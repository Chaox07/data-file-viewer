import { join } from 'node:path';
import { registerCase } from '../expect';
import { firstTable, quote, readTable } from '../harness/inspect';
import * as w from './_write';

/**
 * Table, column and sheet names that are hostile to the code that
 * interpolates them.
 *
 * Every one of these names is legal. DuckDB, SQLite, Parquet and Excel all
 * permit a quote or a semicolon in an identifier, and real files carry them --
 * a sheet called `O'Brien's Data` is the example already written into
 * duckdbConnection.ts's own comments, where nothing exercised it.
 *
 * There are four separate escapes in play and they are not interchangeable:
 *
 *   quoteIdent      "  -> ""       for a SQL identifier
 *   quoteLiteral    '  -> ''       for a SQL string
 *   read_xlsx       the sheet NAME is a literal, the VIEW name an identifier
 *                   -- the same string, escaped two different ways, in one
 *                   statement
 *   xlsxWrite       the name is matched against XML text, entity-decoded
 *
 * Mixing two of them up does not usually produce a syntax error. It produces a
 * statement that runs against the wrong object, or a WHERE clause that matches
 * a different row -- which is why these sit under `identifiers` rather than
 * under a "does it crash" family. The assertion throughout is that the name
 * survives ROUND TRIP: it is listed as written, selectable by that name, and
 * usable to identify a row for an edit.
 */

const NASTY_NAMES: [string, string][] = [
  ['double_quote', 'say "hello"'],
  ['single_quote', "O'Brien's Data"],
  ['both_quotes', `mixed "and" O'Brien`],
  ['semicolon', 'total; drop table t'],
  ['line_comment', 'rate -- per cent'],
  ['block_comment', 'rate /* note */ pct'],
  ['backtick', 'weird `backtick` name'],
  ['newline', 'two\nlines'],
  ['leading_space', '  padded  '],
  ['unicode_turkish', 'İstanbul ısı'],
  ['unicode_rtl', 'مرحبا bidi'],
  ['emoji', 'growth 📈'],
  ['sql_keyword', 'select'],
  ['write_keyword', 'update'],
  ['numeric_looking', '2024'],
  ['long_name', `col_${'x'.repeat(280)}`],
];

/**
 * A hostile COLUMN name, in a kind that stores names verbatim.
 *
 * Parquet is used rather than CSV because a CSV header goes through the
 * sniffer, which has its own opinions about quoting -- that is a separate
 * question, asked further down.
 */
for (const [slug, name] of NASTY_NAMES) {
  registerCase({
    name: `identifiers_column_${slug}`,
    family: 'identifiers',
    expect: {
      note: `a column named ${JSON.stringify(name)} survives to the grid and back`,
      table: { columns: ['id', name], rows: [[1, 'alpha']] },
    },
    build: async (ctx) => ({
      path: await w.parquetFile(join(ctx.dir, 'col.parquet'), {
        name: 'cols',
        columns: [
          { name: 'id', type: 'INTEGER' },
          { name, type: 'VARCHAR' },
        ],
        rows: [[1, 'alpha']],
      }),
    }),
    check: async (file, ctx) => {
      // Selectable by name, not merely listed. A name that survives listing but
      // breaks in a WHERE is the failure worth catching, because that is the
      // one that only shows up when somebody sorts or filters on the column.
      const table = await firstTable(file);
      const result = await file.runQuery(
        `select ${quote(name)} from ${quote(table)} where ${quote(name)} is not null`
      );
      if (result.rows.length !== 1) {
        ctx.fail('crash', `selecting the column by name returned ${result.rows.length} rows, expected 1`);
      }
    },
  });
}

/** A hostile TABLE name inside a .duckdb database. */
for (const [slug, name] of NASTY_NAMES) {
  registerCase({
    name: `identifiers_table_${slug}`,
    family: 'identifiers',
    expect: {
      note: `a table named ${JSON.stringify(name)} is listed and selectable under that name`,
      tables: [name],
    },
    build: async (ctx) => ({
      path: await w.duckdbFile(join(ctx.dir, 'tbl.duckdb'), [
        {
          name,
          columns: [
            { name: 'id', type: 'INTEGER' },
            { name: 'label', type: 'VARCHAR' },
          ],
          rows: [[1, 'alpha']],
        },
      ]),
      tableName: name,
    }),
  });
}

