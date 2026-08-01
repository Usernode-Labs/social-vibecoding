// Tests for POST /api/apps/:slug/visibility-pr (issue #124) — the
// vote-gated dapp.json proposal that replaced the instant
// PATCH /api/apps/:slug/visibility — plus a regression check that the
// createManifestPR refactor kept createRenamePR's artifact shape.
//
// Exercises the route end-to-end (express + mocked pool + stubbed
// GitHub service), mirroring tests/github-issues-route.test.js.
//
// Run with: node --test tests/visibility-pr-route.test.js

const { test } = require('node:test');
const assert = require('node:assert');

// Override the pool BEFORE requiring the route module: apps.js
// destructures getPool at require time. The pool delegates to a
// swappable handler so individual tests can answer specific SQL shapes
// (default: empty result for everything).
const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
poolMod.getPool = () => ({ query: (sql, params) => poolQueryHandler(sql, params) });

// Stub the GitHub service: enabled, with recordable branch/push/PR calls.
const github = require('../src/services/github');
let ghCalls;
let ghEnabled = true;
let ghManifestOnMain = JSON.stringify({ name: 'Demo', secrets: [{ key: 'FOO_KEY', description: 'x' }] });
github.isEnabled = () => ghEnabled;
github.getFileContent = async () => ghManifestOnMain;
github.createBranch = async (owner, repo, branch) => { ghCalls.push({ op: 'branch', branch }); };
github.pushFiles = async (owner, repo, files, opts) => { ghCalls.push({ op: 'push', files, opts }); };
github.createPR = async (owner, repo, { branch, title, body }) => {
  ghCalls.push({ op: 'pr', branch, title, body });
  return { number: 555, html_url: 'https://github.com/o/r/pull/555' };
};

process.env.GITHUB_BOT_TOKEN = process.env.GITHUB_BOT_TOKEN || 'test-token';

const { appRoutes } = require('../src/routes/apps');
const express = require('express');

const APP_ROW = {
  id: 11,
  slug: 'demo',
  name: 'Demo',
  created_by: 1,
  self_hosted: false,
  repo_url: 'https://github.com/o/r',
  collab_visibility: 'public',
  view_visibility: 'public',
};

let currentUser = { id: 1, username: 'creator', isAdmin: false };
let appRow;
let openVisibilitySession;

function defaultHandler() {
  return async (sql, params) => {
    if (/SELECT \* FROM apps WHERE slug = \$1/.test(sql)) {
      return { rows: appRow ? [appRow] : [] };
    }
    if (/branch_name LIKE 'visibility\/%'/.test(sql)) {
      return { rows: openVisibilitySession ? [openVisibilitySession] : [] };
    }
    if (/INSERT INTO chat_sessions/.test(sql)) {
      return { rows: [{ id: 4242 }] };
    }
    if (/COUNT\(DISTINCT a\.user_id\) AS cnt/.test(sql)) {
      return { rows: [{ cnt: '3' }] };
    }
    return { rows: [] };
  };
}

