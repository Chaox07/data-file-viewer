import { writeFile } from 'node:fs/promises';
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { zipSync, strToU8 } from 'fflate';

/**
 * File writers shared by every generator -- the analogue of
 * etl_stress/generators/_write.py.
 *
 * Two independent writers on purpose, because a corpus written by the same
 * library the reader uses proves nothing:
 *
 *   DuckDB       -> .duckdb, .parquet, .csv, .json, .sqlite
 *   apache-arrow -> .arrow / .arrows (stream) and .feather (file encoding)
 *   fflate + XML -> .xlsx, emitted by hand
 *
 * The workbook writer being hand-rolled is the point, not a shortcut. openpyxl
 * and friends produce tidy, uniform packages; the shapes that actually broke
 * `xlsxWrite.ts` are the ones a tidy writer never emits -- a sheet whose first
 * column is blank, notes sitting below the table, a row with no cell for a
 * column at all, a shared formula whose `t="shared"` can be mistaken for the
 * cell's own type. Those have to be constructed deliberately.
 *
 * Values are plain JS. `null` means a genuinely empty cell, and values keep
 * their type, because a large part of what is being tested is how the viewer
 * copes with a column that mixes them.
 */

export interface ColumnSpec {
  name: string;
  /** A DuckDB type name: 'INTEGER', 'VARCHAR', 'BIGINT', 'DOUBLE', 'DATE'... */
  type: string;
}

export interface TableSpec {
  name: string;
  columns: ColumnSpec[];
  rows: unknown[][];
}

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** A throwaway in-memory connection. Callers must close it. */
export async function scratchConnection(): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(':memory:');
  return instance.connect();
}

/**
 * Materialise a spec as a real table on `con`.
 *
 * Rows go in through a parameterised INSERT in chunks rather than one giant
 * literal, so a 40,000-row case does not build a megabyte of SQL. Chunked
 * because DuckDB's parameter list is not unbounded and a single-row INSERT per
 * row makes the big cases take minutes.
 */
export async function createTable(con: DuckDBConnection, spec: TableSpec): Promise<void> {
  const defs = spec.columns.map((c) => `${quote(c.name)} ${c.type}`).join(', ');
  await con.run(`create table ${quote(spec.name)} (${defs})`);
  if (spec.rows.length === 0) return;

  const width = spec.columns.length;
  const perChunk = Math.max(1, Math.floor(2000 / width));
  for (let start = 0; start < spec.rows.length; start += perChunk) {
    const chunk = spec.rows.slice(start, start + perChunk);
    const tuples: string[] = [];
    const params: unknown[] = [];
    for (const row of chunk) {
      const slots: string[] = [];
      for (let c = 0; c < width; c++) {
        params.push(row[c] ?? null);
        // Cast every parameter to the declared type. Without it DuckDB infers
        // from the JS value, and a column declared BIGINT would silently take
        // an INTEGER for a small value -- which is exactly the sort of quiet
        // type drift the corpus is supposed to rule out rather than contain.
        slots.push(`$${params.length}::${spec.columns[c].type}`);
      }
      tuples.push(`(${slots.join(', ')})`);
    }
    await con.run(`insert into ${quote(spec.name)} values ${tuples.join(', ')}`, params as never[]);
  }
}

/**
 * Build tables from raw SQL instead of from values.
 *
 * Needed for everything a JS value cannot express: NaN, ±Infinity, HUGEINT past
 * 2^64, a BLOB with a zero byte in it, nested LIST/STRUCT/MAP.
 */
export async function createTableFromSql(con: DuckDBConnection, name: string, selectSql: string): Promise<void> {
  await con.run(`create table ${quote(name)} as ${selectSql}`);
}

async function withScratch<T>(fn: (con: DuckDBConnection) => Promise<T>): Promise<T> {
  const con = await scratchConnection();
  try {
    return await fn(con);
  } finally {
    con.closeSync();
  }
}

/** A .duckdb database holding every table given. */
export async function duckdbFile(path: string, specs: TableSpec[]): Promise<string> {
  await withScratch(async (con) => {
    await con.run(`attach ${literal(path)} as out`);
    for (const spec of specs) {
      await createTable(con, spec);
      await con.run(`create table out.${quote(spec.name)} as select * from ${quote(spec.name)}`);
    }
    await con.run(`detach out`);
  });
  return path;
}

/** A .sqlite database. Needs DuckDB's sqlite extension, hence the load here. */
export async function sqliteFile(path: string, specs: TableSpec[]): Promise<string> {
  await withScratch(async (con) => {
    await con.run(`install sqlite`);
    await con.run(`load sqlite`);
    await con.run(`attach ${literal(path)} as out (type sqlite)`);
    for (const spec of specs) {
      await createTable(con, spec);
      await con.run(`create table out.${quote(spec.name)} as select * from ${quote(spec.name)}`);
    }
    await con.run(`detach out`);
  });
  return path;
}

