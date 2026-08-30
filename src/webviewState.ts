import type { StatsKind } from './gridFormat';
import type { SortState } from './gridOrder';

/**
 * The webview's data state, and the rules for moving it.
 *
 * webview.ts held 21 module-level `let`s and a 20-case message switch that
 * mutated them in among its DOM calls, so none of it could be tested -- and
 * several of those cases carry rules that are subtle, load-bearing and
 * commented precisely because they are not obvious. Three query results arrive
 * on three different messages and each one treats `sortState`, `totalRows`,
 * `serverSorted` and the scroll position DIFFERENTLY, on purpose. Getting one
 * of those crossed shows stale numbers under fresh rows, which nothing errors
 * about.
 *
 * The split is: this module decides what the state becomes and what the DOM
 * must be told; webview.ts still does every bit of the telling. Each case below
 * is the original body moved across with its reasoning intact, DOM calls
 * swapped for effect objects, and no logic changed.
 */

export type TableStatus = 'unchanged' | 'changed' | 'new';

export interface QueryResultFields {
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

export type LastResult = QueryResultFields;

export type ExtensionMessage =
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

export interface WebviewState {
  lastResult: LastResult | undefined;
  sortState: SortState | undefined;
  /** The query a pending row-count belongs to; see the rowTotal case. */
  awaitingTotalForSql: string | undefined;
  pinnedToBottom: boolean;
  liveEnabled: boolean;
  liveIntervalMs: number;
  liveLastUpdatedMs: number | undefined;
  liveStale: boolean;
  liveLastError: string | undefined;
}

export function initialState(): WebviewState {
  return {
    lastResult: undefined,
    sortState: undefined,
    awaitingTotalForSql: undefined,
    pinnedToBottom: true,
    liveEnabled: false,
    liveIntervalMs: 2000,
    liveLastUpdatedMs: undefined,
    liveStale: false,
    liveLastError: undefined,
  };
}

/**
 * What the DOM layer must do, in order.
 *
 * Deliberately a list of instructions rather than callbacks: a reducer that
 * took callbacks would be just as untestable as the switch it replaces, since
 * the assertions would all be about which function got called rather than what
 * was decided.
 */
export type Effect =
  | { kind: 'renderTables'; tables: string[]; combined: string[]; previewFirst: boolean }
  | { kind: 'setRunning'; value: boolean }
  | { kind: 'status'; text: string }
  | { kind: 'showError'; message: string }
  | { kind: 'render'; preserveScroll: boolean }
  | { kind: 'invalidateOrder' }
  | { kind: 'tableChangeStatus'; status: Record<string, TableStatus> }
  | { kind: 'safeModeState'; safeMode: boolean }
  | { kind: 'setLiveUi'; enabled: boolean }
  | { kind: 'setLiveIntervalInput'; intervalMs: number }
  | { kind: 'startLiveStatusTicker' }
  | { kind: 'updateLiveStatusText' }
  | { kind: 'liveRefreshRejected'; reason: string }
  | { kind: 'statsResult'; message: Extract<ExtensionMessage, { command: 'columnStatsResult' }> }
  | { kind: 'statsError'; column: string; message: string }
  | { kind: 'closeCellInspector' }
  | { kind: 'cellUpdateError'; column: string; message: string }
  | { kind: 'editStatus'; message: string };

export interface Reduced {
  state: WebviewState;
  effects: Effect[];
}

const READ_ONLY_NOTICE =
  'Live off — but this file is still open read-only, because another process holds the write lock. Editing stays disabled until it releases.';

function resultFrom(message: QueryResultFields, over: Partial<LastResult> = {}): LastResult {
  return {
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
    ...over,
  };
}

export function reduce(state: WebviewState, message: ExtensionMessage): Reduced {
  const next: WebviewState = { ...state };
  const effects: Effect[] = [];

  switch (message.command) {
    case 'tables':
      effects.push({
        kind: 'renderTables',
        tables: message.tables,
        combined: message.combinedTableNames,
        previewFirst: message.previewFirst === true,
      });
      break;

    case 'queryResult':
      next.lastResult = resultFrom(message, { serverSorted: false });
      next.sortState = undefined;
      // A brand-new query result (not a live tick re-running the same one)
      // always starts scrolled to the top — "pinned to bottom" only matters
      // once this same query starts live-ticking.
      next.pinnedToBottom = false;
      effects.push(
        { kind: 'setRunning', value: false },
        { kind: 'status', text: message.timeColumnWarning ?? '' },
        { kind: 'render', preserveScroll: false }
      );
      break;

    case 'rowTotal':
      // Late-arriving companion to the queryResult above. Ignored unless it
      // counted the query currently on screen — the user can run something
      // else while a count is still running, and a total from the previous
      // query under these rows would be worse than no total at all.
      if (state.lastResult && message.sql === state.awaitingTotalForSql) {
        next.lastResult = { ...state.lastResult, totalRows: message.total };
        effects.push({ kind: 'render', preserveScroll: false });
      }
      break;

    case 'sortQueryResult':
      next.lastResult = resultFrom(message, {
        // Sorting re-orders the same matching rows and re-applies the same
        // LIMIT, so the total is unchanged — carried across rather than
        // recomputed, which would re-run the count on every column click.
        totalRows: state.lastResult?.totalRows,
        // DuckDB ordered these across the full data set; computeDisplayOrder
        // must leave them exactly as they arrived.
        serverSorted: message.serverSorted ?? true,
      });
      // sortState is intentionally left as-is -- this response IS the result
      // of the sort that was just clicked, so the arrow icon must keep showing
      // it (unlike a fresh queryResult, which clears it above).
      effects.push(
        { kind: 'setRunning', value: false },
        { kind: 'status', text: '' },
        { kind: 'render', preserveScroll: false }
      );
      break;

    case 'error':
      effects.push(
        { kind: 'setRunning', value: false },
        { kind: 'status', text: '' },
        { kind: 'showError', message: message.message }
      );
      break;

    case 'backupStatus':
      effects.push({ kind: 'status', text: message.message });
      break;

    case 'tableChangeStatus':
      effects.push({ kind: 'tableChangeStatus', status: message.status });
      break;

    case 'safeModeState':
      effects.push({ kind: 'safeModeState', safeMode: message.safeMode });
      break;

    case 'liveRefreshStarted':
      next.liveEnabled = true;
      next.liveIntervalMs = message.intervalMs;
      next.liveLastUpdatedMs = undefined;
      next.liveStale = false;
      next.liveLastError = undefined;
      effects.push(
        { kind: 'setLiveUi', enabled: true },
        { kind: 'setLiveIntervalInput', intervalMs: message.intervalMs },
        { kind: 'startLiveStatusTicker' }
      );
      break;

    case 'liveRefreshStopped':
      next.liveEnabled = false;
      effects.push({ kind: 'setLiveUi', enabled: false });
      if (message.readOnly) {
        effects.push({ kind: 'status', text: READ_ONLY_NOTICE });
      }
      break;

    case 'liveRefreshRejected':
      effects.push(
        { kind: 'liveRefreshRejected', reason: message.reason },
        { kind: 'status', text: message.reason }
      );
      break;

    case 'liveRefreshIntervalSet':
      next.liveIntervalMs = message.intervalMs;
      effects.push({ kind: 'setLiveIntervalInput', intervalMs: message.intervalMs });
      break;

    case 'liveStatus':
      next.liveStale = message.stale;
      next.liveLastError = message.lastError;
      effects.push({ kind: 'updateLiveStatusText' });
      break;

    case 'liveTick':
      next.liveLastUpdatedMs = message.lastUpdatedMs;
      effects.push({ kind: 'updateLiveStatusText' });
      if (!message.unchanged && message.result) {
        next.lastResult = resultFrom(message.result, {
          // Deliberately NOT carried across. A live tick means the underlying
          // data just moved, so the previous total is exactly the number that
          // has stopped being true — the footer drops back to "N rows shown"
          // rather than asserting a stale one. Recounting every tick would
          // double the cost of the poll loop to state something that is
          // already about to change again.
          totalRows: undefined,
          // A live tick re-runs the user's own query, which carries whatever
          // ORDER BY they wrote but not the client-side sort — so any active
          // column sort still has to be applied here.
          serverSorted: false,
        });
        // preserve scroll position / pinned-bottom auto-follow — this is the
        // same ongoing query, not a fresh one.
        effects.push({ kind: 'render', preserveScroll: true });
      }
      break;

    case 'columnStatsResult':
      effects.push({ kind: 'statsResult', message });
      break;

    case 'columnStatsError':
      effects.push({ kind: 'statsError', column: message.column, message: message.message });
      break;

    case 'cellUpdated': {
      if (state.lastResult) {
        // Re-match by full-row equality (same principle used server-side),
        // robust to any client-side sort that happened between send and
        // receive — display order never matches the underlying row index.
        const result = state.lastResult;
        const colIdx = result.columns.indexOf(message.column);
        const rowIdx = result.rows.findIndex((row) =>
          result.columns.every((c, j) => {
            const expected = message.rowValues[c];
            return c === message.column ? true : row[j] === expected || (row[j] == null && expected == null);
          })
        );
        if (colIdx !== -1 && rowIdx !== -1) {
          result.rows[rowIdx][colIdx] = message.newValue;
          // Edited in place, so the rows array keeps its identity — the cached
          // permutation has to be dropped explicitly or an edit to the sort
          // column would leave the row sitting in its old position.
          effects.push({ kind: 'invalidateOrder' });
          if (result.cellChanged) {
            if (!result.cellChanged[rowIdx]) {
              result.cellChanged[rowIdx] = result.columns.map(() => false);
            }
            result.cellChanged[rowIdx][colIdx] = true;
          }
        }
      }
      effects.push({ kind: 'closeCellInspector' }, { kind: 'render', preserveScroll: false });
      break;
    }

    case 'cellUpdateError':
      effects.push({ kind: 'cellUpdateError', column: message.column, message: message.message });
      break;

    case 'editStatus':
      effects.push({ kind: 'editStatus', message: message.message });
      break;
  }

  return { state: next, effects };
}
