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
  lazyWindowMs,
  rejectionWindowMs,
  isContested,
  mergeGate,
  MERGE_GATE_CONSTANTS,
} = require('../src/services/active-users');

const DAY = 24 * 60 * 60 * 1000;
const {
  WINDOW_MAX_MS, WINDOW_MID_MS, REJECT_WINDOW_MAX_MS,
  LAZY_WINDOW_BASE_MS, LAZY_WINDOW_STEP_MS,
} = MERGE_GATE_CONSTANTS;

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

  // Below threshold with unopposed support → lazy consensus: not mergeable
  // through the threshold path, but the lazy clock (missing 1 vote → 3d)
  // has long elapsed → mergeable.
  const thin = mergeGate(20, 5, 0, opened, openedMs + 30 * DAY);
  assert.equal(thin.thresholdMet, false);
  assert.equal(thin.lazyArmed, true);
  assert.equal(thin.mergeable, true);

  // Below threshold with NO support at all → nothing arms, never merges.
  const zero = mergeGate(20, 0, 0, opened, openedMs + 30 * DAY);
  assert.equal(zero.thresholdMet, false);
  assert.equal(zero.lazyArmed, false);
  assert.equal(zero.mergeable, false);

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

// ---------------------------------------------------------------------------
// Lazy-consensus merge window (silence is consent).
// ---------------------------------------------------------------------------

test('lazyWindowMs: arms below threshold when Yes strictly leads unopposed', () => {
  // active=2 (required 2): 1 yes, 0 no → missing 1 → base window (3d).
  assert.equal(lazyWindowMs(2, 1, 0), LAZY_WINDOW_BASE_MS);
  // active=20 (required 6, unopposed): 5 yes → missing 1 → 3d.
  assert.equal(lazyWindowMs(20, 5, 0), LAZY_WINDOW_BASE_MS);
  // 4 yes → missing 2 → 3d + 2d = 5d.
  assert.equal(lazyWindowMs(20, 4, 0), LAZY_WINDOW_BASE_MS + LAZY_WINDOW_STEP_MS);
  // 1 yes → missing 5 → capped at the 7d max.
  assert.equal(lazyWindowMs(20, 1, 0), WINDOW_MAX_MS);
});

test('lazyWindowMs: null when the threshold path owns the clock', () => {
  // active=20 unopposed → required 6; at/above it the lazy clock is off.
  assert.equal(lazyWindowMs(20, 6, 0), null);
  assert.equal(lazyWindowMs(20, 11, 0), null);
});

test('lazyWindowMs: never arms without a strict Yes lead', () => {
  assert.equal(lazyWindowMs(20, 0, 0), null, 'no votes at all');
  assert.equal(lazyWindowMs(20, 2, 2), null, 'tie is a stalemate');
  assert.equal(lazyWindowMs(20, 2, 3), null, 'No lead belongs to the rejection clock');
});

test('lazyWindowMs: contested (No >= 1/3 of active) disarms it', () => {
  // active=9, 3 no → contested; even with Yes leading, no lazy clock.
  assert.equal(lazyWindowMs(9, 4, 3), null);
});

test('lazyWindowMs: No votes stretch the clock via the eased threshold', () => {
  // active=20: 1 no restores required from 6 to 8, so 5 yes → missing 3
  // → 3d + 2*2d = 7d (capped). More missing votes = longer clock.
  const unopposed = lazyWindowMs(20, 5, 0);
  const opposed = lazyWindowMs(20, 5, 1);
  assert.ok(opposed > unopposed, 'a No vote pushes the lazy clock out');
});

test('mergeGate: lazy-consensus transitions (2-active app, author-only Yes)', () => {
  const opened = '2026-06-01T00:00:00.000Z';
  const openedMs = Date.parse(opened);

  // Just opened: armed, clock running, not mergeable yet. windowEndsAt
  // serialized so the client renders the countdown pill.
  const fresh = mergeGate(2, 1, 0, opened, openedMs + 60 * 1000);
  assert.equal(fresh.thresholdMet, false);
  assert.equal(fresh.lazyArmed, true);
  assert.equal(fresh.lazyWindowMs, LAZY_WINDOW_BASE_MS);
  assert.equal(fresh.windowElapsed, false);
  assert.equal(fresh.mergeable, false);
  assert.equal(fresh.windowEndsAt,
    new Date(openedMs + LAZY_WINDOW_BASE_MS).toISOString());

  // Clock elapsed with no objection → merges.
  const aged = mergeGate(2, 1, 0, opened, openedMs + LAZY_WINDOW_BASE_MS + 1);
  assert.equal(aged.lazyArmed, true);
  assert.equal(aged.mergeable, true);

  // A No vote lands mid-window: tie disarms the lazy clock (and on a
  // 2-active app 1 no is also contested) → back to a pure count gate.
  const objected = mergeGate(2, 1, 1, opened, openedMs + 30 * DAY);
  assert.equal(objected.lazyArmed, false);
  assert.equal(objected.mergeable, false);
});

