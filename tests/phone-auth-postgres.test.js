'use strict';

// Real-PostgreSQL tests for the phone sign-in account rules
// (services/firebase-phone-auth.js) and the route wiring
// (routes/phone-auth.js). The unit file pins the Firebase-facing halves
// with stubs; this one pins what only a database can prove:
//
//   - A brand-new account is the email code's account: placeholder
//     handle, needs_username_choice, no password — then the username
//     continuation Apple and Google share is spent by /finish.
//   - The second sign-in with the same Firebase uid finds the SAME
//     account (the uid is the lookup key, not the number).
//   - One account per number: a different uid with the same number is
//     refused phone_in_use and the user row it inserted is ROLLED BACK.
//   - An admin account is refused, the email code's way.
//   - An ID token is spent once against the real phone_sign_in_tokens.
//   - The route boundary: 404 not_offered when the flow is off, and the
//     session-mint guard answers 409 over a live session.
//
// Run with: node --test tests/phone-auth-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Client, Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';

const DDL = `
  CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    email_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
    email_confirmed_at TIMESTAMPTZ,
    password_set BOOLEAN NOT NULL DEFAULT FALSE,
    is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    admin_readonly BOOLEAN NOT NULL DEFAULT FALSE,
    has_platform_access BOOLEAN NOT NULL DEFAULT FALSE,
    needs_username_choice BOOLEAN NOT NULL DEFAULT FALSE,
    needs_communities_choice BOOLEAN NOT NULL DEFAULT FALSE,
    getting_started_gate BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ
  );
  CREATE UNIQUE INDEX users_email_lower_unique
    ON users (lower(email)) WHERE email IS NOT NULL;
  CREATE TABLE username_history (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username VARCHAR(255) NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE sessions (
    token VARCHAR(64) PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    native_session_credential_reference VARCHAR(47)
  );
  CREATE TABLE oauth_signup_sessions (
    token_hash  VARCHAR(64) PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    provider    TEXT NOT NULL CHECK (provider IN ('apple', 'google', 'phone')),
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE user_phone_identities (
    id           BIGSERIAL PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    firebase_uid TEXT NOT NULL UNIQUE CHECK (char_length(firebase_uid) BETWEEN 1 AND 128),
    phone_e164   VARCHAR(16) NOT NULL UNIQUE CHECK (phone_e164 ~ '^\\+[1-9][0-9]{1,14}$'),
    last_used_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id)
  );
  CREATE TABLE phone_sign_in_tokens (
    token_hash VARCHAR(64) PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE phone_auth_failures (
    id            BIGSERIAL PRIMARY KEY,
    kind          TEXT NOT NULL CHECK (kind IN
                    ('code_request', 'verify', 'link_request', 'link_verify')),
    user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    phone_last4   VARCHAR(4) CHECK (phone_last4 ~ '^[0-9]{4}$'),
    error_code    TEXT NOT NULL,
    provider_code TEXT,
    message       TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX idx_phone_auth_failures_created
    ON phone_auth_failures (created_at DESC);
`;

const OFFERED_CONFIG = {
  firebasePhoneAuthEnabled: true,
  firebaseWebApiKey: 'web-key',
  firebaseProjectId: 'proj',
  firebaseServiceAccountJsonB64: 'e30=',
};

