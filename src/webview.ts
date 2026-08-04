import { EditorView, basicSetup } from 'codemirror';
import { keymap } from '@codemirror/view';
import { sql } from '@codemirror/lang-sql';
import { json } from '@codemirror/lang-json';
import { oneDark } from '@codemirror/theme-one-dark';

interface VsCodeApi {
  postMessage(message: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

type TableStatus = 'unchanged' | 'changed' | 'new';
type StatsKind = 'numeric' | 'datetime' | 'other';

interface QueryResultFields {
  columns: string[];
  rows: unknown[][];
  columnStatsKind: StatsKind[];
  cellChanged?: boolean[][];
  rowIsNew?: boolean[];
  renamedColumns?: Record<string, string>;
  diffSkipped: boolean;
  hasLimit: boolean;
  editable: boolean;
  editableTable?: string;
}

type ExtensionMessage =
  | { command: 'tables'; tables: string[] }
  | ({ command: 'queryResult' } & QueryResultFields)
  | ({ command: 'sortQueryResult' } & QueryResultFields)
  | { command: 'error'; message: string }
  | { command: 'backupStatus'; message: string }
  | { command: 'tableChangeStatus'; status: Record<string, TableStatus> }
  | { command: 'safeModeState'; safeMode: boolean }
  | {
      command: 'columnStatsResult';
      column: string;
      statsKind: StatsKind;
      totalRows: number;
      nonNullRows: number;
      nullCount: number;
      distinctCount?: number;
      topValues?: { value: unknown; frequency: number }[];
      min?: unknown;
      max?: unknown;
      mean?: unknown;
      p5?: unknown;
      p95?: unknown;
    }
  | { command: 'columnStatsError'; column: string; message: string }
  | { command: 'cellUpdated'; column: string; newValue: unknown; rowValues: Record<string, unknown>; rowsMatched: number }
  | { command: 'cellUpdateError'; column: string; message: string };

type LastResult = QueryResultFields;

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
        <label class="toolbar-check" title="Blocks write/destructive statements until unchecked">
          <input type="checkbox" id="safe-mode-check" checked /> Safe Mode
        </label>
        <span id="unlock-options" class="unlock-options" hidden>
          <label class="toolbar-check" title="Back up the file the moment Safe Mode is turned off">
            <input type="checkbox" id="backup-check" checked /> Backup on unlock
          </label>
          <label class="toolbar-check" title="Compare against the backup and highlight what changed">
            <input type="checkbox" id="check-changes-check" checked /> Check for changes
          </label>
        </span>
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
const safeModeCheck = document.getElementById('safe-mode-check') as HTMLInputElement;
const backupCheck = document.getElementById('backup-check') as HTMLInputElement;
const checkChangesCheck = document.getElementById('check-changes-check') as HTMLInputElement;
const unlockOptionsEl = document.getElementById('unlock-options') as HTMLSpanElement;

let running = false;
let lastResult: LastResult | undefined;
let sortState: { columnIndex: number; direction: 'asc' | 'desc' } | undefined;

function setRunning(value: boolean): void {
  running = value;
  // Stays enabled and turns into a Cancel button while running, rather than
  // being disabled — a runaway query otherwise has no escape hatch short of
  // closing the tab.
  runBtn.textContent = value ? 'Cancel ■' : 'Run ▶';
  runBtn.classList.toggle('run-btn-cancel', value);
  // Disables sort/stats/cell-edit affordances too (via pointer-events),
  // rather than letting a click sent mid-query silently no-op on the host
  // side and leave e.g. a stats popover stuck on "Loading…" forever.
  resultsEl.classList.toggle('busy', value);
}

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
  setRunning(true);
  statusEl.textContent = 'Running…';
  vscode.postMessage({ command: 'runQuery', sql: trimmed });
}

runBtn.addEventListener('click', () => {
  if (running) {
    vscode.postMessage({ command: 'cancelQuery' });
  } else {
    runQuery(editor.state.doc.toString());
  }
});

function sendToggleSafeMode(): void {
  unlockOptionsEl.hidden = safeModeCheck.checked;
  vscode.postMessage({
    command: 'toggleSafeMode',
    safeMode: safeModeCheck.checked,
    backupBeforeWrite: backupCheck.checked,
    checkForChanges: checkChangesCheck.checked,
  });
}

safeModeCheck.addEventListener('change', sendToggleSafeMode);
backupCheck.addEventListener('change', sendToggleSafeMode);
checkChangesCheck.addEventListener('change', sendToggleSafeMode);

function renderTables(tables: string[]): void {
  tableListEl.innerHTML = '';
  for (const name of tables) {
    const item = document.createElement('div');
    item.className = 'table-item';
    item.textContent = name;
    item.dataset.table = name;
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

function applyTableChangeStatus(status: Record<string, TableStatus>): void {
  const items = tableListEl.querySelectorAll<HTMLDivElement>('.table-item');
  items.forEach((item) => {
    const name = item.dataset.table;
    if (!name) return;
    const s = status[name];
    if (s === 'unchanged') item.textContent = `${name} (unchanged)`;
    else if (s === 'changed') item.textContent = `${name} (changed)`;
    else if (s === 'new') item.textContent = `${name} (new since backup)`;
    else item.textContent = name;
  });
}

/** Value-to-string used for the sort fallback and JSON-detection — distinct
 *  from formatValue (display) since it needs to be collision-resistant for
 *  ordering (JSON.stringify for objects, not the raw "[object Object]"
 *  String() would produce). */
function sortableString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Permutation of original row indices — never physically reorders
 *  rows/cellChanged/rowIsNew, so every array stays indexed by the same
 *  original row index and diff-highlighting alignment is structural, not
 *  something that has to be hand-maintained across a sort. */
function computeDisplayOrder(): number[] {
  const n = lastResult!.rows.length;
  const order = Array.from({ length: n }, (_, i) => i);
  if (!sortState) return order;
  const { columnIndex, direction } = sortState;
  const rows = lastResult!.rows;
  order.sort((a, b) => {
    const va = rows[a][columnIndex];
    const vb = rows[b][columnIndex];
    const aNull = va === null || va === undefined;
    const bNull = vb === null || vb === undefined;
    if (aNull && bNull) return 0;
    if (aNull) return 1; // nulls always last, regardless of direction
    if (bNull) return -1;
    let cmp: number;
    if (typeof va === 'bigint' && typeof vb === 'bigint') {
      cmp = va < vb ? -1 : va > vb ? 1 : 0;
    } else if (typeof va === 'number' && typeof vb === 'number') {
      cmp = Number.isNaN(va) && Number.isNaN(vb) ? 0 : Number.isNaN(va) ? 1 : Number.isNaN(vb) ? -1 : va - vb;
    } else {
      const sa = sortableString(va);
      const sb = sortableString(vb);
      cmp = sa < sb ? -1 : sa > sb ? 1 : 0;
    }
    return direction === 'asc' ? cmp : -cmp;
  });
  return order;
}

function renderStatsPopoverContent(container: HTMLElement, message: Extract<ExtensionMessage, { command: 'columnStatsResult' }>): void {
  container.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'stats-title';
  title.textContent = message.column;
  container.appendChild(title);

  if (message.totalRows === 0) {
    const empty = document.createElement('div');
    empty.className = 'stats-empty';
    empty.textContent = 'No data.';
    container.appendChild(empty);
    return;
  }
  if (message.nonNullRows === 0) {
    const empty = document.createElement('div');
    empty.className = 'stats-empty';
    empty.textContent = `All ${message.totalRows} value${message.totalRows === 1 ? '' : 's'} are NULL.`;
    container.appendChild(empty);
    return;
  }

  const summary = document.createElement('div');
  summary.className = 'stats-summary';
  summary.textContent = `${message.nonNullRows} of ${message.totalRows} rows non-null (${message.nullCount} null)`;
  container.appendChild(summary);

  if (message.statsKind === 'other') {
    const distinct = document.createElement('div');
    distinct.className = 'stats-summary';
    distinct.textContent = `${message.distinctCount ?? 0} distinct value${message.distinctCount === 1 ? '' : 's'}`;
    container.appendChild(distinct);

    const list = document.createElement('div');
    list.className = 'stats-top-values';
    for (const { value, frequency } of message.topValues ?? []) {
      const row = document.createElement('div');
      row.className = 'stats-top-value-row';
      const val = document.createElement('span');
      val.className = 'stats-top-value';
      val.textContent = formatValue(value, message.statsKind);
      const freq = document.createElement('span');
      freq.className = 'stats-top-freq';
      freq.textContent = String(frequency);
      row.appendChild(val);
      row.appendChild(freq);
      list.appendChild(row);
    }
    container.appendChild(list);
  } else {
    const rows: [string, unknown][] = [
      ['min', message.min],
      ['max', message.max],
      ['avg', message.mean],
      ['p5 (approx.)', message.p5],
      ['p95 (approx.)', message.p95],
    ];
    const table = document.createElement('div');
    table.className = 'stats-descriptive';
    for (const [label, value] of rows) {
      const row = document.createElement('div');
      row.className = 'stats-descriptive-row';
      const l = document.createElement('span');
      l.className = 'stats-descriptive-label';
      l.textContent = label;
      const v = document.createElement('span');
      v.className = 'stats-descriptive-value';
      v.textContent = formatValue(value, message.statsKind);
      row.appendChild(l);
      row.appendChild(v);
      table.appendChild(row);
    }
    container.appendChild(table);
  }
}

let statsPopoverEl: HTMLDivElement | null = null;
let pendingStatsColumn: string | null = null;
let pendingStatsAnchor: HTMLElement | null = null;

function closeStatsPopover(): void {
  statsPopoverEl?.remove();
  statsPopoverEl = null;
  pendingStatsColumn = null;
  pendingStatsAnchor = null;
}

// The popover's size changes once real content replaces the "Loading…"
// placeholder, so this is called both right after opening (rough initial
// placement) and again once the final content is rendered (correct
// placement) -- a single up-front clamp using the small placeholder's size
// would let a wide/tall result overflow again after it loads.
function positionPopover(popover: HTMLElement, anchor: HTMLElement): void {
  const anchorRect = anchor.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();

  let left = anchorRect.left;
  if (left + popRect.width > window.innerWidth) {
    left = anchorRect.right - popRect.width;
  }
  left = Math.max(0, left);

  let top = anchorRect.bottom + 4;
  if (top + popRect.height > window.innerHeight) {
    top = anchorRect.top - popRect.height - 4;
  }
  top = Math.max(0, top);

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

function openStatsPopover(anchor: HTMLElement, column: string, statsKind: StatsKind): void {
  if (running) return;
  closeStatsPopover();
  closeCellInspector();

  const popover = document.createElement('div');
  popover.className = 'stats-popover';
  popover.innerHTML = '<div class="stats-loading">Loading…</div>';
  document.body.appendChild(popover);
  positionPopover(popover, anchor);
  statsPopoverEl = popover;
  pendingStatsColumn = column;
  pendingStatsAnchor = anchor;

  const closeOnOutsideClick = (e: MouseEvent) => {
    if (statsPopoverEl && !statsPopoverEl.contains(e.target as Node)) {
      closeStatsPopover();
      document.removeEventListener('click', closeOnOutsideClick, true);
    }
  };
  setTimeout(() => document.addEventListener('click', closeOnOutsideClick, true), 0);

  vscode.postMessage({ command: 'columnStats', column, statsKind, limit: 20 });
}

let inspectorCleanup: (() => void) | null = null;
let pendingCellEdit: { rowIdx: number; colIdx: number; column: string; statusEl: HTMLSpanElement } | null = null;

function closeCellInspector(): void {
  inspectorCleanup?.();
  inspectorCleanup = null;
  pendingCellEdit = null;
}

function openCellInspector(rowIdx: number, colIdx: number): void {
  if (!lastResult || running) return;
  closeStatsPopover();
  closeCellInspector();

  const column = lastResult.columns[colIdx];
  const value = lastResult.rows[rowIdx][colIdx];
  const canEdit = lastResult.editable && !safeModeCheck.checked;

  const isObjectValue = typeof value === 'object' && value !== null;
  let jsonParsed: unknown;
  let looksLikeJson = false;
  if (!isObjectValue && typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        jsonParsed = JSON.parse(trimmed);
        looksLikeJson = true;
      } catch {
        // Not actually JSON — fall through to plain text display.
      }
    }
  }
  const isNullValue = value === null || value === undefined;
  const displayText = isNullValue
    ? ''
    : isObjectValue
      ? JSON.stringify(value, null, 2)
      : looksLikeJson
        ? JSON.stringify(jsonParsed, null, 2)
        : String(value);
  const useJsonLang = isObjectValue || looksLikeJson;

  const backdrop = document.createElement('div');
  backdrop.className = 'cell-inspector-backdrop';
  const panel = document.createElement('div');
  panel.className = 'cell-inspector-panel';

  const header = document.createElement('div');
  header.className = 'cell-inspector-header';
  const title = document.createElement('span');
  title.textContent = column;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'cell-inspector-close';
  closeBtn.textContent = '×';
  closeBtn.title = 'Close';
  closeBtn.addEventListener('click', closeCellInspector);
  header.appendChild(title);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const body = document.createElement('div');
  body.className = 'cell-inspector-body';
  panel.appendChild(body);

  const editorExtensions = [basicSetup, oneDark, EditorView.lineWrapping];
  if (useJsonLang) editorExtensions.push(json());
  if (!canEdit) editorExtensions.push(EditorView.editable.of(false));

  const inspectorEditor = new EditorView({
    doc: displayText,
    extensions: editorExtensions,
    parent: body,
  });

  const footer = document.createElement('div');
  footer.className = 'cell-inspector-footer';

  if (canEdit) {
    const nullBtn = document.createElement('button');
    nullBtn.className = 'cell-inspector-secondary';
    nullBtn.textContent = 'Set NULL';
    nullBtn.addEventListener('click', () => {
      inspectorEditor.dispatch({ changes: { from: 0, to: inspectorEditor.state.doc.length, insert: '' } });
    });

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    const statusSpan = document.createElement('span');
    statusSpan.className = 'cell-inspector-status';

    saveBtn.addEventListener('click', () => {
      if (running || !lastResult) return;
      const text = inspectorEditor.state.doc.toString();
      // Empty input means NULL, not the literal empty string — matches how
      // NULL is already shown as literal text "NULL" elsewhere in the grid.
      const newValue = text === '' ? null : text;
      const rowValues: Record<string, unknown> = {};
      lastResult.columns.forEach((c, j) => {
        rowValues[c] = lastResult!.rows[rowIdx][j];
      });
      pendingCellEdit = { rowIdx, colIdx, column, statusEl: statusSpan };
      statusSpan.textContent = 'Saving…';
      vscode.postMessage({ command: 'updateCell', column, newValue, rowValues });
    });

    footer.appendChild(nullBtn);
    footer.appendChild(saveBtn);
    footer.appendChild(statusSpan);
  } else {
    const note = document.createElement('span');
    note.className = 'cell-inspector-note';
    note.textContent = !lastResult.editable
      ? "View only — this result isn't a plain single-table SELECT, so it can't be edited."
      : 'View only — uncheck Safe Mode to edit.';
    footer.appendChild(note);
  }
  panel.appendChild(footer);

  backdrop.appendChild(panel);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) closeCellInspector();
  });
  document.body.appendChild(backdrop);

  inspectorCleanup = () => {
    inspectorEditor.destroy();
    backdrop.remove();
  };
}

