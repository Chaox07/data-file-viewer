/**
 * Writing one cell back into an .xlsx workbook, without disturbing anything else.
 *
 * The naive save -- regenerate the sheet from the table DuckDB holds -- is what
 * kept .xlsx view-only, and rightly: it replaces formulas with whatever they
 * last evaluated to, drops number formats and styling, and (Excel having no
 * integer type) turns every `1` in the sheet into `1.0`. Editing one cell would
 * quietly rewrite ten thousand you did not touch.
 *
 * So nothing is regenerated. The workbook is unzipped, the ONE `<c>` element
 * the edit targets is rewritten inside the worksheet XML, and the package is
 * zipped back up. Every other cell keeps its bytes: formulas, styles, merged
 * ranges, charts, pivot caches, the other sheets, the parts nobody has heard of.
 *
 * Finding the cell
 * ----------------
 * The hard half, because an edit identifies its row by the row's VALUES (see
 * updateCell -- DuckDB has no stable rowid across the shapes this viewer
 * opens), and this file needs a spreadsheet row NUMBER.
 *
 * Matching values here would mean re-implementing DuckDB's own comparison in
 * JS against raw XML -- dates stored as serial numbers, floats stored at
 * whatever precision Excel wrote, integers indistinguishable from floats. Get
 * it subtly wrong and the result is not an error, it is an edit to the wrong
 * cell of somebody's workbook.
 *
 * Instead DuckDB does the matching, in its own types, and reports the row's
 * ORDINAL (see updateXlsxCell in duckdbConnection.ts). read_xlsx returns rows
 * in sheet order, so the Nth row it returned is the Nth data row of the XML.
 * What remains is finding where the data starts, and that is done by FINDING
 * the header row -- the first row carrying every one of the view's column
 * names -- rather than by arithmetic on row counts. The arithmetic version
 * (rows in the file minus rows in the table) is wrong on any sheet with
 * trailing content, and real workbooks are full of it: the sheet this was
 * first run against holds 136 rows for 121 rows of data, the surplus being
 * notes below the table, which put the "header" fourteen rows into the data.
 *
 * Two independent readings then have to agree before a byte is written: the
 * ordinal DuckDB reported, and the cell's own current contents, which must be
 * what the grid was showing. When they disagree the edit is refused.
 *
 * The cell grammar below follows ETL's reader (ETL/etl_parts/etl_xlsx.py,
 * _parse_batch), including its one non-obvious rule: `t="..."` must be matched
 * anchored INSIDE the `<c ...>` tag. A cell holding a shared formula contains
 * `<f t="shared" si="0"/>`, and an unanchored match takes the formula's type
 * for the cell's -- which in that codebase nulled 182,000 cells in one sheet.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

/** A1 column letters -> 0-based index. "A" -> 0, "Z" -> 25, "AA" -> 26. */
export function columnIndexOf(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 0-based index -> A1 column letters. The inverse of columnIndexOf. */
export function columnLettersOf(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unescapeXmlText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&'); // last, so "&amp;lt;" does not become "<"
}

/** One `<row ...>…</row>` block, with where it sits in the sheet XML. */
interface RowBlock {
  /** The row's own `r=` number, 1-based, as Excel counts rows. */
  number: number;
  /** Offsets of the whole block in the XML string. */
  start: number;
  end: number;
  xml: string;
}

const ROW_RE = /<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g;

function readRows(sheetXml: string): RowBlock[] {
  const rows: RowBlock[] = [];
  ROW_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ROW_RE.exec(sheetXml)) !== null) {
    const xml = match[0];
    const r = /<row\b[^>]*?\br="(\d+)"/.exec(xml);
    rows.push({
      number: r ? Number(r[1]) : rows.length + 1,
      start: match.index,
      end: match.index + xml.length,
      xml,
    });
  }
  return rows;
}

/** Rows carrying at least one cell. read_xlsx does not return a row of nothing. */
function isNonEmpty(row: RowBlock): boolean {
  return /<c\b/.test(row.xml);
}

/** The display text of every cell in a row, keyed by column letters. */
function cellTextsOf(rowXml: string, sharedStrings: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let match: RegExpExecArray | null;
  while ((match = cellRe.exec(rowXml)) !== null) {
    const attrs = match[1] ?? '';
    const body = match[2] ?? '';
    const ref = /\br="([A-Z]+)\d+"/.exec(attrs);
    if (!ref) continue;
    // Anchored in the attribute list, never in the body: see the module note.
    const type = /\bt="([a-zA-Z]+)"/.exec(attrs)?.[1];
    let text = '';
    if (type === 's') {
      const index = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '-1');
      text = sharedStrings[index] ?? '';
    } else if (type === 'inlineStr') {
      text = unescapeXmlText(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1] ?? '');
    } else {
      text = unescapeXmlText(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
    }
    out.set(ref[1], text);
  }
  return out;
}

