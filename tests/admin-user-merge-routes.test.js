'use strict';

// The "Deduplicate user" HTTP edge (src/routes/admin-user-merge.js), on a
// real Express app: who may reach the preview and the merge, what reaches the
// service, and how its errors come back. The service itself runs against a
// real database in tests/user-merge-postgres.test.js; here its two entry
// points are replaced on the module object the router calls through.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const merge = require('../src/services/user-merge');
const { adminUserMergeRoutes } = require('../src/routes/admin-user-merge');

const calls = [];
merge.mergePreview = async (pool, args) => { calls.push(['preview', args]); return { user: { id: args.userId }, other: { id: args.otherId } }; };
merge.mergeUsers = async (pool, args) => {
  calls.push(['merge', args]);
  if (args.confirmation !== 'bob') throw new merge.UserMergeError(400, 'confirmation_mismatch', 'Type bob exactly to confirm.');
  return { ok: true, kept_user_id: args.keepId, merged_user_id: args.mergeId };
};

const ROLES = {
  none: null,
  member: { id: 5, isAdmin: false, canAdminWrite: false },
  viewer: { id: 6, isAdmin: true, canAdminWrite: false },
  admin: { id: 7, isAdmin: true, canAdminWrite: true },
};

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = ROLES[req.get('x-role') || 'none'] || undefined; next(); });
  const pool = { query() { throw new Error('the pool is never touched directly'); }, connect() { throw new Error('no'); } };
  app.use(adminUserMergeRoutes({}, { pool }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise((r) => server.close(r)); }
}

const req = (base, role, method, url, body) => fetch(base + url, {
  method,
  headers: { 'x-role': role, 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test('non-admins get 403 on both routes and never reach the service', async () => {
  await withServer(async (base) => {
    calls.length = 0;
    for (const role of ['none', 'member']) {
      assert.equal((await req(base, role, 'GET', '/api/admin/users/1/merge-preview?other=2')).status, 403);
      assert.equal((await req(base, role, 'POST', '/api/admin/users/1/merge', { mergeUserId: 2, emailFrom: 'kept', confirmation: 'bob' })).status, 403);
    }
    assert.deepEqual(calls, []);
  });
});

test('a view-only admin may preview but gets 403 on the merge', async () => {
  await withServer(async (base) => {
    calls.length = 0;
    const preview = await req(base, 'viewer', 'GET', '/api/admin/users/1/merge-preview?other=2');
    assert.equal(preview.status, 200);
    const denied = await req(base, 'viewer', 'POST', '/api/admin/users/1/merge', { mergeUserId: 2, emailFrom: 'kept', confirmation: 'bob' });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: 'Full admin access required' });
    assert.deepEqual(calls.map((c) => c[0]), ['preview']);
  });
});

test('a full admin reaches the service with the kept id from the path and the actor from the session', async () => {
  await withServer(async (base) => {
    calls.length = 0;
    const ok = await req(base, 'admin', 'POST', '/api/admin/users/11/merge', { mergeUserId: 12, emailFrom: 'merged', confirmation: 'bob' });
    assert.equal(ok.status, 200);
    assert.deepEqual(calls[0], ['merge', { keepId: 11, mergeId: 12, actorId: 7, emailFrom: 'merged', confirmation: 'bob' }]);
    const bad = await req(base, 'admin', 'POST', '/api/admin/users/11/merge', { mergeUserId: 12, emailFrom: 'kept', confirmation: 'Bob' });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'Type bob exactly to confirm.', code: 'confirmation_mismatch' });
    assert.equal((await req(base, 'admin', 'POST', '/api/admin/users/11/merge', { emailFrom: 'kept' })).status, 400);
    assert.equal((await req(base, 'admin', 'GET', '/api/admin/users/abc/merge-preview?other=2')).status, 400);
  });
});

test('the router is mounted and the merge copy is em-dash free', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /require\('\.\/src\/routes\/admin-user-merge'\)/);
  assert.match(server, /app\.use\(adminUserMergeRoutes\(config\)\)/);
  for (const rel of ['src/routes/admin-user-merge.js', 'src/services/user-merge.js']) {
    const code = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!code.includes('—'), `${rel} has no em dash in its messages`);
  }
});

test('staging seeds a fake duplicate of 900301 to merge, gated and idempotent', () => {
  const MIGRATE = fs.readFileSync(path.join(__dirname, '..', 'src/db/migrate.js'), 'utf8');
  const start = MIGRATE.indexOf('async function seedStagingDuplicateUser(pool)');
  assert.ok(start > 0);
  const body = MIGRATE.slice(start, MIGRATE.indexOf('\n}\n', start));
  assert.match(body, /if \(process\.env\.USERNODE_ENV !== 'staging'\) return;/);
  assert.match(body, /900310, 'staging-demo-admin-details-dup'/);
  assert.match(body, /ON CONFLICT DO NOTHING/);
  assert.match(MIGRATE, /await seedStagingDuplicateUser\(pool\);/);
});
