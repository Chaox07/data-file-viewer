import { join } from 'node:path';
import { registerCase } from '../expect';
import { readTable } from '../harness/inspect';
import * as w from './_write';

/**
 * Hostile data shapes and hostile values, against every kind that can hold
 * them.
 *
 * The invariant for every case here is the same and it is deliberately narrow:
 * the value the writer put in is the value the grid shows, or the file is
 * refused with a message naming the reason. Never a third outcome -- and the
 * third outcome is the one that matters, because "opened fine, showed a number
 * that is not the number" is invisible from the inside.
 *
 * Values are declared in getRowsJson() space; see harness/inspect.ts for what
 * DuckDB actually does to each type on the way out. The comparator tolerates an
 * integer arriving as `1` from one kind and `"1"` from another, because both
 * render identically in the grid, but it compares big values as text so that
 * tolerance never re-introduces the 2^53 rounding it exists to detect.
 */

// ---------------------------------------------------------------------------
// Degenerate table shapes, across kinds
// ---------------------------------------------------------------------------

const KINDS: [string, (dir: string, spec: w.TableSpec) => Promise<string>][] = [
  ['duckdb', (dir, spec) => w.duckdbFile(join(dir, 'x.duckdb'), [spec])],
  ['parquet', (dir, spec) => w.parquetFile(join(dir, 'x.parquet'), spec)],
  ['csv', (dir, spec) => w.csvFile(join(dir, 'x.csv'), spec)],
  ['sqlite', (dir, spec) => w.sqliteFile(join(dir, 'x.sqlite'), [spec])],
];

const SIMPLE_COLUMNS: w.ColumnSpec[] = [
  { name: 'id', type: 'INTEGER' },
  { name: 'label', type: 'VARCHAR' },
];

const DEGENERATE: [string, w.TableSpec, number, string][] = [
  [
    'zero_rows',
    { name: 'data', columns: SIMPLE_COLUMNS, rows: [] },
    0,
    'a table with no rows must read as empty, not as damaged',
  ],
  [
    'one_row',
    { name: 'data', columns: SIMPLE_COLUMNS, rows: [[1, 'only']] },
    1,
    'a single-row table — the shape where an off-by-one is invisible',
  ],
  [
    'all_null_column',
    {
      name: 'data',
      columns: SIMPLE_COLUMNS,
      rows: [
        [1, null],
        [2, null],
        [3, null],
      ],
    },
    3,
    'a column that is null in every row must keep its column, not vanish',
  ],
  [
    'null_except_last',
    {
      name: 'data',
      columns: SIMPLE_COLUMNS,
      rows: [
        [1, null],
        [2, null],
        [3, 'here'],
      ],
    },
    3,
    'a column null everywhere but the last row — type sniffing that samples the head gets this wrong',
  ],
];

for (const [shapeName, spec, rows, note] of DEGENERATE) {
  for (const [kind, build] of KINDS) {
    registerCase({
      name: `shapes_${shapeName}_${kind}`,
      family: 'shapes',
      expect: { note: `${note} (${kind})`, rows, table: { columns: ['id', 'label'], rows: spec.rows } },
      build: async (ctx) => ({ path: await build(ctx.dir, spec) }),
    });
  }
}

/**
 * A thousand columns.
 *
 * Declared programmatically rather than by hand, which is the point of a
 * generated corpus: nobody writes this fixture, so nobody's assumptions are
 * baked into it.
 */
registerCase({
  name: 'shapes_thousand_columns',
  family: 'shapes',
  expect: { note: 'a 1,000-column table must keep all 1,000 columns and their order' },
  build: async (ctx) => {
    const columns = Array.from({ length: 1000 }, (_, i) => ({ name: `c${i}`, type: 'INTEGER' }));
    const rows = [Array.from({ length: 1000 }, (_, i) => i)];
    const spec: w.TableSpec = { name: 'wide', columns, rows };
    return {
      path: await w.parquetFile(join(ctx.dir, 'wide.parquet'), spec),
      table: { columns: columns.map((c) => c.name), rows },
    };
  },
});

/** Forty thousand rows, to hold the row-count and last-row properties at size. */
registerCase({
  name: 'shapes_forty_thousand_rows',
  family: 'shapes',
  expect: { note: 'a 40,000-row table reads back complete, with its last row intact', rows: 40000 },
  build: async (ctx) => {
    const rows = Array.from({ length: 40000 }, (_, i) => [i, `row ${i}`]);
    return {
      path: await w.parquetFile(join(ctx.dir, 'tall.parquet'), {
        name: 'tall',
        columns: SIMPLE_COLUMNS,
        rows,
      }),
      table: { columns: ['id', 'label'], rows },
    };
  },
});

