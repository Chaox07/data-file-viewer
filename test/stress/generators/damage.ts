import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { registerCase } from '../expect';
import * as w from './_write';

/**
 * Damaged files must be REFUSED, never half-read.
 *
 * `malformedFiles.test.ts` already holds the curated version of this: a
 * hand-reasoned corpus with assertions on the exact wording of each
 * diagnosis, plus the base64 polars fixtures that Node cannot regenerate.
 * Those stay where they are -- they are evidence, and the messages they pin
 * are worth more than the uniformity of moving them here.
 *
 * This family is the other half: the systematic sweep nobody enumerates by
 * hand. Every corpus file, cut at every 10% boundary; every magic number
 * zeroed; every header and footer byte-flipped; every format wearing every
 * other format's extension. Combinatorially it is a few hundred openings, and
 * its value is precisely that no human chose which combinations to include.
 *
 * The invariant is the one `malformedFiles.test.ts` established and it is not
 * "did it throw". For the flat kinds `open()` only runs `create view ... from
 * read_x(...)`, and DuckDB does not touch the file to create a view, so a
 * corrupt flat file routinely opens clean and fails on first query. Every case
 * here therefore opens AND reads -- which the runner does for all cases, so
 * `refuses` is all a case has to declare.
 *
 * The failure this hunts is not a crash. It is a truncated file that comes
 * back as zero rows and no error, which draws the right column headers over an
 * empty grid and reads as "this export produced nothing" rather than "this
 * file is damaged". That is silent-misread, the second-worst category here,
 * and it is exactly what a truncated Arrow stream did before
 * `assertArrowStreamComplete` went in.
 */

const SPEC: w.TableSpec = {
  name: 'data',
  columns: [
    { name: 'id', type: 'INTEGER' },
    { name: 'label', type: 'VARCHAR' },
  ],
  // Enough rows that a cut at any fraction lands inside real data rather than
  // inside a header that happens to be most of a tiny file.
  rows: Array.from({ length: 500 }, (_, i) => [i, `row ${i}`]),
};

const ARROW_COLUMNS: w.ArrowColumn[] = [
  { name: 'id', encoding: 'int32', values: Array.from({ length: 500 }, (_, i) => i) },
  { name: 'label', encoding: 'utf8', values: Array.from({ length: 500 }, (_, i) => `row ${i}`) },
];

/** The intact files every damage case is derived from. */
const SOURCES: [string, string, (dir: string) => Promise<string>][] = [
  ['parquet', 'parquet', (dir) => w.parquetFile(join(dir, 'good.parquet'), SPEC)],
  ['duckdb', 'duckdb', (dir) => w.duckdbFile(join(dir, 'good.duckdb'), [SPEC])],
  ['arrows', 'arrows', (dir) => w.arrowStreamFile(join(dir, 'good.arrows'), ARROW_COLUMNS)],
  ['feather', 'feather', (dir) => w.featherFile(join(dir, 'good.feather'), ARROW_COLUMNS)],
  [
    'xlsx',
    'xlsx',
    (dir) =>
      w.xlsxFile(join(dir, 'good.xlsx'), [
        { name: 'data', rows: [['id', 'label'], ...SPEC.rows] },
      ]),
  ],
];

/** Cut the file short, keeping the head. */
for (const [kind, ext, build] of SOURCES) {
  for (const percent of [10, 25, 50, 75, 90, 99]) {
    registerCase({
      name: `damage_truncate_${kind}_${percent}pct`,
      family: 'damage',
      expect: {
        note: `a .${ext} cut to ${percent}% of its length must be refused, not read up to the cut`,
        refuses: true,
      },
      build: async (ctx) => {
        const good = await build(ctx.dir);
        const bytes = await readFile(good);
        const cut = join(ctx.dir, `cut.${ext}`);
        await writeFile(cut, bytes.subarray(0, Math.floor((bytes.length * percent) / 100)));
        return { path: cut };
      },
    });
  }
}

/**
 * Zero the magic bytes, keeping the length.
 *
 * The opposite of truncation: a file of exactly the right size whose
 * identifying header is gone. Nothing can be inferred from the size, so
 * anything that reads it is guessing.
 */
