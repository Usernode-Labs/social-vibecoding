// Append-only product-analytics event emitter.
//
// Writes rows into the `events` table (see schema.sql) that power the
// admin /dashboard growth, retention, and funnel views. Emission is
// deliberately fire-and-forget: a missed analytics row must NEVER break
// or slow down the user action that produced it, so `record()` swallows
// every error (logging at debug) and callers do not await it on the hot
// path — they invoke it and move on.
//
// Historical rows (everything that happened before these emitters
// shipped) are synthesized once by backfillEvents() in src/db/migrate.js,
// so the dashboard curves are continuous across the cutover.

const { getPool } = require('../db/pool');
const log = require('./logger');

// Canonical event vocabulary. Mirrored by the backfill in migrate.js and
// consumed by the funnel/growth/retention queries in routes/dashboard.js.
// Keep these three in sync when adding a new event type.
const EVENT_TYPES = Object.freeze({
  USER_SIGNED_UP: 'user_signed_up',
  DAPP_OPENED: 'dapp_opened',
  DAPP_ACTIVE_DAY: 'dapp_active_day',
  CHAT_MESSAGE_SENT: 'chat_message_sent',
  PR_VOTE_CAST: 'pr_vote_cast',
  PR_VOTE_RECEIVED: 'pr_vote_received',
  KUDOS_GIVEN: 'kudos_given',
  // Retraction of a previously given PR kudos (issue #197). Append-only
  // ledger: the original kudos_given row stays; any consumer netting
  // "kudos given" from raw events should subtract these. No backfill —
  // historical retractions don't exist by definition.
  KUDOS_RETRACTED: 'kudos_retracted',
  APP_FAVORITED: 'app_favorited',
  APP_CREATED: 'app_created',
  DEV_SESSION_STARTED: 'dev_session_started',
  PR_OPENED: 'pr_opened',
  PR_PROMOTED: 'pr_promoted',
  PR_MERGED: 'pr_merged',
  BOUNTY_CREATED: 'bounty_created',
  BOUNTY_AWARDED: 'bounty_awarded',
  COLLAB_INVITED: 'collab_invited',
  COLLAB_JOINED: 'collab_joined',
  VISIBILITY_CHANGED: 'visibility_changed',
  // Sync-with-main completed (issue: make sync emit session activity).
  // Attributed to the session owner (sync bills the owner), recorded on
  // the terminal path with { syncResult, behind, sha, pushOk, trigger }.
  SYNC_MAIN: 'sync_main',
});

// Record a single analytics event. Fire-and-forget — returns a promise
// that always resolves (never rejects), so callers can either ignore it
// or `.catch(() => {})` it without risk. Pass whichever of
// userId/appId/sessionId are known; all are optional. `metadata` is an
// arbitrary JSON-serializable object stored alongside the row.
//
// `poolOrConfig` accepts either an already-resolved pg Pool (the common
// case — routes already hold one) or a config object, from which the
// shared pool is looked up. This keeps call sites terse regardless of
// what they have in scope.
function record(poolOrConfig, { type, userId, appId, sessionId, metadata } = {}) {
  // Everything is wrapped so a missing pool, a synchronous throw, or a
  // mock pool that returns a non-promise can never escape into the
  // calling request handler. record() ALWAYS returns a resolved promise.
  try {
    if (!type) return Promise.resolve();
    const pool = resolvePool(poolOrConfig);
    const result = pool.query(
      `INSERT INTO events (user_id, app_id, session_id, event_type, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        userId ?? null,
        appId ?? null,
        sessionId ?? null,
        type,
        JSON.stringify(metadata || {}),
      ]
    );
    if (result && typeof result.then === 'function') {
      return result.then(() => {}).catch((err) => {
        log.debug('events', 'record failed', { type, err: err.message });
      });
    }
    return Promise.resolve();
  } catch (err) {
    // Never propagate — analytics is best-effort.
    log.debug('events', 'record skipped', { type, err: err && err.message });
    return Promise.resolve();
  }
}

// A pg Pool exposes `.query`; a config object does not. Disambiguate so
// callers can hand us either.
function resolvePool(poolOrConfig) {
  if (poolOrConfig && typeof poolOrConfig.query === 'function') {
    return poolOrConfig;
  }
  return getPool(poolOrConfig);
}

module.exports = { record, EVENT_TYPES };
