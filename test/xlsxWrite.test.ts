import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { columnIndexOf, columnLettersOf, patchCell } from '../src/xlsxWrite';
import { DuckDbFile } from '../src/duckdbConnection';

/**
 * Editing a workbook without rewriting it.
 *
 * The whole point of patching the worksheet XML rather than regenerating it is
 * what SURVIVES, so most of these assert on things the edit was not supposed to
 * touch: the other sheet, the neighbouring formula, the cell's number format,
 * an integer that must not become 1.0. A test that only checked the new value
 * landed would pass just as happily for the wholesale rewrite this replaced.
 *
 * The fixture is hand-built XML rather than a workbook written by a library,
 * because the cases worth pinning are the ones a clean writer does not produce:
 * a sheet whose first column is blank, a row Excel never wrote a cell for, a
 * shared formula whose own `t="shared"` sits inside the cell it would be
 * mistaken for.
 */

let dir: string;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
</Types>`;

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="data" sheetId="1" r:id="rId1"/><sheet name="notes" sheetId="2" r:id="rId2"/></sheets>
</workbook>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`;

const SHARED = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="5" uniqueCount="5">
<si><t>name</t></si><si><t>qty</t></si><si><t>total</t></si><si><t>widget</t></si><si><t>bolt</t></si>
</sst>`;

/**
 * Column A deliberately empty, so the data starts at B and any code that maps
 * "first column" to A is one column out. Row 4 has no cell for D at all.
 * D3 carries a formula, which the edit to a different cell must not disturb.
 */
const SHEET1 = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="B1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c><c r="D1" t="s"><v>2</v></c></row>
<row r="2"><c r="B2" t="s"><v>3</v></c><c r="C2" s="4"><v>2</v></c><c r="D2" s="7"><v>5.5</v></c></row>
<row r="3"><c r="B3" t="s"><v>4</v></c><c r="C3" s="4"><v>10</v></c><c r="D3" s="7"><f t="shared" si="0">C3*2</f><v>20</v></c></row>
<row r="4"><c r="B4" t="inlineStr"><is><t>nut</t></is></c><c r="C4" s="4"><v>7</v></c></row>
</sheetData></worksheet>`;

