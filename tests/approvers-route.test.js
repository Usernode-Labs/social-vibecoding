// Tests for the approver roster + invite endpoints (issue #646,
// src/routes/approvers.js): permission matrix, the collab-private
// prerequisite, accept/decline/remove, and the governance-cache
// invalidation. Express + mocked pool, mirroring
// tests/governance-pr-route.test.js.
//
// Run with: node --test tests/approvers-route.test.js

const { test } = require('node:test');
const assert = require('node:assert');

// Override the pool BEFORE requiring the route module.
const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
poolMod.getPool = () => ({ query: (sql, params) => poolQueryHandler(sql, params) });

const governance = require('../src/services/governance');
let invalidated;
const realInvalidate = governance.invalidateGovernance;
governance.invalidateGovernance = (appId) => { invalidated.push(appId); realInvalidate(appId); };

const { approverRoutes } = require('../src/routes/approvers');
const express = require('express');

const APP_ROW = {
  id: 11,
  slug: 'demo',
  created_by: 1,
  self_hosted: false,
  collab_visibility: 'public',
  view_visibility: 'public',
  approver_policy: 'invited',
  approvals_required: 1,
  name: 'Demo',
};

let currentUser;
let appRow;
let calls;
let targetUser;          // resolved by the username lookup
let existingApproverRow; // status of an existing app_approvers row, or null
let collabMember;        // is the target a collaborator member?
let pendingInviteUpdate; // rows returned by the accept UPDATE

function defaultHandler() {
  return async (sql, params) => {
    calls.push({ sql, params });
    if (/FROM apps WHERE slug = \$1/.test(sql)) {
      return { rows: appRow ? [appRow] : [] };
    }
    if (/SELECT id, slug, name FROM apps WHERE id = \$1/.test(sql)) {
      return { rows: appRow ? [appRow] : [] };
    }
    if (/SELECT id, username FROM users WHERE LOWER\(username\)/.test(sql)) {
      return { rows: targetUser ? [targetUser] : [] };
    }
    if (/FROM app_collaborators/.test(sql)) {
      // The caller's own collab-gate check (id 1/9/50) always passes —
      // creators get a member row at creation time; `collabMember` only
      // scripts the TARGET invitee's membership (id 7 in invite tests).
      const isTargetCheck = params && params[1] === targetUser?.id && currentUser.id !== targetUser?.id;
      return { rows: (isTargetCheck ? collabMember : true) ? [{ 1: 1 }] : [] };
    }
    if (/INSERT INTO app_approvers/.test(sql)) {
      return { rows: existingApproverRow ? [] : [{ user_id: targetUser?.id }] };
    }
    if (/SELECT status FROM app_approvers/.test(sql)) {
      return { rows: existingApproverRow ? [{ status: existingApproverRow }] : [] };
    }
    if (/UPDATE app_approvers/.test(sql)) {
      return { rows: pendingInviteUpdate };
    }
    if (/SELECT ap\.user_id/.test(sql)) {
      return {
        rows: [
          { user_id: 1, status: 'member', created_at: null, accepted_at: null, username: 'creator', invited_by: null },
          { user_id: 2, status: 'invited', created_at: null, accepted_at: null, username: 'bob', invited_by: 'creator' },
        ],
      };
    }
    if (/DELETE FROM app_approvers WHERE app_id = \$1 AND user_id = \$2$/.test(sql)) {
      return { rowCount: 1, rows: [] };
    }
    return { rows: [], rowCount: 0 };
  };
}

let server;
let base;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use(approverRoutes({ jwtSecret: 'test' }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

test.beforeEach(() => {
  calls = [];
  invalidated = [];
  appRow = { ...APP_ROW };
  currentUser = { id: 1, username: 'creator', isAdmin: false, canAdminWrite: false };
  targetUser = { id: 7, username: 'newapprover' };
  existingApproverRow = null;
  collabMember = true;
  pendingInviteUpdate = [{ invited_by: 1 }];
  poolQueryHandler = defaultHandler();
});

const invite = (username) => fetch(`${base}/api/apps/demo/approver-invites`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username }),
});

