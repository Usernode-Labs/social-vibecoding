// #6735: the viewer's own leaderboard row reads the points LEDGER, so it no
// longer sits at a stale snapshot figure (often 0) until the standings next
// update.
//
// The new SQL runs against a REAL PostgreSQL here — a throwaway database with
// the committed schema — because the query is the change: the caught-up
// arithmetic has to add up against real NUMERIC columns, real event weights
// and a real DISTINCT ON. The route is served from this database too, so the
// viewer's row and everyone else's are compared end to end.
//
// Skipped when no server is reachable, and required when TEST_DATABASE_URL is
// set, like the other *-postgres tests.
//
// Run with: node --test tests/leaderboard-viewer-points-postgres.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const { Pool } = require('pg');

const { boardScopeEventIds, viewerLedgerTotals } = require('../src/services/topochain/event-standings');
const { LEDGER_AHEAD_SQL } = require('../src/services/topochain/challenge-scorer');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// Two seasons' worth of shapes in one:
//   100  a regular event with an epoch range, weighted 1 (block-style event)
//   101  a POINTS-ONLY event with `offchain_weight: 0` — production's season
//        shape, where the builder enters ledger points at face value
//   102  an internal points-only event: never part of the scope
//   103  the season-type event the board opens on
const SEASON = 900600;
const EVENT_REGULAR = 900601;
const EVENT_POINTS_ONLY = 900602;
const EVENT_INTERNAL = 900603;
const EVENT_SEASON = 900604;
const VIEWER = 'viewer';
const OTHER = 'other';

async function withDatabase(t) {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return null;
  }
  const name = 'leaderboard_points_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  return pool;
}

async function seed(pool) {
  await pool.query(
    'INSERT INTO seasons (id, name, starts_at, ends_at, is_active) VALUES ($1, $2, NOW() - INTERVAL \'10 days\', NOW() + INTERVAL \'10 days\', TRUE)',
    [SEASON, 'Viewer Points Season']
  );
  await pool.query(
    `INSERT INTO season_events (id, name, season_id, type, starts_at, ends_at, scoring_formula,
                                start_epoch, end_epoch, internal, display_leaderboard)
     VALUES
       ($1, 'Weighted Sprint', $5, 'regular', NOW() - INTERVAL '5 days', NOW() + INTERVAL '5 days',
        '{"metrics": [], "offchain_weight": 1}'::jsonb, 1, 3, FALSE, TRUE),
       ($2, 'Points-only Event', $5, 'season', NOW() - INTERVAL '5 days', NOW() + INTERVAL '5 days',
        '{"metrics": [], "offchain_weight": 0}'::jsonb, NULL, NULL, FALSE, TRUE),
       ($3, 'Internal Event', $5, 'season', NOW() - INTERVAL '5 days', NOW() + INTERVAL '5 days',
        '{"metrics": [], "offchain_weight": 0}'::jsonb, NULL, NULL, TRUE, TRUE),
       ($4, 'Season Wrap-up', $5, 'season', NOW() - INTERVAL '5 days', NOW() + INTERVAL '5 days',
        '{"metrics": [], "offchain_weight": 0}'::jsonb, NULL, NULL, FALSE, TRUE)`,
    [EVENT_REGULAR, EVENT_POINTS_ONLY, EVENT_INTERNAL, EVENT_SEASON, SEASON]
  );
  await pool.query(
    `INSERT INTO challenge_templates (id, category, goal, task, reward)
     VALUES (900610, 'bug', 'Report a bug', 'File it.', '250 points')`
  );
  await pool.query(
    `INSERT INTO challenges (id, season_event_id, challenge_template_id, enabled, display_order, completed)
     VALUES (900620, $1, 900610, TRUE, 1, FALSE),
            (900621, $2, 900610, TRUE, 1, FALSE)`,
    [EVENT_REGULAR, EVENT_POINTS_ONLY]
  );
  const { rows: users } = await pool.query(
    `INSERT INTO users (username, password) VALUES ($1, 'x'), ($2, 'x') RETURNING id, username`,
    [VIEWER, OTHER]
  );
  const id = (name) => users.find((u) => u.username === name).id;

  // The viewer: a snapshot of 0 on the weighted event (the reported bug),
  // and 750 credited in the ledger since. 250 of those points sit on the
  // points-only event, whose weight of 0 must not erase them.
  await pool.query(
    `INSERT INTO leaderboard_snapshots (season_event_id, user_id, rank, total_points, extra_points, snapshot_at)
     VALUES ($1, $2, 1, 0, 0, NOW())`,
    [EVENT_REGULAR, id(VIEWER)]
  );
  await pool.query(
    `INSERT INTO user_activities (user_id, season_event_id, activity_type, points, description, activity_at, challenge_id)
     VALUES ($1, $3, 'bug_report', 500, 'Filed a bug', NOW(), 900620),
            ($1, $4, 'bug_report', 250, 'Filed a bug', NOW(), 900621),
            ($2, $3, 'bug_report', 40, 'Other filed a bug', NOW(), 900620)`,
    [id(VIEWER), id(OTHER), EVENT_REGULAR, EVENT_POINTS_ONLY]
  );
  // Somebody else, with a snapshot the ledger agrees with: no correction.
  await pool.query(
    `INSERT INTO leaderboard_snapshots (season_event_id, user_id, rank, total_points, extra_points, snapshot_at)
     VALUES ($1, $2, 2, 300, 40, NOW())`,
    [EVENT_REGULAR, id(OTHER)]
  );
  return id;
}