function readSharedStrings(files: Record<string, Uint8Array>): string[] {
  const part = files['xl/sharedStrings.xml'];
  if (!part) return [];
  const xml = strFromU8(part);
  const out: string[] = [];
  // An <si> may hold one <t>, or several inside <r> runs that concatenate.
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let match: RegExpExecArray | null;
  while ((match = siRe.exec(xml)) !== null) {
    const pieces = match[1].match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) ?? [];
    out.push(
      pieces.map((p) => unescapeXmlText(p.replace(/<t\b[^>]*>|<\/t>/g, ''))).join('')
    );
  }
  return out;
}

/**
 * The `<c>` element for a new value, keeping the old cell's style.
 *
 * Strings go in as `inlineStr` rather than as an index into sharedStrings.
 * Appending to the shared table would mean renumbering nothing (indices are
 * append-only, so that part is safe) but also rewriting a part every other
 * sheet in the book points into -- a much wider blast radius than the one cell
 * being edited, for no gain. `inlineStr` is in the spec, Excel reads it, and
 * ETL's own reader handles it (etl_xlsx.py routes t="inlineStr" explicitly).
 *
 * Any `<f>` the cell held is NOT carried over. The cell now holds a literal
 * somebody typed, and keeping the formula beside it would mean Excel
 * recomputing the edit away on the next open.
 */
function buildCell(ref: string, styleAttr: string, value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return `<c r="${ref}"${styleAttr}/>`;
  }
  if (typeof value === 'boolean') {
    return `<c r="${ref}"${styleAttr} t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"${styleAttr}><v>${value}</v></c>`;
  }
  if (typeof value === 'bigint') {
    return `<c r="${ref}"${styleAttr}><v>${value.toString()}</v></c>`;
  }
  const text = String(value);
  // A number typed into a numeric column arrives as text from the webview.
  // Written as a number so the column stays numeric and the cell's own format
  // still applies -- writing "12.5" as text into a formatted column is how an
  // edited cell ends up left-aligned and excluded from every SUM around it.
  if (/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text.trim())) {
    return `<c r="${ref}"${styleAttr}><v>${text.trim()}</v></c>`;
  }
  return (
    `<c r="${ref}"${styleAttr} t="inlineStr">` +
    `<is><t xml:space="preserve">${escapeXmlText(text)}</t></is></c>`
  );
}

/** Put `cellXml` into `rowXml` at `ref`, replacing or inserting in column order. */
function spliceCell(rowXml: string, ref: string, letters: string, value: unknown): string {
  const cellRe = new RegExp(`<c\\b[^>]*?\\br="${letters}\\d+"[^>]*?(?:/>|>[\\s\\S]*?</c>)`);
  const existing = cellRe.exec(rowXml);
  if (existing) {
    // The style index is the cell's link to its number format, alignment,
    // font and borders. Dropping it is how an edited date cell comes back as
    // 45678 and an edited currency cell loses its symbol.
    const style = /\bs="(\d+)"/.exec(existing[0]);
    return rowXml.replace(cellRe, buildCell(ref, style ? ` s="${style[1]}"` : '', value));
  }

  // The cell is absent -- an empty cell Excel never wrote out. Cells must sit
  // in ascending column order inside a <row>, so insert before the first cell
  // that comes after it rather than appending.
  const target = columnIndexOf(letters);
  const cellRe2 = /<c\b[^>]*?\br="([A-Z]+)\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g;
  let match: RegExpExecArray | null;
  while ((match = cellRe2.exec(rowXml)) !== null) {
    if (columnIndexOf(match[1]) > target) {
      const at = match.index;
      return rowXml.slice(0, at) + buildCell(ref, '', value) + rowXml.slice(at);
    }
  }
  // Past every cell in the row, or the row is self-closing (<row r="7"/>).
  if (/<row\b[^>]*\/>/.test(rowXml)) {
    return rowXml.replace(/\/>$/, `>${buildCell(ref, '', value)}</row>`);
  }
  return rowXml.replace(/<\/row>\s*$/, `${buildCell(ref, '', value)}</row>`);
}

export interface PatchCellRequest {
  /** The .xlsx on disk. */
  filePath: string;
  /** Worksheet part inside the package, from listSheets(). */
  sheetPath: string;
  /** Column header text, as the grid shows it. */
  columnName: string;
  /** Every column the sheet's view exposes, in order, for finding the header row. */
  columnNames: readonly string[];
  /** 1-based position of the row among the rows read_xlsx returned. */
  rowOrdinal: number;
  /** What the grid showed in this cell. The write is refused if the file disagrees. */
  expectedCurrent: unknown;
  newValue: unknown;
}

/**
 * Whether the cell's stored text is the value the grid was showing.
 *
 * Deliberately loose about FORM and strict about VALUE. Excel stores 12.5 as
 * "12.5", 12.50 as "12.5", and a date as the serial number 45678 -- so a
 * character comparison would refuse most legitimate edits, while a comparison
 * that gave up and returned true would defeat the check entirely. Numbers are
 * compared as numbers, everything else as trimmed text, and a value this cannot
 * put in either bucket (a date against its serial number) answers true, because
 * the ordinal already agreed and refusing on a comparison this function is
 * simply not equipped to make would block editing every dated sheet.
 */
