// Admin featured-apps endpoints — the write side of the home screen's
// "Featured apps" row.
//
//   GET  /api/admin/featured-apps  — read; router-level admin gate ONLY,
//        so a view-only admin can inspect the list (same stance as
//        /limits and /overview).
//   PUT  /api/admin/featured-apps  — requireAdminWrite; a FULL REWRITE
//        from an ordered slug array (the array IS the display order),
//        with every slug resolved up front so an unknown or self-hosted
//        one is a 400 naming the offender rather than a silently
//        shorter list.
//
// Same harness shape as tests/favorite-hidden-route.test.js: override
// getPool before requiring the route module, mount on a real express app,
// hit it over HTTP, stub the heavy service imports.
//
// Run with: node --test tests/featured-apps-route.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const ids = {
  logger: require.resolve('../src/services/logger'),
  limits: require.resolve('../src/services/limits'),
  anthropicCredits: require.resolve('../src/services/anthropic-credits'),
  dbExport: require.resolve('../src/services/db-export'),
  events: require.resolve('../src/services/events'),
  appRollover: require.resolve('../src/services/app-rollover'),
  stagingReap: require.resolve('../src/services/staging-reap'),
  stagingEnv: require.resolve('../src/services/staging-env'),
  clientIp: require.resolve('../src/services/client-ip'),
  lifecycle: require.resolve('../src/services/lifecycle'),
  rateLimits: require.resolve('../src/middleware/rate-limits'),
  adminMw: require.resolve('../src/middleware/admin'),
  status: require.resolve('../src/services/status'),
};

