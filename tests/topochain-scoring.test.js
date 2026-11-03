// Topochain snapshot builder — pure scoring functions (no DB).
//
// These pin the epoch-average v2 formula ported from the source system's
// LeaderboardAggregationService, including its golden numeric vector
// (K=4, ratios [0.8, 1.0, 0, 0], base 5000 → 45% → 2250 points), the
// zero rules (no won slots / no data ⇒ ratio 0), delegation halving, and
// the offchain column arithmetic shared verbatim with the admin
// refresh-totals route.
//
// Run with: node --test tests/topochain-scoring.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  epochRatio,
  reconstructEpochBoundaries,
  computeEpochWeights,
  delegationMultipliers,
  computeChallengeScore,
  computeOffchainColumns,
} = require('../src/services/topochain/scoring');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ─── epochRatio ───────────────────────────────────────────────────────

test('epochRatio: produced/won, capped at 1', () => {
  assert.equal(epochRatio(4, 5), 0.8);
  assert.equal(epochRatio(7, 5), 1);
});

test('epochRatio: 0 when no slots were won or inputs are missing', () => {
  assert.equal(epochRatio(3, 0), 0);
  assert.equal(epochRatio(0, 0), 0);
  assert.equal(epochRatio(undefined, undefined), 0);
});

// ─── reconstructEpochBoundaries ───────────────────────────────────────

test('boundaries: epoch start = first slot time; end = next epoch start; last end projected from mean gap', () => {
  const t0 = 1_000_000_000_000;
  const rows = [
    { epoch: 10, first_slot_time_ms: t0 },
    { epoch: 11, first_slot_time_ms: t0 + 2 * HOUR },
    { epoch: 12, first_slot_time_ms: t0 + 6 * HOUR },
  ];
  const b = reconstructEpochBoundaries(rows);
  assert.deepEqual(b.get(10), { startMs: t0, endMs: t0 + 2 * HOUR });
  assert.deepEqual(b.get(11), { startMs: t0 + 2 * HOUR, endMs: t0 + 6 * HOUR });
  // mean gap = (2h + 4h) / 2 = 3h
  assert.deepEqual(b.get(12), { startMs: t0 + 6 * HOUR, endMs: t0 + 9 * HOUR });
});

test('boundaries: a single observed epoch projects its end with the default duration (86400s)', () => {
  const t0 = 1_000_000_000_000;
  const b = reconstructEpochBoundaries([{ epoch: 5, first_slot_time_ms: t0 }]);
  assert.deepEqual(b.get(5), { startMs: t0, endMs: t0 + DAY });
});

test('boundaries: no rows → empty map', () => {
  assert.equal(reconstructEpochBoundaries([]).size, 0);
});

test('boundaries: fillRange projects missing epochs backward, across gaps, and forward', () => {
  const t0 = 1_000_000_000_000;
  const rows = [
    { epoch: 2, first_slot_time_ms: t0 },
    { epoch: 4, first_slot_time_ms: t0 + 4 * HOUR }, // epoch 3 unobserved
  ];
  const b = reconstructEpochBoundaries(rows, { fillRange: { startEpoch: 1, endEpoch: 5 } });
  // mean per-epoch duration = (4h span) / (2 epochs) = 2h
  assert.deepEqual(b.get(1), { startMs: t0 - 2 * HOUR, endMs: t0 });
  assert.deepEqual(b.get(2), { startMs: t0, endMs: t0 + 2 * HOUR });
  assert.deepEqual(b.get(3), { startMs: t0 + 2 * HOUR, endMs: t0 + 4 * HOUR });
  assert.deepEqual(b.get(4), { startMs: t0 + 4 * HOUR, endMs: t0 + 6 * HOUR });
  assert.deepEqual(b.get(5), { startMs: t0 + 6 * HOUR, endMs: t0 + 8 * HOUR });
});

test('boundaries: fillRange with no observations still yields an empty map (no-timing mode)', () => {
  const b = reconstructEpochBoundaries([], { fillRange: { startEpoch: 1, endEpoch: 4 } });
  assert.equal(b.size, 0);
});

test('boundaries: non-increasing observed starts degrade to the empty map instead of zero-length spans', () => {
  const t0 = 1_000_000_000_000;
  // A batch-ingested telemetry burst can stamp several epochs with one
  // shared slot time (meanDuration 0), or clock skew can invert them
  // (meanDuration < 0). Both must fall back to no-timing mode — zero
  // -length spans would silently zero every user's block points.
  assert.equal(reconstructEpochBoundaries([
    { epoch: 1, first_slot_time_ms: t0 },
    { epoch: 2, first_slot_time_ms: t0 },
  ]).size, 0);
  assert.equal(reconstructEpochBoundaries([
    { epoch: 1, first_slot_time_ms: t0 },
    { epoch: 2, first_slot_time_ms: t0 - HOUR },
  ]).size, 0);
});

