const { Router } = require('express');
const { getPool } = require('../db/pool');
const { adminMiddleware } = require('../middleware/admin');
const log = require('../services/logger');
const analyticsDemo = require('../services/analytics-demo');
// #892: read-only access to the estimator's COMMITTED run-length priors so
// the estimator card can show them beside the live numbers and say when a
// refresh is due. This is a plain module-constant read — it does NOT call
// llm.init() and needs no API key, so requiring it here is safe in every
// environment including tests.
const llm = require('../services/llm');

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
  // Every user gets a budget of 20 kudos per ISO week (WEEKLY_KUDOS_LIMIT
  // in services/bounties.js). For each of the last 12 weeks we bucket users
  // by how many kudos they actually gave that week. pr_kudos.week_start is
  // already the Monday-00:00-UTC bucket, so we group on it directly.
  //
  // #964: the buckets are BANDED (1, 2, 3, 4–5, 6–10, 11+) rather than one
  // per exact count. Under the old 5-per-week cap an exact 1..5 series was
  // exhaustive; at 20 it silently was not — anyone giving 6+ fell out of
  // every named bucket AND got swept into g0 by its
  // "population minus the named buckets" subtraction, i.e. the most
  // generous givers were reported as having given nothing. Bands keep the
  // series exhaustive at any cap, so g0 stays a true "gave none".
  //
  // Note this series measures pr_kudos ONLY, not issue-bounty pledges, even
  // though the two draw on one shared allowance. Widening it to the combined
  // ledger would be a more honest participation view but changes the meaning
  // of an existing chart, so it is deliberately left alone here.
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
                  COUNT(pg.giver_user_id) FILTER (WHERE pg.k BETWEEN 4 AND 5)::int AS g4_5,
                  COUNT(pg.giver_user_id) FILTER (WHERE pg.k BETWEEN 6 AND 10)::int AS g6_10,
                  COUNT(pg.giver_user_id) FILTER (WHERE pg.k >= 11)::int AS g11p
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
                b.g1, b.g2, b.g3, b.g4_5, b.g6_10, b.g11p,
                GREATEST(p.users - (b.g1 + b.g2 + b.g3 + b.g4_5 + b.g6_10 + b.g11p), 0)::int AS g0
         FROM buckets b
         JOIN pop p ON p.wk = b.wk
         ORDER BY b.wk`
      );
      // Staging demo: pr_kudos is staging:private.
      if (wantsDemo(req) && allZero(rows, ['g0', 'g1', 'g2', 'g3', 'g4_5', 'g6_10', 'g11p'])) {
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

  // ── Progress estimator accuracy (#891) ─────────────────────
  //
  // Answers "is the experimental AI progress estimate good enough to leave
  // experimental?" from `progress_estimates`, which has been recording every
  // guess and its backfilled ground truth all along with nothing reading it
  // back. Per-tick prediction is `predicted_remaining_seconds`; ground truth
  // is `actual_remaining_ms` (= the turn's total wall clock minus that tick's
  // elapsed_ms), filled in at the coding run's terminal choke point.
  //
  // DELIBERATELY IGNORES the includeAdmins filter every sibling endpoint
  // applies. The estimator is opt-in and default-OFF, so the population that
  // has it switched on is tiny and admin-heavy — excluding admins would leave
  // this card permanently empty. Surfaced in the card's (?) definition.
  router.get('/api/admin/analytics/estimator', async (req, res) => {
    // A tick is SCORABLE when the turn resolved, the model actually gave a
    // number, and there was real time left to predict. `actual_remaining_ms
    // <= 0` (the run outlived its own estimate window) is excluded from the
    // ratio-based band metric — division by ~zero — but counted separately
    // as `ran_past` so it can't hide.
    const SCORED = `actual_total_ms IS NOT NULL
                    AND predicted_remaining_seconds IS NOT NULL
                    AND actual_remaining_ms > 0`;
    // Signed error: positive = predicted MORE time remaining than there was
    // (pessimistic), negative = optimistic. Median of this is the bias.
    const ERR = `(predicted_remaining_seconds - actual_remaining_ms / 1000.0)`;
    // ONE definition of the elapsed buckets, shared by the by-elapsed
    // breakdown, the oracle baseline and the priors-staleness check (#892).
    // If the drift check and the baseline disagreed about where a bucket
    // starts, the card could show a drift the baseline contradicts — so
    // they read the same expression. Mirrors the bucket bounds in
    // llm.RUN_LENGTH_PRIORS (matched by its `key` field).
    const BUCKET_CASE = `CASE WHEN elapsed_ms < 120000  THEN '<2m'
                              WHEN elapsed_ms < 300000  THEN '2-5m'
                              WHEN elapsed_ms < 600000  THEN '5-10m'
                              WHEN elapsed_ms < 1200000 THEN '10-20m'
                              ELSE '20m+' END`;
    // Mirrors llm.isCompletionClaim's phrase family in SQL, so a claim made
    // BEFORE suppression shipped is still counted (historical v1 rows have
    // suppressed=false but the phrase is right there in estimate_text).
    const CLAIM_RE = `(nearly|almost|just about)[[:space:]]+(done|finished|complete|there)|wrapping[[:space:]]+up|finishing[[:space:]]+(up|off)|just[[:space:]]+finishing|final[[:space:]]+(touches|tweaks|checks)`;
    const metricsSql = (windowed, groupBy) => `
      SELECT
        ${groupBy ? `${groupBy} AS group_key,` : ''}
        COUNT(*)::int                                              AS ticks,
        COUNT(*) FILTER (WHERE actual_total_ms IS NOT NULL)::int    AS resolved,
        COUNT(*) FILTER (WHERE actual_total_ms IS NULL)::int        AS unresolved,
        COUNT(DISTINCT progress_message_id)::int                    AS runs,
        COUNT(DISTINCT user_id)::int                                AS users,
        COUNT(*) FILTER (WHERE ${SCORED})::int                      AS scored,
        COUNT(*) FILTER (WHERE actual_total_ms IS NOT NULL
                           AND actual_remaining_ms <= 0)::int       AS ran_past,
        COUNT(*) FILTER (WHERE actual_total_ms IS NOT NULL
                           AND predicted_remaining_seconds IS NOT NULL)::int
                                                                    AS resolved_with_prediction,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(${ERR}))
          FILTER (WHERE ${SCORED})                                  AS median_abs_err_s,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY ${ERR})
          FILTER (WHERE ${SCORED})                                  AS median_bias_s,
        AVG((abs(${ERR}) <= 60)::int) FILTER (WHERE ${SCORED})      AS within_60s,
        AVG((predicted_remaining_seconds
               BETWEEN actual_remaining_ms / 2000.0
                   AND actual_remaining_ms / 500.0)::int)
          FILTER (WHERE ${SCORED})                                  AS within_band
      FROM progress_estimates
      ${windowed ? `WHERE created_at >= NOW() - INTERVAL '30 days'` : ''}
      ${groupBy ? `GROUP BY ${groupBy} ORDER BY ${groupBy}` : ''}`;

    // Nulls (no scorable rows) must reach the client as null, not 0 — "no
    // data yet" and "perfectly accurate" are very different answers.
    const num = (v) => (v == null ? null : Number(v));
    const shapeMetrics = (r) => ({
      ticks: r.ticks,
      resolved: r.resolved,
      unresolved: r.unresolved,
      unresolvedRate: r.ticks ? r.unresolved / r.ticks : null,
      runs: r.runs,
      users: r.users,
      scored: r.scored,
      ranPast: r.ran_past,
      // Share of resolved ticks where the model committed to a number at all.
      coverage: r.resolved ? r.resolved_with_prediction / r.resolved : null,
      medianAbsErrS: num(r.median_abs_err_s),
      medianBiasS: num(r.median_bias_s),
      within60s: num(r.within_60s),
      withinBand: num(r.within_band),
    });

    const shapeBaselines = (r) => (!r || !r.scored ? null : {
      scored: r.scored,
      constant: {
        medianAbsErrS: num(r.const_abs),
        medianBiasS: num(r.const_bias),
        withinBand: num(r.const_band),
      },
      oracle: {
        medianAbsErrS: num(r.oracle_abs),
        medianBiasS: num(r.oracle_bias),
        withinBand: num(r.oracle_band),
      },
    });

    // Priors staleness (#892). The numbers the estimator prompt feeds the
    // model are a COMMITTED constant, not a live query — that keeps the
    // guidance stable mid-run, off the request path, and behind a reviewable
    // change. The trade is that it can go out of date, so the card holds the
    // committed values next to the live ones and says when a refresh is due.
    // Two mechanical triggers: any bucket whose live median has moved more
    // than 25% from the committed p50, or a scored-tick count that has more
    // than doubled since the snapshot was taken.
    const DRIFT_THRESHOLD = 0.25;
    const shapePriors = (liveRows, allRow) => {
      const snapshot = llm.RUN_LENGTH_PRIORS_SNAPSHOT;
      const live = new Map(liveRows.map((r) => [r.bucket, r]));
      const staleReasons = [];
      const buckets = (llm.RUN_LENGTH_PRIORS.buckets || []).map((b) => {
        const row = live.get(b.key);
        const liveP50 = row ? num(row.live_p50) : null;
        const driftRatio = (liveP50 == null || !b.p50)
          ? null : Math.abs(liveP50 - b.p50) / b.p50;
        if (driftRatio != null && driftRatio > DRIFT_THRESHOLD) {
          staleReasons.push(`bucket ${b.key} drifted ${Math.round(driftRatio * 100)}%`);
        }
        return {
          bucket: b.key,
          committedP50: b.p50,
          liveP50,
          driftRatio: driftRatio == null ? null : Number(driftRatio.toFixed(2)),
          scored: row ? row.scored : 0,
        };
      });
      const liveScored = allRow ? allRow.scored : 0;
      if (snapshot.scoredTicks && liveScored > 2 * snapshot.scoredTicks) {
        staleReasons.push(`scored guesses more than doubled (${liveScored} vs ${snapshot.scoredTicks})`);
      }
      return { snapshot, buckets, stale: staleReasons.length > 0, staleReasons };
    };

    const shapeMonotonicity = (m, g) => ({
      transitions: m ? m.transitions : 0,
      // RAW = what the model said tick to tick. DISPLAYED = what the guard
      // let the user see. A large gap between them is the guard working.
      raw: {
        laterRate: num(m && m.raw_later),
        earlierRate: num(m && m.raw_earlier),
        increasedRate: num(m && m.raw_increased),
        medianShiftS: num(m && m.raw_median_shift),
        p90ShiftS: num(m && m.raw_p90_shift),
      },
      displayed: {
        transitions: m ? m.disp_transitions : 0,
        laterRate: num(m && m.disp_later),
        earlierRate: num(m && m.disp_earlier),
        increasedRate: num(m && m.disp_increased),
        medianShiftS: num(m && m.disp_median_shift),
        p90ShiftS: num(m && m.disp_p90_shift),
      },
      clampRate: num(g && g.clamp_rate),
      flooredRate: num(g && g.floored_rate),
      slipReasons: {
        expired: g ? g.slip_expired : 0,
        new_phase: g ? g.slip_new_phase : 0,
        revision: g ? g.slip_revision : 0,
      },
    });

    try {
      const [
        d30, all, enabled, byElapsed, byOutcome, daily,
        byVersion, baselines, priorsLive, mono, guardAgg, claims,
      ] = await Promise.all([
        pool.query(metricsSql(true)),
        pool.query(metricsSql(false)),
        pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE ai_progress_estimate`),
        // How far into the run the guess was made. A model that is only
        // wrong in the first two minutes is a very different problem from
        // one that is wrong throughout.
        pool.query(
          `SELECT
             ${BUCKET_CASE}                                         AS bucket,
             prompt_version                                         AS prompt_version,
             COUNT(*)::int                                          AS scored,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(${ERR})) AS median_abs_err_s,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY ${ERR})     AS median_bias_s,
             AVG((predicted_remaining_seconds
                    BETWEEN actual_remaining_ms / 2000.0
                        AND actual_remaining_ms / 500.0)::int)      AS within_band
           FROM progress_estimates
           WHERE ${SCORED}
           GROUP BY 1, 2
           ORDER BY MIN(elapsed_ms), 2`
        ),
        pool.query(
          `SELECT
             COALESCE(outcome, 'unknown')                           AS outcome,
             COUNT(*)::int                                          AS scored,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(${ERR})) AS median_abs_err_s,
             AVG((predicted_remaining_seconds
                    BETWEEN actual_remaining_ms / 2000.0
                        AND actual_remaining_ms / 500.0)::int)      AS within_band
           FROM progress_estimates
           WHERE ${SCORED}
           GROUP BY 1
           ORDER BY 2 DESC`
        ),
        pool.query(
          `SELECT
             created_at::date::text                                 AS day,
             COUNT(*)::int                                          AS scored,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(${ERR})) AS median_abs_err_s
           FROM progress_estimates
           WHERE ${SCORED} AND created_at >= NOW() - INTERVAL '30 days'
           GROUP BY 1
           ORDER BY 1`
        ),

        // ── #892: is the recalibrated prompt actually better? ──────
        //
        // Pooling v1 and v2 into one average hides the answer, so every
        // headline metric is also reported per prompt generation. v1 is the
        // "bias toward 2-10 minutes" prompt whose flat output failed every
        // bar; v2 feeds the measured run-length distribution in as input.
        pool.query(`${metricsSql(false, 'prompt_version')}`),

        // Baselines the estimator has to BEAT, computed over the same scored
        // population rather than hard-coded, so they stay honest as the data
        // grows. (a) a fixed constant equal to the population's own median
        // actual remaining — "say the same thing every time"; (b) the
        // elapsed-conditioned median oracle — the best any predictor that
        // knows ONLY elapsed time could possibly do, fitted to the answers.
        // Measured at ~39% in-band, which is why the retired 60% graduation
        // bar was unreachable by anything.
        pool.query(
          `WITH s AS (
             SELECT actual_remaining_ms / 1000.0 AS a, ${BUCKET_CASE} AS bucket
               FROM progress_estimates WHERE ${SCORED}
           ),
           k AS (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY a) AS c FROM s),
           o AS (SELECT bucket, percentile_cont(0.5) WITHIN GROUP (ORDER BY a) AS m
                   FROM s GROUP BY 1),
           j AS (SELECT s.a, (SELECT c FROM k) AS cp, o.m AS op
                   FROM s JOIN o ON o.bucket = s.bucket)
           SELECT
             COUNT(*)::int                                            AS scored,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(cp - a)) AS const_abs,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY cp - a)      AS const_bias,
             AVG((cp BETWEEN a / 2 AND a * 2)::int)                   AS const_band,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(op - a)) AS oracle_abs,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY op - a)      AS oracle_bias,
             AVG((op BETWEEN a / 2 AND a * 2)::int)                   AS oracle_band
           FROM j`
        ),

        // Live per-bucket medians for the priors-staleness check. Same
        // BUCKET_CASE as the oracle baseline above — deliberately, so the
        // card can never report a drift the baseline disagrees with.
        pool.query(
          `SELECT ${BUCKET_CASE}                                     AS bucket,
                  COUNT(*)::int                                       AS scored,
                  percentile_cont(0.5) WITHIN GROUP (ORDER BY actual_remaining_ms / 1000.0) AS live_p50
             FROM progress_estimates
            WHERE ${SCORED}
            GROUP BY 1`
        ),

        // Monotonicity, computed twice: on the RAW model values (what the
        // model said) and on the DISPLAYED post-guard values (what the user
        // saw). The guard's whole purpose is to make those differ, so
        // collapsing them into one number would hide whether it works.
        // Partitioned by progress_message_id — a RUN — not by session: a
        // session holds many runs and their projections are unrelated.
        pool.query(
          `WITH s AS (
             SELECT progress_message_id, created_at, elapsed_ms / 1000.0 AS e,
                    predicted_remaining_seconds AS rp,
                    displayed_remaining_seconds AS dp
               FROM progress_estimates
              WHERE predicted_remaining_seconds IS NOT NULL
                AND progress_message_id IS NOT NULL
           ),
           t AS (
             SELECT
               e + rp                                      AS raw_total,
               LAG(e + rp) OVER w                          AS prev_raw_total,
               rp, LAG(rp) OVER w                          AS prev_rp,
               e + dp                                      AS disp_total,
               LAG(e + dp) OVER w                          AS prev_disp_total,
               dp, LAG(dp) OVER w                          AS prev_dp
             FROM s
             WINDOW w AS (PARTITION BY progress_message_id ORDER BY created_at)
           )
           SELECT
             COUNT(*) FILTER (WHERE prev_raw_total IS NOT NULL)::int      AS transitions,
             AVG((raw_total > prev_raw_total + 5)::int)                   AS raw_later,
             AVG((raw_total < prev_raw_total - 5)::int)                   AS raw_earlier,
             AVG((rp > prev_rp)::int)                                     AS raw_increased,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY raw_total - prev_raw_total)  AS raw_median_shift,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY raw_total - prev_raw_total)  AS raw_p90_shift,
             COUNT(*) FILTER (WHERE prev_disp_total IS NOT NULL)::int     AS disp_transitions,
             AVG((disp_total > prev_disp_total + 5)::int)                 AS disp_later,
             AVG((disp_total < prev_disp_total - 5)::int)                 AS disp_earlier,
             AVG((dp > prev_dp)::int)                                     AS disp_increased,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY disp_total - prev_disp_total) AS disp_median_shift,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY disp_total - prev_disp_total) AS disp_p90_shift
           FROM t`
        ),

        // Guard telemetry. `flooredRate` — the share of ticks where the 30s
        // display floor bound — is the direct measure of how often a run
        // outlives its estimate, and is derived from the displayed value
        // rather than stored as its own column.
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE displayed_remaining_seconds IS NOT NULL)::int AS guarded,
             AVG(clamped::int) FILTER (WHERE displayed_remaining_seconds IS NOT NULL)         AS clamp_rate,
             AVG((displayed_remaining_seconds <= 30)::int)
               FILTER (WHERE displayed_remaining_seconds IS NOT NULL)                          AS floored_rate,
             COUNT(*) FILTER (WHERE slip_reason = 'expired')::int   AS slip_expired,
             COUNT(*) FILTER (WHERE slip_reason = 'new_phase')::int AS slip_new_phase,
             COUNT(*) FILTER (WHERE slip_reason = 'revision')::int  AS slip_revision
           FROM progress_estimates`
        ),

        // Completion-claim reliability. Measured over v1 this fired 1,355
        // times with 5+ minutes still to run a third of the time, which is
        // what the suppression gate exists to stop.
        pool.query(
          `SELECT
             COUNT(*)::int                                          AS ticks,
             COUNT(*) FILTER (WHERE suppressed)::int                AS suppressed,
             AVG((actual_remaining_ms > 300000)::int)
               FILTER (WHERE actual_total_ms IS NOT NULL AND actual_remaining_ms > 0) AS over_five_min_left_rate,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY actual_remaining_ms / 1000.0)
               FILTER (WHERE actual_total_ms IS NOT NULL AND actual_remaining_ms > 0) AS median_actual_left_s
           FROM progress_estimates
           WHERE suppressed OR estimate_text ~* '${CLAIM_RE}'`
        ),
      ]);

      const payload = {
        last30d: shapeMetrics(d30.rows[0]),
        allTime: shapeMetrics(all.rows[0]),
        usersEnabled: enabled.rows[0].n,
        byElapsed: byElapsed.rows.map((r) => ({
          bucket: r.bucket,
          scored: r.scored,
          medianAbsErrS: num(r.median_abs_err_s),
          withinBand: num(r.within_band),
        })),
        byOutcome: byOutcome.rows.map((r) => ({
          outcome: r.outcome,
          scored: r.scored,
          medianAbsErrS: num(r.median_abs_err_s),
          withinBand: num(r.within_band),
        })),
        daily: daily.rows.map((r) => ({
          day: r.day, scored: r.scored, medianAbsErrS: num(r.median_abs_err_s),
        })),
        // #892: v1 (flat-prior prompt) vs v2 (empirical priors as input),
        // never pooled — pooling is exactly what would hide whether the
        // recalibration worked.
        byPromptVersion: byVersion.rows.map((r) => ({
          promptVersion: Number(r.group_key), ...shapeMetrics(r),
        })),
        baselines: shapeBaselines(baselines.rows[0]),
        priors: shapePriors(priorsLive.rows, all.rows[0]),
        monotonicity: shapeMonotonicity(mono.rows[0], guardAgg.rows[0]),
        completionClaims: {
          ticks: claims.rows[0].ticks,
          suppressed: claims.rows[0].suppressed,
          overFiveMinLeftRate: num(claims.rows[0].over_five_min_left_rate),
          medianActualLeftS: num(claims.rows[0].median_actual_left_s),
        },
      };

      // Staging demo: progress_estimates is `staging:private`, so a
      // prod-cloned staging DB has it schema-only — the card would be a wall
      // of dashes in every PR preview. Substituted only when genuinely empty.
      if (wantsDemo(req) && !payload.allTime.ticks) {
        return res.json(analyticsDemo.estimatorAccuracy());
      }
      res.json(payload);
    } catch (err) {
      log.error('dashboard', 'estimator failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { dashboardRoutes };
