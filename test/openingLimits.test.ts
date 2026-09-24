import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DuckDBConnection } from '@duckdb/node-api';
import { DuckDbFile } from '../src/duckdbConnection';
import { readerThreads } from '../src/queryPolicy';

test('CSV cache creation already has the reader memory, spill and thread limits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-cache-limits-'));
  const run = DuckDBConnection.prototype.run;
  const observed: unknown[][] = [];
  let file: DuckDbFile | undefined;
  DuckDBConnection.prototype.run = async function (...args: Parameters<typeof run>) {
    if (args[0].startsWith('create table "__dfv_load_')) {
      observed.push((await this.runAndReadAll("select current_setting('memory_limit'), current_setting('max_temp_directory_size'), current_setting('threads')")).getRows()[0]);
    }
    return run.apply(this, args);
  };
  try {
    const source = join(dir, 'data.csv');
    await writeFile(source, 'id,value\n1,10\n2,20\n');
    file = await DuckDbFile.open(source, undefined, { restrictedReads: true });
    assert.ok(observed.length > 0, 'the eager cache was exercised');
    for (const settings of observed) {
      assert.equal(settings[0], '488.2 MiB');
      assert.equal(settings[1], '0 bytes');
      assert.equal(Number(settings[2]), readerThreads());
    }
    assert.equal((await file.runQuery('select * from data')).rows.length, 2);
  } finally { DuckDBConnection.prototype.run = run; file?.dispose(); await rm(dir, { recursive: true, force: true }); }
});
