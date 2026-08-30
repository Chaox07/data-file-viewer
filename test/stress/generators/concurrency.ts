// The stub patches Module._load, so it must be imported before anything that
// reaches duckdbEditorProvider -- which is why this import sits first and is
// not merged into the group below.
import '../stubs/vscode';

import { join } from 'node:path';
import { DuckDBDocument } from '../../../src/duckdbEditorProvider';
import { DuckDbFile } from '../../../src/duckdbConnection';
import { registerCase } from '../expect';
import { readTable } from '../harness/inspect';
import * as w from './_write';

/**
 * The connection lock, and everything that races for it.
 *
 * `DuckDBDocument.runExclusive` / `tryRunExclusive` / `lockChain` exist for a
 * failure the extension host cannot survive, spelled out in their own comment:
 * a live tick's reconnect can dispose the connection that a runQuery or
 * updateCell handler is still awaiting, which is a use-after-close in native
 * code -- it takes the host down rather than raising something catchable.
 *
 * None of it had any tests, because the file imports `vscode`. It is reachable
 * now via stubs/vscode.ts.
 *
 * Two behaviours are being separated here and they are easy to conflate:
 *
 *   runExclusive     QUEUES. User-initiated work must never be dropped.
 *   tryRunExclusive  YIELDS. A live tick that finds the connection busy gives
 *                    up, because by the time a queued tick ran the scheduler
 *                    would already want a newer one, and a backlog of stale
 *                    ticks is what the interval floor exists to prevent.
 *
 * A change that made the second one queue would look correct in every
 * single-threaded test and produce exactly the backlog the design rules out.
 */

const SPEC: w.TableSpec = {
  name: 'data',
  columns: [
    { name: 'id', type: 'INTEGER' },
    { name: 'label', type: 'VARCHAR' },
  ],
  rows: Array.from({ length: 200 }, (_, i) => [i, `row ${i}`]),
};

/**
 * A document over a file that already exists.
 *
 * The runner has opened and disposed its own handle by the time this runs, so
 * the document gets a fresh connection to the same path -- which is what the
 * provider does for real.
 */
async function documentFor(path: string): Promise<DuckDBDocument> {
  const file = await DuckDbFile.open(path);
  const uri = { fsPath: path } as unknown as ConstructorParameters<typeof DuckDBDocument>[0];
  return new DuckDBDocument(uri, file);
}

/** Work queued on the lock runs one at a time, in order, and never overlaps. */
registerCase({
  name: 'concurrency_exclusive_work_does_not_overlap',
  family: 'concurrency',
  expect: { note: 'twenty queued jobs run one at a time, in submission order' },
  build: async (ctx) => ({ path: await w.duckdbFile(join(ctx.dir, 'seed.duckdb'), [SPEC]) }),
  check: async (file, ctx, built) => {
    file.dispose();
    const doc = await documentFor(built.path);
    try {
      let inFlight = 0;
      let maxInFlight = 0;
      const order: number[] = [];

      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          doc.runExclusive(async () => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            // A real await, so an implementation that only looks serial
            // because nothing yields is not let off.
            await doc.file.runQuery('select count(*) from "data"');
            order.push(i);
            inFlight--;
          })
        )
      );

      if (maxInFlight > 1) {
        ctx.fail(
          'crash',
          `${maxInFlight} jobs held the connection at once — this is the use-after-close the lock exists to prevent`
        );
      }
      const expected = Array.from({ length: 20 }, (_, i) => i);
      if (order.join(',') !== expected.join(',')) {
        ctx.fail('crash', `queued work ran out of order: [${order.join(', ')}]`);
      }
      if (doc.isBusy()) {
        ctx.fail('crash', 'the lock still reports busy after every job finished');
      }
    } finally {
      doc.file.dispose();
    }
  },
});

/**
 * A job that THROWS must not wedge the queue.
 *
 * The chain is settled on both arms for exactly this reason; without it one
 * rejected promise leaves every later job waiting on it forever, and the file
 * simply stops responding with no error anywhere.
 */
