'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const proposalUpdate = require('../src/services/proposal-update');
const evidenceState = require('../src/services/visual-evidence-state');
const handoff = require('../src/routes/proposal-handoff');
const { intent } = require('./fixtures/visual-evidence');

const HEAD = 'a'.repeat(40);

test('submission response fields are explicit about acceptance, requirement, and next action', () => {
  assert.deepEqual(proposalUpdate.visualEvidenceSubmissionFields({
    accepted: true, rejected: false, required: true, state: 'planned',
  }), {
    visualEvidenceState: 'planned',
    visualEvidenceAccepted: true,
    visualEvidenceRejected: false,
    visualEvidenceRequired: true,
    visualEvidenceNextStep: 'await_visual_evidence',
  });
  assert.equal(proposalUpdate.visualEvidenceNextStep('failed', { required: true }),
    'rerun_or_correct_visual_evidence');
  assert.equal(proposalUpdate.visualEvidenceNextStep(null, { rejected: true }),
    'retry_visual_evidence_intent');
});

test('a disabled collector rejects a supplied declaration instead of pretending it was stored', async () => {
  const result = await proposalUpdate.applyVisualEvidenceRevision({
    pool: {},
    config: { visualEvidence: { collect: false } },
    session: { id: 42, visual_evidence_state: null, visual_evidence_detail: null },
    headSha: HEAD,
    visualEvidence: intent(),
    headChanged: true,
  });
  assert.equal(result.accepted, false);
  assert.equal(result.rejected, true);
  assert.equal(result.changed, false);
  assert.equal(result.nextStep, 'visual_evidence_collection_disabled');
});

test('a head-changing update stales old evidence before recording the preserved declaration', async () => {
  const originalStale = evidenceState.markStaleForHead;
  const originalRecord = evidenceState.recordIntent;
  const calls = [];
  try {
    evidenceState.markStaleForHead = async (_pool, sessionId, headSha) => {
      calls.push(['stale', sessionId, headSha]);
    };
    evidenceState.recordIntent = async (_pool, sessionId, parsed, options) => {
      calls.push(['record', sessionId, parsed.impact, options.headSha]);
      return {
        accepted: true, unchanged: false, required: true, state: 'planned',
        detail: { intent: parsed, required: true, headSha: options.headSha }, runId: null,
      };
    };
    const session = {
      id: 42,
      visual_evidence_state: 'verified',
      visual_evidence_detail: { intent: intent(), required: true, headSha: 'b'.repeat(40) },
    };
    const result = await proposalUpdate.applyVisualEvidenceRevision({
      pool: {}, config: { visualEvidence: { collect: true } }, session,
      headSha: HEAD, visualEvidence: undefined, headChanged: true,
    });
    assert.deepEqual(calls.map((call) => call[0]), ['stale', 'record']);
    assert.equal(result.accepted, false, 'preserved intent was not falsely reported as newly submitted');
    assert.equal(result.rejected, false);
    assert.equal(result.required, true);
    assert.equal(result.state, 'planned');
    assert.equal(result.nextStep, 'await_visual_evidence');
  } finally {
    evidenceState.markStaleForHead = originalStale;
    evidenceState.recordIntent = originalRecord;
  }
});

test('native handoff build requests accept the same strictly parsed visual intent', () => {
  const parsed = handoff.parseBuildBody({
    schemaVersion: 1,
    headSha: HEAD,
    history: [],
    tests: [],
    visualEvidence: intent(),
  });
  assert.equal(parsed.visualEvidence.impact, 'ui');
  assert.equal(parsed.visualEvidence.stories[0].intent.baseState, 'present');
  const bad = intent();
  bad.stories[0].intent.startPath = 'https://evil.example';
  assert.throws(() => handoff.parseBuildBody({
    schemaVersion: 1, headSha: HEAD, history: [], tests: [], visualEvidence: bad,
  }), /relative in-app path/);
});
