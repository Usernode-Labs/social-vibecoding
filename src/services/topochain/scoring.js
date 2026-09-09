// Topochain snapshot builder — pure scoring functions (no DB, no I/O).
//
// A Node port of the arithmetic inside the source system's
// LeaderboardAggregationService ("epoch_average_v2"): fractional epoch
// weights over a challenge window, per-epoch produced/won ratios,
// delegation multipliers, and the rate → points formula, plus the
// offchain column arithmetic the admin refresh-totals route applies —
// extracted here so the builder and that route share ONE copy and can
// never diverge (the source system states the same invariant for its
// refresh path).
//
// Everything here is deterministic over plain data; the DB-facing
// orchestration lives in snapshot-builder.js.
'use strict';

const DEFAULT_EPOCH_DURATION_MS = 24 * 60 * 60 * 1000; // 86400s

// produced/won for one epoch, capped at 1. Zero when no slots were won
// (or inputs are missing): an epoch you couldn't produce in scores 0,
// it is never skipped — that is what makes the average an average over
// EXPECTED epochs, not observed ones.
function epochRatio(produced, won) {
  const w = Number(won) || 0;
  if (w <= 0) return 0;
  const p = Number(produced) || 0;
  return Math.min(p / w, 1);
}

// Reconstruct wall-clock epoch boundaries from observed slot timing:
// each epoch starts at its first observed slot time; it ends where the
// next epoch starts; the final end is projected forward by the mean
// per-epoch duration (default 86400s when there is only one
// observation). With `fillRange: { startEpoch, endEpoch }`, epochs the
// telemetry never observed are filled in too — interpolated inside
// observed gaps, extrapolated at the mean duration before the first and
// after the last observation — so the builder's K stays the FULL event
// window even when only part of it has been produced yet (the source
// system projects future epochs the same way). Without any observation
// at all the map stays empty: that is the no-timing mode every consumer
// treats as "weight 1 per epoch, delegation never guessed".
// `rows` = [{ epoch, first_slot_time_ms }], any order.
// Returns Map(epoch → { startMs, endMs }).
function reconstructEpochBoundaries(rows, { defaultDurationMs = DEFAULT_EPOCH_DURATION_MS, fillRange = null } = {}) {
  const sorted = [...rows]
    .map((r) => ({ epoch: Number(r.epoch), startMs: Number(r.first_slot_time_ms) }))
    .filter((r) => Number.isFinite(r.epoch) && Number.isFinite(r.startMs))
    .sort((a, b) => a.epoch - b.epoch);

  const boundaries = new Map();
  if (!sorted.length) return boundaries;

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const meanDuration = last.epoch > first.epoch
    ? (last.startMs - first.startMs) / (last.epoch - first.epoch)
    : defaultDurationMs;
  // Degenerate telemetry (a batch stamping several epochs with one slot
  // time, or clock skew inverting them) would make every span
  // zero/negative-length and silently zero all block points downstream —
  // fall back to no-timing mode instead.
  if (!(meanDuration > 0)) return boundaries;

  // The epochs to emit: the observed ones, plus every epoch of fillRange.
  const epochs = new Set(sorted.map((r) => r.epoch));
  if (fillRange) {
    const s = Number(fillRange.startEpoch);
    const e = Number(fillRange.endEpoch);
    if (Number.isFinite(s) && Number.isFinite(e)) {
      for (let epoch = s; epoch <= e; epoch += 1) epochs.add(epoch);
    }
  }

  const startFor = (epoch) => {
    if (epoch <= first.epoch) return first.startMs - (first.epoch - epoch) * meanDuration;
    if (epoch >= last.epoch) return last.startMs + (epoch - last.epoch) * meanDuration;
    // Interior: interpolate between the observed neighbours evenly.
    let lo = first;
    let hi = last;
    for (const o of sorted) {
      if (o.epoch <= epoch) lo = o;
      if (o.epoch >= epoch) { hi = o; break; }
    }
    if (lo.epoch === epoch) return lo.startMs;
    const perEpoch = (hi.startMs - lo.startMs) / (hi.epoch - lo.epoch);
    return lo.startMs + (epoch - lo.epoch) * perEpoch;
  };

  const ordered = [...epochs].sort((a, b) => a - b);
  const starts = ordered.map((epoch) => ({ epoch, startMs: startFor(epoch) }));
  for (let i = 0; i < starts.length; i += 1) {
    const endMs = i + 1 < starts.length ? starts[i + 1].startMs : starts[i].startMs + meanDuration;
    boundaries.set(starts[i].epoch, { startMs: starts[i].startMs, endMs });
  }
  return boundaries;
}