test('mergeGate: below threshold with no lazy arm has no merge clock', () => {
  const opened = '2026-06-01T00:00:00.000Z';
  const openedMs = Date.parse(opened);
  // Tie below threshold: no clock of any kind is serialized.
  const tied = mergeGate(20, 2, 2, opened, openedMs + 60 * 1000);
  assert.equal(tied.lazyArmed, false);
  assert.equal(tied.windowEndsAt, null);
  assert.equal(tied.mergeable, false);
});

// ---------------------------------------------------------------------------
// Auto-takedown (rejection) window.
// ---------------------------------------------------------------------------

test('rejectionWindowMs: kept alive (null) when Yes fraction >= 1/3', () => {
  // active=20: yes=7 → 0.35 >= 1/3, even with heavy No → no rejection clock.
  assert.equal(rejectionWindowMs(20, 7, 10), null);
  assert.equal(rejectionWindowMs(9, 3, 9), null); // 3/9 = 1/3 exactly → kept alive
});

test('rejectionWindowMs: not armed (null) when No does not strictly lead Yes', () => {
  assert.equal(rejectionWindowMs(20, 3, 3), null); // tie
  assert.equal(rejectionWindowMs(20, 4, 3), null); // Yes ahead
});

test('rejectionWindowMs: a lone No can never arm (REJECT_MIN_NO)', () => {
  // yes=0, no=1: No leads but is below the min-No floor → null.
  assert.equal(rejectionWindowMs(20, 0, 1), null);
  // yes=0, no=2: clears the floor → armed (and fully dominant → instant).
  assert.equal(rejectionWindowMs(20, 0, 2), 0);
});

test('rejectionWindowMs: ~max when No barely leads Yes (with support present)', () => {
  // active=20, yes=5, no=6: t=(6-5)/11 ≈ 0.09 → window ≈ max.
  const w = rejectionWindowMs(20, 5, 6);
  assert.ok(w > 0.98 * REJECT_WINDOW_MAX_MS, `expected ~7d, got ${w / DAY}d`);
  assert.ok(w <= REJECT_WINDOW_MAX_MS);
});

test('rejectionWindowMs: shrinks monotonically as No dominance grows', () => {
  const slim = rejectionWindowMs(20, 2, 3);   // t small
  const mid = rejectionWindowMs(20, 2, 6);    // t larger
  const heavy = rejectionWindowMs(20, 1, 10); // t large
  assert.ok(slim > mid && mid > heavy, `expected slim>${mid / DAY}>${heavy / DAY}`);
  // Full dominance (no Yes at all) → instant.
  assert.equal(rejectionWindowMs(20, 0, 5), 0);
});

test('rejectionWindowMs: non-linear front-loaded (stays nearer max at mid-dominance)', () => {
  // Pick yes/no giving t=0.5: (no-yes)/(no+yes)=0.5 → no=3*yes. yes=3,no=9
  // but 3/active must be < 1/3, so use a big active. active=60, yes=3, no=9:
  // yesFrac=0.05 (<1/3), t=(9-3)/12=0.5.
  const w = rejectionWindowMs(60, 3, 9);
  const linearMid = REJECT_WINDOW_MAX_MS * 0.5;
  assert.ok(w > linearMid, 'front-loaded curve stays above the straight-line midpoint');
  assert.ok(w > 0.85 * REJECT_WINDOW_MAX_MS, `expected ~6.1d, got ${w / DAY}d`);
});

test('mergeGate: rejection fields and rejectable transitions', () => {
  const opened = '2026-06-01T00:00:00.000Z';
  const openedMs = Date.parse(opened);

  // Armed, slim No majority, just opened → not yet rejectable.
  const fresh = mergeGate(20, 2, 3, opened, openedMs + 60 * 1000);
  assert.equal(fresh.rejectionArmed, true);
  assert.ok(fresh.rejectionEndsAt, 'exposes a rejection-end timestamp while armed');
  assert.equal(fresh.rejectable, false);

  // Same proposal, well past the rejection window → rejectable.
  const aged = mergeGate(20, 2, 3, opened, openedMs + 8 * DAY);
  assert.equal(aged.rejectionArmed, true);
  assert.equal(aged.rejectable, true);

  // Kept alive (Yes fraction >= 1/3) → never armed/rejectable, even aged.
  const keptAlive = mergeGate(20, 7, 12, opened, openedMs + 30 * DAY);
  assert.equal(keptAlive.rejectionArmed, false);
  assert.equal(keptAlive.rejectionEndsAt, null);
  assert.equal(keptAlive.rejectable, false);

  // Not armed (No not ahead) → no rejection.
  const notLosing = mergeGate(20, 4, 3, opened, openedMs + 30 * DAY);
  assert.equal(notLosing.rejectionArmed, false);
  assert.equal(notLosing.rejectable, false);
});

test('mergeGate: mergeable and rejectable are never simultaneously true', () => {
  const opened = '2026-06-01T00:00:00.000Z';
  const long = Date.parse(opened) + 60 * DAY; // far past any window
  // Sweep a range of yes/no on a 20-active app long after opening.
  for (let yes = 0; yes <= 20; yes++) {
    for (let no = 0; no <= 20; no++) {
      const g = mergeGate(20, yes, no, opened, long);
      assert.ok(!(g.mergeable && g.rejectable),
        `mergeable && rejectable both true at yes=${yes} no=${no}`);
    }
  }
});