registerCase({
  name: 'concurrency_a_failed_job_does_not_wedge_the_queue',
  family: 'concurrency',
  expect: { note: 'a job that throws still lets the next one run, and clears the busy flag' },
  build: async (ctx) => ({ path: await w.duckdbFile(join(ctx.dir, 'seed.duckdb'), [SPEC]) }),
  check: async (file, ctx, built) => {
    file.dispose();
    const doc = await documentFor(built.path);
    try {
      await doc.runExclusive(async () => {
        throw new Error('deliberate');
      }).catch(() => undefined);

      if (doc.isBusy()) {
        ctx.fail('crash', 'the lock is still held after a job threw');
      }

      const after = await Promise.race([
        doc.runExclusive(async () => 'ran'),
        new Promise<string>((resolve) => setTimeout(() => resolve('WEDGED'), 2000)),
      ]);
      if (after !== 'ran') {
        ctx.fail('crash', 'the queue was wedged by a failed job: nothing after it ever ran');
      }

      // And a whole run of failures, since one is the easy case.
      for (let i = 0; i < 10; i++) {
        await doc.runExclusive(async () => {
          throw new Error(`deliberate ${i}`);
        }).catch(() => undefined);
      }
      if (doc.isBusy()) {
        ctx.fail('crash', 'the lock is still held after ten consecutive failures');
      }
    } finally {
      doc.file.dispose();
    }
  },
});

/**
 * tryRunExclusive yields rather than queueing.
 *
 * The distinction that matters: while user work holds the lock, a live tick
 * must report `ran: false` and get out of the way. If it queued instead, a
 * slow query would accumulate a tick per interval behind it.
 */
registerCase({
  name: 'concurrency_live_tick_yields_instead_of_queueing',
  family: 'concurrency',
  expect: { note: 'a live tick finding the connection busy yields, and does not stack up behind it' },
  build: async (ctx) => ({ path: await w.duckdbFile(join(ctx.dir, 'seed.duckdb'), [SPEC]) }),
  check: async (file, ctx, built) => {
    file.dispose();
    const doc = await documentFor(built.path);
    try {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const user = doc.runExclusive(async () => {
        await held;
        return 'user work';
      });

      // Ten ticks arriving while the connection is busy. Every one must yield.
      const ticks = await Promise.all(
        Array.from({ length: 10 }, () => doc.tryRunExclusive(async () => 'tick'))
      );
      const ran = ticks.filter((t) => t.ran).length;
      if (ran !== 0) {
        ctx.fail(
          'crash',
          `${ran} of 10 live ticks queued behind busy user work instead of yielding — ` +
            `this is the stale-tick backlog the interval floor exists to prevent`
        );
      }

      release();
      await user;

      // And once the connection is free, a tick must actually run: a
      // tryRunExclusive that always yields would pass the assertion above.
      const afterwards = await doc.tryRunExclusive(async () => 'tick');
      if (!afterwards.ran) {
        ctx.fail('crash', 'a live tick yielded even with the connection idle');
      }
    } finally {
      doc.file.dispose();
    }
  },
});

/**
 * A live tick must not dispose a connection that queued work is awaiting.
 *
 * The exact shape from the lock's own comment, run for real: user work in
 * flight, a reconnect attempted underneath it. What must NOT happen is the
 * query resolving against a closed connection.
 */
registerCase({
  name: 'concurrency_refresh_does_not_close_a_connection_in_use',
  family: 'concurrency',
  expect: { note: 'a refresh attempted while a query is in flight does not close it underneath' },
  build: async (ctx) => ({ path: await w.duckdbFile(join(ctx.dir, 'seed.duckdb'), [SPEC]) }),
  check: async (file, ctx, built) => {
    file.dispose();
    const doc = await documentFor(built.path);
    try {
      const queries = doc.runExclusive(async () => {
        const out: number[] = [];
        for (let i = 0; i < 25; i++) {
          const r = await doc.file.runQuery('select count(*) from "data"');
          out.push(Number(r.rows[0][0]));
        }
        return out;
      });

      // A tick trying to reconnect at the same moment. It must yield.
      const tick = await doc.tryRunExclusive(async () => {
        await doc.file.refreshInPlace();
        return 'refreshed';
      });
      if (tick.ran) {
        ctx.fail(
          'crash',
          'a refresh ran while a query was in flight — the connection could be disposed under it'
        );
      }

      const counts = await queries;
      if (counts.some((c) => c !== SPEC.rows.length)) {
        ctx.fail(
          'silent-misread',
          `queries returned ${[...new Set(counts)].join(', ')} where every one should be ${SPEC.rows.length}`
        );
      }
    } finally {
      doc.file.dispose();
    }
  },
});

