/** Detail is bounded by real, non-null points, across the visible series. */
export const DETAIL_POINT_LIMIT = 3000;

export interface ZoomRange {
  start?: number;
  end?: number;
  startValue?: number;
  endValue?: number;
  batch?: ZoomRange[];
}

export function zoomBounds(
  event: ZoomRange,
  extent: [number, number],
  previous: [number, number],
  category: boolean
): [number, number] {
  const range = event.batch?.[0] ?? event;
  const resolve = (value: number | undefined, percent: number | undefined, fallback: number) => {
    const result = value ?? (percent == null ? fallback : extent[0] + (extent[1] - extent[0]) * percent / 100);
    return category ? Math.round(result) : result;
  };
  const a = resolve(range.startValue, range.start, previous[0]);
  const b = resolve(range.endValue, range.end, previous[1]);
  return [Math.min(a, b), Math.max(a, b)];
}

/** Sorted x positions let wheel events count points without scanning the dataset. */
export function countVisiblePoints(xs: readonly number[], [lo, hi]: [number, number]): number {
  const bound = (value: number, inclusive: boolean) => {
    let left = 0;
    let right = xs.length;
    while (left < right) {
      const mid = (left + right) >>> 1;
      if (xs[mid] < value || (inclusive && xs[mid] === value)) left = mid + 1;
      else right = mid;
    }
    return left;
  };
  return bound(hi, true) - bound(lo, false);
}

export function detailStyle(mode: 'line' | 'scatter', enabled: boolean) {
  return {
    ...(mode === 'line' ? { showSymbol: enabled, showAllSymbol: enabled, symbol: 'circle', symbolSize: 5 } : {}),
    large: !enabled,
    largeThreshold: 2000,
    // Brush blocks the upstream layout task in ECharts 6.1. Incremental
    // scatter rendering then consumes mismatched point ranges on zoom reset.
    // Large mode still batches dense points into a single canvas path.
    progressive: 0,
    progressiveThreshold: 2000,
  };
}