// ─── computeEpochWeights ──────────────────────────────────────────────

test('weights: without timing data every in-window epoch weighs 1 and K is the epoch count', () => {
  const { weights, K } = computeEpochWeights({
    startEpoch: 1,
    endEpoch: 4,
    boundaries: new Map(),
    scheduleStartMs: null,
    scheduleEndMs: null,
  });
  assert.equal(K, 4);
  for (const e of [1, 2, 3, 4]) assert.equal(weights.get(e), 1);
});

test('weights: challenge window overlap is fractional per epoch', () => {
  const t0 = 1_000_000_000_000;
  const boundaries = new Map([
    [1, { startMs: t0, endMs: t0 + 4 * HOUR }],
    [2, { startMs: t0 + 4 * HOUR, endMs: t0 + 8 * HOUR }],
  ]);
  // schedule covers the last half of epoch 1 and all of epoch 2
  const { weights, K } = computeEpochWeights({
    startEpoch: 1,
    endEpoch: 2,
    boundaries,
    scheduleStartMs: t0 + 2 * HOUR,
    scheduleEndMs: t0 + 8 * HOUR,
  });
  assert.equal(weights.get(1), 0.5);
  assert.equal(weights.get(2), 1);
  assert.equal(K, 1.5);
});

test('weights: K is floored at 1 even when the schedule barely overlaps', () => {
  const t0 = 1_000_000_000_000;
  const boundaries = new Map([[1, { startMs: t0, endMs: t0 + 4 * HOUR }]]);
  const { weights, K } = computeEpochWeights({
    startEpoch: 1,
    endEpoch: 1,
    boundaries,
    scheduleStartMs: t0 + 3 * HOUR,
    scheduleEndMs: t0 + 4 * HOUR,
  });
  assert.equal(weights.get(1), 0.25);
  assert.equal(K, 1);
});

test('weights: epochs outside [startEpoch, endEpoch] are never included (hard cap)', () => {
  const t0 = 1_000_000_000_000;
  const boundaries = new Map([
    [1, { startMs: t0, endMs: t0 + HOUR }],
    [2, { startMs: t0 + HOUR, endMs: t0 + 2 * HOUR }],
    [3, { startMs: t0 + 2 * HOUR, endMs: t0 + 3 * HOUR }],
  ]);
  const { weights } = computeEpochWeights({
    startEpoch: 1,
    endEpoch: 2,
    boundaries,
    scheduleStartMs: t0,
    scheduleEndMs: t0 + 3 * HOUR, // schedule overhangs past end_epoch
  });
  assert.equal(weights.has(3), false);
});

// ─── delegationMultipliers ────────────────────────────────────────────

test('delegation: 0.5 for epochs whose start falls inside a period, else 1', () => {
  const t0 = 1_000_000_000_000;
  const boundaries = new Map([
    [1, { startMs: t0, endMs: t0 + HOUR }],
    [2, { startMs: t0 + HOUR, endMs: t0 + 2 * HOUR }],
    [3, { startMs: t0 + 2 * HOUR, endMs: t0 + 3 * HOUR }],
  ]);
  const mults = delegationMultipliers({
    epochs: [1, 2, 3],
    boundaries,
    periods: [{ startedAtMs: t0 + HOUR, endedAtMs: t0 + 2 * HOUR }],
  });
  assert.equal(mults.get(1), 1);
  assert.equal(mults.get(2), 0.5);
  assert.equal(mults.get(3), 1);
});

test('delegation: an open period (no end) covers every later epoch', () => {
  const t0 = 1_000_000_000_000;
  const boundaries = new Map([
    [1, { startMs: t0, endMs: t0 + HOUR }],
    [2, { startMs: t0 + HOUR, endMs: t0 + 2 * HOUR }],
  ]);
  const mults = delegationMultipliers({
    epochs: [1, 2],
    boundaries,
    periods: [{ startedAtMs: t0 + HOUR, endedAtMs: null }],
  });
  assert.equal(mults.get(1), 1);
  assert.equal(mults.get(2), 0.5);
});

test('delegation: without timing data every multiplier is 1 (never guessed)', () => {
  const mults = delegationMultipliers({
    epochs: [1, 2],
    boundaries: new Map(),
    periods: [{ startedAtMs: 0, endedAtMs: null }],
  });
  assert.equal(mults.get(1), 1);
  assert.equal(mults.get(2), 1);
});

