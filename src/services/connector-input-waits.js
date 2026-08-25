'use strict';

// #1405 path B — "my coding agent is waiting on me".
//
// ── Why the agent has to tell us ───────────────────────────────────────
//
// The platform sees MCP tool calls and nothing else. It cannot see the Claude
// Code conversation, so it cannot tell "waiting for the user" apart from "busy
// working", "session over" or "tab closed" — a coding agent routinely runs for
// many minutes without touching the connector at all. A silence-derived timer
// would therefore fire constantly and wrongly, which is why this module is
// driven by an explicit call from the agent instead.
//
// ── Why it is delayed, not immediate ───────────────────────────────────
//
// If you are at the keyboard you answer in seconds and a push is pure noise.
// So arming records an INTENT to notify at `notify_at`, and `sweepDue` only
// fires rows still live when their moment arrives. Answering promptly clears
// it long before that.
//
// ── The failure this design cannot prevent, and how it is bounded ──────
//
// Clearing depends on the agent calling back after the user replies, and an
// agent may simply forget. Three things keep that cheap:
//
//   1. ONE-SHOT. `fired_at` is stamped on send and a fired row is never
//      reconsidered, so a forgotten clear costs one stray notification rather
//      than a repeating alarm.
//   2. ANY connector call clears (see clearForUser's caller in mcp-tools).
//      Free, and it catches every session where the agent happens to call
//      something. It is a supplement and NOT the mechanism: an agent can reply
//      and then work silently for twenty minutes, which is exactly why the
//      explicit clear still has to exist.
//   3. The COPY never claims you are currently being waited on — it says when
//      the question was asked (see services/mobile-push-policy.js). A stale
//      notification is then a redundancy rather than a false statement.
//
// ── At most one live wait per user ─────────────────────────────────────
//
// Enforced by a partial unique index in schema.sql, and honoured here by
// superseding: arming clears any live row first. Two sessions both waiting on
// one person still only needs telling them once that something wants them.

const log = require('./logger');

// How long a wait sits before it is worth interrupting somebody over.
//
// Two minutes was the first instinct and is too short: the common path is
// "answered in thirty seconds, then the agent worked silently", which a
// two-minute timer turns into a stray push almost every turn. Ten is long
// enough that being at the keyboard clears it naturally and still catches a
// genuine walk-away quickly.
const DEFAULT_DELAY_MS = 10 * 60 * 1000;
const MIN_DELAY_MS = 60 * 1000;
const MAX_DELAY_MS = 2 * 60 * 60 * 1000;

// How often the sweeper looks. Well under the delay, so the notification lands
// close to the moment it was scheduled for rather than up to a tick late.
const SWEEP_INTERVAL_MS = 60 * 1000;

// The agent's own words, stored so the record says what you were actually
// asked. Bounded because it reaches a database column and, eventually, a
// screen.
const QUESTION_MAX = 2000;

function resolveDelayMs(requested) {
  const raw = Number(requested);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_DELAY_MS;
  return Math.min(Math.max(Math.round(raw), MIN_DELAY_MS), MAX_DELAY_MS);
}

/**
 * Arm a wait for this user, superseding any live one.
 *
 * The clear and the insert are one statement each rather than a transaction:
 * the partial unique index makes the pair safe under a race (the loser's
 * insert fails, and a failed arming is a missing notification, not corruption),
 * and holding a transaction open across them buys nothing this needs.
 */
