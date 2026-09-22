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

test('a rejected locator exposes the failed plan and permits one changed replay only', async () => {
  const rejected = fixtures.plan();
  const corrected = fixtures.plan();
  corrected.stories[0].replay.before.actions[0].target = {
    by: 'role', role: 'button', name: 'Browse all apps', exact: true,
  };
  const mismatch = Object.assign(new Error('open-members matched 0 elements; exactly one is required.'), {
    code: 'ambiguous_locator',
  });
  let replays = 0;
  const control = new RunControl({
    runId: 'c'.repeat(32), sessionId: 42, intent: fixtures.intent(), context: {},
    expiresAt: Date.now() + 10_000,
    runPlan: async (plan) => {
      replays += 1;
      if (replays === 1) throw mismatch;
      return { hardVerdict: { passed: true }, planHash: contract.planHash(plan) };
    },
  });
  await assert.rejects(control.runPlan(rejected), { code: 'ambiguous_locator' });
  control.allowRepair('Inspect the actual control in both revisions.', {
    code: 'ambiguous_locator', detail: { side: 'base', actionId: 'open-members' },
  });
  const context = control.getContext();
  assert.equal(context.attempt, 2);
  assert.equal(context.repair.failure.detail.actionId, 'open-members');
  assert.deepEqual(context.repair.rejectedPlan, contract.parseReplayPlan(rejected));
  await assert.rejects(control.runPlan(rejected), { code: 'evidence_repair_unchanged' });
  assert.equal(replays, 1, 'an unchanged plan never spends a replay');
  await control.runPlan(corrected);
  assert.equal(replays, 2);
  await assert.rejects(control.runPlan(corrected), { code: 'evidence_plan_attempt_exhausted' });
});
