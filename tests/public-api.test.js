// Tests for the public read-only apps + contributors API
// (src/routes/public-api.js):
//   - GET /api/public/apps — view-public apps with embedded contributors.
//   - GET /api/public/apps/:slug/contributors — one app's contributors.
//   - the include_wallets opt-out.
//   - 404 (non-disclosure) for view-private / self-hosted / suspended /
//     hidden-status / unknown slugs.
//   - GET /api/public/waitlist/options — the survey definitions plus the
//     configured marketing waitlist URL.
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
const crypto = require('node:crypto');
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
  'app-one': { id: 1, slug: 'app-one', self_hosted: false, view_visibility: 'public', status: 'running', moderation_suspended_at: null },
  'secret-app': { id: 9, slug: 'secret-app', self_hosted: false, view_visibility: 'private', status: 'running', moderation_suspended_at: null },
  'self-app': { id: 10, slug: 'self-app', self_hosted: true, view_visibility: 'public', status: 'running', moderation_suspended_at: null },
  // View-public but left out of the public directory: suspended by
  // moderators, or in one of the hidden statuses.
  'suspended-app': { id: 11, slug: 'suspended-app', self_hosted: false, view_visibility: 'public', status: 'running', moderation_suspended_at: '2026-09-01T00:00:00.000Z' },
  'error-app': { id: 12, slug: 'error-app', self_hosted: false, view_visibility: 'public', status: 'error', moderation_suspended_at: null },
  'creating-app': { id: 13, slug: 'creating-app', self_hosted: false, view_visibility: 'public', status: 'creating', moderation_suspended_at: null },
  'secrets-app': { id: 14, slug: 'secrets-app', self_hosted: false, view_visibility: 'public', status: 'awaiting_secrets', moderation_suspended_at: null },
};

// The published terms row the /api/public/terms/current route returns.
// Same column shape the session-authed twin's newest-published query
// selects (src/routes/topochain/mobile.js termsCurrentHandler). Null here
// means "nothing published" — the 404 branch.
const TERMS_ROW = {
  version: 'v3',
  title: 'Homeroom Terms and conditions',
  terms_link: 'https://example.com/terms/v3',
  published_at: '2026-09-15T00:00:00.000Z',
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
    // Newest published terms version; null rows = nothing published.
    if (/FROM terms_versions\s+WHERE published_at IS NOT NULL/i.test(s)) {
      return { rows: TERMS_ROW ? [{ ...TERMS_ROW }] : [] };
    }
    throw new Error(`unhandled mock SQL: ${s.slice(0, 80)}`);
  }
  return { query, calls };
}

async function startTestServer(pool, config = {}) {
  return withMockPool(pool, async () => {
    const { publicApiRoutes } = require('../src/routes/public-api');
    const app = express();
    app.use(express.json());
    app.use(publicApiRoutes(config));
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

test('contributors: 404 for an app moderators suspended', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { status, body } = await get(srv.baseUrl, '/api/public/apps/suspended-app/contributors');
    assert.equal(status, 404);
    assert.deepEqual(body, { error: 'App not found' });
  } finally { await srv.close(); }
});

test('contributors: 404 for every hidden app status, same body as unknown', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const unknown = await get(srv.baseUrl, '/api/public/apps/nope/contributors');
    for (const slug of ['error-app', 'creating-app', 'secrets-app']) {
      const { status, body } = await get(srv.baseUrl, `/api/public/apps/${slug}/contributors`);
      assert.equal(status, 404, slug);
      assert.deepEqual(body, unknown.body, slug);
    }
  } finally { await srv.close(); }
});

