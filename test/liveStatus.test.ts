import assert from 'node:assert/strict';
import test from 'node:test';
import { MIN_STALE_AFTER_MS, isLocallyStale, liveStatusText, type LiveState } from '../src/liveStatus';

/**
 * The live-refresh status line, and its independent staleness rule.
 *
 * Why the rule is independent is the thing to keep in front of whoever changes
 * it: the host's own `stale` flag can only arrive if the host is still running
 * its scheduler at all, so a WEDGED extension host is precisely the case it
 * cannot report. Time since the last successful update is observable from the
 * webview no matter what happened over there — and a status line that says
 * "Live" while nothing has updated for ten minutes is worse than no status
 * line, because it is an active assurance that the data is current.
 *
 * `now` is injected, so this is tested across the axis that matters rather
 * than at whatever the wall clock happened to be.
 */

const NOW = 1_700_000_000_000;

function state(over: Partial<LiveState> = {}): LiveState {
  return {
    enabled: true,
    hostStale: false,
    lastUpdatedMs: NOW,
    intervalMs: 2000,
    lastError: undefined,
    ...over,
  };
}

test('a fresh update is not stale', () => {
  assert.equal(isLocallyStale(state({ lastUpdatedMs: NOW - 1000 }), NOW), false);
});

test('one missed tick is not stale', () => {
  // Ordinary jitter. A rule that fired here would flicker between Live and
  // stale on every slow query.
  assert.equal(isLocallyStale(state({ lastUpdatedMs: NOW - 2500 }), NOW), false);
});

test('the floor is ten seconds even at a fast cadence', () => {
  // 3 * 250ms is 750ms, which would call a perfectly healthy connection stale
  // within a second. The floor is what stops that.
  const fast = state({ intervalMs: 250, lastUpdatedMs: NOW - 5000 });
  assert.equal(isLocallyStale(fast, NOW), false);
  assert.equal(isLocallyStale({ ...fast, lastUpdatedMs: NOW - MIN_STALE_AFTER_MS - 1 }, NOW), true);
});

test('three intervals governs once the cadence is slow enough', () => {
  const slow = state({ intervalMs: 10_000 });
  assert.equal(isLocallyStale({ ...slow, lastUpdatedMs: NOW - 29_000 }, NOW), false);
  assert.equal(isLocallyStale({ ...slow, lastUpdatedMs: NOW - 31_000 }, NOW), true);
});

test('never having updated is not stale', () => {
  // "Waiting for the first update" is a different state from "updates stopped",
  // and reporting the first as stale would make every file look broken for its
  // first few seconds.
  assert.equal(isLocallyStale(state({ lastUpdatedMs: undefined }), NOW), false);
});

test('a wedged host is caught by the clock even though it never reported stale', () => {
  // The case the whole rule exists for: hostStale is false because nothing is
  // running over there to set it.
  const wedged = state({ hostStale: false, lastUpdatedMs: NOW - 600_000 });
  assert.equal(isLocallyStale(wedged, NOW), true);
  assert.match(liveStatusText(wedged, NOW).text, /stale/);
});

// ---------------------------------------------------------------------------
// The rendered line
// ---------------------------------------------------------------------------

test('a healthy live view says when it last updated', () => {
  const status = liveStatusText(state({ lastUpdatedMs: NOW - 5000 }), NOW);
  assert.equal(status.text, 'Live · updated 5s ago');
  assert.match(status.className, /live-status-active/);
  assert.equal(status.title, '');
});

test('before the first update it says so rather than claiming an age', () => {
  const status = liveStatusText(state({ lastUpdatedMs: undefined }), NOW);
  assert.equal(status.text, 'Live · waiting for first update…');
  assert.match(status.className, /live-status-active/);
});

test('the host reporting stale is enough on its own', () => {
  const status = liveStatusText(state({ hostStale: true, lastUpdatedMs: NOW - 1000 }), NOW);
  assert.match(status.text, /^Live · stale, last updated 1s ago$/);
  assert.match(status.className, /live-status-stale/);
});

test('the last error is shown only while stale', () => {
  const err = 'IO Error: file is locked';

  const healthy = liveStatusText(state({ lastError: err, lastUpdatedMs: NOW - 1000 }), NOW);
  assert.equal(healthy.title, '', 'a recovered error was still being advertised');

  const stale = liveStatusText(state({ lastError: err, hostStale: true }), NOW);
  assert.equal(stale.title, `Last error: ${err}`);
});

test('a stale view with no recorded error has no tooltip', () => {
  const status = liveStatusText(state({ hostStale: true, lastError: undefined }), NOW);
  assert.equal(status.title, '');
});

test('the age in the line advances with the clock', () => {
  const s = state({ lastUpdatedMs: NOW });
  assert.match(liveStatusText(s, NOW + 1000).text, /1s ago/);
  assert.match(liveStatusText(s, NOW + 65_000).text, /1m 5s ago/);
});
