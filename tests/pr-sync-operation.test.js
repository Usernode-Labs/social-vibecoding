'use strict';

// `pr.sync` (src/services/pr-sync-operation.js): a change's pull-request
// metadata written to GitHub on a conductor, for the platform repository,
// whose credential a web process does not hold. The routes keep their
// database writes and their answers; the operation reads the row as it
// stands and makes the GitHub write. Run here as a conductor runs it
// (tests/lib/inline-operations.js); the machine against PostgreSQL, and a
// retried create that never opens a second pull request, are
// tests/pr-sync-operation-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolMod = require('../src/db/pool');
const state = { row: null, queries: [], user: null };
const PLATFORM = require('../src/services/repo-ref').platformRepoUrl();
const APP = { id: 3, slug: 'homeroom', collab_visibility: 'public', view_visibility: 'public', repo_url: PLATFORM };

function sessionRow(over = {}) {
  return {
    id: 412, app_id: 3, app_slug: 'homeroom', repo_url: PLATFORM, user_id: 7,
    status: 'active', is_headless: false, source: 'native', branch_name: 'dev/owner-change',
    pr_number: 41, pr_url: 'https://github.com/x/y/pull/41', pr_title: 'Old name',
    session_title: 'Old name', proposed_pr_title: null, shared_at: null,
    pr_body: 'Old summary\n\n## Technical details\nThe rest.',
    pr_summary_md: 'Old summary', pr_summary_previous_md: null, pr_summary_input_version: 4,
    pr_summary_source: 'generated', pr_summary_stale: true,
    linked_issues: [12], pr_linked_issues_applied: [12],
    ...over,
  };
}

const flat = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const pool = {
  query: async (sql, params = []) => {
    const text = flat(sql);
    state.queries.push(text);
    const row = state.row;
    if (/^SELECT a\.id, a\.collab_visibility/.test(text)) return { rows: [{ id: APP.id, collab_visibility: 'public', view_visibility: 'public' }] };
    if (/user_app_blocks/.test(text)) return { rows: [] };
    if (/^SELECT \* FROM apps WHERE id = \$1$/.test(text)) return { rows: params[0] === APP.id ? [APP] : [] };
    if (/^SELECT cs\.\*, a\.slug AS app_slug, a\.repo_url FROM chat_sessions cs JOIN apps a ON a\.id = cs\.app_id WHERE cs\.id = \$1$/.test(text)) {
      return { rows: row && row.id === params[0] ? [{ ...row }] : [] };
    }
    if (/WHERE cs\.id = \$1 AND cs\.user_id = \$2 AND cs\.is_headless = FALSE AND cs\.status IN/.test(text)) {
      return { rows: row && row.id === params[0] && row.user_id === params[1] && !row.is_headless
        && ['active', 'paused', 'promoted', 'merging'].includes(row.status) ? [{ ...row }] : [] };
    }
    if (/pr_summary_input_version = pr_summary_input_version \+ 1/.test(text)) {
      if (Number(row.pr_summary_input_version) !== params[4]) return { rows: [] };
      Object.assign(row, { pr_summary_previous_md: row.pr_summary_md, pr_summary_md: params[0], pr_summary_source: 'author',
        pr_summary_stale: false, pr_summary_input_version: Number(row.pr_summary_input_version) + 1, pr_summary_projection: JSON.parse(params[5]) });
      return { rows: [{ ...row }] };
    }
    if (/^UPDATE chat_sessions SET pr_body = \$1, pr_summary_source_body_hash = \$2 WHERE id = \$3$/.test(text)) { row.pr_body = params[0]; return { rows: [] }; }
    if (/^UPDATE chat_sessions SET pr_summary_projection = \$1::jsonb WHERE id = \$2$/.test(text)) { row.pr_summary_projection = JSON.parse(params[0]); return { rows: [] }; }
    if (/^UPDATE chat_sessions SET pr_body = \$1 WHERE id = \$2$/.test(text)) { row.pr_body = params[0]; return { rows: [] }; }
    if (/^UPDATE chat_sessions SET linked_issues = \$1 WHERE id = \$2$/.test(text)) { row.linked_issues = params[0]; return { rows: [] }; }
    if (/^UPDATE chat_sessions SET pr_linked_issues_applied = \$1 WHERE id = \$2$/.test(text)) { row.pr_linked_issues_applied = params[0]; return { rows: [] }; }
    if (/^UPDATE chat_sessions cs SET session_title = \$1::text/.test(text)) {
      if (!row || row.id !== params[1] || row.user_id !== params[2]) return { rows: [] };
      Object.assign(row, { session_title: params[0], proposed_pr_title: params[0], ...(row.pr_number ? { pr_title: params[0] } : {}) });
      return { rows: [{ ...row }] };
    }
    return { rows: [] };
  },
};
poolMod.getPool = () => pool;

