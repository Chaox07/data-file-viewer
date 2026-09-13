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

// ===================================================================
// E20 -- interpretTextColumns casts a text column to DOUBLE
// ===================================================================
//
// NEW on 2026-09-12, not in the 2026-09-09 review. Found while writing the E17
// control above, and the two belong together: E17 established that the query
// TRANSPORT is exact, and it is. This is one layer earlier, and it is where the
// exactness is spent.
//
// interpretTextColumns() promotes a VARCHAR column to numbers when the column
// "demonstrably holds numbers", and markerNullExpr does the promoting with
//
//     try_cast(<normalised> as double)
//
// -- double, unconditionally, whatever the column actually holds. The guard in
// front of it (markerResidueExpr, run over the whole column) asks whether every
// value CAN be cast, not whether the cast keeps the value. `try_cast(
// '9007199254740993' as double)` succeeds; it just succeeds with a different
// number. So the check cannot see this loss, by construction.
//
// Not DuckDB's doing. `read_csv_auto` types both fixtures below as VARCHAR and
// returns them intact; the promotion is this project's own and runs after it.
//
// EXT-04 owns it. It has to precede EXT-02: there is no point comparing an
// expected value against a stored one when the expected value is already the
// wrong number.

test('E20: an exact integer wider than 2^53 keeps every digit', async () => {
  // FIXED by EXT-04. The promotion used to cast to DOUBLE regardless of what
  // the column held, so any integer past 2^53 was rounded to the nearest
  // representable double -- UP as readily as down, which is why two of these
  // three values moved in different directions. Nothing was logged, because
  // every value cast successfully and the residue guard saw a clean column.
  //
  // This column is now left as TEXT, and by two of EXT-04's decisions at once:
  // '007' is an identifier, so the exact-integer round-trip refuses the column,
  // and a column that cannot be promoted without changing a value is not
  // promoted. All three values therefore come back exactly as written.
  const path = join(dir, 'e20-wide.csv');
  // The column is VARCHAR because of the '007' row -- that is what stops DuckDB
  // typing it BIGINT (the E17 control above, where it does).
  await writeFile(path, 'id\n9007199254740993\n9007199254740995\n007\n', 'utf8');
  const file = await DuckDbFile.open(path);
  try {
    const typed = await file.runQuery('select typeof(id) as t from "e20-wide" limit 1');
    assert.equal(String(cell(typed, 0, 't')), 'VARCHAR');

    const result = await file.runQuery('select id from "e20-wide"');
    const at = result.columns.indexOf('id');
    assert.deepEqual(result.rows.map((r) => String(r[at])), [
      '9007199254740993',
      '9007199254740995',
      '007',
    ]);
  } finally {
    file.dispose();
  }
});

test('EXT-04: a wide integer column without leading zeros is promoted, exactly', async () => {
  // The other half of the decision, and the one that keeps the fix from being
  // "refuse everything". Nothing here needs to stay text: every value is a
  // whole number that BIGINT holds exactly. It is promoted, it sorts and
  // summarises as a number, and 2^53+1 survives -- which is precisely what
  // DOUBLE could not do.
  const path = join(dir, 'ext04-wide-clean.csv');
  await writeFile(path, 'id\n9007199254740993\n9007199254740995\n42\n', 'utf8');
  const file = await DuckDbFile.open(path);
  try {
    const typed = await file.runQuery('select typeof(id) as t from "ext04-wide-clean" limit 1');
    assert.equal(String(cell(typed, 0, 't')), 'BIGINT');
    const result = await file.runQuery('select id from "ext04-wide-clean" order by id');
    const at = result.columns.indexOf('id');
    assert.deepEqual(result.rows.map((r) => String(r[at])), [
      '42',
      '9007199254740993',
      '9007199254740995',
    ]);
  } finally {
    file.dispose();
  }
});

