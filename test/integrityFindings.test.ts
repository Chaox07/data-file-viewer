import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { patchCell } from '../src/xlsxWrite';
import { DuckDbFile } from '../src/duckdbConnection';

/**
 * The reproduced findings of the 2026-09-09 data-integrity review.
 *
 * Recipes 8 and 9 of section 11 of DATA_INTEGRITY_AND_PERFORMANCE_HANDOFF.md,
 * evidence E14, E15, E16 and E17. The review reproduced each against the real
 * classes with throwaway scripts and then discarded the scripts, which left
 * four findings recorded only in a document. A defect a document remembers is
 * one the suite cannot contradict.
 *
 * How a pinned defect is written here. node's test runner has no xfail, so a
 * reproduced defect is asserted the other way round: the test states what the
 * code DOES today, and `t.todo(...)` carries the reason and puts it in the
 * runner's `todo` column rather than its `pass` column. When the fix lands the
 * assertion fails, loudly, at the exact line that describes the old behaviour
 * -- which is the signal to rewrite it as the correct expectation and drop the
 * todo. The stress corpus in test/stress/ has a real `knownBug` mechanism and
 * is the better home for anything that fits its case shape; these two need
 * fault injection and a hand-built package, which that harness does not drive.
 *
 * Every pinned check is paired with a CONTROL that must pass -- the same
 * fixture on the path that works. E17 is the control for the whole file: exact
 * numeric transport already works, and no fix here may cost it.
 *
 * EXT-01 owns E15, EXT-02 owns E14/E16. These report; they fix nothing.
 */

let dir: string;

