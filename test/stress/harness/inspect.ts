import type { DuckDbFile } from '../../../src/duckdbConnection';
import type { CanonicalTable } from '../expect';

/**
 * Reading any kind back into one shape, and comparing it against what the
 * generator said it wrote. This is the suite's silent-misread detector, so it
 * has to compare in the space the USER actually sees -- not in DuckDB's types.
 *
 * `runQuery` returns `reader.getRowsJson()`, and that conversion is lossier and
 * stranger than it looks. Measured against DuckDB 1.5.5 rather than assumed:
 *
 *   BIGINT / HUGEINT   -> a decimal STRING ("9007199254740993")
 *   DECIMAL            -> a STRING, full precision preserved
 *   DOUBLE NaN / Inf   -> the strings "NaN" / "Infinity"
 *   -0.0               -> 0 (the sign is gone)
 *   DATE / TIME / TS   -> strings ("1666-09-02", "12:34:56.789")
 *   INTERVAL           -> { months, days, micros } with micros as a string
 *   BLOB               -> a "\x00\x01\xFF" escape string
 *   LIST / STRUCT      -> plain arrays / objects
 *   MAP                -> [{ key, value }, ...]
 *
 * The big integers becoming strings is the important one: it means a value past
 * 2^53 reaches the webview intact rather than being rounded by JSON, which is
 * the hazard the `shapes` family was written to look for. It also means an
 * expectation written as a JS number for such a column can never match, so
 * `normalizeValue` converts a declared bigint the same way DuckDB does and the
 * generators can stay readable.
 */

export function normalizeValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    // -0 compares equal to 0 with ===, but Object.is distinguishes them and
    // DuckDB does not preserve the sign, so collapse it here too.
    if (Object.is(value, -0)) return 0;
    return value;
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value;
}

export function normalizeTable(table: CanonicalTable): CanonicalTable {
  return {
    columns: [...table.columns],
    rows: table.rows.map((r) => r.map(normalizeValue)),
  };
}

/** The first table the file reports, or throws the way the UI would. */
export async function firstTable(file: DuckDbFile): Promise<string> {
  const tables = await file.listTables();
  if (tables.length === 0) throw new Error('the file reports no tables');
  return tables[0];
}

/**
 * Open, list, and actually READ.
 *
 * Never just open. For the flat kinds `open()` only runs `create view ... as
 * select * from read_x(...)`, and DuckDB does not touch the file to create a
 * view -- so a corrupt flat file routinely opens clean and fails on first
 * query. `malformedFiles.test.ts` learned this the hard way; asserting on
 * "did open() throw" passes for the wrong reason.
 */
export async function readTable(file: DuckDbFile, tableName?: string): Promise<CanonicalTable> {
  const name = tableName ?? (await firstTable(file));
  const result = await file.runQuery(`select * from ${quote(name)}`);
  return { columns: result.columns, rows: result.rows };
}

export function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Differences between what was written and what came back, as sentences.
 *
 * Returns every difference rather than the first, because a report saying
 * "row 3 column 2 differs" when 400 rows shifted by one is actively
 * misleading about what happened.
 */
export function compareTables(expected: CanonicalTable, actual: CanonicalTable): string[] {
  const out: string[] = [];
  const want = normalizeTable(expected);

  if (!sameArray(want.columns, actual.columns)) {
    out.push(`columns: wrote [${want.columns.join(', ')}], read back [${actual.columns.join(', ')}]`);
    // Column mismatch makes per-cell comparison meaningless noise.
    return out;
  }

  if (want.rows.length !== actual.rows.length) {
    out.push(`row count: wrote ${want.rows.length}, read back ${actual.rows.length}`);
  }

  const limit = Math.min(want.rows.length, actual.rows.length);
  let reported = 0;
  for (let r = 0; r < limit; r++) {
    for (let c = 0; c < want.columns.length; c++) {
      const w = want.rows[r][c];
      const a = normalizeValue(actual.rows[r][c]);
      if (!deepEqual(w, a)) {
        // A whole column of differences is one fact, not N facts. Cap the
        // enumeration so a systematic shift stays readable in the report.
        if (reported >= 8) {
          out.push('...and more differences beyond the first 8');
          return out;
        }
        out.push(`row ${r} "${want.columns[c]}": wrote ${show(w)}, read back ${show(a)}`);
        reported++;
      }
    }
  }
  return out;
}

function sameArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Numbers that a user would read as the same number.
 *
 * Measured, not assumed: writing one logical table through every writer and
 * reading it back shows the SAME integer arriving as `1` from Parquet and as
 * the string `"1"` from CSV and SQLite, because both of those type an integer
 * column as BIGINT and getRowsJson renders BIGINT as a decimal string. Neither
 * is wrong and both render identically in the grid, so a comparator that
 * insists on the JS type would report every CSV case as a misread and drown the
 * real findings.
 *
 * Compared as canonical DECIMAL STRINGS rather than by casting to Number, so
 * the tolerance does not quietly reintroduce the 2^53 problem: 9007199254740993
 * and 9007199254740992 stay distinguishable here, which is the whole reason the
 * BIGINT-as-string behaviour is worth having.
 */
function numericText(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return canonicalDecimal(String(value));
  }
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) {
    return canonicalDecimal(value);
  }
  return null;
}

function canonicalDecimal(text: string): string {
  if (!text.includes('.')) return text;
  const trimmed = text.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '-0' ? '0' : trimmed;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const na = numericText(a);
  if (na !== null && na === numericText(b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function show(value: unknown): string {
  const s = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}
