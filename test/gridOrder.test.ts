import assert from 'node:assert/strict';
import test from 'node:test';
import { DisplayOrderCache, computeDisplayOrder, type OrderableResult } from '../src/gridOrder';

/**
 * Which rows to draw, in which order — and when NOT to reorder them.
 *
 * The rule worth protecting is `serverSorted`. When DuckDB has already ordered
 * rows across the full data set, sorting again on the client is not merely
 * wasted work: where the client comparator disagrees with DuckDB's ordering it
 * scrambles a correct top-N back into a wrong one. The `consistency` stress
 * family asserts that a sorted top-N is the true top N; this is the code that
 * can break that promise after the data is already right.
 */

function result(rows: unknown[][], serverSorted = false): OrderableResult {
  return { rows, columnStatsKind: ['numeric', 'other'], serverSorted };
}

const ROWS = [
  [3, 'c'],
  [1, 'a'],
  [2, 'b'],
];

test('with no sort, rows are drawn in the order they arrived', () => {
  assert.deepEqual(computeDisplayOrder(result(ROWS), undefined), [0, 1, 2]);
});

test('a client sort reorders by the chosen column', () => {
  assert.deepEqual(computeDisplayOrder(result(ROWS), { columnIndex: 0, direction: 'asc' }), [1, 2, 0]);
  assert.deepEqual(computeDisplayOrder(result(ROWS), { columnIndex: 0, direction: 'desc' }), [0, 2, 1]);
});

test('serverSorted rows are left exactly as DuckDB ordered them', () => {
  // The important one. A sort state is present AND the rows are already
  // ordered by the server: the client must not touch them, even though it has
  // been asked to sort. Re-sorting here is what turns a true top-N into a
  // wrong one.
  const order = computeDisplayOrder(result(ROWS, true), { columnIndex: 0, direction: 'asc' });
  assert.deepEqual(order, [0, 1, 2], 'the client re-sorted rows DuckDB had already ordered');
});

test('an empty result produces an empty order rather than throwing', () => {
  assert.deepEqual(computeDisplayOrder(result([]), undefined), []);
  assert.deepEqual(computeDisplayOrder(result([]), { columnIndex: 0, direction: 'asc' }), []);
});

test('a single row is its own order', () => {
  assert.deepEqual(computeDisplayOrder(result([[1, 'a']]), { columnIndex: 0, direction: 'desc' }), [0]);
});

// ---------------------------------------------------------------------------
// The memo
// ---------------------------------------------------------------------------

test('the same rows and sort reuse the cached order', () => {
  const cache = new DisplayOrderCache();
  const r = result(ROWS);
  const first = cache.order(r, { columnIndex: 0, direction: 'asc' });
  const second = cache.order(r, { columnIndex: 0, direction: 'asc' });
  assert.equal(first, second, 'the order was recomputed for an identical request');
});

test('changing the sort direction recomputes', () => {
  const cache = new DisplayOrderCache();
  const r = result(ROWS);
  assert.deepEqual(cache.order(r, { columnIndex: 0, direction: 'asc' }), [1, 2, 0]);
  assert.deepEqual(cache.order(r, { columnIndex: 0, direction: 'desc' }), [0, 2, 1]);
});

test('changing the sort column recomputes', () => {
  // A fixture whose two columns deliberately disagree. ROWS above is sorted
  // the same way by either column, so it could not tell a recompute from a
  // stale cache hit -- the assertion would pass either way.
  const cache = new DisplayOrderCache();
  const r = result([
    [3, 'a'],
    [1, 'b'],
    [2, 'c'],
  ]);
  assert.deepEqual(cache.order(r, { columnIndex: 0, direction: 'asc' }), [1, 2, 0]);
  assert.deepEqual(cache.order(r, { columnIndex: 1, direction: 'asc' }), [0, 1, 2]);
});

test('NEW rows invalidate the cache even under an identical sort', () => {
  // The failure this guards is the expensive one: a live tick replaces the
  // rows, the sort has not changed, and a cache keyed only on the sort would
  // hand back an order computed for data that is gone -- showing a stale
  // ordering over fresh rows, with no error anywhere.
  const cache = new DisplayOrderCache();
  const before = cache.order(result(ROWS), { columnIndex: 0, direction: 'asc' });
  assert.deepEqual(before, [1, 2, 0]);

  const refreshed = result([
    [9, 'z'],
    [8, 'y'],
    [7, 'x'],
  ]);
  const after = cache.order(refreshed, { columnIndex: 0, direction: 'asc' });
  assert.deepEqual(after, [2, 1, 0], 'a stale order was served over refreshed rows');
});

test('rows that are equal by value but a different array still invalidate', () => {
  // Keyed on object identity, deliberately: a live tick hands over a new array
  // every time, and comparing contents instead would be both slower and wrong
  // for a tick that produced identical values from a changed file.
  const cache = new DisplayOrderCache();
  const first = cache.order(result([...ROWS]), { columnIndex: 0, direction: 'asc' });
  const second = cache.order(result([...ROWS]), { columnIndex: 0, direction: 'asc' });
  assert.deepEqual(first, second);
  assert.notEqual(first, second, 'a different rows array reused the cached array');
});

test('invalidate() forces a recompute for rows changed in place', () => {
  const cache = new DisplayOrderCache();
  const r = result(ROWS);
  const first = cache.order(r, { columnIndex: 0, direction: 'asc' });
  cache.invalidate();
  const second = cache.order(r, { columnIndex: 0, direction: 'asc' });
  assert.deepEqual(first, second);
  assert.notEqual(first, second, 'invalidate() did not force a recompute');
});

test('the cache respects serverSorted too', () => {
  const cache = new DisplayOrderCache();
  const order = cache.order(result(ROWS, true), { columnIndex: 0, direction: 'asc' });
  assert.deepEqual(order, [0, 1, 2]);
});
