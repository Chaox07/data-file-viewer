import {
  DuckDBAppender,
  DuckDBConnection,
  DuckDBDateValue,
  DuckDBInstance,
  DuckDBTimeValue,
  DuckDBTimestampValue,
  DuckDBTypeId,
  DuckDBValue,
  StatementType,
} from '@duckdb/node-api';
import { basename, dirname, extname, join } from 'node:path';
import { chmod, copyFile, open, stat } from 'node:fs/promises';
import { parseKdbFile, type KdbColumn, type KdbTable } from './kdbParser';
import { listSheets } from './xlsxSheets';

export type StatsKind = 'numeric' | 'datetime' | 'other';

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  columnStatsKind: StatsKind[];
  /** Set when a maxRows cap actually cut the result short (see runQuery). */
  truncated?: boolean;
}

export interface QueryDiff {
  cellChanged: boolean[][];
  rowIsNew: boolean[];
  renamedColumns: Record<string, string>;
}

export interface EditabilityInfo {
  editable: boolean;
  table?: string;
  columns?: string[];
}

export interface TopValuesStats {
  totalRows: number;
  nonNullRows: number;
  nullCount: number;
  distinctCount: number;
  topValues: { value: unknown; frequency: number }[];
}

export interface DescriptiveStats {
  totalRows: number;
  nonNullRows: number;
  nullCount: number;
  min: unknown;
  max: unknown;
  mean: unknown;
  p5: unknown;
  p95: unknown;
}

export type FileKind = 'duckdb' | 'parquet' | 'sqlite' | 'csv' | 'dta' | 'arrow' | 'xlsx' | 'kdb';

export interface DuckDbFileOpenOptions {
  /** Request read-only up front (live-refresh reconnects) instead of trying read-write first. */
  forceReadOnly?: boolean;
  /** Absolute path to the other half of a hot/cold pair, if one was found — see duckdbEditorProvider.ts's sibling detection. */
  siblingPath?: string;
}

/**
 * Refuse a truncated Arrow IPC stream before it can be shown as an empty table.
 *
 * read_arrow does not notice. An Arrow stream is a schema message followed by
 * record batches, and a file that simply stops looks the same to it as one
 * that ended: cut a 50-row stream to 90%, 50% or 25% and every one of them
 * comes back as **zero rows and no error**. The schema survives, so the viewer
 * draws the right column headers over an empty grid — which reads as "this
 * export produced nothing", not as "this file is damaged". Only cutting past
 * the schema itself (~5%) produces a real error.
 *
 * A complete stream ends with the 8-byte end-of-stream marker: the 0xFFFFFFFF
 * continuation followed by a zero metadata length. A legitimately EMPTY table
 * still carries it (verified: a 152-byte zero-row stream ends the same way),
 * so this separates damaged from empty, which is the distinction read_arrow
 * loses.
 */
const ARROW_END_OF_STREAM = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00]);

async function assertArrowStreamComplete(path: string): Promise<void> {
  const { size } = await stat(path);
  if (size < ARROW_END_OF_STREAM.length) {
    throw new Error(
      `"${basename(path)}" is too small to be an Arrow IPC stream (${size} bytes) — it looks truncated or empty.`
    );
  }
  const handle = await open(path, 'r');
  try {
    const tail = Buffer.alloc(ARROW_END_OF_STREAM.length);
    await handle.read(tail, 0, tail.length, size - tail.length);
    if (!tail.equals(ARROW_END_OF_STREAM)) {
      throw new Error(
        `"${basename(path)}" is not a complete Arrow IPC stream — the end-of-stream marker is missing, ` +
          `so the file was truncated (a writer that was interrupted, or a partial copy). ` +
          `Reading it anyway would show an empty table rather than an error.`
      );
    }
  } finally {
    await handle.close();
  }
}

/**
 * Refuse a Feather / Arrow IPC *file* by name, rather than by symptom.
 *
 * Arrow has two encodings that share a name, and picking the wrong one is the
 * single easiest mistake to make when writing a file for this viewer:
 *
 *   - the *stream* encoding, which read_arrow() reads: polars'
 *     write_ipc_stream(), pyarrow's RecordBatchStreamWriter, DuckDB's
 *     COPY ... TO ... (FORMAT arrow). Conventionally .arrows/.arrow.
 *   - the *file* encoding, also called Feather V2, which read_arrow() rejects:
 *     polars' write_ipc(), pyarrow.feather.write_feather(), pandas'
 *     DataFrame.to_feather(). It begins with the ASCII magic `ARROW1`.
 *
 * Not supporting the file encoding is deliberate -- read_arrow is the only
 * Arrow path here. But the refusal used to arrive as DuckDB's own
 * "Expected -1 field nodes in message but found 2", which is accurate and
 * useless: it describes a symptom of the mismatch rather than the mismatch,
 * and gives no hint that the fix is one method name away.
 *
 * Checked BEFORE the truncation check, and that order is load-bearing: a
 * Feather file ends with its own `ARROW1` footer magic rather than the 8-byte
 * end-of-stream marker, so assertArrowStreamComplete would otherwise claim it
 * was truncated -- sending someone to look for an interrupted writer when
 * nothing is damaged at all.
 */
const ARROW_FILE_MAGIC = Buffer.from('ARROW1', 'ascii');
const FEATHER_V1_MAGIC = Buffer.from('FEA1', 'ascii');

const ARROW_STREAM_REMEDY =
  `Write it as an Arrow IPC *stream* instead: polars ` +
  `write_ipc_stream(path, compat_level=pl.CompatLevel.oldest()), pyarrow's ` +
  `RecordBatchStreamWriter, or DuckDB's COPY ... TO '...' (FORMAT arrow).`;

async function assertNotFeatherFile(path: string): Promise<void> {
  const head = Buffer.alloc(ARROW_FILE_MAGIC.length);
  const handle = await open(path, 'r');
  let bytesRead = 0;
  try {
    ({ bytesRead } = await handle.read(head, 0, head.length, 0));
  } finally {
    await handle.close();
  }

  if (bytesRead >= ARROW_FILE_MAGIC.length && head.equals(ARROW_FILE_MAGIC)) {
    throw new Error(
      `"${basename(path)}" is a Feather / Arrow IPC *file* — it starts with the ARROW1 magic bytes. ` +
        `This viewer reads the Arrow IPC *stream* encoding, which is a different byte layout despite ` +
        `the shared name, so the file cannot be opened as-is. ${ARROW_STREAM_REMEDY}`
    );
  }
  if (bytesRead >= FEATHER_V1_MAGIC.length && head.subarray(0, FEATHER_V1_MAGIC.length).equals(FEATHER_V1_MAGIC)) {
    throw new Error(
      `"${basename(path)}" is a legacy Feather V1 file — it starts with the FEA1 magic bytes. ` +
        `This viewer reads the Arrow IPC stream encoding only. ${ARROW_STREAM_REMEDY}`
    );
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(
    date.getMinutes()
  )}${pad(date.getSeconds())}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value);
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function groupColumnsByTable(rows: unknown[][]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [tableName, columnName, dataType] of rows) {
    const key = `${columnName}:${dataType}`;
    const list = map.get(String(tableName));
    if (list) list.push(key);
    else map.set(String(tableName), [key]);
  }
  return map;
}

export const FNV_OFFSET_BASIS = 0x811c9dc5;

export function fnv1aFold(hash: number, str: string): number {
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash;
}

/** Cheap per-column content signature used to narrow rename-match candidates
 *  before falling back to an exact array comparison (below). */
function columnSignature(rows: unknown[][], colIdx: number, len: number): number {
  let hash = FNV_OFFSET_BASIS;
  for (let r = 0; r < len; r++) {
    hash = fnv1aFold(hash, stableStringify(rows[r][colIdx]));
    hash = fnv1aFold(hash, ' '); // row delimiter, prevents value-boundary collisions
  }
  return hash >>> 0;
}

