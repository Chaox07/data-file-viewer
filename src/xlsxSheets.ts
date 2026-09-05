/**
 * Sheet-name discovery for .xlsx workbooks.
 *
 * DuckDB's `excel` extension reads a sheet by NAME (`read_xlsx(f, sheet => 'x')`)
 * but exposes no way to ask which names exist -- there is no sheet-listing
 * function, and a wrong name yields an error naming only the single nearest
 * match, not the set. So the names are read out of the package itself, the same
 * way the ETL pipeline's own reader does it (see ETL/etl_parts/etl_io.py,
 * `_sheet_xml_paths`), and for the same two reasons that implementation records:
 *
 *   1. The mapping lives in TWO files. xl/workbook.xml lists sheets by name and
 *      relationship id; xl/_rels/workbook.xml.rels maps that id to the actual
 *      worksheet part. Neither alone is enough, and sheet order in workbook.xml
 *      is the order Excel displays -- worth preserving in the sidebar.
 *   2. Attribute ORDER varies between writers: Excel emits Id/Type/Target while
 *      openpyxl emits Type/Target/Id. Anything that reads attributes
 *      positionally gets it wrong on half the files in the wild, so attributes
 *      are matched by NAME below.
 *
 * Only the two tiny XML parts are inflated; the worksheet bodies (which can be
 * 100+ MB decompressed) are left alone, because DuckDB is what reads those.
 */

import { createReadStream } from 'fs';
import { readFile } from 'fs/promises';
import { unzipSync, strFromU8, Unzip, UnzipInflate } from 'fflate';

/** Attribute lookup by name, tolerant of order, quoting style and namespace prefix. */
function attr(tag: string, name: string): string | undefined {
  // `name` may be namespaced (r:id); match any prefix, and both quote styles.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\s)(?:[A-Za-z0-9_.-]+:)?${escaped}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i');
  const m = re.exec(tag);
  if (!m) return undefined;
  return m[2] !== undefined ? m[2] : m[3];
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&'); // last, so "&amp;lt;" does not become "<"
}