async function serve(pool, userId) {
  const poolModule = require('../src/db/pool');
  const original = poolModule.getPool;
  poolModule.getPool = () => pool;
  let router;
  try {
    for (const file of ['../src/routes/topochain/public', '../src/middleware/topochain-auth']) {
      delete require.cache[require.resolve(file)];
    }
    router = require('../src/routes/topochain/public').topochainPublicRoutes({ sessionSecret: 'postgres-test-secret' });
  } finally {
    poolModule.getPool = original;
  }
  const app = express();
  app.use((req, _res, next) => { req.user = { id: userId, username: 'member', isAdmin: false }; next(); });
  app.use(router);
  const server = await new Promise((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('the ledger totals an event at the snapshot builder\'s own weight, on a real database', async (t) => {
  const pool = await withDatabase(t);
  if (!pool) return;
  const ids = await seed(pool);

  const scope = await boardScopeEventIds(pool, { id: EVENT_SEASON, type: 'season', season_id: SEASON });
  assert.deepEqual(scope, [EVENT_REGULAR, EVENT_POINTS_ONLY, EVENT_SEASON],
    'every non-internal event of the season; the internal one is not in scope');

  const totals = await viewerLedgerTotals(pool, { userId: ids(VIEWER), eventIds: scope });
  assert.equal(totals.get(EVENT_REGULAR), 500, 'weighted 1: the ledger at the event\'s own weight');
  assert.equal(totals.get(EVENT_POINTS_ONLY), 250,
    'the points-only event enters at face value: `offchain_weight: 0` must not erase the points');
  assert.equal(totals.get(EVENT_SEASON), 0);

  const regular = await boardScopeEventIds(pool, { id: EVENT_REGULAR, type: 'regular' });
  assert.deepEqual(regular, [EVENT_REGULAR], 'a regular board covers its own event');
});

test('the scorer\'s ledger-ahead check reads the snapshot, and is idle when the two agree', async (t) => {
  const pool = await withDatabase(t);
  if (!pool) return;
  const ids = await seed(pool);

  const ahead = async () => (await pool.query(LEDGER_AHEAD_SQL)).rows[0].ahead;
  assert.equal(await ahead(), true, 'the viewer\'s ledger is ahead of the 0 snapshot');

  // Bring both snapshots up to what their ledgers hold: nothing is ahead.
  await pool.query(
    'UPDATE leaderboard_snapshots SET extra_points = 500, total_points = 500 WHERE season_event_id = $1 AND user_id = $2',
    [EVENT_REGULAR, ids(VIEWER)]
  );
  await pool.query(
    `INSERT INTO leaderboard_snapshots (season_event_id, user_id, rank, total_points, extra_points, snapshot_at)
     VALUES ($1, $2, 1, 250, 250, NOW())`,
    [EVENT_POINTS_ONLY, ids(VIEWER)]
  );
  await pool.query(
    `INSERT INTO leaderboard_snapshots (season_event_id, user_id, rank, total_points, extra_points, snapshot_at)
     VALUES ($1, $2, 2, 40, 40, NOW())`,
    [EVENT_REGULAR, ids(OTHER)]
  );
  assert.equal(await ahead(), false, 'the snapshots count every credit: no rebuild');
});

test('GET /leaderboard catches the viewer\'s row up to the ledger, and changes nobody else\'s', async (t) => {
  const pool = await withDatabase(t);
  if (!pool) return;
  const ids = await seed(pool);
  const server = await serve(pool, ids(VIEWER));
  try {
    const body = await (await fetch(`${server.origin}/api/v4/leaderboard?season_event_id=${EVENT_REGULAR}`)).json();
    assert.equal(body.data.viewer_row.total_points, 500, 'the ledger, not the 0 snapshot');
    assert.equal(body.data.viewer_row.pending_points, 500);
    assert.equal(body.data.viewer_row.rank, 1, 'the rank is the standings\'');
    assert.equal(body.data.leaderboard.find((r) => r.is_viewer).total_points, 500);

    const other = body.data.leaderboard.find((r) => !r.is_viewer);
    assert.equal(other.total_points, 300, 'nobody else\'s figure is touched');
    assert.equal('pending_points' in other, false);
  } finally {
    await server.close();
  }
});
