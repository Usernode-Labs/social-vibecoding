'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { collectedUncertainty } = require('../src/services/cli-preview-handoff/checks-outcome');
const { publicSessionStatus } = require('../src/routes/proposal-handoff');

for (const kind of ['capture', 'unit']) {
  test(`unknown ${kind}: absence, interruption and polling deadline cannot establish a verdict`, () => {
    assert.equal(collectedUncertainty(kind, null), null, 'No Job required is distinct from a missing required Job');
    for (const state of ['gone', 'aborted']) {
      assert.equal(collectedUncertainty(kind, { state }), `${kind}_outcome_unconfirmed`);
    }
    assert.equal(collectedUncertainty(kind, { state: 'timeout', stdout: 'partial' }), `${kind}_deadline_unconfirmed`);
    assert.equal(collectedUncertainty(kind, { state: 'failed', stdout: '', stderr: 'failed command' }), null,
      'A verified terminal failure retains existing grading');
  });
}

test('unknown capture: missing frames/logs block; verified unit exit remains authoritative', () => {
  assert.equal(collectedUncertainty('capture', { state: 'succeeded', stdout: '' }), 'capture_output_unavailable');
  assert.equal(collectedUncertainty('capture', { state: 'succeeded', stdout: 'partial', partialReason: 'capture log unavailable' }),
    'capture_output_unavailable');
  assert.equal(collectedUncertainty('capture', { state: 'succeeded', stdout: 'frames' }), null);
  assert.equal(collectedUncertainty('unit', { state: 'succeeded', stdout: '', exitCode: 0 }), null);
  assert.equal(collectedUncertainty('unit', { state: 'failed', partialReason: 'capture log unavailable', exitCode: 1 }), null);
});

test('CLI status exposes blocked identity and reconciliation owner without inventing a verdict', () => {
  const headSha = 'a'.repeat(40);
  const checksRecovery = {
    state: 'blocked', owner: 'check-harvest', reason: 'capture_output_unavailable', runId: 'original', headSha,
  };
  const session = { id: 1, source: 'cli_handoff', status: 'active', check_state: 'pending', checks_commit_sha: headSha };
  const status = publicSessionStatus(session, { checksRecovery });
  assert.deepEqual(status.checksRecovery, checksRecovery);
  assert.match(status.nextStep, /blocked.*check-harvest.*original/);
  assert.match(status.nextStep, /cannot replace/);
  assert.equal(publicSessionStatus(session).checksRecovery, undefined, 'Unenrolled responses remain compatible');
});
