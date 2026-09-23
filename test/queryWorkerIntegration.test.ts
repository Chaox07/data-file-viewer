import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { QueryWorker } from '../src/queryWorker';

test('real read worker queries its document, refuses writes and recovers from cancellation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-worker-'));
  const worker = new QueryWorker(resolve('out-test/src/queryWorkerEntry.js'));
  try {
    const source = join(dir, 'data.csv');
    await writeFile(source, 'id,value\n1,10\n2,20\n');
    await worker.call('open', [source]);
    const result = await worker.call<any>('runQuery', ['select * from data where id=2']);
    assert.equal(Number(result.value.rows[0][1]), 20);
    await assert.rejects(worker.call('updateCell', ['data', 'value', 99, { id: 1 }]), /not available/);
    await assert.rejects(worker.call('runQuery', ['select * from duckdb_databases()']), /unavailable/);
    const running = worker.call('runQuery', ['select sum(sin(i)) from range(10000000000) t(i)']);
    await Promise.all([
      assert.rejects(running, /cancel|stopped/i),
      new Promise<void>(resolve => setTimeout(() => { worker.cancel(); resolve(); }, 100)),
    ]);
  } finally { worker.dispose(); await rm(dir, { recursive: true, force: true }); }
});
