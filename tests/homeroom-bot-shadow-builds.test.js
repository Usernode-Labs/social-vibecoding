// Shadow builds: on an app outside the live list, a ready verdict is also
// built on a branch of its own, and nothing else happens. No proposal, no
// post, nothing in the app: the dashboard and the export carry the branch,
// so what the bot would have proposed can be spot-checked before an app
// goes live. Off unless `shadowBuildsPerDay` is set.
//
// Run with: node --test tests/homeroom-bot-shadow-builds.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const APP = { id: 9, slug: 'todo', name: 'Todo', repo_url: 'https://github.com/usernode-bot/todo', self_hosted: false };
const REPO = { owner: 'usernode-bot', repo: 'todo' };
const BOT = { id: 77, username: 'homeroom_bot' };
const ITEM = { id: 31, app_id: 9, issue_number: 12, priority: 1, reason: 'new', thread_seen_at: '2026-09-28T00:00:00Z' };
const READY = '```json\n{"verdict":"ready","determined":true,"missing_fact":"none","build_note":"Add an hourly refresh."}\n```';

// ── The setting ──────────────────────────────────────────────────────────

test('shadow builds ship off, and the daily count is clamped and validated', () => {
  assert.equal(bot.parseSettings([]).shadowBuildsPerDay, 0, 'off unless someone turns it on');
  const key = 'homeroom_bot_shadow_builds_per_day';
  assert.equal(bot.parseSettings([{ key, value: '999' }]).shadowBuildsPerDay, bot.MAX_SHADOW_BUILDS_PER_DAY);
  assert.equal(bot.parseSettings([{ key, value: '-3' }]).shadowBuildsPerDay, 0);
  assert.deepEqual(bot.validateSettingsPatch({ shadowBuildsPerDay: 10 }).updates, [[key, '10']]);
  for (const bad of [-1, 51, 1.5, 'ten']) {
    assert.equal(bot.validateSettingsPatch({ shadowBuildsPerDay: bad }).ok, false, `refuses ${bad}`);
  }
  assert.match(read('src/db/schema.sql'), /\('homeroom_bot_shadow_builds_per_day', '0'\)/, 'seeded off');
});

// ── The build: the same one live runs, minus everything a person sees ────

function buildHarness(result = { pushOk: true, ahead: 2, sha: 'c'.repeat(40) }) {
  const calls = { queries: [], promoted: [] };
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
        return { result: r, error: null, estimatedCostUsd: 0.04 };
      },
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
    sessionLifecycle: { async ensureSessionBranch({ sessionId }) { return { branchName: `dev/homeroom_bot-s${sessionId}` }; } },
    activeWorkers: new Set(),
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
  });
  assert.deepEqual(h.calls.promoted, [], 'never promoted');
  const insert = h.calls.queries.find((q) => /INSERT INTO chat_sessions/.test(q.sql));
  assert.equal(insert.params[2], null, 'no issue: no board reads it as work under way on #12');
  assert.match(insert.params[3], /^Homeroom bot shadow build: #12 /);
  const archived = h.calls.queries.find((q) => /SET status = 'archived'/.test(q.sql));
  assert.ok(archived, 'archived the moment the build ends');
  assert.deepEqual(archived.params, [6001, BOT.id]);
});

test('a shadow build that changes nothing is a failure with its branch named', async () => {
  const h = buildHarness({ pushOk: true, ahead: 0, sha: 'd'.repeat(40) });
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...BUILD_ARGS, propose: false });
  assert.equal(out.ok, false);
  assert.match(out.error, /no change/);
  assert.equal(out.branchName, 'dev/homeroom_bot-s6001');
  assert.deepEqual(h.calls.promoted, []);
});

// ── runTriage: when a shadow verdict is built ───────────────────────────

function triage({ perDay = 5, builtToday = 0, verdictText = READY, liveApps = [], budgetError = null } = {}) {
  const calls = { queries: [], builds: [], spend: [] };
  const pool = {
    async query(sql, params) {
      const s = String(sql);
      calls.queries.push({ s, params });
      if (/SELECT \* FROM chat_sessions/.test(s)) {
        return { rows: [{ id: 501, user_id: 77, app_id: 9, branch_name: 'main', agent_backend: 'codex_openrouter' }] };
      }
      if (/INSERT INTO homeroom_bot_runs/.test(s)) return { rows: [{ id: 900 }] };
      if (/WHERE build_at > NOW\(\) - INTERVAL '24 hours'/.test(s)) return { rows: [{ n: builtToday }] };
      if (/COUNT\(\*\)::int AS cnt/.test(s)) return { rows: [{ cnt: 0 }] };
      return { rows: [] };
    },
  };
  let budgetCalls = 0;
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
    limits: {
      // The triage's own check passes; the shadow build's is the second.
      async checkBudget() { budgetCalls += 1; return budgetCalls > 1 && budgetError ? { error: budgetError } : { ok: true }; },
      async recordSpend(_p, id, cents) { calls.spend.push(cents); },
    },
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
  const settings = { mode: 'shadow', liveApps, turnSeconds: 1200, turnInputTokens: 10_000_000, shadowBuildsPerDay: perDay };
  return { pool, deps, calls, settings };
}

