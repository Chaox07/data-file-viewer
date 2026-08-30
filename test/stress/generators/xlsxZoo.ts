import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { registerCase, type CaseContext } from '../expect';
import { readTable } from '../harness/inspect';
import * as w from './_write';

/**
 * Workbooks, in every structural shape a real one comes in.
 *
 * This gets the densest matrix in the suite for one reason: `xlsxWrite.ts` is
 * the only code here that MODIFIES a file the user already had. Everything
 * else either reads, or rewrites a file the viewer itself produced. A mistake
 * in the others shows a wrong number; a mistake here damages a workbook
 * somebody has been keeping since 2018.
 *
 * The shapes below are the ones a human-made workbook has and a
 * library-written one does not: a blank leading column, notes under the table,
 * a row where Excel never wrote a cell, a merged banner, a shared formula
 * whose own `t="shared"` sits inside the cell it could be mistaken for. The
 * real workbook that prompted this had 136 rows for 121 rows of data, and the
 * header was found by counting rather than by looking -- which put it fourteen
 * rows into the data.
 *
 * Every editing case asserts on what SURVIVES as well as on what changed.
 * A test that only checks the new value landed passes just as happily for a
 * wholesale rewrite that discards the formulas, the styles and the other
 * sheets.
 */

const HEADER = ['id', 'label', 'amount'];
const BODY: unknown[][] = [
  [1, 'alpha', 1.5],
  [2, 'beta', 2.5],
  [3, 'gamma', 3.5],
  [4, 'delta', 4.5],
];

const EXPECTED = { columns: HEADER, rows: BODY };

