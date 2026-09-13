/**
 * Excel error markers, and the text columns they trap.
 *
 * A spreadsheet writes "there is no value here" as an error marker: `=NA()`
 * caches as `#N/A`, a broken reference as `#REF!`, and a hand-typed gap as the
 * bare word `NA`. Read back, those are strings sitting in a column of numbers,
 * and the consequence is not cosmetic -- read_xlsx types the column VARCHAR,
 * and chartSpec.plottableYColumns only offers `kind === 'numeric'`, so the
 * column vanishes from the chart's y picker without a word. Measured on
 * YieldCurve_Data.xlsx: 70 of Raw_Data's 100 columns and 12 of
 * used-YieldCurve's 33, unplottable for this reason alone.
 *
 * `ignore_errors = true` does NOT cover this. It nulls errors only in columns
 * that already typed numeric -- so where `=NA()` happens to fall inside the
 * sniff window the column types VARCHAR and keeps the literal string. The same
 * `=NA()` cell lands as NULL in one column and as `'#N/A'` in another, decided
 * purely by row position. Row 3 of used-YieldCurve shows both at once.
 *
 * Nothing here writes. This module is values in, verdict out; the caller owns
 * the connection and the view. The file on disk is never touched -- a marker
 * "becoming NULL" is a reading of the file, applied at view time and
 * reversible by setting `dataFileViewer.nullText` to [].
 *
 * The ETL is the reference implementation: `_EXCEL_ERRORS` and
 * `_is_excel_error_string` in ETL/etl_parts/etl_values.py. The names are kept
 * here so the two can be diffed by eye.
 */

import { NumberLocale, decideLocale, parseEn, parseEu } from './numericLocale';

/**
 * `_EXCEL_ERRORS` (etl_values.py:860), verbatim.
 *
 * The seven cached error values Excel can store in a cell, plus the two
 * spellings of a hand-written gap. `NA` and `N/A` are in the same set as
 * `#REF!` there and are here for the same reason: by the time a workbook is
 * being read they all mean one thing, "no value", and splitting them into
 * "real errors" and "typed words" would make the same missing value land two
 * different ways depending on how it was produced.
 */
export const EXCEL_ERROR_TOKENS: readonly string[] = [
  '#VALUE!',
  '#REF!',
  '#DIV/0!',
  '#NAME?',
  '#NUM!',
  '#NULL!',
  '#N/A',
  'N/A',
  'NA',
];

/** `_is_excel_error_string` (etl_values.py:864): trimmed, upper-cased, matched. */
export function isExcelError(
  value: string | null | undefined,
  tokens: readonly string[] = EXCEL_ERROR_TOKENS
): boolean {
  if (value === null || value === undefined) return false;
  const s = String(value).trim().toUpperCase();
  if (s === '') return false;
  return tokens.some((t) => t.trim().toUpperCase() === s);
}

/**
 * What a promoted column is read AS.
 *
 * This used to be `double`, unconditionally, whatever the column held — which
 * is E20: `try_cast('9007199254740993' as double)` succeeds, and succeeds with
 * a different number. An exact integer type costs nothing and keeps the value,
 * so the type is now chosen from the column's own contents.
 *
 * `hugeint` is 128-bit and exists for identifiers longer than 18 digits, which
 * are not exotic — a 23-digit reference number fits it and nothing narrower.
 */
export type PromotionTarget = 'bigint' | 'hugeint' | 'double';

export type TextColumnVerdict =
  /**
   * Every non-marker value is a number, so the markers can become NULL and the
   * column can be read as one. `locale` is which reading, per numericLocale.
   *
   * `integral` says every value is written as a whole number, with no decimal
   * point and no exponent. It decides which TARGET is tried first, not whether
   * the column is promoted: the sample cannot prove a type fits, so the whole
   * -column fidelity check below settles it.
   */
  | { kind: 'numeric'; locale: NumberLocale; markers: number; values: number; integral: boolean }
  /**
   * Nothing but markers. There is no data to misread, so the markers still
   * become NULL -- but no type is invented for a column that never showed one.
   */
  | { kind: 'markers-only'; markers: number }
  /**
   * Left alone, and the caller must say why. `residue` carries up to three of
   * the values that decided it, so the notice can quote the file rather than
   * recite a rule.
   */
  | { kind: 'text'; reason: 'residue' | 'undecidable' | 'empty'; residue: string[] };

function cleaned(values: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s !== '') out.push(s);
  }
  return out;
}

/**
 * Is this text column a numeric column with markers in it?
 *
 * The refusal contract is W1's, unchanged: convert only on evidence, and where
 * the evidence is absent leave the text alone and say so. Two differences from
 * `decideColumn`, both deliberate:
 *
 *   - the bar is EVERY non-marker value, not 85% of them. decideColumn's
 *     threshold exists to let a mostly-numeric column absorb a few stray
 *     labels as NULL; here that would be silent loss of exactly the kind this
 *     module is meant to prevent, because the strays would be indistinguishable
 *     from the markers we deliberately nulled.
 *   - a value is admissible if it parses under EITHER reading, and only then
 *     is decideLocale asked which. Gating on one reading before knowing the
 *     convention would reject every Turkish column on its first `1.234,56`.
 *
 * This runs on a sample. It picks the locale and throws out the obviously
 * textual columns cheaply; it is NOT the safety check. The caller must still
 * verify the chosen expression across the whole column -- see
 * markerNullExpr's note.
 */
