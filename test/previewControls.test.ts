import { vscodeStub, resetVscodeStub } from './stress/stubs/vscode';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDbFile } from '../src/duckdbConnection';
import { DuckDBDocument, DuckDBEditorProvider } from '../src/duckdbEditorProvider';
import { initialState, reduce, type ExtensionMessage } from '../src/webviewState';
import { plottableColumns } from '../src/chartSpec';
import { duckdbFile, xlsxFile } from './stress/generators/_write';

// Drive the real provider message handler, including the sidebar's preview
// marker, and consume its response with the same reducer as the webview.
async function harness(file: DuckDbFile, path: string) {
  resetVscodeStub();
  const document = new DuckDBDocument(vscodeStub.Uri.file(path) as any, file);
  const provider = new DuckDBEditorProvider({ extensionUri: vscodeStub.Uri.file(process.cwd()) } as any);
  let receive!: (message: any) => Promise<void>;
  const messages: any[] = [];
  const webview = {
    asWebviewUri: (uri: unknown) => uri,
    postMessage: (message: unknown) => { messages.push(message); return Promise.resolve(true); },
    onDidReceiveMessage: (handler: typeof receive) => { receive = handler; return { dispose() {} }; },
  };
  await provider.resolveCustomEditor(document, { webview, onDidDispose() {} } as any);
  const handler = receive;
  receive = async (message) => {
    await handler(message);
    // Row totals run after the result; drain them before closing the native connection.
    await document.runExclusive(async () => undefined);
  };
  async function query(table: string, preview = true) {
    messages.length = 0;
    await receive({ command: 'runQuery', sql: `SELECT * FROM "${table.replace(/"/g, '""')}" LIMIT 100;`,
      ...(preview ? { sheetPreview: table } : {}) });
    const result = messages.find(m => m.command === 'queryResult');
    assert.ok(result, JSON.stringify(messages));
    const state = reduce(initialState(), result as ExtensionMessage).state;
    assert.ok(state.lastResult);
    return state.lastResult;
  }
  return { document, query, receive, messages };
}

test('DuckDB sidebar previews keep normal controls through repeated selection, sorting and recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'preview-controls-'));
  const path = join(dir, 'merged_excel.duckdb');
  await duckdbFile(path, [
    { name: 'usdtry', columns: [{ name: 'Date', type: 'VARCHAR' }, { name: 'USDTRY', type: 'DOUBLE' }],
      rows: Array.from({ length: 122 }, (_, i) => [`2018-${i + 1}`, i]) },
    { name: 'sheet_metadata', columns: [{ name: 'table_name', type: 'VARCHAR' }], rows: [['usdtry']] },
    { name: 'empty', columns: [{ name: 'Date', type: 'VARCHAR' }, { name: 'value', type: 'DOUBLE' }], rows: [] },
  ]);
  const file = await DuckDbFile.open(path);
  try {
    const h = await harness(file, path);
    await h.receive({ command: 'ready' });
    assert.equal(h.messages.find(m => m.command === 'tables').previewFirst, true);
    for (let i = 0; i < 50; i++) {
      const table = i % 2 ? 'sheet_metadata' : 'usdtry';
      const result = await h.query(table);
      assert.equal(result.sheetTables, undefined, 'normal header controls must not be suppressed');
      assert.equal(h.document.lastSheetPreview, undefined);
      assert.deepEqual(plottableColumns(result.columns, result.columnStatsKind), table === 'usdtry' ? ['USDTRY'] : []);
    }
    assert.equal((await h.query('empty')).sheetTables, undefined);
    await h.query('usdtry');
    h.messages.length = 0;
    await h.receive({ command: 'sortQuery', column: 'USDTRY', direction: 'desc' });
    const sorted = h.messages.find(m => m.command === 'sortQueryResult');
    assert.ok(sorted);
    assert.equal(sorted.rows[0][1], 121, 'sort must reach beyond the first 100 rows');
    assert.equal(sorted.sheetTables, undefined);
    await h.receive({ command: 'runQuery', sql: 'SELECT * FROM missing_table', sheetPreview: 'missing_table' });
    assert.ok(h.messages.some(m => m.command === 'error'));
    assert.equal((await h.query('usdtry')).sheetTables, undefined);
    assert.equal((await h.query('usdtry', false)).sheetTables, undefined);
  } finally { file.dispose(); await rm(dir, { recursive: true, force: true }); }
});

for (const detection of ['grid', 'off'] as const) {
  test(`Excel ${detection}: only real worksheet previews suppress normal controls`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'preview-xlsx-'));
    const path = await xlsxFile(join(dir, 'book.xlsx'), [{ name: 'data', rows: [
      ['Date', 'Value'], ['2018-01', 1], ['2018-02', 2], ['2018-03', 3],
    ] }]);
    const file = await DuckDbFile.open(path, undefined, { sheetTables: detection });
    try {
      const h = await harness(file, path);
      const preview = await h.query('data');
      assert.ok(Array.isArray(preview.sheetTables));
      assert.equal(h.document.lastSheetPreview, 'data');
      if (detection === 'off') assert.deepEqual(preview.sheetTables, []);
      else {
        assert.ok(preview.sheetTables.length > 0);
        const derived = preview.sheetTables[0].name;
        assert.equal((await h.query(derived)).sheetTables, undefined, 'derived tables are not worksheets');
      }
      assert.equal((await h.query('data', false)).sheetTables, undefined);
      assert.equal(h.document.lastSheetPreview, undefined);
      assert.ok(Array.isArray((await h.query('data')).sheetTables));
    } finally { file.dispose(); await rm(dir, { recursive: true, force: true }); }
  });
}

test('CSV sidebar preview keeps normal header controls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'preview-csv-'));
  const path = join(dir, 'values.csv');
  await writeFile(path, 'Date,Value\n2018-01,1\n2018-02,2\n');
  const file = await DuckDbFile.open(path);
  try {
    const h = await harness(file, path);
    assert.equal((await h.query('values')).sheetTables, undefined);
  } finally { file.dispose(); await rm(dir, { recursive: true, force: true }); }
});
