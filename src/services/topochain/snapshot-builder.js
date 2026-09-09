// Topochain snapshot builder — the WRITE side of the leaderboard.
//
// Everything below `leaderboard_snapshots` (standings.js,
// event-standings.js, the public/mobile routes) is read-only over rows
// that historically arrived from the external topochain ETL; nothing in
// this repo produced them. This module computes them from data the
// platform ingests itself: `epoch_stats` (canonical per-(chain, epoch,
// wallet) tallies with server-resolved user_id), `user_activities` (the
// points ledger), `slot_outcome_reports` (slot timing, used only to map
// epochs to wall-clock for challenge windows and delegation), and
// timestamp delegation before the immutable cutover C, and the epoch policy
// ledger from C onward.
//
// It is a port of the source system's LeaderboardAggregationService
// ("epoch_average_v2" mode), with the pure arithmetic in ./scoring.js
// and these deliberate divergences (spec'd in the proposal):
//   1. Block scores are NOT mirrored into `user_activities` — the admin
//      refresh-totals route folds EVERY activity_type into extra_points,
//      so a ledger write-back would double-count. Block points live in
//      the snapshot columns + challenge_details only.
//   2. Top-3 bonuses are not auto-awarded: on this platform `top_3` is a
//      ledger activity_type, weighted like any other.
//   3. Canonical-only: there is no client-reported metrics leg yet, so
//      the canonical_*/vrf_* column pairs carry the same figures.
//   4. Events without an epoch range are skipped (no timestamp-mode
//      scoring), reported as `missing_epoch_range`.
//
// Triggering is admin-only (POST /api/v4/admin/leaderboard/aggregate):
// each run writes a NEW shared snapshot_at — it never REWRITES rows an
// earlier run (or the ETL) wrote, so the two writers can coexist and
// reads always pick the latest snapshot_at per (event, user). Retention
// does delete, though: after every run the event keeps only its newest
// KEEP_SNAPSHOTS distinct snapshot_at values (the source system's own
// prune rule), ETL-imported history included — repeated triggers age
// older timestamps out of the time series.
'use strict';

const { assignSharedRanks } = require('./standings');
const {
  round2,
  resolveOffchainWeight,
  epochRatio,
  reconstructEpochBoundaries,
  computeEpochWeights,
  delegationMultipliers,
  computeChallengeScore,
  computeOffchainColumns,
} = require('./scoring');

const DEFAULT_BLOCK_POINTS = 5000; // the source system's produce_every_block
const KEEP_SNAPSHOTS = 10; // distinct snapshot_at values kept per event
// Epoch windows are iterated (weights, boundary fill), so a fat-fingered
// BIGINT end_epoch must be refused outright rather than wedging the
// process. Epochs are ~daily: 100k epochs is centuries of headroom.
const MAX_EPOCH_RANGE = 100_000;

// Candidate events. With $1 NULL this is the default sweep (active
// regular events on active seasons — never a hardcoded id, the smell the
// source scheduler had); with $1 set it returns exactly that row so the
// caller can report a precise skip reason instead of silence.
const EVENTS_SQL = `
  SELECT se.id, se.name, se.season_id, se.start_epoch, se.end_epoch, se.chain_id,
         se.scoring_formula, se.is_active, se.internal, se.type,
         COALESCE(s.is_active, FALSE) AS season_is_active
    FROM season_events se
    LEFT JOIN seasons s ON s.id = se.season_id
   WHERE ($1::bigint IS NULL AND se.type = 'regular' AND se.is_active = TRUE AND s.is_active = TRUE)
      OR se.id = $1
   ORDER BY se.id ASC
`;

// Enabled block-production challenges with their effective fields. The
// signal is the effective metric_type = 'blocks_produced' (challenge
// override, else template) — the same marker the public breakdown route
// keys on; `kind` is not distinctive for block production.
const BLOCK_CHALLENGES_SQL = `
  SELECT c.id,
         COALESCE(c.goal, ct.goal) AS goal,
         COALESCE(c.schedule_start, ct.schedule_start) AS schedule_start,
         COALESCE(c.schedule_end, ct.schedule_end) AS schedule_end
    FROM challenges c
    JOIN challenge_templates ct ON ct.id = c.challenge_template_id
   WHERE c.season_event_id = $1 AND c.enabled = TRUE
     AND COALESCE(c.metric_type, ct.metric_type) = 'blocks_produced'
   ORDER BY c.id ASC
`;

