/**
 * Which slice of the rows is actually in the DOM.
 *
 * The grid renders a window rather than every row, with spacer rows standing
 * in for what is above and below so the scrollbar keeps its true length. That
 * arithmetic was buried inside `renderVirtualWindow`, wrapped around
 * `document.createElement` calls, and so was unreachable from a test despite
 * being pure -- four numbers in, two numbers out.
 *
 * It is worth reaching. The failure mode is not a crash: it is rows quietly
 * missing from the middle of a long scroll, or a spacer of the wrong height
 * making the scrollbar disagree with the content. Both look like rendering
 * glitches and are actually off-by-ones in these four lines.
 */

/**
 * Rows drawn beyond the viewport on each side, so a fast scroll does not flash
 * empty. 8 is the value the grid has always used; it is carried over exactly
 * rather than re-chosen, because this extraction is meant to change nothing a
 * user could see.
 */
export const VIRTUAL_OVERSCAN = 8;

export interface VirtualWindow {
  /** First row index to render, inclusive. */
  start: number;
  /** Last row index to render, exclusive. */
  end: number;
  /** Height of the spacer standing in for the rows above `start`. */
  topSpacerPx: number;
  /** Height of the spacer standing in for the rows below `end`. */
  bottomSpacerPx: number;
}

export function computeVirtualWindow(options: {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  rowCount: number;
  overscan?: number;
}): VirtualWindow {
  const { scrollTop, rowCount } = options;
  const overscan = options.overscan ?? VIRTUAL_OVERSCAN;
  // A zero or negative row height would divide the viewport into infinitely
  // many rows; clamped rather than trusted because it is measured from a
  // rendered row and a hidden or collapsed grid legitimately measures zero.
  const rowHeight = options.rowHeight > 0 ? options.rowHeight : 1;
  const viewportHeight = options.viewportHeight > 0 ? options.viewportHeight : 400;

  const end = Math.min(rowCount, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  // `start` is clamped against `end`, not just against zero. Without the upper
  // clamp a scrollTop past the content height -- macOS elastic overscroll, or a
  // row height re-measured smaller than the one the last layout used -- puts
  // `start` beyond the last row, which makes the top spacer taller than the
  // whole table and the bottom spacer negative. The original had the same gap;
  // it never showed because a scroll container normally cannot exceed its own
  // content height, and the invariant below is what surfaced it.
  const start = Math.min(Math.max(0, Math.floor(scrollTop / rowHeight) - overscan), end);

  return {
    start,
    end,
    topSpacerPx: start * rowHeight,
    // Computed from the row COUNT rather than by subtracting the rendered
    // height, so the two spacers plus the rendered rows always add up to the
    // full scroll height exactly -- which is what keeps the scrollbar honest.
    bottomSpacerPx: (rowCount - end) * rowHeight,
  };
}
