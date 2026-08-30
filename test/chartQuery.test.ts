import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { DuckDbFile } from '../src/duckdbConnection';

/**
 * runChartQuery against a real database, because the two things it decides
 * cannot be decided anywhere else.
 *
 * 1. **Stripping the preview's LIMIT.** A table preview runs `LIMIT 100`;
 *    charting those rows of a longer series draws a line that stops early and
 *    looks exactly like a series that ends early.
 * 2. **Whether a VARCHAR date column is a time axis or a category axis.** ETL
 *    writes every date column as VARCHAR ISO text, so the type says nothing
 *    and only try_cast can answer. The fixture below holds one of each: ISO
 *    text that parses, and the "1996-1Q" period labels that do not.
 */

let dir: string;
let dbPath: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dfv-chart-'));
  dbPath = join(dir, 'fixture.duckdb');
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();

  // macro_project's shape: a native DATE column.
  await connection.run(`create table native (Date date, Rate double)`);
  await connection.run(
    `insert into native select date '2000-01-01' + interval (i) month, i * 1.5
     from range(0, 200) as t(i)`
  );

  // ETL's shape: the same dates, stored as VARCHAR ISO text.
  await connection.run(`create table etl (Date varchar, SVENF01 double)`);
  await connection.run(`insert into etl select strftime(Date, '%Y-%m-%d'), Rate from native`);

  // The degraded ETL case: period labels try_cast cannot parse. Inserted
  // deliberately out of chronological order, to pin that nothing re-sorts them.
  await connection.run(`create table labels (Date varchar, ff double)`);
  await connection.run(
    `insert into labels values ('1996-3Q', 5.3), ('1996-1Q', 5.1), ('1996-2Q', 5.2)`
  );

  // A real date column with a couple of junk rows: still a time axis.
  await connection.run(`create table mostly (Date varchar, v double)`);
  await connection.run(
    `insert into mostly select strftime(Date, '%Y-%m-%d'), Rate from native limit 100`
  );
  await connection.run(`insert into mostly values ('n/a', 1.0), ('', 2.0)`);

  connection.closeSync();
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function open(): Promise<DuckDbFile> {
  return DuckDbFile.open(dbPath);
}

test('a native DATE column charts on a time axis', async () => {
  const file = await open();
  try {
    const r = await file.runChartQuery('select * from native', 'Date', ['Rate'], false);
    assert.equal(r.xAxisMode, 'time');
    assert.equal(r.rows.length, 200);
  } finally {
    file.dispose();
  }
});

test("the preview's trailing LIMIT is stripped, so the chart is the whole series", async () => {
  // The reason runChartQuery exists at all.
  const file = await open();
  try {
    const r = await file.runChartQuery('SELECT * FROM "native" LIMIT 100;', 'Date', ['Rate'], false);
    assert.equal(r.rows.length, 200);
  } finally {
    file.dispose();
  }
});

test('a VARCHAR column of ISO text charts on a time axis, cast', async () => {
  // Every ordinary ETL export. Under the old type-only rule this was
  // unchartable.
  const file = await open();
  try {
    const r = await file.runChartQuery('select * from etl', 'Date', ['SVENF01'], true);
    assert.equal(r.xAxisMode, 'time');
    assert.equal(r.rows.length, 200);
    // Cast, not passed through: the value must be a timestamp rather than the
    // string it was stored as, or the axis silently becomes categorical.
    assert.notEqual(String(r.rows[0][0]), '2000-01-01');
    assert.ok(Number.isFinite(Date.parse(String(r.rows[0][0]))));
  } finally {
    file.dispose();
  }
});

test('a time axis is ordered by the cast date, not by the string', async () => {
  const file = await open();
  try {
    const r = await file.runChartQuery('select * from etl', 'Date', ['SVENF01'], true);
    const ms = r.rows.map((row) => Date.parse(String(row[0])));
    assert.deepEqual(ms, [...ms].sort((a, b) => a - b));
  } finally {
    file.dispose();
  }
});

test('a few junk rows do not downgrade a real date column', async () => {
  // 100 of 102 parse, which is over the bar. The two junk rows drop out via
  // try_cast returning null rather than taking the axis down with them.
  const file = await open();
  try {
    const r = await file.runChartQuery('select * from mostly', 'Date', ['v'], true);
    assert.equal(r.xAxisMode, 'time');
    assert.equal(r.rows.length, 100);
  } finally {
    file.dispose();
  }
});

test('unparseable period labels fall back to a category axis', async () => {
  const file = await open();
  try {
    const r = await file.runChartQuery('select * from labels', 'Date', ['ff'], true);
    assert.equal(r.xAxisMode, 'category');
  } finally {
    file.dispose();
  }
});

test('category labels come back verbatim, in the table’s own order', async () => {
  // Sorting "1996-3Q" / "1996-1Q" lexically would arrange them into an order
  // that LOOKS chronological. It is not ours to invent, so there is no ORDER
  // BY on this path -- the rows arrive as the writer stored them.
  const file = await open();
  try {
    const r = await file.runChartQuery('select * from labels', 'Date', ['ff'], true);
    assert.deepEqual(
      r.rows.map((row) => row[0]),
      ['1996-3Q', '1996-1Q', '1996-2Q']
    );
  } finally {
    file.dispose();
  }
});

test('the point cap is reported rather than quietly drawing a prefix', async () => {
  const file = await open();
  try {
    const r = await file.runChartQuery('select * from native', 'Date', ['Rate'], false, 50);
    assert.equal(r.truncated, true);
    assert.equal(r.rows.length, 50);
  } finally {
    file.dispose();
  }
});

test('a column name containing a quote cannot break out of the query', async () => {
  const file = await open();
  try {
    await assert.rejects(
      file.runChartQuery('select * from native', 'Date" from native; drop table native; --', ['Rate'], false)
    );
    // Still there.
    const r = await file.runQuery('select count(*) from native');
    assert.equal(Number(r.rows[0][0]), 200);
  } finally {
    file.dispose();
  }
});
