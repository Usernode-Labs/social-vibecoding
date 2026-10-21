'use strict';

// Where the configurations meet the bot (src/services/bot-configs.js):
//
//   - a live FIRST VERSION is built by the current configuration: its spec
//     and build models, its pack's guidance, its reviewer, its side builds
//     queued before the build starts, and its results recorded after; every
//     other build keeps the per-stage settings it was handed;
//   - a SIDE BUILD on the App bench lane replays the live run's plan on the
//     live project's own repository, from the live build's commit: no first
//     commit, no triage, never posted or proposed, then the screenshot step;
//     and it is never put to the benchmark's judge (it is picked pairwise);
//   - a side build runs as a durable build, as every trial does, and a
//     restart's next attempt carries it on from the last step it saved: a
//     kept spec is built from, a build that landed is not built again but
//     reviewed and captured, a review goes on from the state it saved, and
//     its branch, once cut, is never cut again. Until 7 Oct 2026 a restart
//     ran it again from the start, and with restarts every few minutes almost
//     none finished.
//
// Run with: node --test tests/bot-config-paths.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const runner = require('../src/services/bench/runner');
const graders = require('../src/services/bench/graders');
const configs = require('../src/services/bot-configs');
const durableSteps = require('../src/services/durable-steps');

const OPUS = 'anthropic/claude-opus-5.5';
const GLM = 'z-ai/glm-5.3-flash';
const BASE = 'b'.repeat(40);
const VERSION = {
  id: 11, key: 'opus-spec-review', label: 'Opus spec, GLM build, Opus review', version: 1, role: 'current',
  recipe: { models: { triage: GLM, spec: OPUS, build: GLM }, reviewer: { model: OPUS, maxRounds: 3, budgetMinutes: 25 }, pack: null },
};

function stubConfigs(t, { version = VERSION, sides = { derived: 1, trials: 1, skipped: 0 } } = {}) {
  const seen = { spawned: [], finished: [] };
  const real = { currentVersion: configs.currentVersion, spawnSideBuilds: configs.spawnSideBuilds, finishLive: configs.finishLive };
  configs.currentVersion = async () => version;
  configs.spawnSideBuilds = async (_pool, _config, args) => { seen.spawned.push(args); return sides; };
  configs.finishLive = async (_pool, args) => { seen.finished.push(args); return true; };
  t.after(() => Object.assign(configs, real));
  return seen;
}

function buildLiveArgs(over = {}) {
  const queries = [];
  return {
    queries,
    args: {
      pool: { async query(sql, params) { queries.push([String(sql), params]); return /RETURNING id/.test(String(sql)) && /homeroom_bot_run_snapshots/.test(String(sql)) ? { rows: [{ id: 321 }] } : { rows: [] }; } },
      config: {}, bot: { id: 77, username: 'homeroom_bot' }, app: { id: 9, slug: 'plant-log' }, repo: { owner: 'o', repo: 'r' },
      issueNumber: 1, issue: { title: 'Plant Log' }, parsed: { verdict: 'ready', buildNote: 'x' }, capSuppressed: null, runId: 900,
      seed: 's', seedReadAt: '2026-10-07T10:00:00Z', postedAt: [], turnBudgetMs: 1000, model: 'stage/build', specModel: 'stage/spec',
      firstVersion: true,
      deps: {
        github: { getBotUsername: async () => 'usernode-bot', async fetchIssueComments() { return { comments: [] }; }, async getBranchSha() { return BASE; } },
        ws: {}, threadContext: { async loadIssueThread() { return { messages: [] }; } },
        limits: { async recordSpend() {}, async checkBudget() { return {}; } },
        managedOpenRouter: { async usesIncludedKey() { return false; } }, domain: 'x',
      },
      ...over,
    },
  };
}

