// Topochain v4 mobile auth (plan Task 8; SPEC §4.5, lines 850-854 for the
// endpoint list, 1588-1746 for the token model + throttling + the six
// endpoint contracts).
//
// HTTP-level tests against a throwaway express app + an in-memory mock
// pool (same idiom as tests/topochain-partner-api.test.js). Because
// src/middleware/rate-limits.js's `topochainMobileAuthLimiter` is a
// module-level singleton keyed by client IP, and every test in this file
// hits it from the same loopback address, EVERY test rebuilds the app
// from scratch via `withApp()` (require.cache reset on rate-limits.js,
// topochain-auth.js, and mobile-auth.js) so each test starts with a fresh,
// unexhausted throttle bucket — mirrors tests/db-export-limits.test.js's
// note that an IP/user-keyed limiter needs either a fresh instance or a
// deliberately distinct key per test.
//
// bcrypt is exercised for real (no mock) — hashing/comparison timing is
// part of what's under test (login/otp/verify's constant-shaped failure
// paths), and this repo's test idiom favors real dependencies over mocks
// wherever they're fast enough (bcrypt is; native addon, no I/O).
//
// Run with: node --test tests/topochain-mobile-auth.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const express = require('express');

// ─── Fixture data ─────────────────────────────────────────────────────

// Low bcrypt cost (4) purely for test speed — the value hashed and later
// compared is what's under test, not the cost factor itself (login's
// bcrypt.compare re-derives at whatever cost is embedded in the hash, so
// a cost-4 fixture hash works identically to a cost-12 production one).
const ALICE_PASSWORD = 'CorrectHorse1!';
const ALICE_HASH = bcrypt.hashSync(ALICE_PASSWORD, 4);
const OPERATOR_PASSWORD = 'OperatorPass1!';
const OPERATOR_HASH = bcrypt.hashSync(OPERATOR_PASSWORD, 4);
const UNUSABLE_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 4);

let users;         // [{id, username, password, email, display_name, email_confirmed, password_set, is_admin}]
let tokens;        // mobile_auth_tokens rows
let otps;          // mobile_otp_codes rows
let onchainAccounts; // [{user_id}]
let capturedCodes; // email -> plaintext OTP code, captured via the injected mail transport
let nextUserId;
let nextTokenId;
let nextOtpId;

function resetFixtures() {
  users = [
    { id: 1, username: 'alice@example.com', password: ALICE_HASH, email: 'alice@example.com', display_name: 'Alice', email_confirmed: true, password_set: true, is_admin: false },
    { id: 2, username: 'operator@example.com', password: OPERATOR_HASH, email: 'operator@example.com', display_name: 'Op', email_confirmed: true, password_set: true, is_admin: false },
    { id: 3, username: 'noPasswordYet@example.com', password: UNUSABLE_HASH, email: 'nopasswordyet@example.com', display_name: null, email_confirmed: true, password_set: false, is_admin: false },
    // A platform ADMIN sharing the users table (Global Constraints #7) —
    // the OTP flow must never become a password reset for this row, even
    // hypothetically with password_set FALSE (belt and braces: both flags
    // block independently, this row exercises the is_admin one alone).
    { id: 4, username: 'root@example.com', password: UNUSABLE_HASH, email: 'root@example.com', display_name: 'Root', email_confirmed: true, password_set: false, is_admin: true },
  ];
  tokens = [];
  otps = [];
  onchainAccounts = [{ user_id: 2 }]; // user 2 is the sole operator
  capturedCodes = {};
  nextUserId = 5;
  nextTokenId = 1;
  nextOtpId = 1;
}

// ─── Mock pool: SQL shape -> in-memory computation ──────────────────────

