/**
 * Minimal types for node:sqlite, which @types/node 20 predates.
 *
 * The tests use it as an INDEPENDENT reader and writer of SQLite files -- one
 * that is neither DuckDB nor this extension -- so that "the file holds this,
 * in this storage class" is a claim something other than the code under test
 * makes. Only what those tests call is declared.
 */
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
    close(): void;
  }
}
