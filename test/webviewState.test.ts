import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type Effect,
  type ExtensionMessage,
  type QueryResultFields,
  type WebviewState,
  initialState,
  reduce,
} from '../src/webviewState';

/**
 * The webview's message protocol, tested for the first time.
 *
 * This lived inside a 20-case switch in a browser bundle with no exports, so
 * none of it was reachable — including several rules that are subtle,
 * load-bearing, and commented precisely because they are not obvious. Three
 * different messages deliver a query result, and each one treats `sortState`,
 * `totalRows`, `serverSorted` and the scroll position DIFFERENTLY on purpose.
 * Crossing any two of them shows stale numbers under fresh rows, and nothing
 * anywhere errors.
 */

function fields(over: Partial<QueryResultFields> = {}): QueryResultFields {
  return {
    columns: ['id', 'label'],
    rows: [
      [1, 'a'],
      [2, 'b'],
    ],
    columnStatsKind: ['numeric', 'other'],
    diffSkipped: false,
    hasLimit: false,
    editable: true,
    ...over,
  };
}

function kinds(effects: Effect[]): string[] {
  return effects.map((e) => e.kind);
}

function apply(state: WebviewState, ...messages: ExtensionMessage[]): { state: WebviewState; effects: Effect[] } {
  let s = state;
  let last: Effect[] = [];
  for (const m of messages) {
    const r = reduce(s, m);
    s = r.state;
    last = r.effects;
  }
  return { state: s, effects: last };
}

// ---------------------------------------------------------------------------
// The three ways a result arrives
// ---------------------------------------------------------------------------

test('a fresh query result clears the sort and scrolls back to the top', () => {
  const start: WebviewState = { ...initialState(), sortState: { columnIndex: 1, direction: 'desc' } };
  const { state, effects } = apply(start, { command: 'queryResult', ...fields() });

  assert.equal(state.sortState, undefined, 'a new query kept the previous column sort');
  assert.equal(state.pinnedToBottom, false, 'a new query stayed pinned to the bottom');
  assert.equal(state.lastResult?.serverSorted, false);
  assert.deepEqual(kinds(effects), ['setRunning', 'status', 'render']);
});

test('a sort result KEEPS the sort — it is the answer to the click', () => {
  const sorted = { columnIndex: 1, direction: 'desc' } as const;
  const start: WebviewState = { ...initialState(), sortState: sorted };
  const { state } = apply(start, { command: 'sortQueryResult', ...fields() });

  assert.deepEqual(state.sortState, sorted, 'the arrow icon would have lost the column it was showing');
  assert.equal(state.lastResult?.serverSorted, true, 'the client would re-sort rows DuckDB already ordered');
});

test('a sort result carries the row total across rather than dropping it', () => {
  // Sorting re-orders the same matching rows under the same LIMIT, so the
  // total has not changed. Dropping it would make the footer flicker back to
  // "N rows shown" on every column click.
  const start = apply(initialState(),
    { command: 'queryResult', ...fields() },
    { command: 'rowTotal', sql: '', total: 500 }
  );
  // Prime awaitingTotalForSql the way running a query does.
  const primed: WebviewState = { ...start.state, awaitingTotalForSql: 'select 1' };
  const withTotal = apply(primed, { command: 'rowTotal', sql: 'select 1', total: 500 });
  assert.equal(withTotal.state.lastResult?.totalRows, 500);

  const afterSort = apply(withTotal.state, { command: 'sortQueryResult', ...fields() });
  assert.equal(afterSort.state.lastResult?.totalRows, 500, 'sorting dropped a total that was still true');
});

test('a live tick DROPS the row total, because it is the number that just stopped being true', () => {
  const primed: WebviewState = { ...initialState(), awaitingTotalForSql: 'q' };
  const seeded = apply(primed,
    { command: 'queryResult', ...fields() },
    { command: 'rowTotal', sql: 'q', total: 500 }
  );
  assert.equal(seeded.state.lastResult?.totalRows, 500);

  const ticked = apply({ ...seeded.state, awaitingTotalForSql: 'q' }, {
    command: 'liveTick',
    lastUpdatedMs: 1000,
    unchanged: false,
    result: fields({ rows: [[9, 'z']] }),
  });
  assert.equal(
    ticked.state.lastResult?.totalRows,
    undefined,
    'the footer would assert a total counted before the data moved'
  );
  assert.equal(ticked.state.lastResult?.serverSorted, false, 'a tick carries no client-side sort');
});

test('a live tick preserves the scroll position; a fresh query does not', () => {
  const tick = reduce(initialState(), {
    command: 'liveTick',
    lastUpdatedMs: 1,
    unchanged: false,
    result: fields(),
  });
  const render = tick.effects.find((e) => e.kind === 'render');
  assert.ok(render && render.kind === 'render' && render.preserveScroll, 'a live tick jumped the scroll position');

  const fresh = reduce(initialState(), { command: 'queryResult', ...fields() });
  const freshRender = fresh.effects.find((e) => e.kind === 'render');
  assert.ok(freshRender && freshRender.kind === 'render' && !freshRender.preserveScroll);
});

