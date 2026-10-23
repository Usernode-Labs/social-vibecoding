'use strict';

// The tier list's share of a Homeroom-wide tier list, as every new tier list
// gets it (app-templates/tier-list/usernode-rankings.js, mounted from its
// api.js): off as it comes, reachable only with a platform token for this
// app and this purpose, and when a group turns it on, counts per tier and
// never who. Token checks run everywhere; the export runs against a
// throwaway PostgreSQL database when one is reachable (TEST_DATABASE_URL
// makes it required).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
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
const appTemplates = require('../src/services/app-templates');
const rankings = require('../app-templates/tier-list/usernode-rankings');
const tierApi = require('../app-templates/tier-list/api');

const SOURCE = path.join(__dirname, '..', 'app-templates', 'tier-list', 'usernode-rankings.js');
const AUDIENCE = 'usernode:app:42';
const options = { publicKey, audience: AUDIENCE };
// The platform has no signer for this purpose yet, so the test signs as it
// would: RS256 under the app-identity key, this app's audience.
const platformToken = (purpose = 'rankings-export', audience = AUDIENCE) =>
  jwt.sign({ pur: purpose }, privateKey, { algorithm: 'RS256', issuer: 'usernode', audience, expiresIn: 60 });
const req = (token) => ({ get: (name) => (name === 'x-usernode-platform-token' ? token : undefined) });
const noDatabase = { query: () => assert.fail('no database access') };

test('every tier list ships it, mounted from api.js, and switched off', () => {
  for (const id of ['tier-list-restaurants', 'tier-list-hikes', 'tier-list-cities', 'tier-list-games']) {
    const files = template.getTemplateFiles('Demo', 'demo', 'postgres://x/y', null, { template: id });
    const handler = files.find((f) => f.path === 'usernode-rankings.js');
    assert.ok(handler, `${id} writes usernode-rankings.js`);
    assert.equal(handler.content, fs.readFileSync(SOURCE, 'utf8'), 'copied as it is: nothing in it is a placeholder');
    assert.match(files.find((f) => f.path === 'api.js').content, /require\('\.\/usernode-rankings'\)\.mount\(app, pool\);/);
  }
  // Only the tier lists: no other starter has the tables it reads.
  for (const id of appTemplates.READY_IDS.filter((t) => !t.startsWith('tier-list-'))) {
    const files = template.getTemplateFiles('Demo', 'demo', 'postgres://x/y', null, { template: id });
    assert.equal(files.find((f) => f.path === 'usernode-rankings.js'), undefined, id);
  }
  // Off is the literal a group's vote would change: one line, nothing else.
  assert.equal(rankings.SHARE_RANKINGS, false);
  assert.match(fs.readFileSync(SOURCE, 'utf8'), /^const SHARE_RANKINGS = false;$/m);
});

test('only a platform token for this app and this purpose is let in', () => {
  assert.equal(rankings.verifyPlatformRequest(req(platformToken()), options), true);
  assert.equal(rankings.verifyPlatformRequest(req(platformToken('user-export')), options), false, 'another purpose');
  assert.equal(rankings.verifyPlatformRequest(req(platformToken('rankings-export', 'usernode:app:43')), options), false, 'another app');
  assert.equal(rankings.verifyPlatformRequest(req(undefined), options), false, 'no token');
  // A person's own sign-in token, and the platform's user-data tokens, open nothing here.
  const signIn = platformJwt.signAppIdentityToken({ appId: 42, user: { id: 7, username: 'x' } });
  assert.equal(rankings.verifyPlatformRequest(req(signIn), options), false, 'a sign-in token');
  const exportToken = platformJwt.signAppUserDataToken({ appId: 42, userId: 7, purpose: 'user-export' });
  assert.equal(rankings.verifyPlatformRequest(req(exportToken), options), false, 'a user-export token');
  // An HS256 token "signed" with something other than the key, the classic forgery.
  const forged = jwt.sign({ pur: 'rankings-export' }, 'not-the-key', { algorithm: 'HS256', issuer: 'usernode', audience: AUDIENCE });
  assert.equal(rankings.verifyPlatformRequest(req(forged), options), false, 'HS256');
  // Not configured (no key in env): refuse rather than trust.
  assert.equal(rankings.verifyPlatformRequest(req(platformToken()), { publicKey: '', audience: AUDIENCE }), false);
});

async function listen(pool, share) {
  const app = express();
  rankings.mount(app, pool, { ...options, share });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('it refuses before touching the database: no token, or a group that has not turned it on', async () => {
  const off = await listen(noDatabase, rankings.SHARE_RANKINGS);
  const on = await listen(noDatabase, true);
  try {
    let r = await fetch(off.base + '/usernode/rankings-export');
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, 'platform_token_required');
    r = await fetch(off.base + '/usernode/rankings-export', { headers: { 'x-usernode-platform-token': platformToken() } });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, 'not_shared', 'off as it comes, even for the platform');
    r = await fetch(on.base + '/usernode/rankings-export', { headers: { 'x-usernode-platform-token': platformToken('user-export') } });
    assert.equal(r.status, 403, 'turned on, still only for its own purpose');
  } finally {
    off.server.close();
    on.server.close();
  }
});

test('turned on, it sends counts per tier against PostgreSQL, and never who', { timeout: 60000 }, async (t) => {
  const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'tier_list_rankings_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url) });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  // The tables as the tier list makes them, with a production database's rows.
  await tierApi.migrate(pool);
  const items = (await pool.query(`
    INSERT INTO tier_items (name, created_by, created_by_name)
    VALUES ('Lisbon', 7, 'ana'), ('Porto', 8, 'ben'), ('Nobody ranked it', 7, 'ana')
    RETURNING id`)).rows.map((r) => r.id);
  await pool.query(`
    INSERT INTO tier_votes (item_id, user_id, username, tier)
    VALUES ($1, 7, 'ana', 'S'), ($1, 8, 'ben', 'S'), ($1, 9, 'cy', 'A'),
           ($2, 7, 'ana', 'C'), ($2, 9, 'cy', 'W')`, items.slice(0, 2));

  const { server, base } = await listen(pool, true);
  t.after(() => server.close());
  const r = await fetch(base + '/usernode/rankings-export', { headers: { 'x-usernode-platform-token': platformToken() } });
  assert.equal(r.status, 200);
  const body = await r.json();
  const zero = { S: 0, A: 0, B: 0, C: 0, D: 0, F: 0 };
  assert.deepEqual(body, {
    version: 1,
    tiers: ['S', 'A', 'B', 'C', 'D', 'F'],
    people: 3,
    items: [
      { name: 'Lisbon', tiers: { ...zero, S: 2, A: 1 }, wants: 0 },
      { name: 'Porto', tiers: { ...zero, C: 1 }, wants: 1 },
      { name: 'Nobody ranked it', tiers: zero, wants: 0 },
    ],
    truncated: false,
  });
  // Nobody's id or name rides along, however the rows were written.
  const text = JSON.stringify(body);
  for (const who of ['ana', 'ben', 'cy', 'user_id', 'username', 'created_by']) assert.ok(!text.includes(who), who);
});