function isLockConflict(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /lock/i.test(message);
}

// INSTALL writes into DuckDB's extension directory on disk, so it only needs
// to happen once per process — but LOAD is per-connection state and must run
// every time. Splitting the two matters on the live path, where a connection
// used to be rebuilt from scratch on every tick.
let sqliteExtensionInstalled = false;

async function ensureSqliteExtension(connection: DuckDBConnection): Promise<void> {
  try {
    if (!sqliteExtensionInstalled) {
      await connection.run(`install sqlite`);
      sqliteExtensionInstalled = true;
    }
    await connection.run(`load sqlite`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not load DuckDB's SQLite extension — this requires an internet connection the first time it's used on this machine. (${message})`
    );
  }
}

function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;\s*$/, '');
}

function wrapAsSubquery(sql: string): string {
  // The newlines are load-bearing: if `sql`'s last line ends in a `--`
  // comment, a closing `)` on the same line would become part of the
  // comment and break the query.
  return `(\n${sql}\n)`;
}

// $-anchored so only the outermost/final LIMIT is matched -- a LIMIT nested
// inside an inner subquery (part of the query's own logic) is left alone.
const TRAILING_LIMIT_RE = /\s+limit\s+\d+(?:\s+offset\s+\d+)?\s*;?\s*$/i;

export function hasTrailingLimit(sql: string): boolean {
  return TRAILING_LIMIT_RE.test(sql);
}

function extractTrailingLimit(sql: string): { withoutLimit: string; limitClause: string } | null {
  const match = sql.match(TRAILING_LIMIT_RE);
  if (!match) return null;
  return {
    withoutLimit: sql.slice(0, match.index),
    limitClause: match[0].trim().replace(/;\s*$/, ''),
  };
}

/** kdb+ vector type code -> DuckDB SQL column type, for the CREATE TABLE that backs a loaded kdb+ table. */
function kdbTypeToSql(qType: number): string {
  switch (qType) {
    case 1: // boolean
      return 'BOOLEAN';
    case 4: // byte
      return 'UTINYINT';
    case 5: // short
      return 'SMALLINT';
    case 6: // int
      return 'INTEGER';
    case 7: // long
      return 'BIGINT';
    case 8: // real
      return 'REAL';
    case 9: // float
      return 'DOUBLE';
    case 12: // timestamp
    case 15: // datetime
      return 'TIMESTAMP';
    case 13: // month (first-of-month date)
    case 14: // date
      return 'DATE';
    case 16: // timespan (raw nanosecond duration)
      return 'BIGINT';
    case 17: // minute
    case 18: // second
    case 19: // time
      return 'TIME';
    default: // guid(2), char(10), symbol(11), general list(0), anything else
      return 'VARCHAR';
  }
}

/** Appends one already-decoded kdb+ cell value (see kdbParser.ts) to the appender's current row/column. */
function appendKdbValue(appender: DuckDBAppender, qType: number, value: unknown): void {
  if (value === null || value === undefined) {
    appender.appendNull();
    return;
  }
  switch (qType) {
    case 1:
      appender.appendBoolean(value as boolean);
      return;
    case 4:
      appender.appendUTinyInt(value as number);
      return;
    case 5:
      appender.appendSmallInt(value as number);
      return;
    case 6:
      appender.appendInteger(value as number);
      return;
    case 7:
      appender.appendBigInt(value as bigint);
      return;
    case 8:
      appender.appendFloat(value as number);
      return;
    case 9:
      appender.appendDouble(value as number);
      return;
    case 12:
    case 15:
      appender.appendTimestamp(new DuckDBTimestampValue(value as bigint));
      return;
    case 13:
    case 14:
      appender.appendDate(new DuckDBDateValue(value as number));
      return;
    case 16:
      appender.appendBigInt(value as bigint);
      return;
    case 17:
    case 18:
    case 19:
      appender.appendTime(new DuckDBTimeValue(value as bigint));
      return;
    default: // guid(2), char(10), symbol(11), general list(0), anything else
      appender.appendVarchar(typeof value === 'string' ? value : JSON.stringify(value));
      return;
  }
}

/**
 * Bulk-loads a parsed kdb+ table (see kdbParser.ts) into a fresh table on
 * this connection via the Appender API. This is purely an in-memory query
 * engine bridge for the viewer -- the on-disk kdb+ file itself is only ever
 * read, never rewritten or converted.
 */
async function loadKdbTableIntoConnection(
  connection: DuckDBConnection,
  tableName: string,
  columns: KdbColumn[]
): Promise<void> {
  const colDefs = columns.map((c) => `${quoteIdent(c.name)} ${kdbTypeToSql(c.qType)}`).join(', ');
  await connection.run(`create table ${quoteIdent(tableName)} (${colDefs})`);

  const appender = await connection.createAppender(tableName);
  const rowCount = columns.length > 0 ? columns[0].values.length : 0;
  try {
    for (let r = 0; r < rowCount; r++) {
      for (const col of columns) {
        appendKdbValue(appender, col.qType, col.values[r]);
      }
      appender.endRow();
    }
    appender.flushSync();
  } finally {
    appender.closeSync();
  }
}

function classifyForStats(typeId: DuckDBTypeId): StatsKind {
  switch (typeId) {
    case DuckDBTypeId.TINYINT:
    case DuckDBTypeId.SMALLINT:
    case DuckDBTypeId.INTEGER:
    case DuckDBTypeId.BIGINT:
    case DuckDBTypeId.HUGEINT:
    case DuckDBTypeId.UHUGEINT:
    case DuckDBTypeId.UTINYINT:
    case DuckDBTypeId.USMALLINT:
    case DuckDBTypeId.UINTEGER:
    case DuckDBTypeId.UBIGINT:
    case DuckDBTypeId.FLOAT:
    case DuckDBTypeId.DOUBLE:
    case DuckDBTypeId.DECIMAL:
      return 'numeric';
    case DuckDBTypeId.DATE:
    case DuckDBTypeId.TIME:
    case DuckDBTypeId.TIME_TZ:
    case DuckDBTypeId.TIMESTAMP:
    case DuckDBTypeId.TIMESTAMP_S:
    case DuckDBTypeId.TIMESTAMP_MS:
    case DuckDBTypeId.TIMESTAMP_NS:
    case DuckDBTypeId.TIMESTAMP_TZ:
    case DuckDBTypeId.INTERVAL:
      return 'datetime';
    default:
      return 'other';
  }
}

// Structural gate for "is this SELECT * FROM <one table> [WHERE][ORDER BY]
// [LIMIT]". Intentionally conservative: a false negative just disables the
// edit affordance for that query, never misclassifies something dangerous
// as safe. The real security boundary is the extractStatements()/
// statementType check in checkEditableSelect, run before this regex.
const EDITABLE_SELECT_RE = new RegExp(
  '^select\\s+\\*\\s+from\\s+' +
    '("(?:[^"]|"")+"|[a-zA-Z_][a-zA-Z0-9_]*)' +
    '(?:\\s+where\\s+[\\s\\S]+?)?' +
    '(?:\\s+order\\s+by\\s+[\\s\\S]+?)?' +
    '(?:\\s+limit\\s+\\d+(?:\\s+offset\\s+\\d+)?)?' +
    '\\s*;?\\s*$',
  'i'
);
const FORBIDDEN_KEYWORDS_RE = /\b(join|group\s+by|distinct|union|intersect|except|using|window)\b/i;

export class DuckDbFile {
  private lastBackupPath: string | undefined;
  private backupAttached = false;
  private materialized = false;

  private constructor(
    private readonly connection: DuckDBConnection,
    private readonly path: string,
    private readonly kind: FileKind,
    private readonly catalogName: string,
    private readonly mainObjectName: string,
    private readonly readOnly: boolean,
    private siblingCatalogName: string | undefined,
    private siblingIsSqlite: boolean = false,
    /** The catalog `connect()` started in, before any ATTACH/USE — the parking spot refreshInPlace() needs to DETACH from. */
    private readonly rootCatalogName: string = 'memory',
    private readonly siblingPath: string | undefined = undefined
  ) {}

  isReadOnly(): boolean {
    return this.readOnly;
  }

  hasSibling(): boolean {
    return this.siblingCatalogName !== undefined;
  }

  private isFlatFileKind(): boolean {
    return this.kind === 'parquet' || this.kind === 'csv' || this.kind === 'dta' || this.kind === 'arrow';
  }

  static async open(path: string, forceKind?: FileKind, options?: DuckDbFileOpenOptions): Promise<DuckDbFile> {
    // kdb+ files are extensionless (see kdbParser.ts) so they can't be
    // sniffed by suffix like every other kind below -- the caller (the
    // dedicated kdb+ explorer-context command, see duckdbEditorProvider.ts)
    // knows this from which viewType it opened through and says so directly.
    if (forceKind === 'kdb') {
      return DuckDbFile.openKdb(path);
    }

    const isParquet = path.toLowerCase().endsWith('.parquet');
    const isCsv = path.toLowerCase().endsWith('.csv');
    const isDta = path.toLowerCase().endsWith('.dta');
    const isArrow = /\.arrows?$/i.test(path);
    const isXlsx = path.toLowerCase().endsWith('.xlsx');
    const isSqlite = path.toLowerCase().endsWith('.db') || path.toLowerCase().endsWith('.sqlite');
    const useMemory = isParquet || isCsv || isDta || isArrow || isXlsx || isSqlite;
    const kind: FileKind = isParquet
      ? 'parquet'
      : isCsv
        ? 'csv'
        : isDta
          ? 'dta'
          : isArrow
            ? 'arrow'
            : isXlsx
              ? 'xlsx'
              : isSqlite
                ? 'sqlite'
                : 'duckdb';
    // Live-refresh reconnects request read-only up front rather than trying
    // read-write first and falling back on a lock conflict — there's never a
    // reason for a live tick to want read-write, and going through the
    // fallback path could momentarily grab the write lock and stall the
    // actual writer process (the scraper/extractor) before falling back.
    const forceReadOnly = options?.forceReadOnly === true;

    let instance: DuckDBInstance;
    let readOnly = false;
    if (!useMemory && forceReadOnly) {
      try {
        instance = await DuckDBInstance.create(path, { access_mode: 'READ_ONLY' });
        readOnly = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Could not open "${path}" read-only: ${message}`);
      }
    } else {
      try {
        // Neither a .parquet nor a .db/.sqlite (SQLite) file is itself a
        // DuckDB database — open an in-memory instance and expose the file's
        // data through it instead (view / ATTACH, below).
        instance = await DuckDBInstance.create(useMemory ? ':memory:' : path);
      } catch (err) {
        // A lock conflict on the direct (non-memory) path means another
        // process already has this exact file open — most commonly, this
        // extension's own backup_cmp attachment elsewhere (see createBackup)
        // holding it read-only. Since DuckDB itself suggests read-only mode
        // is available in that case, fall back to it instead of failing
        // outright — better to show the data than nothing.
        if (!useMemory && isLockConflict(err)) {
          try {
            instance = await DuckDBInstance.create(path, { access_mode: 'READ_ONLY' });
            readOnly = true;
          } catch (roErr) {
            throw new Error(
              `This file is already open elsewhere and could not be opened read-only either: ${
                roErr instanceof Error ? roErr.message : String(roErr)
              }`
            );
          }
        } else {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`Could not open "${path}": ${message}`);
        }
      }
    }
    const connection = await instance.connect();

    // Captured before any ATTACH/USE below moves the current database — a
    // catalog can't DETACH itself, so refreshInPlace() needs somewhere to
    // stand while it swaps the SQLite attachment.
    const rootReader = await connection.runAndReadAll('select current_database()');
    const rootCatalogName = String(rootReader.getRows()[0][0]);

    const mainObjectName = basename(path, extname(path)).replace(/"/g, '""');

    if (isParquet) {
      // Exposed as a single view named after the file, so the sidebar's
      // "click a table to preview it" behavior works unchanged — Parquet
      // has no concept of multiple tables, just the one dataset.
      const filePath = path.replace(/'/g, "''");
      await connection.run(`create view "${mainObjectName}" as select * from read_parquet('${filePath}')`);
    }

    if (isCsv) {
      // Same single-view treatment as Parquet — auto-detects delimiter,
      // header presence, and column types.
      const filePath = path.replace(/'/g, "''");
      await connection.run(`create view "${mainObjectName}" as select * from read_csv_auto('${filePath}')`);
    }

    if (isDta) {
      // Same single-view treatment as Parquet/CSV — a .dta file is one
      // Stata dataset, not multiple tables. Uses DuckDB's community `dta`
      // extension (codedthinking/duckdb-dta), which reads Stata formats
      // 117-121 (Stata 13-18) via read_dta().
      try {
        await connection.run(`install dta from community`);
        await connection.run(`load dta`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Could not load DuckDB's dta extension — this requires an internet connection the first time it's used on this machine. (${message})`
        );
      }
      const filePath = path.replace(/'/g, "''");
      await connection.run(`create view "${mainObjectName}" as select * from read_dta('${filePath}')`);
    }

    if (isArrow) {
      // Same single-view treatment as Parquet/CSV/dta. Uses DuckDB's community
      // `arrow` extension, whose read_arrow() reads the Arrow IPC *stream*
      // encoding -- the one `COPY ... TO ... (FORMAT arrow)` and polars'
      // write_ipc_stream() produce, conventionally .arrows/.arrow.
      //
      // A Feather/IPC *file* (the `ARROW1` magic that pyarrow's write_feather
      // and polars' write_ipc produce) is a DIFFERENT encoding and read_arrow
      // rejects it -- "Expected -1 field nodes in message but found 2". That is
      // why .feather is deliberately not in the selector: claiming it would
      // open a viewer that fails on the majority of files carrying that name.
      try {
        await connection.run(`install arrow from community`);
        await connection.run(`load arrow`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Could not load DuckDB's arrow extension — this requires an internet connection the first time it's used on this machine. (${message})`
        );
      }
      // Feather first: it is a specific diagnosis, and a Feather file would
      // otherwise fail the truncation check below and be reported as damaged.
      await assertNotFeatherFile(path);
      await assertArrowStreamComplete(path);
      const filePath = path.replace(/'/g, "''");
      await connection.run(`create view "${mainObjectName}" as select * from read_arrow('${filePath}')`);
    }

    if (isXlsx) {
      // The one flat format here that is genuinely MULTI-table: a workbook's
      // sheets each become their own view, named after the sheet, so the
      // sidebar lists them the way it lists a .duckdb file's tables rather
      // than collapsing a whole workbook to a single entry.
      //
      // `excel` is a core DuckDB extension (not community), but still needs
      // fetching once per machine like sqlite/dta above.
      try {
        await connection.run(`install excel`);
        await connection.run(`load excel`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Could not load DuckDB's excel extension — this requires an internet connection the first time it's used on this machine. (${message})`
        );
      }
      const sheets = await listSheets(path);
      if (sheets.length === 0) {
        throw new Error(`"${basename(path)}" declares no readable sheets.`);
      }
      const filePath = path.replace(/'/g, "''");
      const failures: string[] = [];
      for (const sheet of sheets) {
        // read_xlsx addresses a sheet by NAME, so the sheet name is a SQL
        // string literal here and a quoted identifier for the view -- two
        // different escapes, and mixing them up is how a sheet called
        // O'Brien's Data breaks the whole workbook.
        const asLiteral = sheet.name.replace(/'/g, "''");
        const asIdent = sheet.name.replace(/"/g, '""');
        try {
          await connection.run(
            `create view "${asIdent}" as select * from read_xlsx('${filePath}', sheet = '${asLiteral}')`
          );
        } catch (err) {
          // One unreadable sheet (a chart sheet, a macro sheet, an empty one)
          // must not cost the user the rest of the workbook.
          failures.push(sheet.name);
        }
      }
      if (failures.length === sheets.length) {
        throw new Error(
          `None of the ${sheets.length} sheet(s) in "${basename(path)}" could be read.`
        );
      }
    }

    if (isSqlite) {
      await ensureSqliteExtension(connection);
      const filePath = path.replace(/'/g, "''");
      if (forceReadOnly) {
        await connection.run(`attach '${filePath}' as "${mainObjectName}" (type sqlite, read_only)`);
        readOnly = true;
      } else {
        try {
          await connection.run(`attach '${filePath}' as "${mainObjectName}" (type sqlite)`);
        } catch (err) {
          // Same fallback as the direct .duckdb path above, for attached
          // SQLite files (a .db/.sqlite backup file attached elsewhere).
          if (isLockConflict(err)) {
            await connection.run(`attach '${filePath}' as "${mainObjectName}" (type sqlite, read_only)`);
            readOnly = true;
          } else {
            throw err;
          }
        }
      }
      await connection.run(`use "${mainObjectName}"`);
    }

    const catalogReader = await connection.runAndReadAll('select current_database()');
    const catalogName = String(catalogReader.getRows()[0][0]);

    // Combined hot+cold view support: a sibling file (the other half of a
    // hot/cold pair — see duckdbEditorProvider.ts's sibling detection) gets
    // ATTACHed under its own alias, always read-only regardless of whether
    // the primary connection is, so a live tick can never end up holding a
    // write lock on the sibling file via a connection whose primary handle
    // is read-only but whose attached catalog isn't. Best-effort: if the
    // sibling has vanished or isn't actually a valid database file, skip it
    // silently rather than failing the whole open — the primary file is
    // still perfectly usable without it.
    // The in-memory kinds (parquet/csv/dta) have no lock to fall back from, so
    // nothing above ever marked them read-only — but a caller that asked for
    // read-only meant it, and checkEditableSelect keys the edit affordance off
    // this flag. Without it, "Live implies read-only" held for .duckdb/.sqlite
    // and quietly didn't for flat files.
    if (forceReadOnly) readOnly = true;

    let siblingCatalogName: string | undefined;
    let siblingIsSqlite = false;
    if (options?.siblingPath) {
      const attached = await DuckDbFile.tryAttachSibling(connection, options.siblingPath);
      siblingCatalogName = attached?.alias;
      siblingIsSqlite = attached?.isSqlite ?? false;
    }

    return new DuckDbFile(
      connection,
      path,
      kind,
      catalogName,
      mainObjectName,
      readOnly,
      siblingCatalogName,
      siblingIsSqlite,
      rootCatalogName,
      options?.siblingPath
    );
  }

  private static async tryAttachSibling(
    connection: DuckDBConnection,
    siblingPath: string
  ): Promise<{ alias: string; isSqlite: boolean } | undefined> {
    const isSiblingSqlite = siblingPath.toLowerCase().endsWith('.db') || siblingPath.toLowerCase().endsWith('.sqlite');
    const alias = 'sibling';
    try {
      const filePath = siblingPath.replace(/'/g, "''");
      if (isSiblingSqlite) {
        await ensureSqliteExtension(connection);
        await connection.run(`attach '${filePath}' as ${quoteIdent(alias)} (type sqlite, read_only)`);
      } else {
        await connection.run(`attach '${filePath}' as ${quoteIdent(alias)} (read_only)`);
      }
      // Confirms the attach actually mounted a readable database (and not,
      // say, an empty/corrupt file that ATTACH accepted but nothing else
      // can query) before this file is trusted as a real combined-view
      // source — a cheap probe now avoids a confusing failure on first use.
      await connection.runAndReadAll(
        `select table_name from information_schema.tables where table_catalog = ${quoteLiteral(alias)} limit 1`
      );
      return { alias, isSqlite: isSiblingSqlite };
    } catch {
      try {
        await connection.run(`detach ${quoteIdent(alias)}`);
      } catch {
        // Attach itself never succeeded — nothing to detach.
      }
      return undefined;
    }
  }

  /** Reads a real kdb+ table (see kdbParser.ts) and loads it into a fresh in-memory table. */
  private static async openKdb(path: string): Promise<DuckDbFile> {
    let table: KdbTable;
    try {
      table = parseKdbFile(path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not read "${path}" as a kdb+ table: ${message}`);
    }

    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    const mainObjectName = basename(path, extname(path)).replace(/"/g, '""');
    await loadKdbTableIntoConnection(connection, mainObjectName, table.columns);

    const catalogReader = await connection.runAndReadAll('select current_database()');
    const catalogName = String(catalogReader.getRows()[0][0]);

    return new DuckDbFile(connection, path, 'kdb', catalogName, mainObjectName, false, undefined);
  }

  async listTables(): Promise<string[]> {
    // Scoped to the current database: once a SQLite file is ATTACHed and
    // USEd, information_schema.tables spans multiple catalogs otherwise.
    const reader = await this.connection.runAndReadAll(
      `select table_name from information_schema.tables where table_catalog = current_database() order by table_name`
    );
    return reader.getRows().map((row) => String(row[0]));
  }

  async listSiblingTables(): Promise<string[]> {
    if (!this.siblingCatalogName) return [];
    const reader = await this.connection.runAndReadAll(
      `select table_name from information_schema.tables where table_catalog = ${quoteLiteral(
        this.siblingCatalogName
      )} order by table_name`
    );
    return reader.getRows().map((row) => String(row[0]));
  }

  /** Table names present on both sides of an attached hot/cold pair -- the set eligible for a synthesized `<table>_combined` entry. */
  async getCombinableTableNames(): Promise<string[]> {
    if (!this.siblingCatalogName) return [];
    const mainTables = new Set(await this.listTables());
    const siblingTables = await this.listSiblingTables();
    return siblingTables.filter((t) => mainTables.has(t));
  }

  private async getColumnNames(table: string, catalog: string): Promise<string[]> {
    const reader = await this.connection.runAndReadAll(
      `select column_name from information_schema.columns where table_catalog = ${quoteLiteral(
        catalog
      )} and table_name = ${quoteLiteral(table)} order by ordinal_position`
    );
    return reader.getRows().map((r) => String(r[0]));
  }

  // Both writers this format targets (alpaca_extractor.py, and any future
  // one following the same convention) use one of these column names for
  // their time axis -- not stored anywhere in sheet_metadata as a distinct
  // "this is the time column" field, so this is a fixed allow-list rather
  // than something pulled from untrusted file content. Intentionally
  // conservative: a table using a differently-named time column just means
  // the combined view falls back to unbounded (see buildCombinedQuery).
  private static readonly TIME_COLUMN_CANDIDATES = ['Datetime', 'Date', 'scraped_at'];
  private static readonly DEFAULT_COMBINED_LIMIT = 500;

  /** Resolves the time column shared by both sides of a combined pair. Returns null if hot/cold don't share any of the conventional candidates. */
  private async resolveTimeColumn(table: string): Promise<string | null> {
    if (!this.siblingCatalogName) return null;
    const [mainCols, siblingCols] = await Promise.all([
      this.getColumnNames(table, this.catalogName),
      this.getColumnNames(table, this.siblingCatalogName),
    ]);
    const shared = new Set(mainCols.filter((c) => siblingCols.includes(c)));
    for (const candidate of DuckDbFile.TIME_COLUMN_CANDIDATES) {
      if (shared.has(candidate)) return candidate;
    }
    return null;
  }

  /**
   * Builds the synthesized `<table>_combined` query: a tail window (the N
   * most recent rows across both sides, re-sorted back into chronological
   * order for display — see the design notes on why a flat `DESC LIMIT N`
   * alone would show the tail backwards) when a shared time column can be
   * resolved, or an unbounded union when it can't. Both the table name and
   * the resolved time column are identifiers backed by `quoteIdent`
   * (standard `"` doubling) since both ultimately come from a file's own
   * catalog, not typed user input.
   */
  async buildCombinedQuery(
    table: string,
    limitN: number = DuckDbFile.DEFAULT_COMBINED_LIMIT
  ): Promise<{ sql: string; timeColumn: string | null }> {
    if (!this.siblingCatalogName) throw new Error('No sibling attached — buildCombinedQuery requires one.');
    const mainRef = `${quoteIdent(this.catalogName)}.main.${quoteIdent(table)}`;
    const siblingRef = `${quoteIdent(this.siblingCatalogName)}.main.${quoteIdent(table)}`;
    const union = `select *, false as is_hot from ${mainRef}\n  union all by name\n  select *, true as is_hot from ${siblingRef}`;

    const timeColumn = await this.resolveTimeColumn(table);
    if (!timeColumn) {
      return { sql: `select *\nfrom (\n  ${union}\n) as _combined`, timeColumn: null };
    }
    const col = quoteIdent(timeColumn);
    const safeLimit = Number.isInteger(limitN) && limitN > 0 ? limitN : DuckDbFile.DEFAULT_COMBINED_LIMIT;
    const sql = `select * from (\n  select *\n  from (\n    ${union}\n  ) as _union\n  order by ${col} desc\n  limit ${safeLimit}\n) as _combined\norder by ${col} asc`;
    return { sql, timeColumn };
  }

  private isMainHot(): boolean {
    return this.kind === 'sqlite';
  }

  /**
   * Best-effort read of a writer-published poll-cadence hint (see
   * alpaca_extractor.py's `_sheet_metadata_extra_json` `live_poll_seconds`
   * key) — checked on the hot side first regardless of whether that's the
   * primary file or the attached sibling, since it's the side actually
   * setting the meaningful cadence. Returns null (not a thrown error) for
   * any failure: no sheet_metadata table, no row for this table, invalid
   * JSON, or a non-numeric/non-positive value — this value comes from a
   * file's own JSON blob, exactly as untrusted as anything else pulled from
   * file content elsewhere in this class, so a corrupt or crafted value
   * must never propagate past this method as anything other than "no hint".
   */
  async getPollCadenceSeconds(table: string): Promise<number | null> {
    const candidates: string[] = [];
    // Hot side first.
    if (this.isMainHot()) candidates.push(this.catalogName);
    if (this.siblingCatalogName && this.siblingIsSqlite) candidates.push(this.siblingCatalogName);
    // Then whatever's left, in case the "hot" convention doesn't hold for a
    // future writer this wasn't designed against.
    if (!this.isMainHot()) candidates.push(this.catalogName);
    if (this.siblingCatalogName && !this.siblingIsSqlite) candidates.push(this.siblingCatalogName);

    for (const catalog of candidates) {
      const value = await this.readPollCadenceFromCatalog(table, catalog);
      if (value !== null) return value;
    }
    return null;
  }

  private async readPollCadenceFromCatalog(table: string, catalog: string): Promise<number | null> {
    try {
      const reader = await this.connection.runAndReadAll(
        `select extra_json from ${quoteIdent(catalog)}.main.sheet_metadata where table_name = ${quoteLiteral(table)}`
      );
      const rows = reader.getRows();
      if (rows.length === 0) return null;
      const raw = rows[0][0];
      if (typeof raw !== 'string') return null;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const value = parsed.live_poll_seconds;
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * Makes this connection observe writes another process has committed since
   * it was opened, *without* rebuilding the instance — the live path used to
   * pay for a full `DuckDBInstance.create` + `connect` + extension install +
   * re-ATTACH on every tick, at up to 4 ticks a second.
   *
   * Returns false when the kind can't be refreshed in place, or when the
   * refresh failed partway: either way the caller falls back to a full
   * re-open, so a connection left half-detached is always replaced rather
   * than reused. Deliberately restricted to already-read-only connections —
   * going back to read-write is a different operation and always re-opens.
   */
  async refreshInPlace(): Promise<boolean> {
    if (!this.readOnly) return false;
    try {
      switch (this.kind) {
        case 'sqlite': {
          // The SQLite scanner holds its own file handle, so re-ATTACHing is
          // what actually makes another process's commits visible. A catalog
          // can't detach itself, hence the hop through the root catalog.
          const filePath = this.path.replace(/'/g, "''");
          await this.connection.run(`use ${quoteIdent(this.rootCatalogName)}`);
          await this.connection.run(`detach ${quoteIdent(this.catalogName)}`);
          await this.connection.run(
            `attach '${filePath}' as ${quoteIdent(this.catalogName)} (type sqlite, read_only)`
          );
          await this.connection.run(`use ${quoteIdent(this.catalogName)}`);
          break;
        }
        case 'parquet':
        case 'csv':
        case 'dta':
        case 'arrow':
        case 'xlsx':
          // The view calls read_parquet()/read_csv_auto()/read_dta()/read_arrow()/
          // read_xlsx() afresh on
          // every query, so each query already re-reads the file — there is
          // genuinely nothing to refresh. The exception is a view an edit has
          // materialized into a real table, where this connection's data no
          // longer comes from the file at all.
          if (this.materialized) return false;
          break;
        case 'duckdb':
          // A DuckDB database's MVCC snapshot is fixed for the life of the
          // instance, so nothing short of a new one sees another process's
          // commits. The single kind that genuinely has to pay for a re-open.
          return false;
        case 'kdb':
          // Parsed off disk once at open (see openKdb) — no live connection to refresh.
          return false;
      }
      await this.refreshSibling();
      return true;
    } catch {
      return false;
    }
  }

  /** Re-ATTACHes the hot/cold sibling for the same reason refreshInPlace() re-ATTACHes the main file. */
  private async refreshSibling(): Promise<void> {
    if (!this.siblingCatalogName || !this.siblingPath) return;
    await this.connection.run(`detach ${quoteIdent(this.siblingCatalogName)}`);
    const attached = await DuckDbFile.tryAttachSibling(this.connection, this.siblingPath);
    // A sibling that has since vanished or gone unreadable degrades to "no
    // sibling", exactly as it would have on a fresh open.
    this.siblingCatalogName = attached?.alias;
    this.siblingIsSqlite = attached?.isSqlite ?? false;
  }

  /**
   * `maxRows <= 0` keeps the historical behaviour: whatever the query returns
   * is shown in full. Above zero, reading stops early rather than the result
   * being sliced afterwards -- the cost this cap exists to avoid is
   * materializing every row into JSON and structured-cloning the lot across
   * the webview boundary, and a post-hoc slice would still pay both.
   *
   * The cap is a parameter rather than a config read because this module
   * deliberately imports no `vscode`; duckdbEditorProvider owns the setting.
   */
  async runQuery(sql: string, maxRows = 0): Promise<QueryResult> {
    const capped = maxRows > 0;
    // One past the cap: that extra row is what distinguishes "exactly maxRows
    // rows exist" from "there were more", without reading the rest.
    const reader = capped
      ? await this.connection.streamAndReadUntil(sql, maxRows + 1)
      : await this.connection.streamAndReadAll(sql);
    const columns = reader.columnNames();
    let rows = reader.getRowsJson() as unknown[][];
    // Rows arrive a vector at a time, so a read of maxRows + 1 can overshoot.
    const truncated = capped && rows.length > maxRows;
    if (truncated) rows = rows.slice(0, maxRows);
    const columnStatsKind = reader.columnTypes().map((t) => classifyForStats(t.typeId));
    return { columns, rows, columnStatsKind, truncated };
  }

  /**
   * Sorting on the client only re-orders whatever rows a LIMIT already
   * fetched -- if the base query has a trailing LIMIT (with no matching
   * ORDER BY of its own), DuckDB's row selection for that is
   * implementation-defined, so a client-side sort can't recover the true
   * top/bottom N by a column from a set that was never guaranteed to
   * contain them. This strips that trailing LIMIT, sorts the *full*
   * underlying result, then re-applies the original LIMIT/OFFSET on the
   * outside, so "sorted" always means sorted across the whole matching
   * data set, not just whatever happened to already be in memory.
   */
  async runSortedQuery(
    baseSql: string,
    column: string,
    direction: 'asc' | 'desc',
    maxRows = 0
  ): Promise<QueryResult & { sortedSql: string }> {
    const stripped = stripTrailingSemicolon(baseSql);
    const extracted = extractTrailingLimit(stripped);
    const inner = extracted ? extracted.withoutLimit : stripped;
    const col = quoteIdent(column);
    const limitSuffix = extracted ? ` ${extracted.limitClause}` : '';
    const sortedSql = `select * from ${wrapAsSubquery(inner)} as _sorted order by ${col} ${direction} nulls last${limitSuffix}`;
    // The cap applies to the sorted result, so it stays "the true top N by
    // this column" rather than "N arbitrary rows, then sorted".
    const result = await this.runQuery(sortedSql, maxRows);
    // Handed back because the caller has to diff against the backup using the
    // *same* ordering: diffQueryAgainstBackup compares row-by-row positionally,
    // so running the unsorted base query on the backup side lights up nearly
    // every cell as changed.
    return { ...result, sortedSql };
  }

  /**
   * How many rows this query matches in total, ignoring its trailing LIMIT.
   *
   * "247 rows shown" cannot answer the question people actually have, which is
   * whether that is the whole answer. Write `limit 200` against a 146-row
   * table and you get 146 back — the same footer you would get if the table
   * held a million rows and your limit had cut it. The two cases are
   * indistinguishable from the count alone, and the cap note below only fires
   * for the viewer's OWN maxResultRows, never for a LIMIT you typed.
   *
   * Only the trailing LIMIT is stripped, by the same `extractTrailingLimit`
   * the sort path uses, so a LIMIT nested inside the query's own logic is left
   * alone. WHERE clauses are deliberately NOT stripped: the useful total is
   * "how many rows your query matches", not "how many rows the table holds" —
   * the filter is part of the question being asked.
   *
   * Returns undefined rather than throwing. A count is a nicety; a query whose
   * shape defeats the wrapper (or that gets cancelled) must still show its
   * rows.
   */
  async countMatchingRows(sql: string): Promise<number | undefined> {
    try {
      const stripped = stripTrailingSemicolon(sql);
      const extracted = extractTrailingLimit(stripped);
      const inner = extracted ? extracted.withoutLimit : stripped;
      const reader = await this.connection.runAndReadAll(
        `select count(*) from ${wrapAsSubquery(inner)} as _rowcount`
      );
      const value = reader.getRows()[0]?.[0];
      // count(*) comes back as a BIGINT, so the driver hands over a bigint.
      const total = typeof value === 'bigint' ? Number(value) : Number(value);
      return Number.isFinite(total) ? total : undefined;
    } catch {
      return undefined;
    }
  }

  /** Flushes pending writes to disk, then copies the file. Returns the backup path. */
  async createBackup(): Promise<string> {
    if (this.kind === 'kdb') {
      throw new Error("Safe Mode isn't applicable to a read-only kdb+ table.");
    }
    if (this.kind === 'sqlite') {
      await this.connection.run(`checkpoint ${quoteIdent(this.mainObjectName)}`);
    } else if (this.kind === 'duckdb') {
      await this.connection.run('checkpoint');
    }
    // .parquet/.csv have nothing to checkpoint: edits to those go through
    // materializeIfNeeded()/updateCell() below, which write back to disk
    // synchronously via writeBackFlatFile() on every edit — by the time
    // createBackup() runs, the file is already current, unlike duckdb/
    // sqlite's WAL-based writes which need an explicit flush.

    const ext = extname(this.path);
    const base = basename(this.path, ext);
    const dir = dirname(this.path);
    const backupPath = join(dir, `${base}.backup-${formatTimestamp(new Date())}${ext}`);
    await copyFile(this.path, backupPath);

    // copyFile creates the destination under the process's umask, not the
    // source's own mode bits — mirror them so a backup of a file someone
    // deliberately locked down (e.g. chmod 600) doesn't end up more
    // permissive than the original. Best-effort: never let this block the
    // backup itself. Meaningful mainly on POSIX; Windows ACLs don't map onto
    // mode bits the same way.
    try {
      const { mode } = await stat(this.path);
      await chmod(backupPath, mode);
    } catch {
      // Backup already succeeded above; permission mirroring is a nice-to-have.
    }

    // A repeat createBackup() (Safe Mode toggled off more than once) must
    // swap the attached catalog, not stack a second backup_cmp — DuckDB
    // won't allow re-attaching an alias that's already attached.
    if (this.backupAttached) {
      await this.detachBackupCatalog();
      this.backupAttached = false;
    }
    this.lastBackupPath = backupPath;
    await this.attachBackupCatalog();
    this.backupAttached = true;

    return backupPath;
  }

  private async attachBackupCatalog(): Promise<void> {
    if (!this.lastBackupPath) throw new Error('No backup available to compare against');
    if (this.kind === 'duckdb') {
      await this.connection.run(`attach ${quoteLiteral(this.lastBackupPath)} as backup_cmp (read_only)`);
    } else if (this.kind === 'sqlite') {
      await this.connection.run(
        `attach ${quoteLiteral(this.lastBackupPath)} as backup_cmp (type sqlite, read_only)`
      );
    } else {
      // Parquet/CSV: mirror the same view name inside a fresh in-memory
      // catalog, so unqualified SQL resolves against it once USEd, same as
      // the others. (If this document's own file was already materialized
      // into a table via an edit, the backup itself is still the original
      // pre-edit flat file on disk — read back with the same read_* function
      // used to open it in the first place, regardless of materialization.)
      const readFn =
        this.kind === 'parquet'
          ? 'read_parquet'
          : this.kind === 'dta'
            ? 'read_dta'
            : this.kind === 'arrow'
              ? 'read_arrow'
              : 'read_csv_auto';
      await this.connection.run(`attach ':memory:' as backup_cmp`);
      await this.connection.run('use backup_cmp');
      await this.connection.run(
        `create view ${quoteIdent(this.mainObjectName)} as select * from ${readFn}(${quoteLiteral(
          this.lastBackupPath
        )})`
      );
      await this.connection.run(`use ${quoteIdent(this.catalogName)}`);
    }
  }

  private async detachBackupCatalog(): Promise<void> {
    await this.connection.run('detach backup_cmp');
  }

  /** Table-level "did anything in this table change since the backup" summary for the sidebar. */
  async compareToBackup(): Promise<Record<string, 'unchanged' | 'changed' | 'new'>> {
    if (!this.lastBackupPath) return {};
    const status: Record<string, 'unchanged' | 'changed' | 'new'> = {};
    const tables = await this.listTables();

    const liveColsReader = await this.connection.runAndReadAll(
      `select table_name, column_name, data_type from information_schema.columns where table_catalog = ${quoteLiteral(
        this.catalogName
      )} order by table_name, ordinal_position`
    );
    const backupColsReader = await this.connection.runAndReadAll(
      `select table_name, column_name, data_type from information_schema.columns where table_catalog = 'backup_cmp' order by table_name, ordinal_position`
    );
    const liveColsByTable = groupColumnsByTable(liveColsReader.getRows());
    const backupColsByTable = groupColumnsByTable(backupColsReader.getRows());

    for (const table of tables) {
      const backupCols = backupColsByTable.get(table);
      if (!backupCols) {
        status[table] = 'new';
        continue;
      }

      const liveColsKey = (liveColsByTable.get(table) ?? []).join(',');
      const backupColsKey = backupCols.join(',');
      if (liveColsKey !== backupColsKey) {
        status[table] = 'changed';
        continue;
      }

      const qualifiedLive = `${quoteIdent(this.catalogName)}.main.${quoteIdent(table)}`;
      const qualifiedBackup = `backup_cmp.main.${quoteIdent(table)}`;
      const diffReader = await this.connection.runAndReadAll(
        `select count(*) from ((select * from ${qualifiedLive} except select * from ${qualifiedBackup}) union all (select * from ${qualifiedBackup} except select * from ${qualifiedLive}))`
      );
      const diffCount = Number(diffReader.getRows()[0][0]);
      status[table] = diffCount === 0 ? 'unchanged' : 'changed';
    }
    return status;
  }

  /**
   * Runs the same SQL against the backup and compares results, column by
   * column (matched by name, then by identical content for renames) and
   * row by row, top to bottom (positional — see plan for the known
   * limitation around inserted/deleted rows). Returns null if there's no
   * backup yet, or the query can't be run against it (e.g. a brand-new table).
   */
  async diffQueryAgainstBackup(sql: string, liveColumns: string[], liveRows: unknown[][]): Promise<QueryDiff | null> {
    if (!this.lastBackupPath) return null;
    let backupColumns: string[];
    let backupRows: unknown[][];
    try {
      await this.connection.run('use backup_cmp');
      const reader = await this.connection.streamAndReadAll(sql);
      backupColumns = reader.columnNames();
      backupRows = reader.getRowsJson() as unknown[][];
    } catch {
      return null;
    } finally {
      await this.connection.run(`use ${quoteIdent(this.catalogName)}`);
    }

    const renamedColumns: Record<string, string> = {};
    const liveToBackupCol = new Map<number, number>();
    const usedBackupCols = new Set<number>();

    liveColumns.forEach((name, i) => {
      const backupIdx = backupColumns.indexOf(name);
      if (backupIdx !== -1 && !usedBackupCols.has(backupIdx)) {
        liveToBackupCol.set(i, backupIdx);
        usedBackupCols.add(backupIdx);
      }
    });

    // Only compare over the row range both sides actually have — rows
    // beyond the backup's length are already handled via rowIsNew below,
    // and requiring equal array lengths here would reject an otherwise
    // perfect rename match just because new rows were also added since.
    const overlapLen = Math.min(liveRows.length, backupRows.length);

    // One signature per still-unmatched backup column, computed once (not
    // once per live-column candidate) and bucketed by signature — a hash
    // collision only costs one extra (cheap) exact-equality check on the
    // colliding candidate, it never reintroduces the unmatchedCols² scan.
    const backupSigBuckets = new Map<number, number[]>();
    for (let b = 0; b < backupColumns.length; b++) {
      if (usedBackupCols.has(b)) continue;
      const sig = columnSignature(backupRows, b, overlapLen);
      const bucket = backupSigBuckets.get(sig);
      if (bucket) bucket.push(b);
      else backupSigBuckets.set(sig, [b]);
    }

    liveColumns.forEach((name, i) => {
      if (liveToBackupCol.has(i)) return;
      const sig = columnSignature(liveRows, i, overlapLen);
      const candidates = backupSigBuckets.get(sig);
      if (!candidates) return;
      const liveValues = liveRows.slice(0, overlapLen).map((row) => stableStringify(row[i]));
      for (const b of candidates) {
        if (usedBackupCols.has(b)) continue;
        const backupValues = backupRows.slice(0, overlapLen).map((row) => stableStringify(row[b]));
        if (!arraysEqual(liveValues, backupValues)) continue; // hash collision, not an actual rename
        liveToBackupCol.set(i, b);
        usedBackupCols.add(b);
        renamedColumns[name] = backupColumns[b];
        break;
      }
    });

    const rowIsNew = liveRows.map((_, rowIdx) => rowIdx >= backupRows.length);
    const cellChanged = liveRows.map((row, rowIdx) =>
      row.map((value, colIdx) => {
        if (rowIsNew[rowIdx]) return false; // whole row already flagged
        const backupColIdx = liveToBackupCol.get(colIdx);
        if (backupColIdx === undefined) return false; // brand-new column, nothing to diff against
        return stableStringify(value) !== stableStringify(backupRows[rowIdx][backupColIdx]);
      })
    );

    return { cellChanged, rowIsNew, renamedColumns };
  }

  /**
   * Server-side gate for cell editing: only a plain `SELECT * FROM
   * "<one table>"` (optionally with WHERE/ORDER BY/LIMIT) is editable — no
   * joins, computed columns, or aggregates, since editing needs to target a
   * real, unambiguous row in a real table. Never trust the webview's own
   * opinion of whether a result is editable; this is always re-derived here.
   */
  async checkEditableSelect(sql: string): Promise<EditabilityInfo> {
    // kdb+ tables are read from the real on-disk file (see kdbParser.ts) into
    // an in-memory table purely so this viewer can query it -- there is no
    // write-back path to real kdb+ format, so editing is never offered.
    //
    // .xlsx is view-only for a different and sharper reason. DuckDB CAN write
    // one (`copy ... to ... (format xlsx)`), but a workbook is many sheets and
    // that writes a file containing ONE -- saving an edit to a single sheet
    // would silently destroy every other sheet in the book. It also has no
    // integer type, so a round trip turns 1 into 1.0 throughout. Neither is a
    // trade worth making silently behind a double-click.
    if (this.readOnly || this.kind === 'kdb' || this.kind === 'xlsx') return { editable: false };
    const trimmed = sql.trim();

    try {
      const extracted = await this.connection.extractStatements(trimmed);
      if (extracted.count !== 1) return { editable: false };
      const prepared = await extracted.prepare(0);
      if (prepared.statementType !== StatementType.SELECT) return { editable: false };
    } catch {
      return { editable: false };
    }

    const match = EDITABLE_SELECT_RE.exec(trimmed);
    if (!match || FORBIDDEN_KEYWORDS_RE.test(trimmed)) return { editable: false };

    const rawTable = match[1];
    const tableName = rawTable.startsWith('"') ? rawTable.slice(1, -1).replace(/""/g, '"') : rawTable;

    const tables = await this.listTables();
    const found =
      tables.find((t) => t === tableName) ?? tables.find((t) => t.toLowerCase() === tableName.toLowerCase());
    if (!found) return { editable: false };

    // Column list for the UPDATE is re-derived from the live table, not
    // parsed out of the SELECT text.
    const colsReader = await this.connection.runAndReadAll(
      `select column_name from information_schema.columns where table_catalog = current_database() and table_name = ${quoteLiteral(
        found
      )} order by ordinal_position`
    );
    const columns = colsReader.getRows().map((r) => String(r[0]));
    return { editable: true, table: found, columns };
  }

  /**
   * CSV/Parquet load as lazy VIEWs (see open()) — views over external files
   * aren't updatable, so the first actual edit attempt materializes into a
   * real TABLE under the same name. Deferred until here (not done at open
   * time) so files that are only ever browsed, never edited, keep today's
   * fast lazy-scan behavior. Wrapped in a transaction so an interruption
   * mid-sequence can't leave an orphaned temp table or a missing object.
   */
  private async materializeIfNeeded(): Promise<void> {
    if (this.materialized || !this.isFlatFileKind()) return;
    const tmpName = `${this.mainObjectName}__dfv_materialize`;
    await this.connection.run('begin transaction');
    try {
      await this.connection.run(
        `create table ${quoteIdent(tmpName)} as select * from ${quoteIdent(this.mainObjectName)}`
      );
      await this.connection.run(`drop view ${quoteIdent(this.mainObjectName)}`);
      await this.connection.run(`alter table ${quoteIdent(tmpName)} rename to ${quoteIdent(this.mainObjectName)}`);
      await this.connection.run('commit');
    } catch (err) {
      await this.connection.run('rollback');
      throw err;
    }
    this.materialized = true;
  }

  /**
   * Edits target a row via full-row equality on every column's pre-edit
   * value (null-safe via IS NOT DISTINCT FROM) — DuckDB has no stable rowid
   * across plain tables, attached SQLite tables, and materialized flat-file
   * tables alike, so there's no cheaper universal row identity available.
   * Accepted limitation: rows that are identical across every column all
   * update together (same risk-tolerance precedent as the positional-row-
   * diff limitation in diffQueryAgainstBackup above). Returns the number of
   * rows actually matched/updated, so the caller can distinguish "no
   * matching row" (0) from a successful edit.
   */
  async updateCell(
    table: string,
    column: string,
    newValue: unknown,
    rowValues: Record<string, unknown>,
    onStatus?: (message: string) => void
  ): Promise<number> {
    if (!this.materialized && this.isFlatFileKind()) {
      onStatus?.('Preparing file for editing…');
    }
    await this.materializeIfNeeded();

    const whereCols = Object.keys(rowValues);
    const whereClause = whereCols.map((c, i) => `${quoteIdent(c)} is not distinct from $${i + 2}`).join(' and ');
    const sql = `update ${quoteIdent(table)} set ${quoteIdent(column)} = $1${
      whereClause ? ` where ${whereClause}` : ''
    }`;
    // Values arrive as plain JSON (from getRowsJson()/postMessage), which
    // covers every type this feature actually supports editing/matching on
    // (scalars: string/number/boolean/null/bigint) — DuckDBValue's wrapper
    // classes for nested types are a non-goal here (BLOB/STRUCT/LIST/MAP are
    // excluded from the edit affordance entirely; if one still shows up in a
    // WHERE match for an untouched column, worst case is 0 rows matched,
    // which is already handled as a safe, surfaced error).
    const values = [newValue, ...whereCols.map((c) => rowValues[c])] as DuckDBValue[];

    const result = await this.connection.run(sql, values);
    const rowsChanged = result.rowsChanged;

    if (rowsChanged > 0 && this.isFlatFileKind()) {
      onStatus?.('Saving…');
      await this.writeBackFlatFile();
    }
    return rowsChanged;
  }

  /**
   * Rewrites the ENTIRE source file from the current (materialized) table
   * contents — CSV/Parquet have no row-level update mechanism of their own,
   * so this is the only way an edit becomes visible outside the extension.
   * Known side effect, not a bug: this reformats every row per DuckDB's
   * writer conventions, not just the edited one, so an untouched row can
   * show as "changed" in a post-edit compareToBackup() purely from
   * formatting normalization (e.g. numeric precision, quoting).
   */
  private async writeBackFlatFile(): Promise<void> {
    const filePath = this.path.replace(/'/g, "''");
    const table = quoteIdent(this.mainObjectName);
    if (this.kind === 'csv') {
      await this.connection.run(`copy ${table} to '${filePath}' (format csv, header true)`);
    } else if (this.kind === 'parquet') {
      await this.connection.run(`copy ${table} to '${filePath}' (format parquet)`);
    } else if (this.kind === 'dta') {
      // Outputs Stata format 119 (Stata 15) — the dta extension's write
      // format, regardless of the original file's own format version.
      await this.connection.run(`copy ${table} to '${filePath}' (format dta)`);
    } else if (this.kind === 'arrow') {
      await this.connection.run(`copy ${table} to '${filePath}' (format arrow)`);
    }
  }

  /** On-demand top-N most frequent values for a string/"other"-kind column. */
  async getColumnTopValues(baseSql: string, column: string, limit = 20): Promise<TopValuesStats> {
    // limit ends up interpolated directly into a LIMIT clause (integers
    // can't be bound as query parameters the way values/identifiers can) —
    // clamp it here as a second line of defense even though the caller
    // (duckdbEditorProvider.ts) already validates it, so this method stays
    // safe regardless of what calls it in the future.
    const safeLimit = Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 20;
    const wrapped = wrapAsSubquery(stripTrailingSemicolon(baseSql));
    const col = quoteIdent(column);

    const summaryReader = await this.connection.runAndReadAll(
      `select count(*) as total_rows, count(${col}) as non_null_rows, count(*) - count(${col}) as null_count, count(distinct ${col}) as distinct_count from ${wrapped} as _stats_source`
    );
    const summaryRow = summaryReader.getRowsJson()[0] as unknown[];
    const [totalRows, nonNullRows, nullCount, distinctCount] = summaryRow.map(Number);

    const topReader = await this.connection.runAndReadAll(
      `select ${col} as value, count(*) as frequency from ${wrapped} as _stats_source where ${col} is not null group by ${col} order by frequency desc, value limit ${safeLimit}`
    );
    const topValues = topReader.getRowsJson().map((row) => {
      const [value, frequency] = row as unknown[];
      return { value, frequency: Number(frequency) };
    });

    return { totalRows, nonNullRows, nullCount, distinctCount, topValues };
  }

  /** On-demand descriptive stats for a numeric/datetime-kind column. approx_quantile is approximate by design. */
  async getColumnDescriptiveStats(
    baseSql: string,
    column: string,
    statsKind: 'numeric' | 'datetime'
  ): Promise<DescriptiveStats> {
    const wrapped = wrapAsSubquery(stripTrailingSemicolon(baseSql));
    const col = quoteIdent(column);
    const meanExpr = statsKind === 'numeric' ? `avg(${col})` : `to_timestamp(avg(epoch(${col})))`;

    const reader = await this.connection.runAndReadAll(
      `select count(*) as total_rows, count(${col}) as non_null_rows, count(*) - count(${col}) as null_count,
              min(${col}) as min_value, max(${col}) as max_value, ${meanExpr} as mean_value,
              approx_quantile(${col}, 0.05) as p5, approx_quantile(${col}, 0.95) as p95
       from ${wrapped} as _stats_source`
    );
    const row = reader.getRowsJson()[0] as unknown[];
    const [totalRows, nonNullRows, nullCount, min, max, mean, p5, p95] = row;
    return {
      totalRows: Number(totalRows),
      nonNullRows: Number(nonNullRows),
      nullCount: Number(nullCount),
      min,
      max,
      mean,
      p5,
      p95,
    };
  }

  /**
   * Stops whatever query is currently in flight on this connection.
   * Verified empirically (not just from the type signature) that this
   * unblocks a pending streamAndReadAll()/streamAndReadUntil() call almost
   * immediately, and that the connection is fully reusable for a fresh
   * query right afterward — DuckDB's own type definitions don't document
   * either guarantee.
   */
  interruptCurrentQuery(): void {
    this.connection.interrupt();
  }

  dispose(): void {
    this.connection.closeSync();
  }
}
