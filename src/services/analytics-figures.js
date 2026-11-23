'use strict';

// The admin analytics figures that something besides the dashboard reads:
// who counts as active, and what the platform spent on AI. Moved here from
// routes/dashboard.js so Admin › Analytics and Homeroom bot's automatic
// switch to verified accounts (services/homeroom-bot-verified-auto.js) read
// one definition and cannot disagree:
//
//   activeUsersSql    the Overview's WAU and MAU (MAU: distinct people
//                     active on any of the trailing 30 UTC days)
//   dailySpendSql     the Daily spend chart's rows, one a day for the last
//                     30 days (today included)
//   trailingFigures   those two read the way the dashboard shows them by
//                     default (admins left out): MAU, and the 30 days'
//                     platform-key spend plus system tokens, the chart's
//                     "Platform" bars added up. Spend on a person's own key
//                     (BYOK) is not the platform's and is not in it.
//
// The bot's own spend is in it: every turn, plan, build and picture the bot
// pays for is recorded in llm_usage on its own account
// (homeroom-bot-turn-engine.js, bot-pictures.js, homeroom-bot.js
// limits.recordSpend), and the spend reads keep synthetic accounts
// (`keepSynthetic`).

// Admin-exclusion predicate (dashboard checkbox #1). When `includeAdmins`
// is false (the default) every analytics query drops rows attributed to
// an admin account (users.is_admin = TRUE — view-only admins included).
// Test accounts (services/test-accounts.js) and synthetic accounts
// (users.is_synthetic: the Homeroom bot) are dropped whatever the box says:
// they are nobody's real use, and with the box on they would land in the
// non-admin column. The bot's own work is not lost by this: a change it
// built is credited to the person who asked for it (CHANGE_PERSON_SQL), and
// that person's messages to it count as their activity. That half keeps a
// row with no user (a NULL `col`), as the query did before it. `col` is the
// user-id column to test in the calling query. Returns a fragment that
// begins with the given keyword (AND by default) so it can be spliced into
// an existing WHERE clause or stand alone.
//
// Spend totals pass `keepSynthetic`: the bot's LLM spend is recorded on its
// own account, and dropping it would understate what the platform spent.
function adminFilter(col, includeAdmins, keyword = 'AND', { keepSynthetic = false } = {}) {
  const notPeople = keepSynthetic
    ? 'test_account_created_at IS NOT NULL'
    : 'test_account_created_at IS NOT NULL OR is_synthetic';
  const tests = `(${col} IS NULL OR ${col} NOT IN (SELECT id FROM users WHERE ${notPeople}))`;
  if (includeAdmins) return `${keyword} ${tests}`;
  return `${keyword} ${col} NOT IN (SELECT id FROM users WHERE is_admin) AND ${tests}`;
}

// Analytics days are UTC regardless of the PostgreSQL session timezone.
// app_activity.date is already a stored calendar-day fact; every TIMESTAMPTZ
// source and each rolling-window spine is normalized explicitly here.
const UTC_TODAY_SQL = "(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date";