export function classifyTextColumn(
  values: readonly (string | null | undefined)[],
  tokens: readonly string[] = EXCEL_ERROR_TOKENS
): TextColumnVerdict {
  const clean = cleaned(values);
  if (clean.length === 0) return { kind: 'text', reason: 'empty', residue: [] };

  const rest: string[] = [];
  let markers = 0;
  for (const s of clean) {
    if (isExcelError(s, tokens)) markers += 1;
    else rest.push(s);
  }

  if (rest.length === 0) {
    return markers > 0 ? { kind: 'markers-only', markers } : { kind: 'text', reason: 'empty', residue: [] };
  }

  const unparseable = rest.filter((s) => parseEn(s) === null && parseEu(s) === null);
  if (unparseable.length > 0) {
    return { kind: 'text', reason: 'residue', residue: unparseable.slice(0, 3) };
  }

  const verdict = decideLocale(rest);
  if (verdict.kind === 'undecidable') {
    return { kind: 'text', reason: 'undecidable', residue: verdict.samples };
  }
  // 'no-separators' means the two readings are provably identical, so either
  // label is correct; 'en' is the one whose SQL is a plain cast.
  const locale: NumberLocale = verdict.kind === 'decided' ? verdict.locale : 'en';

  const parse = locale === 'en' ? parseEn : parseEu;
  const failed = rest.filter((s) => parse(s) === null);
  if (failed.length > 0) {
    return { kind: 'text', reason: 'residue', residue: failed.slice(0, 3) };
  }

  // Not `rest.every(isIntegral)`: every() passes the INDEX as the second
  // argument, which would arrive as the locale and read every column as 'en'.
  const integral = rest.every((s) => isIntegral(s, locale));
  return { kind: 'numeric', locale, markers, values: rest.length, integral };
}

/**
 * Is this value written as a whole number?
 *
 * Deliberately a test on the TEXT, not on the parsed number. `1e3` and `1.0`
 * are worth 1000 and 1 as quantities, but they are not written as integers and
 * a column containing them is a column of measurements, not of identifiers.
 * Sending them down the exact-integer path would only make the round-trip test
 * reject them a moment later.
 *
 * Thousands separators are stripped first, in the locale's own convention, so
 * `1.234` reads as integral under 'eu' and as a decimal under 'en' — which is
 * exactly the disagreement decideLocale exists to settle before this is asked.
 */
function isIntegral(value: string, locale: NumberLocale = 'en'): boolean {
  const bare = locale === 'eu' ? value.replace(/\./g, '') : value.replace(/,/g, '');
  return /^[+-]?\d+$/.test(bare.trim());
}

/**
 * Deliberately duplicated from duckdbConnection rather than imported, to keep
 * this a leaf module like numericLocale.ts. Two lines, and the escaping rule
 * is fixed by SQL rather than by us.
 */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The `upper(trim(col)) in (...)` test, shared by the projection and the check. */
export function markerTest(column: string, tokens: readonly string[] = EXCEL_ERROR_TOKENS): string {
  const list = tokens.map((t) => literal(t.trim().toUpperCase())).join(', ');
  return `upper(trim(${ident(column)})) in (${list})`;
}

/**
 * The projection that reads one text column as numbers with its markers nulled.
 *
 * The separator handling has to match numericLocale's parsers, because a plain
 * `try_cast` does not: verified on DuckDB 1.5.5, `try_cast('1,234.56' as
 * double)` is NULL and `try_cast('1.234,56' as double)` is NULL, so an English
 * thousands separator and every Turkish decimal would be nulled as though they
 * were markers. The replaces are what parseEn and parseEu do, in SQL.
 *
 * IMPORTANT for the caller: `try_cast` returns NULL for anything it cannot
 * read, which means this expression cannot distinguish "was a marker" from
 * "was a value we failed to parse". That is why the sample verdict is not
 * enough on its own -- run markerResidueExpr over the WHOLE column first and
 * refuse the column if it finds anything. Measured on Raw_Data: 0.77s for 70
 * columns x 16,803 rows, so there is no reason to sample it.
 */
export function markerNullExpr(
  column: string,
  locale: NumberLocale,
  target: PromotionTarget,
  tokens: readonly string[] = EXCEL_ERROR_TOKENS
): string {
  return (
    `case when ${markerTest(column, tokens)} then null ` +
    `else try_cast(${normalisedExpr(column, locale)} as ${target}) end`
  );
}

/** The value with its separators in SQL what parseEn/parseEu do in TypeScript. */
export function normalisedExpr(column: string, locale: NumberLocale): string {
  const col = ident(column);
  return locale === 'eu'
    ? `replace(replace(trim(${col}), '.', ''), ',', '.')`
    : `replace(trim(${col}), ',', '')`;
}