for (const [kind, ext, build] of SOURCES) {
  registerCase({
    name: `damage_magic_zeroed_${kind}`,
    family: 'damage',
    expect: {
      note: `a .${ext} whose leading magic bytes are zeroed must be refused`,
      refuses: true,
    },
    build: async (ctx) => {
      const good = await build(ctx.dir);
      const bytes = Buffer.from(await readFile(good));
      bytes.fill(0, 0, Math.min(8, bytes.length));
      const damaged = join(ctx.dir, `nomagic.${ext}`);
      await writeFile(damaged, bytes);
      return { path: damaged };
    },
  });
}

/**
 * Flip a byte deep in the body, leaving both ends intact.
 *
 * The nastiest shape in this family: every structural check a reader performs
 * at the head or the tail still passes, so whatever refuses this has to be
 * looking at the data itself. A reader that does not is liable to return a
 * plausible-looking wrong value rather than an error, which is why the
 * expectation here is deliberately NOT `refuses` -- see below.
 */
for (const [kind, ext, build] of SOURCES) {
  registerCase({
    name: `damage_byte_flip_${kind}`,
    family: 'damage',
    expect: {
      note: `a .${ext} with a flipped byte in its body is refused, or reads back correctly — never a wrong value shown as right`,
      // A flipped byte may legitimately land in slack space, in a
      // checksum-protected block that recovers, or in a value that is still a
      // valid value of its type. Refusing is right; reading correctly is right.
      // What must not happen is a confidently-wrong read.
      mayRefuse: true,
    },
    build: async (ctx) => {
      const good = await build(ctx.dir);
      const bytes = Buffer.from(await readFile(good));
      const at = Math.floor(bytes.length / 2);
      bytes[at] = bytes[at] ^ 0xff;
      const damaged = join(ctx.dir, `flipped.${ext}`);
      await writeFile(damaged, bytes);
      return { path: damaged };
    },
    check: async (file, ctx, built) => {
      // Reaching here means it opened and read. The rows must then be the rows
      // that were written -- a flipped byte that changes a value without
      // anything noticing is the silent misread this whole suite is for.
      const { readTable } = await import('../harness/inspect');
      const table = await readTable(file, built.tableName);
      if (table.rows.length !== SPEC.rows.length) {
        ctx.fail(
          'silent-misread',
          `${basename(built.path)} opened with a corrupted byte and returned ` +
            `${table.rows.length} of ${SPEC.rows.length} rows, with no error`
        );
        return;
      }
      for (let r = 0; r < table.rows.length; r++) {
        if (Number(table.rows[r][0]) !== r) {
          ctx.fail(
            'silent-misread',
            `row ${r} came back as id ${JSON.stringify(table.rows[r][0])} after a byte flip, ` +
              `shown with no indication anything is wrong`
          );
          return;
        }
      }
    },
  });
}

/**
 * Every format wearing every other format's extension.
 *
 * The kind is chosen by extension, so this is the collision that decides
 * whether the wrong reader gets pointed at a real, valid file -- and a valid
 * file read by the wrong reader is the case most likely to produce rows rather
 * than an error. `.arrows`/`.feather` are excluded from each other's list:
 * either encoding legitimately turns up under either name and the viewer
 * sniffs the magic rather than trusting the suffix, which is tested as
 * intended behaviour elsewhere.
 */
const DISGUISE_TARGETS = ['parquet', 'duckdb', 'arrows', 'feather', 'xlsx', 'csv', 'sqlite'];

for (const [kind, ext, build] of SOURCES) {
  for (const wearing of DISGUISE_TARGETS) {
    if (wearing === ext) continue;
    if ((ext === 'arrows' && wearing === 'feather') || (ext === 'feather' && wearing === 'arrows')) continue;
    registerCase({
      name: `damage_disguise_${kind}_as_${wearing}`,
      family: 'damage',
      expect: {
        note: `a valid .${ext} renamed .${wearing} must be refused, not read by the wrong reader`,
        refuses: true,
      },
      build: async (ctx) => {
        const good = await build(ctx.dir);
        const disguised = join(ctx.dir, `disguised.${wearing}`);
        await writeFile(disguised, await readFile(good));
        return { path: disguised };
      },
    });
  }
}