/** Every `<tagName ...>` open/self-closing tag in `xml`, as raw tag text. */
function tags(xml: string, tagName: string): string[] {
  const re = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tagName}(\\s[^>]*)?/?>`, 'g');
  return xml.match(re) ?? [];
}

export interface XlsxSheet {
  /** The name as Excel displays it, already entity-decoded. */
  name: string;
  /** Path of the worksheet part inside the archive, e.g. "xl/worksheets/sheet1.xml". */
  path: string;
}

/**
 * The workbook's sheets, in the order the workbook declares them.
 *
 * Throws when the file is not a readable xlsx package; returns [] when it is a
 * valid archive that simply declares no resolvable sheets. Callers distinguish
 * the two: the first is "this is not a workbook", the second is "an empty one".
 */
export async function listSheets(filePath: string): Promise<XlsxSheet[]> {
  const buf = await readFile(filePath);

  let files: Record<string, Uint8Array>;
  try {
    // Only the two small parts are inflated. Worksheet bodies stay compressed.
    files = unzipSync(new Uint8Array(buf), {
      filter: (f) => f.name === 'xl/workbook.xml' || f.name === 'xl/_rels/workbook.xml.rels',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Not a readable .xlsx package: ${message}`);
  }

  const bookRaw = files['xl/workbook.xml'];
  if (!bookRaw) {
    // A ZIP without xl/workbook.xml is some other archive wearing an .xlsx
    // name -- most often a .xls renamed, or an .xlsb, neither of which the
    // excel extension reads either.
    throw new Error('Not a readable .xlsx package: no xl/workbook.xml inside.');
  }
  const book = strFromU8(bookRaw);
  const rels = files['xl/_rels/workbook.xml.rels']
    ? strFromU8(files['xl/_rels/workbook.xml.rels'])
    : '';

  const targetById = new Map<string, string>();
  for (const tag of tags(rels, 'Relationship')) {
    const id = attr(tag, 'Id');
    const target = attr(tag, 'Target');
    if (!id || !target) continue;
    // Targets are relative to xl/ unless absolute within the package.
    const clean = decodeEntities(target);
    targetById.set(id, clean.startsWith('/')
      ? clean.replace(/^\/+/, '')
      : 'xl/' + clean.replace(/^\.\//, ''));
  }

  const out: XlsxSheet[] = [];
  const seen = new Set<string>();
  for (const tag of tags(book, 'sheet')) {
    const name = attr(tag, 'name');
    if (!name) continue;
    const rid = attr(tag, 'id'); // r:id -- attr() ignores the prefix
    const path = rid ? targetById.get(rid) : undefined;
    const decoded = decodeEntities(name);
    // Two sheets cannot share a name in Excel, but a corrupt file can claim
    // otherwise; keeping the first preserves display order and keeps the view
    // names we derive from these unique.
    if (seen.has(decoded)) continue;
    seen.add(decoded);
    out.push({ name: decoded, path: path ?? '' });
  }
  return out;
}

/** The rectangle a worksheet occupies. */
export interface SheetExtent {
  /** The range in spreadsheet notation, e.g. "B1:CW16814" — reusable as a read_xlsx `range`. */
  ref: string;
  /** 1-based, inclusive. A is 1. */
  firstColumn: number;
  lastColumn: number;
  firstRow: number;
  lastRow: number;
  columns: number;
  rows: number;
  /**
   * How wide MOST rows holding values are, over the rows inspected.
   *
   * The number to compare a view against, and NOT `columns` -- a `<dimension>`
   * routinely over-declares. Measured across the ten sheets of a workbook in
   * daily use: `efektif_kur` declares three columns and its data has two;
   * `chain_gdp` declares twelve and has ten; `real_gdp` declares nine, has
   * eight, and carries a stray empty `<c r="I3"/>` that makes it look like nine
   * to anything counting cells rather than values. Trusting `columns` here
   * would have rewritten five perfectly good sheets as raw rectangles.
   *
   * Modal rather than maximum, for a second reason found in the same workbook:
   * see modalRowWidth.
   *
   * 0 when nothing was inspected.
   */
  contentColumns: number;
  /**
   * Whether this is the whole rectangle or a lower bound on it.
   *
   * True when the sheet declared a `<dimension>`, or when the entire sheet fit
   * in the window read. False when the bounds were derived from the first
   * cells of a sheet that carries on past them: the COLUMN count is still
   * trustworthy (a sheet's columns are established in its first rows) but the
   * last row is only "at least this". Anything that needs an exact end must
   * call scanSheetExtent.
   */
  exact: boolean;
}

function extent(
  firstColumn: number,
  lastColumn: number,
  firstRow: number,
  lastRow: number,
  exact: boolean,
  contentColumns = 0
): SheetExtent | undefined {
  if (!firstColumn || !lastColumn || !firstRow || !lastRow) return undefined;
  if (lastColumn < firstColumn || lastRow < firstRow) return undefined;
  return {
    ref: `${columnLetters(firstColumn)}${firstRow}:${columnLetters(lastColumn)}${lastRow}`,
    firstColumn,
    lastColumn,
    firstRow,
    lastRow,
    columns: lastColumn - firstColumn + 1,
    rows: lastRow - firstRow + 1,
    contentColumns,
    exact,
  };
}

/** 1 -> "A", 27 -> "AA". The inverse of columnNumber. */
function columnLetters(n: number): string {
  let out = '';
  let rest = n;
  while (rest > 0) {
    const rem = (rest - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    rest = Math.floor((rest - rem) / 26);
  }
  return out;
}

/** "A" -> 1, "Z" -> 26, "AA" -> 27. Returns 0 for anything that is not column letters. */
function columnNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const d = ch.charCodeAt(0) - 64; // 'A' is 65
    if (d < 1 || d > 26) return 0;
    n = n * 26 + d;
  }
  return n;
}

/** Parses "B1:CW16814", and the single-cell form "A1" some writers emit. */
function parseRef(ref: string): SheetExtent | undefined {
  const cell = /^([A-Za-z]+)(\d+)$/;
  const [start, end = ref] = ref.split(':');
  const a = cell.exec(start.trim());
  const b = cell.exec(end.trim());
  if (!a || !b) return undefined;
  return extent(columnNumber(a[1]), columnNumber(b[1]), Number(a[2]), Number(b[2]), true);
}

/** Running bounds over the cell references in worksheet XML. */
class RefBounds {
  private firstColumn = Infinity;
  private lastColumn = 0;
  private firstRow = Infinity;
  private lastRow = 0;
  /** Cells carrying a value, per row — the max of these is what a view is judged against. */
  private readonly valuesPerRow = new Map<number, number>();