// ===================================================================
// E23 -- the CSV SNIFFER types a wide-integer column DOUBLE
// ===================================================================
//
// NEW on 2026-09-12, found while validating EXT-04's fix. It is NOT E20, and
// the distinction is the whole point of both:
//
//   - E20/E21 is this project's own promotion. It needs a column DuckDB typed
//     VARCHAR -- which is why every E20 fixture carries a '007' -- and the
//     damage is done by interpretTextColumns after the read. EXT-04 fixed it.
//
//   - E23 is DuckDB's CSV type inference, and it happens BEFORE any code in
//     this repository runs. Remove the padded row and the sniffer types the
//     column DOUBLE itself, so the values are already gone by the time
//     interpretTextColumns is offered the view -- it sees no VARCHAR column at
//     all and correctly does nothing.
//
// The same reader returns every digit under `all_varchar=true` (the control
// below), so the file is intact and the reader is capable; the loss is in the
// type the sniffer chose. read_csv_auto also declines to reach for HUGEINT: a
// 23-digit identifier is past BIGINT and comfortably inside HUGEINT, and it
// goes to DOUBLE regardless.
//
// NOT fixed here. The remedy is to read the main CSV view `all_varchar` and let
// the (now exact) promotion assign types, and that is a much larger change than
// it sounds -- the sniffer is also what types date and timestamp columns, which
// the promotion does not handle. It needs its own package and its own decision.

test('E23: a wide-integer CSV column is typed DOUBLE by the sniffer, before any of our code runs', async (t) => {
  t.todo(
    'E23: 23 digits is past BIGINT and well inside HUGEINT, and read_csv_auto ' +
      'chooses DOUBLE anyway. interpretTextColumns never sees the column -- it ' +
      'is not VARCHAR by the time it is offered one -- so EXT-04 cannot reach ' +
      'this and did not try to.'
  );
  const path = join(dir, 'e23-hugeint.csv');
  await writeFile(path, 'id\n12345678901234567890123\n12345678901234567890124\n', 'utf8');
  const file = await DuckDbFile.open(path);
  try {
    const typed = await file.runQuery('select typeof(id) as t from "e23-hugeint" limit 1');
    assert.equal(String(cell(typed, 0, 't')), 'HUGEINT', 'E23 is fixed; drop this pin');
  } finally {
    file.dispose();
  }
});

test('E23: an integer past every exact type is shown in scientific notation', async (t) => {
  t.todo(
    'E23: 40 digits cannot be held exactly by anything, which is precisely when ' +
      'the column must stay text -- EXT-04 decides exactly that for a column it ' +
      'is given. This one it is not given: the sniffer typed it DOUBLE first.'
  );
  const path = join(dir, 'e23-astronomical.csv');
  await writeFile(
    path,
    'id\n1234567890123456789012345678901234567890\n1234567890123456789012345678901234567891\n',
    'utf8'
  );
  const file = await DuckDbFile.open(path);
  try {
    const result = await file.runQuery('select id from "e23-astronomical"');
    const at = result.columns.indexOf('id');
    assert.deepEqual(
      result.rows.map((r) => String(r[at])),
      [
        '1234567890123456789012345678901234567890',
        '1234567890123456789012345678901234567891',
      ],
      'E23 is fixed; drop this pin'
    );
  } finally {
    file.dispose();
  }
});