test('an unchanged live tick updates the clock but does not re-render', () => {
  const { state, effects } = reduce(initialState(), {
    command: 'liveTick',
    lastUpdatedMs: 4242,
    unchanged: true,
  });
  assert.equal(state.liveLastUpdatedMs, 4242);
  assert.deepEqual(kinds(effects), ['updateLiveStatusText'], 'an unchanged tick redrew the grid for nothing');
});

// ---------------------------------------------------------------------------
// The late row total
// ---------------------------------------------------------------------------

test('a total for a superseded query is ignored', () => {
  // The user ran something else while the count was still running. Putting
  // that total under these rows would be worse than showing no total at all.
  const primed: WebviewState = { ...initialState(), awaitingTotalForSql: 'the new query' };
  const seeded = apply(primed, { command: 'queryResult', ...fields() });

  const { state, effects } = reduce({ ...seeded.state, awaitingTotalForSql: 'the new query' }, {
    command: 'rowTotal',
    sql: 'the OLD query',
    total: 999,
  });

  assert.equal(state.lastResult?.totalRows, undefined, 'a stale total was applied to the current rows');
  assert.deepEqual(effects, [], 'a superseded total triggered a re-render');
});

test('a total for the current query is applied', () => {
  const primed: WebviewState = { ...initialState(), awaitingTotalForSql: 'q' };
  const seeded = apply(primed, { command: 'queryResult', ...fields() });
  const { state, effects } = reduce({ ...seeded.state, awaitingTotalForSql: 'q' }, {
    command: 'rowTotal',
    sql: 'q',
    total: 146,
  });
  assert.equal(state.lastResult?.totalRows, 146);
  assert.deepEqual(kinds(effects), ['render']);
});

test('a total arriving before any result is ignored rather than crashing', () => {
  const { state, effects } = reduce(initialState(), { command: 'rowTotal', sql: 'q', total: 5 });
  assert.equal(state.lastResult, undefined);
  assert.deepEqual(effects, []);
});

test('applying a total keeps the rows array identity, so the sort cache still hits', () => {
  // The memo in gridOrder.ts is keyed on the rows OBJECT. If applying a total
  // replaced the array, every live tick would re-sort the whole grid for a
  // change that touched only the footer.
  const primed: WebviewState = { ...initialState(), awaitingTotalForSql: 'q' };
  const seeded = apply(primed, { command: 'queryResult', ...fields() });
  const rowsBefore = seeded.state.lastResult!.rows;

  const after = reduce({ ...seeded.state, awaitingTotalForSql: 'q' }, {
    command: 'rowTotal',
    sql: 'q',
    total: 10,
  });
  assert.equal(after.state.lastResult!.rows, rowsBefore, 'the rows array was replaced by a footer update');
});

// ---------------------------------------------------------------------------
// Cell edits
// ---------------------------------------------------------------------------

test('an edit lands on the row matched by full-row equality, not by position', () => {
  const seeded = apply(initialState(), {
    command: 'queryResult',
    ...fields({
      rows: [
        [1, 'a'],
        [2, 'b'],
        [3, 'c'],
      ],
    }),
  });

  const { state, effects } = reduce(seeded.state, {
    command: 'cellUpdated',
    column: 'label',
    newValue: 'EDITED',
    rowValues: { id: 2, label: 'b' },
    rowsMatched: 1,
  });

  assert.deepEqual(state.lastResult!.rows[1], [2, 'EDITED']);
  assert.deepEqual(state.lastResult!.rows[0], [1, 'a'], 'the edit touched a row it was not aimed at');
  assert.deepEqual(state.lastResult!.rows[2], [3, 'c'], 'the edit touched a row it was not aimed at');
  assert.ok(kinds(effects).includes('invalidateOrder'), 'the sort cache was left holding a stale permutation');
});

test('the edited column itself is excluded from the match', () => {
  // The server echoes back the row as it was BEFORE the edit, so matching on
  // every column including the edited one would work — but matching must not
  // depend on it, or a re-send after a partial update finds nothing.
  const seeded = apply(initialState(), { command: 'queryResult', ...fields() });
  const { state } = reduce(seeded.state, {
    command: 'cellUpdated',
    column: 'label',
    newValue: 'EDITED',
    rowValues: { id: 1, label: 'something else entirely' },
    rowsMatched: 1,
  });
  assert.deepEqual(state.lastResult!.rows[0], [1, 'EDITED']);
});

test('a null in the row values matches a null in the grid', () => {
  const seeded = apply(initialState(), {
    command: 'queryResult',
    ...fields({ rows: [[1, null], [2, 'b']] }),
  });
  const { state } = reduce(seeded.state, {
    command: 'cellUpdated',
    column: 'label',
    newValue: 'FILLED',
    rowValues: { id: 1, label: null },
    rowsMatched: 1,
  });
  assert.deepEqual(state.lastResult!.rows[0], [1, 'FILLED']);
});

