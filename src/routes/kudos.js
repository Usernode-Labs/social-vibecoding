const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const ws = require('../services/ws');

// Weekly quota per giver. The plan locks this at 5; if it ever moves,
// tweak here and the FE budget badge will pick it up via /api/me/kudos-budget.
const WEEKLY_KUDOS_LIMIT = 5;

// PR states that can receive a kudos. Promoted (open vote) + merging
// (in-flight merge) + merged (landed). Active drafts and paused
// sessions are out — kudos is a "thanks for putting this up for review"
// signal, not encouragement on private work.
const ELIGIBLE_STATES = ['promoted', 'merging', 'merged'];

// Compute the Monday-00:00-UTC date that contains the given Date.
// Mirror of Postgres's `date_trunc('week', t AT TIME ZONE 'UTC')::DATE`
// for that same instant. JS getUTCDay() returns 0..6 with Sunday=0; we
// shift so Monday=0 and subtract that many days from the UTC date.
//
// Returned as a `YYYY-MM-DD` string so it slots straight into pg DATE
// parameters without timezone-edge surprises (pg would otherwise
// re-interpret a JS Date in the connection's TZ).
function weekStartUtc(date = new Date()) {
  const utcMidnight = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  ));
  const day = utcMidnight.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  utcMidnight.setUTCDate(utcMidnight.getUTCDate() - daysSinceMonday);
  const y = utcMidnight.getUTCFullYear();
  const m = String(utcMidnight.getUTCMonth() + 1).padStart(2, '0');
  const d = String(utcMidnight.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Single round-trip count of kudos this user has given in the current
// week bucket. Uses the (giver_user_id, week_start) index. Returns the
// number; never null.
async function countKudosGivenThisWeek(pool, userId, weekStart) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM pr_kudos
       WHERE giver_user_id = $1 AND week_start = $2`,
    [userId, weekStart]
  );
  return rows[0]?.c || 0;
}

// Fetch the kudos count + giver usernames + my_kudos flag for a
// session. Used both by `GET /api/sessions/:id/kudos` and by the
// in-line subqueries on /promoted and /merged (though those use
// COUNT(*) directly for performance — the full giver list only
// loads when the hover popover requests it).
async function loadKudosForSession(pool, sessionId, viewerUserId) {
  const { rows } = await pool.query(
    `SELECT pk.created_at, u.username, u.id AS user_id
       FROM pr_kudos pk
       JOIN users u ON u.id = pk.giver_user_id
       WHERE pk.session_id = $1
       ORDER BY pk.created_at ASC`,
    [sessionId]
  );
  const count = rows.length;
  const myKudos = viewerUserId
    ? rows.some((r) => r.user_id === viewerUserId)
    : false;
  const givers = rows.map((r) => ({
    username: r.username,
    createdAt: r.created_at,
  }));
  return { count, givers, my_kudos: myKudos };
}

function kudosRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // --------------------------------------------------------------
  // POST /api/sessions/:id/kudos — give a kudos.
  //
  // Status codes:
  //   200 ok           — kudos recorded
  //   401 unauth       — handled by authMiddleware upstream
  //   404 not_found    — session doesn't exist, OR is in an ineligible
  //                       state (active / paused / archived). We use 404
  //                       not 403 because from the user's perspective
  //                       "no PR to vote on here" is the right framing.
  //   403 forbidden    — would be self-kudos (author == giver)
  //   409 conflict     — already gave kudos to this PR
  //   429 too_many     — weekly quota exceeded
  // --------------------------------------------------------------
  router.post('/api/sessions/:id/kudos', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const sessionId = parseInt(req.params.id, 10);
    if (!Number.isFinite(sessionId)) {
      return res.status(400).json({ error: 'Invalid session id' });
    }

    try {
      // Fetch the session + app context in one query so the broadcast
      // payload below has appSlug without a second round-trip.
      const { rows: sessionRows } = await pool.query(
        `SELECT cs.id, cs.user_id, cs.status, cs.pr_number, cs.pr_title,
                cs.app_id, a.slug AS app_slug, a.name AS app_name
           FROM chat_sessions cs
           JOIN apps a ON a.id = cs.app_id
           WHERE cs.id = $1`,
        [sessionId]
      );
      if (!sessionRows.length) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const session = sessionRows[0];

      if (!ELIGIBLE_STATES.includes(session.status)) {
        return res.status(404).json({
          error: `Kudos can only be given on promoted, merging, or merged PRs (this PR is "${session.status}")`,
        });
      }

      // session.user_id can be NULL if the original author was deleted
      // (chat_sessions.user_id has ON DELETE SET NULL). Treat as
      // "no self-kudos to worry about" — the kudos still attaches to
      // the session and shows up in the PR leaderboard; it just won't
      // credit anyone in the user leaderboard, which already filters
      // out NULL authors.
      if (session.user_id && session.user_id === req.user.id) {
        return res.status(403).json({ error: 'Cannot give kudos to your own PR' });
      }

      const weekStart = weekStartUtc();

      // Quota check. Race window: two parallel POSTs from the same
      // user could both pass this check and both insert, allowing a
      // single user to overshoot the cap by at most 1 across N
      // parallel requests. Bounded, rare, not security-critical; the
      // alternative is a per-user advisory lock which adds complexity
      // for a near-zero-impact race. Documented in the plan.
      const given = await countKudosGivenThisWeek(pool, req.user.id, weekStart);
      if (given >= WEEKLY_KUDOS_LIMIT) {
        return res.status(429).json({
          error: `Weekly kudos quota exceeded (${WEEKLY_KUDOS_LIMIT}/week). Resets every Monday 00:00 UTC.`,
          remaining: 0,
          limit: WEEKLY_KUDOS_LIMIT,
        });
      }

      // Insert. UNIQUE(session_id, giver_user_id) handles the dupe
      // case; we surface that as 409 rather than letting the generic
      // 500 handler eat it.
      let inserted;
      try {
        const { rows: insertRows } = await pool.query(
          `INSERT INTO pr_kudos (session_id, giver_user_id, week_start)
           VALUES ($1, $2, $3)
           RETURNING id, created_at`,
          [sessionId, req.user.id, weekStart]
        );
        inserted = insertRows[0];
      } catch (err) {
        // Postgres unique_violation
        if (err.code === '23505') {
          return res.status(409).json({ error: 'Already gave kudos to this PR' });
        }
        throw err;
      }

      // Notification for the PR author (skip if no author or self —
      // the self case is already 403'd above, but guard anyway).
      if (session.user_id && session.user_id !== req.user.id) {
        try {
          const { rows: notifRows } = await pool.query(
            `INSERT INTO notifications
               (user_id, app_id, session_id, source_user_id, kind)
             VALUES ($1, $2, $3, $4, 'kudos')
             RETURNING id, user_id, app_id, session_id, source_user_id, kind, created_at, read_at`,
            [session.user_id, session.app_id, sessionId, req.user.id]
          );
          if (notifRows.length) {
            // Hydrate with app/sender/session info so the client
            // dropdown renders immediately without another fetch.
            // Same shape that listForUser → serialize produces for
            // history loads.
            const { rows: hydrated } = await pool.query(
              `SELECT n.id, n.kind, n.read_at, n.created_at,
                      n.app_id, a.slug AS app_slug, a.name AS app_name,
                      n.chat_message_id, NULL AS message_content,
                      n.session_id, cs.pr_title, cs.pr_number,
                      su.username AS source_username, n.user_id
                 FROM notifications n
                 LEFT JOIN apps a ON a.id = n.app_id
                 LEFT JOIN chat_sessions cs ON cs.id = n.session_id
                 LEFT JOIN users su ON su.id = n.source_user_id
                 WHERE n.id = $1`,
              [notifRows[0].id]
            );
            if (hydrated.length) {
              const notifications = require('../services/notifications');
              ws.pushNotificationToUser(session.user_id, {
                type: 'notification_new',
                notification: notifications.serialize(hydrated[0]),
              });
            }
          }
        } catch (err) {
          // Notification is best-effort — never fail the kudos itself.
          log.warn('kudos', 'notification emit failed', {
            sessionId, giver: req.user.id, err: err.message,
          });
        }
      }

      // Broadcast updated count so any open PR card and the leaderboard
      // re-render in place.
      try {
        const { rows: countRows } = await pool.query(
          `SELECT COUNT(*)::int AS c FROM pr_kudos WHERE session_id = $1`,
          [sessionId]
        );
        ws.pushKudosUpdate({
          sessionId,
          appSlug: session.app_slug,
          count: countRows[0]?.c || 0,
          giverUsername: req.user.username,
        });
      } catch (err) {
        log.warn('kudos', 'broadcast failed', { sessionId, err: err.message });
      }

      const remaining = Math.max(0, WEEKLY_KUDOS_LIMIT - (given + 1));
      log.info('kudos', 'kudos given', {
        sessionId, giverId: req.user.id, weekStart, remaining,
      });
      res.json({ ok: true, kudosId: inserted.id, remaining, limit: WEEKLY_KUDOS_LIMIT });
    } catch (err) {
      log.error('kudos', 'give failed', { sessionId, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // --------------------------------------------------------------
  // GET /api/sessions/:id/kudos — count + giver list for hover popover.
  // --------------------------------------------------------------
  router.get('/api/sessions/:id/kudos', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const sessionId = parseInt(req.params.id, 10);
    if (!Number.isFinite(sessionId)) {
      return res.status(400).json({ error: 'Invalid session id' });
    }
    try {
      // Defensive existence check so we 404 on bogus ids rather than
      // returning a misleading `{ count: 0, ... }`.
      const { rows } = await pool.query(
        `SELECT id FROM chat_sessions WHERE id = $1`,
        [sessionId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Session not found' });
      const data = await loadKudosForSession(pool, sessionId, req.user.id);
      res.json(data);
    } catch (err) {
      log.error('kudos', 'get failed', { sessionId, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // --------------------------------------------------------------
  // GET /api/me/kudos-budget — header badge poll target.
  // --------------------------------------------------------------
  router.get('/api/me/kudos-budget', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const weekStart = weekStartUtc();
      const given = await countKudosGivenThisWeek(pool, req.user.id, weekStart);
      const remaining = Math.max(0, WEEKLY_KUDOS_LIMIT - given);
      res.json({
        given_this_week: given,
        remaining,
        limit: WEEKLY_KUDOS_LIMIT,
        week_start: weekStart,
      });
    } catch (err) {
      log.error('kudos', 'budget failed', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // --------------------------------------------------------------
  // GET /api/leaderboard/prs?window=all|week&limit=20
  // Top PRs by kudos count. Joins author + app for the card render.
  // --------------------------------------------------------------
  router.get('/api/leaderboard/prs', async (req, res) => {
    // Public endpoint (see PUBLIC_PATHS in middleware/auth.js) — no
    // req.user guard; only aggregate, non-private data is returned.
    const windowArg = req.query.window === 'week' ? 'week' : 'all';
    const limit = clampLimit(req.query.limit);
    try {
      const weekStart = weekStartUtc();
      // Window filter is a single WHERE clause; rest of the query is
      // identical. Using parameterized window arg rather than
      // string-interpolating column names — safe.
      const where = windowArg === 'week' ? `WHERE pk.week_start = $1` : '';
      const params = windowArg === 'week' ? [weekStart, limit] : [limit];
      const limitParamIdx = windowArg === 'week' ? '$2' : '$1';
      const { rows } = await pool.query(
        `SELECT cs.id AS session_id,
                cs.pr_number, cs.pr_url, cs.pr_title, cs.status,
                cs.created_at AS session_created_at,
                u.id AS author_id, u.username AS author_username,
                a.slug AS app_slug, a.name AS app_name,
                COUNT(*)::int AS kudos_count,
                MAX(pk.created_at) AS last_kudos_at
           FROM pr_kudos pk
           JOIN chat_sessions cs ON cs.id = pk.session_id
           JOIN apps a ON a.id = cs.app_id
           LEFT JOIN users u ON u.id = cs.user_id
           ${where}
           GROUP BY cs.id, u.id, a.slug, a.name
           ORDER BY kudos_count DESC, last_kudos_at DESC
           LIMIT ${limitParamIdx}`,
        params
      );
      res.json({
        window: windowArg,
        weekStart: windowArg === 'week' ? weekStart : null,
        items: rows,
      });
    } catch (err) {
      log.error('kudos', 'leaderboard/prs failed', { err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // --------------------------------------------------------------
  // GET /api/leaderboard/users?window=all|week&limit=20
  // Top users by kudos received on MERGED PRs (window-filtered), then
  // total kudos received as a tiebreaker. Excludes sessions with NULL
  // author (deleted user) so the leaderboard doesn't credit a ghost row.
  //
  // Per-row stats:
  //   kudos_received              — total kudos on the user's PRs (window-filtered)
  //   prs_kudosed                 — distinct PRs of theirs that got any kudos
  //   kudos_received_prs_merged   — kudos on PRs now 'merged' (window-filtered);
  //                                 the primary sort key.
  //   kudos_received_prs_unmerged — kudos on PRs not 'merged' (window-filtered)
  //   prs_merged                  — count of the user's PRs that landed. ALL-TIME
  //                                 regardless of window: chat_sessions has no
  //                                 merge timestamp, only a 'merged' status, so
  //                                 there's nothing to window it by. Display-only.
  // --------------------------------------------------------------
  router.get('/api/leaderboard/users', async (req, res) => {
    // Public endpoint (see PUBLIC_PATHS in middleware/auth.js) — no
    // req.user guard; only aggregate, non-private data is returned.
    const windowArg = req.query.window === 'week' ? 'week' : 'all';
    const limit = clampLimit(req.query.limit);
    try {
      const weekStart = weekStartUtc();
      const whereWindow = windowArg === 'week' ? `AND pk.week_start = $1` : '';
      const params = windowArg === 'week' ? [weekStart, limit] : [limit];
      const limitParamIdx = windowArg === 'week' ? '$2' : '$1';
      const { rows } = await pool.query(
        `SELECT u.id AS user_id,
                u.username,
                COUNT(*)::int AS kudos_received,
                COUNT(DISTINCT pk.session_id)::int AS prs_kudosed,
                COUNT(*) FILTER (WHERE cs.status = 'merged')::int AS kudos_received_prs_merged,
                COUNT(*) FILTER (WHERE cs.status <> 'merged')::int AS kudos_received_prs_unmerged,
                COALESCE(m.prs_merged, 0) AS prs_merged,
                MAX(pk.created_at) AS last_kudos_at
           FROM pr_kudos pk
           JOIN chat_sessions cs ON cs.id = pk.session_id
           JOIN users u ON u.id = cs.user_id
           LEFT JOIN (
             SELECT user_id, COUNT(*)::int AS prs_merged
               FROM chat_sessions
              WHERE status = 'merged' AND user_id IS NOT NULL
              GROUP BY user_id
           ) m ON m.user_id = u.id
           WHERE cs.user_id IS NOT NULL
           ${whereWindow}
           GROUP BY u.id, u.username, m.prs_merged
           ORDER BY kudos_received_prs_merged DESC, kudos_received DESC, last_kudos_at DESC
           LIMIT ${limitParamIdx}`,
        params
      );
      res.json({
        window: windowArg,
        weekStart: windowArg === 'week' ? weekStart : null,
        items: rows,
      });
    } catch (err) {
      log.error('kudos', 'leaderboard/users failed', { err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

function clampLimit(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 20;
  return Math.max(1, Math.min(100, n));
}

module.exports = {
  kudosRoutes,
  // Exported for tests and for reuse in other modules (e.g. /promoted
  // and /merged extend their queries with kudos counts, but they
  // compute them inline; weekStartUtc is needed to align the
  // server-side "this week" filter with what the FE budget badge
  // shows). WEEKLY_KUDOS_LIMIT is a constant; ELIGIBLE_STATES is the
  // canonical list the FE can use to know when to render the give-
  // kudos button at all.
  weekStartUtc,
  countKudosGivenThisWeek,
  loadKudosForSession,
  WEEKLY_KUDOS_LIMIT,
  ELIGIBLE_STATES,
};