test('E21: a Stata .dta column declared a string is read back as text', async (t) => {
  // The fourth declared-type format, and the one with the strongest provenance
  // of the four: neither DuckDB nor apache-arrow can WRITE a .dta -- DuckDB's
  // dta extension reads only -- so a fixture written by the reader's own
  // library is not available even in principle. It is therefore built by
  // pandas in the Tier B corpus (test/stress/foreign/build_corpus.py) and
  // recorded in the committed manifest.
  //
  // Tier B's convention: the files are gitignored and absent on a machine with
  // no Python, so a missing fixture SKIPS with the build command rather than
  // failing. `npm test` stays green either way.
  const { access } = await import('node:fs/promises');
  const path = join(
    __dirname, '..', '..', '..', 'test', 'stress', '_work', 'foreign', 'pandas-declared-text.dta'
  );
  try {
    await access(path);
  } catch {
    t.skip(
      'Tier B corpus not built — run: conda run -n myproject python ' +
        'test/stress/foreign/build_corpus.py'
    );
    return;
  }

  const file = await DuckDbFile.open(path);
  try {
    const table = (await file.listTables())[0];
    const typed = await file.runQuery(`select typeof(id) as t from "${table}" limit 1`);
    assert.equal(String(cell(typed, 0, 't')), 'VARCHAR', 'the .dta column was promoted');
    const result = await file.runQuery(`select id from "${table}"`);
    const at = result.columns.indexOf('id');
    assert.deepEqual(result.rows.map((r) => String(r[at])), [...DECLARED_TEXT_VALUES]);
  } finally {
    file.dispose();
  }
});

test('E23 control: the same reader returns every digit under all_varchar', async () => {
  // What makes E23 a finding rather than a limit of CSV. The file holds the
  // characters, and DuckDB will hand them over intact when it is not asked to
  // guess a type. Nothing here goes through DuckDbFile: this is the reader,
  // by itself, on the same bytes.
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const path = join(dir, 'e23-control.csv');
  await writeFile(path, 'id\n12345678901234567890123\n1.5\n9007199254740993\n', 'utf8');
  const con = await (await DuckDBInstance.create(':memory:')).connect();
  const reader = await con.runAndReadAll(
    `select id from read_csv_auto('${path.replace(/'/g, "''")}', all_varchar=true)`
  );
  assert.deepEqual(reader.getRows().map((r) => String(r[0])), [
    '12345678901234567890123',
    '1.5',
    '9007199254740993',
  ]);
});

test('EXT-04: ordinary decimals are still promoted, and still read as numbers', async () => {
  // The control on the whole package. A fix that stopped promoting decimal
  // columns would break every chart in the viewer, and would pass a test suite
  // that only checked identifiers. Markers still become NULL, too.
  const path = join(dir, 'ext04-decimals.csv');
  await writeFile(path, 'rate\n1.50\n2.25\n#N/A\n1e3\n', 'utf8');
  const file = await DuckDbFile.open(path);
  try {
    const typed = await file.runQuery('select typeof(rate) as t from "ext04-decimals" limit 1');
    assert.equal(String(cell(typed, 0, 't')), 'DOUBLE');
    const result = await file.runQuery('select rate from "ext04-decimals"');
    const at = result.columns.indexOf('rate');
    assert.deepEqual(result.rows.map((r) => (r[at] === null ? null : Number(r[at]))), [
      1.5, 2.25, null, 1000,
    ]);
  } finally {
    file.dispose();
  }
});

test('EXT-04: a column mixing integers and decimals keeps its magnitudes', async () => {
  // A mixed column is a quantity, so DOUBLE is the right reading -- but an
  // exact integer past 2^53 hiding among the decimals would still be changed
  // by it. The fidelity check is asked of `double` too, for exactly this, and
  // the column stays text rather than reporting 9007199254740992.
  //
  // Driven through a WORKBOOK rather than a CSV, deliberately. A CSV of these
  // three values never reaches interpretTextColumns at all -- the sniffer
  // types it DOUBLE first, which is E23 above and a different defect. A sheet
  // is read all_varchar, so this exercises the promotion, which is what this
  // test is about.
  const path = join(dir, 'ext04-mixed.xlsx');
  await writeFile(path, Buffer.from(workbookOf(['1.5', '9007199254740993', '2.25'])));
  const file = await DuckDbFile.open(path);
  try {
    // Reading the sheet is what makes the viewer inspect it, and detection is
    // what creates the table. Asking listTables() first finds only the sheet.
    const verbatim = await file.runQuery('select "A" from "data"');
    assert.deepEqual(verbatim.rows.map((r) => String(r[0])).slice(1), [
      '1.5',
      '9007199254740993',
      '2.25',
    ]);

    const table = (await file.listTables()).find((n) => n.startsWith('data · Table '));
    assert.ok(table, 'no table was detected inside the sheet');
    const result = await file.runQuery(`select * from "${table}"`);
    const at = result.columns.indexOf('v');
    assert.deepEqual(result.rows.map((r) => String(r[at])), ['1.5', '9007199254740993', '2.25']);
  } finally {
    file.dispose();
  }
});

