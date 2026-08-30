import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { DuckDbFile } from '../../../src/duckdbConnection';
import { registerCase, type CaseContext, type CanonicalTable } from '../expect';
import { firstTable, readTable } from '../harness/inspect';
import * as w from './_write';

/**
 * open -> edit one cell -> save -> reopen -> the edit is there, and NOTHING
 * ELSE MOVED.
 *
 * This is the property that caught both of the real bugs behind this suite, and
 * the second half is the half that matters. A test asserting only that the new
 * value landed passes just as happily for a writer that rewrites the whole file
 * and throws away the formulas, the styles, the other sheets, and the column
 * types -- which is precisely what the xlsx patcher was written to avoid. So
 * every case here compares the FULL table before and after, cell by cell, and
 * for container kinds also compares the bytes of the parts that were not the
 * target.
 *
 * The reopen is a genuine second open of the file on disk, not a re-read of the
 * live handle. Reading back through the connection that did the write proves
 * only that DuckDB remembers what it was told; the question is what is in the
 * file.
 */

const BASE: w.TableSpec = {
  name: 'data',
  columns: [
    { name: 'id', type: 'INTEGER' },
    { name: 'label', type: 'VARCHAR' },
    { name: 'amount', type: 'DOUBLE' },
    { name: 'note', type: 'VARCHAR' },
  ],
  rows: [
    [1, 'alpha', 1.5, 'first'],
    [2, 'beta', 2.5, null],
    [3, 'gamma', 3.5, 'third'],
    [4, 'delta', 4.5, 'fourth'],
  ],
};

const ARROW_COLUMNS: w.ArrowColumn[] = [
  { name: 'id', encoding: 'int32', values: [1, 2, 3, 4] },
  { name: 'label', encoding: 'utf8', values: ['alpha', 'beta', 'gamma', 'delta'] },
  { name: 'amount', encoding: 'float64', values: [1.5, 2.5, 3.5, 4.5] },
];

/** Which row, which column, and what to put there. */
interface Edit {
  /** 0-based index into the rows as read back. */
  row: number;
  column: string;
  value: unknown;
}

interface RoundTripSpec {
  kind: string;
  build: (dir: string) => Promise<string>;
  edit: Edit;
  /** Extra bytes that must be identical afterwards, keyed for the message. */
  untouched?: (path: string) => Promise<Record<string, string>>;
  /**
   * Whether the file itself must differ afterwards.
   *
   * False for the real database kinds: DuckDB and SQLite commit through a
   * write-ahead log, so an edit can be durable -- a reopen sees it, which is
   * the property that actually matters -- while the main file is still byte
   * for byte what it was. Asserting a byte change there tests the storage
   * engine's flush timing, not the viewer.
   */
  fileMustChange?: boolean;
  note: string;
  knownBug?: string;
}

/**
 * Apply the edit and report on what happened, in the caller's ctx.
 *
 * `updateCell` identifies the row by full-row equality on its pre-edit values,
 * which is what the webview sends, so the row values come from the grid read
 * rather than from the generator's idea of them -- the two differ by kind (a
 * CSV integer arrives as a BIGINT string) and only the grid's version is what
 * the real edit path uses.
 */