test('a live first version is built by the current configuration, its side builds queued first and its results recorded after', async (t) => {
  const seen = stubConfigs(t);
  const realBuild = live.buildAndPropose;
  const realPost = live.post;
  t.after(() => { live.buildAndPropose = realBuild; live.post = realPost; });
  live.post = async () => ({});
  let args = null;
  const order = [];
  configs.spawnSideBuilds = async (_p, _c, a) => { order.push('spawn'); seen.spawned.push(a); return { derived: 1, trials: 1, skipped: 0 }; };
  live.buildAndPropose = async (a) => { order.push('build'); args = a; return { ok: false, error: 'stop here', costUsd: 1.9, review: { stop: 'ship' } }; };
  const { args: liveArgs, queries } = buildLiveArgs();
  await bot.buildLive(liveArgs);
  assert.deepEqual(order, ['spawn', 'build'], 'the side builds are queued before the live build starts');
  assert.equal(args.model, GLM, 'the recipe\'s build model, not the stage setting');
  assert.equal(args.specModel, OPUS, 'the recipe\'s spec model');
  assert.equal(args.harnessOf, live.recipeHarness, 'an Anthropic model runs in Claude Code');
  assert.deepEqual(args.review.reviewer, VERSION.recipe.reviewer);
  assert.deepEqual(args.review.owner, { botRunId: 900 });
  assert.equal(typeof args.review.onState, 'function');
  assert.equal(await args.review.budgetCheck(), null, 'the bot\'s budget, read from its limits');
  // With what this build has spent so far, which is debited only once it is over.
  liveArgs.deps.limits.checkBudget = async () => ({ ok: true, weeklyRemaining: 100 });
  assert.match(await args.review.budgetCheck({ spentUsd: 1.5 }), /^weekly_limit: this build has spent \$1\.50, and \$1\.00 of the week was left/);
  assert.equal(await args.review.budgetCheck({ spentUsd: 0.5 }), null);
  assert.equal(args.firstVersion, true);
  assert.equal(args.specGuidance, null, 'no pack: the platform\'s own first-version guidance');
  assert.deepEqual(seen.spawned[0].current, VERSION);
  assert.equal(seen.spawned[0].botRunId, 900);
  assert.equal(seen.spawned[0].snapshotId, 321, 'replaying the snapshot the live build recorded');
  assert.equal(seen.finished.length, 1);
  assert.equal(seen.finished[0].version, VERSION);
  assert.equal(seen.finished[0].built.review.stop, 'ship');
  assert.ok(queries.some(([sql, p]) => /SET bot_config_version_id = \$2/.test(sql) && p[0] === 900 && p[1] === 11), 'the run names its configuration');
  // The review state is written onto the run, slimmed.
  await args.review.onState({ state: 'reviewing', rounds: [{ verdict: 'fix' }], stop: null, round0: { capture: { booted: true, checks: { x: 1 }, shots: [] } }, finalCapture: null });
  const saved = queries.find(([sql]) => /SET review = \$2::jsonb, review_rounds = \$3, review_stop = \$4/.test(sql));
  assert.ok(saved);
  assert.equal(saved[1][2], 1);
  assert.ok(!saved[1][1].includes('"checks"'), 'the run keeps the slim capture');
});

test('with no reviewer and no side version, a first version is built as before, and only the models change', async (t) => {
  const seen = stubConfigs(t, {
    version: { ...VERSION, recipe: { ...VERSION.recipe, reviewer: null } }, sides: { derived: 0, trials: 0, skipped: 0 },
  });
  const realBuild = live.buildAndPropose;
  const realPost = live.post;
  t.after(() => { live.buildAndPropose = realBuild; live.post = realPost; });
  live.post = async () => ({});
  let args = null;
  live.buildAndPropose = async (a) => { args = a; return { ok: false, error: 'stop here', costUsd: 0 }; };
  await bot.buildLive(buildLiveArgs().args);
  assert.equal(args.review, null, 'nothing is captured: nothing would read it');
  assert.equal(seen.finished.length, 1);

  // A side version to compare with: the first build is captured, never reviewed.
  stubConfigs(t, { version: { ...VERSION, recipe: { ...VERSION.recipe, reviewer: null } }, sides: { derived: 1, trials: 0, skipped: 0 } });
  await bot.buildLive(buildLiveArgs().args);
  assert.deepEqual(args.review.reviewer, { model: null, maxRounds: 0, budgetMinutes: bot.CAPTURE_ONLY_MINUTES });
});

test('every other build keeps the per-stage settings it was handed', async (t) => {
  const seen = stubConfigs(t);
  const realBuild = live.buildAndPropose;
  const realPost = live.post;
  t.after(() => { live.buildAndPropose = realBuild; live.post = realPost; });
  live.post = async () => ({});
  let args = null;
  live.buildAndPropose = async (a) => { args = a; return { ok: false, error: 'stop here', costUsd: 0 }; };
  await bot.buildLive(buildLiveArgs({ firstVersion: false }).args);
  assert.equal(args.model, 'stage/build');
  assert.equal(args.specModel, 'stage/spec');
  assert.equal(args.review, undefined);
  assert.equal(args.harnessOf, undefined);
  assert.deepEqual(seen.spawned, [], 'no side builds');
  assert.deepEqual(seen.finished, [], 'no results');
  // And with no current configuration at all, a first version is built as it was.
  stubConfigs(t, { version: null });
  await bot.buildLive(buildLiveArgs().args);
  assert.equal(args.model, 'stage/build');
  assert.equal(args.review, undefined);
});

