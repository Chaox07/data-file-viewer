import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDbFile } from '../src/duckdbConnection';
import { xlsxFile } from './stress/generators/_write';

const drainedCache = new WeakMap<DuckDbFile, string[]>();

/**
 * The TABLE detected inside a sheet -- the object with named, typed columns.
 *
 * The sheet's own object is verbatim: every row and column as the file holds
 * them, all text, columns named after their Excel letters. These tests are
 * about caching and edits of the DATA, so they address the table. Querying the
 * sheet is what makes it find its tables; detection is deferred to first use.
 */
async function tableOf(file: DuckDbFile, sheet = 'data'): Promise<string> {
  await file.runQuery(`select * from "${sheet}" limit 1`);
  const found = (await file.listTables()).find((t) => t.startsWith(`${sheet} \u00b7 Table `));
  assert.ok(found, `no table was detected inside sheet "${sheet}"`);
  return found;
}

/**
 * A workbook sheet is read into memory once instead of once per query — see
 * cacheSheetAsTable. That turns each sheet from a `read_xlsx()` view into a
 * real table, which is the whole point (545 ms to 4 ms on a 21 MB workbook)
 * and also the whole risk: a table does not notice that the file underneath it
 * has changed. Everything here is about that.
 */

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'sheetcache-'));
}

const ROWS = (amount: number) => [
  ['id', 'label', 'amount'],
  [1, 'alpha', amount],
  [2, 'beta', amount + 1],
];

test('an edit lands in the file AND is visible on the next query', async () => {
  // Without the cache this held for free: the view re-read the file. With one,
  // the edit would be written and then apparently not have happened.
  const d = dir();
  const path = await xlsxFile(join(d, 'book.xlsx'), [{ name: 'data', rows: ROWS(1.5) }]);
  const file = await DuckDbFile.open(path);
  try {
    const before = await file.runQuery(`select * from "${await tableOf(file)}"`);
    const rowValues: Record<string, unknown> = {};
    before.columns.forEach((c, i) => (rowValues[c] = before.rows[0][i]));

    const changed = await file.updateCell(await tableOf(file), 'amount', 99.5, rowValues);
    assert.equal(changed, 1);

    const after = await file.runQuery(`select * from "${await tableOf(file)}" order by "id"`);
    assert.equal(Number(after.rows[0][2]), 99.5, 'the edit must be visible without reopening');
    assert.equal(Number(after.rows[1][2]), 2.5, 'and nothing else may move');
    assert.equal(after.rows.length, 2);
  } finally {
    await file.dispose();
    rmSync(d, { recursive: true, force: true });
  }
});

test('the edit is really in the file, not only in the copy held in memory', async () => {
  const d = dir();
  const path = await xlsxFile(join(d, 'book.xlsx'), [{ name: 'data', rows: ROWS(1.5) }]);
  const file = await DuckDbFile.open(path);
  const before = await file.runQuery(`select * from "${await tableOf(file)}"`);
  const rowValues: Record<string, unknown> = {};
  before.columns.forEach((c, i) => (rowValues[c] = before.rows[0][i]));
  await file.updateCell(await tableOf(file), 'amount', 99.5, rowValues);
  await file.dispose();

  const reopened = await DuckDbFile.open(path);
  try {
    const after = await reopened.runQuery(`select * from "${await tableOf(reopened)}" order by "id"`);
    assert.equal(Number(after.rows[0][2]), 99.5);
  } finally {
    await reopened.dispose();
    rmSync(d, { recursive: true, force: true });
  }
});

test('a refresh picks up a workbook another process rewrote', async () => {
  // The honesty check. A cached sheet that never reloads would let Live poll a
  // workbook forever and show the same rows — the "healthy view of something
  // nothing is writing" failure this project keeps running into.
  const d = dir();
  const path = join(d, 'book.xlsx');
  await xlsxFile(path, [{ name: 'data', rows: ROWS(1.5) }]);
  const file = await DuckDbFile.open(path, undefined, { forceReadOnly: true });
  try {
    const before = await file.runQuery(`select * from "${await tableOf(file)}" order by "id"`);
    assert.equal(Number(before.rows[0][2]), 1.5);

    await xlsxFile(path, [{ name: 'data', rows: ROWS(42) }]);

    assert.equal(await file.refreshInPlace(), true);
    const after = await file.runQuery(`select * from "${await tableOf(file)}" order by "id"`);
    assert.equal(Number(after.rows[0][2]), 42, 'the refresh must actually re-read the workbook');
  } finally {
    await file.dispose();
    rmSync(d, { recursive: true, force: true });
  }
});

test('a refresh that finds the file unreadable keeps the last good rows', async () => {
  // Stale but coherent beats a sheet vanishing out of the catalog mid-session.
  const d = dir();
  const path = join(d, 'book.xlsx');
  await xlsxFile(path, [{ name: 'data', rows: ROWS(1.5) }]);
  const file = await DuckDbFile.open(path, undefined, { forceReadOnly: true });
  try {
    // Read it BEFORE the damage. A sheet is materialised the first time it is
    // used, not when the workbook opens, so "the last good rows" only exist for
    // a sheet somebody actually looked at -- which is exactly the case this is
    // about: the rows are on screen when the file changes underneath.
    const table = await tableOf(file);

    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, 'this is not a workbook');
    await file.refreshInPlace();
    const after = await file.runQuery(`select * from "${table}" order by "id"`);
    assert.equal(after.rows.length, 2);
    assert.equal(Number(after.rows[0][2]), 1.5);
  } finally {
    await file.dispose();
    rmSync(d, { recursive: true, force: true });
  }
});

test('every sheet of a multi-sheet workbook is still listed and readable', async () => {
  const d = dir();
  const path = await xlsxFile(
    join(d, 'book.xlsx'),
    Array.from({ length: 5 }, (_, i) => ({ name: `s${i}`, rows: ROWS(i) }))
  );
  const file = await DuckDbFile.open(path);
  try {
    const tables = await file.listTables();
    assert.deepEqual(tables.sort(), ['s0', 's1', 's2', 's3', 's4']);
    for (let i = 0; i < 5; i++) {
      const r = await file.runQuery(`select * from "${await tableOf(file, `s${i}`)}" order by "id"`);
      assert.equal(r.rows.length, 2);
      assert.equal(Number(r.rows[0][2]), i);
    }
  } finally {
    await file.dispose();
    rmSync(d, { recursive: true, force: true });
  }
});

test('caching and the marker interpretation compose — the sheet is a table AND converted', async () => {
  const d = dir();
  const path = await xlsxFile(join(d, 'book.xlsx'), [
    {
      name: 'data',
      rows: [
        ['id', 'ratio'],
        [1, 'NA'],
        [2, '1.5'],
      ],
    },
  ]);
  const file = await DuckDbFile.open(path);
  try {
    const r = await file.runQuery(`select * from "${await tableOf(file)}" order by "id"`);
    assert.equal(r.columnStatsKind[1], 'numeric');
    assert.deepEqual(
      r.rows.map((row) => row[1]),
      [null, 1.5]
    );
    // A table, not a view: the whole reason the query above is fast.
    const kind = await file.runQuery(
      `select table_type from information_schema.tables where table_name = 'data'`
    );
    assert.equal(String(kind.rows[0][0]), 'BASE TABLE');
  } finally {
    await file.dispose();
    rmSync(d, { recursive: true, force: true });
  }
});
