'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const express = require('express');
const { restoreNativeWebSession } = require('../src/services/topochain/native-web-session');
const { nativeWebSessionIsLive } = require('../src/services/web-session-auth');

const DSN = process.env.TEST_DATABASE_URL;
const auth = { credentialReference: 'credential-a', credentialGeneration: 1,
  tokenId: 1, attemptId: 'attempt-a' };

test('native web session recovery against PostgreSQL', { skip: !DSN && 'set TEST_DATABASE_URL' }, async (t) => {
  const admin = new Pool({ connectionString: DSN });
  const schema = `web_recovery_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: DSN, options: `-c search_path=${schema}` });
  try {
    await pool.query(`
      CREATE TABLE users (id bigint PRIMARY KEY, username text DEFAULT 'alice');
      CREATE TABLE native_session_attempts (attempt_id text PRIMARY KEY);
      CREATE TABLE mobile_auth_tokens (id bigint PRIMARY KEY, user_id bigint, ability text, expires_at timestamptz, token_hash text);
      CREATE TABLE native_session_credentials (
        credential_reference text PRIMARY KEY, credential_generation int, user_id bigint,
        mobile_auth_token_id bigint, attempt_id text, web_session_incarnation_id text,
        state text, expires_at timestamptz, installation_id text DEFAULT 'installation-a');
      CREATE TABLE sessions (token text PRIMARY KEY, user_id bigint,
        expires_at timestamptz, native_session_incarnation_id text UNIQUE,
        created_at timestamptz DEFAULT NOW());
      INSERT INTO users (id) VALUES (1), (2);
      INSERT INTO native_session_attempts VALUES ('attempt-a');
    `);
    const migration = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8')
      .match(/ALTER TABLE sessions ADD COLUMN IF NOT EXISTS native_session_credential_reference[\s\S]*?;/)[0];
    await pool.query(migration);
    await pool.query(migration); // safe on both fresh and upgraded databases
    async function reset() {
      await pool.query(`DELETE FROM sessions; DELETE FROM native_session_credentials; DELETE FROM mobile_auth_tokens;
        INSERT INTO mobile_auth_tokens (id,user_id,ability,expires_at,token_hash) VALUES (1, 1, 'session', NOW() + INTERVAL '90 days', '${crypto.createHash('sha256').update('bearer-a').digest('hex')}');
        INSERT INTO native_session_credentials (credential_reference,credential_generation,user_id,mobile_auth_token_id,attempt_id,web_session_incarnation_id,state,expires_at)
          SELECT 'credential-a', 1, 1, 1, 'attempt-a', 'incarnation-a', 'valid', expires_at FROM mobile_auth_tokens;
      `);
    }
    const restore = (currentSessionToken = null) => restoreNativeWebSession(pool, { userId: 1, auth, currentSessionToken });
    const live = async (token) => (await pool.query(
      `SELECT token FROM sessions s WHERE token=$1 AND s.expires_at > NOW() AND ${nativeWebSessionIsLive('s')}`, [token]
    )).rows.length;

    await t.test('the native HTTP endpoint authenticates the bearer and returns its lease with private cookie material', async () => {
      await reset();
      const poolModule = require('../src/db/pool');
      const originalGetPool = poolModule.getPool;
      let nativeSessionRoutes;
      try {
        poolModule.getPool = () => pool;
        ({ nativeSessionRoutes } = require('../src/routes/topochain/native-session'));
      } finally { poolModule.getPool = originalGetPool; }
      const app = express();
      app.use(express.json(), nativeSessionRoutes({}));
      const server = app.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const url = `http://127.0.0.1:${server.address().port}/api/v4/mobile/auth/restore-web-session`;
      const request = (body, bearer = 'bearer-a') => fetch(url, {
        method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      try {
        const response = await request({ protocol: 2, currentSessionToken: null });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('usernode-credential-reference'), auth.credentialReference);
        const result = await response.json();
        assert.equal(result.data.attemptId, auth.attemptId);
        assert.equal(await live(result.data.sessionToken), 1);
        assert.equal((await request({ protocol: 2, currentSessionToken: null, userId: 2 })).status, 422);
        assert.equal((await request({ protocol: 2, currentSessionToken: null }, 'unknown')).status, 401);
        await pool.query("UPDATE native_session_credentials SET state='revoked'");
        assert.equal((await request({ protocol: 2, currentSessionToken: null })).status, 401);
      } finally {
        server.close();
        await once(server, 'close');
      }
    });
    await t.test('missing cookie and deleted web row recover the exact incarnation with a seven-day bound', async () => {
      await reset();
      const result = await restore();
      assert.equal(result.userId, '1');
      assert.equal(result.attemptId, 'attempt-a');
      assert.match(result.sessionToken, /^[a-f0-9]{64}$/);
      assert.ok(Math.abs(Date.parse(result.expiresAt) - Date.now() - 7 * 86400000) < 2000);
      const { rows } = await pool.query('SELECT * FROM sessions');
      assert.equal(rows[0].native_session_incarnation_id, 'incarnation-a');
      assert.equal(rows[0].native_session_credential_reference, 'credential-a');
      assert.equal(await live(result.sessionToken), 1);
    });
    await t.test('expired web cookies recover, rotate, and keep the same attempt', async () => {
      await reset();
      await pool.query("INSERT INTO sessions (token,user_id,expires_at,native_session_incarnation_id) VALUES ('old', 1, NOW()-INTERVAL '1 day', 'incarnation-a')");
      const restored = await restore('old');
      assert.equal(await live('old'), 0);
      assert.equal(restored.attemptId, 'attempt-a');
      assert.equal(await live(restored.sessionToken), 1);
    });
    await t.test('a live different account or incarnation is never overwritten', async () => {
      for (const userId of [1, 2]) {
        await reset();
        await pool.query("INSERT INTO sessions (token,user_id,expires_at,native_session_incarnation_id) VALUES ('other', $1, NOW()+INTERVAL '1 day', 'incarnation-b')", [userId]);
        await assert.rejects(restore('other'), { status: 409, code: 'native_web_session_conflict' });
        assert.equal(await live('other'), 1);
      }
    });
    await t.test('expired, revoked, orphaned, or mismatched credentials cannot restore', async () => {
      for (const mutation of [
        "UPDATE native_session_credentials SET expires_at=NOW()-INTERVAL '1 second'",
        "UPDATE native_session_credentials SET state='revoked'",
        'DELETE FROM mobile_auth_tokens',
        "UPDATE mobile_auth_tokens SET expires_at=NOW()+INTERVAL '1 hour'",
      ]) {
        await reset();
        await pool.query(mutation);
        await assert.rejects(restore(), { status: 401 });
        assert.equal((await pool.query('SELECT * FROM sessions')).rows.length, 0);
      }
    });
    await t.test('a recovery response arriving after revocation is unusable on every shared auth predicate', async () => {
      await reset();
      const restored = await restore();
      await pool.query("UPDATE native_session_credentials SET state='revoked'");
      assert.equal(await live(restored.sessionToken), 0);
      await assert.rejects(restore(restored.sessionToken), { status: 401 });
    });
    await t.test('revocation holding the credential lock wins over an in-flight restore', async () => {
      await reset();
      const revoker = await pool.connect();
      try {
        await revoker.query('BEGIN');
        await revoker.query("UPDATE native_session_credentials SET state='revoked'");
        const restoring = restore().then(() => null, (error) => error);
        await revoker.query('COMMIT');
        assert.equal((await restoring).status, 401);
        assert.equal((await pool.query('SELECT * FROM sessions')).rows.length, 0);
      } finally { revoker.release(); }
    });
    await t.test('concurrent recoveries leave one incarnation and only the latest token valid', async () => {
      await reset();
      const results = await Promise.all([restore(), restore()]);
      assert.notEqual(results[0].sessionToken, results[1].sessionToken);
      assert.equal((await live(results[0].sessionToken)) + (await live(results[1].sessionToken)), 1);
      assert.equal((await pool.query('SELECT * FROM sessions')).rows.length, 1);
    });
    await t.test('the web cookie cannot outlive the remaining native lease', async () => {
      await reset();
      await pool.query("UPDATE mobile_auth_tokens SET expires_at=NOW()+INTERVAL '1 hour'; UPDATE native_session_credentials SET expires_at=(SELECT expires_at FROM mobile_auth_tokens)");
      const result = await restore();
      assert.ok(Math.abs(Date.parse(result.expiresAt) - Date.now() - 3600000) < 2000);
    });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
