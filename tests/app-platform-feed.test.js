// Tests for the app-facing governance feed (issue #744) —
// GET /api/app-platform/governance/feed in
// src/routes/app-platform-api.js + the appPlatformAuth middleware in
// src/middleware/app-llm-auth.js.
//
// Covers: the auth matrix (private-IP gate, missing/malformed/unknown
// app token, success), token → app scoping (each app only ever sees
// its own rows), row filtering (active/paused/archived never leak),
// the proposed/voting/merging/merged status mapping, gate-derived eta
// (visibility window vs approvals_required clock-off mode), and keyset
// pagination (limit clamp, cursor ordering, has_more, malformed-cursor
// fallback, status filter).
//
// Harness shape: same as tests/apps-last-failure-route.test.js —
// stub the logger, override getPool with an in-memory fixture pool
// BEFORE requiring the route module, mount on a real express app, hit
// it over HTTP (loopback passes the private-IP gate; the non-private
// case uses trust-proxy + X-Forwarded-For). The governance service is
// the REAL one (its SQL runs against the fixture pool); only
// active-users.getActiveUserStats is patched so the electorate is
// deterministic while mergeGate's real window math stays in play.
//
// Run with: node --test tests/app-platform-feed.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

stub(require.resolve('../src/services/logger'), {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
});

const APP_A_TOKEN = 'a'.repeat(64);
const APP_B_TOKEN = 'b'.repeat(64);

const HOUR = 3600 * 1000;
const NOW = Date.now();
const hoursAgo = (h) => new Date(NOW - h * HOUR);

const state = {
  apps: [
    { id: 1, slug: 'tier-lists', llm_proxy_token: APP_A_TOKEN },
    { id: 2, slug: 'game-corner', llm_proxy_token: APP_B_TOKEN },
  ],
  // { app_id, id, status, pr_number, pr_title, pr_summary_md,
  //   created_at, promoted_at, merged_at, votes_required, author }
  sessions: [],
  // session id -> { yes, no }
  votes: new Map(),
  // apps.approver_policy / approvals_required row (per-app)
  governance: { approver_policy: 'anyone', approvals_required: null },
  // getActiveUserStats patch value
  activeStats: { active: 4, majority: 3 },
  lastFeedParams: null,
};

function counts(id) {
  return state.votes.get(id) || { yes: 0, no: 0 };
}

const pool = {
  async query(sql, params) {
    const s = String(sql);
    if (/FROM apps WHERE llm_proxy_token/.test(s)) {
      const app = state.apps.find((a) => a.llm_proxy_token === params[0]);
      return { rows: app ? [app] : [] };
    }
    if (/SELECT approver_policy, approvals_required FROM apps WHERE id/.test(s)) {
      return { rows: [state.governance] };
    }
    if (/FROM app_approvers/.test(s)) {
      return { rows: [] };
    }
    if (/FROM chat_sessions cs/.test(s)) {
      state.lastFeedParams = params;
      const [appId, statuses] = params;
      const hasCursor = params.length === 5;
      const cursor = hasCursor ? { before: new Date(params[2]).getTime(), id: params[3] } : null;
      const limit = hasCursor ? params[4] : params[2];
      const rows = state.sessions
        .filter((r) => r.app_id === appId && statuses.includes(r.status))
        .map((r) => ({
          id: r.id,
          pr_number: r.pr_number ?? null,
          pr_title: r.pr_title ?? null,
          pr_summary_md: r.pr_summary_md ?? null,
          status: r.status,
          promoted_at: r.promoted_at ?? null,
          created_at: r.created_at,
          merged_at: r.merged_at ?? null,
          votes_required: r.votes_required ?? null,
          author: r.author ?? null,
          activity_at: r.merged_at || r.promoted_at || r.created_at,
          yes_count: counts(r.id).yes,
          no_count: counts(r.id).no,
        }))
        .filter((r) => {
          if (!cursor) return true;
          const t = new Date(r.activity_at).getTime();
          return t < cursor.before || (t === cursor.before && r.id < cursor.id);
        })
        .sort((a, b) =>
          (new Date(b.activity_at).getTime() - new Date(a.activity_at).getTime()) || (b.id - a.id))
        .slice(0, limit);
      return { rows };
    }
    return { rows: [], rowCount: 0 };
  },
};

const poolMod = require('../src/db/pool');
poolMod.getPool = () => pool;