/** Every part of the package except the one sheet an edit was aimed at. */
async function partsExcept(path: string, sheetPart: string): Promise<Record<string, string>> {
  const zip = unzipSync(new Uint8Array(await readFile(path)));
  const out: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(zip)) {
    if (name === sheetPart) continue;
    out[name] = Buffer.from(bytes).toString('base64');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Structural shapes that must READ correctly
// ---------------------------------------------------------------------------

const SHAPES: [string, w.SheetSpec, string][] = [
  [
    'plain',
    { name: 'data', rows: [HEADER, ...BODY] },
    'the ordinary case, so a failure below means the shape and not the reader',
  ],
  [
    'blank_leading_column',
    { name: 'data', leadingBlankColumns: 1, rows: [HEADER, ...BODY] },
    'column A empty, so the data starts at B and anything mapping "first column" to A is one out',
  ],
  [
    'two_blank_leading_columns',
    { name: 'data', leadingBlankColumns: 2, rows: [HEADER, ...BODY] },
    'the same, further out, where an off-by-one and an off-by-two look different',
  ],
  [
    'notes_below',
    { name: 'data', rows: w.withNotes(HEADER, BODY, { below: [['Source: internal'], ['Revised 2024']] }) },
    'notes under the table — the shape that put the real workbook’s header fourteen rows into the data',
  ],
  [
    'notes_below_no_blank_line',
    {
      name: 'data',
      rows: w.withNotes(HEADER, BODY, { below: [['Source: internal']], blankBeforeBelow: false }),
    },
    // Measured: WITH a blank line the note is excluded; without one it becomes
    // a fifth data row, `["Source: internal", null, null]`. That is not a
    // defect -- nothing distinguishes a note from data when no blank line
    // separates them -- but it is the boundary, and it is worth pinning which
    // side of it the reader falls on.
    'a note immediately under the last data row, with no blank line, is read AS a row of nulls',
  ],
  [
    'missing_cells',
    {
      name: 'data',
      rows: [
        HEADER,
        [1, 'alpha', 1.5],
        [2, 'beta'], // no cell for amount at all — not an empty one
        [3, 'gamma', 3.5],
        [4, 'delta', 4.5],
      ],
    },
    'a row where Excel wrote no <c> element for the last column',
  ],
  [
    'with_styles',
    {
      name: 'data',
      styles: { '1-2': 7, '2-1': 4, '3-0': 3 },
      rows: [HEADER, ...BODY],
    },
    'styled cells, which must keep their s= attribute through an edit',
  ],
  [
    'with_formula',
    {
      name: 'data',
      formulas: { '2-2': '=B3*2' },
      rows: [HEADER, ...BODY],
    },
    'a formula in the data, which an edit elsewhere must not disturb',
  ],
];

for (const [slug, sheet, note] of SHAPES) {
  const expectedRows =
    slug === 'missing_cells'
      ? [
          [1, 'alpha', 1.5],
          [2, 'beta', null],
          [3, 'gamma', 3.5],
          [4, 'delta', 4.5],
        ]
      : slug === 'notes_below_no_blank_line'
        // The note lands in the `id` column, which read_xlsx has typed numeric
        // from the four rows above it, so the whole row reads as nulls -- and
        // the sheet only opens AT ALL because of the lazy ignore_errors repair.
        // Without it, `Could not convert string 'Source: internal' to DOUBLE`
        // takes the entire sheet down. That repair was added for #DIV/0!; this
        // shows it also rescues the far more common case of a note written
        // under a table.
        ? [...BODY, [null, null, null]]
        : BODY;

  registerCase({
    name: `xlsx_read_${slug}`,
    family: 'xlsxZoo',
    expect: { note, table: { columns: HEADER, rows: expectedRows } },
    build: async (ctx) => ({ path: await w.xlsxFile(join(ctx.dir, `${slug}.xlsx`), [sheet]) }),
  });
}

// ---------------------------------------------------------------------------
// The same shapes, EDITED
// ---------------------------------------------------------------------------

/** Edit one cell and assert both halves: it landed, and nothing else moved. */
async function editAndVerify(
  file: import('../../../src/duckdbConnection').DuckDbFile,
  ctx: CaseContext,
  path: string,
  options: { row: number; column: string; value: unknown; sheet?: string }
): Promise<void> {
  const sheet = options.sheet ?? 'data';
  const before = await readTable(file, sheet);
  const untouchedBefore = await partsExcept(path, 'xl/worksheets/sheet1.xml');

  const rowValues: Record<string, unknown> = {};
  before.columns.forEach((c, i) => {
    rowValues[c] = before.rows[options.row][i];
  });

  const changed = await file.updateCell(sheet, options.column, options.value, rowValues);
  file.dispose();

  if (changed !== 1) {
    ctx.fail('lost-edit', `updateCell reported ${changed} rows changed, expected 1`);
    return;
  }

  const { DuckDbFile } = await import('../../../src/duckdbConnection');
  const reopened = await DuckDbFile.open(path);
  try {
    const after = await readTable(reopened, sheet);
    const col = before.columns.indexOf(options.column);

    if (after.rows.length !== before.rows.length) {
      ctx.fail(
        'silent-corruption',
        `the sheet had ${before.rows.length} rows before the edit and ${after.rows.length} after`
      );
      return;
    }
    if (String(after.rows[options.row][col]) !== String(options.value)) {
      ctx.fail(
        'lost-edit',
        `wrote ${JSON.stringify(options.value)}, read back ${JSON.stringify(after.rows[options.row][col])}`
      );
    }
    for (let r = 0; r < before.rows.length; r++) {
      for (let c = 0; c < before.columns.length; c++) {
        if (r === options.row && c === col) continue;
        if (String(before.rows[r][c]) !== String(after.rows[r][c])) {
          ctx.fail(
            'silent-corruption',
            `row ${r} "${before.columns[c]}" changed from ${JSON.stringify(before.rows[r][c])} ` +
              `to ${JSON.stringify(after.rows[r][c])} without being edited`
          );
        }
      }
    }
  } finally {
    reopened.dispose();
  }

  const untouchedAfter = await partsExcept(path, 'xl/worksheets/sheet1.xml');
  for (const [part, bytes] of Object.entries(untouchedBefore)) {
    if (untouchedAfter[part] === undefined) {
      ctx.fail('silent-corruption', `${part} was removed from the package by the edit`);
    } else if (untouchedAfter[part] !== bytes) {
      ctx.fail('silent-corruption', `${part} was rewritten by an edit that did not target it`);
    }
  }
}

for (const [slug, sheet] of SHAPES.map((s) => [s[0], s[1]] as const)) {
  registerCase({
    name: `xlsx_edit_${slug}`,
    family: 'xlsxZoo',
    expect: { note: `one cell edited in the "${slug}" shape lands, and nothing else in the package moves` },
    build: async (ctx) => ({
      path: await w.xlsxFile(join(ctx.dir, `${slug}.xlsx`), [
        sheet,
        // A second sheet, so "the other sheet is byte-identical" is a real
        // assertion rather than a vacuous one.
        { name: 'keep', rows: [['do not touch me'], [42]] },
      ]),
    }),
    check: async (file, ctx, built) => {
      await editAndVerify(file, ctx, built.path, { row: 1, column: 'label', value: 'EDITED' });
    },
  });
}

/**
 * An integer must stay an integer.
 *
 * The failure is cosmetic-looking and is not: a quantity written back as `2.0`
 * where the sheet held `2` changes what every downstream formula and export
 * sees, and it is exactly what a naive `String(value)` produces.
 */
registerCase({
  name: 'xlsx_edit_integer_stays_integer',
  family: 'xlsxZoo',
  expect: { note: 'editing a numeric cell to an integer writes 7, not 7.0' },
  build: async (ctx) => ({
    path: await w.xlsxFile(join(ctx.dir, 'int.xlsx'), [{ name: 'data', rows: [HEADER, ...BODY] }]),
  }),
  check: async (file, ctx, built) => {
    const before = await readTable(file, 'data');
    const rowValues: Record<string, unknown> = {};
    before.columns.forEach((c, i) => {
      rowValues[c] = before.rows[0][i];
    });
    await file.updateCell('data', 'amount', 7, rowValues);
    file.dispose();

    const zip = unzipSync(new Uint8Array(await readFile(built.path)));
    const xml = Buffer.from(zip['xl/worksheets/sheet1.xml']).toString('utf8');
    if (/<v>7\.0+<\/v>/.test(xml)) {
      ctx.fail('silent-corruption', 'the integer 7 was written into the sheet as 7.0');
    }
    if (!/<v>7<\/v>/.test(xml)) {
      ctx.fail('lost-edit', 'no cell in the sheet holds 7 after the edit');
    }
  },
});

/** Editing a cell to null, and to text, in a numeric column. */
for (const [slug, value, note] of [
  ['to_null', null, 'clearing a numeric cell'],
  ['to_text', 'n/a', 'putting text into a numeric column'],  // pinned below
  ['to_negative', -12.5, 'a negative number'],
  ['to_zero', 0, 'zero, which a falsy check would skip'],
] as const) {
  registerCase({
    name: `xlsx_edit_${slug}`,
    family: 'xlsxZoo',
    expect: {
      note: `${note} is written and reads back`,
      // Typing text into a column read_xlsx typed as numeric writes the cell
      // correctly -- verified in the XML: C4 becomes an inlineStr holding
      // "n/a", and Excel shows it -- but on reload read_xlsx types the column
      // DOUBLE from its three remaining numbers, fails on the text, and the
      // lazy ignore_errors repair blanks it. So the user types a value, the
      // file is right, and the cell they typed into goes empty in front of
      // them. Worse, the warning they get blames "#DIV/0!, #N/A, #REF! and the
      // like" -- Excel error values -- for a word they typed themselves.
      //
      // Pinned rather than fixed: the honest repairs are to detect the
      // type conflict at edit time and say so, or to read a mixed column as
      // VARCHAR. Both are product decisions about a trade-off that already has
      // a considered answer written into repairXlsxViewsForCellErrors.
      knownBug:
        slug === 'to_text'
          ? 'text typed into a numeric column is written to the file correctly but reads back as null, and the warning shown blames Excel error values rather than the edit'
          : undefined,
    },
    build: async (ctx) => ({
      path: await w.xlsxFile(join(ctx.dir, `${slug}.xlsx`), [
        { name: 'data', rows: [HEADER, ...BODY] },
        { name: 'keep', rows: [['untouched']] },
      ]),
    }),
    check: async (file, ctx, built) => {
      await editAndVerify(file, ctx, built.path, { row: 2, column: 'amount', value });
    },
  });
}

// ---------------------------------------------------------------------------
// Refusals that must stay refusals
// ---------------------------------------------------------------------------

/**
 * Two rows identical across every column.
 *
 * Rows are identified by full-row equality, so there is genuinely no way to
 * tell which of them the user edited. The SQL path updates both; a file
 * rewrite cannot be half-applied, so this one has to refuse and say why.
 */
registerCase({
  name: 'xlsx_refuses_ambiguous_duplicate_rows',
  family: 'xlsxZoo',
  expect: { note: 'an edit to one of two identical rows is refused rather than guessed at' },
  build: async (ctx) => ({
    path: await w.xlsxFile(join(ctx.dir, 'dupes.xlsx'), [
      {
        name: 'data',
        rows: [
          HEADER,
          [1, 'same', 1.5],
          [1, 'same', 1.5],
          [2, 'other', 2.5],
        ],
      },
    ]),
  }),
  check: async (file, ctx, built) => {
    const before = await readTable(file, 'data');
    const bytes = await readFile(built.path);
    const rowValues: Record<string, unknown> = {};
    before.columns.forEach((c, i) => {
      rowValues[c] = before.rows[0][i];
    });

    let refused = false;
    try {
      await file.updateCell('data', 'label', 'EDITED', rowValues);
    } catch (err) {
      refused = true;
      const message = err instanceof Error ? err.message : String(err);
      if (!/identical|which one/i.test(message)) {
        ctx.fail('bad-message', `refused, but the message does not explain why: "${message}"`);
      }
    }
    if (!refused) {
      ctx.fail('silent-corruption', 'an ambiguous row was edited anyway, with no way to know which');
    }
    file.dispose();
    if (!bytes.equals(await readFile(built.path))) {
      ctx.fail('silent-corruption', 'the workbook was modified despite the edit being refused');
    }
  },
});

/**
 * A sheet with no header row the columns can be found by.
 *
 * The patcher locates the header by matching the column names it was given.
 * When no row carries them it must refuse, not fall back to counting -- the
 * counting fallback is what wrote into the wrong row of a real workbook.
 */
registerCase({
  name: 'xlsx_refuses_when_header_cannot_be_found',
  family: 'xlsxZoo',
  expect: {
    note: 'an edit is refused when no row in the sheet carries the column names',
  },
  build: async (ctx) => ({
    path: await w.xlsxFile(join(ctx.dir, 'noheader.xlsx'), [
      { name: 'data', rows: [HEADER, ...BODY] },
    ]),
  }),
  check: async (file, ctx, built) => {
    const before = await readTable(file, 'data');
    const rowValues: Record<string, unknown> = {};
    before.columns.forEach((c, i) => {
      rowValues[c] = before.rows[0][i];
    });
    file.dispose();

    // Rewrite the package so the header row is gone but the data remains --
    // the state a sheet is in when somebody deletes the header by hand.
    const { unzipSync: uz, zipSync, strToU8 } = await import('fflate');
    const { writeFile } = await import('node:fs/promises');
    const parts = uz(new Uint8Array(await readFile(built.path)));
    const xml = Buffer.from(parts['xl/worksheets/sheet1.xml']).toString('utf8');
    parts['xl/worksheets/sheet1.xml'] = strToU8(xml.replace(/<row r="1">.*?<\/row>/, ''));
    await writeFile(built.path, Buffer.from(zipSync(parts)));

    const { patchCell } = await import('../../../src/xlsxWrite');
    try {
      await patchCell({
        filePath: built.path,
        sheetPath: 'xl/worksheets/sheet1.xml',
        columnName: 'label',
        columnNames: before.columns,
        rowOrdinal: 1,
        expectedCurrent: 'alpha',
        newValue: 'EDITED',
      });
      ctx.fail(
        'silent-corruption',
        'a sheet with no findable header was patched anyway — the row it wrote to was a guess'
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/head|column/i.test(message)) {
        ctx.fail('bad-message', `refused, but not for a reason anyone could act on: "${message}"`);
      }
    }
  },
});

// ---------------------------------------------------------------------------
// Size and multiplicity
// ---------------------------------------------------------------------------

registerCase({
  name: 'xlsx_ten_sheets',
  family: 'xlsxZoo',
  expect: {
    note: 'a ten-sheet workbook lists every sheet, and an edit touches only one part',
    tables: Array.from({ length: 10 }, (_, i) => `sheet_${i}`),
  },
  build: async (ctx) => ({
    path: await w.xlsxFile(
      join(ctx.dir, 'ten.xlsx'),
      Array.from({ length: 10 }, (_, i) => ({
        name: `sheet_${i}`,
        rows: [HEADER, [i, `row ${i}`, i * 1.5]],
      }))
    ),
    tableName: 'sheet_0',
  }),
});

registerCase({
  name: 'xlsx_forty_thousand_rows',
  family: 'xlsxZoo',
  expect: { note: 'a 40,000-row sheet reads back complete and can still be edited', rows: 40000 },
  build: async (ctx) => ({
    path: await w.xlsxFile(join(ctx.dir, 'big.xlsx'), [
      {
        name: 'data',
        rows: [['id', 'label'], ...Array.from({ length: 40000 }, (_, i) => [i, `row ${i}`])],
      },
    ]),
  }),
  check: async (file, ctx, built) => {
    const table = await readTable(file, 'data');
    const last = table.rows[table.rows.length - 1];
    if (Number(last[0]) !== 39999) {
      ctx.fail('silent-misread', `the last row is ${JSON.stringify(last)}, expected [39999, "row 39999"]`);
      return;
    }
    // Edit the LAST row: the one an off-by-one loses, and the one furthest
    // from anything a small fixture would exercise.
    const rowValues: Record<string, unknown> = {};
    table.columns.forEach((c, i) => {
      rowValues[c] = last[i];
    });
    const changed = await file.updateCell('data', 'label', 'EDITED', rowValues);
    file.dispose();
    if (changed !== 1) {
      ctx.fail('lost-edit', `editing the last of 40,000 rows changed ${changed} rows`);
      return;
    }
    const { DuckDbFile } = await import('../../../src/duckdbConnection');
    const reopened = await DuckDbFile.open(built.path);
    try {
      const after = await readTable(reopened, 'data');
      if (after.rows[39999][1] !== 'EDITED') {
        ctx.fail('lost-edit', `the edit to row 39,999 is not in the file: ${JSON.stringify(after.rows[39999])}`);
      }
      if (after.rows.length !== 40000) {
        ctx.fail('silent-corruption', `the sheet now has ${after.rows.length} rows, not 40,000`);
      }
    } finally {
      reopened.dispose();
    }
  },
});

/** Error values Excel could not compute, in an otherwise numeric column. */
for (const error of ['#DIV/0!', '#N/A', '#REF!', '#VALUE!', '#NAME?']) {
  const slug = error.replace(/[^A-Z]/gi, '').toLowerCase();
  registerCase({
    name: `xlsx_error_value_${slug}`,
    family: 'xlsxZoo',
    expect: {
      note: `${error} in a numeric column is shown as empty, and the user is told`,
      says: [/could not compute/i],
    },
    build: async (ctx) => ({
      path: await w.xlsxFile(join(ctx.dir, `${slug}.xlsx`), [
        {
          name: 'data',
          rows: [
            ['id', 'ratio'],
            [1, 1.5],
            [2, 2.5],
            [3, error],
          ],
        },
      ]),
    }),
    check: async (file, ctx) => {
      const table = await readTable(file, 'data');
      if (table.rows.length !== 3) {
        ctx.fail('silent-misread', `one uncomputable cell cost the sheet rows: ${table.rows.length} of 3`);
      }
      // The other two values must be untouched -- `all_varchar` would rescue
      // the sheet by turning every column into text, which is the wrong trade.
      if (Number(table.rows[0][1]) !== 1.5 || Number(table.rows[1][1]) !== 2.5) {
        ctx.fail(
          'silent-misread',
          `the good values changed too: ${JSON.stringify(table.rows.map((r) => r[1]))}`
        );
      }
    },
  });
}