test('an edit that matches nothing changes no rows but still closes the inspector', () => {
  const seeded = apply(initialState(), { command: 'queryResult', ...fields() });
  const before = JSON.stringify(seeded.state.lastResult!.rows);
  const { state, effects } = reduce(seeded.state, {
    command: 'cellUpdated',
    column: 'label',
    newValue: 'EDITED',
    rowValues: { id: 999, label: 'nope' },
    rowsMatched: 1,
  });
  assert.equal(JSON.stringify(state.lastResult!.rows), before);
  assert.deepEqual(kinds(effects), ['closeCellInspector', 'render']);
});

test('an edit records the cell as changed when diff tracking is on', () => {
  const seeded = apply(initialState(), {
    command: 'queryResult',
    ...fields({ cellChanged: [[false, false], [false, false]] }),
  });
  const { state } = reduce(seeded.state, {
    command: 'cellUpdated',
    column: 'label',
    newValue: 'EDITED',
    rowValues: { id: 1, label: 'a' },
    rowsMatched: 1,
  });
  assert.deepEqual(state.lastResult!.cellChanged![0], [false, true]);
});

// ---------------------------------------------------------------------------
// Live refresh state
// ---------------------------------------------------------------------------

test('starting live refresh clears any staleness left from a previous run', () => {
  const stale: WebviewState = {
    ...initialState(),
    liveStale: true,
    liveLastError: 'old error',
    liveLastUpdatedMs: 123,
  };
  const { state, effects } = reduce(stale, {
    command: 'liveRefreshStarted',
    intervalMs: 5000,
    suggestedIntervalSeconds: null,
  });
  assert.equal(state.liveEnabled, true);
  assert.equal(state.liveIntervalMs, 5000);
  assert.equal(state.liveStale, false, 'a fresh start inherited the previous run’s staleness');
  assert.equal(state.liveLastError, undefined, 'a fresh start inherited the previous run’s error');
  assert.equal(state.liveLastUpdatedMs, undefined);
  assert.deepEqual(kinds(effects), ['setLiveUi', 'setLiveIntervalInput', 'startLiveStatusTicker']);
});

test('liveStatus carries staleness even though no tick arrived', () => {
  // The whole reason liveStatus is a separate message: a FAILING tick posts no
  // liveTick at all, so staleness carried on that message would be unreachable
  // during exactly the outage it describes.
  const { state } = reduce(initialState(), {
    command: 'liveStatus',
    stale: true,
    failureCount: 3,
    lastError: 'IO Error',
  });
  assert.equal(state.liveStale, true);
  assert.equal(state.liveLastError, 'IO Error');
});

test('stopping live refresh explains a read-only file, and says nothing otherwise', () => {
  const quiet = reduce({ ...initialState(), liveEnabled: true }, { command: 'liveRefreshStopped' });
  assert.equal(quiet.state.liveEnabled, false);
  assert.deepEqual(kinds(quiet.effects), ['setLiveUi']);

  const locked = reduce({ ...initialState(), liveEnabled: true }, {
    command: 'liveRefreshStopped',
    readOnly: true,
  });
  const status = locked.effects.find((e) => e.kind === 'status');
  assert.ok(status && status.kind === 'status' && /read-only/.test(status.text));
});

test('an interval change updates the state and the input together', () => {
  const { state, effects } = reduce(initialState(), {
    command: 'liveRefreshIntervalSet',
    intervalMs: 30_000,
  });
  assert.equal(state.liveIntervalMs, 30_000);
  assert.deepEqual(kinds(effects), ['setLiveIntervalInput']);
});

// ---------------------------------------------------------------------------
// Everything else is pass-through, and must stay side-effect free on state
// ---------------------------------------------------------------------------

test('display-only messages do not disturb the data state', () => {
  const seeded = apply({ ...initialState(), awaitingTotalForSql: 'q' }, {
    command: 'queryResult',
    ...fields(),
  });
  const before = JSON.stringify(seeded.state);

  for (const message of [
    { command: 'error', message: 'boom' },
    { command: 'backupStatus', message: 'backed up' },
    { command: 'tableChangeStatus', status: {} },
    { command: 'safeModeState', safeMode: true },
    { command: 'columnStatsError', column: 'id', message: 'nope' },
    { command: 'cellUpdateError', column: 'id', message: 'nope' },
    { command: 'editStatus', message: 'saving' },
    { command: 'liveRefreshRejected', reason: 'no' },
    { command: 'tables', tables: ['t'], combinedTableNames: [] },
  ] as ExtensionMessage[]) {
    const { state } = reduce(seeded.state, message);
    assert.equal(JSON.stringify(state), before, `${message.command} changed the data state`);
  }
});

test('an error clears the running flag so the UI is not stuck mid-query', () => {
  const { effects } = reduce(initialState(), { command: 'error', message: 'boom' });
  assert.deepEqual(kinds(effects), ['setRunning', 'status', 'showError']);
});