function collapse(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function handleQuery(rawSql, params = []) {
  const sql = collapse(rawSql);

  // mobileTokenAuth's own lookup + bookkeeping update.
  if (sql.startsWith('SELECT t.id, t.user_id, t.ability, t.expires_at, u.username FROM mobile_auth_tokens')) {
    const tok = tokens.find((t) => t.token_hash === params[0]);
    if (!tok) return { rows: [] };
    const user = users.find((u) => u.id === tok.user_id);
    return { rows: [{ id: tok.id, user_id: tok.user_id, ability: tok.ability, expires_at: tok.expires_at, username: user ? user.username : null }] };
  }
  if (sql.startsWith('UPDATE mobile_auth_tokens SET last_used_at')) {
    return { rows: [] };
  }

  // check-email
  if (sql.startsWith('SELECT password_set FROM users WHERE email = $1')) {
    const u = users.find((x) => x.email === params[0]);
    return { rows: u ? [{ password_set: u.password_set }] : [] };
  }

  // login
  if (sql.startsWith('SELECT id, password, email, display_name, email_confirmed, password_set FROM users WHERE email = $1')) {
    const u = users.find((x) => x.email === params[0]);
    return { rows: u ? [{ ...u }] : [] };
  }

  // otp/verify existing-user check (now carries is_admin for the
  // admin/password-set guard), and set-password's post-update refetch.
  if (sql.startsWith('SELECT id, email, display_name, email_confirmed, password_set, is_admin FROM users WHERE email = $1')) {
    const u = users.find((x) => x.email === params[0]);
    return { rows: u ? [{ ...u }] : [] };
  }
  if (sql.startsWith('SELECT id, email, display_name, email_confirmed, password_set FROM users WHERE id = $1')) {
    const u = users.find((x) => x.id === params[0]);
    return { rows: u ? [{ ...u }] : [] };
  }
  // set-password's consume-side guard re-read.
  if (sql.startsWith('SELECT is_admin, password_set FROM users WHERE id = $1')) {
    const u = users.find((x) => x.id === params[0]);
    return { rows: u ? [{ is_admin: !!u.is_admin, password_set: !!u.password_set }] : [] };
  }

  // otp/verify: account creation.
  if (sql.startsWith('INSERT INTO users')) {
    const [username, password, email] = params;
    const row = {
      id: nextUserId++, username, password, email,
      display_name: null, email_confirmed: true, password_set: false, is_admin: false,
    };
    users.push(row);
    return { rows: [{ id: row.id, email: row.email, display_name: row.display_name, email_confirmed: row.email_confirmed, password_set: row.password_set }] };
  }

  // set-password: the write itself.
  if (sql.startsWith('UPDATE users SET password = $1, password_set = TRUE WHERE id = $2')) {
    const [passwordHash, id] = params;
    const u = users.find((x) => x.id === id);
    if (u) { u.password = passwordHash; u.password_set = true; }
    return { rows: [] };
  }

  // level computation.
  if (sql.startsWith('SELECT 1 FROM onchain_accounts WHERE user_id = $1 LIMIT 1')) {
    const has = onchainAccounts.some((a) => a.user_id === params[0]);
    return { rows: has ? [{ x: 1 }] : [] };
  }

  // token issuance + single-use revocation.
  if (sql.startsWith('INSERT INTO mobile_auth_tokens (user_id, token_hash, ability, expires_at)')) {
    const [userId, tokenHash, ability, expiresAt] = params;
    tokens.push({ id: nextTokenId++, user_id: userId, token_hash: tokenHash, ability, expires_at: expiresAt, last_used_at: null });
    return { rows: [] };
  }
  if (sql.startsWith('DELETE FROM mobile_auth_tokens WHERE token_hash = $1')) {
    tokens = tokens.filter((t) => t.token_hash !== params[0]);
    return { rows: [] };
  }

  // otp/request.
  if (sql.startsWith('DELETE FROM mobile_otp_codes WHERE email = $1 AND consumed_at IS NULL')) {
    otps = otps.filter((o) => !(o.email === params[0] && o.consumed_at == null));
    return { rows: [] };
  }
  if (sql.startsWith('INSERT INTO mobile_otp_codes')) {
    const [email, codeHash, expiresAt] = params;
    otps.push({ id: nextOtpId++, email, code_hash: codeHash, attempts: 0, expires_at: expiresAt, consumed_at: null, created_at: new Date() });
    return { rows: [] };
  }

  // otp/verify.
  if (sql.startsWith('SELECT id, code_hash, attempts, expires_at FROM mobile_otp_codes')) {
    const candidates = otps
      .filter((o) => o.email === params[0] && o.consumed_at == null)
      .sort((a, b) => b.created_at - a.created_at || b.id - a.id);
    return { rows: candidates.length ? [candidates[0]] : [] };
  }
  if (sql.startsWith('UPDATE mobile_otp_codes SET attempts = attempts + 1')) {
    const o = otps.find((x) => x.id === params[0]);
    if (o) o.attempts += 1;
    return { rows: [] };
  }
  if (sql.startsWith('UPDATE mobile_otp_codes SET consumed_at = NOW()')) {
    const o = otps.find((x) => x.id === params[0]);
    if (o) o.consumed_at = new Date();
    return { rows: [] };
  }

  throw new Error(`Unhandled mock query: ${sql}`);
}

function makeMockPool() {
  return { query: async (sql, params) => handleQuery(sql, params) };
}

// ─── Test app wiring (require.cache reset per test — see file header) ──

function testConfig() {
  return {
    databaseUrl: 'postgres://fake/fake',
    env: 'test',
    // Real mailer.js "transport configured" path (src/services/topochain/
    // mailer.js) — captures the plaintext code so tests can drive the
    // full otp/request -> otp/verify lifecycle without reaching into the
    // route module's internals.
    topochainMailTransport: {
      send: async ({ to, code }) => { capturedCodes[to] = code; },
    },
  };
}

function withMockPool(config, fn) {
  const poolModulePath = require.resolve('../src/db/pool');
  const mobileAuthModulePath = require.resolve('../src/routes/topochain/mobile-auth');
  const topoAuthModulePath = require.resolve('../src/middleware/topochain-auth');
  const rateLimitsModulePath = require.resolve('../src/middleware/rate-limits');
  const original = require.cache[poolModulePath];
  require.cache[poolModulePath] = {
    exports: { getPool: () => makeMockPool() },
    loaded: true, id: poolModulePath, filename: poolModulePath, paths: original ? original.paths : [],
  };
  // Fresh instances every call: rate-limits.js's limiters are module-level
  // singletons with their own in-memory store — reusing one across tests
  // would let an earlier test's requests count against a later test's
  // 10-per-minute budget (all tests share the 127.0.0.1 loopback "IP").
  delete require.cache[rateLimitsModulePath];
  delete require.cache[topoAuthModulePath];
  delete require.cache[mobileAuthModulePath];
  try {
    const { topochainMobileAuthRoutes } = require('../src/routes/topochain/mobile-auth');
    const app = express();
    app.use(express.json());
    app.use(topochainMobileAuthRoutes(config));
    return fn(app);
  } finally {
    if (original) require.cache[poolModulePath] = original;
    else delete require.cache[poolModulePath];
    delete require.cache[rateLimitsModulePath];
    delete require.cache[topoAuthModulePath];
    delete require.cache[mobileAuthModulePath];
  }
}

async function withApp(fn) {
  return withMockPool(testConfig(), async (app) => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await fn(base);
    } finally {
      server.close();
    }
  });
}

