/**
 * The chart tab's script. Receives one message and draws it; that is all it
 * does, which is why it can be its own bundle and keep ECharts out of the
 * grid's.
 */

import {
  toSeriesPoints,
  toCategoryLabels,
  toCategoryValues,
  finiteExtent,
  padTimeRange,
  padValueRange,
  evenBreaks,
  axisDateLabel,
  pointDateLabel,
  seriesShape,
  type ChartMode,
  type SeriesFrequency,
} from './chartSpec';
// Modular import rather than `from 'echarts'`: the umbrella entry point
// registers every chart type and component and took a bundle from 468 KB to
// 1.5 MB. This registers the line chart and the components actually used
// below, and nothing else.
import * as echarts from 'echarts/core';
import { LineChart, ScatterChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomInsideComponent,
  BrushComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  LineChart,
  // The scatter the toolbar toggles to. A real series type rather than a line
  // with its width set to zero: the scatter renderer has its own large-mode
  // point painter, and a 200,000-point line asked to draw a symbol per point
  // instead draws 200,000 graphic elements.
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  // Inside only -- the slider one draws the strip along the bottom, which is
  // the thing being removed here. Dragging across the plot replaces it.
  DataZoomInsideComponent,
  BrushComponent,
  CanvasRenderer,
]);

