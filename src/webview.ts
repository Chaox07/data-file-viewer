import { EditorView, basicSetup } from 'codemirror';
import { keymap } from '@codemirror/view';
import { sql } from '@codemirror/lang-sql';
import { json } from '@codemirror/lang-json';
import { oneDark } from '@codemirror/theme-one-dark';
import { computeSortOrder } from './sortOrder';

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
  truncated?: boolean;
  /** Rows the query matches ignoring its trailing LIMIT. Arrives after the rows. */
  totalRows?: number;
  editable: boolean;
  editableTable?: string;
  timeColumnWarning?: string;
  /** DuckDB already ordered these rows — see computeDisplayOrder, which must not re-sort them. */
  serverSorted?: boolean;
}

type ExtensionMessage =
  | { command: 'tables'; tables: string[]; combinedTableNames: string[]; previewFirst?: boolean }
  | ({ command: 'queryResult' } & QueryResultFields)
  | ({ command: 'sortQueryResult' } & QueryResultFields)
  | { command: 'rowTotal'; sql: string; total: number }
  | { command: 'error'; message: string }
  | { command: 'backupStatus'; message: string }
  | { command: 'tableChangeStatus'; status: Record<string, TableStatus> }
  | { command: 'safeModeState'; safeMode: boolean }
  | { command: 'liveRefreshStarted'; intervalMs: number; suggestedIntervalSeconds: number | null }
  | { command: 'liveRefreshStopped'; readOnly?: boolean }
  | { command: 'liveRefreshRejected'; reason: string }
  | { command: 'liveRefreshIntervalSet'; intervalMs: number }
  | ({ command: 'liveTick'; lastUpdatedMs: number; unchanged: boolean } & { result?: QueryResultFields })
  // Pushed on every transition by the host's scheduler, independent of whether
  // a tick produced anything. A failing tick posts no liveTick at all, so
  // carrying staleness on that message meant the flag was unreachable during
  // exactly the outage it describes.
  | {
      command: 'liveStatus';
      stale: boolean;
      failureCount: number;
      lastError?: string;
      lastSuccessMs?: number;
    }
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
  | { command: 'cellUpdateError'; column: string; message: string }
  | { command: 'editStatus'; message: string };

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
        <label id="safe-mode-label" class="toolbar-check" title="Blocks write/destructive statements until unchecked">
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
        <span class="toolbar-right">
          <label class="toolbar-radio" title="Static snapshot — re-run manually">
            <input type="radio" name="live-mode" id="mode-static-radio" checked /> Static
          </label>
          <label class="toolbar-radio" title="Re-run the current query automatically as the file changes">
            <input type="radio" name="live-mode" id="mode-live-radio" /> Live
          </label>
          <span id="live-options" hidden>
            every <input type="number" id="live-interval-input" min="0.25" step="0.25" value="2" title="Refresh interval, seconds" />s
          </span>
          <span id="live-status" class="live-status"></span>
        </span>
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
const safeModeLabel = document.getElementById('safe-mode-label') as HTMLLabelElement;
const backupCheck = document.getElementById('backup-check') as HTMLInputElement;
const checkChangesCheck = document.getElementById('check-changes-check') as HTMLInputElement;
const unlockOptionsEl = document.getElementById('unlock-options') as HTMLSpanElement;
const modeStaticRadio = document.getElementById('mode-static-radio') as HTMLInputElement;
const modeLiveRadio = document.getElementById('mode-live-radio') as HTMLInputElement;
const liveOptionsEl = document.getElementById('live-options') as HTMLSpanElement;
const liveIntervalInput = document.getElementById('live-interval-input') as HTMLInputElement;
const liveStatusEl = document.getElementById('live-status') as HTMLSpanElement;

let running = false;
let lastResult: LastResult | undefined;
/** The query whose row total is still in flight; see runQuery and the 'rowTotal' case. */
let awaitingTotalForSql: string | undefined;
let sortState: { columnIndex: number; direction: 'asc' | 'desc' } | undefined;
let combinedTableNames = new Set<string>();
let liveEnabled = false;
let liveLastUpdatedMs: number | undefined;
let liveStale = false;
let liveLastError: string | undefined;
let liveIntervalMs = 2000;
let liveStatusTicker: number | undefined;
// Sliding-tail scroll behavior for live combined views: only auto-follow
// new rows in (log-tail style) when the user was already at the bottom —
// otherwise a live tick would repeatedly yank someone inspecting history
// back down to the newest row.
let pinnedToBottom = true;

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
  // Remembered so a 'rowTotal' arriving late can be matched to the query it
  // counted -- it is computed after the rows are already on screen, and by
  // then the user may have run something else.
  awaitingTotalForSql = trimmed;
  vscode.postMessage({ command: 'runQuery', sql: trimmed });
}