// "Active" surface: one row per (user, UTC calendar day) with recorded
// participation. Positive project-use heartbeats count; the independent
// heartbeat-engagement work will tighten their legacy idle behavior. Every
// other arm is a deliberate human action. Passive reads and system,
// assistant, or generated rows do not count. Global Chat's owner-scoped
// conversations join back to their human owner; every other source
// carries its actor directly. UNION, rather than UNION ALL, keeps the result
// de-duplicated when one person acts more than once or on several surfaces.
// Current-state vote/kudos tables preserve the rows still present; their
// best-effort events preserve captured actions after a later edit or
// retraction. A favorite counts only from the explicit user-toggle event,
// never from app_favorites state that non-user workflows also populate.
// Actions removed before their event existed cannot be rebuilt. Filing a
// request (issues.created_by) counts too (#3970): people increasingly ask
// the Homeroom bot for changes instead of opening a dev session, and their
// messages to it already count through the Messages arm. The bot's own
// rows (its build sessions, the requests it files) drop out with every
// other synthetic account in adminFilter.
//
// Built per request so the same admin-exclusion predicate (users.is_admin,
// which includes full and view-only admins) is present in every UNION arm.
function activityDaysSql(includeAdmins) {
  const aa = adminFilter('aa.user_id', includeAdmins);
  const cm = adminFilter('cm.user_id', includeAdmins);
  const cs = adminFilter('cs.user_id', includeAdmins);
  const messages = adminFilter('m.sender_id', includeAdmins);
  const globalChat = adminFilter('gct.user_id', includeAdmins);
  const prVotes = adminFilter('pv.user_id', includeAdmins);
  const issueVotes = adminFilter('iv.user_id', includeAdmins);
  const kudos = adminFilter('pk.giver_user_id', includeAdmins);
  const filed = adminFilter('ri.created_by', includeAdmins);
  const durable = adminFilter('e.user_id', includeAdmins);
  return `
  SELECT aa.user_id, aa.date AS day
    FROM app_activity aa
   WHERE aa.user_id IS NOT NULL AND aa.seconds_spent > 0 ${aa}
  UNION
  SELECT cm.user_id, (cm.created_at AT TIME ZONE 'UTC')::date AS day
    FROM chat_messages cm
   WHERE cm.user_id IS NOT NULL AND cm.msg_type = 'message' ${cm}
  UNION
  SELECT cs.user_id, (csm.created_at AT TIME ZONE 'UTC')::date AS day
    FROM chat_session_messages csm
    JOIN chat_sessions cs ON cs.id = csm.session_id
   WHERE cs.user_id IS NOT NULL AND csm.role = 'user' ${cs}
  UNION
  SELECT m.sender_id, (m.created_at AT TIME ZONE 'UTC')::date AS day
    FROM conversation_messages m
   WHERE m.sender_id IS NOT NULL AND m.msg_type = 'message' ${messages}
  UNION
  SELECT gct.user_id, (gcm.created_at AT TIME ZONE 'UTC')::date AS day
    FROM global_chat_messages gcm
    JOIN global_chat_threads gct ON gct.id = gcm.thread_id
   WHERE gcm.role = 'user' ${globalChat}
  UNION
  SELECT pv.user_id, (pv.created_at AT TIME ZONE 'UTC')::date AS day
    FROM pr_votes pv
   WHERE pv.user_id IS NOT NULL ${prVotes}
  UNION
  SELECT iv.user_id, (iv.created_at AT TIME ZONE 'UTC')::date AS day
    FROM issue_votes iv
   WHERE iv.user_id IS NOT NULL ${issueVotes}
  UNION
  SELECT pk.giver_user_id, (pk.created_at AT TIME ZONE 'UTC')::date AS day
    FROM pr_kudos pk
   WHERE pk.giver_user_id IS NOT NULL ${kudos}
  UNION
  SELECT ri.created_by, (ri.created_at AT TIME ZONE 'UTC')::date AS day
    FROM issues ri
   WHERE ri.created_by IS NOT NULL ${filed}
  UNION
  SELECT e.user_id, (e.created_at AT TIME ZONE 'UTC')::date AS day
    FROM events e
   WHERE e.user_id IS NOT NULL
     AND (
       e.event_type IN ('pr_vote_cast','issue_vote_cast','kudos_given')
       OR (
         e.event_type = 'app_favorited'
         AND e.metadata->>'source' = 'user_favorite_toggle'
       )
     )
     ${durable}
`;
}

// The Overview's active-user counters: WAU over the trailing 7 UTC days, MAU
// over the trailing 30, today included.
function activeUsersSql(includeAdmins) {
  return `WITH activity AS (${activityDaysSql(includeAdmins)})
           SELECT
             COUNT(DISTINCT user_id) FILTER (WHERE day >= ${UTC_TODAY_SQL} - 6)::int  AS wau,
             COUNT(DISTINCT user_id) FILTER (WHERE day >= ${UTC_TODAY_SQL} - 29)::int AS mau
           FROM activity`;
}

// Total LLM spend per calendar day for the last 30 days (today inclusive).
// Platform-key spend (total_cost_cents, which drives the daily caps) and
// user-key/BYOK spend (byok_cost_cents, display only) separately per day,
// each with its admin-attributed part, and the day's system-token spend.
function dailySpendSql(includeAdmins) {
  return `WITH spine AS (
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
             ${adminFilter('lu.user_id', includeAdmins, 'AND', { keepSynthetic: true })}
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
         ORDER BY s.day`;
}

/** What the platform paid over the chart's days: platform key plus system tokens, in cents. Pure. */
function platformSpendCents(days) {
  let cents = 0;
  for (const d of days || []) cents += (Number(d.platform_cents) || 0) + (Number(d.system_cents) || 0);
  return Math.round(cents * 100) / 100;
}

/**
 * The two figures as Admin › Analytics shows them by default (admins left
 * out): { activeUsers, aiSpendCents }. Either is null when its read failed;
 * the other is still answered. Never throws.
 */
async function trailingFigures(pool, { includeAdmins = false } = {}) {
  const [active, spend] = await Promise.allSettled([
    pool.query(activeUsersSql(includeAdmins)),
    pool.query(dailySpendSql(includeAdmins)),
  ]);
  const mau = active.status === 'fulfilled' ? Number(active.value.rows?.[0]?.mau) : NaN;
  return {
    activeUsers: Number.isFinite(mau) ? mau : null,
    aiSpendCents: spend.status === 'fulfilled' ? platformSpendCents(spend.value.rows) : null,
  };
}

module.exports = {
  adminFilter,
  UTC_TODAY_SQL,
  activityDaysSql,
  activeUsersSql,
  dailySpendSql,
  platformSpendCents,
  trailingFigures,
};