// Deterministic electorate; mergeGate / computeGate stay real so the
// eta assertions exercise the actual window math.
const activeUsers = require('../src/services/active-users');
activeUsers.getActiveUserStats = async () => state.activeStats;

const governance = require('../src/services/governance');
const appPlatformApiRoutes = require('../src/routes/app-platform-api');

const express = require('express');

let server;
test.before(async () => {
  const app = express();
  // Trust exactly one proxy hop so the non-private-IP test can spoof
  // its source via X-Forwarded-For; loopback requests without the
  // header keep req.ip = 127.0.0.1 (private → accepted).
  app.set('trust proxy', 1);
  app.use(appPlatformApiRoutes({}));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
});
test.after(() => server?.close());

function feedUrl(qs = '') {
  return `http://127.0.0.1:${server.address().port}/api/app-platform/governance/feed${qs}`;
}

async function getFeed({ token = APP_A_TOKEN, qs = '', headers = {} } = {}) {
  const h = { ...headers };
  if (token != null) h['x-usernode-app-token'] = token;
  const res = await fetch(feedUrl(qs), { headers: h });
  return { status: res.status, body: await res.json() };
}

test.beforeEach(() => {
  state.sessions = [];
  state.votes = new Map();
  state.governance = { approver_policy: 'anyone', approvals_required: null };
  state.activeStats = { active: 4, majority: 3 };
  state.lastFeedParams = null;
  // The governance service TTL-caches per app id — flush between tests.
  governance.invalidateGovernance(1);
  governance.invalidateGovernance(2);
});

// ── Auth matrix ──────────────────────────────────────────────────────

test('non-private source IP is rejected', async () => {
  const { status, body } = await getFeed({ headers: { 'x-forwarded-for': '8.8.8.8' } });
  assert.equal(status, 403);
  assert.equal(body.code, 'forbidden_ip');
});

test('missing app token (the staging-container shape) is rejected', async () => {
  const { status, body } = await getFeed({ token: null });
  assert.equal(status, 401);
  assert.equal(body.code, 'missing_app_token');
});

test('malformed app token is rejected without a lookup', async () => {
  for (const bad of ['deadbeef', 'Z'.repeat(64), 'a'.repeat(63)]) {
    const { status, body } = await getFeed({ token: bad });
    assert.equal(status, 401);
    assert.equal(body.code, 'missing_app_token');
  }
});

test('unknown app token is rejected', async () => {
  const { status, body } = await getFeed({ token: 'f'.repeat(64) });
  assert.equal(status, 401);
  assert.equal(body.code, 'bad_app_token');
});

// ── Scoping ──────────────────────────────────────────────────────────

test('each token only ever sees its own app rows', async () => {
  state.sessions = [
    { app_id: 1, id: 10, status: 'merged', pr_number: 1, pr_title: 'A change',
      created_at: hoursAgo(50), promoted_at: hoursAgo(49), merged_at: hoursAgo(48) },
    { app_id: 2, id: 20, status: 'merged', pr_number: 2, pr_title: 'B change',
      created_at: hoursAgo(50), promoted_at: hoursAgo(49), merged_at: hoursAgo(47) },
  ];
  const a = await getFeed({ token: APP_A_TOKEN });
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.items.map((i) => i.id), [10]);
  const b = await getFeed({ token: APP_B_TOKEN });
  assert.deepEqual(b.body.items.map((i) => i.id), [20]);
});

// ── Row filtering ────────────────────────────────────────────────────

test('active/paused/archived sessions never appear in the feed', async () => {
  state.sessions = [
    { app_id: 1, id: 1, status: 'active', pr_title: 'Private WIP', created_at: hoursAgo(1) },
    { app_id: 1, id: 2, status: 'paused', pr_title: 'Parked', created_at: hoursAgo(2) },
    { app_id: 1, id: 3, status: 'archived', pr_title: 'Auto-rejected', created_at: hoursAgo(3) },
    { app_id: 1, id: 4, status: 'promoted', pr_title: 'Live proposal',
      created_at: hoursAgo(4), promoted_at: hoursAgo(3) },
  ];
  const { body } = await getFeed();
  assert.deepEqual(body.items.map((i) => i.id), [4]);
});

// ── Status mapping ───────────────────────────────────────────────────