function postJson(base, path, body, opts) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(opts && opts.headers) },
    body: JSON.stringify(body),
  });
}

function bearer(token) {
  return { headers: { authorization: `Bearer ${token}` } };
}

test.beforeEach(() => resetFixtures());

// ─── POST /check-email (SPEC 1601-1619) ─────────────────────────────────

test('check-email: known address with a password set -> exists:true, password_set:true', async () => {
  await withApp(async (base) => {
    const res = await postJson(base, '/api/v4/mobile/auth/check-email', { email: 'alice@example.com' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true, exists: true, password_set: true });
  });
});

test('check-email: known address with no password set yet -> exists:true, password_set:false', async () => {
  await withApp(async (base) => {
    const res = await postJson(base, '/api/v4/mobile/auth/check-email', { email: 'nopasswordyet@example.com' });
    assert.deepEqual(await res.json(), { success: true, exists: true, password_set: false });
  });
});

test('check-email: unknown address -> exists:false, password_set:false', async () => {
  await withApp(async (base) => {
    const res = await postJson(base, '/api/v4/mobile/auth/check-email', { email: 'nobody@example.com' });
    assert.deepEqual(await res.json(), { success: true, exists: false, password_set: false });
  });
});

test('check-email: missing email -> 422 with details envelope', async () => {
  await withApp(async (base) => {
    const res = await postJson(base, '/api/v4/mobile/auth/check-email', {});
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.ok(body.details.email);
  });
});

// ─── POST /login (SPEC 1621-1655) — the one 401 message for three modes ─

test('login: correct credentials -> 200 token + user (member level, no onchain account)', async () => {
  await withApp(async (base) => {
    const res = await postJson(base, '/api/v4/mobile/auth/login', { email: 'alice@example.com', password: ALICE_PASSWORD });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(typeof body.token, 'string');
    assert.ok(body.token.length > 0);
    assert.deepEqual(body.user, {
      id: 1, email: 'alice@example.com', display_name: 'Alice', email_confirmed: true, level: 'member',
    });
  });
});

test('login: user with an onchain account -> level operator (overrides member)', async () => {
  await withApp(async (base) => {
    const res = await postJson(base, '/api/v4/mobile/auth/login', { email: 'operator@example.com', password: OPERATOR_PASSWORD });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user.level, 'operator');
  });
});

