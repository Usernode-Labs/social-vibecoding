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
