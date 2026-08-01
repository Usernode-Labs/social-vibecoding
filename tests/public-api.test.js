// Tests for the public read-only apps + contributors API
// (src/routes/public-api.js):
//   - GET /api/public/apps — view-public apps with embedded contributors.
//   - GET /api/public/apps/:slug/contributors — one app's contributors.
//   - the include_wallets opt-out.
//   - 404 (non-disclosure) for view-private / self-hosted / unknown slugs.
//
// Same harness style as tests/leaderboard-users-fields.test.js: the router
// is mounted on a throwaway Express app with NO auth middleware (the real
// gate lives in PUBLIC_PATHS, exercised separately below), and getPool() is
// swapped for an in-memory mock that dispatches on the SQL it sees. The
// app-selection WHERE clause and the contributor UNION live in SQL, so the
// mock returns canned rows for those queries; the assertions cover the
// handler's JS-side wiring (embedding, shaping, include_wallets, 404 paths).
//
// Run with: node --test tests/public-api.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

function withMockPool(mockPool, fn) {
  const poolModulePath = require.resolve('../src/db/pool');
  const original = require.cache[poolModulePath];
  require.cache[poolModulePath] = {
    exports: { getPool: () => mockPool },
    loaded: true,
    id: poolModulePath,
    filename: poolModulePath,
    paths: original ? original.paths : [],
  };
  delete require.cache[require.resolve('../src/routes/public-api')];
  try {
    return fn();
  } finally {
    if (original) require.cache[poolModulePath] = original;
    else delete require.cache[poolModulePath];
    delete require.cache[require.resolve('../src/routes/public-api')];
  }
}

// Canned contributor rows keyed by app id. app 1 has two contributors (one
// with a wallet, one without); app 2 has one.
const CONTRIBUTORS = {
  1: [
    { app_id: 1, user_id: 10, username: 'alice', wallet_address: 'ut1alice0000000000000000000000000000000001' },
    { app_id: 1, user_id: 11, username: 'bob', wallet_address: null },
  ],
  2: [
    { app_id: 2, user_id: 10, username: 'alice', wallet_address: 'ut1alice0000000000000000000000000000000001' },
  ],
};

// View-public apps the list query would return (collab-public + collab-
// private, both view-public). The presentation columns (icon_emoji,
// icon_image_id, anon_shell, active_users) ride the same SELECT — the
// three anon_shell values here cover the requires_login mapping: only a
// positive 'public' classification reads as no-login; 'gated' and
// 'unknown' both fail safe to account-required.
const APPS = [
  {
    id: 1, name: 'App One', slug: 'app-one', status: 'running',
    collab_visibility: 'public', view_visibility: 'public',
    created_at: '2026-06-01T00:00:00.000Z', last_deploy_at: '2026-06-10T00:00:00.000Z',
    icon_emoji: '🎯', icon_image_id: null, anon_shell: 'public', active_users: '5',
  },
  {
    id: 2, name: 'App Two', slug: 'app-two', status: 'running',
    collab_visibility: 'private', view_visibility: 'public',
    created_at: '2026-06-02T00:00:00.000Z', last_deploy_at: '2026-06-09T00:00:00.000Z',
    icon_emoji: null, icon_image_id: 'deadbeefdeadbeefdeadbeefdeadbeef', anon_shell: 'gated', active_users: '0',
  },
  {
    id: 3, name: 'App Three', slug: 'app-three', status: 'running',
    collab_visibility: 'public', view_visibility: 'public',
    created_at: '2026-06-03T00:00:00.000Z', last_deploy_at: '2026-06-08T00:00:00.000Z',
    icon_emoji: null, icon_image_id: null, anon_shell: 'unknown', active_users: '0',
  },
];

// Per-slug resolve table for the contributors route.
const APP_BY_SLUG = {
  'app-one': { id: 1, slug: 'app-one', self_hosted: false, view_visibility: 'public' },
  'secret-app': { id: 9, slug: 'secret-app', self_hosted: false, view_visibility: 'private' },
  'self-app': { id: 10, slug: 'self-app', self_hosted: true, view_visibility: 'public' },
};