/** One cell of a QueryResult, by row index and column name. */
function cell(result: { columns: string[]; rows: unknown[][] }, row: number, column: string): unknown {
  const at = result.columns.indexOf(column);
  assert.ok(at >= 0, `no column named ${column} in ${JSON.stringify(result.columns)}`);
  assert.ok(result.rows.length > row, `no row ${row} in a result of ${result.rows.length}`);
  return result.rows[row][at];
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dfv-integrity-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ===================================================================
// E17 -- the control: exact numeric transport
// ===================================================================

test('E17 control: a big integer and a wide decimal survive the query path exactly', async () => {
  // 9007199254740993 is 2^53 + 1: the first integer a JavaScript number cannot
  // represent. If anything on this path ever converts through a double it comes
  // back as ...992, and the loss is silent and unrecoverable. Both arrive as
  // strings today, which is what makes that impossible.
  const path = join(dir, 'e17.csv');
  await writeFile(path, 'id\n1\n', 'utf8');
  const file = await DuckDbFile.open(path);
  try {
    const result = await file.runQuery(
      "select 9007199254740993::BIGINT as big, 1234567890.123456789::DECIMAL(19,9) as wide"
    );
    assert.equal(String(cell(result, 0, 'big')), '9007199254740993');
    assert.equal(String(cell(result, 0, 'wide')), '1234567890.123456789');
  } finally {
    file.dispose();
  }
});

test('E17 control: a long numeric identifier read from a CSV stays exact', async () => {
  // The same hazard arriving from a file rather than a literal: an account
  // number wide enough to lose its last digits to a double. Typed BIGINT and
  // carried exactly, which is E17's claim.
  const path = join(dir, 'e17-ids.csv');
  await writeFile(path, 'account\n9007199254740993\n9007199254740995\n', 'utf8');
  const file = await DuckDbFile.open(path);
  try {
    const result = await file.runQuery('select account from "e17-ids" order by 1');
    const at = result.columns.indexOf('account');
    const seen = result.rows.map((r) => String(r[at]));
    assert.deepEqual(seen, ['9007199254740993', '9007199254740995']);
  } finally {
    file.dispose();
  }
});

test('a zero-padded identifier column is typed DOUBLE, losing the padding', async (t) => {
  t.todo(
    'NEW on 2026-09-12, not from the 2026-09-09 review, found while writing the ' +
      'E17 control. DuckDB\'s CSV sniffer types a zero-padded numeric column as ' +
      'DOUBLE rather than VARCHAR, so the padding is gone -- and because the ' +
      'whole column is then a double, a neighbouring exact integer is dragged ' +
      'through it too: 9007199254740993 arrives as ...992. E17 established that ' +
      'the TRANSPORT is exact; this is the reader typing the column, one layer ' +
      'earlier, and the loss happens before transport ever sees it. Needs triage ' +
      'against EXT-02 (edit/display types) and LIB-01 (reader options).'
  );
  const path = join(dir, 'e17-padded.csv');
  await writeFile(path, 'account\n9007199254740993\n00123456789012345\n', 'utf8');
  const file = await DuckDbFile.open(path);
  try {
    const typed = await file.runQuery('select typeof(account) as t from "e17-padded" limit 1');
    assert.equal(
      String(cell(typed, 0, 't')),
      'DOUBLE',
      'the column is no longer typed DOUBLE; re-read this finding'
    );

    const result = await file.runQuery('select account from "e17-padded" order by 1');
    const at = result.columns.indexOf('account');
    const seen = result.rows.map((r) => String(r[at]));
    assert.deepEqual(
      seen,
      ['123456789012345', '9007199254740992'],
      'the loss this pins has changed shape; re-read the finding'
    );
  } finally {
    file.dispose();
  }
});

// ===================================================================
// Recipe 8 -- E14 and E15: what an edit matches, and what a failed
//             save leaves behind
// ===================================================================

async function twoIdenticalRows(name: string): Promise<string> {
  const path = join(dir, name);
  // Two rows identical in every column. Nothing in the file distinguishes them,
  // which is the whole point: the edit has to decide what to do about that.
  await writeFile(path, 'name,qty\nwidget,2\nwidget,2\nbolt,7\n', 'utf8');
  return path;
}

test('E14: editing one of two identical rows changes both', async (t) => {
  t.todo(
    'E14: the UPDATE matches on full-row equality, so rows identical in every ' +
      'column are one row to it. The user edited one and two changed, with ' +
      'nothing said. EXT-02 owns the policy decision -- refuse, keep the ' +
      'explicit multi-row behaviour, or introduce row identity -- so this pins ' +
      'the current behaviour rather than asserting a fix.'
  );
  const path = await twoIdenticalRows('e14.csv');
  const file = await DuckDbFile.open(path);
  try {
    const changed = await file.updateCell('e14', 'qty', 99, { name: 'widget', qty: 2 });
    assert.equal(
      changed,
      2,
      'the edit matched a number of rows this test does not describe; re-read the finding'
    );

    const after = await readFile(path, 'utf8');
    const lines = after.trim().split('\n').slice(1);
    assert.equal(
      lines.filter((l) => l.includes('99')).length,
      2,
      `two rows should carry the new value on disk: ${JSON.stringify(lines)}`
    );
  } finally {
    file.dispose();
  }
});

test('E14 control: an edit to a row nothing else matches changes exactly one', async () => {
  // The control. Whatever EXT-02 decides about ambiguous rows, an unambiguous
  // edit must keep matching exactly one row -- a fix that refused everything
  // would satisfy the pin above and break editing.
  const path = await twoIdenticalRows('e14-control.csv');
  const file = await DuckDbFile.open(path);
  try {
    const changed = await file.updateCell('e14-control', 'qty', 8, { name: 'bolt', qty: 7 });
    assert.equal(changed, 1);
    const after = await readFile(path, 'utf8');
    assert.match(after, /bolt,8/);
    assert.doesNotMatch(after, /bolt,7/);
  } finally {
    file.dispose();
  }
});

test('E15: a failed write-back leaves memory holding a value the disk does not', async (t) => {
  t.todo(
    'E15: updateCell runs the UPDATE against the in-memory table and only then ' +
      'writes the file. When the write fails the table keeps the new value, so ' +
      'the grid, every later query and every subsequent write-back are working ' +
      'from a number that is not in the file. EXT-01 owns the rollback and ' +
      'publication contract.'
  );
  const path = await twoIdenticalRows('e15.csv');
  const file = await DuckDbFile.open(path);
  try {
    // A first, successful edit, so the file is materialized and the failure
    // below lands on the write-back rather than on setup.
    await file.updateCell('e15', 'qty', 3, { name: 'bolt', qty: 7 });

    // Fail the next publication. Reaching into the private member is
    // deliberate: the fault has to land between the in-memory update and the
    // file write, which is precisely where a full disk or a revoked permission
    // would land, and there is no public seam at that point.
    const injected = new Error('injected: no space left on device');
    (file as unknown as { writeBackFlatFile: () => Promise<void> }).writeBackFlatFile =
      async () => {
        throw injected;
      };

    let raised: unknown;
    try {
      await file.updateCell('e15', 'qty', 42, { name: 'bolt', qty: 3 });
    } catch (err) {
      raised = err;
    }
    assert.equal(raised, injected, 'the injected failure was swallowed');

    const onDisk = await readFile(path, 'utf8');
    assert.doesNotMatch(onDisk, /bolt,42/, 'the file should not hold the failed edit');

    const result = await file.runQuery(`select qty from "e15" where name = 'bolt'`);
    const inMemory = String(cell(result, 0, 'qty'));
    assert.equal(
      inMemory,
      '42',
      'this test pins the divergence; if memory no longer holds 42 the finding is fixed'
    );
  } finally {
    file.dispose();
  }
});

test('E15 control: a successful edit leaves memory and disk agreeing', async () => {
  const path = await twoIdenticalRows('e15-control.csv');
  const file = await DuckDbFile.open(path);
  try {
    await file.updateCell('e15-control', 'qty', 42, { name: 'bolt', qty: 7 });
    const result = await file.runQuery(`select qty from "e15-control" where name = 'bolt'`);
    assert.equal(String(cell(result, 0, 'qty')), '42');
    assert.match(await readFile(path, 'utf8'), /bolt,42/);
  } finally {
    file.dispose();
  }
});

// ===================================================================
// Recipe 9 -- E16: the guard that lets through what it exists to catch
// ===================================================================

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
</Types>`;

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="data" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

/** One cell, at A1, holding `stored`. Read verbatim, so A1 is row 1 column A. */
async function oneCellWorkbook(name: string, stored: string): Promise<string> {
  const path = join(dir, name);
  const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1"><v>${stored}</v></c></row>
</sheetData></worksheet>`;
  const zipped = zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdW" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    ),
    'xl/workbook.xml': strToU8(WORKBOOK),
    'xl/_rels/workbook.xml.rels': strToU8(RELS),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  });
  await writeFile(path, Buffer.from(zipped));
  return path;
}