const SHEET2 = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>keep me</t></is></c></row>
</sheetData></worksheet>`;

async function makeWorkbook(name: string): Promise<string> {
  const path = join(dir, name);
  const zipped = zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdW" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    ),
    'xl/workbook.xml': strToU8(WORKBOOK),
    'xl/_rels/workbook.xml.rels': strToU8(RELS),
    'xl/sharedStrings.xml': strToU8(SHARED),
    'xl/worksheets/sheet1.xml': strToU8(SHEET1),
    'xl/worksheets/sheet2.xml': strToU8(SHEET2),
  });
  await writeFile(path, Buffer.from(zipped));
  return path;
}

async function partOf(path: string, name: string): Promise<string> {
  return strFromU8(unzipSync(new Uint8Array(await readFile(path)))[name]);
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dfv-xlsx-write-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('column letters and indices round-trip past Z', () => {
  for (const [letters, index] of [
    ['A', 0],
    ['Z', 25],
    ['AA', 26],
    ['AZ', 51],
    ['BA', 52],
    ['ZZ', 701],
    ['AAA', 702],
  ] as const) {
    assert.equal(columnIndexOf(letters), index, letters);
    assert.equal(columnLettersOf(index), letters, String(index));
  }
});

test('a number is written into the right cell, found by header name not position', async () => {
  // Column A is empty in the fixture, so "qty" is column C. Anything that
  // counted columns instead of reading the header would write into B.
  const path = await makeWorkbook('number.xlsx');
  await patchCell({
    filePath: path,
    sheetPath: 'xl/worksheets/sheet1.xml',
    columnName: 'qty',
    rowOrdinal: 1,
    columnNames: ['name', 'qty', 'total'],
    expectedCurrent: 2,
    newValue: 99,
  });
  const sheet = await partOf(path, 'xl/worksheets/sheet1.xml');
  assert.match(sheet, /<c r="C2" s="4"><v>99<\/v><\/c>/);
  // B2 untouched, and still a shared string.
  assert.match(sheet, /<c r="B2" t="s"><v>3<\/v><\/c>/);
});

test("the cell's style survives, so a formatted column stays formatted", async () => {
  const path = await makeWorkbook('style.xlsx');
  await patchCell({
    filePath: path,
    sheetPath: 'xl/worksheets/sheet1.xml',
    columnName: 'total',
    rowOrdinal: 1,
    columnNames: ['name', 'qty', 'total'],
    expectedCurrent: 5.5,
    newValue: 6.25,
  });
  const sheet = await partOf(path, 'xl/worksheets/sheet1.xml');
  // s="7" is the cell's link to its number format. Dropping it is how an
  // edited currency cell loses its symbol and a date becomes 45678.
  assert.match(sheet, /<c r="D2" s="7"><v>6\.25<\/v><\/c>/);
});

test('an integer stays an integer', async () => {
  // The specific thing a regenerate-the-sheet save could not do: Excel has no
  // integer type, so a round trip through it turns 10 into 10.0 throughout.
  const path = await makeWorkbook('int.xlsx');
  await patchCell({
    filePath: path,
    sheetPath: 'xl/worksheets/sheet1.xml',
    columnName: 'qty',
    rowOrdinal: 2,
    columnNames: ['name', 'qty', 'total'],
    expectedCurrent: 10,
    newValue: 11,
  });
  const sheet = await partOf(path, 'xl/worksheets/sheet1.xml');
  assert.match(sheet, /<c r="C3" s="4"><v>11<\/v><\/c>/);
  assert.doesNotMatch(sheet, /<v>11\.0<\/v>/);
});

test('a neighbouring formula and the other sheet are left alone', async () => {
  const path = await makeWorkbook('preserve.xlsx');
  const before2 = await partOf(path, 'xl/worksheets/sheet2.xml');
  await patchCell({
    filePath: path,
    sheetPath: 'xl/worksheets/sheet1.xml',
    columnName: 'qty',
    rowOrdinal: 2,
    columnNames: ['name', 'qty', 'total'],
    expectedCurrent: 10,
    newValue: 12,
  });
  const sheet1 = await partOf(path, 'xl/worksheets/sheet1.xml');
  // D3's shared formula is still there. Its `t="shared"` sits inside the cell,
  // and is exactly the attribute an unanchored type match would read as the
  // CELL's type -- the bug ETL's reader documents.
  assert.match(sheet1, /<c r="D3" s="7"><f t="shared" si="0">C3\*2<\/f><v>20<\/v><\/c>/);
  // The other sheet is byte-identical, not merely present.
  assert.equal(await partOf(path, 'xl/worksheets/sheet2.xml'), before2);
  // And so is the shared string table, which was never appended to.
  assert.equal(await partOf(path, 'xl/sharedStrings.xml'), SHARED);
});

test('a string edit goes in as an inline string, escaped', async () => {
  const path = await makeWorkbook('string.xlsx');
  await patchCell({
    filePath: path,
    sheetPath: 'xl/worksheets/sheet1.xml',
    columnName: 'name',
    rowOrdinal: 1,
    columnNames: ['name', 'qty', 'total'],
    expectedCurrent: 'widget',
    newValue: 'Smith & Sons <Ltd>',
  });
  const sheet = await partOf(path, 'xl/worksheets/sheet1.xml');
  assert.match(sheet, /<c r="B2" t="inlineStr"><is><t xml:space="preserve">Smith &amp; Sons &lt;Ltd&gt;<\/t><\/is><\/c>/);
  assert.equal(await partOf(path, 'xl/sharedStrings.xml'), SHARED);
});

test('a cell Excel never wrote is inserted in column order', async () => {
  // Row 4 has B and C but no D. Appending it would leave the row out of
  // column order, which Excel reads as a corrupt sheet.
  const path = await makeWorkbook('insert.xlsx');
  await patchCell({
    filePath: path,
    sheetPath: 'xl/worksheets/sheet1.xml',
    columnName: 'total',
    rowOrdinal: 3,
    columnNames: ['name', 'qty', 'total'],
    expectedCurrent: null,
    newValue: 3.5,
  });
  const sheet = await partOf(path, 'xl/worksheets/sheet1.xml');
  const row4 = /<row r="4">[\s\S]*?<\/row>/.exec(sheet)![0];
  const order = [...row4.matchAll(/<c r="([A-Z]+)4"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['B', 'C', 'D']);
  assert.match(row4, /<c r="D4"><v>3\.5<\/v><\/c>/);
});

test('an edit is refused when the file disagrees about what the cell holds', async () => {
  // The safety net over the row-ordinal mapping. Two independent readings have
  // to agree before anything is written, and here they do not.
  const path = await makeWorkbook('mismatch.xlsx');
  const before = await readFile(path);
  await assert.rejects(
    () =>
      patchCell({
        filePath: path,
        sheetPath: 'xl/worksheets/sheet1.xml',
        columnName: 'qty',
        rowOrdinal: 1,
        columnNames: ['name', 'qty', 'total'],
        expectedCurrent: 4242, // C2 actually holds 2
        newValue: 5,
      }),
    /Refusing to overwrite/
  );
  assert.deepEqual(await readFile(path), before, 'the workbook was modified anyway');
});

test('trailing content below the table does not shift the header', async () => {
  // The bug that a row-count subtraction cannot survive, and the reason the
  // header is searched for instead. Real workbooks carry notes under the data:
  // the sheet this was first run against had 136 rows for 121 rows of data,
  // and `rows.length - dataRowCount` put the "header" fourteen rows in.
  const path = join(dir, 'trailing.xlsx');
  const withNotes = SHEET1.replace(
    '</sheetData>',
    `<row r="6"><c r="B6" t="inlineStr"><is><t>source: somewhere</t></is></c></row>` +
      `<row r="7"><c r="B7" t="inlineStr"><is><t>revised 2026</t></is></c></row></sheetData>`
  );
  await writeFile(
    path,
    Buffer.from(
      zipSync({
        '[Content_Types].xml': strToU8(CONTENT_TYPES),
        '_rels/.rels': strToU8(
          `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdW" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
        ),
        'xl/workbook.xml': strToU8(WORKBOOK),
        'xl/_rels/workbook.xml.rels': strToU8(RELS),
        'xl/sharedStrings.xml': strToU8(SHARED),
        'xl/worksheets/sheet1.xml': strToU8(withNotes),
        'xl/worksheets/sheet2.xml': strToU8(SHEET2),
      })
    )
  );

  await patchCell({
    filePath: path,
    sheetPath: 'xl/worksheets/sheet1.xml',
    columnName: 'qty',
    rowOrdinal: 1,
    columnNames: ['name', 'qty', 'total'],
    expectedCurrent: 2,
    newValue: 42,
  });
  const sheet = await partOf(path, 'xl/worksheets/sheet1.xml');
  // Row 2 -- the first DATA row -- not row 16 and not one of the notes.
  assert.match(sheet, /<c r="C2" s="4"><v>42<\/v><\/c>/);
  assert.match(sheet, /<c r="B6" t="inlineStr"><is><t>source: somewhere<\/t><\/is><\/c>/);
});

