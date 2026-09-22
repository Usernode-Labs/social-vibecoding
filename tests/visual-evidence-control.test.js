'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('../src/services/visual-evidence-plan');
const { RunControl } = require('../src/services/visual-evidence-control');
const fixtures = require('./fixtures/visual-evidence');

test('exploration resets and deterministic replay cannot race each other', async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const plan = fixtures.plan();
  const planHash = contract.planHash(plan);
  const control = new RunControl({
    runId: 'a'.repeat(32),
    sessionId: 42,
    intent: fixtures.intent(),
    context: {},
    expiresAt: Date.now() + 10_000,
    resetSide: async () => ({ ok: true }),
    runPlan: async () => {
      await waiting;
      return { hardVerdict: { passed: true }, planHash };
    },
  });

  const replay = control.runPlan(plan);
  await assert.rejects(control.resetSide('base'), { code: 'evidence_control_busy' });
  assert.throws(() => control.finish({ status: 'failed', reason: 'too early' }), {
    code: 'evidence_control_busy',
  });
  release();
  await replay;
  const finished = control.finish({
    status: 'verified', reason: 'The pair proves the claim.', planHash,
  });
  assert.equal(finished.status, 'verified');
  assert.equal(finished.planHash, planHash);
});

test('the evidence turn stays live after waiting for bounded platform replay', async () => {
  const replayPlan = fixtures.plan();
  const planHash = contract.planHash(replayPlan);
  const control = new RunControl({
    runId: 'b'.repeat(32), sessionId: 42, intent: fixtures.intent(), context: {},
    expiresAt: Date.now() + 20,
    runPlan: async () => {
      await new Promise((resolve) => setTimeout(resolve, 70));
      return { hardVerdict: { passed: true }, planHash };
    },
  });
  await control.runPlan(replayPlan);
  assert.equal(control.finish({ status: 'verified', reason: 'The replayed pair proves the claim.', planHash }).status,
    'verified');
});

test('a failed browser plan permits exactly one corrected replay in the same turn', async () => {
  const original = contract.parseReplayPlan(fixtures.plan());
  const corrected = fixtures.plan();
  corrected.stories[0].replay.before.actions[0].target.name = 'Members and guests';
  const correctedHash = contract.planHash(corrected);
  const browserError = Object.assign(new Error('open-members matched 0 elements'), {
    code: 'ambiguous_locator',
    detail: { side: 'base', phase: 'action', actionId: 'open-members', actionStage: 'setup', actionType: 'waitFor', execution: { partialReason: 'do not expose' } },
  });
  const control = new RunControl({
    runId: 'c'.repeat(32), sessionId: 42, intent: fixtures.intent(), context: {},
    repairableCodes: ['ambiguous_locator'],
    runPlan: async (submitted, { attempt }) => {
      if (attempt === 1) throw browserError;
      assert.equal(contract.planHash(submitted), correctedHash);
      return { hardVerdict: { passed: true }, planHash: correctedHash };
    },
  });

  await assert.rejects(control.runPlan(original), { code: 'ambiguous_locator' });
  assert.equal(control.getContext().attempt, 2);
  assert.equal(control.getContext().repairReason, browserError.message);
  assert.deepEqual(control.getContext().repairFailure, {
    code: 'ambiguous_locator', side: 'base', phase: 'action',
    actionId: 'open-members', actionStage: 'setup', actionType: 'waitFor',
  });
  await assert.rejects(control.runPlan(original), { code: 'evidence_plan_unchanged' });
  assert.equal(control.planCalls, 1, 'an unchanged plan cannot consume the repair attempt');
  await control.runPlan(corrected);
  assert.equal(control.lastReplayFailure, null);
  assert.equal(control.latestHard.planHash, correctedHash);
  await assert.rejects(control.runPlan(corrected), { code: 'evidence_plan_attempt_exhausted' });
});
