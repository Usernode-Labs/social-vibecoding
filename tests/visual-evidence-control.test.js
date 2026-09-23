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

test('hosted replay submission attaches accepted intent before spending a replay attempt', async () => {
  const accepted = fixtures.intent();
  accepted.stories[0].claim = 'Keep this exact accepted wording.';
  const replay = fixtures.plan().stories[0].replay;
  let submitted;
  const control = new RunControl({
    runId: 'd'.repeat(32), sessionId: 42, intent: accepted, context: {},
    expiresAt: Date.now() + 10_000,
    runPlan: async (candidate) => {
      submitted = candidate;
      return { hardVerdict: { passed: true }, planHash: contract.planHash(candidate) };
    },
  });
  await assert.rejects(control.runReplays([{ id: 'different-story', replay }]),
    { code: 'invalid_visual_evidence' });
  assert.equal(control.planCalls, 0);
  await control.runReplays([{ id: 'invite-suggestions', replay }]);
  assert.equal(control.planCalls, 1);
  assert.deepEqual(contract.semanticIntentFromPlan(submitted), contract.parseIntent(accepted));
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

test('two bounded repairs each require a changed complete plan', async () => {
  const plans = [fixtures.plan(), fixtures.plan(), fixtures.plan()];
  plans[1].stories[0].replay.before.actions[0].target = {
    by: 'role', role: 'button', name: 'Browse all apps', exact: true,
  };
  plans[2].stories[0].replay.after.actions[0].target = {
    by: 'role', role: 'button', name: 'Browse all apps', exact: false,
  };
  let calls = 0;
  const control = new RunControl({
    runId: 'e'.repeat(32), sessionId: 42, intent: fixtures.intent(), context: {},
    expiresAt: Date.now() + 10_000,
    runPlan: async (plan) => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('Missing locator'), { code: 'locator_not_found' });
      return { hardVerdict: { passed: true }, planHash: contract.planHash(plan) };
    },
  });
  await assert.rejects(control.runPlan(plans[0]), { code: 'locator_not_found' });
  control.allowRepair('Check the first locator.', { code: 'locator_not_found' });
  await assert.rejects(control.runPlan(plans[1]), { code: 'locator_not_found' });
  control.allowRepair('Check the next locator.', { code: 'locator_not_found' });
  assert.equal(control.getContext().attempt, 3);
  assert.deepEqual(control.getContext().repair.rejectedPlan, contract.parseReplayPlan(plans[1]));
  await assert.rejects(control.runPlan(plans[1]), { code: 'evidence_repair_unchanged' });
  await control.runPlan(plans[2]);
  assert.equal(calls, 3);
  assert.throws(() => control.allowRepair('No more attempts.', { code: 'locator_not_found' }),
    { code: 'evidence_repair_unavailable' });
});
