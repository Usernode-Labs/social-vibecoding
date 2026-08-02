const { Router } = require('express');
const { getPool } = require('../db/pool');
const { adminMiddleware } = require('../middleware/admin');
const log = require('../services/logger');
const analyticsDemo = require('../services/analytics-demo');

// Admin analytics dashboard API. All endpoints sit behind adminMiddleware
// (same gate as the rest of /api/admin) and answer the questions the
// #admin/analytics console section asks (the standalone /dashboard page it
// used to back is a redirect stub since #860): how many users, how the
// dapp-usage and PR-promotion funnels convert, and how growth + retention
// are trending.
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

// ── Staging mock data (#860) ─────────────────────────────────────────────
//
// Every chart here derives from `events` and `llm_usage`, both
// `staging:private` — so a prod-cloned staging DB renders the whole
// #admin/analytics section as blank axes, and no reviewer can tell a broken
// chart from an empty one. Under IS_STAGING + ?demo=1 we SUBSTITUTE the
// deterministic synthetic series in services/analytics-demo.js.
//
// Substitute, not add: `wantsDemo` only opens the door, and each call site
// additionally requires the real result to be genuinely empty. Spend and
// spend-distribution build a date "spine", so they always return ~30 rows —
// emptiness there means all-zero VALUES, which is what `allZero` tests.
// Strictly a no-op in production (analyticsDemo.IS_STAGING is false).
function wantsDemo(req) {
  return analyticsDemo.IS_STAGING && req.query.demo === '1';
}