test('login: unknown email -> 401 "Invalid email or password."', async () => {
  await withApp(async (base) => {
    const res = await postJson(base, '/api/v4/mobile/auth/login', { email: 'nobody@example.com', password: 'whatever123' });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { success: false, error: 'Invalid email or password.' });
  });
});

test('login: known email, password not set yet -> the SAME 401 message (no enumeration)', async () => {
  await withApp(async (base) => {
    const res = await postJson(base, '/api/v4/mobile/auth/login', { email: 'nopasswordyet@example.com', password: 'whatever123' });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { success: false, error: 'Invalid email or password.' });
  });
});

test('login: wrong password -> the SAME 401 message', async () => {
  await withApp(async (base) => {
    const res = await postJson(base, '/api/v4/mobile/auth/login', { email: 'alice@example.com', password: 'totallyWrong123' });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { success: false, error: 'Invalid email or password.' });
  });
});

// Code review fix: bcrypt.compare must run on EVERY failure path (real
// hash or the fixed DUMMY_PASSWORD_HASH when there's no row/no password
// to compare against) so an unknown email can't be timed apart from a
// known one. This test doesn't assert on timing directly (flaky in CI)
// — it asserts the three modes are byte-identical side by side, which is
// what the shared bcrypt.compare call guarantees: no code path returns
// the 401 without first doing that one comparison.
test('login: all three failure modes (unknown email, no password set, wrong password) return the IDENTICAL body', async () => {
  await withApp(async (base) => {
    const [unknownRes, noPasswordRes, wrongPasswordRes] = await Promise.all([
      postJson(base, '/api/v4/mobile/auth/login', { email: 'nobody@example.com', password: 'whatever123' }),
      postJson(base, '/api/v4/mobile/auth/login', { email: 'nopasswordyet@example.com', password: 'whatever123' }),
      postJson(base, '/api/v4/mobile/auth/login', { email: 'alice@example.com', password: 'totallyWrong123' }),
    ]);
    for (const res of [unknownRes, noPasswordRes, wrongPasswordRes]) {
      assert.equal(res.status, 401);
    }
    const bodies = await Promise.all([unknownRes, noPasswordRes, wrongPasswordRes].map((r) => r.json()));
    const expected = { success: false, error: 'Invalid email or password.' };
    for (const body of bodies) assert.deepEqual(body, expected);
  });
});

test('login: concurrent sessions — logging in twice mints two independent tokens', async () => {
  await withApp(async (base) => {
    const res1 = await postJson(base, '/api/v4/mobile/auth/login', { email: 'alice@example.com', password: ALICE_PASSWORD });
    const res2 = await postJson(base, '/api/v4/mobile/auth/login', { email: 'alice@example.com', password: ALICE_PASSWORD });
    const token1 = (await res1.json()).token;
    const token2 = (await res2.json()).token;
    assert.notEqual(token1, token2);
    assert.equal(tokens.length, 2, 'both sessions are live at once');
  });
});

test('login: missing password -> 422', async () => {
  await withApp(async (base) => {
    const res = await postJson(base, '/api/v4/mobile/auth/login', { email: 'alice@example.com' });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.ok(body.details.password);
  });
});

// ─── Full OTP lifecycle: request -> verify -> set-password -> login ────