stub(ids.logger, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
stub(ids.limits, {
  KEY_USER: 'user_daily_limit_cents',
  KEY_GLOBAL: 'global_daily_limit_cents',
  KEY_SYSTEM: 'system_tokens_daily_limit_cents',
  getDefaultUserLimitCents: async () => 0,
  getGlobalLimitCents: async () => 0,
  getSystemTokensLimitCents: async () => 0,
  invalidate: () => {},
});
stub(ids.anthropicCredits, {});
stub(ids.dbExport, {});
stub(ids.events, { record: () => {} });
stub(ids.appRollover, {});
stub(ids.stagingReap, {});
stub(ids.stagingEnv, {});
stub(ids.clientIp, { clientIp: () => '127.0.0.1' });
stub(ids.lifecycle, { drainGuard: (_req, _res, next) => next() });
stub(ids.rateLimits, {
  dbExportLimiter: (_req, _res, next) => next(),
  mailTestLimiter: (_req, _res, next) => next(),
  smsTestLimiter: (_req, _res, next) => next(),
  smsTestNumberLimiter: (_req, _res, next) => next(),
  featuredAdminLimiter: (_req, _res, next) => next(),
});
stub(ids.status, { snapshot: async () => ({}) });

// The real gates, minus the session plumbing: adminMiddleware requires an
// admin, requireAdminWrite additionally requires write capability. Keeping
// them as middleware (rather than stubbing them out) is what lets the
// view-only-admin cases below be meaningful.
stub(ids.adminMw, {
  adminMiddleware: (req, res, next) => {
    if (!req.user?.isAdmin) return res.status(403).json({ error: 'Admin only' });
    return next();
  },
  requireAdminWrite: (req, res, next) => {
    if (!req.user?.canAdminWrite) return res.status(403).json({ error: 'View-only admin' });
    return next();
  },
});

// Mock pool. `appsBySlug` resolves the per-slug lookups the PUT does;
// every statement is recorded in `queries` so the full-rewrite sequence
// (BEGIN → DELETE → INSERT×N → COMMIT) can be asserted.
const poolMod = require('../src/db/pool');
let appsBySlug = {};
let featuredRows = [];
let availableRows = [];
let queries = [];
let featuredIds = new Set();
let failFlagUpdate = false;

const fakeQuery = async (sql, params) => {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  queries.push({ sql: s, params });
  if (failFlagUpdate && /^UPDATE apps SET directory_review_status/.test(s)) throw new Error('database unavailable');
  if (/^DELETE FROM featured_apps WHERE app_id = \$1/.test(s)) return { rows: [], rowCount: featuredIds.has(params[0]) ? 1 : 0 };
  if (/^BEGIN|^COMMIT|^ROLLBACK/.test(s)) return { rows: [] };
  if (/SELECT id, self_hosted\b.*FROM apps WHERE slug/.test(s)) {
    const row = appsBySlug[params[0]];
    return row ? { rows: [row] } : { rows: [] };
  }
  if (/FROM featured_apps fa JOIN apps a/.test(s)) return { rows: featuredRows };
  if (/NOT EXISTS \(SELECT 1 FROM featured_apps/.test(s)) return { rows: availableRows };
  return { rows: [], rowCount: 1 };
};

poolMod.getPool = () => ({
  query: fakeQuery,
  connect: async () => ({ query: fakeQuery, release: () => {} }),
});

const { adminRoutes } = require('../src/routes/admin');
const { featuredAdminRoutes } = require('../src/routes/featured-admin');
const express = require('express');

let currentUser = null;

function startServer(routes = adminRoutes) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(routes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

const FULL_ADMIN = { id: 1, username: 'admin', isAdmin: true, canAdminWrite: true };
const VIEW_ONLY = { id: 2, username: 'viewer', isAdmin: true, canAdminWrite: false };

async function put(server, body, endpoint = '/api/admin/featured-apps') {
  const res = await fetch(
    `http://127.0.0.1:${server.address().port}${endpoint}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function reset() {
  queries = [];
  featuredIds = new Set();
  failFlagUpdate = false;
  const ready = { status: 'running', icon_emoji: '🧩', main_sha: 'a'.repeat(40),
    last_deploy_at: '2026-09-01T12:00:00.000Z', directory_review_status: 'unreviewed' };
  appsBySlug = {
    alpha: { ...ready, id: 11, self_hosted: false },
    beta: { ...ready, id: 12, self_hosted: false },
    gamma: { ...ready, id: 13, self_hosted: false },
    'usernode-self': { id: 1, self_hosted: true },
  };
  featuredRows = [];
  availableRows = [];
}

// ── PUT: the happy path is one full rewrite ──────────────────────

test('PUT rewrites the whole list in order, in one transaction', async () => {
  reset();
  currentUser = FULL_ADMIN;
  const server = await startServer();
  try {
    const res = await put(server, { slugs: ['gamma', 'alpha'] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.slugs, ['gamma', 'alpha']);

    const kinds = queries.map((q) => q.sql);
    assert.ok(kinds.some((s) => /^BEGIN/.test(s)), 'transactional');
    assert.ok(kinds.some((s) => /^COMMIT/.test(s)));
    assert.ok(kinds.some((s) => /DELETE FROM featured_apps/.test(s)),
      'full rewrite, not a delta');

    const inserts = queries.filter((q) => /INSERT INTO featured_apps/.test(q.sql));
    assert.equal(inserts.length, 2);
    // Contiguous sort_order in the submitted order, attributed to the
    // acting admin.
    assert.deepEqual(inserts[0].params, [13, 0, FULL_ADMIN.id]);
    assert.deepEqual(inserts[1].params, [11, 1, FULL_ADMIN.id]);
    // The DELETE must precede every INSERT or the rewrite would drop
    // rows it just wrote.
    const delAt = queries.findIndex((q) => /DELETE FROM featured_apps/.test(q.sql));
    const firstInsertAt = queries.findIndex((q) => /INSERT INTO featured_apps/.test(q.sql));
    assert.ok(delAt < firstInsertAt, 'DELETE before INSERTs');
  } finally {
    server.close();
  }
});

test('featuring needs no review: any app with an icon and no flag, whatever it last deployed', async () => {
  currentUser = FULL_ADMIN;
  const server = await startServer();
  try {
    for (const override of [{}, { directory_review_status: 'working' }, { main_sha: 'b'.repeat(40) },
      { last_deploy_at: '2030-01-01T00:00:00.000Z' }, { status: 'error' }]) {
      reset(); Object.assign(appsBySlug.alpha, override);
      const res = await put(server, { slugs: ['alpha'] });
      assert.equal(res.status, 200, JSON.stringify(override));
    }
  } finally { server.close(); }
});

test('featuring refuses a flagged or iconless app, naming it, without rewriting', async () => {
  currentUser = FULL_ADMIN;
  const server = await startServer();
  try {
    for (const [override, reason] of [
      [{ directory_review_status: 'broken' }, /alpha is flagged[\s\S]*Clear the flag/],
      [{ directory_review_status: 'demo' }, /alpha is flagged/],
      [{ icon_emoji: null }, /alpha has no icon/],
    ]) {
      reset(); Object.assign(appsBySlug.alpha, override);
      const res = await put(server, { slugs: ['gamma', 'alpha'] });
      assert.equal(res.status, 400, JSON.stringify(override));
      assert.match(res.body.error, reason);
      assert.ok(queries.some((q) => q.sql === 'ROLLBACK'));
      assert.ok(!queries.some((q) => /DELETE|INSERT/.test(q.sql)));
    }
  } finally { server.close(); }
});

const flag = (server, body, slug = 'alpha') => put(server, body, `/api/admin/apps/${slug}/discover-flag`);

test('flagging needs a write admin and a true or false, before any SQL', async () => {
  reset(); const server = await startServer();
  try {
    for (const user of [null, { id: 3 }, VIEW_ONLY]) {
      currentUser = user;
      assert.equal((await flag(server, { flagged: true })).status, 403);
    }
    currentUser = FULL_ADMIN;
    for (const body of [{}, { flagged: 'true' }, { flagged: 1 }, { status: 'demo' }]) {
      assert.equal((await flag(server, body)).status, 400, JSON.stringify(body));
    }
    assert.equal(queries.length, 0, 'no SQL before authorization and validation');
  } finally { server.close(); }
});

test('flagging hides the app and takes it off the featured list in one transaction; clearing lists it again', async () => {
  currentUser = FULL_ADMIN;
  const server = await startServer();
  try {
    reset(); featuredIds = new Set([11]);
    const res = await flag(server, { flagged: true });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, flagged: true, unfeatured: true });
    assert.ok(queries.some((q) => /FROM apps WHERE slug = \$1 FOR UPDATE/.test(q.sql)), 'under a row lock');
    const update = queries.find((q) => /^UPDATE apps/.test(q.sql));
    assert.deepEqual(update.params, [11, 'broken', true]);
    assert.match(update.sql, /directory_reviewed_sha = NULL/);
    const delAt = queries.findIndex((q) => /^DELETE FROM featured_apps WHERE app_id = \$1/.test(q.sql));
    assert.ok(delAt > 0 && queries[delAt].params[0] === 11);
    assert.equal(queries.at(-1).sql, 'COMMIT');

    reset();
    assert.deepEqual((await flag(server, { flagged: true })).body.unfeatured, false, 'an app not featured stays unfeatured');

    // Clearing touches the flag alone: it does not feature the app again.
    reset();
    assert.deepEqual((await flag(server, { flagged: false })).body, { ok: true, flagged: false, unfeatured: false });
    assert.deepEqual(queries.find((q) => /^UPDATE apps/.test(q.sql)).params, [11, 'unreviewed', false]);
    assert.ok(!queries.some((q) => /featured_apps/.test(q.sql)));

    // A stopped app with no icon can still be flagged.
    reset(); Object.assign(appsBySlug.alpha, { status: 'error', icon_emoji: null, main_sha: null });
    assert.equal((await flag(server, { flagged: true })).status, 200);

    reset();
    assert.equal((await flag(server, { flagged: true }, 'ghost')).status, 404);
    assert.equal((await flag(server, { flagged: true }, 'usernode-self')).status, 404);
    assert.ok(!queries.some((q) => /^UPDATE|^DELETE/.test(q.sql)));
  } finally { server.close(); }
});

test('a failed flag rolls back with a useful error and never reports success', async () => {
  reset(); currentUser = FULL_ADMIN; failFlagUpdate = true;
  const server = await startServer();
  try {
    const res = await flag(server, { flagged: true });
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'Could not save the flag.');
    assert.equal(queries.at(-1).sql, 'ROLLBACK');
    assert.ok(!queries.some((q) => q.sql === 'COMMIT'));
  } finally { server.close(); failFlagUpdate = false; }
});

test('PUT with an empty array clears the list (the row hides for everyone)', async () => {
  reset();
  currentUser = FULL_ADMIN;
  const server = await startServer();
  try {
    const res = await put(server, { slugs: [] });
    assert.equal(res.status, 200);
    assert.ok(queries.some((q) => /DELETE FROM featured_apps/.test(q.sql)));
    assert.equal(queries.filter((q) => /INSERT INTO featured_apps/.test(q.sql)).length, 0);
  } finally {
    server.close();
  }
});

// ── PUT: validation ─────────────────────────────────────────────

test('PUT rejects a non-array, a non-string entry, and an empty slug', async () => {
  reset();
  currentUser = FULL_ADMIN;
  const server = await startServer();
  try {
    assert.equal((await put(server, { slugs: 'alpha' })).status, 400);
    assert.equal((await put(server, {})).status, 400);
    assert.equal((await put(server, { slugs: [42] })).status, 400);
    assert.equal((await put(server, { slugs: ['  '] })).status, 400);
    assert.equal(queries.filter((q) => /featured_apps/.test(q.sql)).length, 0,
      'nothing touched on a rejected body');
  } finally {
    server.close();
  }
});

test('PUT rejects duplicates, naming the offender', async () => {
  reset();
  currentUser = FULL_ADMIN;
  const server = await startServer();
  try {
    const res = await put(server, { slugs: ['alpha', 'beta', 'alpha'] });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Duplicate slug: alpha/);
  } finally {
    server.close();
  }
});

test('PUT rejects an unknown slug and rolls back', async () => {
  reset();
  currentUser = FULL_ADMIN;
  const server = await startServer();
  try {
    const res = await put(server, { slugs: ['alpha', 'ghost'] });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Unknown app: ghost/);
    assert.ok(queries.some((q) => /^ROLLBACK/.test(q.sql)), 'transaction rolled back');
    assert.equal(queries.filter((q) => /DELETE FROM featured_apps/.test(q.sql)).length, 0,
      'the existing list survives a bad request');
  } finally {
    server.close();
  }
});

test('PUT refuses the self-hosted platform row', async () => {
  reset();
  currentUser = FULL_ADMIN;
  const server = await startServer();
  try {
    const res = await put(server, { slugs: ['usernode-self'] });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /platform app cannot be featured/);
    assert.ok(queries.some((q) => /^ROLLBACK/.test(q.sql)));
  } finally {
    server.close();
  }
});

test('PUT enforces the 12-app cap', async () => {
  reset();
  currentUser = FULL_ADMIN;
  const server = await startServer();
  try {
    const slugs = Array.from({ length: 13 }, (_, i) => `app-${i}`);
    const res = await put(server, { slugs });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /At most 12 featured apps/);
    assert.equal(queries.filter((q) => /featured_apps/.test(q.sql)).length, 0);
  } finally {
    server.close();
  }
});

// ── Gates ───────────────────────────────────────────────────────

test('PUT is closed to a view-only admin; GET is open to them', async () => {
  reset();
  const server = await startServer();
  try {
    currentUser = VIEW_ONLY;
    const write = await put(server, { slugs: ['alpha'] });
    assert.equal(write.status, 403, 'requireAdminWrite chained on the write');

    featuredRows = [{
      slug: 'alpha', name: 'Alpha', status: 'running',
      icon_emoji: null, icon_image_id: null, sort_order: 0,
    }];
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/api/admin/featured-apps`
    );
    assert.equal(res.status, 200, 'a pure read stays open to view-only admins');
    const body = await res.json();
    assert.deepEqual(body.featured.map((a) => a.slug), ['alpha']);
  } finally {
    server.close();
  }
});

test('both endpoints are closed to a non-admin', async () => {
  reset();
  currentUser = { id: 9, username: 'nobody' };
  const server = await startServer();
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/admin/featured-apps`;
    assert.equal((await fetch(base)).status, 403);
    assert.equal((await put(server, { slugs: [] })).status, 403);
  } finally {
    server.close();
  }
});

// ── GET shape ───────────────────────────────────────────────────

test('GET returns display-ordered featured rows plus what is available', async () => {
  reset();
  currentUser = FULL_ADMIN;
  featuredRows = [
    { ...appsBySlug.alpha, slug: 'alpha', name: 'Alpha', icon_emoji: '🎯', icon_image_id: null, sort_order: 0,
      featured_illustration: { url: '/app-illustrations/' + 'f'.repeat(32), zoom: 1, x: 0, y: 0 } },
    { slug: 'beta', name: 'Beta', status: 'running', icon_emoji: null, icon_image_id: 'abc123', sort_order: 1 },
  ];
  availableRows = [
    { slug: 'gamma', name: 'Gamma', status: 'running', icon_emoji: null, icon_image_id: null },
  ];
  const server = await startServer();
  try {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/api/admin/featured-apps`
    );
    const body = await res.json();
    assert.deepEqual(body.featured.map((a) => a.slug), ['alpha', 'beta']);
    assert.equal(body.featured[0].icon_emoji, '🎯');
    // Server-built icon URL — the client never assembles ids into paths.
    assert.equal(body.featured[1].icon_url, '/app-icons/abc123');
    assert.equal(body.featured[0].icon_url, null);
    assert.equal(body.featured[0].directory.tier, 'listed');
    assert.equal(body.featured[0].directory.flagged, false);
    for (const key of ['directory_review_status', 'main_sha', 'last_deploy_at']) {
      assert.equal(key in body.featured[0], false, `${key} is no longer sent`);
    }
    assert.equal(body.available[0].directory.state, 'missing_icon');
    assert.deepEqual(body.available.map((a) => a.slug), ['gamma']);
    // #2615: whether Discover has art for the card, as a boolean only.
    assert.equal(body.featured[0].has_illustration, true);
    assert.equal(body.featured[1].has_illustration, false);
    assert.equal(body.available[0].has_illustration, false);
    assert.equal(body.featured[0].featured_illustration, undefined, 'the record itself is not echoed');
  } finally {
    server.close();
  }
});

