'use strict';

// Wallet sign-in challenges (routes/auth.js wallet-check, wallet-verify,
// wallet-reset-verify, wallet-change-password) live in Postgres
// (wallet_challenges), as their hash: one minted by one process is redeemed
// by whichever answers the signed reply, once. In each process's memory
// before, a reply another web Pod (or the next release) answered failed.
//
// Two routers stand for two processes: each kept its own Map before.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/wallet-challenges-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a wallet challenge minted by one process is redeemed by another, once', { timeout: 60000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wallet_challenges_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const poolMod = require('../src/db/pool');
  const realGetPool = poolMod.getPool;
  poolMod.getPool = () => pool;
  const logger = require('../src/services/logger');
  const quiet = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((l) => [l, logger[l]]));
  for (const l of Object.keys(quiet)) logger[l] = () => {};
  const rpc = await new Promise((resolve) => {
    const s = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"valid":true}'); }); });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const servers = [];
  t.after(async () => {
    for (const s of servers) s.close();
    rpc.close();
    poolMod.getPool = realGetPool;
    Object.assign(logger, quiet);
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });

  const address = 'ut1' + 'q'.repeat(59);
  await pool.query(`INSERT INTO users (username, password, usernode_pubkey) VALUES ('walleted', 'x', $1)`, [address]);
  delete require.cache[require.resolve('../src/routes/auth')];
  const { authRoutes } = require('../src/routes/auth');
  const serve = () => new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use(authRoutes({ nodeRpcUrl: `http://127.0.0.1:${rpc.address().port}` }));
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    servers.push(s);
  });
  const one = await serve();
  const two = await serve();
  const post = (s, path, body) => fetch(`http://127.0.0.1:${s.address().port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  const minted = await post(one, '/api/auth/wallet-check', { pubkey: address });
  assert.equal(minted.status, 200);
  const { challenge } = minted.body;
  assert.match(challenge, /^[0-9a-f]{64}$/);
  const { rows: kept } = await pool.query('SELECT challenge_hash, pubkey FROM wallet_challenges');
  assert.deepEqual(kept.map((r) => r.pubkey), [address]);
  assert.notEqual(kept[0].challenge_hash, challenge, 'only its hash is kept');

  // Another address cannot spend it, and that leaves it in place.
  assert.equal((await post(two, '/api/auth/wallet-reset-verify', { pubkey: 'ut1other', challenge, signature: 's', newPassword: 'a-brand-new-pass-1' })).status, 401);
  // The other process redeems it, once.
  const redeemed = await post(two, '/api/auth/wallet-reset-verify', { pubkey: address, challenge, signature: 's', newPassword: 'a-brand-new-pass-1' });
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
  assert.equal((await post(one, '/api/auth/wallet-reset-verify', { pubkey: address, challenge, signature: 's', newPassword: 'a-brand-new-pass-1' })).status, 401, 'single use');

  // Past its two minutes, it is refused, and the next mint clears it.
  const late = (await post(one, '/api/auth/wallet-check', { pubkey: address })).body.challenge;
  await pool.query(`UPDATE wallet_challenges SET expires_at = NOW() - interval '1 second'`);
  assert.equal((await post(two, '/api/auth/wallet-reset-verify', { pubkey: address, challenge: late, signature: 's', newPassword: 'a-brand-new-pass-1' })).status, 401);
  await post(one, '/api/auth/wallet-check', { pubkey: address });
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM wallet_challenges')).rows[0].n, 1);
});
