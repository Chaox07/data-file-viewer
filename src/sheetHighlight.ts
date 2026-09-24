/** Which sides of a cell lie on the outline of a selected table. */
export interface CellEdges {
  top: boolean;
  right: boolean;
  bottom: boolean;
  left: boolean;
}

/**
 * The outline of a detected table, one cell at a time.
 *
 * The coordinates are DetectedSheetTable's: 0-based, with `bottom` and `right`
 * exclusive, and `top` the header row. So the catalog's "B4:D9" is
 * `{ top: 3, bottom: 9, left: 1, right: 4 }`. Kept per cell rather than as one
 * overlay rectangle because the virtual window builds and discards rows as it
 * scrolls, so each row has to be able to draw its own part of the outline.
 */
export function tableEdges(
  table: { top: number; bottom: number; left: number; right: number },
  row: number,
  col: number
): CellEdges | undefined {
  if (row < table.top || row >= table.bottom || col < table.left || col >= table.right) return undefined;
  return {
    top: row === table.top,
    right: col === table.right - 1,
    bottom: row === table.bottom - 1,
    left: col === table.left,
  };
}
