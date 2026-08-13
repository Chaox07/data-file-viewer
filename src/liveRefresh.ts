import { watch, FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';

/** Pushed on every state transition, so a failure reaches the UI *while* it's
 *  happening rather than only riding along with the next successful tick. */
export interface LiveStatus {
  stale: boolean;
  failureCount: number;
  lastError: string | undefined;
  lastSuccessMs: number | undefined;
}

export interface LiveRefreshCallbacks {
  /** Does the actual reconnect+query+post work for one tick. Throwing marks the tick as failed (drives backoff). */
  onTick: (generation: number) => Promise<void>;
  /**
   * A tick has overrun its deadline and is being abandoned. The caller's job
   * is to unblock whatever it has in flight (interrupt the query) — the
   * scheduler does not wait for that to take effect, and does not wait for
   * the abandoned onTick promise to settle either.
   */
  onTimeout: () => void;
  onStatus: (status: LiveStatus) => void;
  onLog: (message: string) => void;
}

/** Clock/timer seam. Exists so the scheduling logic below is testable without real waiting. */
export interface LiveRefreshTimers {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const REAL_TIMERS: LiveRefreshTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/**
 * Drives the "when do we re-check this document" decision for live mode —
 * the *what happens on a tick* is entirely the caller's (onTick), this only
 * decides *when* to call it.
 *
 * Combines two ideas that must be designed as one mechanism, not two
 * independent timers (see the design notes): a short debounce that collapses
 * multi-event write bursts, and the refresh interval doubling as a minimum
 * spacing floor between ticks. Implemented as two separate reset-on-event
 * timers, a writer hammering the file faster than the debounce window would
 * keep resetting it forever — the classic "debounce that never fires under
 * continuous input" bug. Instead: every watch event during a burst is
 * coalesced into a single pending tick request that's guaranteed to fire
 * within `intervalMs` of the first event in the burst (the max-wait cap),
 * and once fired, actual execution still respects the minimum spacing floor
 * relative to the previous tick.
 *
 * Three invariants the rest of this class exists to hold, each of which was
 * violated by an earlier design:
 *
 *  1. **A tick always reschedules.** No tick may await anything unbounded.
 *     Without the deadline below, a query blocking on lock contention meant
 *     the await never returned, so the reschedule in `finally` never ran, so
 *     live mode was silently dead for the rest of the session.
 *  2. **Backoff is a floor, not a suggestion.** Scheduling is expressed as an
 *     absolute "not before" timestamp rather than a delay, because the process
 *     whose writes generate the watch events is usually the same process whose
 *     lock contention caused the failures — computing delays against
 *     `intervalMs` let those events cancel the backoff built for exactly that
 *     situation.
 *  3. **Failure is observable.** Status is pushed on transition, not carried
 *     by a tick's result, since the ticks that most need reporting are the
 *     ones that produce no result at all.
 */
export class LiveRefreshController {
  private timer: unknown;
  private coalesceTimer: unknown;
  private watchers: FSWatcher[] = [];
  private disposed = false;
  private running = false;
  private lastTickAt = 0;
  private lastSuccessAt: number | undefined;
  private coalesceStartedAt = 0;
  private failureCount = 0;
  private lastError: string | undefined;
  private watchedPaths: string[] = [];
  private watchedNames = new Set<string>();
  /** Absolute "no tick before this time" deadline — the backoff floor (invariant 2). */
  private earliestNextTickAt = 0;
  /** A change arrived while a tick was already running; honour it once that tick lands. */
  private pendingRequest = false;
  /** Bumped per tick and on stop/dispose, so an abandoned tick that settles late can't post. */
  private generation = 0;
  private rearmWatchersAt = 0;

  private static readonly DEBOUNCE_MS = 75;
  private static readonly STALE_AFTER_FAILURES = 3;
  private static readonly MAX_BACKOFF_MS = 30_000;
  /** A tick gets 3 intervals, but never less than this — a 250ms interval doesn't make a 750ms query "hung". */
  private static readonly MIN_TICK_TIMEOUT_MS = 15_000;
  private static readonly WATCHER_REARM_MS = 60_000;

  constructor(
    private intervalMs: number,
    private readonly callbacks: LiveRefreshCallbacks,
    private readonly timers: LiveRefreshTimers = REAL_TIMERS
  ) {}

  setIntervalMs(ms: number): void {
    if (ms === this.intervalMs) return;
    this.intervalMs = ms;
    // The pending timer was computed against the old interval, so without
    // this a 60s -> 0.25s change would still wait out the old 60s in full.
    if (!this.running && this.timer !== undefined) this.requestTick();
  }

  start(watchedPaths: string[]): void {
    this.watchedPaths = watchedPaths;
    this.setupWatchers();
    this.scheduleFor(0);
  }

  stop(): void {
    // Anything already in flight is now uninteresting; make sure it can't
    // post a result against a controller that's been stopped.
    this.generation++;
    this.pendingRequest = false;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.coalesceTimer !== undefined) this.timers.clearTimeout(this.coalesceTimer);
    this.coalesceTimer = undefined;
    this.closeWatchers();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  isStale(): boolean {
    return this.failureCount >= LiveRefreshController.STALE_AFTER_FAILURES;
  }

  /**
   * True while `generation` is still the tick the caller was invoked for.
   * Callers check this before posting anything: a tick abandoned at its
   * deadline may still settle later, and it must not overwrite the view with
   * data the scheduler has already given up on.
   */
  isCurrentGeneration(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  /** A change was observed by something other than our own watchers (or, in tests, directly). */
  notifyExternalChange(): void {
    this.onWatchEvent();
  }

  private closeWatchers(): void {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // Already closed/never opened successfully — nothing to do.
      }
    }
    this.watchers = [];
  }

  /**
   * Watches the *directories* containing the paths of interest, not the paths
   * themselves. Three things fall out of that, all of which the per-file
   * version got wrong:
   *   - a writer doing atomic write-then-rename replaces the inode, and a
   *     per-file watch keeps reporting on the old, unlinked one — live but
   *     deaf, with no error to notice it by;
   *   - `-wal`/`-shm` files usually don't exist yet when Live starts, so
   *     watching them by name threw ENOENT and was never retried, which meant
   *     the file whose mtime actually moves in SQLite WAL mode was unwatched
   *     for the whole session;
   *   - it collapses up to six per-file handles into one per directory.
   */
  private setupWatchers(): void {
    this.closeWatchers();
    this.watchedNames = new Set(this.watchedPaths.map((p) => basename(p)));
    const dirs = new Set(this.watchedPaths.map((p) => dirname(p)));
    for (const dir of dirs) {
      try {
        const watcher = watch(dir, { persistent: false }, (_eventType, filename) => {
          // Some platforms don't report a filename. Treating that as "something
          // in this directory changed" costs at most one stat-gated tick;
          // dropping it would lose the event entirely.
          if (filename === null || filename === undefined) {
            this.onWatchEvent();
            return;
          }
          if (this.watchedNames.has(basename(String(filename)))) this.onWatchEvent();
        });
        watcher.on('error', () => {
          // Don't let a dead watcher take live mode down — the timer fallback
          // keeps it alive regardless. Mark it for re-arming at the first
          // opportunity rather than leaving it dead for the session.
          this.callbacks.onLog(`watcher error on ${dir} — re-arming, timer fallback covers the gap`);
          this.rearmWatchersAt = 0;
        });
        this.watchers.push(watcher);
      } catch {
        // Setup itself failing (directory doesn't exist, or the OS-wide
        // watch-handle limit was hit by several Live tabs at once) is just as
        // recoverable — the timer fallback covers it the same way, and the
        // periodic re-arm will try again.
        this.callbacks.onLog(`could not watch ${dir} — relying on timer fallback`);
        this.rearmWatchersAt = 0;
      }
    }
    this.rearmWatchersAt = this.timers.now() + LiveRefreshController.WATCHER_REARM_MS;
  }

  /**
   * Periodic re-arm, on every tick rather than only after a failure. A
   * watcher can stop delivering without ever erroring, which by definition
   * produces no failure to hang a recovery off — so the recovery can't be
   * conditioned on one.
   */
  private maybeRearmWatchers(): void {
    if (this.watchedPaths.length === 0) return;
    if (this.timers.now() < this.rearmWatchersAt) return;
    this.setupWatchers();
  }

  private onWatchEvent(): void {
    if (this.disposed) return;
    const now = this.timers.now();
    if (this.coalesceTimer === undefined) {
      this.coalesceStartedAt = now;
    } else {
      this.timers.clearTimeout(this.coalesceTimer);
    }
    const sinceBurstStart = now - this.coalesceStartedAt;
    const maxWaitRemaining = Math.max(0, this.intervalMs - sinceBurstStart);
    const waitFor = Math.min(LiveRefreshController.DEBOUNCE_MS, maxWaitRemaining);
    this.coalesceTimer = this.timers.setTimeout(() => {
      this.coalesceTimer = undefined;
      this.requestTick();
    }, waitFor);
  }

  private requestTick(): void {
    if (this.running) {
      // Don't schedule against a tick that's still going — record the interest
      // and let its own completion path honour it, otherwise the timer fires
      // into a busy controller and the event is simply lost.
      this.pendingRequest = true;
      return;
    }
    this.scheduleFor(Math.max(this.lastTickAt + this.intervalMs, this.earliestNextTickAt));
  }

  /**
   * Absolute target time, not a delay. This is what makes the backoff a real
   * floor: every caller's target is clamped against `earliestNextTickAt`, so
   * a burst of watch events can pull a tick forward to the interval spacing
   * but can never pull it past an active backoff.
   */
  private scheduleFor(targetAtMs: number): void {
    if (this.disposed) return;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    const delay = Math.max(0, targetAtMs - this.timers.now());
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      void this.runTick();
    }, delay);
  }

  private tickTimeoutMs(): number {
    return Math.max(LiveRefreshController.MIN_TICK_TIMEOUT_MS, this.intervalMs * 3);
  }

  private backoffMs(): number {
    return Math.min(LiveRefreshController.MAX_BACKOFF_MS, this.intervalMs * 2 ** this.failureCount);
  }

  private emitStatus(): void {
    this.callbacks.onStatus({
      stale: this.isStale(),
      failureCount: this.failureCount,
      lastError: this.lastError,
      lastSuccessMs: this.lastSuccessAt,
    });
  }

  private async runTick(): Promise<void> {
    if (this.disposed) return;
    if (this.running) {
      this.pendingRequest = true;
      return;
    }
    this.running = true;
    this.pendingRequest = false;
    this.lastTickAt = this.timers.now();
    const generation = ++this.generation;

    let timedOut = false;
    let timeoutHandle: unknown;
    try {
      const timeoutMs = this.tickTimeoutMs();
      await new Promise<void>((resolve, reject) => {
        timeoutHandle = this.timers.setTimeout(() => {
          timedOut = true;
          // Retire this generation the instant it's abandoned, not merely when
          // the next tick starts — otherwise the abandoned tick could still
          // settle and post during the backoff window before that happens.
          this.generation++;
          try {
            this.callbacks.onTimeout();
          } catch {
            // Interrupting is best-effort; a failure there must not swallow
            // the timeout itself, which is what actually restores scheduling.
          }
          reject(new Error(`tick exceeded its ${timeoutMs}ms deadline and was abandoned`));
        }, timeoutMs);
        // Rejecting above resolves this race immediately; the abandoned tick's
        // own settlement lands on an already-settled promise and is discarded.
        Promise.resolve(this.callbacks.onTick(generation)).then(resolve, reject);
      });

      if (this.failureCount > 0) {
        this.callbacks.onLog(`recovered after ${this.failureCount} consecutive failure(s) — clearing backoff`);
      }
      this.failureCount = 0;
      this.lastError = undefined;
      this.lastSuccessAt = this.timers.now();
      this.earliestNextTickAt = 0;
      this.emitStatus();
    } catch (err) {
      this.failureCount++;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.callbacks.onLog(
        `tick ${timedOut ? 'timed out' : 'failed'} (${this.failureCount} consecutive${
          this.isStale() ? ', now stale' : ''
        }): ${this.lastError}`
      );
      this.earliestNextTickAt = this.timers.now() + this.backoffMs();
      this.emitStatus();
    } finally {
      if (timeoutHandle !== undefined) this.timers.clearTimeout(timeoutHandle);
      this.running = false;
      if (!this.disposed) {
        this.maybeRearmWatchers();
        // setTimeout chained from tick completion, not setInterval — a slow
        // tick (lock contention, a big combined query) can't queue overlapping
        // ticks against the same document state this way.
        if (this.pendingRequest) {
          this.pendingRequest = false;
          this.requestTick();
        } else {
          this.scheduleFor(Math.max(this.timers.now() + this.intervalMs, this.earliestNextTickAt));
        }
      }
    }
  }
}
