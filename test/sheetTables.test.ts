import assert from 'node:assert/strict';
import test from 'node:test';
import {
  columnLetters,
  dedupe,
  detectTables,
  foldLabel,
  looksLikeFooter,
  splitRegions,
  wholeGrid,
  type Cell,
} from '../src/sheetTables';

/**
 * The fixtures below are the real geometry of
 * `Desktop/scatter/YieldCurve_Data.xlsx`, measured from the file rather than
 * imagined: `used-YieldCurve` is a 3-wide preamble, a 3-wide spanning label,
 * then a 33-wide header; `Raw_Data` is a 1-wide note, a 3-wide series legend,
 * then a 100-wide header. Copied here rather than read from disk so the suite
 * does not depend on a file outside the repo.
 *
 * The case with teeth is row 4 of used-YieldCurve. `#of Years to Maturity |
 * 1-Period HPY's | Excess Returns` is three strings wide, so ETL's rule alone
 * -- all populated values are strings, behind a breadth gate of 2 -- promotes
 * it and yields a 3-column table with the real 33-column header sitting inside
 * it as data. Only the modal-width gate rejects it.
 */

const wide = (n: number, prefix: string): Cell[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`);

/** used-YieldCurve, rows 0..8 with the real widths. */
const USED_YIELD_CURVE: Cell[][] = [
  [],
  ['Series', 'Compounding Convention', 'Mnemonic(s)'],
  ['Zero-coupon yield', 'Continuously Compounded', 'SVENYXX'],
  [],
  ['#of Years to Maturity', "1-Period HPY's", 'Excess Returns'],
  ['Date', ...wide(32, 'c')],
  ['22446', ...wide(32, 'v')],
  ['22447', ...wide(32, 'v')],
  ['22448', ...wide(32, 'v')],
];

/** Raw_Data, rows 0..10 with the real widths. */
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

/* ------------------------------------------------------------ header choice */

test('used-YieldCurve: the 33-wide row is the header, not the 3-wide label above it', () => {
  const tables = detectTables(USED_YIELD_CURVE);
  const main = tables.find((t) => t.columns.length === 33);
  assert.ok(main, 'the 33-column table was not found');
  assert.equal(main.headerRow, 5);
  assert.equal(main.columns[0], 'Date');
  assert.equal(main.rowCount, 3);
  // The table starts at its header. The spanning label on row 4 is above it,
  // belongs to no table, and is still on the sheet at row 4.
  assert.equal(main.region.top, 5);
  assert.ok(
    !tables.some((t) => t.region.top === 4),
    'the spanning label was offered as a table of its own'
  );
});

test('the naive all-strings rule would have taken the label; this does not', () => {
  const label = USED_YIELD_CURVE[4];
  assert.ok(label.every((v) => typeof v === 'string'), 'fixture no longer exercises the trap');
  const tables = detectTables(USED_YIELD_CURVE);
  assert.ok(
    !tables.some((t) => t.columns.length === 3 && t.columns[0] === '#of Years to Maturity'),
    'the spanning label was promoted to a header'
  );
});

test('Raw_Data: the 100-wide table is found, and the note above it is not a table', () => {
  const tables = detectTables(RAW_DATA);
  const main = tables.find((t) => t.columns.length === 100);
  assert.ok(main, 'the 100-column table was not found');
  assert.equal(main.headerRow, 8);
  assert.equal(main.columns.slice(0, 3).join('|'), 'Date|BETA0|BETA1');
  assert.ok(
    !tables.some((t) => t.region.top === 1),
    'the "Note: ..." sentence was returned as a table'
  );
});

test('a 3x4 series legend is a table in its own right', () => {
  const tables = detectTables(RAW_DATA);
  const legend = tables.find((t) => t.region.top === 3);
  assert.ok(legend, 'the legend block was not offered');
  assert.deepEqual(legend.columns, ['Series', 'Compounding Convention', 'Mnemonic(s)']);
  assert.equal(legend.rowCount, 3);
});

/* -------------------------------------------------------- side-by-side split */

test('two tables separated by a blank column are two tables', () => {
  const grid: Cell[][] = [
    ['Date', 'cpi', null, 'Date', 'gdp'],
    ['2020', 1.0, null, '2020', 5.0],
    ['2021', 1.1, null, '2021', 5.2],
  ];
  const tables = detectTables(grid);
  assert.equal(tables.length, 2);
  assert.deepEqual(tables[0].columns, ['Date', 'cpi']);
  assert.deepEqual(tables[1].columns, ['Date', 'gdp']);
  assert.equal(tables[0].region.left, 0);
  assert.equal(tables[0].region.right, 2);
  assert.equal(tables[1].region.left, 3);
  assert.equal(tables[1].region.right, 5);
});

test('without the column split they fuse into one wide table, as the ETL does', () => {
  const grid: Cell[][] = [
    ['Date', 'cpi', null, 'Date', 'gdp'],
    ['2020', 1.0, null, '2020', 5.0],
    ['2021', 1.1, null, '2021', 5.2],
  ];
  const tables = detectTables(grid, { splitColumns: false });
  assert.equal(tables.length, 1);
  // The blank column is still a column; the duplicate name is suffixed.
  assert.deepEqual(tables[0].columns, ['Date', 'cpi', '_col2', 'Date_1', 'gdp']);
});

test('a 2x2 grid of tables needs both splits, repeatedly', () => {
  const grid: Cell[][] = [
    ['Date', 'a', null, 'Date', 'b'],
    ['2020', 1, null, '2020', 2],
    [],
    ['Date', 'c', null, 'Date', 'd'],
    ['2021', 3, null, '2021', 4],
  ];
  const tables = detectTables(grid);
  assert.equal(tables.length, 4);
  assert.deepEqual(
    tables.map((t) => t.columns[1]),
    ['a', 'b', 'c', 'd'],
    'tables should come back in reading order: down the page, then across'
  );
});

test('a shorter table beside a taller one still separates', () => {
  const grid: Cell[][] = [
    ['Date', 'a', null, 'Date', 'b'],
    ['2020', 1, null, '2020', 2],
    [null, null, null, '2021', 3],
    [null, null, null, '2022', 4],
  ];
  const tables = detectTables(grid);
  assert.equal(tables.length, 2);
  assert.equal(tables[0].rowCount, 1);
  assert.equal(tables[1].rowCount, 3);
});

/* ------------------------------------------------------------- blank rules */

test('a row whose only populated cell is "NULL" is data, not a separator', () => {
  const grid: Cell[][] = [
    ['Date', 'v'],
    ['2020', 1],
    ['NULL', 'NULL'],
    ['2021', 2],
  ];
  const tables = detectTables(grid);
  assert.equal(tables.length, 1, '"NULL" split the table in two');
  assert.equal(tables[0].rowCount, 3);
});

test('an Excel error marker occupies its cell', () => {
  const grid: Cell[][] = [
    ['Date', 'v'],
    ['2020', '#N/A'],
    ['2021', 2],
  ];
  const tables = detectTables(grid);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].rowCount, 2);
});

/* ---------------------------------------------------------------- footnotes */

test('a lone "Kaynak: TCMB" promotes no header and is no table', () => {
  const grid: Cell[][] = [
    ['Date', 'v'],
    ['2020', 1],
    ['2021', 2],
    [],
    ['Kaynak: TCMB'],
  ];
  const tables = detectTables(grid);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].region.bottom, 3, 'the footnote was swept into the table');
});

test('a footnote WIDER than the table above it is still a footnote', () => {
  // The TCMB shape: 124 rows of two columns, then three-column notes beneath.
  const grid: Cell[][] = [
    ['Tarih', 'kur'],
    ['2020', 1.0],
    ['2021', 1.1],
    [],
    ['Veri Kaynağı', 'TCMB', 'EVDS'],
    ['Etiketler', 'Kurlar', 'Döviz'],
  ];
  const tables = detectTables(grid);
  assert.equal(tables.length, 1, 'the wider note block was offered as a second table');
  assert.deepEqual(tables[0].columns, ['Tarih', 'kur']);
});

test('a section heading alone on its row marks the block a footer', () => {
  const grid: Cell[][] = [
    ['Date', 'v'],
    ['2020', 1],
    ['2021', 2],
    [],
    ['Notlar'],
    ['TP.DK.USD', 'Veri Kaynağı', 'TCMB'],
  ];
  assert.equal(detectTables(grid).length, 1);
});

test('a block that describes the table above it is a footer, however big', () => {
  const grid: Cell[][] = [
    ['Date', 'cpi', 'gdp'],
    ['2020', 1, 5],
    ['2021', 2, 6],
    [],
    ['Definition', 'Meaning', 'Unit'],
    ['cpi', 'consumer prices', 'index'],
    ['gdp', 'output', 'TRY'],
  ];
  const tables = detectTables(grid);
  assert.equal(tables.length, 1, 'the definitions block was offered as a table');
});

test('label folding is accent, case and trailing-colon insensitive', () => {
  assert.equal(foldLabel('Açıklama:'), 'aciklama');
  assert.equal(foldLabel('SIKLIK'), 'siklik');
  assert.equal(foldLabel(' Kaynak '), 'kaynak');
});

test('the BIS/SDMX code form is matched, and only in upper case', () => {
  const upper: Cell[][] = [['FREQ: M'], ['UNIT: index']];
  assert.equal(looksLikeFooter(upper, wholeGrid(upper), false), true);
  const lower: Cell[][] = [['freq: m'], ['unit: index']];
  assert.equal(
    looksLikeFooter(lower, wholeGrid(lower), false),
    false,
    'lower-cased values must not match; this is why nothing lowercases before the test'
  );
});

/* ------------------------------------------------------- continuation merge */

test('a stray blank row through one table does not make two', () => {
  const grid: Cell[][] = [
    ['Date', 'v'],
    ['2020', 1],
    [],
    ['2021', 2],
    ['2022', 3],
  ];
  const tables = detectTables(grid);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].rowCount, 3);
  assert.equal(tables[0].region.bottom, 5);
});

test('a repeated header continues the table rather than starting one', () => {
  const grid: Cell[][] = [
    ['Date', 'v'],
    ['2020', 1],
    [],
    ['Date', 'v'],
    ['2021', 2],
  ];
  const tables = detectTables(grid);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].rowCount, 2, 'the repeated header row was counted as data');
});

test('a different header below a blank row IS a second table', () => {
  const grid: Cell[][] = [
    ['Date', 'cpi'],
    ['2020', 1],
    [],
    ['Date', 'gdp'],
    ['2020', 5],
  ];
  const tables = detectTables(grid);
  assert.equal(tables.length, 2);
  assert.deepEqual(tables[1].columns, ['Date', 'gdp']);
});

/* --------------------------------------------------------------- size gate */

test('a header plus one observation is a table', () => {
  const grid: Cell[][] = [
    ['Date', 'v'],
    ['2020', 1],
  ];
  assert.equal(detectTables(grid).length, 1);
});

test('a one-column block is not a table', () => {
  const grid: Cell[][] = [['Date'], ['2020'], ['2021']];
  assert.equal(detectTables(grid).length, 0);
});

/* ------------------------------------------------------------------ basics */

test('an empty sheet yields nothing and does not throw', () => {
  assert.deepEqual(detectTables([]), []);
  assert.deepEqual(detectTables([[], [null, null]]), []);
});

test('detection does not mutate the grid it is given', () => {
  const grid: Cell[][] = [
    ['Date', 'v'],
    ['2020', 1],
  ];
  const before = JSON.stringify(grid);
  detectTables(grid);
  assert.equal(JSON.stringify(grid), before);
});

test('regions are trimmed to the cells they actually hold', () => {
  const grid: Cell[][] = [
    [null, null, null],
    [null, 'Date', 'v'],
    [null, '2020', 1],
  ];
  const regions = splitRegions(grid, wholeGrid(grid));
  assert.deepEqual(regions, [{ top: 1, bottom: 3, left: 1, right: 3 }]);
});

test('a header with a blank cell keeps a placeholder so the width still matches', () => {
  const grid: Cell[][] = [
    ['Date', null, 'v'],
    ['2020', 1, 2],
    ['2021', 3, 4],
  ];
  const tables = detectTables(grid);
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].columns, ['Date', '_col1', 'v']);
});

test('repeated captions are suffixed rather than dropped', () => {
  assert.deepEqual(dedupe(['a', 'a', 'b', 'a']), ['a', 'a_1', 'b', 'a_2']);
});

test('column letters are bijective base-26', () => {
  assert.equal(columnLetters(0), 'A');
  assert.equal(columnLetters(25), 'Z');
  assert.equal(columnLetters(26), 'AA');
  assert.equal(columnLetters(701), 'ZZ');
});

test('a table with no header at all is named by its Excel column letters', () => {
  const grid: Cell[][] = [
    [null, 1, 2],
    [null, 3, 4],
    [null, 5, 6],
  ];
  const tables = detectTables(grid);
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].columns, ['B', 'C']);
  assert.equal(tables[0].headerRow, null);
});
