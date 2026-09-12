// The browser's door into the external-agent flow (#1049).
//
// src/routes/dev-flow.js is deliberately thin: prepareWork / submitWork /
// inspectFork / inspectPushedBranch already existed and are covered by
// tests/external-agent-tasks.test.js. What is NEW here — and what this file
// pins — is the transport around them:
//
//   1. GET /api/apps/:slug/dev-flow/status answers every step of the
//      walkthrough in one request, and degrades a step at a time. A missing
//      repository, a GitHub App that is off, an unlinked account and a
//      branch read that throws each produce a renderable payload, never a
//      500 and never a half-answer.
//   2. The picked agent round-trips as `usernode-web:<agent>` on client_id,
//      which is what makes reopening the chat resume the same work order.
//      Only the two real products are pickable.
//   3. Both writes are cookie-authenticated mutations that spend a
//      rate-limit slot and can open a pull request, so they carry the
//      same-origin check — refused BEFORE the service is reached.
//   4. Every failure code the service layer can emit has an HTTP status.
//      This is scraped from the service sources, so a new code in
//      external-agent-tasks.js fails here instead of silently answering 400.
//
// Run with: node --test tests/dev-flow-routes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ── Stubs, installed before the router is built ─────────────────────────

const poolMod = require('../src/db/pool');
let poolCalls = [];
poolMod.getPool = () => ({
  async query(sql, params) {
    poolCalls.push({ sql, params });
    // The hand-off target's row (#1071), read when the caller named one.
    if (/FROM chat_sessions/.test(sql)) {
      if (stub.targetThrows) throw new Error('database is on fire');
      return { rows: stub.target ? [stub.target] : [] };
    }
    // The only other query the route itself makes: the advisory connector count.
    return { rows: [{ n: 2 }] };
  },
});

const appAccess = require('../src/services/app-access');
const svc = require('../src/services/external-agent-tasks');
const githubLink = require('../src/services/github-link');
const gh = require('../src/services/github');

const APP = { id: 7, slug: 'recipe-box', name: 'Recipe Box', repo_url: 'https://github.com/usernode-apps/recipe-box' };
const BASE_SHA = '0123456789abcdef0123456789abcdef01234567';
const ORIGIN = 'https://usernode.example';
const CONFIG = { cliAuthOrigin: ORIGIN, port: 4321 };

// Every stub is reset in beforeEach; a test overrides only what it needs.
let stub;
function resetStubs() {
  poolCalls = [];
  stub = {
    app: APP,
    ghEnabled: true,
    linkEnabled: true,
    link: { linked: true, login: 'octo-contributor' },
    fork: { state: 'ready', fork: { name: 'recipe-box' } },
    task: null,
    branchState: 'pushed',
    branchThrows: false,
    prepare: { ok: true, taskId: 4242, agent: 'claude-code', reused: false },
    submit: { ok: true, proposalId: 91, submittedVia: 'pull_request' },
    prepareArgs: null,
    submitArgs: null,
    target: null,
    targetThrows: false,
    // The discard route's service call: the id it closed, or null for
    // "not open any more".
    discard: 4242,
    discardArgs: null,
    discardThrows: false,
    loadedVia: null,
    loadedSessionId: null,
  };
}

// A hand-off target row, as the prepare route reads it (#1071). Native and
// owned by the caller unless a test says otherwise, because that is the shape
// the options menu offers "Continue this session" for.
function targetRow(status, over) {
  return Object.assign({
    id: 990405,
    user_id: 42,
    app_id: 7,
    status,
    source: 'native',
    branch_name: 'dev/evan-1786376421087',
    imported_pr_head_sha: null,
    pr_title: null,
    session_title: 'Add a button',
  }, over || {});
}

appAccess.getAppForUser = async () => stub.app;
gh.isEnabled = () => stub.ghEnabled;
gh.parseGithubUrl = (url) => {
  const m = /github\.com\/([^/]+)\/([^/.]+)/.exec(url || '');
  return m ? { owner: m[1], repo: m[2] } : null;
};
githubLink.isEnabled = () => stub.linkEnabled;
githubLink.linkStatus = async () => stub.link;
svc.inspectFork = async () => stub.fork;
svc.loadLatestOpenTaskForSlug = async (_pool, _userId, _slug, opts) => {
  stub.loadOpts = opts;
  stub.loadedVia = 'app';
  return stub.task;
};
svc.loadOpenTaskForSession = async (_pool, _userId, _slug, sessionId, opts) => {
  stub.loadOpts = opts;
  stub.loadedVia = 'session';
  stub.loadedSessionId = sessionId;
  return stub.task;
};
svc.inspectPushedBranch = async () => {
  if (stub.branchThrows) throw new Error('github said no');
  return stub.branchState;
};
svc.discardTask = async (_pool, userId, appId, taskId) => {
  stub.discardArgs = { userId, appId, taskId };
  if (stub.discardThrows) throw new Error('database is on fire');
  return stub.discard;
};
svc.prepareWork = async (_deps, args) => { stub.prepareArgs = args; return stub.prepare; };
svc.submitWork = async (_deps, args) => { stub.submitArgs = args; return stub.submit; };

const { devFlowRoutes, PICKABLE_AGENTS, STATUS_BY_CODE, shapeBranch } = require('../src/routes/dev-flow');

let server, base;
let user = null;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(devFlowRoutes(CONFIG));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  // closeAllConnections first — undici holds the sockets open and a bare
  // close() would wait on them (see tests/dev-flow-preference.test.js).
  if (!server) return;
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  server.close();
});

test.beforeEach(() => {
  resetStubs();
  user = { id: 42, username: 'tester', isAdmin: false };
});

