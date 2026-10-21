'use strict';

// #4938: Settings › Linked phones. What this pins about
// src/services/linked-phones.js and the revocation it uses:
//
//   - a linked phone is one installation holding a valid, unexpired native
//     credential of the account; two sign-ins on one phone are one row, and
//     a revoked or expired credential, or another account's, is no row;
//   - the row carries the phone's kind from its push registration, the
//     dates, and `current` for the phone the page is open on;
//   - unlinking revokes every valid credential the account holds on that
//     installation, deletes its mobile bearers and ends its push lease,
//     leaving the account's other phones and another account on the same
//     phone untouched;
//   - unlinking another account's phone, or one already unlinked, changes
//     nothing and answers false (the route's 404).
//
// Run with: TEST_DATABASE_URL=... node --test tests/linked-phones-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, Pool } = require('pg');

const { listLinkedPhones, unlinkPhone, isPhoneId } = require('../src/services/linked-phones');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';
const schemaSql = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
const chainId = 'utc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqcmpl5h';
const opaque = (prefix, byte) => `${prefix}${Buffer.alloc(32, byte).toString('base64url')}`;

function extractTable(name) {
  const match = schemaSql.match(new RegExp(
    `CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`,
  ));
  if (!match) throw new Error(`schema.sql no longer contains ${name}`);
  return match[0];
}

const PRODUCTION_DDL = [
  'native_session_web_incarnations',
  'native_session_attempts',
  'native_session_handoffs',
  'native_session_tickets',
  'native_installation_key_generations',
  'native_session_credentials',
].map(extractTable);

const STUB_DDL = `
  CREATE TABLE users (id BIGINT PRIMARY KEY, username TEXT NOT NULL);
  CREATE TABLE mobile_auth_tokens (
    id BIGINT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    ability VARCHAR(20) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (id, user_id)
  );
  CREATE TABLE onchain_accounts (
    id BIGINT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    UNIQUE (id, user_id)
  );
  CREATE TABLE mobile_push_registrations (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    native_session_credential_reference VARCHAR(47),
    platform VARCHAR(16) NOT NULL,
    session_expires_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`;