function renderResults(): void {
  resultsEl.innerHTML = '';
  if (!lastResult) return;
  const { columns, rows, cellChanged, rowIsNew, renamedColumns, columnStatsKind } = lastResult;

  if (columns.length === 0) {
    resultsEl.innerHTML = '<div class="empty">Query returned no columns.</div>';
    return;
  }

  const table = document.createElement('table');

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  columns.forEach((col, colIdx) => {
    const th = document.createElement('th');
    // display:flex has to live on this inner wrapper, not on <th> itself --
    // see the .th-inner comment in main.css for why.
    const inner = document.createElement('span');
    inner.className = 'th-inner';
    const label = document.createElement('span');
    label.className = 'th-label';
    label.textContent = col;
    const renamedFrom = renamedColumns?.[col];
    if (renamedFrom) {
      th.title = `renamed from "${renamedFrom}"`;
      th.classList.add('col-renamed');
    }
    inner.appendChild(label);

    const controls = document.createElement('span');
    controls.className = 'th-controls';

    const isActiveSort = sortState?.columnIndex === colIdx;
    const sortBtn = document.createElement('button');
    sortBtn.className = 'th-sort-btn';
    sortBtn.classList.toggle('th-sort-btn-active', isActiveSort);
    sortBtn.textContent = isActiveSort ? (sortState!.direction === 'asc' ? '▲' : '▼') : '⇅';
    sortBtn.title = isActiveSort
      ? `Sorted ${sortState!.direction === 'asc' ? 'ascending' : 'descending'} — click to reverse`
      : 'Sort ascending';
    sortBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (running) return;
      const direction = isActiveSort && sortState!.direction === 'asc' ? 'desc' : 'asc';
      sortState = { columnIndex: colIdx, direction };
      if (lastResult?.hasLimit) {
        // A LIMIT-ed result can't be correctly re-sorted from just the rows
        // already in memory (see hasLimit's origin in duckdbConnection.ts) --
        // ask the host to re-run the query sorted against the full data.
        setRunning(true);
        statusEl.textContent = 'Sorting…';
        vscode.postMessage({ command: 'sortQuery', column: col, direction });
      } else {
        renderResults();
      }
    });

    const statsBtn = document.createElement('button');
    statsBtn.className = 'th-stats-btn';
    statsBtn.textContent = '≡';
    statsBtn.title = columnStatsKind[colIdx] === 'other' ? 'Top values' : 'Descriptive stats';
    statsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openStatsPopover(statsBtn, col, columnStatsKind[colIdx]);
    });

    controls.appendChild(sortBtn);
    controls.appendChild(statsBtn);
    inner.appendChild(controls);
    th.appendChild(inner);
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  const rowsFragment = document.createDocumentFragment();
  const order = computeDisplayOrder();
  order.forEach((i, displayIdx) => {
    const row = rows[i];
    const tr = document.createElement('tr');
    tr.className = displayIdx % 2 === 0 ? 'even' : 'odd';
    const isNewRow = rowIsNew?.[i] === true;
    if (isNewRow) tr.classList.add('row-new');
    row.forEach((value, j) => {
      const td = document.createElement('td');
      td.textContent = formatValue(value, columnStatsKind[j]);
      if (!isNewRow && cellChanged?.[i]?.[j]) {
        td.classList.add('cell-changed');
      }
      td.addEventListener('dblclick', () => openCellInspector(i, j));
      tr.appendChild(td);
    });
    rowsFragment.appendChild(tr);
  });
  tbody.appendChild(rowsFragment);
  table.appendChild(tbody);
  resultsEl.appendChild(table);

  const footer = document.createElement('div');
  footer.className = 'results-footer';
  footer.textContent = `${rows.length} row${rows.length === 1 ? '' : 's'} shown`;

  if (lastResult.diffSkipped) {
    const note = document.createElement('span');
    note.className = 'diff-skipped-note';
    note.textContent = ' — result too large to auto-diff against the backup.';
    const diffBtn = document.createElement('button');
    diffBtn.className = 'diff-anyway-btn';
    diffBtn.textContent = 'Diff anyway';
    diffBtn.addEventListener('click', () => {
      if (running) return;
      setRunning(true);
      statusEl.textContent = 'Diffing…';
      vscode.postMessage({ command: 'diffQuery' });
    });
    note.appendChild(diffBtn);
    footer.appendChild(note);
  }

  resultsEl.appendChild(footer);
}

