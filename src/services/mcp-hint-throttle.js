'use strict';

// Hosted MCP connector — throttle for the in-band "you can stop these
// permission prompts" setup tip.
//
// Its own module, and not inlined into services/mcp-tools.js, for the reason
// that module's header gives: no tool there touches the database directly,
// because a tool that did would be routing around the platform's own
// authorization. Every database read a tool needs goes through a service that
// owns that table — `whoami` reaches github-link the same way. This owns
// `mcp_connector_hints` and nothing else.
//
// Everything here is ADVISORY. The table gates no access, carries no user
// content, and a failed claim costs the caller a tip rather than a result.
//
// ── Why this was rewritten ─────────────────────────────────────────────
//
// The first version keyed "have we already shown this?" on the ACCESS TOKEN:
// a claim was refused when `last_token_id` matched the token making the call.
// The reasoning was that a token rotates roughly hourly, so a token is
// approximately a conversation. It is not. One token is shared by every
// conversation a client opens in that hour, so the FIRST hint-eligible read
// after connecting consumed the only slot and every conversation afterwards
// got nothing. Combined with a lifetime cap of three per grant and no reset
// path, a connection would go quiet permanently.
//
// In production it did exactly that: one row platform-wide, `shown_count` 1,
// written minutes after the feature shipped, and never again.
//
// The rekeyed version below stops guessing at "conversation" from a
// credential and instead takes the signal the protocol already gives us. A
// client sends `initialize` when it opens a session, so routes/mcp-remote.js
// ARMS the hint there (see armHint), and a claim is granted when the hint has
// been armed since it was last shown. Two bounds keep an armed hint from
// becoming a nag: a cooldown floor, and a rolling weekly budget.

const log = require('./logger');

// The budget, and the window it rolls over. Three showings is "the user saw
// it, and saw it again if they were busy the first time" — but per WEEK, not
// per grant forever. A lifetime cap on a 30-day-refresh grant is a permanent
// lockout with no reset path, which is what the first version shipped.
const MAX_SHOWS_PER_WINDOW = 3;
const HINT_WINDOW_DAYS = 7;
const HINT_WINDOW = `${HINT_WINDOW_DAYS} days`;

// Floor between two showings, independent of arming. Some clients send
// `initialize` more than once for what a human would call one conversation
// (a reconnect, a resumed session, a second tab), and without this floor each
// one would spend a slot and the tip would read as a nag.
const HINT_COOLDOWN_MINUTES = 10;
const HINT_COOLDOWN = `${HINT_COOLDOWN_MINUTES} minutes`;

// ── Arm ────────────────────────────────────────────────────────────────
//
// Called from the /mcp edge when the request body is an `initialize` — the
// one point in the protocol that means "a session is starting". Everything
// else the transport carries (tools/list, tools/call) happens inside a
// session that has already begun.
//
// It records intent only. Nothing is shown here: the tip rides on a read
// tool's result, and whether one runs at all is up to the model. So arming is
// cheap and idempotent, and a claim later decides whether the arm is spent.
//
// One statement. On a first `initialize` for a grant it inserts a row with
// `shown_count = 0`; on every later one it just moves `armed_at` forward.
//
// The `shown_count = 0` matters more than it looks: `last_shown_at` is
// `NOT NULL DEFAULT NOW()`, so a row created here looks like it was shown
// this instant, and a cooldown check alone would refuse the first claim for
// ten minutes. claimHintShow treats `shown_count = 0` as unconditionally
// claimable for exactly that reason, which is also why this must not be
// written as `shown_count = 1`.
async function armHint(pool, { grantId, userId }) {
  if (!pool || !grantId || !userId) return false;
  try {
    const { rows } = await pool.query(
      `INSERT INTO mcp_connector_hints (grant_id, user_id, shown_count, armed_at)
            VALUES ($1, $2, 0, NOW())
       ON CONFLICT (grant_id) DO UPDATE
               SET armed_at = NOW()
         RETURNING shown_count`,
      [String(grantId), userId]
    );
    return rows.length > 0;
  } catch (err) {
    // Advisory, like every other write here: a session that could not be
    // armed loses a tip, never a result. The caller is fire-and-forget.
    log.warn('mcp-hint-throttle', 'hint arm failed', { err: err.message });
    return false;
  }
}