// Weight each epoch in [startEpoch, endEpoch] (the event's hard cap —
// epochs outside it are never weighted, no matter what the challenge
// schedule says) by its overlap with the challenge window:
//   weight_e = overlap(epoch span, schedule span) / epoch duration ∈ [0, 1]
// With no timing data at all the schedule cannot be mapped to epochs, so
// every in-window epoch weighs 1 (whole-window scoring). A null schedule
// bound means "unbounded" on that side. K = max(Σ weights, 1).
function computeEpochWeights({ startEpoch, endEpoch, boundaries, scheduleStartMs = null, scheduleEndMs = null }) {
  const weights = new Map();
  const s = Number(startEpoch);
  const e = Number(endEpoch);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return { weights, K: 1 };

  const hasTiming = boundaries instanceof Map && boundaries.size > 0;
  let sum = 0;
  for (let epoch = s; epoch <= e; epoch += 1) {
    let w;
    if (!hasTiming) {
      w = 1;
    } else {
      const span = boundaries.get(epoch);
      if (!span || !(span.endMs > span.startMs)) continue;
      const lo = scheduleStartMs === null ? span.startMs : Math.max(span.startMs, scheduleStartMs);
      const hi = scheduleEndMs === null ? span.endMs : Math.min(span.endMs, scheduleEndMs);
      w = Math.max(0, hi - lo) / (span.endMs - span.startMs);
      if (w <= 0) continue;
    }
    weights.set(epoch, w);
    sum += w;
  }
  return { weights, K: Math.max(sum, 1) };
}

// Before the immutable cutover C, timestamp history decides delegation by an
// epoch's reconstructed start time. At and after C, only the epoch ledger is
// authoritative; legacy periods are not consulted even if malformed history
// overlaps the boundary. `epochDelegated` is Map(epoch -> boolean).
function delegationMultipliers({
  epochs, boundaries, periods, cutoverEpoch = null, epochDelegated = new Map(),
}) {
  const mults = new Map();
  const hasTiming = boundaries instanceof Map && boundaries.size > 0;
  for (const epoch of epochs) {
    let m = 1;
    if (cutoverEpoch !== null && epoch >= cutoverEpoch) {
      if (epochDelegated.get(epoch) === true) m = 0.5;
    } else if (hasTiming) {
      const span = boundaries.get(epoch);
      if (span) {
        const delegated = (periods || []).some((p) => {
          const from = Number(p.startedAtMs);
          const to = p.endedAtMs === null || p.endedAtMs === undefined ? Infinity : Number(p.endedAtMs);
          return from <= span.startMs && span.startMs < to;
        });
        if (delegated) m = 0.5;
      }
    }
    mults.set(epoch, m);
  }
  return mults;
}

const round2 = (n) => Math.round(n * 100) / 100;

// The epoch-average v2 formula. `ratios` and `multipliers` are
// Map(epoch → value); an epoch absent from `ratios` contributes 0, one
// absent from `multipliers` contributes at full value (mult 1). Epochs
// carrying no weight never contribute, whatever the ratio says.
//   rate       = min(Σ ratio·w / K, 1) · 100      (displayed completion %)
//   pointsRate = min(Σ ratio·w·mult / K, 1) · 100
//   points     = round(basePoints · pointsRate / 100, 2)
//   pointsMultiplier = pointsRate / rate           (1 when rate is 0)
function computeChallengeScore({ weights, K, ratios, multipliers, basePoints }) {
  let weightedSum = 0;
  let pointsWeightedSum = 0;
  for (const [epoch, w] of weights) {
    const ratio = ratios.get(epoch) || 0;
    if (!ratio) continue;
    const mult = multipliers.has(epoch) ? multipliers.get(epoch) : 1;
    weightedSum += ratio * w;
    pointsWeightedSum += ratio * w * mult;
  }
  const k = Math.max(Number(K) || 0, 1);
  const rate = Math.min(weightedSum / k, 1) * 100;
  const pointsRate = Math.min(pointsWeightedSum / k, 1) * 100;
  return {
    rate,
    pointsRate,
    points: round2((Number(basePoints) || 0) * (pointsRate / 100)),
    pointsMultiplier: rate > 0 ? pointsRate / rate : 1,
  };
}

// The offchain weight as both write paths must read it off
// season_events.scoring_formula: missing/NaN → 0 (a weightless event
// scores no offchain points, it never errors).
function resolveOffchainWeight(scoringFormula) {
  return Number(scoringFormula?.offchain_weight) || 0;
}

// The admin refresh-totals arithmetic, verbatim (see the route's own
// JUDGMENT CALL comment for which snapshot columns count as
// offchain-derived): the six INTEGER category columns each round their
// weighted per-type sum to a whole number; `extra_points` rounds the
// weighted sum over EVERY activity_type to 2 decimals.
function computeOffchainColumns(byType, offchainWeight) {
  const w = Number(offchainWeight) || 0;
  const totalAll = Object.values(byType || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  const per = (type) => Math.round((Number(byType?.[type]) || 0) * w);
  return {
    extra_points: round2(totalAll * w),
    bug_report_points: per('bug_report'),
    inviting_new_participant_points: per('inviting_new_participant'),
    community_contribution_points: per('community_contribution'),
    first_block_points: per('first_block'),
    top_3_points: per('top_3'),
    success_50_percent_points: per('success_50_percent'),
  };
}

module.exports = {
  DEFAULT_EPOCH_DURATION_MS,
  round2,
  resolveOffchainWeight,
  epochRatio,
  reconstructEpochBoundaries,
  computeEpochWeights,
  delegationMultipliers,
  computeChallengeScore,
  computeOffchainColumns,
};
