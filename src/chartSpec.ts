/**
 * Deciding what, if anything, a result can be charted against.
 *
 * Kept apart from the webviews so it is testable: everything here is a pure
 * function over the column names and type kinds a query already returns, with
 * no DOM, no vscode and no ECharts. The rendering is the easy half; choosing
 * the axis -- and knowing when NOT to offer a chart -- is where this gets a
 * result wrong.
 */

export type StatsKind = 'numeric' | 'datetime' | 'other';

/**
 * What the x column is made of, which is NOT the same question as what the
 * axis will be.
 *
 * `datetime` is a real DATE/TIMESTAMP and always draws a time axis.  `text`
 * is a column that merely claims to be one by its name, and whether it can be
 * a time axis depends on what the strings actually parse to -- a question only
 * the database can answer, so it is settled host-side at chart time (see
 * runChartQuery) rather than guessed here.
 */
export type XAxisKind = 'datetime' | 'text';

export interface XAxis {
  column: string;
  kind: XAxisKind;
}

/**
 * The column names a text x axis is allowed to come from, lowercased.
 *
 * This list is the whole reason a text column can be an axis at all, and it
 * is deliberately tiny. Plotting numbers against arbitrary text draws the
 * order the table happens to hold its rows in, dressed up as a chart -- so a
 * text column has to *say* it is the axis before it is treated as one.
 *
 * `sheet_metadata` is the case that makes this concrete: its first column is
 * text and its last is a count, and under a looser rule every macro and ETL
 * export in existence would offer to plot row counts against table names.
 *
 * The two names are the ones ETL and macro_project actually write, and the
 * same two the R scripts accept -- helpers_core.R's .resolve_date_col checks
 * "Datetime" then "Date" and nothing else.
 */
const TEXT_AXIS_NAMES = ['datetime', 'date'];

/**
 * The x axis for this result, or undefined if it has not got one.
 *
 * Resolution order, and the reason for it:
 *
 *   1. The first DATE/TIMESTAMP column. macro_project writes native dates
 *      (rformat.normalise_dates), so this is the path its files take. Where a
 *      table has two -- a period and a revision stamp, say -- the first wins,
 *      which is the writer's own ordering.
 *   2. A text column NAMED as a date. **ETL writes every date column as
 *      VARCHAR holding ISO text**, always, in every output format: _dt_to_iso
 *      plus `pl.Series(..., dtype=pl.Utf8)`, with no setting that changes it.
 *      A type-only rule therefore finds an axis in macro files and never in
 *      ETL ones, which is the bug this ordering exists to fix.
 *
 * Anything else has no axis and gets no chart.
 */
export function pickXAxis(columns: string[], kinds: StatsKind[]): XAxis | undefined {
  if (columns.length !== kinds.length) return undefined;

  const nativeIndex = kinds.indexOf('datetime');
  if (nativeIndex >= 0) return { column: columns[nativeIndex], kind: 'datetime' };

  // "Datetime" before "Date" regardless of position, matching
  // helpers_core.R's .resolve_date_col rather than merely resembling it.
  for (const wanted of TEXT_AXIS_NAMES) {
    const i = columns.findIndex(
      (name, idx) => kinds[idx] === 'other' && name.trim().toLowerCase() === wanted
    );
    if (i >= 0) return { column: columns[i], kind: 'text' };
  }
  return undefined;
}

/**
 * The columns worth offering a plot button on: every numeric one, provided
 * the result has an axis to plot it against.
 *
 * One button per column rather than one for the table. A wide ETL table like
 * Raw_Data has 40-odd numeric columns and "plot all of them" was never the
 * useful reading -- 40 series sharing one linear axis is a picture of the
 * largest one and a flat line for everything else.
 */
export function plottableColumns(columns: string[], kinds: StatsKind[]): string[] {
  if (pickXAxis(columns, kinds) === undefined) return [];
  return columns.filter((_, i) => kinds[i] === 'numeric');
}

/**
 * Rows as ECharts wants them for a time axis: [x, y] pairs, x as epoch
 * milliseconds, y as a number or null.
 *
 * `null` rather than a dropped point, because a gap in a series is a fact
 * about the data. ECharts draws a break there unless connectNulls says
 * otherwise, which is the honest default -- silently joining across a
 * three-year hole draws a line nobody measured.
 *
 * Values that are neither a number nor a date come back null rather than
 * NaN: NaN survives JSON.stringify as `null` anyway, and ECharts treats a
 * NaN as a gap, so making it explicit here keeps the two ends agreeing.
 */
export function toSeriesPoints(xs: unknown[], ys: unknown[]): [number, number | null][] {
  const points: [number, number | null][] = [];
  for (let i = 0; i < xs.length; i += 1) {
    const at = toEpochMs(xs[i]);
    if (at === undefined) continue;
    points.push([at, toFiniteNumber(ys[i])]);
  }
  return points;
}

