// What is left of shadow builds. The shadow build lane is gone (design D2:
// production treats mode 'shadow' as 'live', and a staging copy runs no
// worker turns), with the queue of builds it drained. What stays: its
// settings (whether a later change's side builds include the platform's own
// repository reads one: laterSideSkipReason); the not-proposed
// build (live.buildAndPropose with `propose: false`) the benchmark makes;
// the runs' shadow history on the dashboard and the export; and the rule
// that the benchmark yields only to the bot's live slots. The bot is live on
// every app but a paused one (live.liveScope), so a triage that acts on
// nothing is a staging copy's: this file runs as one (USERNODE_ENV=staging,
// set below) unless a test says otherwise.
//
// Run with: node --test tests/homeroom-bot-shadow-builds.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
// A build closes its own session through the proposal machine
// (session-lifecycle.closeOwnSession), which no fake pool runs: the build
// harness stands in for it and records every close.
const sessionLifecycle = require('../src/services/session-lifecycle');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const APP = { id: 9, slug: 'todo', name: 'Todo', repo_url: 'https://github.com/usernode-bot/todo', self_hosted: false };
const PLATFORM = { id: 1, slug: 'usernode-2d5619', name: 'Homeroom', repo_url: 'https://github.com/Usernode-Labs/social-vibecoding.git' };
const REPO = { owner: 'usernode-bot', repo: 'todo' };
const BOT = { id: 77, username: 'homeroom_bot' };
const ITEM = { id: 31, app_id: 9, issue_number: 12, priority: 1, reason: 'new', thread_seen_at: '2026-09-28T00:00:00Z' };
const READY = '```json\n{"verdict":"ready","determined":true,"missing_fact":"none","build_note":"Add an hourly refresh."}\n```';
const PERSON = '```json\n{"verdict":"person","determined":false,"missing_fact":"x","reason":"policy"}\n```';
const ON = { mode: 'shadow', pausedApps: [], shadowBuilds: true, buildConcurrency: 2, shadowBuildPlatform: false };

// A staging copy acts on nothing (live.liveScope), so every app there is the
// shadow lane's; outside one, every app but a paused one is live.
function setEnv(value) {
  if (value === undefined) delete process.env.USERNODE_ENV;
  else process.env.USERNODE_ENV = value;
}
const ENV_BEFORE = process.env.USERNODE_ENV;
test.before(() => setEnv('staging'));
test.after(() => setEnv(ENV_BEFORE));

// ── The settings ─────────────────────────────────────────────────────────

test('shadow builds ship off; the lane runs two at once and leaves the platform out', () => {
  const s = bot.parseSettings([]);
  assert.equal(s.shadowBuilds, false, 'off unless someone turns it on');
  assert.equal(s.buildConcurrency, 2);
  assert.equal(s.shadowBuildPlatform, false);
  const on = bot.parseSettings([
    { key: bot.KEY_SHADOW_BUILDS, value: 'on' },
    { key: bot.KEY_BUILD_CONCURRENCY, value: '99' },
    { key: bot.KEY_SHADOW_BUILD_PLATFORM, value: 'on' },
  ]);
  assert.equal(on.shadowBuilds, true);
  assert.equal(on.buildConcurrency, bot.MAX_BUILD_CONCURRENCY, 'clamped');
  assert.equal(on.shadowBuildPlatform, true);
  assert.equal(bot.parseSettings([{ key: bot.KEY_SHADOW_BUILDS, value: 'yes' }]).shadowBuilds, false, 'only "on" is on');

  assert.deepEqual(bot.validateSettingsPatch({ shadowBuilds: true, buildConcurrency: 3, shadowBuildPlatform: false }).updates, [
    [bot.KEY_SHADOW_BUILDS, 'on'], [bot.KEY_BUILD_CONCURRENCY, '3'], [bot.KEY_SHADOW_BUILD_PLATFORM, 'off'],
  ]);
  for (const bad of [{ shadowBuilds: 'on' }, { shadowBuilds: 1 }, { buildConcurrency: 0 }, { buildConcurrency: 5 },
    { buildConcurrency: 1.5 }, { shadowBuildPlatform: 'true' }]) {
    assert.equal(bot.validateSettingsPatch(bad).ok, false, `refuses ${JSON.stringify(bad)}`);
  }
  const schema = read('src/db/schema.sql');
  assert.match(schema, /\('homeroom_bot_shadow_builds', 'off'\)/, 'seeded off');
  assert.match(schema, /\('homeroom_bot_build_concurrency', '2'\)/);
  assert.match(schema, /\('homeroom_bot_shadow_build_platform', 'off'\)/);
  assert.doesNotMatch(schema, /homeroom_bot_shadow_builds_per_day/, 'the daily count is gone: the weekly cap bounds the lane');
});