/**
 * A hostile SHEET name in a workbook.
 *
 * This is the sharpest of the three, because read_xlsx addresses the sheet by
 * NAME as a string literal while the view it creates is a quoted identifier --
 * the same characters, escaped two different ways, in one statement. Excel
 * forbids : \ / ? * [ ] in sheet names and caps them at 31 characters, so the
 * names here stay inside what a real workbook can actually contain.
 */
const SHEET_NAMES: [string, string][] = [
  ['single_quote', "O'Brien"],
  ['double_quote', 'say "hi"'],
  ['semicolon', 'a; drop'],
  ['space', 'my sheet'],
  ['unicode', 'İstanbul'],
  ['dash_comment', 'rate -- pct'],
  ['at_31_chars', 'sheet_name_exactly_31_chars_ok!'],
];

for (const [slug, name] of SHEET_NAMES) {
  registerCase({
    name: `identifiers_sheet_${slug}`,
    family: 'identifiers',
    expect: {
      note: `a sheet named ${JSON.stringify(name)} opens and reads`,
      tables: [name],
      table: { columns: ['id', 'label'], rows: [[1, 'alpha']] },
    },
    build: async (ctx) => ({
      path: await w.xlsxFile(join(ctx.dir, 'sheet.xlsx'), [
        { name, rows: [['id', 'label'], [1, 'alpha']] },
      ]),
      tableName: name,
    }),
  });
}

/**
 * An edit on a table whose columns are all hostile.
 *
 * updateCell builds a WHERE clause naming EVERY column in the row, so a table
 * like this puts all of them through quoteIdent at once -- and then the xlsx
 * path takes the same names and matches them against worksheet XML, where they
 * arrive entity-encoded. `say "hello"` is stored in the sheet as
 * `say &quot;hello&quot;`, so a header lookup comparing raw strings finds
 * nothing and the edit is refused on a workbook that is perfectly fine.
 */
registerCase({
  name: 'identifiers_edit_with_hostile_columns',
  family: 'identifiers',
  expect: { note: 'a row whose every column name is hostile can still be edited' },
  build: async (ctx) => ({
    path: await w.duckdbFile(join(ctx.dir, 'edit.duckdb'), [
      {
        name: "O'Brien's Data",
        columns: [
          { name: 'say "hello"', type: 'INTEGER' },
          { name: "it's here", type: 'VARCHAR' },
          { name: 'a; drop table t', type: 'VARCHAR' },
        ],
        rows: [
          [1, 'first', 'x'],
          [2, 'second', 'y'],
        ],
      },
    ]),
    tableName: "O'Brien's Data",
  }),
  check: async (file, ctx) => {
    const name = "O'Brien's Data";
    const table = await readTable(file, name);
    const rowValues: Record<string, unknown> = {};
    table.columns.forEach((c, i) => {
      rowValues[c] = table.rows[0][i];
    });
    const changed = await file.updateCell(name, "it's here", 'EDITED', rowValues);
    if (changed !== 1) {
      ctx.fail('lost-edit', `editing through hostile column names changed ${changed} rows, expected 1`);
      return;
    }
    const after = await readTable(file, name);
    if (after.rows[0][1] !== 'EDITED') {
      ctx.fail('lost-edit', `the edit did not land: row 0 reads ${JSON.stringify(after.rows[0][1])}`);
    }
    if (after.rows[1][1] !== 'second') {
      ctx.fail('silent-corruption', 'the edit also changed the row it was not aimed at');
    }
  },
});