test('status maps promoted→proposed/voting, merging, merged', async () => {
  const mergedAt = hoursAgo(1);
  state.sessions = [
    { app_id: 1, id: 5, status: 'promoted', pr_number: 11, pr_title: 'No votes yet',
      created_at: hoursAgo(6), promoted_at: hoursAgo(5) },
    { app_id: 1, id: 6, status: 'promoted', pr_number: 12, pr_title: 'Being voted',
      created_at: hoursAgo(6), promoted_at: hoursAgo(4) },
    { app_id: 1, id: 7, status: 'merging', pr_number: 13, pr_title: 'In pipeline',
      created_at: hoursAgo(6), promoted_at: hoursAgo(3) },
    { app_id: 1, id: 8, status: 'merged', pr_number: 14, pr_title: 'Shipped',
      created_at: hoursAgo(6), promoted_at: hoursAgo(2), merged_at: mergedAt,
      votes_required: 3, author: 'evan' },
  ];
  state.votes.set(6, { yes: 2, no: 1 });
  state.votes.set(7, { yes: 3, no: 0 });
  const { body } = await getFeed();
  const byId = new Map(body.items.map((i) => [i.id, i]));
  assert.equal(byId.get(5).status, 'proposed');
  assert.equal(byId.get(6).status, 'voting');
  assert.equal(byId.get(6).votes_for, 2);
  assert.equal(byId.get(6).votes_against, 1);
  assert.equal(byId.get(7).status, 'merging');
  assert.equal(byId.get(7).eta, null);
  assert.equal(byId.get(8).status, 'merged');
  assert.equal(byId.get(8).merged_at, mergedAt.toISOString());
  assert.equal(byId.get(8).votes_required, 3);
  assert.equal(byId.get(8).author, 'evan');
  assert.equal(byId.get(8).eta, null);
});

test('title falls back to PR #N when pr_title is null', async () => {
  state.sessions = [
    { app_id: 1, id: 9, status: 'promoted', pr_number: 77,
      created_at: hoursAgo(2), promoted_at: hoursAgo(1) },
  ];
  const { body } = await getFeed();
  assert.equal(body.items[0].title, 'PR #77');
  assert.equal(body.items[0].summary_md, null);
});

// ── ETA (gate-derived) ───────────────────────────────────────────────

test('threshold-met proposal inside its visibility window carries the gate eta', async () => {
  // active=5, yes=2, no=0, promoted recently: the eased threshold
  // (floor 2) is met but yes is under a majority, so a multi-day
  // visibility window is still running (the "Merging in ~2d" pill).
  // eta must equal the REAL mergeGate's windowEndsAt for the same
  // inputs — deterministic, since windowEndsAt anchors on promoted_at,
  // not on now.
  state.activeStats = { active: 5, majority: 3 };
  const promotedAt = hoursAgo(3);
  state.sessions = [
    { app_id: 1, id: 30, status: 'promoted', pr_number: 30, pr_title: 'Thin support',
      created_at: hoursAgo(4), promoted_at: promotedAt },
  ];
  state.votes.set(30, { yes: 2, no: 0 });
  const expected = activeUsers.mergeGate(5, 2, 0, promotedAt);
  assert.ok(expected.thresholdMet && expected.windowEndsAt, 'fixture must arm the window');
  const { body } = await getFeed();
  assert.equal(body.items[0].status, 'voting');
  assert.equal(body.items[0].eta, expected.windowEndsAt);
  assert.equal(body.items[0].votes_required, expected.required);
});

test('approvals_required mode has every clock off — eta is null', async () => {
  state.governance = { approver_policy: 'anyone', approvals_required: 2 };
  state.sessions = [
    { app_id: 1, id: 31, status: 'promoted', pr_number: 31, pr_title: 'At-least mode',
      created_at: hoursAgo(4), promoted_at: hoursAgo(3) },
  ];
  state.votes.set(31, { yes: 1, no: 0 });
  const { body } = await getFeed();
  assert.equal(body.items[0].status, 'voting');
  assert.equal(body.items[0].eta, null);
  assert.equal(body.items[0].votes_required, 2);
});

// ── Pagination / limits / filters ────────────────────────────────────

function seedMergedRows(n) {
  for (let i = 1; i <= n; i++) {
    state.sessions.push({
      app_id: 1, id: 100 + i, status: 'merged', pr_number: 100 + i,
      pr_title: `Merged #${i}`, created_at: hoursAgo(100),
      promoted_at: hoursAgo(99), merged_at: hoursAgo(50 - i),
    });
  }
}