test('the platform\'s own repository is told apart from any other', () => {
  // A later change's side builds leave it out unless an admin includes it
  // (laterSideSkipReason), and its builds get more time (buildBudgets).
  assert.equal(bot.isPlatformRepo(PLATFORM), true);
  assert.equal(bot.isPlatformRepo({ repo_url: 'https://github.com/usernode-labs/Social-Vibecoding' }), true, 'case-insensitive, as GitHub is');
  assert.equal(bot.isPlatformRepo(APP, { platformRepoUrl: 'https://github.com/usernode-bot/todo' }), true, 'config names it');
  assert.equal(bot.isPlatformRepo(APP), false);
});

// ── The build: the same one live runs, minus everything a person sees ────

function buildHarness(result = { pushOk: true, ahead: 2, sha: 'c'.repeat(40) }) {
  const calls = { queries: [], promoted: [], closed: [] };
  sessionLifecycle.closeOwnSession = async ({ sessionId, reason }) => { calls.closed.push({ sessionId, reason }); return true; };
  const pool = {
    async query(sql, params) {
      calls.queries.push({ sql: String(sql), params });
      if (/INSERT INTO chat_sessions/.test(sql)) return { rows: [{ id: 6001, app_id: APP.id, user_id: BOT.id }] };
      return { rows: [] };
    },
  };
  const router = express.Router();
  router.post('/api/sessions/:id/promote', (req, res) => { calls.promoted.push(req.params.id); res.json({ ok: true, prNumber: 9 }); });
  const deps = {
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() { return 'usernode-worker-6001'; },
      async execInWorker() { return result; },
      stopTurn() { return Promise.resolve(); },
    },
    sessions: {
      async runCodexAttemptLoop(args) {
        const r = await args.dispatchOnce({});
        // The spec turn (tests/homeroom-bot-spec.test.js) writes nothing here.
        if (args.mode === 'scout') return { result: {}, error: null, estimatedCostUsd: null };
        return { result: r, error: null, estimatedCostUsd: 0.04 };
      },
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
    sessionLifecycle: { async ensureSessionBranch({ sessionId }) { return { branchName: `dev/homeroom_bot-s${sessionId}` }; } },
    votesRouter: router,
  };
  return { pool, deps, calls };
}

const BUILD_ARGS = {
  config: {}, bot: BOT, app: APP, repo: REPO, issueNumber: 12,
  issue: { title: 'Refresh feeds every hour' }, seed: 'Please work on GitHub issue #12.',
  buildNote: 'Add an hourly refresh.', turnBudgetMs: 60_000, model: 'z-ai/glm-5.3-flash',
};

test('propose: false builds and pushes, then puts the session away: no proposal, no linked issue', async () => {
  const h = buildHarness();
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...BUILD_ARGS, propose: false });
  assert.deepEqual(out, {
    ok: true, sessionId: 6001, branchName: 'dev/homeroom_bot-s6001', sha: 'c'.repeat(40), commits: 2, costUsd: 0.04,
    specNote: 'no spec (the spec turn returned nothing); the build worked from the plan',
    // The build's own cost on its model (services/stage-costs.js).
    stageCosts: { build: { usd: 0.04, model: 'z-ai/glm-5.3-flash' } },
  }, 'this harness writes no spec, and the result says so');
  assert.deepEqual(h.calls.promoted, [], 'never promoted');
  const insert = h.calls.queries.find((q) => /INSERT INTO chat_sessions/.test(q.sql));
  assert.equal(insert.params[2], null, 'no issue: no board reads it as work under way on #12');
  assert.match(insert.params[3], /^Homeroom bot shadow build: #12 /);
  assert.deepEqual(h.calls.closed, [{ sessionId: 6001, reason: 'not-proposed' }], 'archived the moment the build ends');
});

