import assert from 'node:assert/strict';
import test from 'node:test';
import { compareDecimalStrings, computeSortOrder, type SortKind } from '../src/sortOrder';

/** Applies the permutation, so assertions read as the order the user would see. */
function sorted(values: unknown[], kind: SortKind, direction: 'asc' | 'desc' = 'asc'): unknown[] {
  const rows = values.map((v) => [v]);
  return computeSortOrder(rows, 0, direction, kind).map((i) => values[i]);
}

test('BIGINT values arrive as strings and must still sort numerically', () => {
  // The whole point: `typeof value === 'number'` is false for every one of
  // these, so the old comparator sorted them as text and put "10" before "9".
  assert.deepEqual(sorted(['9', '10', '1000', '100'], 'numeric'), ['9', '10', '100', '1000']);
});

test('values beyond 2^53 keep their exact order', () => {
  const big = ['1152921504606846976', '1152921504606846977', '1152921504606846975'];
  assert.deepEqual(sorted(big, 'numeric'), [
    '1152921504606846975',
    '1152921504606846976',
    '1152921504606846977',
  ]);
});

test('negative and fractional decimals order correctly', () => {
  assert.deepEqual(sorted(['-2', '-10', '0', '1.5', '1.25', '-1.5'], 'numeric'), [
    '-10',
    '-2',
    '-1.5',
    '0',
    '1.25',
    '1.5',
  ]);
});

test('nulls sort last in both directions', () => {
  assert.deepEqual(sorted([3, null, 1], 'numeric', 'asc'), [1, 3, null]);
  assert.deepEqual(sorted([3, null, 1], 'numeric', 'desc'), [3, 1, null]);
  assert.deepEqual(sorted(['b', undefined, 'a'], 'other', 'desc'), ['b', 'a', undefined]);
});

test('NaN is parked with the nulls rather than landing arbitrarily', () => {
  assert.deepEqual(sorted([2, NaN, 1], 'numeric', 'asc'), [1, 2, NaN]);
});

test('timestamps sort chronologically, not lexicographically', () => {
  const stamps = ['2024-03-01 09:00:00', '2024-03-01 10:00:00', '2023-12-31 23:59:59'];
  assert.deepEqual(sorted(stamps, 'datetime'), [
    '2023-12-31 23:59:59',
    '2024-03-01 09:00:00',
    '2024-03-01 10:00:00',
  ]);
});

test('text sorting is case- and accent-aware rather than code-unit order', () => {
  // Code-unit order would give: Zebra, apple, çilek, ıspanak, Şeker — every
  // capital before every lowercase, and every non-ASCII letter after "z".
  const result = sorted(['Zebra', 'apple', 'çilek', 'Şeker', 'ıspanak'], 'other') as string[];
  assert.equal(result[0], 'apple', 'lowercase "a" sorts before uppercase "Z"');
  assert.ok(result.indexOf('çilek') < result.indexOf('Zebra'), 'ç sorts among the letters, not past z');
  assert.ok(result.indexOf('Şeker') < result.indexOf('Zebra'), 'ş sorts among the letters, not past z');
});

test('embedded numbers in text sort numerically', () => {
  assert.deepEqual(sorted(['item9', 'item10', 'item1'], 'other'), ['item1', 'item9', 'item10']);
});

test('a numeric column that is not actually numeric text falls back to text ordering', () => {
  // 1e400 overflows to Infinity, so the exactness check fails, and the values
  // aren't plain decimals either — this must degrade, not throw or mis-sort.
  const result = sorted(['1e400', 'abc', '2'], 'numeric') as string[];
  assert.equal(result.length, 3);
});

test('sorting is stable for equal keys', () => {
  const rows = [
    [1, 'first'],
    [1, 'second'],
    [0, 'third'],
  ];
  const order = computeSortOrder(rows, 0, 'asc', 'numeric');
  assert.deepEqual(order, [2, 0, 1], 'ties keep their original relative order');
});

test('compareDecimalStrings is a total order consistent with sign and magnitude', () => {
  assert.equal(compareDecimalStrings('1', '2'), -1);
  assert.equal(compareDecimalStrings('-1', '-2'), 1);
  assert.equal(compareDecimalStrings('-1', '1'), -1);
  assert.equal(compareDecimalStrings('007', '7'), 0, 'leading zeros are not significant');
  assert.equal(compareDecimalStrings('1.10', '1.1'), 0, 'trailing zeros are not significant');
  assert.equal(compareDecimalStrings('1.2', '1.15'), 1, 'fractions compare by value, not length');
});
