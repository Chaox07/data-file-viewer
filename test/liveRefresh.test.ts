import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveRefreshController, type LiveStatus } from '../src/liveRefresh';
import { FakeClock } from './fakeClock';

const INTERVAL = 1000;

interface Harness {
  clock: FakeClock;
  controller: LiveRefreshController;
  ticks: () => number;
  timeouts: () => number;
  statuses: LiveStatus[];
}

function harness(onTick: (generation: number) => Promise<void>, intervalMs = INTERVAL): Harness {
  const clock = new FakeClock();
  let ticks = 0;
  let timeouts = 0;
  const statuses: LiveStatus[] = [];
  const controller = new LiveRefreshController(
    intervalMs,
    {
      onTick: (generation) => {
        ticks++;
        return onTick(generation);
      },
      onTimeout: () => {
        timeouts++;
      },
      onStatus: (status) => statuses.push({ ...status }),
      onLog: () => {},
    },
    clock.timers
  );
  return { clock, controller, ticks: () => ticks, timeouts: () => timeouts, statuses };
}

/** Steps the clock forward until exactly `n` ticks have run. Steps are short enough that no backoff window can hide two. */
async function advanceUntilTicks(h: Harness, n: number, stepMs = 200): Promise<void> {
  for (let i = 0; i < 5_000 && h.ticks() < n; i++) await h.clock.advance(stepMs);
  assert.equal(h.ticks(), n, `expected exactly ${n} ticks`);
}

test('a tick that never settles is abandoned at its deadline, and scheduling continues', async () => {
  // The original failure: runTick awaited onTick with no bound, so `finally`
  // never ran, `running` stayed true, and live mode was dead for the session.
  const h = harness(() => new Promise<void>(() => {}));
  h.controller.start([]);

  await h.clock.advance(0);
  assert.equal(h.ticks(), 1, 'first tick starts');

  // Deadline is max(15s floor, 3 x interval).
  await h.clock.advance(14_999);
  assert.equal(h.timeouts(), 0, 'not abandoned before the deadline');

  await h.clock.advance(2);
  assert.equal(h.timeouts(), 1, 'the caller is asked to interrupt the in-flight query');

  await h.clock.advance(60_000);
  assert.ok(h.ticks() > 1, `scheduling continued (saw ${h.ticks()} ticks)`);
  h.controller.dispose();
});

test('a watch event cannot pull a tick in ahead of an active backoff', async () => {
  // The original failure: requestTick() computed its delay from intervalMs and
  // scheduleAt cleared the pending timer, so the writes causing the failures
  // cancelled the backoff built for exactly that case.
  const h = harness(async () => {
    throw new Error('lock contention');
  });
  h.controller.start([]);

  // Four consecutive failures => a backoff of min(30s, 1000 * 2^4) = 16s.
  await advanceUntilTicks(h, 4);
  const backoffStartedAt = h.clock.nowMs;

  // Hammer it with watch events the way an actively-writing process does — the
  // process generating them is the same one whose lock contention is causing
  // the failures, which is exactly why this case matters.
  for (let i = 0; i < 40; i++) {
    h.controller.notifyExternalChange();
    await h.clock.advance(100);
  }
  assert.equal(h.ticks(), 4, 'no tick ran inside the backoff window despite 40 watch events');

  const elapsed = h.clock.nowMs - backoffStartedAt;
  await h.clock.advance(16_000 - elapsed + 200);
  assert.equal(h.ticks(), 5, 'the tick does run once the backoff expires');
  h.controller.dispose();
});

test('stale is reported during the outage, not on recovery from it', async () => {
  // The original failure: `stale` only rode along with a liveTick message, and
  // a failing tick posts none — so the flag was unreachable during the very
  // outage it describes, then appeared once at the moment things recovered.
  let shouldFail = true;
  const h = harness(async () => {
    if (shouldFail) throw new Error('nope');
  });
  h.controller.start([]);

  await advanceUntilTicks(h, 3);

  const duringOutage = h.statuses.at(-1);
  assert.ok(duringOutage, 'a status was pushed without any tick result to carry it');
  assert.equal(duringOutage.stale, true, 'stale while still failing');
  assert.equal(duringOutage.failureCount, 3);
  assert.match(String(duringOutage.lastError), /nope/);

  shouldFail = false;
  await advanceUntilTicks(h, 4);
  const afterRecovery = h.statuses.at(-1)!;
  assert.equal(afterRecovery.stale, false, 'cleared on recovery, not raised by it');
  assert.equal(afterRecovery.failureCount, 0);
  assert.ok(afterRecovery.lastSuccessMs !== undefined);
  h.controller.dispose();
});

test('a change arriving during a running tick is honoured once that tick lands', async () => {
  let release: (() => void) | undefined;
  const h = harness(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
  );
  h.controller.start([]);

  await h.clock.advance(0);
  assert.equal(h.ticks(), 1);

  // Arrives while tick 1 is still in flight. Previously the timer fired into a
  // busy controller and the event was simply dropped.
  h.controller.notifyExternalChange();
  await h.clock.advance(200);
  assert.equal(h.ticks(), 1, 'no overlapping tick');

  release!();
  await h.clock.advance(INTERVAL + 50);
  assert.equal(h.ticks(), 2, 'the pending change produced a tick after the first completed');
  h.controller.dispose();
});

test('successive ticks respect the interval as a minimum spacing floor', async () => {
  const h = harness(async () => {});
  h.controller.start([]);
  await h.clock.advance(0);
  assert.equal(h.ticks(), 1);

  // A burst of events cannot produce more than one tick per interval.
  for (let i = 0; i < 20; i++) {
    h.controller.notifyExternalChange();
    await h.clock.advance(10);
  }
  assert.equal(h.ticks(), 1, 'burst coalesced into the pending tick');

  await h.clock.advance(INTERVAL);
  assert.equal(h.ticks(), 2);
  h.controller.dispose();
});

test('shortening the interval reschedules the pending tick', async () => {
  const h = harness(async () => {}, 60_000);
  h.controller.start([]);
  await h.clock.advance(0);
  assert.equal(h.ticks(), 1);

  h.controller.setIntervalMs(250);
  await h.clock.advance(300);
  assert.equal(h.ticks(), 2, 'did not wait out the old 60s delay');
  h.controller.dispose();
});

test('a tick abandoned at its deadline can no longer post its result', async () => {
  // Generation guard: an abandoned tick may still settle later, and must not
  // overwrite the view with data the scheduler already gave up on.
  let firstGeneration: number | undefined;
  const h = harness(
    (generation) =>
      new Promise<void>(() => {
        firstGeneration ??= generation;
      })
  );
  h.controller.start([]);
  await h.clock.advance(0);
  assert.equal(h.controller.isCurrentGeneration(firstGeneration!), true, 'current while running');

  // Retired at the deadline itself, not merely once the next tick starts —
  // otherwise the abandoned tick could still post during the backoff window.
  await h.clock.advance(15_001);
  assert.equal(h.timeouts(), 1);
  assert.equal(h.controller.isCurrentGeneration(firstGeneration!), false, 'stale the moment it is abandoned');
  h.controller.dispose();
});

test('dispose stops scheduling entirely', async () => {
  const h = harness(async () => {});
  h.controller.start([]);
  await h.clock.advance(0);
  const seen = h.ticks();
  h.controller.dispose();
  await h.clock.advance(120_000);
  assert.equal(h.ticks(), seen, 'no ticks after dispose');
});
