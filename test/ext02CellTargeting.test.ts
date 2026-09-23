import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { patchCell } from '../src/xlsxWrite';
import { DuckDbFile } from '../src/duckdbConnection';

/**
 * EXT-02 -- an edit changes the cell it was made on, or nothing.
 *
 * E14 and E16 are in integrityFindings.test.ts. This file covers what fixing
 * them had to decide, on the user's answers of 2026-09-13:
 *
 *   - an edit that matches rows identical in every column is refused, on every
 *     kind of source (E14 was a CSV; attached tables took the same path);
 *   - a workbook cell holding a formula refuses an edit rather than losing the
 *     formula to a typed value;
 *   - a date typed into a date-formatted cell is written as Excel's serial, so it
 *     stays a date;
 *   - the stale-edit guard compares by what the cell declares itself to be --
 *     text as text, integers of any width exactly, dates through their format --
 *     instead of E16's tolerance and its "one side is numeric" pass.
 *
 * The workbooks are hand-built so each cell's type, style and formula are known
 * exactly, and every assertion reads the worksheet XML back rather than asking
 * the writer what it did.
 */

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dfv-ext02-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Style 1 is built-in date format 14; style 2 a custom date-time; style 3 a
// currency format whose quoted "TL" must not read as a date.
const STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd\\ hh:mm:ss"/><numFmt numFmtId="165" formatCode="&quot;TL&quot;#,##0.00"/></numFmts>
<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="165" applyNumberFormat="1"/></cellXfs>
</styleSheet>`;

function workbook(sheetData: string, options: { date1904?: boolean } = {}): Uint8Array {
  const pr = options.date1904 ? '<workbookPr date1904="1"/>' : '';
  return zipSync({
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdW" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    ),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${pr}
<sheets><sheet name="data" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    'xl/styles.xml': strToU8(STYLES),
    'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
${sheetData}
</sheetData></worksheet>`),
  });
}

/** 2026-01-02 is serial 46024 in the 1900 system; 09:30 is 9.5/24 of a day. */
const ROW1 =
  '<row r="1">' +
  '<c r="A1"><v>123</v></c>' +
  '<c r="B1" s="1"><v>46024</v></c>' +
  '<c r="C1"><f>A1*2</f><v>246</v></c>' +
  '<c r="D1" s="2"><v>46024.395833333336</v></c>' +
  '<c r="E1" t="inlineStr"><is><t>007</t></is></c>' +
  '<c r="F1" t="b"><v>1</v></c>' +
  '<c r="G1"><v>9007199254740993</v></c>' +
  '<c r="H1"><f t="shared" si="0"/><v>5</v></c>' +
  '<c r="I1" s="3"><v>1500.5</v></c>' +
  '<c r="J1"><v>12.5</v></c>' +
  '</row>';

async function book(name: string, sheetData = ROW1, options: { date1904?: boolean } = {}) {
  const path = join(dir, name);
  await writeFile(path, Buffer.from(workbook(sheetData, options)));
  return path;
}

function patch(path: string, letter: string, expectedCurrent: unknown, newValue: unknown) {
  return patchCell({
    filePath: path,
    sheetPath: 'xl/worksheets/sheet1.xml',
    columnName: letter,
    columnNames: [letter],
    rowOrdinal: 1,
    verbatim: true,
    expectedCurrent,
    newValue,
  });
}

async function cellXml(path: string, ref: string): Promise<string> {
  const sheet = strFromU8(unzipSync(new Uint8Array(await readFile(path)))['xl/worksheets/sheet1.xml']);
  const m = new RegExp(`<c r="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`).exec(sheet);
  return m ? m[0] : '';
}

// ------------------------------------------------------------ formulas

test('EXT-02: a formula cell refuses an edit and keeps its formula', async () => {
  const path = await book('formula.xlsx');
  const before = await readFile(path);
  await assert.rejects(() => patch(path, 'C', 246, 999), /C1 holds a formula \(=A1\*2\)/);
  assert.deepEqual(await readFile(path), before, 'the workbook changed');
});