const status = (qs = '') => fetch(`${base}/api/apps/recipe-box/dev-flow/status${qs}`);
const post = (url, body, headers = {}) => fetch(`${base}${url}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const prepare = (body, headers) => post('/api/apps/recipe-box/external-tasks', body, headers);
const submit = (id, body, headers) => post(`/api/apps/recipe-box/external-tasks/${id}/submit`, body || {}, headers);

function openTask(over) {
  return Object.assign({
    id: 4242,
    client_id: 'usernode-web:codex',
    branch_name: 'usernode/add-a-button',
    base_sha: BASE_SHA,
    fork_owner: 'octo-contributor',
    fork_repo: 'recipe-box',
    issue_number: null,
    brief: 'Add a button.',
  }, over || {});
}

// ── 1. Authentication and app access ────────────────────────────────────

test('all three routes are 401 without a session', async () => {
  user = null;
  for (const r of [await status(), await prepare({ agent: 'codex', brief: 'x' }), await submit(1)]) {
    assert.equal(r.status, 401);
  }
  assert.equal(stub.prepareArgs, null, 'the service is never reached');
  assert.equal(stub.submitArgs, null);
});

test('an app the user cannot collaborate on is a 404 on all three', async () => {
  stub.app = null;
  for (const r of [await status(), await prepare({ agent: 'codex', brief: 'x' }), await submit(1)]) {
    assert.equal(r.status, 404);
  }
  assert.equal(stub.prepareArgs, null, 'access is resolved before any work is prepared');
});

// ── 2. Status: the walkthrough's state ──────────────────────────────────

test('an app with no repository reports why, instead of failing', async () => {
  // Every unavailable branch still returns 200 with a `reason` the client
  // has copy for — the walkthrough explains itself rather than erroring.
  stub.app = { ...APP, repo_url: null };
  const r = await status();
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.available, false);
  assert.equal(j.reason, 'no_repository');
  assert.deepEqual([j.fork, j.task, j.branch], [null, null, null]);
});

test('the two "the platform cannot do this" reasons are distinguished', async () => {
  stub.ghEnabled = false;
  assert.equal((await (await status()).json()).reason, 'platform_unavailable');

  stub.ghEnabled = true;
  stub.linkEnabled = false;
  const j = await (await status()).json();
  assert.equal(j.reason, 'link_unavailable');
  assert.equal(j.github.available, false,
    'the GitHub step must show as unavailable, not merely unlinked');
});

test('an unlinked account stops at step 1 without touching GitHub', async () => {
  stub.link = { linked: false, login: null };
  let inspected = false;
  const realInspect = svc.inspectFork;
  svc.inspectFork = async () => { inspected = true; return stub.fork; };
  try {
    const j = await (await status()).json();
    assert.equal(j.available, true, 'the flow itself is available — the user just has a step to do');
    assert.deepEqual(j.github, { linked: false, login: null, available: true });
    assert.deepEqual([j.fork, j.task, j.branch], [null, null, null]);
    assert.equal(inspected, false, 'there is no login to inspect a fork for');
  } finally {
    svc.inspectFork = realInspect;
  }
});

test('a linked account with no work order reports the fork and stops there', async () => {
  const j = await (await status()).json();
  assert.equal(j.available, true);
  assert.deepEqual(j.repo, { owner: 'usernode-apps', repo: 'recipe-box' });
  assert.equal(j.github.login, 'octo-contributor');
  assert.equal(j.fork.state, 'ready');
  assert.equal(j.fork.owner, 'octo-contributor');
  assert.equal(j.fork.url, 'https://github.com/octo-contributor/recipe-box');
  assert.equal(j.fork.pageUrl, 'https://github.com/usernode-apps/recipe-box/fork',
    'the "create a fork" link must point at the UPSTREAM repo');
  assert.equal(j.task, null);
  assert.equal(j.branch, null);
  assert.equal(j.connectors.count, 2, 'the advisory connector count comes from the pool');
});

test('an unreadable fork is "unknown", and a name conflict keeps its suffix', async () => {
  stub.fork = { state: 'unknown' };
  assert.equal((await (await status()).json()).fork.state, 'unknown',
    'a failed read must not assert the user has no fork');

  stub.fork = { state: 'name_conflict' };
  const j = await (await status()).json();
  assert.equal(j.fork.state, 'name_conflict');
  assert.equal(j.fork.repo, `recipe-box${svc.CONFLICT_FORK_SUFFIX}`,
    'the walkthrough must name the fork the service will actually use');
});

test('an open work order is re-rendered from its stored values', async () => {
  // This is what makes the walkthrough resumable: the branch and base commit
  // come off the row, so closing the tab and coming back shows the SAME work
  // order rather than preparing a second one.
  stub.task = openTask();
  let renderArgs = null;
  const realRender = svc.renderPreparedTask;
  svc.renderPreparedTask = (args) => {
    renderArgs = args;
    return realRender({ ...args, prompts: require('../src/services/prompts') });
  };
  try {
    const j = await (await status()).json();
    assert.equal(renderArgs.reused, true);
    assert.equal(renderArgs.clientId, 'usernode-web:codex',
      'the stored client id is what carries the picked agent');
    assert.equal(renderArgs.origin, ORIGIN, 'links are stamped with the canonical origin');
    assert.equal(renderArgs.forkStatus, 'ready');

    assert.equal(j.task.id, 4242);
    assert.equal(j.task.agent, 'codex', 'the agent survives a reload with no column of its own');
    assert.equal(j.task.branch, 'usernode/add-a-button');
    assert.equal(j.task.baseSha, BASE_SHA);
    assert.equal(j.task.brief, 'Add a button.');
    assert.ok(j.task.workOrder.length > 0, 'the work order is ready to paste');
    assert.ok(Array.isArray(j.task.guidance) && j.task.guidance.length > 0);
    assert.deepEqual(j.branch, { state: 'pushed', pushed: true, unpushed: false, missing: false });
  } finally {
    svc.renderPreparedTask = realRender;
  }
});

test('a resumed update work order says WHICH kind of thing it continues (#1071)', async () => {
  // targetKind is what the walkthrough's copy branches on: continuing a
  // promoted proposal clears votes, continuing a session nobody has voted on
  // does not. It has to survive a reload, so it is re-derived here from the
  // target's CURRENT status rather than stored on the task row.
  stub.task = openTask({ target_session_id: 990405 });

  for (const [sessionStatus, kind] of [['active', 'session'], ['paused', 'session'], ['promoted', 'proposal']]) {
    stub.target = targetRow(sessionStatus);
    const j = await (await status()).json();
    assert.equal(j.task.targetProposal.targetKind, kind, `${sessionStatus} → ${kind}`);
    assert.equal(j.task.targetProposal.id, 990405);
    assert.equal(j.task.targetProposal.branchHome, 'app_repo');
    assert.equal(j.task.targetProposal.title, 'Add a button',
      'a session that was never promoted has no pr_title, so its own title is shown');
  }

  // A target that stopped being continuable is dropped rather than described:
  // the walkthrough goes back to "open a new proposal", which is the truth.
  stub.target = targetRow('archived');
  assert.equal((await (await status()).json()).task.targetProposal, null);
});

test('an ordinary work order has no target at all', async () => {
  stub.task = openTask();
  const j = await (await status()).json();
  assert.equal(j.task.targetProposal, null);
  assert.equal(poolCalls.some((c) => /FROM chat_sessions/.test(c.sql)), false,
    'nothing is read for a work order that continues nothing');
});

test('a branch read that throws leaves the step unknown, not the request failed', async () => {
  // GitHub being briefly unreadable must not blank the work order the user
  // is in the middle of — the last step just cannot answer yet.
  stub.task = openTask();
  stub.branchThrows = true;
  const r = await status();
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.task.id, 4242, 'the work order is still delivered');
  assert.deepEqual(j.branch, { state: 'unknown', pushed: false, unpushed: false, missing: false });
});

test('shapeBranch answers the three questions the walkthrough asks', () => {
  assert.deepEqual(shapeBranch('pushed'), { state: 'pushed', pushed: true, unpushed: false, missing: false });
  assert.deepEqual(shapeBranch('unpushed'), { state: 'unpushed', pushed: false, unpushed: true, missing: false });
  assert.deepEqual(shapeBranch('missing'), { state: 'missing', pushed: false, unpushed: false, missing: true });
  // Anything else is "we don't know" — never accidentally truthy.
  for (const s of ['unknown', '', null, undefined]) {
    const shaped = shapeBranch(s);
    assert.equal(shaped.pushed || shaped.unpushed || shaped.missing, false, `${s} asserts nothing`);
  }
});

test('an unexpected throw is a 500, not a half-rendered payload', async () => {
  const real = appAccess.getAppForUser;
  appAccess.getAppForUser = async () => { throw new Error('database is on fire'); };
  try {
    const r = await status();
    assert.equal(r.status, 500);
    assert.doesNotMatch(JSON.stringify(await r.json()), /on fire/,
      'the internal message must not be echoed to the browser');
  } finally {
    appAccess.getAppForUser = real;
  }
});

// ── 3. Prepare ──────────────────────────────────────────────────────────

test('only the two real products are pickable', async () => {
  assert.deepEqual(PICKABLE_AGENTS, ['claude-code', 'codex']);
  for (const agent of ['external', 'claude', 'CODEX', '', null, 42, ['codex']]) {
    const r = await prepare({ agent, brief: 'Add a button.' });
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(agent)}`);
    assert.equal((await r.json()).code, 'invalid_request');
    assert.equal(stub.prepareArgs, null, 'no slot is spent on an unpickable agent');
  }
});

