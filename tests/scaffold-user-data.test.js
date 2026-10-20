'use strict';

// #5118: the app side of the user-data contract, as every new app gets it
// (app-templates/_scaffold/usernode-user-data.js, written into the repo by
// services/template.js and mounted from its server.js). Token checks run
// everywhere; erasure and export run against a throwaway PostgreSQL database
// when one is reachable (TEST_DATABASE_URL makes it required).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
process.env.IFRAME_JWT_PRIVATE_KEY = privateKey;
process.env.IFRAME_JWT_PUBLIC_KEY = publicKey;

const platformJwt = require('../src/services/platform-jwt');
const template = require('../src/services/template');
const userData = require('../app-templates/_scaffold/usernode-user-data');

const AUDIENCE = 'usernode:app:42';
const options = { publicKey, audience: AUDIENCE };
const platformToken = (purpose, userId = 7, appId = 42, usernodePubkey = 'ut1wallet') =>
  platformJwt.signAppUserDataToken({ appId, userId, usernodePubkey, purpose });
const req = (token) => ({ get: (name) => (name === 'x-usernode-platform-token' ? token : undefined) });

test('every new app ships the handler and mounts it before the sign-in check', () => {
  for (const files of [template.getTemplateFiles('Demo', 'demo', 'postgres://x/y')]) {
    const handler = files.find((f) => f.path === 'usernode-user-data.js');
    assert.ok(handler, 'the scaffold writes usernode-user-data.js');
    assert.equal(handler.content, require('node:fs').readFileSync(require.resolve('../app-templates/_scaffold/usernode-user-data.js'), 'utf8'));
    const server = files.find((f) => f.path === 'server.js').content;
    const mount = server.indexOf("require('./usernode-user-data').mount(app, pool);");
    assert.ok(mount > 0, 'server.js mounts it');
    assert.ok(mount < server.indexOf('app.use((req, res, next) => {\n  req.now'), 'before the sign-in middleware');
    assert.match(files.find((f) => f.path === 'CLAUDE.md').content, /## Your people's data/);
  }
});

test('only a platform token for this app and this purpose names a person', () => {
  const deletion = platformToken('user-deletion');
  assert.deepEqual(userData.verifyPlatformRequest(req(deletion), 'user-deletion', options), { id: 7, usernodePubkey: 'ut1wallet' });
  assert.equal(userData.verifyPlatformRequest(req(deletion), 'user-export', options), null, 'wrong purpose');
  assert.equal(userData.verifyPlatformRequest(req(platformToken('user-deletion', 7, 43)), 'user-deletion', options), null, 'another app');
  assert.equal(userData.verifyPlatformRequest(req(undefined), 'user-deletion', options), null, 'no token');
  // A person's own sign-in token cannot erase them (or anyone).
  const signIn = platformJwt.signAppIdentityToken({ appId: 42, user: { id: 7, username: 'x' } });
  assert.equal(userData.verifyPlatformRequest(req(signIn), 'user-deletion', options), null, 'a sign-in token');
  // An HS256 token "signed" with the public PEM, the classic forgery.
  const forged = jwt.sign({ id: 7, pur: 'user-deletion' }, 'not-the-key', { algorithm: 'HS256', issuer: 'usernode', audience: AUDIENCE });
  assert.equal(userData.verifyPlatformRequest(req(forged), 'user-deletion', options), null, 'HS256');
  // Not configured (no key in env): refuse rather than trust.
  assert.equal(userData.verifyPlatformRequest(req(deletion), 'user-deletion', { publicKey: '', audience: AUDIENCE }), null);
});

async function listen(pool) {
  const app = express();
  app.use(express.json());
  userData.mount(app, pool, options);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('the routes refuse a request without a valid platform token before touching the database', async () => {
  const pool = { connect: () => assert.fail('no database access'), query: () => assert.fail('no database access') };
  const { server, base } = await listen(pool);
  try {
    let r = await fetch(base + '/usernode/user-deletion', { method: 'POST' });
    assert.equal(r.status, 403);
    r = await fetch(base + '/usernode/user-deletion', { method: 'POST', headers: { 'x-usernode-platform-token': platformToken('user-export') } });
    assert.equal(r.status, 403);
    r = await fetch(base + '/usernode/user-export', { headers: { 'x-usernode-platform-token': platformToken('user-deletion') } });
    assert.equal(r.status, 403);
  } finally {
    server.close();
  }
});

test('erasure and export against PostgreSQL', { timeout: 60000 }, async (t) => {
  const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'scaffold_user_data_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url) });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  // A poll app's shape: a shared poll (created_by), the person's votes, a
  // note keyed by wallet address, a child row pointing at a vote (so the
  // delete order matters), and an audit table whose user_id is not "about"
  // the person.
  await pool.query(`
    CREATE TABLE polls (id SERIAL PRIMARY KEY, question TEXT, created_by INTEGER, created_by_name TEXT);
    CREATE TABLE poll_votes (id SERIAL PRIMARY KEY, poll_id INTEGER REFERENCES polls(id), user_id INTEGER NOT NULL, username TEXT);
    CREATE TABLE vote_receipts (id SERIAL PRIMARY KEY, vote_id INTEGER NOT NULL REFERENCES poll_votes(id), user_id INTEGER);
    CREATE TABLE wallet_notes (id SERIAL PRIMARY KEY, usernode_pubkey TEXT, note TEXT);
    CREATE TABLE moderation_log (id SERIAL PRIMARY KEY, user_id INTEGER, action TEXT);
  `);
  const poll = (await pool.query("INSERT INTO polls (question, created_by, created_by_name) VALUES ('Lunch?', 7, 'ana') RETURNING id")).rows[0].id;
  const votes = (await pool.query('INSERT INTO poll_votes (poll_id, user_id, username) VALUES ($1, 7, $2), ($1, 8, $3) RETURNING id', [poll, 'ana', 'ben'])).rows;
  // A row of someone else's pointing at the person's vote, created before it
  // in table order: the delete must retry past the foreign key.
  await pool.query('INSERT INTO vote_receipts (vote_id, user_id) VALUES ($1, 7)', [votes[0].id]);
  await pool.query("INSERT INTO wallet_notes (usernode_pubkey, note) VALUES ('ut1wallet', 'mine'), ('ut1other', 'theirs')");
  await pool.query("INSERT INTO moderation_log (user_id, action) VALUES (7, 'warned')");
  userData.OWNED_BY.push({ table: 'polls', column: 'created_by', action: 'anonymise', clear: ['created_by_name'] });
  userData.SKIP.push('moderation_log');
  t.after(() => { userData.OWNED_BY.length = 0; userData.SKIP.length = 0; });

  const { server, base } = await listen(pool);
  t.after(() => server.close());

  let r = await fetch(base + '/usernode/user-export', { headers: { 'x-usernode-platform-token': platformToken('user-export') } });
  assert.equal(r.status, 200);
  const exported = await r.json();
  assert.equal(exported.userId, 7);
  assert.deepEqual(Object.keys(exported.tables).sort(), ['poll_votes', 'polls', 'vote_receipts', 'wallet_notes']);
  assert.equal(exported.tables.poll_votes.length, 1);
  assert.equal(exported.tables.wallet_notes[0].note, 'mine');

  for (let i = 0; i < 2; i++) { // idempotent: the platform retries until it hears 2xx
    r = await fetch(base + '/usernode/user-deletion', { method: 'POST', headers: { 'x-usernode-platform-token': platformToken('user-deletion') } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
  }
  const all = async (sql) => (await pool.query(sql)).rows;
  assert.deepEqual(await all('SELECT user_id FROM poll_votes'), [{ user_id: 8 }], "only the other person's vote is left");
  assert.deepEqual(await all('SELECT * FROM vote_receipts'), []);
  assert.deepEqual(await all('SELECT note FROM wallet_notes'), [{ note: 'theirs' }]);
  assert.deepEqual(await all('SELECT question, created_by, created_by_name FROM polls'),
    [{ question: 'Lunch?', created_by: null, created_by_name: null }], 'the shared poll stays, nameless');
  assert.deepEqual(await all('SELECT user_id FROM moderation_log'), [{ user_id: 7 }], 'SKIP is left alone');
});
