'use strict';

// A process a release replaced finishes its own work, the last step of a
// build included (docs/plans/draining-releases.md).
//
// 14 Oct 2026: a release replaced the conductor that was building a
// newcomer's first version (bot run 2027, session 8550). The replaced
// process went on with the build, as a draining process does, and then
// refused the build's own promote, "Server is restarting" (lifecycle.js
// drainGuard). The `promoted` step kept that 503 as what the promotion came
// to, the run ended built but not proposed, and the newcomer was told it
// had stopped. What is pinned here, with this process shutting down:
//
//   - the drain guard lets an in-process request for work this process
//     already holds through (lifecycle.OWN_WORK), and nothing else: a
//     request over HTTP still gets the 503, whatever it says about itself;
//   - the bot's promote carries the mark, so a durable build that reaches
//     its proposal while its process drains proposes, and no 503 is kept;
//   - a proposal refused anyway (5xx) is never kept as the step's result: it
//     is tried again, then thrown while the build has a try left, so the
//     next try goes on from `prepared` and proposes, and nothing is said or
//     recorded meanwhile;
//   - on its last try, or run unkept, a refused build ends as it always has.
//
// The flag cannot be unset, so it is set for the whole file.
//
// Run with: node --test tests/drain-finishes-own-work.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const lifecycle = require('../src/services/lifecycle');
const live = require('../src/services/homeroom-bot-live');
const bot = require('../src/services/homeroom-bot');
const configs = require('../src/services/bot-configs');
const durableSteps = require('../src/services/durable-steps');

lifecycle.setShuttingDown();

const DRAIN_503 = { error: 'Server is restarting, try again in a few seconds' };
const APP = { id: 9, slug: 'page-turners-30094f', name: 'Page Turners', repo_url: 'https://github.com/usernode-bot/page-turners' };
const REPO = { owner: 'usernode-bot', repo: 'page-turners' };
const BOT = { id: 77, username: 'homeroom_bot' };

// One request into a router, in-process, as promoteAsBot makes it.
function dispatch(router, extra = {}) {
  return new Promise((resolve) => {
    const url = '/api/sessions/5001/promote';
    const req = {
      method: 'POST', url, originalUrl: url, baseUrl: '', path: url, headers: {}, query: {}, params: {}, body: {},
      user: { id: BOT.id }, get() {}, header() {}, ...extra,
    };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; },
      set() { return this; }, setHeader() {}, getHeader() {},
    };
    router.handle(req, res, () => resolve({ status: 404, body: null }));
  });
}

// The promote route's shape: the drain guard first, then the handler.
function guardedPromote() {
  const reached = [];
  const router = express.Router();
  router.post('/api/sessions/:id/promote', lifecycle.drainGuard, (req, res) => {
    reached.push(req.params.id);
    res.json({ ok: true, prNumber: 42 });
  });
  return { router, reached };
}

test('the drain guard lets a step of this process\'s own work through, and only that', async (t) => {
  const { router, reached } = guardedPromote();
  assert.deepEqual(await dispatch(router, { [lifecycle.OWN_WORK]: true }), { status: 200, body: { ok: true, prNumber: 42 } });
  assert.deepEqual(await dispatch(router), { status: 503, body: DRAIN_503 }, 'an unmarked request is new work');
  assert.deepEqual(await dispatch(router, { OWN_WORK: true, 'lifecycle-own-work': true, [Symbol('lifecycle-own-work')]: true }),
    { status: 503, body: DRAIN_503 }, 'a key that only looks like the mark is not the mark');
  assert.equal(lifecycle.isOwnWork({ [lifecycle.OWN_WORK]: 'yes' }), false, 'only the mark set to true');
  assert.equal(lifecycle.isOwnWork(null), false);

  // Over HTTP, whatever the request says about itself: nothing a client
  // sends becomes a Symbol-keyed property of `req`.
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: BOT.id }; next(); });
  app.use(router);
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((r) => server.once('listening', r));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/5002/promote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-own-work': 'true', 'lifecycle-own-work': 'true', cookie: 'OWN_WORK=true' },
    body: JSON.stringify({ OWN_WORK: true, 'lifecycle-own-work': true, ownWork: true }),
  });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), DRAIN_503);
  assert.deepEqual(reached, ['5001'], 'only the marked in-process request reached the handler');
});

