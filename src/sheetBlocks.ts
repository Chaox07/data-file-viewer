/**
 * Where does the table actually start on this sheet?
 *
 * A published workbook rarely puts its header on row 1. `YieldCurve_Data.xlsx`
 * is typical:
 *
 *     used-YieldCurve                        Raw_Data
 *       r2  Series | Compounding | Mnemonic    r2   Note: This is not an offic...
 *       r3  Zero-coupon yield | ...            r4-9 Series | Compounding | ...
 *       r4  (blank)                            r10  (blank)
 *       r5  #of Years to Maturity              r11  Date | BETA0 | BETA1 | ...
 *       r6  Date | 1 | 2 | 3 | ...             r12  1961-06-14 | 3.9176 | ...
 *       r7  1961-06-14 | 2.9825 | ...
 *
 * Handed to `read_xlsx` as-is, the first row becomes the column names and the
 * real header becomes a data row, so the sheet cannot be charted.
 *
 * This is STRUCTURE, not cleaning. The distinction is the one ETL itself
 * draws in `_split_blocks` (etl_shape.py:1277): block-splitting and header
 * promotion are "structural parsing, not a cleanliness judgment", and are
 * what that function does even with `discard_footnote_blocks = False`. The
 * things behind that flag -- `discard_footnote_blocks`,
 * `_looks_like_metadata_footer_block` (etl_shape.py:980), and every "is this
 * block worth keeping" heuristic -- are deliberately NOT ported.
 *
 * AND SAYING THAT IS NOT ENOUGH. The first version of this file picked the
 * widest block, called the rest `notes`, and handed the caller a list of
 * strings -- which the caller showed as three lines of a toast. Nothing was
 * "dropped" in the sense that no code deleted it, and it was still gone: there
 * was no object anywhere holding the footnote at the top of `Raw_Data`, so it
 * could not be read, sorted, exported or plotted. Reported as exactly that.
 *
 * So `pickTable` still names the block the sheet is ABOUT -- something has to
 * be the object called `Raw_Data` -- and `sheetFragments` below hands back
 * every other rectangle on the sheet with the bounds needed to open each one
 * as an object of its own. A sheet holding six things offers six things.
 *
 * WHERE THIS DIVERGES FROM ETL, and why. ETL decides "is the first row of
 * this block a header?" from the row itself -- all-strings, or a date-like
 * label, behind a breadth gate. That rule picks r5 above: `#of Years to
 * Maturity` is a lone string, and a spanning label over the numeric header is
 * indistinguishable from a header when you only look at one row. The result
 * is a one-column table.
 *
 * So the header is chosen by WIDTH instead, against the block's own modal
 * populated width -- the signal recorded in the project's xlsx geometry
 * notes, and the one thing that actually separates these rows: the preamble
 * populates 3-4 cells and the spanning label 1, while the header and every
 * data row populate 34 (101 on Raw_Data). A row that does not reach the
 * width the block settles into is not that block's header.
 *
 * Nothing here reads or writes a file; it is a pure function over cell values.
 */

export type Cell = string | number | boolean | null | undefined;

export interface SheetBlock {
  /** 0-based row index of the block's first row in the original sheet. */
  startRow: number;
  /** 0-based, exclusive. */
  endRow: number;
  /**
   * Promoted header, or null when no row in the block reached the block's
   * modal width (a note block, typically).
   */
  header: string[] | null;
  /** 0-based index of the header row in the original sheet, when promoted. */
  headerRow: number | null;
  /** Rows above the header inside this block — a spanning label, say. */
  preamble: Cell[][];
  /** Data rows, header excluded. */
  rows: Cell[][];
  /** The block's modal populated width. */
  width: number;
  /**
   * The columns this block actually occupies, as 0-based indices into the rows
   * it was given. `-1` for both when the block holds nothing.
   *
   * The block's own extent, not the sheet's: `Raw_Data`'s footnote sits alone
   * in column B of a sheet 100 columns wide, and reading it across the sheet's
   * width would give one sentence and 99 empty columns. A caller turning a
   * block into a range needs the block's own bounds.
   */
  firstCol: number;
  lastCol: number;
}

/** The columns any of these rows populate, as 0-based indices. */
function columnExtent(rows: readonly Cell[][]): { firstCol: number; lastCol: number } {
  let firstCol = -1;
  let lastCol = -1;
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      if (isBlank(row[i])) continue;
      if (firstCol === -1 || i < firstCol) firstCol = i;
      if (i > lastCol) lastCol = i;
    }
  }
  return { firstCol, lastCol };
}