test('EXT-04: a Turkish-formatted column is promoted without losing a value', async () => {
  // The locale path normalises separators before casting, so it has to be
  // checked for the same loss. parseEu's reading of these is 1794446.52 and
  // 12.5, and the fidelity test compares against the NORMALISED text rather
  // than the raw column, or every Turkish column would be refused.
  const path = join(dir, 'ext04-eu.csv');
  await writeFile(path, 'tutar\n1.794.446,52\n12,5\nNA\n', 'utf8');
  const file = await DuckDbFile.open(path);
  try {
    const result = await file.runQuery('select tutar from "ext04-eu"');
    const at = result.columns.indexOf('tutar');
    assert.deepEqual(result.rows.map((r) => (r[at] === null ? null : Number(r[at]))), [
      1794446.52, 12.5, null,
    ]);
  } finally {
    file.dispose();
  }
});

test('E20: a workbook\'s sheet and the table inside it agree on every value', async () => {
  // FIXED by EXT-04, and this was the sharpest form of the finding. The
  // verbatim sheet is read all_varchar and was always EXACT -- so the file was
  // fine and the values were there. The detected table inside that same sheet
  // was the promoted one, and it is the object the grid sorts, the stats panel
  // summarises, the chart plots and a cell edit addresses. One open workbook,
  // two answers, nothing said.
  //
  // The verbatim sheet is therefore both the evidence and the ORACLE here: it
  // is asserted first, and the table is then required to match it.
  // Text cells, so the sheet holds exactly these characters.
  const path = join(dir, 'e20-sheet.xlsx');
  const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>id</t></is></c><c r="B1" t="inlineStr"><is><t>note</t></is></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>9007199254740993</t></is></c><c r="B2" t="inlineStr"><is><t>a</t></is></c></row>
<row r="3"><c r="A3" t="inlineStr"><is><t>9007199254740995</t></is></c><c r="B3" t="inlineStr"><is><t>b</t></is></c></row>
<row r="4"><c r="A4" t="inlineStr"><is><t>007</t></is></c><c r="B4" t="inlineStr"><is><t>c</t></is></c></row>
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

  const file = await DuckDbFile.open(path);
  try {
    const verbatim = await file.runQuery('select "A" from "data"');
    const seenVerbatim = verbatim.rows.map((r) => String(r[0])).slice(1);
    assert.deepEqual(
      seenVerbatim,
      ['9007199254740993', '9007199254740995', '007'],
      'the verbatim sheet is meant to be the file, exactly -- if this moved, the ' +
        'control this finding rests on is gone and E20 needs re-establishing'
    );

    const table = (await file.listTables()).find((n) => n.startsWith('data · Table '));
    assert.ok(table, 'no table was detected inside the sheet');
    const typed = await file.runQuery(`select * from "${table}"`);
    const at = typed.columns.indexOf('id');
    assert.deepEqual(
      typed.rows.map((r) => String(r[at])),
      seenVerbatim,
      'the detected table disagrees with the sheet it was detected in'
    );
  } finally {
    file.dispose();
  }
});

/**
 * The same three values written into formats that DECLARE their column types.
 *
 * This is the sharper half of E20, and the reason it is not merely a CSV
 * problem. interpretTextColumns already refuses to touch attached .duckdb and
 * .sqlite tables, and its own comment gives the principle: "Those are real
 * tables with a schema the file itself declares; a column is VARCHAR there
 * because its writer said so. Reinterpreting untyped text out of a spreadsheet
 * is a reading of an ambiguous file — overriding a stated schema is a different
 * and much larger claim, and not one a viewer should make."
 *
 * Parquet, Arrow and Feather declare their schemas too. Their writers said so
 * as plainly as SQLite's did. The exclusion is drawn around the storage
 * mechanism -- attached database versus view -- rather than around the
 * principle it states, so every one of them is promoted, and the claim the
 * comment calls too large to make is made on each of them.
 */

