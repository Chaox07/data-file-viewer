import type { DuckDBConnection } from '@duckdb/node-api';

/** Host-owned limits; these are not grants that webview messages can change. */
export const QUERY_LIMITS = Object.freeze({
  sqlBytes: 256 * 1024,
  resultBytes: 32 * 1024 * 1024,
  cellBytes: 4 * 1024 * 1024,
  catalogBytes: 1024 * 1024,
  filters: 100,
  filterChars: 4000,
  queuedRequests: 8,
  deadlineMs: 30_000,
  cancelDeadlineMs: 2_000,
});

export class QueryPolicyError extends Error {
  constructor(message: string) { super(message); this.name = 'QueryPolicyError'; }
}

export function validateSqlSize(sql: unknown): asserts sql is string {
  if (typeof sql !== 'string' || !sql.trim() || Buffer.byteLength(sql, 'utf8') > QUERY_LIMITS.sqlBytes) {
    throw new QueryPolicyError('Enter a SQL query no larger than 256 KiB.');
  }
}

/** Call after host-selected extension bootstrap and before binding dataset views.
 * Canonical paths must be derived by the host, never by SQL or a webview message.
 * This is an engine capability restriction, not a sandbox for native-code exploits.
 */
export async function restrictQueryEngine(connection: DuckDBConnection, paths: readonly string[]): Promise<void> {
  const literals = paths.map(p => `'${p.replace(/'/g, "''")}'`).join(',');
  for (const sql of [
    `set allowed_paths = [${literals}]`,
    'set autoinstall_known_extensions = false',
    'set autoload_known_extensions = false',
    'set allow_persistent_secrets = false',
    'set enable_external_access = false',
    "set memory_limit = '512MB'",
    'set threads = 2',
    "set max_temp_directory_size = '0B'",
    'set enable_logging = false',
    'set lock_configuration = true',
  ]) await connection.run(sql);
}

/** Refuse large values explicitly; do not present clipped text as complete data. */
export function validateResultSize(value: unknown): void {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json ?? '', 'utf8') > QUERY_LIMITS.resultBytes) {
    throw new QueryPolicyError('Query result exceeds 32 MiB. Select fewer columns or rows.');
  }
}

export interface QueryRelation {
  catalog: string;
  schema: string;
  name: string;
  /** Host-created format views have already been constructed from approved paths. */
  trustedView?: boolean;
  viewSql?: string;
}

/** getTableNames expands existing views and loses worksheet names. Serialization
 * preserves syntactic references without interpreting quoted text as a reference.
 */
export async function referencedQueryTables(connection: DuckDBConnection, sql: string): Promise<Set<string>> {
  const reader = await connection.runAndReadAll('select system.main.json_serialize_sql(?::varchar)', [sql]);
  const ast = JSON.parse(String(reader.getRows()[0][0]));
  const names = new Set<string>();
  const stack: unknown[] = [ast];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (!Array.isArray(node) && (node as Record<string, unknown>).type === 'BASE_TABLE') {
      names.add(String((node as Record<string, unknown>).table_name));
    }
    stack.push(...Object.values(node));
  }
  return names;
}

/** Extract only the SELECT body of DuckDB's canonical CREATE VIEW definition.
 * The body is then parsed by DuckDB, never interpreted by this header scanner.
 */
function viewBody(sql: string): string {
  let i = 0;
  let depth = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < sql.length) {
        if (sql[i++] !== quote) continue;
        if (sql[i] === quote) { i++; continue; }
        break;
      }
    } else if (ch === '(') { depth++; i++; }
    else if (ch === ')') { depth--; i++; }
    else if (/[A-Za-z_]/.test(ch)) {
      const start = i++;
      while (i < sql.length && /[A-Za-z_0-9]/.test(sql[i])) i++;
      if (depth === 0 && sql.slice(start, i).toLowerCase() === 'as') return sql.slice(i);
    } else i++;
  }
  throw new QueryPolicyError('This stored view cannot be inspected safely.');
}

