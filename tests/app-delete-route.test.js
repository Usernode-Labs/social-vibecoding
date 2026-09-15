// Issue #1897: DELETE /api/apps/:slug is available to the app creator only
// while they are the app's sole contributor. Full admins keep the existing
// operational override. The route must re-read the shared contributor count
// before any destructive teardown rather than trusting a client payload.
//
// Issue #2161 adds, in front of the teardown: a core app (self_hosted, or
// the configured self-app slug) is never deletable, admins included; the
// typed app name is verified server-side; and a shared app refuses a plain
// delete. A full admin may override with acknowledge_shared:true, and the
// other contributors are notified of the attempt and of the deletion.

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

// The contributor set behind `contributorCount`: the creator (42) first, then
// synthetic others, so the notification fan-out has real ids to exclude
// the actor from.
function contributorRows() {
  const rows = [];
  for (let i = 0; i < contributorCount; i++) {
    rows.push({ app_id: appRow.id, user_id: i === 0 ? 42 : 100 + i, username: `u${i}` });
  }
  return rows;
}
const notified = { attempts: [], deletions: [] };

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
    if (/WITH contributor_ids AS/.test(source) && /u\.username/.test(source)) {
      return { rows: contributorRows() };
    }
    if (/INSERT INTO notifications/.test(source) && /'app_delete_attempted'/.test(source)) {
      notified.attempts.push({ appId: params[0], actorId: params[1], recipients: params[2] });
      return { rows: [] };
    }
    if (/INSERT INTO notifications/.test(source) && /'app_deleted'/.test(source)) {
      notified.deletions.push({ actorId: params[0], name: params[1], recipients: params[2] });
      return { rows: [] };
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
  app.use(express.json());
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(appRoutes({ selfAppSlug: 'usernode-2d5619' }));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
});

test.after(() => server && server.close());

test.beforeEach(() => {
  appRow = {
    id: 7,
    slug: 'throwaway',
    name: 'Throwaway',
    created_by: 42,
    self_hosted: false,
    runtime_name: null,
    container_id: null,
    runtime_kind: null,
  };
  contributorCount = 1;
  contributorReads = 0;
  teardown.drops.length = 0;
  teardown.prefixes.length = 0;
  teardown.deletedRows.length = 0;
  notified.attempts.length = 0;
  notified.deletions.length = 0;
});

// The dialog's request: the typed name, plus the shared-app acknowledgement
// when the caller ticks it. `body: null` sends the bare request a script
// would.
async function remove(body = { confirm_name: 'Throwaway' }) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/throwaway`, {
    method: 'DELETE',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
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
  // #2161: the refusal now says why (the old copy was "sole contributor").
  assert.equal(result.body.reason, 'shared');
  assert.match(result.body.error, /cannot delete it alone/);
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

test('a full admin retains the delete override on an unshared app', async () => {
  currentUser = { id: 1, username: 'admin', canAdminWrite: true };
  contributorCount = 1;
  const result = await remove();
  assert.equal(result.status, 200);
  assert.equal(contributorReads, 1, 'the count decides whether the app is shared');
  assert.deepEqual(teardown.deletedRows, [7]);
  assert.deepEqual(notified.deletions, [], 'nobody else to tell');
});

// ── #2161 ──────────────────────────────────────────────────────────────

test('a core app is never deletable, full admin included (#2161)', async () => {
  currentUser = { id: 1, username: 'admin', canAdminWrite: true };
  appRow.self_hosted = true;
  let result = await remove();
  assert.equal(result.status, 403);
  assert.equal(result.body.reason, 'core');
  assert.match(result.body.error, /core platform app/);
  assert.equal(contributorReads, 0, 'refused before any read');
  assertNoTeardown();

  // The configured self-app slug is the second signal, for a platform row
  // that predates the self_hosted seed.
  appRow.self_hosted = false;
  appRow.slug = 'usernode-2d5619';
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/usernode-2d5619`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm_name: 'Throwaway' }),
  });
  result = { status: res.status, body: await res.json() };
  assert.equal(result.status, 403);
  assert.equal(result.body.reason, 'core');
  assertNoTeardown();
});

test('the typed app name is verified on the server, not only in the dialog (#2161)', async () => {
  currentUser = { id: 42, username: 'creator', canAdminWrite: false };
  for (const body of [null, {}, { confirm_name: 'throwaway' }, { confirm_name: 'Throwaway ' + 'x' }]) {
    const result = await remove(body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(result.body.reason, 'confirm_name');
    assertNoTeardown();
  }
  const result = await remove({ confirm_name: '  Throwaway  ' });
  assert.equal(result.status, 200, 'surrounding whitespace is not a mismatch');
});

test('the creator of a shared app is told why, and the others are told of the attempt (#2161)', async () => {
  currentUser = { id: 42, username: 'creator', canAdminWrite: false };
  contributorCount = 3;
  const result = await remove();
  assert.equal(result.status, 403);
  assert.equal(result.body.reason, 'shared');
  assert.equal(result.body.contributor_count, 3);
  assert.match(result.body.error, /2 other contributors/);
  assert.match(result.body.error, /group's agreement/);
  assertNoTeardown();
  assert.deepEqual(notified.attempts, [{ appId: 7, actorId: 42, recipients: [101, 102] }]);
});

test('a full admin gets a plain delete of a shared app refused with the governance pointer (#2161)', async () => {
  currentUser = { id: 1, username: 'admin', canAdminWrite: true };
  contributorCount = 2;
  let result = await remove({ confirm_name: 'Throwaway' });
  assert.equal(result.status, 409);
  assert.equal(result.body.reason, 'shared');
  assert.equal(result.body.contributor_count, 2);
  assert.match(result.body.error, /1 other contributor who/);
  assert.match(result.body.error, /group vote/);
  assertNoTeardown();
  // The admin is not a contributor here, so both contributors are told.
  assert.deepEqual(notified.attempts, [{ appId: 7, actorId: 1, recipients: [42, 101] }]);

  // A truthy-but-not-true acknowledgement does not count.
  result = await remove({ confirm_name: 'Throwaway', acknowledge_shared: 'yes' });
  assert.equal(result.status, 409);
  assertNoTeardown();
});

test('a full admin who acknowledges the other contributors deletes, and they are notified (#2161)', async () => {
  currentUser = { id: 1, username: 'admin', canAdminWrite: true };
  contributorCount = 3;
  const result = await remove({ confirm_name: 'Throwaway', acknowledge_shared: true });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true });
  assert.deepEqual(teardown.deletedRows, [7]);
  // The response is sent before the fan-out; give it a tick.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notified.deletions, [{ actorId: 1, name: 'Throwaway', recipients: [42, 101, 102] }]);
  assert.deepEqual(notified.attempts, [], 'a completed delete is not also an attempt');
});

test('an acknowledging admin who is themselves a contributor is not notified of their own delete (#2161)', async () => {
  currentUser = { id: 42, username: 'creator-admin', canAdminWrite: true };
  contributorCount = 2;
  const result = await remove({ confirm_name: 'Throwaway', acknowledge_shared: true });
  assert.equal(result.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notified.deletions, [{ actorId: 42, name: 'Throwaway', recipients: [101] }]);
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
