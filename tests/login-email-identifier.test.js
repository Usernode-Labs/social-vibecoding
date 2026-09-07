// POST /api/auth/login — email-or-username identifier resolution (#1269).
//
// The credential lookup collects CANDIDATES (the account whose email the
// @-shaped identifier is, then the account whose username is exactly that
// string) and lets the password decide which one signs in, instead of the
// old first-match-wins lookup where an email match shadowed a username
// match and the wrong account's password got checked. Email matching is
// case-insensitive on both sides (lower(email) = lower($1)).
//
// Harness mirrors tests/password-reset.test.js: override getPool BEFORE
// requiring the route module (it destructures at require time), mount the
// router on a real express app, capture every query, and use real bcrypt
// hashes (low cost — speed, not strength, is what a test needs).
//
// Run with: node --test tests/login-email-identifier.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcrypt');

// ── bcrypt.compare spy: count compares without changing behaviour ──
// The route calls bcrypt.compare via the module object, so patching the
// cached module's property is visible to it. The empty-candidate path
// must do ZERO compares (its cost posture is pinned below).
const realCompare = bcrypt.compare.bind(bcrypt);
let compareCalls = 0;
bcrypt.compare = (...args) => { compareCalls++; return realCompare(...args); };

// ── Pool stub: a tiny in-memory users table ────────────────────────
const poolMod = require('../src/db/pool');
let users = []; // { id, username, password (bcrypt hash), email, is_admin, admin_readonly }
let liveSessions = new Set();
let capturedQueries = [];
const USER_COLS = (u) => ({
  id: u.id, username: u.username, password: u.password,
  is_admin: !!u.is_admin, admin_readonly: !!u.admin_readonly,
});
poolMod.getPool = () => ({
  query: async (sql, params) => {
    capturedQueries.push({ sql, params });
    if (sql.includes('FROM sessions') && sql.includes('expires_at > NOW()')) {
      return { rows: liveSessions.has(params[0]) ? [{ '?column?': 1 }] : [] };
    }
    if (sql.includes('FROM users WHERE lower(email) = lower($1)')) {
      const needle = String(params[0]).toLowerCase();
      return { rows: users.filter((u) => u.email && u.email.toLowerCase() === needle).map(USER_COLS) };
    }
    if (sql.includes('FROM users WHERE username = $1')) {
      return { rows: users.filter((u) => u.username === params[0]).map(USER_COLS) };
    }
    // INSERT INTO sessions / everything else
    return { rows: [] };
  },
});

// ── Spy on the logger so the failure branch can be asserted ────────
const logger = require('../src/services/logger');
let logCalls = [];
for (const level of ['info', 'warn', 'error', 'debug']) {
  logger[level] = (...args) => { logCalls.push([level, ...args]); };
}

const { authRoutes } = require('../src/routes/auth');
const express = require('express');
const cookieParser = require('cookie-parser');

function startApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authRoutes({ nodeRpcUrl: 'http://unused' }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function login(
  server,
  username,
  password,
  sessionToken = null,
  path = '/api/auth/login',
) {
  const port = server.address().port;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(sessionToken ? { cookie: `session=${sessionToken}` } : {}),
    },
    body: JSON.stringify({ username, password }),
  }).then(async (res) => ({ res, body: await res.json().catch(() => ({})) }));
}

function reset() {
  users = [];
  liveSessions = new Set();
  capturedQueries = [];
  logCalls = [];
  compareCalls = 0;
}

const warned = (msg) => logCalls.some(([, , m]) => m === msg);
const COST = 4; // low bcrypt cost: this file tests routing, not hashing

test('every spelling and flow enforces logout before another session mint', async () => {
  reset();
  const hash = await bcrypt.hash('new-account-pw', COST);
  users.push({
    id: 1,
    username: 'new-account',
    password: hash,
    email: null,
  });
  liveSessions.add('session-a');
  const server = await startApp();
  try {
    for (const path of [
      '/api/auth/login',
      '/api/auth/login/',
      '/API/AUTH/LOGIN',
      '/api/auth/wallet-reset-verify',
    ]) {
      const r = await login(
        server,
        'new-account',
        'new-account-pw',
        'session-a',
        path,
      );
      assert.strictEqual(r.res.status, 409, path);
      assert.deepStrictEqual(r.body, {
        error: 'Sign out before signing in again.',
        code: 'logout_required',
      });
    }
    assert.strictEqual(compareCalls, 0,
      'the boundary is enforced before consuming new credentials');
    assert.ok(!capturedQueries.some((q) => /INSERT INTO sessions/.test(q.sql)),
      'no successor session is minted');
  } finally { server.close(); }
});

test('email identifier matches case-insensitively (both input and stored casing) and echoes the real username', async () => {
  reset();
  const hash = await bcrypt.hash('alice-pw', COST);
  // Stored mixed-case (a legacy row the boot normalize may have skipped).
  users.push({ id: 1, username: 'alice', password: hash, email: 'Alice@Example.com' });
  const server = await startApp();
  try {
    const r = await login(server, 'aLiCe@eXaMpLe.CoM', 'alice-pw');
    assert.strictEqual(r.res.status, 200);
    assert.strictEqual(r.body.user.id, 1);
    // The response carries the account's real username, not the email typed.
    assert.strictEqual(r.body.user.username, 'alice');
    const sess = capturedQueries.find((q) => /INSERT INTO sessions/.test(q.sql));
    assert.ok(sess, 'a session row was created');
    assert.strictEqual(sess.params[1], 1);
  } finally { server.close(); }
});