/** The same edit, in a workbook, where the names also pass through XML entities. */
registerCase({
  name: 'identifiers_xlsx_edit_with_encoded_header',
  family: 'identifiers',
  expect: {
    note: 'a workbook column whose header contains " and & is still editable',
  },
  build: async (ctx) => ({
    path: await w.xlsxFile(join(ctx.dir, 'entities.xlsx'), [
      {
        name: 'data',
        rows: [
          ['id', 'say "hello"', 'Jones & Co'],
          [1, 'first', 'x'],
          [2, 'second', 'y'],
        ],
      },
    ]),
  }),
  check: async (file, ctx) => {
    const table = await readTable(file, 'data');
    if (!table.columns.includes('say "hello"')) {
      ctx.fail(
        'silent-misread',
        `the header came back entity-encoded rather than decoded: [${table.columns.join(', ')}]`
      );
      return;
    }
    const rowValues: Record<string, unknown> = {};
    table.columns.forEach((c, i) => {
      rowValues[c] = table.rows[0][i];
    });
    try {
      const changed = await file.updateCell('data', 'say "hello"', 'EDITED', rowValues);
      if (changed !== 1) {
        ctx.fail('lost-edit', `the edit changed ${changed} rows, expected 1`);
      }
    } catch (err) {
      ctx.fail(
        'lost-edit',
        `editing a column whose header holds an XML entity was refused: ${
          err instanceof Error ? err.message.split('\n')[0] : String(err)
        }`
      );
    }
  },
});

/**
 * Columns that differ only in case, above and below the ASCII boundary.
 *
 * DuckDB folds identifier case, but only over ASCII -- measured, not assumed:
 * `Rate`/`rate` and `I`/`i` collide outright ("Column with name I already
 * exists"), while `Ä`/`ä`, `İ`/`I` and `ı`/`I` stay distinct columns.
 *
 * So the collision rule depends on the alphabet the names are written in, and
 * this user's columns are Turkish. The pair that bites is `I`/`ı`: an
 * ASCII-lowercasing comparison anywhere in the viewer's own code -- a header
 * lookup, a "did the columns change" diff, a chart's axis match -- folds them
 * together where DuckDB keeps them apart, and the two disagree about which
 * column is which.
 *
 * `Rate`/`rate` is deliberately absent: DuckDB cannot hold such a table at all,
 * so there is nothing to assert. What is asserted is that everything DuckDB
 * DOES keep distinct stays distinct all the way to the grid, and that each name
 * selects its own value rather than its neighbour's.
 */
registerCase({
  name: 'identifiers_case_folding_boundary',
  family: 'identifiers',
  expect: {
    note: 'columns differing only by non-ASCII case stay distinct and select their own values',
    hasColumns: ['İ', 'ı', 'I', 'Ä', 'ä'],
  },
  build: async (ctx) => ({
    path: await w.parquetFile(join(ctx.dir, 'collide.parquet'), {
      name: 'collide',
      columns: [
        { name: 'İ', type: 'INTEGER' },
        { name: 'ı', type: 'INTEGER' },
        { name: 'I', type: 'INTEGER' },
        { name: 'Ä', type: 'INTEGER' },
        { name: 'ä', type: 'INTEGER' },
      ],
      rows: [[1, 2, 3, 4, 5]],
    }),
  }),
  check: async (file, ctx) => {
    const table = await readTable(file);
    if (new Set(table.columns).size !== table.columns.length) {
      ctx.fail('silent-misread', `columns collapsed into duplicates: [${table.columns.join(', ')}]`);
    }
    const name = await firstTable(file);
    for (const [column, expected] of [
      ['İ', 1],
      ['ı', 2],
      ['I', 3],
      ['Ä', 4],
      ['ä', 5],
    ] as const) {
      const r = await file.runQuery(`select ${quote(column)} from ${quote(name)}`);
      if (Number(r.rows[0]?.[0]) !== expected) {
        ctx.fail(
          'silent-misread',
          `selecting "${column}" returned ${JSON.stringify(r.rows[0]?.[0])}, expected ${expected} — ` +
            `two columns differing only by case are being confused for one another`
        );
      }
    }
  },
});
