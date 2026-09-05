import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDbFile, baseTableOfSelect, type SheetBlockMode } from '../src/duckdbConnection';
import { xlsxFile } from './stress/generators/_write';

/**
 * A sheet holding six things must offer six things.
 *
 * The first version of the block work picked the widest block, called the rest
 * "notes", and showed three lines of them in a toast. Nothing deleted them and
 * they were still gone: no object in the catalog held the footnote at the top
 * of the sheet, so it could not be read, sorted, exported or plotted. Reported
 * as "I do not see the top footnotes of the file".
 *
 * So what is asserted here is REACHABILITY -- that each block is somewhere you
 * can run a query against -- not that the split is pretty.
 */

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'blocks-'));
}

/** The published shape: a footnote, a definitions table, then the data. */
function publishedSheet(dataRows = 6): unknown[][] {
  const rows: unknown[][] = [
    ['Note: this is not an official release'],
    [],
    ['Series', 'Compounding Convention', 'Mnemonic(s)'],
    ['Zero-coupon yield', 'Continuously Compounded', 'SVENYXX'],
    ['Par yield', 'Coupon-Equivalent', 'SVENPYXX'],
    [],
    ['Date', 'one', 'two'],
  ];
  for (let i = 0; i < dataRows; i++) rows.push([`2020-01-0${i + 1}`, i + 1, (i + 1) * 2]);
  return rows;
}

async function openBook(
  sheets: { name: string; rows: unknown[][] }[],
  sheetBlocks?: SheetBlockMode
): Promise<{ file: DuckDbFile; dir: string; path: string }> {
  const dir = scratchDir();
  const path = await xlsxFile(join(dir, 'book.xlsx'), sheets);
  const file = await DuckDbFile.open(path, undefined, sheetBlocks ? { sheetBlocks } : undefined);
  return { file, dir, path };
}