async function driveEdit(spec: RoundTripSpec, ctx: CaseContext, path: string): Promise<void> {
  const before = await readFile(path);
  const untouchedBefore = await spec.untouched?.(path);

  let file = await DuckDbFile.open(path);
  let table: CanonicalTable;
  let name: string;
  try {
    name = await firstTable(file);
    table = await readTable(file, name);
    const colIndex = table.columns.indexOf(spec.edit.column);
    if (colIndex < 0) {
      ctx.fail('crash', `the fixture has no column "${spec.edit.column}"; it has [${table.columns.join(', ')}]`);
      return;
    }
    const rowValues: Record<string, unknown> = {};
    table.columns.forEach((c, i) => {
      rowValues[c] = table.rows[spec.edit.row][i];
    });

    const changed = await file.updateCell(name, spec.edit.column, spec.edit.value, rowValues);
    if (changed !== 1) {
      ctx.fail('lost-edit', `updateCell reported ${changed} row(s) changed, expected exactly 1`);
      return;
    }
  } finally {
    file.dispose();
  }

  // The real question: what is in the file now.
  const reopened = await DuckDbFile.open(path);
  try {
    const after = await readTable(reopened, name);

    if (!sameNames(table.columns, after.columns)) {
      ctx.fail(
        'silent-corruption',
        `columns changed: [${table.columns.join(', ')}] -> [${after.columns.join(', ')}]`
      );
      return;
    }
    if (after.rows.length !== table.rows.length) {
      ctx.fail(
        'silent-corruption',
        `row count changed: ${table.rows.length} -> ${after.rows.length}`
      );
      return;
    }

    const colIndex = table.columns.indexOf(spec.edit.column);
    const landed = after.rows[spec.edit.row][colIndex];
    if (!looksSame(landed, spec.edit.value)) {
      ctx.fail(
        'lost-edit',
        `wrote ${JSON.stringify(spec.edit.value)} to row ${spec.edit.row} "${spec.edit.column}", ` +
          `read back ${JSON.stringify(landed)}`
      );
    }

    // Everything that was NOT the edit.
    for (let r = 0; r < table.rows.length; r++) {
      for (let c = 0; c < table.columns.length; c++) {
        if (r === spec.edit.row && c === colIndex) continue;
        if (!looksSame(table.rows[r][c], after.rows[r][c])) {
          ctx.fail(
            'silent-corruption',
            `row ${r} "${table.columns[c]}" was not edited but changed: ` +
              `${JSON.stringify(table.rows[r][c])} -> ${JSON.stringify(after.rows[r][c])}`
          );
        }
      }
    }
  } finally {
    reopened.dispose();
  }

  if (untouchedBefore) {
    const untouchedAfter = await spec.untouched!(path);
    for (const [part, bytes] of Object.entries(untouchedBefore)) {
      if (untouchedAfter[part] === undefined) {
        ctx.fail('silent-corruption', `${part} was removed from the file by the edit`);
      } else if (untouchedAfter[part] !== bytes) {
        ctx.fail('silent-corruption', `${part} was rewritten by an edit that did not target it`);
      }
    }
  }

  if (spec.fileMustChange !== false && before.equals(await readFile(path))) {
    ctx.fail('lost-edit', 'the file on disk is byte-identical to before the edit');
  }
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Loose enough for the legitimate per-kind type drift, tight enough to catch corruption. */
function looksSame(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && String(a) !== '' && String(b) !== '') {
    // Compared as text first so a BIGINT past 2^53 is not rounded into equality.
    if (String(a) === String(b)) return true;
    return na === nb;
  }
  return String(a) === String(b);
}

/** Every part of an .xlsx except the sheet being edited. */
function xlsxPartsExcept(sheetPart: string) {
  return async (path: string): Promise<Record<string, string>> => {
    const zip = unzipSync(new Uint8Array(await readFile(path)));
    const out: Record<string, string> = {};
    for (const [name, bytes] of Object.entries(zip)) {
      if (name === sheetPart) continue;
      out[name] = Buffer.from(bytes).toString('base64');
    }
    return out;
  };
}

const SPECS: RoundTripSpec[] = [
  {
    kind: 'duckdb',
    build: (dir) => w.duckdbFile(join(dir, 'rt.duckdb'), [BASE]),
    edit: { row: 1, column: 'label', value: 'EDITED' },
    fileMustChange: false,
    note: 'a string cell in a .duckdb table',
  },
  {
    kind: 'sqlite',
    build: (dir) => w.sqliteFile(join(dir, 'rt.sqlite'), [BASE]),
    edit: { row: 2, column: 'label', value: 'EDITED' },
    fileMustChange: false,
    note: 'a string cell in a .sqlite table',
  },
  {
    kind: 'parquet',
    build: (dir) => w.parquetFile(join(dir, 'rt.parquet'), BASE),
    edit: { row: 0, column: 'amount', value: 99.25 },
    note: 'a numeric cell in a .parquet file, which is rewritten wholesale on save',
  },
  {
    kind: 'csv',
    build: (dir) => w.csvFile(join(dir, 'rt.csv'), BASE),
    edit: { row: 3, column: 'label', value: 'EDITED' },
    note: 'the last row of a .csv, the row most likely to be lost to an off-by-one',
  },
  {
    kind: 'arrows',
    build: (dir) => w.arrowStreamFile(join(dir, 'rt.arrows'), ARROW_COLUMNS),
    edit: { row: 1, column: 'label', value: 'EDITED' },
    note: 'an Arrow IPC stream',
  },
  {
    kind: 'feather',
    build: (dir) => w.featherFile(join(dir, 'rt.feather'), ARROW_COLUMNS),
    edit: { row: 2, column: 'label', value: 'EDITED' },
    note: 'a Feather file, which must still be Feather afterwards and not a stream',
  },
  {
    kind: 'feather-multibatch',
    build: (dir) => w.featherFile(join(dir, 'rt-mb.feather'), ARROW_COLUMNS, 2),
    edit: { row: 3, column: 'label', value: 'EDITED' },
    note: 'a multi-batch Feather file edited in its second batch',
  },
  {
    kind: 'xlsx',
    build: (dir) =>
      w.xlsxFile(join(dir, 'rt.xlsx'), [
        {
          name: 'data',
          leadingBlankColumns: 1,
          styles: { '2-1': 7 },
          formulas: { '3-2': '=C3*2' },
          rows: w.withNotes(
            ['id', 'label', 'amount'],
            [
              [1, 'alpha', 1.5],
              [2, 'beta', 2.5],
              [3, 'gamma', 3.5],
              [4, 'delta', 4.5],
            ],
            // Notes BELOW only. A title row above the header is a separate
            // shape with a separate outcome — see shapes_xlsx_title_row_above,
            // which pins what actually happens to it.
            { below: [['Source: internal']] }
          ),
        },
        { name: 'keep', rows: [['do not touch me']] },
      ]),
    edit: { row: 1, column: 'label', value: 'EDITED' },
    // Every other part of the package, compared byte for byte: the second
    // sheet, the workbook, the rels, the content types. This is the assertion
    // that distinguishes a surgical patch from a rewrite that happens to
    // preserve the values.
    untouched: xlsxPartsExcept('xl/worksheets/sheet1.xml'),
    note: 'a workbook with a blank first column, notes above and below, a formula and a style',
  },
];

