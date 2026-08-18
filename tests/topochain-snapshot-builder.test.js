// Topochain snapshot builder — the DB-facing orchestration
// (src/services/topochain/snapshot-builder.js) and its admin trigger
// (POST /api/v4/admin/leaderboard/aggregate).
//
// Same "fake Postgres" idiom as tests/topochain-admin-api2.test.js:
// tables as plain arrays, one substring-dispatching query handler, no
// live DB. The INSERT dispatch maps positional params through the
// builder's own exported SNAPSHOT_COLUMNS so these tests never encode
// parameter positions of their own.
//
// Run with: node --test tests/topochain-snapshot-builder.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// Install the pool wrapper BEFORE requiring any route module (same
// require.cache indirection as the admin API test files).
const poolMod = require('../src/db/pool');
let currentMockPool = null;
poolMod.getPool = () => currentMockPool;

const { buildSnapshots, SNAPSHOT_COLUMNS } = require('../src/services/topochain/snapshot-builder');
const { leaderboardAdminRoutes } = require('../src/routes/topochain/admin/leaderboard');
const { topochainAdminRoutes } = require('../src/routes/topochain/admin');
const { topochainPublicRoutes } = require('../src/routes/topochain/public');

// ─── Fixtures ────────────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const T = (offsetDays) => new Date(NOW + offsetDays * DAY);
const T0 = NOW - 10 * DAY; // wall-clock anchor for slot timing fixtures

let db;

