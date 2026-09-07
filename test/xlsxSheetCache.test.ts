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
    const before = await file.runQuery(`select * from "${table}" order by "id"`);
    assert.equal(Number(before.rows[0][2]), 1.5);

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

test('detected tables stay lazy until first use, so opening a sheet reads the workbook once', async () => {
  const d = dir();
  const path = await xlsxFile(join(d, 'book.xlsx'), [
    {
      name: 'data',
      rows: [
        ['date', 'left', null, 'date', 'right'],
        ['2020-01-01', 2, null, '2020-01-01', 20],
        ['2020-01-02', 1, null, '2020-01-02', 10],
      ],
    },
  ]);
  const file = await DuckDbFile.open(path);
  try {
    await file.runQuery('select * from "data" limit 1');
    const detected = (await file.listTables()).filter((name) => name.startsWith('data · Table '));
    assert.equal(detected.length, 2);
    assert.deepEqual(await file.listSidebarTables(), ['data'], 'detected tables duplicated the sheet in the sidebar');
    assert.deepEqual(
      file.getDetectedSheetTables('data').map(({ name, sheet, ...layout }) => ({ name, sheet, ...layout })),
      [
        {
          name: detected[0],
          sheet: 'data',
          top: 0,
          bottom: 3,
          left: 0,
          right: 2,
          headerRow: 0,
          columns: ['date', 'left'],
          columnStatsKind: ['other', 'numeric'],
          rowCount: 2,
        },
        {
          name: detected[1],
          sheet: 'data',
          top: 0,
          bottom: 3,
          left: 3,
          right: 5,
          headerRow: 0,
          columns: ['date', 'right'],
          columnStatsKind: ['other', 'numeric'],
          rowCount: 2,
        },
      ]
    );

    const kindsBefore = await file.runQuery(
      `select table_name, table_type from information_schema.tables
       where table_name like 'data · Table %' order by table_name`
    );
    assert.deepEqual(
      kindsBefore.rows.map((row) => row.map(String)),
      detected.map((name) => [name, 'VIEW']),
      'merely opening the sheet eagerly materialized every detected table'
    );

    const first = await file.runDetectedTableQuery(
      detected[0],
      [{ column: 'date', operator: 'contains', value: '2020' }],
      { column: 'left', direction: 'asc' },
      1
    );
    assert.deepEqual(first.rows.map((row) => Number(row[1])), [1]);
    assert.equal(first.totalRows, 2, 'the inline row count confused its display limit with its filter');
    const hostileFilter = await file.runDetectedTableQuery(detected[0], [
      { column: 'date', operator: 'contains', value: "2020' or true --" },
    ]);
    assert.equal(hostileFilter.rows.length, 0, 'filter text escaped into executable SQL');
    await assert.rejects(
      file.runDetectedTableQuery(detected[0], [{ column: 'missing', operator: 'equals', value: 'x' }]),
      /does not exist/
    );

    const exact = await file.runDetectedTableQuery(detected[0], [
      { column: 'left', operator: 'equals', value: '1' },
    ]);
    assert.deepEqual(exact.rows.map((row) => Number(row[1])), [1]);
    const greater = await file.runDetectedTableQuery(detected[0], [
      { column: 'left', operator: 'gt', value: '1' },
    ]);
    assert.deepEqual(greater.rows.map((row) => Number(row[1])), [2]);
    const range = await file.runDetectedTableQuery(detected[0], [
      { column: 'left', operator: 'between', value: '1', valueTo: '2' },
    ]);
    assert.equal(range.rows.length, 2);

    // Junk in a numeric filter names the column and the value the user typed.
    // Left to DuckDB's own cast this said `Could not convert string "abc" to
    // DECIMAL(3,1)`, which names a type nobody chose and no filter at all.
    await assert.rejects(
      file.runDetectedTableQuery(detected[0], [
        { column: 'left', operator: 'gt', value: 'abc' },
      ]),
      /"abc" is not a number, so left cannot be compared to it/
    );

    // The filter box is where somebody retypes what they are looking at, and
    // a Turkish workbook renders 1,5 rather than 1.5. The viewer already reads
    // both conventions when it types a sheet's columns; refusing one here
    // would be the viewer disagreeing with itself.
    const european = await file.runDetectedTableQuery(detected[0], [
      { column: 'left', operator: 'gt', value: '1,5' },
    ]);
    assert.deepEqual(european.rows.map((row) => Number(row[1])), [2]);

    const kindsAfter = await file.runQuery(
      `select table_name, table_type from information_schema.tables
       where table_name like 'data · Table %' order by table_name`
    );
    assert.deepEqual(
      kindsAfter.rows.map((row) => row.map(String)),
      [
        [detected[0], 'BASE TABLE'],
        [detected[1], 'VIEW'],
      ],
      'using one detected table should not force its neighbour to load'
    );

    // Sorting can be the first action on an inline detected table. It must
    // trigger the same one-time preparation without requiring a preview query.
    const second = await file.runSortedQuery(
      `select * from "${detected[1]}"`,
      'right',
      'asc'
    );
    assert.deepEqual(second.rows.map((row) => Number(row[1])), [10, 20]);
    const secondKind = await file.runQuery(
      `select table_type from information_schema.tables where table_name = '${detected[1]}'`
    );
    assert.equal(String(secondKind.rows[0][0]), 'BASE TABLE');
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

test('detected-table blank and non-blank filters include empty spreadsheet cells', async () => {
  const d = dir();
  const path = await xlsxFile(join(d, 'book.xlsx'), [
    {
      name: 'data',
      rows: [
        ['date', 'value', 'note'],
        ['2024-01-01', 1, 'ready'],
        ['2024-01-02', 2, null],
        ['2024-01-03', 3, ''],
      ],
    },
  ]);
  const file = await DuckDbFile.open(path);
  try {
    const table = await tableOf(file);
    const blank = await file.runDetectedTableQuery(table, [
      { column: 'note', operator: 'isBlank' },
    ]);
    assert.deepEqual(blank.rows.map((row) => Number(row[1])), [2, 3]);

    const nonBlank = await file.runDetectedTableQuery(table, [
      { column: 'note', operator: 'isNotBlank' },
    ]);
    assert.deepEqual(nonBlank.rows.map((row) => Number(row[1])), [1]);
  } finally {
    await file.dispose();
    rmSync(d, { recursive: true, force: true });
  }
});
