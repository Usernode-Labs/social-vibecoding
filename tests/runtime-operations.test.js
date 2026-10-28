'use strict';

// A web process makes no runtime write of its own: a custom domain's check
// and edge teardown and an app's removal are platform operations
// (services/platform-operations.js) a conductor runs, rechecking the
// requester's standing first; a workflow process keeps doing them itself.
// Account deletions' provider and worker cleanups are the conductor's
// account-deletion clock's alone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const operations = require('../src/services/platform-operations');
const appDomains = require('../src/services/app-domains');
const teardown = require('../src/services/app-teardown');

function asWeb(t) {
  const role = process.env.PROCESS_ROLE;
  process.env.PROCESS_ROLE = 'web';
  t.after(() => { if (role === undefined) delete process.env.PROCESS_ROLE; else process.env.PROCESS_ROLE = role; });
}
function capture(t, answer = () => ({ ok: true })) {
  const asked = [];
  const prior = operations._setTransportForTests(async (p) => {
    asked.push(p);
    return { status: 'done', requestId: 'r', result: answer(p) };
  });
  t.after(() => operations._setTransportForTests(prior));
  return asked;
}

test('a web process asks a conductor to check a domain, for the person who asked, and reads the row back', async (t) => {
  asWeb(t);
  const asked = capture(t);
  const row = { id: 4, app_id: 9, hostname: 'app.example.org', status: 'pending' };
  const pool = { query: async () => ({ rows: [{ ...row, status: 'verified' }] }) };
  const k8s = require('../src/services/kubernetes');
  t.mock.method(k8s, 'deployCustomDomain', () => { throw new Error('web wrote the edge'); });
  const next = await appDomains.checkNow(pool, { appRuntime: 'kubernetes' }, row, { userId: 3 });
  assert.deepEqual(asked, [{ appId: 9, op: 'domain.check', userId: 3, input: { domainId: 4 } }]);
  assert.equal(next.status, 'verified');
  await assert.rejects(appDomains.checkNow(pool, {}, row), /needs the person who asked/);
});

test('a web process asks a conductor to take a domain\'s edge down; a refusal is thrown', async (t) => {
  asWeb(t);
  const asked = capture(t, (p) => (p.userId === 3 ? { ok: true } : { ok: false, status: 403, error: 'no' }));
  const row = { id: 4, app_id: 9, hostname: 'app.example.org' };
  await appDomains.teardownEdge({ appRuntime: 'kubernetes' }, row, { userId: 3 });
  assert.deepEqual(asked[0], { appId: 9, op: 'domain.teardown', userId: 3, input: { domainId: 4, hostname: 'app.example.org' } });
  await assert.rejects(appDomains.teardownEdge({ appRuntime: 'kubernetes' }, row, { userId: 5 }), (err) => err.status === 403);
  // Docker has no edge to take down, on any process.
  asked.length = 0;
  await appDomains.teardownEdge({ appRuntime: 'docker' }, row, { userId: 3 });
  assert.equal(asked.length, 0);
});

test('a domain whose edge could not be taken down keeps its row and its status', async (t) => {
  asWeb(t);
  capture(t, () => ({ ok: false, status: 503, code: 'operation_unavailable', error: 'down' }));
  const row = { id: 4, app_id: 9, hostname: 'app.example.org', status: 'live' };
  const writes = [];
  const pool = { query: async (sql) => { writes.push(sql); return { rows: [] }; } };
  const config = { appRuntime: 'kubernetes' };
  await assert.rejects(appDomains.remove(pool, config, { id: 9 }, row, { id: 3 }), (err) => err.code === 'edge_teardown_failed' && err.status === 503);
  await assert.rejects(appDomains.disable(pool, config, row, { id: 3 }), (err) => err.code === 'edge_teardown_failed');
  assert.deepEqual(writes, [], 'no row deleted, no status changed, nothing recorded');
});

