'use strict';

// A bench first version's plan, as a live one gets it since newcomer run six
// (#5062): the plan written from the description at Make it, its early first
// look drawn from that plan, and the build note Build it makes with the
// suggested answers (bench/runner.js earlySteps, planFirstVersion); and the
// rule for which arms of a studio run can share their plans
// (bench/shared-plans.js mismatchOf).

const test = require('node:test');
const assert = require('node:assert/strict');

const runner = require('../src/services/bench/runner');
const sharedPlans = require('../src/services/bench/shared-plans');
const bot = require('../src/services/homeroom-bot');

const PLAN = Object.freeze({
  bullets: ['Pick a bread and a loaf size', 'See every ingredient in grams'],
  questions: [{ question: 'Which units?', answers: ['Grams', 'Cups'] }],
  buildNote: 'One screen: the bread, the size and the recipe.',
  assumptions: ['Bakers weigh flour'],
});
const SCREEN = '<template data-screen data-size="phone" data-height="900"><main class="app">Bread</main></template>';

function ctxWith({ plan = PLAN, screen = SCREEN, lookOn = true, planError = null, lookError = null } = {}) {
  const calls = { plan: [], look: [], steps: [] };
  const ctx = {
    pool: {}, user: { id: 7 }, app: { id: 3, slug: 'bench-host' },
    onStep: (name) => calls.steps.push(name),
    deps: {
      firstVersionPlan: {
        async makePlan(pool, args) {
          calls.plan.push(args);
          await args.deps.limits.recordSpend(pool, args.user.id, 0.5, { byok: false });
          return plan ? { plan, model: 'z-ai/glm-5.3-flash', error: null } : { plan: null, model: 'z-ai/glm-5.3-flash', error: planError || 'timeout' };
        },
      },
      earlyLook: {
        enabled: () => lookOn,
        async drawScreen(pool, args, deps) {
          calls.look.push({ args, deps });
          await deps.limits.recordSpend(pool, args.user.id, 1.25, { byok: false });
          return screen ? { screen, model: 'anthropic/claude-sonnet-5.5', error: null } : { screen: null, model: 'anthropic/claude-sonnet-5.5', error: lookError || 'timeout' };
        },
      },
    },
  };
  return { ctx, calls };
}

const INPUT = { appName: 'Bread Bot', brief: 'Tell me how much flour, water and salt for a loaf of each bread.' };

test('a first version is planned at Make it, its early first look drawn from that plan, as a live one is', async () => {
  const { ctx, calls } = ctxWith();
  const out = await runner.planFirstVersion(ctx, { input: INPUT, starter: null, replay: {}, base: 'a'.repeat(40), models: { triage: 'x' } });
  // The plan call sees the project by its own name and its creator's words,
  // nobody else in it yet, and the look is drawn from the plan it wrote.
  assert.equal(calls.plan[0].app.name, 'Bread Bot');
  assert.equal(calls.plan[0].brief, INPUT.brief);
  assert.equal(await calls.plan[0].deps.bot.projectMembers(), null);
  assert.equal(calls.look[0].args.plan, PLAN);
  assert.deepEqual(calls.steps, ['plan'], 'no triage turn');
  assert.equal(out.outcome, undefined);
  assert.deepEqual(out.triage, {
    verdict: 'ready', question: null, buildNote: PLAN.buildNote, reason: null, assumptions: PLAN.assumptions, fromMakeIt: true,
  });
  assert.deepEqual(out.plan, { bullets: PLAN.bullets, questions: PLAN.questions });
  // Build it with the suggested answers adds exactly what it adds live.
  const chosen = bot.choicesFrom(PLAN.questions, []);
  assert.deepEqual(out.chosen, chosen);
  assert.equal(out.buildNote, `${PLAN.buildNote}${bot.creatorChoiceNote(chosen, { bullets: PLAN.bullets })}`);
  assert.equal(out.earlyLook, SCREEN, 'the spec starts its main screen from it');
  assert.equal(out.triaged, null);
  // What the two calls cost is metered for the trial (0.5 + 1.25 cents),
  // under the triage the plan replaces, and never recorded against the
  // bench user here: the lane charges the trial once.
  assert.equal(out.helperUsd, 0.0175);
  assert.deepEqual([out.planPart.usd, out.planPart.model], [0.005, 'z-ai/glm-5.3-flash']);
  assert.deepEqual(out.meta.earlyPlan, { model: 'z-ai/glm-5.3-flash', ms: out.meta.earlyPlan.ms, costUsd: 0.005, error: null });
  assert.deepEqual({ ...out.meta.earlyLook, ms: 0 }, { model: 'anthropic/claude-sonnet-5.5', ms: 0, costUsd: 0.0125, error: null, chars: SCREEN.length });
});