// Canonical per-(user, epoch) tallies inside the event's hard epoch cap.
// Attribution rides on epoch_stats.user_id, which ingest resolves
// server-side from the wallet's latest assignment — rows for wallets
// never linked to a user carry NULL and are excluded here.
const EPOCH_STATS_SQL = `
  SELECT user_id, epoch,
         SUM(epoch_won_slots) AS won_slots,
         SUM(epoch_produced_blocks) AS produced_blocks
    FROM epoch_stats
   WHERE chain_id = ANY($1) AND epoch BETWEEN $2 AND $3 AND user_id IS NOT NULL
   GROUP BY user_id, epoch
`;

// First observed slot time per epoch — the wall-clock anchor for epoch
// boundaries (see scoring.reconstructEpochBoundaries). Entirely optional
// input: with no telemetry the builder scores in no-timing mode.
const EPOCH_TIMING_SQL = `
  SELECT epoch, MIN(slot_time_ms) AS first_slot_time_ms
    FROM slot_outcome_reports
   WHERE chain_id = ANY($1) AND epoch BETWEEN $2 AND $3
     AND epoch IS NOT NULL AND slot_time_ms IS NOT NULL
   GROUP BY epoch
`;

// The per-type ledger sums — the same shape the admin refresh-totals
// route aggregates, feeding the SAME computeOffchainColumns arithmetic
// so the two write paths cannot diverge.
const ACTIVITY_SUMS_SQL = `
  SELECT user_id, activity_type, COALESCE(SUM(points), 0) AS total_points
    FROM user_activities WHERE season_event_id = $1
   GROUP BY user_id, activity_type
`;

const PODIUM_FLAGS_SQL = 'SELECT id, exclude_podium FROM users WHERE id = ANY($1)';

// Delegation periods reached through the users' accounts in scope for
// the event (event-scoped, or season-scoped on the event's season) —
// mirroring how onchain_accounts are resolved everywhere else.
const DELEGATION_PERIODS_SQL = `
  SELECT oa.user_id, adp.started_at, adp.ended_at
    FROM onchain_accounts oa
    JOIN account_delegation_periods adp ON adp.account = oa.address
   WHERE oa.user_id = ANY($1)
     AND (oa.season_event_id = $2 OR (oa.season_event_id IS NULL AND oa.season_id = $3))
`;

const DELEGATION_CUTOVER_SQL = `
  SELECT chain_id, cutover_epoch
    FROM native_epoch_delegation_fences
   WHERE network_id = 'testnet' AND chain_id = ANY($1)
     AND cutover_epoch IS NOT NULL
   ORDER BY chain_id
`;

const EPOCH_DELEGATION_POLICIES_SQL = `
  SELECT p.user_id, p.account_address, p.chain_id, p.delegated,
         p.effective_epoch, p.id
    FROM native_epoch_delegation_policies p
    JOIN onchain_accounts oa
      ON oa.id = p.account_id AND oa.user_id = p.user_id
     AND oa.address = p.account_address
   WHERE p.user_id = ANY($1) AND p.network_id = 'testnet'
     AND p.chain_id = ANY($2) AND p.effective_epoch <= $3
     AND (oa.season_event_id = $4
       OR (oa.season_event_id IS NULL AND oa.season_id = $5))
   ORDER BY p.user_id, p.account_address, p.chain_id, p.effective_epoch, p.id
`;

function epochPolicyStateByUser(rows, userIds, epochs) {
  const byUser = new Map();
  for (const userId of userIds) {
    const policies = rows.filter((row) => Number(row.user_id) === userId);
    const states = new Map();
    for (const epoch of epochs) {
      const latest = new Map();
      for (const row of policies) {
        if (Number(row.effective_epoch) > epoch) continue;
        const key = `${row.chain_id}\0${row.account_address}`;
        latest.set(key, !!row.delegated);
      }
      states.set(epoch, [...latest.values()].some(Boolean));
    }
    byUser.set(userId, states);
  }
  return byUser;
}

