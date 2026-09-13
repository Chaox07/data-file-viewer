import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { chmod, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { DuckDbFile } from '../src/duckdbConnection';

/**
 * EXT-01 -- the file on disk and the table the grid edits agree after every
 * save outcome.
 *
 * E15 was the finding: updateCell committed the UPDATE and then wrote the file,
 * so a failed write left the table holding a value the file did not. The fix
 * keeps the UPDATE uncommitted until the file is published, stages every
 * flat-file save beside its target and renames it into place, refuses to
 * overwrite a file another program changed after editing began, and keeps the
 * file's permissions. User decision (2026-09-13): a .dta opens read-only,
 * because its write-back loses the version, all labels, and -- measured with
 * pandas -- the readable text of an untouched string column.
 *
 * Every assertion about the file reads it independently of the DuckDbFile
 * that wrote it: the raw bytes, or a fresh DuckDbFile.
 */

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dfv-ext01-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ROWS = 'name,qty\nwidget,2\nbolt,7\n';
const POSIX = process.platform !== 'win32';
const ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

async function subdir(name: string): Promise<string> {
  return mkdtemp(join(dir, `${name}-`));
}

async function qtyOf(file: DuckDbFile, table: string, name: string): Promise<string> {
  const result = await file.runQuery(`select qty from "${table}" where name = '${name}'`);
  return String(result.rows[0][result.columns.indexOf('qty')]);
}

async function stagingLeftIn(folder: string): Promise<string[]> {
  return (await readdir(folder)).filter((f) => f.includes('.saving'));
}

test('EXT-01: a save that cannot be written leaves the file byte-identical and the table unchanged', {
  skip: !POSIX || ROOT ? 'needs POSIX directory permissions and a non-root user' : false,
}, async () => {
  const folder = await subdir('unwritable');
  const path = join(folder, 'locked.csv');
  await writeFile(path, ROWS, 'utf8');
  const file = await DuckDbFile.open(path);
  try {
    await file.updateCell('locked', 'qty', 8, { name: 'bolt', qty: 7 });
    const onDisk = await readFile(path);

    // The staging file cannot be created: the save fails where a full disk or
    // a revoked permission would.
    await chmod(folder, 0o555);
    let raised: unknown;
    try {
      await file.updateCell('locked', 'qty', 42, { name: 'bolt', qty: 8 });
    } catch (err) {
      raised = err;
    } finally {
      await chmod(folder, 0o755);
    }
    assert.ok(raised instanceof Error, 'an unwritable save was reported as a success');
    assert.deepEqual(await readFile(path), onDisk, 'the file changed after a failed save');
    assert.equal(await qtyOf(file, 'locked', 'bolt'), '8', 'the table kept the edit the file refused');
    assert.deepEqual(await stagingLeftIn(folder), []);

    // And the session is still usable: the next save succeeds and both agree.
    await file.updateCell('locked', 'qty', 9, { name: 'bolt', qty: 8 });
    assert.equal(await qtyOf(file, 'locked', 'bolt'), '9');
    assert.match(await readFile(path, 'utf8'), /bolt,9/);
  } finally {
    file.dispose();
  }
});

test('EXT-01: a file another program changed after editing began is not overwritten', async () => {
  const folder = await subdir('external');
  const path = join(folder, 'shared.csv');
  await writeFile(path, ROWS, 'utf8');
  const file = await DuckDbFile.open(path);
  try {
    await file.updateCell('shared', 'qty', 8, { name: 'bolt', qty: 7 });

    const theirs = 'name,qty\nwidget,2\nbolt,99\nnut,1\n';
    await writeFile(path, theirs, 'utf8');
    const later = new Date(Date.now() + 10_000);
    await utimes(path, later, later);

    await assert.rejects(
      file.updateCell('shared', 'qty', 3, { name: 'widget', qty: 2 }),
      /changed on disk by another program/
    );
    assert.equal(await readFile(path, 'utf8'), theirs, "the other program's change was overwritten");
    assert.equal(await qtyOf(file, 'shared', 'widget'), '2', 'the refused edit stayed in the table');
    assert.deepEqual(await stagingLeftIn(folder), []);
  } finally {
    file.dispose();
  }
});

test('EXT-01: a save keeps the file permissions', { skip: !POSIX ? 'POSIX mode bits' : false }, async () => {
  const folder = await subdir('mode');
  const path = join(folder, 'private.csv');
  await writeFile(path, ROWS, 'utf8');
  await chmod(path, 0o640);
  const file = await DuckDbFile.open(path);
  try {
    await file.updateCell('private', 'qty', 8, { name: 'bolt', qty: 7 });
  } finally {
    file.dispose();
  }
  assert.equal((await stat(path)).mode & 0o777, 0o640);
});

for (const kind of ['parquet', 'arrows'] as const) {
  test(`EXT-01: a ${kind} save is staged, published, and reads back through a fresh open`, async () => {
    const folder = await subdir(kind);
    const path = join(folder, `data.${kind}`);
    const instance = await DuckDBInstance.create(':memory:');
    const conn = await instance.connect();
    const format = kind === 'parquet' ? 'parquet' : 'arrow';
    try {
      if (format === 'arrow') await conn.run('install arrow from community; load arrow').catch(() => undefined);
      await conn.run(
        `copy (select * from (values ('widget', 2), ('bolt', 7)) as t(name, qty)) ` +
          `to '${path.replace(/'/g, "''")}' (format ${format})`
      );
    } finally {
      conn.closeSync();
    }

    const file = await DuckDbFile.open(path);
    try {
      assert.equal(await file.updateCell('data', 'qty', 8, { name: 'bolt', qty: 7 }), 1);
    } finally {
      file.dispose();
    }
    assert.deepEqual(await stagingLeftIn(folder), []);

    const reopened = await DuckDbFile.open(path);
    try {
      assert.equal(await qtyOf(reopened, 'data', 'bolt'), '8');
      assert.equal(await qtyOf(reopened, 'data', 'widget'), '2');
    } finally {
      reopened.dispose();
    }
    if (kind === 'arrows') {
      const head = (await readFile(path)).subarray(0, 6).toString('latin1');
      assert.notEqual(head, 'ARROW1', 'a stream file was rewritten in the Feather file encoding');
    }
  });
}

test('EXT-01: after publication, a failed in-memory commit is not reported as a failed edit', async () => {
  const folder = await subdir('commit');
  const path = join(folder, 'late.csv');
  await writeFile(path, ROWS, 'utf8');
  const file = await DuckDbFile.open(path);
  try {
    await file.updateCell('late', 'qty', 8, { name: 'bolt', qty: 7 });

    // Fail the COMMIT once, after the file has already been renamed into place.
    const conn = (file as unknown as { connection: { run: (sql: string, ...rest: unknown[]) => Promise<unknown> } })
      .connection;
    const real = conn.run.bind(conn);
    let injected = false;
    conn.run = async (sql: string, ...rest: unknown[]) => {
      if (!injected && sql.trim().toLowerCase() === 'commit') {
        injected = true;
        throw new Error('injected: commit failed');
      }
      return real(sql, ...rest);
    };

    const changed = await file.updateCell('late', 'qty', 42, { name: 'bolt', qty: 8 });
    assert.ok(injected, 'the fault was never reached');
    assert.equal(changed, 1, 'an edit that reached the file was reported as not made');
    assert.match(await readFile(path, 'utf8'), /bolt,42/, 'the file does not hold the published edit');
    assert.equal(await qtyOf(file, 'late', 'bolt'), '42', 'the table was not brought in line with the file');
  } finally {
    file.dispose();
  }
});

test('EXT-01: a .dta opens read-only, says why, and refuses an edit', async (t) => {
  // Built by pandas in the Tier B corpus -- see E21 in integrityFindings.test.ts.
  // Compiled tests run from out-test/test; the corpus lives under the source tree.
  const fixture = [
    join(__dirname, '..', '..', 'test', 'stress', '_work', 'foreign', 'pandas.dta'),
    join(__dirname, '..', 'test', 'stress', '_work', 'foreign', 'pandas.dta'),
  ].find((p) => existsSync(p)) ?? '';
  if (!fixture) {
    t.skip('Tier B corpus not built: npm run stress:foreign');
    return;
  }
  const before = await readFile(fixture);
  const file = await DuckDbFile.open(fixture);
  try {
    assert.equal(file.isReadOnly(), true);
    assert.equal(file.isReadOnlyByFormat(), true);
    assert.ok(file.openWarnings.some((w) => /read-only/.test(w)), 'no open warning explains the read-only state');
    const result = await file.runQuery(`select * from "pandas" limit 1`);
    await assert.rejects(
      file.updateCell('pandas', result.columns[0], null, { [result.columns[0]]: result.rows[0][0] }),
      /read-only/
    );
  } finally {
    file.dispose();
  }
  assert.deepEqual(await readFile(fixture), before, 'the .dta changed');
});
