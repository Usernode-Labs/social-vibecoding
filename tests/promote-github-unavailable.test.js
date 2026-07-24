// Promote-route mapping of lazy-PR-creation failures (2026-07-24 outage).
//
// POST /api/sessions/:id/promote creates the PR lazily when the session
// doesn't have one. When applyPrMetadata throws:
//   - code 'github_unavailable' (GitHub-side outage) → 503 with an honest
//     "GitHub is failing, wait a few minutes" message that names the HTTP
//     status/request id — NOT the generic "re-run your request" 502 that
//     sent users (and the Mayor) chasing ghosts during the outage.
//   - code 'no_commits' → the existing 409 (unchanged).
//   - anything else / a null result → the existing generic 502 (unchanged).
//
// Same require.cache stubbing pattern as votes-closed-pr-merge.test.js,
// plus an express Router stub that records route registrations so the
// promote handler can be invoked directly. Nothing real spins up.
//
// Run with: node --test tests/promote-github-unavailable.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeGate } = require('../src/services/active-users');

// Express stub: Router() returns a recorder exposing the registered
// handlers keyed as "<METHOD> <path>".
const routes = new Map();
function makeRouterStub() {
  const router = {};
  for (const method of ['use', 'get', 'post', 'put', 'delete', 'patch']) {
    router[method] = (path, ...handlers) => {
      if (typeof path === 'string' && handlers.length) {
        routes.set(`${method.toUpperCase()} ${path}`, handlers[handlers.length - 1]);
      }
      return router;
    };
  }
  return router;
}

const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'express') return { Router: makeRouterStub };
  return _origLoad.call(this, request, ...rest);
};

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function makeRecordingPool(handlers) {
  const queries = [];
  return {
    queries,
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

// A session with no PR yet — promote must create one lazily.
function prLessSessionRow() {
  return {
    id: 7, app_id: 5, user_id: 3, status: 'active', is_headless: false,
    branch_name: 'dev/evan-1', pr_number: null, pr_title: null,
    app_slug: 'whiteboard', app_name: 'Whiteboard',
    repo_url: 'https://github.com/acme/whiteboard',
  };
}

function loadPromote({ applyPrMetadataImpl }) {
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
    stagingRecovery: require.resolve('../src/services/staging-recovery'),
    prMetadata: require.resolve('../src/services/pr-metadata'),
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const pool = makeRecordingPool([
    [/FROM chat_sessions cs JOIN apps a/, [prLessSessionRow()]],
    [/SELECT COUNT\(\*\) AS cnt FROM chat_sessions/, [{ cnt: '0' }]],
    [/FROM chat_session_messages/, [{ content: 'add a thing' }]],
  ]);

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => pool });
  stub(ids.github, {
    isEnabled: () => false,
    describeGithubError: (err) => ({
      status: (err && err.status) || null,
      requestId: (err && err.requestId) || null,
      message: (err && err.message) || 'unknown error',
      data: null,
    }),
  });
  stub(ids.staging, {});
  stub(ids.docker, {});
  stub(ids.resolver, { checkAndResolveConflicts: async () => {}, isResolving: () => false });
  stub(ids.ws, {
    sendSystemMessage: async () => {}, pushNotificationToUser() {},
    pushVoteUpdate() {}, pushSessionUpdate() {},
  });
  stub(ids.activeUsers, { getActiveUserStats: async () => ({ active: 1, majority: 1 }), isUserActive: async () => true, mergeGate });
  stub(ids.notifications, {});
  stub(ids.adminApproval, { isAppLocked: async () => false, hasAdminYesVote: async () => false });
  stub(ids.events, { record: () => {}, EVENT_TYPES: { PR_PROMOTED: 'pr_promoted', PR_MERGED: 'pr_merged' } });
  stub(ids.appAccess, { sessionCollabGuard: () => (_req, _res, next) => next() });
  stub(ids.stagingRecovery, {
    recheckSessionChecks: async () => 'rechecked',
    rebuildSessionStaging: async () => 'skipped',
    stagingNeedsRebuild: async () => false,
  });
  stub(ids.prMetadata, {
    applyPrMetadata: async (args) => applyPrMetadataImpl(args),
  });

  routes.clear();
  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  subject.voteRoutes({ maxUserPromotedSessions: 3 });
  const promote = routes.get('POST /api/sessions/:id/promote');

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { promote, pool, restore };
}

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

const req = { params: { id: '7' }, user: { id: 3, username: 'evan' }, body: {} };

test('github_unavailable → 503 with the honest GitHub-side message (status + request id)', async () => {
  const ctx = loadPromote({
    applyPrMetadataImpl: async () => {
      const e = new Error('GitHub failed to create the PR for acme:whiteboard after 3 attempts (HTTP 500, request id AB36:1).');
      e.code = 'github_unavailable';
      e.status = 500;
      e.requestId = 'AB36:1';
      throw e;
    },
  });
  try {
    assert.ok(ctx.promote, 'promote route registered');
    const res = makeRes();
    await ctx.promote(req, res);
    assert.equal(res.statusCode, 503);
    assert.match(res.body.error, /GitHub is currently failing to create pull requests/);
    assert.match(res.body.error, /HTTP 500 from GitHub/);
    assert.match(res.body.error, /AB36:1/);
    assert.match(res.body.error, /safe on its branch/);
    assert.ok(!/re-run/i.test(res.body.error.replace(/do not re-run.*/i, '')),
      'no "please retry / re-run" framing as the remedy');
  } finally {
    ctx.restore();
  }
});

test('no_commits → the existing honest 409 (unchanged)', async () => {
  const ctx = loadPromote({
    applyPrMetadataImpl: async () => {
      const e = new Error('No commits between main and dev/evan-1 — the branch has no pushed commits.');
      e.code = 'no_commits';
      throw e;
    },
  });
  try {
    const res = makeRes();
    await ctx.promote(req, res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /no committed code on its branch/);
  } finally {
    ctx.restore();
  }
});

test('untyped failure (null result) → the existing generic 502 (unchanged)', async () => {
  const ctx = loadPromote({ applyPrMetadataImpl: async () => null });
  try {
    const res = makeRes();
    await ctx.promote(req, res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body.error, /Could not create the pull request/);
  } finally {
    ctx.restore();
  }
});

test('untyped thrown failure → also the generic 502', async () => {
  const ctx = loadPromote({
    applyPrMetadataImpl: async () => { throw new Error('kaboom'); },
  });
  try {
    const res = makeRes();
    await ctx.promote(req, res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body.error, /Could not create the pull request/);
  } finally {
    ctx.restore();
  }
});

test.after(() => { Module._load = _origLoad; });
