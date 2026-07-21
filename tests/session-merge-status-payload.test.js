// #405: route test for GET /api/sessions/:id (src/routes/sessions.js). The
// dev session view's merge-lifecycle pill needs the vote tally to resolve the
// In-vote / "Passed — merging shortly" states exactly as the proposal feed
// card does, so the single-session payload now returns computed yes_count +
// no_count (subqueries) and majority (the app's active-user threshold).
//
// Harness shape mirrors tests/me-active-sessions.test.js: stub getPool before
// requiring the route module, stub the service helpers the handler reaches
// (getActiveUserStats — destructured at require time, so it MUST be overridden
// before the require below — plus visuals.getForSession and
// notifications.markReadForAction), mount on a real express app, inject
// req.user, and assert on the JSON the route returns.
//
// Run with: node --test tests/session-merge-status-payload.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const poolMod = require('../src/db/pool');
let capturedQueries = [];
let sessionRow = {};
// #695: governance stubs — the handler now resolves the app's approver
// policy, roster, and qualifying tally for promoted rows. Defaults model
// the 'anyone' policy (empty apps row → policy 'anyone').
let govRows = [];
let approverRows = [];
let qualifiedRow = { yes: 0, no: 0 };
poolMod.getPool = () => ({
  query: (sql, params) => {
    capturedQueries.push({ sql, params });
    if (/FROM chat_sessions cs\s+JOIN apps a/.test(sql) && /WHERE cs\.id/.test(sql)) {
      return Promise.resolve({ rows: [sessionRow] });
    }
    if (/FROM chat_session_messages/.test(sql)) {
      return Promise.resolve({ rows: [] });
    }
    if (/SELECT approver_policy, approvals_required FROM apps/.test(sql)) {
      return Promise.resolve({ rows: govRows });
    }
    if (/FROM app_approvers/.test(sql)) {
      return Promise.resolve({ rows: approverRows });
    }
    if (/FROM users WHERE is_admin/.test(sql)) {
      // Admin fallback roster (only reached when app_approvers is empty).
      return Promise.resolve({ rows: [{ id: 1 }] });
    }
    if (/FILTER \(WHERE vote = 'yes'\)/.test(sql)) {
      return Promise.resolve({ rows: [qualifiedRow] });
    }
    // activity bump UPDATE + anything else.
    return Promise.resolve({ rows: [] });
  },
});

// getActiveUserStats is destructured at require time in sessions.js, so the
// override must land on the module BEFORE requiring the route. A wrapper over
// a mutable impl lets individual tests change the behaviour at runtime (the
// captured reference stays the wrapper).
const activeUsers = require('../src/services/active-users');
let statsImpl = async () => ({ active: 5, majority: 3 });
activeUsers.getActiveUserStats = (...args) => statsImpl(...args);

// Keep the handler's best-effort side calls inert.
const visuals = require('../src/services/visuals');
visuals.getForSession = async () => null;
const notifications = require('../src/services/notifications');
notifications.markReadForAction = async () => 0;

const { sessionRoutes } = require('../src/routes/sessions');
const express = require('express');

const VIEWER = { id: 7, username: 'tester' };