export interface SheetShape {
  /** The block the sheet is "about" — the widest one. Null when the sheet is empty. */
  table: SheetBlock | null;
  /** Everything else, in sheet order. Kept, never discarded. */
  notes: SheetBlock[];
  /** All blocks, for a caller that wants to offer them individually. */
  blocks: SheetBlock[];
}

function isBlank(v: Cell): boolean {
  return v === null || v === undefined || String(v).trim() === '';
}

/** Populated cells in a row — the width signal everything here turns on. */
function populatedWidth(row: readonly Cell[]): number {
  let n = 0;
  for (const v of row) if (!isBlank(v)) n++;
  return n;
}

function isBlankRow(row: readonly Cell[]): boolean {
  return populatedWidth(row) === 0;
}

/**
 * Split on genuinely blank rows only.
 *
 * ETL's `sentinels=False`, and for the same reason: a row holding the literal
 * text "NULL" or "NONE" is a row of data whose value is missing, and treating
 * it as a separator split one table in two, the rows below becoming a second
 * table with fabricated column names.
 */
function rawBlocks(rows: readonly Cell[][]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start: number | null = null;
  for (let i = 0; i < rows.length; i++) {
    if (isBlankRow(rows[i])) {
      if (start !== null) {
        out.push({ start, end: i });
        start = null;
      }
    } else if (start === null) {
      start = i;
    }
  }
  if (start !== null) out.push({ start, end: rows.length });
  return out;
}

/**
 * The width a block settles into. The mode rather than the max, so one
 * unusually wide note row cannot set the bar above the header.
 */
function modalWidth(rows: readonly Cell[][]): number {
  const counts = new Map<number, number>();
  for (const r of rows) {
    const w = populatedWidth(r);
    if (w > 0) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = 0;
  for (const [w, c] of counts) {
    // Ties go to the wider row: between a header at 34 and a scatter of
    // 34-wide data rows they agree anyway, and where they do not, the wider
    // reading keeps columns rather than dropping them.
    if (c > bestCount || (c === bestCount && w > best)) {
      best = w;
      bestCount = c;
    }
  }
  return best;
}

function headerText(row: readonly Cell[], width: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < width; i++) {
    const v = row[i];
    out.push(isBlank(v) ? `_col${i}` : String(v).trim());
  }
  return dedupe(out);
}

/**
 * Excel lets two columns carry the same caption; a view cannot. Suffix
 * repeats rather than dropping them, so the column count still matches the
 * data and nothing silently disappears.
 */
export function dedupe(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    const name = raw === '' ? '_col' : raw;
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    return n === 0 ? name : `${name}_${n}`;
  });
}

/**
 * Split one sheet into blocks and promote each block's header.
 *
 * `minHeaderRatio`: how close to the modal width a row must come to be that
 * block's header. Not 1.0, because a real header can leave a trailing column
 * unlabelled while its data rows fill it.
 */
export function splitBlocks(
  rows: readonly Cell[][],
  opts: { minHeaderRatio?: number; minHeaderCols?: number } = {}
): SheetBlock[] {
  const minHeaderRatio = opts.minHeaderRatio ?? 0.75;
  // A one-column "table" is a note. ETL's min_secondary_cols, same value.
  const minHeaderCols = opts.minHeaderCols ?? 2;

  return rawBlocks(rows).map(({ start, end }) => {
    const body = rows.slice(start, end);
    const width = modalWidth(body);
    // How wide a row must be to count as this block's header.
    //
    // The ratio alone is wrong at small widths: ceil(3 * 0.75) is 3, which
    // demands an EXACT match, so a 2-wide header over 3-wide data rows was
    // skipped and the first data row promoted in its place -- the column
    // names became a date and a number. Allowing a one-column shortfall fixes
    // that without touching the wide case: at width 33 the bar is still 25,
    // so the 3-wide spanning label is still rejected.
    const need = Math.max(minHeaderCols, Math.min(width - 1, Math.ceil(width * minHeaderRatio)));

    // The first row that reaches the block's own width. Rows above it are a
    // spanning label or a caption -- kept as preamble, never dropped.
    let headerIdx = -1;
    for (let i = 0; i < body.length; i++) {
      if (populatedWidth(body[i]) >= need && populatedWidth(body[i]) >= minHeaderCols) {
        headerIdx = i;
        break;
      }
    }

    const extent = columnExtent(body);

    if (headerIdx === -1) {
      return {
        startRow: start,
        endRow: end,
        header: null,
        headerRow: null,
        preamble: [],
        rows: body,
        width,
        ...extent,
      };
    }

    // The widest row overall bounds the header: a header may be narrower than
    // a data row that fills a trailing column, and truncating to the header's
    // own populated count would drop that column.
    const span = Math.max(...body.map((r) => r.length), width);
    return {
      startRow: start,
      endRow: end,
      header: headerText(body[headerIdx], span),
      headerRow: start + headerIdx,
      preamble: body.slice(0, headerIdx),
      rows: body.slice(headerIdx + 1),
      width,
      ...extent,
    };
  });
}