async function arm(pool, { userId, slug, question, clientId, delayMs }) {
  if (!userId) return null;
  const ms = resolveDelayMs(delayMs);

  // Resolved HERE rather than in the tool handler: services/mcp-tools.js is
  // contractually free of raw `pool.query(` — its handlers delegate, so that
  // every gate and every query lives in one implementation rather than two.
  // A slug that names nothing is not an error; the wait simply has no app.
  let appId = null;
  if (slug) {
    try {
      const { rows } = await pool.query('SELECT id FROM apps WHERE slug = $1', [String(slug)]);
      appId = rows[0] ? rows[0].id : null;
    } catch { appId = null; }
  }

  // Read before the clear replaces it: an agent that armed twice without
  // standing the first one down is worth telling, and afterwards the evidence
  // is gone.
  const superseded = await hasLiveWait(pool, userId);

  await clearForUser(pool, userId, 'superseded');
  const { rows } = await pool.query(
    `INSERT INTO connector_input_waits
       (user_id, app_id, question, client_id, notify_at)
     VALUES ($1, $2, $3, $4, NOW() + ($5::bigint * INTERVAL '1 millisecond'))
     RETURNING id, user_id, app_id, question, armed_at, notify_at`,
    [userId, appId, String(question || '').slice(0, QUESTION_MAX), clientId || null, ms]
  );
  const row = rows[0] || null;
  return row ? { ...row, superseded } : null;
}

/** Whether this user has a wait armed and neither cleared nor fired. */
async function hasLiveWait(pool, userId) {
  if (!userId) return false;
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM connector_input_waits
        WHERE user_id = $1 AND cleared_at IS NULL AND fired_at IS NULL LIMIT 1`,
      [userId]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Clear this user's live wait, if any. Idempotent and cheap enough to call on
 * every connector request.
 *
 * Returns the number of rows cleared, so a caller can tell "there was one" from
 * "there was nothing" without a second read — the explicit clear tool reports
 * that back to the agent.
 */
async function clearForUser(pool, userId, _reason) {
  if (!userId) return 0;
  const { rowCount } = await pool.query(
    `UPDATE connector_input_waits
        SET cleared_at = NOW()
      WHERE user_id = $1 AND cleared_at IS NULL AND fired_at IS NULL`,
    [userId]
  );
  return rowCount || 0;
}

/**
 * Fire every wait whose moment has come.
 *
 * `fired_at` is stamped in the SAME statement that selects the row, so two
 * overlapping sweeps cannot both send one wait — the second finds nothing. The
 * notification is created afterwards, which means a crash between the stamp and
 * the insert loses a notification rather than duplicating one. That is the
 * right way round for something whose whole job is to not be annoying.
 */
async function sweepDue(pool, deps = {}) {
  const notifications = deps.notifications || require('./notifications');
  let due = [];
  try {
    const { rows } = await pool.query(
      `UPDATE connector_input_waits
          SET fired_at = NOW()
        WHERE id IN (
          SELECT id FROM connector_input_waits
           WHERE cleared_at IS NULL AND fired_at IS NULL AND notify_at <= NOW()
           ORDER BY notify_at ASC
           LIMIT 100
        )
        RETURNING id, user_id, app_id, armed_at`
    );
    due = rows;
  } catch (err) {
    log.warn('connector-input-waits', 'sweep query failed', { err: err.message });
    return 0;
  }

  let sent = 0;
  for (const row of due) {
    try {
      const created = await notifications.createAgentAwaitingInputNotification(pool, {
        userId: row.user_id, appId: row.app_id,
      });
      if (created.length) {
        await notifications.hydrateAndPush(pool, created[0]);
        sent += 1;
      }
    } catch (err) {
      // The row is already stamped fired, so this one is simply lost. Never
      // throw: one user's dead push must not stop the rest of the sweep.
      log.warn('connector-input-waits', 'notify failed', { waitId: row.id, err: err.message });
    }
  }
  return sent;
}

let intervalHandle = null;

function start(config, deps = {}) {
  if (intervalHandle) return;
  const pool = deps.pool || require('../db/pool').getPool();
  intervalHandle = setInterval(() => {
    sweepDue(pool, deps).catch((err) => {
      log.warn('connector-input-waits', 'sweep failed', { err: err.message });
    });
  }, SWEEP_INTERVAL_MS);
  intervalHandle.unref?.();
}

function stop() {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
}

module.exports = {
  arm,
  hasLiveWait,
  clearForUser,
  sweepDue,
  start,
  stop,
  resolveDelayMs,
  DEFAULT_DELAY_MS,
  MIN_DELAY_MS,
  MAX_DELAY_MS,
  SWEEP_INTERVAL_MS,
  QUESTION_MAX,
};
