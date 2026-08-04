import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { basename, dirname, extname, join } from 'node:path';
import { copyFile } from 'node:fs/promises';

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
}

export interface QueryDiff {
  cellChanged: boolean[][];
  rowIsNew: boolean[];
  renamedColumns: Record<string, string>;
}

export type FileKind = 'duckdb' | 'parquet' | 'sqlite';

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

export class DuckDbFile {
  private lastBackupPath: string | undefined;
  private backupAttached = false;

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

  static async open(path: string): Promise<DuckDbFile> {
    const isParquet = path.toLowerCase().endsWith('.parquet');
    const isSqlite = path.toLowerCase().endsWith('.db') || path.toLowerCase().endsWith('.sqlite');
    const useMemory = isParquet || isSqlite;
    const kind: FileKind = isParquet ? 'parquet' : isSqlite ? 'sqlite' : 'duckdb';

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
    return { columns, rows };
  }

  /** Flushes pending writes to disk, then copies the file. Returns the backup path. */
  async createBackup(): Promise<string> {
    if (this.kind === 'sqlite') {
      await this.connection.run(`checkpoint ${quoteIdent(this.mainObjectName)}`);
    } else if (this.kind === 'duckdb') {
      await this.connection.run('checkpoint');
    }
    // .parquet is never written to, nothing to flush.

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
      // Parquet: mirror the same view name inside a fresh in-memory catalog,
      // so unqualified SQL resolves against it once USEd, same as the others.
      await this.connection.run(`attach ':memory:' as backup_cmp`);
      await this.connection.run('use backup_cmp');
      await this.connection.run(
        `create view ${quoteIdent(this.mainObjectName)} as select * from read_parquet(${quoteLiteral(
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

  dispose(): void {
    this.connection.closeSync();
  }
}