test('list: returns roster + policy fields and canManage', async () => {
  const res = await fetch(`${base}/api/apps/demo/approvers`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.approvers.length, 2);
  assert.equal(body.approvers[0].status, 'member');
  assert.equal(body.approverPolicy, 'invited');
  assert.equal(body.approvalsRequired, 1);
  assert.equal(body.canManage, true, 'creator can manage');
});

test('invite: creator succeeds, roster mutation notifies', async () => {
  const res = await invite('newapprover');
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.username, 'newapprover');
  const ins = calls.find((c) => /INSERT INTO app_approvers/.test(c.sql));
  assert.ok(ins);
  assert.deepEqual(ins.params.slice(0, 2), [11, 7]);
});

test('invite: plain collaborator (non-creator, non-admin) gets 403', async () => {
  currentUser = { id: 9, username: 'member', isAdmin: false, canAdminWrite: false };
  const res = await invite('newapprover');
  assert.equal(res.status, 403);
});

test('invite: full admin succeeds on an app they did not create', async () => {
  currentUser = { id: 50, username: 'boss', isAdmin: true, canAdminWrite: true };
  const res = await invite('newapprover');
  assert.equal(res.status, 201);
});

test('invite: allowed on the self-hosted app (admins)', async () => {
  appRow.self_hosted = true;
  currentUser = { id: 50, username: 'boss', isAdmin: true, canAdminWrite: true };
  const res = await invite('newapprover');
  assert.equal(res.status, 201);
});

test('invite: on a collab-private app the invitee must already be a member', async () => {
  appRow.collab_visibility = 'private';
  collabMember = false;
  const res = await invite('newapprover');
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /collaborator first/);
});

test('invite: duplicate member → 409 "already an approver"', async () => {
  existingApproverRow = 'member';
  const res = await invite('newapprover');
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /already an approver/);
});

test('invite: duplicate pending → 409 "pending approver invite"', async () => {
  existingApproverRow = 'invited';
  const res = await invite('newapprover');
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /pending approver invite/);
});

test('invite: unknown user → 404', async () => {
  targetUser = null;
  const res = await invite('ghost');
  assert.equal(res.status, 404);
});

test('accept: flips to member, invalidates the governance cache', async () => {
  currentUser = { id: 7, username: 'newapprover' };
  const res = await fetch(`${base}/api/approver-invites/11/accept`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(invalidated.includes(11), 'accept must invalidate the governance cache');
});

test('accept: nothing pending and not a member → 404', async () => {
  currentUser = { id: 7, username: 'newapprover' };
  pendingInviteUpdate = [];
  const res = await fetch(`${base}/api/approver-invites/11/accept`, { method: 'POST' });
  assert.equal(res.status, 404);
});

test('decline: always ok, deletes the invited row', async () => {
  currentUser = { id: 7, username: 'newapprover' };
  const res = await fetch(`${base}/api/approver-invites/11/decline`, { method: 'POST' });
  assert.equal(res.status, 200);
  const del = calls.find((c) => /DELETE FROM app_approvers WHERE app_id = \$1 AND user_id = \$2 AND status = 'invited'/.test(c.sql));
  assert.ok(del);
});

test('remove: creator can remove an approver; cache invalidated', async () => {
  const res = await fetch(`${base}/api/apps/demo/approvers/7`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.ok(invalidated.includes(11));
});

test('remove: an approver can remove themself (leave)', async () => {
  currentUser = { id: 7, username: 'newapprover' };
  const res = await fetch(`${base}/api/apps/demo/approvers/7`, { method: 'DELETE' });
  assert.equal(res.status, 200);
});

test('remove: an unrelated user gets 403', async () => {
  currentUser = { id: 9, username: 'member', isAdmin: false, canAdminWrite: false };
  const res = await fetch(`${base}/api/apps/demo/approvers/7`, { method: 'DELETE' });
  assert.equal(res.status, 403);
});
