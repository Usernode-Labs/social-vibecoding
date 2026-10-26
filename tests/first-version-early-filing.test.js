'use strict';

// Newcomer run nine (14 Oct 2026, measured 15 Oct): from the made screen's
// Submit to the first version's spec took 40 s. 18 s of it was the request
// waiting for the starter app to be built, deployed and answering before it
// was filed, though it needs only the repository; 14.6 s more was the bot's
// pass reading every app (the full refresh and its sweeps) before it read the
// new request, which the conductor saw only once GitHub's list had it. These
// pin what changed:
//
//   - the project files its first version right after its repository is
//     made, beside its first deploy (src/workflow/app-creation/);
//   - an issue one process files is in every other process's board read at
//     once: it is a request row (services/requests.js) that every process
//     reads, so nothing is passed over the bus any more (it was, through
//     github.js noteIssueCreated and applyIssuesChange, until requests left
//     GitHub on 26 Oct 2026);
//   - a first version just filed has its project refreshed at once, not
//     after the settle (the bot's lane, RefreshAsked `now`);
//   - a first version filed while its project is set up waits for the
//     project to run before it is proposed, and stops, in words it always
//     had, when the project's setup failed (projectSetUpStop, buildAndPropose
//     `setupCheck`).
//
// The real schema's side is first-version-early-filing-postgres.test.js.
//
// Run with: node --test tests/first-version-early-filing.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// ── Filed once the repository is made ─────────────────────────────────────
//
// By the project's making (src/workflow/app-creation/): its first request is
// queued once its setup has made the repository, beside its first deploy
// (tests/workflow-app-creation-postgres.test.js C7), and filed once
// (tests/first-version-early-filing-postgres.test.js).

// ── The created issue, on every process ──────────────────────────────────

function capturePublishes(t) {
  const wsBus = require('../src/services/ws-bus');
  const sent = [];
  const real = wsBus.publish;
  wsBus.publish = (kind, routing, data) => { sent.push({ kind, routing, data: JSON.parse(JSON.stringify(data)) }); };
  t.after(() => { wsBus.publish = real; });
  return sent;
}

/** Another process's github.js: the same code with a copy of its own, made while `t` runs. */
function otherProcess(t) {
  const id = require.resolve('../src/services/github');
  const mine = require.cache[id];
  delete require.cache[id];
  const other = require(id);
  t.after(() => { require.cache[id] = mine; });
  return other;
}

/** Any read of GitHub's API is a failure here: requests are not there any more. */
function refuseGithubFetch(t) {
  const calls = [];
  const real = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => null };
  };
  t.after(() => { global.fetch = real; });
  return calls;
}

// The second case this section had ("one too big for the bus carries its
// number, and the other process reads it from GitHub once") went with the
// bus message: the long request below is read from the store like any other.
test('an issue one process files is in every other process\'s board read at once, with nothing on the bus', async (t) => {
  const { installFakeRequests } = require('./helpers/fake-requests');
  installFakeRequests(t, { 'usernode-bot/club-votes': [] });
  require('../src/services/github').isEnabled(); // loaded before it is swapped
  const sent = capturePublishes(t);
  const calls = refuseGithubFetch(t);
  const github = require('../src/services/github');
  const body = `**Source:** Homeroom user (evan)\n\nPolls for our club. ${'Every member votes once on each poll, and sees who won. '.repeat(150)}`;
  const filed = await github.createIssue('usernode-bot', 'club-votes', { title: 'First version of Club Votes', body });
  assert.equal(filed.number, 1);
  github.noteIssueCreated('usernode-bot', 'club-votes', filed);
  assert.deepEqual(sent, [], 'nothing is passed on: every process reads the same rows');

  // The conductor: another process, which never saw the filing.
  const conductor = otherProcess(t);
  const list = await conductor.fetchPublicIssues('usernode-bot', 'club-votes');
  assert.deepEqual(list.issues.map((i) => i.number), [1], 'its refresh finds the request');
  const one = await conductor.fetchPublicIssue('usernode-bot', 'club-votes', 1);
  assert.equal(one.issue.body, body, 'and its read has the whole request');
  assert.deepEqual(calls, [], 'without asking GitHub');
});

// ── A first version filed is read at once ───────────────────────────────

const bot = require('../src/services/homeroom-bot');

// Newcomer run nine (15 Oct 2026): a first version filed while its project
// is set up is read as soon as it is filed (about 4 s), not after the
// settle every other project's refresh waits for. Filing it asks the bot's
// lane to refresh its project at once (bot-lane RefreshAsked `now`), which
// owes its request; the lane grants it then (tests/workflow-bot-loop-postgres
// pins the lane's side).
test('a first version just filed has its project refreshed at once, not after the settle', () => {
  const dmSrc = fs.readFileSync(path.join(__dirname, '..', 'src/services/homeroom-bot-dm.js'), 'utf8');
  assert.match(dmSrc, /if \(botBuilds\) settingsModule\(\)\.noteIssueActivity\(\{ appId: row\.app_id, issueNumber, reason: 'first_version' \}\);/);
  const botSrc = fs.readFileSync(path.join(__dirname, '..', 'src/services/homeroom-bot.js'), 'utf8');
  assert.match(botSrc, /: platform\(\)\.botRefresh\(id, \{ now: String\(reason\) === 'first_version' \}\);/);
});