test('a shadow build that changes nothing is a failure with its branch named', async () => {
  const h = buildHarness({ pushOk: true, ahead: 0, sha: 'd'.repeat(40) });
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...BUILD_ARGS, propose: false });
  assert.equal(out.ok, false);
  assert.match(out.error, /no change/);
  assert.equal(out.branchName, 'dev/homeroom_bot-s6001');
  assert.deepEqual(h.calls.promoted, []);
});

// ── runTriage where nothing is live: a verdict and its run, nothing built ──

function triage({ settings = ON, verdictText = READY, app = APP } = {}) {
  const calls = { queries: [], builds: [] };
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      calls.queries.push({ s, params });
      if (/SELECT \* FROM chat_sessions/.test(s)) {
        return { rows: [{ id: 501, user_id: 77, app_id: app.id, branch_name: 'main', agent_backend: 'codex_openrouter' }] };
      }
      if (/INSERT INTO homeroom_bot_runs/.test(s)) return { rows: [{ id: 900 }] };
      if (/COUNT\(\*\)::int AS cnt/.test(s)) return { rows: [{ cnt: 0 }] };
      return { rows: [] };
    },
  };
  const deps = {
    github: {
      isEnabled: () => true,
      getBotUsername: async () => 'usernode-bot',
      async fetchPublicIssue() { return { issue: { number: 12, title: 'Refresh feeds', body: 'hourly', state: 'open' } }; },
      async fetchIssueComments() { return { comments: [] }; },
    },
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() { return 'w'; },
      async execInWorker() { return { lastResultText: verdictText }; },
      isInFlight: () => false,
      async clearActiveTurn() {},
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
    limits: { async checkBudget() { return { ok: true }; }, async recordSpend() {} },
    threadContext: { async loadIssueThread() { return { messages: [] }; } },
    managedOpenRouter: { async usesIncludedKey() { return true; } },
    sessions: {
      buildHeadlessSeed: (n) => `ISSUE #${n}`,
      async runCodexAttemptLoop({ dispatchOnce }) {
        const r = await dispatchOnce({});
        return { result: r, error: null, estimatedCostUsd: 0.001 };
      },
    },
    activeWorkers: new Set(),
    sessionLifecycle: {},
  };
  return { pool, deps, calls, settings: { turnSeconds: 1200, turnInputTokens: 10_000_000, ...settings } };
}

async function runWith(t, h, app = APP) {
  const real = live.buildAndPropose;
  t.after(() => { live.buildAndPropose = real; });
  live.buildAndPropose = async (args) => { h.calls.builds.push(args); return { ok: true }; };
  return bot.runTriage(h.pool, {}, { bot: BOT, app, item: ITEM, mode: 'shadow', settings: h.settings, deps: h.deps });
}

test('every verdict supersedes an older queued build of the same issue, ready or not', async (t) => {
  for (const verdictText of [READY, PERSON]) {
    const h = triage({ verdictText });
    await runWith(t, h);
    const sup = h.calls.queries.find((q) => /superseded: a later verdict/.test(q.s));
    assert.ok(sup, 'the lane builds what the bot thinks now');
    assert.deepEqual(sup.params, [APP.id, 12, 900]);
    assert.match(sup.s, /build_queued_at IS NOT NULL AND build_at IS NULL AND build_ok IS NULL/, 'never one under way or done');
  }
});

