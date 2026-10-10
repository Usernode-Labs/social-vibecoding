// Tests for the #788 "explicit approval" gate modifier —
// applyNoTimerMerge + the computeGate dispatch in
// src/services/governance.js.
//
// The whole point of this feature is what it does NOT change. A
// proposal that edits dapp.json's `admins` block keeps the app's normal
// approval rules — same threshold, same electorate, same at-least-N /
// invited-approver configuration, same contested handling — and loses
// only the TIME-BASED merge paths. So most of these assertions compare
// a flagged gate field-by-field against the unflagged one and require
// them to be identical everywhere except the four window/lazy fields
// and `mergeable`.
//
// Run with: node --test tests/explicit-approval-gate.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const governance = require('../src/services/governance');
const activeUsers = require('../src/services/active-users');

const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 6, 25, 12, 0, 0);
const ago = (ms) => new Date(NOW - ms).toISOString();

const DEFAULT_GOV = { approverPolicy: 'anyone', approvalsRequired: null };
const INVITED_GOV = { approverPolicy: 'invited', approvalsRequired: null };
const AT_LEAST_GOV = { approverPolicy: 'anyone', approvalsRequired: 2 };

const gate = (gov, active, yes, no, openedAt, explicit) =>
  governance.computeGate(gov, active, yes, no, openedAt, NOW, { explicitApproval: explicit });

// Fields the modifier is ALLOWED to touch. Anything else differing
// between the flagged and unflagged gate is a regression.
const TOUCHED = new Set(['windowMs', 'windowEndsAt', 'windowElapsed', 'lazyArmed', 'lazyWindowMs', 'mergeable', 'explicitApproval']);

function assertOnlyTimersDiffer(plain, flagged, label) {
  for (const key of Object.keys(plain)) {
    if (TOUCHED.has(key)) continue;
    assert.deepEqual(flagged[key], plain[key], `${label}: ${key} must be unchanged`);
  }
}

// ── The modifier in isolation ─────────────────────────────────────────

test('applyNoTimerMerge zeroes the window and disarms lazy consensus', () => {
  const base = activeUsers.mergeGate(6, 1, 0, ago(1 * DAY), NOW);
  assert.equal(base.lazyArmed, true, 'precondition: this shape normally arms lazy consensus');
  assert.ok(base.windowEndsAt, 'precondition: it normally has a countdown');

  const out = governance.applyNoTimerMerge(base);
  assert.equal(out.windowMs, 0);
  assert.equal(out.windowEndsAt, null);
  assert.equal(out.windowElapsed, true);
  assert.equal(out.lazyArmed, false);
  assert.equal(out.lazyWindowMs, null);
  assert.equal(out.mergeable, false, 'below threshold, and silence no longer merges it');
});

test('applyNoTimerMerge makes mergeable a pure function of thresholdMet', () => {
  // Threshold met but inside the visibility window: normally deferred,
  // now immediately mergeable.
  const base = activeUsers.mergeGate(8, 3, 0, ago(1 * 3600 * 1000), NOW);
  assert.equal(base.thresholdMet, true);
  assert.equal(base.mergeable, base.windowElapsed);
  const out = governance.applyNoTimerMerge(base);
  assert.equal(out.mergeable, true);
});

test('applyNoTimerMerge passes every rejection field through untouched', () => {
  const base = activeUsers.mergeGate(9, 1, 6, ago(6 * DAY), NOW);
  assert.equal(base.rejectionArmed, true, 'precondition: the takedown clock is armed');
  const out = governance.applyNoTimerMerge(base);
  for (const k of ['rejectionWindowMs', 'rejectionArmed', 'rejectionEndsAt', 'rejectable']) {
    assert.deepEqual(out[k], base[k], `${k} must survive the modifier`);
  }
});

test('applyNoTimerMerge leaves required / contested / thresholdMet alone', () => {
  const base = activeUsers.mergeGate(9, 7, 9, ago(2 * DAY), NOW);
  const out = governance.applyNoTimerMerge(base);
  assert.equal(out.required, base.required);
  assert.equal(out.contested, base.contested);
  assert.equal(out.thresholdMet, base.thresholdMet);
});

// ── Default regime ────────────────────────────────────────────────────

