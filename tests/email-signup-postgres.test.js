'use strict';

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
    platform_access_granted_at TIMESTAMPTZ
  );
  CREATE UNIQUE INDEX users_email_lower_unique
    ON users (lower(email)) WHERE email IS NOT NULL;
  CREATE TABLE sessions (
    token VARCHAR(64) PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE mobile_otp_codes (
    id BIGSERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    code_hash VARCHAR(255) NOT NULL,
    attempts SMALLINT NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
  );
  CREATE TABLE web_signup_sessions (
    token_hash VARCHAR(64) PRIMARY KEY,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE mobile_auth_tokens (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    ability VARCHAR(20) NOT NULL CHECK (ability = 'session'),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE seasons (
    id BIGINT PRIMARY KEY,
    internal BOOLEAN NOT NULL,
    is_active BOOLEAN NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE onchain_accounts (
    id BIGINT PRIMARY KEY,
    address VARCHAR(100) NOT NULL,
    public_key VARCHAR(64) NOT NULL,
    secret_key VARCHAR(64) NOT NULL,
    season_event_id BIGINT,
    season_id BIGINT NOT NULL REFERENCES seasons(id),
    user_id INTEGER REFERENCES users(id),
    updated_at TIMESTAMPTZ
  );
  CREATE UNIQUE INDEX onchain_accounts_user_season_unique
    ON onchain_accounts (user_id, season_id)
    WHERE user_id IS NOT NULL AND season_event_id IS NULL;
  CREATE TABLE user_enrollments (
    id BIGSERIAL PRIMARY KEY,
    season_event_id BIGINT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    season_id BIGINT NOT NULL REFERENCES seasons(id),
    registered_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
  );
  CREATE UNIQUE INDEX user_enrollments_user_season_unique
    ON user_enrollments (user_id, season_id) WHERE season_event_id IS NULL;
  CREATE TABLE native_session_credentials (
    credential_reference VARCHAR(47) PRIMARY KEY,
    account_id BIGINT NOT NULL REFERENCES onchain_accounts(id)
  );
  CREATE TABLE waitlist_signups (
    email VARCHAR(255) PRIMARY KEY,
    linked_user_id INTEGER,
    released_at TIMESTAMPTZ
  );
  CREATE TABLE mail_deliveries (
    id BIGSERIAL PRIMARY KEY,
    kind TEXT NOT NULL,
    recipient_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

async function withDatabase(t, run) {
  const admin = new Client({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch (error) {
    await admin.end().catch(() => {});
    return t.skip(`no postgres reachable at ${DSN}: ${error.message || error.code || error}`);
  }

  const schema = `email_signup_test_${process.pid}`;
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

function cookieValue(headers, name) {
  const cookies = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter(Boolean);
  const match = cookies.map((cookie) => new RegExp(`(?:^|, )${name}=([^;]*)`).exec(cookie))
    .find(Boolean);
  return match ? decodeURIComponent(match[1]) : null;
}

test('real PostgreSQL web signup keeps authority in HttpOnly cookies', async (t) => {
  await withDatabase(t, async (pool) => {
    const poolPath = require.resolve('../src/db/pool');
    const authPath = require.resolve('../src/routes/auth');
    const mobilePath = require.resolve('../src/routes/topochain/mobile');
    const mail = require('../src/services/mail');
    const originalPool = require.cache[poolPath];
    const originalSend = mail.sendOtpMail;
    const originalPrune = mail.pruneDeliveries;
    let code = null;
    require.cache[poolPath] = {
      exports: { getPool: () => pool },
      loaded: true,
      id: poolPath,
      filename: poolPath,
      paths: originalPool ? originalPool.paths : [],
    };
    mail.sendOtpMail = async (_config, _email, value) => { code = value; };
    mail.pruneDeliveries = async () => {};
    delete require.cache[authPath];
    delete require.cache[mobilePath];

    const { authRoutes } = require('../src/routes/auth');
    const { topochainMobileRoutes } = require('../src/routes/topochain/mobile');
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(topochainMobileRoutes({}));
    app.use(authRoutes({}));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const request = await fetch(`${base}/api/auth/otp/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'New.User@example.com' }),
      });
      assert.equal(request.status, 200);
      assert.match(code, /^[0-9]{6}$/);

      const verify = await fetch(`${base}/api/auth/otp/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'new.user@example.com', code }),
      });
      assert.equal(verify.status, 200);
      assert.deepEqual(await verify.json(), { ok: true });
      const signupCookie = cookieValue(verify.headers, 'usernode_signup');
      assert.match(signupCookie, /^[0-9a-f]{64}$/);
      assert.match(verify.headers.get('set-cookie'), /HttpOnly/i);
      assert.match(verify.headers.get('set-cookie'), /Path=\/api\/auth\/otp/i);

      const complete = await fetch(`${base}/api/auth/otp/set-password`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `usernode_signup=${signupCookie}`,
        },
        body: JSON.stringify({
          password: 'correct horse battery staple',
          passwordConfirmation: 'correct horse battery staple',
        }),
      });
      assert.equal(complete.status, 200);
      const body = await complete.json();
      assert.deepEqual(Object.keys(body), ['user']);
      assert.equal(body.user.username, 'new.user@example.com');
      assert.equal('token' in body, false);
      const sessionCookie = cookieValue(complete.headers, 'session');
      assert.match(sessionCookie, /^[0-9a-f]{64}$/);
      assert.match(complete.headers.get('set-cookie'), /HttpOnly/i);

      assert.equal((await pool.query(
        'SELECT COUNT(*)::int AS count FROM web_signup_sessions',
      )).rows[0].count, 0);
      assert.equal((await pool.query(
        'SELECT COUNT(*)::int AS count FROM sessions WHERE token = $1',
        [sessionCookie],
      )).rows[0].count, 1);
      assert.equal((await pool.query(
        'SELECT COUNT(*)::int AS count FROM mobile_auth_tokens',
      )).rows[0].count, 0);

      const replay = await fetch(`${base}/api/auth/otp/set-password`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `usernode_signup=${signupCookie}`,
        },
        body: JSON.stringify({ password: 'another password', passwordConfirmation: 'another password' }),
      });
      assert.equal(replay.status, 422);
      assert.equal((await replay.json()).code, 'invalid_signup_session');

      const { rows: sourceRows } = await pool.query(
        `INSERT INTO users
           (username, password, email, email_confirmed, password_set)
         VALUES ('legacy@example.com', 'unused', 'legacy@example.com', TRUE, TRUE)
         RETURNING id`,
      );
      const sourceId = sourceRows[0].id;
      await pool.query(
        `INSERT INTO seasons (id, internal, is_active, starts_at, ends_at)
         VALUES (10, FALSE, TRUE, NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day')`,
      );
      await pool.query(
        `INSERT INTO onchain_accounts
           (id, address, public_key, secret_key, season_id, user_id, updated_at)
         VALUES (400, 'ut1legacy', 'utpk1legacy', 'utsk1legacy', 10, $1, NOW())`,
        [sourceId],
      );
      await pool.query(
        `INSERT INTO mobile_auth_tokens
           (user_id, token_hash, ability, expires_at)
         VALUES ($1, repeat('a', 64), 'session', NOW() + INTERVAL '1 day')`,
        [sourceId],
      );

      code = null;
      const claimCodeRequest = await fetch(`${base}/api/auth/otp/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'legacy@example.com' }),
      });
      assert.equal(claimCodeRequest.status, 200);
      assert.match(code, /^[0-9]{6}$/);

      const claim = await fetch(`${base}/api/v4/mobile/wallet/claim`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `session=${sessionCookie}`,
        },
        body: JSON.stringify({ email: 'legacy@example.com', code }),
      });
      assert.equal(claim.status, 200);
      const claimed = await claim.json();
      assert.equal(claimed.claimed, true);
      assert.equal(claimed.address, 'ut1legacy');
      assert.equal('secret_key' in claimed, false);
      assert.equal((await pool.query(
        'SELECT user_id FROM onchain_accounts WHERE id = 400',
      )).rows[0].user_id, body.user.id);
      assert.equal((await pool.query(
        'SELECT COUNT(*)::int AS count FROM user_enrollments WHERE user_id = $1 AND season_id = 10',
        [body.user.id],
      )).rows[0].count, 1);
      assert.equal((await pool.query(
        'SELECT COUNT(*)::int AS count FROM mobile_auth_tokens WHERE user_id = $1',
        [sourceId],
      )).rows[0].count, 0);

      // A key already published to a protocol-2 installation cannot be
      // revoked by deleting a server bearer. Keep ownership unchanged until
      // the deferred on-chain key-rotation primitive exists.
      await pool.query(
        'UPDATE onchain_accounts SET user_id = $1 WHERE id = 400',
        [sourceId],
      );
      await pool.query(
        'DELETE FROM user_enrollments WHERE user_id = $1 AND season_id = 10',
        [body.user.id],
      );
      await pool.query(
        `INSERT INTO native_session_credentials (credential_reference, account_id)
         VALUES ('nsc_bound_legacy_wallet', 400)`,
      );
      code = null;
      await fetch(`${base}/api/auth/otp/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'legacy@example.com' }),
      });
      const blockedClaim = await fetch(`${base}/api/v4/mobile/wallet/claim`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `session=${sessionCookie}`,
        },
        body: JSON.stringify({ email: 'legacy@example.com', code }),
      });
      assert.equal(blockedClaim.status, 409);
      assert.equal((await blockedClaim.json()).code, 'wallet_claim_requires_key_rotation');
      assert.equal((await pool.query(
        'SELECT user_id FROM onchain_accounts WHERE id = 400',
      )).rows[0].user_id, sourceId);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      mail.sendOtpMail = originalSend;
      mail.pruneDeliveries = originalPrune;
      if (originalPool) require.cache[poolPath] = originalPool;
      else delete require.cache[poolPath];
      delete require.cache[authPath];
      delete require.cache[mobilePath];
    }
  });
});

