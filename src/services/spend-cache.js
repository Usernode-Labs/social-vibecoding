'use strict';

// The LLM spend trackers' read-through cache, shared by both proxies.
//
// #2513 reported two defects in a block that was COPIED into
// routes/app-llm-proxy.js and routes/anthropic-proxy.js. THIS MODULE FIXES
// ONE OF THEM, and says plainly which.
//
// ── FIXED HERE: a database error removed the cap ───────────────────────
//
// Every refresher installed `totalAtCheckpointCents: 0` in its catch block —
// literally "no spend today" — and cached it for the full TTL. The log line
// said "failing open" and meant it. A Postgres blip therefore removed the
// spending limit rather than the traffic, for ten seconds at a time, on every
// replica independently, while the caller was free to spend as fast as they
// could issue calls.
//
// It now fails CLOSED:
//
//   - with a previous entry, keep its real numbers rather than inventing
//     zero, and retry after a second instead of a full window, so a blip
//     costs a little accuracy rather than the whole cap;
//   - with nothing known about this payer at all, report `Infinity`, so every
//     `spend >= cap` comparison refuses.
//
// The failure mode of failing closed is a 429 the caller retries. The failure
// mode of failing open is an unbounded bill. For a cap on real money that is
// not a close call.
//
// ── NOT FIXED HERE: the concurrency race ───────────────────────────────
//
// `liveDeltaCents` is incremented at SETTLEMENT, after a call finishes, so
// within one cache window concurrent requests still read the same pre-spend
// snapshot and can all pass a gate only one of them fits under.
//
// A reservation scheme was built for it and withdrawn before shipping,
// because review showed it was not sound admission control and would only
// have looked like it. Closing this properly needs all of:
//
//   - the reservation taken ATOMICALLY with the gate, not after the payer
//     and entitlement lookups that currently sit between them;
//   - a reservation SIZED to bound a real call, which needs a per-model cost
//     estimate — a flat cent still admits sixty calls against a $10 remainder;
//   - reservations that SURVIVE a refresh, which today replaces the entry
//     object and would silently drop anything in flight;
//   - the swap from reservation to real cost made BEFORE the awaited ledger
//     writes, not after, or there is a window with neither visible;
//   - the same treatment in anthropic-proxy.js, whose worker sessions race
//     the same way;
//   - a refusal BEFORE forwarding when a snapshot is unavailable, rather than
//     relying on the mid-stream kill.
//
// That is a design, not a patch, and half of one on a money path is worse
// than none because it reads like a guard.

const CACHE_TTL_MS = 10_000;

// After an error, how long before the next call re-attempts the query. Short,
// because a stale figure is a weaker cap and an unavailable one refuses
// traffic — neither is a state to sit in.
const RETRY_AFTER_ERROR_MS = 1_000;


// The total a gate compares against a cap: what the database knew, plus what
// has settled since. A missing entry refuses rather than reading as zero.
function spendTotal(entry) {
  if (!entry) return Number.POSITIVE_INFINITY;
  return entry.totalAtCheckpointCents + (entry.liveDeltaCents || 0);
}

// Is this entry a fail-closed placeholder rather than a real reading? Callers
// use it to log the difference between "at cap" and "we cannot tell".
function isUnavailable(entry) {
  return !entry || !Number.isFinite(entry.totalAtCheckpointCents);
}

function freshEntry(totalAtCheckpointCents, now) {
  return {
    totalAtCheckpointCents,
    fetchedAt: now,
    liveDeltaCents: 0,
  };
}

/**
 * Read-through with a TTL, failing CLOSED.
 *
 * `load()` returns the figure from the database. `previous` is whatever this
 * key held before, or undefined.
 */
async function readSpend({
  previous, load, now = Date.now(), ttlMs = CACHE_TTL_MS, onError,
}) {
  if (previous && now - previous.fetchedAt < ttlMs) return previous;
  try {
    return freshEntry(await load(), now);
  } catch (err) {
    if (onError) onError(err);
    // Retry sooner than a full TTL: backdating `fetchedAt` leaves the entry
    // fresh for only RETRY_AFTER_ERROR_MS more.
    const fetchedAt = now - ttlMs + RETRY_AFTER_ERROR_MS;
    if (previous) {
      // The last REAL numbers, including anything settled or reserved against
      // them. Keeping the cap approximately right beats resetting it to zero.
      return { ...previous, fetchedAt };
    }
    return {
      totalAtCheckpointCents: Number.POSITIVE_INFINITY,
      fetchedAt,
      liveDeltaCents: 0,
    };
  }
}



// Record what the call actually cost, against the checkpoint.
function settle(entry, cents) {
  if (!entry || !(cents > 0)) return;
  entry.liveDeltaCents = (entry.liveDeltaCents || 0) + cents;
}

/**
 * The fail-closed entry to install when a refresh threw.
 *
 * Kept separate from `readSpend` for the call sites that still own their own
 * try/catch — routes/anthropic-proxy.js has four, each with different query
 * shapes and log context — so they get the same posture without being
 * rewritten around a different control flow.
 */
function unavailable(previous, now = Date.now(), ttlMs = CACHE_TTL_MS) {
  const fetchedAt = now - ttlMs + RETRY_AFTER_ERROR_MS;
  if (previous && Number.isFinite(previous.totalAtCheckpointCents)) {
    return { ...previous, fetchedAt };
  }
  return {
    totalAtCheckpointCents: Number.POSITIVE_INFINITY,
    fetchedAt,
    liveDeltaCents: 0,
  };
}

module.exports = {
  readSpend,
  unavailable,
  spendTotal,
  isUnavailable,
  settle,
  CACHE_TTL_MS,
  RETRY_AFTER_ERROR_MS,
};
