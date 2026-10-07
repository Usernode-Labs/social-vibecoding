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
//     a restart runs it again rather than following a turn of it; and it is
//     never put to the benchmark's judge (it is picked pairwise).
//
// Run with: node --test tests/bot-config-paths.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const runner = require('../src/services/bench/runner');
const graders = require('../src/services/bench/graders');
const configs = require('../src/services/bot-configs');

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

test('a first version\'s triage reads the current configuration\'s model and pack', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/homeroom-bot'), 'utf8');
  const triage = src.slice(src.indexOf('async function runTriage('), src.indexOf('async function actOnVerdict('));
  assert.match(triage, /if \(liveMode && requester\?\.firstVersion\) \{\n\s+const version = await botConfigs\(\)\.currentVersion\(pool\);/);
  assert.match(triage, /model = version\.recipe\.models\.triage;\n\s+triageHarness = live\.recipeHarness\(model\);/);
  assert.match(triage, /harness: triageHarness,/);
});

// ── A side build on the App bench lane ───────────────────────────────────

function sideHarness() {
  const calls = { modes: [], pinned: [], ensured: [], captured: 0, deleted: [] };
  const pool = {
    async query(sql, params) {
      if (/INSERT INTO chat_sessions/.test(String(sql))) return { rows: [{ id: 7001, branch_name: params[2] ?? null, agent_model: params[4] }] };
      return { rows: [], rowCount: 1 };
    },
  };
  const gh = {
    isEnabled: () => true,
    async getBranchSha() { return 'f'.repeat(40); },
    async ensureBranchAtSha(o, r, branch, sha) { calls.pinned.push({ branch, sha }); },
    async deleteBenchBranch(o, r, branch) { calls.deleted.push(branch); },
    async compareFiles() { return { files: [{ filename: 'app.js' }], diff: 'diff', complete: true, truncated: false }; },
    async createRootCommit() { throw new Error('no first commit for a side build'); },
  };
  const deps = {
    github: runner.guardedGithub(gh),
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker(id, opts) { calls.ensured.push(opts); return 'w-7001'; },
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
    captureStep: async () => { calls.captured += 1; return { ok: true, capture: { booted: true, shots: [] } }; },
    scaffold: async () => { throw new Error('no first commit for a side build'); },
  };
  return { pool, deps, calls };
}

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
  const out = await runner.runStage({
    pool: h.pool, config: {}, stage: 'first_version', task: { id: 5, stage: 'first_version', reference: {} }, snapshot,
    model: GLM, user: { id: 501, username: 'homeroom_bench' }, app: { id: 9, slug: 'plant-log', name: 'Plant Log', repo_url: 'https://github.com/o/r' },
    repo: { owner: 'o', repo: 'r' }, trial: { id: 44, run_id: 3, attempt: 1 }, deps: h.deps,
    budgets: { turnMs: 60_000, buildMs: 60_000, specMs: 60_000, firstVersion: { turnMs: 60_000, buildMs: 120_000, specMs: 120_000 } },
    title: 't', stageModels: { triage: GLM, spec: GLM, build: GLM }, sideBuild: { botRunId: 900, versionId: 12 },
    harnessOf: live.recipeHarness,
  });
  assert.equal(out.status, 'ok', out.error);
  assert.deepEqual(h.calls.modes, ['scout', 'build'], 'a spec and a build, no triage');
  assert.deepEqual(h.calls.pinned, [{ branch: 'bench/r3-t44', sha: BASE }], 'its branch at the live build\'s commit');
  assert.equal(h.calls.captured, 1, 'then the screenshot step');
  assert.deepEqual(out.capture, { booted: true, shots: [] });
  assert.deepEqual(out.parsed.side, { botRunId: 900 });
  assert.deepEqual(out.parsed.models, { triage: GLM, spec: GLM, build: GLM });
  assert.equal(args.propose, false, 'never proposed');
  assert.equal(args.onSpec, null, 'its spec is posted nowhere');
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
});

test('a restart runs a side build again rather than following one of its turns; the judge never sees it', async () => {
  for (const mode of ['scout', 'build']) {
    assert.equal(runner.resumableTurn('first_version', { mode }, { side: true }), false, mode);
    assert.equal(runner.resumableTurn('first_version', { mode }), true, `a studio first version still goes on (${mode})`);
  }
  const src = require('node:fs').readFileSync(require.resolve('../src/services/bench/lane'), 'utf8');
  assert.match(src, /return !!row && row\.stage === 'first_version' && !row\.reference_label && !row\.bot_config_version_id;/);
  assert.match(src, /\{ reference: !!trial\.reference_label, side: !!trial\.bot_config_version_id \}/);
  // A side build's branch is not kept, whatever it holds.
  assert.match(src, /\(!\(patch\.build_commits > 0\) \|\| row\?\.bot_config_version_id\)/);

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

test('a studio arm may name a configuration version, and "today" is the current configuration', () => {
  const studio = require('../src/services/bench/studio');
  const ok = studio.validateLaunch({ models: ['today', 'config:12', GLM], capUsd: 5 });
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(ok.models, ['today', 'config:12', GLM]);
  const bad = studio.validateLaunch({ models: ['config:abc'], capUsd: 5 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /config:<version id>/);
});
