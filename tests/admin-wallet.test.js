// Issue #422: admin wallet display + inline edit.
//
// Covers PUT /api/admin/users/:id/wallet — set, change, clear, malformed
// input (400), the already-linked conflict (409 + conflictUser), the
// atomic reassign (other holder ends up cleared), the view-only-admin 403
// gate, and that usernode_pubkey is surfaced by GET /api/admin/users.
//
// Run with: node --test tests/admin-wallet.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// In-memory users table the mocked pool operates against.
let users;
function resetUsers() {
  users = [
    { id: 1, username: 'admin', is_admin: true, admin_readonly: false, app_quota: 5, daily_limit_cents: null, usernode_pubkey: null, created_at: '2020-01-01' },
    { id: 2, username: 'alice', is_admin: false, admin_readonly: false, app_quota: 5, daily_limit_cents: null, usernode_pubkey: 'ut1aliceaaaaaaaaaaaaaaaaaaaaaaaaaaaa', created_at: '2020-01-02' },
    { id: 3, username: 'bob',   is_admin: false, admin_readonly: false, app_quota: 5, daily_limit_cents: null, usernode_pubkey: null, created_at: '2020-01-03' },
  ];
}
resetUsers();

function runQuery(sql, params = []) {
  // Reassign-clear: null out every OTHER holder of this pubkey.
  if (/SET[\s\S]*usernode_pubkey = NULL[\s\S]*WHERE usernode_pubkey = \$1 AND id <> \$2/.test(sql)) {
    const [pubkey, keepId] = params;
    let n = 0;
    for (const u of users) {
      if (u.usernode_pubkey === pubkey && u.id !== keepId) { u.usernode_pubkey = null; n++; }
    }
    return { rows: [], rowCount: n };
  }
  // Conflict check.
  if (/SELECT id, username FROM users WHERE usernode_pubkey = \$1 AND id <> \$2/.test(sql)) {
    const [pubkey, selfId] = params;
    return { rows: users.filter((u) => u.usernode_pubkey === pubkey && u.id !== selfId).map((u) => ({ id: u.id, username: u.username })) };
  }
  // Clear: set NULL where id = $1.
  if (/SET[\s\S]*usernode_pubkey = NULL[\s\S]*WHERE id = \$1/.test(sql)) {
    const u = users.find((x) => x.id === params[0]);
    if (!u) return { rows: [] };
    u.usernode_pubkey = null;
    return { rows: [{ id: u.id, username: u.username, usernode_pubkey: null }] };
  }
  // Set: usernode_pubkey = $1 where id = $2.
  if (/SET[\s\S]*usernode_pubkey = \$1[\s\S]*WHERE id = \$2/.test(sql)) {
    const u = users.find((x) => x.id === params[1]);
    if (!u) return { rows: [] };
    u.usernode_pubkey = params[0];
    return { rows: [{ id: u.id, username: u.username, usernode_pubkey: u.usernode_pubkey }] };
  }
  // GET /api/admin/users list.
  if (/FROM users u/.test(sql)) {
    return {
      rows: users.map((u) => ({
        id: u.id, username: u.username, is_admin: u.is_admin, admin_readonly: u.admin_readonly,
        app_quota: u.app_quota, created_at: u.created_at, daily_limit_cents: u.daily_limit_cents,
        usernode_pubkey: u.usernode_pubkey, is_self: u.id === params[0],
        activation_code: null, cost_today_cents: 0, apps_created: 0,
      })),
    };
  }
  // BEGIN / COMMIT / ROLLBACK and anything else.
  return { rows: [] };
}

const poolMod = require('../src/db/pool');
poolMod.getPool = () => ({
  query: async (sql, params) => runQuery(sql, params),
  connect: async () => ({ query: async (sql, params) => runQuery(sql, params), release() {} }),
});

const { adminRoutes } = require('../src/routes/admin');
const express = require('express');

let server, base;
// Mutable so a test can flip to a view-only admin.
let currentUser = { id: 1, username: 'admin', isAdmin: true, canAdminWrite: true };

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(adminRoutes({ jwtSecret: 'test' }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server && server.close());

test.beforeEach(() => {
  resetUsers();
  currentUser = { id: 1, username: 'admin', isAdmin: true, canAdminWrite: true };
});

function putWallet(id, body) {
  return fetch(`${base}/api/admin/users/${id}/wallet`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('sets a wallet on a user who had none', async () => {
  const r = await putWallet(3, { pubkey: 'ut1bobbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.usernode_pubkey, 'ut1bobbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(users.find((u) => u.id === 3).usernode_pubkey, 'ut1bobbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
});

test('clears a wallet when pubkey is empty', async () => {
  const r = await putWallet(2, { pubkey: '' });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.usernode_pubkey, null);
  assert.equal(users.find((u) => u.id === 2).usernode_pubkey, null);
});

test('clears a wallet when pubkey is null', async () => {
  const r = await putWallet(2, { pubkey: null });
  assert.equal(r.status, 200);
  assert.equal(users.find((u) => u.id === 2).usernode_pubkey, null);
});

test('rejects a non-ut1 address with 400', async () => {
  const r = await putWallet(3, { pubkey: 'xt1notawallet' });
  assert.equal(r.status, 400);
});

test('rejects an address with whitespace with 400', async () => {
  const r = await putWallet(3, { pubkey: 'ut1 has spaces' });
  assert.equal(r.status, 400);
});

test('returns 409 + conflictUser when the wallet belongs to another user', async () => {
  const r = await putWallet(3, { pubkey: 'ut1aliceaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  assert.equal(r.status, 409);
  const d = await r.json();
  assert.equal(d.conflictUser.username, 'alice');
  assert.equal(d.conflictUser.id, 2);
  // No mutation happened.
  assert.equal(users.find((u) => u.id === 3).usernode_pubkey, null);
  assert.equal(users.find((u) => u.id === 2).usernode_pubkey, 'ut1aliceaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
});

test('reassign:true moves the wallet atomically — old holder ends up cleared', async () => {
  const r = await putWallet(3, { pubkey: 'ut1aliceaaaaaaaaaaaaaaaaaaaaaaaaaaaa', reassign: true });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.usernode_pubkey, 'ut1aliceaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(users.find((u) => u.id === 3).usernode_pubkey, 'ut1aliceaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bob now holds it');
  assert.equal(users.find((u) => u.id === 2).usernode_pubkey, null, 'alice was cleared');
});

test('view-only admin gets 403 (requireAdminWrite gate)', async () => {
  currentUser = { id: 4, username: 'viewer', isAdmin: true, canAdminWrite: false };
  const r = await putWallet(3, { pubkey: 'ut1bobbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
  assert.equal(r.status, 403);
});

test('GET /api/admin/users surfaces usernode_pubkey', async () => {
  const rows = await fetch(`${base}/api/admin/users`).then((x) => x.json());
  const alice = rows.find((u) => u.username === 'alice');
  assert.equal(alice.usernode_pubkey, 'ut1aliceaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const bob = rows.find((u) => u.username === 'bob');
  assert.equal(bob.usernode_pubkey, null);
});
