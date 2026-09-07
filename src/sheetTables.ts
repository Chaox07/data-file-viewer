/**
 * Which tables does one worksheet hold, and where are they?
 *
 * A hand-built sheet is not a table. It is a page: a title, maybe a legend, one
 * or more tables, and footnotes under them. This finds the tables and says
 * nothing about the rest -- deliberately, because the caller shows the sheet
 * verbatim and only needs to know which rectangles inside it are worth offering
 * as typed, queryable, plottable objects.
 *
 * Nothing here discards anything. The module it replaces (`sheetBlocks.ts`)
 * picked the single widest block, called everything else "notes", and handed
 * the caller a list the caller turned into separate sidebar entries -- so a
 * footnote written under a table stopped being under the table. A viewer has no
 * business relocating the file it is showing. Here a region that is not a table
 * simply is not returned; it is still on the sheet, in its own rows, because
 * the sheet is read whole.
 *
 * ## What is ported, and from where
 *
 * The classification is the ETL pipeline's, function by function, so that a
 * sheet read here and the same sheet read by ETL/etl_parts/etl_shape.py agree
 * about how many tables it holds:
 *
 *   - header promotion            _split_blocks          etl_shape.py:1315-1359
 *   - a bare year as a header     _year_headed_header    etl_shape.py:1246-1274
 *   - continuation merge          _split_blocks          etl_shape.py:1405-1427
 *   - metadata-footer test        _looks_like_..._block  etl_shape.py:980-1101
 *   - label folding               _fold_label / _TR_FOLD etl_values.py:906-935
 *   - date-ish column names       _DATE_COL_PATTERN      etl_values.py:518-534
 *   - what counts as blank        _is_blank_value        etl_values.py:830-857
 *
 * Two deliberate divergences from the ETL, both because this is a viewer:
 *
 *   1. **Nothing is discarded.** ETL's `discarded_out` collects footnote text
 *      on its way to a metadata sidecar, because ETL's output has no room for
 *      it. Here the footnote is already on screen, at its own row number.
 *   2. **Every region promotes a header the same way.** ETL exempts its first
 *      block, whose column names come from a separate sheet-level header pass
 *      (`_find_header_row_idx`, etl_io.py:89). There is no such pass here --
 *      the sheet is read with `header = false` -- so there is no reason for the
 *      first region to be special, and making it special would mean the first
 *      table on a sheet was the one table whose header was not found.
 *
 * ## The 2-D split, which the ETL does not have
 *
 * ETL splits on blank ROWS only: `_split_blocks` builds its boundaries from
 * `_row_blank_mask` and slices `df[start:i]` (etl_shape.py:1296-1313), and a
 * blank column BETWEEN two tables is deleted as a `_colN` placeholder by
 * `_drop_empty_cols` (etl_shape.py:230-233) rather than read as a boundary. So
 * two tables side by side fuse into one wide block whose "header" is whichever
 * row first reaches their combined width -- usually neither table's.
 *
 * `splitRegions` below alternates row and column splits until neither divides
 * anything further. The same routine has been added to the ETL, behind
 * SPLIT_SIDE_BY_SIDE_TABLES, so the two stay in step.
 */

/** A cell as DuckDB hands it back from an `all_varchar` read. */
export type Cell = string | number | boolean | null | undefined;