test('contributors: the per-slug read and the directory share one hidden-status list', () => {
  const route = withMockPool(makeMockPool(), () => require('../src/routes/public-api'));
  const directory = require('../src/services/public-app-directory');
  assert.equal(route.HIDDEN_APP_STATUSES, directory.HIDDEN_APP_STATUSES);
  for (const status of directory.HIDDEN_APP_STATUSES) {
    assert.equal(directory.isPublicDirectoryApp({ ...APP_BY_SLUG['app-one'], status }), false, status);
  }
  assert.equal(directory.isPublicDirectoryApp(APP_BY_SLUG['app-one']), true);
  assert.equal(directory.isPublicDirectoryApp(undefined), false);
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

// ─── GET /api/public/waitlist/options ────────────────────────────
//
// There was no route-level test for this endpoint at all: the CORS suite
// mounts a stand-in handler and asserts headers only, and the questions
// suite tests the service beneath it. So the composition the route does —
// the static option maps PLUS a `waitlist_url` built from config — was
// unpinned in both directions. It needs no rows; the pool mock goes unused.

test('waitlist options: the marketing waitlist URL comes from config', async () => {
  const srv = await startTestServer(makeMockPool(), { marketingBaseUrl: 'https://example.test' });
  try {
    const { status, body } = await get(srv.baseUrl, '/api/public/waitlist/options');
    assert.equal(status, 200);
    // Absolute, this deployment's configured origin, no query, no trailing
    // slash. The landing's primary pill is this string, so a client never
    // hardcodes the host.
    assert.equal(body.waitlist_url, 'https://example.test/waitlist');
    // The site's front door rides along, for the landing's "Learn more".
    assert.equal(body.marketing_url, 'https://example.test');
  } finally { await srv.close(); }
});

test('waitlist options: an unconfigured origin still serves a usable URL', async () => {
  // waitlistUrl() is never null — normalizeBaseUrl falls back — so the field
  // is always present and always absolute. A client may rely on that.
  const srv = await startTestServer(makeMockPool());
  try {
    const { body } = await get(srv.baseUrl, '/api/public/waitlist/options');
    assert.equal(body.waitlist_url, 'https://onhomeroom.com/waitlist');
    assert.equal(body.marketing_url, 'https://onhomeroom.com');
  } finally { await srv.close(); }
});

test('waitlist options: the seven question maps are served untouched beside it', async () => {
  // The route spreads publicOptions() into a fresh object, so the added field
  // must not disturb — or mutate — the service's constants.
  const questions = require('../src/services/waitlist-questions');
  // By VALUE, before the request: publicOptions() builds a fresh outer object
  // around the same seven constant maps every call, so holding its return
  // value would be holding the very objects a mutation would change — the
  // comparison below would pass however badly the route misbehaved. The maps
  // are plain string records, so a deep clone is a faithful snapshot.
  const expected = structuredClone(questions.publicOptions());
  const srv = await startTestServer(makeMockPool(), { marketingBaseUrl: 'https://example.test' });
  try {
    const { body } = await get(srv.baseUrl, '/api/public/waitlist/options');
    for (const key of Object.keys(expected)) {
      assert.deepEqual(body[key], expected[key], `${key} no longer matches the service`);
    }
    assert.deepEqual(
      Object.keys(body).sort(),
      [...Object.keys(expected), 'marketing_url', 'waitlist_url'].sort(),
      'the public payload grew or lost a field'
    );
    // And the service's own constants are unmutated by the spread: the live
    // maps still equal the pre-request snapshot.
    assert.deepEqual(questions.publicOptions(), expected);
  } finally { await srv.close(); }
});

test('waitlist options: the never-public fields are still absent', async () => {
  // Mirrors tests/waitlist-questions.test.js's two absence assertions, one
  // level up: `max_invites` is server-side policy and `discovery_detail_labels`
  // belongs to a retired question. Neither may reappear through the route.
  const srv = await startTestServer(makeMockPool());
  try {
    const { body } = await get(srv.baseUrl, '/api/public/waitlist/options');
    assert.equal('max_invites' in body, false);
    assert.equal('discovery_detail_labels' in body, false);
  } finally { await srv.close(); }
});

// ─── GET /api/public/terms/current (#3801) ───────────────────────
//
// The sign-on screens' passive terms notice reads the published terms'
// web address here, signed out — the session-authed twin
// (/challenges-api/terms/current) is not callable anonymously. The route
// must stay a read of public metadata only: the consent state lives on
// the session-authed endpoint, and nothing about it may leak here.

test('terms current: 200 with the published version’s public metadata', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { status, body } = await get(srv.baseUrl, '/api/public/terms/current');
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.deepEqual(body.data, {
      title: 'Homeroom Terms and conditions',
      version: 'v3',
      terms_link: 'https://example.com/terms/v3',
      published_at: '2026-09-15T00:00:00.000Z',
    });
  } finally { await srv.close(); }
});