test('a row past the end of the sheet is refused', async () => {
  const path = await makeWorkbook('offset.xlsx');
  await assert.rejects(
    () =>
      patchCell({
        filePath: path,
        sheetPath: 'xl/worksheets/sheet1.xml',
        columnName: 'qty',
        rowOrdinal: 99,
        columnNames: ['name', 'qty', 'total'],
        expectedCurrent: 2,
        newValue: 5,
      }),
    /past the end of this sheet/
  );
});

test('a sheet with no header row at all is refused, not guessed at', async () => {
  const path = await makeWorkbook('noheader.xlsx');
  await assert.rejects(
    () =>
      patchCell({
        filePath: path,
        sheetPath: 'xl/worksheets/sheet2.xml',
        columnName: 'qty',
        rowOrdinal: 1,
        columnNames: ['name', 'qty', 'total'],
        expectedCurrent: 2,
        newValue: 5,
      }),
    /find the header row/
  );
});

test('the edited workbook still opens, with the edit in it', async () => {
  // End to end through DuckDB's own reader: a package this rewrote has to be
  // one read_xlsx still accepts, which the XML assertions above cannot show.
  const path = await makeWorkbook('reopen.xlsx');
  await patchCell({
    filePath: path,
    sheetPath: 'xl/worksheets/sheet1.xml',
    columnName: 'qty',
    rowOrdinal: 2,
    columnNames: ['name', 'qty', 'total'],
    expectedCurrent: 10,
    newValue: 55,
  });
  const file = await DuckDbFile.open(path);
  try {
    const r = await file.runQuery('select "qty" from "data" order by "qty"');
    assert.deepEqual(
      r.rows.map((row) => Number(row[0])),
      [2, 7, 55]
    );
    const other = await file.runQuery('select count(*) from "notes"');
    assert.equal(Number(other.rows[0][0]), 0);
  } finally {
    file.dispose();
  }
});

test('an edit made through updateCell lands in the file', async () => {
  // The real path: DuckDB finds the row by its values, reports the ordinal,
  // xlsxWrite places it. Nothing here knows a row number.
  const path = await makeWorkbook('endtoend.xlsx');
  const file = await DuckDbFile.open(path);
  try {
    const info = await file.checkEditableSelect('select * from "data"');
    assert.equal(info.editable, true, '.xlsx should be editable');
    const n = await file.updateCell('data', 'qty', 77, { name: 'bolt', qty: 10, total: 20 });
    assert.equal(n, 1);
  } finally {
    file.dispose();
  }
  const reopened = await DuckDbFile.open(path);
  try {
    const r = await reopened.runQuery(`select "qty" from "data" where "name" = 'bolt'`);
    assert.equal(Number(r.rows[0][0]), 77);
  } finally {
    reopened.dispose();
  }
});