  /**
   * Every `<c r="B12" …>` in `xml`, and whether it holds anything.
   *
   * A cell counts toward the row's width only if it carries a `<v>` or `<is>`.
   * `<c r="I3"/>` and `<c r="I3"></c>` are formatting, not data, and counting
   * them is the difference between reading a sheet correctly and rewriting it.
   *
   * Call with whole, non-overlapping text: rows are keyed by number and
   * accumulate across calls, so a cell seen twice would be counted twice.
   */
  add(xml: string): void {
    // The tag is matched whole and `r` picked out of its attributes BY NAME,
    // for the reason this module's header already gives: attribute order
    // varies between writers. Excel emits `<c r="B2" s="1" t="s">` and a
    // pattern expecting `r` last silently matches nothing at all -- which is
    // exactly what happened, and what made every real workbook report a
    // content width of zero.
    const re = /<c\s([^>]*?)(\/?)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) {
      const ref = /\br="([A-Z]+)(\d+)"/.exec(m[1]);
      if (!ref) continue;
      const col = columnNumber(ref[1]);
      const row = Number(ref[2]);
      if (!col || !row) continue;
      if (col < this.firstColumn) this.firstColumn = col;
      if (col > this.lastColumn) this.lastColumn = col;
      if (row < this.firstRow) this.firstRow = row;
      if (row > this.lastRow) this.lastRow = row;

      if (m[2] === '/') continue; // self-closing: no value
      // Everything up to whichever comes first: this cell's end, or the next
      // cell's start (a malformed part with no </c>).
      const rest = xml.slice(re.lastIndex, re.lastIndex + 4096);
      const end = rest.search(/<\/c>|<c\s/);
      if (/<v>|<is>/.test(end === -1 ? rest : rest.slice(0, end))) {
        this.valuesPerRow.set(row, (this.valuesPerRow.get(row) ?? 0) + 1);
      }
    }
  }

  /** Kept from one chunk to the next, so a tag split across them is still matched. */
  static readonly OVERLAP = 64;

  /**
   * The width MOST rows have — the shape of the table, not of its widest line.
   *
   * The max is the wrong statistic, and the workbook that proved it is one in
   * daily use: `efektif_kur` holds 124 rows of two columns and then, below the
   * table, five TCMB footnote rows of three (`Veri Kaynağı | TCMB`). Judging by
   * the widest row makes a correctly-read two-column sheet look like a sheet
   * missing a column, and the suite already has a whole family for notes
   * written under a table. The modal width ignores them, which is what a reader
   * looking at the sheet would do.
   *
   * Ties go to the narrower width, so the doubt is always resolved toward
   * leaving the sheet alone.
   */
  private modalRowWidth(): number {
    const counts = new Map<number, number>();
    for (const n of this.valuesPerRow.values()) counts.set(n, (counts.get(n) ?? 0) + 1);
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

  toExtent(exact: boolean): SheetExtent | undefined {
    if (this.lastColumn === 0) return undefined;
    return extent(this.firstColumn, this.lastColumn, this.firstRow, this.lastRow, exact, this.modalRowWidth());
  }

  /** A dimension's rectangle, but judged against the content actually seen. */
  withDeclared(declared: SheetExtent): SheetExtent {
    return { ...declared, contentColumns: this.modalRowWidth() };
  }
}

/**
 * How much of a worksheet part to inflate when sizing it up.
 *
 * `<dimension>` is in the first kilobyte, but the modal row width needs enough
 * ROWS to have a mode: a sheet whose real table starts ten rows down needs more
 * than ten rows of it read, and one row of a 100-column sheet is ~4 KB. Costs
 * nothing in practice -- the inflater emits chunks larger than this anyway, so
 * this is a bound rather than a target.
 */
const DIMENSION_SEARCH_BYTES = 256 * 1024;

/**
 * Stream one archive, inflating only the parts asked for.
 *
 * `onChunk` returns true when it has seen enough of that part, which stops it
 * being inflated any further. When every wanted part has said so, the file
 * stream is torn down mid-archive.
 */
function streamParts(
  filePath: string,
  wanted: Set<string>,
  onChunk: (name: string, text: string, final: boolean) => boolean
): Promise<void> {
  return new Promise((resolve) => {
    const settled = new Set<string>();
    const stream = createReadStream(filePath);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      stream.destroy();
      resolve();
    };

    const unzip = new Unzip();
    unzip.register(UnzipInflate);
    unzip.onfile = (file) => {
      // Not registering a handler leaves the part compressed and unread, which
      // is the whole point: only the worksheets asked for cost anything.
      if (!wanted.has(file.name)) return;
      file.ondata = (err, chunk, final) => {
        if (err || settled.has(file.name)) return;
        // ASCII tag names and digits are all that is read out of these; latin1
        // decodes any byte without throwing and never merges two into one, so
        // a multi-byte cell value cannot shift a reference's offsets.
        const done = onChunk(file.name, Buffer.from(chunk).toString('latin1'), final);
        if (done || final) {
          settled.add(file.name);
          if (settled.size === wanted.size) finish();
        }
      };
      file.start();
    };

    stream.on('data', (chunk) => {
      if (finished) return;
      // A malformed archive throws out of push(); listSheets is what reports
      // "not a readable .xlsx package", so here it just means no second opinion.
      try {
        unzip.push(new Uint8Array(chunk as Buffer), false);
      } catch {
        finish();
      }
    });
    stream.on('end', () => {
      try {
        unzip.push(new Uint8Array(0), true);
      } catch {
        // Already reporting whatever was found.
      }
      finish();
    });
    stream.on('error', finish);
  });
}