/** The three values as a one-batch Arrow table with an explicit Utf8 `id`. */
/**
 * The three values every declared-text fixture carries: two exact integers
 * either side of 2^53 that a double moves in opposite directions, and one
 * padded identifier. Shared so the Parquet, Arrow and Feather fixtures are
 * provably the same data in four different declarations.
 */
const DECLARED_TEXT_VALUES = ['9007199254740993', '9007199254740995', '007'] as const;

async function arrowTable(ids: readonly string[] = DECLARED_TEXT_VALUES) {
  const { Table, Utf8, vectorFromArray } = await import('apache-arrow');
  return new Table({
    id: vectorFromArray(ids, new Utf8()),
    note: vectorFromArray(ids.map((_, i) => String.fromCharCode(97 + i)), new Utf8()),
  });
}

/**
 * Write the table at `path` in one of Arrow's two IPC encodings.
 *
 * Both, because the handoff distinguishes them and this project has been bitten
 * by the difference before: `.arrows` is the STREAM encoding and `.feather` the
 * FILE one, and a fixture covering one says nothing about the other.
 * apache-arrow rather than DuckDB, which has no arrow COPY function in this
 * build -- and which would in any case make the fixture and the reader the same
 * library.
 */
async function writeArrow(
  path: string,
  encoding: 'stream' | 'file',
  ids: readonly string[] = DECLARED_TEXT_VALUES
): Promise<void> {
  const arrow = await import('apache-arrow');
  const { createWriteStream } = await import('node:fs');
  const writer =
    encoding === 'file' ? new arrow.RecordBatchFileWriter() : new arrow.RecordBatchStreamWriter();
  const out = createWriteStream(path);
  const done = new Promise<void>((resolve, reject) => {
    out.on('finish', () => resolve());
    out.on('error', reject);
  });
  writer.toNodeStream().pipe(out);
  for (const batch of (await arrowTable(ids)).batches) writer.write(batch);
  writer.finish();
  await done;
}

type TypedFixture = {
  ext: string;
  /** `ids` lets one fixture shape serve both the lossy case and the clean one. */
  write: (path: string, ids?: readonly string[]) => Promise<void>;
  what: string;
};

const TYPED_FORMATS: TypedFixture[] = [
  {
    ext: 'parquet',
    what: 'Parquet, whose schema names the column a BYTE_ARRAY/UTF8',
    write: async (path, ids = DECLARED_TEXT_VALUES) => {
      // Written by DuckDB itself, so the column is VARCHAR because the writer
      // said so -- no sniffing anywhere in the fixture's provenance.
      const seed = await DuckDbFile.open(join(dir, 'e17.csv'));
      try {
        await seed.runQuery(
          `copy (select * from (values ${ids
            .map((v, i) => `('${v}','${String.fromCharCode(97 + i)}')`)
            .join(',')}) ` + `t(id, note)) to '${path.replace(/'/g, "''")}' (FORMAT parquet)`
        );
      } finally {
        seed.dispose();
      }
    },
  },
  {
    ext: 'arrows',
    what: 'Arrow IPC STREAM, whose schema names the field Utf8',
    write: (path, ids) => writeArrow(path, 'stream', ids),
  },
  {
    ext: 'feather',
    what: 'Arrow IPC FILE (Feather), the other encoding of the same declaration',
    write: (path, ids) => writeArrow(path, 'file', ids),
  },
];

