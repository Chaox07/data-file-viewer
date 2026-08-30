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