// ---------------------------------------------------------------------------
// Value traps
// ---------------------------------------------------------------------------

/**
 * Integers past 2^53, where JSON's number type stops being able to tell two
 * values apart.
 *
 * DuckDB renders BIGINT as a decimal string on the way out, which is what makes
 * this safe -- and which is exactly the sort of load-bearing behaviour that
 * looks like an inconsistency and gets "cleaned up". If these two rows ever
 * read back as the same number, the grid is showing a value that is not in the
 * file and nothing anywhere says so.
 */
registerCase({
  name: 'shapes_bigint_past_2_53',
  family: 'shapes',
  expect: {
    note: 'two BIGINTs one apart, both past 2^53, must stay distinguishable in the grid',
    table: {
      columns: ['id'],
      rows: [['9007199254740993'], ['9007199254740992'], ['-9007199254740993']],
    },
  },
  build: async (ctx) => ({
    path: await w.parquetFile(join(ctx.dir, 'big.parquet'), {
      name: 'big',
      columns: [{ name: 'id', type: 'BIGINT' }],
      rows: [[9007199254740993n], [9007199254740992n], [-9007199254740993n]],
    }),
  }),
});

/**
 * The values that have no JSON representation at all.
 *
 * Built from SQL rather than from JS values because JS cannot express a HUGEINT
 * past 2^64 or a DECIMAL that keeps its scale, and because `NaN` written
 * through a parameter is not the same thing as a DOUBLE that IS NaN.
 */
registerCase({
  name: 'shapes_non_finite_and_exact_numerics',
  family: 'shapes',
  expect: {
    note: 'NaN, ±Infinity, HUGEINT and an exact DECIMAL survive to the grid as themselves',
    table: {
      columns: ['nan', 'pos_inf', 'neg_inf', 'huge', 'exact'],
      rows: [
        [
          'NaN',
          'Infinity',
          '-Infinity',
          '170141183460469231731687303715884105727',
          '1.234567890123456789',
        ],
      ],
    },
  },
  build: async (ctx) => {
    const path = join(ctx.dir, 'numeric.duckdb');
    const con = await w.scratchConnection();
    try {
      await con.run(`attach '${path}' as out`);
      await con.run(
        `create table out.numeric as select
           'nan'::DOUBLE as nan,
           'inf'::DOUBLE as pos_inf,
           '-inf'::DOUBLE as neg_inf,
           170141183460469231731687303715884105727::HUGEINT as huge,
           1.234567890123456789::DECIMAL(38,18) as exact`
      );
      await con.run(`detach out`);
    } finally {
      con.closeSync();
    }
    return { path };
  },
});

/** Dates outside the range a JS Date handles comfortably. */
registerCase({
  name: 'shapes_extreme_dates',
  family: 'shapes',
  expect: {
    note: 'dates before 1900 and past 2262, plus TIME and a nanosecond timestamp',
    table: {
      columns: ['old', 'far', 'clock', 'nanos'],
      rows: [['1666-09-02', '2400-01-01', '12:34:56.789', '2262-04-11 23:47:16.854775']],
    },
  },
  build: async (ctx) => {
    const path = join(ctx.dir, 'dates.duckdb');
    const con = await w.scratchConnection();
    try {
      await con.run(`attach '${path}' as out`);
      await con.run(
        `create table out.dates as select
           DATE '1666-09-02' as old,
           DATE '2400-01-01' as far,
           TIME '12:34:56.789' as clock,
           TIMESTAMP_NS '2262-04-11 23:47:16.854775' as nanos`
      );
      await con.run(`detach out`);
    } finally {
      con.closeSync();
    }
    return { path };
  },
});

