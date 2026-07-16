// Tests for POST /api/apps/:slug/governance-pr (issue #646) — the
// vote-gated dapp.json proposal that changes the two proposal-approval
// settings. Mirrors tests/visibility-pr-route.test.js (express +
// mocked pool + stubbed GitHub service).
//
// Run with: node --test tests/governance-pr-route.test.js

const { test } = require('node:test');
const assert = require('node:assert');

// Override the pool BEFORE requiring the route module: apps.js
// destructures getPool at require time.
const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
poolMod.getPool = () => ({ query: (sql, params) => poolQueryHandler(sql, params) });

// Stub the GitHub service: enabled, with recordable branch/push/PR calls.
const github = require('../src/services/github');
let ghCalls;
let ghEnabled = true;
const ghManifestOnMain = JSON.stringify({ name: 'Demo', secrets: [{ key: 'FOO_KEY', description: 'x' }] });
github.isEnabled = () => ghEnabled;
github.getFileContent = async () => ghManifestOnMain;
github.createBranch = async (owner, repo, branch) => { ghCalls.push({ op: 'branch', branch }); };
github.pushFiles = async (owner, repo, files, opts) => { ghCalls.push({ op: 'push', files, opts }); };
github.createPR = async (owner, repo, { branch, title, body }) => {
  ghCalls.push({ op: 'pr', branch, title, body });
  return { number: 777, html_url: 'https://github.com/o/r/pull/777' };
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
  approver_policy: 'anyone',
  approvals_required: null,
};

let currentUser = { id: 1, username: 'creator', isAdmin: false };
let appRow;
let openGovernanceSession;

function defaultHandler() {
  return async (sql, params) => {
    if (/SELECT \* FROM apps WHERE slug = \$1/.test(sql)) {
      return { rows: appRow ? [appRow] : [] };
    }
    if (/branch_name LIKE 'governance\/%'/.test(sql)) {
      return { rows: openGovernanceSession ? [openGovernanceSession] : [] };
    }
    if (/INSERT INTO chat_sessions/.test(sql)) {
      return { rows: [{ id: 4243 }] };
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
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

test.beforeEach(() => {
  ghCalls = [];
  ghEnabled = true;
  appRow = { ...APP_ROW };
  openGovernanceSession = null;
  currentUser = { id: 1, username: 'creator', isAdmin: false };
  poolQueryHandler = defaultHandler();
});

function propose(body) {
  return fetch(`${base}/api/apps/demo/governance-pr`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('invalid values are rejected with 400', async () => {
  let res = await propose({ approverPolicy: 'everyone', approvalsRequired: 1 });
  assert.equal(res.status, 400);
  res = await propose({ approverPolicy: 'invited', approvalsRequired: 0 });
  assert.equal(res.status, 400);
  res = await propose({ approverPolicy: 'invited', approvalsRequired: 51 });
  assert.equal(res.status, 400);
  res = await propose({ approverPolicy: 'invited', approvalsRequired: 1.5 });
  assert.equal(res.status, 400);
});

test('non-creator non-admin gets 403', async () => {
  currentUser = { id: 99, username: 'rando', isAdmin: false };
  const res = await propose({ approverPolicy: 'invited', approvalsRequired: 1 });
  assert.equal(res.status, 403);
});

test('same-as-current settings are a 400', async () => {
  const res = await propose({ approverPolicy: 'anyone', approvalsRequired: null });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /already has those approval settings/);
});

test('GitHub disabled means 503', async () => {
  ghEnabled = false;
  const res = await propose({ approverPolicy: 'invited', approvalsRequired: 1 });
  assert.equal(res.status, 503);
});

test('no repo_url means 400', async () => {
  appRow.repo_url = null;
  const res = await propose({ approverPolicy: 'invited', approvalsRequired: 1 });
  assert.equal(res.status, 400);
});

test('an open governance PR dedupes to 409 with a pointer at it', async () => {
  openGovernanceSession = { id: 88, pr_number: 654, pr_url: 'https://github.com/o/r/pull/654' };
  const res = await propose({ approverPolicy: 'invited', approvalsRequired: 1 });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.sessionId, 88);
  assert.equal(body.prNumber, 654);
});

test('success: opens a governance/ branch PR editing dapp.json and promotes a session', async () => {
  const res = await propose({ approverPolicy: 'invited', approvalsRequired: 1 });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.sessionId, 4243);
  assert.equal(body.prNumber, 777);

  const branchCall = ghCalls.find((c) => c.op === 'branch');
  assert.match(branchCall.branch, /^governance\/demo-\d+$/);

  const push = ghCalls.find((c) => c.op === 'push');
  assert.equal(push.files[0].path, 'dapp.json');
  const written = JSON.parse(push.files[0].content);
  // Existing manifest fields are preserved; only the block is added.
  assert.equal(written.name, 'Demo');
  assert.equal(written.secrets[0].key, 'FOO_KEY');
  assert.deepEqual(written.governance, { approvers: 'invited', approvals: { atLeast: 1 } });

  const pr = ghCalls.find((c) => c.op === 'pr');
  assert.match(pr.title, /at least 1 approval/);
  assert.match(pr.body, /`governance` block in `dapp\.json`/);
});

test('switching back to the default strategy writes approvals: "default"', async () => {
  appRow.approver_policy = 'invited';
  appRow.approvals_required = 1;
  const res = await propose({ approverPolicy: 'anyone', approvalsRequired: null });
  assert.equal(res.status, 201);
  const push = ghCalls.find((c) => c.op === 'push');
  const written = JSON.parse(push.files[0].content);
  assert.deepEqual(written.governance, { approvers: 'anyone', approvals: 'default' });
});

test('the self-hosted platform app is ALLOWED (unlike visibility-pr)', async () => {
  appRow.self_hosted = true;
  currentUser = { id: 50, username: 'boss', isAdmin: true, canAdminWrite: true };
  const res = await propose({ approverPolicy: 'invited', approvalsRequired: 1 });
  assert.equal(res.status, 201);
  const pr = ghCalls.find((c) => c.op === 'pr');
  assert.match(pr.title, /invited approvers/);
});

test('admins can propose on apps they did not create', async () => {
  currentUser = { id: 50, username: 'boss', isAdmin: true, canAdminWrite: true };
  const res = await propose({ approverPolicy: 'invited', approvalsRequired: 2 });
  assert.equal(res.status, 201);
  const pr = ghCalls.find((c) => c.op === 'pr');
  assert.match(pr.title, /at least 2 approvals/);
});