test('OTP lifecycle: request -> verify creates a brand-new user -> set-password -> fresh login succeeds', async () => {
  await withApp(async (base) => {
    const email = 'newperson@example.com';

    // 1. otp/request — always-200, generic message, code captured via the
    //    injected mail transport (never exposed in the HTTP response).
    const reqRes = await postJson(base, '/api/v4/mobile/auth/otp/request', { email });
    assert.equal(reqRes.status, 200);
    assert.deepEqual(await reqRes.json(), {
      success: true, message: 'If that email can receive a code, one has been sent.',
    });
    const code = capturedCodes[email];
    assert.match(code, /^\d{6}$/, 'a 6-digit code was minted');
    assert.equal(otps.length, 1);
    assert.notEqual(otps[0].code_hash, code, 'the code is stored hashed, never plaintext');

    // 2. otp/verify — creates the user, force-confirms the email, returns
    //    a set-password token.
    const verifyRes = await postJson(base, '/api/v4/mobile/auth/otp/verify', { email, code });
    assert.equal(verifyRes.status, 200);
    const verifyBody = await verifyRes.json();
    assert.equal(verifyBody.success, true);
    assert.equal(typeof verifyBody.set_password_token, 'string');

    const created = users.find((u) => u.email === email);
    assert.ok(created, 'a new user row was created');
    assert.equal(created.username, email, 'username = lower-cased email');
    assert.equal(created.email_confirmed, true, 'force-confirmed on success');
    assert.equal(created.password_set, false, 'no real password yet');
    assert.equal(otps[0].consumed_at !== null, true, 'the code is marked consumed');

    // 3. set-password — uses the set-password token, sets a real password,
    //    returns a login-shaped 200 with a fresh SESSION token.
    const setRes = await postJson(base, '/api/v4/mobile/auth/set-password',
      { password: 'BrandNewPass1!', password_confirmation: 'BrandNewPass1!' },
      bearer(verifyBody.set_password_token));
    assert.equal(setRes.status, 200);
    const setBody = await setRes.json();
    assert.equal(typeof setBody.token, 'string');
    assert.equal(setBody.user.email, email);
    assert.equal(setBody.user.level, 'member', 'password now set, no onchain account');
    assert.equal(created.password_set, true);

    // 4. login — the freshly-set password now works.
    const loginRes = await postJson(base, '/api/v4/mobile/auth/login', { email, password: 'BrandNewPass1!' });
    assert.equal(loginRes.status, 200);
    assert.equal((await loginRes.json()).user.email, email);
  });
});

test('OTP lifecycle: verify for an existing PASSWORD-LESS account attaches the token to the EXISTING user and completes set-password (the §8.5 migrated-participant flow)', async () => {
  // User 3 models the 199 migrated participants: an existing users row
  // with an unusable hash and password_set = FALSE. The security guard on
  // otp/verify (is_admin / password_set refusal) must NOT touch this
  // path — it is exactly the flow SPEC §8.5 requires to keep working.
  await withApp(async (base) => {
    const email = 'nopasswordyet@example.com';
    await postJson(base, '/api/v4/mobile/auth/otp/request', { email });
    const code = capturedCodes[email];

    const res = await postJson(base, '/api/v4/mobile/auth/otp/verify', { email, code });
    assert.equal(res.status, 200);
    assert.equal(users.filter((u) => u.email === email).length, 1, 'no duplicate user row created');
    const setPasswordToken = (await res.json()).set_password_token;
    const tokenRow = tokens.find((t) => t.ability === 'set-password');
    assert.equal(tokenRow.user_id, 3, 'the token is attached to the existing row, not a new one');
    assert.ok(setPasswordToken);

    // The first-password set itself must succeed end to end.
    const setRes = await postJson(base, '/api/v4/mobile/auth/set-password', {
      password: 'FirstPassword1!', password_confirmation: 'FirstPassword1!',
    }, bearer(setPasswordToken));
    assert.equal(setRes.status, 200);
    const setBody = await setRes.json();
    assert.ok(setBody.token, 'a fresh session token is issued');
    assert.equal(users.find((u) => u.id === 3).password_set, true);
  });
});

test('otp/verify: an account that ALREADY has a real password (password_set=TRUE) gets the generic 422 — never a set-password token (unauthenticated password-reset guard)', async () => {
  // alice has a usable password. Handing out a set-password token here
  // would turn the OTP flow into a password reset for any platform web
  // account. The refusal body is byte-identical to every other OTP
  // failure (SPEC 1702/1707's one-message rule) so this is not a
  // "does this account have a password" oracle.
  await withApp(async (base) => {
    const email = 'alice@example.com';
    await postJson(base, '/api/v4/mobile/auth/otp/request', { email });
    const code = capturedCodes[email];

    const res = await postJson(base, '/api/v4/mobile/auth/otp/verify', { email, code });
    assert.equal(res.status, 422);
    assert.deepEqual(await res.json(), { success: false, error: 'Invalid or expired code.' });
    assert.ok(!tokens.some((t) => t.ability === 'set-password'), 'no set-password token may exist');
    assert.equal(users.find((u) => u.id === 1).password, ALICE_HASH, 'password untouched');
  });
});

test('otp/verify: a platform ADMIN account gets the same generic 422, even with password_set=FALSE (admin web-console takeover guard)', async () => {
  await withApp(async (base) => {
    const email = 'root@example.com';
    await postJson(base, '/api/v4/mobile/auth/otp/request', { email });
    const code = capturedCodes[email];

    const res = await postJson(base, '/api/v4/mobile/auth/otp/verify', { email, code });
    assert.equal(res.status, 422);
    assert.deepEqual(await res.json(), { success: false, error: 'Invalid or expired code.' });
    assert.ok(!tokens.some((t) => t.ability === 'set-password'), 'no set-password token may exist');
  });
});

