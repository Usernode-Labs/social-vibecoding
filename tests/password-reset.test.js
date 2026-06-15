// Route + helper tests for the password-recovery feature (issue #282):
//   - src/services/password-policy.js  (shared validation)
//   - POST /api/me/password            (authenticated change-password)
//   - POST /api/auth/wallet-reset-verify (pre-login wallet self-reset)
//   - POST /api/admin/users/:id/reset-password (admin temp password)
//
// Harness mirrors tests/me-active-sessions.test.js: override getPool
// BEFORE requiring the route modules (they destructure it at require
// time), mount the router on a real express app, inject req.user, and
// capture every query so the SQL contract (password write + session
// wipe) can be asserted directly. The wallet-reset signature check hits
// a real verify-signature RPC, so we stand up a tiny fake node server and
// point config.nodeRpcUrl at it.
//
// Run with: node --test tests/password-reset.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const bcrypt = require('bcrypt');

// ── Pool stub: query-aware, captures everything ────────────────────
const poolMod = require('../src/db/pool');
let capturedQueries = [];
let userByPubkey = null;   // row returned for SELECT ... WHERE usernode_pubkey = $1
let userPasswordRow = null; // row returned for SELECT password ... WHERE id
let userLinkedPubkeyRow = null; // row for SELECT usernode_pubkey FROM users WHERE id
let updateReturns = [];     // rows returned for UPDATE ... RETURNING

poolMod.getPool = () => ({
  query: async (sql, params) => {
    capturedQueries.push({ sql, params });
    if (/SELECT usernode_pubkey FROM users WHERE id/.test(sql)) {
      return { rows: userLinkedPubkeyRow ? [userLinkedPubkeyRow] : [] };
    }
    if (/SELECT .*usernode_pubkey = \$1/s.test(sql)) {
      return { rows: userByPubkey ? [userByPubkey] : [] };
    }
    if (/SELECT password FROM users WHERE id/.test(sql)) {
      return { rows: userPasswordRow ? [userPasswordRow] : [] };
    }
    if (/UPDATE users SET password/.test(sql)) {
      return { rows: updateReturns };
    }
    // INSERT INTO sessions / DELETE FROM sessions / everything else
    return { rows: [] };
  },
});

// ── Spy on the logger so we can assert plaintext is never logged ───
const logger = require('../src/services/logger');
let logCalls = [];
for (const level of ['info', 'warn', 'error', 'debug']) {
  const orig = logger[level];
  logger[level] = (...args) => { logCalls.push(args); if (typeof orig === 'function') { /* swallow */ } };
}

const genesisAccounts = require('../src/services/genesis-accounts');
const { validatePassword } = require('../src/services/password-policy');
const { authRoutes } = require('../src/routes/auth');
const { adminRoutes } = require('../src/routes/admin');
const express = require('express');

// Fake node RPC that answers POST /misc/verify-signature with a
// configurable validity, the same shape src/routes/auth.js expects.
let rpcValid = true;
function startRpc() {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ valid: rpcValid }));
    });
  });
  return new Promise((resolve) => srv.listen(0, () => resolve(srv)));
}

let currentUser = null;
function startApp(makeRouter, config) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (currentUser) req.user = currentUser; next(); });
  app.use(makeRouter(config));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function post(server, path, body, opts = {}) {
  const port = server.address().port;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(async (res) => ({ res, body: await res.json().catch(() => ({})), ...opts }));
}

function reset() {
  capturedQueries = [];
  logCalls = [];
  userByPubkey = null;
  userPasswordRow = null;
  userLinkedPubkeyRow = null;
  updateReturns = [];
  rpcValid = true;
  currentUser = null;
}

// ── password-policy helper ─────────────────────────────────────────
test('password-policy: rejects empty and short, accepts >= 8', () => {
  assert.strictEqual(validatePassword('').ok, false);
  assert.strictEqual(validatePassword(undefined).ok, false);
  assert.strictEqual(validatePassword('short7!').ok, false); // 7 chars
  assert.strictEqual(validatePassword('exactly8').ok, true);
  assert.strictEqual(validatePassword('a-longer-one').ok, true);
});