for (const { ext, write, what } of TYPED_FORMATS) {
  test(`E21: a .${ext} column declared as text is read back as text`, async () => {
    // FIXED by EXT-04. The file declares this column a string and the viewer
    // used to return doubles. interpretTextColumns excluded attached
    // .duckdb/.sqlite tables precisely because their schema is declared -- but
    // Parquet, Arrow and Feather declare theirs just as plainly and are views,
    // so the exclusion, drawn around the storage MECHANISM, missed them. The
    // values were lost against the file's own stated type, which is a stronger
    // claim than the CSV case: there is nothing ambiguous left to interpret.
    //
    // The exclusion is now drawn around the principle the code already stated,
    // so this column is not touched at all -- not "promoted carefully", not
    // promoted.
    const path = join(dir, `e20-typed.${ext}`);
    await write(path);

    const file = await DuckDbFile.open(path);
    try {
      const table = (await file.listTables())[0];
      const typed = await file.runQuery(`select typeof(id) as t from "${table}" limit 1`);
      assert.equal(String(cell(typed, 0, 't')), 'VARCHAR', `the .${ext} column was promoted`);
      const result = await file.runQuery(`select id from "${table}"`);
      const at = result.columns.indexOf('id');
      assert.deepEqual(result.rows.map((r) => String(r[at])), [
        '9007199254740993',
        '9007199254740995',
        '007',
      ]);
    } finally {
      file.dispose();
    }
  });

  test(`E21: a .${ext} column of clean integers is left alone too, because its type is declared`, async () => {
    // The consequence of the decision, stated as a test so nobody "improves"
    // it later by accident. This column would be promoted without losing
    // anything if it came from a CSV -- and it is still not promoted, because
    // the question is not "can we get away with it" but "did the file's writer
    // already say what this column is".
    const path = join(dir, `ext04-typed-clean.${ext}`);
    await write(path, ['1', '2', '3']);
    const file = await DuckDbFile.open(path);
    try {
      const table = (await file.listTables())[0];
      const typed = await file.runQuery(`select typeof(id) as t from "${table}" limit 1`);
      assert.equal(String(cell(typed, 0, 't')), 'VARCHAR');
    } finally {
      file.dispose();
    }
  });

  test(`E20 control: the .${ext} file really does declare the column as text`, async () => {
    // Without this the test above could pass because the fixture was written
    // numeric, which would make it evidence of nothing at all. Read straight
    // out of the file with apache-arrow or DuckDB's own reader -- not through
    // DuckDbFile, which is the thing under test.
    const path = join(dir, `e20-typed-control.${ext}`);
    await write(path);

    if (ext === 'parquet') {
      const seed = await DuckDbFile.open(join(dir, 'e17.csv'));
      try {
        const declared = await seed.runQuery(
          `select typeof(id) as t from '${path.replace(/'/g, "''")}' limit 1`
        );
        assert.equal(String(cell(declared, 0, 't')), 'VARCHAR', what);
        const raw = await seed.runQuery(`select id from '${path.replace(/'/g, "''")}'`);
        assert.deepEqual(
          raw.rows.map((r) => String(r[0])),
          ['9007199254740993', '9007199254740995', '007']
        );
      } finally {
        seed.dispose();
      }
      return;
    }

    const arrow = await import('apache-arrow');
    const reader = await arrow.RecordBatchReader.from(await readFile(path));
    const table = new arrow.Table(await reader.readAll());
    assert.equal(String(table.schema.fields[0].type), 'Utf8', what);
    assert.deepEqual(
      table.getChild('id')!.toArray() instanceof Array
        ? (table.getChild('id')!.toArray() as unknown[]).map(String)
        : Array.from(table.getChild('id')!).map(String),
      ['9007199254740993', '9007199254740995', '007']
    );
  });
}

