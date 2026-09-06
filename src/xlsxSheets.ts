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
 *
 * Everything here STREAMS the archive rather than reading it whole. The version
 * this replaces called `readFile` and then `unzipSync`, which had two costs
 * worth naming so they are not reintroduced:
 *
 *   - `readFile` holds the entire package resident. A 200 MB workbook is 200 MB
 *     of Buffer to answer a question about two kilobytes of XML.
 *   - `unzipSync` is synchronous, and this runs on the extension host. It
 *     blocked the whole editor -- every other extension, the file tree, the
 *     command palette -- not merely this view.
 *
 * `streamParts` inflates only the parts asked for and tears the stream down as
 * soon as they have answered, so opening a workbook reads a few kilobytes.
 */

import { createReadStream } from 'fs';
import { open } from 'fs/promises';
import { Unzip, UnzipInflate } from 'fflate';

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

/**
 * Stream one archive, inflating only the parts asked for.
 *
 * `onChunk` returns true when it has seen enough of that part, which stops it
 * being inflated any further. When every wanted part has said so, the file
 * stream is torn down mid-archive.
 *
 * Harvested from the `viewer/pinned-findings` branch, where it was written to
 * size up sheets without inflating them; it serves every reader here now.
 */
function streamParts(
  filePath: string,
  wanted: Set<string>,
  onChunk: (name: string, text: string, final: boolean) => boolean
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const settled = new Set<string>();
    const stream = createReadStream(filePath);
    let finished = false;
    let failure: string | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      stream.destroy();
      resolve({ ok: failure === undefined, error: failure });
    };

    const unzip = new Unzip();
    unzip.register(UnzipInflate);
    unzip.onfile = (file) => {
      // Not registering a handler leaves the part compressed and unread, which
      // is the whole point: only the parts asked for cost anything.
      if (!wanted.has(file.name)) return;
      file.ondata = (err, chunk, final) => {
        if (err || settled.has(file.name)) return;
        // ASCII tag names and digits are all that is read out of these; latin1
        // decodes any byte without throwing and never merges two into one, so
        // a multi-byte cell value cannot shift a reference offsets. Callers
        // that need real text (sheet names) re-decode as UTF-8 themselves.
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
      try {
        unzip.push(new Uint8Array(chunk as Buffer), false);
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
        finish();
      }
    });
    stream.on('end', () => {
      try {
        unzip.push(new Uint8Array(0), true);
      } catch (err) {
        // Reaching the end of the file with the archive still expecting more is
        // what a TRUNCATED package looks like. It matters that this is not
        // swallowed: the reading that used to happen when a workbook opened is
        // now deferred until a sheet is used, so this is one of the only places
        // left that notices the damage early.
        failure = err instanceof Error ? err.message : String(err);
      }
      // NOTE: a wanted part that never arrived is NOT reported as damage here.
      // A perfectly well-formed ZIP can simply not contain it -- an archive
      // that is not a workbook at all has no xl/workbook.xml -- and calling
      // that "the package ends early" misdescribes it. Truncation is caught by
      // hasCentralDirectory and by the throw above; a missing part is the
      // caller's to interpret, and listSheets says what it means.
      finish();
    });
    stream.on('error', (err) => {
      failure = err instanceof Error ? err.message : String(err);
      finish();
    });
  });
}

/**
 * A part read whole, as text.
 *
 * The two workbook-metadata parts are kilobytes, so they are accumulated in
 * full; `latin1` is undone here because sheet NAMES are real text and the
 * package writes them UTF-8.
 */