async function withDatabase(t, run) {
  const admin = new Client({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch (error) {
    await admin.end().catch(() => {});
    return t.skip(`no postgres reachable at ${DSN}: ${error.message || error.code || error}`);
  }
  const schema = `linked_phones_test_${process.pid}`;
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: DSN,
    connectionTimeoutMillis: 3000,
    options: `-c search_path=${schema}`,
  });
  try {
    await pool.query(STUB_DDL);
    for (const ddl of PRODUCTION_DDL) await pool.query(ddl);
    await run(pool);
  } finally {
    await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

let seq = 0;

async function addUser(pool, userId) {
  await pool.query('INSERT INTO users (id, username) VALUES ($1, $2)', [userId, `phone-owner-${userId}`]);
}

async function addInstallation(pool, byte) {
  const installationId = opaque('nsi_', byte);
  await pool.query(
    `INSERT INTO native_installation_key_generations
       (installation_id, key_generation, possession_key_id,
        possession_key_thumbprint, possession_public_jwk, envelope_key_id,
        envelope_key_thumbprint, envelope_public_jwk)
     VALUES ($1, 1, $2, $3, '{"kty":"EC"}', $4, $5, '{"kty":"RSA"}')`,
    [installationId, opaque('nskp_', byte), opaque('', byte + 100),
      opaque('nske_', byte), opaque('', byte + 150)],
  );
  return installationId;
}

// One sign-in of `userId` on `installationId`: an incarnation, an exchanged
// attempt, a bearer and the credential, optionally with a push registration.
async function signIn(pool, { userId, installationId, platform = null, lastUsedDaysAgo = 0, createdDaysAgo = 10 }) {
  seq += 1;
  const byte = seq;
  const incarnation = opaque('nsw_', byte);
  const attempt = opaque('nsa_', byte);
  const reference = opaque('nsc_', byte);
  const tokenId = 1000 + seq;
  await pool.query('INSERT INTO native_session_web_incarnations (id, user_id) VALUES ($1, $2)', [incarnation, userId]);
  await pool.query(
    `INSERT INTO native_session_attempts
       (attempt_id, user_id, web_session_incarnation_id, desired_runtime,
        network_id, chain_id, request_digest, state)
     VALUES ($1, $2, $3, 'running', 'testnet', $4, $5, 'exchanged')`,
    [attempt, userId, incarnation, chainId, String(seq).padStart(64, '0')],
  );
  await pool.query(
    `INSERT INTO mobile_auth_tokens (id, user_id, token_hash, ability, expires_at, last_used_at)
     VALUES ($1, $2, $3, 'session', NOW() + INTERVAL '90 days', NOW() - make_interval(days => $4))`,
    [tokenId, userId, tokenId.toString(16).padStart(64, '0'), lastUsedDaysAgo],
  );
  await pool.query(
    `INSERT INTO native_session_credentials
       (credential_reference, attempt_id, user_id, web_session_incarnation_id,
        installation_id, installation_key_generation, mobile_auth_token_id,
        network_id, chain_id, exchange_request_digest, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, 1, $6, 'testnet', $7, $8,
             NOW() - make_interval(days => $9), NOW() + INTERVAL '90 days')`,
    [reference, attempt, userId, incarnation, installationId, tokenId, chainId,
      String(seq + 500).padStart(64, '0'), createdDaysAgo],
  );
  if (platform) {
    await pool.query(
      `INSERT INTO mobile_push_registrations
         (user_id, native_session_credential_reference, platform, session_expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '90 days')`,
      [userId, reference, platform],
    );
  }
  return { reference, tokenId, attempt };
}

test('a phone id is an installation reference and nothing else', () => {
  assert.equal(isPhoneId(opaque('nsi_', 1)), true);
  assert.equal(isPhoneId(opaque('nsc_', 1)), false);
  assert.equal(isPhoneId('1'), false);
  assert.equal(isPhoneId(undefined), false);
});

test('the list is the account\'s own valid phones, one row per phone, this phone first', async (t) => {
  await withDatabase(t, async (pool) => {
    await addUser(pool, 1);
    await addUser(pool, 2);
    const pixel = await addInstallation(pool, 1);
    const iphone = await addInstallation(pool, 2);
    const unknown = await addInstallation(pool, 3);
    const revoked = await addInstallation(pool, 4);

    await signIn(pool, { userId: 1, installationId: pixel, platform: 'android', lastUsedDaysAgo: 5, createdDaysAgo: 30 });
    await signIn(pool, { userId: 1, installationId: pixel, platform: 'android', lastUsedDaysAgo: 1, createdDaysAgo: 3 });
    const here = await signIn(pool, { userId: 1, installationId: iphone, platform: 'ios', lastUsedDaysAgo: 9 });
    await signIn(pool, { userId: 1, installationId: unknown, lastUsedDaysAgo: 2 });
    const gone = await signIn(pool, { userId: 1, installationId: revoked, platform: 'android' });
    await pool.query(
      `UPDATE native_session_credentials
          SET state = 'revoked', revocation_reason = 'web_logout', revoked_at = NOW()
        WHERE credential_reference = $1`,
      [gone.reference],
    );
    // Another account on the same Android phone is that account's row.
    await signIn(pool, { userId: 2, installationId: pixel, platform: 'android' });

    const phones = await listLinkedPhones(pool, 1, { currentCredential: here.reference });
    assert.deepEqual(phones.map((p) => [p.id, p.platform, p.current]), [
      [iphone, 'ios', true],
      [pixel, 'android', false],
      [unknown, null, false],
    ]);
    const pixelRow = phones[1];
    assert.ok(Date.parse(pixelRow.linkedAt) < Date.now() - 29 * 86400e3, 'linked at its first sign-in');
    assert.ok(Date.parse(pixelRow.lastUsedAt) > Date.now() - 2 * 86400e3, 'last used at its latest use');

    assert.deepEqual(
      (await listLinkedPhones(pool, 2)).map((p) => [p.id, p.current]),
      [[pixel, false]],
    );
  });
});

test('unlinking signs that phone out of this account only', async (t) => {
  await withDatabase(t, async (pool) => {
    await addUser(pool, 1);
    await addUser(pool, 2);
    const pixel = await addInstallation(pool, 11);
    const iphone = await addInstallation(pool, 12);
    const first = await signIn(pool, { userId: 1, installationId: pixel, platform: 'android' });
    const second = await signIn(pool, { userId: 1, installationId: pixel, platform: 'android' });
    const other = await signIn(pool, { userId: 1, installationId: iphone, platform: 'ios' });
    const neighbour = await signIn(pool, { userId: 2, installationId: pixel, platform: 'android' });

    // Somebody else's phone, and a malformed id, change nothing.
    assert.equal(await unlinkPhone(pool, 2, iphone), false);
    assert.equal(await unlinkPhone(pool, 1, 'nsi_short'), false);
    assert.equal((await listLinkedPhones(pool, 1)).length, 2);

    assert.equal(await unlinkPhone(pool, 1, pixel), true);

    const { rows: creds } = await pool.query(
      `SELECT credential_reference, state, revocation_reason, mobile_auth_token_id
         FROM native_session_credentials ORDER BY credential_reference`,
    );
    const byRef = Object.fromEntries(creds.map((r) => [r.credential_reference, r]));
    for (const mine of [first, second]) {
      assert.equal(byRef[mine.reference].state, 'revoked');
      assert.equal(byRef[mine.reference].revocation_reason, 'web_logout');
      assert.equal(byRef[mine.reference].mobile_auth_token_id, null, 'its bearer is gone');
    }
    assert.equal(byRef[other.reference].state, 'valid');
    assert.equal(byRef[neighbour.reference].state, 'valid');

    const { rows: tokens } = await pool.query('SELECT id FROM mobile_auth_tokens ORDER BY id');
    assert.deepEqual(tokens.map((r) => Number(r.id)), [other.tokenId, neighbour.tokenId]);

    const { rows: attempts } = await pool.query(
      'SELECT attempt_id, state FROM native_session_attempts',
    );
    const attemptState = Object.fromEntries(attempts.map((r) => [r.attempt_id, r.state]));
    assert.equal(attemptState[first.attempt], 'revoked');
    assert.equal(attemptState[second.attempt], 'revoked');
    assert.equal(attemptState[other.attempt], 'exchanged');
    assert.equal(attemptState[neighbour.attempt], 'exchanged');

    const { rows: pushes } = await pool.query(
      `SELECT native_session_credential_reference AS ref, session_expires_at <= NOW() AS ended
         FROM mobile_push_registrations`,
    );
    const ended = Object.fromEntries(pushes.map((r) => [r.ref, r.ended]));
    assert.equal(ended[first.reference], true);
    assert.equal(ended[second.reference], true);
    assert.equal(ended[other.reference], false);
    assert.equal(ended[neighbour.reference], false);

    assert.deepEqual((await listLinkedPhones(pool, 1)).map((p) => p.id), [iphone]);
    assert.deepEqual((await listLinkedPhones(pool, 2)).map((p) => p.id), [pixel]);

    // Already unlinked: nothing left to do, the route's 404.
    assert.equal(await unlinkPhone(pool, 1, pixel), false);
  });
});