/**
 * Values for a category axis: the y column alone, positionally aligned with
 * the labels, with the same null-is-a-gap rule as above.
 *
 * No pairing with x here, because on a category axis the position IS the
 * index -- which is exactly why a category axis is only ever drawn over
 * labels the writer named as an axis, and why the rows are left in the
 * table's own order rather than sorted into one that would imply a sequence.
 */
export function toCategoryValues(ys: unknown[]): (number | null)[] {
  return ys.map(toFiniteNumber);
}

/** Which mark the chart draws its series with. Toggled from the chart tab. */
export type ChartMode = 'line' | 'scatter';

/** Line width -- `linewidth * 2` (0.7 * 2) in long_run_3.R's ECharts branch. */
const LINE_WIDTH = 1.4;

/**
 * Point size -- `point_size * 4` (1.8 * 4) in the `raw_type == "scatter"` branch
 * of long_run_3.R. Ported rather than chosen, like every other number in this
 * file: the R script has had this exact toggle all along, and the two draw the
 * same series with the same mark at the same size.
 */
const SCATTER_SYMBOL_SIZE = 7.2;

/** The per-series style fields that differ between the two marks. */
export interface SeriesShape {
  type: ChartMode;
  itemStyle: { color: string };
  showSymbol?: boolean;
  symbolSize?: number;
  lineStyle?: { color: string; width: number };
}

/**
 * The mark for one series, as plain data -- this module stays ECharts-free so
 * the numbers in it can be pinned by tests.
 *
 * Both branches are ports, from the `raw_type == "line"` and
 * `raw_type == "scatter"` arms of long_run_3.R: line with `symbol = "none"` and
 * a 1.4 stroke, scatter with a 7.2 circle and the colour moved from lineStyle
 * to itemStyle. The `large`/`progressive` settings the R traces also carry are
 * the same for both marks, so chartView.ts keeps them rather than repeating
 * them here.
 *
 * A scatter carries NO lineStyle at all rather than a zero-width one: the two
 * look identical until something merges a width back in, and "a scatter with a
 * hairline through it" is the failure this shape exists to make impossible.
 * Both marks take the same colour, so toggling changes the mark and nothing
 * else about how the series reads.
 */
export function seriesShape(mode: ChartMode, colour: string): SeriesShape {
  if (mode === 'scatter') {
    return { type: 'scatter', symbolSize: SCATTER_SYMBOL_SIZE, itemStyle: { color: colour } };
  }
  return {
    type: 'line',
    // The line IS the mark here, so the points themselves stay unmarked --
    // symbols on a 60-year daily series draw a smear, not a series.
    showSymbol: false,
    lineStyle: { color: colour, width: LINE_WIDTH },
    itemStyle: { color: colour },
  };
}

/**
 * Axis padding and tick placement, ported from the R plotting helpers so that
 * a series charted here and the same series charted by long_run_3.R are the
 * same figure rather than two charts of the same numbers.
 *
 * The originals live in the Kod repo, at
 * R/Time_Series_Plotting/helpers/helpers_core.R: compute_echarts_x_range,
 * compute_echarts_y_range and get_forced_breaks. They are pinned by tests here
 * BECAUSE they are a port -- two codebases in two languages in two repos drift
 * silently otherwise, and the drift shows up as "why does this look different"
 * rather than as a failure.
 */
export interface Extent {
  lo: number;
  hi: number;
}

/** Smallest and largest finite value, ignoring gaps. */
export function finiteExtent(values: (number | null | undefined)[]): Extent | undefined {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return Number.isFinite(lo) ? { lo, hi } : undefined;
}

/**
 * Time axis range: 2% of the span before the first point, 4% after the last
 * (compute_echarts_x_range). The asymmetry is deliberate over there -- the
 * right-hand end is where the eye goes on a time series, and a line that ends
 * flush against the axis reads as a series that was cut off.
 */
export function padTimeRange(extent: Extent): { min: number; max: number } {
  const span = extent.hi - extent.lo;
  return { min: extent.lo - span * 0.02, max: extent.hi + span * 0.04 };
}

/**
 * Value axis range: 3% of the span either side, or -- when every value is the
 * same and there is no span to take a share of -- 5% of the value itself, and
 * 0.5 at zero (compute_echarts_y_range).
 */
export function padValueRange(extent: Extent): { min: number; max: number } {
  const pad =
    extent.hi === extent.lo
      ? extent.lo === 0
        ? 0.5
        : Math.abs(extent.lo) * 0.05
      : (extent.hi - extent.lo) * 0.03;
  return { min: extent.lo - pad, max: extent.hi + pad };
}

