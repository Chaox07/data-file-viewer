import type { LiveRefreshTimers } from '../src/liveRefresh';

/**
 * Virtual clock for the scheduler tests. Every bug these tests cover is about
 * *when* something is allowed to happen — a 30s backoff, a 15s deadline — so
 * driving them off real time would mean either a minutes-long suite or
 * timing-dependent flakes. Advancing a fake clock makes the assertions exact.
 */
export class FakeClock {
  private time = 0;
  private seq = 0;
  private readonly tasks = new Map<number, { at: number; order: number; fn: () => void }>();

  readonly timers: LiveRefreshTimers = {
    now: () => this.time,
    setTimeout: (fn, ms) => {
      const id = ++this.seq;
      this.tasks.set(id, { at: this.time + Math.max(0, ms), order: id, fn });
      return id;
    },
    clearTimeout: (handle) => {
      this.tasks.delete(handle as number);
    },
  };

  get nowMs(): number {
    return this.time;
  }

  /**
   * Runs every callback due within the window, in scheduled order.
   *
   * Microtasks are drained *before* each pick, not just after each callback:
   * the code under test schedules its next timer from a promise continuation,
   * so a pass that only drained afterwards would miss a timer that became due
   * during the window and report a tick that did happen as one that didn't.
   */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (let guard = 0; guard < 100_000; guard++) {
      await drainMicrotasks();
      const next = this.nextDueBy(target);
      if (!next) {
        if (this.time >= target) return;
        // Jump to the end of the window, then loop once more so anything
        // scheduled for exactly that instant still runs.
        this.time = target;
        continue;
      }
      this.tasks.delete(next.id);
      this.time = Math.max(this.time, next.at);
      next.fn();
    }
    throw new Error('fake clock did not settle — a timer is rescheduling itself with no delay');
  }

  private nextDueBy(target: number): { id: number; at: number; order: number; fn: () => void } | undefined {
    let next: { id: number; at: number; order: number; fn: () => void } | undefined;
    for (const [id, task] of this.tasks) {
      if (task.at > target) continue;
      if (!next || task.at < next.at || (task.at === next.at && task.order < next.order)) {
        next = { id, ...task };
      }
    }
    return next;
  }
}

/** setImmediate lands after the microtask queue, so awaiting it flushes any pending promise chains. */
export function drainMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
