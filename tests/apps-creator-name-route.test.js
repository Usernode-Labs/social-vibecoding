// GET /api/apps: the list payload carries the creator's display name and
// username, so Discover's search can match the person who made an app and
// its rows can show "by Alice" on the meta line. GET /api/apps/:slug is
// untouched — the detail page already names the creator through its
// Contributors card.
//
// Two layers:
//  * a stubbed-pool harness in the shape of
//    tests/apps-last-failure-route.test.js (override getPool before
//    requiring the route module, mount on a real express app, hit it over
//    HTTP) pinning that the two columns ride the serialized payload and
//    that a row whose join missed carries NULLs without a 500;
//  * a real-PostgreSQL test in the shape of tests/app-blocks-postgres.test.js
//    which runs the actual list query — the join and the columns — and so
//    fails if either is dropped. Skipped when no test database answers.
//
// Run with: node --test tests/apps-creator-name-route.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const ids = {
  logger: require.resolve('../src/services/logger'),
  appCreator: require.resolve('../src/services/app-creator'),
  appForker: require.resolve('../src/services/app-forker'),
  caddy: require.resolve('../src/services/caddy'),
  docker: require.resolve('../src/services/docker'),
  github: require.resolve('../src/services/github'),
  driftPoller: require.resolve('../src/services/main-drift-poller'),
  appSecrets: require.resolve('../src/services/app-secrets'),
  appManifest: require.resolve('../src/services/app-manifest'),
  renamePr: require.resolve('../src/services/rename-pr'),
  staging: require.resolve('../src/services/staging'),
};