/**
 * Each sheet's rectangle, read WITHOUT inflating the sheet bodies.
 *
 * This exists to answer one question: does the view DuckDB built over a sheet
 * cover the sheet? `read_xlsx` derives its region from the first row holding
 * consecutive non-empty cells, so a sheet opening with a one-cell title banner
 * reads as a single column and the rest of the table is simply not there. The
 * sheet's own geometry is the second opinion that catches it.
 *
 * Inflating the whole part is not an option -- `Raw_Data` in the workbook this
 * was found on is ~100 MB decompressed, and `unzipSync` (what listSheets above
 * uses, for two parts measured in kilobytes) would hold all of it. So the
 * archive is streamed and each wanted part inflated only until it has answered:
 * measured at 742 KB inflated and 134 ms for that 21 MB workbook's two sheets.
 *
 * Two ways a sheet answers, in order of preference:
 *
 *   1. `<dimension ref="B1:CW16814">`, which sits in the first kilobyte. Exact.
 *   2. The cell references in the window read, when there is no `<dimension>`
 *      -- it is an optional element, and the writers that skip it are not
 *      exotic (this suite's own OOXML writer is one). Exact if the whole sheet
 *      fit in the window; otherwise a lower bound, flagged as such, and good
 *      for the column comparison but not for a range's end.
 *
 * A sheet that answers neither way is simply absent from the result, which
 * degrades to "no second opinion, believe DuckDB" -- never to a wrong
 * rectangle.
 */
export async function readSheetExtents(
  filePath: string,
  sheetPaths: readonly string[]
): Promise<Map<string, SheetExtent>> {
  const wanted = new Set(sheetPaths.filter((p) => p));
  const found = new Map<string, SheetExtent>();
  if (wanted.size === 0) return found;

  // Accumulated whole and parsed once at the end, rather than chunk by chunk:
  // the per-row value counts below cannot tolerate a cell being seen twice,
  // and the window is bounded, so holding it is cheaper than deduplicating.
  const heads = new Map<string, string>();
  await streamParts(filePath, wanted, (name, text, final) => {
    const window = (heads.get(name) ?? '') + text;
    const full = window.length >= DIMENSION_SEARCH_BYTES;
    if (!final && !full) {
      heads.set(name, window);
      return false;
    }
    heads.delete(name);

    const bounds = new RefBounds();
    bounds.add(window);
    const declared = /<dimension[^>]*\sref="([^"]+)"/.exec(window);
    const parsed = declared ? parseRef(declared[1]) : undefined;
    const seen = bounds.toExtent(final && !full);
    // A dimension is believed for the sheet's GEOMETRY -- it is the only source
    // for a last row without reading the whole part -- but never for how wide
    // the content is; see SheetExtent.contentColumns. A dimension that does not
    // even cover what has been seen (the bogus "A1" some writers emit) is
    // discarded in favour of what was measured.
    const usable = parsed && (!seen || (parsed.lastColumn >= seen.lastColumn && parsed.lastRow >= seen.lastRow));
    const extentForSheet = usable ? bounds.withDeclared(parsed!) : seen;
    if (extentForSheet) found.set(name, extentForSheet);
    return true;
  });
  return found;
}

/**
 * One sheet's exact rectangle, at the cost of inflating all of it.
 *
 * The fallback for a sheet that declares no `<dimension>` and does not fit in
 * the window readSheetExtents uses -- where the column count is known to be
 * wrong but the last row is not known at all, and an open-ended range is not
 * an option (measured: `range = 'B1:CW'` pads the result to all 1,048,576 rows
 * a sheet could have, not the 16,814 it has).
 *
 * Called only once a sheet is already known to be mis-read, so the cost is paid
 * by the files that need it rather than by every workbook that opens. Streams
 * and keeps only the running bounds, so a 100 MB sheet costs time, not memory.
 */
export async function scanSheetExtent(filePath: string, sheetPath: string): Promise<SheetExtent | undefined> {
  if (!sheetPath) return undefined;
  const bounds = new RefBounds();
  let carry = '';
  await streamParts(filePath, new Set([sheetPath]), (_name, text) => {
    bounds.add(carry + text);
    carry = text.slice(-RefBounds.OVERLAP);
    return false; // every chunk, to the end of the part
  });
  return bounds.toExtent(true);
}
