'use strict';

// A studio run's shared plans (services/bench/shared-plans.js) against the
// FULL PostgreSQL schema: a launch with `sharedPlans` refuses arms that would
// not plan alike and keys every trial's plan by the attempt it was launched
// as, a rerun keeping its trial's; the first trial to need a plan makes it
// and the others wait for its spec, take over one whose maker failed or went
// quiet, and stop when the trial is cancelled; the runner hands a waiter the
// maker's spec, plan and build note as they are (runner.sharedFirstVersionPlan);
// and what the plan and the early first look cost is added to the trial's
// charge beside its turns (lane.recordTrial).
//
// Skips when no database is reachable, unless TEST_DATABASE_URL insists.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const GLM = 'z-ai/glm-5.3-flash';
const OPUS = 'anthropic/claude-opus-5.5';
const PLAN = Object.freeze({
  bullets: ['Pick a bread and a loaf size', 'See every ingredient in grams'],
  questions: [{ question: 'Which units?', answers: ['Grams', 'Cups'] }],
  buildNote: 'One screen: the bread, the size and the recipe.',
  assumptions: ['Bakers weigh flour'],
});
const SCREEN = '<template data-screen data-size="phone" data-height="900"><main class="app">Bread</main></template>';

test('a studio run\'s shared plans against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `bench_shared_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const studio = require('../src/services/bench/studio');
  const lane = require('../src/services/bench/lane');
  const runner = require('../src/services/bench/runner');
  const sharedPlans = require('../src/services/bench/shared-plans');
  const bot = require('../src/services/homeroom-bot');

  const { rows: [evan] } = await pool.query("INSERT INTO users (username, password, is_admin) VALUES ('evan', 'x', TRUE) RETURNING id");
  const created = [];
  const deps = {
    async createApp(_config, app) {
      created.push(app.id);
      await pool.query("UPDATE apps SET repo_url = $2, status = 'running' WHERE id = $1", [app.id, `https://github.com/usernode-bot/${app.slug}`]);
    },
  };
  const config = async (key, tweaks) => {
    const { rows: [row] } = await pool.query(
      `INSERT INTO bot_config_versions (key, label, version, recipe, role, scope)
       VALUES ($1, $1, 1, $2, 'side', 'first_version') RETURNING id`,
      [key, JSON.stringify({ models: { triage: GLM, spec: OPUS, build: GLM }, reviewer: null, pack: null, ...(tweaks.length ? { tweaks } : {}) })],
    );
    return `config:${row.id}`;
  };
  const lean = await config('lean', ['lean_plan']);
  const roomy = await config('lean-roomy', ['lean_plan', 'roomy_context']);
  const plain = await config('plain', []);

  let run;
  let trials;
  await t.test('a launch shares plans only between arms that plan alike, keyed by the attempt each trial was launched as', async () => {
    const refused = await studio.launch(pool, {}, { briefs: [{ ref: 'bread' }], models: [lean, plain], capUsd: 10, sharedPlans: true }, { actorId: evan.id, deps });
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 400);
    assert.match(refused.error, new RegExp(`${lean} and ${plain} would not plan alike \\(lean_plan\\)`));
    const badFlag = await studio.launch(pool, {}, { briefs: [{ ref: 'bread' }], models: [lean], capUsd: 10, sharedPlans: 'yes' }, { actorId: evan.id, deps });
    assert.match(badFlag.error, /sharedPlans is true or false/);
    assert.equal(created.length, 0, 'nothing was made for a refused launch');

    const launched = await studio.launch(pool, {}, {
      briefs: [{ ref: 'bread' }], models: [lean, roomy], repeats: 2, capUsd: 20, sharedPlans: true,
    }, { actorId: evan.id, deps });
    assert.equal(launched.ok, true, launched.error);
    assert.equal(launched.run.sharedPlans, true);
    assert.equal(launched.trials, 4);
    run = launched.run;
    const { rows: [r] } = await pool.query('SELECT shared_plans FROM bench_runs WHERE id = $1', [run.id]);
    assert.equal(r.shared_plans, true);
    ({ rows: trials } = await pool.query(
      'SELECT id, run_id, task_id, model, attempt, plan_key FROM bench_trials WHERE run_id = $1 ORDER BY attempt, model', [run.id],
    ));
    assert.deepEqual(trials.map((x) => [x.attempt, x.plan_key]), [[1, 1], [1, 1], [2, 2], [2, 2]]);
    const watched = await studio.watchRun(pool, run.id);
    assert.equal(watched.run.sharedPlans, true);

    // A run that does not ask shares nothing, whatever its arms.
    const own = await studio.launch(pool, {}, { briefs: [{ ref: 'bread' }], models: [lean, plain], capUsd: 10 }, { actorId: evan.id, deps });
    assert.equal(own.ok, true, own.error);
    assert.equal(own.run.sharedPlans, false);
    await pool.query("UPDATE bench_runs SET status = 'cancelled' WHERE id = $1", [own.run.id]);
  });

  await t.test('a rerun builds from the same plan as the trial it runs again; the lane hands its key to the runner', async () => {
    const second = trials.find((x) => x.attempt === 2);
    await pool.query("UPDATE bench_trials SET status = 'infra_fail', finished_at = NOW() WHERE id = $1", [second.id]);
    const again = await studio.rerunTrial(pool, second.id);
    assert.equal(again.ok, true, again.error);
    assert.equal(again.attempt, 3);
    const { rows: [made] } = await pool.query('SELECT plan_key FROM bench_trials WHERE id = $1', [again.trialId]);
    assert.equal(made.plan_key, 2);
    const settings = await bot.readSettings(pool);
    const row = await lane.loadTrialContext(pool, again.trialId);
    const ctx = await lane.studioContext(pool, {}, row, settings);
    assert.deepEqual(ctx.sharedPlan, { key: 2 });
    const plainRow = await lane.loadTrialContext(pool, trials[0].id);
    assert.deepEqual((await lane.studioContext(pool, {}, { ...plainRow, run_shared_plans: false }, settings)).sharedPlan, undefined);
  });

  await t.test('the first trial to need a plan makes it; the others wait for its spec, or take over one left failed or quiet', async () => {
    const [a, b, c] = trials;
    const where = { runId: run.id, taskId: a.task_id, packId: null, key: 1 };
    assert.equal((await sharedPlans.claim(pool, { ...where, trialId: a.id })).role, 'maker');
    const waiting = await sharedPlans.claim(pool, { ...where, trialId: b.id });
    assert.equal(waiting.role, 'waiter');
    assert.deepEqual(await sharedPlans.claim(pool, { ...where, trialId: a.id }), { role: 'maker', id: waiting.id }, 'its own claim, carried on after a restart');
    await sharedPlans.savePlanned(pool, waiting.id, { plan: { bullets: PLAN.bullets }, buildNote: 'note', earlyLook: SCREEN, planUsd: 0.005, lookUsd: 0.0125 });
    const quick = { trialId: b.id, waitMs: 40, pollMs: 10 };
    assert.deepEqual(await sharedPlans.waitFor(pool, waiting.id, quick), { error: 'the shared plan was not ready in time' });
    assert.deepEqual(await sharedPlans.waitFor(pool, waiting.id, { ...quick, stopped: async () => 'cancelled by an admin' }), { error: 'cancelled by an admin', stopped: true });
    await sharedPlans.saveSpec(pool, waiting.id, { specMd: '# Bread', specHtml: '<main>Bread</main>' });
    const got = await sharedPlans.waitFor(pool, waiting.id, quick);
    assert.equal(got.row.status, 'ready');
    assert.deepEqual([got.row.specMd, got.row.specHtml, got.row.buildNote, got.row.earlyLook], ['# Bread', '<main>Bread</main>', 'note', SCREEN]);
    assert.deepEqual([got.row.planUsd, got.row.lookUsd, got.row.makerTrialId], [0.005, 0.0125, a.id]);
    assert.equal((await sharedPlans.claim(pool, { ...where, trialId: c.id })).role, 'ready');
    await sharedPlans.saveFailed(pool, waiting.id, 'late');
    assert.equal((await sharedPlans.readById(pool, waiting.id)).status, 'ready', 'a plan once ready stays ready');

    // A failed plan is the next trial's to make; so is one whose maker went quiet.
    const failed = { ...where, key: 7 };
    const f = await sharedPlans.claim(pool, { ...failed, trialId: a.id });
    await sharedPlans.saveFailed(pool, f.id, 'the plan could not be written');
    assert.deepEqual(await sharedPlans.claim(pool, { ...failed, trialId: b.id }), { role: 'maker', id: f.id });
    const row = await sharedPlans.readById(pool, f.id);
    assert.deepEqual([row.status, row.claimedBy, row.makerTrialId, row.error], ['making', `trial:${b.id}`, b.id, null]);
    await pool.query("UPDATE bench_shared_plans SET claimed_at = NOW() - INTERVAL '31 minutes' WHERE id = $1", [f.id]);
    assert.deepEqual(await sharedPlans.waitFor(pool, f.id, { trialId: c.id, waitMs: 40, pollMs: 10 }), { take: true });
    assert.equal((await sharedPlans.readById(pool, f.id)).makerTrialId, c.id);
  });

  // A trial's context as the runner reads it, its plan and look stubbed.
  const ctxFor = (trial, { key, skipCheck = null, calls = { plan: 0, look: 0 } } = {}) => ({
    pool, trial: { id: trial.id, run_id: run.id }, task: { id: trial.task_id }, pack: null, user: { id: evan.id }, app: { id: 1, slug: 'host' },
    sharedPlan: { key }, skipCheck,
    deps: {
      sharedPlanWait: { waitMs: 5000, pollMs: 10 },
      firstVersionPlan: {
        async makePlan(p, args) {
          calls.plan += 1;
          await args.deps.limits.recordSpend(p, args.user.id, 0.5, { byok: false });
          return { plan: PLAN, model: GLM, error: null };
        },
      },
      earlyLook: {
        enabled: () => true,
        async drawScreen(p, args, d) {
          calls.look += 1;
          await d.limits.recordSpend(p, args.user.id, 1.25, { byok: false });
          return { screen: SCREEN, model: 'anthropic/claude-sonnet-5.5', error: null };
        },
      },
    },
  });
  const input = { appName: 'Bread Bot', brief: 'Tell me how much flour, water and salt for a loaf of each bread.' };
  const args = { input, starter: null, replay: {}, base: 'a'.repeat(40), models: { triage: GLM } };

  await t.test('the maker plans as a live first version does and keeps the plan; every other arm builds from its spec as it is', async () => {
    const [a, b] = trials;
    const calls = { plan: 0, look: 0 };
    const made = await runner.sharedFirstVersionPlan(ctxFor(a, { key: 3, calls }), args);
    assert.equal(made.outcome, undefined);
    assert.ok(made.makes > 0);
    assert.deepEqual(made.meta.sharedPlan, { id: made.makes, key: 3, made: true, makerTrialId: a.id });
    assert.equal(made.earlyLook, SCREEN);
    assert.equal(made.helperUsd, 0.0175, 'the maker pays for the plan');
    assert.deepEqual(calls, { plan: 1, look: 1 });
    const { rows: [kept] } = await pool.query('SELECT status, plan, build_note, early_look, plan_usd FROM bench_shared_plans WHERE id = $1', [made.makes]);
    assert.equal(kept.status, 'making', 'not ready until its spec is written');
    assert.deepEqual(kept.plan.bullets, PLAN.bullets);
    assert.deepEqual(kept.plan.chosen, made.chosen);
    assert.equal(kept.plan.triage.fromMakeIt, true);
    assert.equal(kept.build_note, made.buildNote);
    assert.equal(kept.early_look, SCREEN);
    assert.equal(Number(kept.plan_usd), 0.005);

    // The other arm waits, and builds from the maker's spec the moment it is saved.
    const theirs = { plan: 0, look: 0 };
    const waiting = runner.sharedFirstVersionPlan(ctxFor(b, { key: 3, calls: theirs }), args);
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    await sharedPlans.saveSpec(pool, made.makes, { specMd: '# Bread Bot', specHtml: '<main>Bread Bot</main>' });
    const shared = await waiting;
    assert.deepEqual(theirs, { plan: 0, look: 0 }, 'it asks for no plan of its own');
    assert.equal(shared.makes, undefined);
    assert.deepEqual([shared.presetSpec, shared.presetSpecHtml], ['# Bread Bot', '<main>Bread Bot</main>']);
    assert.equal(shared.buildNote, made.buildNote);
    assert.deepEqual(shared.plan, made.plan);
    assert.deepEqual(shared.chosen, made.chosen);
    assert.deepEqual(shared.triage, { ...made.triage, shared: true });
    assert.equal(shared.helperUsd, 0, 'and pays nothing for it');
    assert.equal(shared.earlyLook, undefined, 'its spec is written already');
    assert.deepEqual(shared.meta, { sharedPlan: { id: made.makes, key: 3, made: false, makerTrialId: a.id }, earlyLook: { chars: SCREEN.length, shared: true } });
  });

  await t.test('a waiter makes the plan itself when its maker fails, and stops when its trial is cancelled', async () => {
    const [a, b, c] = trials;
    const first = await sharedPlans.claim(pool, { runId: run.id, taskId: a.task_id, key: 4, trialId: a.id });
    const calls = { plan: 0, look: 0 };
    const waiting = runner.sharedFirstVersionPlan(ctxFor(b, { key: 4, calls }), args);
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    await sharedPlans.saveFailed(pool, first.id, 'the spec turn timed out');
    const took = await waiting;
    assert.equal(took.makes, first.id);
    assert.deepEqual(took.meta.sharedPlan, { id: first.id, key: 4, made: true, makerTrialId: b.id });
    assert.deepEqual(calls, { plan: 1, look: 1 });

    const stopped = await runner.sharedFirstVersionPlan(ctxFor(c, { key: 4, skipCheck: async () => 'cancelled by an admin' }), args);
    assert.equal(stopped.outcome.status, 'cancelled');
    assert.match(stopped.outcome.error, /^shared plan: cancelled by an admin/);
    assert.equal(stopped.helperUsd, 0);
  });

  await t.test('what the plan and the early first look cost is charged with the trial, beside its turns', async () => {
    const [a] = trials;
    await pool.query("UPDATE bench_trials SET status = 'running' WHERE id = $1", [a.id]);
    const { rows: [before] } = await pool.query('SELECT spent_usd FROM bench_runs WHERE id = $1', [run.id]);
    const status = await lane.recordTrial(pool, {
      trialRow: { id: a.id, run_id: run.id },
      row: { stage: 'first_version', repo_url: null },
      patch: { status: 'cancelled', error: 'cancelled by an admin', cost_usd: null, helper_cost_usd: 0.0175, parsed: { built: false } },
      user: null,
      d: { github: null, worker: { evictWorker: async () => {} }, limits: {}, managedOpenRouter: { usesIncludedKey: async () => false }, afterTrial: async () => {} },
    });
    assert.equal(status, 'cancelled');
    const { rows: [tr] } = await pool.query('SELECT cost_usd FROM bench_trials WHERE id = $1', [a.id]);
    assert.equal(Number(tr.cost_usd), 0.0175, 'a trial that ran no turn still paid for its plan');
    const { rows: [after] } = await pool.query('SELECT spent_usd FROM bench_runs WHERE id = $1', [run.id]);
    assert.equal(Math.round((Number(after.spent_usd) - Number(before.spent_usd)) * 1e6) / 1e6, 0.0175);
  });
});