test('a work order needs something to say', async () => {
  for (const body of [{ agent: 'codex' }, { agent: 'codex', brief: '   ' }, { agent: 'codex', issueNumber: 0 }]) {
    const r = await prepare(body);
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.equal(stub.prepareArgs, null);
  }
  // An issue number alone is enough — the brief comes from the issue.
  const ok = await prepare({ agent: 'codex', issueNumber: 12 });
  assert.equal(ok.status, 200);
  assert.equal(stub.prepareArgs.issueNumber, 12);
});

test('the picked agent is recorded on the row as usernode-web:<agent>', async () => {
  for (const agent of PICKABLE_AGENTS) {
    const r = await prepare({ agent, brief: 'Add a button.' });
    assert.equal(r.status, 200);
    assert.equal(stub.prepareArgs.agent, agent, 'the explicit choice is passed through, not sniffed');
    assert.equal(stub.prepareArgs.clientId, `usernode-web:${agent}`);
    assert.equal(stub.prepareArgs.origin, ORIGIN);
    // And that stamp is exactly what the status route reads back.
    assert.equal(svc.normalizeAgent(null, stub.prepareArgs.clientId), agent);
  }
});

// ── 3b. Continuing existing work (#1071) ────────────────────────────────

test('a named target is described and handed to the service', async () => {
  for (const [sessionStatus, kind] of [['active', 'session'], ['paused', 'session'], ['promoted', 'proposal']]) {
    stub.target = targetRow(sessionStatus);
    const r = await prepare({ agent: 'codex', brief: 'Fix the button.', proposalId: 990405 });
    assert.equal(r.status, 200, `${sessionStatus} is continuable`);
    assert.equal(stub.prepareArgs.targetProposal.id, 990405,
      'the ROW reaches prepareWork, which describes it again itself');
    assert.equal(stub.prepareArgs.targetProposal.status, sessionStatus);
    // And the describe that gated it agrees with what the menu offered.
    assert.equal(
      svc.describeTargetProposal(stub.target, user, APP, ORIGIN).targetKind, kind,
      `${sessionStatus} → ${kind}`
    );
  }
});

