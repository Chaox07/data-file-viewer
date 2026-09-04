import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyseSheet,
  dedupe,
  needsBlockHandling,
  notesText,
  splitBlocks,
  type Cell,
} from '../src/sheetBlocks';

/**
 * Where the table starts on a sheet whose header is not row 1.
 *
 * The fixtures below are the real geometry of
 * `Desktop/scatter/YieldCurve_Data.xlsx`, measured from the file rather than
 * imagined: `used-YieldCurve` is a 3-wide preamble, a 3-wide spanning label,
 * then a 33-wide header; `Raw_Data` is a 1-wide note, a 3-wide series legend,
 * then a 100-wide header. Copied here as fixtures rather than read from disk
 * so the suite does not depend on a file outside the repo.
 *
 * The case with teeth is row 5 of used-YieldCurve. `#of Years to Maturity |
 * 1-Period HPY's | Excess Returns` is three strings wide, so ETL's rule --
 * all non-empty values are strings, behind a breadth gate of 2 -- promotes it
 * and yields a 3-column table with the real 33-column header sitting in it as
 * data. Only comparing against the block's own modal width rejects it.
 */

const wide = (n: number, prefix: string): Cell[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`);

/** used-YieldCurve, rows 0..8 with the real widths. */
const USED_YIELD_CURVE: Cell[][] = [
  [],
  ['Series', 'Compounding Convention', 'Mnemonic(s)'],
  ['Zero-coupon yield', 'Continuously Compounded', 'SVENYXX'],
  [],
  ["#of Years to Maturity", "1-Period HPY's", 'Excess Returns'],
  ['Date', ...wide(32, 'c')],
  ['22446', ...wide(32, 'v')],
  ['22447', ...wide(32, 'v')],
  ['22448', ...wide(32, 'v')],
];

/** Raw_Data, rows 0..12 with the real widths. */
const RAW_DATA: Cell[][] = [
  [],
  ['Note: This is not an official Federal Reserve statistical release.'],
  [],
  ['Series', 'Compounding Convention', 'Mnemonic(s)'],
  ['Zero-coupon yield', 'Continuously Compounded', 'SVENYXX'],
  ['Par yield', 'Coupon-Equivalent', 'SVENPYXX'],
  ['Parameters', 'N/A', 'BETA0 to TAU2'],
  [],
  ['Date', 'BETA0', 'BETA1', ...wide(97, 'c')],
  ['22446', '3.9176', '-1.2779', ...wide(97, 'v')],
  ['22447', '3.9784', '-1.2574', ...wide(97, 'v')],
];

test('used-YieldCurve: the 33-wide row is the header, not the label above it', () => {
  const shape = analyseSheet(USED_YIELD_CURVE);
  assert.ok(shape.table);
  assert.equal(shape.table!.headerRow, 5, 'header is sheet row 5');
  assert.equal(shape.table!.header?.[0], 'Date');
  assert.equal(shape.table!.width, 33);
  assert.equal(shape.table!.rows.length, 3, 'three data rows, header excluded');
});

test('the spanning label is kept as preamble, not promoted and not dropped', () => {
  const shape = analyseSheet(USED_YIELD_CURVE);
  // Not the header...
  assert.notEqual(shape.table!.header?.[0], '#of Years to Maturity');
  // ...and not gone either. The viewer only views.
  const notes = notesText(shape).join('\n');
  assert.match(notes, /#of Years to Maturity/);
  assert.match(notes, /Series \| Compounding Convention/);
  assert.match(notes, /Zero-coupon yield/);
});

test('a naive "first row after the blank" rule would have got this wrong', () => {
  // Pinning the actual failure mode, so the reason for the width rule cannot
  // be refactored away by accident: row 4 is three strings wide and passes
  // every all-strings/breadth test there is.
  const row4 = USED_YIELD_CURVE[4];
  assert.equal(row4.filter((v) => v !== null && String(v).trim() !== '').length, 3);
  assert.ok(row4.every((v) => typeof v === 'string'));
  // And yet it is not the header.
  assert.equal(analyseSheet(USED_YIELD_CURVE).table!.headerRow, 5);
});

test('Raw_Data: the 100-wide block wins over the note and the legend', () => {
  const shape = analyseSheet(RAW_DATA);
  assert.equal(shape.table!.headerRow, 8);
  assert.deepEqual(shape.table!.header?.slice(0, 3), ['Date', 'BETA0', 'BETA1']);
  assert.equal(shape.table!.width, 100);
  assert.equal(shape.table!.rows.length, 2);
  // The note and the 3-wide series legend are both kept.
  assert.equal(shape.notes.length, 2);
  const notes = notesText(shape).join('\n');
  assert.match(notes, /not an official Federal Reserve/);
  assert.match(notes, /Par yield/);
});

test('an ordinary single-block sheet is untouched', () => {
  // The regression that matters most: every normal workbook must behave
  // exactly as it did before any of this existed.
  const plain: Cell[][] = [
    ['Date', 'Value'],
    ['2024-01-01', 1],
    ['2024-01-02', 2],
  ];
  const shape = analyseSheet(plain);
  assert.equal(shape.table!.headerRow, 0);
  assert.deepEqual(shape.table!.header, ['Date', 'Value']);
  assert.equal(shape.table!.rows.length, 2);
  assert.equal(shape.notes.length, 0);
  assert.equal(needsBlockHandling(shape), false, 'no special handling needed');
});

test('needsBlockHandling is true exactly when the sheet is not plain', () => {
  assert.equal(needsBlockHandling(analyseSheet(USED_YIELD_CURVE)), true);
  assert.equal(needsBlockHandling(analyseSheet(RAW_DATA)), true);
});

test('only a genuinely blank row separates blocks', () => {
  // ETL's sentinels=false: a row whose value is the literal text "NULL" is a
  // data row with a missing value, and splitting on it fabricated a second
  // table with invented column names.
  const rows: Cell[][] = [
    ['Date', 'Value'],
    ['2024-01-01', 1],
    ['NULL', 'NULL'],
    ['2024-01-03', 3],
  ];
  assert.equal(splitBlocks(rows).length, 1);
});

test('a block with no row wide enough promotes no header', () => {
  const shape = analyseSheet([['Kaynak: TCMB']]);
  assert.equal(shape.table?.header, null);
  assert.equal(shape.table?.rows.length, 1, 'the line survives as a row');
});

test('a header narrower than its data rows keeps the extra column', () => {
  // A trailing unlabelled column is common; truncating to the header's own
  // populated count would silently drop the data under it.
  const rows: Cell[][] = [
    ['Date', 'Value', null],
    ['2024-01-01', 1, 'note'],
    ['2024-01-02', 2, 'note'],
  ];
  const shape = analyseSheet(rows);
  assert.equal(shape.table!.header?.length, 3);
  assert.equal(shape.table!.header?.[2], '_col2');
});

test('repeated captions are suffixed, not dropped', () => {
  assert.deepEqual(dedupe(['a', 'b', 'a', 'a']), ['a', 'b', 'a_1', 'a_2']);
  assert.deepEqual(dedupe(['', '']), ['_col', '_col_1']);
});

test('an empty sheet yields no table and throws nothing', () => {
  const shape = analyseSheet([]);
  assert.equal(shape.table, null);
  assert.equal(needsBlockHandling(shape), false);
  const blank = analyseSheet([[], [null, '  ']]);
  assert.equal(blank.table, null);
});

test('nothing here mutates its input', () => {
  const rows: Cell[][] = [['Date', 'Value'], ['2024-01-01', 1]];
  const snapshot = JSON.stringify(rows);
  analyseSheet(rows);
  splitBlocks(rows);
  assert.equal(JSON.stringify(rows), snapshot);
});
