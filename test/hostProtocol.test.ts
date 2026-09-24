import vscodeStub, { recorded, resetVscodeStub } from './stress/stubs/vscode';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBDocument, DuckDBEditorProvider } from '../src/duckdbEditorProvider';
import { ViewerFile } from '../src/viewerFile';
import { xlsxFile } from './stress/generators/_write';

// REL-13–20, SEC-14/16 (replay), SEC-21–23 (sinks) and SEC-24–26 (trust) of
// docs/sql-filtering-plan.md, through the real provider message loop with a
// recording webview. Only messages the webview would actually receive count.

const SECRET = 'SYNTHETIC_SECRET_4c1e';
type Posted = Record<string, unknown>;

async function openHost(path: string) {
  const file = await ViewerFile.open(path);
  const document = new DuckDBDocument(vscodeStub.Uri.file(path) as any, file);
  const provider = new DuckDBEditorProvider({ extensionUri: vscodeStub.Uri.file(process.cwd()) } as any);
  const posted: Posted[] = [];
  let handler!: (message: unknown) => Promise<void>;
  const webview = {
    cspSource: 'vscode-resource:', html: '', options: {}, asWebviewUri: (uri: unknown) => uri,
    onDidReceiveMessage: (callback: (message: unknown) => Promise<void>) => { handler = callback; return { dispose() {} }; },
    postMessage: async (message: Posted) => { posted.push(message); return true; },
  };
  await provider.resolveCustomEditor(document, { webview, onDidDispose: () => ({ dispose() {} }) } as any);
  let requestId = 0;
  const send = (message: Posted, id: number | null = ++requestId) => handler(id === null ? message : { ...message, requestId: id });
  return { document, posted, send, nextId: () => ++requestId };
}

const byCommand = (posted: Posted[], command: string) => posted.filter(m => m.command === command);

async function workbook(dir: string, name = 'book.xlsx', marker = 'A') {
  return xlsxFile(join(dir, name), [
    { name: 'Data', rows: [['id', 'value'], ...Array.from({ length: 50 }, (_, i) => [i, `${marker}${i}`])] },
    { name: 'Other', rows: [['id', 'label'], [1, `${marker}-other`]] },
  ]);
}

