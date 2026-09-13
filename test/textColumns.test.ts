import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DuckDBInstance } from '@duckdb/node-api';

import {
  EXCEL_ERROR_TOKENS,
  classifyTextColumn,
  isExcelError,
  markerBlankExpr,
  markerCountExpr,
  markerNullExpr,
  markerResidueExpr,
  nonMarkerCountExpr,
} from '../src/textColumns';

// ---------------------------------------------------------------------------
// The token set, ported from ETL's _EXCEL_ERRORS
// ---------------------------------------------------------------------------

test('the token list is ETL\'s _EXCEL_ERRORS, unchanged', () => {
  // Pinned deliberately. The two lists are meant to be diffable by eye, and a
  // token quietly added on one side is exactly the drift this catches.
  assert.deepEqual([...EXCEL_ERROR_TOKENS].sort(), [
    '#DIV/0!',
    '#N/A',
    '#NAME?',
    '#NULL!',
    '#NUM!',
    '#REF!',
    '#VALUE!',
    'N/A',
    'NA',
  ]);
});

test('markers are matched trimmed and case-insensitively, like _is_excel_error_string', () => {
  for (const t of EXCEL_ERROR_TOKENS) assert.equal(isExcelError(t), true, t);
  assert.equal(isExcelError('  #N/A  '), true);
  assert.equal(isExcelError('#n/a'), true);
  assert.equal(isExcelError('na'), true);
});

test('a blank, a number and a real word are not markers', () => {
  assert.equal(isExcelError(''), false);
  assert.equal(isExcelError('   '), false);
  assert.equal(isExcelError(null), false);
  assert.equal(isExcelError(undefined), false);
  assert.equal(isExcelError('1.5'), false);
  // "NAME" contains "NA" and must not match on a prefix.
  assert.equal(isExcelError('NAME'), false);
  assert.equal(isExcelError('Namibia'), false);
});

test('the token list is a parameter, so [] turns the whole thing off', () => {
  assert.equal(isExcelError('#N/A', []), false);
  assert.equal(isExcelError('MISSING', ['missing']), true);
});

// ---------------------------------------------------------------------------
// classifyTextColumn — the refusal contract
// ---------------------------------------------------------------------------

test('a numeric column with markers in it is numeric, and the markers are counted', () => {
  const v = classifyTextColumn(['1.5', 'NA', '2.5', '#N/A', '3.5']);
  assert.equal(v.kind, 'numeric');
  if (v.kind !== 'numeric') return;
  assert.equal(v.locale, 'en');
  assert.equal(v.markers, 2);
  assert.equal(v.values, 3);
});

test('one value that is neither a marker nor a number refuses the whole column', () => {
  // The 85% threshold decideColumn uses would have absorbed this as NULL. Here
  // that is exactly the silent loss the module exists to prevent: nulled, it
  // would be indistinguishable from the markers we nulled on purpose.
  const v = classifyTextColumn(['1.5', 'NA', '2.5', 'under review', '3.5']);
  assert.equal(v.kind, 'text');
  if (v.kind !== 'text') return;
  assert.equal(v.reason, 'residue');
  assert.deepEqual(v.residue, ['under review']);
});

test('a column of nothing but markers says so rather than claiming a type', () => {
  const v = classifyTextColumn(['NA', '#N/A', '  ', 'NA']);
  assert.equal(v.kind, 'markers-only');
  if (v.kind !== 'markers-only') return;
  assert.equal(v.markers, 3);
});

test('an empty column is neither numeric nor markers-only', () => {
  assert.equal(classifyTextColumn([null, '', '   ']).kind, 'text');
  assert.equal(classifyTextColumn([]).kind, 'text');
});

test('a Turkish column with markers converts under the European reading', () => {
  const v = classifyTextColumn(['1.794.446,52', 'NA', '2.345,67', '#N/A', '12,5']);
  assert.equal(v.kind, 'numeric');
  if (v.kind !== 'numeric') return;
  assert.equal(v.locale, 'eu');
  assert.equal(v.markers, 2);
});