test('a malformed proposalId is a 400, never a quietly ignored field', async () => {
  // Ignoring it would open NEW work when the user asked to continue — the one
  // outcome the options menu must never produce by accident.
  for (const proposalId of ['990405', 0, -3, 1.5, true, {}, ['990405']]) {
    const r = await prepare({ agent: 'codex', brief: 'x', proposalId });
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(proposalId)}`);
    assert.equal((await r.json()).code, 'invalid_request');
    assert.equal(stub.prepareArgs, null, 'no slot is spent, and no target is guessed');
  }
  // Absent and null both mean "this is new work", which is not an error.
  for (const body of [{ agent: 'codex', brief: 'x' }, { agent: 'codex', brief: 'x', proposalId: null }]) {
    const r = await prepare(body);
    assert.equal(r.status, 200);
    assert.equal(stub.prepareArgs.targetProposal, null);
  }
});

test('a target that stopped being continuable is refused with its own wording', async () => {
  // The same predicate that chose the menu's label is applied again here, so
  // a session archived between the click and the request is a refusal rather
  // than a silent downgrade to a new change.
  stub.target = targetRow('archived');
  const r = await prepare({ agent: 'codex', brief: 'x', proposalId: 990405 });
  assert.equal(r.status, 409);
  const j = await r.json();
  assert.equal(j.code, 'proposal_closed');
  assert.match(j.error, /was archived/, 'the archived case gets its own copy');
  assert.equal(stub.prepareArgs, null, 'no work order is written for it');

  for (const [sessionStatus, expected] of [['merged', 409], ['draft', 409]]) {
    stub.target = targetRow(sessionStatus);
    assert.equal((await prepare({ agent: 'codex', brief: 'x', proposalId: 990405 })).status, expected);
  }
});

test('somebody else\'s session, another app\'s session, and one that is gone', async () => {
  stub.target = targetRow('active', { user_id: 99 });
  let j = await (await prepare({ agent: 'codex', brief: 'x', proposalId: 990405 })).json();
  assert.equal(j.code, 'not_your_proposal');

  stub.target = targetRow('active', { app_id: 8 });
  j = await (await prepare({ agent: 'codex', brief: 'x', proposalId: 990405 })).json();
  assert.equal(j.code, 'invalid_request');

  stub.target = null;
  const gone = await prepare({ agent: 'codex', brief: 'x', proposalId: 990405 });
  assert.equal(gone.status, 400);
  assert.match((await gone.json()).error, /does not exist/);
  assert.equal(stub.prepareArgs, null);
});

test('a target row that cannot be read is a 503, not a 500', async () => {
  stub.targetThrows = true;
  const r = await prepare({ agent: 'codex', brief: 'x', proposalId: 990405 });
  assert.equal(r.status, 503);
  const j = await r.json();
  assert.equal(j.code, 'platform_unavailable');
  assert.doesNotMatch(j.error, /on fire/, 'the internal message stays internal');
});

test('a session with no usable branch name cannot be continued', async () => {
  // A native continuation is based at the head of THIS branch and pushed back
  // onto it: without a name there is no base to hand the agent.
  //
  // #1350 made this an ordinary state rather than a platform fault: a session
  // that has not run a turn yet genuinely has no branch, so the answer is a
  // 409 naming what to do instead, not a 503 that reads as an outage.
  for (const branch of ['', null]) {
    stub.target = targetRow('active', { branch_name: branch });
    const r = await prepare({ agent: 'codex', brief: 'x', proposalId: 990405 });
    assert.equal(r.status, 409);
    const j = await r.json();
    assert.equal(j.code, 'session_not_started');
    assert.match(j.error, /has not run a turn yet/);
    assert.match(j.error, /send a message in the session/i);
  }
});

test('restart is a boolean the caller cannot smuggle a value through', async () => {
  await prepare({ agent: 'codex', brief: 'x', restart: 'yes please' });
  assert.equal(stub.prepareArgs.restart, true);
  await prepare({ agent: 'codex', brief: 'x' });
  assert.equal(stub.prepareArgs.restart, false);
});

// ── 4. Submit ───────────────────────────────────────────────────────────

test('a task id that is not a positive integer is refused', async () => {
  for (const id of ['abc', '0', '-3', '1.5.2']) {
    const r = await submit(id);
    assert.equal(r.status, 400, `expected 400 for ${id}`);
    assert.equal(stub.submitArgs, null);
  }
});

test('submit hands the service a loopback import that replays the caller\'s session', async () => {
  // The import must run through the browser's OWN pr-import route so the
  // proposal is attributed to the user and gets the same announcement and
  // staging build — and it must not be able to leave the box.
  const r = await fetch(`${base}/api/apps/recipe-box/external-tasks/4242/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: 'session=abc123' },
    body: JSON.stringify({ title: 'Add a button' }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), stub.submit);
  assert.equal(stub.submitArgs.taskId, 4242);
  assert.equal(stub.submitArgs.source, 'web');
  assert.equal(stub.submitArgs.title, 'Add a button');
  assert.equal(typeof stub.submitArgs.importProposal, 'function');

  const seen = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    seen.push({ url, opts });
    return { ok: true, status: 200, async text() { return '{"proposalId":91}'; } };
  };
  try {
    const out = await stub.submitArgs.importProposal('recipe-box', 5);
    assert.deepEqual(out, { ok: true, status: 200, body: { proposalId: 91 } });
  } finally {
    global.fetch = realFetch;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'http://127.0.0.1:4321/api/apps/recipe-box/pr-import',
    'loopback only: 127.0.0.1 and this process\'s own port');
  assert.equal(seen[0].opts.headers.cookie, 'session=abc123',
    'the caller\'s own session is replayed, so the import is attributed to them');
  assert.equal(seen[0].opts.body, '{"pr":5,"promote":true}',
    'automated submit keeps its explicit straight-to-vote contract');
});

test('an import that cannot be reached is reported, not thrown', async () => {
  await submit(4242);
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  try {
    const out = await stub.submitArgs.importProposal('recipe-box', 5);
    assert.deepEqual(out, { ok: false, status: 0, body: null, networkError: true });
  } finally {
    global.fetch = realFetch;
  }
});

// ── 5. Failure mapping ──────────────────────────────────────────────────

