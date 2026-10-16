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
//     made (app-creator.js), and again once it runs (a no-op by then);
//   - an issue one process files reaches every other process's open-issues
//     copy over the bus (github.js noteIssueCreated, applyIssuesChange);
//   - a pass reads a woken first version before its full refresh and sweeps
//     (homeroom-bot.js runOnce);
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

const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// ── Filed once the repository is made ─────────────────────────────────────

/** app-creator.js with nothing real behind it, recording what happens in order. */
function loadAppCreator() {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    github: require.resolve('../src/services/github'),
    docker: require.resolve('../src/services/docker'),
    applicationRuntime: require.resolve('../src/services/application-runtime'),
    caddy: require.resolve('../src/services/caddy'),
    dbManager: require.resolve('../src/services/db-manager'),
    appManifest: require.resolve('../src/services/app-manifest'),
    appSecrets: require.resolve('../src/services/app-secrets'),
    appLlmEnv: require.resolve('../src/services/app-llm-env'),
    template: require.resolve('../src/services/template'),
    pool: require.resolve('../src/db/pool'),
    ws: require.resolve('../src/services/ws'),
    dm: require.resolve('../src/services/homeroom-bot-dm'),
    appCreator: require.resolve('../src/services/app-creator'),
  };
  const saved = Object.fromEntries(Object.values(ids).map((id) => [id, require.cache[id]]));
  for (const id of Object.values(ids)) delete require.cache[id];
  const order = [];
  const pool = {
    async query(sql) {
      const s = String(sql);
      if (/UPDATE apps SET repo_url = \$1/.test(s)) order.push('repo_url');
      if (/UPDATE apps SET status = \$1, container_id/.test(s)) order.push('running');
      if (/UPDATE apps SET status = \$1 WHERE id = \$2/.test(s)) order.push('status');
      return { rows: [], rowCount: 1 };
    },
  };
  stub(ids.logger, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
  stub(ids.github, {
    isEnabled: () => true,
    parseGithubUrl: () => ({ owner: 'usernode-bot', repo: 'club-votes' }),
    getBotUsername: async () => 'usernode-bot',
    createRepo: async (owner, slug) => ({ html_url: `https://github.com/${owner}/${slug}` }),
    pushFiles: async () => { order.push('starter_pushed'); return { sha: 'a'.repeat(40) }; },
    getCloneUrl: async () => 'https://github.com/usernode-bot/club-votes.git',
  });
  stub(ids.docker, { execFileAsync: async () => ({ stdout: 'f'.repeat(40), stderr: '' }) });
  stub(ids.applicationRuntime, {
    mode: () => 'docker',
    async build() { order.push('build'); return { imageRef: 'img', buildRef: 'b', engine: 'docker' }; },
    async deploy(_config, opts) {
      order.push('deploy');
      if (opts.onRollout) opts.onRollout();
      return { hostname: 'club-votes.example.test', url: 'https://club-votes.example.test', runtimeKind: 'docker', runtimeName: 'c' };
    },
  });
  stub(ids.caddy, { productionHostname: (slug) => `${slug}.example.test` });
  stub(ids.dbManager, { appDbName: (slug) => `app_${slug}`, createDatabase: async () => ({ password: 'pw' }), connectionUrl: () => 'postgres://x' });
  stub(ids.appManifest, {
    read: () => ({ secrets: [] }),
    reconcileAppName: async () => {}, reconcileAppVisibility: async () => {}, reconcileAppGovernance: async () => {},
    reconcileAppScreenshot: async () => {}, reconcileAppIcon: async () => {}, reconcileAppAdmins: async () => {},
    reconcileAppTopics: async () => null,
  });
  stub(ids.appSecrets, { getRawValues: async () => ({}), mergeForDeploy: () => ({ missingRequired: [], env: {} }), platformDefaultsFromEnv: () => ({}) });
  stub(ids.appLlmEnv, { productionLlmEnv: async () => ({}) });
  stub(ids.template, {
    getTemplateFiles: () => [{ path: 'Dockerfile', content: 'FROM node:22-alpine\n' }, { path: 'dapp.json', content: '{}\n' }],
    getConnectorScaffoldFiles: () => [],
    getCanonicalRepoFile: () => null,
  });
  stub(ids.pool, { getPool: () => pool });
  stub(ids.ws, { pushAppStatusUpdate: () => {}, pushAppCreationPhase: () => {} });
  const filed = [];
  stub(ids.dm, {
    async fileFirstVersion(_pool, _config, appId) { order.push('file'); filed.push(appId); return null; },
  });
  const appCreator = require(ids.appCreator);
  const restore = () => {
    for (const [id, mod] of Object.entries(saved)) {
      if (mod) require.cache[id] = mod; else delete require.cache[id];
    }
  };
  return { appCreator, order, filed, restore };
}