test('password-policy: notEqualTo rejects reuse of the temp password', () => {
  assert.strictEqual(validatePassword('temppass123', { notEqualTo: 'temppass123' }).ok, false);
  assert.strictEqual(validatePassword('a-new-password', { notEqualTo: 'temppass123' }).ok, true);
});

// ── POST /api/me/password (change password) ────────────────────────
test('change-password: requires current password and verifies it', async () => {
  reset();
  const hash = await bcrypt.hash('oldpassword', 12);
  userPasswordRow = { password: hash };
  currentUser = { id: 5, username: 'alice', isAdmin: false };
  const server = await startApp(authRoutes, { nodeRpcUrl: 'http://unused' });
  try {
    // Missing current password → 400
    let r = await post(server, '/api/me/password', { newPassword: 'brand-new-pw' });
    assert.strictEqual(r.res.status, 400);

    // Wrong current password → 401
    r = await post(server, '/api/me/password', { currentPassword: 'WRONG', newPassword: 'brand-new-pw' });
    assert.strictEqual(r.res.status, 401);

    // Too-short new password → 400 (policy)
    r = await post(server, '/api/me/password', { currentPassword: 'oldpassword', newPassword: 'short' });
    assert.strictEqual(r.res.status, 400);

    // Correct current + valid new → 200, and a password UPDATE was issued
    r = await post(server, '/api/me/password', { currentPassword: 'oldpassword', newPassword: 'brand-new-pw' });
    assert.strictEqual(r.res.status, 200);
    assert.strictEqual(r.body.ok, true);
    const upd = capturedQueries.find((q) => /UPDATE users SET password/.test(q.sql));
    assert.ok(upd, 'password was updated');
    // The stored value is a fresh bcrypt hash of the new password.
    assert.ok(await bcrypt.compare('brand-new-pw', upd.params[0]));
    assert.strictEqual(upd.params[1], 5);
  } finally {
    server.close();
  }
});

// ── POST /api/auth/wallet-reset-verify ─────────────────────────────
test('wallet-reset: rejects an invalid/expired challenge before touching the DB', async () => {
  reset();
  userByPubkey = { id: 9, username: 'bob', is_admin: false };
  const rpc = await startRpc();
  const server = await startApp(authRoutes, { nodeRpcUrl: `http://127.0.0.1:${rpc.address().port}` });
  try {
    const r = await post(server, '/api/auth/wallet-reset-verify', {
      pubkey: 'ut1bob', challenge: 'never-issued', signature: 'sig', newPassword: 'brand-new-pw',
    });
    assert.strictEqual(r.res.status, 401);
    assert.ok(!capturedQueries.some((q) => /UPDATE users SET password/.test(q.sql)), 'no password write');
  } finally {
    server.close();
    rpc.close();
  }
});

test('wallet-reset: rejects when the node RPC reports the signature invalid', async () => {
  reset();
  userByPubkey = { id: 9, username: 'bob', is_admin: false };
  rpcValid = false;
  const rpc = await startRpc();
  const server = await startApp(authRoutes, { nodeRpcUrl: `http://127.0.0.1:${rpc.address().port}` });
  try {
    const chk = await post(server, '/api/auth/wallet-check', { pubkey: 'ut1bob' });
    const challenge = chk.body.challenge;
    assert.ok(challenge, 'wallet-check issued a challenge');

    const r = await post(server, '/api/auth/wallet-reset-verify', {
      pubkey: 'ut1bob', challenge, signature: 'bad', newPassword: 'brand-new-pw',
    });
    assert.strictEqual(r.res.status, 401);
    assert.ok(!capturedQueries.some((q) => /UPDATE users SET password/.test(q.sql)), 'no password write');
  } finally {
    server.close();
    rpc.close();
  }
});