stub(ids.logger, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
stub(ids.appCreator, { createApp: async () => {} });
stub(ids.appForker, { forkApp: async () => {} });
stub(ids.caddy, { productionHostname: (slug) => `${slug}.example.test` });
stub(ids.docker, { getHostPort: async () => null });
stub(ids.github, { parseGithubUrl: () => null, isEnabled: () => false });
stub(ids.driftPoller, { checkAndRedeployOne: async () => ({}) });
stub(ids.appSecrets, {});
stub(ids.appManifest, { MAX_APP_NAME_LENGTH: 64 });
stub(ids.renamePr, {});
stub(ids.staging, { rebuildProduction: async () => ({}), MissingSecretsError: class extends Error {} });

// ── Stubbed-pool harness ─────────────────────────────────────────────
// getPool is overridden BEFORE the route module is required: routes/apps.js
// destructures it at load time, so the override must be in place first
// (the same order tests/apps-last-failure-route.test.js uses).

const poolMod = require('../src/db/pool');
let listRows = [];
poolMod.getPool = () => ({
  query: async (sql) => {
    const s = String(sql);
    // The stub stands in for the LEFT JOIN users creator: rows carry the
    // creator columns only when the list query actually selects them, so
    // dropping the join from the SQL empties the list rather than passing
    // this test vacuously.
    if (/FROM apps a\b/.test(s) && /creator_username/.test(s)) {
      return { rows: listRows };
    }
    if (/WITH contributor_ids AS/.test(s)) return { rows: [] };
    if (/SELECT app_id FROM app_admins/.test(s)) return { rows: [] };
    if (/SELECT id, name FROM apps WHERE id = ANY/.test(s)) return { rows: [] };
    return { rows: [], rowCount: 0 };
  },
});

const { appRoutes } = require('../src/routes/apps');
const express = require('express');

let currentUser = null;

function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(appRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function makeListRow(over) {
  return {
    id: 7,
    name: 'Chess Arena',
    slug: 'chess-arena',
    repo_url: 'https://github.com/acme/chess-arena',
    container_id: null,
    status: 'running',
    retry_count: 0,
    created_by: 100,
    created_at: '2026-08-01T00:00:00.000Z',
    main_sha: null,
    main_pr_number: null,
    last_deploy_at: '2026-09-01T00:00:00.000Z',
    manifest_snapshot: null,
    last_failure: null,
    locked: false,
    self_hosted: false,
    moderation_suspended_at: null,
    collab_visibility: 'public',
    view_visibility: 'public',
    approver_policy: null,
    approvals_required: 0,
    screenshot_device_scale: null,
    icon_emoji: '♟️',
    icon_image_id: null,
    icon_color: null,
    featured_illustration: null,
    forked_from: null,
    admin_usernames: [],
    directory_review_status: null,
    directory_reviewed_at: null,
    directory_reviewed_sha: null,
    main_check_state: null,
    main_check_sha: null,
    main_check_at: null,
    main_check_detail: null,
    main_check_resumed_sha: null,
    main_check_paused_sha: null,
    release_stall: null,
    db_size_bytes: null,
    db_size_measured_at: null,
    db_storage_cap_bytes: null,
    db_storage_frozen_at: null,
    db_storage_warned_at: null,
    db_storage_grace_until: null,
    demo_mode: false,
    demo_partner_id: null,
    demo_base_sha: null,
    demo_prev_approvals: null,
    community_id: null,
    message_count: 0,
    total_seconds: 0,
    active_users: 12,
    is_favorited: false,
    your_apps_hidden: false,
    favorite_order: null,
    featured: false,
    featured_order: null,
    is_collaborator: false,
    is_member: false,
    member_count: 3,
    audience: 'open',
    last_active_at: null,
    open_prs: 0,
    active_sessions: 0,
    merged_prs: 0,
    merged_prs_recent: 0,
    last_merged_at: null,
    open_issues: 0,
    ...over,
  };
}

async function fetchApps(server) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps`);
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()).apps;
}

test('a row with a resolvable creator carries its username and display name', async () => {
  listRows = [
    makeListRow({ creator_username: 'alice', creator_display_name: 'Alice Wonder' }),
  ];
  currentUser = null;
  const server = await startServer();
  try {
    const apps = await fetchApps(server);
    assert.equal(apps.length, 1);
    assert.equal(apps[0].creator_username, 'alice');
    assert.equal(apps[0].creator_display_name, 'Alice Wonder');
  } finally {
    server.close();
  }
});

test('a row whose creator join misses carries nulls, not a 500', async () => {
  listRows = [
    makeListRow({ id: 8, slug: 'orphan-app', name: 'Orphan App', created_by: null,
      creator_username: null, creator_display_name: null }),
  ];
  currentUser = null;
  const server = await startServer();
  try {
    const apps = await fetchApps(server);
    assert.equal(apps.length, 1, 'the row keeps its place in the list');
    assert.equal(apps[0].slug, 'orphan-app');
    assert.equal(apps[0].creator_username, null);
    assert.equal(apps[0].creator_display_name, null);
  } finally {
    server.close();
  }
});

// ── Real-PostgreSQL test: the query itself ───────────────────────────

test('the list query joins the creator: names come back from the database (PostgreSQL)', async (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { Client, Pool } = require('pg');
  const dsn = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const root = new Client({ connectionString: dsn, connectionTimeoutMillis: 2000 });
  try { await root.connect(); } catch (err) { await root.end().catch(() => {}); return t.skip(`Local test database unavailable: ${err.code}`); }
  const name = `apps_creator_name_test_${process.pid}`;
  let pool, server;
  try {
    await root.query(`CREATE DATABASE ${name}`);
    const url = new URL(dsn); url.pathname = `/${name}`;
    pool = new Pool({ connectionString: url.toString() });
    await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
    const addUser = async (username, displayName) => (await pool.query(
      'INSERT INTO users (username, password, display_name) VALUES ($1, \'unused\', $2) RETURNING id, username, display_name',
      [username, displayName]
    )).rows[0];
    const alice = await addUser('alice', 'Alice Wonder');
    const bob = await addUser('bob', null);
    const addApp = async (slug, createdBy) => (await pool.query(
      `INSERT INTO apps (slug, name, created_by, view_visibility, collab_visibility)
       VALUES ($1, $1, $2, 'public', 'public') RETURNING id, slug`,
      [slug, createdBy]
    )).rows[0];
    await addApp('chess-arena', alice.id);
    await addApp('word-garden', bob.id);
    await addApp('orphan-app', null);

    const web = express();
    web.use(express.json());
    web.use((req, _res, next) => { req.user = null; next(); });
    web.use(appRoutes({}, { pool }));
    server = web.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps`);
    assert.equal(res.status, 200, await res.clone().text());
    const { apps } = await res.json();
    const bySlug = Object.fromEntries(apps.map((a) => [a.slug, a]));
    assert.equal(bySlug['chess-arena'].creator_username, 'alice');
    assert.equal(bySlug['chess-arena'].creator_display_name, 'Alice Wonder');
    assert.equal(bySlug['word-garden'].creator_username, 'bob');
    assert.equal(bySlug['word-garden'].creator_display_name, null,
      'no display name set, the column is null and the client falls back to the username');
    assert.equal(bySlug['orphan-app'].creator_username, null);
    assert.equal(bySlug['orphan-app'].creator_display_name, null,
      'a created_by of NULL is a join miss, answered with nulls, not a crash');
  } finally {
    if (server) server.close();
    if (pool) await pool.end().catch(() => {});
    await root.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await root.end().catch(() => {});
  }
});
