const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const esbuild = require('esbuild');
const vscode = require('../../out-test/test/stress/stubs/vscode').default;
const { DuckDBDocument, DuckDBEditorProvider } = require('../../out-test/src/duckdbEditorProvider');
const { ViewerFile } = require('../../out-test/src/viewerFile');
const { xlsxFile } = require('../../out-test/test/stress/generators/_write');

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dfv-browser-sql-'));
  const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome', headless: true });
  let document;
  try {
    const source = path.join(dir, 'data.xlsx');
    await xlsxFile(source, [{ name: 'Raw_Data', rows: [
      ['Series', 'Description'], ['example', 'Synthetic fixture'], [], [null, 'Date', 'value'],
      ...Array.from({ length: 300 }, (_, i) => [null, new Date(Date.UTC(1989, 6, 1 + i)).toISOString().slice(0, 10), i]),
    ] }]);
    const original = await fs.readFile(source);
    const file = await ViewerFile.open(source);
    document = new DuckDBDocument(vscode.Uri.file(source), file);
    const provider = new DuckDBEditorProvider({ extensionUri: vscode.Uri.file(process.cwd()) });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [], requests = [], responses = [], outbound = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/*', route => { outbound.push(route.request().url()); return route.abort(); });
    let handler;
    const webview = {
      cspSource: 'vscode-resource:', asWebviewUri: uri => uri,
      onDidReceiveMessage: callback => { handler = callback; return { dispose() {} }; },
      postMessage: async message => { responses.push(message); if (!page.isClosed()) await page.evaluate(message => window.postMessage(message, '*'), message); return true; },
    };
    await provider.resolveCustomEditor(document, { webview, onDidDispose: () => ({ dispose() {} }) });
    await page.exposeFunction('sendToHost', async message => { requests.push(message); await handler(message); });
    await page.setContent('<div id="root"></div>');
    await page.addStyleTag({ path: 'media/main.css' });
    await page.evaluate(() => { window.acquireVsCodeApi = () => ({ postMessage: message => void window.sendToHost(message) }); });
    const bundle = await esbuild.build({ stdin: {
      contents: await fs.readFile('src/webview.ts', 'utf8') + '\nexport function inspectEditor(){return editor.state.doc.toString()}\n',
      loader: 'ts', resolveDir: path.resolve('src'),
    }, bundle: true, write: false, format: 'iife', globalName: 'sqlTest', platform: 'browser' });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.waitForFunction(() => document.querySelectorAll('.sheet-table-sql').length === 2);
    await page.waitForFunction(() => [...document.querySelectorAll('#query-target option')].some(option => option.textContent.includes('Table 2')));
    const editor = page.locator('.cm-content');
    await editor.fill('SELECT 42 AS saved_draft;');
    const choices = await page.locator('#query-target option').evaluateAll(options => options.map(option => ({ value: option.value, label: option.textContent })));
    const main = choices.find(option => option.label.includes('Table 2'));
    assert.ok(main && main.label.includes('B4:C304'));
    await page.selectOption('#query-target', main.value);
    await page.waitForFunction(() => document.querySelector('#query-schema').textContent.includes('Date: VARCHAR'));
    assert.equal(await page.evaluate(() => sqlTest.inspectEditor()), 'SELECT 42 AS saved_draft;');
    await page.locator('#query-use').click();
    await page.waitForFunction(() => sqlTest.inspectEditor().includes('Table 2'));
    assert.ok((await page.evaluate(() => sqlTest.inspectEditor())).includes('LIMIT 100'));
    await page.locator('#query-restore').click();
    assert.equal(await page.evaluate(() => sqlTest.inspectEditor()), 'SELECT 42 AS saved_draft;');

    // Inline SQL uses the host builder for the exact region and preserves the draft.
    await page.locator('.sheet-table-sql').nth(1).click();
    await page.waitForFunction(() => sqlTest.inspectEditor().includes('Raw_Data · Table 2'));
    assert.match(await page.evaluate(() => sqlTest.inspectEditor()), /limit \d+/i);
    await editor.fill(`SELECT * FROM "Raw_Data · Table 2" WHERE CAST("Date" AS DATE) >= DATE '1990-01-01' LIMIT 100;`);
    await page.locator('#run-btn').click();
    await page.waitForFunction(() => !document.querySelector('.sheet-table-sql') && document.querySelector('#run-btn').textContent.includes('Run') && document.querySelector('.results-footer')?.textContent.includes('100'));
    const result = responses.filter(message => message.command === 'queryResult').at(-1);
    assert.equal(result.rows.length, 100);
    assert.equal(result.sheetTables, undefined);
    assert.equal(result.rows[0][0], '1990-01-01');
    assert.ok(!requests.some(message => message.command === 'updateCell'));

    // A raw-sheet error explains target selection and discovery survives failure.
    await editor.fill('SELECT * FROM "Raw_Data" WHERE "Date" >= 1990 LIMIT 100;');
    await page.locator('#run-btn').click();
    await page.waitForFunction(() => document.querySelector('.error')?.textContent.includes('detected table'));
    await page.waitForFunction(() => [...document.querySelectorAll('#query-target option')].some(option => option.textContent.includes('Table 2')));

    // Schema metadata is text, including hostile markup, and cannot fetch resources.
    const catalogRequest = requests.filter(message => message.command === 'queryCatalog').at(-1);
    await page.evaluate(message => window.postMessage(message, '*'), { command: 'queryCatalog', cursor: 0, generation: 0, requestId: catalogRequest.requestId,
      targets: [{ id: 'hostile', generation: 0, catalog: 'data', schema: 'main', name: '<img src="https://example.invalid/leak" onerror="window.__injected=1">', sqlName: '"hostile"', rawWorksheet: false, prepared: true }] });
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#query-target img').count(), 0);
    assert.equal(await page.evaluate(() => window.__injected), undefined);
    assert.deepEqual(outbound, []);
    assert.deepEqual(errors, []);
    const resultCount = responses.filter(message => message.command === 'queryResult').length;
    await handler(requests.find(message => message.command === 'runQuery'));
    assert.equal(responses.filter(message => message.command === 'queryResult').length, resultCount);
    assert.ok(responses.some(message => message.command === 'error' && message.message.includes('expired')));
    assert.deepEqual(await fs.readFile(source), original);
    console.log('SQL browser workflow passed: real provider/worker, target types, draft restoration, inline SQL, exact date filter, failed-query discovery, and safe metadata rendering.');
  } finally { document?.dispose(); await browser.close(); await fs.rm(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