test('wallet-reset: valid signature updates the hash and clears all sessions', async () => {
  reset();
  userByPubkey = { id: 9, username: 'bob', is_admin: false };
  const rpc = await startRpc();
  const server = await startApp(authRoutes, { nodeRpcUrl: `http://127.0.0.1:${rpc.address().port}` });
  try {
    const chk = await post(server, '/api/auth/wallet-check', { pubkey: 'ut1bob' });
    const challenge = chk.body.challenge;

    const r = await post(server, '/api/auth/wallet-reset-verify', {
      pubkey: 'ut1bob', challenge, signature: 'ok', newPassword: 'brand-new-pw',
    });
    assert.strictEqual(r.res.status, 200);
    assert.strictEqual(r.body.user.username, 'bob');

    const upd = capturedQueries.find((q) => /UPDATE users SET password/.test(q.sql));
    assert.ok(upd, 'password updated');
    assert.ok(await bcrypt.compare('brand-new-pw', upd.params[0]));

    const del = capturedQueries.find((q) => /DELETE FROM sessions WHERE user_id/.test(q.sql));
    assert.ok(del, 'sessions deleted');
    assert.strictEqual(del.params[0], 9);

    assert.ok(capturedQueries.some((q) => /INSERT INTO sessions/.test(q.sql)), 'fresh session minted');
  } finally {
    server.close();
    rpc.close();
  }
});

test('wallet-reset: a linked NON-genesis wallet is accepted (no genesis gate)', async () => {
  reset();
  userByPubkey = { id: 12, username: 'carol', is_admin: false };
  // Force the genesis check to report this address as NOT in the ledger.
  // The reset path must not consult it, so the reset still succeeds.
  const origIsGenesis = genesisAccounts.isGenesisAddress;
  genesisAccounts.isGenesisAddress = () => false;
  const rpc = await startRpc();
  const server = await startApp(authRoutes, { nodeRpcUrl: `http://127.0.0.1:${rpc.address().port}` });
  try {
    const chk = await post(server, '/api/auth/wallet-check', { pubkey: 'ut1carol' });
    assert.strictEqual(chk.body.isGenesis, false, 'wallet reported non-genesis');
    const challenge = chk.body.challenge;
    assert.ok(challenge, 'a linked wallet still gets a challenge even when non-genesis');

    const r = await post(server, '/api/auth/wallet-reset-verify', {
      pubkey: 'ut1carol', challenge, signature: 'ok', newPassword: 'brand-new-pw',
    });
    assert.strictEqual(r.res.status, 200);
    assert.ok(capturedQueries.some((q) => /UPDATE users SET password/.test(q.sql)), 'password written for non-genesis linked wallet');
  } finally {
    genesisAccounts.isGenesisAddress = origIsGenesis;
    server.close();
    rpc.close();
  }
});

// ── POST /api/me/wallet-change-password ────────────────────────────
test('wallet-change: rejected without a session', async () => {
  reset();
  currentUser = null; // no req.user injected
  const rpc = await startRpc();
  const server = await startApp(authRoutes, { nodeRpcUrl: `http://127.0.0.1:${rpc.address().port}` });
  try {
    const r = await post(server, '/api/me/wallet-change-password', {
      challenge: 'x', signature: 'y', newPassword: 'brand-new-pw',
    });
    assert.strictEqual(r.res.status, 401);
    assert.ok(!capturedQueries.some((q) => /UPDATE users SET password/.test(q.sql)));
  } finally {
    server.close();
    rpc.close();
  }
});

test('wallet-change: rejects when the account has no linked wallet', async () => {
  reset();
  currentUser = { id: 9, username: 'bob', isAdmin: false };
  userLinkedPubkeyRow = { usernode_pubkey: null };
  const rpc = await startRpc();
  const server = await startApp(authRoutes, { nodeRpcUrl: `http://127.0.0.1:${rpc.address().port}` });
  try {
    const r = await post(server, '/api/me/wallet-change-password', {
      challenge: 'x', signature: 'y', newPassword: 'brand-new-pw',
    });
    assert.strictEqual(r.res.status, 400);
    assert.ok(!capturedQueries.some((q) => /UPDATE users SET password/.test(q.sql)));
  } finally {
    server.close();
    rpc.close();
  }
});

test('wallet-change: rejects an invalid/expired challenge before touching the DB', async () => {
  reset();
  currentUser = { id: 9, username: 'bob', isAdmin: false };
  userLinkedPubkeyRow = { usernode_pubkey: 'ut1bob' };
  const rpc = await startRpc();
  const server = await startApp(authRoutes, { nodeRpcUrl: `http://127.0.0.1:${rpc.address().port}` });
  try {
    const r = await post(server, '/api/me/wallet-change-password', {
      challenge: 'never-issued', signature: 'y', newPassword: 'brand-new-pw',
    });
    assert.strictEqual(r.res.status, 401);
    assert.ok(!capturedQueries.some((q) => /UPDATE users SET password/.test(q.sql)));
  } finally {
    server.close();
    rpc.close();
  }
});

