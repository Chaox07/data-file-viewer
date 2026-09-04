import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  pickXAxis,
  plottableColumns,
  toSeriesPoints,
  toCategoryLabels,
  toCategoryValues,
  toEpochMs,
  finiteExtent,
  padTimeRange,
  padValueRange,
  evenBreaks,
  axisDateLabel,
  pointDateLabel,
  seriesShape,
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

// --------------------------------------------------- ported from the R helpers
// These pin numbers that exist in two languages in two repos: the originals are
// compute_echarts_x_range, compute_echarts_y_range and get_forced_breaks in
// Kod/R/Time_Series_Plotting/helpers/helpers_core.R. A test is the only thing
// that makes a divergence between them announce itself.

test('the time axis is padded 2% before and 4% after', () => {
  // Asymmetric on purpose over there: a line ending flush against the right
  // edge reads as a series that was cut off.
  assert.deepEqual(padTimeRange({ lo: 0, hi: 100 }), { min: -2, max: 104 });
});

test('the value axis is padded 3% either side', () => {
  assert.deepEqual(padValueRange({ lo: 0, hi: 100 }), { min: -3, max: 103 });
});

test('a flat series is padded by 5% of its value, not by 3% of nothing', () => {
  // Without this the axis collapses onto a single line with the series on it.
  assert.deepEqual(padValueRange({ lo: 200, hi: 200 }), { min: 190, max: 210 });
});

test('a flat series at zero is padded by 0.5', () => {
  // 5% of zero is zero, which is the case the R helper spells out separately.
  assert.deepEqual(padValueRange({ lo: 0, hi: 0 }), { min: -0.5, max: 0.5 });
});

test('eight ticks span the extent inclusive', () => {
  assert.deepEqual(evenBreaks(0, 70, 8), [0, 10, 20, 30, 40, 50, 60, 70]);
});

test('the last tick is exactly the maximum, not a float drifted off it', () => {
  // Accumulated addition would land on 0.30000000000000004 and label it.
  const breaks = evenBreaks(0, 0.3, 4);
  assert.equal(breaks[breaks.length - 1], 0.3);
});

test('a flat extent gets one tick rather than eight of the same number', () => {
  assert.deepEqual(evenBreaks(5, 5, 8), [5]);
});

test('the extent ignores gaps and unparseable values', () => {
  assert.deepEqual(finiteExtent([3, null, 1, undefined, 9, NaN]), { lo: 1, hi: 9 });
});

test('an all-gap series has no extent, rather than an infinite one', () => {
  // Infinity/-Infinity would reach the axis as min/max and draw nothing.
  assert.equal(finiteExtent([null, undefined, NaN]), undefined);
});

// -------------------------------------------------- frequency-aware wording
// Optional everywhere: a file that declares no frequency still charts, with
// plain dates. These pin the wording against make_label_fn (ticks) and
// qLabel (tooltip) in the R helpers.

const Q1 = Date.UTC(2020, 0, 15);

test('no frequency means no axis label of our own -- ECharts labels the tick', () => {
  assert.equal(axisDateLabel(Q1, undefined), undefined);
});

test('a quarterly axis reads as a quarter', () => {
  assert.equal(axisDateLabel(Date.UTC(2020, 7, 1), 'quarterly'), '2020 Q3');
});

test('a semiannual axis reads as a half', () => {
  assert.equal(axisDateLabel(Date.UTC(2020, 5, 30), 'semiannual'), '2020 H1');
  assert.equal(axisDateLabel(Date.UTC(2020, 6, 1), 'semiannual'), '2020 H2');
});

test('monthly and annual axes drop the parts they do not resolve', () => {
  assert.equal(axisDateLabel(Q1, 'monthly'), 'Jan 2020');
  assert.equal(axisDateLabel(Q1, 'annual'), '2020');
});

test('a weekly axis counts whole weeks from 1 January, as make_label_fn does', () => {
  assert.equal(axisDateLabel(Date.UTC(2020, 0, 1), 'weekly'), '2020 W1');
  assert.equal(axisDateLabel(Date.UTC(2020, 0, 8), 'weekly'), '2020 W2');
});

test('a weekly tooltip names the day, where the tick names the week', () => {
  // Deliberate difference, and qLabel has the same one: a week number is
  // useful on a crowded axis and useless when you are pointing at a value.
  assert.equal(pointDateLabel(Date.UTC(2020, 0, 8), 'weekly'), '8 Jan 2020');
});

test('with no frequency a tooltip shows the plain date', () => {
  assert.equal(pointDateLabel(Q1, undefined), '15 Jan 2020');
});

test('a time of day is kept, so an intraday point is not labelled as a whole day', () => {
  assert.equal(pointDateLabel(Date.UTC(2020, 0, 15, 9, 30), undefined), '15 Jan 2020 09:30');
});

test('dates are read in UTC, not in the viewer timezone', () => {
  // Midnight UTC is the previous evening in the Americas; a local read would
  // label a DATE as the day before it.
  assert.equal(pointDateLabel(Date.UTC(2020, 0, 1), undefined), '1 Jan 2020');
});

test('an unparseable instant labels as empty rather than "Invalid Date"', () => {
  assert.equal(pointDateLabel(Number.NaN, undefined), '');
});

// ------------------------------------------------------ the mark, either way
// Also ported: the two arms of `raw_type` in
// Kod/R/Time_Series_Plotting/long_run_3.R, which has had this line/scatter
// switch all along. 1.4 is `linewidth * 2` there and 7.2 is `point_size * 4`.

test('a line is drawn at 1.4 with no symbols on its points', () => {
  assert.deepEqual(seriesShape('line', '#000080'), {
    type: 'line',
    showSymbol: false,
    connectNulls: true,
    lineStyle: { color: '#000080', width: 1.4 },
    itemStyle: { color: '#000080' },
  });
});

test('a line bridges gaps, because long_run_3.R does', () => {
  // The one place the two implementations deliberately disagreed. R sets
  // connectNulls = TRUE on every line trace, for a reason its comment records
  // as verified against a real chart: thousands of single-point gaps fragment
  // the line into segments ECharts then fails to re-render after a zoom-in and
  // reset. used_YieldCurve's "2&1" is null in 3,879 of its 12,406 rows, so
  // this is the difference between one line and thousands of fragments.
  assert.equal(seriesShape('line', '#000080').connectNulls, true);
  // A scatter has no line to bridge anything with.
  assert.equal('connectNulls' in seriesShape('scatter', '#000080'), false);
});

test('a scatter is drawn as 7.2 points and carries no line at all', () => {
  // Not even a zero-width one: the two look identical until something merges a
  // width back in, and a scatter with a hairline through it is not a scatter.
  const shape = seriesShape('scatter', '#000080');
  assert.deepEqual(shape, {
    type: 'scatter',
    symbolSize: 7.2,
    itemStyle: { color: '#000080' },
  });
  assert.equal('lineStyle' in shape, false);
});

test('both marks take the colour they are given, so toggling changes only the mark', () => {
  const colour = '#b0532a';
  assert.equal(seriesShape('line', colour).lineStyle?.color, colour);
  assert.equal(seriesShape('scatter', colour).itemStyle.color, colour);
  assert.equal(seriesShape('line', colour).itemStyle.color, colour);
});
