import * as vscode from 'vscode';
import { basename, dirname, extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { open as fsOpen, readFile, stat, unlink } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import {
  DescriptiveStats,
  DuckDbFile,
  FNV_OFFSET_BASIS,
  FileKind,
  QueryDiff,
  TopValuesStats,
  fnv1aFold,
  hasTrailingLimit,
} from './duckdbConnection';
import { ChartPanel } from './chartPanel';
import { destructiveReason, hasMultipleStatements } from './sqlSafety';
import { LiveRefreshController, LiveStatus } from './liveRefresh';

// Real, permanent debug channel rather than throwaway instrumentation — this
// feature accumulates enough internal state machinery (backoff phase,
// watcher health, stat-gate skip/hit, coalesced-vs-separate ticks, the
// auto-detect cache) that "why did my live view stop updating" is a
// realistic support question. Silent unless dataFileViewer.debugLiveRefresh
// is on.
const liveRefreshChannel = vscode.window.createOutputChannel('Data File Viewer: Live Refresh');

function isDebugLiveRefreshEnabled(): boolean {
  return vscode.workspace.getConfiguration('dataFileViewer').get<boolean>('debugLiveRefresh', false) === true;
}

function logLive(message: string): void {
  if (!isDebugLiveRefreshEnabled()) return;
  liveRefreshChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
}

// Whether opening a file should also preview its first table, rather than
// leaving an empty grid until something is clicked. Read per message rather
// than cached so toggling the setting takes effect on the next file opened.
function isPreviewFirstTableEnabled(): boolean {
  return vscode.workspace.getConfiguration('dataFileViewer').get<boolean>('previewFirstTableOnOpen', true) !== false;
}

// Most points a chart will draw. This is the viewer's OWN ceiling, not the
// query's: a LIMIT you typed is honoured by runChartQuery and plotted in full.
// This cap exists for the query that has no limit and matches ten million rows,
// and it is refused rather than applied, with the true count reported --
// silently drawing the first N would be a chart of a query nobody wrote.
function getChartMaxPoints(): number {
  const value = vscode.workspace.getConfiguration('dataFileViewer').get<number>('chartMaxPoints', 200_000);
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 200_000;
}

function getGlobalLiveRefreshIntervalMs(): number {
  const value = vscode.workspace.getConfiguration('dataFileViewer').get<number>('liveRefreshIntervalMs', 2000);
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.max(250, value) : 2000;
}

// The refresh-interval value shown/edited in the UI (and any auto-detected
// sheet_metadata hint) is exactly as untrusted as the table/column names
// handled elsewhere in this extension — clamp/type-check before it can ever
// reach the tick engine, so a corrupt or crafted value can't bypass the
// floor the rest of the design relies on to avoid tight-loop refreshing.
function clampIntervalMs(candidateMs: unknown): number {
  const n = typeof candidateMs === 'number' && Number.isFinite(candidateMs) ? candidateMs : NaN;
  return Number.isFinite(n) && n > 0 ? Math.max(250, n) : getGlobalLiveRefreshIntervalMs();
}

// A UX nicety, not a security boundary: the read-only reconnect used for
// every live tick is what actually prevents a write from executing, so this
// only needs to catch the common case well enough to produce a clear error
// instead of a confusing stale/backoff spiral — no need for a real SQL
// parser here. Kept deliberately narrower than Safe Mode's allowlist (no
// explain/describe/show), but it does share the multi-statement check: a
// leading "select" is exactly as easy to satisfy with `select 1; drop table
// x` here as it was there.
function looksReadOnly(sql: string): boolean {
  const t = sql.trim().toLowerCase();
  if (hasMultipleStatements(sql)) return false;
  return t.startsWith('select') || t.startsWith('with');
}

function getWalCandidatesFor(filePath: string): string[] {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.sqlite') || lower.endsWith('.db')) {
    // WAL mode: the main file's mtime often doesn't move until a
    // checkpoint, so the -wal file is what actually tracks freshness.
    return [`${filePath}-wal`, `${filePath}-shm`];
  }
  if (lower.endsWith('.duckdb')) {
    // DuckDB checkpoints through its own WAL file before flushing to the
    // main file — same under-reported-freshness risk applies symmetrically
    // here, not just on the SQLite side.
    return [`${filePath}.wal`];
  }
  return [];
}

function watchPathsFor(primaryPath: string, siblingPath: string | undefined): string[] {
  const paths = [primaryPath, ...getWalCandidatesFor(primaryPath)];
  if (siblingPath) paths.push(siblingPath, ...getWalCandidatesFor(siblingPath));
  return paths;
}

interface FileStat {
  mtimeMs: number;
  size: number;
  /** Catches an atomic write-then-rename whose replacement happens to land on the same mtime and size. */
  ino: number;
}

async function statAll(paths: string[]): Promise<Map<string, FileStat>> {
  const map = new Map<string, FileStat>();
  await Promise.all(
    paths.map(async (p) => {
      try {
        const s = await stat(p);
        map.set(p, { mtimeMs: s.mtimeMs, size: s.size, ino: Number(s.ino) });
      } catch {
        // Doesn't exist yet (no WAL file, or no sibling) — absence is
        // itself a valid, comparable state below.
      }
    })
  );
  return map;
}

function statsChanged(prev: Map<string, FileStat> | undefined, next: Map<string, FileStat>): boolean {
  if (!prev) return true;
  const keys = new Set([...prev.keys(), ...next.keys()]);
  for (const key of keys) {
    const a = prev.get(key);
    const b = next.get(key);
    if (!a || !b) return true; // appeared or disappeared
    if (a.mtimeMs !== b.mtimeMs || a.size !== b.size || a.ino !== b.ino) return true;
  }
  return false;
}

// Sentinels for hashRows below: no cell rendered by String()/JSON.stringify can
// contain a control character, so the data can never forge a cell or row
// boundary and collide with a genuinely different result.
const NULL_MARK = String.fromCharCode(0);
const CELL_MARK_A = String.fromCharCode(1);
const CELL_MARK_B = String.fromCharCode(2);
const ROW_MARK_A = String.fromCharCode(3);
const ROW_MARK_B = String.fromCharCode(4);

/**
 * Cheap content signature for the "skip the repost if unchanged" check — only
 * computed below a size threshold (see runLiveTick).
 *
 * Folded cell by cell rather than over one `JSON.stringify` of the whole
 * result: that allocated a multi-megabyte transient string on every tick,
 * which is a strange price to pay for deciding whether to *avoid* sending
 * data. Two lanes (different seeds, different delimiters) rather than one,
 * since a single 32-bit signature over a few thousand rows is thin enough
 * that a silently-missed update becomes plausible across a long session.
 */