function runCombinedQuery(baseTable: string): void {
  if (running) return;
  setRunning(true);
  statusEl.textContent = 'Running…';
  setEditorText(`-- combined hot+cold view of "${baseTable}" (synthesized, read-only)`);
  vscode.postMessage({ command: 'runCombinedQuery', table: baseTable });
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

function setLiveUiEnabled(enabled: boolean): void {
  liveEnabled = enabled;
  modeLiveRadio.checked = enabled;
  modeStaticRadio.checked = !enabled;
  liveOptionsEl.hidden = !enabled;
  // Mutually exclusive with Safe Mode in the UI, not just logically — a
  // live-refreshing view of a file another process is actively writing
  // isn't a sensible place to also be toggling backup/diff semantics, and
  // cell editing is locked out server-side regardless while live.
  safeModeLabel.hidden = enabled;
  unlockOptionsEl.hidden = enabled || safeModeCheck.checked;
  if (!enabled) {
    liveStatusEl.textContent = '';
    liveStatusEl.className = 'live-status';
    stopLiveStatusTicker();
  }
}

function stopLiveStatusTicker(): void {
  if (liveStatusTicker !== undefined) {
    window.clearInterval(liveStatusTicker);
    liveStatusTicker = undefined;
  }
}

function formatAgo(ms: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s ago`;
}

/**
 * Second, independent staleness signal, computed here rather than reported by
 * the host. The host's own `stale` flag can only arrive if the host is still
 * running its scheduler at all — so a wedged extension host is precisely the
 * case it cannot report. Time since the last successful update is observable
 * from this side no matter what happened over there.
 */
function isLocallyStale(): boolean {
  if (liveLastUpdatedMs === undefined) return false;
  return Date.now() - liveLastUpdatedMs > Math.max(3 * liveIntervalMs, 10_000);
}

function updateLiveStatusText(): void {
  if (!liveEnabled) return;
  const stale = liveStale || isLocallyStale();
  const agoText = liveLastUpdatedMs !== undefined ? `updated ${formatAgo(liveLastUpdatedMs)}` : 'waiting for first update…';
  liveStatusEl.textContent = stale ? `Live · stale, last ${agoText}` : `Live · ${agoText}`;
  liveStatusEl.className = `live-status ${stale ? 'live-status-stale' : 'live-status-active'}`;
  liveStatusEl.title = stale && liveLastError ? `Last error: ${liveLastError}` : '';
}

function startLiveStatusTicker(): void {
  stopLiveStatusTicker();
  updateLiveStatusText();
  // Purely a local display refresh for "updated Xs ago" — the actual data
  // refresh cadence is driven entirely by the extension host, independent
  // of this.
  liveStatusTicker = window.setInterval(updateLiveStatusText, 1000);
}

function sendToggleLiveRefresh(enabled: boolean): void {
  const intervalMs = Math.round(Number(liveIntervalInput.value || '2') * 1000);
  vscode.postMessage({ command: 'toggleLiveRefresh', enabled, intervalMs: enabled ? intervalMs : undefined });
}

modeLiveRadio.addEventListener('change', () => {
  if (modeLiveRadio.checked) sendToggleLiveRefresh(true);
});
modeStaticRadio.addEventListener('change', () => {
  if (modeStaticRadio.checked) {
    setLiveUiEnabled(false);
    sendToggleLiveRefresh(false);
  }
});

liveIntervalInput.addEventListener('change', () => {
  if (!liveEnabled) return;
  const intervalMs = Math.round(Number(liveIntervalInput.value || '2') * 1000);
  vscode.postMessage({ command: 'setLiveRefreshInterval', intervalMs });
});

// What clicking a table in the sidebar does. Named, rather than living inline
// in the click handler, so opening a file can run the SAME thing — an
// auto-preview that built its own query would be a second code path to keep in
// step with this one for no reason.
function previewTable(name: string): void {
  if (combinedTableNames.has(name)) {
    // Not a real table — a synthesized hot+cold union built server-side
    // (see duckdbConnection.ts's buildCombinedQuery); the extension
    // rebuilds and runs it directly rather than the usual
    // `SELECT * FROM "<name>"`, which wouldn't resolve to anything.
    const baseTable = name.slice(0, -'_combined'.length);
    runCombinedQuery(baseTable);
    return;
  }
  const sqlText = `SELECT * FROM "${name}" LIMIT 100;`;
  setEditorText(sqlText);
  runQuery(sqlText);
}

function renderTables(tables: string[], combined: string[], previewFirst = false): void {
  combinedTableNames = new Set(combined);
  tableListEl.innerHTML = '';
  for (const name of tables) {
    const item = document.createElement('div');
    item.className = 'table-item';
    item.textContent = name;
    item.dataset.table = name;
    item.addEventListener('click', () => previewTable(name));
    tableListEl.appendChild(item);
  }
  if (tables.length === 0) {
    tableListEl.innerHTML = '<div class="empty">No tables found.</div>';
  }
  // Show the first table straight away. For the single-table formats
  // (.parquet/.csv/.dta/.arrow/.arrows/.feather) there is exactly one entry
  // and clicking it was the only thing left to do; for a .duckdb or .xlsx the
  // first entry is the one the writer put first, which is the data rather than
  // its metadata.
  //
  // Safe to do unconditionally when enabled: this webview keeps no state
  // across reloads (there is no getState/setState anywhere in this file), so
  // there is never a hand-written query here to overwrite — the editor is
  // empty every time this message arrives.
  if (previewFirst && tables.length > 0) {
    previewTable(tables[0]);
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

/**
 * Thin wrapper over the shared ordering logic in sortOrder.ts: decides
 * *whether* to sort, which is webview state, and delegates *how* to sort,
 * which is pure and lives where it can be tested against DuckDB's own output.
 */
function computeDisplayOrder(): number[] {
  const result = lastResult!;
  const n = result.rows.length;
  // Already ordered by DuckDB across the full data set. Re-sorting here is not
  // just wasted work: where the client comparator disagrees with DuckDB's
  // ordering, it would scramble a correct top-N back into a wrong one.
  if (!sortState || result.serverSorted) return Array.from({ length: n }, (_, i) => i);
  return computeSortOrder(
    result.rows,
    sortState.columnIndex,
    sortState.direction,
    result.columnStatsKind[sortState.columnIndex]
  );
}

// Sorting the same rows the same way on every render is pure waste, and
// renderResults runs on every live tick.
let cachedOrder: { rows: unknown[][]; key: string; order: number[] } | undefined;

function displayOrder(): number[] {
  const result = lastResult!;
  const key = sortState && !result.serverSorted ? `${sortState.columnIndex}:${sortState.direction}` : '';
  if (cachedOrder && cachedOrder.rows === result.rows && cachedOrder.key === key) return cachedOrder.order;
  const order = computeDisplayOrder();
  cachedOrder = { rows: result.rows, key, order };
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
let pendingCellEdit: {
  rowIdx: number;
  colIdx: number;
  column: string;
  statusEl: HTMLSpanElement;
  saveBtn: HTMLButtonElement;
} | null = null;

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
      // The host serializes edits rather than dropping a second one, so a
      // double-click would otherwise send two updates and the second would
      // come back as "no matching row" against the row the first just changed.
      if (running || !lastResult || saveBtn.disabled) return;
      saveBtn.disabled = true;
      const text = inspectorEditor.state.doc.toString();
      // Empty input means NULL, not the literal empty string — matches how
      // NULL is already shown as literal text "NULL" elsewhere in the grid.
      const newValue = text === '' ? null : text;
      const rowValues: Record<string, unknown> = {};
      lastResult.columns.forEach((c, j) => {
        rowValues[c] = lastResult!.rows[rowIdx][j];
      });
      pendingCellEdit = { rowIdx, colIdx, column, statusEl: statusSpan, saveBtn };
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

// Windowed/virtualized rendering: above VIRTUALIZE_THRESHOLD rows, only the
// rows in (or just outside) the visible viewport get real <tr> DOM nodes —
// two spacer rows stand in for the skipped rows above/below, sized so the
// native scrollbar behaves as if every row were present. This matters most
// for a live view that can re-run every tick, and especially the combined
// hot+cold view where the result can hold real history.
const VIRTUALIZE_THRESHOLD = 200;
const VIRTUAL_OVERSCAN = 8;
let measuredRowHeight = 25; // corrected from a real rendered row below; this is just the initial estimate
// Signature of the header currently on screen — see the reuse check in renderResults.
let renderedHeaderKey: string | undefined;
let virtualState: { order: number[]; rowHeight: number } | undefined;
let virtualRenderScheduled = false;

function buildRowElement(i: number, displayIdx: number): HTMLTableRowElement {
  const { rows, cellChanged, rowIsNew, columnStatsKind } = lastResult!;
  const row = rows[i];
  const tr = document.createElement('tr');
  tr.className = displayIdx % 2 === 0 ? 'even' : 'odd';
  const isNewRow = rowIsNew?.[i] === true;
  if (isNewRow) tr.classList.add('row-new');
  row.forEach((value, j) => {
    const td = document.createElement('td');
    td.textContent = formatValue(value, columnStatsKind[j]);
    if (value === null || value === undefined) td.classList.add('cell-null');
    if (!isNewRow && cellChanged?.[i]?.[j]) td.classList.add('cell-changed');
    // Coordinates on the element, handled by one delegated listener below,
    // rather than a closure per cell: renderVirtualWindow rebuilds its window
    // on every scroll frame, so per-cell listeners meant thousands of closure
    // allocations per frame.
    td.dataset.r = String(i);
    td.dataset.c = String(j);
    tr.appendChild(td);
  });
  return tr;
}

function appendSpacerRow(tbody: HTMLTableSectionElement, heightPx: number, colCount: number): void {
  if (heightPx <= 0) return;
  const tr = document.createElement('tr');
  tr.className = 'spacer-row';
  tr.style.height = `${heightPx}px`;
  const td = document.createElement('td');
  td.colSpan = colCount;
  td.style.padding = '0';
  td.style.border = 'none';
  tr.appendChild(td);
  tbody.appendChild(tr);
}

function renderVirtualWindow(): void {
  if (!virtualState || !lastResult) return;
  const tbody = resultsEl.querySelector('tbody');
  if (!tbody) return;
  const { order, rowHeight } = virtualState;
  const scrollTop = resultsEl.scrollTop;
  const viewportH = resultsEl.clientHeight || 400;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - VIRTUAL_OVERSCAN);
  const end = Math.min(order.length, Math.ceil((scrollTop + viewportH) / rowHeight) + VIRTUAL_OVERSCAN);
  tbody.innerHTML = '';
  appendSpacerRow(tbody, start * rowHeight, lastResult.columns.length);
  const frag = document.createDocumentFragment();
  for (let displayIdx = start; displayIdx < end; displayIdx++) {
    frag.appendChild(buildRowElement(order[displayIdx], displayIdx));
  }
  tbody.appendChild(frag);
  appendSpacerRow(tbody, (order.length - end) * rowHeight, lastResult.columns.length);
}

// Delegated cell-inspector trigger. Attached to #results, which survives every
// re-render, so it covers rows that don't exist yet — including the ones the
// virtual window creates and destroys as you scroll.
resultsEl.addEventListener('dblclick', (e) => {
  const td = (e.target as HTMLElement | null)?.closest?.('td');
  if (!td || !resultsEl.contains(td)) return;
  const { r, c } = (td as HTMLTableCellElement).dataset;
  if (r === undefined || c === undefined) return;
  openCellInspector(Number(r), Number(c));
});

// Attached once, not per-render — renderResults() below fully rebuilds
// #results' contents on every call, which would orphan a listener declared
// there. Reads whatever `virtualState`/`lastResult` currently hold instead.
resultsEl.addEventListener('scroll', () => {
  // Pinned-to-bottom tracking for live mode's sliding tail window: only
  // auto-follow new rows in when the user was already at the bottom (log
  // tail/chat-scroll convention) — otherwise a live tick would repeatedly
  // yank someone inspecting history back down to the newest row.
  pinnedToBottom = resultsEl.scrollTop + resultsEl.clientHeight >= resultsEl.scrollHeight - 4;
  if (virtualRenderScheduled) return;
  virtualRenderScheduled = true;
  requestAnimationFrame(() => {
    virtualRenderScheduled = false;
    renderVirtualWindow();
  });
});

/**
 * `preserveScroll` is used for live ticks re-rendering the *same* ongoing
 * query — a fresh manual query/sort always starts scrolled to the top
 * (the default, `false`). Scroll position is preserved by raw pixel offset,
 * not by anchoring to a specific row's identity — a live tail's `LIMIT N`
 * window means the oldest visible row can drop out from under a fixed
 * index between ticks, so pixel-offset preservation is an approximation,
 * not a guarantee the exact same row stays under the cursor. Good enough
 * for the common case (a handful of new rows per tick); true identity-based
 * anchoring would be a further refinement.
 */
function renderResults(preserveScroll = false): void {
  const preservedScrollTop = preserveScroll ? resultsEl.scrollTop : 0;
  const wasPinnedToBottom = preserveScroll && pinnedToBottom;

  virtualState = undefined;
  if (!lastResult) {
    resultsEl.innerHTML = '';
    renderedHeaderKey = undefined;
    return;
  }
  const { columns, rows, cellChanged, rowIsNew, renamedColumns, columnStatsKind } = lastResult;

  if (columns.length === 0) {
    resultsEl.innerHTML = '<div class="empty">Query returned no columns.</div>';
    renderedHeaderKey = undefined;
    return;
  }

  // A live tick re-runs the same query, so the header is almost always
  // identical to the one already on screen. Rebuilding it anyway threw away
  // the sort/stats buttons several times a second — and with them the anchor
  // element an open stats popover positions against.
  const headerKey = JSON.stringify([columns, renamedColumns ?? null, sortState ?? null, columnStatsKind]);
  const existingTable = resultsEl.querySelector('table');
  const reuseHeader = preserveScroll && existingTable !== null && headerKey === renderedHeaderKey;

  if (reuseHeader) {
    renderRowsInto(existingTable, preservedScrollTop, wasPinnedToBottom);
    return;
  }

  resultsEl.innerHTML = '';
  renderedHeaderKey = headerKey;

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
      if (lastResult) lastResult.serverSorted = false;
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
  resultsEl.appendChild(table);

  renderRowsInto(table, preservedScrollTop, wasPinnedToBottom);
}

/** Thousands separators, so a six-figure row count is readable at a glance. */
function fmtCount(n: number): string {
  return n.toLocaleString();
}

/** Body + footer only. Split out so a live tick can refresh the rows under an untouched header. */
function renderRowsInto(table: HTMLTableElement, preservedScrollTop: number, wasPinnedToBottom: boolean): void {
  const { rows } = lastResult!;

  table.querySelector('tbody')?.remove();
  resultsEl.querySelector('.results-footer')?.remove();

  const tbody = document.createElement('tbody');
  const order = displayOrder();
  const useVirtual = order.length > VIRTUALIZE_THRESHOLD;

  if (!useVirtual) {
    const frag = document.createDocumentFragment();
    order.forEach((i, displayIdx) => frag.appendChild(buildRowElement(i, displayIdx)));
    tbody.appendChild(frag);
  } else {
    virtualState = { order, rowHeight: measuredRowHeight };
  }
  table.appendChild(tbody);

  const footer = document.createElement('div');
  footer.className = 'results-footer';
  // "146 rows shown" cannot say whether 146 IS the answer or merely where it
  // stopped — write `limit 200` against a 146-row table and you get the same
  // footer you would get if a million rows were waiting behind it. So the
  // total is spelled out even when the two match: "146 of 146" is redundant
  // only until it is the thing you needed to know.
  const total = lastResult!.totalRows;
  const shown = rows.length;
  footer.textContent =
    total === undefined
      ? `${fmtCount(shown)} row${shown === 1 ? '' : 's'} shown`
      : `${fmtCount(shown)} of ${fmtCount(total)} row${total === 1 ? '' : 's'} shown`;

  if (lastResult!.truncated) {
    // The count above is the whole story only when nothing was cut -- say so
    // explicitly, otherwise a capped result reads as the complete answer.
    const cap = document.createElement('span');
    cap.className = 'diff-skipped-note';
    cap.textContent = ' — capped by dataFileViewer.maxResultRows; there are more rows.';
    footer.appendChild(cap);
  }

  if (lastResult!.diffSkipped) {
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

  if (useVirtual) {
    resultsEl.scrollTop = preservedScrollTop;
    renderVirtualWindow();
    // Correct the row-height estimate from a real rendered row, now that
    // one exists, and re-render the window against the corrected value —
    // the initial constant is just a seed for the very first paint.
    const sample = tbody.querySelector('tr:not(.spacer-row)') as HTMLTableRowElement | null;
    if (sample) {
      const h = sample.getBoundingClientRect().height;
      if (h > 0 && Math.abs(h - measuredRowHeight) > 0.5) {
        measuredRowHeight = h;
        if (virtualState) virtualState.rowHeight = h;
        renderVirtualWindow();
      }
    }
    if (wasPinnedToBottom) resultsEl.scrollTop = resultsEl.scrollHeight;
  }
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
      renderTables(message.tables, message.combinedTableNames, message.previewFirst === true);
      break;
    case 'queryResult':
      setRunning(false);
      statusEl.textContent = message.timeColumnWarning ?? '';
      lastResult = {
        columns: message.columns,
        rows: message.rows,
        columnStatsKind: message.columnStatsKind,
        cellChanged: message.cellChanged,
        rowIsNew: message.rowIsNew,
        renamedColumns: message.renamedColumns,
        diffSkipped: message.diffSkipped,
        hasLimit: message.hasLimit,
        truncated: message.truncated,
        editable: message.editable,
        editableTable: message.editableTable,
        serverSorted: false,
      };
      sortState = undefined;
      // A brand-new query result (not a live tick re-running the same one)
      // always starts scrolled to the top — "pinned to bottom" only matters
      // once this same query starts live-ticking.
      pinnedToBottom = false;
      renderResults();
      break;
    case 'rowTotal':
      // Late-arriving companion to the queryResult above. Ignored unless it
      // counted the query currently on screen — the user can run something
      // else while a count is still running, and a total from the previous
      // query under these rows would be worse than no total at all.
      if (lastResult && message.sql === awaitingTotalForSql) {
        lastResult.totalRows = message.total;
        renderResults();
      }
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
        truncated: message.truncated,
        // Sorting re-orders the same matching rows and re-applies the same
        // LIMIT, so the total is unchanged — carried across rather than
        // recomputed, which would re-run the count on every column click.
        totalRows: lastResult?.totalRows,
        editable: message.editable,
        editableTable: message.editableTable,
        // DuckDB ordered these across the full data set; computeDisplayOrder
        // must leave them exactly as they arrived.
        serverSorted: message.serverSorted ?? true,
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
      unlockOptionsEl.hidden = message.safeMode || liveEnabled;
      break;
    case 'liveRefreshStarted':
      setLiveUiEnabled(true);
      liveIntervalMs = message.intervalMs;
      liveIntervalInput.value = String(message.intervalMs / 1000);
      liveLastUpdatedMs = undefined;
      liveStale = false;
      liveLastError = undefined;
      startLiveStatusTicker();
      break;
    case 'liveRefreshStopped':
      setLiveUiEnabled(false);
      if (message.readOnly) {
        statusEl.textContent =
          'Live off — but this file is still open read-only, because another process holds the write lock. Editing stays disabled until it releases.';
      }
      break;
    case 'liveRefreshRejected':
      modeStaticRadio.checked = true;
      modeLiveRadio.checked = false;
      statusEl.textContent = message.reason;
      break;
    case 'liveRefreshIntervalSet':
      liveIntervalMs = message.intervalMs;
      liveIntervalInput.value = String(message.intervalMs / 1000);
      break;
    case 'liveStatus':
      liveStale = message.stale;
      liveLastError = message.lastError;
      updateLiveStatusText();
      break;
    case 'liveTick':
      liveLastUpdatedMs = message.lastUpdatedMs;
      updateLiveStatusText();
      if (!message.unchanged && message.result) {
        const r = message.result;
        lastResult = {
          columns: r.columns,
          rows: r.rows,
          columnStatsKind: r.columnStatsKind,
          cellChanged: r.cellChanged,
          rowIsNew: r.rowIsNew,
          renamedColumns: r.renamedColumns,
          diffSkipped: r.diffSkipped,
          hasLimit: r.hasLimit,
          truncated: r.truncated,
          // Deliberately NOT carried across. A live tick means the underlying
          // data just moved, so the previous total is exactly the number that
          // has stopped being true — the footer drops back to "N rows shown"
          // rather than asserting a stale one. Recounting every tick would
          // double the cost of the poll loop to state something that is
          // already about to change again.
          editable: r.editable,
          editableTable: r.editableTable,
          // A live tick re-runs the user's own query, which carries whatever
          // ORDER BY they wrote but not the client-side sort — so any active
          // column sort still has to be applied here.
          serverSorted: false,
        };
        renderResults(true); // preserve scroll position / pinned-bottom auto-follow — this is the same ongoing query, not a fresh one
      }
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
          // Edited in place, so the rows array keeps its identity — the cached
          // permutation has to be dropped explicitly or an edit to the sort
          // column would leave the row sitting in its old position.
          cachedOrder = undefined;
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
        // Re-armed so a failed edit can be corrected and retried.
        pendingCellEdit.saveBtn.disabled = false;
      }
      break;
    case 'editStatus':
      if (pendingCellEdit) {
        pendingCellEdit.statusEl.textContent = message.message;
      }
      break;
  }
});

vscode.postMessage({ command: 'ready' });