test('every block of a sheet is a table of its own', async () => {
  const { file, dir } = await openBook([{ name: 'data', rows: publishedSheet() }]);
  try {
    const tables = await file.listTables();
    assert.deepEqual(
      tables,
      ['data', 'data (row 1)', 'data (rows 3-5)'],
      'the sheet, its footnote and its definitions table'
    );

    // The footnote, whole. This is the sentence the user could not find.
    const note = await file.runQuery('select * from "data (row 1)"');
    assert.equal(note.rows.length, 1);
    assert.equal(note.rows[0][0], 'Note: this is not an official release');

    // The second table, with its own header promoted -- not a note, a table.
    const defs = await file.runQuery('select * from "data (rows 3-5)"');
    assert.deepEqual(defs.columns, ['Series', 'Compounding Convention', 'Mnemonic(s)']);
    assert.equal(defs.rows.length, 2);
    assert.equal(defs.rows[0][2], 'SVENYXX');

    // And the sheet itself is untouched by any of it.
    const main = await file.runQuery('select * from "data"');
    assert.deepEqual(main.columns, ['Date', 'one', 'two']);
    assert.equal(main.rows.length, 6);
    assert.equal(main.columnStatsKind[1], 'numeric', 'the data must still be plottable');
  } finally {
    file.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the notice names the tables it made rather than quoting three lines of them', async () => {
  const { file, dir } = await openBook([{ name: 'data', rows: publishedSheet() }]);
  try {
    const shapeNotice = file.openWarnings.find((w) => w.includes('the table starts at row'));
    assert.ok(shapeNotice, `expected a shape notice, got ${JSON.stringify(file.openWarnings)}`);
    assert.ok(shapeNotice!.includes('"data (row 1)"'), shapeNotice);
    assert.ok(shapeNotice!.includes('"data (rows 3-5)"'), shapeNotice);
  } finally {
    file.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a caption above the table is reachable, not just the blocks beside it', async () => {
  // The label sits INSIDE the data block (no blank row under it), which is
  // where the first implementation lost it: it is not a block of its own, it
  // is the rows above the header of the block that won.
  const rows: unknown[][] = [
    ['Yields by maturity'],
    ['Date', 'one', 'two'],
    ['2020-01-01', 1, 2],
    ['2020-01-02', 3, 4],
  ];
  const { file, dir } = await openBook([{ name: 'data', rows }]);
  try {
    assert.deepEqual(await file.listTables(), ['data', 'data (row 1)']);
    const caption = await file.runQuery('select * from "data (row 1)"');
    assert.equal(caption.rows[0][0], 'Yields by maturity');
    const main = await file.runQuery('select * from "data"');
    assert.deepEqual(main.columns, ['Date', 'one', 'two']);
    assert.equal(main.rows.length, 2);
  } finally {
    file.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an ordinary sheet gains nothing at all', async () => {
  const { file, dir } = await openBook([
    { name: 'plain', rows: [['a', 'b'], [1, 2], [3, 4]] },
  ]);
  try {
    assert.deepEqual(await file.listTables(), ['plain'], 'no extra objects for a sheet with one block');
    assert.equal(
      file.openWarnings.length,
      0,
      `a plain sheet must say nothing, got ${JSON.stringify(file.openWarnings)}`
    );
  } finally {
    file.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('"single" opens the main table only, the way it did before', async () => {
  const { file, dir } = await openBook([{ name: 'data', rows: publishedSheet() }], 'single');
  try {
    assert.deepEqual(await file.listTables(), ['data']);
    const main = await file.runQuery('select * from "data"');
    assert.deepEqual(main.columns, ['Date', 'one', 'two']);
  } finally {
    file.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('"raw" shows the sheet as it sits on disk, footnote and blank rows included', async () => {
  const { file, dir } = await openBook([{ name: 'data', rows: publishedSheet() }], 'raw');
  try {
    assert.deepEqual(await file.listTables(), ['data']);
    const raw = await file.runQuery('select * from "data"');
    // Columns named after their Excel letters -- there is no header to use.
    assert.deepEqual(raw.columns, ['A', 'B', 'C']);
    assert.equal(raw.rows.length, 13, 'every declared row, blank ones included');
    assert.equal(raw.rows[0][0], 'Note: this is not an official release');
    assert.deepEqual(raw.rows[1], [null, null, null], 'the blank row is a row');
    assert.equal(raw.rows[6][0], 'Date', 'the header is data here, not a header');
  } finally {
    file.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a sheet named like a derived table keeps its own name', async () => {
  const { file, dir } = await openBook([
    { name: 'data', rows: publishedSheet() },
    { name: 'data (row 1)', rows: [['x'], [1]] },
  ]);
  try {
    const tables = await file.listTables();
    assert.ok(tables.includes('data (row 1)'), 'the real sheet keeps the name it has in Excel');
    assert.ok(tables.includes('data (row 1)_2'), `the derived block moves: ${tables.join(', ')}`);
    // And the sheet under the contested name is the SHEET, not the footnote.
    const sheet = await file.runQuery('select * from "data (row 1)"');
    assert.deepEqual(sheet.columns, ['x']);
  } finally {
    file.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a block is read-only, and says why', async () => {
  const { file, dir, path } = await openBook([{ name: 'data', rows: publishedSheet() }]);
  const before = readFileSync(path);
  try {
    await assert.rejects(
      () =>
        file.updateCell('data (rows 3-5)', 'Mnemonic(s)', 'CHANGED', {
          Series: 'Par yield',
          'Compounding Convention': 'Coupon-Equivalent',
          'Mnemonic(s)': 'SVENPYXX',
        }),
      /one block of a sheet/,
      'the refusal has to say what is going on, not "not a sheet"'
    );
    assert.deepEqual(readFileSync(path), before, 'the workbook must not have been touched');

    // The sheet itself is still editable -- the point is that blocks are the
    // exception, not that the workbook became read-only.
    const changed = await file.updateCell('data', 'two', 99, {
      Date: '2020-01-01',
      one: 1,
      two: 2,
    });
    assert.equal(changed, 1);
    const after = await file.runQuery('select "two" from "data" limit 1');
    assert.equal(Number(after.rows[0][0]), 99);
  } finally {
    file.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Safe Mode compares the blocks too, instead of calling them new', async () => {
  const { file, dir } = await openBook([{ name: 'data', rows: publishedSheet() }]);
  try {
    await file.createBackup();
    const status = await file.compareToBackup();
    assert.deepEqual(
      status,
      { data: 'unchanged', 'data (row 1)': 'unchanged', 'data (rows 3-5)': 'unchanged' },
      'a file nobody has touched has nothing new in it'
    );
  } finally {
    file.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two sheets, each split independently', async () => {
  const { file, dir } = await openBook([
    { name: 'first', rows: publishedSheet(3) },
    { name: 'second', rows: [['a', 'b'], [1, 2]] },
  ]);
  try {
    assert.deepEqual(await file.listTables(), [
      'first',
      'first (row 1)',
      'first (rows 3-5)',
      'second',
    ]);
  } finally {
    file.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the grid does not offer to edit a block in the first place', async () => {
  const { file, dir } = await openBook([{ name: 'data', rows: publishedSheet() }]);
  try {
    const block = await file.checkEditableSelect('select * from "data (rows 3-5)" limit 100');
    assert.equal(block.editable, false, 'an editable-looking cell that refuses on save is the worse failure');
    const sheet = await file.checkEditableSelect('select * from "data" limit 100');
    assert.equal(sheet.editable, true, 'the sheet itself is still editable');
  } finally {
    file.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('each block is its own chart, so two can be looked at together', () => {
  // The key the chart tabs are held by. Not checkEditableSelect: a block is
  // never editable, and every block sharing one tab is the bug this replaced.
  assert.equal(baseTableOfSelect('SELECT * FROM "data (rows 3-5)" LIMIT 100;'), 'data (rows 3-5)');
  assert.equal(baseTableOfSelect('select * from data'), 'data');
  assert.equal(baseTableOfSelect('select a, b from "data"'), undefined, 'a query somebody wrote is one thing');
  assert.equal(baseTableOfSelect(undefined), undefined);
});