test('a project files its first version as soon as its repository holds the starter, and again once it runs', async (t) => {
  const slug = 'club-votes-early';
  const { appCreator, order, filed, restore } = loadAppCreator();
  t.after(() => { restore(); fs.rmSync(`/tmp/usernode-build-${slug}`, { recursive: true, force: true }); });

  await appCreator.createApp({}, { id: 41, name: 'Club Votes', slug, created_by: 5, self_hosted: false });

  assert.deepEqual(filed, [41, 41]);
  assert.ok(order.indexOf('file') > order.indexOf('repo_url'), `after its repository is recorded: ${order}`);
  assert.ok(order.indexOf('file') > order.indexOf('starter_pushed'), 'which holds the starter');
  assert.ok(order.indexOf('file') < order.indexOf('build'), `before the starter is built: ${order}`);
  assert.ok(order.lastIndexOf('file') > order.indexOf('running'), 'and once it runs, as before');
});

test('a creation whose repository could not be made files nothing early', async (t) => {
  const slug = 'club-votes-no-repo';
  const { appCreator, order, filed, restore } = loadAppCreator();
  t.after(() => { restore(); fs.rmSync(`/tmp/usernode-build-${slug}`, { recursive: true, force: true }); });
  require('../src/services/github').pushFiles = async () => { throw new Error('GitHub said no'); };

  await appCreator.createApp({}, { id: 42, name: 'Club Votes', slug, created_by: 5, self_hosted: false });

  assert.deepEqual(filed, [], 'no repository, nothing to file');
  assert.ok(!order.includes('repo_url'));
});

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

function rawIssue(number, title, body) {
  return {
    number, title, body, labels: [], state: 'open',
    created_at: '2026-10-15T10:00:00Z', updated_at: '2026-10-15T10:00:00Z',
    html_url: `https://github.com/usernode-bot/club-votes/issues/${number}`, user: { login: 'usernode-bot' },
  };
}

/** GitHub as a process reading it sees it: the open list lags behind the create; one issue can be asked for. */
function stubGithubFetch(t, singles = {}) {
  const calls = [];
  const real = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    const one = String(url).match(/\/issues\/(\d+)$/);
    const body = one ? singles[one[1]] : [];
    return { ok: !!body, status: body ? 200 : 404, headers: { get: () => null }, json: async () => body };
  };
  t.after(() => { global.fetch = real; });
  return calls;
}

test('an issue one process files is in every other process\'s open-issues copy at once, and never passed on again', async (t) => {
  require('../src/services/github').isEnabled(); // loaded before it is swapped
  const sent = capturePublishes(t);
  const github = require('../src/services/github');
  const body = '**Source:** Homeroom user (evan)\n\nPolls for our club, so we can decide things together.';
  assert.equal(github.noteIssueCreated('usernode-bot', 'club-votes', rawIssue(1, 'First version of Club Votes', body)), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'issues_cache');
  assert.deepEqual(sent[0].routing, { owner: 'usernode-bot', repo: 'club-votes' });
  assert.equal(sent[0].data.created.number, 1, 'the issue itself rides along');
  assert.equal(sent[0].data.created.body, body);

  // The conductor: nothing of this repository's, and GitHub's list does not
  // have the issue yet.
  const conductor = otherProcess(t);
  const calls = stubGithubFetch(t);
  const ws = require('../src/services/ws');
  ws._onBusMessage({ kind: 'issues_cache', routing: sent[0].routing, data: sent[0].data });
  assert.equal(sent.length, 1, 'applied here only');
  const list = await conductor.fetchPublicIssues('usernode-bot', 'club-votes');
  assert.deepEqual(list.issues.map((i) => i.number), [1], 'its refresh finds the request');
  const before = calls.length;
  const one = await conductor.fetchPublicIssue('usernode-bot', 'club-votes', 1);
  assert.equal(one.issue.body, body, 'and its read has the whole request');
  assert.equal(calls.length, before, 'without asking GitHub');
});

