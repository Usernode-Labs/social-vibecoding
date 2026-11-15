// What Homeroom knows of a person's own coding agent on a project (#1049).
//
// A person can hand a request to the coding agent they already pay for
// (Claude Code or Codex), which mints its own work order through the
// connector (prepare_work), pushes a branch to their fork and submits it
// (submit_work); tests/external-agent-tasks.test.js covers that service. The
// browser's half is one read, GET /api/apps/:slug/dev-flow/status
// (src/routes/dev-flow.js), which the request page's "own agent" link reads
// (frontend/src/features/dev-board/topic/handoff-status.ts). The dev chat's
// walkthrough, and the prepare, submit and discard routes it drove, are
// retired with the dev chat. What this file pins:
//
//   1. The status read answers every step in one request, and degrades a
//      step at a time. A missing repository, a GitHub App that is off, an
//      unlinked account and a branch read that throws each produce a
//      renderable payload, never a 500 and never a half-answer.
//   2. An open work order is re-rendered from its stored values, and an
//      expired one stops answering.
//   3. Every failure code the service layer can emit has an HTTP status in
//      STATUS_BY_CODE, which the connector's routes and services still read.
//      This is scraped from the service sources, so a new code in
//      external-agent-tasks.js fails here instead of silently answering 400.
//   4. The wiring: behind the global API auth gate, never gated on origin,
//      and never reaching GitHub from a staging preview.
//
// Run with: node --test tests/dev-flow-routes.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// The scripts under test read their text from the language runtime's
// global; give them the real English one.
globalThis.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
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
    // The row an open update work order continues (#1071).
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
    target: null,
    targetThrows: false,
    loadOpts: null,
  };
}

// The row an open update work order continues (#1071), as the status route
// reloads it. Native and owned by the caller unless a test says otherwise.
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
  return stub.task;
};
svc.inspectPushedBranch = async () => {
  if (stub.branchThrows) throw new Error('github said no');
  return stub.branchState;
};

const { devFlowRoutes, STATUS_BY_CODE, shapeBranch } = require('../src/routes/dev-flow');

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

test('the status read is 401 without a session', async () => {
  user = null;
  assert.equal((await status()).status, 401);
});

test('an app the user cannot collaborate on is a 404', async () => {
  stub.app = null;
  assert.equal((await status()).status, 404);
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

// ── 3. Failure mapping ──────────────────────────────────────────────────

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

// ── 4. Wiring and staging ───────────────────────────────────────────────

test('the read is not gated on origin', async () => {
  // Polling status is a plain authenticated GET; gating it would break the
  // "check again" button behind any browser that sends sec-fetch-site.
  const r = await fetch(`${base}/api/apps/recipe-box/dev-flow/status`, {
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(r.status, 200);
});

test('the routes are mounted, and behind the global API auth gate', () => {
  const serverSrc = read('server.js');
  assert.match(serverSrc, /devFlowRoutes\b/);
  assert.match(serverSrc, /app\.use\(devFlowRoutes\(config\)\)/);
  const authIdx = serverSrc.indexOf('app.use(authMiddleware');
  const mountIdx = serverSrc.indexOf('app.use(devFlowRoutes(config))');
  assert.ok(authIdx > 0 && authIdx < mountIdx,
    'the /api/* auth middleware must be installed before these routes');
});

test('staging never reaches GitHub: it answers the first-time state and writes nothing', () => {
  // The #555 convention: obviously fake, written nowhere. A staging clone
  // has no GitHub OAuth app, so the read answers the state a first-time user
  // meets (nothing linked, no connector, no fork, no work order) before any
  // GitHub or link read.
  const src = read('src/routes/dev-flow.js');
  assert.match(src, /const IS_STAGING = process\.env\.USERNODE_ENV === 'staging'/);
  const route = src.slice(src.indexOf("router.get('/api/apps/:slug/dev-flow/status'"));
  const staged = route.indexOf('if (IS_STAGING) {');
  assert.ok(staged > 0, 'the status read has a staging branch');
  for (const read of ['githubLink.linkStatus(', 'externalAgentTasks.inspectFork(', 'externalAgentTasks.loadLatestOpenTaskForSlug(']) {
    assert.ok(route.indexOf(read) > staged, `${read} is never reached in staging`);
  }
  const branch = route.slice(staged, route.indexOf('\n      }', staged));
  assert.match(branch, /demo: true,/);
  assert.match(branch, /github: \{ linked: false, login: null, available: true \},/);
  assert.match(branch, /connectors: \{ count: 0 \},\s*fork: null,\s*task: null,\s*branch: null,/);
  // And the route writes nothing at all: no POST is mounted here.
  assert.doesNotMatch(src, /router\.(post|put|patch|delete)\(/);
});

test('the request page\'s own agent link reads this route, and nothing else', () => {
  const client = read('frontend/src/features/dev-board/topic/handoff-status.ts');
  assert.match(client, /fetch\(`\/api\/apps\/\$\{encodeURIComponent\(slug\)\}\/dev-flow\/status`, \{/);
  assert.match(client, /credentials: 'same-origin',/);
  assert.doesNotMatch(client, /external-tasks/, 'it prepares and submits nothing');
});

test('the walkthrough asks for an UNEXPIRED task, unlike submit recovery', async () => {
  await status();
  assert.deepEqual(stub.loadOpts, { unexpiredOnly: true },
    'an expired reservation must stop answering for this app');

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
