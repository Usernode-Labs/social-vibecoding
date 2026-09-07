// Route-level regression coverage for issue #1549. A failed fork must retry
// through app-forker, never through the fresh starter-template path, and a
// source that is still being created must be refused before an async fork row
// is inserted.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

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
  lifecycle: require.resolve('../src/services/lifecycle'),
  rateLimits: require.resolve('../src/middleware/rate-limits'),
  pool: require.resolve('../src/db/pool'),
  appsRoute: require.resolve('../src/routes/apps'),
};
for (const id of Object.values(ids)) delete require.cache[id];

let failedApp;
let sourceApp;
let currentUser;
let createCalls;
let forkCalls;
let queries;

stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
stub(ids.appCreator, {
  createApp: async (...args) => { createCalls.push(args); },
});
stub(ids.appForker, {
  forkApp: async (...args) => { forkCalls.push(args); },
  findForkSource: async () => sourceApp,
});
stub(ids.caddy, { productionHostname: (slug) => `${slug}.example.test` });
stub(ids.docker, { getHostPort: async () => null });
stub(ids.github, { parseGithubUrl: () => null, isEnabled: () => false });
stub(ids.driftPoller, { checkAndRedeployOne: async () => ({}) });
stub(ids.appSecrets, {});
const realManifest = require('../src/services/app-manifest');
stub(ids.appManifest, {
  MAX_APP_NAME_LENGTH: 64,
  MAX_APP_SLUG_LENGTH: realManifest.MAX_APP_SLUG_LENGTH,
  buildAppSlug: realManifest.buildAppSlug,
});
stub(ids.renamePr, {});
stub(ids.staging, { rebuildProduction: async () => ({}), MissingSecretsError: class extends Error {} });
stub(ids.lifecycle, { drainGuard: (_req, _res, next) => next() });
stub(ids.rateLimits, {
  appCreateLimiter: (_req, _res, next) => next(),
  issueCreateLimiter: (_req, _res, next) => next(),
});

const pool = {
  async query(sql, params = []) {
    const text = String(sql);
    queries.push({ sql: text, params });
    if (/WHERE slug = \$1 AND status = 'error'/.test(text)) {
      return failedApp && params[0] === failedApp.slug ? { rows: [failedApp] } : { rows: [] };
    }
    if (/SELECT \* FROM apps WHERE slug = \$1/.test(text)) {
      return sourceApp && params[0] === sourceApp.slug ? { rows: [sourceApp] } : { rows: [] };
    }
    return { rows: [], rowCount: 1 };
  },
};
stub(ids.pool, { getPool: () => pool });

delete require.cache[ids.appsRoute];
const { appRoutes } = require(ids.appsRoute);

function app(overrides = {}) {
  return {
    id: 22,
    name: 'Forked App',
    slug: 'forked-app',
    repo_url: null,
    status: 'error',
    retry_count: 0,
    created_by: 5,
    self_hosted: false,
    collab_visibility: 'public',
    view_visibility: 'public',
    forked_from: { appId: 11, slug: 'source-app' },
    ...overrides,
  };
}

function source(overrides = {}) {
  return {
    id: 11,
    name: 'Source App',
    slug: 'source-app',
    repo_url: 'https://github.com/acme/source-app',
    status: 'running',
    created_by: 9,
    self_hosted: false,
    collab_visibility: 'public',
    view_visibility: 'public',
    ...overrides,
  };
}

function startServer() {
  const serverApp = express();
  serverApp.use(express.json());
  serverApp.use((req, _res, next) => { req.user = currentUser; next(); });
  serverApp.use(appRoutes({ maxApps: 0 }));
  return new Promise((resolve) => {
    const server = serverApp.listen(0, () => resolve(server));
  });
}

async function post(server, path, body) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { res, body: await res.json() };
}

test.beforeEach(() => {
  failedApp = app();
  sourceApp = source();
  currentUser = { id: 5, username: 'fork-owner' };
  createCalls = [];
  forkCalls = [];
  queries = [];
});

test('retrying a fork dispatches app-forker with the recorded source', async () => {
  const server = await startServer();
  try {
    const { res, body } = await post(server, '/api/apps/forked-app/retry');
    assert.equal(res.status, 200);
    assert.deepEqual(body, { ok: true });
    assert.equal(forkCalls.length, 1);
    assert.equal(forkCalls[0][1], failedApp);
    assert.equal(forkCalls[0][2], sourceApp);
    assert.equal(createCalls.length, 0, 'a fork must never enter fresh-app template provisioning');
    const reset = queries.find((q) => /retry_count = retry_count \+ 1/.test(q.sql));
    assert.ok(reset);
    assert.match(reset.sql, /last_failure = NULL/,
      'the old generic failure must not survive into the new attempt');
  } finally {
    server.close();
  }
});

test('a copied fork can retry from its independent repo after the source is deleted', async () => {
  failedApp = app({ repo_url: 'https://github.com/usernode-bot/forked-app' });
  sourceApp = null;
  const server = await startServer();
  try {
    const { res } = await post(server, '/api/apps/forked-app/retry');
    assert.equal(res.status, 200);
    assert.equal(forkCalls.length, 1);
    assert.equal(forkCalls[0][2], null,
      'app-forker resumes the already-copied repo without reading a deleted source');
    assert.equal(createCalls.length, 0);
  } finally {
    server.close();
  }
});

test('a missing source stops an uncopied fork retry with an actionable reason', async () => {
  sourceApp = null;
  const server = await startServer();
  try {
    const { res, body } = await post(server, '/api/apps/forked-app/retry');
    assert.equal(res.status, 409);
    assert.match(body.error, /source app.*no longer exists/i);
    assert.equal(forkCalls.length, 0);
    assert.equal(createCalls.length, 0);
    assert.ok(!queries.some((q) => /retry_count = retry_count \+ 1/.test(q.sql)),
      'a retry that cannot start does not consume the retry budget');
  } finally {
    server.close();
  }
});

test('forking a source still being created is refused before a fork row is inserted', async () => {
  failedApp = null;
  sourceApp = source({ status: 'creating' });
  currentUser = { id: 5, username: 'fork-owner', canAdminWrite: true };
  const server = await startServer();
  try {
    const { res, body } = await post(server, '/api/apps/source-app/fork', { name: 'Too Soon' });
    assert.equal(res.status, 409);
    assert.match(body.error, /still being set up/i);
    assert.ok(!queries.some((q) => /INSERT INTO apps/.test(q.sql)));
    assert.equal(forkCalls.length, 0);
  } finally {
    server.close();
  }
});