test('keyset pagination pages older with has_more + next_cursor', async () => {
  seedMergedRows(5); // ids 101..105; 105 has the most recent merged_at
  const page1 = await getFeed({ qs: '?limit=2' });
  assert.deepEqual(page1.body.items.map((i) => i.id), [105, 104]);
  assert.equal(page1.body.has_more, true);
  const c = page1.body.next_cursor;
  assert.equal(c.before_id, 104);
  const page2 = await getFeed({
    qs: `?limit=2&before=${encodeURIComponent(c.before)}&before_id=${c.before_id}`,
  });
  assert.deepEqual(page2.body.items.map((i) => i.id), [103, 102]);
  assert.equal(page2.body.has_more, true);
  const c2 = page2.body.next_cursor;
  const page3 = await getFeed({
    qs: `?limit=2&before=${encodeURIComponent(c2.before)}&before_id=${c2.before_id}`,
  });
  assert.deepEqual(page3.body.items.map((i) => i.id), [101]);
  assert.equal(page3.body.has_more, false);
  assert.equal(page3.body.next_cursor, null);
});

test('id breaks ties when activity timestamps collide', async () => {
  const t = hoursAgo(10);
  state.sessions = [
    { app_id: 1, id: 40, status: 'merged', pr_title: 'Older id', created_at: t, merged_at: t },
    { app_id: 1, id: 41, status: 'merged', pr_title: 'Newer id', created_at: t, merged_at: t },
  ];
  const page1 = await getFeed({ qs: '?limit=1' });
  assert.deepEqual(page1.body.items.map((i) => i.id), [41]);
  const c = page1.body.next_cursor;
  const page2 = await getFeed({
    qs: `?limit=1&before=${encodeURIComponent(c.before)}&before_id=${c.before_id}`,
  });
  assert.deepEqual(page2.body.items.map((i) => i.id), [40]);
});

test('malformed cursor is ignored (newest page) and limit is clamped', async () => {
  seedMergedRows(3);
  const { body } = await getFeed({ qs: '?before=not-a-date&before_id=abc&limit=99999' });
  assert.deepEqual(body.items.map((i) => i.id), [103, 102, 101]);
  assert.equal(body.has_more, false);
  // Clamp: the SQL fetches MAX_LIMIT+1 rows (look-ahead), never 100000.
  assert.equal(state.lastFeedParams[state.lastFeedParams.length - 1], 51);
  // And a malformed cursor must not have reached the SQL.
  assert.equal(state.lastFeedParams.length, 3);
});

test('status filter narrows to open or merged rows; bogus values mean all', async () => {
  state.sessions = [
    { app_id: 1, id: 50, status: 'promoted', pr_title: 'Open one',
      created_at: hoursAgo(5), promoted_at: hoursAgo(4) },
    { app_id: 1, id: 51, status: 'merging', pr_title: 'Landing',
      created_at: hoursAgo(5), promoted_at: hoursAgo(3) },
    { app_id: 1, id: 52, status: 'merged', pr_title: 'Done',
      created_at: hoursAgo(5), promoted_at: hoursAgo(2), merged_at: hoursAgo(1) },
  ];
  const open = await getFeed({ qs: '?status=open' });
  assert.deepEqual(open.body.items.map((i) => i.id).sort(), [50, 51]);
  const merged = await getFeed({ qs: '?status=merged' });
  assert.deepEqual(merged.body.items.map((i) => i.id), [52]);
  const bogus = await getFeed({ qs: '?status=everything' });
  assert.equal(bogus.body.items.length, 3);
});

// ── Pure helpers ─────────────────────────────────────────────────────

test('feedStatus + dbStatusesFor helpers', () => {
  assert.equal(appPlatformApiRoutes.feedStatus({ status: 'promoted', yes_count: 0, no_count: 0 }), 'proposed');
  assert.equal(appPlatformApiRoutes.feedStatus({ status: 'promoted', yes_count: 0, no_count: 1 }), 'voting');
  assert.equal(appPlatformApiRoutes.feedStatus({ status: 'merging', yes_count: 3, no_count: 0 }), 'merging');
  assert.equal(appPlatformApiRoutes.feedStatus({ status: 'merged', yes_count: 3, no_count: 0 }), 'merged');
  assert.deepEqual(appPlatformApiRoutes.dbStatusesFor('open'), ['promoted', 'merging']);
  assert.deepEqual(appPlatformApiRoutes.dbStatusesFor('merged'), ['merged']);
  assert.deepEqual(appPlatformApiRoutes.dbStatusesFor(undefined), ['promoted', 'merging', 'merged']);
});
