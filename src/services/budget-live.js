'use strict';

// #2598: push the weekly credit figure while the agent is still running.
//
// ── What was wrong ────────────────────────────────────────────────────
//
// "$x left this week" was a REFETCH, and only ever a refetch. The composer's
// meter re-read /api/budget when a turn ENDED (public/js/app.js calls
// DevChat.refreshBudget on the billing-switch notice, and dev-chat.js calls it
// when a session opens or a key is saved); the header drawer's AI-credit row
// re-read /api/me/ai-budget when the drawer opened, throttled to three
// minutes. So the one figure a builder watches while an agent burns their
// allowance moved only after the agent had finished burning it — which is
// what request #2598 reported, from the OpenRouter side where the gap is
// longest.
//
// ── What happens instead ──────────────────────────────────────────────
//
// Every place a model call's cost is recorded against the account's weekly
// pool calls notifySpend(). One `budget_updated` event carrying the whole
// budget snapshot goes out over the per-user socket ws.pushToUser already
// opens for @mentions and private session state, and both meters re-render
// from the pushed figures. No new route, no poll, no refetch.
//
// The recording sites, and what each one's cadence buys:
//   - routes/anthropic-proxy.js, per model call. The Claude coding agent's
//     calls all pass through that proxy, so this is the "ticks every few
//     seconds during a build" case.
//   - limits.recordSpend, per ledger write. That is the included OpenRouter
//     key's venue (routes/sessions.js sharedPoolCodexSpend debits through it
//     for direct replies, scouts and builds alike), plus every other spend
//     site the ledger has.
//   - limits.settleTurnSpend's durable path, once its receipt commits.
//
// ── Why it is coalesced, not one event per call ───────────────────────
//
// A build makes a model call every few seconds and each one lands here. A
// snapshot per call would be a snapshot READ per call (two queries) and a
// NOTIFY per call, to repaint a figure that moved by a fraction of a cent.
// So a user's pushes are coalesced into a window: the FIRST fires
// immediately — the meter has to move on the first call, not a window
// later — and everything arriving inside the window after it collapses into
// one trailing push. A burst of calls repaints once.
//
// ── What is not faked ─────────────────────────────────────────────────
//
// Tokens still in flight are not priced. Every figure published here comes
// from a call that has already RETURNED: either the ledger's own week-to-date
// sum, or — mid-turn, before the turn's receipt is written — the Anthropic
// proxy's running total, which is the same checkpoint+delta arithmetic its
// mid-stream kill gate refuses a turn on. Nothing is extrapolated from a
// partial response, and `live: true` on the payload says which of the two a
// reader is holding.

const log = require('./logger');

// Long enough that a chatty build coalesces, short enough that the figure
// reads as live. A model call takes seconds; this bounds the push rate to
// roughly one a second per user, not one per call.
const COALESCE_WINDOW_MS = 1000;

// userId -> { pool, timer, expiry, lastSentAt, liveWeeklySpentCents }
// Only users who have spent something inside the last window are in here:
// each entry deletes itself a window after its last push (see `arm`).
const pending = new Map();

// The two collaborators, resolved lazily and through one object.
//   Lazily, because services/limits.js requires THIS module — a top-level
//   require back into it would be a cycle — and because services/ws.js
//   pulls in the socket server, which a unit test has no business booting.
//   Through one object, so a test can observe what would be pushed. Exposed
//   as `_deps` below for exactly that, and for nothing else.
const deps = {
  readSnapshot: (pool, userId) => require('./limits').getBudgetSnapshot(pool, userId),
  push: (userId, payload) => require('./ws').pushToUser(userId, payload),
};