test('a first version\'s triage reads the current configuration\'s model and pack; every other request the later one\'s', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/homeroom-bot'), 'utf8');
  const triage = src.slice(src.indexOf('async function runTriage('), src.indexOf('async function actOnVerdict('));
  assert.match(triage, /if \(liveMode && requester\?\.firstVersion\) \{\n\s+const version = await botConfigs\(\)\.currentVersion\(pool\);/);
  assert.match(triage, /const t = recipeStage\(version\.recipe, 'triage', \{ fallback: model, fallbackMs: turnBudgetMs \}\);\n\s+model = t\.model;/);
  assert.match(triage, /\} else \{\n\s+const recipe = await laterRecipe\(pool\);/);
  assert.match(triage, /triageHarness = live\.recipeHarness\(model, config\);/);
  assert.match(triage, /harness: triageHarness,\n[^\n]*\n\s+\.\.\.\(triageEffort \? \{ reasoningEffort: triageEffort \} : \{\}\),/);
  assert.match(triage, /budgetMs: triageBudgetMs, owner: look\.owner/);
});

test('recipeStage: a stage\'s model, effort and clock from a recipe, else the fallbacks', () => {
  const recipe = {
    models: { triage: 'a/t', spec: 'a/s', build: 'a/b', followup: 'a/f' }, reviewer: null, pack: null,
    effort: { build: 'max', followup: 'low' }, clocks: { triage: 5, build: 45 },
  };
  assert.deepEqual(bot.recipeStage(recipe, 'followup', { fallback: 'x/y', fallbackMs: 1200000 }), { model: 'a/f', effort: 'low', clockMs: 1200000 });
  assert.deepEqual(bot.recipeStage(recipe, 'triage', { fallback: 'x/y', fallbackMs: 1200000 }), { model: 'a/t', effort: null, clockMs: 300000 });
  const noFollowup = { ...recipe, models: { triage: 'a/t', spec: 'a/s', build: 'a/b' } };
  assert.deepEqual(bot.recipeStage(noFollowup, 'followup', { fallback: 'x/y', fallbackMs: 9 }), { model: 'x/y', effort: 'low', clockMs: 9 },
    'a recipe that names no follow-up model leaves it to the per-stage setting');
  assert.deepEqual(bot.recipeStage(null, 'build', { fallback: 'x/y', fallbackMs: 9 }), { model: 'x/y', effort: null, clockMs: 9 });
});

test('recipeBudgets: a configuration\'s own clocks, the platform\'s repository three times them; none named is buildBudgets', () => {
  const app = { repo_url: 'https://github.com/o/app' };
  const recipe = { models: { triage: 'a/t', spec: 'a/s', build: 'a/b' }, reviewer: null, pack: null, clocks: { build: 45, spec: 15 } };
  assert.deepEqual(bot.recipeBudgets(app, {}, 1200000, { firstVersion: true, recipe }), { turnBudgetMs: 45 * 60000, specBudgetMs: 15 * 60000 },
    'a first version\'s clocks are its own, with no factor on top');
  assert.deepEqual(bot.recipeBudgets(app, {}, 1200000, { firstVersion: true, recipe: { ...recipe, clocks: undefined } }),
    bot.buildBudgets(app, {}, 1200000, { firstVersion: true }));
  assert.deepEqual(bot.recipeBudgets(app, {}, 1200000, { recipe: { ...recipe, clocks: { build: 30 } } }),
    { turnBudgetMs: 30 * 60000, specBudgetMs: bot.buildBudgets(app, {}, 1200000).specBudgetMs }, 'a stage it does not name keeps its default');
  const platform = { repo_url: 'https://github.com/Usernode-Labs/social-vibecoding', self_hosted: true, slug: 'usernode-2d5619' };
  const factor = bot.isPlatformRepo(platform, {}) ? bot.PLATFORM_BUILD_TIME_FACTOR : 1;
  assert.equal(bot.recipeBudgets(platform, {}, 1200000, { recipe }).turnBudgetMs, 45 * 60000 * factor);
});

