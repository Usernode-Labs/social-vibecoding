// #3893: an agent that puts its owner's change up for the vote tells the owner.
//
// #1405 gave a connector user "Submitted by your agent" (connector_submitted)
// when submit_work opens a proposal, because the proposer is an agent and the
// person it works for may be nowhere near the screen. The other way an agent
// puts work up for the vote is POST /api/sessions/:id/promote with its bearer
// token: the local Homeroom CLI's proposal_promote, the connector's
// promote_change and submit_work's `propose: true`. That route only ran the
// pr_proposed fan-out, which leaves the proposer out by design, so work
// submitted that way reached the vote without a word to its owner.
//
// Since the proposal machine, the route decides WHO put it up and hands that
// to platform.promoteProposal as `viaAgent`; the machine writes the owner's
// connector_submitted row beside the pr_proposed fan-out in the transaction
// that moves the proposal into review (machine.ts `proposed` write, pinned
// against PostgreSQL by tests/workflow-proposal-postgres.test.js P2). What is
// pinned here, on the real route:
//   - a bearer-token promote (req.cliAuthenticated) is handed on as viaAgent;
//   - a person pressing Propose in the browser is not, and neither is the
//     platform's own agent session (a delegated grant) or the Homeroom bot
//     (a synthetic user); a refused promote reaches the machine not at all.
// [main]'s "a failing notification never fails a promote that already
// happened" has no subject any more: the notification commits with the move
// into review, or neither does.
//
// Same require.cache stubbing and real Express router as
// tests/votes-promote-reopen.test.js.
//
// Run with: node --test tests/connector-promote-notifies-owner.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { mergeGate } = require('../src/services/active-users');
const HEAD = 'a'.repeat(40);

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// One promotable change, owned by user 3, with its PR, title and preview in
// place and its checks already describing HEAD, so no PR is created and no
// build starts.
const sessionRow = {
  id: 7, app_id: 5, app_slug: 'widget', app_name: 'Widget',
  repo_url: 'https://github.com/acme/widget', branch_name: 'dev/x-1',
  pr_number: 26, pr_title: 'Native iOS look', pr_url: 'https://github.com/acme/widget/pull/26',
  staging_url: 'https://stage.example', user_id: 3, status: 'active',
  source: 'cli_handoff', checks_commit_sha: HEAD, check_state: 'passing',
};

function promotePool(session) {
  const row = { ...session };
  return {
    async query(sql, params) {
      const s = String(sql);
      if (/cs\.status IN \('active', 'paused'\)/.test(s)) {
        return ['active', 'paused'].includes(row.status) && row.user_id === params[1]
          ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function loadVotesRouter({ pool }) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    pool: require.resolve('../src/db/pool'),
    github: require.resolve('../src/services/github'),
    staging: require.resolve('../src/services/staging'),
    docker: require.resolve('../src/services/docker'),
    ws: require.resolve('../src/services/ws'),
    activeUsers: require.resolve('../src/services/active-users'),
    notifications: require.resolve('../src/services/notifications'),
    adminApproval: require.resolve('../src/services/admin-approval'),
    events: require.resolve('../src/services/events'),
    appAccess: require.resolve('../src/services/app-access'),
    topicAttrs: require.resolve('../src/services/topic-attributes'),
    platform: require.resolve('../src/workflow/platform.ts'),
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const calls = { promote: [], notified: [] };

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => pool });
  stub(ids.github, {
    isEnabled: () => true,
    getPR: async () => ({ state: 'open', merged: false, draft: true, node_id: 'PR_26', head: { sha: HEAD } }),
  });
  stub(ids.staging, {});
  stub(ids.docker, {});
  stub(ids.ws, { sendSystemMessage: async () => {}, pushNotificationToUser() {}, pushVoteUpdate() {}, pushSessionUpdate() {} });
  stub(ids.activeUsers, { getActiveUserStats: async () => ({ active: 1, majority: 1 }), isUserActive: async () => true, mergeGate });
  // The route writes no notification of its own any more: the machine's
  // move into review does.
  const record = (name) => async (...args) => { calls.notified.push(name, args); return []; };
  stub(ids.notifications, {
    createPrProposedNotifications: record('pr_proposed'),
    createConnectorSubmittedNotification: record('connector_submitted'),
    hydrateAndPush: record('push'),
    serialize: (x) => x,
  });
  stub(ids.adminApproval, { isAppLocked: async () => false, hasAdminYesVote: async () => true });
  stub(ids.events, { record: () => {}, EVENT_TYPES: { PR_PROMOTED: 'pr_promoted', PR_MERGED: 'pr_merged' } });
  stub(ids.appAccess, { sessionCollabGuard: () => (_req, _res, next) => next() });
  stub(ids.topicAttrs, {});
  stub(ids.platform, {
    async promoteProposal(p) {
      calls.promote.push(p);
      return { status: 200, body: { ok: true, prNumber: 26 } };
    },
  });

  delete require.cache[ids.subject];
  const { voteRoutes } = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { voteRoutes, calls, restore };
}

// `as` is how the request was authenticated, set the way the real auth
// layers set it: cli-auth.js marks a CLI or connector bearer token
// cliAuthenticated, and a delegated grant (the platform's own agent session)
// carries mcpDelegation as well. A browser session sets neither; the
// Homeroom bot is a synthetic user.
async function promote({ as = 'browser', session = sessionRow } = {}) {
  const pool = promotePool(session);
  const ctx = loadVotesRouter({ pool });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 3, username: 'evan', ...(as === 'bot' ? { is_synthetic: true } : {}) };
    if (as === 'agent' || as === 'delegated' || as === 'bot') req.cliAuthenticated = true;
    if (as === 'delegated') req.mcpDelegation = { kind: 'agent_mayor' };
    next();
  });
  app.use(ctx.voteRoutes({ jwtSecret: 's', maxUserPromotedSessions: 3 }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/7/promote`, { method: 'POST' });
    return { status: response.status, calls: ctx.calls };
  } finally {
    server.close();
    ctx.restore();
  }
}

test('an agent that puts its owner\'s change up for the vote is handed on as the owner\'s agent', async () => {
  const { status, calls } = await promote({ as: 'agent' });
  assert.equal(status, 200);
  assert.equal(calls.promote.length, 1);
  assert.equal(calls.promote[0].viaAgent, true,
    'the machine writes the owner\'s "Submitted by your agent" with the move into review');
  assert.equal(calls.promote[0].userId, 3);
  assert.deepEqual(calls.notified, [], 'the route itself writes no notification');
});

test('a person pressing Propose is not told about their own click', async () => {
  const { status, calls } = await promote({ as: 'browser' });
  assert.equal(status, 200);
  assert.equal(calls.promote[0].viaAgent, false);
  assert.deepEqual(calls.notified, []);
});

test('the platform\'s own agent session does not get a second notice', async () => {
  // A delegated grant is cliAuthenticated too; its conversation is where its
  // owner already follows the change, so it is left out.
  const { status, calls } = await promote({ as: 'delegated' });
  assert.equal(status, 200);
  assert.equal(calls.promote[0].viaAgent, false);
});

test('the Homeroom bot promoting as itself is not an owner\'s agent', async () => {
  const { calls } = await promote({ as: 'bot' });
  assert.equal(calls.promote[0].viaAgent, false);
});

test('a refused promote tells nobody anything', async () => {
  const { status, calls } = await promote({ as: 'agent', session: { ...sessionRow, user_id: 99 } });
  assert.equal(status, 404);
  assert.deepEqual(calls.promote, []);
  assert.deepEqual(calls.notified, []);
});
