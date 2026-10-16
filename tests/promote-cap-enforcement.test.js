// Enforcement test for the per-user PROMOTED (open-proposal) cap on
// POST /api/sessions/:id/promote (src/routes/votes.js).
//
// Promoted sessions are exempt from the active-session cap (#193 — they're
// un-pausable while their PR is in a vote), so this is the only bound on
// how many open-for-vote PRs one person can hold, each carrying a staging
// preview and vote-panel attention. What's pinned here:
//   1. The ceiling is per-REQUESTER: full platform admins get the raised
//      cap (8 by default), everyone else the base cap (5). Gating is on
//      canAdminWrite, so a view-only admin gets the base cap. The route
//      works the ceiling out and hands it to platform.promoteProposal.
//   2. The proposal machine counts against it under a lock on the owner
//      (R5), and the 429 quotes the number actually enforced.
//   3. The check still runs BEFORE lazy PR creation — an over-cap promote
//      must not open a PR on GitHub it then refuses to put up for vote
//      (review.open, the machine's work, never runs for a refused promote).
//
// Part 1 records what the route hands the machine (require.cache +
// Router-recorder stubs, nothing real spins up). Part 2 runs the promote
// through the platform with a real workflow runtime against the full
// PostgreSQL schema (tests/lib/promote-platform.js).
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/promote-cap-enforcement.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeGate } = require('../src/services/active-users');
const { startPromotePlatform } = require('./lib/promote-platform');

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
const origLoad = Module._load;
Module._load = (function (orig) {
  return function (request, ...rest) {
    if (request === 'express') return { Router: makeRouterStub };
    return orig.call(this, request, ...rest);
  };
})(Module._load);

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// A session with NO PR yet: a promote the machine admits has to create one
// lazily (review.open).
function prLessSessionRow() {
  return {
    id: 7, app_id: 5, user_id: 3, status: 'active', is_headless: false,
    branch_name: 'dev/evan-1', pr_number: null, pr_title: null,
    app_slug: 'whiteboard', app_name: 'Whiteboard',
    repo_url: 'https://github.com/acme/whiteboard',
  };
}