test('a run records what started its read: its queue reason, and for a change what moved', async (t) => {
  const h = triage();
  const real = live.buildAndPropose;
  t.after(() => { live.buildAndPropose = real; });
  live.buildAndPropose = async () => ({ ok: true });
  // What moved comes with the debt (bot-request's Owed changedBy), onto the
  // item the look reads: nothing here claims a queue row to learn it.
  await bot.runTriage(h.pool, {}, {
    bot: BOT, app: APP, item: { ...ITEM, reason: 'changed', changed_by: 'github' }, mode: 'shadow', settings: h.settings, deps: h.deps,
  });
  assert.equal(h.calls.queries.some((q) => /homeroom_bot_queue/.test(q.s)), false, 'the queue is the request machine\'s');
  const insert = h.calls.queries.find((q) => /INSERT INTO homeroom_bot_runs/.test(q.s));
  assert.match(insert.s, /payer_user_id, read_reason\)/);
  assert.equal(insert.params[insert.params.length - 1], 'changed:github', 'the issue itself moved since the last read');
  assert.equal(bot.readReasonOf({ reason: 'changed', changed_by: 'discussion' }), 'changed:discussion');
  assert.equal(bot.readReasonOf({ reason: 'retry_failed', changed_by: 'github' }), 'retry_failed', 'only a change says what changed');
  assert.equal(bot.readReasonOf({ reason: 'changed' }), 'changed', 'a row queued before changed_by');
  assert.equal(bot.readReasonOf({}), null);
});

// ── A build's error: the platform's, or the model's ─────────────────────

test('a build error the platform produced is told apart from one the model did', () => {
  // The benchmark (services/bench/runner.js) reads it to keep a platform
  // fault out of a model's score.
  assert.equal(bot.isInfraBuildError('the worker would not start: quota'), true);
  assert.equal(bot.isInfraBuildError('the build turn failed (credential_required)'), true);
  assert.equal(bot.isInfraBuildError('the build turn failed (dispatch: socket hang up)'), true);
  assert.equal(bot.isInfraBuildError('the build produced no change to propose'), false);
  assert.equal(bot.isInfraBuildError('the build ran past its time limit'), false);
});

// ── The backfill is gone with the shadow apps it built for ──────────────

test('there is no backfill any more: every app but a paused one is live', () => {
  assert.equal(bot.queueShadowBackfill, undefined);
  assert.doesNotMatch(read('src/routes/admin.js'), /shadow-builds\/backfill/);
});

// ── Seeing it: the export and the dashboard ─────────────────────────────

test('the export carries the branch, with a compare address to open, after every older column', () => {
  const header = bot.EXPORT_COLUMNS;
  const at = header.indexOf('build_ok');
  assert.deepEqual(header.slice(at, at + 11), ['build_ok', 'build_branch', 'build_url', 'build_sha', 'build_commits', 'build_error', 'build_cost_usd', 'build_at', 'build_queued_at', 'build_spec_md', 'build_session_id']);
  assert.ok(header.indexOf('proposal_session_id') < header.indexOf('build_ok'), 'appended, so older analyses do not shift');
  const row = bot.exportRow({
    id: 1, issue_number: 12, repo_url: 'https://github.com/usernode-bot/todo.git',
    build_ok: true, build_branch: 'dev/homeroom_bot-s6001', build_sha: 'c'.repeat(40), build_commits: 2,
  });
  assert.equal(row[header.indexOf('build_url')], 'https://github.com/usernode-bot/todo/compare/dev/homeroom_bot-s6001');
  assert.equal(bot.exportRow({ id: 2, repo_url: 'https://github.com/o/r' })[header.indexOf('build_url')], '', 'no branch, no address');
});