/**
 * Which block is the table, and what is commentary.
 *
 * The widest block wins, ties broken by row count then by position. On the
 * YieldCurve sheets that is unambiguous -- 34 or 101 columns against the
 * preamble's 3 -- and on an ordinary single-block sheet it is the only
 * candidate, so nothing changes for the common case.
 */
export function pickTable(blocks: readonly SheetBlock[]): SheetShape {
  const usable = blocks.filter((b) => b.rows.length > 0 || b.header !== null);
  if (usable.length === 0) {
    return { table: null, notes: [...blocks], blocks: [...blocks] };
  }
  let table = usable[0];
  for (const b of usable.slice(1)) {
    if (b.width > table.width) table = b;
    else if (b.width === table.width && b.rows.length > table.rows.length) table = b;
  }
  return {
    table,
    notes: blocks.filter((b) => b !== table),
    blocks: [...blocks],
  };
}

/** The whole job: rows in, shape out. */
export function analyseSheet(
  rows: readonly Cell[][],
  opts?: { minHeaderRatio?: number; minHeaderCols?: number }
): SheetShape {
  return pickTable(splitBlocks(rows, opts));
}

/**
 * Does this sheet need interpreting at all?
 *
 * False for the ordinary case -- one block whose header is already row 1 --
 * so the caller can keep reading those sheets exactly as it did before, and
 * only the sheets that actually need it take the different path.
 */
export function needsBlockHandling(shape: SheetShape): boolean {
  if (!shape.table) return false;
  return shape.notes.length > 0 || shape.table.headerRow !== 0 || shape.table.preamble.length > 0;
}

/**
 * One rectangle of a sheet that is not the main table.
 *
 * Everything here is an INDEX into the rows that were analysed, not an Excel
 * address — the caller knows where its sample started and converts. Each one is
 * meant to become its own object in the catalog, so that a sheet holding six
 * things offers six things.
 */
export interface SheetFragment {
  /** 0-based, into the analysed rows. */
  startRow: number;
  /** 0-based, exclusive. */
  endRow: number;
  /** 0-based column indices into those rows, inclusive. */
  firstCol: number;
  lastCol: number;
  /**
   * Whether the fragment's first row is a header for the rows under it.
   *
   * False for a caption, a footnote, or any block no header could be promoted
   * for — read those with `header = false`, or a lone sentence becomes a
   * column name and the fragment comes back with no rows at all.
   */
  hasHeader: boolean;
}

/**
 * Every part of the sheet the main table does not cover, in sheet order.
 *
 * Two sources: the rows above the main table's header inside its own block (a
 * spanning label, a caption), and every other block. A block that has both a
 * caption and a header of its own yields two fragments for the same reason the
 * main table does — the caption is not a column name.
 */
export function sheetFragments(shape: SheetShape): SheetFragment[] {
  const out: SheetFragment[] = [];
  const push = (startRow: number, endRow: number, rows: readonly Cell[][], hasHeader: boolean) => {
    if (endRow <= startRow) return;
    // Measured from the cells, never from a promoted header: headerText() pads
    // with `_colN` placeholders, which are not blank, so a header would report
    // the block as spanning every column the widest row of the sheet reaches.
    const { firstCol, lastCol } = columnExtent(rows);
    if (firstCol === -1) return;
    out.push({ startRow, endRow, firstCol, lastCol, hasHeader });
  };

  for (const b of shape.blocks) {
    if (b === shape.table) {
      // Only its preamble: the table itself is the object the sheet is named for.
      push(b.startRow, b.headerRow ?? b.startRow, b.preamble, false);
      continue;
    }
    if (b.headerRow === null) {
      push(b.startRow, b.endRow, b.rows, false);
      continue;
    }
    push(b.startRow, b.headerRow, b.preamble, false);
    // The block's own extent for the headed part: its header row's cells are
    // only available as promoted text, and the data rows alone can leave a
    // trailing labelled-but-empty column out.
    if (b.endRow > b.headerRow && b.firstCol !== -1) {
      out.push({
        startRow: b.headerRow,
        endRow: b.endRow,
        firstCol: b.firstCol,
        lastCol: b.lastCol,
        hasHeader: true,
      });
    }
  }

  return out.sort((a, z) => a.startRow - z.startRow);
}
