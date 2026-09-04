import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bothReadings,
  countAmbiguous,
  csvLocaleOptions,
  decideColumn,
  decideFile,
  decideLocale,
  parseEn,
  parseEu,
  scoreLocale,
} from '../src/numericLocale';

/**
 * Which decimal convention a column is written in, and -- more importantly --
 * when to admit we cannot tell.
 *
 * The refusal cases are the ones with teeth. Guessing wrong here is not a
 * visible error: the same bytes read as 1.234 or as 1234, both landing in a
 * clean DOUBLE column with no warning. Every test below that asserts
 * `undecidable` is asserting that we produced no number at all, which is the
 * only safe answer for a column that carries no evidence.
 *
 * Ported alongside src/numericLocale.ts from ETL's etl_parts/etl_shape.py;
 * several of these pin regressions that were actually hit there.
 */

test('a Turkish column is read as European', () => {
  const col = ['1.794.446,52', '2.145.900,00', '987.654,31'];
  const verdict = decideLocale(col);
  assert.equal(verdict.kind, 'decided');
  assert.equal(verdict.kind === 'decided' && verdict.locale, 'eu');
  // The value the user actually cares about round-tripping.
  assert.equal(parseEu('1.794.446,52'), 1794446.52);
});

test('an English column is read as English', () => {
  const col = ['1,234.56', '9,876.54', '1,000,000.01'];
  const verdict = decideLocale(col);
  assert.equal(verdict.kind, 'decided');
  assert.equal(verdict.kind === 'decided' && verdict.locale, 'en');
  assert.equal(parseEn('1,234.56'), 1234.56);
});

/**
 * THE case. A column of nothing but "1.234"-shaped values carries no evidence
 * either way, and the two readings differ by a factor of 1000. It must refuse.
 */
test('a column of only ambiguous values is refused, not guessed', () => {
  const col = ['1.234', '2.345', '3.456'];
  const verdict = decideLocale(col);
  assert.equal(verdict.kind, 'undecidable');
  if (verdict.kind !== 'undecidable') return;
  assert.equal(verdict.ambiguous, 3);
  assert.deepEqual(verdict.samples, ['1.234', '2.345', '3.456']);
});

test('the same column with commas is equally refused', () => {
  // Asserted the other way round: the shape is symmetric, so the refusal
  // must be too. A rule that only refuses dots would silently mangle this.
  const verdict = decideLocale(['1,234', '2,345', '3,456']);
  assert.equal(verdict.kind, 'undecidable');
});

test('the refusal names both readings, so the user can choose', () => {
  // What the toolbar notice is built from.
  assert.deepEqual(bothReadings('1.234'), { en: 1.234, eu: 1234 });
  assert.deepEqual(bothReadings('1,234'), { en: 1234, eu: 1.234 });
  // A 1000x divergence on identical bytes -- the thing being prevented.
  const r = bothReadings('1.234');
  assert.equal(r.eu! / r.en!, 1000);
});

test('forcing a locale on the refused column gives the 1000x difference on purpose', () => {
  // The override exists precisely so the user can resolve what we would not.
  const col = ['1.234', '2.345'];
  assert.deepEqual(col.map(parseEn), [1.234, 2.345]);
  assert.deepEqual(col.map(parseEu), [1234, 2345]);
});

/**
 * The regression ETL's own comments record: ambiguous values used to score 3
 * for eu and 2 for en, which made eu structurally higher for this shape, so a
 * column of plain English three-decimal rates could never reach the
 * equal-score guard and every value was multiplied by 1000.
 */
test('plain English three-decimal rates are never read as European', () => {
  const rates = ['1.234', '2.345', '0.987', '1.500'];
  const verdict = decideLocale(rates);
  assert.notEqual(verdict.kind === 'decided' && verdict.locale, 'eu');
  assert.equal(scoreLocale(rates, 'eu'), 0, 'ambiguous values must score nothing for eu');
  assert.equal(scoreLocale(rates, 'en'), 0, 'and nothing for en either');
});