function startServer() {
  const app = express();
  app.use((req, res, next) => { req.user = VIEWER; next(); });
  app.use(sessionRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function baseRow(overrides = {}) {
  return {
    id: 42,
    app_id: 9,
    user_id: VIEWER.id,
    branch_name: 'dev/tester-42',
    pr_number: 101,
    pr_url: 'https://github.com/o/r/pull/101',
    pr_title: 'Add a thing',
    status: 'promoted',
    check_state: 'passing',
    merge_conflict_state: null,
    behind_main: 0,
    app_slug: 'demo',
    app_name: 'Demo App',
    yes_count: 3,
    no_count: 0,
    ...overrides,
  };
}

async function getSession(server, id) {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}`);
  return { res, body: await res.json() };
}

test('payload includes the vote-tally subqueries and computed majority', async () => {
  capturedQueries = [];
  sessionRow = baseRow();
  const server = await startServer();
  try {
    const { res, body } = await getSession(server, 42);
    assert.strictEqual(res.status, 200);
    assert.ok(body.session, 'session returned');
    assert.strictEqual(body.session.yes_count, 3);
    assert.strictEqual(body.session.no_count, 0);
    assert.strictEqual(body.session.majority, 3, 'majority from getActiveUserStats');
    // #695: default policy — every vote qualifies, majority untouched.
    assert.strictEqual(body.session.approval_policy, 'anyone');
    assert.strictEqual(body.session.qualified_yes_count, 3);

    // The contract is in the SQL: the single-session SELECT computes the
    // yes/no tallies from pr_votes.
    const q = capturedQueries.find((c) => /vote = 'yes'/.test(c.sql) && /cs\.\*/.test(c.sql));
    assert.ok(q, 'single-session query computes the vote tally');
    assert.match(q.sql, /vote = 'no'/);
  } finally {
    server.close();
  }
});

test('majority falls back to 1 when the stats lookup throws', async () => {
  capturedQueries = [];
  sessionRow = baseRow({ yes_count: 1 });
  const orig = statsImpl;
  statsImpl = async () => { throw new Error('stats down'); };
  const server = await startServer();
  try {
    const { res, body } = await getSession(server, 42);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.session.majority, 1, 'defensive default');
  } finally {
    statsImpl = orig;
    server.close();
  }
});

test('payload + MergeStatus together resolve the In-vote vs. ready states', async () => {
  // End-to-end: the route returns the tally and the shared helper turns it
  // into the canonical state the dev session header renders.
  const MergeStatus = require('../public/js/merge-status.js');

  sessionRow = baseRow({ yes_count: 3 }); // 3/3 + checks passing → ready
  let server = await startServer();
  try {
    const { body } = await getSession(server, 42);
    assert.strictEqual(MergeStatus.lifecycle(body.session).key, 'ready');
  } finally { server.close(); }

  sessionRow = baseRow({ yes_count: 1 }); // 1/3 → still in vote
  server = await startServer();
  try {
    const { body } = await getSession(server, 42);
    assert.strictEqual(MergeStatus.lifecycle(body.session).key, 'in_vote');
  } finally { server.close(); }
});

// #695: invited-approver app — only approver votes qualify, so a proposal
// with two non-approver (advisory) yes votes must NOT read as passed. The
// payload carries the governance fields and its majority is the gate
// requirement, not the active-user threshold.
test('invited policy: advisory votes never satisfy the header pill', async () => {
  const MergeStatus = require('../public/js/merge-status.js');
  // Fresh app_id — getGovernance caches per app for 10s, so reusing app_id 9
  // from the earlier ('anyone') tests would hit the cache.
  sessionRow = baseRow({ app_id: 11, yes_count: 2, no_count: 0 });
  govRows = [{ approver_policy: 'invited', approvals_required: 1 }];
  approverRows = [{ user_id: 100 }];
  qualifiedRow = { yes: 0, no: 0 }; // neither voter is the approver
  const server = await startServer();
  try {
    const { res, body } = await getSession(server, 42);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.session.approval_policy, 'invited');
    assert.strictEqual(body.session.approvals_required, 1);
    assert.strictEqual(body.session.qualified_yes_count, 0);
    assert.strictEqual(body.session.qualified_no_count, 0);
    assert.strictEqual(body.session.yes_count, 2, 'raw tally still serialized');
    assert.strictEqual(body.session.majority, 1, 'majority = gate requirement, not active-user stats');
    // Raw yes (2) ≥ majority (1), but the qualified tally (0) keeps it in vote.
    assert.strictEqual(MergeStatus.lifecycle(body.session).key, 'in_vote');
  } finally {
    govRows = [];
    approverRows = [];
    qualifiedRow = { yes: 0, no: 0 };
    server.close();
  }
});

// #695: a qualifying approver vote satisfies the same gate.
test('invited policy: an approver vote reaches the target', async () => {
  const MergeStatus = require('../public/js/merge-status.js');
  sessionRow = baseRow({ app_id: 12, yes_count: 3, no_count: 0 });
  govRows = [{ approver_policy: 'invited', approvals_required: 1 }];
  approverRows = [{ user_id: 100 }];
  qualifiedRow = { yes: 1, no: 0 };
  const server = await startServer();
  try {
    const { body } = await getSession(server, 42);
    assert.strictEqual(body.session.qualified_yes_count, 1);
    assert.strictEqual(MergeStatus.lifecycle(body.session).key, 'ready');
  } finally {
    govRows = [];
    approverRows = [];
    qualifiedRow = { yes: 0, no: 0 };
    server.close();
  }
});