function hashRows(rows: unknown[][]): string {
  let h1 = FNV_OFFSET_BASIS;
  let h2 = 0x9dc5811c;
  for (const row of rows) {
    for (const value of row) {
      const s =
        value === null || value === undefined
          ? NULL_MARK
          : typeof value === 'object'
            ? JSON.stringify(value)
            : String(value);
      // Distinct delimiters per lane, so the two don't avalanche identically
      // despite sharing a fold.
      h1 = fnv1aFold(fnv1aFold(h1, s), CELL_MARK_A);
      h2 = fnv1aFold(fnv1aFold(h2, s), CELL_MARK_B);
    }
    h1 = fnv1aFold(h1, ROW_MARK_A);
    h2 = fnv1aFold(h2, ROW_MARK_B);
  }
  return `${(h1 >>> 0).toString(16)}:${(h2 >>> 0).toString(16)}`;
}
const HASH_ROW_THRESHOLD = 5000;

/**
 * Sibling detection for the combined hot+cold view: filename-convention
 * based (there's no dialog step to supply a second path — VS Code's custom
 * editor API only ever hands the extension one URI on open), trying both
 * naming conventions this codebase's own writers use
 * (`<base>.sqlite`/`<base>.duckdb` same-basename, or `<base>_hot.sqlite`
 * suffix) and using whichever candidate actually exists on disk. Verifies
 * the resolved path is still within the same directory (guards against a
 * symlink swapped in between this check and the caller's later ATTACH)
 * before returning it — the file itself being a valid database is verified
 * separately, by DuckDbFile.open's own attach-and-probe fallback.
 */
function resolveSiblingPath(fsPath: string): string | undefined {
  const dir = dirname(fsPath);
  const ext = extname(fsPath);
  const lowerExt = ext.toLowerCase();
  const base = basename(fsPath, ext);
  const candidates: string[] = [];

  if (lowerExt === '.duckdb') {
    candidates.push(join(dir, `${base}.sqlite`), join(dir, `${base}_hot.sqlite`));
  } else if (lowerExt === '.sqlite' || lowerExt === '.db') {
    candidates.push(join(dir, `${base}.duckdb`));
    if (base.endsWith('_hot')) {
      candidates.push(join(dir, `${base.slice(0, -'_hot'.length)}.duckdb`));
    }
  }

  for (const candidate of candidates) {
    if (isVerifiedSiblingPath(dir, candidate)) return candidate;
  }
  return undefined;
}

function isVerifiedSiblingPath(expectedDir: string, candidate: string): boolean {
  try {
    if (!existsSync(candidate)) return false;
    return dirname(realpathSync(candidate)) === realpathSync(expectedDir);
  } catch {
    return false;
  }
}

// Above this many rows, the automatic post-query diff against the backup
// (an O(rows) comparison) is skipped by default — see the runQuery and
// sortQuery handlers below. User-configurable via
// dataFileViewer.diffRowThreshold; read live (not cached) so a settings
// change takes effect immediately without a window reload.
function getDiffRowThreshold(): number {
  const value = vscode.workspace.getConfiguration('dataFileViewer').get<number>('diffRowThreshold', 50_000);
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 50_000;
}

// 0 (the default) means uncapped, i.e. exactly what this extension did before
// the setting existed. Anything unparseable falls back to uncapped too --
// silently showing fewer rows than the data has would be the worse failure.
function getMaxResultRows(): number {
  const value = vscode.workspace.getConfiguration('dataFileViewer').get<number>('maxResultRows', 0);
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Cross-process (specifically cross-VS-Code-window) file lock for kinds
 * that DuckDB itself doesn't natively lock (.csv/.parquet — see
 * openFlatFilePaths below for the same-window guard this backstops).
 * PID-aware rather than purely presence-based, so a lock file left behind
 * by a crashed VS Code window self-heals on the next open instead of
 * requiring a manual force-clear.
 */
function releaseFileLockSync(lockPath: string): void {
  unlink(lockPath).catch(() => {});
}

async function acquireFileLock(path: string): Promise<() => void> {
  const lockPath = `${path}.dfv.lock`;

  const tryAcquire = async (): Promise<void> => {
    const handle = await fsOpen(lockPath, 'wx'); // atomically fails if it already exists
    await handle.writeFile(String(process.pid));
    await handle.close();
  };

  try {
    await tryAcquire();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

    let stale = false;
    try {
      const pid = Number((await readFile(lockPath, 'utf8')).trim());
      if (!Number.isInteger(pid)) {
        stale = true;
      } else {
        try {
          process.kill(pid, 0); // sends no signal, just tests whether the process exists
        } catch {
          stale = true;
        }
      }
    } catch {
      // Lock file vanished between the EEXIST and reading it (raced with
      // another process releasing it) — safe to just retry acquiring.
      stale = true;
    }

    if (!stale) {
      throw new Error(
        `${basename(
          path
        )} is already open in another VS Code window — this file type has no native lock, so a second window could silently overwrite edits from the first. Close the other window first.`
      );
    }
    releaseFileLockSync(lockPath);
    await tryAcquire();
  }

  return () => releaseFileLockSync(lockPath);
}

// Exported for the stress suite, which drives the document directly rather
// than through the extension host: the connection lock, the stats cache and
// the sibling resolution below are the parts with no coverage, and they are
// all reachable from an instance. Nothing outside this file constructs one.
export class DuckDBDocument implements vscode.CustomDocument {
  private tablesCache: string[] | undefined;
  // name (e.g. "orders_combined") -> the synthesized SQL that entry runs.
  combinedQueryMap = new Map<string, string>();

  safeMode = true;
  backupBeforeWrite = true;
  checkForChanges = true;
  hasBackup = false;

  // Set by the runQuery handler after each run, so columnStats/updateCell
  // (which don't carry the SQL text themselves) know what to re-run/target,
  // and so editability is always server-derived, never trusted from the webview.
  lastSql: string | undefined;
  lastEditableTable: string | undefined;
  lastEditableColumns: string[] | undefined;
  // The base table behind lastSql, whether from a plain single-table SELECT
  // or a synthesized `_combined` query — used to look up the poll-cadence
  // auto-detect hint. Distinct from lastEditableTable since a `_combined`
  // query is never "editable" but still has a meaningful base table.
  lastQueriedBaseTable: string | undefined;

  // Keyed by `${statsKind}:${column}` — cleared whenever a new query runs,
  // since stats are scoped to the current base query.
  readonly statsCache = new Map<string, TopValuesStats | DescriptiveStats>();
  private static readonly MAX_STATS_CACHE_ENTRIES = 50;

