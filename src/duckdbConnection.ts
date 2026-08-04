import { DuckDBConnection, DuckDBInstance, DuckDBTypeId, DuckDBValue, StatementType } from '@duckdb/node-api';
import { basename, dirname, extname, join } from 'node:path';
import { copyFile } from 'node:fs/promises';

export type StatsKind = 'numeric' | 'datetime' | 'other';

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  columnStatsKind: StatsKind[];
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
  p25: unknown;
  median: unknown;
  p75: unknown;
}

export type FileKind = 'duckdb' | 'parquet' | 'sqlite' | 'csv';

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

function fnv1aFold(hash: number, str: string): number {
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash;
}

/** Cheap per-column content signature used to narrow rename-match candidates
 *  before falling back to an exact array comparison (below). */
function columnSignature(rows: unknown[][], colIdx: number, len: number): number {
  let hash = 0x811c9dc5;
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

function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;\s*$/, '');
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
    private readonly readOnly: boolean
  ) {}

  isReadOnly(): boolean {
    return this.readOnly;
  }

  private isFlatFileKind(): boolean {
    return this.kind === 'parquet' || this.kind === 'csv';
  }

  static async open(path: string): Promise<DuckDbFile> {
    const isParquet = path.toLowerCase().endsWith('.parquet');
    const isCsv = path.toLowerCase().endsWith('.csv');
    const isSqlite = path.toLowerCase().endsWith('.db') || path.toLowerCase().endsWith('.sqlite');
    const useMemory = isParquet || isCsv || isSqlite;
    const kind: FileKind = isParquet ? 'parquet' : isCsv ? 'csv' : isSqlite ? 'sqlite' : 'duckdb';

    let instance: DuckDBInstance;
    let readOnly = false;
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
    const connection = await instance.connect();

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

    if (isSqlite) {
      try {
        await connection.run(`install sqlite`);
        await connection.run(`load sqlite`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Could not load DuckDB's SQLite extension — this requires an internet connection the first time it's used on this machine. (${message})`
        );
      }
      const filePath = path.replace(/'/g, "''");
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
      await connection.run(`use "${mainObjectName}"`);
    }

    const catalogReader = await connection.runAndReadAll('select current_database()');
    const catalogName = String(catalogReader.getRows()[0][0]);

    return new DuckDbFile(connection, path, kind, catalogName, mainObjectName, readOnly);
  }

  async listTables(): Promise<string[]> {
    // Scoped to the current database: once a SQLite file is ATTACHed and
    // USEd, information_schema.tables spans multiple catalogs otherwise.
    const reader = await this.connection.runAndReadAll(
      `select table_name from information_schema.tables where table_catalog = current_database() order by table_name`
    );
    return reader.getRows().map((row) => String(row[0]));
  }

  async runQuery(sql: string): Promise<QueryResult> {
    // No row cap: whatever the query returns is shown in full. If you want a
    // bounded preview, write your own LIMIT (e.g. via the sidebar click).
    const reader = await this.connection.streamAndReadAll(sql);
    const columns = reader.columnNames();
    const rows = reader.getRowsJson() as unknown[][];
    const columnStatsKind = reader.columnTypes().map((t) => classifyForStats(t.typeId));
    return { columns, rows, columnStatsKind };
  }

  /** Flushes pending writes to disk, then copies the file. Returns the backup path. */
  async createBackup(): Promise<string> {
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
      const readFn = this.kind === 'parquet' ? 'read_parquet' : 'read_csv_auto';
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
    if (this.readOnly) return { editable: false };
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
    rowValues: Record<string, unknown>
  ): Promise<number> {
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
    }
  }

  /** On-demand top-N most frequent values for a string/"other"-kind column. */
  async getColumnTopValues(baseSql: string, column: string, limit = 20): Promise<TopValuesStats> {
    const wrapped = `(${stripTrailingSemicolon(baseSql)})`;
    const col = quoteIdent(column);

    const summaryReader = await this.connection.runAndReadAll(
      `select count(*) as total_rows, count(${col}) as non_null_rows, count(*) - count(${col}) as null_count, count(distinct ${col}) as distinct_count from ${wrapped} as _stats_source`
    );
    const summaryRow = summaryReader.getRowsJson()[0] as unknown[];
    const [totalRows, nonNullRows, nullCount, distinctCount] = summaryRow.map(Number);

    const topReader = await this.connection.runAndReadAll(
      `select ${col} as value, count(*) as frequency from ${wrapped} as _stats_source where ${col} is not null group by ${col} order by frequency desc, value limit ${limit}`
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
    const wrapped = `(${stripTrailingSemicolon(baseSql)})`;
    const col = quoteIdent(column);
    const meanExpr = statsKind === 'numeric' ? `avg(${col})` : `to_timestamp(avg(epoch(${col})))`;

    const reader = await this.connection.runAndReadAll(
      `select count(*) as total_rows, count(${col}) as non_null_rows, count(*) - count(${col}) as null_count,
              min(${col}) as min_value, max(${col}) as max_value, ${meanExpr} as mean_value,
              approx_quantile(${col}, 0.25) as p25, approx_quantile(${col}, 0.5) as median, approx_quantile(${col}, 0.75) as p75
       from ${wrapped} as _stats_source`
    );
    const row = reader.getRowsJson()[0] as unknown[];
    const [totalRows, nonNullRows, nullCount, min, max, mean, p25, median, p75] = row;
    return {
      totalRows: Number(totalRows),
      nonNullRows: Number(nonNullRows),
      nullCount: Number(nullCount),
      min,
      max,
      mean,
      p25,
      median,
      p75,
    };
  }

  dispose(): void {
    this.connection.closeSync();
  }
}
