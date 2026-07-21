// POST /api/sessions/:id/promote must reconcile the PR's GitHub state
// before flipping the session to 'promoted'. A withdrawn (archived)
// session carries a CLOSED PR; promoting it without a reopen creates a
// proposal that can never merge (session 2398 / PR #26). Now:
//   - closed-unmerged PR → reopened, promote proceeds;
//   - reopen refused → 409 with an actionable error, session NOT promoted;
//   - already-merged PR → 409 (nothing left to vote on);
//   - open PR / transient GET failure → promote proceeds as before.
//
// Drives the real Express router over HTTP with all collaborators stubbed
// via require.cache (same pattern as debug-route.test.js for the HTTP
// side, votes-checks-gate.test.js for the stub set).
//
// Run with: node --test tests/votes-promote-reopen.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { mergeGate } = require('../src/services/active-users');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function makeRecordingPool(handlers) {
  const queries = [];
  return {
    queries,
    issued(re) { return queries.some((q) => re.test(q.sql)); },
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      for (const [re, rows] of handlers) {
        if (re.test(String(sql))) {
          const out = typeof rows === 'function' ? rows(params) : rows;
          return Array.isArray(out) ? { rows: out, rowCount: out.length } : out;
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// One promotable session: active, owned by user 3, PR + title + staging
// already in place (so no lazy PR creation and no staging rebuild fires).
const sessionRow = {
  id: 7, app_id: 5, app_slug: 'widget', app_name: 'Widget',
  repo_url: 'https://github.com/acme/widget', branch_name: 'dev/x-1',
  pr_number: 26, pr_title: 'Native iOS look', pr_url: 'https://github.com/acme/widget/pull/26',
  staging_url: 'https://stage.example', user_id: 3, status: 'active',
};

function promotePool() {
  return makeRecordingPool([
    [/cs\.status = 'active'/, [{ ...sessionRow }]],
    [/COUNT\(\*\) AS cnt FROM chat_sessions/i, [{ cnt: '0' }]],
    [/SET status = 'promoted', promoted_at = NOW\(\)/, []],
  ]);
}

function loadVotesRouter({ getPRImpl, reopenImpl, pool } = {}) {
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
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const getPRCalls = [];
  const reopenCalls = [];
  const systemMessages = [];

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => pool });
  stub(ids.github, {
    isEnabled: () => true,
    getPR: async (owner, repo, pr) => {
      getPRCalls.push({ owner, repo, pr });
      if (!getPRImpl) return { state: 'open', merged: false };
      return getPRImpl(owner, repo, pr);
    },
    reopenPR: async (owner, repo, pr) => {
      reopenCalls.push({ owner, repo, pr });
      if (reopenImpl) return reopenImpl(owner, repo, pr);
      return {};
    },
    // The ready-for-review PATCH goes through a bare installation client.
    getInstallationOctokit: async () => ({ request: async () => ({ data: {} }) }),
  });
  stub(ids.staging, { rebuildProduction: async () => ({ ok: true }), teardownStaging: async () => {} });
  stub(ids.docker, {});
  stub(ids.resolver, {
    checkAndResolveConflicts: async () => {},
    resolveAndMaybeRetry: async () => ({ ok: true }),
    isResolving: () => false,
  });
  stub(ids.ws, {
    sendSystemMessage: async (_pool, _appId, content) => { systemMessages.push(content); },
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
    createPrProposedNotifications: async () => [],
    serialize: (x) => x,
  });
  stub(ids.adminApproval, { isAppLocked: async () => false, hasAdminYesVote: async () => true });
  stub(ids.events, { record: () => {}, EVENT_TYPES: { PR_PROMOTED: 'pr_promoted', PR_MERGED: 'pr_merged' } });
  stub(ids.appAccess, { sessionCollabGuard: () => (_req, _res, next) => next() });
  stub(ids.topicAttrs, {});

  delete require.cache[ids.subject];
  const { voteRoutes } = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { voteRoutes, getPRCalls, reopenCalls, systemMessages, restore };
}

async function withServer({ getPRImpl, reopenImpl } = {}, fn) {
  const pool = promotePool();
  const ctx = loadVotesRouter({ getPRImpl, reopenImpl, pool });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 3, username: 'evan' }; next(); });
  app.use(ctx.voteRoutes({ jwtSecret: 's', maxUserPromotedSessions: 3 }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ ...ctx, pool, base });
  } finally {
    server.close();
    ctx.restore();
  }
}

test('promote: an open PR promotes as before (no reopen call)', async () => {
  await withServer({ getPRImpl: async () => ({ state: 'open', merged: false }) }, async (ctx) => {
    const r = await fetch(`${ctx.base}/api/sessions/7/promote`, { method: 'POST' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.prNumber, 26);
    assert.equal(ctx.reopenCalls.length, 0);
    assert.ok(ctx.pool.issued(/SET status = 'promoted', promoted_at = NOW\(\)/), 'session promoted');
  });
});

test('promote: a closed-unmerged PR is reopened, then promoted', async () => {
  await withServer({ getPRImpl: async () => ({ state: 'closed', merged: false }) }, async (ctx) => {
    const r = await fetch(`${ctx.base}/api/sessions/7/promote`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.deepEqual(ctx.reopenCalls, [{ owner: 'acme', repo: 'widget', pr: 26 }]);
    assert.ok(ctx.pool.issued(/SET status = 'promoted', promoted_at = NOW\(\)/), 'session promoted');
  });
});

test('promote: a closed PR whose reopen is refused → 409, session NOT promoted', async () => {
  await withServer({
    getPRImpl: async () => ({ state: 'closed', merged: false }),
    reopenImpl: async () => { throw new Error('head branch was deleted'); },
  }, async (ctx) => {
    const r = await fetch(`${ctx.base}/api/sessions/7/promote`, { method: 'POST' });
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.match(body.error, /couldn't be reopened/i, 'error explains the reopen failure');
    assert.ok(!ctx.pool.issued(/SET status = 'promoted', promoted_at = NOW\(\)/),
      'a doomed proposal is never promoted');
  });
});

test('promote: an already-merged PR → 409 (nothing left to vote on)', async () => {
  await withServer({ getPRImpl: async () => ({ state: 'closed', merged: true }) }, async (ctx) => {
    const r = await fetch(`${ctx.base}/api/sessions/7/promote`, { method: 'POST' });
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.match(body.error, /already merged/i);
    assert.equal(ctx.reopenCalls.length, 0, 'a merged PR is never reopened');
    assert.ok(!ctx.pool.issued(/SET status = 'promoted', promoted_at = NOW\(\)/));
  });
});

test('promote: a transient PR-state GET failure fails open (promote proceeds)', async () => {
  await withServer({ getPRImpl: async () => { throw new Error('api hiccup'); } }, async (ctx) => {
    const r = await fetch(`${ctx.base}/api/sessions/7/promote`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(ctx.reopenCalls.length, 0);
    assert.ok(ctx.pool.issued(/SET status = 'promoted', promoted_at = NOW\(\)/),
      'a GitHub hiccup must not block promotion');
  });
});
