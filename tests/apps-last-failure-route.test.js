// #416: GET /api/apps/:slug must expose `lastFailure` (reason + build
// log tail) ONLY to involved users — the app's creator, an accepted
// collaborator, or an admin — and must never leak the raw
// `last_failure` column to anyone. Outsiders get today's payload
// exactly (bare status, no failure fields).
//
// Same harness shape as tests/app-icons-route.test.js (override getPool
// before requiring the route module, mount on a real express app, hit
// it over HTTP) plus the require.cache stubs from
// votes-merge-deploy-failed.test.js for the heavy service imports.
//
// Run with: node --test tests/apps-last-failure-route.test.js

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

const poolMod = require('../src/db/pool');
let appRow = null;
let collaboratorIds = new Set();
poolMod.getPool = () => ({
  query: async (sql, params) => {
    const s = String(sql);
    if (/SELECT \* FROM apps WHERE slug = \$1/.test(s)) {
      return appRow ? { rows: [appRow] } : { rows: [] };
    }
    if (/FROM app_collaborators/.test(s)) {
      return collaboratorIds.has(params?.[1]) ? { rows: [{ 1: 1 }] } : { rows: [] };
    }
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

const LAST_FAILURE = {
  stage: 'build',
  reason: 'Build failed: failed to read dockerfile',
  log: 'ERROR: failed to read dockerfile: open Dockerfile: no such file or directory',
  at: '2026-07-01T00:00:00.000Z',
  sha: null,
};

function makeAppRow() {
  return {
    id: 7,
    name: 'Broken Import',
    slug: 'broken-import',
    status: 'error',
    created_by: 100,
    self_hosted: false,
    collab_visibility: 'public',
    view_visibility: 'public',
    manifest_snapshot: null,
    forked_from: null,
    last_failure: { ...LAST_FAILURE },
  };
}

async function fetchApp(server) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/broken-import`);
  assert.equal(res.status, 200);
  return (await res.json()).app;
}

test('creator sees lastFailure; raw last_failure column never rides the payload', async () => {
  appRow = makeAppRow();
  collaboratorIds = new Set();
  currentUser = { id: 100, username: 'creator' };
  const server = await startServer();
  try {
    const app = await fetchApp(server);
    assert.ok(app.lastFailure, 'creator should get lastFailure');
    assert.equal(app.lastFailure.reason, LAST_FAILURE.reason);
    assert.ok(app.lastFailure.log.includes('open Dockerfile'));
    assert.ok(!('last_failure' in app), 'raw column must be stripped');
  } finally {
    server.close();
  }
});

test('accepted collaborator sees lastFailure', async () => {
  appRow = makeAppRow();
  collaboratorIds = new Set([200]);
  currentUser = { id: 200, username: 'collab' };
  const server = await startServer();
  try {
    const app = await fetchApp(server);
    assert.ok(app.lastFailure);
    assert.equal(app.lastFailure.stage, 'build');
  } finally {
    server.close();
  }
});

test('admin sees lastFailure', async () => {
  appRow = makeAppRow();
  collaboratorIds = new Set();
  currentUser = { id: 300, username: 'admin', isAdmin: true };
  const server = await startServer();
  try {
    const app = await fetchApp(server);
    assert.ok(app.lastFailure);
  } finally {
    server.close();
  }
});

test('unrelated viewer gets neither lastFailure nor the raw column', async () => {
  appRow = makeAppRow();
  collaboratorIds = new Set();
  currentUser = { id: 999, username: 'outsider' };
  const server = await startServer();
  try {
    const app = await fetchApp(server);
    assert.equal(app.lastFailure, null);
    assert.ok(!('last_failure' in app), 'raw column must be stripped');
    // Everything else is unchanged for outsiders.
    assert.equal(app.status, 'error');
    assert.equal(app.slug, 'broken-import');
  } finally {
    server.close();
  }
});