test('a web process asks a conductor to remove an app, and a preview still retiring reads as before', async (t) => {
  asWeb(t);
  let answer = { ok: true, removed: true };
  const asked = capture(t, () => answer);
  await teardown.teardownApp({}, {}, { id: 12, slug: 's' }, { userId: 3 });
  assert.deepEqual(asked, [{ appId: 12, op: 'app.remove', userId: 3, input: {} }]);
  answer = { ok: false, status: 409, reason: 'preview_retiring', sessionId: 77, error: 'x' };
  await assert.rejects(teardown.teardownApp({}, {}, { id: 12 }, { userId: 3 }), (err) => err instanceof teardown.PreviewNotRetiredError && err.sessionId === 77);
  answer = { ok: false, status: 403, error: 'You can no longer delete this app.' };
  await assert.rejects(teardown.teardownApp({}, {}, { id: 12 }, { userId: 3 }), (err) => err.status === 403);
  await assert.rejects(teardown.teardownApp({}, {}, { id: 12 }), /needs the person who asked/);
});

test('the conductor rechecks the domain and the requester before touching the edge', async () => {
  const op = require('../src/services/domain-operation');
  const appAdmins = require('../src/services/app-admins');
  const row = { id: 4, app_id: 9, hostname: 'app.example.org' };
  const pool = { query: async (sql) => ({ rows: /FROM app_domains/.test(sql) ? [row] : /FROM apps/.test(sql) ? [{ id: 9, created_by: 1 }] : [] }) };
  const prior = appAdmins.canManageApp;
  appAdmins.canManageApp = async (_p, _a, u) => u.id === 1;
  try {
    const ask = (op_, input, user) => op.authorize({ pool }, { op: op_, appId: 9, input }, user);
    assert.equal(await ask('domain.check', { domainId: 4 }, { id: 1 }), null);
    assert.equal((await ask('domain.check', { domainId: 4 }, { id: 2 })).status, 403);
    assert.equal(await ask('domain.check', { domainId: 4 }, { id: 2, canAdminWrite: true }), null);
    assert.equal((await ask('domain.teardown', { domainId: 4, hostname: 'other.example.org' }, { id: 1 })).status, 409);
    assert.equal((await op.authorize({ pool }, { op: 'domain.check', appId: 10, input: { domainId: 4 } }, { id: 1 })).status, 404);
  } finally { appAdmins.canManageApp = prior; }
});

test('the conductor rechecks who may delete the app; one already gone is done', async () => {
  const op = require('../src/services/app-removal-operation');
  const contributors = require('../src/services/contributors');
  const prior = contributors.loadContributorCounts;
  let app = { id: 12, slug: 's', created_by: 1, self_hosted: false };
  contributors.loadContributorCounts = async () => new Map([[12, 1]]);
  const pool = { query: async () => ({ rows: app ? [app] : [] }) };
  try {
    const ask = (user) => op.authorize({ pool, config: {} }, { appId: 12, input: {} }, user);
    assert.equal(await ask({ id: 1 }), null);
    assert.equal((await ask({ id: 2 })).status, 403);
    assert.equal(await ask({ id: 2, canAdminWrite: true }), null);
    app = { ...app, self_hosted: true };
    assert.equal((await ask({ id: 2, canAdminWrite: true })).reason, 'core');
    app = null;
    assert.equal(await ask({ id: 2 }), null);
    assert.deepEqual(await op.run({ pool, config: {} }, { appId: 12, input: {} }, { id: 2 }, require('../src/services/durable-steps').none()), { removed: true });
  } finally { contributors.loadContributorCounts = prior; }
});

test('no web route runs the account-deletion cleanups itself', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  for (const rel of ['src/routes/account-deletion.js', 'src/routes/admin.js', 'src/routes/topochain/admin/users.js']) {
    assert.doesNotMatch(read(rel), /\.sweep\(pool, config\)/, rel);
  }
  assert.match(read('src/workflow/clock/services.ts'), /name: 'account-deletion', everyMs: MIN,[\s\S]{0,200}account-deletion-cleanup'\)\.sweep\(pool, config\)/);
});
