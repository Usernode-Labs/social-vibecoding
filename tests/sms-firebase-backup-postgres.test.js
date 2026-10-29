'use strict';

// The Firebase backup for sign-in codes (services/firebase-phone-auth.js,
// FIREBASE BACKUP): while Brevo is selected, a code Brevo cannot send, or a
// resend while Brevo's code is still live, goes by Firebase. Real
// PostgreSQL for the code store, the switch and the delivery log; Brevo and
// Identity Toolkit are the only things stubbed.
//
// Run with: node --test tests/sms-firebase-backup-postgres.test.js

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
  CREATE TABLE platform_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TIMESTAMPTZ,
    updated_by INTEGER
  );
`;

const CONFIG = {
  smsProviderDefault: 'brevo',
  brevoApiKey: 'brevo-key',
  brevoSmsSenderIds: { FR: { sender: 'Homeroom', registered: false, optOut: null } },
  firebasePhoneAuthEnabled: true,
  firebaseWebApiKey: 'web-key',
  firebaseProjectId: 'project-1',
  firebaseServiceAccountJsonB64: 'service-account',
};

const PHONE = '+33680065433';
const TOKEN = 'recaptcha-answer';

async function withDatabase(t, run) {
  const admin = new Client({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch (error) {
    await admin.end().catch(() => {});
    return t.skip(`no postgres reachable at ${DSN}: ${error.message || error.code || error}`);
  }

  const schema = `sms_backup_test_${process.pid}`;
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

// Brevo answers `brevo` ('ok' or 'refuse'); Identity Toolkit answers
// `firebase` ('ok' or 'refuse'). Every call is kept, by service.
function fakeFetch({ brevo = 'ok', firebase = 'ok' } = {}) {
  const calls = { brevo: [], firebase: [] };
  const fetch = async (url, opts = {}) => {
    if (url.startsWith('https://api.brevo.com/')) {
      calls.brevo.push(JSON.parse(opts.body));
      if (brevo === 'ok') return { ok: true, status: 201, json: async () => ({ messageId: 'brevo-1' }) };
      return { ok: false, status: 400, json: async () => ({ code: 'invalid_parameter' }) };
    }
    if (url.includes('identitytoolkit.googleapis.com')) {
      if (url.includes('/recaptchaParams')) {
        return { ok: true, status: 200, json: async () => ({ recaptchaSiteKey: 'site-key-1' }) };
      }
      calls.firebase.push(JSON.parse(opts.body));
      if (firebase === 'ok') return { ok: true, status: 200, json: async () => ({ sessionInfo: 'firebase-session-1' }) };
      return { ok: false, status: 400, json: async () => ({ error: { message: 'QUOTA_EXCEEDED' } }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetch, calls };
}

async function reset(pool) {
  await pool.query('TRUNCATE sms_otp_codes, sms_deliveries, platform_settings');
  require('../src/services/sms/select').invalidate();
}

async function deliveries(pool) {
  const { rows } = await pool.query('SELECT provider, status, error_code FROM sms_deliveries ORDER BY id');
  return rows.map((r) => `${r.provider}:${r.status}${r.error_code ? `:${r.error_code}` : ''}`);
}

test('the Firebase backup for sign-in codes, against real PostgreSQL', async (t) => {
  await withDatabase(t, async (pool) => {
    const phoneAuth = require('../src/services/firebase-phone-auth');
    const select = require('../src/services/sms/select');
    const deps = (fetch) => ({ pool, env: {}, fetch, sleep: async () => {} });

    const backUp = (fetch) => ({ ...deps(fetch), canBackUp: true });

    await t.test('a code Brevo refuses: the client is asked for a check, then Firebase sends it', async () => {
      await reset(pool);
      const { fetch, calls } = fakeFetch({ brevo: 'refuse' });
      await assert.rejects(
        () => phoneAuth.requestCode(CONFIG, PHONE, null, backUp(fetch)),
        (err) => err.code === 'recaptcha_backup' && err.status === 409 && err.siteKey === 'site-key-1'
      );
      assert.equal(calls.firebase.length, 0, 'nothing goes by Firebase without a token');
      const sent = await phoneAuth.requestCode(CONFIG, PHONE, TOKEN, backUp(fetch));
      assert.equal(sent.sessionInfo, 'firebase-session-1');
      assert.equal(calls.brevo.length, 1, 'Brevo is not asked twice');
      assert.deepEqual(calls.firebase, [{ phoneNumber: PHONE, recaptchaToken: TOKEN }]);
      assert.deepEqual(await deliveries(pool), ['brevo:refused:provider_refused', 'firebase:sent']);
    });

    await t.test('a token already in hand sends the backup in the same request', async () => {
      await reset(pool);
      const { fetch, calls } = fakeFetch({ brevo: 'refuse' });
      const sent = await phoneAuth.requestCode(CONFIG, PHONE, TOKEN, backUp(fetch));
      assert.equal(sent.sessionInfo, 'firebase-session-1');
      assert.equal(calls.firebase.length, 1);
    });

    await t.test('a resend while Brevo\'s code is live goes by Firebase, without Brevo', async () => {
      await reset(pool);
      const first = fakeFetch();
      const sent = await phoneAuth.requestCode(CONFIG, PHONE, null, backUp(first.fetch));
      assert.match(sent.sessionInfo, /^hr-sms-session\./);
      assert.equal(first.calls.firebase.length, 0, 'the first code goes by Brevo, with no check');

      const again = fakeFetch();
      await assert.rejects(
        () => phoneAuth.requestCode(CONFIG, PHONE, null, backUp(again.fetch)),
        (err) => err.code === 'recaptcha_backup'
      );
      const resent = await phoneAuth.requestCode(CONFIG, PHONE, TOKEN, backUp(again.fetch));
      assert.equal(resent.sessionInfo, 'firebase-session-1');
      assert.equal(again.calls.brevo.length, 0);
      assert.equal(again.calls.firebase.length, 1);
      assert.deepEqual(await deliveries(pool), ['brevo:sent', 'firebase:sent']);
    });

    await t.test('a client that cannot earn the check resends by Brevo, as before', async () => {
      await reset(pool);
      await phoneAuth.requestCode(CONFIG, PHONE, null, deps(fakeFetch().fetch));
      const { fetch, calls } = fakeFetch();
      const resent = await phoneAuth.requestCode(CONFIG, PHONE, null, deps(fetch));
      assert.match(resent.sessionInfo, /^hr-sms-session\./);
      assert.equal(calls.brevo.length, 1);
      assert.equal(calls.firebase.length, 0);
    });

    await t.test('an expired Brevo code makes the next request a fresh Brevo send', async () => {
      await reset(pool);
      await phoneAuth.requestCode(CONFIG, PHONE, null, backUp(fakeFetch().fetch));
      await pool.query("UPDATE sms_otp_codes SET expires_at = NOW() - INTERVAL '1 second'");
      const { fetch, calls } = fakeFetch();
      const sent = await phoneAuth.requestCode(CONFIG, PHONE, null, backUp(fetch));
      assert.match(sent.sessionInfo, /^hr-sms-session\./);
      assert.equal(calls.firebase.length, 0);
    });

    await t.test('switched off, Brevo\'s refusal stands and Firebase is not asked', async () => {
      await reset(pool);
      await select.setFallback(pool, false, null);
      const { fetch, calls } = fakeFetch({ brevo: 'refuse' });
      await assert.rejects(
        () => phoneAuth.requestCode(CONFIG, PHONE, TOKEN, backUp(fetch)),
        (err) => err.code === 'sms_unreachable'
      );
      assert.equal(calls.firebase.length, 0);
      const { rows: [saved] } = await pool.query("SELECT value FROM platform_settings WHERE key = 'sms_firebase_fallback'");
      assert.equal(saved.value, 'off');
    });

    await t.test('without Firebase set up there is no backup', async () => {
      await reset(pool);
      const { fetch, calls } = fakeFetch({ brevo: 'refuse' });
      await assert.rejects(
        () => phoneAuth.requestCode({ ...CONFIG, firebasePhoneAuthEnabled: false }, PHONE, TOKEN, backUp(fetch)),
        (err) => err.code === 'sms_unreachable'
      );
      assert.equal(calls.firebase.length, 0);
    });

    await t.test('when Firebase refuses too, its refusal is answered and logged', async () => {
      await reset(pool);
      const { fetch } = fakeFetch({ brevo: 'refuse', firebase: 'refuse' });
      await assert.rejects(
        () => phoneAuth.requestCode(CONFIG, PHONE, TOKEN, backUp(fetch)),
        (err) => err.code === 'firebase_unreachable'
      );
      assert.deepEqual(await deliveries(pool), [
        'brevo:refused:provider_refused',
        'firebase:failed:firebase_unreachable',
      ]);
    });

    await t.test('the gateway path still serves no site key: the check is asked for only when needed', async () => {
      await reset(pool);
      const { fetch } = fakeFetch();
      assert.equal(await phoneAuth.recaptchaSiteKey(CONFIG, deps(fetch)), '');
    });
  });
});