function looksLikeSameValue(stored: string, expected: unknown): boolean {
  if (expected === null || expected === undefined) return stored.trim() === '';
  if (typeof expected === 'boolean') return stored.trim() === (expected ? '1' : '0');

  const expectedText = String(expected).trim();
  const storedText = stored.trim();
  if (storedText === expectedText) return true;

  const a = Number(storedText);
  const b = Number(expectedText);
  if (Number.isFinite(a) && Number.isFinite(b)) {
    // Relative tolerance: Excel writes a double at up to 17 digits and the grid
    // shows fewer, so exact equality would refuse edits to ordinary numbers.
    const scale = Math.max(Math.abs(a), Math.abs(b), 1);
    return Math.abs(a - b) <= scale * 1e-9;
  }
  // One side numeric and the other not: a date column, where the file holds a
  // serial number and the grid holds a date. Not a disagreement this function
  // can adjudicate -- see the note above.
  return Number.isFinite(a) !== Number.isFinite(b);
}

/**
 * Rewrite one cell in place. Throws rather than guessing when the sheet's
 * shape does not support the mapping -- a refused edit is recoverable, a
 * misplaced one is not.
 */
export async function patchCell(request: PatchCellRequest): Promise<void> {
  const { filePath, sheetPath, columnName, columnNames, rowOrdinal, expectedCurrent, newValue } =
    request;

  const files = unzipSync(new Uint8Array(await readFile(filePath)));
  const part = files[sheetPath];
  if (!part) throw new Error(`The workbook has no worksheet part at ${sheetPath}.`);

  const sheetXml = strFromU8(part);
  const rows = readRows(sheetXml).filter(isNonEmpty);

  const sharedStrings = readSharedStrings(files);

  // The header row is FOUND, not counted to.
  //
  // The obvious derivation -- rows in the file minus rows in the table -- is
  // wrong on any sheet with trailing content, and real workbooks have plenty:
  // the sheet this was first run against holds 136 rows for 121 rows of data,
  // the surplus being notes below the table. That arithmetic put the "header"
  // fourteen rows into the data.
  //
  // So the header is the first row that actually carries the column names,
  // which is also a check: a row that matches every one of them is the header
  // in a way no count can be wrong about. Data rows are the rows after it, in
  // order -- read_xlsx returns them in sheet order, so its Nth row is the Nth
  // row here. Trailing junk sits past the end and is never indexed into,
  // because the ordinal always counts from the top.
  const wanted = new Set(columnNames);
  let headerIndex = -1;
  let headerCells = new Map<string, string>();
  for (let i = 0; i < rows.length; i++) {
    const cells = cellTextsOf(rows[i].xml, sharedStrings);
    const texts = new Set(cells.values());
    if ([...wanted].every((name) => texts.has(name))) {
      headerIndex = i;
      headerCells = cells;
      break;
    }
  }
  if (headerIndex === -1) {
    throw new Error(
      'Could not find the header row in this sheet, so there is no way to tell ' +
        'which row and column the edit belongs to. The cell was not changed.'
    );
  }

  // Which COLUMN, by the header's own text rather than by counting: a sheet
  // whose first column is blank starts at B, and every positional guess is
  // then one column out.
  let letters: string | undefined;
  for (const [ref, text] of headerCells) {
    if (text === columnName) {
      letters = ref;
      break;
    }
  }
  if (!letters) {
    throw new Error(
      `Could not find a column headed "${columnName}" in the sheet, so the edit ` +
        `cannot be placed. The cell was not changed.`
    );
  }

  const targetIndex = headerIndex + rowOrdinal;
  if (rowOrdinal < 1 || targetIndex >= rows.length) {
    throw new Error(
      `Row ${rowOrdinal} is past the end of this sheet (${rows.length} row(s) below ` +
        `the header). The cell was not changed.`
    );
  }
  const target = rows[targetIndex];
  const ref = `${letters}${target.number}`;

  // The second reading. DuckDB said this is the row; the file has to agree that
  // this cell currently holds what the grid was showing, or the two disagree
  // about which row is which and nothing should be written.
  const current = cellTextsOf(target.xml, sharedStrings).get(letters) ?? '';
  if (!looksLikeSameValue(current, expectedCurrent)) {
    throw new Error(
      `Cell ${ref} holds ${current === '' ? '(empty)' : `"${current}"`}, but the grid was ` +
        `showing ${expectedCurrent === null || expectedCurrent === undefined
          ? '(empty)'
          : `"${String(expectedCurrent)}"`}. Refusing to overwrite a cell that is not the ` +
        `one you edited — reopen the file and try again. The workbook was not changed.`
    );
  }

  const patched = spliceCell(target.xml, ref, letters, newValue);

  const updatedSheet = sheetXml.slice(0, target.start) + patched + sheetXml.slice(target.end);
  files[sheetPath] = strToU8(updatedSheet);

  // Rezipped whole, because a zip's central directory has to be rebuilt when
  // any member's compressed size changes. Every other member is passed through
  // as the bytes that came out, so nothing but the edited sheet is re-encoded.
  await writeFile(filePath, Buffer.from(zipSync(files)));
}
