'use strict';

// The Admin console's dashboard (#7081): the platform's counts over a
// period, each beside the same count for the period before it, plus what is
// waiting in the moderation queue and what went live lately.
//
// READ-ONLY, and every figure is a COUNT of rows that already exist: no
// figure is estimated, sampled or cached here, and nothing is written. A
// count with no meaningful "period" (every account, every app, every
// community, the open moderation cases) is a total; the ones that happen at
// a moment (an account made, a project made, a change put up for a vote, a
// vote cast, a change going live) are counted in the window and in the
// window before it, so the console can say which way each is moving.
//
// The route (routes/admin.js, GET /api/admin/dashboard) sits behind
// adminMiddleware like every other /api/admin read: full and view-only
// admins read it, nobody else does.

const PERIODS = Object.freeze([7, 30, 90]);
const DEFAULT_DAYS = 30;
const QUEUE_LIMIT = 5;
const SHIPPED_LIMIT = 6;

/** The period asked for, or null when it is not one the dashboard offers. */
function parseDays(raw) {
  if (raw == null || raw === '') return DEFAULT_DAYS;
  const n = Number(raw);
  return PERIODS.includes(n) ? n : null;
}

// One round trip for every count. `$1` is the period in days. Each windowed
// count is a pair: `…_now` for the last $1 days and `…_before` for the $1
// days before those.
const COUNTS_SQL = `
  WITH w AS (
    SELECT NOW() - make_interval(days => $1::int)     AS start_now,
           NOW() - make_interval(days => $1::int * 2) AS start_before
  )
  SELECT
    (SELECT COUNT(*)::int FROM users)                                                        AS users_total,
    (SELECT COUNT(*)::int FROM users, w WHERE users.created_at >= w.start_now)               AS users_now,
    (SELECT COUNT(*)::int FROM users, w WHERE users.created_at >= w.start_before
                                          AND users.created_at <  w.start_now)               AS users_before,
    (SELECT COUNT(*)::int FROM apps)                                                         AS apps_total,
    (SELECT COUNT(*)::int FROM apps, w WHERE apps.created_at >= w.start_now)                 AS apps_now,
    (SELECT COUNT(*)::int FROM apps, w WHERE apps.created_at >= w.start_before
                                         AND apps.created_at <  w.start_now)                 AS apps_before,
    (SELECT COUNT(*)::int FROM communities)                                                  AS communities_total,
    (SELECT COUNT(*)::int FROM chat_sessions s, w WHERE s.promoted_at >= w.start_now)        AS proposals_now,
    (SELECT COUNT(*)::int FROM chat_sessions s, w WHERE s.promoted_at >= w.start_before
                                                    AND s.promoted_at <  w.start_now)        AS proposals_before,
    (SELECT COUNT(*)::int FROM pr_votes v, w WHERE v.created_at >= w.start_now)              AS votes_now,
    (SELECT COUNT(*)::int FROM pr_votes v, w WHERE v.created_at >= w.start_before
                                               AND v.created_at <  w.start_now)              AS votes_before,
    (SELECT COUNT(DISTINCT v.user_id)::int FROM pr_votes v, w WHERE v.created_at >= w.start_now) AS voters_now,
    (SELECT COUNT(DISTINCT v.user_id)::int FROM pr_votes v, w WHERE v.created_at >= w.start_before
                                                                AND v.created_at <  w.start_now) AS voters_before,
    (SELECT COUNT(*)::int FROM chat_sessions s, w WHERE s.merged_at >= w.start_now)          AS shipped_now,
    (SELECT COUNT(*)::int FROM chat_sessions s, w WHERE s.merged_at >= w.start_before
                                                    AND s.merged_at <  w.start_now)          AS shipped_before,
    (SELECT COUNT(*)::int FROM moderation_cases WHERE status IN ('new', 'in_review'))        AS moderation_open,
    (SELECT COUNT(*)::int FROM moderation_cases WHERE status = 'new')                        AS moderation_new
`;

// The cases still open, the ones waiting longest first: what a moderator
// would open next. The label is the one Moderation's own list shows.
const QUEUE_SQL = `
  SELECT c.id, c.target_type, c.target_label, c.status, c.created_at, c.updated_at,
         (SELECT COUNT(*)::int FROM moderation_reports r WHERE r.case_id = c.id AND r.cycle = c.cycle) AS reports,
         (SELECT r.reason FROM moderation_reports r WHERE r.case_id = c.id AND r.cycle = c.cycle
           ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS reason
    FROM moderation_cases c
   WHERE c.status IN ('new', 'in_review')
   ORDER BY c.updated_at ASC, c.id ASC
   LIMIT $1
`;

// The changes that went live most recently, with the project each is in.
const SHIPPED_SQL = `
  SELECT s.id, s.pr_title, s.merged_at, a.slug AS app_slug, a.name AS app_name
    FROM chat_sessions s
    JOIN apps a ON a.id = s.app_id
   WHERE s.merged_at IS NOT NULL
   ORDER BY s.merged_at DESC, s.id DESC
   LIMIT $1
`;

const pair = (row, key) => ({ now: Number(row[`${key}_now`]) || 0, before: Number(row[`${key}_before`]) || 0 });

/**
 * Everything the dashboard draws, for the last `days` days.
 *
 * @param {{ query: Function }} pool
 * @param {{ days?: number }} [opts]
 */
async function gather(pool, opts = {}) {
  const days = PERIODS.includes(opts.days) ? opts.days : DEFAULT_DAYS;
  const [counts, queue, shipped] = await Promise.all([
    pool.query(COUNTS_SQL, [days]),
    pool.query(QUEUE_SQL, [QUEUE_LIMIT]),
    pool.query(SHIPPED_SQL, [SHIPPED_LIMIT]),
  ]);
  const row = counts.rows[0] || {};
  return {
    days,
    periods: PERIODS.slice(),
    totals: {
      users: Number(row.users_total) || 0,
      apps: Number(row.apps_total) || 0,
      communities: Number(row.communities_total) || 0,
    },
    period: {
      newUsers: pair(row, 'users'),
      newApps: pair(row, 'apps'),
      proposals: pair(row, 'proposals'),
      votes: pair(row, 'votes'),
      voters: pair(row, 'voters'),
      shipped: pair(row, 'shipped'),
    },
    moderation: {
      open: Number(row.moderation_open) || 0,
      fresh: Number(row.moderation_new) || 0,
      queue: queue.rows.map((r) => ({
        id: Number(r.id),
        targetType: r.target_type,
        label: r.target_label,
        status: r.status,
        reports: Number(r.reports) || 0,
        reason: r.reason || null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    },
    shipped: shipped.rows.map((r) => ({
      id: Number(r.id),
      title: r.pr_title || null,
      appSlug: r.app_slug,
      appName: r.app_name,
      mergedAt: r.merged_at,
    })),
  };
}

module.exports = { gather, parseDays, PERIODS, DEFAULT_DAYS, COUNTS_SQL, QUEUE_SQL, SHIPPED_SQL };