const github = require('../src/services/github');
const ws = require('../src/services/ws');
const operations = require('../src/services/platform-operations');
const proposalUpdate = require('../src/services/proposal-update');
const prSync = require('../src/services/pr-sync-operation');
const { inlineOperations } = require('./lib/inline-operations');
const { sessionRoutes } = require('../src/routes/sessions');

const OWNER = { id: 7, username: 'owner', hasPlatformAccess: true };
const ADMIN = { id: 9, username: 'admin', isAdmin: true, canAdminWrite: true, hasPlatformAccess: true };

// The code host, and the order things happen in: a lock a holder takes
// again while it holds it is the deadlock a conductor would hit if the
// route still held the proposal's lock when it asked.
function setup(t, { user = OWNER, row = sessionRow() } = {}) {
  state.row = row; state.queries = []; state.user = user;
  const host = { body: row.pr_body, calls: [], order: [] };
  const held = new Set();
  t.mock.method(proposalUpdate, 'withProposalLock', async (_pool, id, fn) => {
    if (held.has(id)) throw new Error('the proposal lock was taken again by its holder');
    held.add(id); host.order.push('lock');
    try { return await fn(); } finally { held.delete(id); host.order.push('unlock'); }
  });
  t.mock.method(github, 'getPR', async (_o, _r, n) => { host.order.push('getPR'); return { number: n, body: host.body, state: 'open', merged: false }; });
  t.mock.method(github, 'updatePR', async (owner, repo, n, value) => {
    host.order.push('updatePR'); host.calls.push([owner, repo, n, value]);
    if (host.fail) throw new Error('GitHub is down');
    if (typeof value.body === 'string') host.body = value.body;
  });
  t.mock.method(ws, 'pushSessionUpdate', () => {});
  t.mock.method(ws, 'pushIssueUpdate', () => {});
  const restore = inlineOperations({ pool: () => pool, user: () => state.user, app: () => APP });
  t.after(restore);
  return { host, restore };
}

function server(t, user, { connector = false } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; if (connector) req.connectorClientId = 'chatgpt'; next(); });
  app.use(sessionRoutes({}));
  return new Promise((resolve) => {
    const s = app.listen(0, () => { t.after(() => s.close()); resolve(s); });
  });
}

