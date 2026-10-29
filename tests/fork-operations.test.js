'use strict';

// The fork flows' platform operations (services/fork-operations.js): the
// update-from-fork and share-in-progress routes and submit_work's new work
// ask a conductor for their code-host writes and answer exactly as they did
// when they made them in the web process.
//
//   1. The routes, end to end over HTTP, with the operation run here as a
//      conductor runs it (tests/lib/inline-operations.js): the same status
//      codes and bodies, the route's own refusals answered before anything
//      is asked, and the conductor's own (its authority read again, its
//      being unavailable, its failure) in the route's words.
//   2. What each operation reads again before any write, and what a
//      refused one gives back.
//   3. submit_work's writes on the conductor (openSubmission): a refusal
//      reaches the caller whole, and a retry after a stop neither writes the
//      head again nor opens a second pull request.
//   4. The machine's shape for each request, and the branch a discard may
//      remove.
//
// Run with: node --test tests/fork-operations.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const loggerId = require.resolve('../src/services/logger');
require.cache[loggerId] = {
  id: loggerId, filename: loggerId, loaded: true, paths: [],
  exports: { info() {}, debug() {}, warn() {}, error() {} },
};

// ── The world the routes and the operations read ──────────────────────

const APP = {
  id: 9, slug: 'demo', name: 'Demo', repo_url: 'https://github.com/acme/demo',
  collab_visibility: 'public', view_visibility: 'public',
};
const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);

let currentUser;
let state;
function reset() {
  currentUser = { id: 7, username: 'evan', isAdmin: false };
  state = {
    session: {
      id: 501, user_id: 7, app_id: APP.id, status: 'promoted', source: 'native',
      branch_name: 'dev/evan-1', pr_number: 42, app_slug: APP.slug, repo_url: APP.repo_url,
    },
    collab: true,
    join: null,
    cap: null,
    link: { linked: true, login: 'evan-gh' },
    // What the update answers, given what it was handed.
    update: async () => ({ ok: true, updated: true, proposalId: 501, headSha: NEW_HEAD, previousHeadSha: HEAD }),
    updates: [],
    sql: [],
    capChecks: 0,
    broadcasts: [],
  };
}
reset();

const poolMod = require('../src/db/pool');
const pool = {
  async query(sql, params = []) {
    const text = String(sql);
    state.sql.push({ text, params });
    if (/FROM chat_sessions cs JOIN apps a ON a\.id = cs\.app_id\s+WHERE cs\.id = \$1 AND cs\.app_id = \$2/.test(text)) {
      const s = state.session;
      return { rows: s && s.id === Number(params[0]) && s.app_id === Number(params[1]) ? [s] : [] };
    }
    if (/^SELECT \* FROM apps WHERE id = \$1$/.test(text.trim())) return { rows: Number(params[0]) === APP.id ? [APP] : [] };
    if (/INSERT INTO chat_sessions/.test(text)) {
      state.session = {
        id: 77, user_id: params[1], app_id: params[0], status: 'active', source: null,
        branch_name: params[2], app_slug: APP.slug, repo_url: APP.repo_url,
      };
      return { rows: [{ id: 77 }] };
    }
    return { rows: [], rowCount: 0 };
  },
};
poolMod.getPool = () => pool;

const appAccess = require('../src/services/app-access');
appAccess.getAppForUser = async (_pool, slug) => (slug === APP.slug && state.collab ? APP : null);
appAccess.checkAppAccess = async () => state.collab;
const communities = require('../src/services/communities');
communities.requireAppMembership = () => (_req, _res, next) => next();
communities.appNeedsJoin = async () => state.join;
const connectorLimits = require('../src/services/connector-limits');
connectorLimits.checkActiveCap = async () => { state.capChecks += 1; return state.cap; };
const github = require('../src/services/github');
github.isEnabled = () => true;
const githubLink = require('../src/services/github-link');
githubLink.isEnabled = () => true;
githubLink.linkStatus = async () => state.link;
const proposalUpdate = require('../src/services/proposal-update');
proposalUpdate.updateProposalFromForkBranch = async (deps, params) => {
  state.updates.push({ deps, params });
  return state.update(params);
};
require('../src/services/topic-attributes').selfAssignProposal = async () => true;
require('../src/services/ws').pushSessionUpdate = (d) => { state.broadcasts.push(d); };