// #1548 made the invite link request a code by itself, which turns an
// ordinary reload into a second request for the same address. The mail
// layer already refuses to SEND inside RULES.otp.minGapMs, so before this
// rule the reload silently replaced the live code with one nobody could
// read — the recipient's email held a code the server had already thrown
// away. Reusing the outstanding code inside the same window is what makes
// the auto-send safe to repeat.
test('a repeat code request inside the min gap reuses the outstanding code', async (t) => {
  await withDatabase(t, async (pool) => {
    const poolPath = require.resolve('../src/db/pool');
    const authPath = require.resolve('../src/routes/auth');
    const mail = require('../src/services/mail');
    const originalPool = require.cache[poolPath];
    const originalSend = mail.sendOtpMail;
    const originalPrune = mail.pruneDeliveries;
    const sent = [];
    require.cache[poolPath] = {
      exports: { getPool: () => pool },
      loaded: true,
      id: poolPath,
      filename: poolPath,
      paths: originalPool ? originalPool.paths : [],
    };
    mail.sendOtpMail = async (_config, _email, value) => { sent.push(value); };
    mail.pruneDeliveries = async () => {};
    delete require.cache[authPath];

    const { authRoutes } = require('../src/routes/auth');
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(authRoutes({}));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = () => fetch(`${base}/api/auth/otp/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'invited@example.com' }),
    });
    const liveRow = async () => (await pool.query(
      `SELECT id, code_hash FROM mobile_otp_codes
        WHERE email = 'invited@example.com' AND consumed_at IS NULL`,
    )).rows;

    try {
      assert.equal((await request()).status, 200);
      const first = await liveRow();
      assert.equal(first.length, 1);
      assert.equal(sent.length, 1);

      // The reload. Same 200 (the endpoint never tells a caller whether an
      // address exists), but the row and the code behind it must survive.
      assert.equal((await request()).status, 200);
      const second = await liveRow();
      assert.equal(second.length, 1);
      assert.equal(second[0].id, first[0].id, 'the outstanding code must be reused');
      assert.equal(second[0].code_hash, first[0].code_hash);
      assert.equal(sent.length, 1, 'a reused code must not be re-sent');

      // A wrong guess ends the reuse: whoever is typing has seen the code
      // fail, so the next request has to be a genuinely new one.
      await pool.query(
        `UPDATE mobile_otp_codes SET attempts = 1 WHERE id = $1`, [first[0].id],
      );
      assert.equal((await request()).status, 200);
      const third = await liveRow();
      assert.equal(third.length, 1);
      assert.notEqual(third[0].id, first[0].id, 'a guessed-at code must be replaced');
      assert.equal(sent.length, 2);

      // And so does age. Past the window the code is replaced even though it
      // is unexpired and untouched, so "send a new code" means what it says.
      await pool.query(
        `UPDATE mobile_otp_codes
            SET created_at = NOW() - INTERVAL '2 minutes' WHERE id = $1`,
        [third[0].id],
      );
      assert.equal((await request()).status, 200);
      const fourth = await liveRow();
      assert.equal(fourth.length, 1);
      assert.notEqual(fourth[0].id, third[0].id, 'an aged code must be replaced');
      assert.equal(sent.length, 3);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      mail.sendOtpMail = originalSend;
      mail.pruneDeliveries = originalPrune;
      if (originalPool) require.cache[poolPath] = originalPool;
      else delete require.cache[poolPath];
      delete require.cache[authPath];
    }
  });
});