test('wallet-change: rejects a challenge issued for a DIFFERENT pubkey (binding)', async () => {
  reset();
  currentUser = { id: 9, username: 'bob', isAdmin: false };
  userLinkedPubkeyRow = { usernode_pubkey: 'ut1bob' };
  // wallet-check will issue a challenge for whatever pubkey we ask about.
  userByPubkey = { id: 99, username: 'attacker', is_admin: false };
  const rpc = await startRpc();
  const server = await startApp(authRoutes, { nodeRpcUrl: `http://127.0.0.1:${rpc.address().port}` });
  try {
    // Challenge bound to someone else's wallet, not bob's linked key.
    const chk = await post(server, '/api/auth/wallet-check', { pubkey: 'ut1attacker' });
    const challenge = chk.body.challenge;
    assert.ok(challenge);

    const r = await post(server, '/api/me/wallet-change-password', {
      challenge, signature: 'ok', newPassword: 'brand-new-pw',
    });
    assert.strictEqual(r.res.status, 401);
    assert.ok(!capturedQueries.some((q) => /UPDATE users SET password/.test(q.sql)), 'no password write for mismatched pubkey');
  } finally {
    server.close();
    rpc.close();
  }
});

test('wallet-change: rejects when the node RPC reports the signature invalid', async () => {
  reset();
  currentUser = { id: 9, username: 'bob', isAdmin: false };
  userLinkedPubkeyRow = { usernode_pubkey: 'ut1bob' };
  userByPubkey = { id: 9, username: 'bob', is_admin: false };
  rpcValid = false;
  const rpc = await startRpc();
  const server = await startApp(authRoutes, { nodeRpcUrl: `http://127.0.0.1:${rpc.address().port}` });
  try {
    const chk = await post(server, '/api/auth/wallet-check', { pubkey: 'ut1bob' });
    const r = await post(server, '/api/me/wallet-change-password', {
      challenge: chk.body.challenge, signature: 'bad', newPassword: 'brand-new-pw',
    });
    assert.strictEqual(r.res.status, 401);
    assert.ok(!capturedQueries.some((q) => /UPDATE users SET password/.test(q.sql)));
  } finally {
    server.close();
    rpc.close();
  }
});

test('wallet-change: valid signature matching the linked wallet writes a fresh hash and does NOT delete sessions', async () => {
  reset();
  currentUser = { id: 9, username: 'bob', isAdmin: false };
  userLinkedPubkeyRow = { usernode_pubkey: 'ut1bob' };
  userByPubkey = { id: 9, username: 'bob', is_admin: false };
  const rpc = await startRpc();
  const server = await startApp(authRoutes, { nodeRpcUrl: `http://127.0.0.1:${rpc.address().port}` });
  try {
    const chk = await post(server, '/api/auth/wallet-check', { pubkey: 'ut1bob' });
    const r = await post(server, '/api/me/wallet-change-password', {
      publicKey: 'ut1bob', challenge: chk.body.challenge, signature: 'ok', newPassword: 'brand-new-pw',
    });
    assert.strictEqual(r.res.status, 200);
    assert.strictEqual(r.body.ok, true);

    const upd = capturedQueries.find((q) => /UPDATE users SET password/.test(q.sql));
    assert.ok(upd, 'password updated');
    assert.ok(await bcrypt.compare('brand-new-pw', upd.params[0]));
    assert.strictEqual(upd.params[1], 9, 'updated for the logged-in user id');

    // A change (not a reset) leaves existing sessions intact.
    assert.ok(!capturedQueries.some((q) => /DELETE FROM sessions/.test(q.sql)), 'sessions not wiped');
  } finally {
    server.close();
    rpc.close();
  }
});