test('default regime: a lazy-armed proposal loses its countdown and does not merge', () => {
  const plain = gate(DEFAULT_GOV, 6, 1, 0, ago(5 * DAY), false);
  const flagged = gate(DEFAULT_GOV, 6, 1, 0, ago(5 * DAY), true);

  assert.equal(plain.lazyArmed, true);
  assert.equal(plain.mergeable, true, 'precondition: silence-is-consent would have merged it');

  assert.equal(flagged.lazyArmed, false);
  assert.equal(flagged.lazyWindowMs, null);
  assert.equal(flagged.windowEndsAt, null);
  assert.equal(flagged.mergeable, false, 'time alone must never merge an admins change');
  assertOnlyTimersDiffer(plain, flagged, 'lazy-armed');
});

test('default regime: at threshold it merges immediately instead of waiting out the window', () => {
  // active=8 unopposed: the discount eases required to 3, but yes/active
  // is still under the majority mark, so the visibility window applies.
  const plain = gate(DEFAULT_GOV, 8, 3, 0, ago(1 * 3600 * 1000), false);
  const flagged = gate(DEFAULT_GOV, 8, 3, 0, ago(1 * 3600 * 1000), true);

  assert.equal(plain.thresholdMet, true);
  assert.equal(plain.mergeable, false, 'precondition: the visibility window is still running');
  assert.ok(plain.windowEndsAt);

  assert.equal(flagged.thresholdMet, true);
  assert.equal(flagged.mergeable, true);
  assert.equal(flagged.windowEndsAt, null, 'no countdown is serialized, so none renders');
  assertOnlyTimersDiffer(plain, flagged, 'threshold-met');
});

test('default regime: the threshold itself is untouched', () => {
  for (const [active, yes, no] of [[1, 0, 0], [3, 1, 0], [8, 2, 1], [30, 4, 6]]) {
    const plain = gate(DEFAULT_GOV, active, yes, no, ago(DAY), false);
    const flagged = gate(DEFAULT_GOV, active, yes, no, ago(DAY), true);
    assert.equal(flagged.required, plain.required,
      `required must match at active=${active} yes=${yes} no=${no}`);
    assert.equal(flagged.contested, plain.contested);
  }
});

test('default regime: rejection still arms, and still fires once elapsed', () => {
  // No leads Yes, under the keep-alive line, long enough to elapse.
  const flagged = gate(DEFAULT_GOV, 9, 1, 6, ago(7 * DAY), true);
  assert.equal(flagged.rejectionArmed, true);
  assert.equal(flagged.rejectable, true, 'a flagged proposal can still be voted down');
  assert.equal(flagged.mergeable, false);

  // Not yet elapsed → armed but not rejectable, exactly as before.
  const early = gate(DEFAULT_GOV, 30, 2, 3, ago(1 * 3600 * 1000), true);
  assert.equal(early.rejectionArmed, true);
  assert.equal(early.rejectable, false);
  assert.ok(early.rejectionEndsAt, 'the countdown timestamp still renders');
});

test('default regime: contested behaves identically flagged or not', () => {
  const plain = gate(DEFAULT_GOV, 9, 7, 9, ago(2 * DAY), false);
  const flagged = gate(DEFAULT_GOV, 9, 7, 9, ago(2 * DAY), true);
  assert.equal(flagged.contested, true);
  assertOnlyTimersDiffer(plain, flagged, 'contested');
});

// ── at_least regime ───────────────────────────────────────────────────

test('at_least: the modifier is a verified no-op (that mode is already clock-free)', () => {
  for (const [yes, no] of [[0, 0], [1, 0], [2, 0], [2, 3]]) {
    const plain = gate(AT_LEAST_GOV, 5, yes, no, ago(3 * DAY), false);
    const flagged = gate(AT_LEAST_GOV, 5, yes, no, ago(3 * DAY), true);
    for (const key of Object.keys(plain)) {
      if (key === 'explicitApproval') continue;
      assert.deepEqual(flagged[key], plain[key],
        `at_least yes=${yes} no=${no}: ${key} must be identical`);
    }
  }
});

