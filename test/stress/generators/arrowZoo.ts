import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { registerCase } from '../expect';
import { readTable } from '../harness/inspect';
import * as w from './_write';

/**
 * Arrow, across both encodings and every extension they turn up under.
 *
 * The distinction that runs through all of it: the IPC **stream** encoding is
 * what `read_arrow` reads, and the **file** encoding (Feather V2 -- `ARROW1`
 * magic at both ends, plus a footer for random access) is what it cannot read
 * at all. The viewer converts the second into the first before DuckDB sees it,
 * and converts back on save so a .feather stays a .feather.
 *
 * Either encoding turns up under either extension in the wild, so the kind is
 * decided by the magic bytes rather than the suffix. That sniffing is the
 * thing most easily broken by a change here, and it fails in the expensive
 * direction: refusing a valid file, or -- worse -- reading a stream as a file
 * and reporting an empty table.
 *
 * The corpus this family replaces was written entirely by DuckDB, which is why
 * it passed for months while every polars-written Feather file failed. DuckDB
 * writes plain `Utf8`; polars writes `Utf8View`, the type `read_arrow` rejects
 * outright. The lesson generalises: encodings the local writer never emits are
 * exactly the ones that go untested, so this family names them explicitly.
 */

const IDS = Array.from({ length: 300 }, (_, i) => i);
const LABELS = IDS.map((i) => `row ${i}`);

function columns(encoding: w.ArrowEncoding): w.ArrowColumn[] {
  return [
    { name: 'id', encoding: 'int32', values: IDS },
    { name: 'label', encoding, values: LABELS },
  ];
}

const EXPECTED = {
  columns: ['id', 'label'],
  rows: IDS.map((i) => [i, `row ${i}`]),
};

/** Both encodings, under both extensions. Four combinations, all valid. */
for (const [encodingName, write] of [
  ['stream', w.arrowStreamFile],
  ['file', w.featherFile],
] as const) {
  for (const ext of ['arrows', 'arrow', 'feather'] as const) {
    registerCase({
      name: `arrow_${encodingName}_as_${ext}`,
      family: 'arrowZoo',
      expect: {
        note: `the Arrow ${encodingName} encoding under a .${ext} name is sniffed and read`,
        table: EXPECTED,
      },
      build: async (ctx) => ({ path: await write(join(ctx.dir, `z.${ext}`), columns('utf8')) }),
    });
  }
}

/**
 * String encodings.
 *
 * `Utf8View` is the one that mattered: polars' default, and rejected by
 * read_arrow as "Unrecognized Field type with value 24", so converting the
 * container is not enough -- the string columns have to be brought down to
 * plain Utf8 as well. `LargeUtf8` is the same question with a different answer
 * required, and apache-arrow can write it, so it is checked rather than
 * assumed.
 */
for (const encoding of ['utf8', 'largeUtf8'] as const) {
  registerCase({
    name: `arrow_strings_${encoding}`,
    family: 'arrowZoo',
    expect: {
      note: `${encoding} string columns read back as their values`,
      table: EXPECTED,
    },
    build: async (ctx) => ({
      path: await w.featherFile(join(ctx.dir, `${encoding}.feather`), columns(encoding)),
    }),
  });
}

/**
 * Multi-batch files, at several batch sizes.
 *
 * The conversion runs a record batch at a time -- that is what keeps a 400k-row
 * file off the heap -- so batch boundaries are where a rewrite drops or
 * duplicates rows. Sizes chosen so one divides the row count exactly and the
 * others leave a short final batch, since a short last batch is the classic
 * place to lose rows.
 */
for (const batchSize of [1, 7, 100, 150, 299]) {
  registerCase({
    name: `arrow_multibatch_${batchSize}`,
    family: 'arrowZoo',
    expect: {
      note: `a Feather file in batches of ${batchSize} reads back all 300 rows in order`,
      table: EXPECTED,
    },
    build: async (ctx) => ({
      path: await w.featherFile(join(ctx.dir, `mb${batchSize}.feather`), columns('utf8'), batchSize),
    }),
  });
}