/** The stats cache must stay bounded, and evict oldest-first. */
registerCase({
  name: 'concurrency_stats_cache_is_bounded',
  family: 'concurrency',
  expect: { note: 'the stats cache caps at 50 entries and evicts the oldest' },
  build: async (ctx) => ({ path: await w.duckdbFile(join(ctx.dir, 'seed.duckdb'), [SPEC]) }),
  check: async (file, ctx, built) => {
    file.dispose();
    const doc = await documentFor(built.path);
    try {
      for (let i = 0; i < 200; i++) {
        doc.setStatsCache(`numeric:col${i}`, {
          totalRows: i,
          nonNullRows: i,
          nullCount: 0,
          distinctCount: i,
          topValues: [],
        });
      }
      if (doc.statsCache.size > 50) {
        ctx.fail('crash', `the stats cache grew to ${doc.statsCache.size} entries; the cap is 50`);
      }
      if (doc.statsCache.has('numeric:col0')) {
        ctx.fail('crash', 'the oldest entry survived 200 insertions into a 50-entry cache');
      }
      if (!doc.statsCache.has('numeric:col199')) {
        ctx.fail('crash', 'the newest entry was evicted instead of the oldest');
      }
      // Re-inserting an existing key must not evict anything.
      const sizeBefore = doc.statsCache.size;
      doc.setStatsCache('numeric:col199', {
        totalRows: 1,
        nonNullRows: 1,
        nullCount: 0,
        distinctCount: 1,
        topValues: [],
      });
      if (doc.statsCache.size !== sizeBefore) {
        ctx.fail('crash', 'overwriting an existing key changed the cache size');
      }
    } finally {
      doc.file.dispose();
    }
  },
});

/**
 * Two independent opens of the same file.
 *
 * A .duckdb takes a write lock, so the second open has to fall back to
 * read-only rather than failing -- which is what live-refresh reconnects rely
 * on. Both handles must then read the same data.
 */
registerCase({
  name: 'concurrency_two_opens_of_one_file',
  family: 'concurrency',
  expect: { note: 'a second open of a locked .duckdb falls back to read-only and reads the same rows' },
  build: async (ctx) => ({ path: await w.duckdbFile(join(ctx.dir, 'two.duckdb'), [SPEC]) }),
  check: async (file, ctx, built) => {
    const first = await readTable(file, 'data');
    let second: DuckDbFile | undefined;
    try {
      second = await DuckDbFile.open(built.path);
      const other = await readTable(second, 'data');
      if (other.rows.length !== first.rows.length) {
        ctx.fail(
          'silent-misread',
          `the two handles disagree: ${first.rows.length} rows vs ${other.rows.length}`
        );
      }
    } catch (err) {
      ctx.fail(
        'crash',
        `a second open of an already-open file failed outright: ${
          err instanceof Error ? err.message.split('\n')[0] : String(err)
        }`
      );
    } finally {
      second?.dispose();
    }
  },
});

/**
 * An edit and a refresh interleaved.
 *
 * The edit is user work and must not be dropped; the refresh must not run
 * underneath it. What is being ruled out is the edit reporting success and
 * then being discarded by a reconnect that replaced the connection.
 */
registerCase({
  name: 'concurrency_edit_survives_a_concurrent_refresh',
  family: 'concurrency',
  expect: { note: 'an edit made while refreshes are firing is still in the file afterwards' },
  build: async (ctx) => ({ path: await w.duckdbFile(join(ctx.dir, 'edit.duckdb'), [SPEC]) }),
  check: async (file, ctx, built) => {
    file.dispose();
    const doc = await documentFor(built.path);
    try {
      const table = await doc.runExclusive(() => readTable(doc.file, 'data'));
      const rowValues: Record<string, unknown> = {};
      table.columns.forEach((c, i) => {
        rowValues[c] = table.rows[5][i];
      });

      const edit = doc.runExclusive(() => doc.file.updateCell('data', 'label', 'EDITED', rowValues));
      // Ticks firing throughout the edit, as live mode would.
      const ticks = await Promise.all(
        Array.from({ length: 5 }, () => doc.tryRunExclusive(() => doc.file.refreshInPlace()))
      );
      const changed = await edit;

      if (changed !== 1) {
        ctx.fail('lost-edit', `the edit reported ${changed} rows changed, expected 1`);
      }
      if (ticks.some((t) => t.ran)) {
        ctx.fail('crash', 'a refresh ran during the edit rather than yielding to it');
      }

      const after = await doc.runExclusive(() => readTable(doc.file, 'data'));
      if (after.rows[5][1] !== 'EDITED') {
        ctx.fail(
          'lost-edit',
          `the edit is not there after the refreshes: row 5 reads ${JSON.stringify(after.rows[5][1])}`
        );
      }
    } finally {
      doc.file.dispose();
    }
  },
});
