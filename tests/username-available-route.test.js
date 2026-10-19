// GET /api/auth/username-available: the sign-in sheet's live "✓ Available"
// on the account step (#5255).
//
// It answers only a person mid-sign-up: an unexpired signup cookie (the one
// set-password spends) for an account that still has to choose its handle.
// Anyone else gets 401, so it is no oracle for handles a public profile
// would not show.
//
// It answers with the same rules and the same ledger a real choice meets:
// usernames.validateUsername first (length, letters/numbers/_, the
// reserved names), then usernames.checkAvailability over the live table
// AND the retired-handle ledger, case-insensitively, in the same words a
// refusal uses, so the field never says "Available" for a name Create my
// account would then refuse.
//
// Harness mirrors tests/login-email-identifier.test.js: override getPool
// BEFORE requiring the route module, mount the router on a real express
// app, and answer the two availability queries from in-memory rows.
//
// Run with: node --test tests/username-available-route.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const poolMod = require('../src/db/pool');
const crypto = require('node:crypto');
const SIGNUP = 'a'.repeat(64);
let users = [];
let history = [];
let queries = [];
// web_signup_sessions rows: { token_hash, user_id, live }
let signups = [];
poolMod.getPool = () => ({
  query: async (sql, params) => {
    queries.push(sql);
    if (sql.includes('FROM web_signup_sessions w') && sql.includes('needs_username_choice = TRUE')) {
      const row = signups.find((r) => r.token_hash === params[0] && r.live);
      return { rows: row ? [{ user_id: row.user_id }] : [] };
    }
    if (sql.includes('SELECT id FROM users WHERE LOWER(username) = $1')) {
      return { rows: users.filter((u) => u.username.toLowerCase() === params[0]).map((u) => ({ id: u.id })) };
    }
    if (sql.includes('SELECT user_id FROM username_history WHERE LOWER(username) = $1')) {
      return { rows: history.filter((h) => h.username.toLowerCase() === params[0]).map((h) => ({ user_id: h.user_id })) };
    }
    return { rows: [] };
  },
});

const logger = require('../src/services/logger');
for (const level of ['info', 'warn', 'error', 'debug']) logger[level] = () => {};

const { authRoutes } = require('../src/routes/auth');
const express = require('express');
const cookieParser = require('cookie-parser');

const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

async function withApp(fn, cookie = `usernode_signup=${SIGNUP}`) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(authRoutes({ nodeRpcUrl: 'http://unused' }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    await fn((name) => fetch(`http://127.0.0.1:${server.address().port}/api/auth/username-available?username=${encodeURIComponent(name)}`, {
      headers: cookie ? { cookie } : {},
    }).then(async (res) => ({ res, body: await res.json() })));
  } finally {
    server.close();
  }
}

function pending(userId = 9) {
  signups = [{ token_hash: hash(SIGNUP), user_id: userId, live: true }];
}

test('nobody without a pending sign-up gets an answer', async () => {
  users = [{ id: 1, username: 'ada' }];
  history = [];
  signups = [];
  await withApp(async (ask) => {
    const { res, body } = await ask('ada');
    assert.equal(res.status, 401);
    assert.equal(body.code, 'invalid_signup_session');
    assert.equal('available' in body, false);
  }, null);
  // An expired session, or one whose account already chose, is the same.
  signups = [{ token_hash: hash(SIGNUP), user_id: 9, live: false }];
  queries = [];
  await withApp(async (ask) => {
    assert.equal((await ask('ada')).res.status, 401);
  });
  assert.equal(queries.some((q) => q.includes('FROM users WHERE LOWER(username)')), false, 'no handle lookup before the session is proven');
});

test('a free name is available, and the answer is never cached', async () => {
  pending();
  users = [{ id: 1, username: 'ada' }];
  history = [];
  await withApp(async (ask) => {
    const { res, body } = await ask('grace_h');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(body, { ok: true, available: true });
  });
});

test('a held name is taken, live or retired, whatever its case, in the refusal\'s own words', async () => {
  pending();
  users = [{ id: 1, username: 'Ada' }, { id: 9, username: 'member_abc' }];
  history = [{ user_id: 2, username: 'grace' }];
  await withApp(async (ask) => {
    assert.deepEqual((await ask('ada')).body, { ok: true, available: false, error: 'That username is taken.' });
    assert.deepEqual((await ask('GRACE')).body, { ok: true, available: false, error: 'That username is taken.' });
    // The handle the account itself holds is its own.
    assert.deepEqual((await ask('member_abc')).body, { ok: true, available: true });
  });
});

test('a name the rules refuse says why, and looks up no handle', async () => {
  pending();
  users = [];
  history = [];
  queries = [];
  await withApp(async (ask) => {
    assert.deepEqual((await ask('ab')).body, { ok: true, available: false, error: 'Usernames are at least 3 characters.' });
    assert.deepEqual((await ask('ada-l')).body.available, false);
    assert.match((await ask('ada-l')).body.error, /letters, numbers and underscores/);
    assert.deepEqual((await ask('homeroom_fan')).body, { ok: true, available: false, error: 'That name is reserved for the platform.' });
    assert.deepEqual((await ask('')).body, { ok: true, available: false, error: 'Enter a username.' });
  });
  assert.equal(queries.some((q) => q.includes('FROM users WHERE LOWER(username)') || q.includes('FROM username_history')), false);
});

test('the route has its own per-IP limiter, mounted before the handler', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/routes/auth'), 'utf8');
  assert.match(src, /router\.get\('\/api\/auth\/username-available', usernameCheckLimiter, async \(req, res\) => \{/);
  const limits = require('node:fs').readFileSync(require.resolve('../src/middleware/rate-limits'), 'utf8');
  const block = /const usernameCheckLimiter = makeLimiter\(\{([\s\S]*?)\}\);/.exec(limits)[1];
  assert.match(block, /windowMs: AUTH_WINDOW_MS,\s+max: 120,\s+name: 'username-check',/);
  // Never keyed on the signup cookie: the client chooses it, so a fresh one per request would be a fresh bucket.
  assert.doesNotMatch(block, /key:|keyByUser/);
});