async function runWith(t, h, built = { ok: true, sessionId: 6001, branchName: 'dev/homeroom_bot-s6001', sha: 'c'.repeat(40), commits: 2, costUsd: 0.04 }) {
  const real = live.buildAndPropose;
  t.after(() => { live.buildAndPropose = real; });
  live.buildAndPropose = async (args) => { h.calls.builds.push(args); return built; };
  return bot.runTriage(h.pool, {}, { bot: BOT, app: APP, item: ITEM, mode: 'shadow', settings: h.settings, deps: h.deps });
}

const buildUpdate = (h) => h.calls.queries.find((q) => /SET build_ok = \$2/.test(q.s));

test('a shadow ready verdict is built without proposing, and the run records the branch', async (t) => {
  const h = triage();
  const out = await runWith(t, h);
  assert.equal(out.verdict, 'ready');
  assert.equal(out.acted, 'shadow_built');
  assert.equal(h.calls.builds.length, 1);
  assert.equal(h.calls.builds[0].propose, false, 'never proposed');
  assert.equal(h.calls.builds[0].buildNote, 'Add an hourly refresh.', 'from the triage\'s own plan');
  const claimed = h.calls.queries.find((q) => /SET build_at = NOW\(\)/.test(q.s));
  assert.deepEqual(claimed.params, [900], 'claimed before the build, so a parallel pass counts it');
  assert.deepEqual(buildUpdate(h).params, [900, true, 'dev/homeroom_bot-s6001', 'c'.repeat(40), 2, null, 0.04, 6001]);
  assert.ok(h.calls.spend.includes(4), 'the build is paid from the weekly allowance');
});

test('a failed shadow build is recorded with its reason', async (t) => {
  const h = triage();
  const out = await runWith(t, h, { ok: false, sessionId: 6001, branchName: 'dev/x', error: 'the build produced no change to propose', costUsd: 0.01 });
  assert.equal(out.acted, 'shadow_failed');
  const u = buildUpdate(h).params;
  assert.equal(u[1], false);
  assert.equal(u[5], 'the build produced no change to propose');
});

test('no build when it is off, over the day\'s count, out of budget, not ready, or the app is live', async (t) => {
  const cases = [
    ['off', triage({ perDay: 0 })],
    ['over the count', triage({ perDay: 3, builtToday: 3 })],
    ['out of budget', triage({ budgetError: 'weekly_limit' })],
    ['not ready', triage({ verdictText: '```json\n{"verdict":"person","determined":false,"missing_fact":"x","reason":"policy"}\n```' })],
  ];
  for (const [why, h] of cases) {
    const out = await runWith(t, h);
    assert.equal(h.calls.builds.length, 0, `no build when ${why}`);
    assert.equal(out.acted, undefined, why);
    assert.equal(buildUpdate(h), undefined, why);
  }
});

// ── Seeing it: the export and the dashboard ─────────────────────────────

test('the export carries the branch, with a compare address to open, after every older column', () => {
  const header = bot.EXPORT_COLUMNS;
  assert.deepEqual(header.slice(-8), ['build_ok', 'build_branch', 'build_url', 'build_sha', 'build_commits', 'build_error', 'build_cost_usd', 'build_at']);
  assert.ok(header.indexOf('proposal_session_id') < header.indexOf('build_ok'), 'appended, so older analyses do not shift');
  const row = bot.exportRow({
    id: 1, issue_number: 12, repo_url: 'https://github.com/usernode-bot/todo.git',
    build_ok: true, build_branch: 'dev/homeroom_bot-s6001', build_sha: 'c'.repeat(40), build_commits: 2,
  });
  assert.equal(row[header.indexOf('build_url')], 'https://github.com/usernode-bot/todo/compare/dev/homeroom_bot-s6001');
  assert.equal(bot.exportRow({ id: 2, repo_url: 'https://github.com/o/r' })[header.indexOf('build_url')], '', 'no branch, no address');
});

test('the dashboard shows the knob and each build, the address as text, never a link', () => {
  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.match(tsx, /id="admin-homeroom-bot-shadow-builds"/);
  assert.match(tsx, /saveSettings\(\{ shadowBuildsPerDay: n \}/);
  assert.match(tsx, /id="admin-homeroom-bot-shadow-builds-note"/);
  const fn = tsx.slice(tsx.indexOf('function ShadowBuild('), tsx.indexOf('function VerdictBody('));
  assert.match(fn, /Not proposed, not posted\./);
  assert.match(fn, /\{run\.buildUrl \? <p className=\{`\$\{AdminUI\.muted\} break-all select-all`\}>\{run\.buildUrl\}<\/p>/);
  assert.doesNotMatch(fn, /href=/, 'an address built from an app\'s repo_url is text to copy');
  assert.match(tsx, /<ShadowBuild run=\{run\} \/>/);
});
