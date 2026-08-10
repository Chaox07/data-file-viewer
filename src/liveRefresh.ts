import { watch, FSWatcher } from 'node:fs';

export interface LiveRefreshCallbacks {
  /** Does the actual reconnect+query+post work for one tick. Throwing marks the tick as failed (drives backoff). */
  onTick: () => Promise<void>;
  onLog: (message: string) => void;
}

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
 */
export class LiveRefreshController {
  private timer: NodeJS.Timeout | undefined;
  private coalesceTimer: NodeJS.Timeout | undefined;
  private watchers: FSWatcher[] = [];
  private disposed = false;
  private running = false;
  private lastTickAt = 0;
  private coalesceStartedAt = 0;
  private failureCount = 0;
  private watchedPaths: string[] = [];

  private static readonly DEBOUNCE_MS = 75;
  private static readonly STALE_AFTER_FAILURES = 3;
  private static readonly MAX_BACKOFF_MS = 30_000;

  constructor(private intervalMs: number, private readonly callbacks: LiveRefreshCallbacks) {}

  setIntervalMs(ms: number): void {
    this.intervalMs = ms;
  }

  start(watchedPaths: string[]): void {
    this.watchedPaths = watchedPaths;
    this.setupWatchers();
    this.scheduleAt(0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.coalesceTimer) clearTimeout(this.coalesceTimer);
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

  private setupWatchers(): void {
    this.closeWatchers();
    for (const path of this.watchedPaths) {
      try {
        const watcher = watch(path, { persistent: false }, () => this.onWatchEvent());
        watcher.on('error', () => {
          // Don't let a dead watcher take live mode down — the timer
          // fallback below keeps it alive regardless. Attempt to
          // reestablish watchers on the next successful tick rather than
          // leaving this one dead for the rest of the session.
          this.callbacks.onLog(`watcher error on ${path} — falling back to timer polling for this file`);
        });
        this.watchers.push(watcher);
      } catch {
        // Setup itself failing (file doesn't exist yet, or the OS-wide
        // watch-handle limit was hit by several Live tabs open at once) is
        // just as recoverable — the timer fallback covers it the same way.
        this.callbacks.onLog(`could not watch ${path} — relying on timer fallback`);
      }
    }
  }

  private onWatchEvent(): void {
    if (this.disposed) return;
    const now = Date.now();
    if (!this.coalesceTimer) {
      this.coalesceStartedAt = now;
    } else {
      clearTimeout(this.coalesceTimer);
    }
    const sinceBurstStart = now - this.coalesceStartedAt;
    const maxWaitRemaining = Math.max(0, this.intervalMs - sinceBurstStart);
    const waitFor = Math.min(LiveRefreshController.DEBOUNCE_MS, maxWaitRemaining);
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = undefined;
      this.requestTick();
    }, waitFor);
  }

  private requestTick(): void {
    const sinceLast = Date.now() - this.lastTickAt;
    const delay = sinceLast < this.intervalMs ? this.intervalMs - sinceLast : 0;
    this.scheduleAt(delay);
  }

  private scheduleAt(delayMs: number): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.runTick(), delayMs);
  }

  private async runTick(): Promise<void> {
    if (this.disposed || this.running) return;
    this.running = true;
    this.lastTickAt = Date.now();
    try {
      await this.callbacks.onTick();
      if (this.failureCount > 0) {
        this.callbacks.onLog('recovered after failure — resetting backoff');
        // A watcher may have died mid-failure; give it a fresh chance now
        // that things are working again.
        this.setupWatchers();
      }
      this.failureCount = 0;
    } catch (err) {
      this.failureCount++;
      this.callbacks.onLog(
        `tick failed (${this.failureCount} consecutive${this.isStale() ? ', now stale' : ''}): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    } finally {
      this.running = false;
      if (!this.disposed) {
        // setTimeout chained from tick completion, not setInterval — a slow
        // tick (lock contention, a big combined query) can't queue
        // overlapping ticks against the same document state this way.
        const backoffMs =
          this.failureCount > 0
            ? Math.min(LiveRefreshController.MAX_BACKOFF_MS, this.intervalMs * 2 ** this.failureCount)
            : this.intervalMs;
        this.scheduleAt(backoffMs);
      }
    }
  }
}