/**
 * Empty and near-empty files, per extension.
 *
 * CSV is excluded and handled separately below: it is the one text format
 * here, so "empty" is not structurally detectable the way a missing PAR1 or
 * ARROW1 is, and `malformedFiles.test.ts` already leaves CSV out of its own
 * "empty files are refused" list for that reason.
 */
for (const ext of ['parquet', 'duckdb', 'arrows', 'feather', 'xlsx', 'sqlite', 'dta']) {
  registerCase({
    name: `damage_empty_${ext}`,
    family: 'damage',
    expect: { note: `a zero-byte .${ext} is refused`, refuses: true },
    build: async (ctx) => {
      const path = join(ctx.dir, `empty.${ext}`);
      await writeFile(path, '');
      return { path };
    },
  });

  registerCase({
    name: `damage_whitespace_only_${ext}`,
    family: 'damage',
    expect: { note: `a .${ext} holding only whitespace is refused`, refuses: true },
    build: async (ctx) => {
      const path = join(ctx.dir, `blank.${ext}`);
      await writeFile(path, '   \n\n\t  \n');
      return { path };
    },
  });
}

/**
 * A zero-byte CSV opens as an empty table with an invented column.
 *
 * Not a refusal, and defensibly so: an empty CSV is a legal empty CSV, and
 * unlike every binary kind there is no header whose absence proves damage.
 * `column0` is DuckDB's placeholder for a file it could find no header in.
 * Recorded here so the behaviour is a decision rather than an accident.
 */
registerCase({
  name: 'damage_empty_csv',
  family: 'damage',
  expect: {
    note: 'a zero-byte CSV opens as an empty table rather than being refused',
    rows: 0,
    mayRefuse: true,
  },
  build: async (ctx) => {
    const path = join(ctx.dir, 'empty.csv');
    await writeFile(path, '');
    return { path };
  },
});

/**
 * A CSV holding nothing but whitespace produces ROWS.
 *
 * Measured, not inferred. read_csv_auto on `"   \n\n\t  \n"` returns two
 * invented columns and one row, `[null, "  "]`; on `"\n\n\n"` it returns one
 * column and TWO rows of null. So a file with no data in it draws a grid with
 * data in it, and nothing anywhere says the file was blank.
 *
 * This is the silent-misread category: the file opens, the grid draws, and
 * what it shows is not in the file. It is read_csv_auto's permissiveness
 * rather than the viewer's code, but the viewer is what decides whether to
 * pass it on, and a CSV that is entirely whitespace is far more likely a
 * failed write than intentional data.
 *
 * Pinned rather than fixed because refusing blank CSVs is a product decision
 * about a format the viewer opens constantly, not a defect to quietly patch.
 */
for (const [slug, body, description] of [
  ['whitespace', '   \n\n\t  \n', 'two invented columns and a row containing "  "'],
  ['newlines', '\n\n\n', 'one column and two rows of null'],
] as const) {
  registerCase({
    name: `damage_blank_csv_${slug}`,
    family: 'damage',
    expect: {
      note: `a CSV holding only ${slug} must not produce rows`,
      rows: 0,
      knownBug: `read_csv_auto turns a blank CSV into ${description}, so a file with no data draws a grid with data in it, unannounced`,
    },
    build: async (ctx) => {
      const path = join(ctx.dir, `blank-${slug}.csv`);
      await writeFile(path, body);
      return { path };
    },
  });
}

/**
 * Trailing garbage appended after a complete, valid file.
 *
 * A real shape: a writer that appended to a file it should have truncated, or
 * two exports concatenated. The head is perfect, so header checks pass.
 */
