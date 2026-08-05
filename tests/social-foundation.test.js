'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const collapse = (sql) => sql.replace(/\s+/g, ' ').trim();

let handler = async (sql) => {
  throw new Error(`unexpected query: ${collapse(sql).slice(0, 120)}`);
};
const calls = [];
const fakeDb = {
  async query(sql, params = []) {
    calls.push({ sql: collapse(sql), params });
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(collapse(sql))) return { rows: [], rowCount: 0 };
    return handler(collapse(sql), params);
  },
};
const fakePool = {
  query: (...args) => fakeDb.query(...args),
  connect: async () => ({ ...fakeDb, release() {} }),
};

const poolModule = require('../src/db/pool');
const originalGetPool = poolModule.getPool;
poolModule.getPool = () => fakePool;
delete require.cache[require.resolve('../src/routes/social')];
const social = require('../src/routes/social');
poolModule.getPool = originalGetPool;

let currentUser;
let server;
let base;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (currentUser) req.user = currentUser; next(); });
  app.use(social.socialRoutes({}));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server?.close());
test.beforeEach(() => {
  currentUser = { id: 7, username: 'viewer' };
  calls.length = 0;
  handler = async (sql) => { throw new Error(`unexpected query: ${sql.slice(0, 120)}`); };
});

async function request(url, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: body == null ? {} : { 'content-type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

test('strict ids, cursors, pair normalization and Unicode group names are bounded', () => {
  assert.equal(social.positiveId('1'), 1);
  for (const bad of ['0', '-1', '1e3', '1.0', ' 1', '2147483648', 'x']) {
    assert.equal(social.positiveId(bad), null, bad);
  }
  assert.deepEqual(social.pair(9, 2), [2, 9]);
  assert.deepEqual(social.pageArgs({ limit: '500', after: '9' }), { limit: 50, after: 9 });
  assert.equal(social.pageArgs({ after: '1e3' }), null);
  assert.equal(social.groupName('  friends  '), 'friends');
  assert.equal(social.groupName('x'.repeat(81)), null);
  assert.equal(social.groupName('bad\nname'), null);
});

test('schema pins mutual consent, owner/member integrity, cascades, indexes and staging privacy', () => {
  const schema = read('src/db/schema.sql');
  for (const table of ['contact_relationships', 'user_blocks', 'social_groups', 'social_group_members']) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.match(schema, new RegExp(`COMMENT ON TABLE ${table} IS 'staging:private'`));
  }
  assert.match(schema, /PRIMARY KEY \(user_low_id, user_high_id\)/);
  assert.match(schema, /CHECK \(user_low_id < user_high_id\)/);
  assert.match(schema, /CHECK \(requested_by IN \(user_low_id, user_high_id\)\)/);
  assert.match(schema, /owner_user_id INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(schema, /CHECK \(status IN \('invited', 'member'\)\)/);
});

test('server mounts the social router behind the existing auth middleware', () => {
  const serverSource = read('server.js');
  const auth = serverSource.indexOf('app.use(authMiddleware(config))');
  const socialMount = serverSource.indexOf('app.use(socialRoutes(config))');
  assert.ok(auth >= 0 && socialMount > auth);
});

test('Profile UI is signed-in gated, DOM-built, accessible, and states non-authority', () => {
  const profile = read('public/js/profile.js');
  assert.match(profile, /if \(!window\.App\?\.user\) return/);
  assert.match(profile, /Private mutual contacts and membership-only groups/);
  assert.match(profile, /never grant app or voting access/);
  assert.match(profile, /setAttribute\('role', 'tablist'\)/);
  assert.match(profile, /setAttribute\('role', 'alert'\)/);
  assert.match(profile, /min-h-\[44px\]/);
  assert.doesNotMatch(profile, /innerHTML\s*=/);
});

test('all social endpoints fail closed and return no-store without identity', async () => {
  currentUser = null;
  const res = await request('/api/social/contacts');
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(calls.length, 0);
});

test('contact list exposes only the requester pair and maps mutual/incoming/outgoing', async () => {
  handler = async (sql) => {
    assert.match(sql, /NOT EXISTS \( SELECT 1 FROM user_blocks/);
    return { rows: [
      { user_low_id: 3, user_high_id: 7, requested_by: 3, status: 'pending', created_at: 'now', accepted_at: null, other_id: 3, username: 'alice' },
      { user_low_id: 7, user_high_id: 9, requested_by: 7, status: 'pending', created_at: 'now', accepted_at: null, other_id: 9, username: 'bob' },
      { user_low_id: 7, user_high_id: 11, requested_by: 11, status: 'accepted', created_at: 'now', accepted_at: 'now', other_id: 11, username: 'cy' },
    ] };
  };
  const res = await request('/api/social/contacts?limit=3');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.contacts.map((x) => x.direction), ['incoming', 'outgoing', 'mutual']);
  assert.deepEqual(Object.keys(res.body.contacts[0]).sort(),
    ['acceptedAt', 'createdAt', 'direction', 'status', 'userId', 'username']);
});

test('new contact request uses a pair lock before insert and creates one minimal notification', async () => {
  handler = async (sql) => {
    if (sql.includes('FROM users WHERE LOWER(username)')) return { rows: [{ id: 9, username: 'bob' }] };
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM user_blocks')) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM contact_relationships') && sql.includes('FOR UPDATE')) return { rows: [] };
    if (sql.startsWith('INSERT INTO contact_relationships')) return { rows: [], rowCount: 1 };
    if (sql.startsWith('INSERT INTO notifications')) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected query: ${sql}`);
  };
  const res = await request('/api/social/contacts/requests', {
    method: 'POST', body: { username: 'bob' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'pending');
  const lockAt = calls.findIndex((c) => c.sql.includes('pg_advisory_xact_lock'));
  const insertAt = calls.findIndex((c) => c.sql.startsWith('INSERT INTO contact_relationships'));
  assert.ok(lockAt >= 0 && insertAt > lockAt);
  assert.equal(calls.filter((c) => c.sql.startsWith('INSERT INTO notifications')).length, 1);
});

test('blocked and absent exact usernames share the same unavailable response', async () => {
  let exists = true;
  handler = async (sql) => {
    if (sql.includes('FROM users WHERE LOWER(username)')) {
      return { rows: exists ? [{ id: 9, username: 'bob' }] : [] };
    }
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM user_blocks')) return { rows: [{ 1: 1 }], rowCount: 1 };
    throw new Error(`unexpected query: ${sql}`);
  };
  const blocked = await request('/api/social/contacts/requests', { method: 'POST', body: { username: 'bob' } });
  exists = false;
  const absent = await request('/api/social/contacts/requests', { method: 'POST', body: { username: 'ghost' } });
  assert.deepEqual([blocked.status, blocked.body], [absent.status, absent.body]);
  assert.equal(blocked.status, 404);
});

test('crossed requests become accepted mutual contacts atomically', async () => {
  handler = async (sql) => {
    if (sql.includes('FROM users WHERE LOWER(username)')) return { rows: [{ id: 9, username: 'bob' }] };
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM user_blocks')) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM contact_relationships') && sql.includes('FOR UPDATE')) {
      return { rows: [{ requested_by: 9, status: 'pending' }] };
    }
    if (sql.startsWith('UPDATE contact_relationships SET status')) return { rows: [], rowCount: 1 };
    if (sql.startsWith('INSERT INTO notifications')) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected query: ${sql}`);
  };
  const res = await request('/api/social/contacts/requests', { method: 'POST', body: { username: 'bob' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'accepted');
});

test('group creation rejects control/XSS-shaped overlong names before querying', async () => {
  let res = await request('/api/social/groups', { method: 'POST', body: { name: 'bad\nname' } });
  assert.equal(res.status, 400);
  res = await request('/api/social/groups', { method: 'POST', body: { name: '<img>'.repeat(20) } });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('pending group invitee gets safe metadata and no roster query', async () => {
  handler = async (sql) => {
    if (sql.includes('FROM social_groups g') && sql.includes('JOIN social_group_members me')) {
      return { rows: [{
        id: 4, name: 'Private crew', owner_user_id: 2, owner_username: 'owner',
        status: 'invited', created_at: 'now', updated_at: 'now',
      }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  const res = await request('/api/social/groups/4');
  assert.equal(res.status, 200);
  assert.equal(res.body.members, null);
  assert.equal(calls.some((c) => c.sql.includes('ORDER BY (gm.user_id')), false);
});

test('outsiders cannot enumerate a group through self-removal', async () => {
  handler = async (sql) => {
    if (sql.includes('FROM social_groups g WHERE g.id')) {
      return { rows: [{ owner_user_id: 2, requester_is_member: false }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  const res = await request('/api/social/groups/4/members/7', { method: 'DELETE' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Group not found');
});

test('owner cannot be removed, preventing orphaned groups', async () => {
  currentUser = { id: 2, username: 'owner' };
  handler = async (sql) => {
    if (sql.includes('FROM social_groups g WHERE g.id')) {
      return { rows: [{ owner_user_id: 2, requester_is_member: true }] };
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  const res = await request('/api/social/groups/4/members/2', { method: 'DELETE' });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /Transfer ownership/);
});

test('notification UI has explicit social copy and navigates to Profile', () => {
  const source = read('public/js/notifications.js');
  for (const kind of ['contact_request', 'contact_accepted', 'social_group_invite']) {
    assert.match(source, new RegExp(kind));
  }
  assert.match(source, /App\.navigateToProfile/);
});