/** A rectangle of the sheet grid. `top`/`left` inclusive, `bottom`/`right` exclusive. */
export interface Region {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface SheetTable {
  /**
   * The rectangle the TABLE occupies, 0-based into the grid it was found in,
   * and directly usable as a read range.
   *
   * When a header was promoted this starts AT the header row, not at the top of
   * the region the table was found in: a spanning caption above the header --
   * `#of Years to Maturity | 1-Period HPY's | Excess Returns` over
   * used-YieldCurve's 33 columns -- is not part of the table. It is not lost
   * either; it is still on the sheet, at its own row, because the sheet is read
   * whole.
   */
  region: Region;
  /**
   * 0-based grid row of the header, or null when no row in the region looked
   * like one (the table is then read positionally, with letter names).
   */
  headerRow: number | null;
  /** Column names: the promoted header, else the Excel letters for the span. */
  columns: string[];
  /** Rows below the header. Empty for a header-only table. */
  rowCount: number;
}

/* ------------------------------------------------------------------ blanks */

/**
 * Blank as STRUCTURE: is this cell absent?
 *
 * ETL's `sentinels=False`. The literal text "NULL"/"NONE" is NOT blank here,
 * and the reason is recorded at etl_shape.py:55-84: for a VALUE those words
 * mean missing, but for structure -- is this row a separator, is this column
 * empty -- they are data. Conflating the two silently split one table in two at
 * the first row whose only populated cell said "NULL", the rows below becoming
 * a second table with fabricated column names.
 *
 * Excel error markers (`#N/A`, `#DIV/0!`) are likewise populated: they occupy a
 * cell. They become null later, when a column's type is decided (textColumns).
 */
export function isBlank(v: Cell): boolean {
  return v === null || v === undefined || String(v).trim() === '';
}

/** ETL's `_BLANK_VALUE_SENTINELS` -- blank as a VALUE, not as structure. */
const VALUE_SENTINELS = new Set(['NULL', 'NONE']);

/** Blank as a VALUE: ETL's `sentinels=True`, used only by the size gate. */
function isBlankValue(v: Cell): boolean {
  if (isBlank(v)) return true;
  return VALUE_SENTINELS.has(String(v).trim().toUpperCase());
}

function cellAt(grid: readonly Cell[][], row: number, col: number): Cell {
  const r = grid[row];
  return r === undefined ? null : r[col];
}

/* ------------------------------------------------------------- region split */

function rowIsBlank(grid: readonly Cell[][], row: number, left: number, right: number): boolean {
  for (let c = left; c < right; c++) if (!isBlank(cellAt(grid, row, c))) return false;
  return true;
}

function colIsBlank(grid: readonly Cell[][], col: number, top: number, bottom: number): boolean {
  for (let r = top; r < bottom; r++) if (!isBlank(cellAt(grid, r, col))) return false;
  return true;
}

/** Trim blank rows and columns from a region's edges. Empty regions come back null. */
function shrink(grid: readonly Cell[][], region: Region): Region | null {
  let { top, bottom, left, right } = region;
  while (top < bottom && rowIsBlank(grid, top, left, right)) top++;
  while (bottom > top && rowIsBlank(grid, bottom - 1, left, right)) bottom--;
  while (left < right && colIsBlank(grid, left, top, bottom)) left++;
  while (right > left && colIsBlank(grid, right - 1, top, bottom)) right--;
  if (top >= bottom || left >= right) return null;
  return { top, bottom, left, right };
}

/** Split a region on its fully-blank rows. Returns the region alone when none divide it. */
function splitOnRows(grid: readonly Cell[][], region: Region): Region[] {
  const out: Region[] = [];
  let start: number | null = null;
  for (let r = region.top; r < region.bottom; r++) {
    if (rowIsBlank(grid, r, region.left, region.right)) {
      if (start !== null) {
        out.push({ ...region, top: start, bottom: r });
        start = null;
      }
    } else if (start === null) {
      start = r;
    }
  }
  if (start !== null) out.push({ ...region, top: start, bottom: region.bottom });
  return out;
}

/** Split a region on its fully-blank columns. */
function splitOnCols(grid: readonly Cell[][], region: Region): Region[] {
  const out: Region[] = [];
  let start: number | null = null;
  for (let c = region.left; c < region.right; c++) {
    if (colIsBlank(grid, c, region.top, region.bottom)) {
      if (start !== null) {
        out.push({ ...region, left: start, right: c });
        start = null;
      }
    } else if (start === null) {
      start = c;
    }
  }
  if (start !== null) out.push({ ...region, left: start, right: region.right });
  return out;
}

/**
 * Every maximal rectangle of the grid separated from its neighbours by a
 * wholly blank row or column.
 *
 * Alternating, and repeated to a fixed point, because one pass is not enough:
 * splitting a sheet on blank rows can expose a blank column inside one of the
 * resulting bands (two tables side by side occupying the same rows), and
 * splitting that band on the column can expose a blank row inside one of ITS
 * halves (the left table being shorter than the right). A grid of tables needs
 * both, repeatedly.
 *
 * Terminates because every recursion either returns its input unchanged -- and
 * stops -- or returns strictly smaller regions.
 */
export function splitRegions(grid: readonly Cell[][], region: Region): Region[] {
  const base = shrink(grid, region);
  if (!base) return [];

  const byRow = splitOnRows(grid, base);
  if (byRow.length > 1) return byRow.flatMap((r) => splitRegions(grid, r));

  const byCol = splitOnCols(grid, base);
  if (byCol.length > 1) return byCol.flatMap((r) => splitRegions(grid, r));

  return [base];
}

/** The whole grid as one region, ready to split. */
export function wholeGrid(grid: readonly Cell[][]): Region {
  let width = 0;
  for (const row of grid) if (row.length > width) width = row.length;
  return { top: 0, bottom: grid.length, left: 0, right: width };
}

/* ------------------------------------------------------------ header naming */

/** Column letters for a 0-based index: 0 -> A, 26 -> AA. */
export function columnLetters(index: number): string {
  let out = '';
  let n = index;
  for (;;) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    if (n < 26) return out;
    n = Math.floor(n / 26) - 1;
  }
}