async function readParts(
  filePath: string,
  wanted: Set<string>
): Promise<{ parts: Map<string, string>; error?: string }> {
  const acc = new Map<string, string[]>();
  const result = await streamParts(filePath, wanted, (name, text) => {
    const chunks = acc.get(name) ?? [];
    chunks.push(text);
    acc.set(name, chunks);
    return false; // want every byte of these
  });
  const parts = new Map<string, string>();
  for (const [name, chunks] of acc) {
    parts.set(name, Buffer.from(chunks.join(''), 'latin1').toString('utf8'));
  }
  return { parts, error: result.error };
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
  if (!(await hasCentralDirectory(filePath))) {
    throw new Error(
      'Not a readable .xlsx package: it has no central directory, so the file is incomplete.'
    );
  }

  // Only the two small parts are inflated. Worksheet bodies stay compressed.
  const { parts, error } = await readParts(
    filePath,
    new Set(['xl/workbook.xml', 'xl/_rels/workbook.xml.rels'])
  );
  if (error) throw new Error(`Not a readable .xlsx package: ${error}`);

  const book = parts.get('xl/workbook.xml');
  if (!book) {
    // A ZIP without xl/workbook.xml is some other archive wearing an .xlsx
    // name -- most often a .xls renamed, or an .xlsb, neither of which the
    // excel extension reads either.
    throw new Error('Not a readable .xlsx package: no xl/workbook.xml inside.');
  }
  const rels = parts.get('xl/_rels/workbook.xml.rels') ?? '';

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

/**
 * The `<dimension ref="B2:AH16809"/>` a worksheet declares, as 1-based bounds.
 *
 * Needed because `read_xlsx` without a `range` stops at the first contiguous
 * block of rows — on a sheet with a preamble and a blank line before the real
 * table, that is the preamble, which is why such a file currently opens as a
 * 3-column, 1-row table. Giving it an explicit range fixes that, and a range
 * needs an end row.
 *
 * The declaration is an upper bound, not a measurement: workbooks routinely
 * over-declare it (see the project's xlsx geometry notes), so a caller should
 * treat a too-large end row as normal. Returns undefined when the sheet
 * declares nothing, which is legal.
 *
 * `<dimension>` is OPTIONAL in the format, and plenty of writers omit it. A
 * sheet that declares nothing used to get no block handling at all — the
 * caller had no end row, so it fell back to the unranged read and the
 * preamble-only open this exists to prevent. So when the declaration is
 * missing the bounds are measured from the sheet's own cell references
 * instead.
 *
 * Guessing a generous range instead is NOT an option, and this is worth
 * recording: `range = 'A1:XFD1048576'` does not return the used cells, it
 * materialises the whole grid. Measured on a five-row sheet, it took the
 * process out with an out-of-memory kill. A bounded range pads too —
 * 'A1:Z200' on that same sheet returns 200 rows of 26 columns — so the end
 * bound has to be real.
 *
 * Only this one worksheet part is inflated, not the whole workbook.
 */

/**
 * Above this, a sheet with no `<dimension>` is left to the unranged read
 * rather than scanned for its bounds. The scan is linear in the part's size
 * and this runs per sheet at open; a workbook big enough to matter is also
 * one written by a tool that declares its dimension (verified on
 * YieldCurve_Data.xlsx, whose 78 MB part declares B1:CW16814).
 */
const DIMENSION_SEARCH_BYTES = 256 * 1024;

export interface SheetDimension {
  firstRow: number;
  lastRow: number;
  firstCol: string;
  lastCol: string;
}

/**
 * Does this file end with a ZIP central directory?
 *
 * A streaming reader does not need one -- it walks the local file headers -- and
 * that tolerance is a hazard here rather than a feature. The central directory
 * is the LAST thing in the archive, so a file cut short still streams every
 * entry that survived the cut and reads as a complete, smaller workbook. That
 * is the "silent misread" the stress suite exists to catch, and the whole-file
 * `unzipSync` this replaced happened to catch it by needing the directory.
 *
 * So the check is made explicitly. `PK\x05\x06` is the End Of Central Directory
 * signature; it sits within 22 bytes of the end unless the archive carries a
 * comment, which is capped at 65535 bytes.
 */
async function hasCentralDirectory(filePath: string): Promise<boolean> {
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const want = Math.min(size, 22 + 0xffff);
    if (want < 22) return false;
    const buf = Buffer.alloc(want);
    await handle.read(buf, 0, want, size - want);
    return buf.lastIndexOf(EOCD_SIGNATURE) !== -1;
  } finally {
    await handle.close();
  }
}

const EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

/**
 * Every sheet's rectangle, in ONE pass over the archive.
 *
 * Per-sheet reading is what made opening a workbook cost a package parse per
 * sheet. The archive is streamed once; each wanted part is inflated only until
 * it has answered, and the stream is torn down when the last one has.
 *
 * Two ways a sheet answers, in order of preference:
 *
 *   1. `<dimension ref="B1:CW16814">`, which sits in the first kilobyte. It is
 *      an upper bound, not a measurement -- workbooks routinely over-declare
 *      (see the project's xlsx geometry notes) -- and the verbatim read is
 *      built to tolerate that by trimming trailing blank rows and columns
 *      after the fact.
 *   2. The cell references in the window read, when there is no `<dimension>`.
 *      It is OPTIONAL in the format and plenty of writers omit it, this
 *      suite's own OOXML writer among them.
 *
 * Guessing a generous range instead is NOT an option, and it is worth
 * recording why: `range = 'A1:XFD1048576'` does not return the used cells, it
 * materialises the whole grid. Measured on a five-row sheet, it took the
 * process out with an out-of-memory kill. A bounded range pads too --
 * 'A1:Z200' on that same sheet returns 200 rows of 26 columns -- so the end
 * bound has to be real.
 */
export async function readSheetDimensions(
  filePath: string,
  sheetPaths: readonly string[]
): Promise<Map<string, SheetDimension>> {
  const { dimensions } = await readSheetDimensionsChecked(filePath, sheetPaths);
  return dimensions;
}

/**
 * The same, plus whether the package was intact.
 *
 * `damaged` is set when the archive ends before a worksheet it declares does.
 * The caller refuses the file on it: a workbook does none of its reading when
 * it opens any more, so this is the earliest point at which a truncated file
 * can be told apart from a small one.
 */
