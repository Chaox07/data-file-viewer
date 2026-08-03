import { EditorView, basicSetup } from 'codemirror';
import { keymap } from '@codemirror/view';
import { sql } from '@codemirror/lang-sql';
import { oneDark } from '@codemirror/theme-one-dark';

interface VsCodeApi {
  postMessage(message: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

type ExtensionMessage =
  | { command: 'tables'; tables: string[] }
  | { command: 'queryResult'; columns: string[]; rows: unknown[][] }
  | { command: 'error'; message: string };

const vscode = acquireVsCodeApi();

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');

root.innerHTML = `
  <div class="layout">
    <div class="sidebar">
      <div class="sidebar-title">Tables</div>
      <div id="table-list" class="table-list"></div>
    </div>
    <div class="main">
      <div class="editor-toolbar">
        <button id="run-btn" title="Run (Ctrl/Cmd+Enter)">Run &#9654;</button>
        <span id="status" class="status"></span>
      </div>
      <div id="editor" class="editor"></div>
      <div id="results" class="results"></div>
    </div>
  </div>
`;

const tableListEl = document.getElementById('table-list') as HTMLDivElement;
const resultsEl = document.getElementById('results') as HTMLDivElement;
const statusEl = document.getElementById('status') as HTMLSpanElement;
const runBtn = document.getElementById('run-btn') as HTMLButtonElement;

let running = false;

// One Dark's default selection color is a muted gray-blue; override with a
// more classic, clearly-blue selection highlight. Applied after oneDark in
// the extensions array so its stylesheet wins on the shared selector.
const selectionColor = EditorView.theme({
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: '#3390ff !important',
  },
});

const runKeymap = keymap.of([
  {
    key: 'Mod-Enter',
    run: () => {
      runQuery(editor.state.doc.toString());
      return true;
    },
  },
]);

const editor = new EditorView({
  doc: '',
  extensions: [basicSetup, sql(), runKeymap, oneDark, selectionColor],
  parent: document.getElementById('editor') as HTMLDivElement,
});

function setEditorText(text: string): void {
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: text },
  });
}

function runQuery(sqlText: string): void {
  if (running) return;
  const trimmed = sqlText.trim();
  if (!trimmed) return;
  running = true;
  runBtn.disabled = true;
  statusEl.textContent = 'Running…';
  vscode.postMessage({ command: 'runQuery', sql: trimmed });
}

runBtn.addEventListener('click', () => runQuery(editor.state.doc.toString()));

function renderTables(tables: string[]): void {
  tableListEl.innerHTML = '';
  for (const name of tables) {
    const item = document.createElement('div');
    item.className = 'table-item';
    item.textContent = name;
    item.addEventListener('click', () => {
      const sqlText = `SELECT * FROM "${name}" LIMIT 100;`;
      setEditorText(sqlText);
      runQuery(sqlText);
    });
    tableListEl.appendChild(item);
  }
  if (tables.length === 0) {
    tableListEl.innerHTML = '<div class="empty">No tables found.</div>';
  }
}

function renderResults(columns: string[], rows: unknown[][]): void {
  resultsEl.innerHTML = '';

  if (columns.length === 0) {
    resultsEl.innerHTML = '<div class="empty">Query returned no columns.</div>';
    return;
  }

  const table = document.createElement('table');

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const col of columns) {
    const th = document.createElement('th');
    th.textContent = col;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach((row, i) => {
    const tr = document.createElement('tr');
    tr.className = i % 2 === 0 ? 'even' : 'odd';
    for (const value of row) {
      const td = document.createElement('td');
      td.textContent = formatValue(value);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  resultsEl.appendChild(table);

  const footer = document.createElement('div');
  footer.className = 'results-footer';
  footer.textContent = `${rows.length} row${rows.length === 1 ? '' : 's'} shown`;
  resultsEl.appendChild(footer);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function showError(message: string): void {
  resultsEl.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'error';
  el.textContent = message;
  resultsEl.appendChild(el);
}

window.addEventListener('message', (event: MessageEvent<ExtensionMessage>) => {
  const message = event.data;
  switch (message.command) {
    case 'tables':
      renderTables(message.tables);
      break;
    case 'queryResult':
      running = false;
      runBtn.disabled = false;
      statusEl.textContent = '';
      renderResults(message.columns, message.rows);
      break;
    case 'error':
      running = false;
      runBtn.disabled = false;
      statusEl.textContent = '';
      showError(message.message);
      break;
  }
});

vscode.postMessage({ command: 'ready' });