// Column order of the snapshot upsert's bound parameters — exported so
// the mock-pool tests map positional params by name instead of encoding
// positions of their own.
const SNAPSHOT_COLUMNS = [
  'season_event_id', 'user_id', 'rank', 'total_points', 'extra_points', 'snapshot_at',
  'last_epoch_total_produced_blocks', 'event_total_produced_blocks',
  'event_success_rate', 'epoch_success_rate',
  'first_block_points', 'produced_half_blocks_points', 'top_3_points', 'success_50_percent_points',
  'bug_report_points', 'inviting_new_participant_points', 'community_contribution_points',
  'vrf_total_won_slots', 'canonical_total_won_slots', 'canonical_total_produced_blocks',
  'canonical_won_slots_up_to_current', 'canonical_produced_blocks_up_to_current',
  'max_bp_success_rate_up_to_current', 'season_id', 'challenge_details',
];

const SNAPSHOT_UPSERT_SQL = `
  INSERT INTO leaderboard_snapshots
    (${SNAPSHOT_COLUMNS.join(', ')}, created_at, updated_at)
  VALUES (${SNAPSHOT_COLUMNS.map((_, i) => `$${i + 1}`).join(', ')}, NOW(), NOW())
  ON CONFLICT (season_event_id, user_id, snapshot_at) DO UPDATE SET
    ${SNAPSHOT_COLUMNS.filter((c) => !['season_event_id', 'user_id', 'snapshot_at'].includes(c))
    .map((c) => `${c} = EXCLUDED.${c}`).join(', ')},
    updated_at = NOW()
`;

// Retention: the table doubles as the history time series, so each event
// keeps its newest KEEP_SNAPSHOTS distinct snapshot_at values.
const PRUNE_SQL = `
  DELETE FROM leaderboard_snapshots
   WHERE season_event_id = $1
     AND snapshot_at NOT IN (
       SELECT snapshot_at FROM (
         SELECT DISTINCT snapshot_at FROM leaderboard_snapshots
          WHERE season_event_id = $1
          ORDER BY snapshot_at DESC
          LIMIT ${KEEP_SNAPSHOTS}
       ) keep
     )
`;

// Guard an event and return a skip reason, or null to aggregate. `force`
// bypasses the two ACTIVITY guards only (a final pass over a just-ended
// or paused event) — never the structural ones.
function skipReason(event, force) {
  if (event.type !== 'regular') return 'not_regular';
  if (!force && !event.is_active) return 'inactive_event';
  // A NULL season_id reports as season_is_active FALSE (LEFT JOIN +
  // COALESCE above) and lands here too — force can still address it.
  if (!force && !event.season_is_active) return 'inactive_season';
  if (event.start_epoch === null || event.end_epoch === null
    || Number(event.end_epoch) < Number(event.start_epoch)) return 'missing_epoch_range';
  if (Number(event.end_epoch) - Number(event.start_epoch) + 1 > MAX_EPOCH_RANGE) return 'epoch_range_too_large';
  if (!event.chain_id || !String(event.chain_id).trim()) return 'missing_chain_id';
  return null;
}

const toMs = (v) => (v === null || v === undefined ? null : new Date(v).getTime());