/** Text carrying the characters that break delimiters, quoting and XML. */
registerCase({
  name: 'shapes_hostile_text_csv',
  family: 'shapes',
  expect: {
    note: 'a CSV whose values contain the delimiter, quotes, and newlines',
    table: {
      columns: ['id', 'text'],
      rows: [
        [1, 'has, a comma'],
        [2, 'has "double quotes"'],
        [3, "has 'single quotes'"],
        [4, 'has\na newline'],
        [5, 'has\ta tab'],
      ],
    },
  },
  build: async (ctx) => ({
    path: await w.csvFile(join(ctx.dir, 'text.csv'), {
      name: 'text',
      columns: [
        { name: 'id', type: 'INTEGER' },
        { name: 'text', type: 'VARCHAR' },
      ],
      rows: [
        [1, 'has, a comma'],
        [2, 'has "double quotes"'],
        [3, "has 'single quotes'"],
        [4, 'has\na newline'],
        [5, 'has\ta tab'],
      ],
    }),
  }),
});

/**
 * An empty string in a CSV comes back as NULL.
 *
 * Found by this suite rather than reasoned about. DuckDB WRITES the value
 * correctly -- the file really does contain `6,""`, which is CSV's unambiguous
 * spelling of an empty string, not a missing field -- and then read_csv reads
 * that same `""` back as NULL. So a cell that held "" is displayed as empty,
 * and if the user saves the file the empty string is gone for good.
 *
 * Was pinned on the belief that fixing it meant changing how every
 * genuinely-missing field in every CSV is read. It did not: `read_csv`'s
 * `allow_quoted_nulls` covers QUOTED fields only, so turning it off rescues ""
 * and leaves an unquoted empty field between two commas reading as NULL, which
 * is what everyone means by it. See CSV_READ_OPTIONS in duckdbConnection.ts.
 */
registerCase({
  name: 'shapes_csv_empty_string_becomes_null',
  family: 'shapes',
  expect: {
    note: 'an empty string written to a CSV reads back as an empty string, not NULL',
    table: { columns: ['id', 'text'], rows: [[1, '']] },
  },
  build: async (ctx) => ({
    path: await w.csvFile(join(ctx.dir, 'empty.csv'), {
      name: 'empty',
      columns: [
        { name: 'id', type: 'INTEGER' },
        { name: 'text', type: 'VARCHAR' },
      ],
      rows: [[1, '']],
    }),
  }),
});

/**
 * A title row above the header collapses the whole sheet to one column.
 *
 * read_xlsx picks its region by scanning for the first row of consecutive
 * non-empty cells and taking it as the header. A workbook whose sheet opens
 * with a title banner -- which is most workbooks a human made -- therefore
 * reads as a single column named after the title, with the real header sitting
 * in the data below it.
 *
 * Fixed by showing the sheet's own rectangle instead: when the view covers
 * fewer columns than the sheet's `<dimension>` declares, it is rebuilt over the
 * whole thing with no header at all, and the user is told. So `id`, `label` and
 * `amount` are still visible here -- as the DATA they always were, in a grid
 * whose columns are the spreadsheet's own letters. That is the point: the
 * viewer no longer decides where the header is, it shows what is there.
 *
 * No header is guessed, deliberately. The real file this came from
 * (~/Desktop/scatter/YieldCurve_Data.xlsx) is why: its row 4 reads exactly like
 * a header -- `Series | Compounding Convention | Mnemonic(s)` -- and is a
 * legend for the 100 columns of data further down.
 */
registerCase({
  name: 'shapes_xlsx_title_row_above',
  family: 'shapes',
  expect: {
    note: 'a workbook with a title row above the header shows the whole sheet, and says so',
    // The banner, the header-as-data, and both data rows -- nothing dropped.
    rows: 4,
    hasColumns: ['A', 'B', 'C'],
    says: [/laid out|read as empty/],
  },
  build: async (ctx) => ({
    path: await w.xlsxFile(join(ctx.dir, 'title.xlsx'), [
      {
        name: 'data',
        rows: w.withNotes(
          ['id', 'label', 'amount'],
          [
            [1, 'alpha', 1.5],
            [2, 'beta', 2.5],
          ],
          { above: [['Quarterly figures']] }
        ),
      },
    ]),
  }),
});

/** A single value larger than most buffers anyone sizes by hand. */
registerCase({
  name: 'shapes_one_megabyte_string',
  family: 'shapes',
  expect: { note: 'a 1 MB string in one cell arrives whole' },
  build: async (ctx) => {
    const big = 'x'.repeat(1024 * 1024);
    const rows = [[1, big]];
    return {
      path: await w.parquetFile(join(ctx.dir, 'big-string.parquet'), {
        name: 'big',
        columns: [
          { name: 'id', type: 'INTEGER' },
          { name: 'text', type: 'VARCHAR' },
        ],
        rows,
      }),
      table: { columns: ['id', 'text'], rows },
    };
  },
});