async function sheetOf(path: string): Promise<string> {
  return strFromU8(unzipSync(new Uint8Array(await readFile(path)))['xl/worksheets/sheet1.xml']);
}

function patchA1(path: string, expectedCurrent: unknown, newValue: unknown) {
  return patchCell({
    filePath: path,
    sheetPath: 'xl/worksheets/sheet1.xml',
    columnName: 'A',
    columnNames: ['A'],
    rowOrdinal: 1,
    verbatim: true,
    expectedCurrent,
    newValue,
  });
}

test('E16: a numeric cell accepts an expected value that is not a number', async (t) => {
  t.todo(
    "E16: looksLikeSameValue answers true whenever exactly one side parses as a " +
      'number, so a stored 123 "agrees" with an expected "not-a-date". The rule ' +
      'exists for date columns, where the file holds a serial and the grid holds ' +
      'a date -- but it cannot tell that case from a genuine disagreement, so it ' +
      'lets every mismatch of that shape through. EXT-02 owns the source-aware ' +
      'replacement.'
  );
  const path = await oneCellWorkbook('e16-text.xlsx', '123');
  await patchA1(path, 'not-a-date', 999);
  assert.match(
    await sheetOf(path),
    /<c r="A1"><v>999<\/v><\/c>/,
    'the write was refused; the finding is fixed and this test should now assert that'
  );
});

test('E16: a numeric cell accepts an expected value one part in a billion away', async (t) => {
  t.todo(
    'E16: the relative tolerance is 1e-9, which at this magnitude is a whole ' +
      'unit -- so a stored 1000000001 "agrees" with an expected 1000000000 and ' +
      'a stale grid can overwrite a cell that has since changed. The tolerance ' +
      'exists because Excel stores a double at up to 17 digits while the grid ' +
      'shows fewer; a source-aware comparison would not need to guess.'
  );
  const path = await oneCellWorkbook('e16-near.xlsx', '1000000001');
  await patchA1(path, 1000000000, 7);
  assert.match(
    await sheetOf(path),
    /<c r="A1"><v>7<\/v><\/c>/,
    'the write was refused; the finding is fixed and this test should now assert that'
  );
});

test('E16 control: a stale expectation far from the stored value is refused', async () => {
  // The guard is not absent, and this is what it does catch. A fix must keep
  // this refusing rather than tightening everything into a refusal of edits
  // that should succeed.
  const path = await oneCellWorkbook('e16-refuse.xlsx', '123');
  await assert.rejects(
    () => patchA1(path, 456, 999),
    /Refusing to overwrite/,
    'a clearly stale numeric expectation was accepted'
  );
  assert.match(await sheetOf(path), /<c r="A1"><v>123<\/v><\/c>/, 'the cell was written anyway');
});

test('E16 control: an ordinary edit still lands', async () => {
  // The other half of the control: display rounding must keep working. The grid
  // shows 12.5 for a stored 12.5, and an edit quoting it has to be accepted.
  const path = await oneCellWorkbook('e16-ok.xlsx', '12.5');
  await patchA1(path, 12.5, 13);
  assert.match(await sheetOf(path), /<c r="A1"><v>13<\/v><\/c>/);
});