async function aggregateEvent(pool, event, now) {
  const startEpoch = Number(event.start_epoch);
  const endEpoch = Number(event.end_epoch);
  // season_events.chain_id is a comma-separated list per the ingest
  // route's own precedent (GET /onchain-accounts unnests it, SPEC 1481);
  // a single-chain value is the common case and works unchanged. NOTE:
  // the public epoch-breakdown route still matches the column literally,
  // so multi-chain events cannot drill down there yet.
  const chains = String(event.chain_id).split(',').map((c) => c.trim()).filter(Boolean);
  const formula = event.scoring_formula || {};
  const offchainWeight = resolveOffchainWeight(formula);
  const basePoints = Number(formula.produce_every_block_points) || DEFAULT_BLOCK_POINTS;

  const [challengesRes, statsRes, timingRes, activityRes] = await Promise.all([
    pool.query(BLOCK_CHALLENGES_SQL, [event.id]),
    pool.query(EPOCH_STATS_SQL, [chains, startEpoch, endEpoch]),
    pool.query(EPOCH_TIMING_SQL, [chains, startEpoch, endEpoch]),
    pool.query(ACTIVITY_SUMS_SQL, [event.id]),
  ]);

  // Per-user per-epoch canonical tallies.
  const statsByUser = new Map();
  for (const r of statsRes.rows) {
    const userId = Number(r.user_id);
    if (!statsByUser.has(userId)) statsByUser.set(userId, new Map());
    statsByUser.get(userId).set(Number(r.epoch), {
      won: Number(r.won_slots) || 0,
      produced: Number(r.produced_blocks) || 0,
    });
  }

  // Per-user per-type ledger sums.
  const activityByUser = new Map();
  for (const r of activityRes.rows) {
    const userId = Number(r.user_id);
    if (!activityByUser.has(userId)) activityByUser.set(userId, {});
    activityByUser.get(userId)[r.activity_type] = Number(r.total_points) || 0;
  }

  const userIds = [...new Set([...statsByUser.keys(), ...activityByUser.keys()])];
  if (!userIds.length) return { season_event_id: event.id, name: event.name, users: 0, snapshot_at: now };

  const boundaries = reconstructEpochBoundaries(timingRes.rows, {
    fillRange: { startEpoch, endEpoch },
  });

  const [podiumRes, delegationRes, cutoverRes, epochPoliciesRes] = await Promise.all([
    pool.query(PODIUM_FLAGS_SQL, [userIds]),
    pool.query(DELEGATION_PERIODS_SQL, [userIds, event.id, event.season_id]),
    pool.query(DELEGATION_CUTOVER_SQL, [chains]),
    pool.query(EPOCH_DELEGATION_POLICIES_SQL, [
      userIds, chains, endEpoch, event.id, event.season_id,
    ]),
  ]);
  const excludedByUser = new Map(podiumRes.rows.map((r) => [Number(r.id), !!r.exclude_podium]));
  const periodsByUser = new Map();
  for (const r of delegationRes.rows) {
    const userId = Number(r.user_id);
    if (!periodsByUser.has(userId)) periodsByUser.set(userId, []);
    periodsByUser.get(userId).push({ startedAtMs: toMs(r.started_at), endedAtMs: toMs(r.ended_at) });
  }
  if (cutoverRes.rows.length > 0 && cutoverRes.rows.length !== chains.length) {
    throw new Error('event chains do not share one delegation authority boundary');
  }
  const cutoverEpochs = new Set(cutoverRes.rows.map((row) => Number(row.cutover_epoch)));
  if (cutoverEpochs.size > 1) {
    throw new Error('event chains have different delegation cutover epochs');
  }
  const cutoverEpoch = cutoverEpochs.size === 1 ? [...cutoverEpochs][0] : null;
  const scoredEpochs = [...new Set(statsRes.rows.map((row) => Number(row.epoch)))].sort((a, b) => a - b);
  const epochDelegatedByUser = epochPolicyStateByUser(
    epochPoliciesRes.rows,
    userIds,
    scoredEpochs,
  );

  const nowMs = now.getTime();

  // Challenge windows are user-independent: resolve schedule bounds and
  // epoch weights once per challenge, not once per (user, challenge).
  const scoredChallenges = challengesRes.rows.map((challenge) => {
    const scheduleStartMs = toMs(challenge.schedule_start);
    const scheduleEndMs = toMs(challenge.schedule_end);
    const { weights, K } = computeEpochWeights({
      startEpoch, endEpoch, boundaries, scheduleStartMs, scheduleEndMs,
    });
    return {
      challenge, weights, K, ended: scheduleEndMs !== null && scheduleEndMs <= nowMs,
    };
  });

  const rows = userIds
    // Users deleted from `users` have no podium flag row — their history
    // stays in the raw tables but they no longer board.
    .filter((userId) => excludedByUser.has(userId))
    .map((userId) => {
      const epochs = statsByUser.get(userId) || new Map();
      const byType = activityByUser.get(userId) || {};

      const ratios = new Map();
      for (const [epoch, s] of epochs) ratios.set(epoch, epochRatio(s.produced, s.won));
      const multipliers = delegationMultipliers({
        epochs: [...ratios.keys()],
        boundaries,
        periods: periodsByUser.get(userId) || [],
        cutoverEpoch,
        epochDelegated: epochDelegatedByUser.get(userId),
      });

      const challengeDetails = [];
      let blockPoints = 0;
      for (const { challenge, weights, K, ended } of scoredChallenges) {
        const score = computeChallengeScore({
          weights, K, ratios, multipliers, basePoints,
        });
        blockPoints += score.points;
        challengeDetails.push({
          challenge_id: Number(challenge.id),
          goal: challenge.goal,
          schedule_start: challenge.schedule_start,
          schedule_end: challenge.schedule_end,
          rate: round2(score.rate),
          points: score.points,
          points_multiplier: round2(score.pointsMultiplier),
          ended,
        });
      }

      const offchain = computeOffchainColumns(byType, offchainWeight);

      let won = 0;
      let produced = 0;
      let lastEpoch = null;
      let maxRatio = 0;
      for (const [epoch, s] of epochs) {
        won += s.won;
        produced += s.produced;
        if (lastEpoch === null || epoch > lastEpoch) lastEpoch = epoch;
        maxRatio = Math.max(maxRatio, epochRatio(s.produced, s.won));
      }
      const lastStats = lastEpoch === null ? null : epochs.get(lastEpoch);

      return {
        user_id: userId,
        is_non_podium: excludedByUser.get(userId),
        total_points: round2(blockPoints + offchain.extra_points),
        extra_points: offchain.extra_points,
        bug_report_points: offchain.bug_report_points,
        inviting_new_participant_points: offchain.inviting_new_participant_points,
        community_contribution_points: offchain.community_contribution_points,
        first_block_points: offchain.first_block_points,
        top_3_points: offchain.top_3_points,
        success_50_percent_points: offchain.success_50_percent_points,
        produced_half_blocks_points: 0,
        event_total_produced_blocks: produced,
        last_epoch_total_produced_blocks: lastStats ? lastStats.produced : 0,
        vrf_total_won_slots: won,
        canonical_total_won_slots: won,
        canonical_total_produced_blocks: produced,
        canonical_won_slots_up_to_current: won,
        canonical_produced_blocks_up_to_current: produced,
        event_success_rate: won > 0 ? round2(Math.min(produced / won, 1) * 100) : null,
        epoch_success_rate: lastStats ? round2(epochRatio(lastStats.produced, lastStats.won) * 100) : null,
        max_bp_success_rate_up_to_current: round2(maxRatio * 100),
        challenge_details: challengeDetails,
      };
    });

  rows.sort((a, b) => b.total_points - a.total_points
    || b.event_total_produced_blocks - a.event_total_produced_blocks
    || a.user_id - b.user_id);
  const ranked = assignSharedRanks(rows);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      for (const row of ranked) {
        const values = SNAPSHOT_COLUMNS.map((col) => {
          if (col === 'season_event_id') return event.id;
          if (col === 'snapshot_at') return now;
          if (col === 'season_id') return event.season_id;
          if (col === 'challenge_details') return JSON.stringify(row.challenge_details);
          return row[col];
        });
        await client.query(SNAPSHOT_UPSERT_SQL, values);
      }
      await client.query(PRUNE_SQL, [event.id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } finally {
    client.release();
  }

  return { season_event_id: event.id, name: event.name, users: ranked.length, snapshot_at: now };
}

// buildSnapshots(pool, { seasonEventId, force, now }) → { events: [...] }
// where each entry is either an aggregation summary
// ({ season_event_id, name, users, snapshot_at }) or a skip record
// ({ season_event_id, name, skipped }). With no seasonEventId this sweeps
// every eligible event; an unknown explicit id yields an empty list (the
// admin route turns that into its 422).
async function buildSnapshots(pool, { seasonEventId = null, force = false, now = new Date() } = {}) {
  const { rows: events } = await pool.query(EVENTS_SQL, [seasonEventId]);
  const results = [];
  for (const raw of events) {
    // BIGSERIAL ids arrive from pg as strings — normalize once so the
    // summary/skip records and every downstream query bind numbers.
    const event = {
      ...raw,
      id: Number(raw.id),
      season_id: raw.season_id === null || raw.season_id === undefined ? null : Number(raw.season_id),
    };
    const reason = skipReason(event, force);
    if (reason) {
      results.push({ season_event_id: event.id, name: event.name, skipped: reason });
      continue;
    }
    results.push(await aggregateEvent(pool, event, now));
  }
  return { events: results };
}

module.exports = { buildSnapshots, SNAPSHOT_COLUMNS, KEEP_SNAPSHOTS };