// ── The connector's doors (routes/featured-admin.js) ─────────────
//
// A full admin's connector session reaches the same handlers through
// /api/featured-admin/*, since a connector token never reaches /api/admin.
// The door adds its own gate (full admins only, the read included) and hands
// the request on at the console's path.

async function call(server, method, endpoint, body) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('the connector\'s doors hand on to the console\'s own handlers for a full admin', async () => {
  reset();
  featuredRows = [{ slug: 'alpha', name: 'Alpha', status: 'running', icon_emoji: '🧩', sort_order: 0 }];
  availableRows = [{ slug: 'beta', name: 'Beta', status: 'running', icon_emoji: '🧩' }];
  currentUser = FULL_ADMIN;
  const server = await startServer(featuredAdminRoutes);
  try {
    const read = await call(server, 'GET', '/api/featured-admin/featured-apps');
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.featured.map((r) => r.slug), ['alpha']);
    assert.deepEqual(read.body.available.map((r) => r.slug), ['beta']);
    assert.equal(read.body.featured[0].directory.tier, 'listed', 'with where it stands, as the console shows it');

    queries = [];
    const set = await call(server, 'PUT', '/api/featured-admin/featured-apps', { slugs: ['gamma', 'alpha'] });
    assert.equal(set.status, 200);
    assert.deepEqual(set.body.slugs, ['gamma', 'alpha']);
    assert.deepEqual(queries.filter((q) => /INSERT INTO featured_apps/.test(q.sql)).map((q) => q.params), [[13, 0, 1], [11, 1, 1]]);
    // The console's own rules: a flagged app is refused, naming it.
    appsBySlug.beta.directory_review_status = 'broken';
    const refused = await call(server, 'PUT', '/api/featured-admin/featured-apps', { slugs: ['beta'] });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /beta is flagged/);

    queries = [];
    const flagged = await call(server, 'PUT', '/api/featured-admin/apps/alpha/discover-flag', { flagged: true });
    assert.equal(flagged.status, 200);
    assert.ok(queries.some((q) => /^UPDATE apps SET directory_review_status/.test(q.sql) && q.params[1] === 'broken'));
  } finally {
    server.close();
  }
});

