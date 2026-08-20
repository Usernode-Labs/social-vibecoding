// POST /api/v4/mobile/auth/from-session — the platform-login unification
// bridge (thin-shell migration, NATIVE-BRIDGE.md bridge v4). Exchanges a
// live platform WEB session cookie for a mobile bearer token so the SV
// shell can log a user in once on the web surface and hand the native app
// a credential over the JS bridge.
//
// Contracts guarded here:
//
//   1. Session-gated: no/expired/unknown session cookie -> 401, identical
//      envelope to every other mobile-auth failure.
//   2. A valid session mints a `session`-ability token: response is the
//      same `{token, user}` shape as POST /login, and only the sha256 of
//      the token is persisted (raw token never hits the DB).
//   3. Identity comes from the session row — the endpoint takes NO body
//      input that could redirect the mint to another user.
//   4. Web-only accounts (email NULL) still get a token — email rides as
//      null in the user payload.
//
// HTTP-level tests against a throwaway express app + a substring-
// dispatching mock pool (same idiom as tests/challenges-web-routes.test.js).
//
// Run with: node --test tests/mobile-auth-from-session.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { mobileIdentityHash } = require('../src/services/mobile-identity-hash');
const cookieParser = require('cookie-parser');

// ─── Fixtures ─────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;

const WEB_USER = {
  id: 7,
  username: 'webuser',
  email: 'web@example.com',
  display_name: 'Web User',
  email_confirmed: true,
  password_set: true,
  is_admin: false,
};

// A username/password-only platform account (pre-topochain-merge shape):
// no email, password_set TRUE. Must still be able to mint a token.
const EMAILLESS_USER = {
  id: 8,
  username: 'walletonly',
  email: null,
  display_name: null,
  email_confirmed: false,
  password_set: true,
  is_admin: false,
};

const USERS = { [WEB_USER.id]: WEB_USER, [EMAILLESS_USER.id]: EMAILLESS_USER };

const SESSIONS = {
  'good-session': { user_id: WEB_USER.id, expires_at: new Date(Date.now() + DAY) },
  'emailless-session': { user_id: EMAILLESS_USER.id, expires_at: new Date(Date.now() + DAY) },
  'expired-session': { user_id: WEB_USER.id, expires_at: new Date(Date.now() - DAY) },
};

function collapse(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function makeMockPool(state) {
  async function query(rawSql, params = []) {
    const sql = collapse(rawSql);

    // optionalSessionAuth's session-cookie resolution.
    if (sql.includes('FROM sessions s JOIN users u')) {
      const s = SESSIONS[params[0]];
      if (!s) return { rows: [] };
      const u = USERS[s.user_id];
      return {
        rows: [{
          user_id: s.user_id,
          expires_at: s.expires_at,
          username: u.username,
          is_admin: u.is_admin,
        }],
      };
    }

    // from-session's own user-row fetch.
    if (sql.includes('SELECT id, email, display_name, email_confirmed, password_set FROM users WHERE id = $1')) {
      const u = USERS[params[0]];
      if (!u) return { rows: [] };
      return { rows: [{ ...u }] };
    }

    // issueToken's insert — capture what gets persisted.
    if (sql.includes('INSERT INTO mobile_auth_tokens')) {
      state.tokenInserts.push({
        userId: params[0],
        tokenHash: params[1],
        ability: params[2],
        expiresAt: params[3],
      });
      return { rows: [] };
    }

    // computeLevel's operator check.
    if (sql.includes('SELECT 1 FROM onchain_accounts WHERE user_id = $1')) {
      return { rows: [] }; // no custodial account yet -> member/guest
    }

    throw new Error(`Unhandled mock query: ${sql}`);
  }
  return { query };
}

// ─── Test app wiring (same require-cache swap as the sibling tests) ────

function withApp(fn) {
  const state = { tokenInserts: [] };
  const poolModulePath = require.resolve('../src/db/pool');
  const original = require.cache[poolModulePath];
  require.cache[poolModulePath] = {
    exports: { getPool: () => makeMockPool(state) },
    loaded: true, id: poolModulePath, filename: poolModulePath, paths: original ? original.paths : [],
  };
  const mobileAuthModulePath = require.resolve('../src/routes/topochain/mobile-auth');
  delete require.cache[mobileAuthModulePath];
  try {
    const { topochainMobileAuthRoutes } = require('../src/routes/topochain/mobile-auth');
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(topochainMobileAuthRoutes({ databaseUrl: 'postgres://fake/fake', env: 'test' }));
    return fn(app, state);
  } finally {
    if (original) require.cache[poolModulePath] = original;
    else delete require.cache[poolModulePath];
    delete require.cache[mobileAuthModulePath];
  }
}

async function withServer(fn) {
  return withApp(async (app, state) => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await fn(base, state);
    } finally {
      server.close();
    }
  });
}

function post(base, headers = {}) {
  return fetch(`${base}/api/v4/mobile/auth/from-session`, {
    method: 'POST',
    headers,
  });
}

// ─── 1. Session gating ────────────────────────────────────────────────

test('anonymous request is refused with 401', async () => {
  await withServer(async (base) => {
    const res = await post(base);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error, 'Unauthenticated.');
  });
});

test('expired session is refused with 401', async () => {
  await withServer(async (base) => {
    const res = await post(base, { cookie: 'session=expired-session' });
    assert.equal(res.status, 401);
  });
});

test('unknown session token is refused with 401', async () => {
  await withServer(async (base) => {
    const res = await post(base, { cookie: 'session=no-such-session' });
    assert.equal(res.status, 401);
  });
});

// ─── 2. Valid session mints a login-shaped token ──────────────────────

test('valid session returns the /login response shape', async () => {
  await withServer(async (base, state) => {
    const res = await post(base, { cookie: 'session=good-session' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(typeof body.token, 'string');
    assert.equal(body.token.length, 80); // 40 random bytes as hex
    assert.deepEqual(body.user, {
      id: WEB_USER.id,
      email: WEB_USER.email,
      display_name: WEB_USER.display_name,
      email_confirmed: true,
      level: 'member',
      // The mobile app's local-storage namespace. The session-bridge login
      // must hand back the SAME namespace as /login and /me for this user,
      // or the app would resolve a second one and lose its local accounts.
      identity_hash: mobileIdentityHash(WEB_USER),
    });

    // Only the sha256 of the raw token is persisted, ability 'session'.
    assert.equal(state.tokenInserts.length, 1);
    const insert = state.tokenInserts[0];
    assert.equal(insert.userId, WEB_USER.id);
    assert.equal(insert.ability, 'session');
    assert.equal(
      insert.tokenHash,
      crypto.createHash('sha256').update(body.token).digest('hex')
    );
    assert.ok(new Date(insert.expiresAt) > new Date(Date.now() + 80 * DAY));
  });
});

// ─── 3. Identity comes only from the session ──────────────────────────

test('a body claiming another user id has no effect', async () => {
  await withServer(async (base, state) => {
    const res = await fetch(`${base}/api/v4/mobile/auth/from-session`, {
      method: 'POST',
      headers: { cookie: 'session=good-session', 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: EMAILLESS_USER.id, id: EMAILLESS_USER.id }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user.id, WEB_USER.id);
    assert.equal(state.tokenInserts[0].userId, WEB_USER.id);
  });
});

// ─── 4. Web-only (email-less) accounts are first-class ────────────────

test('an account without an email still mints a token', async () => {
  await withServer(async (base) => {
    const res = await post(base, { cookie: 'session=emailless-session' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user.id, EMAILLESS_USER.id);
    assert.equal(body.user.email, null);
    assert.equal(typeof body.token, 'string');
  });
});