test('at_least: the modifier still does not touch rejection — the base gate owns it', () => {
  // REVERSED by #2494, with the reasoning kept rather than the assertion.
  //
  // This used to assert `rejectionArmed === false` under the name
  // "rejection stays OFF under the modifier". That was true, but it was
  // true because atLeastGate had NO rejection clock at all — the very
  // thing #2494 reports: a promoted proposal on an at-least-N app could
  // never close itself however it was voted.
  //
  // #788's intent is unchanged and is actually better served now. Its own
  // comment says the modifier passes all four rejection fields through
  // untouched so that "a flagged proposal nobody wants still dies on
  // schedule". With 1 yes / 6 no there is now a schedule for it to die on.
  const flagged = gate(AT_LEAST_GOV, 9, 1, 6, ago(7 * DAY), true);
  assert.equal(flagged.rejectionArmed, true,
    'opposition arms the clock in at-least-N mode now (#2494)');

  // What the modifier must STILL not do: change any of it. The MERGE
  // timers are its business; the rejection fields are the base gate's.
  const plain = gate(AT_LEAST_GOV, 9, 1, 6, ago(7 * DAY), false);
  for (const key of ['rejectionArmed', 'rejectable', 'rejectionWindowMs', 'rejectionEndsAt']) {
    assert.deepEqual(flagged[key], plain[key],
      `the no-timer modifier must not move ${key}`);
  }
});

test('at_least: mode still reports the real regime, not the modifier', () => {
  assert.equal(gate(AT_LEAST_GOV, 5, 1, 0, ago(DAY), true).mode, 'at_least');
  assert.equal(gate(DEFAULT_GOV, 5, 1, 0, ago(DAY), true).mode, 'default');
});

// ── invited-approver regime ───────────────────────────────────────────

test('invited approvers: policy and qualifying counts are unaffected', () => {
  const plain = gate(INVITED_GOV, 3, 2, 0, ago(2 * DAY), false);
  const flagged = gate(INVITED_GOV, 3, 2, 0, ago(2 * DAY), true);
  assert.equal(flagged.policy, 'invited');
  assert.equal(flagged.qualifiedYes, 2);
  assert.equal(flagged.qualifiedNo, 0);
  assert.equal(flagged.activeCount, 3, 'the electorate size is the approver roster, unchanged');
  assertOnlyTimersDiffer(plain, flagged, 'invited');
});

// ── Backwards compatibility ───────────────────────────────────────────

test('omitting the options argument keeps exactly today’s behaviour', () => {
  const legacy = governance.computeGate(DEFAULT_GOV, 6, 1, 0, ago(5 * DAY), NOW);
  const explicitFalse = gate(DEFAULT_GOV, 6, 1, 0, ago(5 * DAY), false);
  assert.deepEqual(legacy, explicitFalse);
  assert.equal(legacy.explicitApproval, false);
  assert.equal(legacy.lazyArmed, true, 'the old lazy path is untouched when unflagged');
});

test('a null `now` still resolves (serializers pass null to reach the options arg)', () => {
  const g = governance.computeGate(DEFAULT_GOV, 4, 1, 0, ago(5 * DAY), null,
    { explicitApproval: true });
  assert.equal(g.explicitApproval, true);
  assert.equal(g.windowEndsAt, null);
  assert.equal(typeof g.required, 'number');
});

// ── The member floor ──────────────────────────────────────────────────
//
// A flagged proposal also needs at least one qualifying Yes from someone
// other than its author whenever the community has more than one member.
// The threshold still reports the vote count; `memberFloor` is its own
// fact, and `mergeable` needs both.

const floorGate = (gov, active, yes, no, openedAt, { members, otherYes, explicit = true } = {}) =>
  governance.computeGate(gov, active, yes, no, openedAt, NOW, {
    explicitApproval: explicit, memberCount: members, otherYes,
  });

test('memberFloor: applies above one member, met by one Yes from someone else', () => {
  assert.equal(governance.memberFloor({}), null, 'no member count: not evaluated');
  assert.equal(governance.memberFloor({ memberCount: null, otherYes: 3 }), null);
  assert.deepEqual(governance.memberFloor({ memberCount: 1, otherYes: 0 }),
    { applies: false, otherYes: 0, met: true });
  assert.deepEqual(governance.memberFloor({ memberCount: 2, otherYes: 0 }),
    { applies: true, otherYes: 0, met: false });
  assert.deepEqual(governance.memberFloor({ memberCount: '5', otherYes: '1' }),
    { applies: true, otherYes: 1, met: true });
  assert.deepEqual(governance.memberFloor({ memberCount: 0, otherYes: 0 }),
    { applies: false, otherYes: 0, met: true }, 'no community yet reads as one person');
});