// Loads routes/votes.js with everything stubbed; the proposal machine's
// promote records what the route asks of it.
function loadPromote({ config, status = 'active' }) {
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
    platform: require.resolve('../src/workflow/platform.ts'),
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const promoteCalls = [];
  const pool = {
    async query(sql) {
      if (/FROM chat_sessions cs JOIN apps a/.test(String(sql))) return { rows: [{ ...prLessSessionRow(), status }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => pool });
  stub(ids.github, { isEnabled: () => false });
  stub(ids.staging, {});
  stub(ids.docker, {});
  stub(ids.resolver, { checkAndResolveConflicts: async () => {}, isResolving: () => false });
  stub(ids.ws, { sendSystemMessage: async () => {}, pushNotificationToUser() {}, pushVoteUpdate() {}, pushSessionUpdate() {} });
  stub(ids.activeUsers, { getActiveUserStats: async () => ({ active: 1, majority: 1 }), isUserActive: async () => true, mergeGate });
  stub(ids.notifications, {});
  stub(ids.adminApproval, { isAppLocked: async () => false, hasAdminYesVote: async () => false });
  stub(ids.events, { record: () => {}, EVENT_TYPES: { PR_PROMOTED: 'pr_promoted', PR_MERGED: 'pr_merged' } });
  stub(ids.appAccess, { sessionCollabGuard: () => (_req, _res, next) => next() });
  stub(ids.platform, {
    async promoteProposal(p) {
      promoteCalls.push(p);
      return { status: 429, body: { error: `You already have ${p.cap} changes waiting for approval.` } };
    },
  });

  routes.clear();
  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  subject.voteRoutes(config || {});
  const promote = routes.get('POST /api/sessions/:id/promote');

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { promote, promoteCalls, restore };
}

function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

const USER = { id: 3, username: 'evan' };
const FULL_ADMIN = { id: 3, username: 'evan', isAdmin: true, canAdminWrite: true };
const VIEW_ADMIN = { id: 3, username: 'dfk', isAdmin: true, canAdminWrite: false };

// The ceiling the route hands the machine for `user`.
async function capFor({ user, config, status }) {
  const ctx = loadPromote({ config, status });
  try {
    const res = makeRes();
    await ctx.promote({ params: { id: '7' }, user, body: {} }, res);
    assert.equal(ctx.promoteCalls.length, 1);
    assert.equal(res.statusCode, 429, 'the route answers with the machine\'s reply');
    return ctx.promoteCalls[0];
  } finally {
    ctx.restore();
  }
}

test.after(() => { Module._load = origLoad; });

test('a regular user\'s promote is held to the base cap of 5', async () => {
  assert.equal((await capFor({ user: USER })).cap, 5);
});

test('a full admin\'s promote is held to the raised cap of 8', async () => {
  assert.equal((await capFor({ user: FULL_ADMIN })).cap, 8);
});

test('a view-only admin is held to the base cap of 5 like a regular user', async () => {
  assert.equal((await capFor({ user: VIEW_ADMIN })).cap, 5);
});

test('a tuned promoted cap is handed on per tier', async () => {
  const config = { maxUserPromotedSessions: 2, maxAdminUserPromotedSessions: 4 };
  assert.equal((await capFor({ user: USER, config })).cap, 2);
  assert.equal((await capFor({ user: FULL_ADMIN, config })).cap, 4);
});

test('a paused submission is held to the same cap, named as paused', async () => {
  const call = await capFor({ user: USER, status: 'paused' });
  assert.equal(call.cap, 5);
  assert.equal(call.from, 'paused');
});

// ── Part 2: the machine counts it ────────────────────────────────────────

test('the promoted cap, counted by the proposal machine', { timeout: 120000 }, async (t) => {
  Module._load = origLoad;
  const h = await startPromotePlatform(t, { name: 'wf_promote_cap' });
  if (!h) { t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return; }
  // Lazy creation past the cap reports no commits: the next gate, not the
  // cap; that it was reached at all is what the tests read.
  h.behaviour.applyPrMetadata = async () => {
    throw Object.assign(new Error('stubbed: no GitHub in this test'), { code: 'no_commits' });
  };
  let prs = 1000;
  const upForAVote = async (n) => {
    for (let i = 0; i < n; i++) await h.session({ status: 'promoted', pr: ++prs });
  };

  await t.test('at the cap, refused with 429 quoting the number, and no PR is opened', async () => {
    await upForAVote(5);
    const s = await h.session();
    const res = await h.promote(s, { cap: 5 });
    assert.strictEqual(res.status, 429);
    assert.match(res.body.error, /already have 5 changes waiting for approval/);
    assert.deepEqual(h.calls.applyPrMetadata, [], 'no PR was created on GitHub');
    assert.equal(await h.status(s), 'active');
  });

  await t.test('a paused submission at the cap is refused before touching GitHub too', async () => {
    const s = await h.session({ status: 'paused' });
    const res = await h.promote(s, { cap: 5 });
    assert.strictEqual(res.status, 429);
    assert.deepEqual(h.calls.applyPrMetadata, []);
    assert.equal(await h.status(s), 'paused');
  });

  await t.test('under a raised cap (a full admin\'s 8) the same count is admitted into lazy PR creation', async () => {
    const s = await h.session();
    const res = await h.promote(s, { cap: 8 });
    assert.notStrictEqual(res.status, 429, 'not refused by the per-user cap');
    assert.deepEqual(h.calls.applyPrMetadata, [s.id], 'proceeded into lazy PR creation');
    assert.strictEqual(res.status, 409, 'the stubbed lazy creation reports no commits');
  });

  await t.test('the raised cap is enforced and quoted at its own number', async () => {
    await upForAVote(3);
    const s = await h.session();
    const res = await h.promote(s, { cap: 8 });
    assert.strictEqual(res.status, 429);
    assert.match(res.body.error, /already have 8 changes waiting for approval/);
  });
});
