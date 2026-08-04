// #918: route-level coverage for GET /api/sessions/:id/easy-review.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolMod = require('../src/db/pool');
let handler = async () => ({ rows: [] });
const seen = [];
const pool = {
  query(sql, params) {
    seen.push({ sql, params });
    return handler(sql, params);
  },
};
poolMod.getPool = () => pool;

const github = require('../src/services/github');
github.isEnabled = () => true;
github.compareRefs = async () => ({ files: ['public/js/app-view.js'], filesComplete: true });
github.getProposalDiff = async () => ({
  diff: 'diff --git a/public/js/app-view.js b/public/js/app-view.js\n@@ -1 +1 @@',
  truncated: false,
});
const governance = require('../src/services/governance');
let policy = 'anyone';
let approver = false;
governance.getGovernance = async () => ({ approverPolicy: policy, approvalsRequired: 1 });
governance.isApprover = async () => approver;
const appAdmins = require('../src/services/app-admins');
let manager = false;
appAdmins.canManageApp = async () => manager;

const { sessionRoutes } = require('../src/routes/sessions');

const USER = { id: 7, username: 'reviewer' };

function sessionRow(overrides = {}) {
  return {
    id: 41,
    session_title: '#918 · Easy review',
    branch_name: 'dev/auto-issue-918-1',
    spec_md: '# Spec',
    headless_status: 'ready',
    headless_outcome: 'spec_code',
    staging_url: 'https://preview.example.test',
    check_state: 'passing',
    check_error_detail: null,
    test_results: [{ status: 'passed', command: 'node --test' }],
    app_id: 10,
    app_slug: 'demo',
    repo_url: 'https://github.com/acme/demo',
    created_by: 1,
    collab_visibility: 'public',
    view_visibility: 'public',
    ...overrides,
  };
}

function makeHandler(row) {
  return async (sql) => {
    // appAccess.sessionCollabGuard's view-level preflight.
    if (/SELECT a\.id, a\.collab_visibility, a\.view_visibility/.test(sql)) {
      return { rows: [{ id: 10, collab_visibility: row.collab_visibility, view_visibility: row.view_visibility }] };
    }
    if (/WHERE cs\.id = \$1 AND cs\.is_headless = TRUE/.test(sql)) return { rows: [row] };
    if (/SELECT cs\.\*, a\.slug as app_slug/.test(sql)) {
      return { rows: [{ ...row, app_created_by: row.created_by, is_headless: true }] };
    }
    if (/role = 'assistant'/.test(sql)) return { rows: [{ content: 'Implemented the compact review.' }] };
    if (/FROM app_collaborators/.test(sql)) return { rows: [] };
    return { rows: [] };
  };
}

async function request(row) {
  handler = makeHandler(row);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = USER; next(); });
  app.use(sessionRoutes({}));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/41/easy-review`);
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function requestEasyAccept(row) {
  handler = makeHandler(row);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = USER; next(); });
  app.use(sessionRoutes({ maxUserSessions: 5, maxGlobalSessions: 100 }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/41/clone-headless`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ easyAccept: true }),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('returns a narrow accept-ready payload for a passing code proposal', async () => {
  policy = 'anyone';
  approver = false;
  manager = false;
  const { status, body } = await request(sessionRow());
  assert.equal(status, 200);
  assert.equal(body.review.canAccept, true);
  assert.deepEqual(body.review.changedFiles, ['public/js/app-view.js']);
  assert.match(body.review.diff, /diff --git/);
  assert.equal(body.review.summary, 'Implemented the compact review.');
  assert.equal(body.review.branch_name, undefined, 'branch metadata is not serialized');
  assert.equal(body.review.repo_url, undefined, 'repository metadata is not serialized');
});

test('invited policy disables one-click Accept for a non-approver', async () => {
  policy = 'invited';
  approver = false;
  manager = false;
  const { status, body } = await request(sessionRow());
  assert.equal(status, 200);
  assert.equal(body.review.canAccept, false);
  assert.ok(body.review.acceptBlockedBy.some((x) => /approver or app admin/.test(x)));
});

test('app managers may Accept under invited policy', async () => {
  policy = 'invited';
  approver = false;
  manager = true;
  const { status, body } = await request(sessionRow());
  assert.equal(status, 200);
  assert.equal(body.review.canAccept, true);
});

test('view-only users cannot read unpublished Easy review content', async () => {
  policy = 'anyone';
  manager = false;
  const { status, body } = await request(sessionRow({
    collab_visibility: 'private',
    view_visibility: 'public',
  }));
  assert.equal(status, 404);
  assert.equal(body.error, 'Auto proposal not found');
});

test('pending checks and comparison failures fail closed for acceptance', async () => {
  policy = 'anyone';
  manager = false;
  const originalCompare = github.compareRefs;
  github.compareRefs = async () => { throw new Error('upstream unavailable'); };
  try {
    const { status, body } = await request(sessionRow({ check_state: 'pending' }));
    assert.equal(status, 200);
    assert.equal(body.review.canAccept, false);
    assert.match(body.review.reviewError, /could not be loaded/);
    assert.ok(body.review.acceptBlockedBy.some((x) => /still running/.test(x)));
  } finally {
    github.compareRefs = originalCompare;
  }
});

test('Easy Accept mutation re-checks invited-approver eligibility', async () => {
  policy = 'invited';
  approver = false;
  manager = false;
  const { status, body } = await requestEasyAccept(sessionRow());
  assert.equal(status, 403);
  assert.match(body.error, /current approver or app admin/);
});

test('Easy Accept mutation re-checks automated checks', async () => {
  policy = 'anyone';
  approver = false;
  manager = false;
  const { status, body } = await requestEasyAccept(sessionRow({ check_state: 'pending' }));
  assert.equal(status, 409);
  assert.match(body.error, /still running/);
});