test('a game starter reaches both calls; a look that is off or fails leaves the spec to draw its own', async () => {
  const game = ctxWith();
  await runner.planFirstVersion(game.ctx, { input: INPUT, starter: 'game-blocks', replay: {}, base: 'a', models: {} });
  assert.equal(await game.calls.plan[0].deps.bot.starterOfApp(), 'game-blocks');
  assert.equal(await game.calls.look[0].deps.bot.starterOfApp(), 'game-blocks');

  const off = ctxWith({ lookOn: false });
  const quiet = await runner.planFirstVersion(off.ctx, { input: INPUT, starter: null, replay: {}, base: 'a', models: {} });
  assert.equal(off.calls.look.length, 0, 'HOMEROOM_BOT_EARLY_FIRST_LOOK=0 draws nothing');
  assert.equal(quiet.earlyLook, null);
  assert.equal(quiet.meta.earlyLook, null);
  assert.equal(quiet.helperUsd, 0.005);

  const failed = ctxWith({ screen: null, lookError: 'unusable_reply' });
  const drawn = await runner.planFirstVersion(failed.ctx, { input: INPUT, starter: null, replay: {}, base: 'a', models: {} });
  assert.equal(drawn.earlyLook, null);
  assert.equal(drawn.meta.earlyLook.error, 'unusable_reply');
  assert.equal(drawn.triage.fromMakeIt, true, 'the plan still stands');
});

test('the plan and the look are durable steps: a restart after them asks neither again', async () => {
  const { ctx, calls } = ctxWith();
  const kept = new Map();
  const steps = {
    active: true,
    has: (k) => kept.has(k),
    get: (k) => kept.get(k),
    async once(k, fn) { if (!kept.has(k)) kept.set(k, await fn()); return kept.get(k); },
    async set(k, v) { kept.set(k, v); },
  };
  ctx.deps.durable = steps;
  const first = await runner.earlySteps(ctx, { input: INPUT, starter: null });
  const again = await runner.earlySteps(ctx, { input: INPUT, starter: null });
  assert.equal(calls.plan.length, 1);
  assert.equal(calls.look.length, 1);
  assert.deepEqual(again, first);
  assert.deepEqual([...kept.keys()], ['early_plan', 'early_look']);
});

test('only arms that plan alike can share their plans', () => {
  const arm = (label, over = {}) => ({ label, triage: 'z-ai/glm-5.3-flash', spec: 'anthropic/claude-opus-5.5', leanPlan: true, pack: null, ...over });
  assert.equal(sharedPlans.mismatchOf([arm('config:11'), arm('config:13')]), null, 'build tweaks differ, plans do not');
  assert.equal(sharedPlans.mismatchOf([]), null);
  assert.match(sharedPlans.mismatchOf([arm('config:11'), arm('config:9', { leanPlan: false })]), /config:11 and config:9 would not plan alike \(lean_plan\)/);
  assert.match(sharedPlans.mismatchOf([arm('a'), arm('b', { spec: 'z-ai/glm-5.3-flash' })]), /\(spec model\)/);
  assert.match(sharedPlans.mismatchOf([arm('a'), arm('b', { triage: 'x/y' })]), /\(triage model\)/);
  assert.match(sharedPlans.mismatchOf([arm('a'), arm('b', { pack: 7 })]), /\(configuration pack\)/);
});
