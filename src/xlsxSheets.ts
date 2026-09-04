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

import { readFile } from 'fs/promises';
import { unzipSync, strFromU8 } from 'fflate';

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
 * Only this one worksheet part is inflated, not the whole workbook.
 */
export async function readSheetDimension(
  filePath: string,
  sheetPath: string
): Promise<{ firstRow: number; lastRow: number; firstCol: string; lastCol: string } | undefined> {
  const buf = await readFile(filePath);
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buf), { filter: (f) => f.name === sheetPath });
  } catch {
    return undefined;
  }
  const part = files[sheetPath];
  if (!part) return undefined;

  // The dimension element is in the first few hundred bytes of the part, well
  // before the row data, so this never scans a large sheet body.
  const head = strFromU8(part.subarray(0, Math.min(part.length, 4096)));
  const m = /<(?:[A-Za-z0-9_.-]+:)?dimension\s+ref="([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?"/.exec(head);
  if (!m) return undefined;
  const firstCol = m[1];
  const firstRow = Number(m[2]);
  const lastCol = m[3] ?? m[1];
  const lastRow = Number(m[4] ?? m[2]);
  if (!Number.isFinite(firstRow) || !Number.isFinite(lastRow)) return undefined;
  return { firstRow, lastRow, firstCol, lastCol };
}