async function patch(s, path, body) {
  const res = await fetch(`http://127.0.0.1:${s.address().port}/api/sessions/412/${path}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('a pull request write names its change and what it writes', () => {
  const { requested } = require('../src/workflow/platform-operation/machine.ts');
  const ok = { op: 'pr.sync', requestId: '00000000-0000-4000-8000-000000000001', appId: 3, userId: 7, input: { sessionId: 412, write: 'title' } };
  assert.deepEqual(requested(ok), ok);
  for (const write of prSync.WRITES) assert.equal(requested({ ...ok, input: { sessionId: 412, write } }).input.write, write);
  assert.throws(() => requested({ ...ok, input: { write: 'title' } }), /must name its change/);
  assert.throws(() => requested({ ...ok, input: { sessionId: 412, write: 'merge' } }), /must name its change and what it writes/);
});

test('only the platform repository on GitHub needs the conductor', () => {
  assert.equal(prSync.onConductor(PLATFORM), true);
  assert.equal(prSync.onConductor(PLATFORM.replace(/\/[^/]+$/, '/another-repo')), true, 'any repository of the acting owner');
  assert.equal(prSync.onConductor('https://github.com/acme/demo'), false, 'GitHub refuses any other owner before a request is sent');
  assert.equal(prSync.onConductor('not a url'), false);
  assert.equal(prSync.onConductor(null), false);
});

test('a description edit stores it, lets the lock go, and the conductor leads the body with it', async (t) => {
  const { host } = setup(t);
  const s = await server(t, OWNER);
  const out = await patch(s, 'description', { description: 'A clearer description', expectedVersion: 4 });
  assert.equal(out.status, 200);
  assert.equal(out.body.prBodyStatus, 'synced');
  assert.equal(out.body.version, 5);
  assert.equal(out.body.prBody, 'A clearer description\n\n## Technical details\nThe rest.');
  assert.equal(host.body, out.body.prBody, 'GitHub has the stored description');
  assert.deepEqual(host.order, ['lock', 'unlock', 'lock', 'getPR', 'updatePR', 'unlock'],
    'the route lets the lock go before the conductor takes it');
  assert.equal(state.row.pr_body, out.body.prBody, 'the body mirror follows');
});

test('a description edit no conductor takes is saved and said to be owed, as a GitHub failure was', async (t) => {
  const { host, restore } = setup(t);
  restore.refuseNext();
  const s = await server(t, OWNER);
  const out = await patch(s, 'description', { description: 'Saved anyway', expectedVersion: 4 });
  assert.equal(out.status, 200);
  assert.equal(out.body.description, 'Saved anyway');
  assert.equal(out.body.prBodyStatus, 'github_unavailable');
  assert.deepEqual(host.calls, []);
});

test('linked issues are stored by the route and projected into the body by the conductor', async (t) => {
  const { host } = setup(t);
  const s = await server(t, OWNER);
  const out = await patch(s, 'linked-issues', { addIssues: [27], removeIssues: [12] });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, {
    ok: true, proposalId: 412, appSlug: 'homeroom', linkedIssues: [27], addedIssues: [27], removedIssues: [12],
    changed: true, prBodyUpdated: true, prBodyStatus: 'updated',
  });
  assert.deepEqual(state.row.linked_issues, [27]);
  assert.match(host.body, /Closes #27/);
  assert.deepEqual(host.order, ['lock', 'unlock', 'lock', 'getPR', 'updatePR', 'unlock']);
  assert.deepEqual(state.row.pr_linked_issues_applied, [27]);
});

test('a browser admin repairs links through the conductor, which reads that it may', async (t) => {
  const { host } = setup(t, { user: ADMIN });
  const s = await server(t, ADMIN);
  const out = await patch(s, 'linked-issues', { addIssues: [30] });
  assert.equal(out.status, 200);
  assert.equal(out.body.prBodyStatus, 'updated');
  assert.match(host.body, /Closes #30/);
});

test('an imported pull request takes no projection, and nothing is asked of a conductor', async (t) => {
  const { host } = setup(t, { row: sessionRow({ source: 'imported', branch_name: 'feature/theirs' }) });
  let asked = 0;
  const prior = operations._setTransportForTests(async () => { asked += 1; return { status: 'refused', reason: 'x' }; });
  t.after(() => operations._setTransportForTests(prior));
  const s = await server(t, OWNER);
  const out = await patch(s, 'linked-issues', { addIssues: [27] });
  assert.equal(out.body.prBodyStatus, 'imported_pr');
  assert.equal(asked, 0);
  assert.deepEqual(host.calls, []);
});

test('a rename goes to GitHub from the stored title, and a failure there still answers the rename', async (t) => {
  const { host } = setup(t);
  const s = await server(t, OWNER);
  let out = await patch(s, 'title', { title: '  A  better name ' });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { ok: true, proposalId: 412, title: 'A better name', prTitle: 'A better name', githubUpdated: true });
  assert.deepEqual(host.calls.at(-1)[3], { title: 'A better name' });
  host.fail = true;
  out = await patch(s, 'title', { title: 'Another name' });
  assert.equal(out.status, 200);
  assert.equal(out.body.githubUpdated, false);
  assert.equal(state.row.pr_title, 'Another name');
});

test('the conductor reads each write\'s authority again', async (t) => {
  setup(t);
  const ask = (write, over = {}, input = {}) => ({ op: 'pr.sync', requestId: 'r', appId: 3, userId: 7, input: { sessionId: 412, write, ...input }, ...over });
  const other = { id: 8, username: 'other', canAdminWrite: false };
  const refused = async (request, user, row = sessionRow()) => { state.row = row; return prSync.authorize({ pool }, request, user); };
  assert.equal(await refused(ask('summary'), OWNER), null);
  assert.equal((await refused(ask('summary'), other))?.status, 404, 'not the owner');
  assert.equal((await refused(ask('summary'), OWNER, sessionRow({ status: 'merged' })))?.status, 404, 'settled since');
  assert.equal((await refused(ask('title'), OWNER, sessionRow({ source: 'imported' })))?.status, 404, 'an imported title is its author\'s');
  assert.equal((await refused(ask('title'), OWNER, sessionRow({ is_headless: true })))?.status, 404);
  assert.equal((await refused(ask('issues', {}, { admin: true }), other))?.status, 404, 'an admin flag needs a full admin');
  assert.equal(await refused(ask('issues', { userId: 9 }, { admin: true }), ADMIN), null);
  assert.equal((await refused(ask('summary', { appId: 4 }), OWNER))?.status, 404, 'another project\'s change');
  assert.equal(await refused(ask('create', {}, { from: 'staging' }), other, sessionRow({ pr_number: null, status: 'promoted' })), null,
    'any member may rebuild a change up for a vote');
  assert.equal((await refused(ask('create', {}, { from: 'staging' }), other, sessionRow({ pr_number: null })))?.status, 404);
  assert.equal((await refused(ask('create', {}, { from: 'clone' }), other, sessionRow({ pr_number: null, status: 'promoted' })))?.status, 404,
    'a clone is its owner\'s');
  await assert.rejects(refused(ask('create', {}, { from: 'elsewhere' }), OWNER), /Unknown pull request write/);
});

test('a Preview click on a web process records the missing pull request for a conductor, which opens it once', async (t) => {
  const { restore } = setup(t, { row: sessionRow({ pr_number: null, pr_url: null, pr_title: null }) });
  const role = process.env.PROCESS_ROLE; process.env.PROCESS_ROLE = 'web';
  t.after(() => { if (role === undefined) delete process.env.PROCESS_ROLE; else process.env.PROCESS_ROLE = role; });
  const prMetadata = require('../src/services/pr-metadata');
  const opened = [];
  t.mock.method(github, 'hasApp', () => true);
  t.mock.method(github, 'getReadOctokit', async () => ({ rest: { repos: { compareCommits: async () => ({ data: { ahead_by: 1, commits: [{ sha: 'c'.repeat(40) }] } }) } } }));
  t.mock.method(github, 'findOpenPrByBranch', async () => null);
  t.mock.method(prMetadata, 'applyPrMetadata', async (args) => {
    opened.push({ role: process.env.PROCESS_ROLE, ...args });
    Object.assign(args.session, { pr_number: 88, pr_url: 'https://github.com/x/y/pull/88' });
    Object.assign(state.row, { pr_number: 88, pr_url: 'https://github.com/x/y/pull/88' });
    return { prNumber: 88 };
  });
  t.mock.method(require('../src/services/limits'), 'resolveBillingPath', async () => ({ error: 'no credit' }));
  const workflow = require('../src/services/preview-workflow');
  t.mock.method(workflow, 'working', async () => false);
  t.mock.method(workflow, 'held', async () => false);
  t.mock.method(workflow, 'request', async () => ({ taken: true }));
  const { rebuildSessionStaging } = require('../src/services/staging-recovery');

  assert.equal(await rebuildSessionStaging({ config: {}, pool, session: { ...state.row }, reason: 'preview-click', requesterId: 7 }), 'handed_off');
  assert.equal(opened.length, 0, 'the web process opens nothing');
  assert.deepEqual(restore.queued.map((q) => [q.op, q.userId, q.input]), [['pr.sync', 7, { sessionId: 412, write: 'create', from: 'staging' }]]);
  process.env.PROCESS_ROLE = 'conductor';
  const [result] = await restore.drain();
  assert.deepEqual(result, { ok: true, prNumber: 88, prUrl: 'https://github.com/x/y/pull/88', created: true });
  assert.equal(opened.length, 1);
  assert.equal(opened[0].role, 'conductor');
  assert.equal(opened[0].allowModelGeneration, false, 'no credit: the deterministic draft');
  assert.equal(opened[0].userId, 7, 'billed to the change\'s owner');
  // Asked again (a second click), the change has its pull request.
  process.env.PROCESS_ROLE = 'web';
  await prSync.append(pool, { appId: 3, userId: 7, sessionId: 412, write: 'create', from: 'staging' });
  process.env.PROCESS_ROLE = 'conductor';
  assert.deepEqual(await restore.drain(), [{ ok: true, prNumber: 88, prUrl: 'https://github.com/x/y/pull/88', created: false }]);
  assert.equal(opened.length, 1, 'never opened twice');
});

test('a pull request already open for the branch is adopted, not opened again', async (t) => {
  const { restore } = setup(t, { row: sessionRow({ pr_number: null, pr_url: null, pr_title: null }) });
  const prMetadata = require('../src/services/pr-metadata');
  const seen = [];
  t.mock.method(github, 'findOpenPrByBranch', async () => ({ number: 90, html_url: 'https://github.com/x/y/pull/90', title: 'Made before', body: 'b' }));
  t.mock.method(prMetadata, 'applyPrMetadata', async ({ session }) => { seen.push(session.pr_number); return { prNumber: session.pr_number }; });
  await prSync.append(pool, { appId: 3, userId: 7, sessionId: 412, write: 'create', from: 'clone' });
  const [result] = await restore.drain();
  assert.equal(result.prNumber, 90);
  assert.deepEqual(seen, [90], 'applyPrMetadata updates the adopted one instead of creating');
  assert.ok(state.queries.some((q) => /^UPDATE chat_sessions SET pr_number = \$1, pr_url = \$2/.test(q)), 'its number recorded on the row');
});

test('a branch with nothing on it is an answer; a host that opened nothing is tried again', async (t) => {
  const { restore } = setup(t, { row: sessionRow({ pr_number: null }) });
  const prMetadata = require('../src/services/pr-metadata');
  t.mock.method(github, 'findOpenPrByBranch', async () => null);
  let answer = () => { throw Object.assign(new Error('No commits between main and dev/owner-change'), { code: 'no_commits' }); };
  t.mock.method(prMetadata, 'applyPrMetadata', async () => answer());
  await prSync.append(pool, { appId: 3, userId: 7, sessionId: 412, write: 'create', from: 'clone' });
  assert.deepEqual((await restore.drain())[0], { ok: false, status: 409, code: 'no_commits', error: 'No commits between main and dev/owner-change' });
  answer = () => null;
  await prSync.append(pool, { appId: 3, userId: 7, sessionId: 412, write: 'create', from: 'clone' });
  await assert.rejects(restore.drain(), /was not opened/, 'thrown, so the machine tries it again');
});


test('a delayed issue removal leaves a link that the current row has added back', async (t) => {
  const { host } = setup(t);
  host.body += '\n\nCloses #12';
  const before = host.body;
  const result = await prSync.run({ pool }, {
    op: 'pr.sync', appId: 3, userId: 7,
    input: { sessionId: 412, write: 'issues', removeIssues: [12] },
  }, OWNER);
  assert.equal(result.prBodyStatus, 'already_current');
  assert.equal(host.body, before);
  assert.match(host.body, /Closes #12/);
  assert.deepEqual(state.row.pr_linked_issues_applied, [12]);
});


test('overlapping description edits replace the last host summary once', async (t) => {
  const { host } = setup(t);
  const originalBody = host.body;
  // Both author edits are saved while their conductor requests are delayed.
  const prior = operations._setTransportForTests(async () => ({ status: 'refused', reason: 'operation_unavailable' }));
  t.after(() => operations._setTransportForTests(prior));
  const edit = require('../src/services/proposal-description-edit').edit;
  await edit({ pool, sessionId: 412, userId: 7, input: { description: 'Edit A', expectedVersion: state.row.pr_summary_input_version } });
  await edit({ pool, sessionId: 412, userId: 7, input: { description: 'Edit B', expectedVersion: state.row.pr_summary_input_version } });
  const result = await prSync.run({ pool }, { op: 'pr.sync', input: { sessionId: 412, write: 'summary' } }, OWNER);
  assert.equal(result.prBodyStatus, 'synced');
  assert.equal(host.body, originalBody.replace('Old summary', 'Edit B'));
  assert.deepEqual(state.row.pr_summary_projection, { applied: 'Edit B' });
});

test('a newer description finishes an uncertain earlier host write before replacing it', async (t) => {
  const { host } = setup(t);
  const originalBody = host.body;
  Object.assign(state.row, { pr_summary_md: 'Edit B', pr_summary_projection: { applied: 'Old summary' } });
  const query = pool.query;
  let loseApplied = true;
  t.mock.method(pool, 'query', async (sql, args) => {
    if (loseApplied && /SET pr_summary_projection =/.test(sql) && !JSON.parse(args[0]).pending) {
      loseApplied = false; throw new Error('connection lost before applied record');
    }
    return query(sql, args);
  });
  const request = { op: 'pr.sync', input: { sessionId: 412, write: 'summary' } };
  assert.equal((await prSync.run({ pool }, request, OWNER)).prBodyStatus, 'github_mirror_failed');
  assert.match(host.body, /^Edit B/);
  state.row.pr_summary_md = 'Edit C';
  const result = await prSync.run({ pool }, request, OWNER);
  assert.equal(result.prBodyStatus, 'synced');
  assert.equal(host.body, originalBody.replace('Old summary', 'Edit C'));
});


test('a synchronous summary update supersedes an uncertain asynchronous projection', async (t) => {
  const { host } = setup(t);
  Object.assign(state.row, { pr_summary_md: 'Edit B', pr_summary_previous_md: 'Edit A',
    pr_summary_projection: { applied: 'Old summary', pending: { from: 'Old summary', to: 'Edit A' } } });
  host.body = host.body.replace('Old summary', 'Edit A');
  const rejected = await proposalUpdate.syncSummaryIntoBody({
    pool, gh: github, owner: 'Usernode-Labs', repo: 'social-vibecoding', session: state.row,
    summary: 'Edit B', previousSummary: 'Edit A',
  });
  assert.equal(rejected, null);
  const body = host.body;
  assert.equal((await prSync.run({ pool }, { op: 'pr.sync', input: { sessionId: 412, write: 'summary' } }, OWNER)).prBodyStatus, 'synced');
  assert.equal(host.body, body);
  assert.equal((host.body.match(/Edit B/g) || []).length, 1);
});


test('a full description replacement accepts its accompanying summary after a lost mirror reply', async (t) => {
  const { host } = setup(t);
  Object.assign(state.row, { pr_summary_md: 'New author summary', pr_summary_projection: { applied: 'Old summary' } });
  const query = pool.query;
  let loseMirror = true;
  t.mock.method(pool, 'query', async (sql, args) => {
    if (loseMirror && /^UPDATE chat_sessions SET pr_body =/.test(sql)) { loseMirror = false; throw new Error('lost body mirror reply'); }
    return query(sql, args);
  });
  const replaced = await proposalUpdate.applyProposedDescription({
    pool, gh: github, session: state.row, owner: 'Usernode-Labs', repo: 'social-vibecoding',
    description: 'Replacement technical description', viewerLogin: null,
  });
  assert.equal(replaced.changed, true);
  assert.equal(host.body, 'Replacement technical description');
  const result = await prSync.run({ pool }, { op: 'pr.sync', input: { sessionId: 412, write: 'summary' } }, OWNER);
  assert.equal(result.prBodyStatus, 'synced');
  assert.equal(host.body, 'New author summary\n\nReplacement technical description');
});


test('a summary write refused before applying can retry over a body without a prefix', async (t) => {
  const { host } = setup(t);
  host.body = 'Replacement technical description';
  host.fail = true;
  Object.assign(state.row, { pr_body: host.body, pr_summary_md: 'New author summary', pr_summary_projection: { applied: null } });
  const request = { op: 'pr.sync', input: { sessionId: 412, write: 'summary' } };
  assert.equal((await prSync.run({ pool }, request, OWNER)).prBodyStatus, 'github_write_failed');
  host.fail = false;
  assert.equal((await prSync.run({ pool }, request, OWNER)).prBodyStatus, 'synced');
  assert.equal(host.body, 'New author summary\n\nReplacement technical description');
});