function makeMockPool() {
  const calls = [];
  async function query(sql, params = []) {
    const s = String(sql);
    calls.push({ sql: s, params });

    // Apps list query.
    if (/FROM apps/i.test(s) && /last_deploy_at DESC NULLS LAST/i.test(s)) {
      return { rows: APPS.map((a) => ({ ...a })) };
    }
    // Per-slug resolve.
    if (/FROM apps WHERE slug = \$1/i.test(s)) {
      const app = APP_BY_SLUG[params[0]];
      return { rows: app ? [{ ...app }] : [] };
    }
    // Contributor UNION CTE — params[0] is an int[] of app ids.
    if (/contributor_ids/i.test(s)) {
      const ids = params[0] || [];
      const rows = [];
      for (const id of ids) {
        for (const r of CONTRIBUTORS[id] || []) rows.push({ ...r });
      }
      return { rows };
    }
    throw new Error(`unhandled mock SQL: ${s.slice(0, 80)}`);
  }
  return { query, calls };
}

async function startTestServer(pool) {
  return withMockPool(pool, async () => {
    const { publicApiRoutes } = require('../src/routes/public-api');
    const app = express();
    app.use(express.json());
    app.use(publicApiRoutes({}));
    return new Promise((resolve) => {
      const server = app.listen(0, () => {
        resolve({
          baseUrl: `http://127.0.0.1:${server.address().port}`,
          close: () => new Promise((r) => server.close(r)),
        });
      });
    });
  });
}

function get(baseUrl, path) {
  return fetch(`${baseUrl}${path}`).then(async (res) => ({
    status: res.status,
    body: await res.json(),
  }));
}

// ─── GET /api/public/apps ─────────────────────────────────────────

test('apps list: 200 with apps + embedded contributors, wallets by default', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { status, body } = await get(srv.baseUrl, '/api/public/apps');
    assert.equal(status, 200);
    assert.equal(body.apps.length, 3);

    const one = body.apps.find((a) => a.slug === 'app-one');
    assert.equal(one.collab_visibility, 'public');
    assert.equal(one.view_visibility, 'public');
    assert.equal(one.status, 'running');
    assert.equal(one.contributors.length, 2);

    const alice = one.contributors.find((c) => c.username === 'alice');
    const bob = one.contributors.find((c) => c.username === 'bob');
    assert.deepEqual(Object.keys(alice).sort(), ['user_id', 'username', 'wallet_address']);
    assert.equal(alice.wallet_address, 'ut1alice0000000000000000000000000000000001');
    assert.equal(bob.wallet_address, null); // unlinked → explicit null
  } finally { await srv.close(); }
});

test('apps list: both build-visibility statuses appear (collab public + private)', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { body } = await get(srv.baseUrl, '/api/public/apps');
    const statuses = body.apps.map((a) => a.collab_visibility).sort();
    assert.deepEqual(statuses, ['private', 'public', 'public']);
  } finally { await srv.close(); }
});

test('apps list: home-card fields (icon, active_users) and requires_login mapping', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { body } = await get(srv.baseUrl, '/api/public/apps');
    const one = body.apps.find((a) => a.slug === 'app-one');
    const two = body.apps.find((a) => a.slug === 'app-two');
    const three = body.apps.find((a) => a.slug === 'app-three');

    // Icons: emoji passthrough; icon_url server-built from icon_image_id.
    assert.equal(one.icon_emoji, '🎯');
    assert.equal(one.icon_url, null);
    assert.equal(two.icon_emoji, null);
    assert.equal(two.icon_url, '/app-icons/deadbeefdeadbeefdeadbeefdeadbeef');
    assert.equal(three.icon_url, null);

    // active_users: numeric (pg COUNT arrives as a string).
    assert.equal(one.active_users, 5);
    assert.equal(two.active_users, 0);

    // requires_login: only anon_shell='public' reads as open; 'gated'
    // and 'unknown' both fail safe to account-required.
    assert.equal(one.requires_login, false);
    assert.equal(two.requires_login, true);
    assert.equal(three.requires_login, true);

    // The raw probe column never rides the wire shape.
    assert.ok(!('anon_shell' in one));
  } finally { await srv.close(); }
});

