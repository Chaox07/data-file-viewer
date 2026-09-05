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
import { chmod, copyFile, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseKdbFile, type KdbColumn, type KdbTable } from './kdbParser';
import { KNOWN_FREQUENCIES, type SeriesFrequency } from './chartSpec';
import { listSheets, readSheetExtents, scanSheetExtent, type SheetExtent, type XlsxSheet } from './xlsxSheets';
import { patchCell as patchXlsxCell } from './xlsxWrite';

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

export type FileKind = 'duckdb' | 'parquet' | 'sqlite' | 'csv' | 'dta' | 'arrow' | 'feather' | 'xlsx' | 'kdb';

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
 * `""` in a CSV is an empty string, not a missing value.
 *
 * `read_csv` defaults `allow_quoted_nulls` to true, which reads a QUOTED empty
 * field as NULL -- so an empty string cannot survive a round trip through this
 * viewer, and "" and "no value here" become indistinguishable. Turning it off
 * only affects quoted fields: an unquoted empty field between two commas still
 * reads as NULL, which is what everyone means by it. So this does not change
 * how genuinely-missing values are read, which was the objection that kept it
 * unfixed.
 */
const CSV_READ_OPTIONS = ', allow_quoted_nulls = false';

/** Largest file worth reading in full to find out whether it is all whitespace. */
const BLANK_CSV_SCAN_LIMIT = 1024 * 1024;

/**
 * Refuse a CSV with nothing in it, rather than showing the rows it invents.
 *
 * Measured: `read_csv_auto` on `"   \n\n\t  \n"` returns two invented columns
 * and a row containing `"  "`; on `"\n\n\n"`, one column and two rows of null.
 * A file with no data in it draws a grid with data in it, and nothing says the
 * file was blank -- which is the silent-misread category, the worst outcome
 * here. A CSV that is entirely whitespace is far more often a write that failed
 * than a deliberate empty file.
 *
 * Same shape and same reasoning as assertArrowStreamComplete above, which
 * already refuses a truncated Arrow stream rather than drawing an empty grid.
 *
 * Only files small enough to read are checked. A large file cannot be all
 * whitespace in any realistic sense, and reading it to prove otherwise would
 * cost every CSV open.
 */
async function assertCsvHasContent(path: string): Promise<void> {
  const { size } = await stat(path);
  if (size > BLANK_CSV_SCAN_LIMIT) return;
  const text = await readFile(path, 'utf8');
  if (!/^\s*$/.test(text)) return;
  throw new Error(
    size === 0
      ? `"${basename(path)}" is empty (0 bytes), so there is nothing to show.`
      : `"${basename(path)}" holds no data — all ${size} bytes of it are blank lines and ` +
          `spaces. Read as a CSV it would produce invented columns and rows that are not in ` +
          `the file, so it is refused instead. This usually means a write that did not finish.`
  );
}

/**
 * Tell the two Arrow encodings apart by their leading magic bytes.
 *
 * Arrow has two byte layouts that share a name, and which one a file is
 * decides how it has to be opened:
 *
 *   - the *stream* encoding, which read_arrow() reads directly: polars'
 *     write_ipc_stream(), pyarrow's RecordBatchStreamWriter, DuckDB's
 *     COPY ... TO ... (FORMAT arrow). Conventionally .arrows/.arrow.
 *   - the *file* encoding, a.k.a. Feather V2, which read_arrow() cannot read
 *     at any version: polars' write_ipc(), pyarrow.feather.write_feather(),
 *     pandas' DataFrame.to_feather(). Begins with the ASCII magic `ARROW1`.
 *     Feather V1, which pandas wrote for years, begins with `FEA1`.
 *
 * Sniffed rather than taken from the extension, because both encodings turn up
 * under both names in the wild -- and getting it wrong is not a clean failure:
 * a Feather file ends with its own `ARROW1` footer rather than the stream's
 * 8-byte end-of-stream marker, so the truncation check would call it damaged.
 */
const ARROW_FILE_MAGIC = Buffer.from('ARROW1', 'ascii');
const FEATHER_V1_MAGIC = Buffer.from('FEA1', 'ascii');

/**
 * Whether an error is read_xlsx refusing a single cell's value, not the file.
 *
 * Matched on the message because that is all the extension gives: there is no
 * error code, and the two failures have to be told apart -- a cell that will
 * not parse is recoverable by reading it as NULL, while a sheet that is not a
 * worksheet at all is not.
 */
function isCellParseError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Failed to parse cell|Could not convert string/i.test(message);
}

/**
 * Every value Excel puts in a cell it could not compute.
 *
 * A closed set, and the only reliable way to tell one from a word somebody
 * typed: DuckDB reports both through the same message ("Could not convert
 * string '#REF!' to DOUBLE" and "Could not convert string 'n/a' to DOUBLE"), so
 * the message shape says nothing about which happened. Confirmed by the stress
 * suite, which failed the first attempt at this for exactly that reason.
 */
const EXCEL_ERROR_VALUE_RE = /^#(DIV\/0!|N\/A|REF!|VALUE!|NAME\?|NUM!|NULL!|SPILL!|CALC!|FIELD!|BLOCKED!|CONNECT!|UNKNOWN!|GETTING_DATA)$/i;

/**
 * Say what the `ignore_errors` repair actually rescued, from the error itself.
 *
 * The single sentence this replaces blamed "#DIV/0!, #N/A, #REF! and the like"
 * for EVERY repair, and at least three things that are not Excel errors trigger
 * one: a footnote written directly under a table, a stray unit label, and a word
 * the user typed into a numeric column themselves -- the last being the worst,
 * because the file is right and the message accuses Excel of a value the reader
 * put there thirty seconds earlier.
 *
 * So the value is what decides, not the message: when it is one of Excel's own
 * error values the original wording holds and now names the one it found;
 * anything else is described as what it is.
 */
function describeCellRepair(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const conversion = /Could not convert string '([\s\S]*?)' to (\w+)/i.exec(message);
  const value = conversion?.[1];
  if (value !== undefined && !EXCEL_ERROR_VALUE_RE.test(value.trim())) {
    const shown = value.length > 60 ? `${value.slice(0, 60)}…` : value;
    return (
      `A value in this workbook ("${shown}") is not a ${conversion![2].toLowerCase()}, but the ` +
        `column holding it reads as one — so that cell is shown empty. This is not an Excel ` +
        `error value; the workbook itself is unchanged, and every other value is as it was.`
    );
  }
  const named = value ? ` (${value.trim()})` : '';
  return (
    `This workbook holds cell values Excel could not compute${named} — #DIV/0!, #N/A, #REF! ` +
      `and the like. They are shown as empty cells; every other value is unchanged.`
  );
}

/**
 * The one place a `read_xlsx(...)` call is composed.
 *
 * Three separate places build sheet views -- open(), the ignore_errors repair,
 * and Safe Mode's backup catalog -- and they have to agree, because the diff
 * pairs the live and backup catalogs up by table name and compares them column
 * by column. A sheet read one way on one side and another way on the other does
 * not report "these differ"; it reports whichever nonsense the column
 * alignment produces. They were three hand-built strings that had already
 * drifted once (the backup path had no branch for a workbook at all, which is
 * what took Safe Mode down in the field).
 */
