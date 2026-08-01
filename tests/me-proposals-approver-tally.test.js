// #695: route test for GET /api/me/proposals — on invited-approver apps the
// home "Your proposals" strip needs the QUALIFYING (approver-only) tallies,
// so both the PR rows and the governance rows must carry
// qualified_yes_count / qualified_no_count alongside the raw counts (the
// surplus renders as the "+N advisory" chip client-side), plus the
// electorate-based votes_required the pill uses as its denominator.
//
// Harness shape mirrors tests/session-merge-status-payload.test.js: stub
// getPool + getActiveUserStats BEFORE requiring the route module (both are
// destructured at require time in routes/votes.js), mount on a real express
// app, inject req.user, assert on the JSON.
//
// Run with: node --test tests/me-proposals-approver-tally.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const poolMod = require('../src/db/pool');

// One invited-approver app (id 31) with a roster of one approver (user 55).
// The viewer's open PR proposal and secret_change governance proposal each
// carry two raw Yes/up votes, NONE of them from the approver — so every
// qualifying tally must come back 0 while the raw counts stay 2.
let sessionRows = [];
let governanceRows = [];
poolMod.getPool = () => ({
  query: (sql) => {
    if (/FROM chat_sessions cs JOIN apps a/.test(sql)) {
      return Promise.resolve({ rows: sessionRows });
    }
    if (/FROM issues i JOIN apps a/.test(sql)) {
      return Promise.resolve({ rows: governanceRows });
    }
    if (/SELECT approver_policy, approvals_required FROM apps/.test(sql)) {
      return Promise.resolve({ rows: [{ approver_policy: 'invited', approvals_required: null }] });
    }
    if (/FROM app_approvers WHERE app_id/.test(sql)) {
      return Promise.resolve({ rows: [{ user_id: 55 }] });
    }
    if (/FILTER \(WHERE vote = /.test(sql)) {
      // Electorate-restricted tallies: the approver hasn't voted.
      return Promise.resolve({ rows: [{ yes: '0', no: '0' }] });
    }
    return Promise.resolve({ rows: [] });
  },
});

const activeUsers = require('../src/services/active-users');
activeUsers.getActiveUserStats = async () => ({ active: 5, majority: 3 });

const { voteRoutes } = require('../src/routes/votes');
const express = require('express');

const VIEWER = { id: 7, username: 'tester' };

function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = VIEWER; next(); });
  app.use(voteRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('invited app: PR and governance rows carry qualified tallies + governed requirement', async () => {
  const now = new Date().toISOString();
  sessionRows = [{
    id: 42, pr_number: 101, pr_url: null, pr_title: 'Add a thing',
    pr_title_fallback: false, status: 'promoted',
    created_at: now, promoted_at: now,
    merge_conflict_state: null, behind_main: 0,
    check_state: 'passing', check_error_detail: null,
    app_id: 31, app_slug: 'demo', app_name: 'Demo App',
    yes_count: 2, no_count: 0,
  }];
  governanceRows = [{
    id: 300, title: 'Set FOO_KEY', kind: 'secret_change', created_at: now,
    app_id: 31, app_slug: 'demo', app_name: 'Demo App',
    up_count: 2, down_count: 0,
  }];

  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/me/proposals`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();

    assert.strictEqual(body.proposals.length, 1);
    const p = body.proposals[0];
    assert.strictEqual(p.approval_policy, 'invited');
    assert.strictEqual(p.qualified_yes_count, 0);
    assert.strictEqual(p.qualified_no_count, 0);
    assert.strictEqual(p.votes_required, 1, 'electorate of one approver → 1 required');
    assert.strictEqual(p.yes_count, 2, 'raw tally stays for advisory derivation');

    assert.strictEqual(body.governance.length, 1);
    const g = body.governance[0];
    assert.strictEqual(g.approval_policy, 'invited');
    assert.strictEqual(g.qualified_yes_count, 0, 'governance rows carry qualified tallies too');
    assert.strictEqual(g.qualified_no_count, 0);
    assert.strictEqual(g.votes_required, 1);
    assert.strictEqual(g.up_count, 2);
  } finally {
    server.close();
  }
});
