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

test('a claimed spare reader opens only the file it is sent, and its predecessor document is untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dfv-worker-'));
  const entry = resolve('out-test/src/queryWorkerEntry.js');
  const a = new QueryWorker(entry), b = new QueryWorker(entry);
  const spareOf = () => (QueryWorker as unknown as { spare?: { child: { pid?: number } } }).spare;
  try {
    await writeFile(join(dir, 'first.csv'), 'id\n1\n');
    await writeFile(join(dir, 'second.csv'), 'id\n2\n');
    await a.call('open', [join(dir, 'first.csv')]);
    for (let i = 0; i < 200 && !spareOf(); i++) await new Promise(r => setTimeout(r, 10));
    const sparePid = spareOf()?.child.pid;
    assert.ok(sparePid, 'a spare was started');
    await b.call('open', [join(dir, 'second.csv')]);
    assert.equal((b as unknown as { child?: { pid?: number } }).child?.pid, sparePid);
    const rows = await b.call<any>('runQuery', ['select * from second']);
    assert.equal(Number(rows.value.rows[0][0]), 2);
    await assert.rejects(b.call('runQuery', [`select * from read_csv('${join(dir, 'first.csv')}')`]), /not allowed|unavailable|Permission|not available/i);
    await assert.rejects(b.call('open', [join(dir, 'first.csv')]), /already owns/);
    assert.equal(Number((await a.call<any>('runQuery', ['select * from first'])).value.rows[0][0]), 1);
  } finally { a.dispose(); b.dispose(); await rm(dir, { recursive: true, force: true }); }
});
