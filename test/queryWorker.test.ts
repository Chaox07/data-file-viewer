import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { QueryWorker } from '../src/queryWorker';
import { stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';

const probe = resolve('test/fixtures/queryWorkerProbe.cjs');

test('worker returns exact values and does not reuse request identities', async () => {
  const worker = new QueryWorker(probe);
  try {
    for (let i = 0; i < 100; i++) assert.deepEqual(await worker.call('echo', [[i, '9007199254740993']]), [i, '9007199254740993']);
  } finally { worker.dispose(); }
});

test('parent kills stalled worker, rejects pending work and permits a fresh worker', async () => {
  const worker = new QueryWorker(probe);
  try {
    const start = performance.now();
    await assert.rejects(worker.call('stall', [], 250), /timed out/);
    assert.ok(performance.now() - start < 2500);
    assert.equal(await worker.call('echo', [42]), 42);
  } finally { worker.dispose(); }
});

test('cancel stops an uncooperative worker within the hard deadline', async () => {
  const worker = new QueryWorker(probe);
  try {
    const pending = worker.call('stall', []);
    const rejected = assert.rejects(pending, /cancelled/);
    const start = performance.now();
    worker.cancel();
    await rejected;
    assert.ok(performance.now() - start < 5000);
    assert.equal(await worker.call('echo', [7]), 7);
  } finally { worker.dispose(); }
});

test('queue is bounded and disposal rejects work without leaving a live worker', async () => {
  const worker = new QueryWorker(probe);
  const pending = Array.from({ length: 8 }, () => assert.rejects(worker.call('stall', []), /closed/));
  await assert.rejects(worker.call('echo', [1]), /Too many queued/);
  worker.dispose();
  await Promise.all(pending);
  await assert.rejects(worker.call('echo', [1]), /closed/);
});

test('Cancel cannot deliver a late success, and workers do not inherit arbitrary secrets', async () => {
  process.env.DFV_SYNTHETIC_SECRET = 'SYNTHETIC_ONLY';
  const worker = new QueryWorker(probe);
  try {
    assert.equal(await worker.call('hasSecret', []), false);
    const running = worker.call('delayedEcho', ['stale result']);
    worker.cancel();
    await assert.rejects(running, /cancelled/);
    assert.equal(await worker.call('echo', ['fresh']), 'fresh');
  } finally { worker.dispose(); delete process.env.DFV_SYNTHETIC_SECRET; }
});

test('private worker scratch is removed after close and crash', async () => {
  for (const crash of [false, true]) {
    const worker = new QueryWorker(probe);
    try {
      const root = await worker.call<string>('cwd', []);
      if (process.platform !== 'win32') assert.equal((await stat(root)).mode & 0o777, 0o700);
      if (crash) await assert.rejects(worker.call('exit', []), /stopped/);
      else await worker.close();
      for (let i = 0; i < 100 && await stat(root).then(() => true, () => false); i++) await pause(10);
      await assert.rejects(stat(root), { code: 'ENOENT' });
    } finally { worker.dispose(); }
  }
});

test('worker pool evicts idle readers and refuses a fifth busy reader', async () => {
  const workers = Array.from({ length: 5 }, () => new QueryWorker(probe));
  try {
    for (const worker of workers) assert.equal(await worker.call('echo', [1]), 1);
    assert.equal(workers.filter(worker => worker.running).length, 4);
    for (const worker of workers) await worker.close();
    const blocked = workers.slice(0, 4).map(worker => assert.rejects(worker.call('stall', []), /cancelled/));
    await assert.rejects(workers[4].call('echo', [1]), /Four query runtimes/);
    for (const worker of workers) worker.cancel();
    await Promise.all(blocked);
    assert.equal(await workers[4].call('echo', [2]), 2);
  } finally { workers.forEach(worker => worker.dispose()); }
});

const spareOf = () => (QueryWorker as unknown as { spare?: { child: { pid?: number }; tempRoot: string } }).spare;
const pidOf = (worker: QueryWorker) => (worker as unknown as { child?: { pid?: number } }).child?.pid;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean) { for (let i = 0; i < 200 && !check(); i++) await pause(10); return check(); }

test('spare reader: started after a reply, claimed by the next start, not counted as busy, gone after the last disposal', async () => {
  const first = new QueryWorker(probe);
  const second = new QueryWorker(probe);
  let sparePid: number | undefined, spareRoot: string | undefined;
  try {
    assert.equal(await first.call('echo', [1]), 1);
    assert.ok(await until(() => spareOf() !== undefined), 'a spare is started once the reply settles');
    sparePid = spareOf()!.child.pid!;
    spareRoot = spareOf()!.tempRoot;
    assert.equal(second.running, false, 'the spare is not handed to anyone until needed');
    assert.equal(await second.call('echo', [2]), 2);
    assert.equal(pidOf(second), sparePid, 'the next start claimed the spare process');
    assert.equal(await second.call<string>('cwd', []), realpathSync(spareRoot), 'with its own private scratch directory');
    assert.ok(await until(() => spareOf() !== undefined && spareOf()!.child.pid !== sparePid), 'and a new spare replaces it');
    sparePid = spareOf()!.child.pid!;
    spareRoot = spareOf()!.tempRoot;
  } finally { first.dispose(); second.dispose(); }
  assert.equal(spareOf(), undefined, 'the last disposal releases the spare');
  assert.ok(await until(() => !alive(sparePid!)), 'the spare process is killed');
  for (let i = 0; i < 100 && await stat(spareRoot!).then(() => true, () => false); i++) await pause(10);
  await assert.rejects(stat(spareRoot!), { code: 'ENOENT' });
});

test('spare reader: a spare that died while idle is replaced by a fresh fork, not handed out', async () => {
  const first = new QueryWorker(probe);
  const second = new QueryWorker(probe);
  try {
    await first.call('echo', [1]);
    assert.ok(await until(() => spareOf() !== undefined));
    const pid = spareOf()!.child.pid!;
    process.kill(pid, 'SIGKILL');
    assert.ok(await until(() => spareOf() === undefined), 'a dead spare leaves the slot');
    assert.equal(await second.call('echo', [3]), 3);
    assert.notEqual(pidOf(second), pid);
  } finally { first.dispose(); second.dispose(); }
});