test('set-password: the consume-side guard — a live set-password token for an admin (or already-passworded) row is refused like an invalid token and revoked', async () => {
  // Defense in depth for tokens minted BEFORE the account gained its
  // password/admin status (otp/verify no longer issues them for such
  // rows): seed the token directly, bypassing verify entirely.
  await withApp(async (base) => {
    const raw = crypto.randomBytes(40).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
    tokens.push({ id: 999, user_id: 4, token_hash: tokenHash, ability: 'set-password', expires_at: new Date(Date.now() + 60000), last_used_at: null });

    const res = await postJson(base, '/api/v4/mobile/auth/set-password', {
      password: 'AdminTakeover1!', password_confirmation: 'AdminTakeover1!',
    }, bearer(raw));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { success: false, error: 'Unauthenticated.' });
    assert.equal(users.find((u) => u.id === 4).password, UNUSABLE_HASH, 'admin password untouched');
    assert.ok(!tokens.some((t) => t.id === 999), 'the token is revoked (single-use either way)');
  });
});

// ─── otp/verify: the one 422 message for every failure mode ────────────

test('otp/verify: no code was ever requested -> 422 "Invalid or expired code."', async () => {
  await withApp(async (base) => {
    const res = await postJson(base, '/api/v4/mobile/auth/otp/verify', { email: 'ghost@example.com', code: '123456' });
    assert.equal(res.status, 422);
    assert.deepEqual(await res.json(), { success: false, error: 'Invalid or expired code.' });
  });
});

test('otp/verify: expired code -> the same 422 message', async () => {
  await withApp(async (base) => {
    const email = 'expiring@example.com';
    await postJson(base, '/api/v4/mobile/auth/otp/request', { email });
    const code = capturedCodes[email];
    otps[0].expires_at = new Date(Date.now() - 1000); // force it into the past

    const res = await postJson(base, '/api/v4/mobile/auth/otp/verify', { email, code });
    assert.equal(res.status, 422);
    assert.deepEqual(await res.json(), { success: false, error: 'Invalid or expired code.' });
  });
});

test('otp/verify: wrong code -> the same 422 message, and increments the attempt counter', async () => {
  await withApp(async (base) => {
    const email = 'wrongcode@example.com';
    await postJson(base, '/api/v4/mobile/auth/otp/request', { email });

    const res = await postJson(base, '/api/v4/mobile/auth/otp/verify', { email, code: '000000' });
    assert.equal(res.status, 422);
    assert.deepEqual(await res.json(), { success: false, error: 'Invalid or expired code.' });
    assert.equal(otps[0].attempts, 1);
  });
});

test('otp/verify: new request replaces the previous unconsumed code — the old one no longer verifies', async () => {
  await withApp(async (base) => {
    const email = 'replace@example.com';
    await postJson(base, '/api/v4/mobile/auth/otp/request', { email });
    const staleCode = capturedCodes[email];

    await postJson(base, '/api/v4/mobile/auth/otp/request', { email });
    const freshCode = capturedCodes[email];
    assert.equal(otps.length, 1, 'the previous unconsumed code was deleted, not just superseded');

    const staleRes = await postJson(base, '/api/v4/mobile/auth/otp/verify', { email, code: staleCode });
    // Only possible to assert this cleanly when the two codes differ;
    // random collision odds are 1-in-a-million, acceptable for a test.
    if (staleCode !== freshCode) {
      assert.equal(staleRes.status, 422);
    }

    const freshRes = await postJson(base, '/api/v4/mobile/auth/otp/verify', { email, code: freshCode });
    assert.equal(freshRes.status, 200);
  });
});

test('otp/verify: attempt-counter death — 5 wrong attempts kill the code, even the CORRECT code then fails', async () => {
  await withApp(async (base) => {
    const email = 'deadcode@example.com';
    await postJson(base, '/api/v4/mobile/auth/otp/request', { email });
    const realCode = capturedCodes[email];

    for (let i = 0; i < 5; i++) {
      const res = await postJson(base, '/api/v4/mobile/auth/otp/verify', { email, code: '999999' });
      assert.equal(res.status, 422, `attempt ${i + 1}`);
    }
    assert.equal(otps[0].attempts, 5);

    // The code is now dead — even the real code no longer verifies, and a
    // 6th failed attempt does NOT push the counter past 5.
    const finalRes = await postJson(base, '/api/v4/mobile/auth/otp/verify', { email, code: realCode });
    assert.equal(finalRes.status, 422);
    assert.deepEqual(await finalRes.json(), { success: false, error: 'Invalid or expired code.' });
    assert.equal(otps[0].attempts, 5, 'a dead code short-circuits before the counter is touched again');
  });
});