for (const [kind, ext, build] of SOURCES) {
  registerCase({
    name: `damage_trailing_garbage_${kind}`,
    family: 'damage',
    expect: {
      note: `a complete .${ext} with garbage appended is refused, or reads its real rows — never a truncated subset`,
      mayRefuse: true,
    },
    build: async (ctx) => {
      const good = await build(ctx.dir);
      const damaged = join(ctx.dir, `trailing.${ext}`);
      await writeFile(damaged, Buffer.concat([await readFile(good), Buffer.from('\n\nGARBAGE'.repeat(64))]));
      return { path: damaged };
    },
    check: async (file, ctx, built) => {
      const { readTable } = await import('../harness/inspect');
      const table = await readTable(file, built.tableName);
      if (table.rows.length !== SPEC.rows.length) {
        ctx.fail(
          'silent-misread',
          `appending garbage changed the row count from ${SPEC.rows.length} to ${table.rows.length}, ` +
            `with no error`
        );
      }
    },
  });
}

/**
 * A workbook that is a valid ZIP but not a workbook, and one whose worksheet
 * part is present but not XML.
 *
 * An .xlsx is a ZIP long before it is a workbook, so there are two distinct
 * layers at which it can be wrong, and only the outer one is obvious.
 */
registerCase({
  name: 'damage_zip_that_is_not_a_workbook',
  family: 'damage',
  expect: { note: 'a valid ZIP with no workbook.xml is refused', refuses: true },
  build: async (ctx) => {
    const { zipSync, strToU8 } = await import('fflate');
    const path = join(ctx.dir, 'notabook.xlsx');
    await writeFile(path, Buffer.from(zipSync({ 'readme.txt': strToU8('no workbook here') })));
    return { path };
  },
});

registerCase({
  name: 'damage_workbook_with_unparseable_sheet',
  family: 'damage',
  expect: {
    note: 'a workbook whose worksheet part is not XML is refused rather than shown empty',
    refuses: true,
  },
  build: async (ctx) => {
    const { unzipSync, zipSync, strToU8 } = await import('fflate');
    const good = await w.xlsxFile(join(ctx.dir, 'good.xlsx'), [
      { name: 'data', rows: [['id', 'label'], [1, 'alpha']] },
    ]);
    const parts = unzipSync(new Uint8Array(await readFile(good)));
    parts['xl/worksheets/sheet1.xml'] = strToU8('this is not xml at all <<<>>>');
    const path = join(ctx.dir, 'brokensheet.xlsx');
    await writeFile(path, Buffer.from(zipSync(parts)));
    return { path };
  },
});

/**
 * Repeated failures must not poison the next open.
 *
 * Each open creates an instance and a connection; a failure part-way has to
 * still leave the next file able to open cleanly rather than leaking a handle
 * or a half-attached catalog. The Safe Mode outage was exactly this shape one
 * level up, which is reason enough to hold the property here too.
 */
registerCase({
  name: 'damage_repeated_failures_do_not_poison_the_next_open',
  family: 'damage',
  expect: { note: 'a good file still opens after twenty consecutive refusals' },
  build: async (ctx) => ({ path: await w.parquetFile(join(ctx.dir, 'good.parquet'), SPEC) }),
  check: async (file, ctx, built) => {
    file.dispose();
    const { DuckDbFile } = await import('../../../src/duckdbConnection');
    const { readTable } = await import('../harness/inspect');

    const bytes = await readFile(built.path);
    const broken = join(ctx.dir, 'broken.parquet');
    await writeFile(broken, bytes.subarray(0, Math.floor(bytes.length / 2)));

    for (let i = 0; i < 20; i++) {
      try {
        const bad = await DuckDbFile.open(broken);
        try {
          await readTable(bad);
          ctx.fail('silent-misread', `pass ${i}: the truncated file was read without complaint`);
          return;
        } finally {
          bad.dispose();
        }
      } catch {
        // Expected.
      }
    }

    const reopened = await DuckDbFile.open(built.path);
    try {
      const table = await readTable(reopened);
      if (table.rows.length !== SPEC.rows.length) {
        ctx.fail(
          'crash',
          `after 20 failed opens, a good file read ${table.rows.length} of ${SPEC.rows.length} rows`
        );
      }
    } catch (err) {
      ctx.fail(
        'crash',
        `after 20 failed opens, a good file no longer opens: ${
          err instanceof Error ? err.message.split('\n')[0] : String(err)
        }`
      );
    } finally {
      reopened.dispose();
    }
  },
});