// True when every row is zero/null across the given numeric columns (or
// there are no rows at all).
function allZero(rows, keys) {
  if (!Array.isArray(rows) || !rows.length) return true;
  return rows.every((r) => keys.every((k) => !Number(r[k])));
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

      const overview = {
        users: users.rows[0],
        appsTotal: apps.rows[0].total,
        prs: prs.rows[0],
        wau: active.rows[0].wau,
        mau: active.rows[0].mau,
        llmSpendTodayCents: llm.rows[0].cents,
        kudosTotal: kudos.rows[0].total,
      };
      // Staging demo: only when the counters are genuinely empty — a staging
      // clone that does carry users should show its own numbers.
      if (wantsDemo(req) && !Number(overview.users?.total)) {
        return res.json(analyticsDemo.overview());
      }
      res.json(overview);
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

      // Staging demo: substituted when the first funnel stage is empty.
      if (wantsDemo(req) && !Number(dapp.rows[0]?.signed_up)) {
        return res.json({ cohort: req.query.cohort || 'all', ...analyticsDemo.funnels() });
      }
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
      // Staging demo: growth reads events, which is staging:private.
      if (wantsDemo(req) && allZero(rows, ['new_users', 'new_apps', 'promoted_prs', 'merged_prs'])) {
        return res.json(analyticsDemo.growth());
      }
      res.json({ weeks: rows });
    } catch (err) {
      log.error('dashboard', 'growth failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Retention ──────────────────────────────────────────────
  //
  // The classic signup-week retention triangle. For each signup cohort
  // and each week offset since signup, the share of the cohort that was
  // active that week (active = any tracked action). Capped to the most
  // recent 12 cohorts for readability. The frontend re-pivots this same
  // payload into either a calendar-aligned or cohort-age-aligned grid;
  // the old WAU/MAU stickiness series it used to return is superseded by
  // the General-users daily charts (/api/admin/analytics/general-users).
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

      // (`cohorts` above is the query result; this is the reshaped payload.)
      const cohortRows = Array.from(byCohort.values());
      // Staging demo: retention reads the activity surfaces, all empty in a
      // prod-cloned staging DB.
      if (wantsDemo(req) && !cohortRows.length) {
        return res.json(analyticsDemo.retention());
      }
      res.json({ cohorts: cohortRows });
    } catch (err) {
      log.error('dashboard', 'retention failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── General users (DAU / WAU / MAU, daily rolling windows) ──
  //
  // "General user" = anyone counted active that day, using the same
  // canonical activity surface as retention/overview (activityDaysSql:
  // app_activity ∪ chat_messages ∪ user dev-session messages). There is
  // no login/sign-in event and the sessions table has no created_at, so
  // "active = any tracked action that day" is the faithful, historically
  // complete proxy for "signed in".
  //
  //   dau — distinct general users active on day d.
  //   wau — distinct general users active in the trailing 7 days [d-6, d]
  //         (a 7-day rolling window, recomputed for every day → a point
  //         per day, not a stepped weekly bucket).
  //   mau — distinct general users active in the trailing 30 days
  //         [d-29, d] (a 30-day rolling window, point per day).
  //
  // One point per calendar day over the last 90 days. The widest window
  // reaches 29 days before the first plotted day, so the activity scan is
  // intentionally NOT clipped to the 90-day display range.
  router.get('/api/admin/analytics/general-users', async (req, res) => {
    const includeAdmins = wantsAdmins(req);
    try {
      const { rows } = await pool.query(
        `WITH days AS (
           SELECT generate_series(CURRENT_DATE - 89, CURRENT_DATE, INTERVAL '1 day')::date AS d
         ),
         activity AS (
           SELECT DISTINCT user_id, day FROM (${activityDaysSql(includeAdmins)}) a
         )
         SELECT to_char(d.d, 'YYYY-MM-DD') AS day,
                COUNT(DISTINCT a.user_id) FILTER (WHERE a.day = d.d)::int                    AS dau,
                COUNT(DISTINCT a.user_id) FILTER (WHERE a.day BETWEEN d.d - 6  AND d.d)::int  AS wau,
                COUNT(DISTINCT a.user_id) FILTER (WHERE a.day BETWEEN d.d - 29 AND d.d)::int  AS mau
         FROM days d
         LEFT JOIN activity a ON a.day BETWEEN d.d - 29 AND d.d
         GROUP BY d.d
         ORDER BY d.d`
      );
      // Staging demo: DAU/WAU/MAU all derive from events.
      if (wantsDemo(req) && allZero(rows, ['dau', 'wau', 'mau'])) {
        return res.json(analyticsDemo.generalUsers());
      }
      res.json({ daily: rows });
    } catch (err) {
      log.error('dashboard', 'general-users failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Power users (rolling WAU + L4 consistency) ─────────────
  //
  // A "power user", evaluated over a 7-day window, is a user who BOTH
  //   (a) used dapps >= 3 times that week  — COUNT(*) of dapp_active_day
  //       events in the window (each (app, day) row is one "use"; counting
  //       rows, not distinct days/apps, is what "same or different dapps"
  //       means), AND
  //   (b) did >= 3 visible developer actions that week — at least three
  //       events in {kudos_given, pr_vote_cast, pr_promoted} (kudos, voting,
  //       and making a proposal respectively; "making a proposal" maps to
  //       pr_promoted = a PR opened for group voting, the tracked action
  //       that lives in the events log alongside the other two).
  //
  // Grounded entirely on the `events` table so dapp use and dev actions
  // come from one scan. The per-(user, day) rollup below is shared by both
  // result sets. We clip the rollup to the last ~120 days: the L4 chart's
  // earliest plotted day (CURRENT_DATE - 89) looks back four weeks, i.e.
  // to CURRENT_DATE - 116, so 120 days fully backs every window.
  router.get('/api/admin/analytics/power-users', async (req, res) => {
    const includeAdmins = wantsAdmins(req);
    const rollupCte = `
      rollup AS (
        SELECT e.user_id,
               e.created_at::date AS day,
               COUNT(*) FILTER (WHERE e.event_type = 'dapp_active_day') AS dapp_ct,
               COUNT(*) FILTER (WHERE e.event_type IN ('kudos_given','pr_vote_cast','pr_promoted')) AS dev_ct
        FROM events e
        WHERE e.user_id IS NOT NULL
          AND e.created_at >= CURRENT_DATE - 120
          AND e.event_type IN ('dapp_active_day','kudos_given','pr_vote_cast','pr_promoted')
          ${adminFilter('e.user_id', includeAdmins)}
        GROUP BY e.user_id, e.created_at::date
      )`;
    try {
      // Power-user WAU: per day d, distinct users who were a power user
      // over the trailing 7 days [d-6, d]. Point per day.
      const wau = await pool.query(
        `WITH days AS (
           SELECT generate_series(CURRENT_DATE - 89, CURRENT_DATE, INTERVAL '1 day')::date AS d
         ),
         ${rollupCte},
         qualifying AS (
           SELECT d.d, r.user_id
           FROM days d
           JOIN rollup r ON r.day BETWEEN d.d - 6 AND d.d
           GROUP BY d.d, r.user_id
           HAVING SUM(r.dapp_ct) >= 3 AND SUM(r.dev_ct) >= 3
         )
         SELECT to_char(d.d, 'YYYY-MM-DD') AS day,
                COUNT(q.user_id)::int AS count
         FROM days d
         LEFT JOIN qualifying q ON q.d = d.d
         GROUP BY d.d
         ORDER BY d.d`
      );

      // L4 consistency: per day d, look back over four consecutive trailing
      // weeks w∈{0,1,2,3} (week w = [d-7w-6, d-7w]). A user qualifies for a
      // week if they meet the power-user predicate within it; per user count
      // how many of the four weeks qualified (1..4) and stack the buckets.
      const l4 = await pool.query(
        `WITH days AS (
           SELECT generate_series(CURRENT_DATE - 89, CURRENT_DATE, INTERVAL '1 day')::date AS d
         ),
         weeks AS (SELECT generate_series(0, 3) AS w),
         ${rollupCte},
         qual AS (
           SELECT d.d, gw.w, r.user_id
           FROM days d
           CROSS JOIN weeks gw
           JOIN rollup r ON r.day BETWEEN d.d - 7 * gw.w - 6 AND d.d - 7 * gw.w
           GROUP BY d.d, gw.w, r.user_id
           HAVING SUM(r.dapp_ct) >= 3 AND SUM(r.dev_ct) >= 3
         ),
         counts AS (
           SELECT d, user_id, COUNT(DISTINCT w) AS q
           FROM qual
           GROUP BY d, user_id
         )
         SELECT to_char(d.d, 'YYYY-MM-DD') AS day,
                COUNT(*) FILTER (WHERE c.q = 1)::int AS b1,
                COUNT(*) FILTER (WHERE c.q = 2)::int AS b2,
                COUNT(*) FILTER (WHERE c.q = 3)::int AS b3,
                COUNT(*) FILTER (WHERE c.q = 4)::int AS b4
         FROM days d
         LEFT JOIN counts c ON c.d = d.d
         GROUP BY d.d
         ORDER BY d.d`
      );

      // Staging demo: both series derive from events.
      if (wantsDemo(req)
        && allZero(wau.rows, ['count'])
        && allZero(l4.rows, ['b1', 'b2', 'b3', 'b4'])) {
        return res.json(analyticsDemo.powerUsers());
      }
      res.json({ wau: wau.rows, l4: l4.rows });
    } catch (err) {
      log.error('dashboard', 'power-users failed', { message: err.message });
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
      // Staging demo: pr_kudos is staging:private.
      if (wantsDemo(req) && allZero(rows, ['g0', 'g1', 'g2', 'g3', 'g4', 'g5'])) {
        return res.json(analyticsDemo.kudos());
      }
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
         ),
         -- #361: system-token spend (merge-conflict / sync resolution).
         -- One row per day, not user-attributed, so the admin filter
         -- doesn't apply — the same value shows in both toggle modes.
         sys AS (
           SELECT stu.date AS day,
                  stu.cost_cents AS system_cents
           FROM system_token_usage stu
           WHERE stu.date >= CURRENT_DATE - 29
         )
         SELECT to_char(s.day, 'YYYY-MM-DD') AS day,
                COALESCE(a.platform_cents, 0)::float AS platform_cents,
                COALESCE(a.user_key_cents, 0)::float AS user_key_cents,
                COALESCE(a.platform_cents_admin, 0)::float AS platform_cents_admin,
                COALESCE(a.user_key_cents_admin, 0)::float AS user_key_cents_admin,
                COALESCE(sy.system_cents, 0)::float AS system_cents
         FROM spine s
         LEFT JOIN agg a ON a.day = s.day
         LEFT JOIN sys sy ON sy.day = s.day
         ORDER BY s.day`
      );
      // Staging demo: llm_usage is staging:private. The date spine always
      // returns ~30 rows, so emptiness here means all-zero VALUES.
      if (wantsDemo(req) && allZero(rows, ['platform_cents', 'user_key_cents', 'system_cents'])) {
        return res.json(analyticsDemo.spend());
      }
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
      // Staging demo: llm_usage is staging:private.
      if (wantsDemo(req) && allZero(rows, ['platform_cents', 'user_key_cents'])) {
        return res.json(analyticsDemo.spendByBuilder());
      }
      res.json({ builders: rows });
    } catch (err) {
      log.error('dashboard', 'spend-by-builder failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Spend distribution (last 30 days, bucketed user counts) ────
  //
  // One stacked bar per calendar day for the last 30 days: each segment is
  // the COUNT OF USERS whose platform-key spend (llm_usage.total_cost_cents,
  // the metered spend the daily caps track) fell into a dollar bucket that
  // day. Buckets in cents: $0; (0,5]; (5,10]; (10,15]; (15,20); and a $20+
  // top tier split into "capped" vs "kept going on own key".
  //
  // The $20+ split answers "who hit the cap and stopped vs. who continued on
  // their own Anthropic key". A user has a usable own key for a day when
  // EITHER users.anthropic_key_enc IS NOT NULL (key configured — a CURRENT
  // snapshot; there is no key-presence history table) OR that day's
  // byok_cost_cents > 0 (own-key spend actually recorded). The two are OR'd
  // so the snapshot captures capability and the per-day spend corrects past
  // days for users whose key has since changed. limits.recordSpend only
  // writes a row when cost > 0, so a literal "$0" row generally never exists:
  // the $0 bucket is therefore DERIVED as (users registered as of that day)
  // minus the users counted in the paid buckets — analogous to the kudos
  // "gave 0" bucket. The registered-as-of-day count is a per-day subquery
  // against users; trivial at current scale (30 small COUNTs).
  //
  // `date` is bucketed by CURRENT_DATE at write time, so the window uses
  // CURRENT_DATE too (UTC calendar day, same as every other chart here).
  router.get('/api/admin/analytics/spend-distribution', async (req, res) => {
    const includeAdmins = wantsAdmins(req);
    try {
      // "Has a usable own key" predicate, reused for the $20+ split.
      const byok = '(u.anthropic_key_enc IS NOT NULL OR lu.byok_cost_cents > 0)';
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
                  COUNT(*) FILTER (WHERE lu.total_cost_cents > 0    AND lu.total_cost_cents <= 500)  AS b1,
                  COUNT(*) FILTER (WHERE lu.total_cost_cents > 500  AND lu.total_cost_cents <= 1000) AS b2,
                  COUNT(*) FILTER (WHERE lu.total_cost_cents > 1000 AND lu.total_cost_cents <= 1500) AS b3,
                  COUNT(*) FILTER (WHERE lu.total_cost_cents > 1500 AND lu.total_cost_cents <  2000) AS b4,
                  COUNT(*) FILTER (WHERE lu.total_cost_cents >= 2000 AND NOT ${byok}) AS b5,
                  COUNT(*) FILTER (WHERE lu.total_cost_cents >= 2000 AND ${byok})     AS b6
             FROM llm_usage lu
             LEFT JOIN users u ON u.id = lu.user_id
            WHERE lu.date >= CURRENT_DATE - 29
              ${adminFilter('lu.user_id', includeAdmins)}
            GROUP BY lu.date
         )
         SELECT to_char(s.day, 'YYYY-MM-DD') AS day,
                COALESCE(a.b1, 0)::int AS b1,
                COALESCE(a.b2, 0)::int AS b2,
                COALESCE(a.b3, 0)::int AS b3,
                COALESCE(a.b4, 0)::int AS b4,
                COALESCE(a.b5, 0)::int AS b5,
                COALESCE(a.b6, 0)::int AS b6,
                -- $0 bucket: everyone registered as of this day who isn't in a
                -- paid bucket. GREATEST guards float/clock edge cases.
                GREATEST(0,
                  (SELECT COUNT(*) FROM users u2
                    WHERE u2.created_at::date <= s.day
                      ${adminFilter('u2.id', includeAdmins)})
                  - (COALESCE(a.b1, 0) + COALESCE(a.b2, 0) + COALESCE(a.b3, 0)
                     + COALESCE(a.b4, 0) + COALESCE(a.b5, 0) + COALESCE(a.b6, 0))
                )::int AS b0
           FROM spine s
           LEFT JOIN agg a ON a.day = s.day
          ORDER BY s.day`
      );
      // Staging demo: same spine caveat as /spend — all-zero buckets, not
      // zero rows, is what "empty" looks like here.
      if (wantsDemo(req) && allZero(rows, ['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6'])) {
        return res.json(analyticsDemo.spendDistribution());
      }
      res.json({ days: rows });
    } catch (err) {
      log.error('dashboard', 'spend-distribution failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { dashboardRoutes };
