// Unit tests for the two pure merge gates in services/active-users.js:
//   - requiredVotes(active, noCount): the eased Yes-vote threshold.
//   - mergeWindowMs(active, yesCount, noCount): the minimum visibility window.
//   - mergeGate(...): the convenience wrapper combining both + open-time.
//
// These are pure functions (no DB, no clock except the explicit `now`
// argument to mergeGate), so they're tested directly.
//
// Run with: node --test tests/merge-gates.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  requiredVotes,
  mergeWindowMs,
  isContested,
  mergeGate,
  MERGE_GATE_CONSTANTS,
} = require('../src/services/active-users');

const DAY = 24 * 60 * 60 * 1000;
const { WINDOW_MAX_MS, WINDOW_MID_MS } = MERGE_GATE_CONSTANTS;

test('requiredVotes: unopposed easing scales with app size, capped at majority', () => {
  // active=8 → M=5; unopposed discount = floor(8/4) = 2 → 3.
  assert.equal(requiredVotes(8, 0), 3);
  // active=20 → M=11; unopposed discount = 5 → 6.
  assert.equal(requiredVotes(20, 0), 6);
  // active=4 → M=3; unopposed discount = 1 → 2.
  assert.equal(requiredVotes(4, 0), 2);
});

test('requiredVotes: each No vote restores the bar, never above majority', () => {
  // active=20, M=11: 1 No → 8, 2 No → 10, 3+ No → 11 (capped at M).
  assert.equal(requiredVotes(20, 1), 8);
  assert.equal(requiredVotes(20, 2), 10);
  assert.equal(requiredVotes(20, 3), 11);
  assert.equal(requiredVotes(20, 50), 11, 'never exceeds majority');
  // active=8, M=5: any No removes the whole discount → 5.
  assert.equal(requiredVotes(8, 1), 5);
});

test('requiredVotes: anti-self-merge floor of 2 once active >= 2', () => {
  // active=2 → M=2; a single self-vote (1) can never satisfy the threshold.
  assert.equal(requiredVotes(2, 0), 2);
  // active=3 → M=2; floor still 2.
  assert.equal(requiredVotes(3, 0), 2);
});

test('requiredVotes: tiny-app edge — active=1 needs 1 (floor cannot exceed M)', () => {
  assert.equal(requiredVotes(1, 0), 1);
});

test('mergeWindowMs: 7-day max at low participation', () => {
  assert.equal(mergeWindowMs(20, 0, 0), WINDOW_MAX_MS);
  // Below the 1/3 mark, still well above the mid window.
  assert.ok(mergeWindowMs(20, 2, 0) > WINDOW_MID_MS);
});

test('mergeWindowMs: settles to ~3 days at the 1/3 mark', () => {
  // active=30, yes=10 → yesFrac exactly 1/3 → WINDOW_MID_MS.
  assert.equal(mergeWindowMs(30, 10, 0), WINDOW_MID_MS);
});

test('mergeWindowMs: non-linear front-loaded between 1/3 and 1/2', () => {
  // At t=0.5 of the [1/3,1/2] range (yesFrac=5/12), the front-loaded curve
  // stays much closer to WINDOW_MID than a straight line would.
  // active=1200, yes=500 → yesFrac=5/12.
  const w = mergeWindowMs(1200, 500, 0);
  const linearMidpoint = WINDOW_MID_MS * 0.5; // what a linear ramp would give
  assert.ok(w > linearMidpoint, 'front-loaded curve stays nearer the mid window');
  assert.ok(w > 2 * DAY && w < 3 * DAY, `expected ~2.6d, got ${w / DAY}d`);

  // ...and drops sharply as Yes nears a majority: at yesFrac≈0.49 it's far
  // below the midpoint value.
  const near = mergeWindowMs(10000, 4900, 0); // yesFrac=0.49
  assert.ok(near < w, 'window drops sharply near the majority mark');
});

test('mergeWindowMs: collapses to 0 at yesFrac >= 1/2 and at yes >= majority', () => {
  // yesFrac exactly 1/2 (still below the count majority for even active).
  assert.equal(mergeWindowMs(20, 10, 0), 0);
  // yes >= M (majority) → instant regardless.
  assert.equal(mergeWindowMs(20, 11, 0), 0);
});

test('mergeWindowMs: No-vote pushback widens the window', () => {
  const noOpp = mergeWindowMs(20, 6, 0);
  const someOpp = mergeWindowMs(20, 6, 2);
  assert.ok(someOpp > noOpp, 'opposition pushes the window back toward the max');
});

test('mergeWindowMs: contested (No fraction >= 1/3) removes the window', () => {
  // 7/20 = 0.35 >= 1/3 → 0; 6/20 = 0.30 < 1/3 → still gated.
  assert.equal(mergeWindowMs(20, 5, 7), 0);
  assert.ok(mergeWindowMs(20, 5, 6) > 0);
  assert.equal(isContested(20, 7), true);
  assert.equal(isContested(20, 6), false);
});

test('mergeWindowMs: tiny apps have effectively no soak period', () => {
  // active=4, yes=2 → yesFrac=0.5 → instant.
  assert.equal(mergeWindowMs(4, 2, 0), 0);
  // active=2, yes=1 → yesFrac=0.5 → instant (and threshold unmet anyway).
  assert.equal(mergeWindowMs(2, 1, 0), 0);
});

test('mergeGate: combines threshold + window into a single decision', () => {
  const opened = '2026-06-01T00:00:00.000Z';
  const openedMs = Date.parse(opened);

  // active=20, yes=6, no=0: threshold met (required=6), window ~3.4d.
  const justOpened = mergeGate(20, 6, 0, opened, openedMs + 60 * 1000);
  assert.equal(justOpened.required, 6);
  assert.equal(justOpened.thresholdMet, true);
  assert.equal(justOpened.windowElapsed, false);
  assert.equal(justOpened.mergeable, false);
  assert.ok(justOpened.windowEndsAt, 'exposes a window-end timestamp while gating');

  // Same proposal, now well past the window → mergeable.
  const aged = mergeGate(20, 6, 0, opened, openedMs + 8 * DAY);
  assert.equal(aged.windowElapsed, true);
  assert.equal(aged.mergeable, true);

  // Below threshold → not mergeable, no merge regardless of time.
  const thin = mergeGate(20, 5, 0, opened, openedMs + 30 * DAY);
  assert.equal(thin.thresholdMet, false);
  assert.equal(thin.mergeable, false);

  // Majority reached → window 0, mergeable immediately, no windowEndsAt.
  const majority = mergeGate(20, 11, 0, opened, openedMs + 60 * 1000);
  assert.equal(majority.windowMs, 0);
  assert.equal(majority.windowEndsAt, null);
  assert.equal(majority.mergeable, true);

  // Contested but full majority of Yes → merges immediately.
  const contestedMajority = mergeGate(20, 11, 7, opened, openedMs + 60 * 1000);
  assert.equal(contestedMajority.contested, true);
  assert.equal(contestedMajority.windowMs, 0);
  assert.equal(contestedMajority.mergeable, true);
});
