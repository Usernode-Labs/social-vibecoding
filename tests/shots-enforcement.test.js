'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const votes = require('../src/routes/votes');
const requirements = require('../src/services/merge-requirements');

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const config = { shots: { enforce: true } };

function row(state, overrides = {}) {
  return {
    source: 'native',
    reviewed_head_sha: HEAD,
    shots_state: state,
    shots_detail: {
      required: true,
      state,
      headSha: HEAD,
      ...(state === 'failed' ? { failureReason: 'The declared dialog could not be reached.' } : {}),
    },
    ...overrides,
  };
}

test('enforcement applies only to enrolled proposals and accepts audited terminal states on the exact head', () => {
  assert.deepEqual(votes.shotsGateForSession({ shots: { enforce: false } }, row('planned')),
    { applies: false, allowed: true, state: null });
  assert.deepEqual(votes.shotsGateForSession(config, { reviewed_head_sha: HEAD }),
    { applies: false, allowed: true, state: null });

  for (const state of ['verified', 'overridden']) {
    const gate = votes.shotsGateForSession(config, row(state));
    assert.equal(gate.applies, true);
    assert.equal(gate.allowed, true, state);
  }
  const notRequired = votes.shotsGateForSession(config, row('not_required', {
    shots_detail: { required: false, state: 'not_required', headSha: HEAD },
  }));
  assert.equal(notRequired.allowed, true);
});

test('pending, failed, or prior-head shots cannot be bypassed by the gate', () => {
  const pending = votes.shotsGateForSession(config, row('replaying'));
  assert.equal(pending.allowed, false);
  assert.match(pending.reason, /replaying/);

  const failed = votes.shotsGateForSession(config, row('failed'));
  assert.equal(failed.allowed, false);
  assert.match(failed.reason, /dialog could not be reached/);

  const stale = votes.shotsGateForSession(config, row('verified', {
    shots_detail: { required: true, state: 'verified', headSha: OLD },
  }));
  assert.equal(stale.allowed, false);
  assert.match(stale.reason, /current commit/);
});

test('the proposal requirements list describes the same exact-head shots gate', () => {
  const pending = requirements.provisional({
    ...row('replaying'), shotsEnforced: true,
    votes_required: 1, yes_count: 1,
    integration_behind_by: 0, integration_merges_clean: true,
    check_state: 'passing',
  });
  const gate = pending.find((item) => item.key === 'shots');
  assert.equal(gate.state, 'active');
  assert.equal(gate.actor, 'author');

  const verified = requirements.provisional({
    ...row('verified'), shotsEnforced: true,
    votes_required: 1, yes_count: 1,
    integration_behind_by: 0, integration_merges_clean: true,
    check_state: 'passing',
  });
  assert.equal(verified.find((item) => item.key === 'shots').state, 'done');
});

test('changing the live enforcement flag supersedes an older recorded checklist', () => {
  const trace = requirements.trace().context({
    shotsEnforced: false, locked: false, selfHosted: false,
    headSha: HEAD, approvalEpoch: 0,
  });
  trace.pass('approvals').stop('checks', 'active');
  assert.equal(requirements.recordIsSuperseded(trace.toRecord(), {
    shotsEnforced: true,
    source: 'native', reviewed_head_sha: HEAD, approval_epoch: 0,
  }), true);
});
