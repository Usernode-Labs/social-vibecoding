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

test('at_least: rejection stays OFF under the modifier — "as before" means as that app behaves', () => {
  const flagged = gate(AT_LEAST_GOV, 9, 1, 6, ago(7 * DAY), true);
  assert.equal(flagged.rejectionArmed, false);
  assert.equal(flagged.rejectable, false);
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