test('one too big for the bus carries its number, and the other process reads it from GitHub once', async (t) => {
  require('../src/services/github').isEnabled();
  const sent = capturePublishes(t);
  const github = require('../src/services/github');
  const body = `Polls for our club. ${'Every member votes once on each poll, and sees who won. '.repeat(150)}`;
  github.noteIssueCreated('usernode-bot', 'club-votes-big', rawIssue(2, 'First version of Club Votes', body));
  assert.deepEqual(sent.map((m) => m.data), [{ createdNumber: 2 }], 'never a NOTIFY too big to send');

  const conductor = otherProcess(t);
  const calls = stubGithubFetch(t, { 2: rawIssue(2, 'First version of Club Votes', body) });
  require('../src/services/ws')._onBusMessage({ kind: 'issues_cache', routing: sent[0].routing, data: sent[0].data });
  await settle();
  assert.equal(calls.filter((u) => /\/issues\/2$/.test(u)).length, 1, 'read once, by its number');
  const list = await conductor.fetchPublicIssues('usernode-bot', 'club-votes-big');
  assert.deepEqual(list.issues.map((i) => i.number), [2]);
  assert.equal(list.issues[0].body, body);
});

// ── A pass reads a woken first version first ────────────────────────────

const bot = require('../src/services/homeroom-bot');

// The moment the bot went on for everyone is fixed before the issue below:
// left unset, readSettings counts it from now, and an issue made before now
// reads as one the bot has seen, so the test passed before 10:00 UTC on
// 15 Oct 2026 and failed after it.
const SETTINGS = [
  { key: bot.KEY_MODE, value: 'live' },
  { key: bot.KEY_PER_PERSON, value: '3' },
  { key: bot.KEY_LIVE_AT_ONCE, value: '8' },
  { key: bot.KEY_EVERYONE_SINCE, value: '2026-10-01T00:00:00.000Z' },
];
const APP = { id: 101, slug: 'club-votes', name: 'Club Votes', repo_url: 'https://github.com/o/club-votes', self_hosted: false };