/**
 * Values this column would CHANGE, as opposed to values it cannot read.
 *
 * This is the question markerResidueExpr does not ask, and the whole of E20 is
 * in the gap between them. The residue check asks whether every value *can* be
 * cast; `try_cast('9007199254740993' as double)` can, and returns
 * `9007199254740992`. A guard built on castability is blind to a cast that
 * succeeds with a different number, by construction.
 *
 * The test differs by target because "the same value" means something
 * different for an identifier and for a measurement:
 *
 *   - for an exact integer type, the text must come back CHARACTER for
 *     CHARACTER. That is what makes `007` -> `7` a loss and not a formatting
 *     detail, and it also refuses `1.5` and `1e3` without needing a rule of
 *     their own, since neither is written the way an integer is written.
 *
 *   - for `double`, a character comparison would be wrong: `1.50` and `1e3`
 *     are perfectly good doubles that do not print back the way they were
 *     typed, and refusing a column of prices because it wrote `1.50` would be
 *     a worse reader, not a safer one. So the value is compared as an exact
 *     decimal against the decimal of the double's PRINTED form, which catches
 *     loss of MAGNITUDE -- the integer past 2^53, the overflow to infinity --
 *     and stays quiet about digits below a double's resolution.
 *
 * The double's printed form is load-bearing, and it is not the same thing as
 * the double. Widening the double straight to `decimal(38,15)` expands its
 * true binary value, so `1794446.52` comes back `1794446.520000000032768` and
 * compares unequal to itself -- which refuses nearly every real decimal column,
 * since almost no decimal is a binary fraction. Printing first asks DuckDB for
 * the shortest text that reads back as that same double, which is the question
 * actually being asked: would a reader of this column see the value the file
 * wrote?
 *
 * A value that does not fit `decimal(38,15)` at all counts as loss rather than
 * as "no opinion". Without that clause the comparison is NULL-to-NULL for a
 * 40-digit integer, which is false, which would have promoted the very column
 * this exists to protect.
 */
export function markerFidelityExpr(
  column: string,
  locale: NumberLocale,
  target: PromotionTarget,
  tokens: readonly string[] = EXCEL_ERROR_TOKENS
): string {
  const col = ident(column);
  const n = normalisedExpr(column, locale);
  const exact = `try_cast(${n} as decimal(38,15))`;
  const changed =
    target === 'double'
      ? `(${exact} is null or ${exact} is distinct from try_cast(try_cast(try_cast(${n} as double) as varchar) as decimal(38,15)))`
      : `try_cast(${n} as ${target})::varchar is distinct from ${n}`;
  return (
    `count(*) filter (where ${col} is not null and trim(${col}) <> '' ` +
    `and not ${markerTest(column, tokens)} and ${changed})`
  );
}

/** Markers become NULL, the column stays exactly as typed. For a markers-only column. */
export function markerBlankExpr(
  column: string,
  tokens: readonly string[] = EXCEL_ERROR_TOKENS
): string {
  return `case when ${markerTest(column, tokens)} then null else ${ident(column)} end`;
}

/**
 * Values this column would lose: not null, not blank, not a marker, and not
 * readable by the expression we are about to apply.
 *
 * Counted over the whole column, and a non-zero answer means the column is
 * left as text. This is the check that makes the conversion safe rather than
 * merely likely: a column that is clean for its first 2,000 rows and carries
 * one written note at row 9,000 would otherwise have that note try_cast to
 * NULL and be indistinguishable from the markers.
 */
export function markerResidueExpr(
  column: string,
  locale: NumberLocale,
  tokens: readonly string[] = EXCEL_ERROR_TOKENS
): string {
  const col = ident(column);
  // Readability is asked of `double` whatever the column will finally be read
  // as. This question is "is there a written note hiding in row 9,000", and the
  // answer must not change because the column turned out to be integers: an
  // exact integer type would call every ordinary decimal unreadable and refuse
  // columns for the wrong reason. Whether the chosen type keeps the VALUE is
  // markerFidelityExpr's question, and it is a different one.
  return (
    `count(*) filter (where ${col} is not null and trim(${col}) <> '' ` +
    `and not ${markerTest(column, tokens)} and ${markerNullExpr(column, locale, 'double', tokens)} is null)`
  );
}

/** How many cells in this column are markers. Reported, so the count is evidence. */
export function markerCountExpr(
  column: string,
  tokens: readonly string[] = EXCEL_ERROR_TOKENS
): string {
  return `count(*) filter (where ${markerTest(column, tokens)})`;
}

/**
 * Cells that are neither blank nor a marker — the check that a "nothing but
 * markers" column really is one, over the whole column rather than a sample.
 */
export function nonMarkerCountExpr(
  column: string,
  tokens: readonly string[] = EXCEL_ERROR_TOKENS
): string {
  const col = ident(column);
  return (
    `count(*) filter (where ${col} is not null and trim(${col}) <> '' ` +
    `and not ${markerTest(column, tokens)})`
  );
}