/** A file with a schema and no rows at all. */
registerCase({
  name: 'arrow_zero_rows',
  family: 'arrowZoo',
  expect: {
    note: 'a genuinely empty Arrow table opens and reports its columns, rather than reading as damaged',
    table: { columns: ['id', 'label'], rows: [] },
  },
  build: async (ctx) => ({
    path: await w.featherFile(join(ctx.dir, 'empty.feather'), [
      { name: 'id', encoding: 'int32', values: [] },
      { name: 'label', encoding: 'utf8', values: [] },
    ]),
  }),
});

/** Every scalar encoding the writer can produce, in one file. */
registerCase({
  name: 'arrow_all_scalar_encodings',
  family: 'arrowZoo',
  expect: {
    note: 'int32, int64, float64, utf8 and bool columns all survive the conversion',
    table: {
      columns: ['i32', 'i64', 'f64', 'txt', 'flag'],
      rows: [
        [1, '9007199254740993', 1.5, 'a', true],
        [2, '9007199254740992', 2.5, 'b', false],
      ],
    },
  },
  build: async (ctx) => ({
    path: await w.featherFile(join(ctx.dir, 'scalars.feather'), [
      { name: 'i32', encoding: 'int32', values: [1, 2] },
      // Past 2^53 on purpose: an Int64 that loses precision in the conversion
      // is the same class of bug as the BIGINT case in `shapes`, and the
      // conversion is JS code rather than DuckDB's.
      { name: 'i64', encoding: 'int64', values: [9007199254740993n, 9007199254740992n] },
      { name: 'f64', encoding: 'float64', values: [1.5, 2.5] },
      { name: 'txt', encoding: 'utf8', values: ['a', 'b'] },
      { name: 'flag', encoding: 'bool', values: [true, false] },
    ]),
  }),
});

/** Nulls inside every encoding, including a wholly-null column. */
registerCase({
  name: 'arrow_nulls_in_every_encoding',
  family: 'arrowZoo',
  expect: {
    note: 'nulls survive the Feather conversion in each column type',
    table: {
      columns: ['i32', 'f64', 'txt'],
      rows: [
        [1, null, 'a'],
        [null, 2.5, null],
        [null, null, null],
      ],
    },
  },
  build: async (ctx) => ({
    path: await w.featherFile(join(ctx.dir, 'nulls.feather'), [
      { name: 'i32', encoding: 'int32', values: [1, null, null] },
      { name: 'f64', encoding: 'float64', values: [null, 2.5, null] },
      { name: 'txt', encoding: 'utf8', values: ['a', null, null] },
    ]),
  }),
});

/**
 * A Feather file saved back must still BE a Feather file.
 *
 * `COPY ... (FORMAT arrow)` writes a stream, so saving through DuckDB alone
 * would put stream bytes inside a .feather and quietly change the format out
 * from under whatever reads it next -- the file would still open here and
 * break in pyarrow. The magic at BOTH ends is what distinguishes the two
 * encodings, so both are checked.
 */
registerCase({
  name: 'arrow_feather_stays_feather_after_an_edit',
  family: 'arrowZoo',
  expect: { note: 'saving an edited .feather leaves the file in the FILE encoding, not a stream' },
  build: async (ctx) => ({
    path: await w.featherFile(join(ctx.dir, 'stays.feather'), columns('utf8'), 50),
  }),
  check: async (file, ctx, built) => {
    const table = await readTable(file, built.tableName);
    const rowValues: Record<string, unknown> = {};
    table.columns.forEach((c, i) => {
      rowValues[c] = table.rows[0][i];
    });
    await file.updateCell(await file.listTables().then((t) => t[0]), 'label', 'EDITED', rowValues);
    file.dispose();

    const bytes = await readFile(built.path);
    const head = bytes.subarray(0, 6).toString('latin1');
    const tail = bytes.subarray(bytes.length - 6).toString('latin1');
    if (head !== 'ARROW1') {
      ctx.fail('silent-corruption', `after saving, the file starts with ${JSON.stringify(head)}, not ARROW1`);
    }
    if (tail !== 'ARROW1') {
      ctx.fail(
        'silent-corruption',
        `after saving, the file ends with ${JSON.stringify(tail)}, not ARROW1 — ` +
          `a stream was written into a .feather, which reads here and breaks everywhere else`
      );
    }
  },
});