const { inlineOperations } = require('./lib/inline-operations');
// One config for both roles, as one image runs them.
const operations = inlineOperations({
  pool: () => pool, user: () => currentUser, app: () => APP, config: { cliAuthOrigin: 'https://usernode.test' },
});
const forkOperations = require('../src/services/fork-operations');
const { proposalHandoffRoutes } = require('../src/routes/proposal-handoff');
const { changeHashPath } = require('../src/services/change-destination');

const express = require('express');
let server;
let base;
test.before(async () => {
  const app = express();
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(proposalHandoffRoutes({ cliAuthOrigin: 'https://usernode.test' }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());
test.beforeEach(() => reset());

async function post(p, body) {
  const res = await fetch(`${base}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
}
const update = (body, id = 501) => post(`/api/apps/demo/proposals/${id}/update-from-fork`, body);
const share = (body) => post('/api/apps/demo/work/share-in-progress', body);

// ── 1. update-from-fork ────────────────────────────────────────────────

test('an update is the conductor\'s, and answers what the update answered, plus where it is', async () => {
  const PATCH = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n';
  const res = await update({ patch: PATCH, expectedHeadSha: HEAD, title: 'Fix it', summary: 'It works now.', testingPaths: ['/x'] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, {
    ok: true, updated: true, proposalId: 501, headSha: NEW_HEAD, previousHeadSha: HEAD,
    webPath: changeHashPath('demo', 501),
  }, 'the update\'s own answer, with no operation bookkeeping in it');
  assert.equal(state.updates.length, 1);
  const [{ deps, params }] = state.updates;
  assert.ok(deps.steps, 'run with the work item\'s steps');
  assert.equal(params.patch, PATCH, 'the patch arrives as it was sent');
  assert.equal(params.expectedHeadSha, HEAD);
  assert.equal(params.title, 'Fix it');
  assert.equal(params.summary, 'It works now.');
  assert.equal(params.testing.testingPath, '/x', 'the capture routes as the route parsed them');
  assert.equal(params.user.id, 7, 'as the requester the conductor read again');
  assert.equal(params.session.id, 501);
  assert.equal(params.origin, 'https://usernode.test');
  assert.equal(operations.inputs.size, 0, 'and its input is dropped once it ran');
});

test('an update\'s refusal is answered in the update route\'s words', async () => {
  state.update = async () => ({
    ok: false, code: 'branch_moved', message: 'Somebody advanced it.', retryable: false, headSha: NEW_HEAD,
    detail: 'internal',
  });
  const res = await update({ branch: 'fix/x' });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'branch_moved', message: 'Somebody advanced it.', headSha: NEW_HEAD });
});

test('what the update checks before its lock is answered by the route, and nothing is asked', async () => {
  state.session = { ...state.session, user_id: 99 };
  const theirs = await update({ branch: 'fix/x' });
  assert.equal(theirs.status, 403);
  assert.equal(theirs.body.error, 'not_your_proposal');
  state.session = { ...state.session, user_id: 7 };
  state.link = { linked: false };
  const unlinked = await update({ branch: 'fix/x' });
  assert.equal(unlinked.status, 409);
  assert.equal(unlinked.body.error, 'github_not_linked');
  assert.equal(unlinked.body.settingsUrl, 'https://usernode.test/#settings/connectors');
  const shape = await update({ branch: 'fix/x', expectedHeadSha: 'not-a-sha' });
  assert.equal(shape.status, 400);
  const elsewhere = await update({ branch: 'fix/x' }, 502);
  assert.deepEqual(elsewhere, { ...elsewhere, status: 404, body: { error: 'not_found', message: 'That proposal is not on this app.' } });
  assert.equal(state.updates.length, 0, 'no conductor was asked');
});

test('the conductor reads the authority again: lost since the route checked, it refuses before any write', async () => {
  // The route reads collab access through getAppForUser (stubbed open); the
  // conductor through checkAppAccess, which is closed now.
  appAccess.checkAppAccess = async () => false;
  try {
    const res = await update({ branch: 'fix/x' });
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'App not found' });
    assert.equal(state.updates.length, 0);
  } finally {
    appAccess.checkAppAccess = async () => state.collab;
  }
  // And the ownership gate, read again on the conductor's own read of the row.
  const authorize = await forkOperations.authorize({ config: {}, pool }, {
    op: 'fork.update', appId: APP.id, userId: 8, input: { sessionId: 501 },
  }, { id: 8, username: 'someone' });
  assert.equal(authorize.status, 403);
  assert.equal(authorize.error, 'not_your_proposal');
});

test('no conductor, a conductor still working and a failed run are answered as before', async () => {
  operations.refuseNext();
  const unavailable = await update({ branch: 'fix/x' });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.code, 'operation_unavailable');
  state.update = async () => { throw new Error('connection reset by peer'); };
  const failed = await update({ branch: 'fix/x' });
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, { error: 'Internal server error' }, 'nothing internal leaks');
});

// ── 2. share-in-progress ───────────────────────────────────────────────

test('a share makes its session on the conductor, lands on it, and answers as before', async () => {
  const res = await share({ branch: 'my-branch', title: 'Dark mode', externalAgent: 'claude-code', summary: 'Half of it.' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.sessionId, 77);
  assert.equal(res.body.shared, true);
  assert.equal(res.body.webPath, changeHashPath('demo', 77));
  assert.equal(res.body.updated, true);
  assert.equal('requestId' in res.body, false);
  const insert = state.sql.find((q) => /INSERT INTO chat_sessions/.test(q.text));
  assert.ok(insert, 'the session is made');
  assert.match(insert.params[2], /^usernode\/from-u7-s[0-9a-f]{8}$/, 'on a branch of the platform\'s own');
  assert.equal(insert.params[3], 'Dark mode');
  assert.equal(insert.params[4], 'claude-code');
  const [{ params }] = state.updates;
  assert.equal(params.branch, 'my-branch', 'the fork branch travels to the landing');
  assert.equal(params.session.id, 77);
  assert.equal(params.summary, 'Half of it.');
  assert.equal('patch' in params, false, 'a share lands a fork branch, never a patch');
  assert.deepEqual(state.broadcasts, [{ action: 'shared', sessionId: 77, appId: APP.id, appSlug: APP.slug }]);
  assert.equal(state.capChecks, 2, 'the cap is read by the route and again by the conductor');
});

test('a share the landing refuses leaves no card, and says why in the update\'s words', async () => {
  state.update = async () => ({ ok: false, code: 'not_your_fork', message: 'Not your fork.', retryable: false });
  const res = await share({ branch: 'my-branch' });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'not_your_fork', message: 'Not your fork.' });
  const del = state.sql.find((q) => /DELETE FROM chat_sessions WHERE id = \$1 AND user_id = \$2/.test(q.text));
  assert.deepEqual(del && del.params, [77, 7]);
  assert.deepEqual(state.broadcasts, []);
});

test('a share is refused before a session is made: the cap at the route, the rest on the conductor too', async () => {
  state.cap = { code: 'not_decided', message: 'Not freed yet.' };
  const undecided = await share({ branch: 'my-branch' });
  assert.equal(undecided.status, 503);
  assert.equal(undecided.headers.get('retry-after') !== null, true);
  state.cap = null;
  state.join = { error: 'Join first.', code: 'join_required', app: { slug: 'demo', name: 'Demo' } };
  const join = await share({ branch: 'my-branch' });
  assert.equal(join.status, 403);
  assert.equal(join.body.code, 'join_required', 'the conductor reads membership again');
  state.join = null;
  state.link = { linked: false };
  const unlinked = await share({ branch: 'my-branch' });
  assert.equal(unlinked.status, 409);
  assert.equal(unlinked.body.error, 'github_not_linked');
  assert.ok(!state.sql.some((q) => /INSERT INTO chat_sessions/.test(q.text)), 'no card was made');
});

test('a share refused part way gives its session back, unless its commits landed', async () => {
  const deleted = [];
  const d = { pool: { query: async (sql, params) => { if (/DELETE FROM chat_sessions/.test(sql)) deleted.push(params); return { rows: [] }; } } };
  const request = { op: 'work.share', appId: APP.id, userId: 7, requestId: '00000000-0000-4000-8000-000000000001', input: {} };
  const kept = (data) => {
    const steps = require('../src/workflow/kernel/steps.ts').steps({ resumeFrom: data, checkpoint: async () => {} });
    return steps;
  };
  await forkOperations.abandon(d, request, kept({ session: 77 }));
  assert.deepEqual(deleted, [[77, 7]]);
  await forkOperations.abandon(d, request, kept({ session: 78, 'update/push': { ok: true } }));
  assert.deepEqual(deleted, [[77, 7]], 'a card its commits reached is the work, not litter');
  await forkOperations.abandon(d, request, kept({}));
  assert.deepEqual(deleted, [[77, 7]]);
});

test('the cap does not count a share\'s own session against it', async () => {
  const steps = require('../src/workflow/kernel/steps.ts').steps({ resumeFrom: { session: 77 }, checkpoint: async () => {} });
  state.cap = { code: 'at_capacity', message: 'Full.' };
  const own = await forkOperations.authorize({ config: {}, pool }, { op: 'work.share', appId: APP.id, userId: 7, input: {} },
    currentUser, { steps });
  assert.equal(own, null, 'its own slot is its claim, not a competitor');
  const fresh = await forkOperations.authorize({ config: {}, pool }, { op: 'work.share', appId: APP.id, userId: 7, input: {} },
    currentUser);
  assert.equal(fresh.status, 429);
});

// ── 3. submit_work's writes ────────────────────────────────────────────

const TASK = {
  id: 31, user_id: 7, app_id: APP.id, status: 'open', fork_owner: 'evan-gh', fork_repo: 'demo',
  branch_name: 'usernode/demo-issue-4-abc123', base_sha: HEAD, brief: 'Add dark mode',
  app_slug: APP.slug, app_name: APP.name, repo_url: APP.repo_url, session_id: null, target_session_id: null,
};
function taskPool(task = TASK) {
  return {
    async query(sql) {
      if (/FROM external_agent_tasks t JOIN apps a/.test(sql)) return { rows: task ? [task] : [] };
      if (/SELECT \* FROM apps WHERE id = \$1/.test(sql)) return { rows: [APP] };
      return { rows: [] };
    },
  };
}
const submitRequest = (input = {}) => ({
  op: 'work.submit', appId: APP.id, userId: 7, requestId: '00000000-0000-4000-8000-000000000002',
  input: { taskId: 31, mode: 'patch', branch: null, forkRepo: null, uploaded: false, ...input },
});

test('a submission reads the task, the project and the link again before it writes', async () => {
  const d = (task) => ({ config: {}, pool: taskPool(task) });
  assert.equal(await forkOperations.authorize(d(), submitRequest(), currentUser), null);
  assert.equal((await forkOperations.authorize(d(null), submitRequest(), currentUser)).code, 'unknown_task');
  assert.equal((await forkOperations.authorize(d({ ...TASK, target_session_id: 600 }), submitRequest(), currentUser)).code,
    'invalid_request', 'an update task is never new work');
  assert.equal((await forkOperations.authorize(d({ ...TASK, session_id: 77 }), submitRequest({ mode: 'branch' }), currentUser)).code,
    'already_shared');
  assert.equal(await forkOperations.authorize(d({ ...TASK, session_id: 77 }), submitRequest(), currentUser), null,
    'a patch onto shared work is still a submission, as before');
  state.collab = false;
  assert.deepEqual(await forkOperations.authorize(d(), submitRequest(), currentUser), { status: 404, error: 'App not found' });
  state.collab = true;
  state.join = { error: 'Join first.', code: 'join_required', app: { slug: 'demo', name: 'Demo' } };
  assert.equal((await forkOperations.authorize(d(), submitRequest(), currentUser)).code, 'join_required');
  state.join = null;
  state.link = { linked: false };
  assert.equal((await forkOperations.authorize(d(), submitRequest(), currentUser)).code, 'github_not_linked');
});

test('the web side words a conductor\'s refusal as its own, and a GitHub request id survives the trip', async () => {
  const svc = require('../src/services/external-agent-tasks');
  const answers = [];
  const prior = svc._setConductorForTests(async () => answers.shift());
  try {
    const submit = (ans) => {
      answers.push(ans);
      return svc.submitWork({
        pool: taskPool(), config: {},
        gh: { isEnabled: () => true, parseGithubUrl: () => ({ owner: 'acme', repo: 'demo' }) },
        githubLink: { isEnabled: () => true, linkStatus: async () => ({ linked: true, login: 'evan-gh' }) },
        limits: { checkPromotedCap: async () => null },
      }, { user: { id: 7 }, taskId: 31, importProposal: async () => ({ ok: true, body: { sessionId: 1 } }) });
    };
    const refused = await submit({
      ok: false, requestId: '00000000-0000-4000-8000-00000000000a',
      refused: { ok: false, code: 'pr_open_failed', message: 'GitHub refused it.', retryable: false, requestId: 'ABCD:1234' },
    });
    assert.deepEqual(refused, { ok: false, code: 'pr_open_failed', message: 'GitHub refused it.', retryable: false, requestId: 'ABCD:1234' });
    const join = await submit({ ok: false, status: 403, error: 'Join first.', code: 'join_required', app: { slug: 'demo' }, requestId: 'x' });
    assert.equal(join.code, 'join_required');
    assert.deepEqual(join.platformResult, { ok: false, status: 403, body: { error: 'Join first.', code: 'join_required', app: { slug: 'demo' } } },
      'handed back the way an import\'s refusal is');
    const pending = await submit({ ok: false, pending: true, status: 503, code: 'operation_pending', error: 'Still going.', requestId: 'y' });
    assert.equal(pending.code, 'platform_unavailable');
    assert.equal(pending.retryable, true);
    const gone = await submit({ ok: false, status: 500, error: 'boom', requestId: 'z' });
    assert.equal(gone.code, 'platform_unavailable');
    assert.doesNotMatch(gone.message, /boom/);
  } finally {
    svc._setConductorForTests(prior);
  }
});

test('a submission retried after a stop writes its head once and adopts the pull request it opened', async () => {
  const svc = require('../src/services/external-agent-tasks');
  const patchSvc = require('../src/services/external-agent-patch');
  const kernelSteps = require('../src/workflow/kernel/steps.ts');
  const realApply = patchSvc.applyPatch;
  const applied = [];
  patchSvc.applyPatch = async (args) => {
    applied.push(args);
    return { ok: true, branch: args.newBranch, headSha: NEW_HEAD, cleanup: async () => {} };
  };
  const host = new Map();
  const gh = {
    isEnabled: () => true,
    parseGithubUrl: () => ({ owner: 'acme', repo: 'demo' }),
    findOpenPrByBranch: async (_o, _r, branch) => host.get(branch) || null,
    createPR: async (_o, _r, { branch }) => {
      const pr = { number: 300 + host.size, html_url: 'https://github.com/acme/demo/pull/300', head: { sha: NEW_HEAD } };
      host.set(branch, pr);
      return pr;
    },
  };
  const store = {};
  const make = (stopAfterPr) => {
    const steps = kernelSteps.steps({ resumeFrom: store.saved || null, checkpoint: async (v) => { store.saved = v; } });
    if (!stopAfterPr) return steps;
    const crashing = Object.create(steps);
    // The pull request is opened on the host, then the process goes before
    // its step is kept.
    crashing.once = async (key, fn) => {
      if (key === 'pr') { await fn(); throw new kernelSteps.StepsStopped(); }
      return steps.once(key, fn);
    };
    return crashing;
  };
  const args = {
    user: { id: 7 }, task: TASK, link: null, mode: 'patch', patch: 'diff', title: 'Dark mode', body: 'It works.',
  };
  try {
    await assert.rejects(svc.openSubmission({ gh }, args, make(true)), (err) => err.stopped === true);
    assert.equal(applied.length, 1);
    assert.equal(host.size, 1, 'the first try opened the pull request');
    const again = await svc.openSubmission({ gh }, args, make(false));
    assert.equal(again.ok, true);
    assert.equal(applied.length, 1, 'the patch is not applied again');
    assert.equal(host.size, 1, 'and no second pull request is opened');
    assert.equal(again.pr.number, 300);
    assert.equal(again.via, 'patch');
    assert.match(again.platformBranch, /^usernode\/patch-u7-t31-[0-9a-f]{8}$/);
    assert.equal(applied[0].newBranch, again.platformBranch, 'the branch is the name the request kept');
    assert.ok(Number.isFinite(Date.parse(applied[0].commitDate)));
  } finally {
    patchSvc.applyPatch = realApply;
  }
});

// ── 4. The request's shape, and what a discard may remove ──────────────

test('the machine refuses a fork flow that does not name what it is for', () => {
  const { requested } = require('../src/workflow/platform-operation/machine.ts');
  const ok = (op, input, appId = 9) => requested({ op, requestId: '00000000-0000-4000-8000-000000000003', userId: 7, appId, input });
  assert.doesNotThrow(() => ok('fork.update', { sessionId: 501 }));
  assert.doesNotThrow(() => ok('work.share', {}));
  assert.doesNotThrow(() => ok('work.submit', { taskId: 31, mode: 'branch' }));
  assert.doesNotThrow(() => ok('work.discard', { taskId: 31, branch: 'usernode/patch-u7-t31-abcd0123' }));
  assert.throws(() => ok('fork.update', {}), /name its proposal/);
  assert.throws(() => ok('work.share', {}, null), /name its project/);
  assert.throws(() => ok('work.submit', { mode: 'patch' }), /name its task/);
  assert.throws(() => ok('work.submit', { taskId: 31, mode: 'pr' }), /what it carries/);
  assert.throws(() => ok('work.discard', { taskId: 31 }), /name its branch/);
});

test('a discard removes only a branch a submission of that very task wrote', async () => {
  const yes = (b) => forkOperations.taskBranch(TASK, 7, b);
  assert.equal(yes('usernode/patch-u7-t31-0a1b2c3d'), true);
  assert.equal(yes('usernode/from-evan-gh-t31-0a1b2c3d'), true);
  assert.equal(yes('usernode/patch-u8-t31-0a1b2c3d'), false, 'another account\'s');
  assert.equal(yes('usernode/patch-u7-t32-0a1b2c3d'), false, 'another task\'s');
  assert.equal(yes('usernode/from-mallory-t31-0a1b2c3d'), false, 'another fork owner\'s');
  assert.equal(yes('main'), false);
  assert.equal(yes('dev/evan-1'), false);
  assert.equal(yes('usernode/patch-u7-t31-0a1b2c3d/../main'), false);
  const refused = await forkOperations.authorize({ config: {}, pool: taskPool() },
    { op: 'work.discard', appId: APP.id, userId: 7, input: { taskId: 31, branch: 'main' } }, currentUser);
  assert.equal(refused.status, 400);
});

// ── The pushes themselves: made twice, they land once ──────────────────

function gitIn(dir, args) {
  const result = spawnSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout;
}

test('a plain-diff patch applied twice at the same date makes the same commit, and its second push is the first', async () => {
  const patchSvc = require('../src/services/external-agent-patch');
  const headSvc = require('../src/services/external-agent-head');
  const githubSvc = require('../src/services/github');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-ops-patch-'));
  const realRemote = headSvc.appRemote;
  const realToken = githubSvc.getInstallationToken;
  try {
    const work = path.join(root, 'work');
    const bare = path.join(root, 'app.git');
    fs.mkdirSync(work);
    gitIn(work, ['init', '-q']);
    fs.writeFileSync(path.join(work, 'README.md'), '# Demo\n');
    gitIn(work, ['add', '-A']);
    gitIn(work, ['commit', '-qm', 'Base']);
    const base = gitIn(work, ['rev-parse', 'HEAD']).trim();
    gitIn(root, ['clone', '--bare', '-q', work, bare]);
    fs.appendFileSync(path.join(work, 'README.md'), 'Dark mode.\n');
    const diff = gitIn(work, ['diff']);
    headSvc.appRemote = () => `file://${bare}`;
    githubSvc.getInstallationToken = async () => 'local-test-token';

    const commitDate = '2026-10-29T12:00:00.000Z';
    const fresh = { owner: 'acme', repo: 'demo', patch: diff, baseSha: base, userId: 7, taskId: 31, commitDate };
    const name = headSvc.patchBranchName(7, 31);
    const first = await patchSvc.applyPatch({ ...fresh, newBranch: name });
    assert.equal(first.ok, true, `${first.code}: ${first.message}`);
    assert.equal(first.branch, name);
    const second = await patchSvc.applyPatch({ ...fresh, newBranch: name });
    assert.equal(second.ok, true, `${second.code}: ${second.message}`);
    assert.equal(second.headSha, first.headSha, 'the same commit');
    assert.equal(gitIn(bare, ['rev-parse', `refs/heads/${name}`]).trim(), first.headSha);
    assert.equal(gitIn(bare, ['log', '--format=%cI', '-1', first.headSha]).trim().slice(0, 19), commitDate.slice(0, 19));

    // Onto a proposal's own branch under a lease at `base`: the second try
    // finds the branch already at its commit, which is its own push.
    gitIn(bare, ['branch', 'dev/evan-1', base]);
    const onto = { ...fresh, targetBranch: 'dev/evan-1', sessionId: 501 };
    const landed = await patchSvc.applyPatch(onto);
    assert.equal(landed.ok, true, `${landed.code}: ${landed.message}`);
    const retried = await patchSvc.applyPatch(onto);
    assert.equal(retried.ok, true, `${retried.code}: ${retried.message}`);
    assert.equal(retried.headSha, landed.headSha);
    assert.equal(gitIn(bare, ['rev-parse', 'refs/heads/dev/evan-1']).trim(), landed.headSha);

    // A different patch from the same base is still refused by the lease.
    fs.writeFileSync(path.join(work, 'NOTES.md'), 'Another change.\n');
    gitIn(work, ['add', 'NOTES.md']);
    const other = gitIn(work, ['diff', '--cached']);
    const moved = await patchSvc.applyPatch({ ...onto, patch: other });
    assert.equal(moved.code, 'branch_moved');
    // And a new branch name already holding another commit is not taken.
    const clash = await patchSvc.applyPatch({ ...fresh, patch: other, newBranch: name });
    assert.equal(clash.ok, false);
    assert.equal(gitIn(bare, ['rev-parse', `refs/heads/${name}`]).trim(), first.headSha, 'nothing was overwritten');
    const badName = await patchSvc.applyPatch({ ...fresh, newBranch: 'dev/not-ours' });
    assert.equal(badName.code, 'invalid_request');
  } finally {
    headSvc.appRemote = realRemote;
    githubSvc.getInstallationToken = realToken;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a push whose lease failed checks whether the branch already holds its commit', async () => {
  const headSvc = require('../src/services/external-agent-head');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-ops-holds-'));
  try {
    const work = path.join(root, 'work');
    const bare = path.join(root, 'app.git');
    fs.mkdirSync(work);
    gitIn(work, ['init', '-q']);
    fs.writeFileSync(path.join(work, 'a'), '1\n');
    gitIn(work, ['add', '-A']);
    gitIn(work, ['commit', '-qm', 'one']);
    const one = gitIn(work, ['rev-parse', 'HEAD']).trim();
    gitIn(root, ['clone', '--bare', '-q', work, bare]);
    gitIn(bare, ['branch', 'target', one]);
    await headSvc.withScratchRepo('holds', async ({ git }) => {
      await git(['fetch', '--depth', '1', `file://${bare}`, 'target']);
      assert.equal(await headSvc.remoteHolds(git, `file://${bare}`, 'target', null), true);
      assert.equal(await headSvc.remoteHolds(git, `file://${bare}`, 'missing', null), false);
      assert.equal(await headSvc.remoteHolds(git, `file://${root}/nowhere.git`, 'target', null), false, 'an unreadable remote answers no');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('a finished update retains its answer after input cleanup loses its reply', async () => {
  const { steps: makeSteps } = require('../src/workflow/kernel/steps.ts');
  let saved = null;
  let input = { branch: 'fix/x' };
  let loseReply = true;
  const d = { config: {}, pool: {
    async query(sql, args) {
      if (/SELECT payload FROM platform_operation_inputs/.test(sql)) return { rows: input ? [{ payload: input }] : [] };
      if (/DELETE FROM platform_operation_inputs/.test(sql)) {
        input = null;
        if (loseReply) { loseReply = false; throw new Error('connection lost after delete'); }
        return { rows: [] };
      }
      return pool.query(sql, args);
    },
  } };
  const request = { op: 'fork.update', appId: APP.id, userId: 7,
    requestId: '00000000-0000-4000-8000-000000000004', input: { sessionId: 501 } };
  const steps = () => makeSteps({ resumeFrom: saved, checkpoint: async (v) => { saved = structuredClone(v); } });
  await assert.rejects(forkOperations.run(d, request, currentUser, steps()), /connection lost/);
  assert.equal(input, null);
  // The target can close once the work finished. Replaying the answer makes no write.
  state.session.status = 'merged';
  assert.equal(await forkOperations.authorize(d, request, currentUser, { steps: steps() }), null);
  const answer = await forkOperations.run(d, request, currentUser, steps());
  assert.equal(answer.ok, true);
  assert.equal(answer.headSha, NEW_HEAD);
  assert.equal(state.updates.length, 1);
});

test('a share adopts an inserted session whose checkpoint was lost before checking the active cap', async () => {
  const { steps: makeSteps } = require('../src/workflow/kernel/steps.ts');
  const branch = 'usernode/from-u7-s1234abcd';
  const saved = makeSteps({ resumeFrom: { 'branch-name': branch }, checkpoint: async () => {} });
  state.cap = { code: 'at_capacity', message: 'Full.' };
  const d = { config: {}, pool: {
    query(sql, args) {
      if (/SELECT id FROM chat_sessions WHERE app_id/.test(sql)) {
        assert.deepEqual(args, [APP.id, 7, branch]);
        return Promise.resolve({ rows: [{ id: 77 }] });
      }
      return pool.query(sql, args);
    },
  } };
  const request = { op: 'work.share', appId: APP.id, userId: 7, input: {} };
  assert.equal(await forkOperations.authorize(d, request, currentUser, { steps: saved }), null);
  assert.equal(state.capChecks, 0);
  await forkOperations.abandon(d, request, saved);
  assert.ok(state.sql.some((q) => /DELETE FROM chat_sessions/.test(q.text) && q.params[0] === 77));
});

test('a submission adopts the task request after timeout or a lost web reply', async () => {
  const operations = require('../src/services/platform-operations');
  const broker = require('../src/services/work-submission-request');
  const real = operations.request;
  let kept = null;
  const calls = [];
  const db = {
    async query(sql, args) {
      if (/COALESCE\(submit_operation/.test(sql)) {
        kept ||= JSON.parse(args[3]);
        return { rows: [{ submit_operation: kept }] };
      }
      if (/submit_operation = NULL/.test(sql)) {
        assert.equal(args[2], kept.requestId);
        kept = null;
        return { rows: [] };
      }
      throw new Error('Unexpected SQL');
    },
  };
  const p = { op: 'work.submit', appId: 9, userId: 7, input: { taskId: 31, mode: 'patch' }, payload: { patch: 'eA==' } };
  let answer = { ok: false, pending: true, code: 'operation_pending' };
  operations.request = async (request) => { calls.push(request); return answer; };
  try {
    assert.equal((await broker.request(db, p)).pending, true);
    answer = { ok: true, pr: { number: 55 }, platformBranch: 'usernode/patch-u7-t31-1234abcd' };
    assert.deepEqual(await broker.request(db, { ...p, input: { taskId: 31, mode: 'branch', branch: 'other' } }), answer);
    assert.equal(calls[0].requestId, calls[1].requestId);
    assert.deepEqual(calls[1].input, p.input, 'the queued request retains its original control fields');
    operations.request = async () => { throw new Error('connection lost'); };
    await assert.rejects(broker.request(db, p), /connection lost/);
    assert.equal(kept.requestId, calls[0].requestId, 'unknown outcomes retain the recovery handle');
    operations.request = async () => ({ ok: false, status: 409, code: 'branch_moved' });
    await broker.request(db, p);
    assert.equal(kept, null, 'a definite refusal releases the task for corrected work');
  } finally {
    operations.request = real;
  }
});

test('submission cleanup preserves any proposal already using the generated branch', async (t) => {
  const head = require('../src/services/external-agent-head');
  let removals = 0;
  t.mock.method(head, 'removeBranch', async () => { removals++; return true; });
  const db = taskPool();
  const d = { pool: {
    query(sql, args) {
      if (/SELECT id FROM chat_sessions WHERE app_id/.test(sql)) return Promise.resolve({ rows: [{ id: 81 }] });
      return db.query(sql, args);
    },
  }, gh: { parseGithubUrl: () => ({ owner: 'acme', repo: 'demo' }) } };
  const result = await forkOperations.discardHere(d, {
    input: { taskId: 31, branch: 'usernode/patch-u7-t31-1234abcd' },
  }, currentUser);
  assert.equal(result.removed, false);
  assert.equal(removals, 0);
});

test('a completed task answer survives workflow receipt expiry', async (t) => {
  const operations = require('../src/services/platform-operations');
  const completed = { ok: true, pr: { number: 55 }, platformBranch: 'usernode/patch-u7-t31-1234abcd' };
  const db = { query: async () => ({ rows: [{ submit_operation: {
    requestId: '00000000-0000-4000-8000-000000000006', input: { taskId: 31, mode: 'patch' }, result: completed,
  } }] }) };
  t.mock.method(operations, 'request', async () => { throw new Error('an expired workflow must not run again'); });
  const answer = await require('../src/services/work-submission-request').request(db, {
    op: 'work.submit', appId: 9, userId: 7, input: { taskId: 31, mode: 'patch' }, payload: {},
  });
  assert.equal(answer.pr.number, 55);
  assert.equal(answer.platformBranch, completed.platformBranch);
});

test('a pull request whose create response is unknown is adopted before cleanup', async () => {
  const flows = require('../src/services/git-host-flows');
  let created = null;
  const host = {
    findOpenPrByBranch: async () => created,
    createPR: async () => { created = { number: 42 }; throw Object.assign(new Error('already exists after retry'), { code: 'pr_exists', status: 422 }); },
  };
  assert.deepEqual(await flows.openPr(host, 'apps','demo',{branch:'b'}), { number: 42 });
  host.findOpenPrByBranch = async () => { throw Object.assign(new Error('lookup failed'), { status: 503 }); };
  await assert.rejects(flows.openPr(host, 'apps','demo',{branch:'b'}), (err) => !flows.permanentPrRefusal(err));
});