test('REL-13–16 / SEC-16: stale and replayed requests never deliver results', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-host-stale-'));
  const host = await openHost(await workbook(dir));
  try {
    await host.send({ command: 'ready' });
    // Two runs issued back to back: only the newest owner's result is posted.
    const slow = 'select count(*) as n from range(30000000) a';
    const first = host.send({ command: 'runQuery', sql: slow });
    const second = host.send({ command: 'runQuery', sql: 'select 7 as n' });
    await Promise.all([first, second]);
    const results = byCommand(host.posted, 'queryResult');
    assert.ok(results.length >= 1);
    assert.equal(String((results.at(-1) as any).rows[0][0]), '7', 'last result belongs to the last request');
    assert.ok(results.every(r => String((r as any).rows?.[0]?.[0]) !== '30000000'), 'superseded result was not posted');
    // A replayed or older request ID is refused before any work.
    const before = host.posted.length;
    const id = host.nextId();
    await host.send({ command: 'runQuery', sql: 'select 1 as replay_marker' }, id);
    await host.send({ command: 'runQuery', sql: 'select 2 as replay_marker' }, id);
    await host.send({ command: 'runQuery', sql: 'select 3 as replay_marker' }, id - 1);
    const after = host.posted.slice(before);
    assert.equal(byCommand(after, 'queryResult').length, 1);
    assert.equal(byCommand(after, 'error').filter(m => /expired/.test(String(m.message))).length, 2);
  } finally { host.document.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('REL-13 / SEC-11: a target ID or generation from another document or an older catalog is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-host-target-'));
  const a = await openHost(await workbook(dir, 'a.xlsx', 'A'));
  const b = await openHost(await workbook(dir, 'b.xlsx', 'B'));
  try {
    await a.send({ command: 'queryCatalog' });
    await b.send({ command: 'queryCatalog' });
    const catA = byCommand(a.posted, 'queryCatalog').at(-1) as any;
    const catB = byCommand(b.posted, 'queryCatalog').at(-1) as any;
    const targetA = catA.targets.find((t: any) => t.name === 'Data');
    assert.ok(targetA && catB.targets.length);
    // Opaque IDs are per document: A's ID means nothing in B.
    assert.ok(!catB.targets.some((t: any) => t.id === targetA.id));
    const beforeB = b.posted.length;
    await b.send({ command: 'queryTarget', targetId: targetA.id, generation: catB.generation });
    assert.deepEqual(byCommand(b.posted.slice(beforeB), 'queryTargetDetails'), []);
    assert.ok(byCommand(b.posted.slice(beforeB), 'error').length === 1);
    // A's own ID works with its generation, and fails with a wrong one.
    await a.send({ command: 'queryTarget', targetId: targetA.id, generation: catA.generation });
    assert.equal(byCommand(a.posted, 'queryTargetDetails').length, 1);
    const beforeA = a.posted.length;
    await a.send({ command: 'queryTarget', targetId: targetA.id, generation: catA.generation + 1 });
    await a.send({ command: 'sheetTableSql', table: 'Data · Table 1', filters: [], limit: 10, generation: catA.generation + 1 });
    assert.equal(byCommand(a.posted.slice(beforeA), 'queryTargetDetails').length, 0);
    assert.equal(byCommand(a.posted.slice(beforeA), 'querySqlDraft').length, 0);
    // Results never cross documents.
    await a.send({ command: 'runQuery', sql: 'select value from "Data · Table 1" where id = 3' });
    await b.send({ command: 'runQuery', sql: 'select value from "Data · Table 1" where id = 3' });
    assert.equal(String((byCommand(a.posted, 'queryResult').at(-1) as any).rows[0][0]), 'A3');
    assert.equal(String((byCommand(b.posted, 'queryResult').at(-1) as any).rows[0][0]), 'B3');
  } finally { a.document.dispose(); b.document.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('REL-17–20: cancel during execution is prompt, and the next query succeeds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-host-cancel-'));
  const host = await openHost(await workbook(dir));
  try {
    await host.send({ command: 'ready' });
    const started = Date.now();
    const running = host.send({ command: 'runQuery', sql: 'select count(*) from range(2000000000) a, range(10) b' });
    await new Promise(r => setTimeout(r, 300));
    await host.send({ command: 'cancelQuery' });
    await running;
    assert.ok(Date.now() - started < 15_000, 'cancellation stopped the work well before completion');
    assert.ok(!byCommand(host.posted, 'queryResult').some(r => String((r as any).rows?.[0]?.[0]) === '20000000000'));
    await host.send({ command: 'runQuery', sql: 'select count(*) as n from "Data · Table 1"' });
    assert.equal(String((byCommand(host.posted, 'queryResult').at(-1) as any).rows[0][0]), '50');
    // Repeated Run: ten quick runs, only the last is delivered last, and the reader stays usable.
    await Promise.all(Array.from({ length: 10 }, (_, i) => host.send({ command: 'runQuery', sql: `select ${i} as n` })));
    assert.equal(String((byCommand(host.posted, 'queryResult').at(-1) as any).rows[0][0]), '9');
  } finally { host.document.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('SEC-21–23: engine failures, paths and literals do not reach the webview or notifications', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dfv-host-sinks-'));
  const dir = join(root, `${SECRET}_dir`);
  await mkdir(dir);
  resetVscodeStub();
  const host = await openHost(await workbook(dir));
  try {
    await host.send({ command: 'ready' });
    const before = host.posted.length;
    for (const sql of [
      `select '${SECRET}'::integer`, `select * from "${SECRET}"`, `select "${SECRET}" from "Data · Table 1"`,
      `select * from read_csv('/${SECRET}/x.csv')`, `select 1 +`, `select error('${SECRET}')`,
      `select * from "Data · Table 1" where value = 1 and '${SECRET}' = 2`,
      `copy "Data · Table 1" to '/${SECRET}.csv'`,
    ]) {
      await host.send({ command: 'runQuery', sql });
      await host.send({ command: 'columnStats', sql, column: SECRET, statsKind: 'numeric' } as any);
      await host.send({ command: 'chartQuery', sql, xColumn: SECRET, xIsText: false, yColumns: [SECRET] } as any);
    }
    const sent = JSON.stringify(host.posted.slice(before));
    assert.ok(!sent.includes(SECRET), `sentinel reached the webview: ${sent.slice(sent.indexOf(SECRET) - 200, sent.indexOf(SECRET) + 50)}`);
    assert.ok(byCommand(host.posted.slice(before), 'error').length >= 8, 'failures were still reported');
    const notified = JSON.stringify(recorded.messages) + JSON.stringify(recorded.outputLines);
    assert.ok(!notified.includes(SECRET), 'sentinel reached a notification or output channel');
  } finally { host.document.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('SEC-24–26: an untrusted workspace refuses queries at execution time, with no native access', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-host-trust-'));
  const path = await workbook(dir);
  const bytes = await readFile(path);
  const workspace = vscodeStub.workspace as typeof vscodeStub.workspace & { isTrusted?: boolean };
  const prior = workspace.isTrusted;
  workspace.isTrusted = true;
  const host = await openHost(path);
  try {
    await host.send({ command: 'ready' });
    workspace.isTrusted = false;
    const before = host.posted.length;
    for (const message of [
      { command: 'runQuery', sql: 'select * from "Data · Table 1"' }, { command: 'queryCatalog' },
      { command: 'sheetTableQuery', table: 'Data · Table 1', filters: [], limit: 10 },
      { command: 'toggleSafeMode', safeMode: false, backupBeforeWrite: false, checkForChanges: false },
      { command: 'updateCell', column: 'value', rowValues: { id: 1, value: 'A1' }, newValue: 'X' },
    ]) await host.send(message);
    const after = host.posted.slice(before);
    assert.equal(byCommand(after, 'queryResult').length, 0);
    assert.equal(byCommand(after, 'queryCatalog').length, 0);
    assert.equal(byCommand(after, 'cellUpdated').length, 0);
    assert.ok(byCommand(after, 'error').every(m => /Trust this workspace/.test(String(m.message))));
    assert.deepEqual(await readFile(path), bytes, 'nothing was written while untrusted');
    // Restoring trust restores function (no permissive fallback while revoked).
    workspace.isTrusted = true;
    await host.send({ command: 'runQuery', sql: 'select count(*) from "Data · Table 1"' });
    assert.equal(String((byCommand(host.posted, 'queryResult').at(-1) as any).rows[0][0]), '50');
  } finally { workspace.isTrusted = prior; host.document.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('REL-16: a source replaced on disk invalidates targets; the old generation cannot run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-host-refresh-'));
  const path = join(dir, 'data.csv');
  await writeFile(path, 'id,value\n1,old\n');
  const host = await openHost(path);
  try {
    await host.send({ command: 'queryCatalog' });
    const cat = byCommand(host.posted, 'queryCatalog').at(-1) as any;
    await writeFile(path, 'id,value\n1,new\n2,new\n');
    await new Promise(r => setTimeout(r, 20));
    await host.send({ command: 'runQuery', sql: 'select count(*) from data' });
    const last = host.posted.at(-1)!;
    // Either the change is detected and refused, or the new bytes are read; never the stale row count.
    if (last.command === 'queryResult') assert.equal(String((last as any).rows[0][0]), '2');
    else assert.equal(last.command, 'error');
    await host.send({ command: 'queryCatalog' });
    const next = byCommand(host.posted, 'queryCatalog').at(-1) as any;
    if (next.generation !== cat.generation) {
      const before = host.posted.length;
      await host.send({ command: 'queryTarget', targetId: cat.targets[0].id, generation: cat.generation });
      assert.equal(byCommand(host.posted.slice(before), 'queryTargetDetails').length, 0);
    }
  } finally { host.document.dispose(); await rm(dir, { recursive: true, force: true }); }
});
