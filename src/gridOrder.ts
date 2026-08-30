import { computeSortOrder } from './sortOrder';
import type { StatsKind } from './gridFormat';

/**
 * Which rows to draw, in which order.
 *
 * Two things live here, and the second is the one worth testing.
 *
 * `computeDisplayOrder` carries a rule that is easy to lose in a refactor:
 * when DuckDB has ALREADY ordered the rows across the full data set
 * (`serverSorted`), sorting again on the client is not merely wasted work --
 * where the client comparator disagrees with DuckDB's ordering, it scrambles a
 * correct top-N back into a wrong one. The `consistency` stress family asserts
 * that a sorted top-N is the true top N; this is the code that can break that
 * promise after the data is already correct.
 *
 * `displayOrder` memoises it, because renderResults runs on every live tick.
 * The cache key is the interesting part: it is keyed on the rows OBJECT
 * IDENTITY plus the sort, so a live tick that replaces the rows invalidates
 * it, while a re-render of the same rows does not. A key that missed either
 * half would either sort on every tick or -- much worse -- show a stale order
 * over fresh rows.
 */

export interface OrderableResult {
  rows: unknown[][];
  columnStatsKind: StatsKind[];
  /** DuckDB already ordered these rows; see above. */
  serverSorted?: boolean;
}

export interface SortState {
  columnIndex: number;
  direction: 'asc' | 'desc';
}

export function computeDisplayOrder(result: OrderableResult, sortState: SortState | undefined): number[] {
  const n = result.rows.length;
  if (!sortState || result.serverSorted) return Array.from({ length: n }, (_, i) => i);
  return computeSortOrder(
    result.rows,
    sortState.columnIndex,
    sortState.direction,
    result.columnStatsKind[sortState.columnIndex]
  );
}

/** The memo. One per grid; webview.ts holds the single instance. */
export class DisplayOrderCache {
  private cached: { rows: unknown[][]; key: string; order: number[] } | undefined;

  order(result: OrderableResult, sortState: SortState | undefined): number[] {
    const key = sortState && !result.serverSorted ? `${sortState.columnIndex}:${sortState.direction}` : '';
    if (this.cached && this.cached.rows === result.rows && this.cached.key === key) {
      return this.cached.order;
    }
    const order = computeDisplayOrder(result, sortState);
    this.cached = { rows: result.rows, key, order };
    return order;
  }

  /** Drop the memo, for a caller that knows the rows changed in place. */
  invalidate(): void {
    this.cached = undefined;
  }
}