function freshDb() {
  return {
    seasons: [
      { id: 10, name: 'Season Ten', is_active: true },
      { id: 11, name: 'Season Eleven (closed)', is_active: false },
    ],
    seasonEvents: [
      {
        id: 100, name: 'Sprint One', season_id: 10, type: 'regular', is_active: true, internal: false,
        starts_at: T(-10), ends_at: T(10), start_epoch: 1, end_epoch: 4, chain_id: 'chain-1',
        scoring_formula: { metrics: [], offchain_weight: 1, produce_every_block_points: 5000 },
        disclaimer: null, display_leaderboard: true,
      },
      {
        id: 101, name: 'Paused Sprint', season_id: 10, type: 'regular', is_active: false, internal: false,
        starts_at: T(-10), ends_at: T(10), start_epoch: 1, end_epoch: 4, chain_id: 'chain-1',
        scoring_formula: { metrics: [], offchain_weight: 1 },
        disclaimer: null, display_leaderboard: true,
      },
      {
        id: 102, name: 'No Epoch Range', season_id: 10, type: 'regular', is_active: true, internal: false,
        starts_at: T(-10), ends_at: T(10), start_epoch: null, end_epoch: null, chain_id: 'chain-1',
        scoring_formula: { metrics: [], offchain_weight: 1 },
        disclaimer: null, display_leaderboard: true,
      },
      {
        id: 103, name: 'Season Standings', season_id: 10, type: 'season', is_active: true, internal: false,
        starts_at: T(-10), ends_at: T(10), start_epoch: null, end_epoch: null, chain_id: null,
        scoring_formula: { metrics: [], offchain_weight: 1 },
        disclaimer: null, display_leaderboard: true,
      },
      {
        id: 104, name: 'Closed Season Sprint', season_id: 11, type: 'regular', is_active: true, internal: false,
        starts_at: T(-10), ends_at: T(10), start_epoch: 1, end_epoch: 4, chain_id: 'chain-1',
        scoring_formula: { metrics: [], offchain_weight: 1 },
        disclaimer: null, display_leaderboard: true,
      },
      {
        // A fat-fingered end_epoch: iterating this range would wedge the
        // process, so the builder must refuse it outright.
        id: 105, name: 'Typo Epoch Range', season_id: 10, type: 'regular', is_active: true, internal: false,
        starts_at: T(-10), ends_at: T(10), start_epoch: 1, end_epoch: 1_000_000_000, chain_id: 'chain-1',
        scoring_formula: { metrics: [], offchain_weight: 1 },
        disclaimer: null, display_leaderboard: true,
      },
      {
        // season_id is nullable in the schema — the event must still be
        // addressable explicitly (LEFT JOIN), guarded like an inactive
        // season rather than 422ing as an unknown id.
        id: 106, name: 'Season-less Sprint', season_id: null, type: 'regular', is_active: true, internal: false,
        starts_at: T(-10), ends_at: T(10), start_epoch: 1, end_epoch: 4, chain_id: 'chain-1',
        scoring_formula: { metrics: [], offchain_weight: 1 },
        disclaimer: null, display_leaderboard: true,
      },
    ],
    challengeTemplates: [
      { id: 900, goal: 'Produce every block', metric_type: 'blocks_produced', schedule_start: null, schedule_end: null },
      { id: 901, goal: 'Report a bug', metric_type: null, schedule_start: null, schedule_end: null },
    ],
    challenges: [
      { id: 500, season_event_id: 100, challenge_template_id: 900, enabled: true, goal: null, metric_type: null, schedule_start: null, schedule_end: null },
      { id: 501, season_event_id: 100, challenge_template_id: 901, enabled: true, goal: null, metric_type: null, schedule_start: null, schedule_end: null },
      // Disabled block challenge — must never score.
      { id: 502, season_event_id: 100, challenge_template_id: 900, enabled: false, goal: null, metric_type: null, schedule_start: null, schedule_end: null },
    ],
    users: [
      { id: 1, email: 'alice@example.com', telegram: null, discord: null, display_name: null, exclude_podium: true },
      { id: 2, email: 'bob@example.com', telegram: null, discord: null, display_name: null, exclude_podium: false },
      { id: 3, email: 'carol@example.com', telegram: null, discord: null, display_name: null, exclude_podium: false },
      { id: 4, email: 'dave@example.com', telegram: null, discord: null, display_name: null, exclude_podium: false },
    ],
    epochStats: [
      // alice: full production in epochs 1-2 → rate 50% → 2500 points
      { chain_id: 'chain-1', wallet_address: 'addr-alice', user_id: 1, epoch: 1, epoch_won_slots: 2, epoch_produced_blocks: 2 },
      { chain_id: 'chain-1', wallet_address: 'addr-alice', user_id: 1, epoch: 2, epoch_won_slots: 3, epoch_produced_blocks: 3 },
      // bob: the golden vector — 0.8, 1.0, nothing after → 45% → 2250
      { chain_id: 'chain-1', wallet_address: 'addr-bob', user_id: 2, epoch: 1, epoch_won_slots: 5, epoch_produced_blocks: 4 },
      { chain_id: 'chain-1', wallet_address: 'addr-bob', user_id: 2, epoch: 2, epoch_won_slots: 4, epoch_produced_blocks: 4 },
      // beyond end_epoch (hard cap) — must never count
      { chain_id: 'chain-1', wallet_address: 'addr-bob', user_id: 2, epoch: 5, epoch_won_slots: 10, epoch_produced_blocks: 10 },
      // wrong chain — must never count
      { chain_id: 'chain-2', wallet_address: 'addr-bob', user_id: 2, epoch: 1, epoch_won_slots: 9, epoch_produced_blocks: 0 },
      // carol: one perfect epoch → 25% → 1250
      { chain_id: 'chain-1', wallet_address: 'addr-carol', user_id: 3, epoch: 1, epoch_won_slots: 10, epoch_produced_blocks: 10 },
      // unattributed wallet — must never count
      { chain_id: 'chain-1', wallet_address: 'addr-ghost', user_id: null, epoch: 1, epoch_won_slots: 5, epoch_produced_blocks: 5 },
    ],
    slotOutcomeReports: [],
    userActivities: [
      { user_id: 2, season_event_id: 100, activity_type: 'bug_report', points: 100 },
      { user_id: 4, season_event_id: 100, activity_type: 'top_3', points: 500 },
      // different event — must never count toward event 100
      { user_id: 3, season_event_id: 102, activity_type: 'bug_report', points: 999 },
    ],
    onchainAccounts: [
      { id: 1, user_id: 2, season_event_id: null, season_id: 10, address: 'addr-bob', public_key: 'pk-bob' },
      { id: 2, user_id: 1, season_event_id: null, season_id: 10, address: 'addr-alice', public_key: 'pk-alice' },
    ],
    accountDelegationPeriods: [],
    leaderboardSnapshots: [],
    nextSnapshotId: 1,
  };
}

