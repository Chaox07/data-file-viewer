import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countVisiblePoints, zoomBounds, detailStyle, DETAIL_POINT_LIMIT } from '../src/chartDetail';

test('brush values, batched wheel percentages, partial events and reset resolve the viewport', () => {
  const full: [number, number] = [1000, 11000];
  assert.deepEqual(zoomBounds({ startValue: 1100, endValue: 1300 }, full, full, false), [1100, 1300]);
  assert.deepEqual(zoomBounds({ batch: [{ start: 10, end: 20 }] }, full, full, false), [2000, 3000]);
  assert.deepEqual(zoomBounds({ endValue: 4000 }, full, [2000, 3000], false), [2000, 4000]);
  assert.deepEqual(zoomBounds({ start: 0, end: 100 }, full, [2000, 3000], false), full);
  assert.deepEqual(zoomBounds({ start: 10, end: 20 }, [0, 9], [0, 9], true), [1, 2]);
});

test('counts inclusive boundaries, duplicates, empty ranges and irregular density', () => {
  const xs = [1, 1, 1, 2, 10000];
  assert.equal(countVisiblePoints(xs, [1, 1]), 3);
  assert.equal(countVisiblePoints(xs, [3, 9999]), 0);
  assert.equal(countVisiblePoints([], [0, 10]), 0);
  assert.equal(countVisiblePoints(xs, [1, 2]), 4);
});

test('200,000 points survive repeated zoom/reset counts and the exact detail threshold', () => {
  const xs = Array.from({ length: 200000 }, (_, i) => i);
  for (let i = 0; i < 1000; i++) {
    assert.equal(countVisiblePoints(xs, [i, i + DETAIL_POINT_LIMIT - 1]), DETAIL_POINT_LIMIT);
    assert.equal(countVisiblePoints(xs, [i, i + DETAIL_POINT_LIMIT]), DETAIL_POINT_LIMIT + 1);
    assert.equal(countVisiblePoints(xs, [0, 199999]), xs.length);
  }
});

test('detail reveals all line symbols and turns off scatter batching for hover', () => {
  assert.equal(detailStyle('line', true).showSymbol, true);
  assert.equal(detailStyle('line', true).showAllSymbol, true);
  assert.equal(detailStyle('line', false).showSymbol, false);
  assert.equal(detailStyle('scatter', true).large, false);
  assert.equal(detailStyle('scatter', true).progressive, 0);
  assert.equal(detailStyle('scatter', false).large, true);
  assert.equal(detailStyle('scatter', false).progressive, 0);
});