test('the dashboard keeps the two settings that still do something, and the runs keep their shadow history', () => {
  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  // No shadow apps, so no switch, no backfill and no lane line for them.
  assert.doesNotMatch(tsx, /id="admin-homeroom-bot-shadow-builds"|admin-homeroom-bot-shadow-backfill|admin-homeroom-bot-build-lane|shadow-builds\/backfill/);
  assert.doesNotMatch(tsx, /setField\('shadowBuilds'/);
  // How many shadow builds run at once, and whether side builds include the
  // platform's own repository (laterSideSkipReason), say so; and the note
  // says the benchmark and side builds wait for the live requests at once
  // (isLiveLaneSaturated), not for this number, which held them back behind
  // any two live builds until 9 Oct 2026.
  assert.match(tsx, /id="admin-homeroom-bot-side-builds"/);
  assert.match(tsx, /<NumberField id="admin-homeroom-bot-build-concurrency" label="Shadow builds at once"/);
  assert.doesNotMatch(tsx, /Live builds before side builds wait|fewer live builds than this/);
  assert.match(tsx, /start only while the bot&apos;s live requests leave a slot free \(Live requests at once, under Advanced\)/);
  assert.match(tsx, /onChange=\{\(v\) => setField\('buildConcurrency', v\)\}/);
  assert.match(tsx, /id="admin-homeroom-bot-shadow-build-platform"[\s\S]{0,400}<span>Make side builds on Homeroom&apos;s own repository too<\/span>/);
  assert.match(tsx, /id="admin-homeroom-bot-side-builds-note"/);
  const fn = tsx.slice(tsx.indexOf('function ShadowBuild('), tsx.indexOf('function VerdictBody('));
  assert.match(fn, /data-shadow-build="queued"/);
  assert.match(fn, /data-shadow-build="building"/);
  assert.match(fn, /data-shadow-build="skipped"/);
  assert.match(fn, /Not proposed, not posted\./);
  assert.match(fn, /\{run\.buildUrl \? <p className=\{`\$\{AdminUI\.muted\} break-all select-all`\}>\{run\.buildUrl\}<\/p>/);
  assert.doesNotMatch(fn, /href=/, 'an address built from an app\'s repo_url is text to copy');
  assert.match(tsx, /<ShadowBuild run=\{run\} \/>/);
});

// #3654: the benchmark yields only to live work, the requests a person is
// waiting for. A full shadow lane must not hold it back: both are
// experiments, and counting shadow builds starved the benchmark whenever
// the shadow bot was busy. Live work has `liveAtOnce` slots; the benchmark
// waited behind the shadow lane's `buildConcurrency` (2) until 9 Oct 2026,
// so any two live builds held every trial and side build back.
test('the benchmark waits for live work to fill its live slots only, never for shadow builds', async () => {
  const settings = { buildConcurrency: 2, liveAtOnce: 12 };
  assert.equal(await bot.isLiveLaneSaturated(settings, { live: 0 }), false, 'nothing live: the bench may run');
  assert.equal(await bot.isLiveLaneSaturated(settings, { live: 2 }), false, 'two live builds leave ten live slots free');
  assert.equal(await bot.isLiveLaneSaturated(settings, { live: 11 }), false);
  assert.equal(await bot.isLiveLaneSaturated(settings, { live: 12 }), true, 'every live slot taken');
  assert.equal(await bot.isLiveLaneSaturated({ liveAtOnce: 4, buildConcurrency: 4 }, { live: 3 }), false);
  assert.equal(await bot.isLiveLaneSaturated({ liveAtOnce: 4 }, { live: 4 }), true);
  assert.equal(await bot.isLiveLaneSaturated({}, { live: 11 }), false, 'the default liveAtOnce (12) when unset');
  assert.equal(await bot.isLiveLaneSaturated({}, { live: 12 }), true);
  // Without counts or a database, nothing is in use.
  assert.equal(await bot.isLiveLaneSaturated(settings), false);
  assert.doesNotMatch(String(bot.isLiveLaneSaturated), /buildConcurrency/, 'the shadow lane\'s number is not the live lane\'s');
  // With the database, the slots the bot's lane has granted, reads and
  // builds alike, read from its requests (rules/bot-loop.ts
  // SLOTS_IN_USE_SQL): the same count in every process and after a restart.
  const asked = [];
  const pool = (n) => ({ async query(sql) { asked.push(String(sql)); return { rows: [{ n }] }; } });
  assert.equal(await bot.isLiveLaneSaturated(settings, null, pool(11)), false);
  assert.equal(await bot.isLiveLaneSaturated(settings, null, pool(12)), true);
  assert.match(asked[0], /FROM wf_instances w\s+WHERE w\.machine = 'bot-request' AND w\.state IN \('reading', 'following_up', 'building'\)\s+AND jsonb_typeof\(w\.data->'slot'\) = 'object' AND w\.flag IS NULL/);
  // Side builds share the live slots: they count beside the lane's.
  assert.equal(await bot.isLiveLaneSaturated(settings, { besides: 2 }, pool(10)), true);
});