/**
 * Excel lets two columns carry the same caption; a view cannot. Suffix repeats
 * rather than dropping them, so the column count still matches the data and
 * nothing silently disappears.
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

/** A header row as column names, blanks minted `_colN` the way ETL mints them. */
function headerNames(grid: readonly Cell[][], row: number, left: number, right: number): string[] {
  const out: string[] = [];
  for (let c = left; c < right; c++) {
    const v = cellAt(grid, row, c);
    out.push(isBlank(v) ? `_col${c - left}` : String(v).trim());
  }
  return dedupe(out);
}

/** Positional names for a region with no header: the sheet's own column letters. */
function letterNames(left: number, right: number): string[] {
  const out: string[] = [];
  for (let c = left; c < right; c++) out.push(columnLetters(c));
  return out;
}

/* -------------------------------------------------------- header detection */

/**
 * ETL's `_DATE_COL_PATTERN` (etl_values.py:518-534), verbatim.
 *
 * A bare year is deliberately NOT in here. ETL records why at
 * etl_values.py:593-598: matching one would make an ordinary row of yearly data
 * look like a header and get promoted. `yearHeadedHeader` below handles the
 * genuine "2019 | ppi | wage" case with a contrast test instead.
 */
export const DATE_COL_PATTERN =
  /^(?:date|datetime|time|timestamp|period|year|month|week|day|quarter|tarih|tarihi|zaman|yil|yıl|yillar|yıllar|donem|dönem|donemi|dönemi|ay|aylar|hafta|ceyrek|çeyrek|gun|gün|(?:date|dt|ts|time)_.+|.+_(?:date|datetime|dt|ts|time|timestamp|period)|[DWMQYHdwmqyh]\d*date|dt|ts)$/i;

/** Shared by table detection and chart-axis selection so the two cannot drift. */
export function isDateColumnName(name: string): boolean {
  return DATE_COL_PATTERN.test(name.trim());
}

function populatedCells(grid: readonly Cell[][], row: number, left: number, right: number): Cell[] {
  const out: Cell[] = [];
  for (let c = left; c < right; c++) {
    const v = cellAt(grid, row, c);
    if (!isBlank(v)) out.push(v);
  }
  return out;
}

/** Is this cell a string as the spreadsheet stored it (not a number wearing quotes)? */
function isText(v: Cell): boolean {
  return typeof v === 'string';
}

/**
 * ETL's `_year_headed_header` (etl_shape.py:1246-1274).
 *
 * "2019 | ppi | wage" is a header whose period column is labelled with a bare
 * year. Allowing a leading number on its own would eat real data rows, so this
 * demands CONTRAST: every cell after the first is text here, and the row below
 * is not shaped that way.
 */
