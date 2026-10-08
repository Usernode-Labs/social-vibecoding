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
//   - a restart follows a side build's spec, build and review fix turns, as
//     it follows a first version's, and its next claim goes on from what was
//     kept: a kept spec is built from, a kept build is not built again but
//     reviewed (or its cut-short review recorded so) and captured. Until
//     7 Oct 2026 a restart ran it again from the start, and with restarts
//     every few minutes almost none finished.
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

test('a first version\'s triage reads the current configuration\'s model and pack', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/homeroom-bot'), 'utf8');
  const triage = src.slice(src.indexOf('async function runTriage('), src.indexOf('async function actOnVerdict('));
  assert.match(triage, /if \(liveMode && requester\?\.firstVersion\) \{\n\s+const version = await botConfigs\(\)\.currentVersion\(pool\);/);
  assert.match(triage, /model = version\.recipe\.models\.triage;\n\s+triageHarness = live\.recipeHarness\(model, config\);/);
  assert.match(triage, /harness: triageHarness,/);
});

// ── A side build on the App bench lane ───────────────────────────────────

function sideHarness() {
  const calls = { modes: [], pinned: [], ensured: [], captured: 0, deleted: [], reset: [], captureSessions: [] };
  let nextSession = 7001;
  const pool = {
    async query(sql, params) {
      if (/INSERT INTO chat_sessions/.test(String(sql))) {
        const id = nextSession;
        nextSession += 1;
        return { rows: [{ id, branch_name: params[2] ?? null, agent_model: params[4] }] };
      }
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
  const kept = [];
  const out = await runner.runStage({
    pool: h.pool, config: {}, stage: 'first_version', task: { id: 5, stage: 'first_version', reference: {} }, snapshot,
    model: GLM, user: { id: 501, username: 'homeroom_bench' }, app: { id: 9, slug: 'plant-log', name: 'Plant Log', repo_url: 'https://github.com/o/r' },
    repo: { owner: 'o', repo: 'r' }, trial: { id: 44, run_id: 3, attempt: 1 }, deps: h.deps,
    budgets: { turnMs: 60_000, buildMs: 60_000, specMs: 60_000, firstVersion: { turnMs: 60_000, buildMs: 120_000, specMs: 120_000 } },
    title: 't', stageModels: { triage: GLM, spec: GLM, build: GLM }, sideBuild: { botRunId: 900, versionId: 12 },
    harnessOf: live.recipeHarness,
    checkpoint: null, onCheckpoint: async (part) => { kept.push(part); },
  });
  assert.equal(out.status, 'ok', out.error);
  assert.deepEqual(h.calls.modes, ['scout', 'build'], 'a spec and a build, no triage');
  assert.deepEqual(h.calls.deleted, ['bench/r3-t44'], 'any earlier claim\'s branch goes first');
  assert.deepEqual(h.calls.pinned, [{ branch: 'bench/r3-t44', sha: BASE }], 'its branch at the live build\'s commit');
  assert.equal(h.calls.captured, 1, 'then the screenshot step');
  assert.deepEqual(out.capture, { booted: true, shots: [] });
  assert.deepEqual(out.parsed.side, { botRunId: 900 });
  assert.deepEqual(out.parsed.models, { triage: GLM, spec: GLM, build: GLM });
  assert.equal(args.propose, false, 'never proposed');
  // Its spec is posted nowhere: onSpec only keeps it on the trial, for a
  // restart to go on from (it was null until side builds went on, 7 Oct 2026).
  assert.equal(typeof args.onSpec, 'function');
  assert.deepEqual(kept.find((p) => p.spec)?.spec, { sessionId: 7001, specMd: '# Plant log\n\n## User-facing changes\nLogs plants.' });
  assert.deepEqual(kept.filter((p) => p.sessions).pop().sessions, [7001], 'every session it opened, for a release to charge');
  const keptBuild = kept.find((p) => p.build)?.build;
  assert.equal(keptBuild.ok, true, 'the build, kept as it landed');
  assert.equal(keptBuild.sha, 'c'.repeat(40));
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

// Until 7 Oct 2026 this said the opposite: a restart ran a side build again
// from the start, and with the platform restarting every few minutes that
// night almost none finished. Now each of its turns is followed and kept.
test('a restart follows a side build\'s turns and its next claim goes on from what they kept; the judge never sees it', async () => {
  const lanes = require('../src/services/bench/lane');
  for (const mode of ['scout', 'build']) {
    assert.equal(runner.resumableTurn('first_version', { mode }, { side: true }), true, `a first version's side build (${mode})`);
    assert.equal(runner.resumableTurn('build', { mode }, { side: true }), true, `a later change's side build (${mode})`);
    assert.equal(runner.resumableTurn('first_version', { mode }), true, `a studio first version still goes on (${mode})`);
  }
  assert.equal(runner.resumableTurn('first_version', { mode: 'shots' }, { side: true }), false);
  assert.equal(runner.resumableTurn('triage', { mode: 'scout' }, { side: true }), false, 'a side build is never a triage');
  assert.equal(runner.resumableTurn('first_version', null, { side: true }), false);
  assert.equal(lanes.goesOnAfterRestart({ stage: 'first_version', bot_config_version_id: 13 }), true);
  assert.equal(lanes.goesOnAfterRestart({ stage: 'build', bot_config_version_id: 22 }), true, 'a later change\'s');
  assert.equal(lanes.goesOnAfterRestart({ stage: 'first_version' }), true, 'a studio first version, as before');
  assert.equal(lanes.goesOnAfterRestart({ stage: 'build' }), false, 'a benchmark build is finished from its last turn instead');
  assert.equal(lanes.goesOnAfterRestart({ stage: 'first_version', reference_label: 'cc' }), false, 'a reference build has no turns');

  // Which turn it is: a side build has no triage, so its one scout turn is
  // its spec; a build turn is a review's fix once the build has landed.
  const scout = { mode: 'scout' };
  const build = { mode: 'build' };
  assert.equal(runner.sideTurnOf({}, scout), 'spec');
  assert.equal(runner.sideTurnOf(null, build), 'build');
  assert.equal(runner.sideTurnOf({ build: { ok: true, sha: 'd'.repeat(40) } }, build), 'fix');
  assert.equal(runner.sideTurnOf({ build: { ok: false } }, build), 'build');
  assert.equal(runner.sideTurnOf({}, { mode: 'shots' }), null);
  const session = { id: 7001, spec_md: '' };
  const spec = runner.recoverFirstVersionTurn({ checkpoint: { sessions: [7001] }, session, activeTurn: scout, result: { lastResultText: '# Plant log\n\nLogs plants.' }, side: true });
  assert.deepEqual(spec, { step: 'spec', keep: { spec: { sessionId: 7001, specMd: '# Plant log\n\nLogs plants.' } } }, 'never read as a triage');
  const landed = runner.recoverFirstVersionTurn({
    checkpoint: { spec: { sessionId: 7001, specMd: '# Plant log' } }, session, activeTurn: build, result: { pushOk: true, ahead: 2, sha: 'd'.repeat(40) }, side: true,
  });
  assert.equal(landed.step, 'build');
  assert.equal(landed.keep.build.ok, true);
  assert.equal(landed.keep.build.sha, 'd'.repeat(40));
  assert.equal(landed.keep.build.specMd, '# Plant log', 'the spec it was built from');
  assert.equal(runner.recoverFirstVersionTurn({
    checkpoint: { build: { ok: true, sha: 'd'.repeat(40) }, review: { state: 'reviewing' } }, session, activeTurn: build, result: { pushOk: true, ahead: 3, sha: 'e'.repeat(40) }, side: true,
  }), null, 'a review\'s fix keeps nothing of its own');

  const src = require('node:fs').readFileSync(require.resolve('../src/services/bench/lane'), 'utf8');
  assert.match(src, /\{ reference: !!trial\.reference_label, side: !!trial\.bot_config_version_id \}/);
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

// ── A side build's next claim, after a restart ──────────────────────────

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

test('a side build goes on from the spec a restart kept: built from it as it is, its branch cut again at the base', async (t) => {
  const realBuild = live.buildAndPropose;
  let args = null;
  live.buildAndPropose = async (a) => { args = a; return realBuild(a); };
  t.after(() => { live.buildAndPropose = realBuild; });
  const h = sideHarness();
  const kept = [];
  const out = await sideStage(h, {
    checkpoint: { sessions: [6001], spec: { sessionId: 6001, specMd: '# Kept plan\n\nLogs plants.' }, handBacks: 1, handedBackAt: 1 },
    onCheckpoint: async (part) => { kept.push(part); },
  });
  assert.equal(out.status, 'ok', out.error);
  assert.deepEqual(h.calls.modes, ['build'], 'no spec turn: the kept spec is built from');
  assert.equal(args.presetSpec, '# Kept plan\n\nLogs plants.');
  assert.deepEqual(h.calls.deleted, ['bench/r3-t48'], 'the earlier claim\'s branch goes first');
  assert.deepEqual(h.calls.pinned, [{ branch: 'bench/r3-t48', sha: BASE }], 'and the build cuts it at the base again');
  assert.equal(out.parsed.spec, '# Kept plan\n\nLogs plants.');
  assert.equal(out.parsed.resumedAfterRestart, 1);
  assert.deepEqual(out.session_ids, [6001, 7001], 'its result is built from the spec\'s session and the build\'s');
  assert.deepEqual(kept.filter((p) => p.sessions).pop().sessions, [6001, 7001], 'each claim\'s sessions, for a release to charge');
  assert.equal(kept.find((p) => p.build)?.build.sha, 'c'.repeat(40), 'its build kept as it landed');
  assert.ok(!kept.some((p) => p.spec), 'the kept spec is not written again');
  assert.equal(h.calls.captured, 1);
});

test('a side build whose build landed before a restart is not built again: its diff read, then captured on a fresh session at its branch', async () => {
  const h = sideHarness();
  const sessions = [];
  const out = await sideStage(h, {
    checkpoint: {
      sessions: [6001], spec: { sessionId: 6001, specMd: '# Plant log' }, sight: { told: true, passed: true },
      build: { ok: true, sessionId: 6001, sha: 'd'.repeat(40), commits: 2, specMd: '# Plant log' }, handBacks: 2,
    },
    onSession: async (id, info) => { sessions.push({ id, ...info }); },
  });
  assert.equal(out.status, 'ok', out.error);
  assert.deepEqual(h.calls.modes, [], 'no turn runs again');
  assert.deepEqual(h.calls.deleted, [], 'its branch, holding the build, is left as it is');
  assert.deepEqual(h.calls.pinned, []);
  assert.equal(out.build_sha, 'd'.repeat(40));
  assert.equal(out.build_commits, 2);
  assert.equal(out.parsed.built, true);
  assert.equal(out.parsed.spec, '# Plant log');
  assert.equal(out.diff, 'diff', 'read against the base as a live one is');
  assert.deepEqual(out.parsed.sight, { told: true, passed: true });
  assert.deepEqual(sessions, [{ id: 7001, baseSha: BASE, branch: 'bench/r3-t48' }], 'a fresh session at its branch, its worker sealed at the base');
  assert.deepEqual(h.calls.captureSessions, ['w-7001']);
  assert.deepEqual(out.capture, { booted: true, shots: [] });
  assert.deepEqual(out.session_ids, [6001, 7001]);

  // A build the restart caught failing is the trial's outcome, recorded as it is.
  const h2 = sideHarness();
  const failed = await sideStage(h2, {
    checkpoint: { build: { ok: false, sessionId: 6001, sha: null, error: 'the build ran past its time limit (finished after a restart)' } },
  });
  assert.equal(failed.status, 'timeout');
  assert.deepEqual(h2.calls.modes, []);
  assert.equal(h2.calls.captured, 0);
});

test('a side build that landed before its review began is reviewed now, as recovery reviews the live build', async (t) => {
  const realReview = live.reviewLanded;
  let args = null;
  const finalCapture = { booted: true, shots: [{ id: 'phone-light-populated', artifactId: 'a'.repeat(32) }] };
  live.reviewLanded = async (a) => {
    args = a;
    await a.review.onState({ state: 'reviewing', startedAt: '2026-10-07T22:00:00.000Z', rounds: [], round0: null, finalSha: a.start.sha, finalCapture: null });
    return { state: 'done', stop: 'ship', finalSha: 'e'.repeat(40), finalCommits: 3, finalCapture, round0: null, rounds: [{ round: 1, verdict: 'ship', reviewerCostUsd: 0.2 }] };
  };
  t.after(() => { live.reviewLanded = realReview; });
  const h = sideHarness();
  const kept = [];
  const out = await sideStage(h, {
    reviewer: REVIEWER,
    checkpoint: { sessions: [6001], build: { ok: true, sessionId: 6001, sha: 'd'.repeat(40), commits: 2, specMd: '# Plant log' }, handBacks: 1 },
    onCheckpoint: async (part) => { kept.push(part); },
  });
  assert.equal(out.status, 'ok', out.error);
  assert.deepEqual(h.calls.modes, [], 'its build is not run again');
  assert.deepEqual(args.start, { sha: 'd'.repeat(40), commits: 2, costUsd: null, activeMs: null, buildText: null }, 'reviewed from the build that landed');
  assert.deepEqual(args.review.reviewer, REVIEWER);
  assert.deepEqual(args.review.owner, { trialId: 48 }, 'its rounds\' screenshots are the trial\'s');
  assert.equal(args.branchName, 'bench/r3-t48');
  assert.equal(args.session.id, 7001, 'on a fresh session at its branch');
  assert.equal(args.seed, SIDE_SNAPSHOT.texts.seed);
  assert.equal(args.spec, '# Plant log');
  assert.equal(args.turnBudgetMs, 120_000, 'a first version\'s clocks');
  assert.equal(typeof args.runBuildTurn, 'function', 'its fixes run by the live build\'s own runner');
  assert.deepEqual(kept.find((p) => p.reviewSessionId), { reviewSessionId: 7001 });
  assert.equal(kept.find((p) => p.review)?.review.state, 'reviewing', 'its state kept as it goes');
  assert.equal(out.build_sha, 'e'.repeat(40), 'where the review left the branch');
  assert.equal(out.build_commits, 3);
  assert.equal(out.parsed.review.stop, 'ship');
  assert.ok(Math.abs(out.review_cost_usd - 0.2) < 1e-9);
  assert.deepEqual(out.capture, finalCapture, 'its review captured the final state');
  assert.equal(h.calls.captured, 0);
  assert.deepEqual(out.session_ids, [6001, 7001]);
});

test('a side build whose review a restart cut short is not reviewed again: recorded interrupted, an unchecked fix put back, then captured', async (t) => {
  const realReview = live.reviewLanded;
  live.reviewLanded = async () => { throw new Error('a review cut short is not run again'); };
  t.after(() => { live.reviewLanded = realReview; });
  const review = {
    state: 'reviewing', startedAt: '2026-10-07T22:00:00.000Z', reviewer: REVIEWER,
    round0: { sha: 'd'.repeat(40), capture: { booted: true, shots: [] } },
    rounds: [{ round: 1, verdict: 'fix', issues: [{ what: 'x' }], reviewerCostUsd: 0.3, fix: { ok: true, sha: 'e'.repeat(40), commits: 3 } }],
    stop: null, finalSha: 'e'.repeat(40), finalCommits: 3, lastBooted: { sha: 'd'.repeat(40), commits: 2 }, finalCapture: null,
  };
  const landed = { ok: true, sessionId: 6001, sha: 'd'.repeat(40), commits: 2, specMd: '# Plant log' };
  const h = sideHarness();
  // The fix landed before the restart, and no capture saw it.
  h.gh.tip = 'e'.repeat(40);
  const kept = [];
  const out = await sideStage(h, {
    reviewer: REVIEWER, checkpoint: { sessions: [6001], build: landed, review, handBacks: 2 },
    onCheckpoint: async (part) => { kept.push(part); },
  });
  assert.equal(out.status, 'ok', out.error);
  assert.deepEqual(h.calls.reset, [{ branch: 'bench/r3-t48', sha: 'd'.repeat(40) }], 'put back on the last commit that booted, as the live path does');
  assert.equal(out.build_sha, 'd'.repeat(40));
  assert.equal(out.build_commits, 2);
  assert.equal(out.parsed.review.state, 'done');
  assert.equal(out.parsed.review.stop, 'interrupted');
  assert.deepEqual(out.parsed.review.rolledBack, { from: 'e'.repeat(40), to: 'd'.repeat(40), why: 'not seen to boot before the restart' });
  assert.equal(out.parsed.review.roundsUsed, 1);
  assert.ok(Math.abs(out.review_cost_usd - 0.3) < 1e-9, 'the reviewer calls of the claim before, charged once, here');
  assert.equal(kept.find((p) => p.review)?.review.stop, 'interrupted', 'settled on the checkpoint, so a restart in the capture does not settle it again');
  assert.equal(h.calls.captured, 1, 'then captured as it stands');
  assert.deepEqual(h.calls.modes, []);

  // With no commit seen to boot, the branch is taken as the fix left it:
  // its tip, not the last state the review saved.
  const h2 = sideHarness();
  h2.gh.tip = 'e'.repeat(40);
  const out2 = await sideStage(h2, {
    reviewer: REVIEWER,
    checkpoint: { build: landed, review: { ...review, lastBooted: null, finalSha: 'd'.repeat(40), finalCommits: 2 } },
  });
  assert.equal(out2.status, 'ok', out2.error);
  assert.deepEqual(h2.calls.reset, []);
  assert.equal(out2.build_sha, 'e'.repeat(40));
  assert.equal(out2.parsed.review.stop, 'interrupted');
});

test('a side build\'s first claim keeps its build the moment its review begins, so a restart in the review goes on from it', async (t) => {
  const realBuild = live.buildAndPropose;
  live.buildAndPropose = async (a) => {
    await a.onSession({ id: 7001 });
    await a.onSpec({ sessionId: 7001, specMd: '# Plant log' });
    await a.review.onState({ state: 'reviewing', startedAt: '2026-10-07T22:00:00.000Z', round0: null, rounds: [], finalSha: 'd'.repeat(40), finalCommits: 2 });
    await a.review.onState({ state: 'reviewing', round0: { sha: 'd'.repeat(40) }, rounds: [{ verdict: 'fix' }], finalSha: 'e'.repeat(40), finalCommits: 3 });
    return {
      ok: true, sessionId: 7001, sha: 'e'.repeat(40), commits: 3, specMd: '# Plant log',
      review: { state: 'done', stop: 'ship', round0: null, rounds: [], finalSha: 'e'.repeat(40), finalCapture: { booted: true, shots: [] } },
    };
  };
  t.after(() => { live.buildAndPropose = realBuild; });
  const kept = [];
  const out = await sideStage(sideHarness(), { reviewer: REVIEWER, onCheckpoint: async (part) => { kept.push(part); } });
  assert.equal(out.status, 'ok', out.error);
  const builds = kept.filter((p) => p.build);
  assert.equal(builds.length, 1, 'kept once, as its build turn landed; not again when the review is over');
  assert.deepEqual(builds[0].build, { ok: true, sessionId: 7001, sha: 'd'.repeat(40), commits: 2, specMd: '# Plant log', specNote: null, error: null });
  assert.equal(builds[0].review.state, 'reviewing', 'with the review that began');
  assert.equal(kept.filter((p) => p.review).length, 2, 'and the review\'s state as it goes');
  assert.equal(runner.sideTurnOf({ build: builds[0].build }, { mode: 'build' }), 'fix', 'so a build turn after it is the review\'s fix');
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
