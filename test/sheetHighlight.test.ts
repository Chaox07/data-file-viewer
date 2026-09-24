import assert from 'node:assert/strict';
import test from 'node:test';
import { tableEdges } from '../src/sheetHighlight';

// B4:D9, as the Query table picker names it: header on Excel row 4, columns B..D.
const B4_D9 = { top: 3, bottom: 9, left: 1, right: 4 };
const none = { top: false, right: false, bottom: false, left: false };

test('cells outside the table get no outline', () => {
  assert.equal(tableEdges(B4_D9, 2, 1), undefined); // B3, the row above
  assert.equal(tableEdges(B4_D9, 9, 1), undefined); // B10, the row below
  assert.equal(tableEdges(B4_D9, 3, 0), undefined); // A4, the column left of it
  assert.equal(tableEdges(B4_D9, 3, 4), undefined); // E4, the column right of it
});

test('an interior cell is inside but on no edge', () => {
  assert.deepEqual(tableEdges(B4_D9, 5, 2), none); // C6
});

test('the four corners carry two edges each', () => {
  assert.deepEqual(tableEdges(B4_D9, 3, 1), { ...none, top: true, left: true }); // B4
  assert.deepEqual(tableEdges(B4_D9, 3, 3), { ...none, top: true, right: true }); // D4
  assert.deepEqual(tableEdges(B4_D9, 8, 1), { ...none, bottom: true, left: true }); // B9
  assert.deepEqual(tableEdges(B4_D9, 8, 3), { ...none, bottom: true, right: true }); // D9
});

test('the middle of each side carries one edge', () => {
  assert.deepEqual(tableEdges(B4_D9, 3, 2), { ...none, top: true }); // C4
  assert.deepEqual(tableEdges(B4_D9, 8, 2), { ...none, bottom: true }); // C9
  assert.deepEqual(tableEdges(B4_D9, 5, 1), { ...none, left: true }); // B6
  assert.deepEqual(tableEdges(B4_D9, 5, 3), { ...none, right: true }); // D6
});

test('a one-cell table is outlined on all four sides', () => {
  assert.deepEqual(tableEdges({ top: 0, bottom: 1, left: 0, right: 1 }, 0, 0), {
    top: true,
    right: true,
    bottom: true,
    left: true,
  });
});