function loopPool(log) {
  const client = {
    async query(sql) {
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] };
      return { rows: [] };
    },
    release() {},
  };
  return {
    async connect() { return client; },
    async query(sql, params) {
      const s = String(sql);
      if (/SELECT key, value FROM platform_settings/.test(s)) return { rows: SETTINGS };
      if (/FROM users WHERE username = \$1/.test(s)) return { rows: [{ id: 77, username: 'homeroom_bot', weekly_limit_cents: 15000 }] };
      if (/SELECT is_synthetic FROM users/.test(s)) return { rows: [{ is_synthetic: true }] };
      if (/WHERE fv\.app_id = ANY\(\$1::int\[\]\) AND fv\.bot_builds AND fv\.status = 'filed'/.test(s)) {
        log.push('first_versions_to_read');
        return { rows: params[0].includes(APP.id) ? [{ app_id: APP.id }] : [] };
      }
      if (/FROM apps\s+WHERE status = 'running'/.test(s)) { log.push('list_apps'); return { rows: [APP] }; }
      if (/INSERT INTO homeroom_bot_queue/.test(s)) { log.push('queued'); return { rows: [{ id: 500, inserted: true }] }; }
      if (/FROM homeroom_bot_queue q\s+JOIN apps a/.test(s)) {
        log.push(`candidates:${params[11] ? 'first_versions' : 'all'}`);
        return { rows: [{ id: 500, app_id: APP.id, issue_number: 1, priority: 1, reason: 'new', person_id: 7 }] };
      }
      if (/FROM apps WHERE id = ANY\(\$1::int\[\]\)/.test(s)) return { rows: [APP] };
      if (/UPDATE homeroom_bot_queue SET started_at = NOW\(\) WHERE id = \$1 AND started_at IS NULL RETURNING id/.test(s)) {
        log.push('claimed');
        return { rows: [{ id: params[0] }] };
      }
      if (/UPDATE homeroom_bot_queue SET started_at = NOW\(\) WHERE id = \$1 AND \(started_at IS NULL OR/.test(s)) {
        return { rows: [{ thread_seen_at: null, changed_by: null }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

test('a woken first version is refreshed and its read started before the pass\'s full refresh and sweeps', async (t) => {
  bot._resetForTests(); // the full refresh is due: it has never run
  t.after(() => bot._resetForTests());
  // Woken for the project whose first version was just filed (onBusMessage).
  bot._setPassInFlightForTests(true);
  assert.equal(bot.wake({ appId: APP.id }), true);
  bot._setPassInFlightForTests(false);

  const log = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const reads = [];
  const deps = {
    drain: false,
    github: {
      isEnabled: () => true,
      async fetchPublicIssues() {
        log.push('github_list');
        return { issues: [{ number: 1, title: 'First version of Club Votes', state: 'open', createdAt: '2026-10-15T10:00:00Z', updatedAt: '2026-10-15T10:00:00Z' }] };
      },
      // Where the read is once it has its slot: reading its request.
      async fetchPublicIssue(_o, _r, n) { reads.push(n); await gate; return { issue: { state: 'closed' } }; },
    },
    limits: { async checkBudget() { return { ok: true }; } },
    worker: { async listWorkerVolumes() { return []; } },
    dm: {
      async recordRequester() { return null; },
      async overWeeklyAllowance() { return false; },
      async requesterOf() { return null; },
      // The full sweep every REFRESH_INTERVAL_MS starts here; it never ends,
      // as a slow refresh of every app might not for a long time.
      sweepFirstVersions: () => { log.push('sweep'); return new Promise(() => {}); },
    },
  };
  void bot.runOnce(loopPool(log), {}, deps);
  await settle(30);

  assert.ok(log.includes('sweep'), 'the pass is in its sweep');
  const at = (what) => log.indexOf(what);
  assert.ok(at('queued') >= 0 && at('queued') < at('sweep'), `its request queued first: ${log}`);
  assert.ok(at('candidates:first_versions') >= 0 && at('candidates:first_versions') < at('sweep'), `read first: ${log}`);
  assert.ok(at('claimed') < at('sweep'), 'and claimed, before the sweep');
  assert.equal(log.filter((x) => x === 'list_apps').length, 1, 'the full refresh has not read every app yet');
  assert.ok(!log.includes('candidates:all'), 'nothing else of the pass has been dispatched');
  assert.deepEqual(bot._inFlightForTests().map((e) => [e.appId, e.issueNumber, e.lane, e.itemId]), [[APP.id, 1, 'live', 500]],
    'the first version\'s read already has its slot');
  await settle();
  assert.deepEqual(reads, [1], 'and has started');
  release();
  await settle(20);
});

test('a pass with nothing of a first version woken goes as it always did', async (t) => {
  bot._resetForTests();
  t.after(() => bot._resetForTests());
  const log = [];
  const deps = {
    drain: false,
    github: { isEnabled: () => true, async fetchPublicIssues() { return { issues: [] }; }, async fetchPublicIssue() { return { issue: null }; } },
    limits: { async checkBudget() { return { ok: true }; } },
    worker: { async listWorkerVolumes() { return []; } },
    dm: { sweepFirstVersions: async () => { log.push('sweep'); return 0; } },
  };
  const out = await bot.runOnce(loopPool(log), {}, deps);
  assert.equal(out.firstVersionReads, undefined);
  assert.ok(!log.includes('first_versions_to_read'), 'nothing woken: nothing asked');
  assert.equal(log[0], 'sweep', `the sweep and the full refresh first, as before: ${log}`);
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