function addThousandsSeparators(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// DuckDB's node-api serializes BIGINT/HUGEINT/DECIMAL/TIMESTAMP/DATE all as
// plain strings over the wire (only the small int types and float/double
// come through as JS numbers) -- so a string alone can't tell numeric values
// apart from dates. `kind` (from columnStatsKind, computed server-side from
// the actual DuckDB type) is what disambiguates. Formatting is done by
// string manipulation, not toLocaleString(), so it never rounds/truncates
// the value's original precision.
function formatValue(value: unknown, kind?: StatsKind): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  if (kind === 'numeric' && (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string')) {
    const match = String(value).match(/^(-?)(\d+)(\.\d+)?$/);
    if (match) {
      const [, sign, intPart, fracPart = ''] = match;
      return `${sign}${addThousandsSeparators(intPart)}${fracPart}`;
    }
  }
  return String(value);
}

function showError(message: string): void {
  resultsEl.innerHTML = '';
  lastResult = undefined;
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
      setRunning(false);
      statusEl.textContent = '';
      lastResult = {
        columns: message.columns,
        rows: message.rows,
        columnStatsKind: message.columnStatsKind,
        cellChanged: message.cellChanged,
        rowIsNew: message.rowIsNew,
        renamedColumns: message.renamedColumns,
        diffSkipped: message.diffSkipped,
        hasLimit: message.hasLimit,
        editable: message.editable,
        editableTable: message.editableTable,
      };
      sortState = undefined;
      renderResults();
      break;
    case 'sortQueryResult':
      setRunning(false);
      statusEl.textContent = '';
      lastResult = {
        columns: message.columns,
        rows: message.rows,
        columnStatsKind: message.columnStatsKind,
        cellChanged: message.cellChanged,
        rowIsNew: message.rowIsNew,
        renamedColumns: message.renamedColumns,
        diffSkipped: message.diffSkipped,
        hasLimit: message.hasLimit,
        editable: message.editable,
        editableTable: message.editableTable,
      };
      // sortState is intentionally left as-is -- this response IS the
      // result of the sort that was just clicked, so the arrow icon must
      // keep showing it (unlike a fresh runQuery, which clears it above).
      renderResults();
      break;
    case 'error':
      setRunning(false);
      statusEl.textContent = '';
      showError(message.message);
      break;
    case 'backupStatus':
      statusEl.textContent = message.message;
      break;
    case 'tableChangeStatus':
      applyTableChangeStatus(message.status);
      break;
    case 'safeModeState':
      safeModeCheck.checked = message.safeMode;
      unlockOptionsEl.hidden = message.safeMode;
      break;
    case 'columnStatsResult':
      if (statsPopoverEl && pendingStatsColumn === message.column) {
        renderStatsPopoverContent(statsPopoverEl, message);
        if (pendingStatsAnchor) positionPopover(statsPopoverEl, pendingStatsAnchor);
      }
      break;
    case 'columnStatsError':
      if (statsPopoverEl && pendingStatsColumn === message.column) {
        statsPopoverEl.innerHTML = '';
        const el = document.createElement('div');
        el.className = 'stats-empty';
        el.textContent = message.message;
        statsPopoverEl.appendChild(el);
        if (pendingStatsAnchor) positionPopover(statsPopoverEl, pendingStatsAnchor);
      }
      break;
    case 'cellUpdated':
      if (lastResult) {
        // Re-match by full-row equality (same principle used server-side),
        // robust to any client-side sort that happened between send and
        // receive — display order never matches the underlying row index.
        const colIdx = lastResult.columns.indexOf(message.column);
        const rowIdx = lastResult.rows.findIndex((row) =>
          lastResult!.columns.every((c, j) => {
            const expected = message.rowValues[c];
            return c === message.column ? true : row[j] === expected || (row[j] == null && expected == null);
          })
        );
        if (colIdx !== -1 && rowIdx !== -1) {
          lastResult.rows[rowIdx][colIdx] = message.newValue;
          if (lastResult.cellChanged) {
            if (!lastResult.cellChanged[rowIdx]) {
              lastResult.cellChanged[rowIdx] = lastResult.columns.map(() => false);
            }
            lastResult.cellChanged[rowIdx][colIdx] = true;
          }
        }
      }
      closeCellInspector();
      renderResults();
      break;
    case 'cellUpdateError':
      if (pendingCellEdit && pendingCellEdit.column === message.column) {
        pendingCellEdit.statusEl.textContent = message.message;
      }
      break;
  }
});

vscode.postMessage({ command: 'ready' });
