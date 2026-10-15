'use strict';
// The daily security bot's own account (#4678) against the full PostgreSQL
// schema (services/security-bot/identity.js): created synthetic, without the
// admin bit or the app-creation right, idempotent, refused when a real person
// holds the name, refused by the ordinary sign-in form, and never handed an
// OpenRouter key.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// Any reach for the managed-key service is recorded: the identity must never
// issue or look up a key.
const keyCalls = [];
const keysId = require.resolve('../src/services/openrouter-managed-keys');
require.cache[keysId] = {
  id: keysId, filename: keysId, loaded: true, paths: [],
  exports: new Proxy({}, { get: (_t, prop) => (...args) => { keyCalls.push(String(prop)); return Promise.resolve(null); } }),
};

const identity = require('../src/services/security-bot/identity');

test('the security bot account against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'security_bot_identity_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  const config = { databaseUrl: String(url), jwtSecret: 'synthetic-test-only' };
  const routePool = require('../src/db/pool').getPool(config);
  let server = null;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await routePool.end();
    await pool.end();
    // pool.end() resolves before its sockets finish closing. FORCE can cut
    // an idle connection during shutdown and turn a passing suite into an
    // uncaught pool error; a normal DROP waits for those sockets to close.
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const userRow = async (id) => (await pool.query('SELECT * FROM users WHERE id = $1', [id])).rows[0];
  const countNamed = async () => (await pool.query(
    "SELECT count(*)::int AS n FROM users WHERE LOWER(username) = 'security_bot'")).rows[0].n;

  await t.test('a status read before creation finds nothing and creates nothing', async () => {
    assert.equal(await identity.findSecurityBotUser(pool), null);
    assert.equal(await countNamed(), 0);
  });

  let botId;
  await t.test('creation makes a synthetic account with no rights and finite limits', async () => {
    const bot = await identity.ensureSecurityBotUser(pool);
    botId = bot.id;
    const u = await userRow(bot.id);
    assert.equal(u.username, 'security_bot');
    assert.equal(u.is_synthetic, true);
    assert.equal(u.is_admin, false);
    assert.equal(u.admin_readonly, false);
    assert.equal(u.can_create_apps, false);
    assert.equal(u.daily_limit_cents, 500);
    assert.equal(u.weekly_limit_cents, 3500);
    assert.match(u.password, /^\$2[aby]\$12\$/, 'only a bcrypt hash of a discarded random value is stored');
  });

  await t.test('re-running is idempotent and puts back rights it should not have', async () => {
    const again = await identity.ensureSecurityBotUser(pool);
    assert.equal(again.id, botId);
    assert.equal(await countNamed(), 1);
    const before = (await userRow(botId)).password;
    await pool.query('UPDATE users SET is_admin = TRUE, can_create_apps = TRUE WHERE id = $1', [botId]);
    const fixed = await identity.ensureSecurityBotUser(pool);
    assert.equal(fixed.id, botId);
    const u = await userRow(botId);
    assert.equal(u.is_admin, false);
    assert.equal(u.can_create_apps, false);
    assert.equal(u.password, before, 'the stored hash is not re-issued');
    assert.deepEqual((await identity.findSecurityBotUser(pool)).id, botId);
  });

  await t.test('the ordinary sign-in form refuses it, even with a known password', async () => {
    // The real password is discarded; give the row one we know, to prove the
    // refusal is the synthetic flag and not merely an unknown password.
    await pool.query('UPDATE users SET password = $2 WHERE id = $1', [botId, await bcrypt.hash('known-test-password', 4)]);
    const app = express();
    app.use(express.json(), cookieParser());
    app.use(require('../src/routes/auth').authRoutes(config));
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const login = () => fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'security_bot', password: 'known-test-password' }),
    });
    const res = await login();
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null, 'no session cookie is issued');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [botId])).rows[0].n, 0);
    // Control: the same row and password, not synthetic, does sign in, so the
    // 401 above is the synthetic flag at work.
    await pool.query('UPDATE users SET is_synthetic = FALSE WHERE id = $1', [botId]);
    const control = await login();
    assert.equal(control.status, 200, await control.clone().text());
    await pool.query('UPDATE users SET is_synthetic = TRUE WHERE id = $1', [botId]);
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [botId]);
  });

  await t.test('a real person holding the name is a configuration error, never adopted', async () => {
    await pool.query('DELETE FROM users WHERE id = $1', [botId]);
    const { rows: [person] } = await pool.query(
      "INSERT INTO users (username, password) VALUES ('Security_Bot', 'x') RETURNING id");
    for (const call of [identity.ensureSecurityBotUser, identity.findSecurityBotUser]) {
      await assert.rejects(call(pool), (err) => err instanceof identity.SecurityBotIdentityError
        && err.code === 'security_bot_name_taken' && /Configuration error/.test(err.message));
    }
    const u = await userRow(person.id);
    assert.equal(u.is_synthetic, false, 'the person\'s account is untouched');
    assert.equal(u.password, 'x');
    assert.equal(await countNamed(), 1);
  });

  await t.test('no OpenRouter key was provisioned or looked up', () => {
    assert.deepEqual(keyCalls, []);
  });
});
