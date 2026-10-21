'use strict';

// The made screen's moments (newcomer run five, 13 October 2026) through the
// real route, POST /api/apps/:slug/first-version/moments, against the real
// schema: a member's moment is one `events` row ('first_session_moment')
// for them and the project, with the browser's clock and the server's; a
// test account's is kept too (the newcomer runs are theirs), and the admin
// Journey still counts nobody from it; anyone else gets a 404 (never the
// 403 that offers Join), a malformed moment a 400, the signed out a 401, a
// page on another origin a 403, and a client in a loop a 429.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/first-session-moments-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// The apps router's infrastructure is not what this is about.
stub(require.resolve('../src/services/ws'), new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : () => 1) }));
stub(require.resolve('../src/services/mobile-push'), { scheduleBadgeSync() { return false; } });
stub(require.resolve('../src/services/app-creator'), { createApp: async () => {} });
stub(require.resolve('../src/services/app-forker'), { forkApp: async () => {} });
stub(require.resolve('../src/services/caddy'), { productionHostname: (slug) => `${slug}.example.test`, USERNODE_DOMAIN: 'example.test' });
stub(require.resolve('../src/services/docker'), { getHostPort: async () => null });
stub(require.resolve('../src/services/github'), { parseGithubUrl: () => null, isEnabled: () => false });
stub(require.resolve('../src/services/main-drift-poller'), { checkAndRedeployOne: async () => ({}) });
stub(require.resolve('../src/services/app-secrets'), {});
stub(require.resolve('../src/services/rename-pr'), {});
stub(require.resolve('../src/services/staging'), { rebuildProduction: async () => ({}), MissingSecretsError: class extends Error {} });

let pool = null;
require('../src/db/pool').getPool = () => pool;

const { appRoutes } = require('../src/routes/apps');