test('default regime: the author’s own Yes meets the threshold but does not merge', () => {
  // Two members, only the author active lately: one Yes is the threshold,
  // which is exactly how an author's own Yes used to merge it alone.
  const g = floorGate(DEFAULT_GOV, 1, 1, 0, ago(DAY), { members: 2, otherYes: 0 });
  assert.equal(g.thresholdMet, true, 'the count is met');
  assert.equal(g.mergeable, false, 'but nobody else has said Yes');
  assert.deepEqual(g.memberFloor, { applies: true, otherYes: 0, met: false });
});

test('default regime: one Yes from another member opens the merge', () => {
  const g = floorGate(DEFAULT_GOV, 2, 2, 0, ago(DAY), { members: 2, otherYes: 1 });
  assert.equal(g.mergeable, true);
  assert.equal(g.memberFloor.met, true);
});

test('a one-member community: the author’s Yes is enough', () => {
  const g = floorGate(DEFAULT_GOV, 1, 1, 0, ago(DAY), { members: 1, otherYes: 0 });
  assert.equal(g.mergeable, true);
  assert.equal(g.memberFloor.applies, false);
});

test('the floor never lowers the bar: below threshold stays unmergeable', () => {
  const g = floorGate(DEFAULT_GOV, 9, 1, 0, ago(DAY), { members: 9, otherYes: 1 });
  assert.equal(g.thresholdMet, false);
  assert.equal(g.mergeable, false);
});

test('at_least: the floor holds a met count and lets opposition close it', () => {
  // N=1: the author's Yes is the whole count. Two members voted No.
  const ONE = { approverPolicy: 'anyone', approvalsRequired: 1 };
  const held = floorGate(ONE, 3, 1, 2, ago(7 * DAY), { members: 3, otherYes: 0 });
  assert.equal(held.thresholdMet, true);
  assert.equal(held.mergeable, false, 'the author alone cannot open it');
  assert.equal(held.rejectionArmed, true,
    'the keep-alive keys on mergeable, so an author-only Yes does not keep it open forever');

  const plain = floorGate(ONE, 3, 1, 2, ago(7 * DAY), { members: 3, otherYes: 0, explicit: false });
  assert.equal(plain.mergeable, true, 'unflagged, the same tally merges as before');
  assert.equal(plain.rejectionArmed, false);
  assert.equal(plain.memberFloor, null, 'an unflagged gate has no floor');

  const met = floorGate(ONE, 3, 2, 1, ago(DAY), { members: 3, otherYes: 1 });
  assert.equal(met.mergeable, true);
  assert.equal(met.rejectionArmed, false, 'a mergeable proposal is never auto-closed');
});

test('applyNoTimerMerge: the floor gates mergeable, and null means not evaluated', () => {
  const base = activeUsers.mergeGate(8, 3, 0, ago(3600 * 1000), NOW);
  assert.equal(base.thresholdMet, true);
  assert.equal(governance.applyNoTimerMerge(base, null).mergeable, true);
  assert.equal(governance.applyNoTimerMerge(base, { applies: false, otherYes: 0, met: true }).mergeable, true);
  assert.equal(governance.applyNoTimerMerge(base, { applies: true, otherYes: 0, met: false }).mergeable, false);
  assert.equal(governance.applyNoTimerMerge(base, { applies: true, otherYes: 2, met: true }).mergeable, true);
});

// governedGate is the path every merge and apply decision takes, so it must
// evaluate the floor itself: the author (passed, or read off the row), the
// other-member Yes count, and the community size.
function floorPool({ yes, otherYes, members, author = 7 }) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      seen.push({ sql, params });
      if (/FROM apps WHERE id/.test(sql) && /approver_policy/.test(sql)) return { rows: [{}] };
      if (/community_members/.test(sql)) return { rows: [{ n: members }] };
      if (/SELECT user_id AS author_id FROM chat_sessions/.test(sql)) return { rows: [{ author_id: author }] };
      if (/IS DISTINCT FROM \$2::int/.test(sql)) return { rows: [{ cnt: String(otherYes) }] };
      if (/vote = 'yes'/.test(sql)) return { rows: [{ cnt: String(yes) }] };
      if (/vote = 'no'/.test(sql)) return { rows: [{ cnt: '0' }] };
      return { rows: [] };
    },
  };
}

