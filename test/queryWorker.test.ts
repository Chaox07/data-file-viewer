import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { QueryWorker } from '../src/queryWorker';

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
