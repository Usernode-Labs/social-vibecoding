'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

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
  events: require.resolve('../src/services/events'),
};

let createCalls = 0;
let forkCalls = 0;
let eventCalls = 0;

stub(ids.logger, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
stub(ids.appCreator, { createApp: async () => { createCalls++; } });
stub(ids.appForker, { forkApp: async () => { forkCalls++; } });
stub(ids.caddy, { productionHostname: (slug) => `${slug}.example.test` });
stub(ids.docker, { getHostPort: async () => null });
stub(ids.github, { parseGithubUrl: () => null, isEnabled: () => false });
stub(ids.driftPoller, { checkAndRedeployOne: async () => ({}) });
stub(ids.appSecrets, {});
stub(ids.appManifest, { MAX_APP_NAME_LENGTH: 64 });
stub(ids.renamePr, {});
stub(ids.staging, { rebuildProduction: async () => ({}), MissingSecretsError: class extends Error {} });
stub(ids.events, {
  EVENT_TYPES: { APP_CREATED: 'app_created' },
  record: () => { eventCalls++; },
});

const SOURCE_APP = {
  id: 42,
  name: 'Source',
  slug: 'source-000001',
  repo_url: 'https://github.com/acme/source',
  status: 'running',
  created_by: 8,
  self_hosted: false,
  collab_visibility: 'public',
  view_visibility: 'public',
};

const poolMod = require('../src/db/pool');
let insertHandler = async () => ({ rows: [] });
let insertCalls = [];

poolMod.getPool = () => ({
  query: async (sql, params) => {
    const text = String(sql);
    if (/FROM apps WHERE slug = \$1/.test(text)) {
      return params?.[0] === SOURCE_APP.slug ? { rows: [SOURCE_APP] } : { rows: [] };
    }
    if (/INSERT INTO apps/.test(text)) {
      insertCalls.push({ text, params });
      return insertHandler(text, params);
    }
    return { rows: [], rowCount: 0 };
  },
});

const { appRoutes } = require('../src/routes/apps');
const express = require('express');

function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 7, username: 'creator', canAdminWrite: true };
    next();
  });
  app.use(appRoutes({ maxApps: 0 }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function collision() {
  return Object.assign(new Error('slug collision'), {
    code: '23505',
    constraint: 'apps_slug_key',
  });
}

function row(name, slug, id = 100) {
  return {
    id,
    name,
    slug,
    repo_url: null,
    status: 'creating',
    created_by: 7,
    self_hosted: false,
    collab_visibility: 'public',
    view_visibility: 'public',
  };
}

async function post(server, path, name) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return { res, body: await res.json() };
}

async function withRandom(hexValues, fn) {
  const real = crypto.randomBytes;
  let i = 0;
  crypto.randomBytes = () => Buffer.from(hexValues[i++], 'hex');
  try {
    return await fn();
  } finally {
    crypto.randomBytes = real;
  }
}

function reset() {
  createCalls = 0;
  forkCalls = 0;
  eventCalls = 0;
  insertCalls = [];
}

test('new-app route retries one DB slug collision and runs side effects once',
  { concurrency: false }, async () => {
    reset();
    insertHandler = async (_sql, params) => {
      if (insertCalls.length === 1) throw collision();
      return { rows: [row(params[0], params[1])] };
    };
    const server = await startServer();
    try {
      const { res, body } = await withRandom(['000001', '000002'],
        () => post(server, '/api/apps', 'Same Display Name'));
      assert.equal(res.status, 201);
      assert.equal(body.app.name, 'Same Display Name');
      assert.equal(body.app.slug, 'same-display-name-000002');
      assert.deepEqual(insertCalls.map((c) => c.params[1]), [
        'same-display-name-000001',
        'same-display-name-000002',
      ]);
      assert.equal(createCalls, 1);
      assert.equal(forkCalls, 0);
      assert.equal(eventCalls, 1);
    } finally {
      server.close();
    }
  });

test('fork route uses the same retry contract without renaming the fork',
  { concurrency: false }, async () => {
    reset();
    insertHandler = async (_sql, params) => {
      if (insertCalls.length === 1) throw collision();
      return { rows: [row(params[0], params[1], 101)] };
    };
    const server = await startServer();
    try {
      const { res, body } = await withRandom(['000001', '000002'],
        () => post(server, '/api/apps/source-000001/fork', 'Same Display Name'));
      assert.equal(res.status, 201);
      assert.equal(body.app.name, 'Same Display Name');
      assert.equal(body.app.slug, 'same-display-name-000002');
      assert.equal(insertCalls.length, 2);
      assert.equal(createCalls, 0);
      assert.equal(forkCalls, 1);
      assert.equal(eventCalls, 1);
    } finally {
      server.close();
    }
  });

test('bounded exhaustion returns a truthful transient error and no side effects',
  { concurrency: false }, async () => {
    reset();
    insertHandler = async () => { throw collision(); };
    const server = await startServer();
    try {
      const { res, body } = await withRandom(
        ['000001', '000002', '000003', '000004', '000005'],
        () => post(server, '/api/apps', 'Same Display Name')
      );
      assert.equal(res.status, 503);
      assert.equal(body.code, 'APP_SLUG_UNAVAILABLE');
      assert.match(body.error, /unique app address/i);
      assert.doesNotMatch(body.error, /name already exists/i);
      assert.equal(insertCalls.length, 5);
      assert.equal(createCalls, 0);
      assert.equal(forkCalls, 0);
      assert.equal(eventCalls, 0);
    } finally {
      server.close();
    }
  });

test('a non-slug unique violation is not mislabeled or retried',
  { concurrency: false }, async () => {
    reset();
    insertHandler = async () => {
      throw Object.assign(new Error('other conflict'), {
        code: '23505',
        constraint: 'some_future_unique_key',
      });
    };
    const server = await startServer();
    try {
      const { res, body } = await withRandom(['000001'],
        () => post(server, '/api/apps', 'Same Display Name'));
      assert.equal(res.status, 500);
      assert.equal(body.error, 'Internal server error');
      assert.equal(insertCalls.length, 1);
      assert.equal(createCalls, 0);
      assert.equal(eventCalls, 0);
    } finally {
      server.close();
    }
  });
