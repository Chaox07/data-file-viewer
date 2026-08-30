import assert from 'node:assert/strict';
import test from 'node:test';
import { addThousandsSeparators, fmtCount, formatAgo, formatStat, formatValue } from '../src/gridFormat';

/**
 * What a value looks like by the time somebody reads it and believes it.
 *
 * These ran on every cell of every grid and could not be tested, because
 * webview.ts is a browser bundle entry point with no exports. The extraction
 * is what makes them reachable; this is what it was for.
 *
 * The BIGINT cases are the ones with teeth. DuckDB sends BIGINT, HUGEINT,
 * DECIMAL, TIMESTAMP and DATE over the wire as STRINGS -- which is exactly
 * what keeps a value past 2^53 intact on the way here -- so the last thing
 * that must not happen is this function parsing them back into a Number to
 * format them.
 */

test('a value past 2^53 keeps every digit', () => {
  // The two values the `shapes` stress family generates. If either of these
  // ever comes back rounded, the grid is showing a number that is not in the
  // file, and the two rows become indistinguishable.
  assert.equal(formatValue('9007199254740993', 'numeric'), '9,007,199,254,740,993');
  assert.equal(formatValue('9007199254740992', 'numeric'), '9,007,199,254,740,992');
  assert.notEqual(
    formatValue('9007199254740993', 'numeric'),
    formatValue('9007199254740992', 'numeric')
  );
});

test('a 39-digit HUGEINT is not rounded either', () => {
  const huge = '170141183460469231731687303715884105727';
  assert.equal(formatValue(huge, 'numeric').replace(/,/g, ''), huge);
});

test('a DECIMAL keeps its full scale', () => {
  assert.equal(formatValue('1.234567890123456789', 'numeric'), '1.234567890123456789');
});

test('grouping applies to the integer part only', () => {
  assert.equal(formatValue('1234567.891', 'numeric'), '1,234,567.891');
  assert.equal(formatValue('-1234567.891', 'numeric'), '-1,234,567.891');
  assert.equal(formatValue('0.000001', 'numeric'), '0.000001');
});

test('a date string is not grouped, because kind says it is not numeric', () => {
  // Both arrive as strings; only `kind` can tell them apart. Formatting
  // "2020-01-31" as a number would be the visible symptom of losing that.
  assert.equal(formatValue('2020-01-31', 'datetime'), '2020-01-31');
  assert.equal(formatValue('12:34:56.789', 'other'), '12:34:56.789');
});

test('a numeric-looking string in a non-numeric column is left alone', () => {
  assert.equal(formatValue('1234567', 'other'), '1234567');
  assert.equal(formatValue('1234567'), '1234567');
});

test('null and undefined both read as NULL', () => {
  assert.equal(formatValue(null), 'NULL');
  assert.equal(formatValue(undefined), 'NULL');
  assert.equal(formatValue(null, 'numeric'), 'NULL');
});

test('an empty string is not NULL', () => {
  // The distinction the CSV round-trip loses; the formatter must at least not
  // lose it as well.
  assert.equal(formatValue(''), '');
});

test('non-finite doubles arrive as their own spelling', () => {
  // DuckDB's JSON conversion renders these as strings, so they reach here as
  // text and must not be mangled into something numeric-looking.
  assert.equal(formatValue('NaN', 'numeric'), 'NaN');
  assert.equal(formatValue('Infinity', 'numeric'), 'Infinity');
  assert.equal(formatValue('-Infinity', 'numeric'), '-Infinity');
});

test('nested values are shown as JSON rather than [object Object]', () => {
  assert.equal(formatValue({ a: 1 }), '{"a":1}');
  assert.equal(formatValue([1, 2, 3]), '[1,2,3]');
  assert.equal(formatValue([{ key: 'k', value: 'v' }]), '[{"key":"k","value":"v"}]');
});

test('booleans and bigints survive', () => {
  assert.equal(formatValue(true), 'true');
  assert.equal(formatValue(false), 'false');
  assert.equal(formatValue(9007199254740993n, 'numeric'), '9,007,199,254,740,993');
});

test('addThousandsSeparators handles every digit-count boundary', () => {
  for (const [digits, expected] of [
    ['1', '1'],
    ['12', '12'],
    ['123', '123'],
    ['1234', '1,234'],
    ['12345', '12,345'],
    ['123456', '123,456'],
    ['1234567', '1,234,567'],
  ] as const) {
    assert.equal(addThousandsSeparators(digits), expected, digits);
  }
});

test('formatStat caps at four decimals without padding shorter ones', () => {
  // "At most" four: padding 0.5 out to 0.5000 would claim a precision the
  // measurement does not have.
  assert.equal(formatStat(0.5), '0.5');
  assert.equal(formatStat(42), '42');
  assert.equal(formatStat(1 / 3), '0.3333');
  assert.equal(formatStat(2 / 3), '0.6667');
  assert.equal(formatStat(1234.56789), '1,234.5679');
});

test('formatStat falls through for values that are not finite numbers', () => {
  assert.equal(formatStat(null), 'NULL');
  assert.equal(formatStat('NaN'), 'NaN');
  assert.equal(formatStat('Infinity'), 'Infinity');
});

test('fmtCount groups a row count', () => {
  assert.equal(fmtCount(0), '0');
  assert.equal(fmtCount(146), '146');
  assert.equal(fmtCount(40000), '40,000');
});

test('formatAgo reads in seconds under a minute and minutes past it', () => {
  const now = 1_000_000_000;
  assert.equal(formatAgo(now, now), '0s ago');
  assert.equal(formatAgo(now - 5_000, now), '5s ago');
  assert.equal(formatAgo(now - 59_000, now), '59s ago');
  assert.equal(formatAgo(now - 60_000, now), '1m 0s ago');
  assert.equal(formatAgo(now - 125_000, now), '2m 5s ago');
});

test('formatAgo never reads as negative when a clock skews backwards', () => {
  const now = 1_000_000_000;
  assert.equal(formatAgo(now + 5_000, now), '0s ago');
});
