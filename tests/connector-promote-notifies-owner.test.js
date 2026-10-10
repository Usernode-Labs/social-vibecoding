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
// What is pinned here, on the real route:
//   - a bearer-token promote (req.cliAuthenticated) notifies its owner once,
//     as connector_submitted 'submitted', and pushes the row;
//   - a person pressing Propose in the browser is not notified about their
//     own click, and neither is the platform's own agent session (a delegated
//     grant) or anyone on a promote that was refused;
//   - a failing notification never fails a promote that already happened.
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
  let row = { ...session };
  return {
    async query(sql, params) {
      const s = String(sql);
      if (/cs\.status IN \('active', 'paused'\)/.test(s)) {
        return ['active', 'paused'].includes(row.status) && row.user_id === params[1]
          ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/COUNT\(\*\) AS cnt FROM chat_sessions/i.test(s)) return { rows: [{ cnt: '0' }], rowCount: 1 };
      if (/SET status = 'promoted', promoted_at = NOW\(\)/.test(s)) {
        const matches = params[2] === row.status;
        if (matches) row = { ...row, status: 'promoted' };
        return { rows: [], rowCount: matches ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function loadVotesRouter({ pool, connectorNotify }) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    pool: require.resolve('../src/db/pool'),
    github: require.resolve('../src/services/github'),
    staging: require.resolve('../src/services/staging'),
    docker: require.resolve('../src/services/docker'),
    resolver: require.resolve('../src/services/conflict-resolver'),
    ws: require.resolve('../src/services/ws'),
    activeUsers: require.resolve('../src/services/active-users'),
    notifications: require.resolve('../src/services/notifications'),
    adminApproval: require.resolve('../src/services/admin-approval'),
    events: require.resolve('../src/services/events'),
    appAccess: require.resolve('../src/services/app-access'),
    topicAttrs: require.resolve('../src/services/topic-attributes'),
    visuals: require.resolve('../src/services/visuals'),
    prImportSync: require.resolve('../src/services/pr-import-sync'),
    pipeline: require.resolve('../src/services/handoff-pipeline'),
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const calls = { proposed: [], connector: [], pushed: [] };
  // Resolves once the route has run everything it does after answering: the
  // owner's notification is post-response, like the fan-out beside it.
  let finished;
  const done = new Promise((resolve) => { finished = resolve; });

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => pool });
  stub(ids.github, {
    isEnabled: () => true,
    getPR: async () => ({ state: 'open', merged: false, draft: true, node_id: 'PR_26', head: { sha: HEAD } }),
    reopenPR: async () => ({}),
    markPrReadyForReview: async (_o, _r, _n, existing) => ({ ...existing, draft: false }),
  });
  stub(ids.staging, {});
  // The change's own run is still checking HEAD, so the route starts no
  // second build after answering.
  stub(ids.pipeline, { hasInFlightHandoffPipeline: () => true });
  stub(ids.docker, {});
  stub(ids.resolver, {
    checkAndResolveConflicts: async () => {},
    resolveAndMaybeRetry: async () => ({ ok: true }),
    isResolving: () => false,
  });
  stub(ids.ws, {
    sendSystemMessage: async () => {},
    pushNotificationToUser() {},
    pushVoteUpdate() {},
    pushSessionUpdate() {},
  });
  stub(ids.activeUsers, {
    getActiveUserStats: async () => ({ active: 1, majority: 1 }),
    isUserActive: async () => true,
    mergeGate,
  });
  stub(ids.notifications, {
    createPrProposedNotifications: async (_pool, args) => {
      calls.proposed.push(args);
      // Nothing more follows a promote that does not notify its owner.
      setTimeout(finished, 30);
      return [];
    },
    createConnectorSubmittedNotification: async (_pool, args) => {
      calls.connector.push(args);
      if (connectorNotify) return connectorNotify(args);
      return [{ id: 901, user_id: args.userId, kind: 'connector_submitted', detail: args.detail }];
    },
    hydrateAndPush: async (_pool, row) => { calls.pushed.push(row); },
    serialize: (x) => x,
  });
  stub(ids.adminApproval, { isAppLocked: async () => false, hasAdminYesVote: async () => true });
  stub(ids.events, { record: () => {}, EVENT_TYPES: { PR_PROMOTED: 'pr_promoted', PR_MERGED: 'pr_merged' } });
  stub(ids.appAccess, { sessionCollabGuard: () => (_req, _res, next) => next() });
  stub(ids.topicAttrs, {});
  stub(ids.visuals, {
    setChecksPending: async () => true,
    notifyChecksPending() {},
    captureForSession: async () => {},
  });
  stub(ids.prImportSync, { rerunChecksForNewHead: async () => {} });

  delete require.cache[ids.subject];
  const { voteRoutes } = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { voteRoutes, calls, done, restore };
}

// `as` is how the request was authenticated, set the way the real auth
// layers set it: cli-auth.js marks a CLI or connector bearer token
// cliAuthenticated, and a delegated grant (the platform's own agent session)
// carries mcpDelegation as well. A browser session sets neither.
async function promote({ as = 'browser', session = sessionRow, connectorNotify } = {}) {
  const pool = promotePool(session);
  const ctx = loadVotesRouter({ pool, connectorNotify });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 3, username: 'evan' };
    if (as === 'agent' || as === 'delegated') req.cliAuthenticated = true;
    if (as === 'delegated') req.mcpDelegation = { kind: 'agent_mayor' };
    next();
  });
  app.use(ctx.voteRoutes({ jwtSecret: 's', maxUserPromotedSessions: 3 }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/7/promote`, { method: 'POST' });
    const status = response.status;
    if (status === 200) {
      await Promise.race([ctx.done, new Promise((r) => setTimeout(r, 2000))]);
    }
    return { status, calls: ctx.calls };
  } finally {
    server.close();
    ctx.restore();
  }
}

test('an agent that puts its owner\'s change up for the vote tells the owner, once', async () => {
  const { status, calls } = await promote({ as: 'agent' });
  assert.equal(status, 200);
  assert.equal(calls.proposed.length, 1, 'everybody else still hears about it as before');
  assert.deepEqual(calls.connector, [{ userId: 3, appId: 5, sessionId: 7, detail: 'submitted' }],
    'the owner hears it as "Submitted by your agent", the same row submit_work writes');
  assert.equal(calls.pushed.length, 1, 'and the row reaches their open screens');
  assert.equal(calls.pushed[0].id, 901);
});

test('a person pressing Propose is not told about their own click', async () => {
  const { status, calls } = await promote({ as: 'browser' });
  assert.equal(status, 200);
  assert.equal(calls.proposed.length, 1);
  assert.deepEqual(calls.connector, []);
  assert.deepEqual(calls.pushed, []);
});

test('the platform\'s own agent session does not get a second notice', async () => {
  // A delegated grant is cliAuthenticated too; its conversation is where its
  // owner already follows the change, so it is left out.
  const { status, calls } = await promote({ as: 'delegated' });
  assert.equal(status, 200);
  assert.deepEqual(calls.connector, []);
});

test('a refused promote tells nobody anything', async () => {
  const { status, calls } = await promote({ as: 'agent', session: { ...sessionRow, user_id: 99 } });
  assert.equal(status, 404);
  assert.deepEqual(calls.connector, []);
  assert.deepEqual(calls.proposed, []);
});

test('a failing notification never fails a promote that already happened', async () => {
  const { status, calls } = await promote({
    as: 'agent',
    connectorNotify: async () => { throw new Error('notifications table unavailable'); },
  });
  assert.equal(status, 200);
  assert.equal(calls.connector.length, 1);
  assert.deepEqual(calls.pushed, []);
});
