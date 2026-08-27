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

    const { authRoutes } = require('../src/routes/auth');
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
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