test('the bot\'s promote carries the mark, and the route it reaches is drain-guarded', async () => {
  const { router, reached } = guardedPromote();
  assert.deepEqual(await live.promoteAsBot({ config: {}, bot: BOT, sessionId: 5001, router }),
    { status: 200, body: { ok: true, prNumber: 42 } });
  assert.deepEqual(reached, ['5001']);
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  assert.match(read('src/routes/votes.js'), /router\.post\('\/api\/sessions\/:id\/promote', drainGuard,/);
  assert.match(read('src/services/homeroom-bot-live.js'),
    /headers: \{\}, query: \{\}, params: \{\}, body: \{\}, cookies: \{\},\n(\s*\/\/.*\n)*\s*\[require\('\.\/lifecycle'\)\.OWN_WORK\]: true,/,
    'set on the request promoteAsBot builds');
});

// ── A durable build that reaches its proposal while its process drains ──

// The build's fakes, as tests/homeroom-bot-live.test.js's buildHarness has
// them: a spec turn that writes nothing, a build turn that pushes one
// commit, and the promote route behind the real drain guard. `answer` is
// what the route says once it is reached (a refusal here stands for any the
// platform makes for now).
function buildHarness() {
  const calls = { modes: [], promoted: [], queries: [] };
  const state = { answer: { status: 200, body: { ok: true, prNumber: 42 } } };
  const pool = {
    async query(sql, params) {
      calls.queries.push({ sql: String(sql), params });
      if (/INSERT INTO chat_sessions/.test(sql)) return { rows: [{ id: 5001, app_id: APP.id, user_id: BOT.id }] };
      if (/SELECT \* FROM chat_sessions WHERE id = \$1/.test(sql)) return { rows: [{ id: 5001, app_id: APP.id, user_id: BOT.id }] };
      return { rows: [] };
    },
  };
  const router = express.Router();
  router.post('/api/sessions/:id/promote', lifecycle.drainGuard, (req, res) => {
    calls.promoted.push(req.params.id);
    res.status(state.answer.status).json(state.answer.body);
  });
  const deps = {
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() { return 'usernode-worker-5001'; },
      async execInWorker(id, opts) {
        calls.modes.push(opts.mode);
        if (opts.mode === 'scout') return { lastResultText: '' };
        return { pushOk: true, ahead: 1, sha: 'a'.repeat(40) };
      },
      async stopTurn() {},
    },
    sessions: {
      async runCodexAttemptLoop(args) {
        const r = await args.dispatchOnce({ openrouterApiKey: 'k' });
        return { result: r, error: null, estimatedCostUsd: args.mode === 'scout' ? null : 0.05 };
      },
      async persistScoutPublication() { return { specVersion: 1 }; },
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
    sessionLifecycle: { async ensureSessionBranch({ sessionId }) { return { branchName: `homeroom_bot/s${sessionId}` }; } },
    activeWorkers: new Set(),
    votesRouter: router,
    // The waits between a refused proposal's tries: none here.
    proposeRetryMs: [0, 0],
  };
  return { pool, deps, calls, state };
}

const BUILD_ARGS = {
  config: {}, bot: BOT, app: APP, repo: REPO, issueNumber: 1,
  issue: { title: 'A shared reading list' }, seed: 'Please work on GitHub issue #1.',
  buildNote: 'A reading list the club shares.', turnBudgetMs: 20 * 60 * 1000, model: 'z-ai/glm-5.3-flash',
};

// The build's work item: every state it saves is kept, so a later attempt
// can go on from the last, as the next claim does.
function workItem() {
  const saves = [];
  const attempt = ({ resumeFrom = null, attempt: n = 1, triesLeft = 0 } = {}) => durableSteps.durable({
    resumeFrom, attempt: n, triesLeft, owner: 'bot-build/run:2027@w1',
    checkpoint: async (state) => { saves.push(state); },
  });
  return { saves, attempt, last: () => saves.at(-1) || null };
}

const keptRefusal = (saves) => saves.some((s) => /Server is restarting|"status":5\d\d/.test(JSON.stringify(s)));

test('a durable build that reaches its proposal while its process drains proposes, and keeps no refusal', async () => {
  const h = buildHarness();
  const w = workItem();
  const out = await live.buildAndPropose({ pool: h.pool, ...BUILD_ARGS, deps: { ...h.deps, durable: w.attempt({ triesLeft: 1 }) } });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.prNumber, 42);
  assert.equal(out.notProposed, undefined);
  assert.deepEqual(h.calls.promoted, ['5001'], 'proposed once, through the drain guard');
  assert.deepEqual(w.last().promoted, { status: 200, body: { ok: true, prNumber: 42, error: null, message: null } });
  assert.equal(keptRefusal(w.saves), false);
});