function validUserId(userId) {
  const id = Number(userId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// The snapshot both meters read, with the in-flight turn folded in when the
// caller knows about one the ledger does not.
async function buildPayload(pool, userId, liveWeeklySpentCents) {
  const snapshot = await deps.readSnapshot(pool, userId);
  if (!snapshot || typeof snapshot !== 'object') return null;
  const live = Number(liveWeeklySpentCents);
  const settled = Number(snapshot.weeklySpentCents) || 0;
  // Take the live figure only when it is AHEAD of the ledger. The proxy's
  // tracker resets its delta on every checkpoint refresh, so a stale one is
  // BEHIND the settled sum — and a meter that walks backwards mid-turn reads
  // as a bug whichever number is the honest one.
  if (!Number.isFinite(live) || !(live > settled)) {
    return { ...snapshot, live: false };
  }
  const limitCents = Number(snapshot.limitCents) || 0;
  return {
    ...snapshot,
    // limits.getBudgetSnapshot reports the week in all three of these
    // (#2571), so all three move together or the meter states two different
    // weeks side by side.
    spentCents: live,
    weeklySpentCents: live,
    remainingCents: limitCents > 0 ? Math.max(0, limitCents - live) : 0,
    live: true,
  };
}

async function publish(pool, userId, { liveWeeklySpentCents = null } = {}) {
  const id = validUserId(userId);
  if (!id || !pool) return null;
  let payload = null;
  try {
    payload = await buildPayload(pool, id, liveWeeklySpentCents);
  } catch (err) {
    // A display read must never be what breaks the turn that paid for it —
    // the same tolerance every other reader of this ledger has. The meter
    // keeps its last figure and the turn-end refetch still repairs it.
    log.warn('budget-live', 'budget snapshot read failed; no push', {
      userId: id, err: err.message,
    });
    return null;
  }
  if (!payload) return null;
  try {
    deps.push(id, { type: 'budget_updated', budget: payload });
  } catch (err) {
    log.warn('budget-live', 'budget push failed', { userId: id, err: err.message });
  }
  return payload;
}

function clearTimers(entry) {
  if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
  if (entry.expiry) { clearTimeout(entry.expiry); entry.expiry = null; }
}

function unref(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

function flush(userId) {
  const id = validUserId(userId);
  const entry = id && pending.get(id);
  if (!entry) return null;
  clearTimers(entry);
  entry.lastSentAt = Date.now();
  const live = entry.liveWeeklySpentCents;
  entry.liveWeeklySpentCents = null;
  // Forget this user a window after their last push. Until then the entry is
  // what makes the NEXT call coalesce instead of firing immediately, so it
  // cannot be dropped straight away; after then it is only a timestamp, and
  // an unbounded map of them is a leak on a busy instance.
  entry.expiry = unref(setTimeout(() => {
    const current = pending.get(id);
    if (current && !current.timer) pending.delete(id);
  }, COALESCE_WINDOW_MS));
  return publish(entry.pool, id, { liveWeeklySpentCents: live });
}

// Call this wherever a model call's cost lands against the weekly pool. Never
// await it: a push must not add latency to the turn that paid for it, and
// every failure inside is already swallowed and logged. Returns the in-flight
// send when this call fired one (the leading edge), null when it was folded
// into a pending window.
function notifySpend(pool, userId, { liveWeeklySpentCents = null } = {}) {
  const id = validUserId(userId);
  if (!id || !pool) return null;
  let entry = pending.get(id);
  if (!entry) {
    entry = { pool, timer: null, expiry: null, lastSentAt: 0, liveWeeklySpentCents: null };
    pending.set(id, entry);
  }
  entry.pool = pool;
  // Two sites can offer a live figure inside one window (a proxy call and the
  // turn's own receipt). A turn's running total only grows, so the largest is
  // the latest.
  const live = Number(liveWeeklySpentCents);
  if (Number.isFinite(live) && live > 0) {
    entry.liveWeeklySpentCents = Math.max(entry.liveWeeklySpentCents || 0, live);
  }
  if (entry.timer) return null; // already coalescing into a trailing push
  const since = Date.now() - entry.lastSentAt;
  if (since >= COALESCE_WINDOW_MS) return flush(id);
  if (entry.expiry) { clearTimeout(entry.expiry); entry.expiry = null; }
  entry.timer = unref(setTimeout(() => flush(id), COALESCE_WINDOW_MS - since));
  return null;
}

// Test-only: drop every coalescing window so one test's burst cannot leak
// into the next one's leading edge.
function _reset() {
  for (const entry of pending.values()) clearTimers(entry);
  pending.clear();
}

module.exports = {
  notifySpend,
  publish,
  COALESCE_WINDOW_MS,
  // Test seams — see the `deps` comment above. Not for production callers.
  _deps: deps,
  _flush: flush,
  _reset,
  _pending: pending,
};
