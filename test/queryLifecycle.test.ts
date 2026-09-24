import vscodeStub from './stress/stubs/vscode';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DuckDBDocument } from '../src/duckdbEditorProvider';
import type { DocumentFile } from '../src/viewerFile';

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test('trust is checked when queued work starts, after earlier work releases the connection', async () => {
  const workspace = vscodeStub.workspace as typeof vscodeStub.workspace & { isTrusted?: boolean };
  const prior = workspace.isTrusted;
  workspace.isTrusted = true;
  const entered = latch(), held = latch();
  const doc = new DuckDBDocument(vscodeStub.Uri.file('/synthetic.csv') as any, {
    interruptCurrentQuery() {}, dispose() {},
  } as unknown as DocumentFile);
  try {
    const first = doc.runExclusive(async () => { entered.release(); await held.promise; });
    await entered.promise;
    let accessed = false;
    const queued = assert.rejects(doc.runExclusive(async () => { accessed = true; }), /Trust this workspace/);
    workspace.isTrusted = false;
    held.release();
    await Promise.all([first, queued]);
    assert.equal(accessed, false);
  } finally { held.release(); workspace.isTrusted = prior; doc.dispose(); }
});

test('closing a document drains an active save before disposing and refuses queued work', async () => {
  const entered = latch(), held = latch(), closed = latch();
  let disposed = 0, released = 0, completed = false;
  const doc = new DuckDBDocument(vscodeStub.Uri.file('/synthetic.csv') as any, {
    interruptCurrentQuery() {}, dispose() { assert.equal(completed, true); disposed++; },
  } as unknown as DocumentFile, () => { released++; closed.release(); });
  const save = doc.runExclusive(async () => { entered.release(); await held.promise; completed = true; });
  await entered.promise;
  let accessed = false;
  const queued = assert.rejects(doc.runExclusive(async () => { accessed = true; }), /closed/);
  doc.dispose(); doc.dispose();
  assert.equal(disposed, 0);
  assert.equal(released, 0);
  held.release();
  await Promise.all([save, queued, closed.promise]);
  assert.equal(accessed, false);
  assert.equal(disposed, 1);
  assert.equal(released, 1);
});

test('queue counts distinct jobs even when they share a supersession predicate', async () => {
  const held = latch();
  const doc = new DuckDBDocument(vscodeStub.Uri.file('/synthetic.csv') as any, {
    interruptCurrentQuery() {}, dispose() {},
  } as unknown as DocumentFile);
  const current = () => false;
  try {
    const outcomes = Array.from({ length: 9 }, () => doc.runExclusive(() => held.promise, current).then(() => 'ran', () => 'refused'));
    held.release();
    assert.deepEqual(await Promise.all(outcomes), [...Array(8).fill('ran'), 'refused']);
  } finally { held.release(); doc.dispose(); }
});