  // Live-refresh state.
  liveRefreshEnabled = false;
  liveRefreshIntervalMs = 2000;
  liveRefreshController: LiveRefreshController | undefined;
  lastFileStats: Map<string, FileStat> | undefined;
  lastResultRowCount: number | undefined;
  lastResultHash: string | undefined;
  // Cached per base table so repeated toggle-off/toggle-on within the same
  // session doesn't re-read sheet_metadata each time. `null` is a cached
  // "checked, no hint found" — distinct from `undefined` ("not checked yet").
  pollCadenceCache: number | null | undefined;
  pollCadenceCacheTable: string | undefined;
  disposed = false;

  // Sibling resolution costs an existsSync plus two realpathSync per candidate,
  // and the live path was paying for it twice per tick. Cached, but re-checked
  // periodically rather than once for the session: a cold file appearing
  // partway through is exactly the kind of thing live mode exists to notice.
  private siblingPathCache: string | undefined;
  private siblingPathCheckedAt = 0;
  private static readonly SIBLING_RECHECK_MS = 30_000;

  // Serializes every use of `file`. Without it, a live tick's reconnect can
  // dispose the connection a columnStats/runQuery/updateCell handler is
  // awaiting on — a use-after-close in native code, which takes the extension
  // host down rather than raising something catchable.
  private lockChain: Promise<void> = Promise.resolve();
  private lockDepth = 0;

  constructor(
    readonly uri: vscode.Uri,
    public file: DuckDbFile,
    private readonly onDispose?: () => void,
    /** Set only for kinds that can't be sniffed from the path (kdb+), so a live reconnect re-opens as the right kind. */
    readonly forceKind?: FileKind
  ) {}

  isBusy(): boolean {
    return this.lockDepth > 0;
  }

  /** Queues `fn` behind whatever else holds the connection. Use for user-initiated work, which must never be dropped. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.lockDepth++;
    const run = this.lockChain.then(fn);
    // Both arms settle the chain, so one failed job can't wedge every later
    // one behind a permanently rejected promise.
    this.lockChain = run.then(
      () => {
        this.lockDepth--;
      },
      () => {
        this.lockDepth--;
      }
    );
    return run;
  }

  /**
   * Non-blocking variant for the live tick: a tick that finds the connection
   * busy yields rather than queueing. Queueing would be wrong here — by the
   * time it ran, the scheduler would already want a newer tick, and a backlog
   * of stale ticks is exactly what the interval floor exists to prevent.
   */
  async tryRunExclusive<T>(fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    if (this.isBusy()) return { ran: false };
    return { ran: true, value: await this.runExclusive(fn) };
  }

  getSiblingPath(): string | undefined {
    // kdb+ tables are extensionless and standalone — there's no naming
    // convention to pair them off by.
    if (this.forceKind === 'kdb') return undefined;
    const now = Date.now();
    if (now - this.siblingPathCheckedAt >= DuckDBDocument.SIBLING_RECHECK_MS) {
      this.siblingPathCache = resolveSiblingPath(this.uri.fsPath);
      this.siblingPathCheckedAt = now;
    }
    return this.siblingPathCache;
  }

  invalidateTablesCache(): void {
    this.tablesCache = undefined;
  }

  // Capped insert — cheap insurance against unbounded growth if caching
  // ever extends beyond "cleared on every new query" in the future.
  setStatsCache(key: string, value: TopValuesStats | DescriptiveStats): void {
    if (this.statsCache.size >= DuckDBDocument.MAX_STATS_CACHE_ENTRIES && !this.statsCache.has(key)) {
      const oldestKey = this.statsCache.keys().next().value; // Map preserves insertion order
      if (oldestKey !== undefined) this.statsCache.delete(oldestKey);
    }
    this.statsCache.set(key, value);
  }

  async getTables(): Promise<string[]> {
    if (this.tablesCache) return this.tablesCache;

    const ownTables = await this.file.listTables();
    this.combinedQueryMap.clear();
    const combinable = await this.file.getCombinableTableNames().catch(() => [] as string[]);
    const combinedNames: string[] = [];
    for (const table of combinable) {
      try {
        const { sql } = await this.file.buildCombinedQuery(table);
        const name = `${table}_combined`;
        this.combinedQueryMap.set(sql, table);
        combinedNames.push(name);
      } catch {
        // Best-effort — a table that fails to build a combined query (e.g.
        // an introspection error) just doesn't get a synthesized entry.
      }
    }

    this.tablesCache = [...ownTables, ...combinedNames];
    return this.tablesCache;
  }

  dispose(): void {
    this.disposed = true;
    this.liveRefreshController?.dispose();
    this.liveRefreshController = undefined;
    if (this.hasBackup && this.checkForChanges) {
      // Fire-and-forget: the webview is already gone by the time dispose()
      // runs, so a VS Code notification is the only place left to report
      // this. Connection is closed either way once the comparison settles.
      this.file
        .compareToBackup()
        .then((status) => {
          const entries = Object.entries(status);
          const changed = entries.filter(([, s]) => s !== 'unchanged');
          const fileName = basename(this.uri.fsPath);
          if (changed.length > 0) {
            vscode.window.showInformationMessage(
              `${fileName}: ${changed.length} of ${entries.length} table(s) changed since backup (${changed
                .map(([table]) => table)
                .join(', ')}).`
            );
          } else if (entries.length > 0) {
            vscode.window.showInformationMessage(`${fileName}: no changes since backup.`);
          }
        })
        .catch(() => {
          // Best-effort notification only — never block closing the file over this.
        })
        .finally(() => {
          this.file.dispose();
          this.onDispose?.();
        });
    } else {
      this.file.dispose();
      this.onDispose?.();
    }
  }
}

/**
 * Reconnects a document's underlying file, swapping `document.file` to a
 * fresh connection — used both for the initial live-tick reconnect and for
 * restoring a normal (read-write-attempting) connection when Live turns
 * off. DuckDB's single-connection model isn't built for observing another
 * process's commits made after the connection opened, so this is the
 * mechanism live mode relies on to actually see fresh writes (mirrors
 * dashboard.py's own `_read_cold_with_retry`/`_cold_connection` pattern in
 * trading_project, which reconnects fresh on every read for the same
 * reason).
 */
async function reconnectDocument(document: DuckDBDocument, forceReadOnly: boolean): Promise<void> {
  // Most kinds don't need a new instance at all to see another process's
  // writes — a re-ATTACH, or in the flat-file case nothing whatsoever, is
  // enough. Only .duckdb has to pay full price. See DuckDbFile.refreshInPlace.
  if (forceReadOnly && (await document.file.refreshInPlace())) {
    document.invalidateTablesCache();
    return;
  }

  const siblingPath = document.getSiblingPath();
  const newFile = await DuckDbFile.open(document.uri.fsPath, document.forceKind, { forceReadOnly, siblingPath });
  if (document.disposed) {
    // dispose() fired while this reconnect was in flight — don't swap a
    // fresh connection into a now-dead document (a connection leak, and a
    // route to querying something nobody will ever close). Just close what
    // was just opened instead of assigning it.
    newFile.dispose();
    return;
  }
  const oldFile = document.file;
  document.file = newFile;
  document.invalidateTablesCache();
  oldFile.dispose();
}