test('wallet-change: a NON-genesis matching pubkey is accepted (no genesis gate)', async () => {
  reset();
  currentUser = { id: 12, username: 'carol', isAdmin: false };
  userLinkedPubkeyRow = { usernode_pubkey: 'ut1carol' };
  userByPubkey = { id: 12, username: 'carol', is_admin: false };
  const origIsGenesis = genesisAccounts.isGenesisAddress;
  genesisAccounts.isGenesisAddress = () => false;
  const rpc = await startRpc();
  const server = await startApp(authRoutes, { nodeRpcUrl: `http://127.0.0.1:${rpc.address().port}` });
  try {
    const chk = await post(server, '/api/auth/wallet-check', { pubkey: 'ut1carol' });
    assert.strictEqual(chk.body.isGenesis, false);
    const r = await post(server, '/api/me/wallet-change-password', {
      publicKey: 'ut1carol', challenge: chk.body.challenge, signature: 'ok', newPassword: 'brand-new-pw',
    });
    assert.strictEqual(r.res.status, 200);
    assert.ok(capturedQueries.some((q) => /UPDATE users SET password/.test(q.sql)), 'password written for non-genesis linked wallet');
  } finally {
    genesisAccounts.isGenesisAddress = origIsGenesis;
    server.close();
    rpc.close();
  }
});

// ── POST /api/admin/users/:id/reset-password ───────────────────────
test('admin reset: a non-admin never reaches the handler', async () => {
  reset();
  currentUser = { id: 3, username: 'mallory', isAdmin: false };
  const server = await startApp(adminRoutes, {});
  try {
    // adminMiddleware is mounted with `router.use('/api/admin', …)`, which
    // strips the mount prefix, so its non-admin branch redirects to '/'
    // (the admin page is the gate) rather than emitting a literal 403.
    // Either way the security contract is the same: the handler does not
    // run, so no password is written. Don't follow the redirect — we only
    // care that the request was refused, not where it points.
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/users/9/reset-password`, {
      method: 'POST', redirect: 'manual',
    });
    assert.notStrictEqual(res.status, 200);
    assert.ok(!capturedQueries.some((q) => /UPDATE users SET password/.test(q.sql)), 'handler did not run');
  } finally {
    server.close();
  }
});

test('admin reset: unknown user is 404', async () => {
  reset();
  currentUser = { id: 1, username: 'admin', isAdmin: true };
  updateReturns = []; // UPDATE ... RETURNING yields no rows → user not found
  const server = await startApp(adminRoutes, {});
  try {
    const r = await post(server, '/api/admin/users/9999/reset-password', {});
    assert.strictEqual(r.res.status, 404);
    // No session wipe for a user that didn't exist.
    assert.ok(!capturedQueries.some((q) => /DELETE FROM sessions/.test(q.sql)));
  } finally {
    server.close();
  }
});

test('admin reset: success returns a one-time temp password, wipes sessions, never logs plaintext', async () => {
  reset();
  currentUser = { id: 1, username: 'admin', isAdmin: true };
  updateReturns = [{ id: 9, username: 'bob' }];
  const server = await startApp(adminRoutes, {});
  try {
    const r = await post(server, '/api/admin/users/9/reset-password', {});
    assert.strictEqual(r.res.status, 200);
    assert.strictEqual(r.body.username, 'bob');
    assert.ok(typeof r.body.tempPassword === 'string' && r.body.tempPassword.length >= 8, 'temp password returned');

    const upd = capturedQueries.find((q) => /UPDATE users SET password/.test(q.sql));
    assert.ok(upd, 'password updated');
    // Stored value is a bcrypt hash of the returned temp password, not the plaintext.
    assert.notStrictEqual(upd.params[0], r.body.tempPassword);
    assert.ok(await bcrypt.compare(r.body.tempPassword, upd.params[0]));

    const del = capturedQueries.find((q) => /DELETE FROM sessions WHERE user_id/.test(q.sql));
    assert.ok(del, 'sessions deleted');
    assert.strictEqual(del.params[0], 9);

    // Plaintext temp password must never appear in any logged field.
    const flat = JSON.stringify(logCalls);
    assert.ok(!flat.includes(r.body.tempPassword), 'plaintext temp password not logged');
  } finally {
    server.close();
  }
});

test('admin reset: invalid id is 400', async () => {
  reset();
  currentUser = { id: 1, username: 'admin', isAdmin: true };
  const server = await startApp(adminRoutes, {});
  try {
    const r = await post(server, '/api/admin/users/not-a-number/reset-password', {});
    assert.strictEqual(r.res.status, 400);
  } finally {
    server.close();
  }
});
