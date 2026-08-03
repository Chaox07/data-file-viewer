import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { basename, extname } from 'node:path';

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
}

export class DuckDbFile {
  private constructor(private readonly connection: DuckDBConnection) {}

  static async open(path: string): Promise<DuckDbFile> {
    const isParquet = path.toLowerCase().endsWith('.parquet');
    const isSqlite = path.toLowerCase().endsWith('.db');
    const useMemory = isParquet || isSqlite;

    let instance: DuckDBInstance;
    try {
      // Neither a .parquet nor a .db (SQLite) file is itself a DuckDB
      // database — open an in-memory instance and expose the file's data
      // through it instead (view / ATTACH, below).
      instance = await DuckDBInstance.create(useMemory ? ':memory:' : path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/lock/i.test(message)) {
        throw new Error(
          'This file is already open elsewhere — DuckDB only allows one connection at a time.'
        );
      }
      throw new Error(`Could not open "${path}": ${message}`);
    }
    const connection = await instance.connect();

    if (isParquet) {
      // Exposed as a single view named after the file, so the sidebar's
      // "click a table to preview it" behavior works unchanged — Parquet
      // has no concept of multiple tables, just the one dataset.
      const viewName = basename(path, extname(path)).replace(/"/g, '""');
      const filePath = path.replace(/'/g, "''");
      await connection.run(`create view "${viewName}" as select * from read_parquet('${filePath}')`);
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
      const alias = basename(path, extname(path)).replace(/"/g, '""');
      const filePath = path.replace(/'/g, "''");
      await connection.run(`attach '${filePath}' as "${alias}" (type sqlite)`);
      await connection.run(`use "${alias}"`);
    }

    return new DuckDbFile(connection);
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

  dispose(): void {
    this.connection.closeSync();
  }
}
