/**
 * Which decimal convention is this column written in -- English (`1,234.56`)
 * or European/Turkish (`1.234,56`)?
 *
 * This module only ever *decides*. It never parses a column for real: DuckDB
 * does that, via `read_csv(..., decimal_separator, thousands)`, which the
 * bundled 1.5.5 supports. What DuckDB cannot do is choose, and choosing wrong
 * is not a visible error -- it is a silent factor of 1000:
 *
 *     a.csv containing  1.234, 2.345
 *       read_csv default                      -> 1.234, 2.345
 *       decimal_separator=',', thousands='.'  -> 1234,  2345
 *
 * Same bytes, same clean-looking DOUBLE column, no warning either way.
 *
 * Ported from the ETL pipeline's `etl_parts/etl_shape.py`, which solved this
 * once already and has the stress suite to prove it. The Python function
 * names are kept in the comments so the two can be diffed by eye:
 *
 *   scoreLocale       <- _numeric_locale_confidence   (etl_shape.py:428)
 *   countAmbiguous    <- _ambiguous_separator_count   (etl_shape.py:456)
 *   decideLocale      <- _parse_auto                  (etl_shape.py:465)
 *   parseEn / parseEu <- _parse_en / _parse_eu        (etl_shape.py:395/407)
 *
 * It is Python there and stays Python there -- this is a port, not a
 * dependency. Deliberately NOT ported: the polars/threshold plumbing around
 * it, and every "should this column be cleaned" judgment. The viewer only
 * views.
 *
 * Everything here is a pure function over values: no file access, no DDL, no
 * mutation of its inputs.
 */

/** What a number is ALLOWED to look like, before separators are stripped. */
const EXPONENT = '([eE][+-]?\\d+)?';
const VALID_EN_RE = new RegExp(`^[+-]?(\\d{1,3}(,\\d{3})+|\\d+)(\\.\\d+)?${EXPONENT}$`);
const VALID_EU_RE = new RegExp(`^[+-]?(\\d{1,3}(\\.\\d{3})+|\\d+)(,\\d+)?${EXPONENT}$`);

/**
 * Validate before stripping. Both readings used to strip blindly and cast
 * whatever fell out, which turns a value written in the OTHER convention into
 * a plausible wrong number rather than a null: under the English reading
 * "1.234,56" loses its comma, becomes "1.23456", and casts perfectly -- three
 * orders of magnitude adrift, in a column showing no nulls.
 */

/**
 * "1.234" / "1,234": one separator, exactly three digits after it, nothing
 * else. Genuinely undecidable in isolation -- 1234 or 1.234 -- and the single
 * most important shape here to get right.
 */
const AMBIGUOUS_GROUP_RE = /^[+-]?\d{1,3}[,.]\d{3}$/;

/**
 * A value carrying BOTH separators describes its own convention: whichever
 * comes last is the decimal point, and only one reading is well-formed. These
 * are the only shapes that need no column-level evidence at all.
 */
const BOTH_SEP_EN_RE = /^[+-]?\d{1,3}(,\d{3})+\.\d+$/;
const BOTH_SEP_EU_RE = /^[+-]?\d{1,3}(\.\d{3})+,\d+$/;

/** Accounting negatives: "(1.234,56)" means -1234.56. */
const PARENS_NEGATIVE_RE = /^\((.*)\)$/;

export type NumberLocale = 'en' | 'eu';

export type LocaleVerdict =
  /** Decisively one convention. Safe to pass to DuckDB. */
  | { kind: 'decided'; locale: NumberLocale; enScore: number; euScore: number; ambiguous: number }
  /**
   * No separator anywhere, or nothing numeric at all. The two readings are
   * provably identical, so there is nothing to decide and nothing at risk.
   */
  | { kind: 'no-separators' }
  /**
   * Genuinely undecidable. The caller must leave the column as text and SAY
   * SO -- this is the refusal that the whole module exists to produce.
   */
  | {
      kind: 'undecidable';
      enScore: number;
      euScore: number;
      ambiguous: number;
      /** Up to three offending values, for the notice shown to the user. */
      samples: string[];
    };

function cleanValues(values: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s !== '') out.push(s);
  }
  return out;
}

function unwrapParens(value: string): { inner: string; wrapped: boolean } {
  const m = PARENS_NEGATIVE_RE.exec(value);
  return m ? { inner: m[1], wrapped: true } : { inner: value, wrapped: false };
}

