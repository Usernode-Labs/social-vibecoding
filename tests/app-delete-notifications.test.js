'use strict';

// #2161: the two notification creators behind a refused or completed delete
// of a shared app. createAppDeleteAttemptNotifications keeps its app
// reference and deduplicates per unread (recipient, app); the deleted kind
// has no app row left to reference, so the name rides in `detail` and the
// actor is always excluded from the fan-out.

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}
stub(require.resolve('../src/services/logger'), { info() {}, warn() {}, error() {}, debug() {} });
stub(require.resolve('../src/services/active-users'), { listActiveUserIds: async () => [] });

const pushed = [];
stub(require.resolve('../src/services/ws'), {
  pushNotificationToUser: (userId, payload) => pushed.push({ userId, payload }),
});

const notifications = require('../src/services/notifications');

const collapse = (sql) => sql.replace(/\s+/g, ' ').trim();

function fakePool() {
  const state = { inserts: [], hydrated: [] };
  return {
    state,
    async query(rawSql, params = []) {
      const sql = collapse(rawSql);
      if (/^INSERT INTO notifications/i.test(sql)) {
        state.inserts.push({ sql, params });
        const recipients = params[2];
        return { rows: recipients.map((userId, i) => ({ id: i + 1, user_id: userId })) };
      }
      if (/^SELECT n\.id, n\.kind/i.test(sql)) {
        state.hydrated.push(params[0]);
        return { rows: [{ id: params[0], user_id: 5, kind: 'x' }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test.beforeEach(() => { pushed.length = 0; });

test('an attempt is filed against the app, once per unread recipient, without the actor', async () => {
  const pool = fakePool();
  const rows = await notifications.createAppDeleteAttemptNotifications(pool, {
    appId: 7, actorId: 42, recipientIds: [42, 101, 102, 101, null],
  });
  assert.equal(pool.state.inserts.length, 1);
  const { sql, params } = pool.state.inserts[0];
  assert.match(sql, /'app_delete_attempted'/);
  assert.match(sql, /WHERE NOT EXISTS/, 'unread dedup per (recipient, app)');
  assert.match(sql, /n\.read_at IS NULL/);
  assert.deepEqual(params, [7, 42, [101, 102]]);
  assert.equal(rows.length, 2);
  assert.deepEqual(pool.state.hydrated, [1, 2], 'each row is pushed live');
  assert.equal(pushed.length, 2);
});

test('an attempt with nobody else to tell writes nothing', async () => {
  const pool = fakePool();
  assert.deepEqual(await notifications.createAppDeleteAttemptNotifications(pool, {
    appId: 7, actorId: 42, recipientIds: [42],
  }), []);
  assert.deepEqual(await notifications.createAppDeleteAttemptNotifications(pool, {
    appId: null, actorId: 42, recipientIds: [1],
  }), []);
  assert.equal(pool.state.inserts.length, 0);
});

test('a completed deletion carries the name, no app reference, and skips the actor', async () => {
  const pool = fakePool();
  const rows = await notifications.createAppDeletedNotifications(pool, {
    appName: 'Block Game', appSlug: 'block-game-54d305', actorId: 1, recipientIds: [1, 42, 101],
  });
  assert.equal(pool.state.inserts.length, 1);
  const { sql, params } = pool.state.inserts[0];
  assert.match(sql, /'app_deleted'/);
  assert.match(sql, /SELECT r\.user_id, NULL, \$1, 'app_deleted', \$2/, 'app_id is NULL: the row is gone');
  assert.deepEqual(params, [1, 'Block Game', [42, 101]]);
  assert.equal(rows.length, 2);
  assert.equal(pushed.length, 2);
});

test('a completed deletion falls back to the slug, and caps the name at the column width', async () => {
  const pool = fakePool();
  await notifications.createAppDeletedNotifications(pool, {
    appName: '', appSlug: 'block-game-54d305', actorId: 1, recipientIds: [42],
  });
  assert.equal(pool.state.inserts[0].params[1], 'block-game-54d305');
  await notifications.createAppDeletedNotifications(pool, {
    appName: 'x'.repeat(300), appSlug: 's', actorId: 1, recipientIds: [42],
  });
  assert.equal(pool.state.inserts[1].params[1].length, 255);
});

test('the schema widened notifications.detail for the deleted app name', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  assert.match(schema, /ALTER TABLE notifications ALTER COLUMN detail TYPE VARCHAR\(255\);/);
});
