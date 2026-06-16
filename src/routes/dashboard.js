const { Router } = require('express');
const { getPool } = require('../db/pool');
const { adminMiddleware } = require('../middleware/admin');
const log = require('../services/logger');

// Admin analytics dashboard API. All endpoints sit behind adminMiddleware
// (same gate as the rest of /api/admin) and answer the questions the
// /dashboard page asks: how many users, how the dapp-usage and
// PR-promotion funnels convert, and how growth + retention are trending.
//
// Source-of-truth note: the append-only `events` table (schema.sql) is
// the long-term canonical analytics log and is now both backfilled and
// emitted live. The v1 queries below, however, derive their numbers
// straight from the domain tables (users, apps, app_activity,
// chat_messages, chat_session_messages, chat_sessions, pr_votes,
// pr_kudos, app_favorites). Two reasons:
//   1. Those tables hold the complete history with no cutover seam, and
//      they keep being written on every action, so the dashboard is
//      correct from day one.
//   2. The locked-in "active = any tracked action that day" definition
//      maps directly onto app_activity / chat_messages /
//      chat_session_messages — the canonical activity surfaces.
// The events table is what a future, richer analytics layer reads; these
// endpoints intentionally stay on the primary tables for fidelity.

// Admin-exclusion predicate (dashboard checkbox #1). When `includeAdmins`
// is false (the default) every analytics query drops rows attributed to
// an admin account (users.is_admin = TRUE — view-only admins included).
// `col` is the user-id column to test in the calling query. Returns a
// fragment that begins with the given keyword (AND by default) so it can
// be spliced into an existing WHERE clause or stand alone.
function adminFilter(col, includeAdmins, keyword = 'AND') {
  if (includeAdmins) return '';
  return `${keyword} ${col} NOT IN (SELECT id FROM users WHERE is_admin)`;
}

// Read the ?includeAdmins= query param. Anything but the literal 'true'
// means exclude admins (matches the unchecked-by-default checkbox).
function wantsAdmins(req) {
  return req.query.includeAdmins === 'true';
}

// Admin-membership split for the colour differentiation (#341). When
// `includeAdmins` is on, the affected endpoints keep their existing column as
// the NON-ADMIN value (admins always excluded, via `FILTER (WHERE NOT
// is_admin)` / a joined `is_admin` flag) and add a parallel `_admin`
// companion computed with the matching `FILTER (WHERE is_admin)`. When the
// box is off, `adminFilter` has already dropped every admin row upstream, so
// the admin companions evaluate to 0 and the non-admin column equals the old
// aggregate — the payload is byte-for-byte unchanged.

// "Active" surface: one row per (user, day) the user did anything we
// count as activity. Reused by retention + WAU/MAU. `day` is a DATE.
// Built per-request so the admin-exclusion filter can be woven into each
// UNION arm (each already constrains user_id IS NOT NULL).
function activityDaysSql(includeAdmins) {
  const aa = adminFilter('user_id', includeAdmins);
  const cm = adminFilter('user_id', includeAdmins);
  const cs = adminFilter('cs.user_id', includeAdmins);
  return `
  SELECT user_id, date AS day FROM app_activity WHERE user_id IS NOT NULL ${aa}
  UNION
  SELECT user_id, created_at::date AS day FROM chat_messages WHERE user_id IS NOT NULL ${cm}
  UNION
  SELECT cs.user_id, csm.created_at::date AS day
    FROM chat_session_messages csm
    JOIN chat_sessions cs ON cs.id = csm.session_id
   WHERE cs.user_id IS NOT NULL AND csm.role = 'user' ${cs}
`;
}

// Map the ?cohort= query param to a created_at lower bound (or null for
// "all time"). Used to scope the funnels to recent signups so lifetime
// power users don't dominate the conversion picture.
function cohortSince(raw) {
  if (raw === '1d') return "NOW() - INTERVAL '1 day'";
  if (raw === '3d') return "NOW() - INTERVAL '3 days'";
  if (raw === '7d') return "NOW() - INTERVAL '7 days'";
  if (raw === '14d') return "NOW() - INTERVAL '14 days'";
  if (raw === '30d') return "NOW() - INTERVAL '30 days'";
  if (raw === '90d') return "NOW() - INTERVAL '90 days'";
  return null;
}

function dashboardRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.use('/api/admin/analytics', adminMiddleware);

  // ── Overview counters ──────────────────────────────────────
  router.get('/api/admin/analytics/overview', async (req, res) => {
    const includeAdmins = wantsAdmins(req);
    try {
      const [users, apps, prs, active, llm, kudos] = await Promise.all([
        pool.query(
          `SELECT
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int  AS new_week,
             COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS new_month
           FROM users
           WHERE TRUE ${adminFilter('id', includeAdmins)}`
        ),
        pool.query(
          `SELECT COUNT(*)::int AS total
           FROM apps WHERE COALESCE(self_hosted, FALSE) = FALSE AND status <> 'deleted'
             ${adminFilter('created_by', includeAdmins)}`
        ),
        // promoted        — sessions in the promoted/merging state RIGHT NOW
        //                   (a live snapshot; merged sessions have left this bucket).
        // promoted_all_time — every session that ever recorded a promoted_at,
        //                   regardless of current status. This reconciles with
        //                   the Growth "Promoted PRs" total and explains why
        //                   merged (status='merged') can exceed it: sessions
        //                   merged outside the promote flow (self-app/direct/
        //                   admin merges, pre-promoted_at rows) never recorded one.
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE status IN ('promoted','merging'))::int AS promoted,
             COUNT(*) FILTER (WHERE promoted_at IS NOT NULL)::int          AS promoted_all_time,
             COUNT(*) FILTER (WHERE status = 'merged')::int                AS merged
           FROM chat_sessions
           WHERE TRUE ${adminFilter('user_id', includeAdmins)}`
        ),
        pool.query(
          `WITH activity AS (${activityDaysSql(includeAdmins)})
           SELECT
             COUNT(DISTINCT user_id) FILTER (WHERE day >= CURRENT_DATE - 6)::int  AS wau,
             COUNT(DISTINCT user_id) FILTER (WHERE day >= CURRENT_DATE - 29)::int AS mau
           FROM activity`
        ),
        pool.query(
          `SELECT COALESCE(SUM(total_cost_cents), 0)::float AS cents
           FROM llm_usage WHERE date = CURRENT_DATE
             ${adminFilter('user_id', includeAdmins)}`
        ),
        pool.query(
          `SELECT COUNT(*)::int AS total FROM pr_kudos
           WHERE TRUE ${adminFilter('giver_user_id', includeAdmins)}`
        ),
      ]);

      res.json({
        users: users.rows[0],
        appsTotal: apps.rows[0].total,
        prs: prs.rows[0],
        wau: active.rows[0].wau,
        mau: active.rows[0].mau,
        llmSpendTodayCents: llm.rows[0].cents,
        kudosTotal: kudos.rows[0].total,
      });
    } catch (err) {
      log.error('dashboard', 'overview failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Funnels ────────────────────────────────────────────────
  //
  // Both funnels report, per stage, the count of distinct subjects (users
  // or sessions) that reached that milestone — see the plan's funnel
  // definitions. Stages are ordered along the product journey; the
  // frontend renders each bar as a fraction of the first stage and labels
  // the step-over-step conversion.
  router.get('/api/admin/analytics/funnels', async (req, res) => {
    const since = cohortSince(req.query.cohort);
    const includeAdmins = wantsAdmins(req);
    // Build a reusable "user is in cohort" predicate. When all-time,
    // it's just TRUE so the SQL stays uniform.
    const userCohort = since ? `u.created_at >= ${since}` : 'TRUE';
    const sessUserCohort = since ? `usr.created_at >= ${since}` : 'TRUE';

    try {
      // Dapp-usage funnel — distinct users reaching each milestone. `base`
      // carries each user's is_admin flag so every stage can be split into a
      // non-admin count and an `_admin` companion (#341). When admins are
      // excluded, base holds no admin rows so the companions are all 0.
      const dapp = await pool.query(
        `WITH base AS (
           SELECT u.id AS user_id, u.is_admin FROM users u
            WHERE ${userCohort} ${adminFilter('u.id', includeAdmins)}
         ),
         flags AS (
           SELECT b.user_id, b.is_admin,
             EXISTS (SELECT 1 FROM app_activity aa WHERE aa.user_id = b.user_id) AS opened,
             (SELECT COUNT(DISTINCT aa.date) FROM app_activity aa
                WHERE aa.user_id = b.user_id) >= 2 AS returned,
             (EXISTS (SELECT 1 FROM chat_messages cm WHERE cm.user_id = b.user_id)
               OR EXISTS (SELECT 1 FROM pr_votes pv WHERE pv.user_id = b.user_id)
               OR EXISTS (SELECT 1 FROM pr_kudos pk WHERE pk.giver_user_id = b.user_id)
               OR EXISTS (SELECT 1 FROM app_favorites af WHERE af.user_id = b.user_id)
             ) AS engaged,
             EXISTS (SELECT 1 FROM apps a WHERE a.created_by = b.user_id
                       AND COALESCE(a.self_hosted, FALSE) = FALSE) AS creator
           FROM base b
         )
         SELECT
           COUNT(*) FILTER (WHERE NOT is_admin)::int AS signed_up,
           COUNT(*) FILTER (WHERE is_admin)::int     AS signed_up_admin,
           COUNT(*) FILTER (WHERE opened AND NOT is_admin)::int AS opened_dapp,
           COUNT(*) FILTER (WHERE opened AND is_admin)::int     AS opened_dapp_admin,
           COUNT(*) FILTER (WHERE returned AND NOT is_admin)::int AS returned,
           COUNT(*) FILTER (WHERE returned AND is_admin)::int     AS returned_admin,
           COUNT(*) FILTER (WHERE engaged AND NOT is_admin)::int AS engaged,
           COUNT(*) FILTER (WHERE engaged AND is_admin)::int     AS engaged_admin,
           COUNT(*) FILTER (WHERE creator AND NOT is_admin)::int AS creators,
           COUNT(*) FILTER (WHERE creator AND is_admin)::int     AS creators_admin
         FROM flags`
      );

      // PR-promotion funnel — session-level conversion (counts of dev
      // sessions) plus distinct-user reach at each step. Reverts inserted
      // directly as 'promoted' have no promoted_at, so the promoted test
      // also accepts the terminal statuses.
      const sessCohort = since ? `cs.created_at >= ${since}` : 'TRUE';
      // Session-level conversion, each stage split non-admin vs admin via the
      // session owner's is_admin flag (#341).
      const sessions = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE NOT COALESCE(usr.is_admin, FALSE))::int AS started,
           COUNT(*) FILTER (WHERE COALESCE(usr.is_admin, FALSE))::int     AS started_admin,
           COUNT(*) FILTER (WHERE cs.pr_number IS NOT NULL AND NOT COALESCE(usr.is_admin, FALSE))::int AS produced_pr,
           COUNT(*) FILTER (WHERE cs.pr_number IS NOT NULL AND COALESCE(usr.is_admin, FALSE))::int     AS produced_pr_admin,
           COUNT(*) FILTER (WHERE (cs.promoted_at IS NOT NULL OR cs.status IN ('promoted','merging','merged'))
                              AND NOT COALESCE(usr.is_admin, FALSE))::int AS promoted,
           COUNT(*) FILTER (WHERE (cs.promoted_at IS NOT NULL OR cs.status IN ('promoted','merging','merged'))
                              AND COALESCE(usr.is_admin, FALSE))::int     AS promoted_admin,
           COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM pr_votes pv WHERE pv.session_id = cs.id)
                              AND NOT COALESCE(usr.is_admin, FALSE))::int AS received_vote,
           COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM pr_votes pv WHERE pv.session_id = cs.id)
                              AND COALESCE(usr.is_admin, FALSE))::int     AS received_vote_admin,
           COUNT(*) FILTER (WHERE cs.status = 'merged' AND NOT COALESCE(usr.is_admin, FALSE))::int AS merged,
           COUNT(*) FILTER (WHERE cs.status = 'merged' AND COALESCE(usr.is_admin, FALSE))::int     AS merged_admin
         FROM chat_sessions cs
         LEFT JOIN users usr ON usr.id = cs.user_id
         WHERE ${sessCohort} ${adminFilter('cs.user_id', includeAdmins)}`
      );

      const usersReach = await pool.query(
        `SELECT
           COUNT(DISTINCT cs.user_id) FILTER (WHERE NOT usr.is_admin)::int AS started,
           COUNT(DISTINCT cs.user_id) FILTER (WHERE usr.is_admin)::int     AS started_admin,
           COUNT(DISTINCT cs.user_id) FILTER (WHERE cs.pr_number IS NOT NULL AND NOT usr.is_admin)::int AS produced_pr,
           COUNT(DISTINCT cs.user_id) FILTER (WHERE cs.pr_number IS NOT NULL AND usr.is_admin)::int     AS produced_pr_admin,
           COUNT(DISTINCT cs.user_id) FILTER (WHERE (cs.promoted_at IS NOT NULL
                              OR cs.status IN ('promoted','merging','merged')) AND NOT usr.is_admin)::int AS promoted,
           COUNT(DISTINCT cs.user_id) FILTER (WHERE (cs.promoted_at IS NOT NULL
                              OR cs.status IN ('promoted','merging','merged')) AND usr.is_admin)::int     AS promoted_admin,
           COUNT(DISTINCT cs.user_id) FILTER (WHERE cs.status = 'merged' AND NOT usr.is_admin)::int AS merged,
           COUNT(DISTINCT cs.user_id) FILTER (WHERE cs.status = 'merged' AND usr.is_admin)::int     AS merged_admin
         FROM chat_sessions cs
         JOIN users usr ON usr.id = cs.user_id
         WHERE ${sessUserCohort} ${adminFilter('usr.id', includeAdmins)}`
      );

      res.json({
        cohort: req.query.cohort || 'all',
        dappUsage: dapp.rows[0],
        prSessions: sessions.rows[0],
        prUsers: usersReach.rows[0],
      });
    } catch (err) {
      log.error('dashboard', 'funnels failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Growth (weekly time series) ────────────────────────────
  //
  // New users / apps / promoted PRs / merged PRs per ISO week. A
  // generate_series spine guarantees a continuous x-axis (no gaps for
  // quiet weeks). Merges use merged_at (exact going forward) and fall
  // back to promoted_at for pre-migration rows that never recorded one.
  router.get('/api/admin/analytics/growth', async (req, res) => {
    const includeAdmins = wantsAdmins(req);
    try {
      const { rows } = await pool.query(
        `WITH spine AS (
           SELECT generate_series(
             date_trunc('week', LEAST(
               (SELECT MIN(created_at) FROM users),
               NOW() - INTERVAL '12 weeks'
             )),
             date_trunc('week', NOW()),
             INTERVAL '1 week'
           )::date AS wk
         ),
         u AS (
           SELECT date_trunc('week', created_at)::date AS wk,
                  COUNT(*) FILTER (WHERE NOT is_admin)::int AS n,
                  COUNT(*) FILTER (WHERE is_admin)::int     AS n_admin
           FROM users WHERE TRUE ${adminFilter('id', includeAdmins)} GROUP BY 1
         ),
         a AS (
           SELECT date_trunc('week', ap.created_at)::date AS wk,
                  COUNT(*) FILTER (WHERE NOT COALESCE(au.is_admin, FALSE))::int AS n,
                  COUNT(*) FILTER (WHERE COALESCE(au.is_admin, FALSE))::int     AS n_admin
           FROM apps ap LEFT JOIN users au ON au.id = ap.created_by
           WHERE COALESCE(ap.self_hosted, FALSE) = FALSE
             ${adminFilter('ap.created_by', includeAdmins)} GROUP BY 1
         ),
         pr AS (
           SELECT date_trunc('week', cs.promoted_at)::date AS wk,
                  COUNT(*) FILTER (WHERE NOT COALESCE(pu.is_admin, FALSE))::int AS n,
                  COUNT(*) FILTER (WHERE COALESCE(pu.is_admin, FALSE))::int     AS n_admin
           FROM chat_sessions cs LEFT JOIN users pu ON pu.id = cs.user_id
           WHERE cs.promoted_at IS NOT NULL
             ${adminFilter('cs.user_id', includeAdmins)} GROUP BY 1
         ),
         mg AS (
           SELECT date_trunc('week', COALESCE(cs.merged_at, cs.promoted_at, cs.created_at))::date AS wk,
                  COUNT(*) FILTER (WHERE NOT COALESCE(mu.is_admin, FALSE))::int AS n,
                  COUNT(*) FILTER (WHERE COALESCE(mu.is_admin, FALSE))::int     AS n_admin
           FROM chat_sessions cs LEFT JOIN users mu ON mu.id = cs.user_id
           WHERE cs.status = 'merged'
             ${adminFilter('cs.user_id', includeAdmins)} GROUP BY 1
         )
         SELECT to_char(s.wk, 'YYYY-MM-DD') AS wk,
                COALESCE(u.n, 0)  AS new_users,
                COALESCE(u.n_admin, 0)  AS new_users_admin,
                COALESCE(a.n, 0)  AS new_apps,
                COALESCE(a.n_admin, 0)  AS new_apps_admin,
                COALESCE(pr.n, 0) AS promoted_prs,
                COALESCE(pr.n_admin, 0) AS promoted_prs_admin,
                COALESCE(mg.n, 0) AS merged_prs,
                COALESCE(mg.n_admin, 0) AS merged_prs_admin
         FROM spine s
         LEFT JOIN u  ON u.wk  = s.wk
         LEFT JOIN a  ON a.wk  = s.wk
         LEFT JOIN pr ON pr.wk = s.wk
         LEFT JOIN mg ON mg.wk = s.wk
         ORDER BY s.wk`
      );
      res.json({ weeks: rows });
    } catch (err) {
      log.error('dashboard', 'growth failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Retention ──────────────────────────────────────────────
  //
  // Two views:
  //   1. cohorts — the classic signup-week retention triangle. For each
  //      signup cohort and each week offset since signup, the share of
  //      the cohort that was active that week (active = any tracked
  //      action). Capped to the most recent 12 cohorts for readability.
  //   2. stickiness — per-week WAU and trailing-28-day MAU for the last
  //      12 weeks, so the WAU/MAU ratio can be charted.
  router.get('/api/admin/analytics/retention', async (req, res) => {
    const includeAdmins = wantsAdmins(req);
    try {
      const cohorts = await pool.query(
        `WITH cohorts AS (
           SELECT id AS user_id, date_trunc('week', created_at)::date AS cohort_wk
           FROM users WHERE TRUE ${adminFilter('id', includeAdmins)}
         ),
         activity AS (${activityDaysSql(includeAdmins)}),
         active_weeks AS (
           SELECT DISTINCT user_id, date_trunc('week', day::timestamptz)::date AS wk
           FROM activity
         ),
         sizes AS (
           SELECT cohort_wk, COUNT(*)::int AS cohort_size
           FROM cohorts GROUP BY cohort_wk
         ),
         recent AS (
           SELECT cohort_wk FROM sizes
           ORDER BY cohort_wk DESC LIMIT 12
         ),
         grid AS (
           SELECT c.cohort_wk,
                  ((aw.wk - c.cohort_wk) / 7)::int AS week_offset,
                  COUNT(DISTINCT c.user_id)::int AS active_users
           FROM cohorts c
           JOIN active_weeks aw ON aw.user_id = c.user_id AND aw.wk >= c.cohort_wk
           WHERE c.cohort_wk IN (SELECT cohort_wk FROM recent)
           GROUP BY c.cohort_wk, week_offset
         )
         SELECT to_char(s.cohort_wk, 'YYYY-MM-DD') AS cohort_wk,
                s.cohort_size, g.week_offset, g.active_users
         FROM sizes s
         JOIN recent r ON r.cohort_wk = s.cohort_wk
         LEFT JOIN grid g ON g.cohort_wk = s.cohort_wk
         ORDER BY s.cohort_wk, g.week_offset`
      );

      const stickiness = await pool.query(
        `WITH weeks AS (
           SELECT generate_series(
             date_trunc('week', NOW()) - INTERVAL '11 weeks',
             date_trunc('week', NOW()),
             INTERVAL '1 week'
           )::date AS wk
         ),
         activity AS (
           SELECT DISTINCT user_id, day FROM (${activityDaysSql(includeAdmins)}) a
         )
         SELECT to_char(w.wk, 'YYYY-MM-DD') AS wk,
                COUNT(DISTINCT a.user_id) FILTER (
                  WHERE a.day >= w.wk AND a.day < w.wk + 7
                )::int AS wau,
                COUNT(DISTINCT a.user_id) FILTER (
                  WHERE a.day < w.wk + 7 AND a.day >= w.wk + 7 - 28
                )::int AS mau
         FROM weeks w
         LEFT JOIN activity a ON a.day < w.wk + 7 AND a.day >= w.wk + 7 - 28
         GROUP BY w.wk
         ORDER BY w.wk`
      );

      // Reshape the flat cohort grid into one row per cohort with a
      // sparse offset->count map the frontend renders as a heatmap.
      const byCohort = new Map();
      for (const r of cohorts.rows) {
        if (!byCohort.has(r.cohort_wk)) {
          byCohort.set(r.cohort_wk, {
            cohortWeek: r.cohort_wk,
            cohortSize: r.cohort_size,
            offsets: {},
          });
        }
        if (r.week_offset !== null) {
          byCohort.get(r.cohort_wk).offsets[r.week_offset] = r.active_users;
        }
      }

      res.json({
        cohorts: Array.from(byCohort.values()),
        stickiness: stickiness.rows,
      });
    } catch (err) {
      log.error('dashboard', 'retention failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Engagement tiers (custom DAU / WAU definitions) ────────
  //
  // These are NOT the classic active-user metrics — they are the
  // operator-defined engagement bars requested for this dashboard, both
  // charted as weekly time series over the last 12 ISO weeks. They read
  // from the `events` log (its purpose): "using a dapp" = a
  // dapp_active_day event (one per app per day), "promoting a session" =
  // a pr_promoted event.
  //
  //   dau — per ISO week, distinct users who used a dapp on >= 4 distinct
  //         calendar days that week OR promoted >= 1 session that week.
  //   wau — per week point, distinct users who used a dapp on >= 2
  //         distinct calendar days in the trailing 14-day window ending
  //         that week ("twice each two weeks").
  // "Distinct calendar days" means multiple apps used on the same day
  // collapse to one — hence COUNT(DISTINCT ...::date) rather than COUNT(*)
  // over the per-(app, day) dapp_active_day events.
  router.get('/api/admin/analytics/engagement', async (req, res) => {
    const includeAdmins = wantsAdmins(req);
    try {
      const dau = await pool.query(
        `WITH weeks AS (
           SELECT generate_series(
             date_trunc('week', NOW()) - INTERVAL '11 weeks',
             date_trunc('week', NOW()),
             INTERVAL '1 week'
           )::date AS wk
         ),
         agg AS (
           SELECT e.user_id,
                  COALESCE(u.is_admin, FALSE) AS is_admin,
                  date_trunc('week', e.created_at)::date AS wk,
                  COUNT(DISTINCT e.created_at::date) FILTER (WHERE e.event_type = 'dapp_active_day') AS dapp_days,
                  COUNT(*) FILTER (WHERE e.event_type = 'pr_promoted')     AS promo_ct
           FROM events e
           LEFT JOIN users u ON u.id = e.user_id
           WHERE e.user_id IS NOT NULL
             AND e.event_type IN ('dapp_active_day', 'pr_promoted')
             ${adminFilter('e.user_id', includeAdmins)}
           GROUP BY e.user_id, COALESCE(u.is_admin, FALSE), date_trunc('week', e.created_at)::date
         )
         SELECT to_char(w.wk, 'YYYY-MM-DD') AS wk,
                COUNT(DISTINCT a.user_id) FILTER (
                  WHERE (a.dapp_days >= 4 OR a.promo_ct >= 1) AND NOT a.is_admin
                )::int AS dau,
                COUNT(DISTINCT a.user_id) FILTER (
                  WHERE (a.dapp_days >= 4 OR a.promo_ct >= 1) AND a.is_admin
                )::int AS dau_admin
         FROM weeks w
         LEFT JOIN agg a ON a.wk = w.wk
         GROUP BY w.wk
         ORDER BY w.wk`
      );

      const wau = await pool.query(
        `WITH weeks AS (
           SELECT generate_series(
             date_trunc('week', NOW()) - INTERVAL '11 weeks',
             date_trunc('week', NOW()),
             INTERVAL '1 week'
           )::date AS wk
         ),
         dapp AS (
           SELECT e.user_id, COALESCE(u.is_admin, FALSE) AS is_admin, e.created_at::date AS day
           FROM events e
           LEFT JOIN users u ON u.id = e.user_id
           WHERE e.event_type = 'dapp_active_day' AND e.user_id IS NOT NULL
             ${adminFilter('e.user_id', includeAdmins)}
         ),
         qualifying AS (
           -- A user counts for week w if they used a dapp on >= 2 distinct
           -- calendar days in the 14-day window [w-7, w+7) ending at that
           -- week's close. bool_or carries the admin flag for the split.
           SELECT w.wk, d.user_id, bool_or(d.is_admin) AS is_admin
           FROM weeks w
           JOIN dapp d ON d.day >= w.wk - 7 AND d.day < w.wk + 7
           GROUP BY w.wk, d.user_id
           HAVING COUNT(DISTINCT d.day) >= 2
         )
         SELECT to_char(w.wk, 'YYYY-MM-DD') AS wk,
                COUNT(q.user_id) FILTER (WHERE NOT q.is_admin)::int AS wau,
                COUNT(q.user_id) FILTER (WHERE q.is_admin)::int     AS wau_admin
         FROM weeks w
         LEFT JOIN qualifying q ON q.wk = w.wk
         GROUP BY w.wk
         ORDER BY w.wk`
      );

      // Merge the two weekly series on week for a single tidy payload.
      const byWeek = new Map();
      for (const r of dau.rows) {
        byWeek.set(r.wk, { wk: r.wk, dau: r.dau, dau_admin: r.dau_admin || 0, wau: 0, wau_admin: 0 });
      }
      for (const r of wau.rows) {
        const e = byWeek.get(r.wk) || { wk: r.wk, dau: 0, dau_admin: 0, wau: 0, wau_admin: 0 };
        e.wau = r.wau;
        e.wau_admin = r.wau_admin || 0;
        byWeek.set(r.wk, e);
      }
      const weeks = Array.from(byWeek.values()).sort((a, b) => (a.wk < b.wk ? -1 : 1));
      res.json({ weeks });
    } catch (err) {
      log.error('dashboard', 'engagement failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Top users by dev sessions started ──────────────────────
  //
  // The 30 most prolific builders, by lifetime count of dev sessions
  // (chat_sessions rows) they started. Session-level, so a user who
  // started many sessions ranks high regardless of outcome. Rendered as
  // a descending left-to-right bar chart on the dashboard.
  router.get('/api/admin/analytics/top-users', async (req, res) => {
    const includeAdmins = wantsAdmins(req);
    try {
      const { rows } = await pool.query(
        `SELECT u.username AS name,
                u.is_admin AS is_admin,
                COUNT(cs.id)::int AS sessions,
                COUNT(*) FILTER (WHERE cs.pr_number IS NOT NULL)::int AS produced_pr,
                COUNT(*) FILTER (WHERE cs.promoted_at IS NOT NULL
                                   OR cs.status IN ('promoted','merging','merged'))::int AS promoted,
                COUNT(*) FILTER (WHERE EXISTS (
                          SELECT 1 FROM pr_votes pv WHERE pv.session_id = cs.id))::int AS received_vote,
                COUNT(*) FILTER (WHERE cs.status = 'merged')::int AS merged
           FROM users u
           JOIN chat_sessions cs ON cs.user_id = u.id
          WHERE TRUE ${adminFilter('u.id', includeAdmins)}
          GROUP BY u.id, u.username
          ORDER BY sessions DESC, u.username
          LIMIT 30`
      );
      res.json({ users: rows });
    } catch (err) {
      log.error('dashboard', 'top-users failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Kudos giving distribution (weekly) ─────────────────────
  //
  // Every user gets a budget of 5 kudos per ISO week (WEEKLY_KUDOS_LIMIT
  // in routes/kudos.js). For each of the last 12 weeks we bucket users by
  // how many kudos they actually gave that week (0..5). pr_kudos.week_start
  // is already the Monday-00:00-UTC bucket, so we group on it directly.
  //
  // The g0 ("gave none") bucket is everyone registered as of that week's
  // end who didn't give a kudos that week — i.e. cumulative user base minus
  // that week's distinct givers. That's what makes this a participation /
  // "survival" view rather than just a raw count of kudos given.
  router.get('/api/admin/analytics/kudos', async (req, res) => {
    const includeAdmins = wantsAdmins(req);
    try {
      const { rows } = await pool.query(
        `WITH weeks AS (
           SELECT generate_series(
             date_trunc('week', NOW()) - INTERVAL '11 weeks',
             date_trunc('week', NOW()),
             INTERVAL '1 week'
           )::date AS wk
         ),
         per_giver AS (
           SELECT week_start AS wk, giver_user_id, COUNT(*)::int AS k
           FROM pr_kudos
           WHERE TRUE ${adminFilter('giver_user_id', includeAdmins)}
           GROUP BY week_start, giver_user_id
         ),
         buckets AS (
           SELECT w.wk,
                  COUNT(pg.giver_user_id) FILTER (WHERE pg.k = 1)::int AS g1,
                  COUNT(pg.giver_user_id) FILTER (WHERE pg.k = 2)::int AS g2,
                  COUNT(pg.giver_user_id) FILTER (WHERE pg.k = 3)::int AS g3,
                  COUNT(pg.giver_user_id) FILTER (WHERE pg.k = 4)::int AS g4,
                  COUNT(pg.giver_user_id) FILTER (WHERE pg.k = 5)::int AS g5
           FROM weeks w
           LEFT JOIN per_giver pg ON pg.wk = w.wk
           GROUP BY w.wk
         ),
         pop AS (
           SELECT w.wk,
                  (SELECT COUNT(*) FROM users u
                    WHERE u.created_at < w.wk + 7
                      ${adminFilter('u.id', includeAdmins)})::int AS users
           FROM weeks w
         )
         SELECT to_char(b.wk, 'YYYY-MM-DD') AS wk,
                p.users,
                b.g1, b.g2, b.g3, b.g4, b.g5,
                GREATEST(p.users - (b.g1 + b.g2 + b.g3 + b.g4 + b.g5), 0)::int AS g0
         FROM buckets b
         JOIN pop p ON p.wk = b.wk
         ORDER BY b.wk`
      );
      res.json({ weeks: rows });
    } catch (err) {
      log.error('dashboard', 'kudos failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Daily spend (last 30 days) ─────────────────────────────
  //
  // Total LLM spend per calendar day for the last 30 days (today
  // inclusive), summed across all users. A generate_series spine
  // guarantees a row for every day, so quiet days render as a $0 bar
  // rather than a gap — same continuous-axis pattern as growth /
  // engagement. Cost lives in llm_usage.total_cost_cents (NUMERIC(10,4),
  // sub-cent precision); summed to a float here and formatted as dollars
  // client-side. `date` is bucketed by CURRENT_DATE at write time, so the
  // window comparison uses CURRENT_DATE too.
  router.get('/api/admin/analytics/spend', async (req, res) => {
    const includeAdmins = wantsAdmins(req);
    try {
      // Return platform-key spend (total_cost_cents — drives the daily
      // caps) and user-key/BYOK spend (byok_cost_cents — display only)
      // separately per day. The dashboard's three-way toggle decides
      // which to chart; doing it client-side means no refetch on switch.
      const { rows } = await pool.query(
        `WITH spine AS (
           SELECT generate_series(
             CURRENT_DATE - 29,
             CURRENT_DATE,
             INTERVAL '1 day'
           )::date AS day
         ),
         agg AS (
           SELECT lu.date AS day,
                  SUM(lu.total_cost_cents) AS platform_cents,
                  SUM(lu.byok_cost_cents)  AS user_key_cents,
                  -- Admin-attributed portion of each day's spend. The client
                  -- stacks this as an amber segment on top of the non-admin
                  -- remainder (the bar's total height stays the full value) and
                  -- also lists it as the "of which admin" tooltip line. 0 when
                  -- the box is off (adminFilter has dropped all admin rows).
                  SUM(lu.total_cost_cents) FILTER (WHERE COALESCE(u.is_admin, FALSE)) AS platform_cents_admin,
                  SUM(lu.byok_cost_cents)  FILTER (WHERE COALESCE(u.is_admin, FALSE)) AS user_key_cents_admin
           FROM llm_usage lu
           LEFT JOIN users u ON u.id = lu.user_id
           WHERE lu.date >= CURRENT_DATE - 29
             ${adminFilter('lu.user_id', includeAdmins)}
           GROUP BY lu.date
         )
         SELECT to_char(s.day, 'YYYY-MM-DD') AS day,
                COALESCE(a.platform_cents, 0)::float AS platform_cents,
                COALESCE(a.user_key_cents, 0)::float AS user_key_cents,
                COALESCE(a.platform_cents_admin, 0)::float AS platform_cents_admin,
                COALESCE(a.user_key_cents_admin, 0)::float AS user_key_cents_admin
         FROM spine s
         LEFT JOIN agg a ON a.day = s.day
         ORDER BY s.day`
      );
      res.json({ days: rows });
    } catch (err) {
      log.error('dashboard', 'spend failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Spend by builder (top 30) ──────────────────────────────
  //
  // Lifetime LLM spend per user, split platform-key vs user-key, for the
  // 30 biggest spenders. Ordered by total here; the client re-sorts by
  // the selected toggle mode so the bars stay descending in every mode.
  router.get('/api/admin/analytics/spend-by-builder', async (req, res) => {
    const includeAdmins = wantsAdmins(req);
    try {
      const { rows } = await pool.query(
        `SELECT u.username AS name,
                u.is_admin AS is_admin,
                COALESCE(SUM(lu.total_cost_cents), 0)::float AS platform_cents,
                COALESCE(SUM(lu.byok_cost_cents), 0)::float  AS user_key_cents
           FROM users u
           JOIN llm_usage lu ON lu.user_id = u.id
          WHERE TRUE ${adminFilter('u.id', includeAdmins)}
          GROUP BY u.id, u.username
          ORDER BY (SUM(lu.total_cost_cents) + SUM(lu.byok_cost_cents)) DESC, u.username
          LIMIT 30`
      );
      res.json({ builders: rows });
    } catch (err) {
      log.error('dashboard', 'spend-by-builder failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { dashboardRoutes };
