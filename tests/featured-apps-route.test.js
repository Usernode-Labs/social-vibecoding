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
let failReviewUpdate = false;

const fakeQuery = async (sql, params) => {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  queries.push({ sql: s, params });
  if (failReviewUpdate && /^UPDATE apps SET directory_review_status/.test(s)) throw new Error('database unavailable');
  if (/^BEGIN|^COMMIT|^ROLLBACK/.test(s)) return { rows: [] };
  if (/SELECT id, self_hosted, .*FROM apps WHERE slug/.test(s)) {
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
const express = require('express');

let currentUser = null;

function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(adminRoutes({}));
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
  failReviewUpdate = false;
  const ready = { status: 'running', icon_emoji: '🧩', main_sha: 'a'.repeat(40),
    last_deploy_at: '2026-09-01T12:00:00.000Z', directory_review_status: 'working',
    directory_reviewed_at: '2026-09-01T13:00:00.000Z', directory_reviewed_sha: 'a'.repeat(40) };
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

test('featuring rejects unreviewed, stale, demo, broken, unavailable and iconless apps without rewriting', async () => {
  currentUser = FULL_ADMIN;
  const server = await startServer();
  try {
    for (const override of [
      { directory_review_status: 'unreviewed' }, { directory_review_status: 'demo' },
      { directory_review_status: 'broken' }, { status: 'error' }, { icon_emoji: null },
      { main_sha: 'b'.repeat(40) }, { last_deploy_at: '2026-09-02T12:00:00.000Z' },
    ]) {
      reset(); Object.assign(appsBySlug.alpha, override);
      const res = await put(server, { slugs: ['alpha'] });
      assert.equal(res.status, 400, JSON.stringify(override));
      assert.match(res.body.error, /Review alpha/);
      assert.ok(queries.some((q) => q.sql === 'ROLLBACK'));
      assert.ok(!queries.some((q) => /DELETE|INSERT/.test(q.sql)));
    }
  } finally { server.close(); }
});

const review = (server, body, slug = 'alpha') => put(server, body, `/api/admin/apps/${slug}/directory-review`);
const workingReview = () => ({ status: 'working', confirmWorking: true,
  mainSha: appsBySlug.alpha.main_sha, lastDeployAt: appsBySlug.alpha.last_deploy_at });

test('directory reviews require a write admin and explicit working attestation', async () => {
  reset(); const server = await startServer();
  try {
    for (const user of [null, { id: 3 }, VIEW_ONLY]) {
      currentUser = user;
      assert.equal((await review(server, workingReview())).status, 403);
    }
    currentUser = FULL_ADMIN;
    for (const body of [{}, { status: 'ready' }, { status: 'working' }, { status: 'working', confirmWorking: 'true' }]) {
      assert.equal((await review(server, body)).status, 400);
    }
    assert.equal(queries.length, 0, 'no SQL before authorization and validation');
  } finally { server.close(); }
});

test('working review validates the exact deployment, icon and status under a row lock', async () => {
  currentUser = FULL_ADMIN;
  const server = await startServer();
  try {
    for (const override of [{ icon_emoji: null }, { status: 'creating' }, { main_sha: null }]) {
      reset(); Object.assign(appsBySlug.alpha, override);
      assert.equal((await review(server, workingReview())).status, 400);
      assert.ok(!queries.some((q) => /^UPDATE/.test(q.sql)));
    }
    reset();
    for (const override of [{ mainSha: 'b'.repeat(40) }, { lastDeployAt: '2026-09-01T11:00:00Z' },
      { lastDeployAt: 'invalid' }, { lastDeployAt: undefined }]) {
      const res = await review(server, { ...workingReview(), ...override });
      assert.equal(res.status, 409);
      assert.match(res.body.error, /changed while you were reviewing/);
    }
    assert.ok(!queries.some((q) => /^UPDATE/.test(q.sql)));
    assert.equal((await review(server, workingReview(), 'ghost')).status, 404);
    assert.equal((await review(server, workingReview(), 'usernode-self')).status, 404);
    const res = await review(server, workingReview());
    assert.equal(res.status, 200);
    assert.ok(queries.some((q) => /FROM apps WHERE slug = \$1 FOR UPDATE/.test(q.sql)));
    const update = queries.find((q) => /^UPDATE apps/.test(q.sql));
    assert.deepEqual(update.params, [11, 'working']);
    assert.match(update.sql, /ELSE NOW\(\)/);
    assert.match(update.sql, /ELSE main_sha/);
    assert.equal(queries.at(-1).sql, 'COMMIT');
  } finally { server.close(); }
});

test('demo/broken classification and clearing a review do not need a running deployment', async () => {
  currentUser = FULL_ADMIN;
  const server = await startServer();
  try {
    for (const status of ['demo', 'broken', 'unreviewed']) {
      reset(); Object.assign(appsBySlug.alpha, { status: 'error', icon_emoji: null, main_sha: null });
      assert.equal((await review(server, { status })).status, 200);
      const update = queries.find((q) => /^UPDATE apps/.test(q.sql));
      assert.deepEqual(update.params, [11, status]);
      assert.match(update.sql, /WHEN \$2::text = 'unreviewed' THEN NULL/);
    }
  } finally { server.close(); }
});

test('a failed review rolls back with a useful error and never reports success', async () => {
  reset(); currentUser = FULL_ADMIN; failReviewUpdate = true;
  const server = await startServer();
  try {
    const res = await review(server, workingReview());
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'Could not save the directory review.');
    assert.equal(queries.at(-1).sql, 'ROLLBACK');
    assert.ok(!queries.some((q) => q.sql === 'COMMIT'));
  } finally { server.close(); failReviewUpdate = false; }
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
    { ...appsBySlug.alpha, slug: 'alpha', name: 'Alpha', icon_emoji: '🎯', icon_image_id: null, sort_order: 0 },
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
    assert.equal(body.featured[0].directory.tier, 'ready');
    assert.equal(body.featured[0].directory_review_status, 'working');
    assert.equal(body.featured[0].main_sha, appsBySlug.alpha.main_sha);
    assert.equal(body.featured[0].last_deploy_at, appsBySlug.alpha.last_deploy_at);
    assert.equal(body.available[0].directory.state, 'missing_icon');
    assert.deepEqual(body.available.map((a) => a.slug), ['gamma']);
  } finally {
    server.close();
  }
});

// ── Source pins: the queries exclude the self-app on both sides ──

test('both queries exclude the self-hosted row', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/routes/admin.js'), 'utf8');
  const block = src.slice(
    src.indexOf("router.get('/api/admin/featured-apps'"),
    src.indexOf('// ── Anthropic credits')
  );
  assert.ok(block.length > 500, 'located the featured-apps block');
  assert.equal((block.match(/NOT a\.self_hosted/g) || []).length, 2,
    'featured list and available list both filter it out');
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