test('a configuration\'s effort reaches the spec, the build and the follow-ups; none named, the session\'s own', () => {
  const fs = require('node:fs');
  const live = fs.readFileSync(require.resolve('../src/services/homeroom-bot-live'), 'utf8');
  assert.match(live, /reasoningEffort: \(efforts && efforts\.spec\) \|\| recipeSpecEffort\(specModel \|\| model\),/);
  assert.match(live, /firstVersion, tweaks: buildTweaks, reasoningEffort: \(efforts && efforts\.build\) \|\| null,/);
  const botSrc = fs.readFileSync(require.resolve('../src/services/homeroom-bot'), 'utf8');
  assert.match(botSrc, /efforts: \{ spec: botConfigs\(\)\.stageEffort\(recipe, 'spec'\), build: botConfigs\(\)\.stageEffort\(recipe, 'build'\) \},/);
  assert.match(botSrc, /const f = recipeStage\(await laterRecipe\(pool\), 'followup', \{/);
  const followup = fs.readFileSync(require.resolve('../src/services/homeroom-bot-followup'), 'utf8');
  assert.match(followup, /harness: 'auto',\n\s+\.\.\.\(reasoningEffort \? \{ reasoningEffort \} : \{\}\),/);
});

// ── A side build on the App bench lane ───────────────────────────────────

// `firstSession` keeps a later attempt's sessions apart from the ones an
// earlier attempt opened.
function sideHarness({ firstSession = 7001 } = {}) {
  const calls = { modes: [], pinned: [], ensured: [], captured: 0, deleted: [], reset: [], captureSessions: [] };
  let nextSession = firstSession;
  const pool = {
    async query(sql, params) {
      if (/INSERT INTO chat_sessions/.test(String(sql))) {
        const id = nextSession;
        nextSession += 1;
        return { rows: [{ id, branch_name: params[2] ?? null, agent_model: params[4] }] };
      }
      // A session an earlier attempt opened, read back.
      if (/SELECT \* FROM chat_sessions WHERE id = \$1/.test(String(sql))) return { rows: [{ id: Number(params[0]), branch_name: null, agent_model: null }] };
      return { rows: [], rowCount: 1 };
    },
  };
  const gh = {
    isEnabled: () => true,
    tip: 'f'.repeat(40),
    async getBranchSha() { return gh.tip; },
    async ensureBranchAtSha(o, r, branch, sha) { calls.pinned.push({ branch, sha }); },
    async deleteBenchBranch(o, r, branch) { calls.deleted.push(branch); },
    async forceBranchToSha(o, r, branch, sha) { calls.reset.push({ branch, sha }); return { updated: true }; },
    async compareFiles() { return { files: [{ filename: 'app.js' }], diff: 'diff', complete: true, truncated: false }; },
    async createRootCommit() { throw new Error('no first commit for a side build'); },
  };
  const deps = {
    github: runner.guardedGithub(gh),
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker(id, opts) { calls.ensured.push(opts); return `w-${id}`; },
      async execInWorker(id, opts) {
        calls.modes.push(opts.mode);
        return opts.mode === 'scout' ? { lastResultText: '# Plant log\n\n## User-facing changes\nLogs plants.' } : { pushOk: true, ahead: 1, sha: 'c'.repeat(40) };
      },
      async stopTurn() {},
      clearPendingStop() {},
    },
    sessions: {
      async runCodexAttemptLoop(args) { await args.resolveRuntime(); return { result: await args.dispatchOnce({}), estimatedCostUsd: 0.1 }; },
      async persistScoutPublication() { return { specVersion: 1 }; },
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
    activeWorkers: new Set(),
    captureStep: async (args) => { calls.captured += 1; calls.captureSessions.push(args.containerName); return { ok: true, capture: { booted: true, shots: [] } }; },
    scaffold: async () => { throw new Error('no first commit for a side build'); },
  };
  return { pool, deps, calls, gh };
}

// A side build runs as a durable build (services/build-runs.js): its stage
// runs on durable steps, and every state it saves is kept here, so a later
// attempt can resume from any of them, as the next leader does after a
// restart that came just after that step was saved.
function keeping({ resumeFrom = null, signal = null } = {}) {
  const saves = [];
  const steps = durableSteps.durable({ resumeFrom, signal, lostAttempts: resumeFrom ? 1 : 0, checkpoint: async (state) => { saves.push(state); } });
  return { steps, saves };
}
const onSteps = (h, steps) => ({ deps: { ...h.deps, durable: steps } });
// The first state saved with `key` in it: a restart just after that step.
const savedAt = (saves, key, test = () => true) => saves.find((s) => key in s && test(s[key]));

test('a side build replays the live run\'s plan on its project, from its commit: no first commit, no triage, then the screenshot step', async (t) => {
  const realBuild = live.buildAndPropose;
  let args = null;
  live.buildAndPropose = async (a) => { args = a; return realBuild(a); };
  t.after(() => { live.buildAndPropose = realBuild; });
  const h = sideHarness();
  const snapshot = {
    id: 321, stage: 'build', issueNumber: 1, baseSha: BASE,
    texts: { seed: 'Issue #1: Plant Log', build_note: 'A plant log.\n\nThe creator chose, from the plan they were shown:\n- Reminders? Yes' },
    extra: { firstVersion: true },
  };
  const k = keeping();
  const out = await runner.runStage({
    pool: h.pool, config: {}, stage: 'first_version', task: { id: 5, stage: 'first_version', reference: {} }, snapshot,
    model: GLM, user: { id: 501, username: 'homeroom_bench' }, app: { id: 9, slug: 'plant-log', name: 'Plant Log', repo_url: 'https://github.com/o/r' },
    repo: { owner: 'o', repo: 'r' }, trial: { id: 44, run_id: 3, attempt: 1 },
    budgets: { turnMs: 60_000, buildMs: 60_000, specMs: 60_000, firstVersion: { turnMs: 60_000, buildMs: 120_000, specMs: 120_000 } },
    title: 't', stageModels: { triage: GLM, spec: GLM, build: GLM }, sideBuild: { botRunId: 900, versionId: 12 },
    harnessOf: live.recipeHarness,
    ...onSteps(h, k.steps),
  });
  assert.equal(out.status, 'ok', out.error);
  assert.deepEqual(h.calls.modes, ['scout', 'build'], 'a spec and a build, no triage');
  assert.deepEqual(h.calls.deleted, ['bench/r3-t44'], 'an earlier claim\'s branch of the same trial goes first');
  assert.deepEqual(h.calls.pinned, [{ branch: 'bench/r3-t44', sha: BASE }], 'its branch at the live build\'s commit');
  assert.equal(h.calls.captured, 1, 'then the screenshot step');
  assert.deepEqual(out.capture, { booted: true, shots: [] });
  assert.deepEqual(out.parsed.side, { botRunId: 900 });
  assert.deepEqual(out.parsed.models, { triage: GLM, spec: GLM, build: GLM });
  assert.equal(args.propose, false, 'never proposed');
  // Its spec is posted nowhere: it is the build's own step, kept for a
  // restart to go on from.
  assert.equal(args.onSpec, null);
  const kept = k.saves.at(-1);
  assert.equal(kept['build/spec'].specMd, '# Plant log\n\n## User-facing changes\nLogs plants.');
  assert.deepEqual(kept['build/session'], { id: 7001 });
  assert.equal(kept['build/turn:build'].phase, 'done', 'the build, kept as it landed');
  assert.equal(kept['build/turn:build'].out.routed.result.sha, 'c'.repeat(40));
  assert.equal(kept['shot:capture'].ok, true, 'then its screenshots');
  assert.deepEqual(out.session_ids, [7001]);
  assert.equal(args.firstVersion, true);
  assert.equal(args.buildNote, snapshot.texts.build_note, 'the live plan, the creator\'s choices in it');
  assert.equal(args.turnBudgetMs, 120_000, 'a first version\'s clocks');
  assert.equal(args.review, undefined, 'no reviewer in its recipe, no review');

  const missing = await runner.runStage({
    pool: h.pool, config: {}, stage: 'first_version', snapshot: { ...snapshot, baseSha: null }, trial: { id: 45, run_id: 3 },
    deps: h.deps, budgets: {}, sideBuild: { botRunId: 900, versionId: 12 },
  });
  assert.equal(missing.status, 'infra_fail');
  assert.match(missing.error, /no build snapshot to replay/);
});

test('a side build with a reviewer is reviewed in its trial, its reviewer calls kept beside the ledger', async (t) => {
  const realBuild = live.buildAndPropose;
  let args = null;
  live.buildAndPropose = async (a) => { args = a; return { ok: true, sessionId: 7001, sha: 'd'.repeat(40), commits: 2, costUsd: 0.9, review: { stop: 'ship', rounds: [{ verdict: 'ship', reviewerCostUsd: 0.21 }, { reviewerCostUsd: 0.2 }], round0: null, finalCapture: null } }; };
  t.after(() => { live.buildAndPropose = realBuild; });
  const h = sideHarness();
  const out = await runner.runStage({
    pool: h.pool, config: {}, stage: 'first_version', task: { id: 5, stage: 'first_version', reference: {} },
    snapshot: { id: 1, stage: 'build', issueNumber: 1, baseSha: BASE, texts: { seed: 's', build_note: 'n' }, extra: {} },
    model: GLM, user: { id: 501 }, app: { id: 9 }, repo: { owner: 'o', repo: 'r' }, trial: { id: 46, run_id: 3, attempt: 1 }, deps: h.deps,
    budgets: { turnMs: 1, buildMs: 1, specMs: 1 }, stageModels: { triage: GLM, spec: OPUS, build: GLM }, sideBuild: { botRunId: 900, versionId: 13 },
    reviewer: { model: OPUS, maxRounds: 2, budgetMinutes: 20 }, harnessOf: live.recipeHarness,
  });
  assert.deepEqual(args.review.reviewer, { model: OPUS, maxRounds: 2, budgetMinutes: 20 });
  assert.deepEqual(args.review.owner, { trialId: 46 }, 'its rounds\' screenshots are the trial\'s');
  assert.equal(args.specModel, OPUS);
  assert.ok(Math.abs(out.review_cost_usd - 0.41) < 1e-9);
  assert.equal(out.parsed.review.stop, 'ship');
  assert.equal(runner.reviewerCost(null), 0);

  // Its review captured the final state (the commit a broken fix was rolled
  // back to, say): that is its capture, not the worker's checkout again.
  const finalCapture = { booted: true, shots: [{ id: 'phone-light-populated', artifactId: 'a'.repeat(32) }] };
  live.buildAndPropose = async () => ({ ok: true, sessionId: 7002, sha: 'e'.repeat(40), commits: 1, costUsd: 0.5, review: { stop: 'regressed', rounds: [], round0: null, finalCapture } });
  const h2 = sideHarness();
  const out2 = await runner.runStage({
    pool: h2.pool, config: {}, stage: 'first_version', task: { id: 5, stage: 'first_version', reference: {} },
    snapshot: { id: 1, stage: 'build', issueNumber: 1, baseSha: BASE, texts: { seed: 's', build_note: 'n' }, extra: {} },
    model: GLM, user: { id: 501 }, app: { id: 9 }, repo: { owner: 'o', repo: 'r' }, trial: { id: 47, run_id: 3, attempt: 1 }, deps: h2.deps,
    budgets: { turnMs: 1, buildMs: 1, specMs: 1 }, stageModels: { triage: GLM, spec: OPUS, build: GLM }, sideBuild: { botRunId: 900, versionId: 13 },
    reviewer: { model: OPUS, maxRounds: 2, budgetMinutes: 20 }, harnessOf: live.recipeHarness,
  });
  assert.equal(out2.status, 'ok', out2.error);
  assert.deepEqual(out2.capture, finalCapture);
  assert.equal(h2.calls.captured, 0, 'the screenshot step is not run again');
});

test('a side build is never put to the judge, and a first version\'s side build keeps no branch', async () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/bench/lane'), 'utf8');
  // A first version's side build's branch is not kept, whatever it holds (a
  // later change's keeps its commits for the sweep, for its pair's compare link).
  assert.match(src, /\(!\(patch\.build_commits > 0\) \|\| \(row\?\.bot_config_version_id && row\?\.run_kind !== LATER_SIDE_RUN_KIND\)\)/);

  const writes = [];
  const pool = {
    async query(sql, params) {
      if (/SELECT tr\.\*/.test(String(sql))) return { rows: [{ id: 46, stage: 'first_version', bot_config_version_id: 13, status: 'ok' }] };
      writes.push([String(sql), params]);
      return { rows: [] };
    },
  };
  const graded = await graders.gradeTrial(pool, 46);
  assert.equal(graded.needsJudge, false);
  assert.match(graded.notes[0], /pairwise/);
  assert.match(writes[0][0], /UPDATE bench_trials SET deterministic/);
});

// ── A side build after a restart ─────────────────────────────────────────

const SIDE_SNAPSHOT = {
  id: 321, stage: 'build', issueNumber: 1, baseSha: BASE,
  texts: { seed: 'Issue #1: Plant Log', build_note: 'A plant log.' }, extra: { firstVersion: true },
};
const REVIEWER = { model: OPUS, maxRounds: 2, budgetMinutes: 20 };

function sideStage(h, over = {}) {
  return runner.runStage({
    pool: h.pool, config: {}, stage: 'first_version', task: { id: 5, stage: 'first_version', reference: {} }, snapshot: SIDE_SNAPSHOT,
    model: GLM, user: { id: 501, username: 'homeroom_bench' }, app: { id: 9, slug: 'plant-log', name: 'Plant Log', repo_url: 'https://github.com/o/r' },
    repo: { owner: 'o', repo: 'r' }, trial: { id: 48, run_id: 3, attempt: 1 }, deps: h.deps,
    budgets: { turnMs: 60_000, buildMs: 60_000, specMs: 60_000, firstVersion: { turnMs: 60_000, buildMs: 120_000, specMs: 90_000 } },
    title: 't', stageModels: { triage: GLM, spec: GLM, build: GLM }, sideBuild: { botRunId: 900, versionId: 12 },
    harnessOf: live.recipeHarness,
    ...over,
  });
}

test('a side build a restart caught after its spec builds from the spec it kept: one build turn, its branch as it was cut', async (t) => {
  const realBuild = live.buildAndPropose;
  let args = null;
  live.buildAndPropose = async (a) => { args = a; return realBuild(a); };
  t.after(() => { live.buildAndPropose = realBuild; });
  const first = sideHarness();
  const k = keeping();
  const before = await sideStage(first, onSteps(first, k.steps));
  assert.equal(before.status, 'ok', before.error);
  // A restart just after its spec was saved.
  const atSpec = savedAt(k.saves, 'build/spec');
  const h = sideHarness({ firstSession: 7101 });
  const out = await sideStage(h, onSteps(h, keeping({ resumeFrom: atSpec }).steps));
  assert.equal(out.status, 'ok', out.error);
  assert.deepEqual(h.calls.modes, ['build'], 'no spec turn: the kept spec is built from');
  assert.equal('presetSpec' in args, false, 'nothing handed in from outside: the build reads its own step');
  assert.equal(out.parsed.spec, '# Plant log\n\n## User-facing changes\nLogs plants.');
  assert.deepEqual(h.calls.deleted, [], 'its branch is not cut again');
  assert.deepEqual(h.calls.pinned, []);
  assert.deepEqual(out.session_ids, [7001], 'built on the session its spec was written in, charged once');
  assert.equal(h.calls.captured, 1);
});

test('a side build a restart caught after its build landed is not built again: its diff read, then captured in its own worker', async () => {
  const first = sideHarness();
  const k = keeping();
  const before = await sideStage(first, onSteps(first, k.steps));
  assert.equal(before.status, 'ok', before.error);
  const landed = savedAt(k.saves, 'build/turn:build', (v) => v.phase === 'done');
  const h = sideHarness({ firstSession: 7101 });
  const sessions = [];
  const out = await sideStage(h, { ...onSteps(h, keeping({ resumeFrom: landed }).steps), onSession: async (id, info) => { sessions.push({ id, ...info }); } });
  assert.equal(out.status, 'ok', out.error);
  assert.deepEqual(h.calls.modes, [], 'no turn runs again');
  assert.deepEqual(h.calls.deleted, [], 'its branch, holding the build, is left as it is');
  assert.deepEqual(h.calls.pinned, []);
  assert.equal(out.build_sha, 'c'.repeat(40));
  assert.equal(out.build_commits, 1);
  assert.equal(out.parsed.built, true);
  assert.equal(out.parsed.spec, '# Plant log\n\n## User-facing changes\nLogs plants.');
  assert.equal(out.diff, 'diff', 'read against the base as a live one is');
  assert.deepEqual(out.parsed.sight, before.parsed.sight, 'what it could see, as its turn ran');
  assert.ok(sessions.every((s) => s.id === 7001), 'on the session it opened, and no other');
  assert.deepEqual(h.calls.captureSessions, ['w-7001'], 'its screenshots in its own worker');
  assert.ok(h.calls.ensured.length && h.calls.ensured.every((o) => o.pinnedBase === BASE && o.branchName === 'bench/r3-t48'),
    'its worker started again at its branch, sealed at the base');
  assert.deepEqual(out.capture, { booted: true, shots: [] });
  assert.deepEqual(out.session_ids, [7001]);
});

test('a side build a restart caught in its review carries the review on from the state it saved: never built again, its review\'s capture its own', async (t) => {
  const botReview = require('../src/services/bot-review');
  const realLoop = botReview.runReviewLoop;
  t.after(() => { botReview.runReviewLoop = realLoop; });
  const stop = new AbortController();
  const loops = [];
  const finalCapture = { booted: true, shots: [{ id: 'phone-light-populated', artifactId: 'a'.repeat(32) }] };
  botReview.runReviewLoop = async (a) => {
    loops.push({ start: a.start, resumeFrom: a.resumeFrom || null });
    if (loops.length === 1) {
      // The first round's verdict is in when the platform restarts.
      await a.onState({
        state: 'reviewing', startedAt: '2026-10-07T22:00:00.000Z', reviewer: REVIEWER, round0: { sha: a.start.sha },
        rounds: [{ round: 1, verdict: 'fix', reviewerCostUsd: 0.3 }], finalSha: a.start.sha, finalCommits: a.start.commits,
      });
      stop.abort();
      throw new durableSteps.StepsStopped();
    }
    return {
      state: 'done', stop: 'ship', finalSha: 'e'.repeat(40), finalCommits: 3, finalCapture, round0: { sha: a.start.sha },
      rounds: [...a.resumeFrom.rounds, { round: 2, verdict: 'ship', reviewerCostUsd: 0.2 }],
    };
  };
  const first = sideHarness();
  const k = keeping({ signal: stop.signal });
  await assert.rejects(sideStage(first, { reviewer: REVIEWER, ...onSteps(first, k.steps) }), { code: 'steps_stopped' },
    'a stop is not the trial\'s failure: its next attempt carries it on');
  const kept = k.saves.at(-1);
  assert.equal(kept['build/reached:landed'], true, 'its build kept as it landed, before its review began');
  assert.equal(kept['build/review_state'].state, 'reviewing', 'and its review\'s state as it went');
  assert.equal('build/reviewed' in kept, false);

  const h = sideHarness({ firstSession: 7101 });
  const out = await sideStage(h, { reviewer: REVIEWER, ...onSteps(h, keeping({ resumeFrom: kept }).steps) });
  assert.equal(out.status, 'ok', out.error);
  assert.deepEqual(h.calls.modes, [], 'its build is not run again');
  assert.equal(loops.length, 2);
  assert.deepEqual([loops[1].start.sha, loops[1].start.commits], ['c'.repeat(40), 1], 'reviewed from the build that landed');
  assert.equal(loops[1].resumeFrom.rounds.length, 1, 'carried on from the round it was at');
  assert.deepEqual(h.calls.deleted, [], 'its branch is not cut again');
  assert.deepEqual(h.calls.pinned, []);
  assert.equal(out.build_sha, 'e'.repeat(40), 'where the review left the branch');
  assert.equal(out.build_commits, 3);
  assert.equal(out.parsed.review.stop, 'ship');
  assert.ok(Math.abs(out.review_cost_usd - 0.5) < 1e-9, 'every round\'s reviewer calls, once');
  assert.deepEqual(out.capture, finalCapture, 'its review captured the final state');
  assert.equal(h.calls.captured, 0, 'so the screenshot step is not run');
  assert.deepEqual(out.session_ids, [7001]);
});

test('a studio arm may name a configuration version, and "today" is the live bot\'s per-stage models, as before', async () => {
  const studio = require('../src/services/bench/studio');
  const ok = studio.validateLaunch({ models: ['today', 'config:12', GLM], capUsd: 5 });
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(ok.models, ['today', 'config:12', GLM]);
  const bad = studio.validateLaunch({ models: ['config:abc'], capUsd: 5 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /config:<version id>/);

  const lanes = require('../src/services/bench/lane');
  const asked = [];
  const pool = { async query(sql) { asked.push(String(sql)); return { rows: [] }; } };
  const settings = { models: { triage: 'stage/triage', spec: 'stage/spec', build: 'stage/build' } };
  const today = await lanes.studioContext(pool, {}, { model: 'today', context_pack_id: null, bot_config_version_id: null }, settings);
  assert.deepEqual(today.stageModels, { triage: 'stage/triage', spec: 'stage/spec', build: 'stage/build' });
  assert.equal(today.reviewer, undefined, 'no reviewer: the live bot\'s stages have none');
  assert.equal(today.harnessOf, undefined);
  assert.ok(!asked.some((q) => /bot_config_versions/.test(q)), 'the current configuration is not read for it');
  // A configuration is its own arm.
  const realById = configs.versionById;
  configs.versionById = async (_p, id) => (id === 11 ? VERSION : null);
  try {
    const arm = await lanes.studioContext(pool, {}, { model: 'config:11', context_pack_id: null, bot_config_version_id: null }, settings);
    assert.deepEqual(arm.stageModels, VERSION.recipe.models);
    assert.deepEqual(arm.reviewer, VERSION.recipe.reviewer);
    await assert.rejects(lanes.studioContext(pool, {}, { model: 'config:12', context_pack_id: null, bot_config_version_id: null }, settings), /configuration version is gone/);
  } finally {
    configs.versionById = realById;
  }
});

test('a bench trial may move only its own branch back, for a review\'s rollback', async () => {
  const moved = [];
  const g = runner.guardedGithub({ async forceBranchToSha(...a) { moved.push(a); return { updated: true }; } });
  await g.resetBenchBranch('o', 'r', 'bench/r3-t44', BASE);
  assert.deepEqual(moved, [['o', 'r', 'bench/r3-t44', BASE]]);
  assert.throws(() => g.resetBenchBranch('o', 'r', 'main', BASE), /may not touch the branch main/);
  assert.throws(() => g.resetBenchBranch('o', 'r', 'dev/homeroom_bot-1', BASE), /may not touch/);
  assert.throws(() => g.forceBranchToSha('o', 'r', 'bench/r3-t44', BASE), /benchmark trials may not call github\.forceBranchToSha/, 'never the raw call');
});

test('a max effort reaches a Claude Code turn, and runs at xhigh in Codex, whose scale stops there', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/agent-turn'), 'utf8');
  assert.match(src, /const requestedReasoningEffort = asked === 'max' && agentHarness !== 'claude' \? 'xhigh' : asked;/);
  assert.ok(require('../src/services/bot-configs').EFFORTS.includes('max'));
});