export async function parquetFile(path: string, spec: TableSpec): Promise<string> {
  await withScratch(async (con) => {
    await createTable(con, spec);
    await con.run(`copy ${quote(spec.name)} to ${literal(path)} (format parquet)`);
  });
  return path;
}

export interface CsvOptions {
  delimiter?: string;
  header?: boolean;
  /** Prefix the file with a UTF-8 BOM, as Excel's exporter does. */
  bom?: boolean;
}

export async function csvFile(path: string, spec: TableSpec, options: CsvOptions = {}): Promise<string> {
  await withScratch(async (con) => {
    await createTable(con, spec);
    const opts = [
      `format csv`,
      `header ${options.header === false ? 'false' : 'true'}`,
      `delimiter ${literal(options.delimiter ?? ',')}`,
    ];
    await con.run(`copy ${quote(spec.name)} to ${literal(path)} (${opts.join(', ')})`);
  });
  if (options.bom) {
    const { readFile } = await import('node:fs/promises');
    const body = await readFile(path);
    await writeFile(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]));
  }
  return path;
}

export async function jsonFile(path: string, spec: TableSpec): Promise<string> {
  await withScratch(async (con) => {
    await createTable(con, spec);
    await con.run(`copy ${quote(spec.name)} to ${literal(path)} (format json, array true)`);
  });
  return path;
}

// ---------------------------------------------------------------------------
// Arrow
// ---------------------------------------------------------------------------

/**
 * How a column should be encoded in an Arrow file. Deliberately separate from
 * the DuckDB type name: the whole reason the Feather reader broke was that
 * polars writes `Utf8View` where DuckDB writes `Utf8`, and a corpus that cannot
 * say which one it means cannot express that difference.
 */
export type ArrowEncoding = 'int32' | 'int64' | 'float64' | 'utf8' | 'largeUtf8' | 'bool';

export interface ArrowColumn {
  name: string;
  encoding: ArrowEncoding;
  values: unknown[];
}

async function arrowTable(columns: ArrowColumn[], batchSize?: number) {
  const arrow = await import('apache-arrow');
  const { vectorFromArray, Int32, Int64, Float64, Utf8, LargeUtf8, Bool, Table } = arrow;

  const build = (col: ArrowColumn, values: unknown[]) => {
    switch (col.encoding) {
      case 'int32':
        return vectorFromArray(values as number[], new Int32());
      case 'int64':
        return vectorFromArray(values as bigint[], new Int64());
      case 'float64':
        return vectorFromArray(values as number[], new Float64());
      case 'largeUtf8':
        return vectorFromArray(values as string[], new LargeUtf8());
      case 'bool':
        return vectorFromArray(values as boolean[], new Bool());
      case 'utf8':
      default:
        // Explicitly Utf8, never inferred: tableFromArrays dictionary-encodes
        // strings, which is a different file and a different code path.
        return vectorFromArray(values as string[], new Utf8());
    }
  };

  const height = columns[0]?.values.length ?? 0;
  if (!batchSize || batchSize >= height) {
    const fields: Record<string, ReturnType<typeof build>> = {};
    for (const col of columns) fields[col.name] = build(col, col.values);
    return new Table(fields as never);
  }

  // Multi-batch. Each slice becomes its own Table and they are concatenated,
  // because `new Table(schema, batches)` compares schemas by IDENTITY and the
  // per-slice schema objects are distinct -- the concatenating constructor is
  // the only form that reconciles them. Getting this wrong produces
  // "Table and inner RecordBatch schemas must be equivalent".
  const parts = [];
  for (let start = 0; start < height; start += batchSize) {
    const fields: Record<string, ReturnType<typeof build>> = {};
    for (const col of columns) fields[col.name] = build(col, col.values.slice(start, start + batchSize));
    parts.push(new Table(fields as never));
  }
  const concat = Table as unknown as new (...tables: unknown[]) => InstanceType<typeof Table>;
  return new concat(...parts);
}

/** The Arrow IPC STREAM encoding — what `.arrows` normally holds and read_arrow reads. */
export async function arrowStreamFile(path: string, columns: ArrowColumn[], batchSize?: number): Promise<string> {
  const { RecordBatchStreamWriter } = await import('apache-arrow');
  const table = await arrowTable(columns, batchSize);
  await writeFile(path, Buffer.from(RecordBatchStreamWriter.writeAll(table).toUint8Array(true)));
  return path;
}

/**
 * The Arrow FILE encoding — Feather V2. `ARROW1` magic at both ends, a footer
 * for random access, and unreadable by DuckDB's arrow extension, which is the
 * entire reason the viewer converts it before reading.
 */
