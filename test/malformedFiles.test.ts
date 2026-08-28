import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { zipSync, strToU8 } from 'fflate';
import { DuckDbFile } from '../src/duckdbConnection';

/**
 * What this file is for: a damaged file must be REFUSED, not half-read.
 *
 * Every format here is opened by handing a path to DuckDB and trusting what
 * comes back, so the failure worth guarding against is not a crash — it is a
 * file that opens, shows a grid, and shows the wrong thing. A truncated
 * Parquet still carries a valid header; a Feather file is byte-for-byte a
 * legal Arrow container that `read_arrow` cannot read; an .xlsx is a ZIP long
 * before it is a workbook. Each one has a plausible path to "looks fine".
 *
 * One structural note the assertions are built around: for the flat kinds
 * (parquet / csv / dta / arrow) `open()` only runs `create view ... as select
 * * from read_x(...)`, and DuckDB does not touch the file to create a view.
 * So a corrupt flat file routinely OPENS clean and only fails on first query.
 * That is why `openAndRead` below always does both, and why "did open() throw"
 * is never asserted on its own — it would pass for the wrong reason.
 */

let dir: string;

/** Open, list, and actually read. Returns the rows, or throws like the UI would. */
async function openAndRead(path: string): Promise<unknown[][]> {
  const file = await DuckDbFile.open(path);
  try {
    const tables = await file.listTables();
    if (tables.length === 0) throw new Error('no tables');
    const result = await file.runQuery(`select * from "${tables[0].replace(/"/g, '""')}" limit 5`);
    return result.rows;
  } finally {
    file.dispose();
  }
}