test('the doors are closed to a view-only admin, the read included, and open nothing else', async () => {
  reset();
  currentUser = VIEW_ONLY;
  let server = await startServer(featuredAdminRoutes);
  try {
    assert.equal((await call(server, 'GET', '/api/featured-admin/featured-apps')).status, 403);
    assert.equal((await call(server, 'PUT', '/api/featured-admin/featured-apps', { slugs: [] })).status, 403);
    assert.equal((await call(server, 'PUT', '/api/featured-admin/apps/alpha/discover-flag', { flagged: true })).status, 403);
    assert.ok(!queries.some((q) => /featured_apps|directory_review/.test(q.sql)), 'no query ran');
  } finally {
    server.close();
  }
  currentUser = FULL_ADMIN;
  server = await startServer(featuredAdminRoutes);
  try {
    // Only the three doors: the console's path itself is not served here.
    assert.equal((await call(server, 'GET', '/api/featured-admin/apps/alpha/discover-flag')).status, 404);
    assert.equal((await call(server, 'PUT', '/api/featured-admin/apps/alpha/directory-review', { status: 'demo' })).status, 404,
      'the review route is gone');
    assert.equal((await call(server, 'GET', '/api/admin/featured-apps')).status, 404);
  } finally {
    server.close();
  }
});