interface VsCodeApi {
  postMessage(message: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

type ChartMessage =
  | {
      command: 'chart';
      xColumn: string;
      yColumns: string[];
      columns: string[];
      rows: unknown[][];
      xAxisMode: 'time' | 'category';
      // Absent whenever the file does not declare one, which is most files.
      // Wording only -- see chartSpec's KNOWN_FREQUENCIES.
      frequency?: SeriesFrequency | null;
      truncated: boolean;
      maxPoints: number;
    }
  | { command: 'chartError'; message: string };

// One navy, and it is the same navy the R plotting scripts use for a lone
// series. A single line needs a colour, not a palette; the extra entries only
// come into play when a query puts several numeric columns on one axis.
const SERIES_COLOURS = ['#000080', '#b0532a', '#2e7d5b', '#7a3d8f', '#a3872c', '#3c6ea5'];

// Stated, not read from --vscode-* variables: the chart page is white whatever
// the editor theme is, because a chart is a figure -- it gets screenshotted,
// pasted into a document and printed, and a dark-theme one arrives everywhere
// else as a negative of itself. Only this tab is white; the grid still follows
// the theme.
//
// The values are the ones helpers_echarts.R draws with, so a series opened
// here and the same series opened from long_run_3.R are one figure: black axis
// rules at 1.5, gridlines at rgb(229,229,229) hairline-width, serif labels at
// 10. MINOR_SPLIT_LINE is the one addition -- a lighter line between the
// labelled ones, for reading a level off the chart without hovering.
const INK = '#1f1f1f';
const AXIS_LINE = '#000000';
const SPLIT_LINE = '#e5e5e5';
const MINOR_SPLIT_LINE = '#f2f2f2';
const CHART_FONT = 'serif';

/** The x axis these charts always have exactly one of. */
const X_AXIS_INDEX = 0;

/** y ticks per axis -- `y_ticks` in long_run_3.R. */
const Y_TICKS = 8;

/**
 * Above this many points IN VIEW the tooltip switches itself off, and back on
 * once a zoom brings the count down -- `zoom_threshold` in long_run_3.R, and
 * the reason e_zoom_aware_detail exists over there. With thousands of points
 * overplotted into the same few pixels, the value under the cursor is not the
 * value the eye is on, so the number it reports is close to meaningless.
 */
const TOOLTIP_POINT_LIMIT = 3000;

// A drag narrower than this is a click, not a zoom. Load-bearing for
// double-click-to-reset: with the brush cursor active every click IS a
// zero-width drag, so without this floor the two clicks of a double-click
// each zoom into a slice a few pixels wide before the dblclick arrives, and
// the reset lands on a chart that has already thrown its range away.
const MIN_DRAG_PX = 6;

const vscode = acquireVsCodeApi();

const root = document.getElementById('chart-root');
if (!root) throw new Error('missing #chart-root element');

const titleEl = document.createElement('div');
titleEl.className = 'chart-title';
const plotEl = document.createElement('div');
plotEl.className = 'chart-plot';
const canvasEl = document.createElement('div');
canvasEl.className = 'chart-canvas';
// The tools live over the plot rather than in ECharts' toolbox: its own
// "restore" action resets legend selection along with zoom, so a user who had
// hidden a series would see it come back just from zooming out.
const toolsEl = document.createElement('div');
toolsEl.className = 'chart-tools';
// Hidden as a group -- there is nothing to reset or reshape until a chart is
// actually drawn, and a toolbar over an error message is furniture.
toolsEl.hidden = true;
// Each button says what pressing it DOES, not what is on screen: the mark
// currently drawn is already visible in the plot.
const modeEl = document.createElement('button');
modeEl.className = 'chart-mode';
modeEl.addEventListener('click', () => setMode(mode === 'line' ? 'scatter' : 'line'));
const resetEl = document.createElement('button');
resetEl.className = 'chart-reset';
resetEl.title = 'Reset zoom (or double-click the plot)';
resetEl.textContent = '⟲';
resetEl.addEventListener('click', () => resetZoom());
toolsEl.appendChild(modeEl);
toolsEl.appendChild(resetEl);
plotEl.appendChild(canvasEl);
plotEl.appendChild(toolsEl);
root.appendChild(titleEl);
root.appendChild(plotEl);

// Bound once, on the container, rather than through chart.on('dblclick'):
// zrender never sees a double-click here, because the brush cursor consumes
// both clicks as drags of its own. The browser still dispatches a native
// dblclick — brush calls preventDefault on mousedown/mouseup, which suppresses
// selection and focus but not the click pair — so the DOM is where this has to
// be listened for.
canvasEl.addEventListener('dblclick', () => resetZoom());

let chart: echarts.ECharts | undefined;

/**
 * The mark the plot is drawn with. Deliberately NOT carried across plots --
 * render() puts it back to 'line', so clicking a column always starts from the
 * chart the R scripts draw, and a scatter is something you asked for about the
 * series in front of you.
 */
let mode: ChartMode = 'line';

/**
 * render()'s series builder, kept so the toolbar can rebuild them for the other
 * mark without re-running the whole draw. Undefined until something is drawn.
 */
let buildSeries: ((mode: ChartMode) => unknown[]) | undefined;

/** Brush mode on, so a drag zooms without arming anything first. */
function armBrush(): void {
  chart?.dispatchAction({
    type: 'takeGlobalCursor',
    key: 'brush',
    brushOption: { brushType: 'lineX', brushMode: 'single' },
  });
}

function syncModeButton(): void {
  modeEl.textContent = mode === 'line' ? '∴' : '∿';
  modeEl.title = mode === 'line' ? 'Show as a scatter' : 'Show as a line';
}

function setMode(next: ChartMode): void {
  if (next === mode) return;
  mode = next;
  syncModeButton();
  if (!chart || !buildSeries) return;
  // replaceMerge over a plain merge, and over a full redraw: it swaps the
  // series wholesale -- a line and a scatter share no style fields to reconcile
  // -- while leaving dataZoom, brush, legend and tooltip untouched. So the
  // toggle keeps the range you had zoomed into and any series you had hidden,
  // where re-running render() would reset both.
  chart.setOption({ series: buildSeries(mode) }, { replaceMerge: 'series' });
  // Re-armed rather than assumed: the brush cursor is a mode held outside the
  // option tree, and a chart you could no longer drag-zoom on after one click
  // of a toolbar button would be a strange thing to debug later. Dispatching it
  // again when it was already on costs nothing.
  armBrush();
}

function resetZoom(): void {
  if (!chart) return;
  chart.dispatchAction({ type: 'dataZoom', xAxisIndex: X_AXIS_INDEX, start: 0, end: 100 });
  chart.dispatchAction({ type: 'brush', areas: [] });
}

function showMessage(text: string): void {
  chart?.dispose();
  chart = undefined;
  buildSeries = undefined;
  titleEl.textContent = '';
  toolsEl.hidden = true;
  canvasEl.textContent = text;
}

/** Axis labels: three significant digits -- .echarts_number_formatter_js, non-percent branch. */
function formatAxisNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumSignificantDigits: 3 });
}

/** Tooltip values: four significant digits -- build_tooltip_formatter's fmtValue. */
function formatTooltipNumber(value: number): string {
  return Number(value).toPrecision(4);
}

interface TooltipParam {
  marker?: string;
  seriesName?: string;
  axisValueLabel?: string;
  value?: unknown;
}