for (const spec of SPECS) {
  registerCase({
    name: `roundtrip_${spec.kind}`,
    family: 'roundtrip',
    expect: { note: spec.note, knownBug: spec.knownBug },
    build: async (ctx) => ({ path: await spec.build(ctx.dir) }),
    check: async (_file, ctx, built) => {
      // The file the runner opened is disposed by driveEdit's own handles; the
      // runner's guarded dispose tolerates the double close.
      _file.dispose();
      await driveEdit(spec, ctx, built.path);
    },
  });
}

/**
 * Saving without editing anything must not rewrite the file.
 *
 * A no-op save that rewrites is not merely wasteful: for .xlsx and .feather it
 * means every untouched formula, style and encoding choice is now whatever the
 * writer happened to emit, and the user was never told their file changed.
 */
registerCase({
  name: 'roundtrip_no_edit_is_a_no_op',
  family: 'roundtrip',
  expect: { note: 'opening and closing a workbook without editing must leave it byte-identical' },
  build: async (ctx) => ({
    path: await w.xlsxFile(join(ctx.dir, 'untouched.xlsx'), [
      { name: 'data', rows: [['id', 'label'], [1, 'alpha']] },
    ]),
  }),
  check: async (file, ctx, built) => {
    const before = await readFile(built.path);
    await file.runQuery('select * from "data"');
    file.dispose();
    if (!before.equals(await readFile(built.path))) {
      ctx.fail('silent-corruption', 'reading a workbook rewrote it on disk');
    }
  },
});

/**
 * An edit whose new value contains the characters that break naive SQL and
 * naive XML. Both writers interpolate: one into SQL, one into a worksheet.
 */
registerCase({
  name: 'roundtrip_hostile_value_text',
  family: 'roundtrip',
  expect: { note: `an edit to a value holding ' " & < > and a newline` },
  build: async (ctx) => ({
    path: await w.duckdbFile(join(ctx.dir, 'hostile.duckdb'), [BASE]),
  }),
  check: async (file, ctx, built) => {
    file.dispose();
    await driveEdit(
      {
        kind: 'duckdb',
        build: async () => built.path,
        edit: { row: 0, column: 'label', value: `O'Brien & <Sons> "Ltd"\nsecond line` },
        fileMustChange: false,
        note: '',
      },
      ctx,
      built.path
    );
  },
});

/**
 * A BIGINT past 2^53 in the row that identifies the edit.
 *
 * The grid receives such a value as a decimal STRING (getRowsJson renders
 * BIGINT that way), and updateCell hands it straight back into a WHERE clause
 * against a BIGINT column. Verified to work, and pinned here because the thing
 * that makes it work -- DuckDB coercing the string -- is invisible in the code
 * and would be easy to break by "helpfully" parsing the value first.
 */
registerCase({
  name: 'roundtrip_bigint_row_identity',
  family: 'roundtrip',
  expect: { note: 'a row keyed by an integer too large for a JS number is still matchable' },
  build: async (ctx) => ({
    path: await w.duckdbFile(join(ctx.dir, 'bigint.duckdb'), [
      {
        name: 'data',
        columns: [
          { name: 'id', type: 'BIGINT' },
          { name: 'label', type: 'VARCHAR' },
        ],
        rows: [
          [9007199254740993n, 'first'],
          [9007199254740992n, 'second'],
        ],
      },
    ]),
  }),
  check: async (file, ctx, built) => {
    const table = await readTable(file, 'data');
    if (table.rows[0][0] !== '9007199254740993') {
      ctx.fail(
        'silent-misread',
        `9007199254740993 reached the grid as ${JSON.stringify(table.rows[0][0])}; ` +
          `if that is a rounded number the two rows are now indistinguishable`
      );
    }
    const changed = await file.updateCell('data', 'label', 'EDITED', {
      id: table.rows[0][0],
      label: table.rows[0][1],
    });
    if (changed !== 1) {
      ctx.fail('lost-edit', `matching on a large BIGINT changed ${changed} rows, expected 1`);
    }
    const after = await readTable(file, 'data');
    if (after.rows[1][1] !== 'second') {
      ctx.fail('silent-corruption', 'the edit landed on the neighbouring row as well');
    }
  },
});