test('EXT-02: a shared-formula cell, which carries no formula text of its own, refuses too', async () => {
  const path = await book('shared.xlsx');
  await assert.rejects(() => patch(path, 'H', 5, 6), /H1 holds a formula/);
  assert.match(await cellXml(path, 'H1'), /<f t="shared" si="0"\/>/);
});

// ------------------------------------------------------------ dates

test('EXT-02: a date typed into a date cell is written as its serial, and stays a date', async () => {
  const path = await book('date-write.xlsx');
  await patch(path, 'B', '46024', '2026-02-02');
  assert.equal(await cellXml(path, 'B1'), '<c r="B1" s="1"><v>46055</v></c>');
});

test('EXT-02: a date-time typed into a date-time cell keeps its time of day', async () => {
  const path = await book('datetime-write.xlsx');
  await patch(path, 'D', '2026-01-02 09:30:00', '2026-01-02 10:00:00');
  assert.equal(await cellXml(path, 'D1'), `<c r="D1" s="2"><v>${46024 + 36000 / 86400}</v></c>`);
});

test('EXT-02: a date cell matches the date the grid shows for its serial, and nothing else', async () => {
  // A typed table shows `2026-01-02` for the stored 46024. That pair used to
  // pass only because ANY number-versus-text pair passed (E16).
  const ok = await book('date-match.xlsx');
  await patch(ok, 'B', '2026-01-02', 46030);
  assert.match(await cellXml(ok, 'B1'), /<v>46030<\/v>/);

  const stale = await book('date-stale.xlsx');
  await assert.rejects(() => patch(stale, 'B', '2026-01-03', 46030), /Refusing to overwrite/);
  const staleTime = await book('datetime-stale.xlsx');
  await assert.rejects(
    () => patch(staleTime, 'D', '2026-01-02 09:31:00', '2026-01-02 10:00:00'),
    /Refusing to overwrite/
  );
});

test('EXT-02: text that is not a date is refused by a date cell rather than stored as text', async () => {
  const path = await book('date-text.xlsx');
  const before = await readFile(path);
  await assert.rejects(() => patch(path, 'B', '46024', '02/02/2026'), /formatted as a date/);
  assert.deepEqual(await readFile(path), before);

  // A number is what a date cell holds, so a serial typed directly still lands.
  await patch(path, 'B', '46024', '46100');
  assert.equal(await cellXml(path, 'B1'), '<c r="B1" s="1"><v>46100</v></c>');
});

test('EXT-02: a workbook on the 1904 date system gets 1904 serials', async () => {
  const path = await book('date1904.xlsx', '<row r="1"><c r="B1" s="1"><v>44562</v></c></row>', {
    date1904: true,
  });
  await patch(path, 'B', '2026-01-02', '2026-01-03');
  assert.equal(await cellXml(path, 'B1'), '<c r="B1" s="1"><v>44563</v></c>');
});

test('EXT-02 control: a currency format is not a date format', async () => {
  // "TL" in quotes contains no date letter once the quotes are read as quotes;
  // a naive scan of the format code would see none either, but one that forgot
  // escapes or [colour] blocks would. Typed ISO text stays text here.
  const path = await book('currency.xlsx');
  await patch(path, 'I', 1500.5, '2026-01-02');
  assert.match(await cellXml(path, 'I1'), /t="inlineStr"/);
});

// ------------------------------------------------------------ the guard

test('EXT-02: a text cell matches only its own text', async () => {
  const refused = await book('text-refused.xlsx');
  await assert.rejects(() => patch(refused, 'E', 7, 'x'), /Refusing to overwrite/);
  const ok = await book('text-ok.xlsx');
  await patch(ok, 'E', '007', 'x');
  assert.match(await cellXml(ok, 'E1'), /<t xml:space="preserve">x<\/t>/);
});

test('EXT-02: integers past 2^53 are compared exactly', async () => {
  // 9007199254740992 and ...993 are the same double, so a numeric comparison
  // cannot tell a stale value from the stored one.
  const refused = await book('wide-refused.xlsx');
  await assert.rejects(() => patch(refused, 'G', '9007199254740992', 1), /Refusing to overwrite/);
  const ok = await book('wide-ok.xlsx');
  await patch(ok, 'G', '9007199254740993', 1);
  assert.match(await cellXml(ok, 'G1'), /<v>1<\/v>/);
});