function xlsxReadSql(
  filePath: string,
  sheetName: string,
  options: XlsxSheetOptions | undefined,
  tolerateErrors: boolean
): string {
  const args = [quoteLiteral(filePath), `sheet = ${quoteLiteral(sheetName)}`];
  if (options?.rawRectangle) {
    // header = false is what makes the banner row visible as data instead of
    // becoming the column names; the range is what makes the other 99 columns
    // exist at all. Neither works without the other.
    args.push(`range = ${quoteLiteral(options.rawRectangle)}`, 'header = false');
  }
  if (options?.allVarchar) args.push('all_varchar = true');
  // Redundant under all_varchar (nothing can fail to convert to VARCHAR), and
  // harmful with it: it would silence a genuine read failure for no gain.
  if (tolerateErrors && !options?.allVarchar) args.push('ignore_errors = true');
  return `read_xlsx(${args.join(', ')})`;
}

async function isFeatherEncoding(path: string): Promise<boolean> {
  const head = Buffer.alloc(ARROW_FILE_MAGIC.length);
  let bytesRead = 0;
  try {
    const handle = await open(path, 'r');
    try {
      ({ bytesRead } = await handle.read(head, 0, head.length, 0));
    } finally {
      await handle.close();
    }
  } catch {
    return false; // unreadable — let the normal open path report it
  }
  if (bytesRead >= ARROW_FILE_MAGIC.length && head.equals(ARROW_FILE_MAGIC)) return true;
  return bytesRead >= FEATHER_V1_MAGIC.length && head.subarray(0, FEATHER_V1_MAGIC.length).equals(FEATHER_V1_MAGIC);
}

/**
 * Convert a Feather file to an Arrow IPC stream in a temp file, and return it.
 *
 * DuckDB has no Feather reader — verified against duckdb 1.5.5 with the arrow
 * community extension loaded: read_arrow() fails on the file encoding whether
 * or not it is compressed, and no other function in that extension takes one.
 * So the only way to show a Feather file is to re-encode it, which is what the
 * apache-arrow JS library is here for: tableFromIPC() reads BOTH encodings,
 * tableToIPC(t, 'stream') writes the one read_arrow wants.
 *
 * Converted a RECORD BATCH AT A TIME, not as a whole table. The Feather file
 * encoding puts its footer at the end and is therefore random-access, which is
 * exactly what apache-arrow's AsyncRecordBatchFileReader wants: handed a
 * FileHandle it seeks to the footer, reads the batch index, and yields batches
 * on demand. Each one is re-encoded and written straight out to the stream, so
 * peak memory is one batch rather than the entire dataset — measured at 59 MB
 * on a 12 MB / 400,000-row polars file that previously had to hold the whole
 * decoded table, its re-encoded copy, and the file's own Buffer at once.
 *
 * A conversion still happens; that part is not avoidable while DuckDB has no
 * Feather reader (re-verified against duckdb 1.5.5 + the arrow community
 * extension: read_arrow fails on the file encoding, compressed or not, and
 * nothing else in that extension takes one). What is avoidable is doing it in
 * one bite, and that is what this does.
 *
 * COMPRESSED Feather cannot be handled and is refused with a message saying
 * so. apache-arrow JS has no IPC codecs at all — it throws "Record batch is
 * compressed but codec not found" for lz4 and zstd alike (measured 2026-08-28
 * against apache-arrow 21.2). Worth knowing: read_arrow() itself DOES read
 * zstd-compressed *streams*, so this limitation is the converter's, not
 * DuckDB's.
 */
async function convertFeatherToStream(path: string): Promise<{ streamPath: string; tempDir: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), 'dfv-feather-'));
  const streamPath = join(tempDir, `${basename(path, extname(path))}.arrows`);
  try {
    await streamFeatherToArrowStream(path, streamPath);
  } catch (err) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    if (/compress/i.test(message)) {
      throw new Error(
        `"${basename(path)}" is a COMPRESSED Feather file, which cannot be opened. The converter ` +
          `this viewer uses to read Feather has no decompression codecs. Re-write it uncompressed ` +
          `(polars write_ipc(path, compression=None), pyarrow write_feather(df, path, ` +
          `compression="uncompressed")), or write an Arrow IPC stream instead — a zstd-compressed ` +
          `.arrows stream opens here without any conversion.`
      );
    }
    throw new Error(`"${basename(path)}" could not be read as a Feather / Arrow IPC file: ${message}`);
  }
  return { streamPath, tempDir };
}

/**
 * Re-encode a batch's Utf8View columns as plain Utf8, leaving the rest alone.
 *
 * polars writes strings as Arrow Utf8View by DEFAULT, and read_arrow rejects
 * that type outright: "Unrecognized Field type with value 24" -- 24 being
 * Type.Utf8View exactly. Converting the container is therefore not enough on
 * its own; the string columns have to be brought down to a type DuckDB knows,
 * or every file polars wrote fails after a successful conversion.
 *
 * This is the same hazard `compat_level=oldest` exists for on the write side,
 * arriving from the other direction. It is worth knowing that this was missed
 * by a green test suite: the fixtures were built from DuckDB's own output,
 * which is plain Utf8, so the corpus agreed with the code and both were wrong
 * about real polars files.
 */
async function downcastViewsInBatch(batch: unknown): Promise<unknown> {
  const { Table, Type, Utf8, vectorFromArray } = await import('apache-arrow');
  const source = batch as {
    schema: { fields: { name: string; type: { typeId: number; dictionary?: { typeId: number } } }[] };
    getChild(name: string): unknown;
  };

  // Dictionary-encoded strings are the same hazard as Utf8View, from a
  // different writer. read_arrow refuses them at the schema -- "Schema message
  // field with DictionaryEncoding not supported" -- and they are not exotic:
  // a pandas categorical, an R factor and a polars Categorical all become one.
  // Found by the Tier B corpus, which is the only part of the suite that can
  // produce a file this repo's own writers never emit.
  //
  // Only STRING dictionaries are decoded. A dictionary over some other value
  // type is left as it was, so this widens what opens without quietly changing
  // what a numeric column means.
  const STRING_TYPES = new Set<number>([Type.Utf8, Type.LargeUtf8, Type.Utf8View]);
  const isStringDictionary = (type: { typeId: number; dictionary?: { typeId: number } }): boolean =>
    type.typeId === Type.Dictionary && type.dictionary !== undefined && STRING_TYPES.has(type.dictionary.typeId);

  const columns: Record<string, unknown> = {};
  let changed = false;
  for (const field of source.schema.fields) {
    const vector = source.getChild(field.name);
    if (!vector) continue;
    if (field.type.typeId === Type.Utf8View || isStringDictionary(field.type)) {
      // toJSON() reads through the encoding in both cases: a dictionary
      // vector's get() resolves the index against its dictionary, so this is
      // the decoded value either way.
      columns[field.name] = vectorFromArray(
        (vector as { toJSON(): (string | null)[] }).toJSON(),
        new Utf8()
      );
      changed = true;
    } else {
      columns[field.name] = vector;
    }
  }
  // A Table built from one batch's vectors has exactly one batch back out.
  return changed ? new Table(columns as never).batches[0] : batch;
}

/**
 * Arrow IPC stream at `from` -> Feather file at `to`, one record batch at a time.
 *
 * The save-side mirror of streamFeatherToArrowStream, and the reason .feather
 * can be edited at all: DuckDB's `COPY ... (FORMAT arrow)` writes the stream
 * encoding, and this turns that into the file encoding the original had, with
 * the same one-batch memory ceiling as the read side.
 *
 * No Utf8View downcast on this side. These batches came out of DuckDB, which
 * writes plain Utf8 -- the downcast exists for what polars WROTE, not for what
 * this viewer writes.
 */