test('E20 control: DuckDB itself returns both fixtures intact', async () => {
  // The control that fixes the blame. Neither loss is DuckDB's CSV sniffer:
  // read_csv_auto types this column VARCHAR and hands back every character.
  // Whatever EXT-04 does, it must not "fix" this by reaching for a reader
  // option -- the reader was already right.
  const path = join(dir, 'e20-control.csv');
  await writeFile(path, 'id\n9007199254740993\n007\n', 'utf8');
  const file = await DuckDbFile.open(join(dir, 'e17.csv'));
  try {
    const result = await file.runQuery(
      `select id from read_csv_auto('${path.replace(/'/g, "''")}')`
    );
    const at = result.columns.indexOf('id');
    assert.deepEqual(result.rows.map((r) => String(r[at])), ['9007199254740993', '007']);
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

/**
 * A one-column workbook whose every cell is an INLINE STRING, so the sheet
 * holds exactly these characters and nothing has sniffed a type for them.
 *
 * A workbook rather than a CSV is the only way to hand interpretTextColumns a
 * VARCHAR column of arbitrary numbers: a CSV goes through read_csv_auto's
 * sniffer first, which types a numeric-looking column itself (E23) and leaves
 * the promotion nothing to decide.
 */
function workbookOf(values: readonly string[], header = 'v'): Uint8Array {
  // A second column, because table detection inside a sheet needs a region to
  // find and a single column is not one.
  const cells = values
    .map(
      (v, i) =>
        `<row r="${i + 2}"><c r="A${i + 2}" t="inlineStr"><is><t>${v}</t></is></c>` +
        `<c r="B${i + 2}" t="inlineStr"><is><t>${String.fromCharCode(97 + i)}</t></is></c></row>`
    )
    .join('\n');
  const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>${header}</t></is></c>` +
    `<c r="B1" t="inlineStr"><is><t>note</t></is></c></row>
${cells}
</sheetData></worksheet>`;
  return zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdW" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    ),
    'xl/workbook.xml': strToU8(WORKBOOK),
    'xl/_rels/workbook.xml.rels': strToU8(RELS),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  });
}

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

// ===================================================================
// EXT-04: the format axis, closed rather than sampled
// ===================================================================
//
// The promotion runs over every format exposed as a VIEW, so a fix tested on
// two of them is a fix whose scope nobody knows. Each supported view-backed
// format gets a test here, and each of the two attached kinds gets one saying
// it stays out. The declared-type four (parquet, arrow, feather, dta) are
// covered above, with their own controls proving each fixture really declares
// its column text.
//
// That leaves the ambiguous three -- csv, xlsx, kdb -- which are the formats
// the promotion is FOR: a CSV has no types at all, a worksheet cell carries a
// display format rather than a column type, and a kdb file is parsed by this
// project's own reader.

test('EXT-04 axis: a CSV is still interpreted — it declares no types at all', async () => {
  const path = join(dir, 'axis.csv');
  await writeFile(path, 'rate\n1.5\n#N/A\n2.5\n', 'utf8');
  const file = await DuckDbFile.open(path);
  try {
    const typed = await file.runQuery('select typeof(rate) as t from "axis" limit 1');
    assert.equal(String(cell(typed, 0, 't')), 'DOUBLE');
  } finally {
    file.dispose();
  }
});

test('EXT-04 axis: a worksheet is still interpreted — a cell format is not a column type', async () => {
  const path = join(dir, 'axis-sheet.xlsx');
  await writeFile(path, Buffer.from(workbookOf(['1.5', 'NA', '2.5'], 'rate')));
  const file = await DuckDbFile.open(path);
  try {
    await file.runQuery('select "A" from "data"');
    const table = (await file.listTables()).find((n) => n.startsWith('data · Table '));
    assert.ok(table, 'no table was detected inside the sheet');
    const typed = await file.runQuery(`select typeof(rate) as t from "${table}" limit 1`);
    assert.equal(String(cell(typed, 0, 't')), 'DOUBLE');
  } finally {
    file.dispose();
  }
});

test('EXT-04 axis: an attached .duckdb table stays excluded, as it always was', async () => {
  // Not a new guarantee — a preserved one. The original exclusion covered the
  // two attached kinds, and redrawing the boundary around declared schemas must
  // not accidentally let them in. A text column here is text because a CREATE
  // TABLE said so.
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const path = join(dir, 'axis.duckdb');
  const seed = await (await DuckDBInstance.create(path)).connect();
  await seed.run(
    `create table t as select * from (values ('9007199254740993','a'),('007','b')) v(id, note)`
  );
  await seed.run('checkpoint');
  seed.closeSync();

  const file = await DuckDbFile.open(path);
  try {
    const typed = await file.runQuery('select typeof(id) as t from t limit 1');
    assert.equal(String(cell(typed, 0, 't')), 'VARCHAR');
    const result = await file.runQuery('select id from t order by id');
    const at = result.columns.indexOf('id');
    assert.deepEqual(result.rows.map((r) => String(r[at])), ['007', '9007199254740993']);
  } finally {
    file.dispose();
  }
});

// ===================================================================
// EXT-04: leading zeros, with and without other text
// ===================================================================

test('EXT-04: a padded identifier column keeps its padding', async () => {
  // The decided reading: an all-digit column carrying a leading zero is an
  // identifier, and `007` and `7` are different values. Nothing about this
  // column is a quantity, and sorting it as text is the correct consequence.
  const path = join(dir, 'padded.csv');
  await writeFile(path, 'account\n007\n042\n100\n', 'utf8');
  const file = await DuckDbFile.open(path);
  try {
    const result = await file.runQuery('select account from "padded"');
    const at = result.columns.indexOf('account');
    assert.deepEqual(result.rows.map((r) => String(r[at])), ['007', '042', '100']);
  } finally {
    file.dispose();
  }
});

test('EXT-04: a padded column mixed with real text is refused for the ordinary reason', async () => {
  // Two reasons now exist for keeping a column as text, and they must not be
  // confused: this one holds a value that is not a number at all, so it is the
  // residue check that stops it, not the fidelity check. The distinction
  // matters because the two produce different notices.
  const path = join(dir, 'padded-text.csv');
  await writeFile(path, 'account\n007\nunassigned\n100\n', 'utf8');
  const file = await DuckDbFile.open(path);
  try {
    const result = await file.runQuery('select account from "padded-text"');
    const at = result.columns.indexOf('account');
    assert.deepEqual(result.rows.map((r) => String(r[at])), ['007', 'unassigned', '100']);
  } finally {
    file.dispose();
  }
});

test('EXT-04: a single zero is a number, not a padded identifier', async () => {
  // `0` has a leading zero only in the sense that it is entirely one. Treating
  // it as an identifier would refuse every column containing a plain zero,
  // which is most numeric columns in existence.
  const path = join(dir, 'zeros.csv');
  await writeFile(path, 'n\n0\n1\n0\n', 'utf8');
  const file = await DuckDbFile.open(path);
  try {
    const typed = await file.runQuery('select typeof(n) as t from "zeros" limit 1');
    assert.notEqual(String(cell(typed, 0, 't')), 'VARCHAR', 'a column of 0 and 1 is numeric');
  } finally {
    file.dispose();
  }
});

// ===================================================================
// EXT-04: the verbatim sheet is the oracle, and must stay exact
// ===================================================================

test('EXT-04: the verbatim sheet is untouched by any of this', async () => {
  // The workbook case above rests entirely on the verbatim sheet being the
  // file, exactly. If a change ever made the sheet agree with a promoted table
  // by moving the SHEET, every workbook assertion in this file would go green
  // while the values were lost. So the sheet is asserted against the characters
  // written into the package, independently of any table.
  const path = join(dir, 'verbatim.xlsx');
  await writeFile(path, Buffer.from(workbookOf([...DECLARED_TEXT_VALUES, '1.50', 'NA'])));
  const file = await DuckDbFile.open(path);
  try {
    const verbatim = await file.runQuery('select "A" from "data"');
    assert.deepEqual(verbatim.rows.map((r) => String(r[0])), [
      'v',
      '9007199254740993',
      '9007199254740995',
      '007',
      '1.50',
      'NA',
    ]);
  } finally {
    file.dispose();
  }
});
