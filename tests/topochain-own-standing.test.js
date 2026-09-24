'use strict';

// computeOwnStanding (services/topochain/standings.js, #2777) is the one-row
// answer /me/ranking uses instead of computeStandings(...).find(). It is a
// second copy of the §4.10 aggregate, so this suite holds it to the first on
// a real Postgres: for every user and every scope — ties on points, podium-
// excluded users (true and NULL), several snapshots per (user, event) with the
// latest not the highest, internal events, a user with no row — the rank,
// points, extra points, events, blocks and participant count must be exactly
// what computeStandings() produced.
//
// Mock pools cannot say anything about SQL semantics, which is the whole risk
// here. TEST_DATABASE_URL selects a local test database, like the other
// *-postgres tests; the suite skips when none is reachable.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Client, Pool } = require('pg');

const { computeStandings, computeOwnStanding } = require('../src/services/topochain/standings');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';

// Only the columns the two queries read. leaderboard_snapshots keeps the
// production UNIQUE (season_event_id, user_id, snapshot_at): the one-row query
// relies on it to make MAX(snapshot_at) name exactly one snapshot.
const DDL = `
  CREATE TABLE users (
    id BIGINT PRIMARY KEY,
    exclude_podium BOOLEAN,
    email TEXT, telegram TEXT, discord TEXT, display_name TEXT, username TEXT
  );
  CREATE TABLE season_events (
    id BIGINT PRIMARY KEY,
    season_id BIGINT NOT NULL,
    internal BOOLEAN NOT NULL DEFAULT FALSE,
    starts_at TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE leaderboard_snapshots (
    id BIGSERIAL PRIMARY KEY,
    season_event_id BIGINT NOT NULL REFERENCES season_events(id),
    user_id BIGINT NOT NULL REFERENCES users(id),
    total_points NUMERIC(15,2) NOT NULL DEFAULT 0,
    extra_points NUMERIC(15,2) NOT NULL DEFAULT 0,
    event_total_produced_blocks BIGINT NOT NULL DEFAULT 0,
    snapshot_at TIMESTAMPTZ NOT NULL,
    UNIQUE (season_event_id, user_id, snapshot_at)
  );
`;

// A small deterministic PRNG so a failure reproduces.
function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

async function seed(pool) {
  const rand = rng(2777);
  const users = [];
  for (let id = 1; id <= 60; id += 1) {
    // Every seventh user is podium-excluded, every eleventh has NULL.
    const exclude = id % 7 === 0 ? true : id % 11 === 0 ? null : false;
    users.push(`(${id}, ${exclude === null ? 'NULL' : exclude}, 'u${id}')`);
  }
  // User 61 exists but never appears in a snapshot.
  users.push('(61, FALSE, \'u61\')');
  await pool.query(`INSERT INTO users (id, exclude_podium, username) VALUES ${users.join(',')}`);

  const events = [
    [1, 1, false], [2, 1, false], [3, 1, true], // season 1, one internal
    [4, 2, false], [5, 2, false],               // season 2
    [6, 3, true],                               // season 3: internal only
  ];
  await pool.query(
    `INSERT INTO season_events (id, season_id, internal, starts_at)
     VALUES ${events.map(([id, s, internal]) => `(${id}, ${s}, ${internal}, NOW() - INTERVAL '${id} days')`).join(',')}`,
  );

  const rows = [];
  for (const [eventId] of events) {
    for (let user = 1; user <= 60; user += 1) {
      if (rand() < 0.3) continue; // not everyone takes part in every event
      const snapshots = 1 + Math.floor(rand() * 4);
      for (let k = 0; k < snapshots; k += 1) {
        // Points drawn from a handful of values so ties are common, and the
        // LATEST snapshot is not necessarily the largest.
        const points = [0, 10, 25, 25, 40, 100][Math.floor(rand() * 6)];
        const extra = Math.floor(rand() * 5);
        const blocks = Math.floor(rand() * 9);
        rows.push(`(${eventId}, ${user}, ${points}, ${extra}, ${blocks}, NOW() - INTERVAL '${k} hours')`);
      }
    }
  }
  await pool.query(
    `INSERT INTO leaderboard_snapshots
       (season_event_id, user_id, total_points, extra_points, event_total_produced_blocks, snapshot_at)
     VALUES ${rows.join(',')}`,
  );
}

test('computeOwnStanding matches computeStandings for every user and scope', async (t) => {
  const admin = new Client({ connectionString: DSN });
  try {
    await admin.connect();
  } catch (error) {
    await admin.end().catch(() => {});
    return t.skip(`no postgres reachable at ${DSN}: ${error.message || error.code || error}`);
  }
  const schema = `own_standing_${process.pid}_${Date.now()}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: DSN, options: `-c search_path=${schema}`, max: 4 });
  try {
    await pool.query(DDL);
    await seed(pool);

    for (const seasonId of [null, 1, 2, 3]) {
      const standings = await computeStandings(pool, { seasonId });
      if (seasonId === 1 || seasonId === null) {
        assert.ok(standings.some((s) => s.is_non_podium), 'the fixture exercises podium exclusion');
        const byPoints = new Map();
        for (const s of standings) byPoints.set(s.total_points, (byPoints.get(s.total_points) || 0) + 1);
        assert.ok([...byPoints.values()].some((n) => n > 1), 'the fixture exercises ties');
      }
      for (let userId = 1; userId <= 61; userId += 1) {
        const { own, totalParticipants } = await computeOwnStanding(pool, { seasonId, userId });
        const expected = standings.find((s) => s.user_id === userId) || null;
        const label = `season ${seasonId}, user ${userId}`;
        assert.equal(totalParticipants, standings.length, `${label}: participants`);
        if (!expected) {
          assert.equal(own, null, `${label}: no row`);
          continue;
        }
        assert.deepEqual(own, {
          user_id: expected.user_id,
          rank: expected.rank,
          total_points: expected.total_points,
          extra_points: expected.extra_points,
          events_participated: expected.events_participated,
          total_produced_blocks: expected.total_produced_blocks,
        }, label);
      }
    }
  } finally {
    await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
});
