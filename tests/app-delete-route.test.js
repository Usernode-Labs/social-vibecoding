// Issue #1897: DELETE /api/apps/:slug is available to the app creator only
// while they are the app's sole contributor. Full admins keep the existing
// operational override. The route must re-read the shared contributor count
// before any destructive teardown rather than trusting a client payload.

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const teardown = { drops: [], prefixes: [], deletedRows: [] };

stub(require.resolve('../src/services/logger'), {
  info() {}, warn() {}, error() {}, debug() {},
});
stub(require.resolve('../src/services/db-manager'), {
  appDbName: (slug) => `app_${slug}`,
  dropDatabase: async (name) => { teardown.drops.push(name); },
});
stub(require.resolve('../src/services/app-files'), {
  getStore: () => ({
    removeAppPrefix: async (appId) => {
      teardown.prefixes.push(appId);
      return 1;
    },
  }),
});

const poolMod = require('../src/db/pool');
let appRow = null;
let contributorCount = 0;
let contributorReads = 0;

const pool = {
  async query(sql, params = []) {
    const source = String(sql);
    if (/SELECT \* FROM apps WHERE slug = \$1/.test(source)) {
      return { rows: appRow ? [{ ...appRow }] : [] };
    }
    if (/WITH contributor_ids AS/.test(source) && /COUNT\(\*\)::int AS cnt/.test(source)) {
      contributorReads++;
      return contributorCount > 0
        ? { rows: [{ app_id: appRow.id, cnt: contributorCount }] }
        : { rows: [] };
    }
    if (/DELETE FROM apps WHERE id = \$1/.test(source)) {
      teardown.deletedRows.push(params[0]);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  },
};
poolMod.getPool = () => pool;

const { appRoutes } = require('../src/routes/apps');
const express = require('express');

let currentUser = null;
let server;

test.before(async () => {
  const app = express();
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(appRoutes({}));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
});

test.after(() => server && server.close());

test.beforeEach(() => {
  appRow = {
    id: 7,
    slug: 'throwaway',
    created_by: 42,
    runtime_name: null,
    container_id: null,
    runtime_kind: null,
  };
  contributorCount = 1;
  contributorReads = 0;
  teardown.drops.length = 0;
  teardown.prefixes.length = 0;
  teardown.deletedRows.length = 0;
});

async function remove() {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/throwaway`, {
    method: 'DELETE',
  });
  return { status: res.status, body: await res.json() };
}

function assertNoTeardown() {
  assert.deepEqual(teardown.drops, []);
  assert.deepEqual(teardown.prefixes, []);
  assert.deepEqual(teardown.deletedRows, []);
}

test('the creator can delete while they are the sole contributor', async () => {
  currentUser = { id: 42, username: 'creator', canAdminWrite: false };
  const result = await remove();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true });
  assert.equal(contributorReads, 1, 'eligibility is re-read at mutation time');
  assert.deepEqual(teardown.drops, ['app_throwaway']);
  assert.deepEqual(teardown.prefixes, [7]);
  assert.deepEqual(teardown.deletedRows, [7]);
});

test('the creator is rejected before teardown when another contributor exists', async () => {
  currentUser = { id: 42, username: 'creator', canAdminWrite: false };
  contributorCount = 2;
  const result = await remove();
  assert.equal(result.status, 403);
  assert.match(result.body.error, /sole contributor/);
  assert.equal(contributorReads, 1);
  assertNoTeardown();
});

test('a non-owner is rejected without a contributor scan or teardown', async () => {
  currentUser = { id: 99, username: 'other', canAdminWrite: false };
  const result = await remove();
  assert.equal(result.status, 403);
  assert.equal(contributorReads, 0, 'creator mismatch fails before the aggregate read');
  assertNoTeardown();
});

test('a full admin retains the existing delete override', async () => {
  currentUser = { id: 1, username: 'admin', canAdminWrite: true };
  contributorCount = 8;
  const result = await remove();
  assert.equal(result.status, 200);
  assert.equal(contributorReads, 0, 'the admin override does not need the aggregate');
  assert.deepEqual(teardown.deletedRows, [7]);
});

test('a view-only admin may still delete their own sole-contributor app', async () => {
  currentUser = {
    id: 42,
    username: 'creator',
    isAdmin: true,
    canAdminWrite: false,
    adminReadonly: true,
  };
  const result = await remove();
  assert.equal(result.status, 200);
  assert.equal(contributorReads, 1);
  assert.deepEqual(teardown.deletedRows, [7]);
});
