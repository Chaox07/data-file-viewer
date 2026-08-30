import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  pickXAxis,
  plottableColumns,
  toSeriesPoints,
  toCategoryLabels,
  toCategoryValues,
  toEpochMs,
} from '../src/chartSpec';

// ------------------------------------------------------------- picking an x

test('a native DATE column is the axis', () => {
  assert.deepEqual(pickXAxis(['Date', 'Rate'], ['datetime', 'numeric']), {
    column: 'Date',
    kind: 'datetime',
  });
});

test('the first native date column wins when a table has two', () => {
  // A period column and a revision stamp, say. The writer's own order decides.
  const x = pickXAxis(['Period', 'Revised', 'Rate'], ['datetime', 'datetime', 'numeric']);
  assert.equal(x?.column, 'Period');
});

test('a VARCHAR column NAMED Date is the axis — this is every ETL file', () => {
  // ETL writes dates as VARCHAR ISO text in every output format, so the type
  // says 'other' and the name is the only thing left to go on. Without this
  // branch the entire ETL toolchain is unchartable.
  assert.deepEqual(pickXAxis(['Date', 'SVENF01'], ['other', 'numeric']), {
    column: 'Date',
    kind: 'text',
  });
});

test('Datetime beats Date, matching helpers_core.R .resolve_date_col', () => {
  const x = pickXAxis(['Date', 'Datetime', 'Rate'], ['other', 'other', 'numeric']);
  assert.equal(x?.column, 'Datetime');
});

test('a native date beats a text column named Date', () => {
  const x = pickXAxis(['Date', 'Stamp', 'Rate'], ['other', 'datetime', 'numeric']);
  assert.deepEqual(x, { column: 'Stamp', kind: 'datetime' });
});

test('the name match ignores case and surrounding space', () => {
  assert.equal(pickXAxis([' DATE ', 'Rate'], ['other', 'numeric'])?.kind, 'text');
});

test('a text column NOT named as a date is never an axis', () => {
  // This is the rule that matters. Plotting numbers against arbitrary labels
  // draws the order the table happens to hold its rows in, dressed up as a
  // chart.
  assert.equal(pickXAxis(['Country', 'Rate'], ['other', 'numeric']), undefined);
});

test('sheet_metadata has no axis', () => {
  // Text columns plus a count. The auxiliary table sitting beside every macro
  // and ETL export must never offer to plot row counts against table names.
  assert.equal(
    pickXAxis(['table_name', 'source', 'n_obs'], ['other', 'other', 'numeric']),
    undefined
  );
});

test('a table with only numbers has no axis', () => {
  assert.equal(pickXAxis(['A', 'B'], ['numeric', 'numeric']), undefined);
});

test('mismatched columns and kinds produce nothing rather than guessing', () => {
  assert.equal(pickXAxis(['Date', 'Rate'], ['datetime']), undefined);
});

// ------------------------------------------------------------ plot buttons

test('every numeric column is plottable when there is an axis', () => {
  assert.deepEqual(
    plottableColumns(['Date', 'B', 'A', 'Note'], ['datetime', 'numeric', 'numeric', 'other']),
    ['B', 'A']
  );
});

test('no axis means no plottable columns, however many numbers there are', () => {
  assert.deepEqual(plottableColumns(['A', 'B'], ['numeric', 'numeric']), []);
});

test('the x column is never offered as its own y', () => {
  assert.deepEqual(plottableColumns(['Date', 'Rate'], ['datetime', 'numeric']), ['Rate']);
});

test('a date column with nothing numeric beside it offers no button', () => {
  assert.deepEqual(plottableColumns(['Date', 'Note'], ['datetime', 'other']), []);
});

// -------------------------------------------------- time-axis point building

test('dates become epoch milliseconds', () => {
  const points = toSeriesPoints([new Date('1982-01-01T00:00:00Z')], [2.5]);
  assert.deepEqual(points, [[Date.UTC(1982, 0, 1), 2.5]]);
});

test('ISO strings work too, because postMessage may not preserve a Date', () => {
  const points = toSeriesPoints(['1982-01-01T00:00:00Z'], [2.5]);
  assert.deepEqual(points, [[Date.UTC(1982, 0, 1), 2.5]]);
});

test('a missing value is a null point, not a dropped row', () => {
  // Dropping it would join the line straight across the gap, which draws a
  // segment nobody measured.
  const points = toSeriesPoints(
    [new Date('2020-01-01T00:00:00Z'), new Date('2020-02-01T00:00:00Z')],
    [1, null]
  );
  assert.equal(points.length, 2);
  assert.equal(points[1][1], null);
});

test('a row with an unusable x is dropped, since it has nowhere to go', () => {
  const points = toSeriesPoints([new Date('2020-01-01T00:00:00Z'), 'not a date'], [1, 2]);
  assert.equal(points.length, 1);
});

test('DECIMAL and HUGEINT arriving as strings still plot', () => {
  const points = toSeriesPoints([new Date('2020-01-01T00:00:00Z')], ['1234.5']);
  assert.equal(points[0][1], 1234.5);
});

test('bigint values plot', () => {
  const points = toSeriesPoints([new Date('2020-01-01T00:00:00Z')], [42n]);
  assert.equal(points[0][1], 42);
});

test('a non-numeric y is a gap rather than a crash', () => {
  const points = toSeriesPoints([new Date('2020-01-01T00:00:00Z')], [{ nested: true }]);
  assert.equal(points[0][1], null);
});

test('an invalid Date is refused', () => {
  assert.equal(toEpochMs(new Date('nonsense')), undefined);
});

// ------------------------------------------------------- category-axis rows

test('category labels are shown exactly as stored', () => {
  // The whole point of the category axis: "1996-1Q" is a label DuckDB could
  // not cast, and reformatting it would be inventing a reading of it.
  assert.deepEqual(toCategoryLabels(['1996-1Q', '1996-2Q']), ['1996-1Q', '1996-2Q']);
});

test('a null label renders as empty rather than the word null', () => {
  assert.deepEqual(toCategoryLabels([null, undefined]), ['', '']);
});

test('category values keep their positions, gaps included', () => {
  // Position IS the index on a category axis, so a dropped value would shift
  // every later point onto the wrong label.
  assert.deepEqual(toCategoryValues([1, null, '3.5', 'x']), [1, null, 3.5, null]);
});