// ── Waiting for the project, and its setup failing ───────────────────────

function statusPool(statuses) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      assert.match(String(sql), /SELECT status FROM apps WHERE id = \$1/);
      seen.push(params[0]);
      const next = statuses.length > 1 ? statuses.shift() : statuses[0];
      return { rows: next ? [{ status: next }] : [] };
    },
  };
}

test('a project still being set up is no reason to stop, and is waited for before a proposal', async () => {
  assert.equal(await bot.projectSetUpStop(statusPool(['creating']), 9), null, 'without a wait, it goes on');
  const slept = [];
  const pool = statusPool(['creating', 'creating', 'running']);
  assert.equal(await bot.projectSetUpStop(pool, 9, { wait: true, pollMs: 5, sleep: async (ms) => { slept.push(ms); } }), null);
  assert.deepEqual(slept, [5, 5], 'looked again until it ran');
  assert.deepEqual(pool.seen, [9, 9, 9]);
  assert.equal(await bot.projectSetUpStop(statusPool(['awaiting_secrets']), 9, { wait: true }), null, 'any other state is as it always was');
});

test('a project whose setup failed, or that is gone, stops it; one never set up times out', async () => {
  assert.equal(await bot.projectSetUpStop(statusPool(['error']), 9), 'failed');
  assert.equal(await bot.projectSetUpStop(statusPool(['creating', 'error']), 9, { wait: true, sleep: async () => {} }), 'failed');
  assert.equal(await bot.projectSetUpStop(statusPool([null]), 9), 'failed');
  let clock = 0;
  const now = () => clock;
  assert.equal(await bot.projectSetUpStop(statusPool(['creating']), 9, {
    wait: true, waitMs: 30, pollMs: 10, now, sleep: async (ms) => { clock += ms; },
  }), 'timeout');
  // A durable build this process no longer holds stops waiting.
  const stopped = Object.assign(new Error('the build is no longer this process\'s to run'), { stopped: true });
  await assert.rejects(bot.projectSetUpStop(statusPool(['creating']), 9, {
    wait: true, sleep: async () => {}, fence: () => { throw stopped; },
  }), (err) => err === stopped);
});

test('what a stop comes to is said in the words a build already had, never new ones', async () => {
  const check = bot.setupCheckFor(statusPool(['error']), 9);
  assert.deepEqual(await check(), { error: bot.SETUP_FAILED_DURING });
  assert.equal(await bot.setupCheckFor(statusPool(['creating']), 9)(), null);
  // Waited for its whole time: built, and left for a person to propose.
  let clock = 0;
  const timedOut = bot.setupCheckFor(statusPool(['creating']), 9, {
    waitMs: 30, pollMs: 10, now: () => clock, sleep: async (ms) => { clock += ms; },
  });
  assert.deepEqual(await timedOut({ wait: true }), { error: bot.SETUP_NOT_PROPOSED, notProposed: true });
  const dm = require('../src/services/homeroom-bot-dm');
  const words = (reason) => dm.buildFailedWords(reason, 'the first version', 'me', { first: true });
  assert.equal(words(bot.SETUP_FAILED_BEFORE), words('the build could not start (the worker would not start)'), 'could not start');
  assert.equal(words(bot.SETUP_FAILED_DURING), words('something else entirely'), 'did not finish');
  assert.equal(words(bot.SETUP_NOT_PROPOSED), words('the change was built but could not be proposed: 503'), 'built, not live yet');
  assert.equal(bot.autoRetryable({ ok: false, error: bot.SETUP_FAILED_DURING, setupFailed: true, specMd: '# Plan' }), false,
    'never tried once more: it would stop the same way');
});

// ── The build's steps ────────────────────────────────────────────────────

const live = require('../src/services/homeroom-bot-live');
// A build closes its own session through the proposal machine
// (session-lifecycle.closeOwnSession), which no fake pool runs: the harness
// stands in for it and records every close.
const sessionLifecycle = require('../src/services/session-lifecycle');

const BAPP = { id: 9, slug: 'club-votes', name: 'Club Votes', repo_url: 'https://github.com/usernode-bot/club-votes' };
const BOT = { id: 77, username: 'homeroom_bot' };
const BUILT = Object.freeze({
  agentHarness: 'claude', ccExit: 0, exitCode: 0, pushOk: true, ahead: 3, sha: 'a'.repeat(40),
  routedProvider: 'Together', routedProviders: ['Together'],
  providerTurnCount: 40, toolCallCount: 30, fileChangeCount: 9, outputTokens: 9000,
  lastResultText: 'Built the polls.',
});