test('otp/verify: missing code field -> 422 with details', async () => {
  await withApp(async (base) => {
    const res = await postJson(base, '/api/v4/mobile/auth/otp/verify', { email: 'x@example.com' });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.ok(body.details.code);
  });
});

// ─── set-password: wrong ability, single-use, validation ───────────────

test('set-password: a SESSION token gets the SPEC-literal 403, not the generic ability message', async () => {
  await withApp(async (base) => {
    const loginRes = await postJson(base, '/api/v4/mobile/auth/login', { email: 'alice@example.com', password: ALICE_PASSWORD });
    const sessionToken = (await loginRes.json()).token;

    const res = await postJson(base, '/api/v4/mobile/auth/set-password',
      { password: 'WhateverPass1', password_confirmation: 'WhateverPass1' },
      bearer(sessionToken));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { success: false, error: 'This token cannot set a password.' });
  });
});

test('set-password: missing Authorization -> 401 Unauthenticated.', async () => {
  await withApp(async (base) => {
    const res = await postJson(base, '/api/v4/mobile/auth/set-password',
      { password: 'WhateverPass1', password_confirmation: 'WhateverPass1' });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { success: false, error: 'Unauthenticated.' });
  });
});

test('set-password: password too short -> 422 details', async () => {
  await withApp(async (base) => {
    const email = 'short@example.com';
    await postJson(base, '/api/v4/mobile/auth/otp/request', { email });
    const verifyRes = await postJson(base, '/api/v4/mobile/auth/otp/verify', { email, code: capturedCodes[email] });
    const token = (await verifyRes.json()).set_password_token;

    const res = await postJson(base, '/api/v4/mobile/auth/set-password',
      { password: 'short', password_confirmation: 'short' }, bearer(token));
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.ok(body.details.password);
  });
});

test('set-password: confirmation mismatch -> 422 details', async () => {
  await withApp(async (base) => {
    const email = 'mismatch@example.com';
    await postJson(base, '/api/v4/mobile/auth/otp/request', { email });
    const verifyRes = await postJson(base, '/api/v4/mobile/auth/otp/verify', { email, code: capturedCodes[email] });
    const token = (await verifyRes.json()).set_password_token;

    const res = await postJson(base, '/api/v4/mobile/auth/set-password',
      { password: 'GoodEnoughPass1', password_confirmation: 'DoesNotMatch1' }, bearer(token));
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.ok(body.details.password_confirmation);
  });
});

test('set-password: token is single-use — a second call with the same token -> 401', async () => {
  await withApp(async (base) => {
    const email = 'singleuse@example.com';
    await postJson(base, '/api/v4/mobile/auth/otp/request', { email });
    const verifyRes = await postJson(base, '/api/v4/mobile/auth/otp/verify', { email, code: capturedCodes[email] });
    const token = (await verifyRes.json()).set_password_token;

    const firstRes = await postJson(base, '/api/v4/mobile/auth/set-password',
      { password: 'FirstPass1!', password_confirmation: 'FirstPass1!' }, bearer(token));
    assert.equal(firstRes.status, 200);

    const secondRes = await postJson(base, '/api/v4/mobile/auth/set-password',
      { password: 'SecondPass1!', password_confirmation: 'SecondPass1!' }, bearer(token));
    assert.equal(secondRes.status, 401);
    assert.deepEqual(await secondRes.json(), { success: false, error: 'Unauthenticated.' });
  });
});

// ─── logout: any valid token, single-token revocation ───────────────────

test('logout: a session token -> 200 "Logged out.", and that exact token is now dead', async () => {
  await withApp(async (base) => {
    const loginRes = await postJson(base, '/api/v4/mobile/auth/login', { email: 'alice@example.com', password: ALICE_PASSWORD });
    const token = (await loginRes.json()).token;

    const res = await postJson(base, '/api/v4/mobile/auth/logout', {}, bearer(token));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true, message: 'Logged out.' });

    const again = await postJson(base, '/api/v4/mobile/auth/logout', {}, bearer(token));
    assert.equal(again.status, 401, 'the same token cannot be used twice');
  });
});