export async function readSheetDimensionsChecked(
  filePath: string,
  sheetPaths: readonly string[]
): Promise<{ dimensions: Map<string, SheetDimension>; damaged?: string }> {
  const wanted = new Set(sheetPaths.filter((p) => p));
  const found = new Map<string, SheetDimension>();
  if (wanted.size === 0) return { dimensions: found };

  // Two things are being read here, and they have different appetites.
  //
  // The `<dimension>` sits in the first kilobyte, so a small window finds it and
  // the part can be abandoned immediately -- that is the fast path, and it is
  // what nearly every workbook takes.
  //
  // The FALLBACK, for the writers that omit `<dimension>` (this suite's own
  // OOXML writer among them), has to see the whole part. A window would give a
  // lower bound, and a lower bound used as a range's end silently truncates the
  // sheet: measured, a 40,000-row sheet read back 5,254 rows because that was
  // all that fit. So when no dimension turns up in the head, the part keeps
  // streaming and the bounds accumulate across chunks -- bounded memory, since
  // only four numbers are kept, but the whole part is read.
  const heads = new Map<string, string>();
  const running = new Map<string, RunningBounds>();
  const carry = new Map<string, string>();

  const result = await streamParts(filePath, wanted, (name, text, final) => {
    const head = heads.get(name);
    if (head === undefined || head.length < DIMENSION_SEARCH_BYTES) {
      const window = (head ?? '') + text;
      heads.set(name, window.slice(0, DIMENSION_SEARCH_BYTES));
      const declared = /<(?:[A-Za-z0-9_.-]+:)?dimension[^>]*\sref="([^"]+)"/.exec(window);
      const parsed = declared ? parseRef(declared[1]) : undefined;
      if (parsed) {
        found.set(name, parsed);
        return true; // answered; stop inflating this part
      }
    }

    // No dimension so far, so measure. A tag split across two chunks would be
    // missed, so the tail of each chunk is carried into the next.
    const chunk = (carry.get(name) ?? '') + text;
    const bounds = running.get(name) ?? newBounds();
    addBounds(bounds, chunk.slice(0, Math.max(chunk.length - CHUNK_OVERLAP, 0)));
    carry.set(name, chunk.slice(Math.max(chunk.length - CHUNK_OVERLAP, 0)));
    running.set(name, bounds);

    if (!final) return false;

    addBounds(bounds, carry.get(name) ?? '');
    const measured = boundsToDimension(bounds);
    if (measured) found.set(name, measured);
    return true;
  });

  return { dimensions: found, damaged: result.error };
}

/** One sheet's rectangle. Prefer `readSheetDimensions` -- this streams the archive again. */
export async function readSheetDimension(
  filePath: string,
  sheetPath: string
): Promise<SheetDimension | undefined> {
  const all = await readSheetDimensions(filePath, [sheetPath]);
  return all.get(sheetPath);
}

/** Enough of a chunk boundary to hold any `<c r="AA1234" ...>` tag whole. */
const CHUNK_OVERLAP = 64;

interface RunningBounds {
  firstCol: number;
  lastCol: number;
  firstRow: number;
  lastRow: number;
}

function newBounds(): RunningBounds {
  return {
    firstCol: Number.POSITIVE_INFINITY,
    lastCol: -1,
    firstRow: Number.POSITIVE_INFINITY,
    lastRow: -1,
  };
}

/**
 * Fold every `<c r="B12" ...>` in `xml` into the running bounds.
 *
 * `r` is matched BY NAME with a word boundary, never positionally: attribute
 * order varies between writers (Excel emits `<c r="B2" s="1" t="s">`), and a
 * pattern expecting it last silently matches nothing at all -- which reports a
 * width of zero for every real workbook rather than failing visibly.
 */
function addBounds(bounds: RunningBounds, xml: string): void {
  const cellRef = /<c\s[^>]*?\br="([A-Z]+)(\d+)"/g;
  let match: RegExpExecArray | null;
  while ((match = cellRef.exec(xml)) !== null) {
    const col = columnIndex(match[1]);
    const row = Number(match[2]);
    if (col < bounds.firstCol) bounds.firstCol = col;
    if (col > bounds.lastCol) bounds.lastCol = col;
    if (row < bounds.firstRow) bounds.firstRow = row;
    if (row > bounds.lastRow) bounds.lastRow = row;
  }
}

function boundsToDimension(bounds: RunningBounds): SheetDimension | undefined {
  if (bounds.lastCol < 0 || bounds.lastRow < 0) return undefined;
  return {
    firstRow: bounds.firstRow,
    lastRow: bounds.lastRow,
    firstCol: columnLetters(bounds.firstCol),
    lastCol: columnLetters(bounds.lastCol),
  };
}

/** `"B2:AH16809"` or `"B2"` as bounds, or undefined when it is neither. */
function parseRef(ref: string): SheetDimension | undefined {
  const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(ref.trim());
  if (!m) return undefined;
  const firstRow = Number(m[2]);
  const lastRow = Number(m[4] ?? m[2]);
  if (!Number.isFinite(firstRow) || !Number.isFinite(lastRow)) return undefined;
  return { firstRow, lastRow, firstCol: m[1], lastCol: m[3] ?? m[1] };
}

/** Column letters to a 0-based index, so "AA" sorts after "Z" rather than before it. */
function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function columnLetters(index: number): string {
  let out = '';
  let n = index;
  for (;;) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    if (n < 26) return out;
    n = Math.floor(n / 26) - 1;
  }
}