test('delegation: cutover makes the epoch ledger the sole authority from C onward', () => {
  const t0 = 1_000_000_000_000;
  const boundaries = new Map([
    [9, { startMs: t0, endMs: t0 + HOUR }],
    [10, { startMs: t0 + HOUR, endMs: t0 + 2 * HOUR }],
    [11, { startMs: t0 + 2 * HOUR, endMs: t0 + 3 * HOUR }],
  ]);
  const mults = delegationMultipliers({
    epochs: [9, 10, 11],
    boundaries,
    periods: [{ startedAtMs: t0, endedAtMs: null }],
    cutoverEpoch: 10,
    epochDelegated: new Map([[10, false], [11, true]]),
  });
  assert.equal(mults.get(9), 0.5);
  assert.equal(mults.get(10), 1);
  assert.equal(mults.get(11), 0.5);
});

// ─── computeChallengeScore (the golden vector and friends) ────────────

const flatWeights = (epochs) => new Map(epochs.map((e) => [e, 1]));

test('golden vector: K=4, ratios [0.8, 1.0, 0, 0], base 5000 → 45% → 2250 points', () => {
  const score = computeChallengeScore({
    weights: flatWeights([1, 2, 3, 4]),
    K: 4,
    ratios: new Map([[1, 0.8], [2, 1.0]]),
    multipliers: new Map(),
    basePoints: 5000,
  });
  assert.equal(score.rate, 45);
  assert.equal(score.pointsRate, 45);
  assert.equal(score.points, 2250);
  assert.equal(score.pointsMultiplier, 1);
});

test('delegated epochs halve pointsRate but never the displayed rate', () => {
  const score = computeChallengeScore({
    weights: flatWeights([1, 2, 3, 4]),
    K: 4,
    ratios: new Map([[1, 0.8], [2, 1.0]]),
    multipliers: new Map([[1, 0.5], [2, 0.5]]),
    basePoints: 5000,
  });
  assert.equal(score.rate, 45);
  assert.equal(score.pointsRate, 22.5);
  assert.equal(score.points, 1125);
  assert.equal(score.pointsMultiplier, 0.5);
});

test('rate is capped at 100 even when weighted ratios exceed K', () => {
  const score = computeChallengeScore({
    weights: flatWeights([1]),
    K: 1,
    ratios: new Map([[1, 1.0], [2, 1.0]]), // epoch 2 has no weight → ignored
    multipliers: new Map(),
    basePoints: 1000,
  });
  assert.equal(score.rate, 100);
  assert.equal(score.points, 1000);
});

test('no production at all → 0 points, multiplier 1', () => {
  const score = computeChallengeScore({
    weights: flatWeights([1, 2]),
    K: 2,
    ratios: new Map(),
    multipliers: new Map(),
    basePoints: 5000,
  });
  assert.equal(score.rate, 0);
  assert.equal(score.points, 0);
  assert.equal(score.pointsMultiplier, 1);
});

test('points round to 2 decimals', () => {
  const score = computeChallengeScore({
    weights: flatWeights([1, 2, 3]),
    K: 3,
    ratios: new Map([[1, 1.0]]),
    multipliers: new Map(),
    basePoints: 1000,
  });
  // 1/3 of 1000 = 333.333… → 333.33
  assert.equal(score.points, 333.33);
});

// ─── computeOffchainColumns (must match admin refresh-totals verbatim) ─

test('offchain columns: per-type integer rounding, extra_points to 2 decimals, all times the weight', () => {
  const byType = {
    bug_report: 100.4,
    inviting_new_participant: 50,
    community_contribution: 10.26,
    first_block: 25,
    top_3: 1500,
    success_50_percent: 75,
    something_else: 12.5,
  };
  const cols = computeOffchainColumns(byType, 0.5);
  assert.equal(cols.bug_report_points, 50); // round(100.4*0.5) = round(50.2)
  assert.equal(cols.inviting_new_participant_points, 25);
  assert.equal(cols.community_contribution_points, 5); // round(5.13)
  assert.equal(cols.first_block_points, 13); // round(12.5) → 13
  assert.equal(cols.top_3_points, 750);
  assert.equal(cols.success_50_percent_points, 38); // round(37.5) → 38
  // extra = round(sum(all types) * 0.5, 2) = round(1773.16 * 0.5, 2)
  assert.equal(cols.extra_points, 886.58);
});