/** Assert a damaged file is refused with a real Error rather than served. */
async function assertRefused(path: string, what: string): Promise<void> {
  await assert.rejects(
    () => openAndRead(path),
    (err: unknown) => {
      assert.ok(err instanceof Error, `${what}: threw a non-Error (${typeof err})`);
      assert.ok(err.message.length > 0, `${what}: threw an Error with no message`);
      return true;
    },
    `${what}: was read without complaint instead of being refused`
  );
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dfv-malformed-'));
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  await connection.run(`create table t as select i as id, 'row' || i as name from range(1, 51) s(i)`);

  const q = (p: string) => join(dir, p).replace(/'/g, "''");
  await connection.run(`copy t to '${q('good.parquet')}' (format parquet)`);
  await connection.run(`copy t to '${q('good.csv')}' (format csv, header true)`);
  await connection.run(`install arrow from community; load arrow`);
  await connection.run(`copy t to '${q('good.arrows')}' (format arrow)`);

  // A real DuckDB database, written as a file rather than in memory.
  const dbInstance = await DuckDBInstance.create(join(dir, 'good.duckdb'));
  const dbConnection = await dbInstance.connect();
  await dbConnection.run(`create table t as select i as id from range(1, 11) s(i)`);
  dbConnection.closeSync();

  // The trap this project actually hit: Feather (a.k.a. Arrow IPC *file*) and
  // Arrow IPC *stream* share a name and a library, and read_arrow reads only
  // the stream one. Written here under the .arrows name a user would give it.
  await connection.run(`copy t to '${q('feather-in-disguise.arrows')}' (format parquet)`);

  const bytes = async (name: string) => readFile(join(dir, name));
  const parquet = await bytes('good.parquet');
  const arrows = await bytes('good.arrows');
  const duckdb = await bytes('good.duckdb');

  // Truncations: header intact, body cut. The case where a naive reader has
  // every reason to believe the file is fine.
  await writeFile(join(dir, 'truncated.parquet'), parquet.subarray(0, Math.floor(parquet.length / 2)));
  await writeFile(join(dir, 'truncated.arrows'), arrows.subarray(0, Math.floor(arrows.length / 2)));
  await writeFile(join(dir, 'truncated.duckdb'), duckdb.subarray(0, Math.floor(duckdb.length / 2)));

  // Header-only: the magic bytes and nothing behind them.
  await writeFile(join(dir, 'magic-only.parquet'), Buffer.from('PAR1'));

  // Empty, and plain text wearing a binary extension.
  for (const ext of ['parquet', 'arrows', 'duckdb', 'dta', 'xlsx']) {
    await writeFile(join(dir, `empty.${ext}`), '');
    await writeFile(join(dir, `text.${ext}`), 'this is not a binary file, it is a sentence.\n');
  }

  // A ZIP that is a perfectly good archive and not a workbook at all.
  await writeFile(
    join(dir, 'not-a-workbook.xlsx'),
    Buffer.from(zipSync({ 'readme.txt': strToU8('no workbook.xml here') }))
  );

  connection.closeSync();
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('the valid controls really do read, so a refusal below means something', async () => {
  for (const name of ['good.parquet', 'good.csv', 'good.arrows', 'good.duckdb']) {
    const rows = await openAndRead(join(dir, name));
    assert.ok(rows.length > 0, `${name}: read back no rows`);
    assert.equal(String(rows[0][0]), '1', `${name}: first row is not the row that was written`);
  }
});

test('a Feather file under an .arrows name is refused, not silently misread', async () => {
  // read_arrow handles the STREAM encoding only. The danger is not that this
  // fails — it is that a container this close to correct might half-decode.
  await assertRefused(join(dir, 'feather-in-disguise.arrows'), 'feather-as-arrows');
});

test('truncated files are refused rather than read up to the cut', async () => {
  for (const name of ['truncated.parquet', 'truncated.arrows', 'truncated.duckdb']) {
    await assertRefused(join(dir, name), name);
  }
});

test('a truncated Arrow stream is refused at every cut, not shown as an empty table', async () => {
  // The bug assertArrowStreamComplete exists for. read_arrow reads the schema,
  // finds no batches where the file stops, and reports zero rows with no
  // error — so the grid draws the right headers over nothing at all, which
  // looks exactly like an export that legitimately produced no rows. Every
  // one of these cuts returned 0 rows and no error before the check went in.
  const full = await readFile(join(dir, 'good.arrows'));
  for (const fraction of [0.9, 0.5, 0.25]) {
    const cut = join(dir, `cut-${fraction}.arrows`);
    await writeFile(cut, full.subarray(0, Math.floor(full.length * fraction)));
    await assertRefused(cut, `arrows cut to ${fraction * 100}%`);
  }
});

test('an Arrow stream holding zero rows is NOT mistaken for a damaged one', async () => {
  // The other half of the same check, and the reason it tests the
  // end-of-stream marker rather than the file size: a table that genuinely
  // has no rows is a complete, valid stream and must still open.
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  await connection.run(`install arrow from community; load arrow`);
  await connection.run(`create table empty_t as select 1 as id, 'x' as name where false`);
  const target = join(dir, 'genuinely-empty.arrows');
  await connection.run(`copy empty_t to '${target.replace(/'/g, "''")}' (format arrow)`);
  connection.closeSync();

  const file = await DuckDbFile.open(target);
  try {
    const result = await file.runQuery('select * from "genuinely-empty"');
    assert.equal(result.rows.length, 0, 'an empty table should read back empty');
    assert.deepEqual(result.columns, ['id', 'name'], 'and still report its columns');
  } finally {
    file.dispose();
  }
});

test('a valid header with no body behind it is refused', async () => {
  await assertRefused(join(dir, 'magic-only.parquet'), 'magic-only.parquet');
});

test('empty files are refused for every kind', async () => {
  for (const ext of ['parquet', 'arrows', 'duckdb', 'dta', 'xlsx']) {
    await assertRefused(join(dir, `empty.${ext}`), `empty.${ext}`);
  }
});

test('a text file wearing a binary extension is refused', async () => {
  for (const ext of ['parquet', 'arrows', 'duckdb', 'dta', 'xlsx']) {
    await assertRefused(join(dir, `text.${ext}`), `text.${ext}`);
  }
});

test('a ZIP that is not a workbook is refused', async () => {
  await assertRefused(join(dir, 'not-a-workbook.xlsx'), 'not-a-workbook.xlsx');
});

test('a Parquet file renamed .duckdb is refused, not opened as a database', async () => {
  // Kind is chosen by extension, so this is the collision that decides
  // whether the wrong reader gets pointed at a real, valid file.
  const disguised = join(dir, 'parquet-in-disguise.duckdb');
  await writeFile(disguised, await readFile(join(dir, 'good.parquet')));
  await assertRefused(disguised, 'parquet-as-duckdb');
});

test('a refused file leaves nothing behind that breaks the next open', async () => {
  // Each open creates an instance and a connection; a failure part-way must
  // still let the next file open cleanly rather than leaking a handle or a
  // half-attached catalog.
  for (let i = 0; i < 5; i++) {
    await assertRefused(join(dir, 'truncated.parquet'), `truncated.parquet (pass ${i})`);
  }
  const rows = await openAndRead(join(dir, 'good.parquet'));
  assert.equal(rows.length, 5, 'a good file no longer reads after repeated failures');
});