const collapse = (sql) => sql.replace(/\s+/g, ' ').trim();

const effective = (challenge, template, field) => (challenge[field] !== null && challenge[field] !== undefined
  ? challenge[field] : template[field]);

function handleQuery(rawSql, params = []) {
  const sql = collapse(rawSql);

  if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };

  // Builder: candidate events (season joined for the activity guard).
  if (sql.includes('AS season_is_active')) {
    const id = params[0] ?? null;
    const rows = db.seasonEvents
      .filter((e) => (id === null
        ? e.type === 'regular' && e.is_active && db.seasons.find((s) => s.id === e.season_id)?.is_active
        : e.id === id))
      .sort((a, b) => a.id - b.id)
      // BIGSERIAL columns come back from pg as strings — emulate that so
      // the builder's normalization is what these tests exercise.
      .map((e) => ({
        ...e,
        id: String(e.id),
        season_id: e.season_id === null ? null : String(e.season_id),
        season_is_active: !!db.seasons.find((s) => s.id === e.season_id)?.is_active,
      }));
    return { rows };
  }

  // Builder: enabled block-production challenges with effective fields.
  if (sql.includes("'blocks_produced'")) {
    const eventId = params[0];
    const rows = db.challenges
      .filter((c) => c.season_event_id === eventId && c.enabled)
      .map((c) => ({ c, t: db.challengeTemplates.find((t) => t.id === c.challenge_template_id) }))
      .filter(({ c, t }) => effective(c, t, 'metric_type') === 'blocks_produced')
      .sort((a, b) => a.c.id - b.c.id)
      .map(({ c, t }) => ({
        id: c.id,
        goal: effective(c, t, 'goal'),
        schedule_start: effective(c, t, 'schedule_start'),
        schedule_end: effective(c, t, 'schedule_end'),
      }));
    return { rows };
  }

  // Builder: per-(user, epoch) canonical tallies.
  if (sql.includes('SUM(epoch_won_slots)')) {
    const [chains, startEpoch, endEpoch] = params;
    const byKey = new Map();
    for (const r of db.epochStats) {
      if (!chains.includes(r.chain_id) || r.user_id === null) continue;
      if (r.epoch < startEpoch || r.epoch > endEpoch) continue;
      const key = `${r.user_id}:${r.epoch}`;
      const acc = byKey.get(key) || { user_id: r.user_id, epoch: r.epoch, won_slots: 0, produced_blocks: 0 };
      acc.won_slots += r.epoch_won_slots;
      acc.produced_blocks += r.epoch_produced_blocks;
      byKey.set(key, acc);
    }
    return { rows: [...byKey.values()] };
  }

  // Builder: epoch timing from slot outcome telemetry.
  if (sql.includes('MIN(slot_time_ms)')) {
    const [chains, startEpoch, endEpoch] = params;
    const byEpoch = new Map();
    for (const r of db.slotOutcomeReports) {
      if (!chains.includes(r.chain_id) || r.slot_time_ms == null || r.epoch == null) continue;
      if (r.epoch < startEpoch || r.epoch > endEpoch) continue;
      const prev = byEpoch.get(r.epoch);
      if (prev === undefined || r.slot_time_ms < prev) byEpoch.set(r.epoch, r.slot_time_ms);
    }
    return { rows: [...byEpoch.entries()].map(([epoch, ms]) => ({ epoch, first_slot_time_ms: String(ms) })) };
  }

  // Builder + refresh-totals: the per-type ledger sums.
  if (sql.includes('GROUP BY user_id, activity_type')) {
    const eventId = params[0];
    const byKey = new Map();
    for (const a of db.userActivities) {
      if (a.season_event_id !== eventId) continue;
      const key = `${a.user_id}:${a.activity_type}`;
      byKey.set(key, (byKey.get(key) || 0) + a.points);
    }
    return {
      rows: [...byKey.entries()].map(([key, total]) => {
        const [userId, type] = key.split(':');
        return { user_id: Number(userId), activity_type: type, total_points: String(total) };
      }),
    };
  }

  // Builder: podium flags.
  if (sql.includes('SELECT id, exclude_podium FROM users')) {
    const ids = params[0];
    return { rows: db.users.filter((u) => ids.includes(u.id)).map((u) => ({ id: u.id, exclude_podium: u.exclude_podium })) };
  }

  // Builder: delegation periods via the users' accounts in scope.
  if (sql.includes('JOIN account_delegation_periods')) {
    const [userIds, eventId, seasonId] = params;
    const rows = [];
    for (const oa of db.onchainAccounts) {
      if (!userIds.includes(oa.user_id)) continue;
      if (!(oa.season_event_id === eventId || (oa.season_event_id == null && oa.season_id === seasonId))) continue;
      for (const p of db.accountDelegationPeriods) {
        if (p.account !== oa.address) continue;
        rows.push({ user_id: oa.user_id, started_at: p.started_at, ended_at: p.ended_at });
      }
    }
    return { rows };
  }

  // Builder: the snapshot upsert.
  if (sql.startsWith('INSERT INTO leaderboard_snapshots')) {
    const row = Object.fromEntries(SNAPSHOT_COLUMNS.map((c, i) => [c, params[i]]));
    const existing = db.leaderboardSnapshots.find((s) => s.season_event_id === row.season_event_id
      && s.user_id === row.user_id && String(s.snapshot_at) === String(row.snapshot_at));
    if (existing) {
      Object.assign(existing, row);
    } else {
      db.leaderboardSnapshots.push({ id: db.nextSnapshotId++, ...row });
    }
    return { rows: [] };
  }

  // Builder: prune to the newest 10 snapshot_at values per event.
  if (sql.startsWith('DELETE FROM leaderboard_snapshots')) {
    const eventId = params[0];
    const stamps = [...new Set(db.leaderboardSnapshots
      .filter((s) => s.season_event_id === eventId)
      .map((s) => String(s.snapshot_at)))]
      .sort((a, b) => new Date(b) - new Date(a));
    const keep = new Set(stamps.slice(0, 10));
    db.leaderboardSnapshots = db.leaderboardSnapshots
      .filter((s) => s.season_event_id !== eventId || keep.has(String(s.snapshot_at)));
    return { rows: [] };
  }

  // Public GET /leaderboard: requested event lookup.
  if (sql.includes('disclaimer, display_leaderboard') && sql.includes('WHERE id = $1')) {
    const event = db.seasonEvents.find((e) => e.id === params[0]);
    return { rows: event ? [event] : [] };
  }

  // Public GET /leaderboard: EVENT_LEADERBOARD_SQL (latest snapshot per
  // user joined to identity + accounts) — same emulation as
  // tests/topochain-public-api.test.js's 'accounts AS (' branch.
  if (sql.includes('accounts AS (')) {
    const eventId = params[0];
    const event = db.seasonEvents.find((e) => e.id === eventId);
    const latest = new Map();
    for (const s of db.leaderboardSnapshots) {
      if (s.season_event_id !== eventId) continue;
      const prev = latest.get(s.user_id);
      if (!prev || new Date(s.snapshot_at) > new Date(prev.snapshot_at)
        || (String(s.snapshot_at) === String(prev.snapshot_at) && s.id > prev.id)) {
        latest.set(s.user_id, s);
      }
    }
    const rows = [...latest.values()]
      .sort((a, b) => a.rank - b.rank || Number(b.total_points) - Number(a.total_points))
      .map((s) => {
        const user = db.users.find((u) => u.id === s.user_id);
        const acct = db.onchainAccounts.find((a) => a.user_id === s.user_id
          && (a.season_event_id === eventId || (a.season_event_id == null && a.season_id === event.season_id)));
        return {
          ...s,
          email: user.email, telegram: user.telegram, discord: user.discord,
          display_name: user.display_name, exclude_podium: user.exclude_podium,
          wallet_address: acct ? acct.public_key : null, bech32m: acct ? acct.address : null,
        };
      });
    return { rows };
  }

  throw new Error(`Unhandled SQL in mock pool: ${sql.slice(0, 120)}`);
}