test('every failure code the service layer can emit has an HTTP status', () => {
  // Scraped, not listed: a new fail() in the service must either be mapped
  // here or fail this test. An unmapped code answers 400, which tells a
  // client "your request was wrong" for what may be a 429 or a 502.
  const emitted = new Set();
  for (const src of [
    'src/services/external-agent-tasks.js',
    'src/services/connector-limits.js',
    // The update path (#1054). Its refusals reach this mapping the same way
    // every other service failure does — through submitWork's result — so an
    // unmapped one is the same bug.
    'src/services/proposal-update.js',
  ]) {
    const text = read(src);
    for (const m of text.matchAll(/(?:fail|limitError)\(\s*'([a-z_]+)'/g)) emitted.add(m[1]);
    for (const m of text.matchAll(/\bcode:\s*'([a-z_]+)'/g)) emitted.add(m[1]);
  }
  assert.ok(emitted.size >= 10, `expected to scrape a real set of codes, got ${emitted.size}`);
  for (const code of emitted) {
    assert.ok(STATUS_BY_CODE[code], `${code} has no HTTP status in STATUS_BY_CODE`);
  }
  // And nothing mapped that no longer exists — a stale key is a claim the
  // route makes about the service that is not true any more.
  for (const code of Object.keys(STATUS_BY_CODE)) {
    assert.ok(emitted.has(code), `STATUS_BY_CODE maps '${code}', which nothing emits`);
  }
});

test('a service failure keeps its own wording and gets the right status', async () => {
  const cases = [
    ['github_not_linked', 409],
    ['at_capacity', 429],
    ['platform_unavailable', 503],
    ['import_failed', 502],
    ['unknown_task', 404],
    ['no_access', 403],
    ['not_a_real_code', 400],
  ];
  for (const [code, expected] of cases) {
    stub.prepare = { ok: false, code, message: `wording for ${code}`, retryable: true, settingsUrl: '/settings' };
    const r = await prepare({ agent: 'codex', brief: 'x' });
    assert.equal(r.status, expected, `${code} → ${expected}`);
    const j = await r.json();
    assert.equal(j.error, `wording for ${code}`, 'the service writes the copy, not the route');
    assert.equal(j.code, code, 'the code reaches the client, which branches on it');
    assert.equal(j.retryable, true);
    assert.equal(j.settingsUrl, '/settings');
  }
  // submitWork's failures go through the same mapping.
  stub.submit = { ok: false, code: 'no_commits', message: 'Push it first.' };
  assert.equal((await submit(4242)).status, 409);
});

// ── 6. Same-origin ──────────────────────────────────────────────────────

test('a cross-origin write is refused before the service is reached', async () => {
  for (const headers of [
    { origin: 'https://evil.example' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
  ]) {
    const p = await prepare({ agent: 'codex', brief: 'x' }, headers);
    assert.equal(p.status, 403, `prepare refuses ${JSON.stringify(headers)}`);
    const s = await submit(4242, {}, headers);
    assert.equal(s.status, 403, `submit refuses ${JSON.stringify(headers)}`);
    assert.equal(stub.prepareArgs, null, 'no rate-limit slot is spent');
    assert.equal(stub.submitArgs, null, 'no pull request is opened');
  }
});

test('the platform\'s own origin is allowed through', async () => {
  const ok = await prepare({ agent: 'codex', brief: 'x' }, { origin: ORIGIN, 'sec-fetch-site': 'same-origin' });
  assert.equal(ok.status, 200);
  assert.equal(stub.prepareArgs.agent, 'codex');
});

test('the read is not gated on origin', async () => {
  // Polling status is a plain authenticated GET; gating it would break the
  // "check again" button behind any browser that sends sec-fetch-site.
  const r = await fetch(`${base}/api/apps/recipe-box/dev-flow/status`, {
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(r.status, 200);
});

// ── 7. Wiring and staging ───────────────────────────────────────────────

test('the routes are mounted, and behind the global API auth gate', () => {
  const serverSrc = read('server.js');
  assert.match(serverSrc, /devFlowRoutes\b/);
  assert.match(serverSrc, /app\.use\(devFlowRoutes\(config\)\)/);
  const authIdx = serverSrc.indexOf('app.use(authMiddleware');
  const mountIdx = serverSrc.indexOf('app.use(devFlowRoutes(config))');
  assert.ok(authIdx > 0 && authIdx < mountIdx,
    'the /api/* auth middleware must be installed before these routes');
});

test('staging never reaches GitHub, and only shows fixtures when asked', () => {
  // The #555 convention: gated on USERNODE_ENV === 'staging' AND a
  // request-time ?demo=1, obviously fake, written nowhere. A staging clone
  // has no GitHub OAuth app, so without the fixture there is nothing to
  // review; with it, the walkthrough renders at its most interesting step.
  const src = read('src/routes/dev-flow.js');
  assert.match(src, /const IS_STAGING = process\.env\.USERNODE_ENV === 'staging'/);
  // Two fixtures now (#1071): ?demo=1 is the promoted-proposal update order,
  // ?demo=session the session continuation. Both are opt-in per request.
  assert.match(src, /req\.query\.demo === '1' \|\| req\.query\.demo === 'session'\s*\n?\s*\? demoStatus/,
    'the fixture is opt-in per request');
  assert.match(src, /req\.query\.demo === 'session' \? 'session' : 'proposal'/,
    'the demo payload picks its target kind from the query, not from a guess');
  // `?order=plain` narrows either payload to an ordinary work order. It is a
  // SECOND parameter rather than a third `demo` value on purpose — see the
  // round-trip test below, which is the one that would have caught shipping it
  // the other way.
  assert.match(src, /const orderKind = req\.query\.order === 'plain' \? null : demoKind;/);
  assert.match(src, /990501/, 'fixture ids stay in the obviously-fake 99xxxx range');
  // Every write is refused in staging: they would open a real pull request —
  // or, on the update path (#1054), force-push a real branch — against a real
  // repository from a preview clone.
  const prepareBlock = src.slice(src.indexOf("router.post('/api/apps/:slug/external-tasks'"));
  // Four since the discard route: it writes too — abandoning a work order in a
  // preview would put away a reservation that belongs to production.
  assert.equal((prepareBlock.match(/if \(IS_STAGING\) \{\s*\n\s*return res\.status\(503\)/g) || []).length, 4,
    'all four POSTs refuse in staging with a 503');
});

test('the client polls this route and nothing else', () => {
  const devChat = read('frontend/src/features/dev-chat/dev-chat.js');
  assert.match(devChat, /dev-flow\/status/, 'the walkthrough reads its state from the status route');
  assert.match(devChat, /external-tasks/, 'and prepares/submits through the same pair');
  // The renderer stays pure — see tests/dev-flow-select.test.js.
  assert.ok(!/\bfetch\s*\(/.test(read('public/js/dev-flow-select.js')),
    'public/js/dev-flow-select.js must not fetch; the dev chat owns the I/O');
});


// ── 5. Start over: putting a work order away (the stale-work-order fix) ──
//
// The walkthrough is resumable because the status route re-renders whatever
// open task the account holds for this app. Nothing sweeps that table, so
// without the two changes below a work order minted for something else — or
// finished outside this flow, which leaves the row `open` — answers for this
// app permanently: step 3 reads `done`, its brief field never renders, and the
// only button in reach copies the stale text.

const discard = (id, body, headers) => post(`/api/apps/recipe-box/external-tasks/${id}/discard`, body || {}, headers);

test('the walkthrough asks for an UNEXPIRED task, unlike submit recovery', async () => {
  await status('?sessionId=990404');
  assert.deepEqual(stub.loadOpts, { unexpiredOnly: true },
    'an expired reservation must stop answering for this session');

  // The service keeps the default OFF, because submitWork's slug+branch
  // recovery reads the same function and needs the expired row: it carries the
  // base commit mirrorForkBranch checks the pushed branch against.
  const svcSrc = read('src/services/external-agent-tasks.js');
  assert.match(svcSrc, /async function loadLatestOpenTaskForSlug\(pool, userId, slug, opts = \{\}\)/,
    'the filter is opt-in per caller, not a behaviour change for both');
  // Two call sites, each with its SQL written out in full, so both stay in
  // check-sql.js's static inventory and get Parse/Described against a real
  // planner. A spliced-in predicate — or a constant passed by name — would
  // drop this query into the hand-reviewed dynamic baseline instead.
  assert.match(svcSrc, /opts\.unexpiredOnly\s*\n?\s*\? await pool\.query\(/);
  // Scoped to THIS function. loadOpenTaskForSession writes its own four
  // literals for the same reason, so counting across the file would drift
  // every time another lookup is added and prove nothing about either.
  const appWide = svcSrc.slice(
    svcSrc.indexOf('async function loadLatestOpenTaskForSlug('),
    svcSrc.indexOf('// Scoped to the caller\'s own OPEN rows FOR THIS APP')
  );
  assert.ok(appWide.length > 0, 'the app-wide lookup is where this test thinks it is');
  assert.equal(
    (appWide.match(/AND t\.expires_at > NOW\(\)/g) || []).length, 1,
    'exactly one of its two literals filters expiry'
  );
  assert.equal((appWide.match(/await pool\.query\(/g) || []).length, 2,
    'and it is two whole literals, not one assembled at runtime');
});

test('the per-session lookup is a separate function, not a widened one', () => {
  // loadLatestOpenTaskForSlug must keep answering app-wide for submitWork's
  // slug+branch recovery: an agent that lost its task id knows the app and the
  // branch it pushed, and nothing about the browser session a human minted it
  // in. Session-scoping THAT would break recovery rather than fix the
  // launchpad, so the walkthrough gets its own lookup instead.
  const svcSrc = read('src/services/external-agent-tasks.js');
  assert.match(svcSrc, /async function loadOpenTaskForSession\(pool, userId, slug, sessionId, opts = \{\}\)/);
  assert.ok(!/async function loadLatestOpenTaskForSlug\([^)]*sessionId/.test(svcSrc),
    'the app-wide lookup never learns about sessions');

  const perSession = svcSrc.slice(
    svcSrc.indexOf('async function loadOpenTaskForSession('),
    svcSrc.indexOf('async function abandonTasksForSession(')
  );
  // Two literals: this session's task, with and without the expiry filter.
  // Both static, neither assembled. There is no third — the orphan scan that
  // used to follow them handed a new change somebody else's work order.
  assert.equal((perSession.match(/await pool\.query\(/g) || []).length, 2);
  assert.equal((perSession.match(/AND t\.origin_session_id = \$3/g) || []).length, 2);
  assert.ok(!/origin_session_id IS NULL/.test(perSession),
    'a session shows its own work order or none');
});

test('discard is authenticated, same-origin and digits-only', async () => {
  user = null;
  assert.equal((await discard(4242)).status, 401);
  assert.equal(stub.discardArgs, null, 'the service is never reached');

  user = { id: 42, username: 'tester', isAdmin: false };
  const crossSite = await discard(4242, {}, { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
  assert.equal(crossSite.status, 403, 'a cross-site POST is refused before the service');
  assert.equal(stub.discardArgs, null);

  // parseInt('1.5.2') is 1, which would put away a task nobody named.
  for (const bad of ['1.5.2', 'abc', '0', '-3']) {
    const r = await discard(bad, {}, { origin: ORIGIN, 'sec-fetch-site': 'same-origin' });
    assert.equal(r.status, 400, `'${bad}' is not a task id`);
  }
  assert.equal(stub.discardArgs, null);
});

test('discard closes the caller\'s task and reports the id it closed', async () => {
  const r = await discard(4242, {}, { origin: ORIGIN, 'sec-fetch-site': 'same-origin' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, taskId: 4242 });
  // Scoped to the caller: the user id comes from the session, never the body.
  // Scoped to the app in the URL as well as the caller: the slug is not
  // decorative, so a task under another app is not reachable through this one.
  assert.deepEqual(stub.discardArgs, { userId: 42, appId: 7, taskId: 4242 });
});

test('a task that is not open any more is unknown_task, not a silent success', async () => {
  stub.discard = null;
  const r = await discard(4242, {}, { origin: ORIGIN, 'sec-fetch-site': 'same-origin' });
  assert.equal(r.status, 404);
  assert.equal((await r.json()).code, 'unknown_task');
});

test('discard opens no pull request and touches no branch', () => {
  const src = read('src/routes/dev-flow.js');
  // To the next route's banner, not to submit-update's handler: its comment
  // block sits between the two and names submitWork, which would make this
  // assertion pass or fail on prose rather than on the route's body.
  const block = src.slice(
    src.indexOf("router.post('/api/apps/:slug/external-tasks/:id/discard'"),
    src.indexOf('// \u2500\u2500 Advance a proposal that is already up for a vote')
  );
  assert.ok(block.length > 0, 'the discard route is where this test thinks it is');
  for (const forbidden of ['pr-import', 'submitWork', 'mirrorForkBranch', 'prepareWork']) {
    assert.ok(!block.includes(forbidden),
      `discard must not reach ${forbidden} — abandoning a row is its whole effect`);
  }
});

test('the dev chat drives discard through that route and clears the brief', () => {
  const devChat = read('frontend/src/features/dev-chat/dev-chat.js');
  assert.match(devChat, /_devFlowDiscard/, 'the action has a handler');
  assert.match(devChat, /external-tasks\/\$\{encodeURIComponent\(task\.id\)\}\/discard/,
    'and it posts to the discard route with the task it is showing');
  // An empty box asking "what should it build?" is the point of the button; a
  // seeded one invites a second work order describing the same finished change.
  assert.match(devChat, /flow\.brief = '';/);
  // 404 means somebody else already closed it, which is the state the user was
  // reaching for — re-reading status is the right answer, not an error banner.
  assert.match(devChat, /res\.ok \|\| res\.status === 404/);
});


test('?order=plain renders an ordinary work order, which is the only kind you can start over from', () => {
  const src = read('src/routes/dev-flow.js');
  // Both older fixtures carry a target, so until this one existed no route
  // rendered the commonest case — and no screenshot could show "Start over",
  // which is withheld on a continuation.
  assert.match(src, /targetProposal: targetKind === null \? null :/);
  // Its prose has to agree with that: a body saying "UPDATING a proposal"
  // over a null target would be reviewing a state the real route cannot
  // produce.
  assert.match(src, /workOrder: \(targetKind === null/);
  assert.match(src, /press "Submit for review"/);
});


test('the plain fixture survives the round trip from page URL to status route', () => {
  // THE REGRESSION THIS TEST EXISTS FOR. The fixture discriminator is chosen in
  // the page URL and has to reach the status route through the client, which
  // forwards `demo` through an ALLOWLIST. Shipping the discriminator as a third
  // `demo` value passed every unit test in this file — the route was stubbed,
  // the renderer was called directly — and still rendered nothing in staging,
  // because _demoQS dropped the unrecognised value and the route fell through
  // to the venue sheet. Nothing here crossed that seam, so cross it: lift the
  // client's two query-string methods out of the real source and run them.
  const devChat = read('frontend/src/features/dev-chat/dev-chat.js');
  const lift = (name) => {
    const i = devChat.indexOf(`  ${name}() {`);
    assert.ok(i >= 0, `${name} exists on DevChat`);
    const end = devChat.indexOf('\n  },', i);
    assert.ok(end > i, `${name} is a plain method`);
    return devChat.slice(i, end + 5);
  };
  // The allowlist the forwarder reads comes across too — lifting the methods
  // without it is how this test first reported a false failure.
  const orders = /(DEV_FLOW_ORDERS: \[[^\]]*\],)/.exec(devChat);
  assert.ok(orders, 'the client declares the order values it forwards');
  // eslint-disable-next-line no-eval
  const client = eval(`({${orders[1]}\n${lift('_demoQS')}\n${lift('_devFlowDemoQS')}})`
    .replace(/DevChat\./g, 'this.'));

  // The route's own dispatch, read from the source rather than restated, so a
  // change on either side breaks this rather than drifting past it.
  const src = read('src/routes/dev-flow.js');
  assert.match(src, /const demoKind = req\.query\.demo === 'session' \? 'session' : 'proposal';/);
  assert.match(src, /const orderKind = req\.query\.order === 'plain' \? null : demoKind;/);
  assert.match(src, /req\.query\.demo === '1' \|\| req\.query\.demo === 'session'\s*\n?\s*\? demoStatus\(app, parsed, orderKind, noTask\)/);
  const route = (q) => (q.demo === '1' || q.demo === 'session'
    ? {
      fixture: true,
      targetKind: q.order === 'plain' ? null : (q.demo === 'session' ? 'session' : 'proposal'),
      noTask: q.order === 'none',
    }
    : { fixture: false });

  const roundTrip = (search) => {
    const prev = global.location;
    global.location = { search };
    try {
      const qs = client._devFlowDemoQS();
      return route(Object.fromEntries(new URLSearchParams(qs.replace(/^\?/, ''))));
    } finally {
      if (prev === undefined) delete global.location; else global.location = prev;
    }
  };

  // The plain fixture: reaches the route, and continues nothing — which is the
  // only shape "Start over" is offered on.
  assert.deepEqual(roundTrip('?demo=1&order=plain&flow=claude-code'),
    { fixture: true, targetKind: null, noTask: false });
  // And the no-work-order fixture, which shipped dropped on the floor exactly
  // as ?order=plain had one change earlier, because the forwarder tested for
  // one hardcoded value.
  assert.deepEqual(roundTrip('?demo=1&order=none&flow=claude-code'),
    { fixture: true, targetKind: 'proposal', noTask: true });
  // A value neither side knows is not forwarded at all.
  assert.deepEqual(roundTrip('?demo=1&order=bogus&flow=claude-code'),
    { fixture: true, targetKind: 'proposal', noTask: false });
  // The two that existed before are untouched.
  assert.deepEqual(roundTrip('?demo=1&flow=claude-code'),
    { fixture: true, targetKind: 'proposal', noTask: false });
  assert.deepEqual(roundTrip('?demo=session&flow=claude-code'),
    { fixture: true, targetKind: 'session', noTask: false });
  // `order` alone is not a fixture: it narrows one, it does not select one.
  assert.deepEqual(roundTrip('?order=plain&flow=claude-code'), { fixture: false });
  assert.deepEqual(roundTrip('?flow=claude-code'), { fixture: false });
  // And production, where every one of these is inert.
  assert.deepEqual(roundTrip(''), { fixture: false });

  // _demoQS itself must keep forwarding ONLY the two values every other
  // fixture route knows — /api/sessions/:id/status and /spec ride on it and
  // test `demo` for exactly '1', so widening it would blank the very session
  // this walkthrough renders inside.
  const prev = global.location;
  global.location = { search: '?demo=1&order=plain' };
  try {
    assert.equal(client._demoQS(), '?demo=1', '_demoQS never carries the order param');
  } finally {
    if (prev === undefined) delete global.location; else global.location = prev;
  }

  // Finally, the declared checks must satisfy BOTH gates.
  const dapp = JSON.parse(read('dapp.json'));
  const plain = dapp.tests.filter((t) => t.path.includes('order=plain'));
  assert.ok(plain.length >= 2, 'the plain fixture is covered by declared checks');
  for (const t of plain) {
    assert.ok(/[?&]demo=1(&|#|$)/.test(t.path),
      `${t.name} must carry ?demo=1 as well as order=plain, or no fixture renders`);
  }
});


test('a write that FAILS is a 500, not "Work order put away"', () => {
  // discardTask used to swallow database errors and return null, which the
  // route turned into 404 and the client treats as success — so a transient
  // pool error painted "Work order put away" over a write that never happened.
  // The service now throws, and nothing between here and the user flattens the
  // two answers back together.
  const svcSrc = read('src/services/external-agent-tasks.js');
  const fn = svcSrc.slice(
    svcSrc.indexOf('async function discardTask('),
    svcSrc.indexOf('async function abandonExpiredRequest(')
  );
  assert.ok(fn.length > 0, 'discardTask is where this test thinks it is');
  assert.ok(!/catch/.test(fn), 'discardTask does not swallow the failure');
});

test('...and the route turns that throw into a 500', async () => {
  stub.discardThrows = true;
  const r = await discard(4242, {}, { origin: ORIGIN, 'sec-fetch-site': 'same-origin' });
  assert.equal(r.status, 500);
  assert.notEqual((await r.json()).code, 'unknown_task',
    'a failure must not arrive wearing the "already closed" code the client treats as success');
});

test('the client posts to the discard route from the walkthrough it is showing', () => {
  // The assertion this file lost once already. A round-trip test that exercises
  // a helper proves the helper works; it does not prove anything CALLS it. The
  // demo-discriminator regression shipped through exactly that gap, so pin the
  // call sites themselves.
  const devChat = read('frontend/src/features/dev-chat/dev-chat.js');
  assert.match(devChat, /const fixtureQS = DevChat\._devFlowDemoQS\(\);/,
    'the status fetch builds from the dev-flow query string, not the bare _demoQS');
  assert.ok(!/dev-flow\/status\$\{DevChat\._demoQS\(\)\}/.test(devChat),
    'and never from the bare one, which would drop the order discriminator');
  assert.match(devChat, /if \(action === 'discard'\) return DevChat\._devFlowDiscard\(\);/,
    'the discard action is dispatched');
  assert.match(devChat, /external-tasks\/\$\{encodeURIComponent\(task\.id\)\}\/discard/,
    'and posts to the discard route with the task it is showing');
});


// ── Per-session work orders ─────────────────────────────────────────────
//
// One open work order used to answer for every session in the app, so "New
// change" opened a fresh session already showing an unrelated, often
// long-finished order. The walkthrough is keyed on the session now.

test('the walkthrough asks for THIS session\'s work order', async () => {
  await status('?sessionId=990404');
  assert.equal(stub.loadedVia, 'session', 'the session-scoped lookup is used');
  assert.equal(stub.loadedSessionId, 990404, 'and it is given the session from the query');
  assert.deepEqual(stub.loadOpts, { unexpiredOnly: true },
    'still without the expired reservations the previous change filtered out');
});

test('a caller that names no session degrades to the old app-wide lookup', async () => {
  // A browser running cached JS from before this change sends no sessionId.
  // Falling back to what it used to get is the honest failure mode; answering
  // "no work order" would make its launchpad look empty and invite a second
  // one to be minted for work already in flight.
  await status();
  assert.equal(stub.loadedVia, 'app');
  assert.deepEqual(stub.loadOpts, { unexpiredOnly: true });
});

test('a junk sessionId is not a session, and never reaches the lookup as one', async () => {
  for (const bad of ['abc', '0', '-3', '1.5', '9e9', '']) {
    await status(`?sessionId=${encodeURIComponent(bad)}`);
    assert.equal(stub.loadedVia, 'app', `'${bad}' is not a session id`);
  }
});

test('preparing a work order records the launchpad it was prepared in', async () => {
  const ok = await prepare(
    { agent: 'codex', brief: 'x', sessionId: 990404 },
    { origin: ORIGIN, 'sec-fetch-site': 'same-origin' }
  );
  assert.equal(ok.status, 200);
  assert.equal(stub.prepareArgs.originSessionId, 990404);

  // Absent or malformed is null, not a throw and not a guess: the connector
  // path has no session at all, and those rows are adopted rather than
  // stranded (see loadOpenTaskForSession).
  for (const bad of [undefined, null, 'abc', 0, -3, 1.5, { id: 4 }, ['4']]) {
    resetStubs();
    await prepare(
      { agent: 'codex', brief: 'x', sessionId: bad },
      { origin: ORIGIN, 'sec-fetch-site': 'same-origin' }
    );
    assert.equal(stub.prepareArgs.originSessionId, null, `${JSON.stringify(bad)} is not a session id`);
  }
});

test('the dev chat sends its session on both calls', () => {
  const devChat = read('frontend/src/features/dev-chat/dev-chat.js');
  assert.match(devChat, /sessionId=\$\{encodeURIComponent\(session\.id\)\}/,
    'the status read names the session it is rendering');
  assert.match(devChat, /\{ sessionId: Number\(DevChat\.currentSession\.id\) \}/,
    'and so does the prepare');

  // The separator matters: the fixture query string is '' in production and
  // `?demo=…` in a staging preview, so a bare '?' would produce a second one
  // and the route would see no demo at all.
  const build = (fixtureQS) => `/x${fixtureQS}${fixtureQS ? '&' : '?'}sessionId=7`;
  assert.equal(build(''), '/x?sessionId=7');
  assert.equal(build('?demo=1'), '/x?demo=1&sessionId=7');
  assert.match(devChat, /\$\{fixtureQS\}\$\{fixtureQS \? '&' : '\?'\}sessionId=/,
    'the client builds it that way too');
});

test('?order=none renders a launchpad with no work order at all', () => {
  const src = read('src/routes/dev-flow.js');
  assert.match(src, /const noTask = req\.query\.order === 'none';/);
  assert.match(src, /demoStatus\(app, parsed, orderKind, noTask\)/);
  // Both, or step 4 would be `current` with nothing to hand over.
  assert.match(src, /payload\.task = null;\s*\n\s*payload\.branch = null;/);
});


test('the client forwards EVERY order value the route reads', () => {
  // THE BUG THIS TEST EXISTS FOR, twice over. `?order=plain` shipped read by
  // the route and forwarded by nobody; the fix hardcoded === 'plain', so
  // `?order=none` shipped exactly the same way one change later. Both rendered
  // a launchpad that silently ignored the fixture it was asked for.
  //
  // So do not restate the list — scrape the ROUTE's own literals and hold the
  // client's allowlist to them. Adding a fixture shape to one side now fails
  // here rather than in a staging capture.
  const src = read('src/routes/dev-flow.js');
  const devChat = read('frontend/src/features/dev-chat/dev-chat.js');

  const readByRoute = [...src.matchAll(/req\.query\.order === '([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(readByRoute.length >= 2, `the route reads order values (found ${readByRoute.length})`);

  const declared = /DEV_FLOW_ORDERS: \[([^\]]*)\]/.exec(devChat);
  assert.ok(declared, 'the client declares the list it forwards');
  const forwarded = [...declared[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);

  for (const value of readByRoute) {
    assert.ok(forwarded.includes(value),
      `the route reads ?order=${value} but the client never forwards it, so that fixture renders nothing`);
  }
  // And nothing forwarded that the route ignores — a value the client appends
  // and the route drops is a URL that looks like it does something.
  for (const value of forwarded) {
    assert.ok(readByRoute.includes(value),
      `the client forwards ?order=${value} but the route reads no such value`);
  }

  // Every declared check that names one must use a value both ends agree on,
  // and carry the ?demo=1 that selects a fixture at all.
  const dapp = JSON.parse(read('dapp.json'));
  for (const t of dapp.tests) {
    const m = /[?&]order=([a-z-]+)/.exec(t.path);
    if (!m) continue;
    assert.ok(forwarded.includes(m[1]), `${t.name} shoots ?order=${m[1]}, which is not forwarded`);
    assert.ok(/[?&]demo=1(&|#|$)/.test(t.path), `${t.name} must carry ?demo=1 too, or no fixture renders`);
  }
});
