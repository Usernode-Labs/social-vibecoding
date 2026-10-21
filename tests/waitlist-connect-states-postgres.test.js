'use strict';

// The waitlist's social-connect round trip keeps its state in Postgres
// (waitlist_connect_states, routes/waitlist-connect.js): parked by the
// process that sent the person to the provider, finished by whichever
// process their browser comes back to, and replayed on a reload. In each
// process's memory before, a callback another web Pod (or the next release)
// answered found nothing. tests/lib/waitlist-connect-states.js, which the
// route suites use, is held to the same answers here.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/waitlist-connect-states-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a round trip parked by one process is finished by another, and replayed', { timeout: 60000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'waitlist_connect_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const TOKEN = 'c'.repeat(48);
  const poolMod = require('../src/db/pool');
  const realGetPool = poolMod.getPool;
  poolMod.getPool = () => pool;
  const waitlist = require('../src/services/waitlist');
  const real = { getSignupByMoreToken: waitlist.getSignupByMoreToken };
  waitlist.getSignupByMoreToken = async (_pool, token) => (token === TOKEN ? { id: 1, email: 'x@example.com', answers: {} } : null);
  delete require.cache[require.resolve('../src/routes/waitlist-connect')];
  const { waitlistConnectRoutes } = require('../src/routes/waitlist-connect');
  const CONFIG = { env: 'production', port: 3000, waitlistLinkedinClientId: 'li-id', waitlistLinkedinClientSecret: 'li-secret',
    waitlistGithubClientId: 'gh-id', waitlistGithubClientSecret: 'gh-secret', waitlistOauthOrigin: '' };
  const servers = [];
  const serve = () => new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use(waitlistConnectRoutes(CONFIG));
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    servers.push(s);
  });
  t.after(async () => {
    for (const s of servers) s.close();
    poolMod.getPool = realGetPool;
    Object.assign(waitlist, real);
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  const one = await serve();
  const two = await serve();
  const base = (s) => `http://127.0.0.1:${s.address().port}`;
  const mint = async (s, provider) => {
    const res = await fetch(`${base(s)}/waitlist/connect/${provider}?token=${TOKEN}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    return new URL(res.headers.get('location')).searchParams.get('state');
  };
  const complete = (s, provider, body) => fetch(`${base(s)}/waitlist/connect/${provider}/complete`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json());

  const state = await mint(one, 'linkedin');
  const { rows: parked } = await pool.query('SELECT state_hash, provider, token, status FROM waitlist_connect_states');
  assert.deepEqual(parked.map((r) => [r.provider, r.token, r.status]), [['linkedin', TOKEN, null]]);
  assert.notEqual(parked[0].state_hash, state, 'only its hash is kept');

  // Another provider's callback cannot take it, and leaves it in place.
  assert.equal((await complete(two, 'github', { state })).status, 'expired');
  // The other process finishes it (the person turned it down at LinkedIn).
  const done = await complete(two, 'linkedin', { state });
  assert.deepEqual([done.status, done.redirect], ['denied', `/#more/${TOKEN}?connect=denied`]);
  // A reload on either process replays where it landed.
  assert.equal((await complete(one, 'linkedin', { state })).status, 'denied');
  assert.equal((await complete(two, 'linkedin', { state })).status, 'denied');
  // A nonce nobody minted is expired.
  assert.equal((await complete(one, 'linkedin', { state: 'nope' })).status, 'expired');
  // Past its ten minutes, it is gone, and the next parking clears it.
  await pool.query(`UPDATE waitlist_connect_states SET expires_at = NOW() - interval '1 second'`);
  assert.equal((await complete(one, 'linkedin', { state })).status, 'expired');
  await mint(one, 'github');
  assert.deepEqual((await pool.query('SELECT provider FROM waitlist_connect_states')).rows.map((r) => r.provider), ['github']);
});