async function runLiveTick(document: DuckDBDocument, webview: vscode.Webview, generation: number): Promise<void> {
  const label = basename(document.uri.fsPath);
  // A tick abandoned at its deadline can still settle later. Nothing it
  // computed may reach the view after that point — the scheduler has already
  // moved on, and a late post would overwrite fresher data with older data.
  const isCurrent = () =>
    !document.disposed && document.liveRefreshController?.isCurrentGeneration(generation) === true;

  const paths = watchPathsFor(document.uri.fsPath, document.getSiblingPath());
  const stats = await statAll(paths);

  if (!statsChanged(document.lastFileStats, stats)) {
    logLive(`[${label}] skipped (stat-gate: no change on disk)`);
    if (isCurrent()) {
      webview.postMessage({ command: 'liveTick', lastUpdatedMs: Date.now(), unchanged: true });
    }
    return;
  }

  const outcome = await document.tryRunExclusive(async () => {
    await reconnectDocument(document, true);
    // dispose() can fire while the reconnect is in flight, in which case
    // reconnectDocument deliberately declines to install the new connection —
    // leaving document.file as the one dispose() just closed. Querying that is
    // a use-after-close in native code, not a catchable error.
    const sql = document.lastSql;
    if (document.disposed || !sql) return undefined;
    // Same cap as the manual run that produced lastSql, so a live tick can't
    // quietly return a different number of rows than the view it's refreshing.
    return { sql, result: await document.file.runQuery(sql, getMaxResultRows()) };
  });

  if (!outcome.ran) {
    // A user-initiated query holds the connection. Not a failure — deliberately
    // not counted as one, since it says nothing about the file's health.
    logLive(`[${label}] skipped (connection busy with a user request)`);
    return;
  }
  if (outcome.value === undefined || !isCurrent()) return;
  const { sql, result } = outcome.value;

  const rowCount = result.rows.length;
  const shouldHash = rowCount <= HASH_ROW_THRESHOLD;
  const newHash = shouldHash ? hashRows(result.rows) : undefined;
  const unchanged = shouldHash && document.lastResultRowCount === rowCount && newHash === document.lastResultHash;
  document.lastResultRowCount = rowCount;
  document.lastResultHash = newHash;

  // Committed only now that the tick has actually succeeded. Recording it up
  // front meant a query that then threw still advanced the gate, so the next
  // tick saw "no change on disk" and skipped — leaving the grid frozen on old
  // data until the file happened to change again.
  document.lastFileStats = stats;

  logLive(
    `[${label}] tick ok — ${rowCount} row(s)${unchanged ? ', unchanged (not reposted)' : ', reposted'}${
      shouldHash ? '' : ' (hash skipped, over size threshold)'
    }`
  );

  if (unchanged) {
    webview.postMessage({ command: 'liveTick', lastUpdatedMs: Date.now(), unchanged: true });
    return;
  }

  // The underlying data moved, so any cached column stats describe a result
  // that no longer exists.
  document.statsCache.clear();

  webview.postMessage({
    command: 'liveTick',
    lastUpdatedMs: Date.now(),
    unchanged: false,
    result: {
      ...result,
      diffSkipped: false,
      hasLimit: hasTrailingLimit(sql),
      editable: false,
      editableTable: undefined,
      serverSorted: false,
    },
  });
}

/**
 * Send the footer its "of N" total, once it is known.
 *
 * Posted as a follow-up rather than folded into the queryResult above,
 * because the count is a SECOND execution of the query without its LIMIT.
 * `select * from big limit 100` returns instantly and its count does not, so
 * blocking the grid on it would make every limited query feel as slow as the
 * unlimited one it was written to avoid. The rows land first and the total
 * fills in behind them.
 *
 * Skipped entirely when the rows in hand already are the total: no trailing
 * LIMIT and nothing cut by maxResultRows means the count is `rows.length`,
 * and re-running the whole query to rediscover a number we have would be the
 * expensive way to learn nothing.
 */
async function reportRowTotal(
  document: DuckDBDocument,
  webview: vscode.Webview,
  sql: string,
  result: { rows: unknown[][]; truncated?: boolean }
): Promise<void> {
  const couldBeMore = result.truncated === true || hasTrailingLimit(sql);
  if (!couldBeMore) {
    webview.postMessage({ command: 'rowTotal', sql, total: result.rows.length });
    return;
  }
  const total = await document.runExclusive(() => document.file.countMatchingRows(sql)).catch(() => undefined);
  if (total === undefined) return;
  // The user may have run something else while the count was in flight; a
  // stale total under a newer result would be worse than none at all. The
  // webview checks this against the query the footer belongs to.
  webview.postMessage({ command: 'rowTotal', sql, total });
}

async function startLiveRefresh(
  document: DuckDBDocument,
  webview: vscode.Webview,
  requestedIntervalMs: number | undefined
): Promise<void> {
  const label = basename(document.uri.fsPath);

  let suggestedSeconds: number | null = null;
  if (document.lastQueriedBaseTable) {
    if (document.pollCadenceCacheTable !== document.lastQueriedBaseTable) {
      const table = document.lastQueriedBaseTable;
      document.pollCadenceCache = await document
        .runExclusive(() => document.file.getPollCadenceSeconds(table))
        .catch(() => null);
      document.pollCadenceCacheTable = table;
    }
    suggestedSeconds = document.pollCadenceCache ?? null;
  }

  const intervalMs = clampIntervalMs(requestedIntervalMs ?? (suggestedSeconds ? suggestedSeconds * 1000 : undefined));
  document.liveRefreshEnabled = true;
  document.liveRefreshIntervalMs = intervalMs;
  document.lastFileStats = undefined;
  document.lastResultRowCount = undefined;
  document.lastResultHash = undefined;

  // Reconnect immediately, read-only — this is also what locks out cell
  // editing the moment Live turns on (checkEditableSelect already refuses
  // to edit a read-only connection), rather than deferring the read-only
  // switch until the first tick.
  await document.runExclusive(() => reconnectDocument(document, true));
  if (document.disposed) return;

  document.liveRefreshController?.dispose();
  const controller = new LiveRefreshController(intervalMs, {
    onTick: (generation) => runLiveTick(document, webview, generation),
    // The scheduler has given up waiting; unblock whatever the connection is
    // stuck on so the next tick has a chance of getting through. Best-effort
    // by design — the scheduler doesn't wait for this to take effect.
    onTimeout: () => {
      logLive(`[${label}] tick deadline exceeded — interrupting the in-flight query`);
      try {
        document.file.interruptCurrentQuery();
      } catch {
        // The connection may already be closed/swapped; nothing to interrupt.
      }
    },
    onStatus: (status) => postLiveStatus(webview, status),
    onLog: (msg) => logLive(`[${label}] ${msg}`),
  });
  document.liveRefreshController = controller;

  webview.postMessage({
    command: 'liveRefreshStarted',
    intervalMs,
    suggestedIntervalSeconds: suggestedSeconds,
  });
  logLive(`[${label}] live refresh started, interval ${intervalMs}ms${suggestedSeconds ? ` (auto-detected ${suggestedSeconds}s)` : ''}`);

  // start() schedules the first tick at delay 0. Running one directly here as
  // well used to produce two concurrent first ticks, each reconnecting and
  // disposing the connection the other had just installed.
  controller.start(watchPathsFor(document.uri.fsPath, document.getSiblingPath()));
}