test('an English column with markers is not dragged into the European reading', () => {
  const v = classifyTextColumn(['1,234.56', 'NA', '2,345.67', '99.5']);
  assert.equal(v.kind, 'numeric');
  if (v.kind !== 'numeric') return;
  assert.equal(v.locale, 'en');
});

test('a column that cannot decide its convention keeps its text, markers and all', () => {
  // W1's refusal, reached through this module: 1.234 is 1234 read as Turkish
  // and 1.234 read as English, and nothing in the column breaks the tie.
  const v = classifyTextColumn(['1.234', 'NA', '2.345', '3.456']);
  assert.equal(v.kind, 'text');
  if (v.kind !== 'text') return;
  assert.equal(v.reason, 'undecidable');
  assert.ok(v.residue.length > 0, 'the notice needs the values that caused it');
});

test('with no tokens, a marker is just another word and refuses the column', () => {
  const v = classifyTextColumn(['1.5', 'NA', '2.5'], []);
  assert.equal(v.kind, 'text');
  if (v.kind !== 'text') return;
  assert.deepEqual(v.residue, ['NA']);
});

// ---------------------------------------------------------------------------
// The SQL, run against the engine the extension actually bundles
// ---------------------------------------------------------------------------

async function scratch() {
  const instance = await DuckDBInstance.create(':memory:');
  return instance.connect();
}

async function column(sql: string): Promise<unknown[]> {
  const con = await scratch();
  const reader = await con.runAndReadAll(sql);
  return reader.getRows().map((r) => r[0]);
}

test('markerNullExpr nulls the markers and reads the numbers, under en', async () => {
  const values = await column(
    `select ${markerNullExpr('v', 'en', 'double')} from (values ('1.5'), ('NA'), ('1,234.56'), ('#n/a'), (' 2.5 ')) t(v)`
  );
  assert.deepEqual(values, [1.5, null, 1234.56, null, 2.5]);
});

test('markerNullExpr reads Turkish numbers the way parseEu does', async () => {
  const values = await column(
    `select ${markerNullExpr('v', 'eu', 'double')} from (values ('1.794.446,52'), ('NA'), ('12,5')) t(v)`
  );
  assert.deepEqual(values, [1794446.52, null, 12.5]);
});

test('markerResidueExpr finds the value a conversion would have swallowed', async () => {
  const rows = `(values ('1.5'), ('NA'), ('under review'), ('2.5')) t(v)`;
  const con = await scratch();
  const reader = await con.runAndReadAll(
    `select ${markerCountExpr('v')}, ${markerResidueExpr('v', 'en')}, ${nonMarkerCountExpr('v')} from ${rows}`
  );
  const [markers, residue, nonMarkers] = (reader.getRows()[0] as unknown[]).map(Number);
  assert.equal(markers, 1);
  assert.equal(residue, 1, '"under review" must be seen, not counted as a marker');
  assert.equal(nonMarkers, 3);
});

test('a clean column has no residue, which is what lets it convert', async () => {
  const con = await scratch();
  const reader = await con.runAndReadAll(
    `select ${markerResidueExpr('v', 'en')} from (values ('1.5'), ('NA'), ('2.5'), (null), ('')) t(v)`
  );
  assert.equal(Number((reader.getRows()[0] as unknown[])[0]), 0);
});

test('markerBlankExpr empties the markers without inventing a type', async () => {
  const values = await column(
    `select ${markerBlankExpr('v')} from (values ('NA'), ('#REF!'), ('kept')) t(v)`
  );
  assert.deepEqual(values, [null, null, 'kept']);
});

test('a column name with a quote in it does not break out of its identifier', async () => {
  const values = await column(
    `select ${markerNullExpr('od"d', 'en', 'double')} from (values ('1.5'), ('NA')) t("od""d")`
  );
  assert.deepEqual(values, [1.5, null]);
});

test('a token with a quote in it does not break out of its literal', async () => {
  const values = await column(
    `select ${markerNullExpr('v', 'en', 'double', ["it's missing"])} from (values ('1.5'), ('it''s missing')) t(v)`
  );
  assert.deepEqual(values, [1.5, null]);
});
