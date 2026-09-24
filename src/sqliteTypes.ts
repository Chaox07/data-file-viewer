/**
 * SQLite columns declared with no type at all, and how this viewer reads them.
 *
 * `create table places (id, name, value real)` is legal SQLite: `id` and
 * `name` are declared with no type. SQLite keeps each VALUE's own storage
 * class there, so "İstanbul" is stored as text exactly as it would be in a
 * `text` column -- but a DECLARED type is all DuckDB's sqlite scanner has to
 * go on, and no declared type means BLOB affinity, so it reads the column as
 * BLOB. That is not a display quirk:
 *
 *   - the grid shows "İstanbul" as "\xC4\xB0stanbul" (a BLOB's hex escaping),
 *   - `where name = 'İstanbul'` fails outright ("Invalid byte encountered in
 *     STRING -> BLOB conversion"), so the column cannot be filtered on,
 *   - the same conversion failure hits the WHERE of an edit, so no cell of
 *     such a ROW can be edited, not just that column,
 *   - a whole-number column reads as BLOB too, so it sorts and filters as
 *     bytes rather than as numbers.
 *
 * ETL wrote files like this until phase 8 (polars handed ADBC `string_view`,
 * which the SQLite driver left untyped); it no longer does, but files from
 * other tools are outside anybody's control here, so the viewer has to read
 * them properly rather than the writers being asked to.
 *
 * What this does about it: ask SQLITE ITSELF what is actually stored. Every
 * value's storage class is `typeof()`, and a column whose values are all one
 * class can be read as that class. So the file is ATTACHed under a hidden
 * alias and the catalog the rest of the extension talks to is an in-memory
 * one holding one view per table, where such a column is decoded back to what
 * it holds. Everything downstream -- the grid, filters, sorting, charts,
 * column stats, the backup diff -- then sees text as text and numbers as
 * numbers, because they are all reading the same view.
 *
 * Deliberately conservative. A column is retyped only when it has NO declared
 * type (a declared `blob` is left alone -- it means what it says) and only
 * when every non-null value agrees on one class, so a column genuinely mixing
 * text and numbers keeps today's behaviour rather than this guessing which
 * half to honour. Text decoding is validated before adoption. Numeric reads use exact
 * transport; mixed numeric columns with wide integers are shown as exact text.
 */
import type { DuckDBConnection } from '@duckdb/node-api';

/** What an untyped column's values turned out to be. */
export type SqliteRetype = 'VARCHAR' | 'BIGINT' | 'DOUBLE';

export interface SqliteTablePlan {
  /** Column name -> the type its stored values justify. Empty when nothing needed retyping. */
  readonly retyped: ReadonlyMap<string, SqliteRetype>;
  /** The view body: `select <expr> as "col", ... from <source>.main."table"`. */
  readonly selectSql: string;
  /** The table's columns, in order, as the scanner reports them. */
  readonly columns: readonly string[];
  readonly columnTypes: readonly string[];
  readonly undeclared: readonly string[];
  /** Numeric values that cannot share a lossless DOUBLE are displayed as exact text. */
  readonly numericText: ReadonlySet<string>;
  /** Same reading as the view, plus an internal row identity, for edit lookup. */
  readonly lookupSql: string;
  readonly rowIdentity: string;
}

/** Table name -> how it is read. Every table gets an entry, retyped or not. */
export type SqlitePlan = ReadonlyMap<string, SqliteTablePlan>;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * A string literal INSIDE the SQL handed to `sqlite_query`. Two parsers see
 * that SQL in turn -- SQLite's, and DuckDB's, which the whole statement
 * reaches as one literal of its own -- so this does the SQLite half and
 * `quoteLiteral` on the finished statement does DuckDB's.
 */
function sqliteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The expression a retyped column is read through.
 *
 * `decode` is the blob -> text step (it validates UTF-8 rather than replacing
 * bad bytes, which is why a column that fails it is not retyped). The numeric
 * cases go through the same step first because what the scanner handed over
 * for an integer value is the DIGITS, as bytes.
 */
export function retypeExpr(column: string, type: SqliteRetype): string {
  const decoded = `decode(${quoteIdent(column)})`;
  return type === 'VARCHAR' ? decoded : `cast(${decoded} as ${type})`;
}

/** `typeof()` over one column, as SQLite reports it, collapsed to the distinct classes present. */
function classQuery(table: string, columns: readonly string[]): string {
  const parts = columns.map(
    (c) => `group_concat(distinct typeof(${quoteIdent(c)}))`
  );
  return `select ${parts.join(', ')} from ${quoteIdent(table)}`;
}