test('a proposal refused for now is not kept: tried again, thrown while a try is left, and proposed by the next try', async () => {
  const h = buildHarness();
  const w = workItem();
  h.state.answer = { status: 503, body: DRAIN_503 };
  await assert.rejects(
    live.buildAndPropose({ pool: h.pool, ...BUILD_ARGS, deps: { ...h.deps, durable: w.attempt({ triesLeft: 1 }) } }),
    (err) => {
      assert.ok(err instanceof live.ProposalDeferred);
      assert.equal(err.code, 'proposal_deferred');
      assert.equal(err.status, 503);
      assert.equal(durableSteps.isStopped(err), false, 'a try of its own, not a stop');
      return true;
    },
  );
  assert.equal(h.calls.promoted.length, 3, 'asked three times: once, and again after each wait');
  assert.equal(keptRefusal(w.saves), false, 'the refusal is in no save');
  assert.ok(!('promoted' in w.last()), 'the proposal step kept nothing');
  assert.equal(w.last().prepared, true, 'named and described: the next try goes on from here');
  assert.ok(w.last()['reached:landed'], 'its work landed and is kept');
  assert.deepEqual(h.calls.modes, ['scout', 'build']);
  assert.ok(!h.calls.queries.some((q) => /SET status = 'archived'/.test(q.sql)), 'its session is not put away');

  // The next try (the kernel's retry, wherever it is claimed): the route
  // takes it now, and nothing before the proposal runs again.
  h.state.answer = { status: 200, body: { ok: true, prNumber: 42 } };
  const out = await live.buildAndPropose({
    pool: h.pool, ...BUILD_ARGS, deps: { ...h.deps, durable: w.attempt({ resumeFrom: w.last(), attempt: 2, triesLeft: 0 }) },
  });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.prNumber, 42);
  assert.deepEqual(h.calls.modes, ['scout', 'build'], 'not built again');
  assert.equal(h.calls.promoted.length, 4);
  assert.deepEqual(w.last().promoted, { status: 200, body: { ok: true, prNumber: 42, error: null, message: null } });
  assert.equal(keptRefusal(w.saves), false);
});

test('a proposal that went up while its answer was lost is read, not promoted twice', async () => {
  const h = buildHarness();
  const w = workItem();
  h.state.answer = { status: 500, body: { error: 'socket hang up' } };
  const query = h.pool.query;
  h.pool.query = async (sql, params) => {
    // The route did its work before it failed: the session is up for a vote.
    if (/SELECT status, pr_number FROM chat_sessions WHERE id = \$1/.test(sql) && h.calls.promoted.length) {
      return { rows: [{ status: 'promoted', pr_number: 43 }] };
    }
    return query(sql, params);
  };
  const out = await live.buildAndPropose({ pool: h.pool, ...BUILD_ARGS, deps: { ...h.deps, durable: w.attempt({ triesLeft: 1 }) } });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.prNumber, 43);
  assert.equal(h.calls.promoted.length, 1);
});