// ── Source pins: the queries exclude the self-app on both sides ──

test('both queries exclude the self-hosted row', () => {
  // The handlers live in their own module, mounted by admin.js behind its
  // adminMiddleware and by the connector's doors (routes/featured-admin.js).
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/routes/admin-featured-apps.js'), 'utf8');
  const block = src.slice(
    src.indexOf("router.get('/api/admin/featured-apps'"),
    src.indexOf('// Flag an app, or clear its flag.')
  );
  assert.ok(block.length > 500, 'located the featured-apps read');
  assert.equal((block.match(/NOT a\.self_hosted/g) || []).length, 2,
    'featured list and available list both filter it out');
  const admin = fs.readFileSync(path.join(__dirname, '..', 'src/routes/admin.js'), 'utf8');
  assert.ok(admin.indexOf("router.use('/api/admin', adminMiddleware);") < admin.indexOf('router.use(featuredAppsAdminRoutes(pool));'),
    'admin.js mounts them behind its admin gate');
});

// ── Admin console section ────────────────────────────────────────

test('the console carries a Featured apps section under Platform', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'frontend/src/features/admin/admin-console.js'), 'utf8'
  );
  const sections = src.slice(src.indexOf('SECTIONS: ['), src.indexOf('isOpen()'));
  assert.match(sections,
    /\{ key: 'featured-apps', label: 'Featured apps', group: 'Platform' \}/);
  // `features` is "Submitted features" — a different section entirely.
  assert.match(sections, /\{ key: 'features', label: 'Submitted features'/);
  // The section moved out of the chassis into its own module in #1120 slice
  // 18, so the dispatch is a SECTION_MODULES entry rather than a switch arm.
  assert.match(src, /'featured-apps': 'AdminFeaturedApps'/);
});