let server;
let base;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use(appRoutes({ jwtSecret: 'test' }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

test.beforeEach(() => {
  ghCalls = [];
  ghEnabled = true;
  appRow = { ...APP_ROW };
  openVisibilitySession = null;
  currentUser = { id: 1, username: 'creator', isAdmin: false };
  poolQueryHandler = defaultHandler();
});

function propose(body) {
  return fetch(`${base}/api/apps/demo/visibility-pr`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('invalid combos are rejected with 400', async () => {
  let res = await propose({ collabVisibility: 'open', viewVisibility: 'public' });
  assert.equal(res.status, 400);
  res = await propose({ collabVisibility: 'public', viewVisibility: 'private' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /cannot be private to view/);
});

test('non-creator non-admin gets 403', async () => {
  currentUser = { id: 99, username: 'rando', isAdmin: false };
  const res = await propose({ collabVisibility: 'private', viewVisibility: 'public' });
  assert.equal(res.status, 403);
});

test('same-as-current visibility is a 400', async () => {
  const res = await propose({ collabVisibility: 'public', viewVisibility: 'public' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /already has that visibility/);
});

test('GitHub disabled means 503', async () => {
  ghEnabled = false;
  const res = await propose({ collabVisibility: 'private', viewVisibility: 'public' });
  assert.equal(res.status, 503);
});

test('no repo_url means 400', async () => {
  appRow.repo_url = null;
  const res = await propose({ collabVisibility: 'private', viewVisibility: 'public' });
  assert.equal(res.status, 400);
});

test('an open visibility PR dedupes to 409 with a pointer at it', async () => {
  openVisibilitySession = { id: 77, pr_number: 321, pr_url: 'https://github.com/o/r/pull/321' };
  const res = await propose({ collabVisibility: 'private', viewVisibility: 'public' });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.sessionId, 77);
  assert.equal(body.prNumber, 321);
});

test('success: opens a visibility/ branch PR editing dapp.json and promotes a session', async () => {
  const res = await propose({ collabVisibility: 'private', viewVisibility: 'public' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.sessionId, 4242);
  assert.equal(body.prNumber, 555);

  const branchCall = ghCalls.find((c) => c.op === 'branch');
  assert.match(branchCall.branch, /^visibility\/demo-\d+$/);

  const push = ghCalls.find((c) => c.op === 'push');
  assert.equal(push.files[0].path, 'dapp.json');
  const written = JSON.parse(push.files[0].content);
  // Existing manifest fields are preserved; only the block is added.
  assert.equal(written.name, 'Demo');
  assert.equal(written.secrets[0].key, 'FOO_KEY');
  assert.deepEqual(written.visibility, { build: 'private', view: 'public' });

  const pr = ghCalls.find((c) => c.op === 'pr');
  assert.equal(pr.title, 'Make this app invite-only build, public to view');
  assert.match(pr.body, /`visibility` block in `dapp\.json`/);
});

test('admins can propose on apps they did not create', async () => {
  // Full admin (canAdminWrite) — the visibility-pr gate is full-admin-or-
  // creator since issue #311; a view-only admin would not pass it.
  currentUser = { id: 50, username: 'boss', isAdmin: true, canAdminWrite: true };
  const res = await propose({ collabVisibility: 'private', viewVisibility: 'private' });
  assert.equal(res.status, 201);
  const pr = ghCalls.find((c) => c.op === 'pr');
  assert.equal(pr.title, 'Make this app private (collaborators only)');
});

test('the old instant PATCH /visibility route is gone (404)', async () => {
  const res = await fetch(`${base}/api/apps/demo/visibility`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ collabVisibility: 'private', viewVisibility: 'public' }),
  });
  assert.equal(res.status, 404);
});

// ── createManifestPR refactor regression: rename artifact unchanged ──

test('createRenamePR still produces the rename/ branch + title + manifest shape', async () => {
  const renamePr = require('../src/services/rename-pr');
  ghCalls = [];
  poolQueryHandler = defaultHandler();
  const pool = { query: (sql, params) => poolQueryHandler(sql, params) };

  const result = await renamePr.createRenamePR(
    { jwtSecret: 'test' }, pool,
    { id: 11, slug: 'demo', name: 'Demo', repo_url: 'https://github.com/o/r' },
    'Cooler Demo',
    { id: 1, username: 'creator' }
  );

  assert.equal(result.sessionId, 4242);
  assert.equal(result.prNumber, 555);
  assert.match(result.branch, /^rename\/demo-\d+$/);

  const push = ghCalls.find((c) => c.op === 'push');
  const written = JSON.parse(push.files[0].content);
  assert.equal(written.name, 'Cooler Demo');
  assert.equal(written.secrets[0].key, 'FOO_KEY');

  const pr = ghCalls.find((c) => c.op === 'pr');
  assert.equal(pr.title, 'Rename to "Cooler Demo"');
  assert.match(pr.body, /`name` field in `dapp\.json`/);
});