test('the made screen\'s moments are kept for its maker, test accounts included, and refused for anyone else', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `fs_moments_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const user = async (username, { test: testAccount = false } = {}) => (await pool.query(
    // Each switched "Share usage analytics" on (#5097); the last test below
    // switches it off again.
    `INSERT INTO users (username, password, has_platform_access, test_account_created_at, usage_analytics)
     VALUES ($1, 'x', TRUE, CASE WHEN $2 THEN NOW() END, TRUE) RETURNING id, username`,
    [username, testAccount],
  )).rows[0];
  const alex = await user('alex_t1013', { test: true });
  const sam = await user('sam_t1013');
  const busy = await user('busy_t1013');
  const service = await user('usernode-capture-admin');
  const { rows: [inserted] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Club Votes', 'club-votes', 'running', $1, 'private', 'private') RETURNING id`,
    [alex.id],
  );
  const app = (await pool.query('SELECT id, slug, community_id FROM apps WHERE id = $1', [inserted.id])).rows[0];
  for (const m of [alex, busy, service]) {
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, m.id]);
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [app.id, m.id]);
  }

  let viewer = alex;
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => { if (viewer) req.user = { id: viewer.id, username: viewer.username }; next(); });
  server.use(appRoutes({}));
  const listening = server.listen(0);
  await new Promise((resolve) => listening.once('listening', resolve));
  t.after(() => {
    if (typeof listening.closeAllConnections === 'function') listening.closeAllConnections();
    listening.close();
  });
  const post = (body, { slug = app.slug, headers = {} } = {}) => fetch(
    `http://127.0.0.1:${listening.address().port}/api/apps/${slug}/first-version/moments`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) },
  );
  const moments = async () => (await pool.query(
    `SELECT user_id, app_id, created_at, metadata FROM events WHERE event_type = 'first_session_moment' ORDER BY id`,
  )).rows;

  await t.test('its maker\'s moments, a test account\'s, each with both clocks', async () => {
    const clientAt = new Date(Date.now() - 4000).toISOString();
    let res = await post({ kind: 'questions_shown', clientAt, count: 2 });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, recorded: true });
    res = await post({ kind: 'tour_ended', clientAt, step: 4, steps: 9, how: 'skipped' });
    assert.equal(res.status, 200);
    const rows = await moments();
    assert.equal(rows.length, 2);
    const [first, second] = rows;
    assert.deepEqual([first.user_id, first.app_id], [alex.id, app.id]);
    assert.equal(first.metadata.kind, 'questions_shown');
    assert.equal(first.metadata.count, 2);
    assert.equal(first.metadata.clientAt, clientAt, 'the browser\'s clock');
    assert.equal(new Date(first.metadata.receivedAt).getTime(), new Date(first.created_at).getTime(), 'and the server\'s, the row\'s own time');
    assert.ok(new Date(first.metadata.receivedAt).getTime() >= new Date(clientAt).getTime());
    assert.deepEqual({ ...second.metadata, clientAt: null, receivedAt: null },
      { kind: 'tour_ended', step: 4, steps: 9, how: 'skipped', clientAt: null, receivedAt: null });
  });

  await t.test('a test account is fenced from the Journey all the same', async () => {
    const src = fs.readFileSync(require.resolve('../src/services/journey.js'), 'utf8');
    const journey = require('../src/services/journey');
    const counts = (src.match(/'first_session_moment'/g) || []).length;
    const readers = [journey.MADE_SCREEN_SQL, journey.PERSON_MOMENTS_SQL, journey.FIRST_SESSION_RECORDED_SQL]
      .reduce((n, sql) => n + (sql.match(/'first_session_moment'/g) || []).length, 0);
    assert.equal(counts, readers, 'the Journey reads these rows only in its made-screen reading, one person\'s view and the date they began');
    assert.match(journey.MADE_SCREEN_SQL, /AND u\.test_account_created_at IS NULL/, 'and the people it counts are never test accounts');
    assert.match(journey.MADE_SCREEN_SQL, /e\.user_id IN \(SELECT r\.id FROM real r\)/);
  });

  await t.test('nobody else, nothing malformed, and never from another page', async () => {
    const before = (await moments()).length;
    const clientAt = new Date().toISOString();
    viewer = sam;
    let res = await post({ kind: 'made_shown', clientAt });
    assert.equal(res.status, 404, 'not a member: no Join offered, and nothing said about the project');
    viewer = null;
    res = await post({ kind: 'made_shown', clientAt });
    assert.equal(res.status, 401);
    viewer = alex;
    res = await post({ kind: 'made_shown', clientAt }, { slug: 'no-such-project' });
    assert.equal(res.status, 404);
    for (const body of [
      { kind: 'made_up', clientAt },
      { kind: 'made_shown' },
      { kind: 'made_shown', clientAt: 'yesterday' },
      { kind: 'made_shown', clientAt: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString() },
      { kind: 'tour_step_shown', clientAt, step: 0 },
      { kind: 'tour_step_shown', clientAt, step: '2' },
      { kind: 'invite_sent', clientAt, how: 'texted' },
      { kind: 'made_shown', clientAt, entry: 'somewhere' },
    ]) {
      res = await post(body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    res = await post({ kind: 'made_shown', clientAt }, { headers: { 'Sec-Fetch-Site': 'same-site' } });
    assert.equal(res.status, 403, 'a child app\'s page cannot write them');
    // Unknown fields are not kept.
    res = await post({ kind: 'made_shown', clientAt, entry: 'first_session', note: 'what somebody typed' });
    assert.equal(res.status, 200);
    const rows = await moments();
    assert.equal(rows.length, before + 1);
    assert.equal(JSON.stringify(rows[rows.length - 1].metadata).includes('somebody typed'), false);
  });

  await t.test('a platform service account is answered, never recorded', async () => {
    const before = (await moments()).length;
    viewer = service;
    const res = await post({ kind: 'made_shown', clientAt: new Date().toISOString() });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, recorded: false });
    assert.equal((await moments()).length, before);
    viewer = alex;
  });

  await t.test('somebody who switched usage analytics off is answered, never recorded (#5097)', async () => {
    const before = (await moments()).length;
    await pool.query('UPDATE users SET usage_analytics = FALSE WHERE id = $1', [alex.id]);
    try {
      const res = await post({ kind: 'made_shown', clientAt: new Date().toISOString() });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, recorded: false });
      assert.equal((await moments()).length, before);
    } finally {
      await pool.query('UPDATE users SET usage_analytics = TRUE WHERE id = $1', [alex.id]);
    }
  });

  await t.test('a client in a loop is held at 60 a minute, and its refused requests cost nothing', async () => {
    viewer = busy;
    const clientAt = new Date().toISOString();
    for (let i = 0; i < 5; i += 1) assert.equal((await post({ kind: 'made_up', clientAt })).status, 400);
    for (let i = 0; i < 60; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      assert.equal((await post({ kind: 'tour_step_shown', clientAt, step: 1 + (i % 9), steps: 9 })).status, 200, `moment ${i + 1}`);
    }
    const res = await post({ kind: 'tour_step_shown', clientAt, step: 1, steps: 9 });
    assert.equal(res.status, 429);
    viewer = alex;
  });
});