/** buildAndPropose with one build turn that lands and a promote that answers ok (homeroom-bot-build-nudge's harness). */
function harness() {
  const calls = { queries: [], builds: [], promoted: [], order: [], closed: [] };
  sessionLifecycle.closeOwnSession = async ({ sessionId, reason }) => { calls.closed.push({ sessionId, reason }); return true; };
  const pool = {
    async query(sql, params) {
      calls.queries.push({ sql: String(sql), params });
      if (/INSERT INTO chat_sessions/.test(sql)) return { rows: [{ id: 5001, app_id: BAPP.id, user_id: BOT.id }] };
      return { rows: [] };
    },
  };
  const express = require('express');
  const router = express.Router();
  router.post('/api/sessions/:id/promote', (req, res) => {
    calls.promoted.push(req.params.id);
    calls.order.push('promote');
    res.status(200).json({ ok: true, prNumber: 42 });
  });
  const deps = {
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() { return 'usernode-worker-5001'; },
      async execInWorker(_id, opts) {
        if (opts.mode === 'scout') return { lastResultText: '' };
        calls.builds.push(opts);
        calls.order.push('build');
        return { ...BUILT };
      },
      stopTurn() { return Promise.resolve(); },
      getPendingStop() { return null; },
    },
    sessions: {
      async runCodexAttemptLoop(args) {
        const r = await args.dispatchOnce({ agentHarness: 'claude' });
        return { result: r, error: null, estimatedCostUsd: 0.05 };
      },
      async persistScoutPublication() { return { specVersion: 1 }; },
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
    sessionLifecycle: { async ensureSessionBranch({ sessionId }) { return { branchName: `homeroom_bot/s${sessionId}` }; } },
    activeWorkers: new Set(),
    votesRouter: router,
    seesImages: false,
  };
  return { pool, deps, calls };
}

const ARGS = {
  config: {}, bot: BOT, app: BAPP, repo: { owner: 'usernode-bot', repo: 'club-votes' }, issueNumber: 1,
  issue: { title: 'First version of Club Votes' }, seed: 'Please build issue #1.',
  buildNote: 'Polls for the club.', turnBudgetMs: 40 * 60 * 1000, model: 'z-ai/glm-5.3-flash',
  origin: { lane: 'live', runId: 2101 },
};
const archived = (h) => h.calls.closed.some((c) => c.sessionId === 5001);

/** A setupCheck answering `answers` in turn, recording what it was asked. */
function setupAnswers(h, answers) {
  const asked = [];
  const check = async ({ wait = false, fence } = {}) => {
    asked.push({ wait, fence: typeof fence });
    h.calls.order.push(wait ? 'setup:wait' : 'setup');
    return answers.length ? answers.shift() : null;
  };
  return { asked, check };
}

test('a first version whose project failed to set up stops before its build turn, with nothing left running', async () => {
  const h = harness();
  const { asked, check } = setupAnswers(h, [{ error: bot.SETUP_FAILED_DURING }]);
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS, setupCheck: check });
  assert.equal(out.ok, false);
  assert.equal(out.setupFailed, true);
  assert.equal(out.error, bot.SETUP_FAILED_DURING);
  assert.deepEqual(asked, [{ wait: false, fence: 'function' }], 'asked once its plan was written');
  assert.equal(h.calls.builds.length, 0, 'no build turn');
  assert.ok(archived(h), 'its session put away');
  assert.deepEqual(h.calls.promoted, [], 'no proposal');
});

test('and once its build turn is over, before anything is proposed', async () => {
  const h = harness();
  const { asked, check } = setupAnswers(h, [null, { error: bot.SETUP_FAILED_DURING }]);
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS, setupCheck: check });
  assert.equal(out.ok, false);
  assert.equal(out.setupFailed, true);
  assert.equal(asked.length, 2);
  assert.equal(h.calls.builds.length, 1);
  assert.ok(archived(h));
  assert.deepEqual(h.calls.promoted, []);
});

test('a first version waits for its project to run before it is proposed', async () => {
  const h = harness();
  const { asked, check } = setupAnswers(h, [null, null, null]);
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS, setupCheck: check });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.prNumber, 42);
  assert.deepEqual(asked.map((a) => a.wait), [false, false, true], 'the last look waits for it');
  assert.deepEqual(h.calls.order, ['setup', 'build', 'setup', 'setup:wait', 'promote'], 'and is before the proposal');
});

test('one still being set up after all that time is built and left for a person to propose', async () => {
  const h = harness();
  const { check } = setupAnswers(h, [null, null, { error: bot.SETUP_NOT_PROPOSED, notProposed: true }]);
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS, setupCheck: check });
  assert.equal(out.ok, false);
  assert.equal(out.notProposed, true);
  assert.equal(out.setupFailed, true);
  assert.equal(out.sha, BUILT.sha, 'its work is on its branch');
  assert.ok(!archived(h), 'its session kept, as a proposal refused leaves it');
  assert.deepEqual(h.calls.promoted, []);
});

test('every other build asks nothing of its project', async () => {
  const h = harness();
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS });
  assert.equal(out.ok, true);
  assert.ok(!h.calls.queries.some((q) => /SELECT status FROM apps/.test(q.sql)));
  assert.deepEqual(h.calls.order, ['build', 'promote']);
});