test('logout: a set-password token also authenticates ("any valid token")', async () => {
  await withApp(async (base) => {
    const email = 'logoutviaspt@example.com';
    await postJson(base, '/api/v4/mobile/auth/otp/request', { email });
    const verifyRes = await postJson(base, '/api/v4/mobile/auth/otp/verify', { email, code: capturedCodes[email] });
    const setPasswordToken = (await verifyRes.json()).set_password_token;

    const res = await postJson(base, '/api/v4/mobile/auth/logout', {}, bearer(setPasswordToken));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true, message: 'Logged out.' });
  });
});

test('logout: revokes ONLY the presented token — a second concurrent session survives', async () => {
  await withApp(async (base) => {
    const res1 = await postJson(base, '/api/v4/mobile/auth/login', { email: 'alice@example.com', password: ALICE_PASSWORD });
    const res2 = await postJson(base, '/api/v4/mobile/auth/login', { email: 'alice@example.com', password: ALICE_PASSWORD });
    const token1 = (await res1.json()).token;
    const token2 = (await res2.json()).token;

    const logoutRes = await postJson(base, '/api/v4/mobile/auth/logout', {}, bearer(token1));
    assert.equal(logoutRes.status, 200);
    assert.equal(tokens.length, 1, 'exactly one token remains');
    assert.equal(tokens[0].user_id, 1);

    // token2's session is untouched — logging out with it still works.
    const stillWorks = await postJson(base, '/api/v4/mobile/auth/logout', {}, bearer(token2));
    assert.equal(stillWorks.status, 200);
  });
});

test('logout: missing Authorization -> 401 Unauthenticated.', async () => {
  await withApp(async (base) => {
    const res = await postJson(base, '/api/v4/mobile/auth/logout', {});
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { success: false, error: 'Unauthenticated.' });
  });
});

// ─── Shared throttle bucket (SPEC 1597): 10/min/IP across ALL FOUR routes ─

test('the four public endpoints share ONE throttle bucket (path is not part of the key)', async () => {
  await withApp(async (base) => {
    const codes = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await postJson(base, '/api/v4/mobile/auth/check-email', { email: 'x@example.com' })).status);
    }
    for (let i = 0; i < 4; i++) {
      codes.push((await postJson(base, '/api/v4/mobile/auth/login', { email: 'x@example.com', password: 'x' })).status);
    }
    // 10 requests spent across TWO different routes — the 11th, on a
    // THIRD route, is still throttled, proving one shared bucket.
    const eleventh = await postJson(base, '/api/v4/mobile/auth/otp/request', { email: 'x@example.com' });
    codes.push(eleventh.status);

    assert.ok(codes.slice(0, 10).every((c) => c !== 429), 'first 10 requests all went through');
    assert.equal(eleventh.status, 429, 'the 11th request, on a different route, is throttled');
  });
});

test('set-password and logout are NOT gated by the public throttle bucket', async () => {
  await withApp(async (base) => {
    // Exhaust the public bucket entirely.
    for (let i = 0; i < 10; i++) {
      await postJson(base, '/api/v4/mobile/auth/check-email', { email: 'x@example.com' });
    }
    const exhausted = await postJson(base, '/api/v4/mobile/auth/check-email', { email: 'x@example.com' });
    assert.equal(exhausted.status, 429);

    // logout still gets a normal auth response (401, not 429) — it's on
    // its own token-gate, not the public IP bucket.
    const logoutRes = await postJson(base, '/api/v4/mobile/auth/logout', {});
    assert.equal(logoutRes.status, 401);
  });
});

// ─── computeLevel (direct unit test — see the export's doc comment) ────

test('computeLevel: no onchain account + password not set -> guest', async () => {
  const { computeLevel } = require('../src/routes/topochain/mobile-auth');
  const pool = { query: async () => ({ rows: [] }) };
  assert.equal(await computeLevel(pool, 999, false), 'guest');
});

test('computeLevel: no onchain account + password set -> member', async () => {
  const { computeLevel } = require('../src/routes/topochain/mobile-auth');
  const pool = { query: async () => ({ rows: [] }) };
  assert.equal(await computeLevel(pool, 999, true), 'member');
});

test('computeLevel: any onchain account -> operator, regardless of password_set', async () => {
  const { computeLevel } = require('../src/routes/topochain/mobile-auth');
  const pool = { query: async () => ({ rows: [{ x: 1 }] }) };
  assert.equal(await computeLevel(pool, 999, false), 'operator');
});
