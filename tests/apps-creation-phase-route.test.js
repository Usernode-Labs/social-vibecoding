// GET /api/apps/:slug must carry `creationPhase` while the app is still
// being created.
//
// The WS broadcast drives the create dialog live, but a page refresh
// mid-creation has no history to replay — the dialog has to be able to
// ASK which step is running. This is that read path. It is read from the
// project's making (services/app-creation-phase.js read: the
// app-creation machine's instance and its setup's steps), so any process
// answers the same; it is null whenever there is nothing to report.
//
// Same harness shape as tests/apps-last-failure-route.test.js — override
// getPool before requiring the route module, mount on a real express
// app, hit it over HTTP.
//
// Run with: node --test tests/apps-creation-phase-route.test.js

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
stub(ids.appCreator, {});
stub(ids.appForker, { findForkSource: async () => null });
stub(ids.caddy, { productionHostname: (slug) => `${slug}.example.test` });
stub(ids.docker, { getHostPort: async () => null });
stub(ids.github, { parseGithubUrl: () => null, isEnabled: () => false });
stub(ids.driftPoller, { checkByHand: async () => ({}) });
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
    if (/FROM apps WHERE slug = \$1/.test(s)) {
      return appRow ? { rows: [appRow] } : { rows: [] };
    }
    if (/FROM app_collaborators/.test(s)) {
      return collaboratorIds.has(params?.[1]) ? { rows: [{ 1: 1 }] } : { rows: [] };
    }
    return { rows: [], rowCount: 0 };
  },
});

// What the making says, per app id (services/app-creation-phase.js read).
const making = new Map();
const phaseId = require.resolve('../src/services/app-creation-phase');
stub(phaseId, { read: async (pool, appId) => (making.has(appId) ? { phase: making.get(appId) } : null), PHASES: [] });
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

function makeAppRow(over) {
  return {
    id: 7,
    name: 'Fresh App',
    slug: 'fresh-app',
    status: 'creating',
    created_by: 100,
    self_hosted: false,
    collab_visibility: 'public',
    view_visibility: 'public',
    manifest_snapshot: null,
    forked_from: null,
    last_failure: null,
    ...over,
  };
}

async function fetchApp(server, slug = 'fresh-app') {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/${slug}`);
  assert.equal(res.status, 200);
  return (await res.json()).app;
}

test('an app mid-creation reports the phase it is actually in', async () => {
  appRow = makeAppRow();
  collaboratorIds = new Set();
  currentUser = { id: 100, username: 'creator' };
  making.set(7, 'build');
  const server = await startServer();
  try {
    const app = await fetchApp(server);
    assert.equal(app.creationPhase, 'build');
  } finally {
    making.clear();
    server.close();
  }
});

test('an app with nothing recorded reports creationPhase null', async () => {
  appRow = makeAppRow();
  collaboratorIds = new Set();
  currentUser = { id: 100, username: 'creator' };
  making.clear();
  const server = await startServer();
  try {
    const app = await fetchApp(server);
    assert.equal(app.creationPhase, null,
      'a restarted process has no phase to report, and that is not an error');
  } finally {
    server.close();
  }
});

test('a finished app never reports a phase, even with a stale store entry', async () => {
  appRow = makeAppRow({ status: 'running' });
  collaboratorIds = new Set();
  currentUser = { id: 100, username: 'creator' };
  // Belt-and-braces: endPhases clears on every terminal path, but the
  // route must not hand a live app a spinning step if one ever leaks.
  making.set(7, 'deploy');
  const server = await startServer();
  try {
    const app = await fetchApp(server);
    assert.equal(app.creationPhase, null);
  } finally {
    making.clear();
    server.close();
  }
});

test('creationPhase is not disclosed to someone who cannot see the app', async () => {
  appRow = makeAppRow({ view_visibility: 'private' });
  collaboratorIds = new Set();
  currentUser = { id: 999, username: 'stranger' };
  making.set(7, 'repository');
  const server = await startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/fresh-app`);
    assert.equal(res.status, 404, 'the visibility gate runs before any payload is built');
  } finally {
    making.clear();
    server.close();
  }
});
