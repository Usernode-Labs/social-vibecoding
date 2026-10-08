'use strict';

// Phone sign-in TEST NUMBERS against the full schema, through the real
// routes: what a newcomer's first run on a local stack does when they follow
// an invite and join with +1 415 555 0100 and the test code
// (services/firebase-phone-auth.js, TEST NUMBERS). The account it makes is
// the real one — the invite is followed, they are a private member with a
// handle from their name — and it is a test account, fenced and retirable,
// after which the number is free for the next round. Skipped when no server
// is reachable, and required when TEST_DATABASE_URL is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const express = require('express');
const cookieParser = require('cookie-parser');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// Retire's app teardown reaches outside the database; nothing here made an
// app, but the modules are stubbed so nothing real could be dropped.
function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}
stub(require.resolve('../src/services/db-manager'), {
  appDbName: (slug) => `app_${slug}`,
  dropDatabase: async () => {},
});
stub(require.resolve('../src/services/app-files'), {
  getStore: () => ({ removeAppPrefix: async () => 0 }),
});

const NUMBER = '+1 415 555 0100';
const E164 = '+14155550100';

function post(base, path, body = {}, headers = {}) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('a test number joins an invite as a test account, against the full schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'phone_test_numbers_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  const config = { databaseUrl: String(url), jwtSecret: 'synthetic-test-only', phoneTestCode: '123456' };
  const routePool = require('../src/db/pool').getPool(config);
  let server = null;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await routePool.end();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const invites = require('../src/services/community-invites');
  const testAccounts = require('../src/services/test-accounts');
  const journeyLeftOut = require('../src/services/journey-left-out');
  const { phoneAuthRoutes } = require('../src/routes/phone-auth');

  // Jordan's private group, and a link to it with a note.
  const { rows: [jordan] } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ('jordan', 'x', TRUE) RETURNING id, username`
  );
  await pool.query(
    `INSERT INTO apps (name, slug, created_by, view_visibility, collab_visibility)
     VALUES ('Plant Pal', 'plant-pal', $1, 'private', 'private')`,
    [jordan.id]
  );
  const { rows: [group] } = await pool.query(
    `SELECT id, slug, name, created_by, self_hosted, collab_visibility, view_visibility, community_id
       FROM apps WHERE slug = 'plant-pal'`
  );
  await pool.query(
    "INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING",
    [group.id, jordan.id]
  );
  await pool.query(
    'INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [group.community_id, jordan.id]
  );
  const made = await invites.createInvite(pool, {
    app: group, user: { ...jordan, isAdmin: false, hasPlatformAccess: true },
    note: 'Help me keep the plants alive',
  });
  assert.ok(made.ok);
  const { rows: [ops] } = await pool.query(
    `INSERT INTO users (username, password, is_admin) VALUES ('ops', 'x', TRUE) RETURNING id`
  );

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(phoneAuthRoutes(config));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function join(code) {
    const asked = await post(base, '/api/auth/phone/request', { phoneNumber: NUMBER });
    assert.equal(asked.status, 200);
    const { sessionInfo } = await asked.json();
    return post(base, '/api/auth/phone/verify',
      { sessionInfo, code, name: 'Ben Ito', followInvite: true },
      { cookie: `${invites.INVITE_COOKIE}=${made.link.token}` });
  }

  let benId;
  await t.test('the wrong code is refused, and makes nobody', async () => {
    const res = await join('000000');
    assert.equal(res.status, 422);
    assert.equal((await res.json()).code, 'invalid_or_expired_code');
    const { rows } = await pool.query('SELECT 1 FROM user_phone_identities WHERE phone_e164 = $1', [E164]);
    assert.equal(rows.length, 0);
  });

  await t.test('the test code makes the account, follows the invite and signs it in', async () => {
    const res = await join('123456');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.next, 'signed-in');
    assert.equal(body.created, true);
    assert.equal(body.invite.status, 'joined');
    assert.match(res.headers.get('set-cookie'), /session=/);
    benId = body.user.id;

    const { rows: [ben] } = await pool.query(
      `SELECT u.display_name, u.username_provisional_since IS NOT NULL AS provisional,
              u.private_member_since IS NOT NULL AS private_member,
              u.test_account_created_at IS NOT NULL AS test_account, u.test_account_created_by,
              u.exclude_podium, i.firebase_uid, i.phone_e164
         FROM users u JOIN user_phone_identities i ON i.user_id = u.id
        WHERE u.id = $1`,
      [benId]
    );
    assert.equal(ben.display_name, 'Ben Ito');
    assert.equal(ben.provisional, true, 'a handle picked from the name, as for any phone Join');
    assert.equal(ben.private_member, true, 'the invite let him straight in');
    assert.equal(ben.firebase_uid, 'test-phone:' + E164, 'never mistaken for a Firebase uid');
    assert.equal(ben.phone_e164, E164);
    assert.equal(ben.test_account, true, 'an account a test number makes is a test account');
    assert.equal(ben.test_account_created_by, null);
    assert.equal(ben.exclude_podium, true);
    const { rows: member } = await pool.query(
      'SELECT 1 FROM community_members WHERE community_id = $1 AND user_id = $2', [group.community_id, benId]
    );
    assert.equal(member.length, 1);
    journeyLeftOut.forget(pool);
    const left = await journeyLeftOut.list(pool);
    assert.ok(left.some((e) => e.userId === benId && e.reason === 'test'), 'left out of Journey');
    const live = await testAccounts.list(pool);
    assert.ok(live.some((a) => a.userId === benId), 'list_test_accounts shows it');
  });

  await t.test('test numbers skip the text buckets, so a loop never hits 429', async () => {
    for (let i = 0; i < 12; i++) {
      const res = await post(base, '/api/auth/phone/request', { phoneNumber: NUMBER });
      assert.equal(res.status, 200, `request ${i + 1}`);
    }
  });

  await t.test('any other number is refused in words on a stack with test numbers only', async () => {
    const res = await post(base, '/api/auth/phone/request', { phoneNumber: '+44 7700 900123' });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).code, 'test_numbers_only');
  });

  await t.test('retiring it frees the number for the next round', async () => {
    const retired = await testAccounts.retire(pool, { userId: benId, confirmation: 'RETIRE' }, { actorId: ops.id, config });
    assert.equal(retired.userId, benId);
    const { rows: held } = await pool.query('SELECT 1 FROM user_phone_identities WHERE phone_e164 = $1', [E164]);
    assert.equal(held.length, 0);

    const again = await join('123456');
    assert.equal(again.status, 200);
    const body = await again.json();
    assert.equal(body.created, true);
    assert.notEqual(body.user.id, benId, 'a brand-new account, a brand-new first run');
    assert.equal(body.invite.status, 'joined');
  });
});