function makeMockPool() {
  const query = async (sql, params) => handleQuery(sql, params);
  return {
    query,
    connect: async () => ({ query, release: () => {} }),
  };
}

// ─── HTTP plumbing ───────────────────────────────────────────────────────

function userMiddleware(role) {
  return (req, _res, next) => {
    if (role === 'user') { req.user = { id: 900, username: 'plain', isAdmin: false, canAdminWrite: false }; next(); return; }
    if (role === 'readonly') { req.user = { id: 901, username: 'ro-admin', isAdmin: true, canAdminWrite: false }; next(); return; }
    req.user = { id: 902, username: 'full-admin', isAdmin: true, canAdminWrite: true };
    next();
  };
}

function buildApp(factory, role = 'admin') {
  const app = express();
  app.use(express.json());
  app.use(userMiddleware(role));
  app.use(factory({}));
  return app;
}

async function listen(app) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test.beforeEach(() => {
  db = freshDb();
  currentMockPool = makeMockPool();
});

const byUser = (rows, userId) => rows.find((s) => s.user_id === userId);

// ─── buildSnapshots ─────────────────────────────────────────────────────

test('builder: persists one ranked snapshot per scoring user, shared-rank rule applied', async () => {
  const now = new Date();
  const result = await buildSnapshots(currentMockPool, { seasonEventId: 100, now });

  assert.equal(result.events.length, 1);
  assert.deepEqual(
    { season_event_id: result.events[0].season_event_id, users: result.events[0].users },
    { season_event_id: 100, users: 4 }
  );

  const rows = db.leaderboardSnapshots;
  assert.equal(rows.length, 4);

  // alice 2500 (podium-excluded, shares rank 1), bob 2350, carol 1250, dave 500
  assert.equal(byUser(rows, 1).rank, 1);
  assert.equal(byUser(rows, 1).total_points, 2500);
  assert.equal(byUser(rows, 2).rank, 1);
  assert.equal(byUser(rows, 2).total_points, 2350);
  assert.equal(byUser(rows, 3).rank, 2);
  assert.equal(byUser(rows, 3).total_points, 1250);
  assert.equal(byUser(rows, 4).rank, 3);
  assert.equal(byUser(rows, 4).total_points, 500);

  // every row carries the shared snapshot_at and the event's season_id
  for (const r of rows) {
    assert.equal(String(r.snapshot_at), String(now));
    assert.equal(r.season_id, 10);
  }
});

