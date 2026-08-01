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
// initialApprovers plumbing (services/approver-invites.js): known users,
// recorded app_approvers inserts, and switches for the conflict /
// collaborator-membership branches.
let knownUsers;
let approverInserts;
let approverInsertConflicts; // usernames whose insert should no-op
let existingApproverStatus;  // status returned by the post-conflict lookup
let collaboratorIds;         // user ids that count as collab members

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
    if (/SELECT id, username FROM users WHERE LOWER\(username\)/.test(sql)) {
      const uname = String(params[0]).toLowerCase();
      const id = knownUsers[uname];
      return { rows: id ? [{ id, username: uname }] : [] };
    }
    if (/FROM app_collaborators WHERE app_id/.test(sql)) {
      return { rows: collaboratorIds.includes(params[1]) ? [{ 1: 1 }] : [] };
    }
    if (/INSERT INTO app_approvers/.test(sql)) {
      const conflicted = Object.entries(knownUsers)
        .some(([name, id]) => id === params[1] && approverInsertConflicts.includes(name));
      if (conflicted) return { rows: [] };
      approverInserts.push({ appId: params[0], userId: params[1], invitedBy: params[2] });
      return { rows: [{ user_id: params[1] }] };
    }
    if (/SELECT status FROM app_approvers/.test(sql)) {
      return { rows: [{ status: existingApproverStatus }] };
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
  openGovernanceSession = null;
  currentUser = { id: 1, username: 'creator', isAdmin: false };
  knownUsers = { alice: 21, bob: 22 };
  approverInserts = [];
  approverInsertConflicts = [];
  existingApproverStatus = 'member';
  collaboratorIds = [21, 22];
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

// ── initialApprovers: invites sent alongside the switch to 'invited' ─────

test('initialApprovers must be an array of usernames (400 otherwise)', async () => {
  let res = await propose({ approverPolicy: 'invited', approvalsRequired: null, initialApprovers: 'alice' });
  assert.equal(res.status, 400);
  res = await propose({ approverPolicy: 'invited', approvalsRequired: null, initialApprovers: [42] });
  assert.equal(res.status, 400);
  assert.equal(approverInserts.length, 0);
});

test('initialApprovers is capped at 20 usernames', async () => {
  const many = Array.from({ length: 21 }, (_, i) => `user${i}`);
  const res = await propose({ approverPolicy: 'invited', approvalsRequired: null, initialApprovers: many });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /capped at 20/);
});

test('initialApprovers creates invited rows after the PR opens; unknown users become warnings', async () => {
  const res = await propose({
    approverPolicy: 'invited', approvalsRequired: null,
    initialApprovers: ['alice', 'ghost'],
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.prNumber, 777, 'the PR still opened');
  assert.equal(approverInserts.length, 1, 'one invite row inserted');
  assert.equal(approverInserts[0].userId, 21);
  assert.equal(approverInserts[0].appId, 11);
  assert.equal(approverInserts[0].invitedBy, 1);
  assert.deepEqual(body.inviteWarnings, ['@ghost: User not found']);
  assert.ok(ghCalls.find((c) => c.op === 'pr'), 'PR was created before invites went out');
});

test('initialApprovers are trimmed and deduped case-insensitively', async () => {
  const res = await propose({
    approverPolicy: 'invited', approvalsRequired: null,
    initialApprovers: [' alice ', 'ALICE', '', 'alice'],
  });
  assert.equal(res.status, 201);
  assert.equal(approverInserts.length, 1, 'only one insert for the deduped name');
  const body = await res.json();
  assert.equal(body.inviteWarnings, undefined, 'no warnings for a clean list');
});

test('initialApprovers is ignored when switching to anyone', async () => {
  appRow.approver_policy = 'invited';
  appRow.approvals_required = 1;
  const res = await propose({
    approverPolicy: 'anyone', approvalsRequired: null,
    initialApprovers: ['alice'],
  });
  assert.equal(res.status, 201);
  assert.equal(approverInserts.length, 0, 'no invites for an anyone-policy proposal');
  assert.equal((await res.json()).inviteWarnings, undefined);
});

test('collab-private apps warn (not fail) for non-collaborator initial approvers', async () => {
  appRow.collab_visibility = 'private';
  collaboratorIds = [21]; // alice is a member, bob is not
  const res = await propose({
    approverPolicy: 'invited', approvalsRequired: null,
    initialApprovers: ['alice', 'bob'],
  });
  assert.equal(res.status, 201);
  assert.equal(approverInserts.length, 1, 'only the collaborator got an invite');
  assert.equal(approverInserts[0].userId, 21);
  const body = await res.json();
  assert.equal(body.inviteWarnings.length, 1);
  assert.match(body.inviteWarnings[0], /@bob: .*must be a collaborator first/);
});

test('already-invited / already-member initial approvers are a silent no-op', async () => {
  approverInsertConflicts = ['alice'];
  existingApproverStatus = 'member';
  const res = await propose({
    approverPolicy: 'invited', approvalsRequired: null,
    initialApprovers: ['alice'],
  });
  assert.equal(res.status, 201);
  assert.equal(approverInserts.length, 0);
  assert.equal((await res.json()).inviteWarnings, undefined, 'dupes are not warnings');
});

test('a 409 (governance PR already open) sends no invites', async () => {
  openGovernanceSession = { id: 88, pr_number: 654, pr_url: 'https://github.com/o/r/pull/654' };
  const res = await propose({
    approverPolicy: 'invited', approvalsRequired: null,
    initialApprovers: ['alice'],
  });
  assert.equal(res.status, 409);
  assert.equal(approverInserts.length, 0);
});

test('a failed PR creation sends no invites', async () => {
  const origCreatePR = github.createPR;
  github.createPR = async () => { throw new Error('boom'); };
  try {
    const res = await propose({
      approverPolicy: 'invited', approvalsRequired: null,
      initialApprovers: ['alice'],
    });
    assert.equal(res.status, 500);
    assert.equal(approverInserts.length, 0, 'invites only go out after the PR exists');
  } finally {
    github.createPR = origCreatePR;
  }
});