/**
 * `count` tick values from lo to hi inclusive -- get_forced_breaks with no
 * forced values, which is every chart this viewer draws (forced breaks exist
 * over there to pin a tick onto an hline or onto zero, and neither is
 * something a click on a column header can ask for).
 *
 * Note these come from the UNPADDED extent while the axis range above is
 * padded, so the outermost ticks sit just inside the axis ends. That is the R
 * behaviour, and its helper says so explicitly rather than by accident.
 */
export function evenBreaks(lo: number, hi: number, count: number): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || count < 2) return [lo];
  if (hi === lo) return [lo];
  const step = (hi - lo) / (count - 1);
  const breaks: number[] = [];
  for (let i = 0; i < count; i += 1) breaks.push(lo + step * i);
  breaks[count - 1] = hi;
  return breaks;
}

/**
 * Frequency-aware date labels -- optional, never required.
 *
 * ETL and macro_project both write a `frequency` into `sheet_metadata`, and
 * the R scripts use it to word an axis as "2020 Q1" rather than "1 Jan 2020"
 * (make_label_fn in helpers_core.R for ticks, build_tooltip_formatter's
 * qLabel in helpers_echarts.R for the hover). A file that carries no
 * frequency, or a word not in this list, falls back to the plain date form
 * below and charts exactly as it did before: the frequency is a nicety about
 * wording, and nothing about drawing a series depends on having one.
 *
 * The vocabulary is fixed rather than free text because these labels come
 * from a file and end up in tooltip HTML.
 */
export const KNOWN_FREQUENCIES = [
  'annual',
  'semiannual',
  'quarterly',
  'monthly',
  'weekly',
  'daily',
] as const;

export type SeriesFrequency = (typeof KNOWN_FREQUENCIES)[number];

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Everything below reads the date in UTC, because that is the axis the points
 * were placed on: toEpochMs turns a DATE into midnight UTC, and rendering it
 * in a local timezone west of Greenwich would label it as the day before.
 */
function parts(ms: number): { d: Date; year: number; month: number } | undefined {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return undefined;
  return { d, year: d.getUTCFullYear(), month: d.getUTCMonth() };
}

/** Week of the year the way make_label_fn counts it: whole weeks since 1 January. */
function weekOfYear(d: Date): number {
  const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.floor((d.getTime() - jan1) / (7 * 24 * 60 * 60 * 1000)) + 1;
}

/** An x-axis tick label -- make_label_fn's wording. Undefined frequency means "let ECharts label it". */
export function axisDateLabel(ms: number, frequency?: SeriesFrequency): string | undefined {
  if (!frequency) return undefined;
  const p = parts(ms);
  if (!p) return undefined;
  switch (frequency) {
    case 'annual':
      return String(p.year);
    case 'semiannual':
      return `${p.year} H${p.month < 6 ? 1 : 2}`;
    case 'quarterly':
      return `${p.year} Q${Math.floor(p.month / 3) + 1}`;
    case 'monthly':
      return `${MONTHS[p.month]} ${p.year}`;
    case 'weekly':
      return `${p.year} W${weekOfYear(p.d)}`;
    case 'daily':
      return `${p.d.getUTCDate()} ${MONTHS[p.month]} ${p.year}`;
  }
}

/**
 * A tooltip's date header -- qLabel's wording, which differs from the axis on
 * purpose for weekly (a week's tooltip names the day it starts, where the tick
 * names the week number).
 *
 * With no frequency this is the daily form plus a clock time when the point
 * carries one, which is the same fallback the R formatter uses for a cadence
 * it does not recognise.
 */
export function pointDateLabel(ms: number, frequency?: SeriesFrequency): string {
  const p = parts(ms);
  if (!p) return '';
  const day = `${p.d.getUTCDate()} ${MONTHS[p.month]} ${p.year}`;
  if (frequency === 'weekly') return day;
  if (frequency) return axisDateLabel(ms, frequency) ?? day;
  const h = p.d.getUTCHours();
  const m = p.d.getUTCMinutes();
  const s = p.d.getUTCSeconds();
  if (h === 0 && m === 0 && s === 0) return day;
  return `${day} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Category-axis labels, as stored. Nothing is reformatted: "1996-1Q" is shown as "1996-1Q". */
export function toCategoryLabels(xs: unknown[]): string[] {
  return xs.map((v) => (v === null || v === undefined ? '' : String(v)));
}

/**
 * A DuckDB value on the x axis, as epoch milliseconds.
 *
 * DATE and TIMESTAMP arrive as JS Date objects, but a value that crossed a
 * webview postMessage boundary has been through structured cloning or JSON
 * and may be an ISO string instead, so both are accepted. Anything
 * unparseable returns undefined and its row is dropped -- a point with no
 * position on the axis cannot be drawn anywhere truthful.
 */
export function toEpochMs(value: unknown): number | undefined {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  // DuckDB DECIMAL and HUGEINT can arrive as strings rather than numbers.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
