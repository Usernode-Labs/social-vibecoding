'use strict';

// The `later` scope of the Homeroom bot's configurations
// (src/services/bot-configs.js): every live build that is not a first
// version follows the later scope's current version.
//
//   - the seed: an Opus spec and a GLM build, current, beside all GLM;
//   - ROUTING: a later live build takes its spec
//     and build models, the CLI each runs in and the spec's effort from the
//     current later version, name it on the run, queue its side versions
//     and record its result; with no current later version (or one the
//     catalog cannot run, or a lookup that fails) they are built exactly as
//     before; a first version is untouched;
//   - a SIDE BUILD of a later change replays the run's plan at its commit,
//     in its own worker on a `bench/` branch, never proposed and never
//     pushed anywhere else, with the later spec prompt and no capture; it
//     follows the shadow builds' rule for the platform's own repository; and
//     after a restart it goes on from the last step it saved: a kept spec is
//     built from, a build that landed is its result;
//   - a side whose recipe PLANS ALIKE (the live recipe's spec model, pack and
//     tweaks) waits for the live build's spec and builds from it, with no
//     spec of its own; one whose live build stopped at its plan builds
//     nothing; any other writes its own spec, as every side did before;
//   - its side builds take only the build slots live builds leave free;
//   - a later pair is left out only when a side did not build (or is known
//     not to boot) or both are one commit; the live proposals' outcomes.
//
// tests/bot-configs-later-postgres.test.js runs the rest against the schema.
//
// Run with: node --test tests/bot-configs-later.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const runner = require('../src/services/bench/runner');
const configs = require('../src/services/bot-configs');
const durableSteps = require('../src/services/durable-steps');

const OPUS = 'anthropic/claude-opus-5.5';
const GLM = 'z-ai/glm-5.3-flash';
const BASE = 'b'.repeat(40);
const LATER = {
  id: 21, key: 'later-opus-spec', label: 'Opus spec + GLM build', version: 1, role: 'current', scope: 'later',
  recipe: { models: { triage: GLM, spec: OPUS, build: GLM }, reviewer: null, pack: null },
};
const FIRST = {
  id: 11, key: 'opus-spec-review', label: 'Opus spec, GLM build, Opus review', version: 1, role: 'current', scope: 'first_version',
  recipe: { models: { triage: GLM, spec: OPUS, build: GLM }, reviewer: { model: OPUS, maxRounds: 2, budgetMinutes: 20 }, pack: null },
};
const APP = { id: 9, slug: 'todo', name: 'Todo', repo_url: 'https://github.com/usernode-bot/todo', self_hosted: false };
const PLATFORM = { id: 1, slug: 'usernode-2d5619', name: 'Homeroom', repo_url: 'https://github.com/Usernode-Labs/social-vibecoding.git' };

// The real doors, taken once, so stubbing twice in one test restores these.
const REAL = Object.fromEntries(['currentVersion', 'laterVersion', 'spawnSideBuilds', 'finishLive', 'recipeGuidance', 'abandonSideBuilds']
  .map((n) => [n, configs[n]]));
const REAL_LIVE = { buildAndPropose: live.buildAndPropose, post: live.post };

/** Stub the configurations' doors the bot reaches for; what each was asked is kept. */
function stubConfigs(t, { later = LATER, first = FIRST } = {}) {
  const seen = { spawned: [], finished: [], abandoned: [], laterAsked: 0, firstAsked: [] };
  configs.currentVersion = async (_pool, scope = 'first_version') => { seen.firstAsked.push(scope); return scope === 'first_version' ? first : null; };
  configs.laterVersion = async () => { seen.laterAsked += 1; return later; };
  configs.spawnSideBuilds = async (_pool, _config, args) => { seen.spawned.push(args); return { derived: 0, trials: 1, skipped: 0 }; };
  configs.finishLive = async (_pool, args) => { seen.finished.push(args); return true; };
  configs.recipeGuidance = async () => null;
  configs.abandonSideBuilds = async (_pool, runId, why) => { seen.abandoned.push([runId, why]); return 1; };
  t.after(() => Object.assign(configs, REAL));
  return seen;
}