// ── Claim ──────────────────────────────────────────────────────────────
//
// Claim the right to show the hint on THIS tool result. One atomic
// statement, so two reads racing on the same grant cannot both win it.
//
// Granted when the connection is armed and neither bound is spent:
//
//   * no row yet                    → insert, granted (a client that never
//                                     sent initialize through this build)
//   * shown_count = 0               → granted (armed and never shown; see
//                                     armHint on why the cooldown must not
//                                     apply to a row it just created)
//   * armed_at > last_shown_at      → granted (a new session has begun since
//                                     the last showing)
//   * last_shown_at older than the
//     cooldown                      → granted (a long-running session that
//                                     re-armed nothing still deserves one)
//   * otherwise                     → refused
//
// and in every case bounded by MAX_SHOWS_PER_WINDOW within the rolling
// HINT_WINDOW, whose start is rolled forward inside the same statement.
//
// Showing CONSUMES the arm (`armed_at = NULL`), so one initialize buys one
// showing rather than every read in the session.
//
// `last_token_id` survives as a diagnostic column only. It is written, never
// read by the guard: keying on it is precisely the bug this replaced.
async function claimHintShow(pool, { grantId, userId, tokenId }) {
  if (!pool || !grantId || !userId) return false;
  try {
    const { rows } = await pool.query(
      `INSERT INTO mcp_connector_hints
              (grant_id, user_id, shown_count, last_token_id, window_started_at)
            VALUES ($1, $2, 1, $3, NOW())
       ON CONFLICT (grant_id) DO UPDATE
               SET shown_count = CASE
                     WHEN mcp_connector_hints.window_started_at < NOW() - $4::interval
                     THEN 1
                     ELSE mcp_connector_hints.shown_count + 1
                   END,
                   window_started_at = CASE
                     WHEN mcp_connector_hints.window_started_at < NOW() - $4::interval
                     THEN NOW()
                     ELSE mcp_connector_hints.window_started_at
                   END,
                   last_token_id = EXCLUDED.last_token_id,
                   armed_at = NULL,
                   last_shown_at = NOW()
             WHERE (mcp_connector_hints.shown_count = 0
                    OR mcp_connector_hints.armed_at > mcp_connector_hints.last_shown_at
                    OR mcp_connector_hints.last_shown_at < NOW() - $5::interval)
               AND (mcp_connector_hints.window_started_at < NOW() - $4::interval
                    OR mcp_connector_hints.shown_count < $6)
         RETURNING shown_count`,
      [String(grantId), userId, tokenId == null ? null : tokenId,
        HINT_WINDOW, HINT_COOLDOWN, MAX_SHOWS_PER_WINDOW]
    );
    if (!rows.length) return false;
    // Logged at info, not warn: the first version logged only FAILURES, so a
    // hint that was never granted and a hint that was granted every time
    // looked identical in production and the bug above went unseen for as
    // long as it did. A grant is rare by construction — at most three per
    // connection per week — so this is not chatty.
    log.info('mcp-hint-throttle', 'setup hint shown', {
      grantId: String(grantId),
      shownCount: rows[0].shown_count,
    });
    return true;
  } catch (err) {
    // Same posture as the last_used_at update at the /mcp edge: a working
    // read must not become an error because a tip could not be booked.
    log.warn('mcp-hint-throttle', 'hint claim failed', { err: err.message });
    return false;
  }
}

// ── Status ─────────────────────────────────────────────────────────────
//
// What Settings → Connectors shows the user about the tip: whether it has
// been shown recently, and how much of this week's budget is left. READ
// ONLY, and deliberately so — the panel used to be specified with a "show it
// again" reset button, and a control that writes throttle state is a control
// that can be used to make the connector nag. Arming happens on initialize;
// opening a new chat is the reset.
//
// Aggregated over the caller's grants because the panel line is one line and
// a user has no mental model of a grant. `shownThisWindow` sums only rows
// whose window is still current, so a stale row from three weeks ago does not
// read as "you have used your budget".
async function getHintStatus(pool, { userId }) {
  const empty = {
    shownThisWindow: 0,
    lastShownAt: null,
    maxPerWindow: MAX_SHOWS_PER_WINDOW,
    windowDays: HINT_WINDOW_DAYS,
  };
  if (!pool || !userId) return empty;
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(CASE
                             WHEN window_started_at > NOW() - $2::interval
                             THEN shown_count ELSE 0
                           END), 0)::int                                AS shown_this_window,
              MAX(last_shown_at) FILTER (WHERE shown_count > 0)         AS last_shown_at
         FROM mcp_connector_hints
        WHERE user_id = $1`,
      [userId, HINT_WINDOW]
    );
    const row = rows[0] || {};
    return {
      ...empty,
      shownThisWindow: Number(row.shown_this_window) || 0,
      lastShownAt: row.last_shown_at ? new Date(row.last_shown_at).toISOString() : null,
    };
  } catch (err) {
    // The connector list is the point of that response; a status line that
    // could not be read must not take it down with it.
    log.warn('mcp-hint-throttle', 'hint status read failed', { err: err.message });
    return empty;
  }
}

module.exports = {
  armHint,
  claimHintShow,
  getHintStatus,
  MAX_SHOWS_PER_WINDOW,
  HINT_WINDOW,
  HINT_WINDOW_DAYS,
  HINT_COOLDOWN,
  HINT_COOLDOWN_MINUTES,
};