/**
 * A stream whose end-of-stream marker is missing.
 *
 * The bug `assertArrowStreamComplete` exists for, held here across cut points
 * rather than at one. read_arrow reads the schema, finds no batches where the
 * file stops, and reports ZERO ROWS AND NO ERROR -- so the grid draws the
 * right column headers over an empty table, which reads as "this export
 * produced nothing" rather than "this file is damaged". That is the worst
 * outcome in this suite's ranking and the hardest to notice.
 */
for (const percent of [30, 60, 95, 99]) {
  registerCase({
    name: `arrow_stream_cut_at_${percent}pct`,
    family: 'arrowZoo',
    expect: {
      note: `a stream cut at ${percent}% is refused, not shown as an empty table`,
      refuses: /truncated|incomplete|end-of-stream/i,
    },
    build: async (ctx) => {
      const good = await w.arrowStreamFile(join(ctx.dir, 'good.arrows'), columns('utf8'));
      const bytes = await readFile(good);
      const cut = join(ctx.dir, 'cut.arrows');
      await writeFile(cut, bytes.subarray(0, Math.floor((bytes.length * percent) / 100)));
      return { path: cut };
    },
  });
}

/**
 * The other half of that check, and the reason it looks for the marker rather
 * than the file size: a table that genuinely has no rows is a complete, valid
 * stream and must still open.
 */
registerCase({
  name: 'arrow_empty_stream_is_not_mistaken_for_truncated',
  family: 'arrowZoo',
  expect: {
    note: 'a zero-row stream is complete and must open, not be refused as truncated',
    table: { columns: ['id', 'label'], rows: [] },
  },
  build: async (ctx) => ({
    path: await w.arrowStreamFile(join(ctx.dir, 'empty.arrows'), [
      { name: 'id', encoding: 'int32', values: [] },
      { name: 'label', encoding: 'utf8', values: [] },
    ]),
  }),
});

/**
 * A large file, to hold the property the streaming rewrite bought.
 *
 * Not a timing assertion -- those are flaky on shared CI -- but a correctness
 * one at a size where a whole-file buffer would previously have been built.
 * The row count and both ends of the data are what a batch-at-a-time
 * conversion gets wrong when it gets anything wrong.
 */
registerCase({
  name: 'arrow_large_file_converts_completely',
  family: 'arrowZoo',
  expect: { note: 'a 200,000-row Feather file converts and reads back complete', rows: 200000 },
  build: async (ctx) => {
    const ids = Array.from({ length: 200000 }, (_, i) => i);
    return {
      path: await w.featherFile(
        join(ctx.dir, 'large.feather'),
        [
          { name: 'id', encoding: 'int32', values: ids },
          { name: 'label', encoding: 'utf8', values: ids.map((i) => `r${i}`) },
        ],
        8192
      ),
    };
  },
  check: async (file, ctx, built) => {
    const table = await readTable(file, built.tableName);
    if (Number(table.rows[0][0]) !== 0) {
      ctx.fail('silent-misread', `the first row is id ${JSON.stringify(table.rows[0][0])}, expected 0`);
    }
    const last = table.rows[table.rows.length - 1];
    if (Number(last[0]) !== 199999 || last[1] !== 'r199999') {
      ctx.fail(
        'silent-misread',
        `the last row is ${JSON.stringify(last)}, expected [199999, "r199999"] — ` +
          `a batch was dropped or truncated during conversion`
      );
    }
  },
});