function yearHeadedHeader(
  grid: readonly Cell[][],
  row: number,
  region: Region,
  populated: readonly Cell[]
): boolean {
  if (region.bottom - row < 2 || populated.length < 2) return false;
  const [first, ...rest] = populated;
  if (typeof first === 'boolean' || typeof first !== 'number' || !Number.isInteger(first)) return false;
  if (first < 1900 || first > 2100) return false;
  if (!rest.every(isText)) return false;
  const below = populatedCells(grid, row + 1, region.left, region.right);
  return !(below.length > 1 && below.slice(1).every(isText));
}

/**
 * The width a region settles into: the MODE of its populated row widths.
 *
 * The max is the wrong statistic and a workbook in daily use proves it --
 * `efektif_kur` in merged_excel.xlsx holds 124 rows of two columns and then,
 * below the table, five TCMB footnote rows of three (`Veri Kaynağı | TCMB`).
 * The mode ignores them, which is what a reader looking at the sheet does.
 *
 * Ties go to the NARROWER width, so doubt resolves toward leaving the sheet
 * alone. (The `sheetBlocks.ts` this replaces tied to the wider; the branch that
 * measured real files tied to the narrower, and that one was right.)
 */
function modalWidth(grid: readonly Cell[][], region: Region): number {
  const counts = new Map<number, number>();
  for (let r = region.top; r < region.bottom; r++) {
    const w = populatedCells(grid, r, region.left, region.right).length;
    if (w > 0) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  let width = 0;
  let best = 0;
  for (const [w, count] of counts) {
    if (count > best || (count === best && w < width)) {
      best = count;
      width = w;
    }
  }
  return width;
}

/** How close to the modal width a row must come before it can be the header. */
const MIN_HEADER_RATIO = 0.75;

/**
 * Which row of this region is its header, or null.
 *
 * Two gates, and BOTH are needed -- each one alone has a counter-example in a
 * real workbook:
 *
 *   - **Type**, which is ETL's (`_split_blocks`, etl_shape.py:1330-1345): a row
 *     is header-like when any populated cell reads like a date column name, OR
 *     every populated cell is text, OR it is year-headed. Alone, this promotes
 *     `#of Years to Maturity | 1-Period HPY's | Excess Returns` -- three strings
 *     spanning a 33-column table in `used-YieldCurve` -- and yields a 3-column
 *     table with the real header sitting inside it as data.
 *   - **Width**, against the region's MODAL width. Alone, this promotes the
 *     first row that happens to be full-width, data or not.
 *
 * Rows below the width bar are captions and are skipped over, which is how a
 * spanning label above a header is passed. The first row that clears the bar
 * settles it: if it is header-like it is the header, and if it is not then the
 * region's data starts there and nothing below it can be a header either.
 *
 * ETL tests only a block's FIRST row, because its sheet-level pass
 * (`_find_header_row_idx`, etl_io.py:89) has already consumed the sheet's
 * preamble before blocks exist. There is no such pass here -- the sheet is read
 * with `header = false` -- so the walk does that job instead.
 */
function findHeaderRow(grid: readonly Cell[][], region: Region, minCols: number): number | null {
  const span = region.right - region.left;
  const modal = modalWidth(grid, region);
  // Not the modal width exactly: a real header can leave a trailing column
  // unlabelled while its data rows fill it.
  const need = Math.max(
    Math.min(minCols, span),
    Math.min(Math.max(modal - 1, 1), Math.ceil(modal * MIN_HEADER_RATIO))
  );

  for (let r = region.top; r < region.bottom; r++) {
    const populated = populatedCells(grid, r, region.left, region.right);
    if (populated.length === 0) continue;
    if (populated.length < need) continue; // a caption; keep looking

    const breadthOk = populated.length >= Math.min(minCols, span);
    const looksLikeHeader =
      populated.some((v) => isText(v) && isDateColumnName(String(v))) ||
      (breadthOk && populated.every(isText)) ||
      (breadthOk && yearHeadedHeader(grid, r, region, populated));
    return looksLikeHeader ? r : null;
  }
  return null;
}

/* ------------------------------------------------- footnote / footer tests */

/** ETL's `_TR_FOLD` (etl_values.py:906-909). Deaccent, then lowercase; order matters. */
const TR_FOLD: Record<string, string> = {
  ş: 's', Ş: 's', ğ: 'g', Ğ: 'g', ı: 'i', İ: 'i',
  ö: 'o', Ö: 'o', ü: 'u', Ü: 'u', ç: 'c', Ç: 'c', â: 'a', Â: 'a',
};

/**
 * ETL's `_fold_label` (etl_values.py:922-935): deaccent, lowercase, and drop a
 * trailing colon, because labels are written WITH their colon in real files
 * ("Source:", "Notlar:").
 */
export function foldLabel(v: unknown): string {
  const s = String(v ?? '')
    .trim()
    .replace(/[şŞğĞıİöÖüÜçÇâÂ]/g, (ch) => TR_FOLD[ch] ?? ch)
    .toLowerCase();
  return s.endsWith(':') ? s.slice(0, -1).trim() : s;
}

/** ETL's `_METADATA_FOOTER_KNOWN_LABELS` (etl_shape.py:940-957). Stored deaccented. */
const KNOWN_LABELS = new Set([
  'unit', 'unit multiplier', 'source', 'sources', 'note', 'notes',
  'footnote', 'footnotes', 'definition', 'definitions', 'remark', 'remarks',
  'last updated', 'frequency', 'period', 'coverage', 'methodology',
  'kaynak', 'kaynaklar', 'not', 'notlar', 'dipnot', 'dipnotlar',
  'aciklama', 'aciklamalar', 'tanim', 'tanimlar', 'birim', 'siklik',
  'seri', 'seriler', 'kod', 'guncelleme', 'son guncelleme', 'donem',
  'seri aciklamasi', 'seri aciklamalari', 'veri kaynagi', 'etiketler',
]);

/**
 * ETL's `_FOOTER_SECTION_HEADINGS` (etl_shape.py:959-963).
 *
 * Labels a footer writes as a SECTION HEADING, alone on an otherwise blank row.
 * Deliberately a subset of the set above: a lone cell is strong evidence by
 * itself, so the words allowed to carry it must be ones that cannot plausibly
 * head a real table's column. "Dönem"/"Period"/"Birim"/"Kod" are excluded for
 * exactly that reason.
 */
const SECTION_HEADINGS = new Set([
  'note', 'notes', 'footnote', 'footnotes', 'source', 'sources',
  'definition', 'definitions', 'remark', 'remarks', 'methodology',
  'not', 'notlar', 'dipnot', 'dipnotlar', 'kaynak', 'kaynaklar',
  'aciklama', 'aciklamalar', 'tanim', 'tanimlar',
  'seri aciklamasi', 'seri aciklamalari',
]);

/**
 * ETL's `_METADATA_FOOTER_CODE_RE` (etl_shape.py:939): the BIS/SDMX form
 * `FREQ: M`. CASE-SENSITIVE, and that matters -- ETL records at
 * etl_shape.py:2463-2466 that lowercasing values before this test runs is what
 * made the detector dead on arrival. Nothing here lowercases cell values.
 */
const FOOTER_CODE_RE = /^[A-Z][A-Z0-9_]{2,}:.+/;

export interface FooterOptions {
  /** ETL's METADATA_FOOTER_MIN_RATIO. */
  minRatio?: number;
  /** ETL's FOOTNOTE_LABELS: extends BOTH the heading set and the label set. */
  extraLabels?: readonly string[];
  /** The column names of the table this region sits under, when there is one. */
  describesColumns?: readonly string[];
}

/**
 * Is this region a series-metadata footer describing the table above it?
 *
 * ETL's `_looks_like_metadata_footer_block` (etl_shape.py:980-1101), the four
 * tests in their original order.
 */
export function looksLikeFooter(
  grid: readonly Cell[][],
  region: Region,
  headerPromoted: boolean,
  opts: FooterOptions = {}
): boolean {
  const minRatio = opts.minRatio ?? 0.6;
  const extra = (opts.extraLabels ?? []).map(foldLabel);

  // The first POPULATED column, not literally the leftmost. ETL's note: a
  // footer indented by one column left column A blank, so every candidate came
  // back empty and the block was read as a table.
  let firstColIndex = -1;
  let firstColVals: string[] = [];
  for (let c = region.left; c < region.right; c++) {
    const vals: string[] = [];
    for (let r = region.top; r < region.bottom; r++) {
      const v = cellAt(grid, r, c);
      if (!isBlank(v)) vals.push(String(v));
    }
    if (vals.length > 0) {
      firstColIndex = c;
      firstColVals = vals;
      break;
    }
  }
  if (firstColVals.length === 0) return false;

  const labels = new Set([...KNOWN_LABELS, ...extra]);
  const isLabel = (raw: string): boolean => {
    const s = raw.trim();
    if (FOOTER_CODE_RE.test(s) || labels.has(foldLabel(s))) return true;
    // "Not: veriler gecicidir" -- the label and its value in one cell, which is
    // what a footnote looks like when the sheet has no second column for it.
    const head = s.includes(':') ? s.split(':', 1)[0] : '';
    return head !== '' && labels.has(foldLabel(head));
  };

  // 1. A table that DESCRIBES the table above it. "Definition | Meaning | Unit"
  //    over one row per series is 3x3 -- wide and tall enough to clear any size
  //    gate. What separates it from a real table is the content: its first
  //    column holds the previous table's COLUMN NAMES.
  if (opts.describesColumns && opts.describesColumns.length > 0 && firstColVals.length >= 2) {
    const known = new Set(
      opts.describesColumns.filter((c) => String(c).trim() !== '').map(foldLabel)
    );
    if (known.size > 0) {
      const named = firstColVals.filter((v) => known.has(foldLabel(v))).length;
      if (named / firstColVals.length >= minRatio) return true;
    }
  }

  // 2. A section heading: a row whose ONLY populated cell is a footer label.
  //    One is enough, because the vocabulary is restricted to words that cannot
  //    head a real column.
  const headings = new Set([...SECTION_HEADINGS, ...extra]);
  for (let r = region.top; r < region.bottom; r++) {
    const populated = populatedCells(grid, r, region.left, region.right);
    if (populated.length === 1 && headings.has(foldLabel(populated[0]))) return true;
  }

  // 3. Label ratio down the first populated column.
  const candidates = [...firstColVals];
  if (headerPromoted && firstColIndex >= 0) {
    // ETL prepends the promoted column NAME, which is that column's own header
    // cell -- part of the footer's text, not a name from another table.
    candidates.unshift(String(cellAt(grid, region.top, firstColIndex) ?? ''));
  }
  const hits = candidates.filter(isLabel).length;
  return hits / candidates.length >= minRatio;
}

/* ------------------------------------------------------------- the detector */

export interface DetectOptions {
  /** ETL's SECONDARY_BLOCK_MIN_ROWS. A header plus one observation is a table. */
  minRows?: number;
  /** ETL's SECONDARY_BLOCK_MIN_COLS. */
  minCols?: number;
  /** ETL's METADATA_FOOTER_MIN_RATIO. */
  minRatio?: number;
  /** ETL's FOOTNOTE_LABELS. */
  extraLabels?: readonly string[];
  /** Split side-by-side tables on blank columns. ETL cannot; here it is the default. */
  splitColumns?: boolean;
}

/** Populated column indices of a region, by ETL's structural rule (sentinels off). */
function populatedColumns(grid: readonly Cell[][], region: Region): Set<number> {
  const out = new Set<number>();
  for (let c = region.left; c < region.right; c++) {
    if (!colIsBlank(grid, c, region.top, region.bottom)) out.add(c);
  }
  return out;
}

/** How many columns hold a real VALUE -- ETL's size gate, with sentinels ON. */
function valueColumnCount(grid: readonly Cell[][], region: Region): number {
  let n = 0;
  for (let c = region.left; c < region.right; c++) {
    let any = false;
    for (let r = region.top; r < region.bottom && !any; r++) {
      if (!isBlankValue(cellAt(grid, r, c))) any = true;
    }
    if (any) n++;
  }
  return n;
}

function sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * Every table on the sheet, in reading order.
 *
 * Regions are visited top-to-bottom then left-to-right. Each is asked three
 * questions, in ETL's order, and the order is load-bearing:
 *
 *   1. Is it a continuation of the table before it -- the same table with a
 *      stray blank row through it? (Runs FIRST, and a region that answers yes
 *      is never re-tested; hence the negated footer precondition inside.)
 *   2. Is it a metadata footer describing the table above?
 *   3. Is it big enough to be a table at all?
 *
 * Anything that fails 2 or 3 is not returned. It is not deleted: the caller
 * shows the sheet whole, and the region is still in it, at its own row numbers.
 */
export function detectTables(
  grid: readonly Cell[][],
  opts: DetectOptions = {}
): SheetTable[] {
  const minRows = opts.minRows ?? 2;
  const minCols = opts.minCols ?? 2;
  const splitColumns = opts.splitColumns ?? true;

  const root = wholeGrid(grid);
  if (root.bottom === 0 || root.right === 0) return [];

  const regions = splitColumns
    ? splitRegions(grid, root)
    : splitOnRows(grid, shrink(grid, root) ?? root)
        .map((r) => shrink(grid, r))
        .filter((r): r is Region => r !== null);

  // Reading order: down the page, then across it.
  regions.sort((a, z) => (a.top - z.top) || (a.left - z.left));

  const out: SheetTable[] = [];
  for (const region of regions) {
    const headerRow = findHeaderRow(grid, region, minCols);
    const headerPromoted = headerRow !== null;
    const columns = headerPromoted
      ? headerNames(grid, headerRow, region.left, region.right)
      : letterNames(region.left, region.right);

    const previous = out.length > 0 ? out[out.length - 1] : null;
    const isFooter = looksLikeFooter(grid, region, headerPromoted, {
      minRatio: opts.minRatio,
      extraLabels: opts.extraLabels,
      describesColumns: previous?.columns,
    });

    // 1. Continuation of the table above. ETL's two shapes, exactly
    //    (etl_shape.py:1405-1427): no header of its own and the same populated
    //    columns, or a header repeated character for character.
    if (previous && !isFooter && region.top >= previous.region.bottom) {
      const prevCols = populatedColumns(grid, previous.region);
      const theseCols = populatedColumns(grid, region);
      const continues = headerPromoted
        ? columns.length === previous.columns.length &&
          columns.every((c, i) => c === previous.columns[i])
        : sameSet(prevCols, theseCols) &&
          theseCols.size >= Math.min(minCols, region.right - region.left);
      if (continues) {
        previous.region = {
          top: previous.region.top,
          bottom: region.bottom,
          left: Math.min(previous.region.left, region.left),
          right: Math.max(previous.region.right, region.right),
        };
        // A repeated header is not data; everything else in the region is.
        previous.rowCount += region.bottom - region.top - (headerPromoted ? 1 : 0);
        continue;
      }
    }

    // 2. A metadata footer is not a table, however big it is.
    if (isFooter) continue;

    // 3. The size gate. ETL measures the height BEFORE header promotion
    //    (etl_shape.py:1469): a header plus one observation IS a two-row table.
    const height = region.bottom - region.top;
    if (height < minRows || valueColumnCount(grid, region) < minCols) continue;

    // The table starts at its header; anything above it in the region is a
    // caption, and belongs to the sheet rather than to the table.
    const extent = headerPromoted ? { ...region, top: headerRow } : region;
    out.push({
      region: extent,
      headerRow,
      columns,
      rowCount: extent.bottom - extent.top - (headerPromoted ? 1 : 0),
    });
  }

  return out;
}