test('terms current: the payload carries no consent fields', async () => {
  const srv = await startTestServer(makeMockPool());
  try {
    const { body } = await get(srv.baseUrl, '/api/public/terms/current');
    assert.ok(!('consent' in body.data));
    assert.ok(!('id' in body.data), 'the session-authed twin’s id stays off the public wire');
    assert.deepEqual(Object.keys(body.data).sort(),
      ['published_at', 'terms_link', 'title', 'version']);
  } finally { await srv.close(); }
});

test('terms current: 404 when nothing is published', async () => {
  const emptyTermsPool = { query: async () => ({ rows: [] }) };
  const srv = await startTestServer(emptyTermsPool);
  try {
    const { status, body } = await get(srv.baseUrl, '/api/public/terms/current');
    assert.equal(status, 404);
    assert.equal(body.success, false);
    assert.ok(body.error, 'the 404 carries an error sentence');
  } finally { await srv.close(); }
});

test('terms current: runs against real PostgreSQL when one is up', { timeout: 180000 }, async (t) => {
  const { Client } = require('pg');
  const DSN = process.env.TEST_DATABASE_URL
    || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const client = new Client({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await client.connect(); } catch (err) {
    await client.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const schema = `public_terms_${crypto.randomBytes(6).toString('hex')}`;
  t.after(async () => {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end().catch(() => {});
  });
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path = ${schema}`);
  // The columns the route reads, as schema.sql declares them.
  await client.query(`
    CREATE TABLE terms_versions (
      id bigserial PRIMARY KEY,
      version text NOT NULL,
      title text,
      terms_link text,
      published_at timestamptz
    );
  `);
  await client.query(`
    INSERT INTO terms_versions (version, title, terms_link, published_at) VALUES
      ('v1', 'Old terms', 'https://example.com/terms/v1', now() - interval '30 days'),
      ('v2', 'Current terms', 'https://example.com/terms/v2', now() - interval '2 days'),
      ('v3', 'Draft terms', 'https://example.com/terms/v3', NULL);
  `);
  // A single-client pool shim: the handler only calls pool.query.
  const pool = { query: (sql, params) => client.query(sql, params) };
  const srv = await startTestServer(pool);
  try {
    const { status, body } = await get(srv.baseUrl, '/api/public/terms/current');
    assert.equal(status, 200);
    assert.equal(body.success, true);
    // The NEWEST published version — the draft (NULL published_at) and the
    // older published one must both lose to v2.
    assert.equal(body.data.version, 'v2');
    assert.equal(body.data.terms_link, 'https://example.com/terms/v2');
    assert.ok(body.data.published_at, 'published_at rides along as ISO-8601');
    assert.ok(!('consent' in body.data));
  } finally { await srv.close(); }

  // Unpublish everything: the 404 branch, against the same real table.
  await client.query('UPDATE terms_versions SET published_at = NULL');
  const srv2 = await startTestServer(pool);
  try {
    const { status, body } = await get(srv2.baseUrl, '/api/public/terms/current');
    assert.equal(status, 404);
    assert.equal(body.success, false);
  } finally { await srv2.close(); }
});
