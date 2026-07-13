// Tests for GET /api/admin/submitted-features (#562) — the platform-wide,
// admin-only list of member-submitted feature requests (kind='general'
// issues) across ALL apps, ranked by up-vote count DESC.
//
// Harness mirrors tests/view-only-admin.test.js: getPool() is swapped for a
// mock BEFORE requiring the route module, and the router is mounted on a
// throwaway Express app whose auth shim sets `req.user` to a role we vary
// per test. The mock interprets the kind/status filter and the inlined
// LIMIT/OFFSET so ordering, filtering, and paging are exercised end-to-end;
// the assertions cover the handler's wiring (gate, response shape, filter
// passthrough, clamping).
//
// Run with: node --test tests/admin-submitted-features.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Canned issue dataset. up/down are the tallies the mock reports; the
// governance kinds must never surface through the endpoint.
const ISSUES = [
  { id: 5, app_id: 1, app_slug: 'alpha', app_name: 'Alpha', kind: 'general',
    status: 'open', up: 7, down: 1, created_at: '2026-07-01T00:00:00.000Z' },
  { id: 4, app_id: 2, app_slug: 'beta', app_name: 'Beta', kind: 'general',
    status: 'open', up: 5, down: 0, created_at: '2026-07-02T00:00:00.000Z' },
  { id: 3, app_id: 3, app_slug: 'gamma', app_name: 'Gamma', kind: 'general',
    status: 'open', up: 3, down: 2, created_at: '2026-07-03T00:00:00.000Z' },
  // Same up_count as id:4 but newer → tie-break by created_at DESC puts it
  // AHEAD of id:4.
  { id: 6, app_id: 1, app_slug: 'alpha', app_name: 'Alpha', kind: 'general',
    status: 'open', up: 5, down: 0, created_at: '2026-07-05T00:00:00.000Z' },
  { id: 2, app_id: 2, app_slug: 'beta', app_name: 'Beta', kind: 'general',
    status: 'closed', up: 4, down: 0, created_at: '2026-06-01T00:00:00.000Z' },
  // A shipped feature: status='completed' is distinct from open/closed and
  // surfaces only under ?status=completed or ?status=all (#565).
  { id: 8, app_id: 3, app_slug: 'gamma', app_name: 'Gamma', kind: 'general',
    status: 'completed', up: 6, down: 0, created_at: '2026-06-15T00:00:00.000Z' },
  // Governance rows — excluded by the kind filter regardless of votes.
  { id: 1, app_id: 1, app_slug: 'alpha', app_name: 'Alpha', kind: 'secret_change',
    status: 'open', up: 9, down: 0, created_at: '2026-07-04T00:00:00.000Z' },
  { id: 7, app_id: 3, app_slug: 'gamma', app_name: 'Gamma', kind: 'close_issue',
    status: 'open', up: 9, down: 0, created_at: '2026-07-04T00:00:00.000Z' },
];

function shape(r) {
  return {
    id: r.id, app_id: r.app_id, github_issue_number: null,
    title: `Feature ${r.id}`, description: 'desc', kind: r.kind, status: r.status,
    created_at: r.created_at, created_by: 100, created_by_username: 'submitter',
    app_slug: r.app_slug, app_name: r.app_name,
    up_count: r.up, down_count: r.down,
  };
}

// Apply the same kind/status filter + ordering the SQL would, so the mock
// is a faithful stand-in for Postgres.
function filtered(status) {
  let rows = ISSUES.filter((r) => r.kind === 'general');
  if (status !== 'all') rows = rows.filter((r) => r.status === status);
  return rows.sort((a, b) =>
    b.up - a.up ||
    new Date(b.created_at) - new Date(a.created_at) ||
    b.id - a.id
  );
}

const poolMod = require('../src/db/pool');
const mockPool = {
  async query(sql, params = []) {
    const s = String(sql);
    // status filter: 'all' when the query carries no status param.
    const status = params.length ? params[0] : 'all';
    if (/COUNT\(\*\)::int AS total/.test(s)) {
      return { rows: [{ total: filtered(status).length }] };
    }
    if (/AS app_slug/.test(s)) {
      const m = s.match(/LIMIT\s+(\d+)\s+OFFSET\s+(\d+)/);
      const limit = m ? parseInt(m[1], 10) : 50;
      const offset = m ? parseInt(m[2], 10) : 0;
      return { rows: filtered(status).slice(offset, offset + limit).map(shape) };
    }
    throw new Error(`unhandled mock SQL: ${s.slice(0, 80)}`);
  },
};
poolMod.getPool = () => mockPool;

const { adminRoutes } = require('../src/routes/admin');
const express = require('express');

const NORMAL = { id: 9, username: 'norm', isAdmin: false, canAdminWrite: false, adminReadonly: false };
const VIEW_ADMIN = { id: 8, username: 'view', isAdmin: true, canAdminWrite: false, adminReadonly: true };
const FULL_ADMIN = { id: 1, username: 'snait', isAdmin: true, canAdminWrite: true, adminReadonly: false };

let currentUser = FULL_ADMIN;
let server;
let base;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (currentUser) req.user = currentUser;
    next();
  });
  app.use(adminRoutes({ jwtSecret: 'test' }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

function getFeatures(qs = '') {
  return fetch(`${base}/api/admin/submitted-features${qs}`).then(async (res) => ({
    status: res.status,
    body: res.status === 200 ? await res.json() : await res.json().catch(() => null),
  }));
}

// For gate assertions we must NOT follow the redirect adminMiddleware
// issues to '/' for a non-admin (fetch would chase it to the SPA home and
// mask the block). `redirect: 'manual'` surfaces the raw reject status.
function getGate(user) {
  currentUser = user;
  return fetch(`${base}/api/admin/submitted-features`, { redirect: 'manual' })
    .then((res) => res.status);
}

// ─── Permission model ─────────────────────────────────────────────

test('full admin (snait) gets 200 and a ranked list', async () => {
  currentUser = FULL_ADMIN;
  const { status, body } = await getFeatures();
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.features));
  assert.ok(body.features.length > 0);
});

