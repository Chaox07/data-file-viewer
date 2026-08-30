import { join } from 'node:path';
import { registerCase } from '../expect';
import { firstTable, readTable } from '../harness/inspect';
import * as w from './_write';

/**
 * Safe Mode: taking a backup must work for every kind that can be edited, and
 * -- the part that actually bit -- a backup that FAILS must not take the rest
 * of the session with it.
 *
 * The bug this family was written for, reported against a real workbook:
 *
 *   Could not create backup — Safe Mode stays on: Invalid Input Error: Error
 *   when sniffing file ".../merged_excel.backup-20260830-201014.xlsx"
 *   ...
 *   Catalog Error: Table with name efektif_kur does not exist!
 *   Did you mean "memory.efektif_kur"?
 *
 * Two separate defects in one message. First, `attachBackupCatalog` picked its
 * read function from a chain that ended in `read_csv_auto`, and neither xlsx
 * nor feather had a branch -- so a workbook backup was handed to the CSV
 * sniffer, which failed on the ZIP header. That only became reachable when
 * .xlsx became editable.
 *
 * Second, and worse: the failing statement sat between `use backup_cmp` and
 * `use <the real catalog>`, so the throw left the connection pointing at the
 * backup catalog. Every later unqualified query in that document resolved
 * against an empty in-memory catalog and reported the user's own tables as
 * missing. Nothing in that second error mentions Safe Mode, backups, or the
 * first failure -- from the user's side the file simply stopped working.
 *
 * So these cases assert two things per kind: the backup succeeds, and the
 * connection is still usable afterwards. The second assertion is the one that
 * would have caught the outage, and it is cheap enough to make everywhere.
 */

const SPEC: w.TableSpec = {
  name: 'data',
  columns: [
    { name: 'id', type: 'INTEGER' },
    { name: 'label', type: 'VARCHAR' },
  ],
  rows: [
    [1, 'alpha'],
    [2, 'beta'],
  ],
};

const ARROW_COLUMNS: w.ArrowColumn[] = [
  { name: 'id', encoding: 'int32', values: [1, 2] },
  { name: 'label', encoding: 'utf8', values: ['alpha', 'beta'] },
];

const KINDS: [string, (dir: string) => Promise<string>][] = [
  ['duckdb', (dir) => w.duckdbFile(join(dir, 'sm.duckdb'), [SPEC])],
  ['sqlite', (dir) => w.sqliteFile(join(dir, 'sm.sqlite'), [SPEC])],
  ['parquet', (dir) => w.parquetFile(join(dir, 'sm.parquet'), SPEC)],
  ['csv', (dir) => w.csvFile(join(dir, 'sm.csv'), SPEC)],
  ['arrows', (dir) => w.arrowStreamFile(join(dir, 'sm.arrows'), ARROW_COLUMNS)],
  ['feather', (dir) => w.featherFile(join(dir, 'sm.feather'), ARROW_COLUMNS)],
  [
    'xlsx',
    (dir) =>
      w.xlsxFile(join(dir, 'sm.xlsx'), [
        { name: 'data', rows: [['id', 'label'], [1, 'alpha'], [2, 'beta']] },
        { name: 'other', rows: [['x'], [9]] },
      ]),
  ],
];

for (const [kind, build] of KINDS) {
  registerCase({
    name: `safemode_backup_${kind}`,
    family: 'safemode',
    expect: {
      note: `turning Safe Mode on for a .${kind} takes a backup and leaves the session working`,
    },
    build: async (ctx) => ({ path: await build(ctx.dir) }),
    check: async (file, ctx) => {
      const name = await firstTable(file);
      const before = await readTable(file, name);

      try {
        await file.createBackup();
      } catch (err) {
        ctx.fail(
          'crash',
          `createBackup failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`
        );
      }

      // The assertion that matters. A failed backup used to leave the
      // connection inside backup_cmp, so this is where the damage showed up --
      // as the user's own tables reported missing, with nothing linking it to
      // the backup that failed a moment earlier.
      try {
        const after = await readTable(file, name);
        if (after.rows.length !== before.rows.length) {
          ctx.fail(
            'silent-misread',
            `the table read ${before.rows.length} rows before the backup and ${after.rows.length} after`
          );
        }
      } catch (err) {
        ctx.fail(
          'crash',
          `the session was left unusable by the backup: ${
            err instanceof Error ? err.message.split('\n')[0] : String(err)
          }`
        );
      }

      try {
        const tables = await file.listTables();
        if (!tables.includes(name)) {
          ctx.fail(
            'crash',
            `after the backup, listTables no longer reports "${name}" — it reports [${tables.join(', ')}]`
          );
        }
      } catch (err) {
        ctx.fail('crash', `listTables failed after the backup: ${String(err)}`);
      }
    },
  });
}

/**
 * Toggling Safe Mode more than once.
 *
 * The second backup has to detach the first before re-attaching the alias --
 * DuckDB refuses a name already in use -- and each detach has to leave the
 * connection in the real catalog again, so this walks the same restore path
 * twice rather than once.
 */
registerCase({
  name: 'safemode_backup_twice',
  family: 'safemode',
  expect: { note: 'taking a second backup swaps the attached catalog instead of stacking one' },
  build: async (ctx) => ({
    path: await w.xlsxFile(join(ctx.dir, 'twice.xlsx'), [
      { name: 'data', rows: [['id', 'label'], [1, 'alpha']] },
    ]),
  }),
  check: async (file, ctx) => {
    for (const attempt of [1, 2]) {
      try {
        await file.createBackup();
      } catch (err) {
        ctx.fail(
          'crash',
          `backup ${attempt} failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`
        );
        return;
      }
      try {
        await readTable(file, 'data');
      } catch (err) {
        ctx.fail(
          'crash',
          `the session was unusable after backup ${attempt}: ${
            err instanceof Error ? err.message.split('\n')[0] : String(err)
          }`
        );
        return;
      }
    }
  },
});

/**
 * A workbook whose sheets need `ignore_errors` to be readable at all.
 *
 * The live views get repaired lazily on the first failing query, and the backup
 * has to be read the same way -- otherwise Safe Mode works right up until the
 * moment the user looks at the diff, which then fails on a cell the live side
 * is already handling.
 */
registerCase({
  name: 'safemode_backup_workbook_with_error_cells',
  family: 'safemode',
  expect: {
    note: 'a workbook holding #DIV/0! can still be backed up and compared',
  },
  build: async (ctx) => ({
    path: await w.xlsxFile(join(ctx.dir, 'errors.xlsx'), [
      {
        name: 'data',
        rows: [
          ['id', 'ratio'],
          [1, 1.5],
          [2, 2.5],
          [3, '#DIV/0!'],
        ],
      },
    ]),
  }),
  check: async (file, ctx) => {
    // Force the lazy repair first, the way a real first query does.
    await readTable(file, 'data');
    try {
      await file.createBackup();
      await readTable(file, 'data');
    } catch (err) {
      ctx.fail(
        'crash',
        `backing up a workbook with uncomputable cells failed: ${
          err instanceof Error ? err.message.split('\n')[0] : String(err)
        }`
      );
    }
  },
});