test('shadowing fix (#1269): email matches account A, but the password belongs to account B whose USERNAME is that string -> B signs in', async () => {
  reset();
  // The reporter's exact shape: a mobile-created account owns the email
  // (and uses it as its username), the main account's password is typed.
  const mainHash = await bcrypt.hash('main-account-pw', COST);
  const mobileHash = await bcrypt.hash('mobile-account-pw', COST);
  users.push({ id: 2, username: 'snait', password: mainHash, email: null });
  users.push({ id: 127, username: 'person@example.com', password: mobileHash, email: 'person@example.com' });
  const server = await startApp();
  try {
    // The mobile account's password reaches the mobile account by email...
    let r = await login(server, 'person@example.com', 'mobile-account-pw');
    assert.strictEqual(r.res.status, 200);
    assert.strictEqual(r.body.user.id, 127);

    // ...and a DIFFERENT account whose username equals the email string is
    // reachable with ITS password (username candidate, not shadowed).
    users.push({ id: 3, username: 'other@example.com', password: mainHash, email: null });
    users.find((u) => u.id === 127).email = 'other@example.com';
    r = await login(server, 'other@example.com', 'main-account-pw');
    assert.strictEqual(r.res.status, 200);
    assert.strictEqual(r.body.user.id, 3, 'the username-matching account wins when only its password verifies');
  } finally { server.close(); }
});

test('tie preference: when BOTH candidates verify, the email owner wins', async () => {
  reset();
  const hash = await bcrypt.hash('shared-pw', COST);
  users.push({ id: 10, username: 'emailowner', password: hash, email: 'tie@example.com' });
  users.push({ id: 11, username: 'tie@example.com', password: hash, email: null });
  const server = await startApp();
  try {
    const r = await login(server, 'tie@example.com', 'shared-pw');
    assert.strictEqual(r.res.status, 200);
    assert.strictEqual(r.body.user.id, 10);
  } finally { server.close(); }
});

test('legacy fallback: no email match, exact username that merely looks like an email still works', async () => {
  reset();
  const hash = await bcrypt.hash('legacy-pw', COST);
  users.push({ id: 20, username: 'old.style@example.com', password: hash, email: null });
  const server = await startApp();
  try {
    const r = await login(server, 'old.style@example.com', 'legacy-pw');
    assert.strictEqual(r.res.status, 200);
    assert.strictEqual(r.body.user.id, 20);
  } finally { server.close(); }
});

test('candidates exist but no password verifies -> 401 Invalid credentials via the bad-password branch', async () => {
  reset();
  const hashA = await bcrypt.hash('pw-a', COST);
  const hashB = await bcrypt.hash('pw-b', COST);
  users.push({ id: 30, username: 'both@example.com', password: hashB, email: null });
  users.push({ id: 31, username: 'someone', password: hashA, email: 'both@example.com' });
  const server = await startApp();
  try {
    const r = await login(server, 'both@example.com', 'wrong-pw');
    assert.strictEqual(r.res.status, 401);
    assert.strictEqual(r.body.error, 'Invalid credentials');
    assert.ok(warned('Login failed - bad password'), 'bad-password log branch');
    // Both candidates were actually tried.
    assert.strictEqual(compareCalls, 2);
  } finally { server.close(); }
});

test('no candidates -> 401 Invalid credentials via the unknown-user branch, with ZERO bcrypt compares', async () => {
  reset();
  const server = await startApp();
  try {
    const r = await login(server, 'nobody@example.com', 'whatever');
    assert.strictEqual(r.res.status, 401);
    assert.strictEqual(r.body.error, 'Invalid credentials');
    assert.ok(warned('Login failed - unknown user'), 'unknown-user log branch');
    // Cost posture unchanged: the empty-candidate path short-circuits
    // before any hashing work (same as before #1269).
    assert.strictEqual(compareCalls, 0);
  } finally { server.close(); }
});

test('non-@ identifier: exact username match only, and no email query is issued', async () => {
  reset();
  const hash = await bcrypt.hash('plain-pw', COST);
  users.push({ id: 40, username: 'plainuser', password: hash, email: 'plainuser@example.com' });
  const server = await startApp();
  try {
    let r = await login(server, 'plainuser', 'plain-pw');
    assert.strictEqual(r.res.status, 200);
    assert.strictEqual(r.body.user.id, 40);
    assert.ok(!capturedQueries.some((q) => q.sql.includes('lower(email)')),
      'no email lookup for a non-@ identifier');

    // Usernames stay case-SENSITIVE (unchanged semantics).
    r = await login(server, 'PlainUser', 'plain-pw');
    assert.strictEqual(r.res.status, 401);
  } finally { server.close(); }
});