export async function featherFile(path: string, columns: ArrowColumn[], batchSize?: number): Promise<string> {
  const { RecordBatchFileWriter } = await import('apache-arrow');
  const table = await arrowTable(columns, batchSize);
  await writeFile(path, Buffer.from(RecordBatchFileWriter.writeAll(table).toUint8Array(true)));
  return path;
}

// ---------------------------------------------------------------------------
// xlsx
// ---------------------------------------------------------------------------

export interface SheetSpec {
  name: string;
  /**
   * Rows exactly as they should appear in the sheet, header included. `null`
   * writes no cell at all for that position -- not an empty cell, no `<c>`
   * element, which is what Excel does for a trailing gap and what broke the
   * first version of the patcher.
   */
  rows: (unknown[])[];
  /** 0-based count of blank leading columns, so the data does not start at A. */
  leadingBlankColumns?: number;
  /** `{ "A1:C1": true }` -- merged ranges. */
  merges?: string[];
  /** `{ "1-2": "=SUM(B2:B4)" }` keyed "row-col" (both 0-based, within rows). */
  formulas?: Record<string, string>;
  /** Style index applied to a cell, keyed "row-col" (0-based, within rows). */
  styles?: Record<string, number>;
}

export function columnLetters(index: number): string {
  let out = '';
  let n = index;
  for (;;) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    if (n < 26) return out;
    n = Math.floor(n / 26) - 1;
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sheetXml(spec: SheetSpec): string {
  const offset = spec.leadingBlankColumns ?? 0;
  const rows: string[] = [];
  spec.rows.forEach((row, r) => {
    const cells: string[] = [];
    row.forEach((value, c) => {
      if (value === null || value === undefined) return; // no <c> at all
      const ref = `${columnLetters(c + offset)}${r + 1}`;
      const style = spec.styles?.[`${r}-${c}`];
      const s = style === undefined ? '' : ` s="${style}"`;
      const formula = spec.formulas?.[`${r}-${c}`];
      const f = formula ? `<f>${escapeXml(formula.replace(/^=/, ''))}</f>` : '';
      if (typeof value === 'number') {
        cells.push(`<c r="${ref}"${s}>${f}<v>${value}</v></c>`);
      } else if (typeof value === 'boolean') {
        cells.push(`<c r="${ref}"${s} t="b">${f}<v>${value ? 1 : 0}</v></c>`);
      } else {
        // Inline strings rather than the shared table: it keeps each sheet
        // self-contained, and the patcher has to handle inlineStr anyway.
        cells.push(`<c r="${ref}"${s} t="inlineStr">${f}<is><t>${escapeXml(String(value))}</t></is></c>`);
      }
    });
    rows.push(`<row r="${r + 1}">${cells.join('')}</row>`);
  });
  const merges = (spec.merges ?? []).length
    ? `<mergeCells count="${spec.merges!.length}">${spec.merges!
        .map((ref) => `<mergeCell ref="${ref}"/>`)
        .join('')}</mergeCells>`
    : '';
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${rows.join('')}</sheetData>${merges}</worksheet>`
  );
}

/** A workbook package, assembled part by part. */
export async function xlsxFile(path: string, sheets: SheetSpec[]): Promise<string> {
  const parts: Record<string, Uint8Array> = {};

  parts['[Content_Types].xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      sheets
        .map(
          (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
        )
        .join('') +
      `</Types>`
  );

  parts['_rels/.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rIdW" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`
  );

  parts['xl/workbook.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
      sheets
        .map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('') +
      `</sheets></workbook>`
  );

  parts['xl/_rels/workbook.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
        )
        .join('') +
      `</Relationships>`
  );

  sheets.forEach((spec, i) => {
    parts[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(spec));
  });

  await writeFile(path, Buffer.from(zipSync(parts)));
  return path;
}

/**
 * A sheet's rows with optional notes above and below the real table.
 *
 * Kept here rather than in each generator so "the same table, wrapped in
 * different noise" stays a one-liner. Notes BELOW are the shape that broke
 * header detection on the real workbook: the sheet had 136 rows for 121 rows of
 * data, so counting backwards from the row count landed fourteen rows into the
 * data instead of on the header.
 */
export function withNotes(
  header: unknown[],
  rows: unknown[][],
  options: { above?: unknown[][]; below?: unknown[][]; blankBeforeBelow?: boolean } = {}
): unknown[][] {
  const out: unknown[][] = [...(options.above ?? []).map((r) => [...r])];
  out.push([...header]);
  out.push(...rows.map((r) => [...r]));
  if (options.below?.length) {
    if (options.blankBeforeBelow !== false) out.push([]);
    out.push(...options.below.map((r) => [...r]));
  }
  return out;
}