test('builder: golden-vector columns for one user (points, offchain, metrics, challenge_details)', async () => {
  await buildSnapshots(currentMockPool, { seasonEventId: 100, now: new Date() });
  const bob = byUser(db.leaderboardSnapshots, 2);

  assert.equal(bob.total_points, 2350); // 2250 block + 100 bug_report at weight 1
  assert.equal(bob.extra_points, 100);
  assert.equal(bob.bug_report_points, 100);
  assert.equal(bob.top_3_points, 0);

  // end-epoch cap + chain scoping: epoch 5 and chain-2 rows never count
  assert.equal(bob.event_total_produced_blocks, 8);
  assert.equal(bob.vrf_total_won_slots, 9);
  assert.equal(bob.canonical_total_won_slots, 9);
  assert.equal(bob.canonical_total_produced_blocks, 8);
  assert.equal(bob.canonical_won_slots_up_to_current, 9);
  assert.equal(bob.canonical_produced_blocks_up_to_current, 8);
  assert.equal(bob.last_epoch_total_produced_blocks, 4); // epoch 2, his last in-window epoch
  assert.equal(bob.event_success_rate, 88.89); // 8/9
  assert.equal(bob.epoch_success_rate, 100); // epoch 2: 4/4
  assert.equal(bob.max_bp_success_rate_up_to_current, 100);

  const details = JSON.parse(bob.challenge_details);
  assert.equal(details.length, 1); // enabled block challenge only — 501 is not a block challenge, 502 is disabled
  assert.deepEqual(
    {
      challenge_id: details[0].challenge_id,
      rate: details[0].rate,
      points: details[0].points,
      points_multiplier: details[0].points_multiplier,
    },
    { challenge_id: 500, rate: 45, points: 2250, points_multiplier: 1 }
  );

  // dave never produced: ledger-only totals, null success rates
  const dave = byUser(db.leaderboardSnapshots, 4);
  assert.equal(dave.extra_points, 500);
  assert.equal(dave.top_3_points, 500);
  assert.equal(dave.event_total_produced_blocks, 0);
  assert.equal(dave.event_success_rate, null);
  assert.equal(dave.epoch_success_rate, null);
});