test('one unambiguous value is enough to break the tie', () => {
  // "1.234,56" carries both separators, so it describes its own convention.
  const verdict = decideLocale(['1.234', '2.345', '1.234,56']);
  assert.equal(verdict.kind, 'decided');
  assert.equal(verdict.kind === 'decided' && verdict.locale, 'eu');
});

test('parenthesised negatives are read as negative', () => {
  assert.equal(parseEu('(1.234,56)'), -1234.56);
  assert.equal(parseEn('(1,234.56)'), -1234.56);
});

test('a value written in the other convention fails honestly rather than plausibly', () => {
  // Stripping blindly would turn "1.234,56" into "1.23456" under the English
  // reading -- casting perfectly, three orders of magnitude adrift.
  assert.equal(parseEn('1.234,56'), null);
  assert.equal(parseEu('1,234.56'), null);
});

test('a column with no separator at all needs no decision', () => {
  assert.equal(decideLocale(['1', '2', '3', '4000']).kind, 'no-separators');
  assert.equal(decideLocale([]).kind, 'no-separators');
  assert.equal(decideLocale([null, undefined, '  ']).kind, 'no-separators');
});

test('a text column is left alone even when a few values look numeric', () => {
  // ETL's 0.85 threshold: below it, this is prose, not numbers.
  const col = ['Ankara', 'İstanbul', 'İzmir', 'Bursa', '1.234,56'];
  assert.equal(decideColumn(col).kind, 'no-separators');
});

test('scientific notation stays parseable', () => {
  assert.equal(parseEn('1.5e3'), 1500);
  assert.equal(parseEu('1,5e3'), 1500);
});

test('countAmbiguous counts only the undecidable shape', () => {
  assert.equal(countAmbiguous(['1.234', '1.2345', '12.34', '1.234,56', '1,234']), 2);
});

test('a file is only claimed for a locale when no column disagrees', () => {
  const eu = decideFile(
    new Map([
      ['a', ['1.794.446,52', '2.000,00']],
      ['b', ['12,5', '13,7']],
    ])
  );
  assert.equal(eu.locale, 'eu');
  assert.equal(eu.conflicting, false);

  // One dissenting column blocks the whole file: read_csv's options are
  // per-file, so being right about most columns is not good enough.
  const mixed = decideFile(
    new Map([
      ['a', ['1.794.446,52']],
      ['b', ['1,234.56']],
    ])
  );
  assert.equal(mixed.locale, null);
  assert.equal(mixed.conflicting, true);
});

test('an undecidable column is reported by name, with its values', () => {
  const res = decideFile(
    new Map([
      ['ok', ['1.234,56']],
      ['bad', ['1.234', '2.345']],
    ])
  );
  assert.deepEqual(
    res.undecidable.map((u) => u.column),
    ['bad']
  );
  assert.deepEqual(res.undecidable[0].samples, ['1.234', '2.345']);
});

test('the incoherent option pairing is rejected where it is set', () => {
  // DuckDB rejects thousands === decimal_separator too, but only at sniff
  // time once a real file is being read -- verified against 1.5.5, where a
  // missing file fails on file resolution rather than on the pairing. So a
  // bad setting would not surface until the next file open.
  assert.deepEqual(csvLocaleOptions('eu'), { decimal: ',', thousands: '.' });
  assert.deepEqual(csvLocaleOptions('en'), { decimal: '.', thousands: ',' });
  // "tr" is a spelling of "eu", matching ETL's {"eu", "tr"}.
  assert.deepEqual(csvLocaleOptions('tr'), { decimal: ',', thousands: '.' });
});

test('an unrecognised locale throws rather than defaulting to English', () => {
  // A typo in the setting silently becoming "en" is the same class of failure
  // as guessing the separator: numbers that look fine and are wrong.
  assert.throws(() => csvLocaleOptions('xx' as 'en'), /Invalid number locale/);
  assert.throws(() => csvLocaleOptions('' as 'en'), /Invalid number locale/);
});

test('nothing here touches the file', () => {
  // The viewer only views. These are pure functions over values; the
  // arguments must come back unchanged.
  const col = ['1.234,56', '2.000,00'];
  const copy = [...col];
  decideLocale(col);
  decideColumn(col);
  decideFile(new Map([['a', col]]));
  assert.deepEqual(col, copy);
});