function withActiveUsers(active, fn) {
  const key = require.resolve('../src/services/active-users');
  const original = require.cache[key];
  require.cache[key] = {
    ...original,
    exports: { ...activeUsers, getActiveUserStats: async () => ({ active, majority: Math.floor(active / 2) + 1 }) },
  };
  return Promise.resolve(fn()).finally(() => { require.cache[key] = original; });
}

test('governedGate: a flagged proposal reads the author off the row and holds on the floor', () => withActiveUsers(1, async () => {
  governance.invalidateGovernance(901);
  const pool = floorPool({ yes: 1, otherYes: 0, members: 2, author: 7 });
  const g = await governance.governedGate(pool, 901, {
    kind: 'pr', id: 55, openedAt: ago(DAY), now: NOW, explicitApproval: true,
  });
  assert.equal(g.thresholdMet, true);
  assert.equal(g.mergeable, false);
  assert.deepEqual(g.memberFloor, { applies: true, otherYes: 0, met: false });
  const other = pool.seen.find((c) => /IS DISTINCT FROM \$2::int/.test(c.sql));
  assert.deepEqual(other.params, [55, 7], 'the other-Yes count excludes the author read off the row');
}));

test('governedGate: a passed author is used as is, and another member’s Yes merges', () => withActiveUsers(2, async () => {
  governance.invalidateGovernance(902);
  const pool = floorPool({ yes: 2, otherYes: 1, members: 2 });
  const g = await governance.governedGate(pool, 902, {
    kind: 'pr', id: 56, openedAt: ago(DAY), now: NOW, explicitApproval: true, authorId: 3,
  });
  assert.equal(g.mergeable, true);
  assert.ok(!pool.seen.some((c) => /author_id/.test(c.sql)), 'no author read when the caller passed one');
  const other = pool.seen.find((c) => /IS DISTINCT FROM \$2::int/.test(c.sql));
  assert.deepEqual(other.params, [56, 3]);
}));

test('governedGate: an unflagged proposal pays for none of it', () => withActiveUsers(2, async () => {
  governance.invalidateGovernance(903);
  const pool = floorPool({ yes: 1, otherYes: 0, members: 2 });
  const g = await governance.governedGate(pool, 903, { kind: 'pr', id: 57, openedAt: ago(DAY), now: NOW });
  assert.equal(g.memberFloor, null);
  assert.ok(!pool.seen.some((c) => /community_members|IS DISTINCT FROM|author_id/.test(c.sql)),
    'the common path keeps its exact queries');
}));

test('governedGate: a secret-change issue reads issues.created_by as its author', () => withActiveUsers(3, async () => {
  governance.invalidateGovernance(904);
  const seen = [];
  const pool = {
    async query(sql, params) {
      seen.push({ sql, params });
      if (/approver_policy/.test(sql)) return { rows: [{}] };
      if (/community_members/.test(sql)) return { rows: [{ n: 3 }] };
      if (/SELECT created_by AS author_id FROM issues/.test(sql)) return { rows: [{ author_id: 11 }] };
      if (/IS DISTINCT FROM \$2::int/.test(sql)) return { rows: [{ cnt: '0' }] };
      if (/vote = 'up'/.test(sql)) return { rows: [{ cnt: '2' }] };
      return { rows: [{ cnt: '0' }] };
    },
  };
  const g = await governance.governedGate(pool, 904, {
    kind: 'issue', id: 70, openedAt: ago(DAY), now: NOW, explicitApproval: true,
  });
  assert.equal(g.thresholdMet, true);
  assert.equal(g.mergeable, false, 'the up votes are in, but none is from anyone but the author');
  const other = seen.find((c) => /IS DISTINCT FROM \$2::int/.test(c.sql));
  assert.match(other.sql, /FROM issue_votes/);
  assert.deepEqual(other.params, [70, 11]);
}));