test('offchain columns: zero weight zeroes everything; missing types read as 0', () => {
  const cols = computeOffchainColumns({ bug_report: 500 }, 0);
  assert.equal(cols.extra_points, 0);
  assert.equal(cols.bug_report_points, 0);
  assert.equal(cols.top_3_points, 0);
});

// ─── The standing score's two factors (#6039) ───────────────────────────
//
// The smarter-rank first version: one score per player per board, made of
// the player's points lifted by a capped quality factor (how much of their
// work the grader judged) and a capped breadth factor (how many of the
// season's challenges they scored on). These pin the arithmetic alone; the
// SQL spellings of the same expressions are held against these on real
// Postgres (tests/topochain-own-standing.test.js).

const {
  qualityFactor,
  breadthFactor,
  standingScore,
  compareStandingRows,
  standingOrderBy,
} = require('../src/services/topochain/standing-score');

test('qualityFactor: 1 with nothing graded or no points, and exactly 1.25 at the cap', () => {
  assert.equal(qualityFactor(0, 100), 1, 'nothing graded → no lift');
  assert.equal(qualityFactor(100, 0), 1, 'no points → no lift (never a divide-by-zero)');
  assert.equal(qualityFactor(0, 0), 1);
  // Nothing is graded at more than 100% of points, so the ratio caps at 1:
  // 1 + 0.25 * 1 = 1.25 is the ceiling.
  assert.equal(qualityFactor(100, 100), 1.25);
  assert.equal(qualityFactor(150, 100), 1.25, 'a ratio over 1 cannot lift past the cap');
  assert.equal(qualityFactor(50, 100), 1.125, 'half the points graded → half the lift');
});

test('breadthFactor: 1 at zero challenges, 2% each, clamped at 1.20', () => {
  assert.equal(breadthFactor(0), 1);
  assert.equal(breadthFactor(1), 1.02);
  assert.equal(breadthFactor(5), 1.1);
  assert.equal(breadthFactor(10), 1.2);
  assert.equal(breadthFactor(11), 1.2, 'clamps at ten challenges');
  assert.equal(breadthFactor(500), 1.2);
});

test('standingScore: both factors lift, and the score is never below total_points', () => {
  // Nothing graded, one challenge: only the small breadth lift.
  assert.equal(standingScore({ totalPoints: 1000, gradedPoints: 0, distinctChallenges: 1 }), 1020);
  // Everything graded, ten challenges: both caps → 1000 * 1.25 * 1.20.
  assert.equal(standingScore({ totalPoints: 1000, gradedPoints: 1000, distinctChallenges: 10 }), 1500);
  // The floor: a zero-point or ungraded-zero-breadth player keeps their points.
  assert.equal(standingScore({ totalPoints: 750, gradedPoints: 0, distinctChallenges: 0 }), 750);
  assert.equal(standingScore({ totalPoints: 0, gradedPoints: 0, distinctChallenges: 5 }), 0);
  // Rounded to 2 dp.
  assert.equal(standingScore({ totalPoints: 333.33, gradedPoints: 100, distinctChallenges: 3 }), 379.83);
  // Monotone in points: more points, same factors, is never a smaller score.
  assert.ok(standingScore({ totalPoints: 2000, gradedPoints: 400, distinctChallenges: 4 })
    >= standingScore({ totalPoints: 1000, gradedPoints: 400, distinctChallenges: 4 }));
});

test('compareStandingRows: score, then rate (null last), blocks, challenges, user_id', () => {
  const rows = [
    { user_id: 3, standings_score: 1200, event_success_rate: 40, event_total_produced_blocks: 5, distinct_challenges: 2 },
    { user_id: 1, standings_score: 1200, event_success_rate: null, event_total_produced_blocks: 9, distinct_challenges: 9 },
    { user_id: 2, standings_score: 1200, event_success_rate: 40, event_total_produced_blocks: 5, distinct_challenges: 7 },
    { user_id: 4, standings_score: 999, event_success_rate: 100, event_total_produced_blocks: 100, distinct_challenges: 100 },
  ];
  const sorted = rows.slice().sort(compareStandingRows).map((r) => r.user_id);
  // 1200 loses to nothing; among the 1200s, rate 40 beats null, then the
  // 7-challenge row beats the 2, then user_id breaks the rest.
  assert.deepEqual(sorted, [2, 3, 1, 4]);
});

test('standingOrderBy: one chain, shared by every surface that ranks a board', () => {
  assert.equal(standingOrderBy(),
    'standings_score DESC, event_success_rate DESC NULLS LAST, '
    + 'event_total_produced_blocks DESC, distinct_challenges DESC, user_id ASC');
});