function buildLiveArgs(over = {}) {
  const queries = [];
  return {
    queries,
    args: {
      pool: { async query(sql, params) { queries.push([String(sql), params]); return /RETURNING id/.test(String(sql)) && /homeroom_bot_run_snapshots/.test(String(sql)) ? { rows: [{ id: 321 }] } : { rows: [] }; } },
      config: {}, bot: { id: 77, username: 'homeroom_bot' }, app: APP, repo: { owner: 'usernode-bot', repo: 'todo' },
      issueNumber: 4, issue: { title: 'Dark mode' }, parsed: { verdict: 'ready', buildNote: 'Add dark mode.' }, capSuppressed: null, runId: 900,
      seed: 's', seedReadAt: '2026-10-07T10:00:00Z', postedAt: [], turnBudgetMs: 1000, model: 'stage/build', specModel: 'stage/spec',
      firstVersion: false, settings: { shadowBuildPlatform: false },
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

function stubBuild(t, outcome = { ok: false, error: 'stop here', costUsd: 0.6 }) {
  t.after(() => Object.assign(live, REAL_LIVE));
  live.post = async () => ({});
  const calls = [];
  live.buildAndPropose = async (a) => { calls.push(a); return outcome; };
  return calls;
}

test('the later changes start from two configurations: an Opus spec and a GLM build, current, beside all GLM', () => {
  assert.equal(configs.SEED_LATER.length, 2);
  const [cur, side] = configs.SEED_LATER;
  assert.deepEqual([cur.label, cur.role, cur.scope], ['Opus spec + GLM build', 'current', 'later']);
  assert.deepEqual(cur.recipe, { models: { triage: GLM, spec: OPUS, build: GLM }, reviewer: null, pack: null });
  assert.deepEqual([side.label, side.role, side.scope], ['All GLM', 'side', 'later']);
  assert.deepEqual(side.recipe, { models: { triage: GLM, spec: GLM, build: GLM }, reviewer: null, pack: null });
  // The same model ids as the first versions' seed, every recipe valid, every seed key and key its own.
  assert.equal(configs.GLM, GLM);
  assert.equal(configs.OPUS, OPUS);
  const all = [...configs.SEED, ...configs.SEED_LATER];
  for (const s of all) assert.equal(configs.validateRecipe(s.recipe).ok, true, s.seedKey);
  assert.equal(new Set(all.map((s) => s.seedKey)).size, all.length);
  assert.equal(new Set(all.map((s) => s.key)).size, all.length, 'a key belongs to one scope');
  assert.equal(configs.SEED.every((s) => !s.scope || s.scope === 'first_version'), true);
  // Each scope's side builds have their own week: $50 for later changes.
  assert.equal(configs.DEFAULT_LATER_SIDE_WEEKLY_CENTS, 5000);
  assert.notEqual(configs.LATER_SIDE_WEEKLY_KEY, configs.SIDE_WEEKLY_KEY);
  assert.notEqual(configs.LATER_SIDE_RUN_KIND, configs.SIDE_RUN_KIND);
  // A scope left out is a first version's; anything else unknown is refused.
  assert.equal(configs.scopeOf(undefined), 'first_version');
  assert.equal(configs.scopeOf(''), 'first_version');
  assert.equal(configs.scopeOf('later'), 'later');
  assert.equal(configs.scopeOf('everything'), null);
});

test('a later live build is built by the current later version: its models, its CLI, its side builds and its result', async (t) => {
  const seen = stubConfigs(t);
  const calls = stubBuild(t);
  const order = [];
  configs.spawnSideBuilds = async (_p, _c, a) => { order.push('spawn'); seen.spawned.push(a); return { derived: 0, trials: 1, skipped: 0 }; };
  const realBuild = live.buildAndPropose;
  live.buildAndPropose = async (a) => { order.push('build'); return realBuild(a); };
  const { args, queries } = buildLiveArgs();
  await bot.buildLive(args);
  assert.deepEqual(order, ['spawn', 'build'], 'the side builds are queued before the build starts');
  const a = calls[0];
  assert.equal(seen.laterAsked, 1);
  assert.deepEqual(seen.firstAsked, [], 'the first versions\' configuration is not read for it');
  assert.equal(a.model, GLM, 'the later recipe\'s build model, not the stage setting');
  assert.equal(a.specModel, OPUS, 'the later recipe\'s spec model');
  assert.equal(a.harnessOf, live.recipeHarness, 'an Anthropic model runs in Claude Code');
  assert.equal(live.recipeHarness(OPUS, {}), 'claude');
  assert.equal(live.recipeSpecEffort(OPUS), 'medium', 'its spec\'s effort, as a first version\'s Opus spec has it');
  assert.equal(a.review, null, 'no review and no capture for a later change');
  assert.equal(a.firstVersion, false, 'today\'s spec prompt, not the first-version design brief');
  assert.equal(a.propose, undefined, 'a live build is proposed as before');
  assert.deepEqual(seen.spawned[0].current, LATER);
  assert.equal(seen.spawned[0].scope, 'later');
  assert.equal(seen.spawned[0].skipReason, null);
  assert.equal(seen.spawned[0].snapshotId, 321, 'replaying the snapshot this build recorded');
  assert.equal(seen.finished.length, 1);
  assert.equal(seen.finished[0].version, LATER);
  assert.ok(queries.some(([sql, p]) => /SET bot_config_version_id = \$2/.test(sql) && p[0] === 900 && p[1] === 21), 'the run names its configuration');
  const snap = queries.find(([sql]) => /INSERT INTO homeroom_bot_run_snapshots/.test(sql));
  assert.ok(snap && JSON.stringify(snap[1]).includes(OPUS), 'the snapshot records the spec model that ran');
});

test('a later live build stopped before it was proposed records nothing for its configuration: its side builds are stopped', async (t) => {
  const seen = stubConfigs(t);
  stubBuild(t, { ok: false, skipped: 'the request was closed while it was being built', sessionId: 5, costUsd: 0.3 });
  await bot.buildLive(buildLiveArgs().args);
  assert.deepEqual(seen.finished, [], 'a stop is not the configuration\'s failure');
  assert.deepEqual(seen.abandoned, [[900, 'stopped before it was proposed (the request was closed while it was being built)']]);
});

test('with no current later version, a later live build is built exactly as before', async (t) => {
  const seen = stubConfigs(t, { later: null });
  const calls = stubBuild(t);
  const { args, queries } = buildLiveArgs();
  await bot.buildLive(args);
  const a = calls[0];
  assert.equal(a.model, 'stage/build');
  assert.equal(a.specModel, 'stage/spec');
  assert.equal(a.harnessOf, undefined);
  assert.equal(a.review, undefined);
  assert.equal(a.specGuidance, undefined, 'no pack guidance either');
  assert.deepEqual(seen.spawned, [], 'no side builds');
  assert.deepEqual(seen.finished, [], 'no results');
  assert.ok(!queries.some(([sql]) => /SET bot_config_version_id/.test(sql)), 'the run names no configuration');
});

test('a first version is untouched: the first versions\' configuration, its review, its side builds', async (t) => {
  const seen = stubConfigs(t);
  const calls = stubBuild(t);
  await bot.buildLive(buildLiveArgs({ firstVersion: true }).args);
  assert.equal(seen.laterAsked, 0, 'the later configuration is not read for a first version');
  assert.deepEqual(seen.firstAsked, ['first_version']);
  assert.deepEqual(calls[0].review.reviewer, FIRST.recipe.reviewer);
  assert.equal(seen.spawned[0].scope, undefined, 'its side builds are the first versions\' as before');
  assert.equal(seen.spawned[0].current, FIRST);
});

test('the platform\'s own repository: a later change\'s side builds follow the shadow builds\' rule', async (t) => {
  assert.match(bot.laterSideSkipReason({ shadowBuildPlatform: false }, PLATFORM, {}), /homeroom_bot_shadow_build_platform is off/);
  assert.equal(bot.laterSideSkipReason({ shadowBuildPlatform: true }, PLATFORM, {}), null);
  assert.equal(bot.laterSideSkipReason({ shadowBuildPlatform: false }, APP, {}), null);
  assert.match(bot.laterSideSkipReason(null, PLATFORM, {}), /left out/, 'without settings to read, left out');
  const seen = stubConfigs(t);
  stubBuild(t);
  await bot.buildLive(buildLiveArgs({ app: PLATFORM, repo: { owner: 'Usernode-Labs', repo: 'social-vibecoding' } }).args);
  assert.match(seen.spawned[0].skipReason, /platform's own repository/);
});

// ── Fail open ───────────────────────────────────────────────────────────

function catalogPool({ current = LATER, catalog = [{ id: GLM }, { id: OPUS }], throwOn = null } = {}) {
  return {
    async query(sql, params) {
      const s = String(sql);
      if (throwOn && throwOn.test(s)) throw new Error('connection reset');
      if (/FROM bot_config_versions v\s+WHERE v\.role = 'current' AND v\.scope = \$1/.test(s)) {
        assert.deepEqual(params, ['later']);
        return { rows: current ? [{ ...current, recipe: current.recipe }] : [] };
      }
      if (/FROM openrouter_model_catalog/.test(s)) return { rows: catalog ? [{ models: catalog }] : [] };
      return { rows: [] };
    },
  };
}

test('laterVersion fails open: no current version, a model missing from the catalog, no catalog, or a failed lookup', async () => {
  const ok = await configs.laterVersion(catalogPool());
  assert.equal(ok.id, 21);
  assert.equal(ok.scope, 'later');
  assert.equal(await configs.laterVersion(catalogPool({ current: null })), null);
  assert.equal(await configs.laterVersion(catalogPool({ catalog: [{ id: GLM }] })), null, 'Opus is not in the stored catalog');
  assert.equal(await configs.laterVersion(catalogPool({ catalog: null })), null, 'no stored catalog to check against');
  assert.equal(await configs.laterVersion(catalogPool({ throwOn: /bot_config_versions/ })), null, 'a failed lookup');
  assert.equal(await configs.laterVersion(catalogPool({ throwOn: /openrouter_model_catalog/ })), null);
  // A later recipe that no longer validates is no version at all.
  assert.equal(await configs.laterVersion(catalogPool({ current: { ...LATER, recipe: { models: {} } } })), null);
});

// ── A later change's side build on the App bench lane ──────────────────

function sideHarness() {
  const calls = { prompts: [], runtimes: [], pinned: [], deleted: [], captured: 0, pushed: [] };
  const pool = {
    async query(sql, params) {
      if (/INSERT INTO chat_sessions/.test(String(sql))) return { rows: [{ id: 7001, branch_name: params[2] ?? null, agent_model: params[4] }] };
      // A session an earlier attempt opened, read back.
      if (/SELECT \* FROM chat_sessions WHERE id = \$1/.test(String(sql))) return { rows: [{ id: Number(params[0]), branch_name: null, agent_model: null }] };
      return { rows: [], rowCount: 1 };
    },
  };
  const gh = {
    isEnabled: () => true,
    async getBranchSha() { return 'f'.repeat(40); },
    async getFileContent() { return null; },
    async ensureBranchAtSha(o, r, branch, sha) { calls.pinned.push({ branch, sha }); },
    async deleteBenchBranch(o, r, branch) { calls.deleted.push(branch); },
    async compareFiles() { return { files: [{ filename: 'app.js', additions: 4, deletions: 1 }], diff: 'diff', complete: true, truncated: false }; },
    async createPullRequest() { calls.pushed.push('pr'); },
    async createIssueComment() { calls.pushed.push('comment'); },
  };
  const deps = {
    github: runner.guardedGithub(gh),
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() { return 'w-7001'; },
      async execInWorker(id, opts) {
        calls.prompts.push({ mode: opts.mode, prompt: opts.prompt, model: opts.model, branch: opts.branchName });
        return opts.mode === 'scout' ? { lastResultText: '# Dark mode\n\n## User-facing changes\nA dark look.' } : { pushOk: true, ahead: 1, sha: 'c'.repeat(40) };
      },
      async stopTurn() {},
      clearPendingStop() {},
    },
    sessions: {
      async runCodexAttemptLoop(args) { await args.resolveRuntime(); return { result: await args.dispatchOnce({}), estimatedCostUsd: 0.1 }; },
      async persistScoutPublication() { return { specVersion: 1 }; },
    },
    agentTurn: { async resolveCodexRuntimeContext(a) { calls.runtimes.push({ model: a.model, harness: a.harness, effort: a.reasoningEffort || null }); return {}; } },
    activeWorkers: new Set(),
    captureStep: async () => { calls.captured += 1; return { ok: true, capture: { booted: true, shots: [] } }; },
  };
  return { pool, deps, calls };
}

test('a later side build replays the run\'s plan at its commit on a bench branch: its own spec on its own models, never proposed, no capture', async (t) => {
  let args = null;
  live.buildAndPropose = async (a) => { args = a; return REAL_LIVE.buildAndPropose(a); };
  t.after(() => Object.assign(live, REAL_LIVE));
  const h = sideHarness();
  const snapshot = {
    id: 654, stage: 'build', issueNumber: 12, baseSha: BASE,
    texts: { seed: 'Issue #12: Dark mode', build_note: 'Add a dark look.' },
    extra: { firstVersion: false, model: GLM, specModel: OPUS },
  };
  const out = await runner.runStage({
    pool: h.pool, config: {}, stage: 'build', task: { id: 5, stage: 'build', reference: {} }, snapshot,
    model: GLM, user: { id: 501, username: 'homeroom_bench' }, app: { id: 9, slug: 'todo', name: 'Todo', repo_url: APP.repo_url },
    repo: { owner: 'usernode-bot', repo: 'todo' }, trial: { id: 44, run_id: 3, attempt: 1 }, deps: h.deps,
    budgets: { turnMs: 60_000, buildMs: 60_000, specMs: 30_000 },
    title: 't', stageModels: { triage: GLM, spec: OPUS, build: GLM }, sideBuild: { botRunId: 901, versionId: 22 },
    harnessOf: live.recipeHarness,
  });
  assert.equal(out.status, 'ok', out.error);
  assert.deepEqual(h.calls.prompts.map((p) => p.mode), ['scout', 'build'], 'its own spec, then its build: no triage');
  assert.deepEqual(h.calls.prompts.map((p) => p.model), [OPUS, GLM]);
  assert.ok(h.calls.prompts.every((p) => p.branch === 'bench/r3-t44'), 'only ever its own bench branch');
  assert.deepEqual(h.calls.deleted, ['bench/r3-t44'], 'any earlier claim\'s branch goes first');
  assert.deepEqual(h.calls.pinned, [{ branch: 'bench/r3-t44', sha: BASE }], 'cut at the commit the run started from');
  assert.deepEqual(h.calls.runtimes[0], { model: OPUS, harness: 'claude', effort: 'medium' }, 'the spec on Opus in Claude Code, at the recipe\'s effort');
  assert.equal(h.calls.runtimes[h.calls.runtimes.length - 1].harness, 'auto', 'the build on GLM keeps the platform\'s CLI');
  assert.match(h.calls.prompts[0].prompt, /DESIGN BRIEF:/, 'today\'s spec prompt');
  assert.ok(!/DESIGN BRIEF \(FIRST VERSION\)/.test(h.calls.prompts[0].prompt), 'not the first-version design brief');
  assert.equal(h.calls.captured, 0, 'no screenshot step');
  assert.equal(out.capture, undefined);
  assert.deepEqual(h.calls.pushed, [], 'nothing posted, nothing opened');
  assert.equal(args.propose, false, 'never proposed');
  // Its spec is posted nowhere: it is the build's own step, kept for a
  // restart to go on from.
  assert.equal(args.onSpec, null);
  assert.equal(args.review, undefined, 'no review');
  assert.equal(args.firstVersion, false);
  assert.equal(args.seed, snapshot.texts.seed, 'the same request seed');
  assert.equal(args.buildNote, snapshot.texts.build_note, 'the same triage build note');
  assert.equal(args.turnBudgetMs, 60_000, 'a later build\'s clocks');
  assert.deepEqual(out.parsed.models, { triage: GLM, spec: OPUS, build: GLM });
  assert.deepEqual(out.parsed.side, { botRunId: 901 });
  assert.equal(out.build_branch, 'bench/r3-t44');
  assert.deepEqual(out.changed_files.files, [{ filename: 'app.js', additions: 4, deletions: 1 }], 'its diff is kept on the trial');

  // The guarded client a side build is handed refuses any branch but its own, and any write.
  assert.throws(() => h.deps.github.ensureBranchAtSha('o', 'r', 'main', BASE), /may not touch the branch main/);
  assert.throws(() => h.deps.github.createPullRequest('o', 'r', {}), /benchmark trials may not call github\.createPullRequest/);

  const missing = await runner.runStage({
    pool: h.pool, config: {}, stage: 'build', snapshot: { ...snapshot, baseSha: null }, trial: { id: 45, run_id: 3 },
    deps: h.deps, budgets: {}, sideBuild: { botRunId: 901, versionId: 22 },
  });
  assert.equal(missing.status, 'infra_fail');
  assert.match(missing.error, /no build snapshot to replay/);
});

// Until 7 Oct 2026 a restart ran a side build again from the start. It runs
// as a durable build now, as every trial does (services/build-runs.js): a
// restart's next attempt goes on from the last step it saved.
test('a later side build goes on after a restart from the last step it saved: a spec is built from, a build is its result', async (t) => {
  let args = null;
  live.buildAndPropose = async (a) => { args = a; return REAL_LIVE.buildAndPropose(a); };
  t.after(() => Object.assign(live, REAL_LIVE));
  const snapshot = {
    id: 654, stage: 'build', issueNumber: 12, baseSha: BASE,
    texts: { seed: 'Issue #12: Dark mode', build_note: 'Add a dark look.' }, extra: { firstVersion: false },
  };
  // Every state the stage saves is kept, as the workflow kernel keeps it, so
  // a later attempt can resume from one of them.
  const stage = (h, resumeFrom = null) => {
    const saves = [];
    const durable = durableSteps.durable({ resumeFrom, lostAttempts: resumeFrom ? 1 : 0, checkpoint: async (state) => { saves.push(state); } });
    return runner.runStage({
      pool: h.pool, config: {}, stage: 'build', task: { id: 5, stage: 'build', reference: {} }, snapshot,
      model: GLM, user: { id: 501, username: 'homeroom_bench' }, app: { id: 9, slug: 'todo', name: 'Todo', repo_url: APP.repo_url },
      repo: { owner: 'usernode-bot', repo: 'todo' }, trial: { id: 46, run_id: 3, attempt: 1 }, deps: { ...h.deps, durable },
      budgets: { turnMs: 60_000, buildMs: 60_000, specMs: 30_000 },
      title: 't', stageModels: { triage: GLM, spec: OPUS, build: GLM }, sideBuild: { botRunId: 901, versionId: 22 },
      harnessOf: live.recipeHarness,
    }).then((out) => ({ out, saves }));
  };
  const first = await stage(sideHarness());
  assert.equal(first.out.status, 'ok', first.out.error);

  // A restart just after its spec was saved: the spec is built from.
  const h = sideHarness();
  const { out: fromSpec } = await stage(h, first.saves.find((s) => 'build/spec' in s));
  assert.equal(fromSpec.status, 'ok', fromSpec.error);
  assert.deepEqual(h.calls.prompts.map((p) => p.mode), ['build'], 'no spec turn: the kept spec is built from');
  assert.equal('presetSpec' in args, false, 'nothing handed in from outside: the build reads its own step');
  assert.equal(fromSpec.parsed.spec, '# Dark mode\n\n## User-facing changes\nA dark look.');
  assert.deepEqual(h.calls.deleted, [], 'its branch is not cut again');
  assert.deepEqual(h.calls.pinned, []);
  assert.equal(fromSpec.build_sha, 'c'.repeat(40));

  // A restart just after its build turn's result was saved: the build is its result.
  const h2 = sideHarness();
  const { out: fromBuild } = await stage(h2, first.saves.find((s) => s['build/turn:build']?.phase === 'done'));
  assert.equal(fromBuild.status, 'ok', fromBuild.error);
  assert.deepEqual(h2.calls.prompts, [], 'nothing runs again');
  assert.deepEqual(h2.calls.deleted, [], 'its branch keeps the build');
  assert.deepEqual(h2.calls.pinned, []);
  assert.equal(fromBuild.build_sha, 'c'.repeat(40));
  assert.equal(fromBuild.parsed.spec, '# Dark mode\n\n## User-facing changes\nA dark look.', 'its spec, which its pair shows');
  assert.deepEqual(fromBuild.changed_files.files, [{ filename: 'app.js', additions: 4, deletions: 1 }]);
  assert.equal(h2.calls.captured, 0, 'a later change has no screenshot step');
  assert.deepEqual(fromBuild.parsed.side, { botRunId: 901 });
  assert.deepEqual(fromBuild.session_ids, [7001], 'the session the first attempt opened');
});

// 19 Oct 2026: each side build wrote an Opus spec of its own, about 93% of
// what it cost, and its pair compared two plans as well as two builds. A
// side whose recipe plans as the live one does builds from the live build's.

const DS = 'deepseek/deepseek-v4.1-flash-1017';
const LIVE_SPEC = '# Dark mode\n\n## User-facing changes\nThe live build\'s own plan.';
// Its polls, without the clock.
const NO_WAIT = { pollMs: 1, sleep: async () => {} };

test('a later side plans alike when its spec model, pack and tweaks are the live recipe\'s: its triage and build may differ', () => {
  const current = LATER.recipe;
  assert.equal(configs.plansAlike(current, { ...current, models: { ...current.models, build: DS } }), true);
  assert.equal(configs.plansAlike(current, { ...current, models: { triage: DS, spec: OPUS, build: DS } }), true, 'its triage is the live run\'s, replayed');
  assert.equal(configs.plansAlike(current, { ...current, models: { ...current.models, spec: GLM } }), false, 'All GLM writes its own');
  assert.equal(configs.plansAlike(current, { ...current, pack: 3 }), false, 'a pack guides the spec');
  assert.equal(configs.plansAlike(current, { ...current, tweaks: ['lean_plan'] }), false);
  assert.equal(configs.plansAlike(current, { models: {} }), false, 'a recipe that does not validate');
});

/**
 * A side build's harness whose pool answers the live run's plan
 * (bot-configs.js liveSpecState) from `states`, one row per look (the last
 * one repeated), and the live spec's text.
 */
function livePlanHarness(states) {
  const h = sideHarness();
  const looks = [];
  const base = h.pool.query.bind(h.pool);
  h.pool.query = async (sql, params) => {
    const text = String(sql);
    if (/FROM homeroom_bot_runs r\s+JOIN bot_config_versions cv/.test(text)) {
      looks.push(params);
      const row = states[Math.min(looks.length, states.length) - 1];
      return { rows: row ? [row] : [] };
    }
    if (/SELECT content, content_html FROM chat_session_specs/.test(text)) {
      return { rows: Number(params[0]) === 8100 && Number(params[1]) === 1 ? [{ content: LIVE_SPEC, content_html: null }] : [] };
    }
    return base(sql, params);
  };
  return { ...h, looks };
}

function liveRow(over = {}) {
  return {
    current_recipe: LATER.recipe, side_recipe: { ...LATER.recipe, models: { ...LATER.recipe.models, build: DS } },
    build_ok: null, build_error: null, session_id: null, version: null, ...over,
  };
}

function laterSide(h, over = {}) {
  return runner.runStage({
    pool: h.pool, config: {}, stage: 'build', task: { id: 5, stage: 'build', reference: {} },
    snapshot: {
      id: 654, stage: 'build', issueNumber: 12, baseSha: BASE,
      texts: { seed: 'Issue #12: Dark mode', build_note: 'Add a dark look.' }, extra: { firstVersion: false },
    },
    model: DS, user: { id: 501, username: 'homeroom_bench' }, app: { id: 9, slug: 'todo', name: 'Todo', repo_url: APP.repo_url },
    repo: { owner: 'usernode-bot', repo: 'todo' }, trial: { id: 47, run_id: 3, attempt: 1 },
    deps: { ...h.deps, livePlanWait: NO_WAIT },
    budgets: { turnMs: 60_000, buildMs: 60_000, specMs: 30_000 },
    title: 't', stageModels: { triage: GLM, spec: OPUS, build: DS }, sideBuild: { botRunId: 901, versionId: 23 },
    harnessOf: live.recipeHarness,
    ...over,
  });
}

test('a later side that plans alike waits for the live build\'s spec and builds from it: no spec of its own', async (t) => {
  let args = null;
  live.buildAndPropose = async (a) => { args = a; return REAL_LIVE.buildAndPropose(a); };
  t.after(() => Object.assign(live, REAL_LIVE));
  const h = livePlanHarness([liveRow(), liveRow(), liveRow({ session_id: 8100, version: 1 })]);
  const out = await laterSide(h);
  assert.equal(out.status, 'ok', out.error);
  assert.equal(h.looks.length, 3, 'it looked until the live spec was written');
  assert.deepEqual(h.looks[0], [901, 23], 'the live run and its own version');
  assert.deepEqual(h.calls.prompts.map((p) => [p.mode, p.model]), [['build', DS]], 'no spec turn: only its build');
  assert.equal(args.presetSpec, LIVE_SPEC, 'built from the live build\'s spec as it is');
  assert.equal(out.parsed.spec, LIVE_SPEC, 'which its pair shows on both sides');
  assert.deepEqual(out.parsed.livePlan, { sessionId: 8100, version: 1 }, 'named for its result\'s cost');
  assert.deepEqual(out.parsed.side, { botRunId: 901 });
  assert.equal(args.propose, false, 'never proposed');
  assert.deepEqual(h.calls.pushed, []);
});

test('a later side whose live plan stopped at its plan builds nothing; any other side writes its own spec as before', async () => {
  // The live plan found the request already done: nothing to compare.
  const blocked = livePlanHarness([liveRow({ build_ok: false, build_error: 'blocked: The fix is already on main (#5457).' })]);
  const stopped = await laterSide(blocked);
  assert.equal(stopped.status, 'not_applicable', 'recorded skipped, never as a build that failed');
  assert.match(stopped.error, /^the live build stopped at its plan: blocked: The fix is already on main \(#5457\)\.$/);
  assert.deepEqual(blocked.calls.prompts, [], 'no turn, no spend');
  assert.equal(stopped.parsed.built, false);

  const ownSpec = async (h, over) => {
    const out = await laterSide(h, over);
    assert.equal(out.status, 'ok', out.error);
    assert.deepEqual(h.calls.prompts.map((p) => [p.mode, p.model]), [['scout', OPUS], ['build', DS]], 'its own spec, then its build');
    assert.equal(out.parsed.livePlan, undefined);
    return out;
  };
  // A recipe that plans differently, looked at once.
  const differs = livePlanHarness([liveRow({ side_recipe: { ...LATER.recipe, models: { triage: GLM, spec: GLM, build: GLM } } })]);
  await ownSpec(differs, { stageModels: { triage: GLM, spec: OPUS, build: DS } });
  assert.equal(differs.looks.length, 1);
  // A run that names no configuration (or is gone): no row.
  await ownSpec(livePlanHarness([]));
  // The live build ended without a spec for another reason.
  await ownSpec(livePlanHarness([liveRow({ build_ok: false, build_error: 'the spec turn failed (timeout)' })]));
  // None came in time.
  const late = livePlanHarness([liveRow()]);
  await ownSpec(late, { deps: { ...late.deps, livePlanWait: { ...NO_WAIT, waitMs: 0 } } });
  // Its text is gone.
  await ownSpec(livePlanHarness([liveRow({ session_id: 8100, version: 2 })]));
  // A database error while it looks.
  const broken = livePlanHarness([liveRow()]);
  const query = broken.pool.query;
  broken.pool.query = async (sql, params) => {
    if (/FROM homeroom_bot_runs r\s+JOIN bot_config_versions cv/.test(String(sql))) throw new Error('connection reset');
    return query(sql, params);
  };
  await ownSpec(broken);

  // An admin's cancel while it waits.
  const waiting = livePlanHarness([liveRow()]);
  const cancelled = await laterSide(waiting, { skipCheck: async () => 'cancelled by an admin' });
  assert.deepEqual([cancelled.status, cancelled.error], ['cancelled', 'cancelled by an admin']);
  assert.deepEqual(waiting.calls.prompts, []);
});

test('a later side that plans alike goes on after a restart from the live spec it found, without looking again', async () => {
  const saves = [];
  const durable = durableSteps.durable({ resumeFrom: null, lostAttempts: 0, checkpoint: async (state) => { saves.push(state); } });
  const h = livePlanHarness([liveRow({ session_id: 8100, version: 1 })]);
  assert.equal((await laterSide(h, { deps: { ...h.deps, durable, livePlanWait: NO_WAIT } })).status, 'ok');
  const kept = saves.find((s) => 'live_plan' in s && !('build/spec' in s));
  assert.deepEqual(kept.live_plan, { spec: { sessionId: 8100, version: 1 } }, 'the spec it found, not its text');
  const again = livePlanHarness([liveRow()]);
  const resumed = durableSteps.durable({ resumeFrom: kept, lostAttempts: 1, checkpoint: async () => {} });
  const out = await laterSide(again, { deps: { ...again.deps, durable: resumed, livePlanWait: NO_WAIT } });
  assert.equal(out.status, 'ok', out.error);
  assert.equal(again.looks.length, 0, 'not looked for again');
  assert.equal(out.parsed.spec, LIVE_SPEC);
  assert.deepEqual(again.calls.prompts.map((p) => p.mode), ['build']);
});

test('a later change\'s side builds take only the live slots live work leaves free', async () => {
  const settings = { buildConcurrency: 2, liveAtOnce: 12 };
  assert.equal(await bot.isLiveLaneSaturated(settings, { live: 2, besides: 1 }), false, 'two live builds no longer hold side builds back');
  assert.equal(await bot.isLiveLaneSaturated(settings, { live: 9, besides: 2 }), false);
  assert.equal(await bot.isLiveLaneSaturated(settings, { live: 9, besides: 3 }), true, 'live work and side builds fill the twelve slots');
  assert.equal(await bot.isLiveLaneSaturated(settings, { live: 0, besides: 11 }), false);
  assert.equal(await bot.isLiveLaneSaturated(settings, { live: 12 }), true, 'live work never waits for side builds: they are not counted against it');
  const src = require('node:fs').readFileSync(require.resolve('../src/services/bench/lane'), 'utf8');
  assert.match(src, /if \(run\.kind === LATER_SIDE_RUN_KIND\) \{\n\s+const besides = \[\.\.\.inFlight\.values\(\)\]\.filter\(\(f\) => f\.laterSide\)\.length;/);
  assert.match(src, /laterSide: run\.kind === LATER_SIDE_RUN_KIND,/);
  assert.match(src, /const LATER_SIDE_RUN_KIND = 'bot_config_later';/);
  assert.equal(configs.LATER_SIDE_RUN_KIND, 'bot_config_later');
});

test('a later pair is left out only when a side did not build, is known not to boot, or both are one commit', () => {
  const ok = { built: true, booted: null, capture: null, sha: 'a' };
  assert.equal(configs.laterExclusionOf(ok, { ...ok, sha: 'b' }), null, 'no screenshots needed: a later pair compares specs and diffs');
  assert.equal(configs.laterExclusionOf(ok, { ...ok }), configs.LATER_IDENTICAL_REASON);
  assert.match(configs.LATER_IDENTICAL_REASON, /^identical/);
  assert.equal(configs.laterExclusionOf(ok, { ...ok, sha: 'b', built: false }), 'didn\'t build (the side configuration)');
  assert.equal(configs.laterExclusionOf({ ...ok, built: null }, { ...ok, sha: 'b' }), 'didn\'t build (the current configuration)');
  assert.equal(configs.laterExclusionOf(ok, { ...ok, sha: 'b', booted: false }), 'didn\'t boot (the side configuration)');
  // A first version's rule is as it was: no screenshots, no pair.
  assert.match(configs.exclusionOf(ok, { ...ok, sha: 'b' }), /^no screenshots/);
});

test('what became of a later version\'s live builds\' proposals; shadow builds propose nothing', () => {
  assert.deepEqual(configs.outcomesOf([
    { mode: 'live', proposal_status: 'merged' }, { mode: 'live', proposal_status: 'merged' },
    { mode: 'live', proposal_status: 'archived' }, { mode: 'live', proposal_status: 'promoted' },
    { mode: 'live', proposal_status: null }, { mode: 'shadow', proposal_status: null },
  ]), { merged: 2, closed: 1, open: 1, none: 1 });
  assert.deepEqual(configs.outcomesOf([]), { merged: 0, closed: 0, open: 0, none: 0 });
});

test('a pair side\'s diff: from GitHub by commit, else the side build\'s stored files, else none', async () => {
  const gh = { async compareFiles(o, r, basehead) { assert.equal(basehead, `${BASE}...${'c'.repeat(40)}`); return { files: [{ additions: 3, deletions: 1 }, { additions: 2, deletions: 0 }] }; } };
  assert.deepEqual(await configs.diffSummary({ github: gh, repoUrl: `${APP.repo_url}.git`, base: BASE, sha: 'c'.repeat(40) }), {
    files: 2, insertions: 5, deletions: 1, compareUrl: `${APP.repo_url}/compare/${BASE}...${'c'.repeat(40)}`,
  });
  const down = { async compareFiles() { throw new Error('404'); } };
  assert.equal((await configs.diffSummary({ github: down, repoUrl: APP.repo_url, base: BASE, sha: 'd'.repeat(40), stored: [{ additions: 7, deletions: 2 }] })).insertions, 7);
  assert.equal(await configs.diffSummary({ github: down, repoUrl: APP.repo_url, base: BASE, sha: 'd'.repeat(40) }), null);
  assert.equal(await configs.diffSummary({ github: gh, repoUrl: APP.repo_url, base: null, sha: 'd'.repeat(40) }), null);
});
