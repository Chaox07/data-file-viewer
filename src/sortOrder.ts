/**
 * Client-side row ordering for the results grid.
 *
 * Split out of webview.ts so it can be tested directly — webview.ts touches
 * the DOM at import time and can't be loaded outside a browser context. The
 * property that matters most is that this agrees with the ordering DuckDB
 * produces for the same column, since a LIMIT-ed result is sorted server-side
 * and everything else is sorted here: a disagreement between the two shows up
 * as the grid silently contradicting itself depending on the query.
 */

export type SortKind = 'numeric' | 'datetime' | 'other';

// Raw `<`/`>` on strings is UTF-16 code-unit order, which for a data grid is
// close to arbitrary: every uppercase letter sorts before every lowercase one
// ("Zebra" before "apple"), "10" before "9", and every non-ASCII letter after
// "z" — so Turkish ç/ı/ö/ş/ü all landed past the end of the alphabet. One
// collator, built once: constructing one per comparison would be far slower
// than the code this replaces.
const textCollator = new Intl.Collator(undefined, { numeric: true });

/** Values DuckDB sends as plain decimal strings, which Number() may not hold exactly. */
const DECIMAL_RE = /^-?\d+(?:\.\d+)?$/;

/** Value-to-string used for the sort fallback and JSON-detection — distinct
 *  from formatValue (display) since it needs to be collision-resistant for
 *  ordering (JSON.stringify for objects, not the raw "[object Object]"
 *  String() would produce). */
export function sortableString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Exact ordering for decimal strings of any magnitude — BIGINT/HUGEINT/DECIMAL past 2^53. */
export function compareDecimalStrings(a: string, b: string): number {
  const aNeg = a.startsWith('-');
  const bNeg = b.startsWith('-');
  if (aNeg !== bNeg) return aNeg ? -1 : 1;
  const magnitude = compareMagnitudes(aNeg ? a.slice(1) : a, bNeg ? b.slice(1) : b);
  return aNeg ? -magnitude : magnitude;
}

function compareMagnitudes(a: string, b: string): number {
  const aDot = a.indexOf('.');
  const bDot = b.indexOf('.');
  const aInt = (aDot === -1 ? a : a.slice(0, aDot)).replace(/^0+(?=\d)/, '');
  const bInt = (bDot === -1 ? b : b.slice(0, bDot)).replace(/^0+(?=\d)/, '');
  // Same-radix integers: more digits means larger, and equal digit counts
  // compare correctly lexicographically.
  if (aInt.length !== bInt.length) return aInt.length < bInt.length ? -1 : 1;
  if (aInt !== bInt) return aInt < bInt ? -1 : 1;
  const aFrac = aDot === -1 ? '' : a.slice(aDot + 1);
  const bFrac = bDot === -1 ? '' : b.slice(bDot + 1);
  // Zero-padded to equal length, so plain code-unit comparison of two digit
  // strings is exactly numeric comparison.
  const width = Math.max(aFrac.length, bFrac.length);
  const aPad = aFrac.padEnd(width, '0');
  const bPad = bFrac.padEnd(width, '0');
  return aPad < bPad ? -1 : aPad > bPad ? 1 : 0;
}

/**
 * Permutation of original row indices — never physically reorders
 * rows/cellChanged/rowIsNew, so every array stays indexed by the same
 * original row index and diff-highlighting alignment is structural, not
 * something that has to be hand-maintained across a sort.
 *
 * Keys are derived once per row (decorate–sort–undecorate) rather than inside
 * the comparator, which previously ran String()/JSON.stringify roughly
 * 2·n·log n times per render — and the grid re-renders on every live tick.
 *
 * Which key depends on `kind` (the server-computed columnStatsKind), not on
 * the JS runtime type: DuckDB's node-api sends BIGINT/HUGEINT/DECIMAL/DATE/
 * TIMESTAMP over the wire as *strings*, so a `typeof value === 'number'` test
 * misses every one of them and silently falls through to text ordering.
 */
export function computeSortOrder(
  rows: unknown[][],
  columnIndex: number,
  direction: 'asc' | 'desc',
  kind: SortKind
): number[] {
  const n = rows.length;
  const order = Array.from({ length: n }, (_, i) => i);
  const sign = direction === 'asc' ? 1 : -1;

  // "Last" means last in both directions, matching the `nulls last` the
  // server-side sort uses — so the two agree on where nulls go.
  const trailing = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = rows[i][columnIndex];
    if (v === null || v === undefined) trailing[i] = 1;
  }
  const withTrailing =
    (cmp: (a: number, b: number) => number) =>
    (a: number, b: number): number => {
      if (trailing[a] && trailing[b]) return 0;
      if (trailing[a]) return 1;
      if (trailing[b]) return -1;
      return sign * cmp(a, b);
    };

  if (kind === 'numeric') {
    const nums = new Float64Array(n);
    let exact = true;
    for (let i = 0; i < n; i++) {
      if (trailing[i]) continue;
      const raw = rows[i][columnIndex];
      const num = typeof raw === 'number' ? raw : Number(raw);
      if (Number.isNaN(num)) {
        // NaN has no position in an ordering; park it with the nulls, which is
        // both what this code did before and where DuckDB puts it.
        trailing[i] = 1;
        continue;
      }
      nums[i] = num;
      // A double can't hold every BIGINT/HUGEINT/DECIMAL exactly. Detect the
      // loss once, here, rather than mis-ordering the large end of the column.
      if (exact && typeof raw !== 'number' && String(num) !== String(raw).trim()) exact = false;
    }
    if (exact) {
      order.sort(withTrailing((a, b) => (nums[a] < nums[b] ? -1 : nums[a] > nums[b] ? 1 : 0)));
      return order;
    }
    const texts = new Array<string>(n);
    let allDecimal = true;
    for (let i = 0; i < n && allDecimal; i++) {
      if (trailing[i]) continue;
      texts[i] = String(rows[i][columnIndex]).trim();
      if (!DECIMAL_RE.test(texts[i])) allDecimal = false;
    }
    if (allDecimal) {
      order.sort(withTrailing((a, b) => compareDecimalStrings(texts[a], texts[b])));
      return order;
    }
    // Not actually decimal text after all — fall through to the text path.
  }

  if (kind === 'datetime') {
    const times = new Float64Array(n);
    let parseable = true;
    for (let i = 0; i < n && parseable; i++) {
      if (trailing[i]) continue;
      const t = Date.parse(String(rows[i][columnIndex]));
      if (Number.isNaN(t)) parseable = false;
      else times[i] = t;
    }
    if (parseable) {
      order.sort(withTrailing((a, b) => times[a] - times[b]));
      return order;
    }
    // INTERVAL, or a format Date.parse doesn't accept — fall through to text.
  }

  const texts = new Array<string>(n);
  for (let i = 0; i < n; i++) texts[i] = trailing[i] ? '' : sortableString(rows[i][columnIndex]);
  order.sort(withTrailing((a, b) => textCollator.compare(texts[a], texts[b])));
  return order;
}