test('builder: delegated epochs halve block points (timing data present)', async () => {
  // Slot timing for all four epochs, one hour apart.
  db.slotOutcomeReports = [1, 2, 3, 4].map((epoch) => ({
    chain_id: 'chain-1', epoch, slot_time_ms: T0 + (epoch - 1) * HOUR,
  }));
  // bob's account delegated across epochs 1 and 2.
  db.accountDelegationPeriods = [
    { account: 'addr-bob', started_at: new Date(T0 - HOUR), ended_at: new Date(T0 + 1.5 * HOUR) },
  ];

  await buildSnapshots(currentMockPool, { seasonEventId: 100, now: new Date() });

  const bob = byUser(db.leaderboardSnapshots, 2);
  assert.equal(bob.total_points, 1225); // 2250/2 + 100
  const details = JSON.parse(bob.challenge_details);
  assert.equal(details[0].rate, 45); // displayed rate is never reduced
  assert.equal(details[0].points, 1125);
  assert.equal(details[0].points_multiplier, 0.5);

  // alice is not delegated — unchanged
  assert.equal(byUser(db.leaderboardSnapshots, 1).total_points, 2500);
});

test('builder: re-running at the same instant upserts instead of duplicating', async () => {
  const now = new Date();
  await buildSnapshots(currentMockPool, { seasonEventId: 100, now });
  await buildSnapshots(currentMockPool, { seasonEventId: 100, now });
  assert.equal(db.leaderboardSnapshots.length, 4);
});

test('builder: prunes to the newest 10 snapshot_at values per event', async () => {
  for (let i = 0; i < 10; i += 1) {
    db.leaderboardSnapshots.push({
      id: db.nextSnapshotId++, season_event_id: 100, user_id: 2, snapshot_at: new Date(NOW - (20 - i) * DAY),
      total_points: 1, rank: 1,
    });
  }
  await buildSnapshots(currentMockPool, { seasonEventId: 100, now: new Date() });

  const stamps = new Set(db.leaderboardSnapshots
    .filter((s) => s.season_event_id === 100)
    .map((s) => String(s.snapshot_at)));
  assert.equal(stamps.size, 10);
  // the oldest pre-existing stamp fell off
  assert.equal(db.leaderboardSnapshots.some((s) => String(s.snapshot_at) === String(new Date(NOW - 20 * DAY))), false);
});

test('builder: default sweep takes active regular events on active seasons; others report skip reasons', async () => {
  const result = await buildSnapshots(currentMockPool, { now: new Date() });

  const byId = new Map(result.events.map((e) => [e.season_event_id, e]));
  assert.equal(byId.get(100).users, 4);
  assert.equal(byId.get(100).skipped, undefined);
  // 101 (inactive), 103 (type season), 104 (inactive season) are not
  // candidates of the default sweep at all; 102 IS a candidate (active,
  // regular, active season) but cannot score without an epoch range.
  assert.equal(byId.get(102).skipped, 'missing_epoch_range');
  assert.equal(byId.has(101), false);
  assert.equal(byId.has(103), false);
  assert.equal(byId.has(104), false);
});

test('builder: explicit target reports its guard; force bypasses activity guards only', async () => {
  const paused = await buildSnapshots(currentMockPool, { seasonEventId: 101, now: new Date() });
  assert.equal(paused.events[0].skipped, 'inactive_event');

  const forced = await buildSnapshots(currentMockPool, { seasonEventId: 101, force: true, now: new Date() });
  assert.equal(forced.events[0].skipped, undefined);
  // 3, not 4: the epoch stats reach event 101 (same chain + window), but
  // dave's top_3 ledger row is scoped to event 100.
  assert.equal(forced.events[0].users, 3);

  const seasonType = await buildSnapshots(currentMockPool, { seasonEventId: 103, force: true, now: new Date() });
  assert.equal(seasonType.events[0].skipped, 'not_regular');

  const closedSeason = await buildSnapshots(currentMockPool, { seasonEventId: 104, now: new Date() });
  assert.equal(closedSeason.events[0].skipped, 'inactive_season');
});

