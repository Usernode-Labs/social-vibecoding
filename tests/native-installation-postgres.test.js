'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, Pool } = require('pg');

const {
  revokeNativeSessionCredentials,
} = require('../src/services/native-session-revocation');

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
  'native_session_tickets',
  'native_installation_key_generations',
  'native_session_credentials',
].map(extractTable);

const STUB_DDL = `
  CREATE TABLE users (id BIGINT PRIMARY KEY);
  CREATE TABLE mobile_auth_tokens (
    id BIGINT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    UNIQUE (id, user_id)
  );
  CREATE TABLE onchain_accounts (
    id BIGINT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    UNIQUE (id, user_id)
  );`;

async function withDatabase(t, run) {
  const admin = new Client({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch (error) {
    await admin.end().catch(() => {});
    return t.skip(`no postgres reachable at ${DSN}: ${error.message || error.code || error}`);
  }

  const schema = `native_installation_test_${process.pid}`;
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

async function insertSubject(pool, { userId, incarnation, attempt, tokenId, accountId }) {
  await pool.query('INSERT INTO users (id) VALUES ($1)', [userId]);
  await pool.query(
    'INSERT INTO native_session_web_incarnations (id, user_id) VALUES ($1, $2)',
    [incarnation, userId],
  );
  await pool.query(
    `INSERT INTO native_session_attempts
       (attempt_id, user_id, web_session_incarnation_id, desired_runtime,
        network_id, chain_id, request_digest, state)
     VALUES ($1, $2, $3, 'running', 'testnet', $4, $5, 'exchanged')`,
    [attempt, userId, incarnation, chainId, String(userId).padStart(64, '0')],
  );
  await pool.query(
    'INSERT INTO mobile_auth_tokens (id, user_id) VALUES ($1, $2)',
    [tokenId, userId],
  );
  await pool.query(
    'INSERT INTO onchain_accounts (id, user_id) VALUES ($1, $2)',
    [accountId, userId],
  );
}

async function insertCredential(pool, {
  reference, attempt, userId, incarnation, tokenId, accountId, installationId,
}) {
  await pool.query(
    `INSERT INTO native_session_credentials
       (credential_reference, attempt_id, user_id, web_session_incarnation_id,
        installation_id, installation_key_generation, mobile_auth_token_id,
        account_id, network_id, chain_id, exchange_request_digest,
        created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, 1, $6, $7, 'testnet', $8, $9,
             NOW(), NOW() + INTERVAL '90 days')`,
    [reference, attempt, userId, incarnation, installationId, tokenId,
      accountId, chainId, String(userId + 10).padStart(64, '0')],
  );
}

test('one durable installation is reused across explicit A revocation then B login', async (t) => {
  await withDatabase(t, async (pool) => {
    const installationId = opaque('nsi_', 1);
    await pool.query(
      `INSERT INTO native_installation_key_generations
         (installation_id, key_generation, possession_key_id,
          possession_key_thumbprint, possession_public_jwk, envelope_key_id,
          envelope_key_thumbprint, envelope_public_jwk)
       VALUES ($1, 1, $2, $3, '{"kty":"EC"}', $4, $5, '{"kty":"RSA"}')`,
      [installationId, opaque('nskp_', 2), opaque('', 3),
        opaque('nske_', 4), opaque('', 5)],
    );

    const a = {
      userId: 41, incarnation: opaque('nsw_', 6), attempt: opaque('nsa_', 7),
      tokenId: 71, accountId: 81, reference: opaque('nsc_', 8), installationId,
    };
    await insertSubject(pool, a);
    await insertCredential(pool, a);
    await revokeNativeSessionCredentials(pool, {
      reason: 'web_logout', userId: a.userId,
      webSessionIncarnationId: a.incarnation,
    });

    const b = {
      userId: 42, incarnation: opaque('nsw_', 9), attempt: opaque('nsa_', 10),
      tokenId: 72, accountId: 82, reference: opaque('nsc_', 11), installationId,
    };
    await insertSubject(pool, b);
    await insertCredential(pool, b);

    const { rows } = await pool.query(
      `SELECT user_id, state, revocation_reason, mobile_auth_token_id,
              installation_id
         FROM native_session_credentials
        ORDER BY user_id`,
    );
    assert.deepEqual(rows, [
      {
        user_id: '41', state: 'revoked', revocation_reason: 'web_logout',
        mobile_auth_token_id: null, installation_id: installationId,
      },
      {
        user_id: '42', state: 'valid', revocation_reason: null,
        mobile_auth_token_id: '72', installation_id: installationId,
      },
    ]);
    assert.equal((await pool.query(
      'SELECT COUNT(*)::int AS count FROM native_installation_key_generations',
    )).rows[0].count, 1);
  });
});
