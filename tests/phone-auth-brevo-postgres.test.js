'use strict';

// Real-PostgreSQL tests for the Brevo sign-in path: the hashed code store
// (src/services/sms/otp.js), the request leg and the exchange/verify legs in
// services/firebase-phone-auth.js. Brevo itself is the only thing stubbed.
//
// Run with: node --test tests/phone-auth-brevo-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { Client, Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';

const DDL = `
  CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(255) UNIQUE NOT NULL,
    is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    admin_readonly BOOLEAN NOT NULL DEFAULT FALSE,
    needs_username_choice BOOLEAN NOT NULL DEFAULT FALSE
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
  CREATE TABLE sms_otp_codes (
    id            BIGSERIAL PRIMARY KEY,
    session_hash  VARCHAR(64) NOT NULL UNIQUE CHECK (session_hash ~ '^[0-9a-f]{64}$'),
    phone_e164    VARCHAR(16) NOT NULL CHECK (phone_e164 ~ '^\\+[1-9][0-9]{1,14}$'),
    code_hash     VARCHAR(64) NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
    attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    expires_at    TIMESTAMPTZ NOT NULL,
    consumed_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE sms_deliveries (
    id                  BIGSERIAL PRIMARY KEY,
    kind                TEXT NOT NULL CHECK (kind IN ('otp', 'marketing', 'test')),
    provider            TEXT NOT NULL,
    country             CHAR(2),
    sender_id           TEXT,
    phone_last4         VARCHAR(4) CHECK (phone_last4 ~ '^[0-9]{4}$'),
    status              TEXT NOT NULL CHECK (status IN ('sent', 'logged', 'refused', 'failed')),
    error_code          TEXT,
    provider_code       TEXT,
    provider_message_id TEXT,
    attempts            INTEGER NOT NULL DEFAULT 0,
    delivery_status     TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

const CONFIG = {
  smsProviderDefault: 'brevo',
  brevoApiKey: 'brevo-key',
  brevoSmsSenderIds: { FR: { sender: 'Homeroom', registered: false, optOut: null } },
};

const PHONE = '+33680065433';

async function withDatabase(t, run) {
  const admin = new Client({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch (error) {
    await admin.end().catch(() => {});
    return t.skip(`no postgres reachable at ${DSN}: ${error.message || error.code || error}`);
  }

  const schema = `sms_brevo_test_${process.pid}`;
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

function fakeFetch(calls) {
  return async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 201, json: async () => ({ messageId: 'brevo-message-1' }) };
  };
}

test('the Brevo sign-in path against real PostgreSQL', async (t) => {
  await withDatabase(t, async (pool) => {
    const otp = require('../src/services/sms/otp');
    const phoneAuth = require('../src/services/firebase-phone-auth');
    const { sha256Hex } = otp;

    const { rows: [user] } = await pool.query(
      "INSERT INTO users (username) VALUES ('firebaseuser') RETURNING id"
    );
    await pool.query(
      `INSERT INTO user_phone_identities (user_id, firebase_uid, phone_e164)
       VALUES ($1, 'firebase-uid-1', $2)`,
      [user.id, PHONE]
    );

    // ── requestCode sends through Brevo and stores the code's hashes ──
    const calls = [];
    const sent = await phoneAuth.requestCode(
      CONFIG, PHONE, null,
      { pool, env: {}, fetch: fakeFetch(calls), sleep: async () => {} }
    );
    assert.match(sent.sessionInfo, /^hr-sms-session\./);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.brevo.com/v3/transactionalSMS/send');
    assert.equal(calls[0].body.type, 'transactional');
    assert.equal(calls[0].body.tag, 'otp');
    assert.equal(calls[0].body.recipient, '33680065433');
    assert.equal(calls[0].body.sender, 'Homeroom');
    assert.match(calls[0].body.content, /^Your Homeroom code is [0-9]{6}\. It expires in 10 minutes\.$/);

    const { rows: [stored] } = await pool.query('SELECT * FROM sms_otp_codes');
    assert.equal(stored.session_hash, sha256Hex(sent.sessionInfo));
    assert.notEqual(stored.session_hash, sent.sessionInfo, 'the session is never stored in the clear');
    assert.equal(stored.phone_e164, PHONE);

    const deliveries = await pool.query('SELECT * FROM sms_deliveries');
    assert.equal(deliveries.rows.length, 1);
    assert.equal(deliveries.rows[0].kind, 'otp');
    assert.equal(deliveries.rows[0].country, 'FR');
    assert.equal(deliveries.rows[0].sender_id, 'Homeroom');
    assert.equal(deliveries.rows[0].status, 'sent');
    assert.equal(deliveries.rows[0].provider_message_id, 'brevo-message-1');
    assert.equal(deliveries.rows[0].phone_last4, '5433');
    assert.ok(!JSON.stringify(deliveries.rows[0]).includes(PHONE), 'the full number is never stored');

    // ── issue stores only hashes, and the code works once ──
    const issued = await otp.issue(pool, PHONE);
    assert.match(issued.code, /^[0-9]{6}$/);
    const { rows: [row] } = await pool.query(
      'SELECT * FROM sms_otp_codes WHERE session_hash = $1', [sha256Hex(issued.sessionInfo)]
    );
    assert.equal(row.code_hash, sha256Hex(`${issued.sessionInfo}:${issued.code}`));
    assert.notEqual(row.code_hash, issued.code);

    assert.equal(await otp.redeem(pool, issued.sessionInfo, issued.code), PHONE);
    assert.equal(await otp.redeem(pool, issued.sessionInfo, issued.code), null, 'a code works once');

    // ── expired and five wrong tries ──
    const expired = await otp.issue(pool, PHONE);
    await pool.query(
      "UPDATE sms_otp_codes SET expires_at = NOW() - INTERVAL '1 second' WHERE session_hash = $1",
      [sha256Hex(expired.sessionInfo)]
    );
    assert.equal(await otp.redeem(pool, expired.sessionInfo, expired.code), null);

    const guarded = await otp.issue(pool, PHONE);
    for (let i = 0; i < 5; i += 1) {
      assert.equal(await otp.redeem(pool, guarded.sessionInfo, '000000'), null);
    }
    assert.equal(await otp.redeem(pool, guarded.sessionInfo, guarded.code), null,
      'a sixth try is refused even with the right code');

    // ── exchange mints a token verify turns into the Firebase account ──
    const inFlight = await otp.issue(pool, PHONE);
    const { idToken } = await phoneAuth.exchangeCode(CONFIG, inFlight.sessionInfo, inFlight.code, { pool });
    assert.match(idToken, /^hr-sms-token\./);
    const claims = await phoneAuth.verifyIdToken(pool, CONFIG, idToken);
    assert.equal(claims.phoneNumber, PHONE);
    assert.equal(claims.uid, 'firebase-uid-1', 'the number finds the account Firebase made');
    await assert.rejects(
      () => phoneAuth.verifyIdToken(pool, CONFIG, idToken),
      (err) => err.code === 'bad_token',
      'the token is spent once'
    );

    // ── a forged token is refused before any database work ──
    const forged = `${idToken.slice(0, -4)}AAAA`;
    await assert.rejects(
      () => phoneAuth.verifyIdToken(pool, CONFIG, forged),
      (err) => err.code === 'bad_token'
    );

    // ── a code issued before a switch still redeems ──
    const beforeSwitch = await otp.issue(pool, PHONE);
    const switched = await phoneAuth.exchangeCode(
      { firebasePhoneAuthEnabled: false }, beforeSwitch.sessionInfo, beforeSwitch.code, { pool }
    );
    assert.match(switched.idToken, /^hr-sms-token\./);

    // ── a number linked under Brevo finds the same account through Firebase ──
    await pool.query(
      "UPDATE user_phone_identities SET firebase_uid = $2 WHERE phone_e164 = $1",
      [PHONE, `sms:${PHONE}`]
    );
    const again = await phoneAuth.signIn(
      pool,
      { uid: 'firebase-uid-2', phoneNumber: PHONE },
      { createSession: async () => ({ token: 'session-token', expiresAt: new Date() }) }
    );
    assert.equal(again.userId, user.id, 'the same account, found by the unique number');
    assert.equal(again.created, false);
    const { rows: [rekeyed] } = await pool.query(
      'SELECT firebase_uid FROM user_phone_identities WHERE phone_e164 = $1', [PHONE]
    );
    assert.equal(rekeyed.firebase_uid, 'firebase-uid-2', 'the identity is re-keyed for the next sign-in');
  });
});
