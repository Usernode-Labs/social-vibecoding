'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
    session_expires_at TIMESTAMPTZ NOT NULL,
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
  await pool.query(
    'INSERT INTO users (id, username) VALUES ($1, $2)',
    [userId, `participant-${userId}`],
  );
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
    `INSERT INTO mobile_auth_tokens
       (id, user_id, token_hash, ability, expires_at)
     VALUES ($1, $2, $3, 'session', NOW() + INTERVAL '90 days')`,
    [tokenId, userId, Number(tokenId).toString(16).padStart(64, '0')],
  );
  await pool.query(
    'INSERT INTO onchain_accounts (id, user_id) VALUES ($1, $2)',
    [accountId, userId],
  );
}

function withAuthPool(pool, fn) {
  const poolModulePath = require.resolve('../src/db/pool');
  const authModulePath = require.resolve('../src/middleware/topochain-auth');
  const original = require.cache[poolModulePath];
  require.cache[poolModulePath] = {
    exports: { getPool: () => pool },
    loaded: true,
    id: poolModulePath,
    filename: poolModulePath,
    paths: original ? original.paths : [],
  };
  delete require.cache[authModulePath];
  try {
    return fn(require('../src/middleware/topochain-auth'));
  } finally {
    if (original) require.cache[poolModulePath] = original;
    else delete require.cache[poolModulePath];
    delete require.cache[authModulePath];
  }
}

function responseCapture() {
  return {
    statusCode: 200,
    body: null,
    headers: new Map(),
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers.set(name.toLowerCase(), String(value)); },
    getHeader(name) { return this.headers.get(name.toLowerCase()); },
  };
}

function runMiddleware(middleware, request, response) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const originalJson = response.json.bind(response);
    response.json = (body) => {
      const result = originalJson(body);
      if (!settled) { settled = true; resolve(false); }
      return result;
    };
    Promise.resolve(middleware(request, response, (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(true);
    })).catch(reject);
  });
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
    await pool.query(
      `INSERT INTO mobile_push_registrations
         (user_id, native_session_credential_reference, session_expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '90 days')`,
      [a.userId, a.reference],
    );
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
    assert.equal((await pool.query(
      `SELECT session_expires_at <= NOW() AS inactive
         FROM mobile_push_registrations
        WHERE native_session_credential_reference = $1`,
      [a.reference],
    )).rows[0].inactive, true);
  });
});

test('concurrent authenticated use renews one exact credential and push lease once', async (t) => {
  await withDatabase(t, async (pool) => {
    const bearer = 'a'.repeat(80);
    const bearerHash = crypto.createHash('sha256').update(bearer).digest('hex');
    const subject = {
      userId: 51,
      incarnation: opaque('nsw_', 12),
      attempt: opaque('nsa_', 13),
      tokenId: 73,
      accountId: 83,
      reference: opaque('nsc_', 14),
      installationId: opaque('nsi_', 15),
    };
    await pool.query(
      `INSERT INTO native_installation_key_generations
         (installation_id, key_generation, possession_key_id,
          possession_key_thumbprint, possession_public_jwk, envelope_key_id,
          envelope_key_thumbprint, envelope_public_jwk)
       VALUES ($1, 1, $2, $3, '{"kty":"EC"}', $4, $5, '{"kty":"RSA"}')`,
      [subject.installationId, opaque('nskp_', 16), opaque('', 17),
        opaque('nske_', 18), opaque('', 19)],
    );
    await insertSubject(pool, subject);
    await insertCredential(pool, subject);
    const { rows: clockRows } = await pool.query(
      `SELECT NOW() - INTERVAL '2 days' AS created_at,
              NOW() + INTERVAL '88 days' AS expires_at`,
    );
    const clock = clockRows[0];
    await pool.query(
      `UPDATE native_session_credentials
          SET created_at = $2, expires_at = $3
        WHERE credential_reference = $1`,
      [subject.reference, clock.created_at, clock.expires_at],
    );
    await pool.query(
      `UPDATE mobile_auth_tokens
          SET token_hash = $2, expires_at = $3, last_used_at = NULL
        WHERE id = $1`,
      [subject.tokenId, bearerHash, clock.expires_at],
    );
    await pool.query(
      `INSERT INTO mobile_push_registrations
         (user_id, native_session_credential_reference, session_expires_at)
       VALUES ($1, $2, $3)`,
      [subject.userId, subject.reference, clock.expires_at],
    );

    await withAuthPool(pool, async ({ mobileTokenAuth }) => {
      const middleware = mobileTokenAuth({});
      const request = () => ({ headers: { authorization: `Bearer ${bearer}` } });
      const first = responseCapture();
      const second = responseCapture();
      const admitted = await Promise.all([
        runMiddleware(middleware, request(), first),
        runMiddleware(middleware, request(), second),
      ]);
      assert.deepEqual(admitted, [true, true], JSON.stringify([
        { status: first.statusCode, body: first.body },
        { status: second.statusCode, body: second.body },
      ]));

      const firstExpiry = first.getHeader('Usernode-Credential-Lease-Expires-At');
      assert.equal(firstExpiry, second.getHeader('Usernode-Credential-Lease-Expires-At'));
      assert.equal(first.getHeader('Usernode-Credential-Reference'), subject.reference);
      assert.equal(first.getHeader('Usernode-Credential-Generation'), '1');

      const { rows } = await pool.query(
        `SELECT c.expires_at AS credential_expiry,
                t.expires_at AS token_expiry, t.last_used_at,
                r.session_expires_at AS push_expiry
           FROM native_session_credentials c
           JOIN mobile_auth_tokens t ON t.id = c.mobile_auth_token_id
           JOIN mobile_push_registrations r
             ON r.native_session_credential_reference = c.credential_reference
          WHERE c.credential_reference = $1`,
        [subject.reference],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].credential_expiry.toISOString(), firstExpiry);
      assert.equal(rows[0].token_expiry.toISOString(), firstExpiry);
      assert.equal(rows[0].push_expiry.toISOString(), firstExpiry);
      assert.ok(rows[0].last_used_at);

      const lastUsedAt = rows[0].last_used_at.toISOString();
      const third = responseCapture();
      assert.equal(await runMiddleware(middleware, request(), third), true);
      const unchanged = (await pool.query(
        `SELECT expires_at, last_used_at
           FROM mobile_auth_tokens WHERE id = $1`,
        [subject.tokenId],
      )).rows[0];
      assert.equal(unchanged.expires_at.toISOString(), firstExpiry);
      assert.equal(unchanged.last_used_at.toISOString(), lastUsedAt);
    });
  });
});