function postLiveStatus(webview: vscode.Webview, status: LiveStatus): void {
  webview.postMessage({
    command: 'liveStatus',
    stale: status.stale,
    failureCount: status.failureCount,
    lastError: status.lastError,
    lastSuccessMs: status.lastSuccessMs,
  });
}

async function stopLiveRefresh(document: DuckDBDocument, webview: vscode.Webview): Promise<void> {
  document.liveRefreshEnabled = false;
  document.liveRefreshController?.dispose();
  document.liveRefreshController = undefined;

  let restoredWritable = true;
  try {
    await document.runExclusive(() => reconnectDocument(document, false));
  } catch (err) {
    // The writer still holds the lock. The read-only connection is still
    // perfectly usable for browsing, so keep it — but say so, rather than
    // leaving the user with silently-disabled editing and a generic error.
    restoredWritable = false;
    logLive(`[${basename(document.uri.fsPath)}] could not restore a writable connection: ${(err as Error).message}`);
  }
  if (document.disposed) return;

  webview.postMessage({
    command: 'liveRefreshStopped',
    readOnly: !restoredWritable || document.file.isReadOnly(),
  });
  logLive(`[${basename(document.uri.fsPath)}] live refresh stopped`);
}

export class DuckDBEditorProvider implements vscode.CustomReadonlyEditorProvider<DuckDBDocument> {
  public static readonly viewType = 'dataFileViewer.editor';
  // .db is a genuinely ambiguous extension (plenty of non-SQLite formats use
  // it), so it stays "option" priority in package.json -- opt-in per file
  // rather than silently claiming every .db on the system. .sqlite has no
  // such ambiguity, so it gets its own viewType registered at "default"
  // priority instead, so it opens automatically like .duckdb/.parquet/.csv.
  public static readonly sqliteViewType = 'dataFileViewer.sqliteEditor';
  public static readonly sqliteDefaultViewType = 'dataFileViewer.sqliteEditorDefault';
  // kdb+ table files are extensionless (see kdbParser.ts) and their names are
  // pipeline-specific (Raw_Data, used_YieldCurve, ...), so there's no stable
  // filename pattern to associate by default or offer in "Open With" the
  // normal way. This viewType exists purely to be invoked programmatically —
  // package.json gives it a harmless catch-all "option"-priority selector,
  // and the real entry point is the dataFileViewer.openKdbFile command below
  // (bound to the Explorer context menu, scoped to *_kdb/ folders).
  public static readonly kdbViewType = 'dataFileViewer.kdbEditor';

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new DuckDBEditorProvider(context);
    const registerOptions = {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    };
    const kdbProvider: vscode.CustomReadonlyEditorProvider<DuckDBDocument> = {
      openCustomDocument: (uri) => provider.openKdbDocument(uri),
      resolveCustomEditor: (document, panel) => provider.resolveCustomEditor(document, panel),
    };
    return vscode.Disposable.from(
      liveRefreshChannel,
      vscode.window.registerCustomEditorProvider(DuckDBEditorProvider.viewType, provider, registerOptions),
      vscode.window.registerCustomEditorProvider(DuckDBEditorProvider.sqliteViewType, provider, registerOptions),
      vscode.window.registerCustomEditorProvider(DuckDBEditorProvider.sqliteDefaultViewType, provider, registerOptions),
      vscode.window.registerCustomEditorProvider(DuckDBEditorProvider.kdbViewType, kdbProvider, registerOptions),
      vscode.commands.registerCommand('dataFileViewer.openKdbFile', (uri: vscode.Uri) =>
        vscode.commands.executeCommand('vscode.openWith', uri, DuckDBEditorProvider.kdbViewType)
      )
    );
  }

  // Unlike .duckdb (direct open) and .db/.sqlite (ATTACH), DuckDB doesn't
  // put any file-level lock on .parquet/.csv/.dta — they're read into a
  // :memory: instance, so nothing today stops opening the same path in two tabs, each
  // with its own independent copy and no lock-conflict warning. That's fine
  // for read-only browsing, but with cell editing now writing back to these
  // files, two tabs editing the same path would silently last-write-wins.
  // Guard it the same way the existing DuckDB-native lock error already
  // reads, scoped to just these kinds since duckdb/sqlite already have their
  // own (better — graceful read-only fallback) protection via DuckDbFile.open().
  private readonly openFlatFilePaths = new Set<string>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri): Promise<DuckDBDocument> {
    return this.openDocumentInternal(uri);
  }

  /** Entry point for the kdb+ viewType (see register() above) — no filename pattern to sniff a kind from. */
  async openKdbDocument(uri: vscode.Uri): Promise<DuckDBDocument> {
    return this.openDocumentInternal(uri, 'kdb');
  }

  private async openDocumentInternal(uri: vscode.Uri, forceKind?: FileKind): Promise<DuckDBDocument> {
    const isFlatFile = forceKind === undefined && /\.(parquet|csv|dta|arrows?)$/i.test(uri.fsPath);
    if (isFlatFile && this.openFlatFilePaths.has(uri.fsPath)) {
      const message = `${basename(
        uri.fsPath
      )} is already open in another tab — this file type has no native lock, so a second tab could silently overwrite edits from the first. Close the other tab first.`;
      vscode.window.showErrorMessage(message);
      throw new Error(message);
    }

    let releaseLock: (() => void) | undefined;
    try {
      // In-memory openFlatFilePaths above catches same-window double-opens
      // fast, without touching the filesystem; this lock is the backstop
      // for a second VS Code *window*, which gets its own process and
      // wouldn't see that in-memory guard at all.
      if (isFlatFile) releaseLock = await acquireFileLock(uri.fsPath);

      const siblingPath = forceKind === 'kdb' ? undefined : resolveSiblingPath(uri.fsPath);
      const file = await DuckDbFile.open(uri.fsPath, forceKind, { siblingPath });
      if (file.isReadOnly()) {
        vscode.window.showWarningMessage(
          `${basename(uri.fsPath)}: opened read-only — this file is already open elsewhere. Edits will fail until the other handle is released.`
        );
      }
      // Said at open, once, rather than left for the user to notice as a blank
      // cell and wonder about. The file is fine and usable — this is about
      // what is IN it.
      for (const warning of file.openWarnings) {
        vscode.window.showWarningMessage(`${basename(uri.fsPath)}: ${warning}`);
      }
      if (isFlatFile) this.openFlatFilePaths.add(uri.fsPath);
      return new DuckDBDocument(
        uri,
        file,
        isFlatFile
          ? () => {
              this.openFlatFilePaths.delete(uri.fsPath);
              releaseLock?.();
            }
          : undefined,
        // Carried so a live reconnect re-opens as the same kind. kdb+ files are
        // extensionless, so without this the reconnect would sniff the path,
        // find nothing, and try to open a kdb+ table as a DuckDB database.
        forceKind
      );
    } catch (err) {
      releaseLock?.();
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(message);
      throw err;
    }
  }

  async resolveCustomEditor(
    document: DuckDBDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css')
    );
    webview.html = getHtml(webview, scriptUri, styleUri);

    // Ordering is enforced by document.runExclusive rather than a boolean
    // guard: the old flag only covered messages from this webview, so it said
    // nothing about the live tick, which uses the same connection and disposes
    // it on reconnect. User-initiated work queues (never silently dropped);
    // live ticks yield (see tryRunExclusive).
    type IncomingMessage =
      | { command: 'ready' }
      | { command: 'runQuery'; sql: string }
      | { command: 'cancelQuery' }
      | { command: 'diffQuery' }
      | { command: 'sortQuery'; column: string; direction: 'asc' | 'desc' }
      | { command: 'toggleSafeMode'; safeMode: boolean; backupBeforeWrite: boolean; checkForChanges: boolean }
      | { command: 'columnStats'; column: string; statsKind: 'numeric' | 'datetime' | 'other'; limit?: number }
      | { command: 'updateCell'; column: string; newValue: unknown; rowValues: Record<string, unknown> }
      | { command: 'toggleLiveRefresh'; enabled: boolean; intervalMs?: number }
      | { command: 'setLiveRefreshInterval'; intervalMs: number }
      | { command: 'runCombinedQuery'; table: string }
      | { command: 'chartQuery'; xColumn: string; xIsText: boolean; yColumns: string[] };

    // Created on the first plot click and reused after that; see ChartPanel.
    let chartPanel: ChartPanel | undefined;

    const messageSub = webview.onDidReceiveMessage(async (message: IncomingMessage) => {
      if (message.command === 'ready') {
        try {
          const tables = await document.runExclusive(() => document.getTables());
          webview.postMessage({
            command: 'tables',
            tables,
            combinedTableNames: [...document.combinedQueryMap.values()].map((table) => `${table}_combined`),
            previewFirst: isPreviewFirstTableEnabled(),
          });
        } catch (err) {
          webview.postMessage({ command: 'error', message: (err as Error).message });
        }
        return;
      }

      if (message.command === 'cancelQuery') {
        // Deliberately not gated by `running` — cancelling only makes sense
        // while something is in flight, and interrupting an idle connection
        // is harmless (DuckDB just has nothing to stop).
        document.file.interruptCurrentQuery();
        return;
      }

      if (message.command === 'toggleLiveRefresh') {
        if (message.enabled) {
          if (!document.lastSql || !looksReadOnly(document.lastSql)) {
            webview.postMessage({
              command: 'liveRefreshRejected',
              reason: 'Live requires a read-only query — run a SELECT first.',
            });
            return;
          }
          try {
            await startLiveRefresh(document, webview, message.intervalMs);
          } catch (err) {
            webview.postMessage({ command: 'error', message: (err as Error).message });
          }
        } else {
          try {
            await stopLiveRefresh(document, webview);
          } catch (err) {
            webview.postMessage({ command: 'error', message: (err as Error).message });
          }
        }
        return;
      }

      if (message.command === 'setLiveRefreshInterval') {
        if (!document.liveRefreshEnabled || !document.liveRefreshController) return;
        const intervalMs = clampIntervalMs(message.intervalMs);
        document.liveRefreshIntervalMs = intervalMs;
        document.liveRefreshController.setIntervalMs(intervalMs);
        webview.postMessage({ command: 'liveRefreshIntervalSet', intervalMs });
        return;
      }

      if (message.command === 'runCombinedQuery') {
        try {
          const { sql, timeColumn, result } = await document.runExclusive(async () => {
            const built = await document.file.buildCombinedQuery(message.table);
            document.lastSql = built.sql;
            document.lastQueriedBaseTable = message.table;
            document.combinedQueryMap.set(built.sql, message.table);
            document.statsCache.clear();
            return { ...built, result: await document.file.runQuery(built.sql, getMaxResultRows()) };
          });
          // Never editable — a UNION/subquery, not a plain single-table
          // SELECT, independent of Live state (checkEditableSelect's own
          // structural gate already excludes it; this just avoids the
          // round-trip to re-derive that for a query the extension itself
          // built and already knows the shape of).
          document.lastEditableTable = undefined;
          document.lastEditableColumns = undefined;

          webview.postMessage({
            command: 'queryResult',
            ...result,
            diffSkipped: true,
            hasLimit: false,
            editable: false,
            editableTable: undefined,
            timeColumnWarning: timeColumn
              ? undefined
              : 'No shared time column found between hot and cold — showing an unbounded union instead of a tail window.',
          });
        } catch (err) {
          webview.postMessage({ command: 'error', message: (err as Error).message });
        }
        return;
      }

      if (message.command === 'toggleSafeMode') {
        const wasSafeMode = document.safeMode;
        document.backupBeforeWrite = message.backupBeforeWrite;
        document.checkForChanges = message.checkForChanges;

        if (wasSafeMode && !message.safeMode) {
          // Turning Safe Mode OFF.
          if (document.backupBeforeWrite) {
            try {
              const backupPath = await document.runExclusive(() => document.file.createBackup());
              document.hasBackup = true;
              document.safeMode = false;
              webview.postMessage({ command: 'backupStatus', message: `Backup created: ${basename(backupPath)}` });
              // A fresh backup makes any previous comparison labels stale.
              webview.postMessage({ command: 'tableChangeStatus', status: {} });
            } catch (err) {
              webview.postMessage({
                command: 'backupStatus',
                message: `Could not create backup — Safe Mode stays on: ${(err as Error).message}`,
              });
            }
          } else {
            document.safeMode = false;
            webview.postMessage({ command: 'backupStatus', message: 'Safe Mode off — no backup was made.' });
            webview.postMessage({ command: 'tableChangeStatus', status: {} });
          }
        } else if (!wasSafeMode && message.safeMode) {
          // Turning Safe Mode back ON (re-lock).
          document.safeMode = true;
          if (document.checkForChanges && document.hasBackup) {
            try {
              const status = await document.runExclusive(() => document.file.compareToBackup());
              webview.postMessage({ command: 'tableChangeStatus', status });
            } catch (err) {
              webview.postMessage({ command: 'error', message: (err as Error).message });
            }
          } else {
            webview.postMessage({ command: 'tableChangeStatus', status: {} });
          }
        }

        webview.postMessage({ command: 'safeModeState', safeMode: document.safeMode });
        return;
      }

      if (message.command === 'runQuery' && typeof message.sql === 'string') {
        try {
          // Re-validated on every manual Run while Live stays engaged, not
          // just at the moment the toggle was flipped on — a new query can
          // replace lastSql mid-session. The read-only reconnect used for
          // live ticks is what actually prevents a write from executing;
          // this just turns "runs forever, fails every tick, spins into
          // backoff" into a clear, immediate message.
          if (document.liveRefreshEnabled && !looksReadOnly(message.sql)) {
            webview.postMessage({
              command: 'error',
              message: 'Live is on, so this file is open read-only — turn off Live to run write statements.',
            });
            return;
          }

          // The reason, not the first word: for `select 1; drop table x` the
          // first word is the harmless half, so reporting it would describe
          // the query as a select while blocking it as a write.
          const reason = destructiveReason(message.sql);
          const destructive = reason !== null;
          if (document.safeMode && destructive) {
            webview.postMessage({
              command: 'error',
              message: `Blocked by Safe Mode: this looks like a write statement (${reason}). Uncheck Safe Mode to allow it.`,
            });
            return;
          }

          const sql = message.sql;
          const { result, diffFields, diffSkipped, editability } = await document.runExclusive(async () => {
            const queryResult = await document.file.runQuery(sql, getMaxResultRows());
            document.lastSql = sql;
            document.statsCache.clear();

            let fields: Partial<QueryDiff> = {};
            let skipped = false;
            if (!destructive && document.checkForChanges && document.hasBackup) {
              if (queryResult.rows.length > getDiffRowThreshold()) {
                // An O(rows) comparison nobody explicitly asked for isn't worth
                // paying for automatically on a huge result — offer it as an
                // on-demand action instead (see the diffQuery handler below).
                skipped = true;
              } else {
                try {
                  const diff = await document.file.diffQueryAgainstBackup(sql, queryResult.columns, queryResult.rows);
                  if (diff) fields = diff;
                } catch {
                  // Diff highlighting is a nice-to-have; never let it block showing the result.
                }
              }
            }

            return {
              result: queryResult,
              diffFields: fields,
              diffSkipped: skipped,
              editability: destructive ? { editable: false as const } : await document.file.checkEditableSelect(sql),
            };
          });

          // Raised by the query rather than by opening the file — a workbook
          // whose sheets had to be re-read tolerating uncomputable cells. Said
          // once, when it first becomes true, rather than on every run.
          for (const warning of document.file.takeLateWarnings()) {
            vscode.window.showWarningMessage(`${basename(document.uri.fsPath)}: ${warning}`);
          }

          document.lastEditableTable = editability.editable ? editability.table : undefined;
          document.lastEditableColumns = editability.editable ? editability.columns : undefined;
          document.lastQueriedBaseTable =
            document.combinedQueryMap.get(sql) ?? (editability.editable ? editability.table : undefined);

          webview.postMessage({
            command: 'queryResult',
            ...result,
            ...diffFields,
            diffSkipped,
            hasLimit: hasTrailingLimit(sql),
            editable: editability.editable,
            editableTable: editability.editable ? editability.table : undefined,
          });
          void reportRowTotal(document, webview, sql, result);
        } catch (err) {
          const message2 = (err as Error).message;
          webview.postMessage({
            command: 'error',
            message: /interrupt/i.test(message2) ? 'Query cancelled.' : message2,
          });
        }
        return;
      }

      if (message.command === 'diffQuery') {
        // On-demand counterpart to runQuery's automatic diff, for results
        // large enough that diffSkipped was set — explicit opt-in, since the
        // comparison itself is the expensive part being deferred here.
        if (!document.lastSql || !document.hasBackup) return;
        const baseSql = document.lastSql;
        try {
          const { result, diff } = await document.runExclusive(async () => {
            const queryResult = await document.file.runQuery(baseSql, getMaxResultRows());
            return {
              result: queryResult,
              diff: await document.file.diffQueryAgainstBackup(baseSql, queryResult.columns, queryResult.rows),
            };
          });
          webview.postMessage({
            command: 'queryResult',
            ...result,
            ...(diff ?? {}),
            diffSkipped: false,
            hasLimit: hasTrailingLimit(baseSql),
            // Editability is unchanged from the original run — this is the
            // same query re-executed only to compute the diff, not a new one.
            editable: !!document.lastEditableTable,
            editableTable: document.lastEditableTable,
          });
        } catch (err) {
          webview.postMessage({ command: 'error', message: (err as Error).message });
        }
        return;
      }

      if (message.command === 'chartQuery') {
        // Runs against document.lastSql, so the chart follows whatever is on
        // screen -- a table preview, or a query somebody wrote. lastSql is
        // deliberately not overwritten: the grid, editability and stats keep
        // describing the user's own query, and the chart is a second reading
        // of it rather than a replacement.
        if (!document.lastSql) return;
        const cap = getChartMaxPoints();
        const label = message.yColumns.length === 1 ? message.yColumns[0] : `${message.yColumns.length} series`;
        chartPanel ??= new ChartPanel(this.context.extensionUri, basename(document.uri.fsPath));
        try {
          const result = await document.runExclusive(() =>
            document.file.runChartQuery(
              document.lastSql!,
              message.xColumn,
              message.yColumns,
              message.xIsText === true,
              cap
            )
          );
          // Read after the chart query, and never allowed to fail the chart:
          // a file with no sheet_metadata plots with plain dates, which is the
          // whole point of the frequency being optional. Not cached -- it is
          // one row, read once per click on a plot button.
          const frequency = document.lastQueriedBaseTable
            ? await document
                .runExclusive(() =>
                  document.file.getSeriesFrequency(document.lastQueriedBaseTable!)
                )
                .catch(() => null)
            : null;
          chartPanel.reveal(label, {
            command: 'chart',
            frequency,
            xColumn: message.xColumn,
            yColumns: message.yColumns,
            columns: result.columns,
            rows: result.rows,
            xAxisMode: result.xAxisMode,
            // `truncated` means the cap actually bit. The chart view reports
            // the refusal instead of drawing a prefix of the series.
            truncated: result.truncated === true,
            maxPoints: cap,
          });
        } catch (err) {
          // In the chart's own tab, not the grid's status line: the tab is
          // where the user is looking, and a chart that silently never appears
          // is the failure worth avoiding.
          chartPanel.reveal(label, { command: 'chartError', message: (err as Error).message });
        }
        return;
      }

      if (message.command === 'sortQuery') {
        // Only reachable when the base query has a trailing LIMIT (the
        // webview only sends this then — see hasLimit in queryResult) — a
        // client-side re-sort of already-fetched rows can't recover the
        // true top/bottom N from a LIMIT-ed, unordered result, so this
        // re-runs the query with the LIMIT stripped, sorted, then
        // re-applied. document.lastSql is deliberately left untouched:
        // editability/stats continue to reflect the user's real query.
        if (!document.lastSql) return;
        const baseSql = document.lastSql;
        try {
          const { result, diffFields, diffSkipped } = await document.runExclusive(async () => {
            const sorted = await document.file.runSortedQuery(
              baseSql,
              message.column,
              message.direction,
              getMaxResultRows()
            );

            let fields: Partial<QueryDiff> = {};
            let skipped = false;
            if (document.checkForChanges && document.hasBackup) {
              if (sorted.rows.length > getDiffRowThreshold()) {
                skipped = true;
              } else {
                try {
                  // The *sorted* SQL, not the base query. diffQueryAgainstBackup
                  // compares rows positionally, so running the unsorted base
                  // query against the backup lines sorted rows up against
                  // unsorted ones and reports nearly every cell as changed.
                  const diff = await document.file.diffQueryAgainstBackup(
                    sorted.sortedSql,
                    sorted.columns,
                    sorted.rows
                  );
                  if (diff) fields = diff;
                } catch {
                  // Diff highlighting is a nice-to-have; never let it block showing the result.
                }
              }
            }
            return { result: sorted, diffFields: fields, diffSkipped: skipped };
          });

          webview.postMessage({
            command: 'sortQueryResult',
            ...result,
            ...diffFields,
            diffSkipped,
            hasLimit: true,
            // DuckDB has already ordered these rows across the full data set.
            // Without this the webview re-sorts them client-side, which is both
            // wasted work and — since the client comparator can disagree with
            // DuckDB's ordering — able to scramble a correct top-N back into a
            // wrong one.
            serverSorted: true,
            // Editability is unchanged from the original run — sorting
            // doesn't change the query's shape, only row order.
            editable: !!document.lastEditableTable,
            editableTable: document.lastEditableTable,
          });
        } catch (err) {
          webview.postMessage({ command: 'error', message: (err as Error).message });
        }
        return;
      }

      if (message.command === 'columnStats') {
        if (!document.lastSql) return;
        const baseSql = document.lastSql;
        const limit = Number.isInteger(message.limit) && message.limit! > 0 && message.limit! <= 200 ? message.limit! : 20;
        const cacheKey = `${message.statsKind}:${message.column}`;
        const cached = document.statsCache.get(cacheKey);
        if (cached) {
          webview.postMessage({ command: 'columnStatsResult', column: message.column, statsKind: message.statsKind, ...cached });
          return;
        }
        try {
          if (message.statsKind === 'other') {
            const stats = await document.runExclusive(() =>
              document.file.getColumnTopValues(baseSql, message.column, limit)
            );
            document.setStatsCache(cacheKey, stats);
            webview.postMessage({ command: 'columnStatsResult', column: message.column, statsKind: 'other', ...stats });
          } else {
            const statsKind = message.statsKind;
            const stats = await document.runExclusive(() =>
              document.file.getColumnDescriptiveStats(baseSql, message.column, statsKind)
            );
            document.setStatsCache(cacheKey, stats);
            webview.postMessage({
              command: 'columnStatsResult',
              column: message.column,
              statsKind,
              ...stats,
            });
          }
        } catch (err) {
          webview.postMessage({ command: 'columnStatsError', column: message.column, message: (err as Error).message });
        }
        return;
      }

      if (message.command === 'updateCell') {
        if (document.safeMode) {
          webview.postMessage({
            command: 'cellUpdateError',
            column: message.column,
            message: 'Blocked by Safe Mode: uncheck Safe Mode to allow edits.',
          });
          return;
        }
        if (!document.lastEditableTable || !document.lastEditableColumns?.includes(message.column)) {
          webview.postMessage({
            command: 'cellUpdateError',
            column: message.column,
            message: 'This result is not editable.',
          });
          return;
        }
        const expectedCols = new Set(document.lastEditableColumns);
        const gotCols = Object.keys(message.rowValues);
        if (gotCols.length !== expectedCols.size || !gotCols.every((c) => expectedCols.has(c))) {
          webview.postMessage({
            command: 'cellUpdateError',
            column: message.column,
            message: 'Result changed since this row was loaded — re-run the query and try again.',
          });
          return;
        }

        const editableTable = document.lastEditableTable;
        try {
          const rowsMatched = await document.runExclusive(() =>
            document.file.updateCell(
              editableTable,
              message.column,
              message.newValue,
              message.rowValues,
              (statusMessage) => webview.postMessage({ command: 'editStatus', message: statusMessage })
            )
          );
          if (rowsMatched === 0) {
            webview.postMessage({
              command: 'cellUpdateError',
              column: message.column,
              message: 'No matching row found — the data may have changed. Re-run the query and try again.',
            });
          } else {
            webview.postMessage({
              command: 'cellUpdated',
              column: message.column,
              newValue: message.newValue,
              rowValues: message.rowValues,
              rowsMatched,
            });
          }
        } catch (err) {
          webview.postMessage({ command: 'cellUpdateError', column: message.column, message: (err as Error).message });
        }
      }
    });

    webviewPanel.onDidDispose(() => {
      messageSub.dispose();
      // A chart of a document nobody has open is furniture.
      chartPanel?.dispose();
      chartPanel = undefined;
      // The panel going away is the end of anyone being able to see a tick's
      // result, so stop scheduling them. Document disposal usually follows
      // immediately, but nothing guarantees it happens first.
      document.liveRefreshController?.dispose();
      document.liveRefreshController = undefined;
      document.liveRefreshEnabled = false;
    });
  }
}

function getHtml(webview: vscode.Webview, scriptUri: vscode.Uri, styleUri: vscode.Uri): string {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Data File Viewer</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  // A CSP nonce must be unguessable — Math.random() isn't a CSPRNG and its
  // output is statistically predictable given enough samples, which defeats
  // the point of using a nonce at all.
  return randomBytes(16).toString('hex');
}
