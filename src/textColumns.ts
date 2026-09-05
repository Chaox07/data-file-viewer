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

export type TextColumnVerdict =
  /**
   * Every non-marker value is a number, so the markers can become NULL and the
   * column can be read as one. `locale` is which reading, per numericLocale.
   */
  | { kind: 'numeric'; locale: NumberLocale; markers: number; values: number }
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

  return { kind: 'numeric', locale, markers, values: rest.length };
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
  tokens: readonly string[] = EXCEL_ERROR_TOKENS
): string {
  const col = ident(column);
  const normalised =
    locale === 'eu'
      ? `replace(replace(trim(${col}), '.', ''), ',', '.')`
      : `replace(trim(${col}), ',', '')`;
  return `case when ${markerTest(column, tokens)} then null else try_cast(${normalised} as double) end`;
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
  return (
    `count(*) filter (where ${col} is not null and trim(${col}) <> '' ` +
    `and not ${markerTest(column, tokens)} and ${markerNullExpr(column, locale, tokens)} is null)`
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
