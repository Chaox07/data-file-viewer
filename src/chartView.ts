/**
 * The chart tab's script. Receives one message and draws it; that is all it
 * does, which is why it can be its own bundle and keep ECharts out of the
 * grid's.
 */

import { toSeriesPoints, toCategoryLabels, toCategoryValues } from './chartSpec';
// Modular import rather than `from 'echarts'`: the umbrella entry point
// registers every chart type and component and took a bundle from 468 KB to
// 1.5 MB. This registers the line chart and the components actually used
// below, and nothing else.
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
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
      truncated: boolean;
      maxPoints: number;
    }
  | { command: 'chartError'; message: string };

// One navy, and it is the same navy the R plotting scripts use for a lone
// series. A single line needs a colour, not a palette; the extra entries only
// come into play when a query puts several numeric columns on one axis.
const SERIES_COLOURS = ['#000080', '#b0532a', '#2e7d5b', '#7a3d8f', '#a3872c', '#3c6ea5'];

const vscode = acquireVsCodeApi();

const root = document.getElementById('chart-root');
if (!root) throw new Error('missing #chart-root element');

const titleEl = document.createElement('div');
titleEl.className = 'chart-title';
const canvasEl = document.createElement('div');
canvasEl.className = 'chart-canvas';
root.appendChild(titleEl);
root.appendChild(canvasEl);

let chart: echarts.ECharts | undefined;

function themeTextColour(): string {
  // The webview inherits VS Code's theme through CSS variables; reading the
  // resolved value is what lets ECharts, which wants concrete colours, follow
  // a light/dark switch instead of drawing black axes on a dark ground.
  const styles = getComputedStyle(document.body);
  return styles.getPropertyValue('--vscode-editor-foreground').trim() || '#333';
}

function showMessage(text: string): void {
  chart?.dispose();
  chart = undefined;
  titleEl.textContent = '';
  canvasEl.textContent = text;
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
  const xs = message.rows.map((row) => row[xIndex]);
  const labels = isCategory ? toCategoryLabels(xs) : [];

  const series = message.yColumns.map((name, i) => {
    const yIndex = message.columns.indexOf(name);
    const ys = yIndex < 0 ? [] : message.rows.map((row) => row[yIndex]);
    const colour = SERIES_COLOURS[i % SERIES_COLOURS.length];
    return {
      name,
      type: 'line' as const,
      showSymbol: false,
      // No connectNulls: a gap in a series is a fact about the data, and
      // joining across it draws a segment nobody measured.
      data: isCategory ? toCategoryValues(ys) : toSeriesPoints(xs, ys),
      lineStyle: { color: colour, width: 1.4 },
      itemStyle: { color: colour },
      // large/progressive keep a long daily series interactive. No sampling:
      // lttb invents sharp spikes at the zoomed-out view that are not in the
      // data, which is the same reason the R scripts turn it off.
      large: true,
      largeThreshold: 2000,
      progressive: 2000,
      progressiveThreshold: 2000,
    };
  });

  const drawn = series.reduce((n, s) => n + s.data.length, 0);
  if (drawn === 0) {
    showMessage('Nothing to chart -- no row had both an x value and a number.');
    return;
  }

  canvasEl.textContent = '';
  const points = `${drawn.toLocaleString()} point${drawn === 1 ? '' : 's'}`;
  titleEl.textContent =
    message.yColumns.length === 1
      ? `${message.yColumns[0]} by ${message.xColumn} — ${points}`
      : `${message.yColumns.length} series by ${message.xColumn} — ${points}`;

  chart?.dispose();
  chart = echarts.init(canvasEl, undefined, { renderer: 'canvas' });
  const textColour = themeTextColour();
  chart.setOption({
    animation: false,
    textStyle: { color: textColour },
    grid: { left: 64, right: 24, top: 16, bottom: 56 },
    // A single series has nothing to be told apart from, so its legend would
    // be a caption in the wrong place.
    legend:
      message.yColumns.length > 1 ? { bottom: 0, textStyle: { color: textColour } } : undefined,
    tooltip: { trigger: 'axis' },
    xAxis: isCategory
      ? {
          type: 'category',
          // Labels exactly as stored. A category axis says nothing about the
          // spacing between its ticks, which is the honest thing to say about
          // strings we could not parse into dates.
          data: labels,
          axisLabel: { color: textColour },
          axisLine: { lineStyle: { color: textColour } },
        }
      : {
          type: 'time',
          axisLabel: { color: textColour },
          axisLine: { lineStyle: { color: textColour } },
        },
    yAxis: { type: 'value', scale: true, axisLabel: { color: textColour }, splitLine: { show: true } },
    // Scroll/pinch to zoom in place, and a brush below for coarse navigation.
    dataZoom: [
      { type: 'inside' },
      { type: 'slider', bottom: message.yColumns.length > 1 ? 24 : 8, height: 18 },
    ],
    series,
  });
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
