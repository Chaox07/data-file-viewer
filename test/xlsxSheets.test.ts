import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';

import { listSheets } from '../src/xlsxSheets';

/** Build a minimal .xlsx package with the given workbook/rels XML. */
function makeXlsx(parts: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'xlsxsheets-'));
  const path = join(dir, 'book.xlsx');
  const files: Record<string, Uint8Array> = {};
  for (const [name, body] of Object.entries(parts)) files[name] = strToU8(body);
  writeFileSync(path, Buffer.from(zipSync(files)));
  return path;
}

const RELS = (entries: string) =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries}</Relationships>`;

const BOOK = (sheets: string) =>
  `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>`;

test('sheets come back in workbook order, not archive or alphabetical order', async () => {
  const path = makeXlsx({
    'xl/workbook.xml': BOOK(
      '<sheet name="Zebra" sheetId="1" r:id="rId3"/>' +
      '<sheet name="Apple" sheetId="2" r:id="rId1"/>' +
      '<sheet name="Mango" sheetId="3" r:id="rId2"/>'
    ),
    'xl/_rels/workbook.xml.rels': RELS(
      '<Relationship Id="rId1" Type="x" Target="worksheets/sheet2.xml"/>' +
      '<Relationship Id="rId2" Type="x" Target="worksheets/sheet3.xml"/>' +
      '<Relationship Id="rId3" Type="x" Target="worksheets/sheet1.xml"/>'
    ),
    'xl/worksheets/sheet1.xml': '<worksheet/>',
    'xl/worksheets/sheet2.xml': '<worksheet/>',
    'xl/worksheets/sheet3.xml': '<worksheet/>',
  });
  const got = await listSheets(path);
  assert.deepEqual(got.map((s) => s.name), ['Zebra', 'Apple', 'Mango']);
  assert.deepEqual(got.map((s) => s.path), [
    'xl/worksheets/sheet1.xml',
    'xl/worksheets/sheet2.xml',
    'xl/worksheets/sheet3.xml',
  ]);
  rmSync(path, { force: true });
});

test('attribute ORDER does not matter (Excel writes Id/Type/Target, openpyxl Type/Target/Id)', async () => {
  const excelStyle = makeXlsx({
    'xl/workbook.xml': BOOK('<sheet name="S" sheetId="1" r:id="rId1"/>'),
    'xl/_rels/workbook.xml.rels': RELS(
      '<Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/>'
    ),
    'xl/worksheets/sheet1.xml': '<worksheet/>',
  });
  const openpyxlStyle = makeXlsx({
    'xl/workbook.xml': BOOK('<sheet r:id="rId1" sheetId="1" name="S"/>'),
    'xl/_rels/workbook.xml.rels': RELS(
      '<Relationship Type="t" Target="worksheets/sheet1.xml" Id="rId1"/>'
    ),
    'xl/worksheets/sheet1.xml': '<worksheet/>',
  });
  assert.deepEqual(await listSheets(excelStyle), await listSheets(openpyxlStyle));
  rmSync(excelStyle, { force: true });
  rmSync(openpyxlStyle, { force: true });
});

test('absolute and ./-relative rel targets both resolve', async () => {
  const path = makeXlsx({
    'xl/workbook.xml': BOOK(
      '<sheet name="Abs" sheetId="1" r:id="rId1"/><sheet name="Dot" sheetId="2" r:id="rId2"/>'
    ),
    'xl/_rels/workbook.xml.rels': RELS(
      '<Relationship Id="rId1" Type="t" Target="/xl/worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="t" Target="./worksheets/sheet2.xml"/>'
    ),
    'xl/worksheets/sheet1.xml': '<worksheet/>',
    'xl/worksheets/sheet2.xml': '<worksheet/>',
  });
  const got = await listSheets(path);
  assert.deepEqual(got.map((s) => s.path), [
    'xl/worksheets/sheet1.xml',
    'xl/worksheets/sheet2.xml',
  ]);
  rmSync(path, { force: true });
});

test('names carrying XML entities and quotes are decoded, not passed through raw', async () => {
  const path = makeXlsx({
    'xl/workbook.xml': BOOK(
      '<sheet name="P&amp;L &lt;2026&gt;" sheetId="1" r:id="rId1"/>' +
      "<sheet name=\"O&apos;Brien\" sheetId=\"2\" r:id=\"rId2\"/>"
    ),
    'xl/_rels/workbook.xml.rels': RELS(
      '<Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="t" Target="worksheets/sheet2.xml"/>'
    ),
    'xl/worksheets/sheet1.xml': '<worksheet/>',
    'xl/worksheets/sheet2.xml': '<worksheet/>',
  });
  const got = await listSheets(path);
  assert.deepEqual(got.map((s) => s.name), ['P&L <2026>', "O'Brien"]);
  rmSync(path, { force: true });
});

test('a ZIP that is not a workbook is refused, not silently empty', async () => {
  const path = makeXlsx({ 'not/a/workbook.txt': 'hello' });
  await assert.rejects(() => listSheets(path), /no xl\/workbook\.xml/);
  rmSync(path, { force: true });
});

test('a file that is not a ZIP at all is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xlsxsheets-'));
  const path = join(dir, 'bogus.xlsx');
  writeFileSync(path, Buffer.from('this is plainly not a zip archive'));
  await assert.rejects(() => listSheets(path), /Not a readable \.xlsx package/);
  rmSync(path, { force: true });
});

test('a sheet whose r:id resolves to nothing still lists, with an empty path', async () => {
  // read_xlsx addresses sheets by NAME, so a missing rel is not fatal: the
  // name is still worth offering rather than dropping the sheet outright.
  const path = makeXlsx({
    'xl/workbook.xml': BOOK('<sheet name="Orphan" sheetId="1" r:id="rIdMissing"/>'),
    'xl/_rels/workbook.xml.rels': RELS(''),
    'xl/worksheets/sheet1.xml': '<worksheet/>',
  });
  const got = await listSheets(path);
  assert.deepEqual(got, [{ name: 'Orphan', path: '' }]);
  rmSync(path, { force: true });
});
