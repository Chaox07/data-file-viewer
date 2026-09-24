const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { xlsxFile } = require('../../out-test/test/stress/generators/_write');

// DFV_VSCODE_EXECUTABLE selects a pinned downloaded VS Code in CI. The default
// uses the local macOS application, always with disposable user/extension dirs.
(async () => {
  const executable = process.env.DFV_VSCODE_EXECUTABLE || '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  const vsix = process.env.DFV_VSIX || path.resolve(`data-file-viewer-${require('../../package.json').version}.vsix`);
  let cli = process.platform === 'darwin'
    ? path.resolve(executable, '../../Resources/app/out/cli.js')
    : path.join(path.dirname(executable), 'resources/app/out/cli.js');
  // Recent Windows archives keep resources beneath a version directory;
  // Code.exe remains at the archive root. Support both packaged layouts.
  if (process.platform === 'win32' && !await fs.stat(cli).then(s => s.isFile(), () => false)) {
    const installRoot = path.dirname(executable);
    const candidates = [];
    for (const entry of await fs.readdir(installRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(installRoot, entry.name, 'resources/app/out/cli.js');
      if (await fs.stat(candidate).then(s => s.isFile(), () => false)) candidates.push(candidate);
    }
    assert.equal(candidates.length, 1, 'one Windows VS Code CLI entry point');
    cli = candidates[0];
  }
  const root = await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'dfvh-'));
  let browser, child;
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const stop = () => {
    if (!child?.pid) return;
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }); } catch {}
    } else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  };
  const deadline = setTimeout(() => { stop(); console.error('Installed-host test exceeded its deadline.'); process.exit(1); }, 120000);
  try {
    const user = path.join(root, 'user'), extensions = path.join(root, 'extensions');
    await fs.mkdir(path.join(user, 'User'), { recursive: true });
    await fs.writeFile(path.join(user, 'User', 'settings.json'), JSON.stringify({
      'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false,
      'extensions.autoUpdate': false, 'extensions.ignoreRecommendations': true, 'update.mode': 'none',
      'workbench.editorAssociations': { '*.xlsx': 'dataFileViewer.editor' },
    }));
    const source = path.join(root, 'data.xlsx');
    await xlsxFile(source, [{ name: 'Raw_Data', rows: [
      ['Series', 'Description'], ['example', 'Synthetic'], [], [null, 'Date', 'value'],
      ...Array.from({ length: 300 }, (_, i) => [null, new Date(Date.UTC(1989, 6, 1 + i)).toISOString().slice(0, 10), i]),
    ] }]);
    const original = await fs.readFile(source);
    execFileSync(executable, [cli, '--user-data-dir', user, '--extensions-dir', extensions, '--install-extension', vsix, '--force'],
      { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe', timeout: 30000 });
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    child = spawn(executable, ['--user-data-dir', user, '--extensions-dir', extensions,
      `--remote-debugging-port=${port}`, '--disable-gpu', '--disable-extension', 'GitHub.copilot-chat',
      '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--new-window', source],
      { env, detached: process.platform !== 'win32', stdio: 'ignore' });
    child.on('error', error => { console.error(error.message); });
    for (let i = 0; i < 80 && !browser; i++) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.ok(browser, 'VS Code debugging endpoint');
    let page, frame;
    for (let i = 0; i < 160 && !frame; i++) {
      page = browser.contexts()[0]?.pages().at(-1);
      if (page) for (const candidate of page.frames()) if (await candidate.locator('.sheet-table-sql').count() === 2) frame = candidate;
      if (!frame) await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(frame, 'packaged workbook editor rendered two detected tables');
    console.log('Packaged VS Code workbook rendered.');
    page.setDefaultTimeout(10000);
    await page.bringToFront();
    const editor = frame.locator('.cm-content');
    await editor.fill('SELECT 42 AS saved_draft;');
    const choices = await frame.locator('#query-target option').evaluateAll(options => options.map(o => ({ value: o.value, label: o.textContent })));
    const main = choices.find(o => o.label.includes('Table 2'));
    assert.ok(main);
    await frame.selectOption('#query-target', main.value);
    await frame.waitForFunction(() => document.querySelector('td[data-r="3"][data-c="1"]')?.style.boxShadow.includes('inset'));
    assert.equal(await frame.locator('.row-num').first().textContent(), '1');
    assert.equal(await frame.locator('#query-schema').count(), 0);
    assert.equal(await editor.innerText(), 'SELECT 42 AS saved_draft;');
    await frame.locator('#query-use').click();
    await frame.waitForFunction(() => document.querySelector('.cm-content').textContent.includes('Table 2'));
    await frame.locator('#query-restore').click();
    assert.equal(await editor.innerText(), 'SELECT 42 AS saved_draft;');
    await frame.locator('.sheet-table-sql').nth(1).click();
    await frame.waitForFunction(() => document.querySelector('.cm-content').textContent.includes('Table 2'));
    await editor.fill(`SELECT * FROM "Raw_Data · Table 2" WHERE CAST("Date" AS DATE) >= DATE '1990-01-01' LIMIT 100;`);
    await frame.locator('#run-btn').click();
    await frame.waitForFunction(() => !document.querySelector('.sheet-table-sql') && document.querySelector('.results-footer')?.textContent.includes('100'));
    assert.ok((await frame.locator('body').innerText()).includes('1990-01-01'));
    assert.deepEqual(await fs.readFile(source), original);
    console.log('Installed-host SQL workflow passed: worksheet outline, row numbers, draft, handoff, restore, exact date boundary, 100 rows and unchanged source.');
  } finally {
    // Stop our VS Code process before closing its CDP connection. Keep the
    // hard deadline active through teardown, including a failed host launch.
    stop();
    await browser?.close().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    clearTimeout(deadline);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