test('the section gates its mutating controls on canWrite', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'frontend/src/features/admin/admin-featured-apps.tsx'), 'utf8'
  );
  assert.match(src, /const canWrite = !!\(window as any\)\.AdminConsole\?\.canWrite\(\)/);
  assert.match(src, /admin-featured-save/);
  assert.match(src, /View-only admin/, 'read-only affordance for view-only admins');
  // Every mutating control sits behind the flag: the reorder/remove buttons on
  // each row, and the picker + Add + Save footer.
  assert.match(src, /\{canWrite \? \(\s*<>/, 'the row controls are gated');
  assert.match(src, /\{canWrite \? \(\s*<>\s*<div className="flex flex-wrap items-center gap-2 pt-3/,
    'the picker/Add/Save footer is gated');
  // Save PUTs the ordered slug array — the array IS the display order.
  assert.match(src, /body: JSON\.stringify\(\{ slugs: featured \|\| \[\] \}\)/);
});

// ── "No illustration" badge (#2615) ──────────────────────────────

test('a featured row without a Discover illustration carries a No illustration badge', () => {
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const { NoIllustrationBadge } = loadTsx('frontend/src/features/admin/admin-featured-apps.tsx');
  const missing = renderToHtml(createElement(NoIllustrationBadge, { meta: { slug: 'alpha', has_illustration: false } }));
  assert.match(missing, /data-featured-no-illustration="alpha"/);
  assert.match(missing, />No illustration</);
  assert.equal(renderToHtml(createElement(NoIllustrationBadge, { meta: { slug: 'alpha', has_illustration: true } })), '',
    'absent when the app has an illustration');
  assert.equal(renderToHtml(createElement(NoIllustrationBadge, { meta: { slug: 'alpha' } })), '',
    'absent before the read says either way');

  const src = fs.readFileSync(
    path.join(__dirname, '..', 'frontend/src/features/admin/admin-featured-apps.tsx'), 'utf8'
  );
  assert.match(src, /AdminUI\.badge\.warn/, 'drawn from the console badge recipe');
  assert.match(src, /<NoIllustrationBadge meta=\{m\} \/>/, 'drawn on each featured row');
});