/**
 * Unicode in the DATA, including the Turkish dotted/dotless i.
 *
 * The Turkish pair is not decoration: these columns come out of the user's own
 * pipelines, and `İ`/`ı` are the characters that break any code doing a
 * locale-sensitive case fold on the way to a comparison.
 */
registerCase({
  name: 'shapes_unicode_values',
  family: 'shapes',
  expect: {
    note: 'Turkish dotted/dotless i, RTL Arabic, emoji and combining marks survive intact',
    table: {
      columns: ['id', 'text'],
      rows: [
        [1, 'İstanbul'],
        [2, 'ısı'],
        [3, 'مرحبا'],
        [4, '👩‍👩‍👧‍👦 family'],
        [5, 'é combining'],
        [6, 'Ĳ ǆ ﬁ'],
      ],
    },
  },
  build: async (ctx) => ({
    path: await w.parquetFile(join(ctx.dir, 'unicode.parquet'), {
      name: 'unicode',
      columns: [
        { name: 'id', type: 'INTEGER' },
        { name: 'text', type: 'VARCHAR' },
      ],
      rows: [
        [1, 'İstanbul'],
        [2, 'ısı'],
        [3, 'مرحبا'],
        [4, '👩‍👩‍👧‍👦 family'],
        [5, 'é combining'],
        [6, 'Ĳ ǆ ﬁ'],
      ],
    }),
  }),
});

/**
 * Nested types, which the edit affordance excludes but the grid must still
 * display without falling over.
 */
registerCase({
  name: 'shapes_nested_types',
  family: 'shapes',
  expect: {
    note: 'LIST, STRUCT and MAP columns display rather than breaking the grid',
    hasColumns: ['lst', 'strct', 'mp'],
    rows: 1,
  },
  build: async (ctx) => {
    const path = join(ctx.dir, 'nested.duckdb');
    const con = await w.scratchConnection();
    try {
      await con.run(`attach '${path}' as out`);
      await con.run(
        `create table out.nested as select
           [1, 2, 3] as lst,
           {'a': 1, 'b': 'x'} as strct,
           MAP{'k': 'v'} as mp,
           '\\x00\\x01\\xFF'::BLOB as bl`
      );
      await con.run(`detach out`);
    } finally {
      con.closeSync();
    }
    return { path };
  },
});

/**
 * A CSV with a UTF-8 BOM, which is what Excel's own exporter writes.
 *
 * The failure this looks for is specific: the BOM being read as part of the
 * first column's NAME, so a file that looks perfect in Excel has a first column
 * nothing can address by name.
 */
registerCase({
  name: 'shapes_csv_with_bom',
  family: 'shapes',
  expect: {
    note: "a BOM must not end up inside the first column's name",
    hasColumns: ['id', 'label'],
    rows: 2,
  },
  build: async (ctx) => ({
    path: await w.csvFile(
      join(ctx.dir, 'bom.csv'),
      {
        name: 'bom',
        columns: SIMPLE_COLUMNS,
        rows: [
          [1, 'alpha'],
          [2, 'beta'],
        ],
      },
      { bom: true }
    ),
  }),
});

/**
 * Duplicate column names.
 *
 * There is no right answer here, only a wrong one: silently dropping a column
 * so the grid shows two columns where the file has three. Either both survive
 * (renamed) or the file is refused; this case pins whichever the viewer does so
 * a change to it is a decision rather than an accident.
 */
registerCase({
  name: 'shapes_duplicate_column_names',
  family: 'shapes',
  expect: { note: 'a CSV with two columns of the same name must not quietly lose one' },
  build: async (ctx) => {
    const { writeFile } = await import('node:fs/promises');
    const path = join(ctx.dir, 'dupes.csv');
    await writeFile(path, 'id,label,label\n1,a,b\n2,c,d\n', 'utf8');
    return { path };
  },
  check: async (file, ctx) => {
    const table = await readTable(file);
    if (table.columns.length !== 3) {
      ctx.fail(
        'silent-misread',
        `the file has 3 columns; the grid shows ${table.columns.length}: [${table.columns.join(', ')}]`
      );
    }
    if (table.rows[0]?.length !== table.columns.length) {
      ctx.fail('silent-misread', 'row width does not match the column count');
    }
  },
});
