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

  await connection.run(`create table years (Year integer, Rate double)`);
  await connection.run(`insert into years values (2023, 3.0), (2021, 1.0), (2022, 2.0)`);

  // A numeric period label that is NOT a year, stored out of order for the
  // same reason: it must keep the category axis and the table's own ordering.
  await connection.run(`create table months (Month integer, Rate double)`);
  await connection.run(`insert into months values (3, 3.0), (1, 1.0), (2, 2.0)`);

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

test("a trailing LIMIT is honoured, so the chart is the query on screen", async () => {
  // This used to assert the opposite -- the LIMIT was stripped and the chart
  // drew all 200 rows. That made the chart a picture of a query nobody had
  // written: a grid showing `limit 100` plotted the whole table, silently, and
  // every other clause of the query WAS being honoured. LIMIT was the one part
  // of "what you asked for" the chart overrode.
  const file = await open();
  try {
    const r = await file.runChartQuery('SELECT * FROM "native" LIMIT 100;', 'Date', ['Rate'], false);
    assert.equal(r.rows.length, 100);
  } finally {
    file.dispose();
  }
});

test('the limited rows are the ones the grid shows, not the earliest by x', async () => {
  // The subtle half. Applying the LIMIT inside the subquery plots the hundred
  // rows the grid holds; re-appending it after the chart's own `order by 1`
  // would plot the earliest hundred rows of the whole table -- the same count,
  // a different hundred, and not the ones on screen.
  const file = await open();
  try {
    const limited = await file.runChartQuery(
      'select * from "native" order by "Date" desc limit 10',
      'Date',
      ['Rate'],
      false
    );
    const all = await file.runChartQuery('select * from "native"', 'Date', ['Rate'], false);
    assert.equal(limited.rows.length, 10);
    // The ten LATEST dates, because that is what the query selected -- not the
    // ten earliest, which is what a re-appended LIMIT would have produced.
    const lastOfAll = all.rows[all.rows.length - 1][0];
    const lastOfLimited = limited.rows[limited.rows.length - 1][0];
    assert.deepEqual(lastOfLimited, lastOfAll);
    assert.notDeepEqual(limited.rows[0][0], all.rows[0][0]);
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

/**
 * A year IS a point in time, so it gets a real time axis -- read through
 * make_date rather than a cast, which is what makes it safe.
 *
 * This deliberately overturns the earlier "a numeric Year remains a category
 * in stored order" rule. That rule was right to refuse `cast(2024 as
 * timestamp)`, which reads the number as epoch seconds and lands in 1970 --
 * but the fixture shows what refusing outright costs: the rows are stored
 * 2023, 2021, 2022, and a category axis draws exactly that, a line running
 * backwards through time. A category axis carries no ORDER BY on purpose,
 * because "1996-1Q" sorted lexically can mislead; integers have no such
 * ambiguity, so the reason does not reach this case.
 */
test('a numeric Year charts on an ordered time axis, not a category', async () => {
  const file = await open();
  try {
    const r = await file.runChartQuery('select * from years', 'Year', ['Rate'], false, 0, true);
    assert.equal(r.xAxisMode, 'time');
    // Sorted, and each year placed at its own 1 January.
    assert.deepEqual(
      r.rows.map((row) => String(row[0]).slice(0, 10)),
      ['2021-01-01', '2022-01-01', '2023-01-01']
    );
    assert.deepEqual(r.rows.map((row) => Number(row[1])), [1.0, 2.0, 3.0]);
  } finally {
    file.dispose();
  }
});

/**
 * The bound is what keeps the rule honest. `Month` holding 1..12 is a numeric
 * period label too, and make_date(1, 1, 1) would draw the series in antiquity
 * -- so anything that is not plausibly a year falls back to the category axis
 * it would have been anyway, in stored order.
 */
test('a numeric period that is not a year stays a category in stored order', async () => {
  const file = await open();
  try {
    const r = await file.runChartQuery('select * from months', 'Month', ['Rate'], false, 0, true);
    assert.equal(r.xAxisMode, 'category');
    assert.deepEqual(r.rows.map((row) => Number(row[0])), [3, 1, 2]);
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