test('builder: refuses an epoch range too large to iterate', async () => {
  const result = await buildSnapshots(currentMockPool, { seasonEventId: 105, force: true, now: new Date() });
  assert.equal(result.events[0].skipped, 'epoch_range_too_large');
});

test('builder: a season-less event is addressable — guarded like an inactive season, force aggregates it', async () => {
  const guarded = await buildSnapshots(currentMockPool, { seasonEventId: 106, now: new Date() });
  assert.equal(guarded.events[0].skipped, 'inactive_season');

  const forced = await buildSnapshots(currentMockPool, { seasonEventId: 106, force: true, now: new Date() });
  assert.equal(forced.events[0].skipped, undefined);
  // Same chain/window stats as event 100 (3 producing users), no ledger
  // rows of its own; season_id stays NULL on the written rows.
  assert.equal(forced.events[0].users, 3);
  assert.equal(db.leaderboardSnapshots.every((s) => s.season_id === null), true);
});

test('builder: pg string ids are normalized to numbers in summaries and skip records', async () => {
  const result = await buildSnapshots(currentMockPool, { now: new Date() });
  for (const e of result.events) assert.equal(typeof e.season_event_id, 'number');
  const aggregated = result.events.find((e) => e.season_event_id === 100);
  assert.equal(aggregated.users, 4);
  assert.equal(byUser(db.leaderboardSnapshots, 2).season_id, 10);
});

test('builder: snapshots it writes serve the public leaderboard endpoint', async () => {
  await buildSnapshots(currentMockPool, { seasonEventId: 100, now: new Date() });

  const { server, base } = await listen(buildApp(topochainPublicRoutes));
  try {
    const res = await fetch(`${base}/api/v4/leaderboard?season_event_id=100`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    const board = body.data.leaderboard;
    assert.deepEqual(board.map((r) => [r.rank, Number(r.total_points)]), [
      [1, 2500], [1, 2350], [2, 1250], [3, 500],
    ]);
  } finally { server.close(); }
});

// ─── POST /api/v4/admin/leaderboard/aggregate ───────────────────────────

test('admin aggregate: view-only admin gets the write-gate 403 through the composed admin router', async () => {
  const { server, base } = await listen(buildApp(topochainAdminRoutes, 'readonly'));
  try {
    const res = await fetch(`${base}/api/v4/admin/leaderboard/aggregate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { success: false, error: 'Full admin access required.' });
  } finally { server.close(); }
});

test('admin aggregate: full admin aggregates one event and gets the summary envelope', async () => {
  const { server, base } = await listen(buildApp(leaderboardAdminRoutes));
  try {
    const res = await fetch(`${base}/api/v4/admin/leaderboard/aggregate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ season_event_id: 100 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.events.length, 1);
    assert.equal(body.data.events[0].season_event_id, 100);
    assert.equal(body.data.events[0].users, 4);
    assert.equal(typeof body.data.events[0].snapshot_at, 'string');
    assert.equal(body.message, 'Leaderboard aggregated for 1 event(s).');
    assert.equal(db.leaderboardSnapshots.length, 4);
  } finally { server.close(); }
});

test('admin aggregate: unknown or malformed season_event_id → 422', async () => {
  const { server, base } = await listen(buildApp(leaderboardAdminRoutes));
  try {
    for (const bad of [999999, 'nope']) {
      const res = await fetch(`${base}/api/v4/admin/leaderboard/aggregate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ season_event_id: bad }),
      });
      assert.equal(res.status, 422);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.deepEqual(body.details, { season_event_id: ['The selected season_event_id is invalid.'] });
    }
  } finally { server.close(); }
});

test('admin aggregate: sweep with no body aggregates every eligible event and reports skips', async () => {
  const { server, base } = await listen(buildApp(leaderboardAdminRoutes));
  try {
    const res = await fetch(`${base}/api/v4/admin/leaderboard/aggregate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    const byId = new Map(body.data.events.map((e) => [e.season_event_id, e]));
    assert.equal(byId.get(100).users, 4);
    assert.equal(byId.get(102).skipped, 'missing_epoch_range');
    assert.equal(body.message, 'Leaderboard aggregated for 1 event(s).');
  } finally { server.close(); }
});