async function streamArrowStreamToFeather(from: string, to: string): Promise<void> {
  const { RecordBatchReader, RecordBatchFileWriter } = await import('apache-arrow');
  const handle = await open(from, 'r');
  try {
    // apache-arrow's typings do not list FileHandle among RecordBatchReader.from's
    // overloads, though it accepts one at runtime and returns the async
    // random-access reader the file encoding needs -- which is the whole point
    // here. Typed at the call rather than cast at the argument: `handle as never`
    // collapses the return type to `never` and takes `open()` with it.
    const openReader = RecordBatchReader.from as unknown as (
      source: unknown
    ) => Promise<{ open(): Promise<void> } & AsyncIterable<unknown>>;
    const reader = await openReader(handle);
    await reader.open();

    const out = createWriteStream(to);
    const writer = new RecordBatchFileWriter();
    const done = new Promise<void>((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
    });
    writer.toNodeStream().pipe(out);
    try {
      for await (const batch of reader) writer.write(batch as never);
      writer.finish();
    } catch (err) {
      writer.close();
      out.destroy();
      throw err;
    }
    await done;
  } finally {
    await handle.close();
  }
}

/** Feather file at `from` -> Arrow IPC stream at `to`, one record batch at a time. */
async function streamFeatherToArrowStream(from: string, to: string): Promise<void> {
  const { RecordBatchReader, RecordBatchStreamWriter } = await import('apache-arrow');
  const handle = await open(from, 'r');
  try {
    // apache-arrow's typings do not list FileHandle among RecordBatchReader.from's
    // overloads, though it accepts one at runtime and returns the async
    // random-access reader the file encoding needs -- which is the whole point
    // here. Typed at the call rather than cast at the argument: `handle as never`
    // collapses the return type to `never` and takes `open()` with it.
    const openReader = RecordBatchReader.from as unknown as (
      source: unknown
    ) => Promise<{ open(): Promise<void> } & AsyncIterable<unknown>>;
    const reader = await openReader(handle);
    await reader.open();

    const out = createWriteStream(to);
    const writer = new RecordBatchStreamWriter();
    const done = new Promise<void>((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
    });
    writer.toNodeStream().pipe(out);
    try {
      for await (const batch of reader) {
        writer.write((await downcastViewsInBatch(batch)) as never);
      }
      writer.finish();
    } catch (err) {
      // Close the sink before rethrowing, or a failed conversion leaves the
      // write stream open and the temp file undeleteable on Windows.
      writer.close();
      out.destroy();
      throw err;
    }
    await done;
  } finally {
    await handle.close();
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

// How many non-null values runChartQuery samples before deciding whether a
// text column can be a time axis, and how many of them have to parse.
const TEXT_AXIS_PROBE_ROWS = 5000;
const TEXT_AXIS_MIN_PARSE_RATE = 0.95;

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

/**
 * What a single sheet needs beyond `read_xlsx(file, sheet => name)`.
 *
 * Both flags describe a sheet the defaults get WRONG, and both are set after
 * the fact -- one at open, one on the user's say-so -- which is why they live
 * in a map rather than being decided once for the workbook.
 */
interface XlsxSheetOptions {
  /**
   * The sheet's full rectangle, from its own `<dimension>`, read with no header
   * at all. Set when read_xlsx's region detection missed most of the sheet.
   */
  rawRectangle?: string;
  /** Read every column as text, so a value that is not a number still shows. */
  allVarchar?: boolean;
}

export class DuckDbFile {
  private lastBackupPath: string | undefined;
  private backupAttached = false;
  /** Temp dir holding a Feather backup's stream conversion, if any. */
  private backupTempDir: string | undefined;
  private materialized = false;
  /** Set once this workbook's views have been re-created with ignore_errors. */
  private xlsxErrorsTolerated = false;
  /**
   * Notices raised after open, by a query rather than by opening the file.
   * Drained by the caller -- see takeLateWarnings.
   */
  private readonly lateWarnings: string[] = [];

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
    private readonly siblingPath: string | undefined = undefined,
    /** Temp dir holding the stream a .feather file was converted into, if any. */
    private readonly featherTempDir: string | undefined = undefined,
    /** Notices about a file that opened successfully; see openWarnings in open(). */
    readonly openWarnings: readonly string[] = [],
    /**
     * Sheet name -> its worksheet part inside the package, for .xlsx only.
     * Carried from open() because listSheets had already read it, and because
     * an edit has to reach the right part of the zip knowing only the view name.
     */
    private readonly xlsxSheetPaths: Map<string, string> = new Map(),
    /**
     * Sheet name -> the read_xlsx options that sheet needs beyond the defaults.
     * See xlsxReadSql: this map is the only thing that varies between the three
     * places a sheet view is built, which is what keeps them agreeing.
     */
    private readonly xlsxSheetOptions: Map<string, XlsxSheetOptions> = new Map()
  ) {}

  /**
   * Re-read any sheet whose view covers less of it than the sheet claims.
   *
   * `read_xlsx` picks its region by scanning down for the first row of
   * consecutive non-empty cells and taking that row as the header. A workbook a
   * human made -- a title, a disclaimer paragraph, a blank spacer row -- breaks
   * that assumption in the worst possible way: the banner is ONE cell, so the
   * region becomes one column wide, and reading stops at the first empty row.
   * The file opens, the grid draws, and it shows an empty table. Measured on
   * ~/Desktop/scatter/YieldCurve_Data.xlsx: `Raw_Data` is 16,814 x 100 and read
   * as 0 x 1, its single column named after a Federal Reserve disclaimer;
   * `used-YieldCurve` is 16,809 x 33 and read as 1 x 3. Neither said anything.
   *
   * The sheet's own `<dimension>` is the second opinion. When it says there are
   * more columns than the view has, the view is rebuilt over the whole
   * rectangle with no header at all -- every row and column, columns named for
   * their spreadsheet letters. Not a guess at where the header is: this file is
   * exactly why guessing is a bad idea, since `Raw_Data`'s row 4 reads like a
   * header (`Series | Compounding Convention | Mnemonic(s)`) and is a legend.
   *
   * `all_varchar` comes along necessarily rather than by choice. Once the
   * banner row is data, its column holds a paragraph of prose above a column of
   * numbers, and type inference refuses the sheet outright ("Could not convert
   * string 'Note: This is not an official...' to DOUBLE"). The alternative,
   * `ignore_errors`, would read the banner as NULL -- blanking the very row
   * that explains why the sheet looks like this.
   *
   * Comparing COLUMNS only, because a view's column count is free (the schema
   * is already bound) while its row count is a full scan of the sheet. The
   * narrower case where a banner happens to span every column is caught later,
   * on a query that comes back empty -- see runQuery.
   */
  private static async showFullSheetWhereRegionWasMissed(
    connection: DuckDBConnection,
    path: string,
    sheets: readonly XlsxSheet[],
    options: Map<string, XlsxSheetOptions>
  ): Promise<string[]> {
    let extents: Map<string, SheetExtent>;
    try {
      extents = await readSheetExtents(path, sheets.map((s) => s.path));
    } catch {
      return []; // No second opinion available -- believe DuckDB, as before.
    }

    const warnings: string[] = [];
    for (const sheet of sheets) {
      let extent = extents.get(sheet.path);
      if (!extent) continue;
      const asIdent = sheet.name.replace(/"/g, '""');
      let viewColumns: number;
      try {
        // Binds the schema; does not scan the sheet.
        const probe = await connection.runAndReadAll(`select * from "${asIdent}" limit 0`);
        viewColumns = probe.columnNames().length;
      } catch {
        continue;
      }
      // Against the widest row that actually holds values, NOT against the
      // declared rectangle -- see SheetExtent.contentColumns. Comparing with
      // the rectangle rewrote five good sheets of a workbook in daily use,
      // every one of them because `<dimension>` claimed a trailing column that
      // holds nothing.
      if (!extent.contentColumns || viewColumns >= extent.contentColumns) continue;

      if (!extent.exact) {
        // Column count wrong, last row unknown -- and a range must have one, so
        // this is where the whole sheet gets read. Only for a sheet already
        // known to be mis-read, and only when it declared no dimension.
        const scanned = await scanSheetExtent(path, sheet.path).catch(() => undefined);
        if (!scanned) continue;
        extent = scanned;
      }

      const opts: XlsxSheetOptions = { rawRectangle: extent.ref, allVarchar: true };
      try {
        await connection.run(
          `create or replace view "${asIdent}" as select * from ${xlsxReadSql(path, sheet.name, opts, false)}`
        );
      } catch {
        // Better the partial view than none: leave what opened in place.
        continue;
      }
      options.set(sheet.name, opts);
      warnings.push(
        `Sheet "${sheet.name}" does not begin with a header row: read the usual way it showed ` +
          `${viewColumns} of its ${extent.contentColumns} columns. It is now shown exactly as ` +
          `the sheet is laid out — all ${extent.rows} rows and ${extent.columns} columns, named ` +
          `by their spreadsheet letters, starting at row ${extent.firstRow}. Read as text, and ` +
          `view-only, because without a header there is no way to know what an edit would change.`
      );
    }
    return warnings;
  }

  /** Whether this sheet is shown as its raw rectangle — see showFullSheetWhereRegionWasMissed. */
  private isRawRectangleSheet(name: string): boolean {
    return this.xlsxSheetOptions.get(name)?.rawRectangle !== undefined;
  }

  isReadOnly(): boolean {
    return this.readOnly;
  }

  hasSibling(): boolean {
    return this.siblingCatalogName !== undefined;
  }

  private isFlatFileKind(): boolean {
    return (
      this.kind === 'parquet' ||
      this.kind === 'csv' ||
      this.kind === 'dta' ||
      this.kind === 'arrow' ||
      // Feather earns its place here now that writeBackFlatFile can produce the
      // FILE encoding. It was excluded for one reason only -- `COPY ... (FORMAT
      // arrow)` writes a STREAM, so saving through DuckDB alone would have put
      // stream bytes inside a .feather file and quietly changed its format out
      // from under whatever reads it next.
      this.kind === 'feather'
    );
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
    // Either Arrow encoding may arrive under either name, so which one this
    // actually is comes from the magic bytes, not the extension. A Feather
    // file becomes its own kind: it has to be converted before DuckDB can see
    // it, and converting makes it view-only (an edit written back through
    // `COPY ... (FORMAT arrow)` would put a STREAM inside a .feather file).
    // Set when a Feather file is converted; the instance owns it and removes
    // it on dispose(), so a session leaves nothing behind in the temp dir.
    let featherTempDir: string | undefined;
    // Things the user should be told about a file that DID open. Not errors --
    // an error stops the open -- but facts about what they are now looking at
    // that are not visible in the grid, such as a cell shown as empty because
    // the workbook holds #DIV/0! there.
    const openWarnings: string[] = [];
    // Populated for .xlsx only; see the constructor parameters of the same names.
    const xlsxSheetPaths = new Map<string, string>();
    const xlsxSheetOptions = new Map<string, XlsxSheetOptions>();
    const looksArrow = /\.(arrows?|feather)$/i.test(path);
    const isFeather = looksArrow && (await isFeatherEncoding(path));
    const isArrow = looksArrow && !isFeather;
    const isXlsx = path.toLowerCase().endsWith('.xlsx');
    const isSqlite = path.toLowerCase().endsWith('.db') || path.toLowerCase().endsWith('.sqlite');
    const useMemory = isParquet || isCsv || isDta || isArrow || isFeather || isXlsx || isSqlite;
    const kind: FileKind = isParquet
      ? 'parquet'
      : isCsv
        ? 'csv'
        : isDta
          ? 'dta'
          : isArrow
            ? 'arrow'
            : isFeather
              ? 'feather'
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
      await assertCsvHasContent(path);
      const filePath = path.replace(/'/g, "''");
      await connection.run(
        `create view "${mainObjectName}" as select * from read_csv_auto('${filePath}'${CSV_READ_OPTIONS})`
      );
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

    if (isArrow || isFeather) {
      // Same single-view treatment as Parquet/CSV/dta, through DuckDB's
      // community `arrow` extension. read_arrow() reads the Arrow IPC *stream*
      // encoding only, so a Feather file is converted to one first and the
      // view is built over the conversion instead of the original.
      try {
        await connection.run(`install arrow from community`);
        await connection.run(`load arrow`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Could not load DuckDB's arrow extension — this requires an internet connection the first time it's used on this machine. (${message})`
        );
      }

      let readPath = path;
      if (isFeather) {
        const converted = await convertFeatherToStream(path);
        readPath = converted.streamPath;
        featherTempDir = converted.tempDir;
      } else {
        // Only a real stream can be checked this way: a Feather file ends with
        // its own ARROW1 footer rather than the end-of-stream marker, and the
        // conversion above always produces a complete stream anyway.
        await assertArrowStreamComplete(path);
      }
      const filePath = readPath.replace(/'/g, "''");
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
      const failures: string[] = [];
      for (const sheet of sheets) {
        // read_xlsx addresses a sheet by NAME, so the sheet name is a SQL
        // string literal here and a quoted identifier for the view -- two
        // different escapes, and mixing them up is how a sheet called
        // O'Brien's Data breaks the whole workbook.
        const asIdent = sheet.name.replace(/"/g, '""');
        try {
          await connection.run(
            `create view "${asIdent}" as select * from ${xlsxReadSql(path, sheet.name, undefined, false)}`
          );
          xlsxSheetPaths.set(sheet.name, sheet.path);
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
      for (const warning of await DuckDbFile.showFullSheetWhereRegionWasMissed(
        connection,
        path,
        sheets.filter((s) => xlsxSheetPaths.has(s.name)),
        xlsxSheetOptions
      )) {
        openWarnings.push(warning);
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
      options?.siblingPath,
      featherTempDir,
      openWarnings,
      xlsxSheetPaths,
      xlsxSheetOptions
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
    for (const catalog of this.metadataCatalogs()) {
      const value = await this.readPollCadenceFromCatalog(table, catalog);
      if (value !== null) return value;
    }
    return null;
  }

  /** Catalogs to look for a sheet_metadata row in, hot side first. */
  private metadataCatalogs(): string[] {
    const candidates: string[] = [];
    // Hot side first.
    if (this.isMainHot()) candidates.push(this.catalogName);
    if (this.siblingCatalogName && this.siblingIsSqlite) candidates.push(this.siblingCatalogName);
    // Then whatever's left, in case the "hot" convention doesn't hold for a
    // future writer this wasn't designed against.
    if (!this.isMainHot()) candidates.push(this.catalogName);
    if (this.siblingCatalogName && !this.siblingIsSqlite) candidates.push(this.siblingCatalogName);
    return candidates;
  }

  /**
   * Best-effort read of a table's declared frequency, used only to word a
   * chart's tick and tooltip labels ("2020 Q1" instead of "1 Jan 2020").
   *
   * Entirely optional, by design: a file with no `sheet_metadata`, no row for
   * this table, or a frequency nobody recognises charts exactly as it did
   * before — this returns null and the chart falls back to plain dates. It is
   * a label improvement, never a requirement for plotting.
   *
   * The value is matched against a fixed vocabulary rather than passed
   * through. It comes out of a file, the chart view puts the label into
   * tooltip HTML, and a recognised word cannot carry markup with it.
   */
  async getSeriesFrequency(table: string): Promise<SeriesFrequency | null> {
    for (const catalog of this.metadataCatalogs()) {
      try {
        const reader = await this.connection.runAndReadAll(
          `select frequency from ${quoteIdent(catalog)}.main.sheet_metadata where table_name = ${quoteLiteral(table)}`
        );
        const rows = reader.getRows();
        if (rows.length === 0) continue;
        const raw = rows[0][0];
        if (typeof raw !== 'string') continue;
        const word = raw.trim().toLowerCase();
        const match = KNOWN_FREQUENCIES.find((f) => f === word);
        if (match) return match;
      } catch {
        // No sheet_metadata here, or no frequency column on it. Try the other
        // side, then give up quietly.
      }
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
        case 'feather':
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
    try {
      const result = await this.runQueryOnce(sql, maxRows);
      if (result.rows.length === 0 && (await this.showFullSheetThatReadAsEmpty(sql))) {
        return await this.runQueryOnce(sql, maxRows);
      }
      return result;
    } catch (err) {
      // A workbook cell Excel could not compute -- #DIV/0!, #N/A, #REF! -- in
      // an otherwise numeric column. read_xlsx types the column from its
      // values and then refuses the whole sheet over one of them.
      //
      // Repaired HERE rather than at open, because `create view ... from
      // read_xlsx(...)` does not read the sheet: it binds a schema and returns,
      // so the failure only ever surfaces on the first real query. Repairing at
      // open would have meant scanning every sheet of every workbook up front
      // to find out whether it was needed.
      if (!(await this.repairXlsxViewsForCellErrors(err))) throw err;
      return await this.runQueryOnce(sql, maxRows);
    }
  }

  /**
   * The other half of showFullSheetWhereRegionWasMissed, for the case its
   * column test cannot see.
   *
   * A title banner that happens to span every column leaves the view with the
   * right column COUNT and the wrong contents -- the banner became the header,
   * and reading stopped at the blank row under it. The column comparison at
   * open passes; what gives it away is the sheet coming back empty while its
   * `<dimension>` claims thousands of rows.
   *
   * Lazy, and only on an empty result, because the alternative is a full scan
   * of every sheet of every workbook at open to find out whether it was needed.
   * A genuinely empty sheet costs one dimension read, once.
   */
  private async showFullSheetThatReadAsEmpty(sql: string): Promise<boolean> {
    if (this.kind !== 'xlsx') return false;
    const match = EDITABLE_SELECT_RE.exec(sql.trim());
    if (!match) return false; // Not a plain read of one sheet; nothing to name.
    const raw = match[1];
    const name = raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw;
    const sheetPath = this.xlsxSheetPaths.get(name);
    if (!sheetPath || this.xlsxSheetOptions.has(name)) return false;

    let extent: SheetExtent | undefined;
    try {
      extent = (await readSheetExtents(this.path, [sheetPath])).get(sheetPath);
      if (extent && !extent.exact) extent = await scanSheetExtent(this.path, sheetPath);
    } catch {
      return false;
    }
    if (!extent || extent.rows <= 1) return false;

    const asIdent = name.replace(/"/g, '""');
    const opts: XlsxSheetOptions = { rawRectangle: extent.ref, allVarchar: true };
    try {
      await this.connection.run(
        `create or replace view "${asIdent}" as select * from ${xlsxReadSql(this.path, name, opts, false)}`
      );
    } catch {
      return false;
    }
    this.xlsxSheetOptions.set(name, opts);
    this.lateWarnings.push(
      `Sheet "${name}" read as empty, but the sheet itself declares ${extent.rows} rows. It is ` +
        `now shown exactly as it is laid out — every row and column, named by their ` +
        `spreadsheet letters, read as text and view-only.`
    );
    return true;
  }

  /**
   * Re-create this workbook's sheet views with `ignore_errors`, once.
   *
   * Returns whether anything was repaired, so the caller knows whether
   * retrying the query is worth it.
   *
   * `ignore_errors` reads an uncomputable cell as NULL and keeps every column's
   * real type, which is what the value MEANS: Excel saying it has no number
   * there. Measured on the workbook this was reported from, it changes exactly
   * the one offending cell and nothing else.
   *
   * `all_varchar` would also open the sheet and is the wrong trade -- it turns
   * every column in the sheet into text to rescue one cell, costing sorting,
   * stats and charting on all of them.
   *
   * Every sheet is repaired rather than just the one queried, because the error
   * does not say which sheet it came from and a query may join several. The
   * flag makes it happen at most once per open, so a genuinely broken query
   * cannot loop.
   */
  private async repairXlsxViewsForCellErrors(err: unknown): Promise<boolean> {
    if (this.kind !== 'xlsx' || this.xlsxErrorsTolerated) return false;
    if (!isCellParseError(err)) return false;

    this.xlsxErrorsTolerated = true;
    const repaired: string[] = [];
    for (const name of this.xlsxSheetPaths.keys()) {
      const asIdent = name.replace(/"/g, '""');
      try {
        await this.connection.run(
          `create or replace view "${asIdent}" as select * from ` +
            xlsxReadSql(this.path, name, this.xlsxSheetOptions.get(name), true)
        );
        repaired.push(name);
      } catch {
        // Leave the original view in place; the caller's rethrow still reports
        // the real problem.
      }
    }
    if (repaired.length === 0) return false;
    // Recorded rather than printed: a cell quietly becoming blank has to be
    // said out loud, and the provider is what has a UI to say it in.
    this.lateWarnings.push(describeCellRepair(err));
    return true;
  }

  /** Warnings raised since the last call. Emptied, so each is reported once. */
  takeLateWarnings(): string[] {
    return this.lateWarnings.splice(0, this.lateWarnings.length);
  }

  private async runQueryOnce(sql: string, maxRows = 0): Promise<QueryResult> {
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
  /**
   * How much of a text column try_casts to a timestamp, judged on a bounded
   * sample rather than the whole table.
   *
   * Bounded because this runs before every chart of a text axis and the answer
   * does not get truer past a few thousand rows: a column of ISO dates is
   * uniform, and a column of period labels ("1996-1Q") fails on the first row
   * as surely as on the millionth. `TEXT_AXIS_PROBE_ROWS` rows is enough to
   * tell those two apart and cheap enough not to be noticed.
   *
   * Returns the share of NON-NULL values that parsed, so a column that is
   * mostly null does not read as mostly unparseable.
   */
  private async textAxisParseRate(inner: string, xColumn: string): Promise<number> {
    const x = quoteIdent(xColumn);
    const sample = `select ${x} from ${wrapAsSubquery(inner)} as _probe where ${x} is not null limit ${TEXT_AXIS_PROBE_ROWS}`;
    const reader = await this.connection.runAndReadAll(
      `select count(*) as n, count(try_cast(${x} as timestamp)) as ok from ${wrapAsSubquery(sample)} as _probe_rows`
    );
    const [n, ok] = (reader.getRowsJson()[0] as unknown[]).map(Number);
    return n > 0 ? ok / n : 0;
  }

  /**
   * The x and y columns of `baseSql`, across the WHOLE data set.
   *
   * The trailing LIMIT is stripped rather than kept, and that is the point of
   * this method existing. A table preview runs `LIMIT 100`; charting those 100
   * rows of a 178-row series draws a line that stops in 2006 and says nothing
   * about it. A chart of an arbitrary prefix is worse than no chart, because
   * it looks exactly like a complete one.
   *
   * `xIsText` says the x column is a VARCHAR that was named as an axis rather
   * than typed as one (see chartSpec.pickXAxis). This is the ETL case and it
   * splits two ways, decided here because only the database can decide it:
   *
   *   - the strings parse as timestamps -> a real time axis over the cast,
   *     ordered by it. `Raw_Data.Date` in a live ETL file parses 16,803 of
   *     16,803, so this is what an ordinary ETL export gets;
   *   - they do not ("1996-1Q", from UNPARSEABLE_DATE_POLICY = "keep" or from
   *     output predating the parser's quarter support) -> a category axis over
   *     the labels EXACTLY as stored, and deliberately **no ORDER BY**.
   *     Sorting "1996-1Q" strings lexically would arrange them into an order
   *     that looks chronological and sometimes is not; the table's own order
   *     is the one the writer chose, and it is the only one we can stand
   *     behind.
   *
   * `maxPoints` is a real cap and is reported, not hidden -- see the caller,
   * which refuses to draw rather than silently truncating. Rows whose x is
   * null are dropped in SQL: they have no position on any axis, and leaving
   * them to be dropped client-side means the cap counts rows that were never
   * going to be drawn.
   */
  async runChartQuery(
    baseSql: string,
    xColumn: string,
    yColumns: string[],
    xIsText = false,
    maxPoints = 0
  ): Promise<QueryResult & { xAxisMode: 'time' | 'category' }> {
    const stripped = stripTrailingSemicolon(baseSql);
    const extracted = extractTrailingLimit(stripped);
    // The LIMIT is KEPT, not stripped. It used to be stripped, on the argument
    // that a chart is a picture of the whole series -- but that makes the chart
    // a picture of a different query than the one on screen, and silently: a
    // grid showing `... limit 100` plots twenty years of daily data. Every
    // other clause of the query was already honoured, so LIMIT was the one part
    // of "what you asked for" the chart overrode.
    //
    // Kept as a SUBQUERY rather than re-appended after the ordering below,
    // which matters: `select ... from (inner limit 100) order by 1` plots the
    // hundred rows the grid shows, while `select ... from inner order by 1
    // limit 100` would plot the earliest hundred rows of the whole table --
    // the same count, a different hundred, and not the ones on screen.
    const inner = extracted ? `${extracted.withoutLimit} ${extracted.limitClause}` : stripped;
    const x = quoteIdent(xColumn);
    const ys = yColumns.map(quoteIdent).join(', ');

    // A handful of junk rows in an otherwise real date column must not
    // downgrade the whole axis, so this is a high bar rather than a perfect
    // one -- and try_cast returning NULL for the failures means they simply
    // drop out of the time-axis query below.
    const asTime = !xIsText || (await this.textAxisParseRate(inner, xColumn)) >= TEXT_AXIS_MIN_PARSE_RATE;

    if (asTime) {
      const xExpr = xIsText ? `try_cast(${x} as timestamp)` : x;
      const sql =
        `select ${xExpr} as ${x}, ${ys} from ${wrapAsSubquery(inner)} as _chart ` +
        `where ${xExpr} is not null order by 1 asc`;
      return { ...(await this.runQuery(sql, maxPoints)), xAxisMode: 'time' };
    }

    const sql =
      `select ${x}, ${ys} from ${wrapAsSubquery(inner)} as _chart where ${x} is not null`;
    return { ...(await this.runQuery(sql, maxPoints)), xAxisMode: 'category' };
  }

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

    // A repeat createBackup() (Safe Mode toggled off more than once) must swap
    // the attached catalog, not stack a second backup_cmp — DuckDB won't allow
    // re-attaching an alias that's already attached.
    //
    // Detached unconditionally rather than only when `backupAttached` says so.
    // That flag is set AFTER attachBackupCatalog returns, so any failure in
    // between leaves the alias attached with the flag still false — and then
    // every later attempt fails with "database with name backup_cmp already
    // exists", which is a different error, in a different place, with nothing
    // pointing back at the attempt that actually went wrong. That is not
    // hypothetical: it is what the xlsx backup bug did in the field, and the
    // second error is what the user saw. The state on the connection is the
    // truth here; the flag is only a hint.
    await this.detachBackupCatalog().catch(() => undefined);
    this.backupAttached = false;
    this.lastBackupPath = backupPath;
    await this.attachBackupCatalog();
    this.backupAttached = true;

    return backupPath;
  }

  private async attachBackupCatalog(): Promise<void> {
    if (!this.lastBackupPath) throw new Error('No backup available to compare against');
    if (this.kind === 'duckdb') {
      await this.connection.run(`attach ${quoteLiteral(this.lastBackupPath)} as backup_cmp (read_only)`);
      return;
    }
    if (this.kind === 'sqlite') {
      await this.connection.run(
        `attach ${quoteLiteral(this.lastBackupPath)} as backup_cmp (type sqlite, read_only)`
      );
      return;
    }

    // Every other kind: mirror the live view names inside a fresh in-memory
    // catalog, so unqualified SQL resolves against it once USEd, same as the
    // others. (If this document's own file was already materialized into a
    // table via an edit, the backup itself is still the original pre-edit flat
    // file on disk — read back the same way it was opened in the first place,
    // regardless of materialization.)
    await this.connection.run(`attach ':memory:' as backup_cmp`);
    try {
      await this.connection.run('use backup_cmp');
      try {
        await this.createBackupViews();
      } finally {
        // Non-negotiable, and the reason this is a finally rather than a
        // trailing statement: while the connection points at backup_cmp, every
        // unqualified query in the session resolves against it. A throw between
        // the USE above and this line used to strand the connection there, so
        // one failed backup turned into "Table with name X does not exist" for
        // every query afterwards — the file looked fine, and nothing about the
        // error mentioned Safe Mode.
        await this.connection.run(`use ${quoteIdent(this.catalogName)}`);
      }
    } catch (err) {
      // The alias is attached even though the views are not, and DuckDB refuses
      // to re-attach a name already in use — so without this, a retry fails
      // with a second, more confusing error than the first.
      await this.connection.run('detach backup_cmp').catch(() => undefined);
      await this.clearBackupTempDir();
      throw err;
    }
  }

  /** The backup's views, in whatever shape this kind reads. Runs inside backup_cmp. */
  private async createBackupViews(): Promise<void> {
    const backupPath = this.lastBackupPath!;

    if (this.kind === 'xlsx') {
      // A workbook is the one flat kind that is genuinely multi-table, so the
      // backup needs one view per sheet under the same names the live catalog
      // uses -- the diff pairs the two catalogs up by table name. Reading a
      // workbook with read_csv_auto, which is what the old fallback did, fails
      // on the ZIP header and takes Safe Mode down with it.
      // Every option the live side is reading with applies here too, or the
      // diff compares two differently-shaped readings of the same sheet:
      // ignore_errors, because otherwise the backup throws on the same
      // uncomputable cell the live side is tolerating, and the raw rectangle,
      // because a 100-column reading against a 1-column one aligns nothing.
      let created = 0;
      for (const name of this.xlsxSheetPaths.keys()) {
        const asIdent = name.replace(/"/g, '""');
        try {
          await this.connection.run(
            `create view "${asIdent}" as select * from ` +
              xlsxReadSql(backupPath, name, this.xlsxSheetOptions.get(name), this.xlsxErrorsTolerated)
          );
          created++;
        } catch {
          // One unreadable sheet must not cost the user Safe Mode on the rest,
          // exactly as at open time.
        }
      }
      if (created === 0) {
        throw new Error('None of the workbook\'s sheets could be read from the backup copy.');
      }
      return;
    }

    let readPath = backupPath;
    if (this.kind === 'feather') {
      // read_arrow cannot read the Feather file encoding at all -- converting
      // is the entire reason this kind exists -- so the backup copy has to go
      // through the same conversion the original did.
      const converted = await convertFeatherToStream(backupPath);
      readPath = converted.streamPath;
      this.backupTempDir = converted.tempDir;
    }

    const readFn =
      this.kind === 'parquet'
        ? 'read_parquet'
        : this.kind === 'dta'
          ? 'read_dta'
          : this.kind === 'arrow' || this.kind === 'feather'
            ? 'read_arrow'
            : 'read_csv_auto';
    // The live side's CSV options apply here too, or every empty string in the
    // file reads as NULL on one side and "" on the other, and the diff reports
    // a changed cell in every one of them.
    const readOptions = this.kind === 'csv' ? CSV_READ_OPTIONS : '';
    await this.connection.run(
      `create view ${quoteIdent(this.mainObjectName)} as select * from ${readFn}(${quoteLiteral(
        readPath
      )}${readOptions})`
    );
  }

  private async clearBackupTempDir(): Promise<void> {
    if (!this.backupTempDir) return;
    const dir = this.backupTempDir;
    this.backupTempDir = undefined;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  private async detachBackupCatalog(): Promise<void> {
    await this.connection.run('detach backup_cmp');
    await this.clearBackupTempDir();
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
      const sql = `select count(*) from ((select * from ${qualifiedLive} except select * from ${qualifiedBackup}) union all (select * from ${qualifiedBackup} except select * from ${qualifiedLive}))`;
      let diffCount: number;
      try {
        diffCount = Number((await this.connection.runAndReadAll(sql)).getRows()[0][0]);
      } catch (err) {
        // One sheet holding an uncomputable cell used to end the whole
        // comparison -- and this runs for the sidebar, so every OTHER sheet
        // lost its change badge because of a #DIV/0! in one of them. Same
        // shape as the field failure this file already carries a fix for: a
        // single unreadable sheet must not cost the user the rest.
        //
        // runQuery's repair never fires here, because these queries do not go
        // through it. So it is invoked directly, and the backup's views are
        // rebuilt to match -- both sides have to read a sheet the same way or
        // the EXCEPT compares two different readings of it.
        const repaired = (await this.repairXlsxViewsForCellErrors(err)) && (await this.refreshBackupXlsxViews());
        try {
          if (!repaired) throw err;
          diffCount = Number((await this.connection.runAndReadAll(sql)).getRows()[0][0]);
        } catch {
          // Genuinely cannot be compared. Left out of the map rather than
          // guessed at: the sidebar shows no badge, which is what "we do not
          // know" looks like. Claiming 'unchanged' would be a lie the user
          // would act on.
          continue;
        }
      }
      status[table] = diffCount === 0 ? 'unchanged' : 'changed';
    }
    return status;
  }

  /**
   * Rebuild the backup catalog's sheet views with the options in force now.
   *
   * The backup's views are built once, when the backup is taken. Anything that
   * changes how the live side reads a sheet afterwards -- the ignore_errors
   * repair, or a sheet re-read as text -- leaves the two sides reading the same
   * file differently, and a diff between them then reports differences that are
   * in the reading rather than in the data.
   */
  private async refreshBackupXlsxViews(): Promise<boolean> {
    if (this.kind !== 'xlsx' || !this.lastBackupPath || !this.backupAttached) return false;
    const backupPath = this.lastBackupPath;
    await this.connection.run('use backup_cmp');
    try {
      for (const name of this.xlsxSheetPaths.keys()) {
        const asIdent = name.replace(/"/g, '""');
        await this.connection
          .run(
            `create or replace view "${asIdent}" as select * from ` +
              xlsxReadSql(backupPath, name, this.xlsxSheetOptions.get(name), this.xlsxErrorsTolerated)
          )
          .catch(() => undefined);
      }
    } finally {
      // The lesson from the field failure, applied here too: a throw between
      // the USE above and this line strands the connection in backup_cmp, and
      // every later query reports the user's own tables as missing.
      await this.connection.run(`use ${quoteIdent(this.catalogName)}`);
    }
    return true;
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
    // .xlsx used to be refused here for a sharper reason, now addressed rather
    // than lived with. DuckDB CAN write a workbook (`copy ... to ... (format
    // xlsx)`) and that was never the problem -- it writes a file containing ONE
    // sheet, so saving an edit through it would have destroyed every other
    // sheet in the book, along with the edited sheet's own formulas, number
    // formats and (Excel having no integer type) the difference between 1 and
    // 1.0. Nothing is regenerated now: xlsxWrite.ts rewrites the single <c>
    // element inside the worksheet XML and leaves the rest of the package
    // byte-for-byte, so none of that is on the table.
    if (this.readOnly || this.kind === 'kdb') return { editable: false };
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

    // A raw-rectangle sheet's columns are the spreadsheet's own letters, not
    // the sheet's header -- there is no header, which is the entire point. An
    // edit reaches the workbook by matching the grid's column NAME against the
    // header row in the XML (see xlsxWrite.patchCell), so there is nothing here
    // for it to match, and a near-miss would write to the wrong column of
    // somebody's spreadsheet. View-only until a header is what it has.
    if (this.isRawRectangleSheet(found)) return { editable: false };

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
    // A workbook is edited in the FILE, not in a materialized copy of it. Every
    // other kind here can be rewritten wholesale from the table DuckDB holds; an
    // .xlsx cannot, because that table is one sheet of many and holds none of
    // what makes a workbook a workbook. See xlsxWrite.ts.
    if (this.kind === 'xlsx') {
      return this.updateXlsxCell(table, column, newValue, rowValues, onStatus);
    }

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
   * One cell of one sheet, rewritten inside the workbook package.
   *
   * The row is identified the way every other edit here identifies one -- full-
   * row equality on the pre-edit values -- but the answer this needs is a
   * spreadsheet ROW NUMBER, and comparing DuckDB's typed values against raw
   * worksheet XML in JS is exactly the kind of nearly-right that ends with the
   * wrong cell of somebody's workbook overwritten.
   *
   * So DuckDB does the matching in its own types and reports the row's ordinal,
   * and xlsxWrite then CHECKS that the cell it is about to overwrite currently
   * holds what the grid was showing. Two independent readings have to agree
   * before anything is written; when they do not, the edit is refused.
   */
  private async updateXlsxCell(
    table: string,
    column: string,
    newValue: unknown,
    rowValues: Record<string, unknown>,
    onStatus?: (message: string) => void
  ): Promise<number> {
    const sheetPath = this.xlsxSheetPaths.get(table);
    if (!sheetPath) {
      throw new Error(`"${table}" is not a sheet of this workbook, so it cannot be edited.`);
    }
    // checkEditableSelect refuses these already, so reaching here means the
    // gate was bypassed. Refused twice on purpose: the columns of a
    // raw-rectangle sheet are spreadsheet letters rather than the sheet's own
    // header, so patchCell has nothing to match and the cost of being wrong is
    // a value written into the wrong column of somebody's workbook.
    if (this.isRawRectangleSheet(table)) {
      throw new Error(
        `"${table}" is shown as the sheet's raw layout because no header row could be found, ` +
          `so its columns are spreadsheet letters rather than names from the sheet. There is no ` +
          `way to know which column an edit belongs to, so this sheet is view-only.`
      );
    }

    const whereCols = Object.keys(rowValues);
    const whereClause = whereCols
      .map((c, i) => `${quoteIdent(c)} is not distinct from $${i + 1}`)
      .join(' and ');
    const values = whereCols.map((c) => rowValues[c]) as DuckDBValue[];

    // row_number() over () follows the scan, and read_xlsx scans the sheet in
    // sheet order -- which is what makes "the Nth row DuckDB returned" mean
    // "the Nth data row in the XML". Not trusted on its own; verified below.
    const reader = await this.connection.runAndReadAll(
      `select rn from (
         select row_number() over () as rn, * from ${quoteIdent(table)}
       ) as _rows${whereClause ? ` where ${whereClause}` : ''}`,
      values
    );
    const matches = reader.getRows();
    if (matches.length === 0) return 0;
    if (matches.length > 1) {
      // The same limitation the SQL path carries (identical rows update
      // together) -- but a file rewrite cannot be half-applied, so here it is
      // refused rather than applied to all of them.
      throw new Error(
        `${matches.length} rows in "${table}" are identical across every column, so there ` +
          `is no way to tell which one you edited. The workbook was not changed.`
      );
    }

    onStatus?.('Saving…');
    await patchXlsxCell({
      filePath: this.path,
      sheetPath,
      columnName: column,
      columnNames: whereCols,
      rowOrdinal: Number(matches[0][0]),
      expectedCurrent: rowValues[column],
      newValue,
    });
    await this.warnIfEditWillNotReadBack(table, column, newValue);
    // The view is `read_xlsx(...)`, re-read on every query, so the next one
    // already sees the file as it now is. Nothing to invalidate.
    return 1;
  }

  /**
   * Text typed into a numeric column: the write is right, the read is not.
   *
   * Verified in the XML -- the cell becomes an inline string holding the text,
   * and Excel displays it. But the column is numeric, so on the next read
   * `read_xlsx` infers DOUBLE from the remaining numbers, refuses the text, and
   * the `ignore_errors` repair blanks it. The user types a value and watches
   * the cell go empty while the file on disk is correct.
   *
   * Refusing the edit was the alternative and would be wrong: the edit is
   * legitimate and Excel honours it. So it is written, and then said plainly --
   * including the way out, which the provider offers as a button.
   */
  private async warnIfEditWillNotReadBack(table: string, column: string, newValue: unknown): Promise<void> {
    if (typeof newValue !== 'string' || newValue === '') return;
    if (this.xlsxSheetOptions.get(table)?.allVarchar) return; // already read as text
    let type: string;
    try {
      const reader = await this.connection.runAndReadAll(
        `select column_type from (describe select ${quoteIdent(column)} from ${quoteIdent(table)})`
      );
      type = String(reader.getRows()[0]?.[0] ?? '');
    } catch {
      return;
    }
    if (!/^(TINY|SMALL|BIG|HUGE|U?)INT|^INTEGER$|^DOUBLE$|^FLOAT$|^REAL$|^DECIMAL/i.test(type)) return;

    this.lateWarnings.push(
      `"${newValue}" was saved into "${column}" of sheet "${table}" — the workbook now holds it ` +
        `and Excel will show it. This viewer will show that cell as empty, because it reads ` +
        `"${column}" as a ${type.toLowerCase()} column and the text is not one.`
    );
    this.pendingReadAsTextSheet = table;
  }

  /**
   * The sheet a "read this sheet as text" offer would apply to, if the last
   * edit raised one. Drained like takeLateWarnings, and for the same reason:
   * the offer belongs beside the warning that explains it.
   */
  private pendingReadAsTextSheet: string | undefined;

  takeReadAsTextOffer(): string | undefined {
    const sheet = this.pendingReadAsTextSheet;
    this.pendingReadAsTextSheet = undefined;
    return sheet;
  }

  /**
   * Re-read one sheet with every column as text, on the user's say-so.
   *
   * Scoped to the one sheet because the cost is real -- a text column cannot be
   * sorted numerically, summarised, or charted -- and it is the whole reason
   * the automatic repair uses `ignore_errors` instead. Offering it per sheet
   * makes it the user's trade rather than the viewer's.
   */
  async readSheetAsText(sheet: string): Promise<void> {
    if (this.kind !== 'xlsx') throw new Error('Only a workbook sheet can be read as text.');
    if (!this.xlsxSheetPaths.has(sheet)) {
      throw new Error(`"${sheet}" is not a sheet of this workbook.`);
    }
    const options: XlsxSheetOptions = { ...this.xlsxSheetOptions.get(sheet), allVarchar: true };
    const asIdent = sheet.replace(/"/g, '""');
    await this.connection.run(
      `create or replace view "${asIdent}" as select * from ${xlsxReadSql(this.path, sheet, options, false)}`
    );
    this.xlsxSheetOptions.set(sheet, options);
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
    } else if (this.kind === 'feather') {
      // Two steps, because DuckDB writes only the stream encoding and the file
      // this came from is the file encoding. Writing the stream bytes straight
      // into the .feather path would "work" -- the viewer would even reopen it,
      // since the kind is sniffed from magic bytes rather than the extension --
      // and would hand every OTHER reader a file whose contents no longer match
      // its name. pyarrow.feather.read_feather() and pandas.read_feather() both
      // refuse it.
      //
      // Written to a temp file and moved into place, so an interrupted save
      // leaves the original intact rather than half a table.
      const tempDir = await mkdtemp(join(tmpdir(), 'dfv-feather-save-'));
      try {
        const streamPath = join(tempDir, 'out.arrows');
        const featherPath = join(tempDir, 'out.feather');
        await this.connection.run(`copy ${table} to '${streamPath.replace(/'/g, "''")}' (format arrow)`);
        await streamArrowStreamToFeather(streamPath, featherPath);
        // copyFile rather than rename: the temp dir is in the OS temp location,
        // which is routinely a different filesystem from the user's file, and
        // rename across devices fails with EXDEV.
        await copyFile(featherPath, this.path);
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
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
    if (this.backupTempDir) {
      void rm(this.backupTempDir, { recursive: true, force: true }).catch(() => undefined);
      this.backupTempDir = undefined;
    }
    if (this.featherTempDir) {
      // Fire-and-forget: dispose() is synchronous by contract, and a temp file
      // left behind on a failed unlink is a far smaller problem than a throw
      // out of teardown. The OS clears the directory eventually either way.
      void rm(this.featherTempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
