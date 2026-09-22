// Uses installed Chrome. From the repository root:
// npm install --prefix /tmp/dfv-browser playwright --no-audit --no-fund
// NODE_PATH=/tmp/dfv-browser/node_modules node test/browser/chartDetail.cjs
const { chromium } = require('playwright');
const esbuild = require('esbuild');
const fs = require('node:fs');
const assert = require('node:assert/strict');
(async () => {
  const bundle = await esbuild.build({
    stdin: { contents: fs.readFileSync('src/chartView.ts', 'utf8') + '\nexport function testChart() { return chart; }', resolveDir: require('node:path').resolve('src'), loader: 'ts' },
    bundle: true, write: false, format: 'iife', globalName: 'viewerTest', platform: 'browser',
  });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || String(error)));
    await page.setContent('<style>.chart-canvas{width:950px;height:550px}</style><div id="chart-root"></div>');
    await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage() {} }); });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const result = await page.evaluate(async () => {
      const pause = () => new Promise(resolve => setTimeout(resolve, 60));
      const start = Date.UTC(2020, 0, 1);
      const rows = Array.from({ length: 200000 }, (_, i) => [new Date(start + i * 1000).toISOString(), i === 100 ? 1.23456789012345 : i % 100]);
      window.postMessage({ command: 'chart', xColumn: 'time', yColumns: ['value'], columns: ['time', 'value'], rows, xAxisMode: 'time', truncated: false, maxPoints: 200000 }, '*');
      await pause();
      const chart = viewerTest.testChart();
      const state = () => {
        const option = chart.getOption();
        return { tooltip: option.tooltip[0].show, symbols: option.series[0].showSymbol, large: option.series[0].large, type: option.series[0].type };
      };
      const initial = state();
      chart.dispatchAction({ type: 'dataZoom', startValue: start, endValue: start + 2999 * 1000 });
      await pause();
      const boundary = state();
      const renderedSymbols = chart.getZr().storage.getDisplayList().filter(el => el.type === 'path').length;
      chart.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: 100 });
      await pause();
      const text = document.body.textContent;
      chart.dispatchAction({ type: 'dataZoom', startValue: start, endValue: start + 3000 * 1000 });
      await pause();
      const over = state();
      chart.dispatchAction({ type: 'dataZoom', batch: [{ start: 0, end: 0.1 }] });
      await pause();
      const wheel = state();
      document.querySelector('.chart-mode').click();
      await pause();
      const scatter = state();
      document.querySelector('.chart-reset').click();
      await pause();
      const reset = state();
      document.querySelector('.chart-mode').click();
      await pause();
      const lineReset = state();
      // Category axes, gaps and hidden series share the same detail gate.
      window.postMessage({ command: 'chart', xColumn: 'label', yColumns: ['a', 'b'], columns: ['label', 'a', 'b'], rows: Array.from({ length: 4000 }, (_, i) => ['row' + i, i, i < 2000 ? null : i]), xAxisMode: 'category', truncated: false, maxPoints: 200000 }, '*');
      await pause();
      const categoryChart = viewerTest.testChart();
      categoryChart.dispatchAction({ type: 'dataZoom', startValue: 0, endValue: 1999 });
      await pause();
      const category = categoryChart.getOption().tooltip[0].show;
      categoryChart.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
      categoryChart.dispatchAction({ type: 'legendUnSelect', name: 'a' });
      // legendUnSelect emits legendunselected, whereas a click emits legendselectchanged.
      categoryChart.dispatchAction({ type: 'legendToggleSelect', name: 'a' });
      categoryChart.dispatchAction({ type: 'legendToggleSelect', name: 'a' });
      await pause();
      const hidden = categoryChart.getOption().tooltip[0].show;
      return { initial, boundary, over, wheel, scatter, reset, lineReset, renderedSymbols, text, category, hidden };
    });
    assert.equal(result.initial.tooltip, false);
    assert.equal(result.initial.symbols, false);
    assert.equal(result.boundary.tooltip, true);
    assert.equal(result.boundary.symbols, true);
    assert.ok(result.renderedSymbols >= 3000, JSON.stringify(result));
    assert.ok(result.text.includes('1.23456789012345'));
    assert.ok(result.text.includes('2020-01-01T00:01:40.000Z'));
    assert.equal(result.over.tooltip, false);
    assert.equal(result.wheel.tooltip, true);
    assert.equal(result.scatter.type, 'scatter');
    assert.equal(result.scatter.large, false);
    assert.equal(result.reset.tooltip, false);
    assert.equal(result.reset.large, true);
    assert.equal(result.lineReset.symbols, false);
    assert.equal(result.category, true);
    assert.equal(result.hidden, true);
    const drag = await page.evaluate(() => {
      const chart = viewerTest.testChart();
      chart.dispatchAction({ type: 'legendToggleSelect', name: 'a' });
      chart.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
      const rect = document.querySelector('.chart-canvas').getBoundingClientRect();
      return [500, 700].map(x => {
        const point = chart.convertToPixel({ gridIndex: 0 }, [x, 1000]);
        return { x: rect.left + point[0], y: rect.top + point[1] };
      });
    });
    await page.mouse.move(drag[0].x, drag[0].y);
    await page.mouse.down();
    await page.mouse.move(drag[1].x, drag[1].y, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => viewerTest.testChart().getOption().tooltip[0].show), true);
    await page.locator('.chart-reset').click();
    assert.equal(await page.evaluate(() => viewerTest.testChart().getOption().tooltip[0].show), false);
    assert.deepEqual(errors, []);
    console.log('Chrome chart checks passed: 200,000 points, exact tooltip, markers, threshold, wheel/brush/reset, scatter, categories, gaps and legend.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