/** The classes SQLite reported for one column, e.g. "text,null" -> ['text','null']. */
function splitClasses(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  return String(value)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * The type a set of storage classes justifies, or undefined to leave the
 * column alone. 'null' is ignored: a column of nothing but NULLs has nothing
 * to go on and is left as it is.
 */
export function typeForClasses(classes: readonly string[]): SqliteRetype | undefined {
  const present = new Set(classes.filter((c) => c !== 'null'));
  if (present.size === 0) return undefined;
  if (present.size === 1 && present.has('text')) return 'VARCHAR';
  if (present.size === 1 && present.has('integer')) return 'BIGINT';
  if (![...present].every((c) => c === 'integer' || c === 'real')) return undefined;
  return 'DOUBLE';
}

async function rows(connection: DuckDBConnection, sql: string): Promise<unknown[][]> {
  const reader = await connection.runAndReadAll(sql);
  return reader.getRows() as unknown[][];
}

/** Columns SQLite declares with no type at all, for one table. */
async function undeclaredColumns(
  connection: DuckDBConnection,
  sourceCatalog: string,
  table: string
): Promise<string[]> {
  const pragma = `select name, type from pragma_table_info(${sqliteLiteral(table)})`;
  const reader = await rows(
    connection,
    `select * from sqlite_query(${quoteLiteral(sourceCatalog)}, ${quoteLiteral(pragma)})`
  );
  return reader.filter((r) => String(r[1] ?? '').trim() === '').map((r) => String(r[0]));
}

/**
 * undeclaredColumns' pragma for every table in one SQLite query, in each
 * table's column order; `undefined` if SQLite refuses the joined form.
 */
async function declaredTypesByTable(
  connection: DuckDBConnection,
  sourceCatalog: string
): Promise<Map<string, [string, string][]> | undefined> {
  const sql = `select m.name as table_name, p.name as column_name, p.type as declared_type from sqlite_master m, pragma_table_info(m.name) p ` +
    `where m.type in ('table', 'view') order by m.name, p.cid`;
  try {
    const out = new Map<string, [string, string][]>();
    for (const r of await rows(connection, `select * from sqlite_query(${quoteLiteral(sourceCatalog)}, ${quoteLiteral(sql)})`)) {
      const table = String(r[0]);
      if (!out.has(table)) out.set(table, []);
      out.get(table)!.push([String(r[1]), String(r[2] ?? '')]);
    }
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Proves the decoding against the real values before it is used, because
 * `typeof()` answers for storage classes and not for what DuckDB can do with
 * the bytes -- text SQLite accepted can still be invalid UTF-8, and digits
 * SQLite calls an integer can still be wider than BIGINT. A column that does
 * not survive its own expression is dropped from the plan rather than left to
 * fail later, in the middle of somebody's query.
 */
async function keepWhatDecodes(
  connection: DuckDBConnection,
  sourceRef: string,
  candidates: Map<string, SqliteRetype>
): Promise<Map<string, SqliteRetype>> {
  if (candidates.size === 0) return candidates;
  const probe = (cols: Map<string, SqliteRetype>) =>
    `select ${[...cols]
      .map(([c, t]) => `count(${retypeExpr(c, t)})`)
      .join(', ')} from ${sourceRef}`;
  try {
    await rows(connection, probe(candidates));
    return candidates;
  } catch {
    // One bad column must not cost the others their retyping.
    const kept = new Map<string, SqliteRetype>();
    for (const [column, type] of candidates) {
      const one = new Map([[column, type]]);
      try {
        await rows(connection, probe(one));
        kept.set(column, type);
      } catch {
        // Left as the scanner read it.
      }
    }
    return kept;
  }
}

/**
 * Serialize a SQLite REAL as its signed 53-bit mantissa and binary exponent.
 * SQLite's scanner and even older printf('%!.26g') implementations round at
 * extreme exponents. Scaling by powers of two is exact, including subnormals.
 * At most eleven recursive steps normalize a finite binary64 value to [1, 2).
 */
function binaryReal(column: string): string {
  // Older SQLite decimal parsers also round long power-of-two literals.
  // Build exact powers from exactly representable small factors instead.
  const power = (n: number): string => '(' + [
    ...Array(Math.floor(n / 32)).fill('4294967296.0'), `${2 ** (n % 32)}.0`,
  ].join(' * ') + ')';
  const powers = [512, 256, 128, 64, 32, 16, 8, 4, 2, 1];
  const down = powers.map((n) => `when abs(m) >= ${power(n)} then m / ${power(n)}`).join(' ');
  const up = powers.map((n) => `when abs(m) < ${`(2.0 / ${power(n)})`} then m * ${power(n)}`).join(' ');
  const downExp = powers.map((n) => `when abs(m) >= ${power(n)} then e + ${n}`).join(' ');
  const upExp = powers.map((n) => `when abs(m) < ${`(2.0 / ${power(n)})`} then e - ${n}`).join(' ');
  return `case when ${column} = 0 then 'r0:0'
    when abs(${column}) > ((2.0 - 1.0 / 4503599627370496.0) * ${power(512)} * ${power(511)}) then
      case when ${column} > 0 then 'Infinity' else '-Infinity' end
    else (with recursive bits(m,e) as (
      select ${column}, 0 union all
      select case ${down} ${up} else m end, case ${downExp} ${upExp} else e end
      from bits where abs(m) >= 2 or abs(m) < 1
    ) select 'r' || cast(cast(m * 4503599627370496 as integer) as text) || ':' || cast(e as text)
      from bits where abs(m) >= 1 and abs(m) < 2) end`;
}

/** All fields travel as text/hex, then regain their declared or inferred type. */
function exactNumericSelect(
  sourceCatalog: string, table: string, columns: readonly string[], types: readonly string[],
  retyped: ReadonlyMap<string, SqliteRetype>, numericText: ReadonlySet<string>,
  rowIdentity?: string
): string {
  const sqliteFields: string[] = [];
  const fields: string[] = [];
  columns.forEach((column, i) => {
    const q = quoteIdent(column);
    const type = retyped.get(column) ?? types[i];
    let encoded: string;
    if (type === 'BLOB') encoded = `hex(cast(${q} as blob))`;
    else if (type === 'DOUBLE' || numericText.has(column)) {
      encoded = `case when typeof(${q}) = 'real' then ${binaryReal(q)} else cast(${q} as text) end`;
    } else encoded = `cast(${q} as text)`;
    sqliteFields.push(`case when ${q} is null then null else ${encoded} end as ${q}`);
    let decoded = type === 'BLOB' ? `unhex(${q})` : `cast(${q} as ${type})`;
    if (type === 'DOUBLE' || numericText.has(column)) {
      const real = `(cast(split_part(substr(${q}, 2), ':', 1) as double) / 4503599627370496.0
        * pow(2.0, cast(split_part(${q}, ':', 2) as integer)))`;
      decoded = `case when starts_with(${q}, 'r') then cast(${real} as ${type}) else cast(${q} as ${type}) end`;
    }
    fields.push(`${decoded} as ${q}`);
  });
  if (rowIdentity) {
    sqliteFields.push(`cast(rowid as text) as ${quoteIdent(rowIdentity)}`);
    fields.push(`cast(${quoteIdent(rowIdentity)} as bigint) as ${quoteIdent(rowIdentity)}`);
  }
  const sql = `select ${sqliteFields.join(', ')} from ${quoteIdent(table)}`;
  return `select ${fields.join(', ')} from sqlite_query(${quoteLiteral(sourceCatalog)}, ${quoteLiteral(sql)})`;
}

/**
 * Recheck untyped columns after file changes: storage classes can change without
 * any DDL. Fully declared tables need only a schema check, never a value scan.
 * Live refresh's existing file-change gate avoids work on unchanged files.
 */
export async function planSqliteTables(
  connection: DuckDBConnection, sourceCatalog: string, previous?: SqlitePlan
): Promise<SqlitePlan> {
  const tables = (await rows(connection,
    `select table_name from information_schema.tables where table_catalog = ${quoteLiteral(sourceCatalog)}
     and table_schema = 'main' order by table_name`
  )).map((r) => String(r[0]));
  const plan = new Map<string, SqliteTablePlan>();
  // Two catalog reads for the whole file instead of two per table: a 200-table
  // database spent ~0.9 s opening on these alone. A table missing from either
  // batch (a name the two catalogs spell differently) takes the per-table query
  // it always did, so the plan cannot differ.
  const schemas = new Map<string, unknown[][]>();
  for (const r of await rows(connection,
    `select table_name, column_name, data_type from information_schema.columns
     where table_catalog = ${quoteLiteral(sourceCatalog)} and table_schema = 'main'
     order by table_name, ordinal_position`)) {
    const name = String(r[0]);
    if (!schemas.has(name)) schemas.set(name, []);
    schemas.get(name)!.push([r[1], r[2]]);
  }
  const declared = await declaredTypesByTable(connection, sourceCatalog);
  for (const table of tables) {
    const sourceRef = `${quoteIdent(sourceCatalog)}.main.${quoteIdent(table)}`;
    const schema = schemas.get(table) ?? await rows(connection,
      `select column_name, data_type from information_schema.columns
       where table_catalog = ${quoteLiteral(sourceCatalog)} and table_schema = 'main'
       and table_name = ${quoteLiteral(table)} order by ordinal_position`);
    const columns = schema.map((r) => String(r[0]));
    const columnTypes = schema.map((r) => String(r[1]));
    const pragma = declared?.get(table);
    const undeclared = pragma
      ? pragma.filter(([, type]) => type.trim() === '').map(([name]) => name)
      : await undeclaredColumns(connection, sourceCatalog, table);
    const before = previous?.get(table);
    if (before && undeclared.length === 0 && before.undeclared.length === 0 &&
        JSON.stringify(schema) === JSON.stringify(before.columns.map((c, i) => [c, before.columnTypes[i]]))) {
      plan.set(table, before);
      continue;
    }
    let retyped = new Map<string, SqliteRetype>();
    const numericText = new Set<string>();
    if (undeclared.length > 0) {
      const classes = await rows(connection,
        `select * from sqlite_query(${quoteLiteral(sourceCatalog)}, ${quoteLiteral(classQuery(table, undeclared))})`);
      const seen = classes[0] ?? [];
      undeclared.forEach((column, i) => {
        const type = typeForClasses(splitClasses(seen[i]));
        if (type) retyped.set(column, type);
      });
      // Text and integers survive the scanner's BLOB transport exactly. REAL
      // must bypass it, so do not validate REAL using that lossy transport.
      const safe = await keepWhatDecodes(connection, sourceRef,
        new Map([...retyped].filter(([, t]) => t !== 'DOUBLE')));
      retyped = new Map([...retyped].filter(([c, t]) => t === 'DOUBLE' || safe.has(c)));
      const doubles = [...retyped].filter(([, t]) => t === 'DOUBLE').map(([c]) => c);
      if (doubles.length) {
        const sql = `select ${doubles.map((c) =>
          `max(case when typeof(${quoteIdent(c)}) = 'integer' and
           (${quoteIdent(c)} > 9007199254740992 or ${quoteIdent(c)} < -9007199254740992)
           then 1 else 0 end)`).join(', ')} from ${quoteIdent(table)}`;
        const unsafe = (await rows(connection,
          `select * from sqlite_query(${quoteLiteral(sourceCatalog)}, ${quoteLiteral(sql)})`))[0] ?? [];
        doubles.forEach((c, i) => {
          if (Number(unsafe[i]) === 1) { retyped.set(c, 'VARCHAR'); numericText.add(c); }
        });
      }
    }
    let rowIdentity = '__dfv_row_identity';
    while (columns.some((c) => c.toLowerCase() === rowIdentity.toLowerCase())) rowIdentity += '_';
    const exactNumeric = numericText.size > 0 || [...retyped.values()].includes('DOUBLE');
    const projection = columns.map((c) => {
      const type = retyped.get(c);
      return type ? `${retypeExpr(c, type)} as ${quoteIdent(c)}` : quoteIdent(c);
    }).join(', ');
    const selectSql = exactNumeric
      ? exactNumericSelect(sourceCatalog, table, columns, columnTypes, retyped, numericText)
      : `select ${projection} from ${sourceRef}`;
    const lookupSql = exactNumeric
      ? exactNumericSelect(sourceCatalog, table, columns, columnTypes, retyped, numericText, rowIdentity)
      : `select ${projection}, rowid as ${quoteIdent(rowIdentity)} from ${sourceRef}`;
    plan.set(table, { retyped, selectSql, lookupSql, rowIdentity, columns, columnTypes, undeclared, numericText });
  }
  return plan;
}

/**
 * Builds the catalog the rest of the extension reads: one view per table, in
 * an in-memory catalog carrying the name the file would have had. Views are
 * replaced rather than the catalog rebuilt, so a refresh keeps every name
 * queryable throughout.
 */
export async function createSqliteViews(
  connection: DuckDBConnection,
  viewCatalog: string,
  plan: SqlitePlan
): Promise<void> {
  const wanted = new Set(plan.keys());
  const existing = (
    await rows(
      connection,
      `select table_name from information_schema.tables where table_catalog = ${quoteLiteral(viewCatalog)}`
    )
  ).map((r) => String(r[0]));
  for (const name of existing) {
    // A table the writer dropped must stop being queryable here too.
    if (!wanted.has(name)) {
      await connection.run(`drop view if exists ${quoteIdent(viewCatalog)}.main.${quoteIdent(name)}`);
    }
  }
  for (const [table, tablePlan] of plan) {
    await connection.run(
      `create or replace view ${quoteIdent(viewCatalog)}.main.${quoteIdent(table)} as ${tablePlan.selectSql}`
    );
  }
}

/** True when this table's schema is unchanged, so a live tick can reuse the plan rather than re-scanning. */
export function planStillFits(plan: SqlitePlan, previous: SqlitePlan): boolean {
  if (plan.size !== previous.size) return false;
  for (const [table, tablePlan] of plan) {
    const before = previous.get(table);
    if (!before || before.selectSql !== tablePlan.selectSql) return false;
  }
  return true;
}