async function withDatabase(t, run) {
  const admin = new Client({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch (error) {
    await admin.end().catch(() => {});
    return t.skip(`no postgres reachable at ${DSN}: ${error.message || error.code || error}`);
  }

  const schema = `phone_auth_test_${process.pid}`;
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: DSN,
    connectionTimeoutMillis: 3000,
    options: `-c search_path=${schema}`,
  });
  try {
    await pool.query(DDL);
    await run(pool);
  } finally {
    await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

// The route modules read the pool through src/db/pool; swap the module in
// require.cache the way tests/email-signup-postgres.test.js does, so the
// real handlers run against this test's schema.
function stubPoolModule(pool) {
  const poolPath = require.resolve('../src/db/pool');
  const authPath = require.resolve('../src/routes/auth');
  const phonePath = require.resolve('../src/routes/phone-auth');
  const originalPool = require.cache[poolPath];
  require.cache[poolPath] = {
    exports: { getPool: () => pool },
    loaded: true,
    id: poolPath,
    filename: poolPath,
    paths: originalPool ? originalPool.paths : [],
  };
  delete require.cache[authPath];
  delete require.cache[phonePath];
  return () => {
    if (originalPool) require.cache[poolPath] = originalPool;
    else delete require.cache[poolPath];
    delete require.cache[authPath];
    delete require.cache[phonePath];
  };
}

function post(base, path, body = {}, headers = {}) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('real PostgreSQL phone sign-up and sign-in follow the account rules', async (t) => {
  await withDatabase(t, async (pool) => {
    const restorePool = stubPoolModule(pool);
    try {
      const { createSession } = require('../src/routes/auth');
      const phoneAuth = require('../src/services/firebase-phone-auth');
      const providers = require('../src/services/sign-in-providers');

      // ── First sign-in with this Firebase uid makes the account ──
      const first = await phoneAuth.signIn(
        pool, { uid: 'firebase-uid-1', phoneNumber: '+15551234567' }, { createSession }
      );
      assert.equal(first.next, 'username', 'a brand-new account owes a handle');
      assert.equal(first.created, true);
      assert.match(first.signupToken, /^[0-9a-f]{64}$/);

      const pendingRow = (await pool.query(
        `SELECT u.username, u.needs_username_choice, u.password_set, u.email,
                i.phone_e164, i.firebase_uid
           FROM users u JOIN user_phone_identities i ON i.user_id = u.id
          WHERE u.id = $1`,
        [first.userId]
      )).rows[0];
      assert.match(pendingRow.username, /^member_[0-9a-f]{18}$/,
        'the number is never the handle, and nothing is derived from it');
      assert.equal(pendingRow.needs_username_choice, true);
      assert.equal(pendingRow.password_set, false);
      assert.equal(pendingRow.email, null, 'a phone account has no address to hold');
      assert.equal(pendingRow.firebase_uid, 'firebase-uid-1');
      assert.equal(pendingRow.phone_e164, '+15551234567');

      const signupRow = (await pool.query(
        `SELECT provider, user_id FROM oauth_signup_sessions WHERE token_hash = $1`,
        [require('crypto').createHash('sha256').update(first.signupToken).digest('hex')]
      )).rows[0];
      assert.equal(signupRow.provider, 'phone',
        'the phone continuation rides the same oauth_signup_sessions table');
      assert.equal(signupRow.user_id, first.userId);

      // ── The username step, through the route, mints the session ──
      const { authRoutes } = require('../src/routes/auth');
      const { phoneAuthRoutes } = require('../src/routes/phone-auth');
      const app = express();
      app.use(express.json());
      app.use(cookieParser());
      app.use(authRoutes({}));
      app.use(phoneAuthRoutes(OFFERED_CONFIG));
      const server = app.listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        const finish = await post(base, '/api/auth/phone/finish',
          { username: 'phonefan' },
          { cookie: `hr_phone_signup=${first.signupToken}` });
        assert.equal(finish.status, 200);
        const finished = await finish.json();
        assert.equal(finished.user.username, 'phonefan');
        assert.match(finish.headers.get('set-cookie'), /session=/);
        assert.match(finish.headers.get('set-cookie'), /HttpOnly/i);
        assert.equal(finished.user.isAdmin, false);
        assert.equal(finished.user.role, 'user');

        // The continuation is spent and the handle really landed.
        assert.equal((await pool.query(
          'SELECT 1 FROM oauth_signup_sessions WHERE user_id = $1', [first.userId]
        )).rowCount, 0);
        assert.equal((await pool.query(
          'SELECT needs_username_choice FROM users WHERE id = $1', [first.userId]
        )).rows[0].needs_username_choice, false);

        // ── The second sign-in with the SAME uid finds the same account ──
        const second = await phoneAuth.signIn(
          pool, { uid: 'firebase-uid-1', phoneNumber: '+15551234567' }, { createSession }
        );
        assert.equal(second.next, 'signed-in');
        assert.equal(second.created, false);
        assert.equal(second.userId, first.userId);
        assert.equal(second.user.username, 'phonefan');

        // ── One account per number: a different uid is refused ──
        const before = (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
        await assert.rejects(
          () => phoneAuth.signIn(
            pool, { uid: 'firebase-uid-2', phoneNumber: '+15551234567' }, { createSession }
          ),
          (err) => err.code === 'phone_in_use' && err.status === 422,
        );
        assert.equal(
          (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n,
          before,
          'the loser’s user row must be rolled back, not left behind',
        );

        // ── An admin account signs in with its password, never a phone ──
        const adminRow = (await pool.query(
          `INSERT INTO users (username, password, is_admin, password_set, needs_username_choice)
           VALUES ('admin-with-phone', 'x', TRUE, TRUE, FALSE) RETURNING id`
        )).rows[0];
        await pool.query(
          `INSERT INTO user_phone_identities (user_id, firebase_uid, phone_e164)
           VALUES ($1, 'firebase-uid-3', '+15557654321')`,
          [adminRow.id]
        );
        const refused = await phoneAuth.signIn(
          pool, { uid: 'firebase-uid-3', phoneNumber: '+15557654321' }, { createSession }
        );
        assert.deepEqual(refused, { refuse: 'admin_password_required' });

        // ── The route is fail-closed when the flow is not offered ──
        const offApp = express();
        offApp.use(express.json());
        offApp.use(cookieParser());
        offApp.use(phoneAuthRoutes({}));
        const offServer = offApp.listen(0, '127.0.0.1');
        await new Promise((resolve) => offServer.once('listening', resolve));
        try {
          const offRes = await post(
            `http://127.0.0.1:${offServer.address().port}`,
            '/api/auth/phone/request', { phoneNumber: '+15551234567' });
          assert.equal(offRes.status, 404);
          assert.equal((await offRes.json()).code, 'not_offered');
        } finally {
          offServer.close();
        }

        // ── The session-mint guard answers 409 over a live session ──
        const liveToken = 'a'.repeat(64);
        await pool.query(
          `INSERT INTO sessions (token, user_id, expires_at)
           VALUES ($1, $2, NOW() + INTERVAL '1 day')`,
          [liveToken, first.userId]
        );
        const minted = await post(base, '/api/auth/phone/verify', { code: '123456' }, {
          cookie: `session=${liveToken}`,
        });
        assert.equal(minted.status, 409);
        assert.equal((await minted.json()).code, 'logout_required');
      } finally {
        server.close();
      }

      // ── An ID token is spent once against the real table ──
      const payload = {
        uid: 'firebase-uid-9',
        sub: 'firebase-uid-9',
        phone_number: '+15551112222',
        firebase: { sign_in_provider: 'phone' },
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const claims = await phoneAuth.verifyIdToken(pool, OFFERED_CONFIG, 'real-token', {
        auth: { verifyIdToken: async () => payload },
      });
      assert.deepEqual(claims, { uid: 'firebase-uid-9', phoneNumber: '+15551112222' });
      await assert.rejects(
        () => phoneAuth.verifyIdToken(pool, OFFERED_CONFIG, 'real-token', {
          auth: { verifyIdToken: async () => payload },
        }),
        (err) => err.code === 'bad_token',
        'the replay must be refused, not signed in again',
      );
      assert.equal((await pool.query(
        'SELECT count(*)::int AS n FROM phone_sign_in_tokens'
      )).rows[0].n, 1);
    } finally {
      restorePool();
    }
  });
});

// The failure log (phone_auth_failures, read by Admin → SMS delivery):
// every refused code request, verification and link attempt the ROUTES
// answer leaves one row — this API's code, Firebase's own code beside it,
// the account when one is signed in, and the number's last four digits
// where the request carried or produced one.
test('refused phone requests, verifications and links land in the failure log', async (t) => {
  await withDatabase(t, async (pool) => {
    const restorePool = stubPoolModule(pool);
    const realFetch = globalThis.fetch;
    try {
      const { phoneAuthRoutes } = require('../src/routes/phone-auth');
      const phoneAuth = require('../src/services/firebase-phone-auth');

      // The offered app, with PHONE_TEST_CODE so the link leg can earn a
      // test session without any outbound call. Identity Toolkit is the one
      // outbound call left; the stub refuses it the way a real quota does.
      const config = { ...OFFERED_CONFIG, phoneTestCode: '654321' };
      globalThis.fetch = async (url, opts) => {
        if (String(url).startsWith('https://identitytoolkit.googleapis.com/')) {
          return {
            ok: false,
            status: 400,
            json: async () => ({ error: { message: 'QUOTA_EXCEEDED : project over its SMS quota' } }),
          };
        }
        return realFetch(url, opts);
      };

      const app = express();
      app.use(express.json());
      app.use(cookieParser());
      // The signed-in account the link legs act for; its row exists, so the
      // failure log's FK holds.
      await pool.query(`INSERT INTO users (id, username, password) VALUES (42, 'phonelink', 'x')`);
      await pool.query(`INSERT INTO users (id, username, password) VALUES (7, 'already-has-it', 'x')`);
      await pool.query(
        `INSERT INTO user_phone_identities (user_id, firebase_uid, phone_e164)
         VALUES (7, 'test-phone:+15555550101', '+15555550101')`
      );
      app.use((req, _res, next) => {
        req.user = { id: 42, username: 'phonelink' };
        next();
      });
      app.use(phoneAuthRoutes(config));
      const server = app.listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      try {
        // A malformed number never reaches Firebase: refused here, logged
        // with no digits, because there are none worth keeping.
        const malformed = await post(base(server), '/api/auth/phone/request', { phoneNumber: '555-1234' });
        assert.equal(malformed.status, 422);
        assert.equal((await malformed.json()).code, 'invalid_phone');

        // A well-formed number Firebase refuses: both codes land, ours and
        // Firebase's own, with the digits the request carried.
        const refused = await post(base(server), '/api/auth/phone/request', { phoneNumber: '+15551234567' });
        assert.equal(refused.status, 502);
        assert.equal((await refused.json()).code, 'firebase_unreachable');

        // The link leg against a number another account holds: refused
        // AFTER the claims are in hand, so the row carries the account the
        // attempt was made for and the digits it was about.
        const sent = await post(base(server), '/api/auth/phone-link/request', { phoneNumber: '+15555550101' });
        assert.equal(sent.status, 200);
        const { sessionInfo } = await sent.json();
        const linked = await post(base(server), '/api/auth/phone-link/verify', { sessionInfo, code: '654321' });
        assert.equal(linked.status, 422);
        assert.equal((await linked.json()).code, 'phone_in_use');
      } finally {
        server.close();
      }

      const rows = (await pool.query(
        `SELECT kind, user_id, phone_last4, error_code, provider_code, message
           FROM phone_auth_failures ORDER BY id`
      )).rows;
      assert.equal(rows.length, 3);
      assert.deepEqual(rows[0], {
        kind: 'code_request', user_id: null, phone_last4: null,
        error_code: 'invalid_phone', provider_code: null,
        message: 'Enter a valid phone number.',
      });
      assert.deepEqual(rows[1], {
        kind: 'code_request', user_id: null, phone_last4: '4567',
        error_code: 'firebase_unreachable', provider_code: 'QUOTA_EXCEEDED',
        message: 'Could not reach the sign-in service. Try again.',
      });
      assert.deepEqual(rows[2], {
        kind: 'link_verify', user_id: 42, phone_last4: '0101',
        error_code: 'phone_in_use', provider_code: null,
        message: 'That phone number already has an account.',
      });

      // The failure log is reaped with the rest of the expired state:
      // anything older than 30 days goes, the fresh rows stay.
      await pool.query(
        `INSERT INTO phone_auth_failures (kind, error_code, message, created_at)
         VALUES ('verify', 'bad_token', 'old row', NOW() - INTERVAL '31 days')`
      );
      await phoneAuth.cleanupExpired(pool);
      const kept = (await pool.query(
        `SELECT count(*)::int AS n FROM phone_auth_failures WHERE message = 'old row'`
      )).rows[0].n;
      assert.equal(kept, 0, 'a failure row past its 30 days is reaped');
      assert.equal((await pool.query(
        'SELECT count(*)::int AS n FROM phone_auth_failures'
      )).rows[0].n, 3, 'the fresh rows survive the reap');
    } finally {
      globalThis.fetch = realFetch;
      restorePool();
    }
  });
});

function base(server) {
  return `http://127.0.0.1:${server.address().port}`;
}