test('on its last try, or run unkept, a build still refused ends as it always has: built, not proposed, its session kept', async () => {
  for (const steps of [() => workItem().attempt({ attempt: 2, triesLeft: 0 }), () => durableSteps.none()]) {
    const h = buildHarness();
    h.state.answer = { status: 503, body: DRAIN_503 };
    const out = await live.buildAndPropose({ pool: h.pool, ...BUILD_ARGS, deps: { ...h.deps, durable: steps() } });
    assert.equal(out.ok, false);
    assert.equal(out.notProposed, true);
    assert.match(out.error, /built but could not be proposed: Server is restarting/);
    assert.equal(h.calls.promoted.length, 3, 'tried again first');
    assert.ok(!h.calls.queries.some((q) => /SET status = 'archived'/.test(q.sql)));
  }
  // A refusal that is not the platform's (4xx) is the proposal's answer, at once.
  const h = buildHarness();
  h.state.answer = { status: 429, body: { error: 'You already have 20 changes waiting for approval.' } };
  const out = await live.buildAndPropose({ pool: h.pool, ...BUILD_ARGS, deps: { ...h.deps, durable: workItem().attempt({ triesLeft: 1 }) } });
  assert.equal(out.notProposed, true);
  assert.equal(h.calls.promoted.length, 1);
});

// ── The live build around it ─────────────────────────────────────────────

test('a deferred proposal goes through the live build untouched: its try is not kept, nothing is said or recorded', async (t) => {
  const real = {
    buildAndPropose: live.buildAndPropose, post: live.post,
    currentVersion: configs.currentVersion, laterVersion: configs.laterVersion,
  };
  t.after(() => {
    live.buildAndPropose = real.buildAndPropose;
    live.post = real.post;
    configs.currentVersion = real.currentVersion;
    configs.laterVersion = real.laterVersion;
  });
  configs.currentVersion = async () => null;
  configs.laterVersion = async () => null;
  const said = [];
  live.post = async (args) => { said.push(args.kind); return {}; };
  live.buildAndPropose = async () => { throw new live.ProposalDeferred({ status: 503, why: DRAIN_503.error }); };
  const queries = [];
  const w = workItem();
  await assert.rejects(bot.buildLive({
    pool: { async query(sql, params) { queries.push(String(sql)); return /homeroom_bot_run_snapshots/.test(String(sql)) && /RETURNING id/.test(String(sql)) ? { rows: [{ id: 321 }] } : { rows: [] }; } },
    config: {}, bot: BOT, app: APP, repo: REPO, issueNumber: 1, issue: { title: 'A shared reading list' },
    parsed: { verdict: 'ready', buildNote: 'x' }, runId: 2027, seed: 's', seedReadAt: '2026-10-14T18:00:00Z', postedAt: [],
    turnBudgetMs: 1000, model: 'stage/build', specModel: 'stage/spec', firstVersion: true,
    deps: {
      github: { getBotUsername: async () => 'usernode-bot', async fetchIssueComments() { return { comments: [] }; } },
      ws: {}, threadContext: { async loadIssueThread() { return { messages: [] }; } },
      limits: { async recordSpend() {}, async checkBudget() { return {}; } },
      managedOpenRouter: { async usesIncludedKey() { return false; } }, domain: 'x',
      durable: w.attempt({ triesLeft: 1 }),
    },
  }), { code: 'proposal_deferred' });
  assert.deepEqual(said, [], 'nothing said: no "couldn\'t put it up for approval"');
  assert.ok(!('try' in (w.last() || {})), 'its try is not kept: the next one goes on inside it');
  assert.ok(!queries.some((sql) => /SET build_ok = \$2/.test(sql)), 'nothing recorded on its run');
  assert.ok(!queries.some((sql) => /build_retry = jsonb_build_object/.test(sql)), 'not a first version that failed: no retry claimed');
});
