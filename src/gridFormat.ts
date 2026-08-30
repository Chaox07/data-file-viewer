export type StatsKind = 'numeric' | 'datetime' | 'other';

/**
 * Turning a value into the text a cell shows.
 *
 * Lifted verbatim out of webview.ts, which is a browser bundle entry point with
 * no exports -- so none of this could be tested, despite being the last thing
 * that happens to a value before somebody reads it and believes it.
 *
 * That matters more here than the line count suggests. DuckDB's node-api sends
 * BIGINT, HUGEINT, DECIMAL, TIMESTAMP and DATE over the wire as plain STRINGS
 * (only the small int types and float/double arrive as JS numbers), which is
 * exactly what keeps a value past 2^53 intact on the way to the screen. The
 * `shapes` stress family generates those values; this is where they land, and
 * until now nothing checked what happened to them at the end of the trip.
 *
 * Everything below is string manipulation rather than toLocaleString(), so a
 * value's original precision is never rounded or truncated on the way to being
 * displayed.
 */

export function addThousandsSeparators(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * A cell's value, as displayed.
 *
 * `kind` (from columnStatsKind, computed server-side from the actual DuckDB
 * type) is what disambiguates a numeric string from a date string -- the wire
 * format alone cannot, since both arrive as text.
 */
export function formatValue(value: unknown, kind?: StatsKind): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  if (kind === 'numeric' && (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string')) {
    const match = String(value).match(/^(-?)(\d+)(\.\d+)?$/);
    if (match) {
      const [, sign, intPart, fracPart = ''] = match;
      return `${sign}${addThousandsSeparators(intPart)}${fracPart}`;
    }
  }
  return String(value);
}

/**
 * A computed statistic, at no more than four decimal places.
 *
 * Display-only, and deliberately NOT part of formatValue -- that one formats
 * cell values, and its promise never to touch a value's original precision has
 * to keep holding. This applies to avg and the two percentiles, which are
 * results of avg()/approx_quantile() rather than anything present in the data.
 *
 * "At most" four: an integer stays an integer and 0.5 stays 0.5, because
 * padding them out to 0.5000 would suggest a measurement precision that is not
 * there either. Non-numeric input falls through to formatValue unchanged.
 */
export function formatStat(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(n)) return formatValue(value, 'numeric');
  // parseFloat drops the trailing zeros toFixed adds; String() then avoids
  // toLocaleString, so addThousandsSeparators stays the one place grouping
  // happens.
  return formatValue(String(parseFloat(n.toFixed(4))), 'numeric');
}

/** A row count, for the footer. */
export function fmtCount(n: number): string {
  return n.toLocaleString();
}

/** How long ago something happened, for the live-refresh status line. */
export function formatAgo(ms: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s ago`;
}
