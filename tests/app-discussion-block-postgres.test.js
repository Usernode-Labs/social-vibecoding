'use strict';

// Exercise the two app-discussion reads against PostgreSQL so the block
// predicate is verified before pagination and latest-message selection.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';

test('app discussion history and inbox preview skip blocked authors', async (t) => {
  let pg;
  try { pg = require('pg'); } catch { return t.skip('pg is not installed'); }
  const admin = new pg.Client({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.connect(); }
  catch (error) {
    try { await admin.end(); } catch { /* connection never opened */ }
    return t.skip(`no postgres reachable: ${error.message}`);
  }

  const schema = `app_discussion_block_${process.pid}`;
  let pool;
  let server;
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({
      connectionString: DSN, connectionTimeoutMillis: 3000,
      options: `-c search_path=${schema}`,
    });
    await pool.query(`
      CREATE TABLE users (id int PRIMARY KEY, username text NOT NULL);
      CREATE TABLE apps (
        id int PRIMARY KEY, slug text NOT NULL, name text NOT NULL,
        icon_image_id int, icon_emoji text, self_hosted boolean NOT NULL DEFAULT false
      );
      CREATE TABLE app_collaborators (app_id int, user_id int, status text);
      CREATE TABLE user_blocks (blocker_id int, blocked_user_id int,
        PRIMARY KEY (blocker_id, blocked_user_id));
      CREATE TABLE chat_messages (
        id int PRIMARY KEY, app_id int NOT NULL, user_id int, content text NOT NULL,
        msg_type text NOT NULL DEFAULT 'message', metadata jsonb NOT NULL DEFAULT '{}',
        thread_type text, thread_ref int, created_at timestamptz NOT NULL DEFAULT now(),
        edited_at timestamptz, posted_via text
      );
      INSERT INTO users VALUES (1, 'reader'), (2, 'blocked'), (3, 'visible');
      INSERT INTO apps (id, slug, name) VALUES (7, 'demo', 'Demo');
      INSERT INTO app_collaborators VALUES (7, 1, 'member');
      INSERT INTO user_blocks VALUES (1, 2);
      INSERT INTO chat_messages (id, app_id, user_id, content, metadata) VALUES
        (1, 7, 3, 'visible older', '{}'),
        (2, 7, 2, 'hidden older', '{}'),
        (3, 7, 3, 'visible newest', '{"quote":{"refMsgId":2,"author":"blocked","snippet":"hidden older"}}'),
        (4, 7, 2, 'hidden newest', '{}');
      INSERT INTO chat_messages (id, app_id, user_id, content, thread_type, thread_ref) VALUES
        (5, 7, 3, 'thread visible', 'issue', 20),
        (6, 7, 2, 'thread hidden', 'issue', 20);
    `);

    const poolMod = require('../src/db/pool');
    poolMod.getPool = () => pool;
    const accessId = require.resolve('../src/services/app-access');
    require.cache[accessId] = {
      id: accessId, filename: accessId, loaded: true, paths: [],
      exports: { ACCESS_COLUMNS: 'id', getAppForUser: async () => ({ id: 7 }) },
    };
    const wsId = require.resolve('../src/services/ws');
    require.cache[wsId] = {
      id: wsId, filename: wsId, loaded: true, paths: [],
      exports: { getReactionsForMessages: async () => ({}) },
    };
    const bookmarksId = require.resolve('../src/services/message-bookmarks');
    require.cache[bookmarksId] = {
      id: bookmarksId, filename: bookmarksId, loaded: true, paths: [],
      exports: { savedMessageIdsFor: async () => new Set() },
    };
    const notificationsId = require.resolve('../src/services/notifications');
    require.cache[notificationsId] = {
      id: notificationsId, filename: notificationsId, loaded: true, paths: [],
      exports: { unreadMessageIdsForUser: async () => new Set() },
    };

    const { chatRoutes } = require('../src/routes/chat');
    const { DISCUSSIONS_SQL } = require('../src/routes/messages-overview');
    const app = express();
    app.use((req, _res, next) => { req.user = { id: 1, username: 'reader' }; next(); });
    app.use(chatRoutes({}));
    server = await new Promise((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const url = `http://127.0.0.1:${server.address().port}/api/apps/demo/messages`;
    const general = await (await fetch(`${url}?limit=2`)).json();
    assert.deepEqual(general.messages.map((message) => message.content),
      ['visible older', 'visible newest']);
    assert.equal(general.messages[1].metadata.quote, null,
      'a visible reply does not expose blocked quoted text');

    const topic = await (await fetch(`${url}?thread_type=issue&thread_ref=20&limit=2`)).json();
    assert.deepEqual(topic.messages.map((message) => message.content), ['thread visible']);

    const { rows } = await pool.query(DISCUSSIONS_SQL, [1, false]);
    assert.equal(rows[0].last_message, 'visible newest');
    assert.equal(rows[0].last_by, 'visible');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
});