/** `_parse_en`: English/US-style, comma = thousands. null when not well-formed. */
export function parseEn(value: string): number | null {
  const { inner, wrapped } = unwrapParens(value.trim());
  if (!VALID_EN_RE.test(inner)) return null;
  const n = Number(inner.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return wrapped ? -n : n;
}

/** `_parse_eu`: European/Turkish-style, dot = thousands. null when not well-formed. */
export function parseEu(value: string): number | null {
  const { inner, wrapped } = unwrapParens(value.trim());
  if (!VALID_EU_RE.test(inner)) return null;
  const n = Number(inner.replace(/\./g, '').replace(/,/g, '.'));
  if (!Number.isFinite(n)) return null;
  return wrapped ? -n : n;
}

/**
 * `_numeric_locale_confidence`. Each value contributes to at most one bucket
 * (3 / 2 / 1), highest-specificity pattern first.
 *
 * Ambiguous values score NOTHING, for either convention. They used to score 3
 * for eu ("a thousands group") and 2 for en ("a decimal"), which made eu
 * structurally higher for that shape -- so a column of plain English
 * three-decimal rates could never reach the equal-score guard, and every
 * value was silently multiplied by 1000 into a column that looked perfectly
 * healthy. A value that cannot discriminate must not count as evidence for
 * either side.
 */
export function scoreLocale(
  values: readonly (string | null | undefined)[],
  locale: NumberLocale
): number {
  const v = cleanValues(values).filter((s) => !AMBIGUOUS_GROUP_RE.test(s));
  if (v.length === 0) return 0;

  const [p1, p2, p3] =
    locale === 'en'
      ? [/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/, /^[+-]?\d+\.\d+$/, /^[+-]?\d+(\.\d+)?$/]
      : [/^[+-]?\d{1,3}(\.\d{3})+(,\d+)?$/, /^[+-]?\d+,\d+$/, /^[+-]?\d+(,\d+)?$/];

  let score = 0;
  for (const s of v) {
    if (p1.test(s)) score += 3;
    else if (p2.test(s)) score += 2;
    else if (p3.test(s)) score += 1;
  }
  return score;
}

/** `_ambiguous_separator_count`. */
export function countAmbiguous(values: readonly (string | null | undefined)[]): number {
  return cleanValues(values).filter((s) => AMBIGUOUS_GROUP_RE.test(s)).length;
}

/** The values that made a column undecidable, for the notice. */
function ambiguousSamples(values: readonly (string | null | undefined)[], n = 3): string[] {
  return cleanValues(values)
    .filter((s) => AMBIGUOUS_GROUP_RE.test(s))
    .slice(0, n);
}

/**
 * `_parse_auto`'s arbitration, minus the parsing.
 *
 * Contract, carried over verbatim: if the column is genuinely ambiguous it
 * returns `undecidable` rather than guessing, and the caller leaves the text
 * alone. That is the same decision the trading engine's SeparatorError makes.
 */
export function decideLocale(values: readonly (string | null | undefined)[]): LocaleVerdict {
  const v = cleanValues(values);
  if (v.length === 0) return { kind: 'no-separators' };

  // Nothing carries a separator, so there is no disagreement to arbitrate:
  // strip the grouping alternatives out of VALID_EU_RE and it reduces to
  // VALID_EN_RE, and parseEu's two replacements become no-ops. The readings
  // are provably identical. (ETL keeps this as a fast path because plain
  // integer columns -- ids, counts, years -- are the commonest shape in any
  // real file.)
  if (!v.some((s) => /[.,]/.test(s))) return { kind: 'no-separators' };

  // Where BOTH readings produce a value, and they agree everywhere, the
  // column cannot be misread -- take it without scoring.
  //
  // MEASURED AND REJECTED upstream: "if one reading parsed nothing, return
  // the other". parseEu CAN read "(1.234,56)", but scoreLocale sees the
  // parentheses, matches no pattern and scores zero -- so the column is
  // refused and left as text. That refusal is the point: "this parses" and
  // "this column carries evidence of a convention" are independent tests, and
  // where they disagree the scoring decides.
  let comparable = 0;
  let agreed = 0;
  for (const s of v) {
    const en = parseEn(s);
    const eu = parseEu(s);
    if (en !== null && eu !== null) {
      comparable += 1;
      if (en === eu) agreed += 1;
    }
  }
  if (comparable > 0 && agreed === comparable) {
    return { kind: 'decided', locale: 'en', enScore: 0, euScore: 0, ambiguous: 0 };
  }

  const enScore = scoreLocale(v, 'en');
  const euScore = scoreLocale(v, 'eu');
  const ambiguous = countAmbiguous(v);
  const samples = ambiguousSamples(v);

  if (enScore === 0 && euScore === 0) {
    // Every separated value is of the undecidable shape and nothing else in
    // the column breaks the tie.
    if (ambiguous > 0) return { kind: 'undecidable', enScore, euScore, ambiguous, samples };
    return { kind: 'no-separators' };
  }

  // The equal-score guard, and then the margin gate. Both only bite when at
  // least one value could plausibly be read either way -- a column with no
  // ambiguous value has nothing to lose by taking the higher score.
  if (enScore === euScore && ambiguous > 0) {
    return { kind: 'undecidable', enScore, euScore, ambiguous, samples };
  }
  const margin = Math.abs(enScore - euScore) / Math.max(v.length, 1);
  if (ambiguous > 0 && margin < 0.2) {
    return { kind: 'undecidable', enScore, euScore, ambiguous, samples };
  }

  return {
    kind: 'decided',
    locale: enScore > euScore ? 'en' : 'eu',
    enScore,
    euScore,
    ambiguous,
  };
}

/**
 * Would reading this value under `locale` change it? Used to build the
 * "1.234 is 1234 read as Turkish, 1.234 read as English" notice, so the user
 * is shown the actual divergence rather than a rule.
 */
export function bothReadings(value: string): { en: number | null; eu: number | null } {
  return { en: parseEn(value), eu: parseEu(value) };
}

/**
 * Column-level verdict for a whole file, plus the fraction of values that
 * would survive the chosen reading.
 *
 * `threshold` mirrors ETL's `_convert_numeric_like_columns(threshold=0.85)`:
 * a column converts only if at least this fraction of its non-empty values
 * parse, so a genuine text column carrying a few numeric-looking values is
 * never mangled into numbers.
 */
export function decideColumn(
  values: readonly (string | null | undefined)[],
  threshold = 0.85
): LocaleVerdict {
  const verdict = decideLocale(values);
  if (verdict.kind !== 'decided') return verdict;

  const v = cleanValues(values);
  if (v.length === 0) return { kind: 'no-separators' };
  const parse = verdict.locale === 'en' ? parseEn : parseEu;
  const parsed = v.reduce((n, s) => n + (parse(s) !== null ? 1 : 0), 0);
  if (parsed / v.length < threshold) {
    // Mostly not numbers at all -- a text column. Nothing for DuckDB to do.
    return { kind: 'no-separators' };
  }
  return verdict;
}

/**
 * The file-level decision: read every sampled column, and only claim a
 * convention if at least one column decided and none decided the other way.
 *
 * `read_csv`'s options are per-file, not per-column, so one dissenting column
 * has to block the whole file rather than be outvoted -- being right about
 * most columns is not good enough when the cost of being wrong about one is a
 * silent 1000x.
 */
export function decideFile(columns: ReadonlyMap<string, readonly (string | null | undefined)[]>): {
  locale: NumberLocale | null;
  decided: string[];
  undecidable: { column: string; samples: string[] }[];
  conflicting: boolean;
} {
  const decided: string[] = [];
  const undecidable: { column: string; samples: string[] }[] = [];
  const seen = new Set<NumberLocale>();

  for (const [name, values] of columns) {
    const verdict = decideColumn(values);
    if (verdict.kind === 'decided') {
      seen.add(verdict.locale);
      decided.push(name);
    } else if (verdict.kind === 'undecidable') {
      undecidable.push({ column: name, samples: verdict.samples });
    }
  }

  const conflicting = seen.size > 1;
  // Only 'eu' needs non-default options; 'en' is what read_csv already does.
  const locale = conflicting || seen.size === 0 ? null : [...seen][0];
  return { locale, decided, undecidable, conflicting };
}

/**
 * `thousands` must not equal `decimal_separator`. DuckDB does reject that
 * pairing itself -- "Binder Error: THOUSANDS must not appear in the
 * DECIMAL_SEPARATOR specification and vice versa" -- but only once the path
 * has resolved. Verified against 1.5.5: against a missing file the same call
 * fails on file resolution instead, so the pairing is never examined. A bad
 * *setting* therefore stays silent until the user's next successful file
 * open. Validate it where it is set, and keep DuckDB's check as the backstop.
 */
export function csvLocaleOptions(locale: NumberLocale | 'tr'): {
  decimal: string;
  thousands: string;
} {
  // "tr" is accepted as a spelling of "eu", matching ETL's
  // _convert_series_by_locale({"eu", "tr"}).
  //
  // Anything else throws rather than falling through to a default. An
  // unrecognised setting -- a typo, or a locale name this build does not know
  // -- silently becoming "en" is the same class of failure as guessing the
  // separator: it produces numbers that look fine and are wrong.
  let opts: { decimal: string; thousands: string };
  if (locale === 'eu' || locale === 'tr') opts = { decimal: ',', thousands: '.' };
  else if (locale === 'en') opts = { decimal: '.', thousands: ',' };
  else throw new Error(`Invalid number locale "${locale}": expected "en", "eu" or "tr".`);

  if (opts.decimal === opts.thousands) {
    throw new Error(
      `Invalid number locale "${locale}": decimal separator and thousands separator are both "${opts.decimal}".`
    );
  }
  return opts;
}
