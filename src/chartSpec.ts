/**
 * Deciding what, if anything, a result can be charted as.
 *
 * Kept apart from webview.ts so it is testable: everything here is a pure
 * function over the column names and type kinds a query already returns, with
 * no DOM, no vscode and no ECharts. The rendering is the easy half; choosing
 * the axes -- and knowing when NOT to offer a chart -- is where this gets a
 * result wrong.
 */

export type StatsKind = 'numeric' | 'datetime' | 'other';

export interface TimeSeriesSpec {
  /** The column to put on the x axis. */
  x: string;
  /** Every numeric column, in result order. */
  y: string[];
}

/**
 * The time-series reading of a result, or undefined if it has not got one.
 *
 * A chart needs an ordered x and something to plot against it, so this asks
 * for one datetime column and at least one numeric column. The FIRST datetime
 * column wins: a table with two of them (a period and a revision stamp, say)
 * is plotted against the one that came first, which is the writer's own
 * ordering and the same rule the R scripts' .resolve_date_col() follows.
 *
 * Deliberately NOT falling back to "any column" for x. A line joining rows in
 * whatever order the table happens to hold them is a picture of the storage
 * order, not of the data, and it looks exactly like a real chart.
 */
export function pickTimeSeries(columns: string[], kinds: StatsKind[]): TimeSeriesSpec | undefined {
  if (columns.length !== kinds.length) return undefined;
  const x = columns.find((_, i) => kinds[i] === 'datetime');
  if (x === undefined) return undefined;
  const y = columns.filter((name, i) => kinds[i] === 'numeric' && name !== x);
  return y.length > 0 ? { x, y } : undefined;
}

/**
 * Whether this result is one series and nothing else -- exactly one datetime
 * column and exactly one numeric column, with no third column of any kind.
 *
 * This is the case worth opening a chart for without being asked: there is
 * only one thing the table can be a picture of, so the chart is not a guess.
 * Two numeric columns on a shared axis is a decision (which scale? which one
 * gets flattened?) and it should be made by whoever clicks the button.
 */
export function isSingleSeries(columns: string[], kinds: StatsKind[]): boolean {
  if (columns.length !== 2 || kinds.length !== 2) return false;
  const spec = pickTimeSeries(columns, kinds);
  return spec !== undefined && spec.y.length === 1;
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
