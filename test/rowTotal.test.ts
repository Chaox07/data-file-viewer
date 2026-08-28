import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { DuckDbFile } from '../src/duckdbConnection';

/**
 * countMatchingRows is what turns "146 rows shown" into "146 of 146 rows
 * shown". The distinction it has to get right is between a LIMIT the user
 * typed (strip it — they want to know what is behind it) and a WHERE they
 * typed (keep it — the filter is part of the question).
 */

let dir: string;
let dbPath: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dfv-total-'));
  dbPath = join(dir, 'fixture.duckdb');
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  // 146 rows, matching the real macro_*.xlsx sheet that prompted this.
  await connection.run(`create table t as select i as id, i % 7 as bucket from range(1, 147) s(i)`);
  connection.closeSync();
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function withFile<T>(fn: (file: DuckDbFile) => Promise<T>): Promise<T> {
  const file = await DuckDbFile.open(dbPath);
  try {
    return await fn(file);
  } finally {
    file.dispose();
  }
}

test('a LIMIT above the row count still reports the true total', async () => {
  // The exact case that prompted this: `limit 200` on 146 rows returned 146,
  // and the footer could not say whether that was everything.
  await withFile(async (file) => {
    const result = await file.runQuery('select * from t limit 200');
    assert.equal(result.rows.length, 146);
    assert.equal(await file.countMatchingRows('select * from t limit 200'), 146);
  });
});

test('a LIMIT below the row count reports what is behind it', async () => {
  await withFile(async (file) => {
    const result = await file.runQuery('select * from t limit 10');
    assert.equal(result.rows.length, 10);
    assert.equal(await file.countMatchingRows('select * from t limit 10'), 146);
  });
});

test('a WHERE clause is counted, not stripped', async () => {
  // The total worth showing is "rows your query matches", not "rows the table
  // holds" — stripping the filter would answer a question nobody asked.
  await withFile(async (file) => {
    assert.equal(await file.countMatchingRows('select * from t where bucket = 0'), 20);
    assert.equal(await file.countMatchingRows('select * from t where bucket = 0 limit 5'), 20);
  });
});

test('LIMIT with OFFSET, and a trailing semicolon, are both handled', async () => {
  await withFile(async (file) => {
    assert.equal(await file.countMatchingRows('select * from t limit 10 offset 100'), 146);
    assert.equal(await file.countMatchingRows('select * from t limit 10;'), 146);
  });
});

test('a LIMIT inside the query\'s own logic is left alone', async () => {
  // Only the trailing LIMIT is the viewer's to strip. One nested in a
  // subquery is part of what the query means.
  await withFile(async (file) => {
    const sql = 'select * from (select * from t order by id limit 5) as inner_q';
    assert.equal(await file.countMatchingRows(sql), 5, 'an inner LIMIT must survive counting');
  });
});

test('queries with no LIMIT at all count correctly', async () => {
  await withFile(async (file) => {
    assert.equal(await file.countMatchingRows('select * from t'), 146);
    assert.equal(await file.countMatchingRows('select count(*) from t'), 1);
  });
});

test('an aggregate reports its own row count, not the underlying table\'s', async () => {
  await withFile(async (file) => {
    assert.equal(await file.countMatchingRows('select bucket, count(*) from t group by bucket'), 7);
  });
});

test('a query the wrapper cannot count returns undefined rather than throwing', async () => {
  // A count is a nicety. Whatever happens here, the rows still have to show.
  await withFile(async (file) => {
    assert.equal(await file.countMatchingRows('this is not sql'), undefined);
    assert.equal(await file.countMatchingRows('select * from no_such_table'), undefined);
  });
});
