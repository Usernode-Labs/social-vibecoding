'use strict';
// test:changed: when public/js/app-view.js (the client's "waits on your vote" predicate, run over the route's rows)
// test:changed: when src/services/work-state.js (work_states.vote_open, which the row and the feed both read)

// A project's "Needs you" count and its Needs you page agree, against the
// REAL schema in a throwaway PostgreSQL database.
//
// The count is worked out in the browser from GET /api/apps/:slug/promoted
// (AppView._devCardMatches, needsVote); the page lists what
// GET /api/workshop/needs-feed returns. A change whose checks were still
// running was counted and not listed, so a project said "1" beside Needs you
// while its Needs you page said nothing was waiting.
//
// What this pins, through the real route, the real feed query and the real
// client predicate over the route's own rows:
//   1. while a change is still being checked, the board's row is there with
//      vote_open false, the predicate does not count it, and the feed does
//      not list it;
//   2. once its checks pass, all three say it waits on the viewer;
//   3. once the viewer has voted, none does.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/needs-count-vote-open-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { loadAppView } = require('./lib/app-view-vm');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the count a project works out from /promoted is the Needs you feed\'s list', { timeout: 180000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `needs_count_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  const cleanup = [];
  t.after(async () => {
    for (const step of cleanup) await step();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  require('../src/db/pool').getPool = () => pool;
  const overview = require('../src/routes/workshop-overview');
  const ws = require('../src/services/work-state');

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const user = (username) => one(
    `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`,
    [username]);
  const ada = await user('nc_ada');
  const bob = await user('nc_bob');
  const cat = await user('nc_cat');
  const app = await one(
    `INSERT INTO apps (name, slug, view_visibility, collab_visibility, created_by)
     VALUES ('Count and page', 'nc-count', 'public', 'public', $1) RETURNING id, slug`, [ada.id]);
  for (const u of [ada, bob, cat]) {
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`, [app.id, u.id]);
  }
  const change = async (pr, checkState, checkPhase = null) => one(
    `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues, pr_number, pr_title, check_state,
                                check_phase, integration_merges_clean, promoted_at)
     VALUES ($1, $2, 'promoted', '{}'::int[], $3, $4, $5, $6, TRUE, NOW()) RETURNING id`,
    [app.id, bob.id, pr, `Change ${pr}`, checkState, checkPhase]);

  // The viewer's board, through the real route, as the browser reads it.
  const express = require('express');
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    req.user = { id: ada.id, username: ada.username, isAdmin: false, hasPlatformAccess: true };
    next();
  });
  server.use(require('../src/routes/votes').voteRoutes({ databaseUrl: String(url) }));
  const listener = await new Promise((resolve) => {
    const l = server.listen(0, '127.0.0.1', () => resolve(l));
  });
  cleanup.push(() => new Promise((resolve) => listener.close(resolve)));
  const base = `http://127.0.0.1:${listener.address().port}`;

  // Whether a change is open for votes is its stored work state, derived
  // again from what the triggers mark (services/work-state.js drainDirty).
  const settle = async () => { while ((await ws.drainDirty(pool)).taken) { /* until none is left */ } };
  const AppView = loadAppView();
  const ids = (list) => list.map(Number).sort((a, b) => a - b);
  const everywhere = async () => {
    await settle();
    const res = await fetch(`${base}/api/apps/${app.slug}/promoted?results=failing`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    assert.equal(res.status, 200);
    const rows = (await res.json()).promoted;
    const feed = (await pool.query(overview.NEEDS_FEED_SQL, [ada.id, false, false, overview.NEEDS_FEED_MAX])).rows
      .filter((r) => Number(r.app_id) === Number(app.id) && r.kind === 'proposal');
    const counts = (await pool.query(overview.COUNTS_SQL, [ada.id, false, false])).rows.find((r) => r.slug === app.slug);
    return {
      // Every change the board lists, whatever its vote.
      board: ids(rows.map((r) => r.id)),
      open: Object.fromEntries(rows.map((r) => [Number(r.id), r.vote_open])),
      // The project's own count: the rows the client says wait on your vote.
      counted: ids(rows.filter((r) => AppView._devCardMatches('proposal', r, { needsVote: true })).map((r) => r.id)),
      // Its Needs you page: the feed, narrowed to the project.
      page: ids(feed.map((r) => r.id)),
      // And the number every other screen shows for it.
      needs: counts ? Number(counts.needs) : 0,
    };
  };

  const ready = await change(20, 'passing');
  const checking = await change(21, 'pending', 'testing');

  await t.test('still being checked: on the board, not counted, not on the page', async () => {
    const now = await everywhere();
    assert.deepEqual(now.board, ids([ready.id, checking.id]), 'the board lists both, each with its own status');
    assert.deepEqual(now.open, { [ready.id]: true, [checking.id]: false });
    assert.deepEqual(now.page, [Number(ready.id)]);
    assert.deepEqual(now.counted, now.page, 'the count is the page\'s list');
    assert.equal(now.needs, now.counted.length, 'and the number every other screen shows');
  });

  await t.test('its checks pass: counted and on the page together', async () => {
    await pool.query(`UPDATE chat_sessions SET check_state = 'passing', check_phase = NULL WHERE id = $1`, [checking.id]);
    const now = await everywhere();
    assert.deepEqual(now.open, { [ready.id]: true, [checking.id]: true });
    assert.deepEqual(now.page, ids([ready.id, checking.id]));
    assert.deepEqual(now.counted, now.page);
    assert.equal(now.needs, 2);
  });

  await t.test('voted on: gone from both', async () => {
    await pool.query(
      `INSERT INTO pr_votes (session_id, user_id, vote, approval_epoch)
       SELECT id, $2, 'no', approval_epoch FROM chat_sessions WHERE id = $1`, [ready.id, ada.id]);
    const now = await everywhere();
    assert.deepEqual(now.board, ids([ready.id, checking.id]), 'still on the board');
    assert.deepEqual(now.page, [Number(checking.id)]);
    assert.deepEqual(now.counted, now.page);
    assert.equal(now.needs, 1);
  });
});
