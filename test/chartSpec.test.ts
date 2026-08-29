import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pickTimeSeries, isSingleSeries, toSeriesPoints, toEpochMs } from '../src/chartSpec';

// ------------------------------------------------------------ picking axes

test('a date column and a numeric column are a time series', () => {
  assert.deepEqual(
    pickTimeSeries(['Date', 'Rate'], ['datetime', 'numeric']),
    { x: 'Date', y: ['Rate'] }
  );
});

test('every numeric column goes on the y axis, in result order', () => {
  assert.deepEqual(
    pickTimeSeries(['Date', 'B', 'A'], ['datetime', 'numeric', 'numeric']),
    { x: 'Date', y: ['B', 'A'] }
  );
});

test('text columns are ignored rather than plotted', () => {
  assert.deepEqual(
    pickTimeSeries(['Date', 'Rate', 'Note'], ['datetime', 'numeric', 'other']),
    { x: 'Date', y: ['Rate'] }
  );
});

test('the first date column wins when a table has two', () => {
  // A period column and a revision stamp, say. The writer's own order decides,
  // which is the same rule the R scripts' .resolve_date_col follows.
  const spec = pickTimeSeries(['Period', 'Revised', 'Rate'], ['datetime', 'datetime', 'numeric']);
  assert.equal(spec?.x, 'Period');
});

test('a table with no date column is not chartable', () => {
  // This is the one that matters. Plotting numbers against their row position
  // draws the storage order and looks exactly like a real chart.
  assert.equal(pickTimeSeries(['A', 'B'], ['numeric', 'numeric']), undefined);
});

test('a date column with nothing numeric beside it is not chartable', () => {
  assert.equal(pickTimeSeries(['Date', 'Note'], ['datetime', 'other']), undefined);
});

test('sheet_metadata is not chartable', () => {
  // All text plus a couple of counts, and no date column: the auxiliary table
  // sitting beside every macro export must never be mistaken for a series.
  assert.equal(
    pickTimeSeries(['table_name', 'source', 'n_obs'], ['other', 'other', 'numeric']),
    undefined
  );
});

test('mismatched columns and kinds produce nothing rather than guessing', () => {
  assert.equal(pickTimeSeries(['Date', 'Rate'], ['datetime']), undefined);
});

// -------------------------------------------------- the auto-open condition

test('exactly one date and one number is a single series', () => {
  assert.equal(isSingleSeries(['Date', 'Rate'], ['datetime', 'numeric']), true);
});

test('two numeric columns are NOT a single series', () => {
  // Chartable, but which scale? That is a decision, and it belongs to whoever
  // clicks the button rather than to the file opening.
  assert.equal(isSingleSeries(['Date', 'A', 'B'], ['datetime', 'numeric', 'numeric']), false);
});

test('a date, a number and a note are NOT a single series', () => {
  assert.equal(isSingleSeries(['Date', 'Rate', 'Note'], ['datetime', 'numeric', 'other']), false);
});

test('a two-column table with no date is not a single series', () => {
  assert.equal(isSingleSeries(['A', 'B'], ['numeric', 'numeric']), false);
});

// ----------------------------------------------------------- point building

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