test('view-only admin gets 200 (pure read, no requireAdminWrite)', async () => {
  currentUser = VIEW_ADMIN;
  const { status } = await getFeatures();
  assert.equal(status, 200);
});

test('non-admin is blocked (redirected away, not served the list)', async () => {
  // adminMiddleware redirects a non-admin to '/' (3xx); it never reaches
  // the handler, so no feature payload is returned.
  const status = await getGate(NORMAL);
  assert.ok(status >= 300 && status < 400, `expected redirect, got ${status}`);
  currentUser = FULL_ADMIN;
});

test('unauthenticated request is blocked by adminMiddleware', async () => {
  const status = await getGate(null);
  assert.ok(status >= 300 && status < 400, `expected redirect, got ${status}`);
  currentUser = FULL_ADMIN;
});

// ─── Ranking + kind filter ────────────────────────────────────────

test('ordered by up_count DESC, then newest first on ties', async () => {
  currentUser = FULL_ADMIN;
  const { body } = await getFeatures();
  const ups = body.features.map((f) => f.up_count);
  // Non-increasing up-counts.
  for (let i = 1; i < ups.length; i++) assert.ok(ups[i] <= ups[i - 1]);
  // Top row is the 7-vote feature.
  assert.equal(body.features[0].up_count, 7);
  assert.equal(body.features[0].id, 5);
  // Tie on 5 up-votes: the newer id:6 precedes id:4.
  const idx6 = body.features.findIndex((f) => f.id === 6);
  const idx4 = body.features.findIndex((f) => f.id === 4);
  assert.ok(idx6 < idx4, 'newer tied feature ranks first');
});

test('governance kinds (secret_change / close_issue) never appear', async () => {
  currentUser = FULL_ADMIN;
  const { body } = await getFeatures('?status=all');
  for (const f of body.features) assert.equal(f.kind, 'general');
  assert.ok(!body.features.some((f) => f.id === 1 || f.id === 7));
});

test('each row carries app attribution + vote tallies', async () => {
  currentUser = FULL_ADMIN;
  const { body } = await getFeatures();
  const top = body.features[0];
  assert.equal(top.app_slug, 'alpha');
  assert.equal(top.app_name, 'Alpha');
  assert.equal(top.down_count, 1);
  assert.ok('created_by_username' in top);
  assert.ok('github_issue_number' in top);
});

// ─── Status filter ────────────────────────────────────────────────

test('default lists only open features', async () => {
  currentUser = FULL_ADMIN;
  const { body } = await getFeatures();
  assert.ok(body.features.every((f) => f.status === 'open'));
  assert.ok(!body.features.some((f) => f.id === 2)); // the closed one
});

test('?status=all includes the closed feature', async () => {
  currentUser = FULL_ADMIN;
  const { body } = await getFeatures('?status=all');
  assert.ok(body.features.some((f) => f.id === 2 && f.status === 'closed'));
});

test('?status=closed returns only closed', async () => {
  currentUser = FULL_ADMIN;
  const { body } = await getFeatures('?status=closed');
  assert.ok(body.features.length > 0);
  assert.ok(body.features.every((f) => f.status === 'closed'));
});

test('?status=completed returns only completed (shipped) features', async () => {
  currentUser = FULL_ADMIN;
  const { status, body } = await getFeatures('?status=completed');
  assert.equal(status, 200);
  assert.ok(body.features.length > 0);
  assert.ok(body.features.every((f) => f.status === 'completed'));
  // The closed row must NOT leak into the completed view.
  assert.ok(!body.features.some((f) => f.id === 2));
});

test('?status=all includes the completed feature', async () => {
  currentUser = FULL_ADMIN;
  const { body } = await getFeatures('?status=all');
  assert.ok(body.features.some((f) => f.id === 8 && f.status === 'completed'));
});

test('an unrecognized status falls back to open (no 400)', async () => {
  currentUser = FULL_ADMIN;
  const { status, body } = await getFeatures('?status=bogus');
  assert.equal(status, 200);
  assert.ok(body.features.every((f) => f.status === 'open'));
});

// ─── Paging + clamping ────────────────────────────────────────────

test('limit/offset page through the ranking; total ignores the page', async () => {
  currentUser = FULL_ADMIN;
  const full = (await getFeatures('?status=all')).body;
  const page = await getFeatures('?status=all&limit=2&offset=1');
  assert.equal(page.body.limit, 2);
  assert.equal(page.body.offset, 1);
  assert.equal(page.body.features.length, 2);
  // total reflects the full filtered set, not the page size.
  assert.equal(page.body.total, full.features.length);
  // The offset:1 page starts at the 2nd row of the full ranking.
  assert.equal(page.body.features[0].id, full.features[1].id);
});

test('limit is clamped to [1, 200]', async () => {
  currentUser = FULL_ADMIN;
  const hi = await getFeatures('?limit=9999');
  assert.equal(hi.body.limit, 200);
  const lo = await getFeatures('?limit=0');
  assert.equal(lo.body.limit, 1);
  const neg = await getFeatures('?limit=-4');
  assert.equal(neg.body.limit, 1);
});

test('a negative offset is treated as 0', async () => {
  currentUser = FULL_ADMIN;
  const { body } = await getFeatures('?offset=-3');
  assert.equal(body.offset, 0);
});
