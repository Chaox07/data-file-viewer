import { formatAgo } from './gridFormat';

/**
 * What the live-refresh status line says.
 *
 * The staleness rule here is a SECOND, independent signal, and the reason it
 * exists is worth keeping in front of whoever changes it: the host's own
 * `stale` flag can only arrive if the host is still running its scheduler at
 * all -- so a wedged extension host is precisely the case it cannot report.
 * Time since the last successful update is observable from this side no matter
 * what happened over there.
 *
 * `now` is a parameter rather than a call to Date.now() so this can be driven
 * against test/fakeClock.ts, the way liveRefresh.test.ts already drives the
 * scheduler. A staleness rule tested only at the current wall clock is tested
 * at one point on the only axis that matters.
 */

export interface LiveState {
  enabled: boolean;
  /** The host's own staleness flag. */
  hostStale: boolean;
  lastUpdatedMs: number | undefined;
  intervalMs: number;
  lastError: string | undefined;
}

/** The floor below which "no update yet" is not yet suspicious. */
export const MIN_STALE_AFTER_MS = 10_000;

/**
 * Stale by local observation alone.
 *
 * Three intervals, or ten seconds, whichever is longer: one missed tick is
 * ordinary, and a fast poll cadence must not make the line flicker between
 * "live" and "stale" on normal jitter.
 */
export function isLocallyStale(state: LiveState, now: number = Date.now()): boolean {
  if (state.lastUpdatedMs === undefined) return false;
  return now - state.lastUpdatedMs > Math.max(3 * state.intervalMs, MIN_STALE_AFTER_MS);
}

export interface LiveStatusText {
  text: string;
  className: string;
  title: string;
}

export function liveStatusText(state: LiveState, now: number = Date.now()): LiveStatusText {
  const stale = state.hostStale || isLocallyStale(state, now);
  const agoText =
    state.lastUpdatedMs !== undefined ? `updated ${formatAgo(state.lastUpdatedMs, now)}` : 'waiting for first update…';
  return {
    text: stale ? `Live · stale, last ${agoText}` : `Live · ${agoText}`,
    className: `live-status ${stale ? 'live-status-stale' : 'live-status-active'}`,
    // The error is shown only alongside a stale state: a transient error that
    // recovered is not something to keep advertising once updates resume.
    title: stale && state.lastError ? `Last error: ${state.lastError}` : '',
  };
}