/** Bold header, then one `marker name: value` line per series -- build_tooltip_formatter's shape. */
function formatTooltip(
  params: TooltipParam[],
  isCategory: boolean,
  frequency?: SeriesFrequency
): string {
  if (!params || params.length === 0) return '';
  const first = params[0];
  const header = isCategory
    ? (first.axisValueLabel ?? '')
    : pointDateLabel((first.value as [number, unknown])?.[0], frequency);
  const lines = [`<b>${header}</b>`];
  for (const p of params) {
    const raw = isCategory ? p.value : (p.value as [number, unknown])?.[1];
    if (raw === null || raw === undefined || typeof raw !== 'number') continue;
    lines.push(`${p.marker ?? ''} ${p.seriesName ?? ''}: <b>${formatTooltipNumber(raw)}</b>`);
  }
  return lines.join('<br/>');
}

function render(message: Extract<ChartMessage, { command: 'chart' }>): void {
  if (message.truncated) {
    // Refused, not truncated. runChartQuery strips the preview's LIMIT so the
    // chart is of the whole series; drawing the first N here would put back
    // exactly the lie that stripping it removed, and a chart that stops early
    // looks identical to a series that ends early.
    showMessage(
      `Too many points to chart (over ${message.maxPoints.toLocaleString()}). ` +
        'Narrow the query, or raise dataFileViewer.chartMaxPoints.'
    );
    return;
  }

  const xIndex = message.columns.indexOf(message.xColumn);
  if (xIndex < 0) {
    showMessage('The chart query did not return its x column.');
    return;
  }
  const isCategory = message.xAxisMode === 'category';
  // Optional throughout: undefined means every date label falls back to its
  // plain form, and nothing else about the chart changes.
  const frequency = message.frequency ?? undefined;
  // Only the cadences ECharts cannot express take over the axis. Its own time
  // labels already read well day to day and adapt as you zoom, and forcing
  // "14 Jun 1961" onto every tick of a 60-year daily series is worse than what
  // it does unaided; what it has no idea about is that a point stands for a
  // quarter or a half-year. The tooltip takes the frequency either way, since
  // there it names one point rather than crowding an axis.
  const axisFrequency =
    frequency && frequency !== 'daily' && frequency !== 'weekly' ? frequency : undefined;
  // Ticks are labelled in order and the run starts again at index 0 on every
  // repaint, so a tick whose label repeats the one before it is blanked rather
  // than drawing "2020 Q1" three times where ECharts placed three ticks inside
  // one quarter.
  let previousLabel = '';
  const labelTick = (value: number, index: number): string => {
    const label = axisDateLabel(value, axisFrequency) ?? '';
    if (index === 0) {
      previousLabel = label;
      return label;
    }
    if (label === previousLabel) return '';
    previousLabel = label;
    return label;
  };
  const xs = message.rows.map((row) => row[xIndex]);
  const labels = isCategory ? toCategoryLabels(xs) : [];

  // Built once and reused for both marks: only the style fields seriesShape
  // owns differ between a line and a scatter, and re-deriving the points on
  // every toggle would walk every row again for a change of stroke.
  const data = message.yColumns.map((name) => {
    const yIndex = message.columns.indexOf(name);
    const ys = yIndex < 0 ? [] : message.rows.map((row) => row[yIndex]);
    // Gaps stay in the DATA as nulls -- dropping the point would move the
    // series in x, not just close a hole. Whether the line bridges them is a
    // rendering choice, and seriesShape() makes it (connectNulls, matching R).
    return isCategory ? toCategoryValues(ys) : toSeriesPoints(xs, ys);
  });

  buildSeries = (forMode: ChartMode) =>
    message.yColumns.map((name, i) => ({
      name,
      data: data[i],
      ...seriesShape(forMode, SERIES_COLOURS[i % SERIES_COLOURS.length]),
      // large/progressive keep a long daily series interactive, on either mark
      // -- the R traces carry them on both too. No sampling: lttb invents sharp
      // spikes at the zoomed-out view that are not in the data, which is the
      // same reason the R scripts turn it off.
      large: true,
      largeThreshold: 2000,
      progressive: 2000,
      progressiveThreshold: 2000,
    }));

  // A new plot is a new question, so the mark goes back to the line the R
  // scripts draw rather than inheriting the last chart's toggle.
  mode = 'line';
  syncModeButton();
  const series = buildSeries(mode);

  const drawn = data.reduce((n, points) => n + points.length, 0);
  if (drawn === 0) {
    showMessage('Nothing to chart -- no row had both an x value and a number.');
    return;
  }

  canvasEl.textContent = '';
  const points = `${drawn.toLocaleString()} point${drawn === 1 ? '' : 's'}`;
  const heading =
    message.yColumns.length === 1
      ? `${message.yColumns[0]} by ${message.xColumn} — ${points}`
      : `${message.yColumns.length} series by ${message.xColumn} — ${points}`;
  titleEl.textContent = heading;
  const hintEl = document.createElement('span');
  hintEl.className = 'chart-hint';
  hintEl.textContent = 'drag to zoom · scroll to zoom · double-click to reset';
  titleEl.appendChild(hintEl);
  toolsEl.hidden = false;

  chart?.dispose();
  chart = echarts.init(canvasEl, undefined, { renderer: 'canvas' });

  // Axis ranges and ticks are the R helpers' numbers, not ECharts' defaults:
  // padded either side, and the y ticks placed from the UNPADDED extent so the
  // outermost ones sit just inside the ends of the axis.
  // From `data`, not from the series: the extents are a property of the points,
  // and toggling the mark must not move an axis.
  const yExtent = finiteExtent(
    data.flat().map((point) => (Array.isArray(point) ? point[1] : (point as number | null)))
  );
  const yRange = yExtent ? padValueRange(yExtent) : undefined;
  const yBreaks = yExtent ? evenBreaks(yExtent.lo, yExtent.hi, Y_TICKS) : undefined;
  const xExtent = isCategory
    ? undefined
    : finiteExtent(data.flat().map((point) => (Array.isArray(point) ? point[0] : null)));
  const xRange = xExtent ? padTimeRange(xExtent) : undefined;
  // Shared by both axes. The minor lines are the ones between the labelled
  // ticks; ECharts only draws them on value/time/log axes, which is why the
  // category axis below leaves them off rather than asking for lines that
  // would silently not appear.
  const axis = {
    axisLabel: { color: INK, fontFamily: CHART_FONT, fontSize: 10 },
    axisLine: { show: true, lineStyle: { color: AXIS_LINE, width: 1.5 } },
    axisTick: { lineStyle: { color: AXIS_LINE } },
    splitLine: { show: true, lineStyle: { color: SPLIT_LINE, width: 0.5 } },
  };
  const minor = {
    minorTick: { show: true, splitNumber: 2, lineStyle: { color: SPLIT_LINE } },
    minorSplitLine: { show: true, lineStyle: { color: MINOR_SPLIT_LINE, width: 0.5 } },
  };
  chart.setOption({
    animation: false,
    // Painted, not left transparent: the canvas is what a screenshot or an
    // ECharts image export captures, and a transparent one picks up whatever
    // is behind it.
    backgroundColor: '#ffffff',
    textStyle: { color: INK, fontFamily: CHART_FONT },
    // containLabel, so the left margin follows the width of the numbers
    // actually on the axis instead of a guess that clips six-figure ones.
    grid: {
      left: 10,
      right: 10,
      top: 16,
      bottom: message.yColumns.length > 1 ? 34 : 10,
      containLabel: true,
    },
    // A single series has nothing to be told apart from, so its legend would
    // be a caption in the wrong place.
    legend:
      message.yColumns.length > 1
        ? { bottom: 0, textStyle: { color: INK, fontFamily: CHART_FONT, fontSize: 11 } }
        : undefined,
    tooltip: {
      trigger: 'axis',
      // Starts off when the opening view is already too dense to hover
      // usefully; the datazoom handler below turns it back on. Same gate, and
      // the same starting condition, as e_zoom_aware_detail.
      show: drawn <= TOOLTIP_POINT_LIMIT,
      formatter: (params: unknown) => formatTooltip(params as TooltipParam[], isCategory, frequency),
      backgroundColor: '#ffffff',
      borderColor: '#000000',
      borderWidth: 1,
      textStyle: { color: INK, fontFamily: CHART_FONT, fontSize: 11 },
      // Crosshair rather than a vertical rule alone: reading a level off the y
      // axis is half of what a hover is for.
      axisPointer: {
        type: 'cross',
        crossStyle: { color: '#000000', width: 1, type: 'solid' },
        label: { show: false },
      },
    },
    xAxis: isCategory
      ? {
          type: 'category',
          // Labels exactly as stored. A category axis says nothing about the
          // spacing between its ticks, which is the honest thing to say about
          // strings we could not parse into dates.
          data: labels,
          ...axis,
        }
      : {
          type: 'time',
          ...axis,
          ...minor,
          min: xRange?.min,
          max: xRange?.max,
          // Tick PLACEMENT stays ECharts' own, deliberately: the R script pins
          // six of them, which reads well on a fixed view and empties the axis
          // as soon as you drag-zoom inside them. Only the wording comes from
          // the frequency, so a zoomed-in view still labels itself.
          axisLabel: {
            ...axis.axisLabel,
            formatter: axisFrequency ? labelTick : undefined,
          },
          // onZero false pins the axis to the bottom of the plot rather than
          // to y = 0 when zero happens to fall inside the range -- the same
          // correction helpers_echarts.R makes.
          axisLine: { ...axis.axisLine, onZero: false },
        },
    yAxis: {
      type: 'value',
      ...axis,
      ...minor,
      min: yRange?.min,
      max: yRange?.max,
      // customValues pins ticks, labels and gridlines to the computed breaks
      // instead of letting ECharts choose its own round numbers, which is how
      // the same series ends up with a different number of gridlines here than
      // it has in R.
      axisLabel: { ...axis.axisLabel, customValues: yBreaks, formatter: formatAxisNumber },
      axisTick: { ...axis.axisTick, customValues: yBreaks },
      splitLine: { ...axis.splitLine, customValues: yBreaks },
    },
    // Wheel/pinch zoom in place. No slider: the whole series is on screen to
    // begin with, and a strip along the bottom is a second, smaller copy of
    // the chart that has to be aimed at. Dragging on the plot itself is the
    // gesture that replaces it -- see the brush below.
    dataZoom: [{ type: 'inside', xAxisIndex: X_AXIS_INDEX }],
    // Drag-to-zoom is built on `brush`, not on the toolbox dataZoom feature's
    // own cursor mode: that mode is registered BY the toolbox feature, so
    // hiding its icons unregisters dragging with them, and showing them
    // desyncs their highlight from the cursor mode forced on below. `brush` is
    // a standalone component, so its cursor works with no toolbox at all.
    // `lineX` restricts a drag to an x-range, which is the only selection that
    // means anything for a time series.
    brush: {
      xAxisIndex: X_AXIS_INDEX,
      brushType: 'lineX',
      brushMode: 'single',
      throttleType: 'debounce',
      throttleDelay: 80,
      brushStyle: { borderWidth: 0, color: 'rgba(0, 0, 128, 0.10)' },
    },
    series,
  });

  // Turn the dragged range into a zoom, then clear the shape so the next drag
  // starts from a clean plot rather than on top of the last selection.
  chart.on('brushEnd', (params: unknown) => {
    const area = (params as { areas?: { range?: number[]; coordRange?: number[] }[] }).areas?.[0];
    const pixels = area?.range;
    const values = area?.coordRange;
    // `range` is in pixels and `coordRange` in axis values; the floor is
    // applied to the pixel one because it is about the gesture, not the data.
    // Always clear the shape, so an ignored click leaves no band behind.
    if (!values || values.length < 2 || values[0] === values[1]) {
      chart?.dispatchAction({ type: 'brush', areas: [] });
      return;
    }
    if (pixels && pixels.length >= 2 && Math.abs(pixels[1] - pixels[0]) < MIN_DRAG_PX) {
      chart?.dispatchAction({ type: 'brush', areas: [] });
      return;
    }
    chart?.dispatchAction({
      type: 'dataZoom',
      xAxisIndex: X_AXIS_INDEX,
      startValue: values[0],
      endValue: values[1],
    });
    chart?.dispatchAction({ type: 'brush', areas: [] });
  });

  // The other half of the density gate: recount what is in view after every
  // zoom and switch the tooltip accordingly. Only the top-level `show` flag is
  // touched, so the formatter and styling above survive the merge.
  chart.on('datazoom', () => {
    if (!chart) return;
    const zooms = (chart.getOption() as { dataZoom?: { start?: number; end?: number }[] }).dataZoom;
    const zoom = zooms?.[0];
    const from = zoom?.start ?? 0;
    const to = zoom?.end ?? 100;
    const visible = (drawn * (to - from)) / 100;
    chart.setOption({ tooltip: { show: visible <= TOOLTIP_POINT_LIMIT } });
  });

  armBrush();
}

window.addEventListener('message', (event: MessageEvent<ChartMessage>) => {
  const message = event.data;
  if (message.command === 'chart') render(message);
  else if (message.command === 'chartError') showMessage(message.message);
});

// ECharts sizes itself once at init and does not watch its container, so a
// split-pane drag or a window resize leaves the canvas at its old size.
window.addEventListener('resize', () => chart?.resize());

showMessage('Loading…');
// The host holds the first chart until this arrives: a webview created a
// moment ago has not run this script yet, and a postMessage sent before it
// does is dropped with no error anywhere.
vscode.postMessage({ command: 'ready' });
