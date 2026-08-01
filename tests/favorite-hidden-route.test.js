// #618: POST /api/apps/:slug/favorite must map a MEMBER's
// favorited=false to a persisted hidden=TRUE opt-out row (membership
// pins the app into "Your apps", so a delete would mean "pinned",
// not "removed"), while a NON-member's favorited=false keeps today's
// row delete. favorited=true is a single upsert that both adds a
// favorite and clears a member's hidden flag. PUT /api/favorites/order
// must never touch `hidden`, and GET /api/apps must pass
// `your_apps_hidden` through as a real boolean.
//
// Same harness shape as tests/apps-last-failure-route.test.js
// (override getPool before requiring the route module, mount on a real
// express app, hit it over HTTP, stub the heavy service imports).
//
// Run with: node --test tests/favorite-hidden-route.test.js

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

// Mock pool: resolves the app-by-slug lookup, answers the
// app_collaborators membership probe from `memberUserIds`, records
// every app_favorites statement in `favQueries`, and serves `listRows`
// for the big GET /api/apps query (matched on its FROM apps a shape).
const poolMod = require('../src/db/pool');
let appRow = null;
let memberUserIds = new Set();
let favQueries = [];
let listRows = [];

const fakeQuery = async (sql, params) => {
  const s = String(sql);
  if (/FROM apps a\b/.test(s)) return { rows: listRows.map((r) => ({ ...r })) };
  if (/FROM apps WHERE slug = \$1/.test(s)) {
    return appRow ? { rows: [{ ...appRow }] } : { rows: [] };
  }
  if (/SELECT id, name FROM apps WHERE id = ANY/.test(s)) return { rows: [] };
  if (/FROM app_collaborators/.test(s)) {
    return memberUserIds.has(params?.[1]) ? { rows: [{ '?column?': 1 }] } : { rows: [] };
  }
  if (/app_favorites/.test(s)) {
    favQueries.push({ sql: s, params });
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
};

poolMod.getPool = () => ({
  query: fakeQuery,
  connect: async () => ({
    query: fakeQuery,
    release: () => {},
  }),
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
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function makeAppRow() {
  return {
    id: 7,
    slug: 'demo-app',
    created_by: 100,
    self_hosted: false,
    collab_visibility: 'public',
    view_visibility: 'public',
  };
}

async function postFavorite(server, favorited) {
  return fetch(`http://127.0.0.1:${server.address().port}/api/apps/demo-app/favorite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ favorited }),
  });
}

test('member favorited=false persists a hidden opt-out row, not a delete', async () => {
  appRow = makeAppRow();
  memberUserIds = new Set([100]);
  favQueries = [];
  currentUser = { id: 100, username: 'creator' };
  const server = await startServer();
  try {
    const res = await postFavorite(server, false);
    assert.equal(res.status, 200);
    assert.equal(favQueries.length, 1);
    const q = favQueries[0];
    assert.match(q.sql, /INSERT INTO app_favorites/, 'upsert, not delete');
    assert.match(q.sql, /hidden = TRUE/, 'hidden flips on');
    assert.match(q.sql, /sort_order = NULL/, 'ordering slot cleared');
    assert.doesNotMatch(q.sql, /DELETE/, 'no delete for members');
    assert.deepEqual(q.params, [7, 100]);
  } finally {
    server.close();
  }
});

test('non-member favorited=false still deletes the favorite row', async () => {
  appRow = makeAppRow();
  memberUserIds = new Set(); // caller is NOT a member
  favQueries = [];
  currentUser = { id: 200, username: 'visitor' };
  const server = await startServer();
  try {
    const res = await postFavorite(server, false);
    assert.equal(res.status, 200);
    assert.equal(favQueries.length, 1);
    assert.match(favQueries[0].sql, /DELETE FROM app_favorites/);
    assert.deepEqual(favQueries[0].params, [7, 200]);
  } finally {
    server.close();
  }
});

test('favorited=true upserts with hidden = FALSE (add + un-hide in one)', async () => {
  appRow = makeAppRow();
  memberUserIds = new Set([100]);
  favQueries = [];
  currentUser = { id: 100, username: 'creator' };
  const server = await startServer();
  try {
    const res = await postFavorite(server, true);
    assert.equal(res.status, 200);
    assert.equal(favQueries.length, 1);
    const q = favQueries[0];
    assert.match(q.sql, /INSERT INTO app_favorites/);
    assert.match(q.sql, /DO UPDATE SET hidden = FALSE/, 'conflict path clears the opt-out');
    assert.deepEqual(q.params, [7, 100]);
  } finally {
    server.close();
  }
});

test('PUT /api/favorites/order never touches hidden', async () => {
  appRow = makeAppRow();
  memberUserIds = new Set([100]);
  favQueries = [];
  currentUser = { id: 100, username: 'creator' };
  const server = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/favorites/order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: ['demo-app'] }),
    });
    assert.equal(res.status, 200);
    assert.ok(favQueries.length >= 1, 'order rewrite ran');
    for (const q of favQueries) {
      assert.doesNotMatch(q.sql, /hidden/i, 'reorder must not set or clear hidden');
    }
  } finally {
    server.close();
  }
});

test('GET /api/apps serves your_apps_hidden as a boolean and hidden rows as not favorited', async () => {
  appRow = null;
  memberUserIds = new Set();
  favQueries = [];
  currentUser = { id: 100, username: 'creator' };
  // Shape mirrors what the real query returns for a member app whose
  // favorites row is hidden=TRUE: the SQL derives is_favorited=false
  // and your_apps_hidden=true.
  listRows = [{
    id: 7,
    slug: 'demo-app',
    name: 'Demo App',
    status: 'error',
    self_hosted: false,
    created_by: 100,
    collab_visibility: 'public',
    view_visibility: 'public',
    manifest_snapshot: null,
    forked_from: null,
    last_failure: null,
    repo_url: null,
    main_sha: null,
    is_favorited: false,
    your_apps_hidden: true,
    favorite_order: null,
    is_collaborator: true,
    open_prs: '0',
    active_sessions: '0',
    open_issues: '0',
    active_users: '0',
  }];
  const server = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps`);
    assert.equal(res.status, 200);
    const { apps } = await res.json();
    assert.equal(apps.length, 1);
    assert.equal(apps[0].your_apps_hidden, true);
    assert.equal(apps[0].is_favorited, false);
  } finally {
    server.close();
    listRows = [];
  }
});
