import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDbFile } from '../src/duckdbConnection';
import { xlsxFile } from './stress/generators/_write';

/**
 * End-to-end, against real workbooks and the real DuckDB.
 *
 * textColumns.test.ts covers the decision in isolation; this covers what the
 * user sees, which is the part that was wrong: a column of numbers with `NA`
 * in it typed as text and vanished from the chart's column picker without a
 * word. See interpretTextColumns in duckdbConnection.ts.
 */

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'markers-'));
}

async function openSheet(
  rows: unknown[][],
  options?: { nullText?: readonly string[] }
): Promise<{ file: DuckDbFile; dir: string }> {
  const dir = scratchDir();
  const path = await xlsxFile(join(dir, 'book.xlsx'), [{ name: 'data', rows }]);
  const file = await DuckDbFile.open(path, undefined, options);
  return { file, dir };
}

/**
 * Numeric rows with the markers placed wherever the caller asks.
 *
 * One decimal place, deliberately. "1.001" is genuinely ambiguous — 1001 read
 * as Turkish, 1.001 read as English — so a column of those is refused by W1's
 * arbitration before this module's question is even reached. Correct, but it
 * would test the wrong refusal.
 */
function seriesWithMarkers(total: number, markerRows: (i: number) => boolean, note?: [number, string]) {
  const rows: unknown[][] = [['id', 'ratio']];
  for (let i = 0; i < total; i++) {
    rows.push([i, markerRows(i) ? 'NA' : String((i + 1) * 0.5)]);
  }
  if (note) rows[note[0] + 1][1] = note[1];
  return rows;
}

test('a numeric column with NA in it becomes numeric, and the NA cells become empty', async () => {
  const { file, dir } = await openSheet([
    ['id', 'ratio'],
    [1, 'NA'],
    [2, '1.5'],
    [3, '#N/A'],
    [4, '2.5'],
  ]);
  try {
    const r = await file.runQuery('select * from "data"');
    assert.equal(r.columnStatsKind[1], 'numeric', 'the column must be plottable');
    assert.deepEqual(
      r.rows.map((row) => row[1]),
      [null, 1.5, null, 2.5]
    );
    assert.ok(
      file.openWarnings.some((w) => /read as numbers/.test(w) && /2 Excel error markers/.test(w)),
      `the count is the evidence; got: ${file.openWarnings.join(' | ')}`
    );
  } finally {
    await file.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no row is lost — the count is the same before and after', async () => {
  const { file, dir } = await openSheet([
    ['id', 'ratio'],
    [1, 'NA'],
    [2, '1.5'],
    [3, '#N/A'],
    [4, '2.5'],
  ]);
  try {
    const r = await file.runQuery('select count(*) as n from "data"');
    assert.equal(Number(r.rows[0][0]), 4);
  } finally {
    await file.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a column whose FIRST 2,000 rows are all markers still converts', async () => {
  // The head of a time series is the least representative part of it. Measured
  // on YieldCurve_Data.xlsx: its long-maturity columns are "NA" for the first
  // 3,274 rows because those maturities did not exist in 1961, and a `limit
  // 2000` sample concluded "nothing but markers" for all 70 of them.
  const { file, dir } = await openSheet(seriesWithMarkers(3000, (i) => i < 2500));
  try {
    const r = await file.runQuery('select * from "data" limit 1');
    assert.equal(r.columnStatsKind[1], 'numeric');
    const counts = await file.runQuery(
      'select count(*) as n, count("ratio") as filled from "data"'
    );
    assert.equal(Number(counts.rows[0][0]), 3000);
    assert.equal(Number(counts.rows[0][1]), 500);
  } finally {
    await file.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one written note far past the sample keeps the whole column as text', async () => {
  // The sample cannot see row 2,800, so this is the whole-column check doing
  // the work. Converted, that note would have become NULL and been
  // indistinguishable from the markers.
  const { file, dir } = await openSheet(
    seriesWithMarkers(3000, (i) => i % 7 === 0, [2800, 'under review'])
  );
  try {
    const r = await file.runQuery('select * from "data" limit 1');
    assert.equal(r.columnStatsKind[1], 'other', 'the column must keep its text');
    const kept = await file.runQuery(`select count(*) as n from "data" where "ratio" = 'under review'`);
    assert.equal(Number(kept.rows[0][0]), 1, 'the note itself must survive');
    assert.ok(
      file.openWarnings.some((w) => /"ratio" was left as text/.test(w)),
      `the refusal must be said out loud; got: ${file.openWarnings.join(' | ')}`
    );
  } finally {
    await file.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nullText: [] reads the file literally', async () => {
  const { file, dir } = await openSheet(
    [
      ['id', 'ratio'],
      [1, 'NA'],
      [2, '1.5'],
    ],
    { nullText: [] }
  );
  try {
    const r = await file.runQuery('select * from "data"');
    assert.deepEqual(
      r.rows.map((row) => row[1]),
      ['NA', '1.5']
    );
    assert.equal(file.openWarnings.length, 0, 'nothing was interpreted, so there is nothing to report');
  } finally {
    await file.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a workbook with no markers is untouched and says nothing', async () => {
  const { file, dir } = await openSheet([
    ['id', 'label'],
    [1, 'alpha'],
    [2, 'beta'],
  ]);
  try {
    const r = await file.runQuery('select * from "data"');
    assert.deepEqual(
      r.rows.map((row) => row[1]),
      ['alpha', 'beta']
    );
    assert.equal(r.columnStatsKind[1], 'other');
    assert.equal(file.openWarnings.length, 0);
  } finally {
    await file.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a column of nothing but markers empties but keeps its type', async () => {
  const { file, dir } = await openSheet([
    ['id', 'ratio'],
    [1, 'NA'],
    [2, '#N/A'],
  ]);
  try {
    const r = await file.runQuery('select * from "data"');
    assert.deepEqual(
      r.rows.map((row) => row[1]),
      [null, null]
    );
    assert.ok(
      file.openWarnings.some((w) => /nothing but error markers/.test(w)),
      `got: ${file.openWarnings.join(' | ')}`
    );
  } finally {
    await file.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a sheet whose header is not row 1 opens at its own first column, with no phantom', async () => {
  // Anchoring the range at "A" instead of the sheet's declared first column
  // gave every shaped sheet a leading all-NULL column called C0.
  const dir = scratchDir();
  const path = await xlsxFile(join(dir, 'book.xlsx'), [
    {
      name: 'data',
      leadingBlankColumns: 1,
      rows: [
        ['Some workbook', null, null],
        [null, null, null],
        ['Date', 'a', 'b'],
        ['2020-01-01', 1, 2],
        ['2020-01-02', 3, 4],
      ],
    },
  ]);
  const file = await DuckDbFile.open(path);
  try {
    const r = await file.runQuery('select * from "data"');
    assert.deepEqual(r.columns, ['Date', 'a', 'b']);
    assert.equal(r.rows.length, 2);
  } finally {
    await file.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
