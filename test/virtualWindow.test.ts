import assert from 'node:assert/strict';
import test from 'node:test';
import { VIRTUAL_OVERSCAN, computeVirtualWindow } from '../src/virtualWindow';

/**
 * The slice of rows actually in the DOM, and the two spacers standing in for
 * the rest.
 *
 * This was four lines inside a function full of createElement calls, so it
 * could not be tested despite being pure. Its failures do not crash: rows go
 * quietly missing from the middle of a long scroll, or a spacer of the wrong
 * height makes the scrollbar disagree with the content. Both read as rendering
 * glitches and are off-by-ones here.
 *
 * The invariant that catches most of them is the last test: the two spacers
 * plus the rendered rows must add up to the full scroll height, exactly, at
 * every scroll position.
 */

const ROW_H = 25;

test('at the top, the window starts at 0 with no top spacer', () => {
  const w = computeVirtualWindow({ scrollTop: 0, viewportHeight: 400, rowHeight: ROW_H, rowCount: 1000 });
  assert.equal(w.start, 0);
  assert.equal(w.topSpacerPx, 0);
  // 400/25 = 16 rows visible, plus overscan below.
  assert.equal(w.end, 16 + VIRTUAL_OVERSCAN);
});

test('scrolled into the middle, the window brackets the viewport with overscan', () => {
  const w = computeVirtualWindow({ scrollTop: 5000, viewportHeight: 400, rowHeight: ROW_H, rowCount: 1000 });
  assert.equal(w.start, 5000 / ROW_H - VIRTUAL_OVERSCAN);
  assert.equal(w.end, (5000 + 400) / ROW_H + VIRTUAL_OVERSCAN);
  assert.equal(w.topSpacerPx, w.start * ROW_H);
});

test('at the very bottom, the window stops at the last row and the bottom spacer is zero', () => {
  const rowCount = 1000;
  const w = computeVirtualWindow({
    scrollTop: rowCount * ROW_H - 400,
    viewportHeight: 400,
    rowHeight: ROW_H,
    rowCount,
  });
  assert.equal(w.end, rowCount, 'the window ran past the last row');
  assert.equal(w.bottomSpacerPx, 0);
});

test('a table shorter than the viewport renders whole, with no spacers', () => {
  const w = computeVirtualWindow({ scrollTop: 0, viewportHeight: 400, rowHeight: ROW_H, rowCount: 5 });
  assert.equal(w.start, 0);
  assert.equal(w.end, 5);
  assert.equal(w.topSpacerPx, 0);
  assert.equal(w.bottomSpacerPx, 0);
});

test('an empty table produces an empty window rather than a negative one', () => {
  const w = computeVirtualWindow({ scrollTop: 0, viewportHeight: 400, rowHeight: ROW_H, rowCount: 0 });
  assert.equal(w.start, 0);
  assert.equal(w.end, 0);
  assert.equal(w.topSpacerPx, 0);
  assert.equal(w.bottomSpacerPx, 0);
});

test('a zero row height is clamped rather than dividing by it', () => {
  // Measured from a rendered row, and a hidden or collapsed grid legitimately
  // measures zero — which would otherwise make the window infinitely tall.
  const w = computeVirtualWindow({ scrollTop: 0, viewportHeight: 400, rowHeight: 0, rowCount: 100 });
  assert.ok(Number.isFinite(w.end), 'a zero row height produced a non-finite window');
  assert.ok(w.end <= 100);
});

test('a zero viewport height falls back rather than rendering nothing', () => {
  const w = computeVirtualWindow({ scrollTop: 0, viewportHeight: 0, rowHeight: ROW_H, rowCount: 1000 });
  assert.ok(w.end > w.start, 'a collapsed viewport rendered an empty window');
});

test('scrolling past the end does not produce a window below zero rows', () => {
  const w = computeVirtualWindow({
    scrollTop: 999_999,
    viewportHeight: 400,
    rowHeight: ROW_H,
    rowCount: 100,
  });
  assert.ok(w.start <= w.end, `start ${w.start} ran past end ${w.end}`);
  assert.equal(w.end, 100);
  assert.ok(w.bottomSpacerPx >= 0);
});

test('the spacers and the rendered rows always add up to the full scroll height', () => {
  // The invariant that catches an off-by-one anywhere in the arithmetic: if
  // this ever fails the scrollbar is lying about how much content there is.
  const rowCount = 5000;
  const total = rowCount * ROW_H;
  for (const scrollTop of [0, 1, 137, 5000, 62_500, total - 400, total, total + 1000]) {
    const w = computeVirtualWindow({ scrollTop, viewportHeight: 400, rowHeight: ROW_H, rowCount });
    const rendered = (w.end - w.start) * ROW_H;
    assert.equal(
      w.topSpacerPx + rendered + w.bottomSpacerPx,
      total,
      `heights do not add up at scrollTop=${scrollTop}`
    );
  }
});

test('every row is reachable across a full scroll', () => {
  // Walked a viewport at a time from top to bottom: every index must appear in
  // some window. A row that no window contains is a row nobody can ever see.
  const rowCount = 1000;
  const seen = new Set<number>();
  for (let scrollTop = 0; scrollTop <= rowCount * ROW_H; scrollTop += 200) {
    const w = computeVirtualWindow({ scrollTop, viewportHeight: 400, rowHeight: ROW_H, rowCount });
    for (let i = w.start; i < w.end; i++) seen.add(i);
  }
  assert.equal(seen.size, rowCount, `${rowCount - seen.size} row(s) were never rendered by any window`);
});