test('EXT-02 control: the same number in another form still matches', async () => {
  const path = await book('form.xlsx');
  await patch(path, 'J', '12.50', 13);
  assert.match(await cellXml(path, 'J1'), /<v>13<\/v>/);
});

test('EXT-02: a boolean cell matches its own truth value', async () => {
  const refused = await book('bool-refused.xlsx');
  await assert.rejects(() => patch(refused, 'F', false, true), /Refusing to overwrite/);
  const ok = await book('bool-ok.xlsx');
  await patch(ok, 'F', true, false);
  assert.match(await cellXml(ok, 'F1'), /t="b"><v>0<\/v>/);
});

// ------------------------------------------------------------ through DuckDbFile

test('EXT-02: a date edit through a typed table in a workbook lands as a date', async () => {
  // The path E16's loophole existed for: read_xlsx types the column DATE, the
  // grid holds `2026-01-02`, the file holds 46024.
  const rows = [
    '<row r="1"><c r="A1" t="inlineStr"><is><t>when</t></is></c><c r="B1" t="inlineStr"><is><t>qty</t></is></c></row>',
    '<row r="2"><c r="A2" s="1"><v>46024</v></c><c r="B2"><v>2</v></c></row>',
    '<row r="3"><c r="A3" s="1"><v>46027</v></c><c r="B3"><v>7</v></c></row>',
    '<row r="4"><c r="A4" s="1"><v>46028</v></c><c r="B4"><v>9</v></c></row>',
  ].join('\n');
  const path = await book('typed-table.xlsx', rows);
  const file = await DuckDbFile.open(path);
  try {
    await file.runQuery('select * from "data"');
    const table = (await file.listTables()).find((n) => n.startsWith('data · Table '));
    assert.ok(table, `no detected table in ${JSON.stringify(await file.listTables())}`);
    const result = await file.runQuery(`select * from "${table}" order by qty`);
    const row = Object.fromEntries(result.columns.map((c, i) => [c, result.rows[0][i]]));
    assert.equal(String(row.when).slice(0, 10), '2026-01-02', `fixture read as ${JSON.stringify(row)}`);
    assert.equal(await file.updateCell(table, 'when', '2026-02-02', row), 1);
  } finally {
    file.dispose();
  }
  assert.equal(await cellXml(path, 'A2'), '<c r="A2" s="1"><v>46055</v></c>');
});

test('EXT-02: identical rows of an attached DuckDB table are refused like a CSV', async () => {
  // Attached tables took a different branch of updateCell -- no materialize, no
  // write-back, one autocommitted UPDATE -- so E14's CSV fix did not reach them.
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const path = join(dir, 'identical.duckdb');
  const instance = await DuckDBInstance.create(path);
  const seed = await instance.connect();
  await seed.run(`create table t as select * from (values ('widget', 2), ('widget', 2), ('bolt', 7)) v(name, qty)`);
  await seed.run('checkpoint');
  seed.closeSync();
  instance.closeSync();

  const file = await DuckDbFile.open(path);
  try {
    await assert.rejects(
      () => file.updateCell('t', 'qty', 99, { name: 'widget', qty: 2 }),
      /2 rows in "t" are identical/
    );
    const kept = await file.runQuery('select count(*) as n from t where qty = 99');
    assert.equal(String(kept.rows[0][0]), '0', 'the refused edit was committed');
    assert.equal(await file.updateCell('t', 'qty', 8, { name: 'bolt', qty: 7 }), 1, 'an unambiguous edit failed');
  } finally {
    file.dispose();
  }
});

test('EXT-02: an edit that names no row is refused instead of updating every row', async () => {
  const path = join(dir, 'no-row.csv');
  await writeFile(path, 'name,qty\nwidget,2\nbolt,7\n', 'utf8');
  const before = await readFile(path, 'utf8');
  const file = await DuckDbFile.open(path);
  try {
    await assert.rejects(() => file.updateCell('no-row', 'qty', 0, {}), /did not say which row/);
  } finally {
    file.dispose();
  }
  assert.equal(await readFile(path, 'utf8'), before);
});