test('apps list: include_wallets=0 omits wallet_address everywhere', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { body } = await get(srv.baseUrl, '/api/public/apps?include_wallets=0');
    for (const app of body.apps) {
      for (const c of app.contributors) {
        assert.deepEqual(Object.keys(c).sort(), ['user_id', 'username']);
        assert.ok(!('wallet_address' in c));
      }
    }
  } finally { await srv.close(); }
});

test('apps list: include_wallets=1 (and unset) keeps wallet_address', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    for (const qs of ['', '?include_wallets=1', '?include_wallets=true']) {
      const { body } = await get(srv.baseUrl, `/api/public/apps${qs}`);
      const alice = body.apps[0].contributors.find((c) => c.username === 'alice');
      assert.ok('wallet_address' in alice, `wallet kept for "${qs}"`);
    }
  } finally { await srv.close(); }
});

// ─── GET /api/public/apps/:slug/contributors ─────────────────────

test('contributors: 200 for a view-public app', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { status, body } = await get(srv.baseUrl, '/api/public/apps/app-one/contributors');
    assert.equal(status, 200);
    assert.equal(body.slug, 'app-one');
    assert.equal(body.contributors.length, 2);
    assert.deepEqual(
      body.contributors.map((c) => c.username).sort(),
      ['alice', 'bob']
    );
  } finally { await srv.close(); }
});

test('contributors: include_wallets=0 omits wallet_address', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { body } = await get(srv.baseUrl, '/api/public/apps/app-one/contributors?include_wallets=0');
    for (const c of body.contributors) {
      assert.ok(!('wallet_address' in c));
    }
  } finally { await srv.close(); }
});

test('contributors: 404 for a view-private app (non-disclosure)', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { status } = await get(srv.baseUrl, '/api/public/apps/secret-app/contributors');
    assert.equal(status, 404);
  } finally { await srv.close(); }
});

test('contributors: 404 for a self-hosted app', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { status } = await get(srv.baseUrl, '/api/public/apps/self-app/contributors');
    assert.equal(status, 404);
  } finally { await srv.close(); }
});

test('contributors: 404 for an unknown slug', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { status } = await get(srv.baseUrl, '/api/public/apps/nope/contributors');
    assert.equal(status, 404);
  } finally { await srv.close(); }
});

// ─── Unit tests for the exported helpers ─────────────────────────

test('shapeContributor: wallet included by default, omitted when off', () => {
  const { shapeContributor } = withMockPool(makeMockPool(), () =>
    require('../src/routes/public-api')
  );
  const row = { user_id: 10, username: 'alice', wallet_address: 'ut1abc' };
  assert.deepEqual(shapeContributor(row, true), {
    user_id: 10, username: 'alice', wallet_address: 'ut1abc',
  });
  assert.deepEqual(shapeContributor(row, false), { user_id: 10, username: 'alice' });
  // null wallet surfaces as explicit null when included.
  assert.equal(
    shapeContributor({ user_id: 11, username: 'bob', wallet_address: null }, true).wallet_address,
    null
  );
});

test('loadContributors: groups rows by app id; empty ids → empty map', async () => {
  const pool = makeMockPool();
  const { loadContributors } = withMockPool(pool, () => require('../src/routes/public-api'));
  const empty = await loadContributors(pool, []);
  assert.equal(empty.size, 0);

  const byApp = await loadContributors(pool, [1, 2]);
  assert.deepEqual(byApp.get(1).map((r) => r.username).sort(), ['alice', 'bob']);
  assert.deepEqual(byApp.get(2).map((r) => r.username), ['alice']);
});

// ─── PUBLIC_PATHS wiring ─────────────────────────────────────────

test('the /api/public/ prefix is in the auth middleware allowlist', () => {
  const src = require('node:fs').readFileSync(
    require.resolve('../src/middleware/auth'), 'utf8'
  );
  assert.match(src, /'\/api\/public\/'/);
});