/** Native parser-backed authorization of user expressions. Binding/execution is
 * always under the locked engine policy as well. Generated host schema queries
 * never enter this user-facing channel.
 */
export class ReadSqlPolicy {
  private functions?: Set<string>;

  constructor(private readonly connection: DuckDBConnection, private readonly catalog: string) {}

  async validate(sql: string, relations: readonly QueryRelation[]): Promise<void> {
    validateSqlSize(sql);
    if (!this.functions) {
      const reader = await this.connection.runAndReadAll(
        `select function_name from system.main.duckdb_functions()
         group by function_name having bool_and(internal)
         and bool_and(function_type in ('scalar','aggregate','macro'))
         and not bool_or(coalesce(has_side_effects,false))`
      );
      this.functions = new Set(reader.getRows().map(row => String(row[0]).toLowerCase()));
    }
    const inspected = new Set<string>();
    const inspect = async (text: string, viewDepth = 0): Promise<void> => {
      if (viewDepth > 32) throw new QueryPolicyError('Stored view nesting exceeds the query limit.');
      const serialized = await this.connection.runAndReadAll('select system.main.json_serialize_sql(?::varchar)', [text]);
      const ast = JSON.parse(String(serialized.getRows()[0][0]));
      if (ast.error || !Array.isArray(ast.statements) || ast.statements.length !== 1) {
        throw new QueryPolicyError('Enter one SELECT query. SQL writes and configuration commands are unavailable; use the existing cell editor for changes.');
      }
      const walk = async (node: unknown, depth: number, inheritedCtes: ReadonlySet<string> = new Set()): Promise<void> => {
        if (depth > 256) throw new QueryPolicyError('SQL nesting exceeds the query limit.');
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { for (const value of node) await walk(value, depth + 1, inheritedCtes); return; }
        const n = node as Record<string, any>;
        const ctes = new Set(inheritedCtes);
        if (n.cte_map?.map) for (const entry of n.cte_map.map) ctes.add(String(entry.key).toLowerCase());
        if (n.type === 'TABLE_FUNCTION') {
          if (!['range', 'generate_series', 'unnest'].includes(String(n.function?.function_name).toLowerCase())) {
            throw new QueryPolicyError('Query the opened document tables. External readers and system table functions are unavailable.');
          }
        }
        if (n.class === 'FUNCTION') {
          const name = String(n.function_name).toLowerCase();
          const safeTableFunction = ['range', 'generate_series', 'unnest'].includes(name);
          if ((!this.functions!.has(name) && !safeTableFunction) ||
              /^(duckdb_|pragma_|read_|sqlite_|query$|query_table$|current_setting$|getenv$|which_secret$|json_execute|write_|nextval$|setseed$)/.test(name) ||
              n.catalog || (n.schema && n.schema !== 'main')) {
            throw new QueryPolicyError('This function is unavailable in document queries.');
          }
        }
        if (n.type === 'BASE_TABLE') {
          const name = String(n.table_name);
          if (!n.catalog_name && !n.schema_name && ctes.has(name.toLowerCase())) return;
          const relation = relations.find(r =>
            r.name.toLowerCase() === name.toLowerCase() &&
            r.catalog.toLowerCase() === String(n.catalog_name || this.catalog).toLowerCase() &&
            r.schema.toLowerCase() === String(n.schema_name || 'main').toLowerCase());
          if (!relation) throw new QueryPolicyError('Select a table from this document’s query catalog. System and unrelated catalogs are unavailable.');
          if (relation.viewSql && !relation.trustedView) {
            const key = JSON.stringify([relation.catalog, relation.schema, relation.name]);
            if (!inspected.has(key)) { inspected.add(key); await inspect(viewBody(relation.viewSql), viewDepth + 1); }
          }
        }
        for (const value of Object.values(n)) await walk(value, depth + 1, ctes);
      };
      await walk(ast, 0);
    };
    await inspect(sql);
  }
}
