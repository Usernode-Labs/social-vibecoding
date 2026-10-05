'use strict';

// Mentions written in a change's description.
//
// The bell already rings people a chat `@name` names. This is the other
// half of the same convention: saving a change's description that names
// somebody inserts ONE notification row for them — kind 'mention', the
// session set, no chat message — so the row opens the change's page, and
// the usual rules carry over: self-mentions ring, the Homeroom bot is
// never rung, a blocked pair is not, and on a collab-private project only
// its members are. Only a save that CHANGED the text rings anybody.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/session-description-mentions-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('description mentions chip, ring and follow the chat rules', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `desc_mentions_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(read('src/db/schema.sql'));

  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
    [username, synthetic],
  )).rows[0];
  const evan = await user('evan');
  const ada = await user('ada');
  const noor = await user('noor');
  await user('homeroom_bot', true);

  // A collab-private project the author and Ada build together, and a
  // public one Ada has never joined.
  const app = async (slug, collab) => (await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, collab_visibility)
     VALUES ($1, $1, 'running', $2, $3, $4) RETURNING id`,
    [slug, evan.id, `https://github.com/example/${slug}`, collab],
  )).rows[0];
  const garden = await app('garden', 'private');
  const market = await app('market', 'public');
  for (const member of [evan, ada]) {
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [garden.id, member.id]);
  }
  const session = (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, is_headless, session_title)
     VALUES ($1, $2, 'active', FALSE, 'Tidy the garden beds') RETURNING id, app_id, session_title`,
    [garden.id, evan.id],
  )).rows[0];
  const marketSession = (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, is_headless, session_title)
     VALUES ($1, $2, 'active', FALSE, 'Stall prices') RETURNING id`,
    [market.id, evan.id],
  )).rows[0].id;

  const rowsFor = async (userId) => (await pool.query(
    `SELECT id, user_id, app_id, session_id, chat_message_id, source_user_id, kind
       FROM notifications WHERE session_id = $1 ORDER BY id`,
    [session.id],
  )).rows.filter((r) => r.user_id === userId);

  // ── The route: only a save that changed the text rings anybody ──
  const poolModule = require('../src/db/pool'); const previousPool = poolModule.getPool;
  poolModule.getPool = () => pool;
  const ws = require('../src/services/ws'); const previousPush = ws.pushSessionUpdate;
  ws.pushSessionUpdate = () => {};
  let server;
  try {
    const express = require('express'); const appExpress = express();
    appExpress.use(express.json());
    appExpress.use((req, _res, next) => { req.user = { id: Number(req.headers['x-test-user'] || evan.id), username: 'evan' }; next(); });
    appExpress.use(require('../src/routes/sessions').sessionRoutes({}));
    server = appExpress.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/sessions/${session.id}/description`;
    const save = async (description, expectedVersion, user = evan.id) => {
      const response = await fetch(base, { method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-test-user': String(user) },
        body: JSON.stringify({ description, expectedVersion }) });
      return { status: response.status, body: await response.json() };
    };
    const readState = async () => (await fetch(base)).json();

    await t.test('saving a description that names @ada rings her, with the change for the row', async () => {
      const result = await save('Please review the beds with @ada', 0);
      assert.equal(result.status, 200); assert.equal(result.body.changed, true);
      const rows = await rowsFor(ada.id);
      assert.equal(rows.length, 1);
      assert.deepEqual(
        { kind: rows[0].kind, session_id: rows[0].session_id, chat_message_id: rows[0].chat_message_id,
          source_user_id: rows[0].source_user_id, app_id: rows[0].app_id },
        { kind: 'mention', session_id: session.id, chat_message_id: null,
          source_user_id: evan.id, app_id: garden.id },
      );
    });

    await t.test('re-saving the identical text rings nobody, and a changed save rings again', async () => {
      const snapshot = await readState();
      assert.equal((await save('Please review the beds with @ada', snapshot.version)).body.changed, false);
      assert.equal((await rowsFor(ada.id)).length, 1, 'the unchanged save inserted nothing');
      assert.equal((await save('Still worth a look, @ada', snapshot.version)).status, 200);
      assert.equal((await rowsFor(ada.id)).length, 2, 'a changed save that still names her rings her again');
    });

    await t.test('a name that matches nobody rings nobody', async () => {
      const snapshot = await readState();
      await save('And @nobody_here should look too', snapshot.version);
      assert.equal((await rowsFor(ada.id)).length, 2, 'no second row from the unknown name');
    });

    await t.test('an email address is not a mention', async () => {
      const snapshot = await readState();
      await save('mail ada@foo.com about the beds', snapshot.version);
      assert.equal((await rowsFor(ada.id)).length, 2);
    });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    poolModule.getPool = previousPool; ws.pushSessionUpdate = previousPush;
  }

  // ── The mention rules, against the helper directly ──
  const notifications = require('../src/services/notifications');
  const ring = (appId, sessionId, content, senderId = evan.id) =>
    notifications.createSessionMentionNotifications(pool, { appId, sessionId, senderId, content });

  await t.test('a self-mention rings the author', async () => {
    const rows = await ring(garden.id, session.id, 'note to self, @evan');
    assert.deepEqual(rows.map((r) => r.user_id), [evan.id]);
  });

  await t.test('the Homeroom bot is never rung, though the people named beside it are', async () => {
    assert.deepEqual(await ring(garden.id, session.id, 'wake up @homeroom_bot'), []);
    const rows = await ring(garden.id, session.id, 'wake up @homeroom_bot and @ada');
    assert.deepEqual(rows.map((r) => r.user_id), [ada.id], 'the bot is dropped, Ada is not');
  });

  await t.test('a non-member of a collab-private project is not rung; a member is', async () => {
    assert.deepEqual(await ring(garden.id, session.id, 'help wanted, @noor'), []);
    const rows = await ring(garden.id, session.id, 'help wanted, @noor and @ada');
    assert.deepEqual(rows.map((r) => r.user_id), [ada.id]);
  });

  await t.test('on a public project anybody named is rung', async () => {
    const rows = await ring(market.id, marketSession, 'come argue prices, @noor and @ada');
    assert.deepEqual(rows.map((r) => r.user_id).sort((a, b) => a - b),
      [ada.id, noor.id].sort((a, b) => a - b), 'no member gate on a public project');
  });

  await t.test('a person who blocked the writer is not rung', async () => {
    await pool.query(`INSERT INTO user_blocks (blocker_id, blocked_user_id) VALUES ($1, $2)`, [ada.id, evan.id]);
    const rows = await ring(market.id, marketSession, 'prices, @ada');
    assert.deepEqual(rows.map((r) => r.user_id), []);
    await pool.query(`DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_user_id = $2`, [ada.id, evan.id]);
  });
});
