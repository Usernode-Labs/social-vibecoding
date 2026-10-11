'use strict';

// Topic figures: the strip of numbers at the top of a topic's channel.
//
// A topic (dapp.json's `topics`, app-manifest.js) may name, in its
// `figures` list, a few of the figures registered below. Its channel then
// shows them above the room, to everyone who can read it: how the platform
// is doing on the part of it the topic is about. Which figures a topic shows
// is a line in dapp.json, so changing it is a proposal like any other.
//
// Every figure is read off what the platform already records. Where
// Homeroom's own numbers and the other projects' are different things (the
// bot's cost and speed, the proposal pipeline, merge to live), the figure is
// SPLIT: one cell shows Homeroom beside Other projects, since a median of
// the two describes neither. The rest cover what they say: every project,
// the other projects only, or the people joining the platform.
//
// Figures about PEOPLE (the onboarding ones) protect the individual: they
// are rounded more as the group behind them gets smaller, a group under 10
// says "Not enough data", a 0% or 100% says "Under" or "Over" instead, and
// they cover the 30 days that ended at the start of today (UTC), so they
// change once a day and nobody can watch one person's arrival move them.
// They count real people the way the admin Journey does (journey.js): no
// staff, test or synthetic account, nobody on the team's addresses and
// nobody left out of it. The server does the rounding; the client is only
// ever sent the words.
//
// A figure the platform does not record yet says "Not recorded yet", never
// 0, and each query fails on its own: a figure that could not be read says
// so and the rest of the strip still draws.

const log = require('./logger');
const journey = require('./journey');
const journeyLeftOut = require('./journey-left-out');

const DAY_MS = 24 * 60 * 60 * 1000;
// Rolling windows end on a 10-minute boundary, so requests in the same ten
// minutes share one reading.
const ROLLING_STEP_MS = 10 * 60 * 1000;
const ROLLING_TTL_MS = 10 * 60 * 1000;
const PLATFORM_IDS_TTL_MS = 10 * 60 * 1000;
const BOT_USERNAME = 'homeroom_bot';

// The two sides of a split figure.
const SIDES = Object.freeze([
  Object.freeze({ key: 'homeroom', name: 'Homeroom' }),
  Object.freeze({ key: 'others', name: 'Other projects' }),
]);
const COVERS = Object.freeze(['all', 'split', 'others']);
// Group sizes for figures about people.
const PEOPLE_MIN = 10;
const PEOPLE_FIVE = 20;
const PEOPLE_EXACT = 50;
// How many figures one topic may show.
const MAX_TOPIC_FIGURES = 6;

const NOTE_PEOPLE = 'Totals only. Smaller groups are rounded more; under 10 people shows “Not enough data”.';
const FEW_PEOPLE = 'Fewer than 10 people so far';

// ── The queries ──────────────────────────────────────────────────────────
//
// Each one names its SQL constant where it is called, so
// scripts/check-sql.js resolves and checks it against the schema. Window
// bounds are $1 (from) and $2 (until). The scoped ones take $3 (every
// project), $4 (the platform's own app ids) and $5 (true: only those;
// false: every other project). A DM with the bot belongs to no project; it
// counts toward Homeroom, whose bot it is. The ones about people take
// journey.js's real-person parameters as $3 (reserved name patterns) and
// $4 (the ids left out of the Journey).

// Somebody new to the platform: a real person who was let in during the
// window.
const NEWCOMER_SQL = `u.has_platform_access
     AND u.platform_access_granted_at >= $1::timestamptz
     AND u.platform_access_granted_at < $2::timestamptz
     AND ${journey.REAL_PERSON_SQL}`;

// Each newcomer's first project.
const FIRST_PROJECTS_CTE = `firsts AS (
    SELECT DISTINCT ON (ap.created_by) ap.id AS app_id, ap.created_by AS user_id,
           ap.created_at, ap.first_running_at
      FROM apps ap
      JOIN users u ON u.id = ap.created_by
     WHERE ap.self_hosted IS NOT TRUE
       AND ${NEWCOMER_SQL}
     ORDER BY ap.created_by, ap.created_at, ap.id
  )`;

// Let in → signed up: the people let in from the waitlist in the window
// (an admin's test release lets in nobody) and how many of them have an
// account now, counted as the Journey's first mile counts them
// (journey.js COHORTS_SQL).
const SIGN_UP_SQL = `WITH ${journey.ADMITTED_CTE}
  SELECT COUNT(*)::int AS total, COUNT(u.id)::int AS hits
    FROM admitted a
    LEFT JOIN users u ON u.id = a.linked_user_id
   WHERE a.released_at >= $1::timestamptz AND a.released_at < $2::timestamptz
     AND ${journey.NEWCOMER_OR_NO_ACCOUNT}`;

const FIRST_PROJECT_RUNNING_SQL = `
  WITH ${FIRST_PROJECTS_CTE}
  SELECT COUNT(*) FILTER (WHERE first_running_at >= created_at)::int AS n,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM first_running_at - created_at))
           FILTER (WHERE first_running_at >= created_at))::float8 AS median_secs
    FROM firsts`;

// From a newcomer making their first project to a change they asked for on
// it going live (the change_live event names who asked for it).
const FIRST_CHANGE_LIVE_SQL = `
  WITH ${FIRST_PROJECTS_CTE}, live AS (
    SELECT f.created_at,
           (SELECT MIN(e.created_at) FROM events e
             WHERE e.event_type = 'change_live' AND e.app_id = f.app_id
               AND e.metadata->'requesterIds' @> to_jsonb(f.user_id)) AS live_at
      FROM firsts f
  )
  SELECT COUNT(*) FILTER (WHERE live_at >= created_at)::int AS n,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM live_at - created_at))
           FILTER (WHERE live_at >= created_at))::float8 AS median_secs
    FROM live`;

// Newcomers who had their whole first week inside the window, and how many
// of them made a project or joined one in it. Joining Homeroom's own
// community does not count: everyone is put in it.
const FOUND_PROJECT_SQL = `
  WITH newcomers AS (
    SELECT u.id, u.platform_access_granted_at AS let_in_at
      FROM users u
     WHERE u.has_platform_access
       AND u.platform_access_granted_at >= $1::timestamptz
       AND u.platform_access_granted_at < $2::timestamptz - interval '7 days'
       AND ${journey.REAL_PERSON_SQL}
  )
  SELECT COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM apps ap
              WHERE ap.created_by = n.id AND ap.self_hosted IS NOT TRUE
                AND ap.created_at < n.let_in_at + interval '7 days')
           OR EXISTS (
             SELECT 1 FROM community_members m
               JOIN apps ap ON ap.community_id = m.community_id AND ap.self_hosted IS NOT TRUE
              WHERE m.user_id = n.id AND m.source = 'joined'
                AND m.joined_at < n.let_in_at + interval '7 days'))::int AS hits
    FROM newcomers n`;

// The bot's answers: thread and chat turns (a quiet turn chose not to
// answer, so it is not counted) and DM turns, what they cost, and how many
// went out as written.
const BOT_ANSWERS_SQL = `
  SELECT (SELECT COUNT(*) FROM homeroom_bot_voice_turns t
           WHERE t.started_at >= $1::timestamptz AND t.started_at < $2::timestamptz
             AND t.outcome IN ('replied', 'fallback', 'failed')
             AND ($3::boolean OR (t.app_id = ANY($4::int[])) = $5::boolean))::int AS voice_total,
         (SELECT COUNT(*) FROM homeroom_bot_voice_turns t
           WHERE t.started_at >= $1::timestamptz AND t.started_at < $2::timestamptz
             AND t.outcome = 'replied'
             AND ($3::boolean OR (t.app_id = ANY($4::int[])) = $5::boolean))::int AS voice_ok,
         (SELECT COUNT(*) FROM homeroom_bot_voice_turns t
           WHERE t.started_at >= $1::timestamptz AND t.started_at < $2::timestamptz
             AND t.outcome IN ('replied', 'fallback')
             AND ($3::boolean OR (t.app_id = ANY($4::int[])) = $5::boolean))::int AS voice_posted,
         (SELECT COALESCE(SUM(t.cost_usd), 0) FROM homeroom_bot_voice_turns t
           WHERE t.started_at >= $1::timestamptz AND t.started_at < $2::timestamptz
             AND ($3::boolean OR (t.app_id = ANY($4::int[])) = $5::boolean))::float8 AS voice_cost,
         (SELECT COUNT(*) FROM homeroom_bot_dm_turns d
           WHERE d.created_at >= $1::timestamptz AND d.created_at < $2::timestamptz
             AND ($3::boolean OR $5::boolean))::int AS dm_total,
         (SELECT COUNT(*) FROM homeroom_bot_dm_turns d
           WHERE d.created_at >= $1::timestamptz AND d.created_at < $2::timestamptz
             AND d.error IS NULL AND ($3::boolean OR $5::boolean))::int AS dm_ok,
         (SELECT COUNT(*) FROM homeroom_bot_dm_turns d
           WHERE d.created_at >= $1::timestamptz AND d.created_at < $2::timestamptz
             AND d.fallback IS DISTINCT FROM 'broken' AND ($3::boolean OR $5::boolean))::int AS dm_posted,
         (SELECT COALESCE(SUM(d.cost_usd), 0) FROM homeroom_bot_dm_turns d
           WHERE d.created_at >= $1::timestamptz AND d.created_at < $2::timestamptz
             AND ($3::boolean OR $5::boolean))::float8 AS dm_cost`;

// From the message the bot answered to its reply: a thread or chat reply
// against the newest message its turn read, a DM answer against the
// person's message.
const BOT_REPLY_TIME_SQL = `
  SELECT COUNT(*)::int AS n,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY x.secs))::float8 AS median_secs
    FROM (
      SELECT EXTRACT(EPOCH FROM rp.created_at - th.created_at) AS secs
        FROM homeroom_bot_voice_turns t
        JOIN chat_messages th ON th.id = t.through_message_id
        JOIN chat_messages rp ON rp.id = t.reply_message_id
       WHERE t.started_at >= $1::timestamptz AND t.started_at < $2::timestamptz
         AND t.outcome = 'replied' AND rp.created_at >= th.created_at
         AND ($3::boolean OR (t.app_id = ANY($4::int[])) = $5::boolean)
      UNION ALL
      SELECT EXTRACT(EPOCH FROM d.created_at - cm.created_at)
        FROM homeroom_bot_dm_turns d
        JOIN conversation_messages cm ON cm.id = d.message_id
       WHERE d.created_at >= $1::timestamptz AND d.created_at < $2::timestamptz
         AND d.error IS NULL AND d.created_at >= cm.created_at AND ($3::boolean OR $5::boolean)
    ) x`;

// Proposals put up in the window that have settled (merged, or closed
// without merging), the bot's beside everyone else's, and how long the
// bot's took from the request being filed (homeroom-bot-health.js reads
// the same).
const BOT_PROPOSALS_SQL = `
  WITH props AS (
    SELECT cs.id, cs.status, cs.promoted_at,
           (u.username = $6::text AND u.is_synthetic = TRUE) AS by_bot,
           u.is_synthetic AS synthetic
      FROM chat_sessions cs
      JOIN users u ON u.id = cs.user_id
     WHERE cs.promoted_at >= $1::timestamptz AND cs.promoted_at < $2::timestamptz
       AND ($3::boolean OR (cs.app_id = ANY($4::int[])) = $5::boolean)
  ), timed AS (
    SELECT p.promoted_at,
           (SELECT MIN(i.created_at)
              FROM homeroom_bot_runs pr
              JOIN issues i ON i.app_id = pr.app_id AND i.github_issue_number = pr.issue_number
             WHERE pr.proposal_session_id = p.id) AS filed_at
      FROM props p
     WHERE p.by_bot
  )
  SELECT (SELECT COUNT(*) FROM props WHERE by_bot AND status IN ('merged', 'paused', 'archived'))::int AS bot_settled,
         (SELECT COUNT(*) FROM props WHERE by_bot AND status = 'merged')::int AS bot_merged,
         (SELECT COUNT(*) FROM props WHERE synthetic IS NOT TRUE AND status IN ('merged', 'paused', 'archived'))::int AS people_settled,
         (SELECT COUNT(*) FROM props WHERE synthetic IS NOT TRUE AND status = 'merged')::int AS people_merged,
         (SELECT COUNT(*) FROM timed WHERE promoted_at >= filed_at)::int AS timed,
         (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM promoted_at - filed_at))
            FROM timed WHERE promoted_at >= filed_at)::float8 AS median_secs`;

// What the bot spent reading, planning and building in the window, and the
// proposals of its that merged in it. Only its live runs: a shadow run
// (homeroom_bot_runs.mode 'shadow', the bot building for a project it does
// not propose to yet) can never become a proposal, so counting it charged
// each merge for builds that had no way to merge.
const BOT_SPEND_SQL = `
  SELECT (SELECT COALESCE(SUM(COALESCE(r.cost_usd, 0) + COALESCE(r.build_cost_usd, 0)), 0)
            FROM homeroom_bot_runs r
           WHERE r.mode = 'live'
             AND r.created_at >= $1::timestamptz AND r.created_at < $2::timestamptz
             AND ($3::boolean OR (r.app_id = ANY($4::int[])) = $5::boolean))::float8 AS spent,
         (SELECT COUNT(*)
            FROM chat_sessions cs
            JOIN users u ON u.id = cs.user_id
           WHERE u.username = $6::text AND u.is_synthetic = TRUE AND cs.status = 'merged'
             AND cs.merged_at >= $1::timestamptz AND cs.merged_at < $2::timestamptz
             AND ($3::boolean OR (cs.app_id = ANY($4::int[])) = $5::boolean))::int AS merged`;

// Check runs (merge_debug_runs kind 'checks', kept 30 days): the ones that
// reached a verdict, how long they took (from the start of the preview build
// the run followed, when it followed one: visuals.captureForSession), and the
// ones that ended without one ('error': the change could not be built or
// started, or the checks never answered; the change page says they couldn't
// run).
const CHECKS_SQL = `
  SELECT COUNT(*) FILTER (WHERE r.status IN ('passing', 'failing', 'error'))::int AS total,
         COUNT(*) FILTER (WHERE r.status = 'error')::int AS errors,
         COUNT(*) FILTER (WHERE r.status IN ('passing', 'failing') AND r.ended_at >= r.started_at)::int AS timed,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM r.ended_at - r.started_at))
           FILTER (WHERE r.status IN ('passing', 'failing') AND r.ended_at >= r.started_at))::float8 AS median_secs
    FROM merge_debug_runs r
   WHERE r.kind = 'checks'
     AND r.started_at >= $1::timestamptz AND r.started_at < $2::timestamptz
     AND ($3::boolean OR (r.app_id = ANY($4::int[])) = $5::boolean)`;

// Before & after shot runs that finished, and how many were published.
const SHOTS_SQL = `
  SELECT COUNT(*) FILTER (WHERE s.state IN ('verified', 'failed'))::int AS total,
         COUNT(*) FILTER (WHERE s.state = 'verified')::int AS hits
    FROM shot_runs s
    JOIN chat_sessions cs ON cs.id = s.session_id
   WHERE COALESCE(s.completed_at, s.updated_at) >= $1::timestamptz
     AND COALESCE(s.completed_at, s.updated_at) < $2::timestamptz
     AND ($3::boolean OR (cs.app_id = ANY($4::int[])) = $5::boolean)`;

// From a proposal's first merge attempt (one opens only once its vote has
// passed) to GitHub merging it, for proposals merged in the window.
const VOTE_TO_MERGED_SQL = `
  WITH runs AS (
    SELECT r.id, r.session_id, r.started_at
      FROM merge_debug_runs r
     WHERE r.kind = 'merge' AND r.session_id IS NOT NULL
       AND r.started_at >= $1::timestamptz - interval '7 days' AND r.started_at < $2::timestamptz
       AND ($3::boolean OR (r.app_id = ANY($4::int[])) = $5::boolean)
  ), per AS (
    SELECT ru.session_id, MIN(ru.started_at) AS first_at,
           MIN(s.created_at) FILTER (WHERE s.phase = 'github_merge' AND s.detail ? 'sha') AS merged_at
      FROM runs ru
      LEFT JOIN merge_debug_steps s ON s.run_id = ru.id
     GROUP BY ru.session_id
  )
  SELECT COUNT(*)::int AS n,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM merged_at - first_at)))::float8 AS median_secs
    FROM per
   WHERE merged_at >= $1::timestamptz AND merged_at < $2::timestamptz AND merged_at >= first_at`;

// Merges into a project in the window: from GitHub merging it (or, with no
// GitHub merge, the deploy starting) to the deploy finishing, and the ones
// whose deploy failed. Homeroom's own release runs outside the merge:
// HOMEROOM_LIVE_SQL reads it.
const MERGE_LIVE_SQL = `
  WITH runs AS (
    SELECT r.id, r.summary
      FROM merge_debug_runs r
      JOIN apps ap ON ap.id = r.app_id
     WHERE r.kind = 'merge' AND r.status = 'merged' AND ap.self_hosted IS NOT TRUE
       AND r.started_at >= $1::timestamptz AND r.started_at < $2::timestamptz
  ), timed AS (
    SELECT ru.summary,
           COALESCE(
             (SELECT MIN(s.created_at) FROM merge_debug_steps s
               WHERE s.run_id = ru.id AND s.phase = 'github_merge' AND s.detail ? 'sha'),
             (SELECT MIN(s.created_at) FROM merge_debug_steps s
               WHERE s.run_id = ru.id AND s.phase = 'prod_rebuild')) AS merged_at,
           (SELECT MAX(s.created_at) FROM merge_debug_steps s
             WHERE s.run_id = ru.id AND s.phase = 'prod_rebuild' AND s.detail ? 'sha') AS live_at
      FROM runs ru
  )
  SELECT COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE summary ILIKE '%production deploy failed%')::int AS failed,
         COUNT(*) FILTER (WHERE live_at >= merged_at)::int AS n,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM live_at - merged_at))
           FILTER (WHERE live_at >= merged_at))::float8 AS median_secs
    FROM timed`;

// Merges into Homeroom in the window, from the merge to the first
// production process serving a build that carries it
// (chat_sessions.platform_live_at, services/platform-release.js). One
// still waiting for its release is not counted yet. `since`: when that
// record began, while that is inside the window (#4697).
const HOMEROOM_LIVE_SQL = `
  SELECT COUNT(*)::int AS n,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM cs.platform_live_at - cs.merged_at)))::float8 AS median_secs,
         (SELECT s.value::timestamptz FROM platform_settings s
           WHERE s.key = 'platform_live_tracked_since' AND s.value::timestamptz > $1::timestamptz) AS since
    FROM chat_sessions cs
    JOIN apps ap ON ap.id = cs.app_id AND ap.self_hosted = TRUE
   WHERE cs.status = 'merged'
     AND cs.merged_at >= $1::timestamptz AND cs.merged_at < $2::timestamptz
     AND cs.platform_live_at >= cs.merged_at`;

// Opens of a project's app in the window (dapp_opened: a signed-in person
// entering it from the App tab), and how many loaded: no unavailable page
// was shown for that app within two minutes either side of the open
// (services/app-outages.js keeps one row per app per minute, stamped at the
// minute's start, so a page shown seconds after the open can carry a time
// up to a minute before it). Only opens since those rows began are counted,
// so a week from before them does not read as perfect, and `since` says when
// that was while it is inside the window (#4697).
const APP_OPENS_SQL = `
  WITH since AS (
    SELECT GREATEST($1::timestamptz, COALESCE(
             (SELECT s.value::timestamptz FROM platform_settings s WHERE s.key = 'app_outages_tracked_since'),
             $2::timestamptz)) AS at
  )
  SELECT COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM events d
            WHERE d.event_type = 'app_unavailable' AND d.app_id = o.app_id
              AND d.created_at > o.created_at - interval '2 minutes'
              AND d.created_at < o.created_at + interval '2 minutes'))::int AS hits,
         (SELECT s.value::timestamptz FROM platform_settings s
           WHERE s.key = 'app_outages_tracked_since' AND s.value::timestamptz > $1::timestamptz) AS since
    FROM events o
    JOIN apps ap ON ap.id = o.app_id AND ap.self_hosted IS NOT TRUE
   WHERE o.event_type = 'dapp_opened'
     AND o.created_at >= (SELECT at FROM since) AND o.created_at < $2::timestamptz`;

// The times the watchdog brought a project's app back in the window, and
// in how many projects.
const RESTARTS_SQL = `
  SELECT COALESCE(SUM(COALESCE((e.metadata->>'count')::int, 1)), 0)::int AS n,
         COUNT(DISTINCT e.app_id)::int AS apps
    FROM events e
   WHERE e.event_type = 'app_restarted'
     AND e.created_at >= $1::timestamptz AND e.created_at < $2::timestamptz`;

// A platform limit (apps, sessions, GitHub) filling up: each one notified
// every admin, so one crossing is one limit at one minute.
const LIMITS_SQL = `
  SELECT COUNT(DISTINCT split_part(n.detail, ':', 1) || '@'
           || to_char(date_trunc('minute', n.created_at), 'YYYY-MM-DD HH24:MI'))::int AS n
    FROM notifications n
   WHERE n.kind = 'platform_limit' AND n.detail ~ '^[a-z_]+_full:'
     AND n.created_at >= $1::timestamptz AND n.created_at < $2::timestamptz`;

const PLATFORM_APPS_SQL = 'SELECT id FROM apps WHERE self_hosted = TRUE ORDER BY id';

// ── Sources: one query each, shared by the figures that read it ─────────
//
// A `scoped` source is read once per side it is asked for (every project,
// Homeroom, the other projects); any other reads what it reads, once.

const scoped = (s) => [s.all, s.ids, s.inPlatform];

// journey.js's real-person parameters: the reserved name patterns and the
// people left out of the Journey.
async function realPeople(pool) {
  return journey.realPersonParams(await journeyLeftOut.leftOutIds(pool));
}

const SOURCES = Object.freeze({
  signUp: { days: 30, daily: true, people: true, read: async (pool, w) => pool.query(SIGN_UP_SQL, [w.from, w.until, ...(await realPeople(pool))]) },
  firstProjectRunning: { days: 30, daily: true, people: true, read: async (pool, w) => pool.query(FIRST_PROJECT_RUNNING_SQL, [w.from, w.until, ...(await realPeople(pool))]) },
  firstChangeLive: { days: 30, daily: true, people: true, read: async (pool, w) => pool.query(FIRST_CHANGE_LIVE_SQL, [w.from, w.until, ...(await realPeople(pool))]) },
  foundProject: { days: 30, daily: true, people: true, read: async (pool, w) => pool.query(FOUND_PROJECT_SQL, [w.from, w.until, ...(await realPeople(pool))]) },
  botAnswers: { days: 7, scoped: true, read: (pool, w, s) => pool.query(BOT_ANSWERS_SQL, [w.from, w.until, ...scoped(s)]) },
  botReplyTime: { days: 7, scoped: true, read: (pool, w, s) => pool.query(BOT_REPLY_TIME_SQL, [w.from, w.until, ...scoped(s)]) },
  botProposals: { days: 7, scoped: true, read: (pool, w, s) => pool.query(BOT_PROPOSALS_SQL, [w.from, w.until, ...scoped(s), BOT_USERNAME]) },
  botSpend: { days: 7, scoped: true, read: (pool, w, s) => pool.query(BOT_SPEND_SQL, [w.from, w.until, ...scoped(s), BOT_USERNAME]) },
  checks: { days: 7, scoped: true, read: (pool, w, s) => pool.query(CHECKS_SQL, [w.from, w.until, ...scoped(s)]) },
  shots: { days: 7, scoped: true, read: (pool, w, s) => pool.query(SHOTS_SQL, [w.from, w.until, ...scoped(s)]) },
  voteToMerged: { days: 7, scoped: true, read: (pool, w, s) => pool.query(VOTE_TO_MERGED_SQL, [w.from, w.until, ...scoped(s)]) },
  mergeLive: { days: 7, read: (pool, w) => pool.query(MERGE_LIVE_SQL, [w.from, w.until]) },
  homeroomLive: { days: 7, read: (pool, w) => pool.query(HOMEROOM_LIVE_SQL, [w.from, w.until]) },
  appOpens: { days: 7, read: (pool, w) => pool.query(APP_OPENS_SQL, [w.from, w.until]) },
  restarts: { days: 7, read: (pool, w) => pool.query(RESTARTS_SQL, [w.from, w.until]) },
  limits: { days: 7, read: (pool, w) => pool.query(LIMITS_SQL, [w.from, w.until]) },
});

// ── Formatting ───────────────────────────────────────────────────────────

const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const int = (v) => Math.max(0, Math.trunc(num(v) || 0));

/** "45 s", "9 min", "1 h 20 min", "2 d". Pure. */
function formatDuration(secs) {
  const s = num(secs);
  if (s == null || s < 0) return null;
  if (s < 60) return `${Math.max(1, Math.round(s))} s`;
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} min`;
  if (s < DAY_MS / 1000) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  return `${Math.round(s / 86400)} d`;
}

/** "$0.04", "$3.80", "$120". Pure. */
function formatUsd(v) {
  const n = num(v);
  if (n == null || n < 0) return null;
  if (n >= 100) return `$${Math.round(n)}`;
  return `$${n.toFixed(2)}`;
}

/** "3.1%" under 10%, "58%" from there, "99.4%" short of all. Pure. */
function formatPercent(rate) {
  const r = num(rate);
  if (r == null) return null;
  const pct = r * 100;
  if (pct > 0 && pct < 10) return `${(Math.round(pct * 10) / 10).toString()}%`;
  // Near the top a whole percent hides what matters: 99.4% is not 100%.
  if (pct >= 99 && pct < 100) return `${(Math.floor(pct * 10) / 10).toString()}%`;
  return `${Math.round(pct)}%`;
}

/**
 * A rate about people, rounded by the size of the group behind it:
 * whole percent from 50, nearest 5% from 20, "About N%" (nearest 10%)
 * from 10, and null under 10 (Not enough data). A rate that would read as
 * none or all reads "Under" or "Over" the step instead. Pure.
 *   { text, small } | null
 */
function peopleRate(hits, total) {
  const n = int(total);
  const h = Math.min(int(hits), n);
  if (n < PEOPLE_MIN) return null;
  const rate = h / n;
  const step = n >= PEOPLE_EXACT ? 1 : (n >= PEOPLE_FIVE ? 5 : 10);
  const small = n < PEOPLE_FIVE;
  const rounded = Math.round((rate * 100) / step) * step;
  if (h === 0 || rounded <= 0) return { text: `Under ${step}%`, small };
  if (h === n || rounded >= 100) return { text: `Over ${100 - step}%`, small };
  return { text: small ? `About ${rounded}%` : `${rounded}%`, small };
}

// Bands for a small group's time: under 1 min, 1 to 2 min, 2 to 5 min, ...
const TIME_BANDS = Object.freeze([60, 120, 300, 600, 1800, 3600, 7200, 86400]);

/** "1 to 2 min", "30 min to 1 h": one unit when both ends share it. Pure. */
function bandText(lower, upper) {
  const a = formatDuration(lower);
  const b = formatDuration(upper);
  const unit = (s) => s.split(' ').pop();
  return unit(a) === unit(b) && a.split(' ').length === 2 ? `${a.split(' ')[0]} to ${b}` : `${a} to ${b}`;
}

/**
 * A median time about people, by the size of the group: exact from 50,
 * whole minutes from 20, a band ("5 to 10 min") from 10, null under 10.
 * Pure.  { text, small } | null
 */
function peopleDuration(secs, count) {
  const n = int(count);
  const s = num(secs);
  if (n < PEOPLE_MIN || s == null || s < 0) return null;
  if (n >= PEOPLE_EXACT) return { text: formatDuration(s), small: false };
  if (n >= PEOPLE_FIVE) {
    return { text: s < 60 ? 'Under 1 min' : formatDuration(Math.round(s / 60) * 60), small: false };
  }
  let lower = 0;
  for (const edge of TIME_BANDS) {
    if (s < edge) return { text: lower === 0 ? `Under ${formatDuration(edge)}` : bandText(lower, edge), small: true };
    lower = edge;
  }
  return { text: `Over ${formatDuration(lower)}`, small: true };
}

// ── The figures ──────────────────────────────────────────────────────────
//
// Each figure reads one source and turns its row into a measure of its
// `kind`:
//   rate      { hits, total }           a share
//   duration  { secs, n }               a median time over n
//   usd       { value, n }              dollars, over n
//   count     { n, apps? }              how many times (in how many projects)
//   compare   { rate, n, other }        a share beside another one
// `covers`: 'all' (every project; the default), 'others' (the projects
// other than Homeroom), or 'split' (Homeroom beside the other projects,
// each read from `source`, or from `sources[side]` when the two are
// recorded apart). `target`: { atLeast } or { atMost } in the measure's
// own unit (a share 0..1, seconds, dollars, a count). `noun` names what a
// rate counts in its line ("13 of 412 runs").

const FIGURES = Object.freeze({
  'onboarding.sign-up': {
    source: 'signUp', kind: 'rate', people: true, label: 'Let in → signed up',
    tip: 'Of the people let in from the waitlist, the share who went on to make an account. Test accounts and the team are not counted. Low can mean the invite isn’t reaching people, or signing up is in their way.',
    target: { atLeast: 0.7 },
    measure: (r) => ({ hits: r.hits, total: r.total }),
  },
  'onboarding.first-project': {
    source: 'firstProjectRunning', kind: 'duration', people: true, label: 'Wait for a first project to run',
    tip: 'How long new people waited from making their first project to seeing it run. Half waited less than this.',
    target: { atMost: 300 },
    measure: (r) => ({ secs: r.median_secs, n: r.n }),
  },
  'onboarding.first-change': {
    source: 'firstChangeLive', kind: 'duration', people: true, label: 'Wait for a first change to go live',
    tip: 'How long from making a first project until a change they asked for was live on it. Half waited less than this.',
    target: { atMost: 600 },
    measure: (r) => ({ secs: r.median_secs, n: r.n }),
  },
  'onboarding.found-project': {
    source: 'foundProject', kind: 'rate', people: true, label: 'Found a project in their first week',
    tip: 'The share of new people who made or joined a project within 7 days of getting in.',
    target: { atLeast: 0.4 },
    measure: (r) => ({ hits: r.hits, total: r.total }),
  },
  'bot.answered': {
    source: 'botAnswers', kind: 'rate', group: 'answers', column: 'quality', label: 'Answered without errors', noun: 'replies',
    tip: 'The share of the bot’s replies in threads, chats and DMs that went out without failing or falling back to a stock answer.',
    target: { atLeast: 0.95 },
    measure: (r) => ({ hits: int(r.voice_ok) + int(r.dm_ok), total: int(r.voice_total) + int(r.dm_total) }),
  },
  'bot.reply-cost': {
    source: 'botAnswers', kind: 'usd', covers: 'split', group: 'answers', column: 'cost', label: 'Cost per 100 replies',
    tip: 'What the bot’s answering cost for every 100 replies it posted. Homeroom counts its own channels and DMs with the bot; other projects count their channels.',
    target: { atMost: 5 },
    measure: (r) => {
      const n = int(r.voice_posted) + int(r.dm_posted);
      return { value: n ? (((num(r.voice_cost) || 0) + (num(r.dm_cost) || 0)) / n) * 100 : null, n };
    },
  },
  'bot.reply-time': {
    source: 'botReplyTime', kind: 'duration', covers: 'split', group: 'answers', column: 'speed', label: 'Reply time',
    tip: 'How long from someone’s message to the bot’s reply. Half are faster. It includes a short pause while the conversation settles. DMs count under Homeroom.',
    target: { atMost: 20 },
    measure: (r) => ({ secs: r.median_secs, n: r.n }),
  },
  'bot.merged': {
    source: 'botProposals', kind: 'compare', group: 'builds', column: 'quality', label: 'Proposals merged',
    tip: 'The share of the bot’s proposals that were voted in, next to the same share for proposals people made.',
    measure: (r) => ({
      rate: int(r.bot_settled) ? int(r.bot_merged) / int(r.bot_settled) : null,
      n: int(r.bot_settled),
      other: int(r.people_settled) ? int(r.people_merged) / int(r.people_settled) : null,
    }),
  },
  'bot.merged-cost': {
    source: 'botSpend', kind: 'usd', covers: 'split', group: 'builds', column: 'cost', label: 'Cost per merged proposal',
    tip: 'Everything the bot spent reading, planning and building, divided by its proposals that were merged. Builds that weren’t merged count too, so it is more than one build costs. Practice builds it makes without proposing them (its shadow mode) are left out.',
    target: { atMost: 5 },
    measure: (r) => ({ value: int(r.merged) ? (num(r.spent) || 0) / int(r.merged) : null, n: int(r.merged) }),
  },
  'bot.request-to-proposal': {
    source: 'botProposals', kind: 'duration', covers: 'split', group: 'builds', column: 'speed', label: 'Request → proposal',
    tip: 'How long from a request being filed to the bot’s proposal being up for a vote. Half are faster.',
    target: { atMost: 3600 },
    measure: (r) => ({ secs: r.median_secs, n: r.timed }),
  },
  'pipeline.checks-time': {
    source: 'checks', kind: 'duration', covers: 'split', label: 'Time to a checks verdict',
    tip: 'How long from a check run starting to its checks passing or failing, including the build and any wait in the queue. Half are faster.',
    target: { atMost: 120 },
    measure: (r) => ({ secs: r.median_secs, n: r.timed }),
  },
  'pipeline.checks-couldnt-run': {
    source: 'checks', kind: 'rate', covers: 'split', label: 'Checks that couldn’t run', noun: 'runs',
    tip: 'The share of check runs that ended with no pass or fail, because the change couldn’t be built or started or the checks never answered. That is usually the platform failing, not the change, and each one has to run again.',
    target: { atMost: 0.01 },
    measure: (r) => ({ hits: r.errors, total: r.total }),
  },
  'pipeline.shots': {
    source: 'shots', kind: 'rate', covers: 'split', label: 'Shots published', noun: 'runs',
    tip: 'The share of before-and-after shot runs that finished and were published on their proposal.',
    target: { atLeast: 0.9 },
    measure: (r) => ({ hits: r.hits, total: r.total }),
  },
  'pipeline.vote-to-merged': {
    source: 'voteToMerged', kind: 'duration', covers: 'split', label: 'Vote passed → merged',
    tip: 'How long from a proposal’s vote passing to it being merged. A long wait means something held it, such as failing checks or merges being paused.',
    target: { atMost: 900 },
    measure: (r) => ({ secs: r.median_secs, n: r.n }),
  },
  'infra.merge-to-live': {
    kind: 'duration', covers: 'split', sources: { homeroom: 'homeroomLive', others: 'mergeLive' }, label: 'Merge → live',
    tip: 'How long from a change merging to it running in production. Half are faster. A project deploys as part of the merge; Homeroom goes out in its next release, so its changes wait for one.',
    target: { atMost: 120 },
    measure: (r) => ({ secs: r.median_secs, n: r.n, since: r.since }),
  },
  'infra.deploys-failed': {
    source: 'mergeLive', kind: 'rate', covers: 'others', label: 'Deploys that failed', noun: 'project merges',
    tip: 'The share of merges into projects whose deploy to production failed. Homeroom’s own release is not counted.',
    target: { atMost: 0.05 },
    measure: (r) => ({ hits: r.failed, total: r.total }),
  },
  'infra.apps-up': {
    source: 'appOpens', kind: 'rate', covers: 'others', label: 'App opens that worked', noun: 'opens',
    tip: 'Of the times someone opened a project’s app in Homeroom, the share that loaded instead of showing the page that says the app is restarting. Homeroom itself is not counted.',
    target: { atLeast: 0.99 },
    measure: (r) => ({ hits: r.hits, total: r.total, since: r.since }),
  },
  'infra.restarts': {
    source: 'restarts', kind: 'count', covers: 'others', label: 'Apps restarted',
    tip: 'How many times the platform found a project’s app stopped or not answering and started it again. Each one means the app was down for a while.',
    measure: (r) => ({ n: r.n, apps: r.apps }),
  },
  'infra.limits-filled': {
    source: 'limits', kind: 'count', label: 'Limits that filled up',
    tip: 'How many times a platform limit filled up, such as the cap on sessions running at once. While one is full, people are turned away.',
    target: { atMost: 0 },
    measure: (r) => ({ n: r.n }),
  },
});

const FIGURE_IDS = Object.freeze(Object.keys(FIGURES));

const GROUPS = Object.freeze({
  answers: { name: 'Answers', about: 'Threads, chats and DMs' },
  builds: { name: 'Builds', about: 'Specs, builds and fixes' },
});
const COLUMNS = Object.freeze(['quality', 'cost', 'speed']);
const COLUMN_NAMES = Object.freeze({ quality: 'Quality', cost: 'Cost', speed: 'Speed' });

/** Whether `id` names a registered figure. Pure. */
function isFigureId(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(FIGURES, id);
}

/** A target as a measure's line reads it ("95%", "10 min", "$5"). Pure. */
function targetText(kind, value) {
  if (kind === 'duration') return formatDuration(value);
  if (kind === 'usd') return value >= 1 ? `$${Math.round(value)}` : formatUsd(value);
  if (kind === 'rate') return formatPercent(value);
  return String(value);
}

/** Whether `value` is off `target`: true, false, or null with no target. Pure. */
function offTarget(target, value) {
  if (!target || value == null) return null;
  if (target.atLeast != null) return value < target.atLeast;
  if (target.atMost != null) return value > target.atMost;
  return null;
}

/** "target 95%" on target, "below 95% target" off it. Pure. */
function targetLine(target, kind, off) {
  if (!target) return '';
  const want = target.atLeast != null ? target.atLeast : target.atMost;
  const text = targetText(kind, want);
  if (off) return target.atLeast != null ? `below ${text} target` : `over ${text} target`;
  if (kind === 'usd' || (kind === 'rate' && target.atMost != null)) return `target under ${text}`;
  return `target ${text}`;
}

const joinLine = (...parts) => parts.filter(Boolean).join(' · ');
// Words of one part of a line: "median since 10 Oct".
const joinWords = (...parts) => parts.filter(Boolean).join(' ');

const verdict = (off) => (off == null ? 'calm' : (off ? 'warn' : 'ok'));

/**
 * A number off its target never reads as the target itself: 89.7% against
 * 90% says 89.7%, not 90%, and 15 min 5 s against 15 min says so. Pure.
 */
function sharpen(def, kind, raw, text, off) {
  if (!off || !def.target) return text;
  const want = def.target.atLeast != null ? def.target.atLeast : def.target.atMost;
  const up = def.target.atMost != null;
  const step = (v, by) => (up ? Math.ceil(v * by) : Math.floor(v * by)) / by;
  if (kind === 'rate' && text === targetText('rate', want)) return `${step(raw * 100, 10)}%`;
  if (kind === 'duration' && text === targetText('duration', want) && raw < 3600) {
    return `${Math.floor(raw / 60)} min ${Math.round(raw % 60)} s`;
  }
  if (kind === 'usd' && raw < 100) return formatUsd(step(raw, 100));
  return text;
}

/**
 * The day a record began, "10 Oct" (UTC), from a measure's `since`: set
 * only while that day is inside the window. '' without one. Pure.
 */
function sinceDay(since) {
  if (!since) return '';
  const at = since instanceof Date ? since : new Date(since);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/**
 * What one measure of a figure reads. Pure.
 *   { state, value, detail, off, final, since }
 * `detail` is the line's own part (a rate's "13 of 412 runs", a count's
 * "in 3 projects"); `final` marks a reading whose detail is its whole line
 * (nothing to count yet, a group too small to say more, not read).
 * #4697: a record that began inside the window (`measure.since`) says so,
 * "Counting since 10 Oct" with nothing yet and "since 10 Oct" beside what
 * it has, so a week not recorded yet reads as new rather than as none or as
 * a whole week. `since` is that day, or ''.
 */
function reading(def, measure) {
  if (!measure) return { state: 'error', value: 'Couldn’t load', detail: 'Try again later', off: null, final: true, since: '' };
  const since = sinceDay(measure.since);
  const empty = (detail) => ({
    state: 'empty', value: 'None yet', detail: since ? `Counting since ${since}` : detail, off: null, final: true, since,
  });
  const calm = (value, detail) => ({ state: 'calm', value, detail, off: null, final: true });

  if (def.kind === 'rate') {
    const total = int(measure.total);
    const hits = Math.min(int(measure.hits), total);
    if (def.people) {
      if (total < PEOPLE_MIN) return calm('Not enough data', FEW_PEOPLE);
      const shown = peopleRate(hits, total);
      if (shown.small) return calm(shown.text, 'rounded · small group');
      const off = offTarget(def.target, hits / total);
      return { state: verdict(off), value: shown.text, detail: '', off, final: false };
    }
    if (!total) return empty(`No ${def.noun || 'runs'} yet`);
    const off = offTarget(def.target, hits / total);
    return { state: verdict(off), value: sharpen(def, 'rate', hits / total, formatPercent(hits / total), off), off, final: false, since,
      detail: joinWords(`${hits.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} ${def.noun || ''}`.trim(), since && `since ${since}`) };
  }

  if (def.kind === 'duration') {
    const n = int(measure.n);
    const secs = num(measure.secs);
    if (def.people) {
      if (n < PEOPLE_MIN || secs == null) return calm('Not enough data', FEW_PEOPLE);
      const shown = peopleDuration(secs, n);
      if (shown.small) return calm(shown.text, 'rounded · small group');
      const off = offTarget(def.target, secs);
      return { state: verdict(off), value: shown.text, detail: 'median', off, final: false };
    }
    if (!n || secs == null) return empty('Nothing timed yet');
    const off = offTarget(def.target, secs);
    return { state: verdict(off), value: sharpen(def, 'duration', secs, formatDuration(secs), off),
      detail: joinWords('median', since && `since ${since}`), off, final: false, since };
  }

  if (def.kind === 'usd') {
    const value = num(measure.value);
    if (!int(measure.n) || value == null) return empty('Nothing to divide by yet');
    const off = offTarget(def.target, value);
    return { state: verdict(off), value: sharpen(def, 'usd', value, formatUsd(value), off), detail: '', off, final: false };
  }

  if (def.kind === 'count') {
    const n = int(measure.n);
    const off = offTarget(def.target, n);
    let detail = 'across the platform';
    if (measure.apps != null) {
      const apps = int(measure.apps);
      detail = apps ? `in ${apps} ${apps === 1 ? 'project' : 'projects'}` : '';
    }
    return { state: verdict(off), value: n ? `${n} ${n === 1 ? 'time' : 'times'}` : 'None', detail, off, final: false };
  }

  if (def.kind === 'compare') {
    if (!int(measure.n) || measure.rate == null) return empty('No proposals settled yet');
    const other = measure.other == null ? 'none by people yet' : `people’s rate ${formatPercent(measure.other)}`;
    return { state: 'calm', value: formatPercent(measure.rate), detail: other, off: null, final: true };
  }

  return { state: 'error', value: 'Couldn’t load', detail: 'Try again later', off: null, final: true };
}

/** A reading's whole line: its own part and the target. Pure. */
function lineFor(def, read) {
  if (read.final) return read.detail;
  if (def.kind === 'count') return joinLine(read.detail, read.off ? 'target none' : '');
  return joinLine(read.detail, targetLine(def.target, def.kind, read.off));
}

// A split figure's state, from its sides': off target on either side wins,
// then a verdict, then anything to show.
const SPLIT_STATE_ORDER = Object.freeze(['warn', 'ok', 'calm', 'empty', 'missing', 'error']);

/**
 * One figure as the strip draws it, from its measure (null when it could
 * not be read). Pure.
 *   { id, label, tip, group, column, state, value, sub, sides? }
 * state: 'ok' | 'warn' (off target) | 'calm' (no verdict) | 'empty'
 * (nothing to count) | 'missing' (not recorded) | 'error' (not read).
 *
 * A split figure's measure is { homeroom, others }, each a measure or
 * null. It answers `sides`, Homeroom first, each { key, name, state,
 * value, detail }, with the target once in `sub`, and a `value` that reads
 * both sides in one line for a client that draws no sides.
 */
function present(id, measure) {
  const def = FIGURES[id];
  const base = { id, label: def.label, tip: def.tip, group: def.group || null, column: def.column || null };
  if (!def.source && !def.sources) {
    return { ...base, state: 'missing', value: 'Not recorded yet', sub: def.missingNote || '' };
  }
  if (def.covers === 'split') {
    const sides = SIDES.map((side) => {
      const read = reading(def, measure ? measure[side.key] : null);
      // A side's own part of the line: a rate's count. Nothing to count, or
      // not read, says so in its value alone, unless its record is new
      // (#4697): then when counting began.
      const detail = !read.final && def.kind === 'rate' ? read.detail
        : read.since ? (read.final ? read.detail : `since ${read.since}`) : '';
      return { key: side.key, name: side.name, state: read.state, value: read.value, detail };
    });
    const state = SPLIT_STATE_ORDER.find((st) => sides.some((side) => side.state === st)) || 'error';
    return {
      ...base,
      state,
      value: sides.map((side) => `${side.name} ${side.value}`).join(' · '),
      sub: joinLine(def.kind === 'duration' ? 'median' : '', targetLine(def.target, def.kind, false)),
      sides,
    };
  }
  const read = reading(def, measure);
  return { ...base, state: read.state, value: read.value, sub: lineFor(def, read) };
}

// ── Windows, sides and the cache ─────────────────────────────────────────

/**
 * The window a source covers at `now`: rolling (the last `days`, ending on
 * a 10-minute step) or daily (the `days` that ended at the start of today,
 * UTC). Pure.  { from, until, key, label, expiresAt }
 */
function windowFor(source, now = Date.now()) {
  const days = source.days || 7;
  if (source.daily) {
    const until = Math.floor(now / DAY_MS) * DAY_MS;
    return { from: new Date(until - days * DAY_MS), until: new Date(until), key: `d${until}`, days, expiresAt: until + DAY_MS };
  }
  const until = Math.floor(now / ROLLING_STEP_MS) * ROLLING_STEP_MS;
  return { from: new Date(until - days * DAY_MS), until: new Date(until), key: `r${until}`, days, expiresAt: now + ROLLING_TTL_MS };
}

let platformIdsCache = null;

async function platformAppIds(pool) {
  if (platformIdsCache && platformIdsCache.until > Date.now()) return platformIdsCache.ids;
  const { rows } = await pool.query(PLATFORM_APPS_SQL);
  const ids = rows.map((r) => Number(r.id)).filter((n) => Number.isSafeInteger(n));
  platformIdsCache = { ids, until: Date.now() + PLATFORM_IDS_TTL_MS };
  return ids;
}

async function scopeParams(pool, scope) {
  if (scope === 'all') return { all: true, ids: [], inPlatform: false };
  return { all: false, ids: await platformAppIds(pool), inPlatform: scope === 'homeroom' };
}

/**
 * The sources a figure reads, each with the projects it reads them for
 * ('all', 'homeroom' or 'others'; a source that is not scoped reads what
 * it reads, as 'all'), and for a split figure, which side each is. Pure.
 *   [{ side, name, scope }]
 */
function readsFor(def) {
  const at = (name, want) => ({ name, scope: SOURCES[name].scoped ? want : 'all' });
  if (def.covers === 'split') {
    return SIDES.map((side) => ({ side: side.key, ...at(def.sources ? def.sources[side.key] : def.source, side.key) }));
  }
  if (!def.source) return [];
  return [{ side: null, ...at(def.source, def.covers === 'others' ? 'others' : 'all') }];
}

const cache = new Map();
const MAX_CACHE_ENTRIES = 200;

function sweepCache(now) {
  for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
}

/** One source's row for a scope, read at most once per window. */
async function readSource(pool, name, scope, now = Date.now()) {
  const source = SOURCES[name];
  const effective = source.scoped ? scope : 'all';
  const w = windowFor(source, now);
  const key = `${name}|${effective}|${w.key}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.promise;
  const promise = (async () => {
    const params = await scopeParams(pool, effective);
    const { rows } = await source.read(pool, w, params);
    return rows[0] || {};
  })();
  cache.set(key, { promise, expiresAt: w.expiresAt });
  promise.catch(() => cache.delete(key));
  sweepCache(now);
  return promise;
}

/** The ids a topic's dapp.json entry names that are registered. Pure. */
function knownFigureIds(ids) {
  if (!Array.isArray(ids)) return [];
  const out = [];
  for (const id of ids) if (isFigureId(id) && !out.includes(id)) out.push(id);
  return out.slice(0, MAX_TOPIC_FIGURES);
}

/**
 * How the strip lays the figures out. Pure.
 *   { layout: 'tiles' | 'grid', groups, columns, days, note }
 */
function layoutFor(ids) {
  const defs = ids.map((id) => FIGURES[id]);
  const grid = defs.length > 0 && defs.every((d) => d.group && d.column);
  const groups = [];
  if (grid) for (const d of defs) if (!groups.some((g) => g.key === d.group)) groups.push({ key: d.group, ...GROUPS[d.group] });
  const first = defs.map((d) => readsFor(d)[0]).find(Boolean);
  return {
    layout: grid ? 'grid' : 'tiles',
    groups,
    columns: grid ? COLUMNS.map((key) => ({ key, name: COLUMN_NAMES[key] })) : [],
    days: first ? SOURCES[first.name].days : 7,
    note: defs.some((d) => d.people) ? NOTE_PEOPLE : null,
  };
}

/** A figure's measure from the rows its sources gave (null: not read). */
function measureFrom(def, reads, rowOf) {
  const one = (r) => {
    const row = rowOf(r);
    return row ? def.measure(row) : null;
  };
  if (def.covers === 'split') {
    const out = {};
    for (const r of reads) out[r.side] = one(r);
    return out;
  }
  return reads.length ? one(reads[0]) : null;
}

/**
 * A topic's strip: its figures, read (or taken from the cache). Never
 * throws for one figure: a source that fails marks its figures.
 */
async function figuresFor(pool, ids, { now = Date.now() } = {}) {
  const known = knownFigureIds(ids);
  const shape = layoutFor(known);
  const wanted = new Map();
  for (const id of known) for (const r of readsFor(FIGURES[id])) wanted.set(`${r.name}|${r.scope}`, r);
  const rows = new Map();
  await Promise.all([...wanted.entries()].map(async ([key, r]) => {
    try {
      rows.set(key, await readSource(pool, r.name, r.scope, now));
    } catch (err) {
      log.warn('topic-figures', 'Could not read a figure source', { source: r.name, scope: r.scope, err: err.message });
      rows.set(key, null);
    }
  }));
  const figures = known.map((id) => {
    const def = FIGURES[id];
    const reads = readsFor(def);
    return present(id, measureFrom(def, reads, (r) => rows.get(`${r.name}|${r.scope}`)));
  });
  return { ...shape, figures };
}

// Staging's database starts without the private tables these read (events,
// chat_sessions, the merge traces), so `?demo=1` there answers with fixed
// figures, marked as such, for the testing steps and the declared check to
// reach.
const DEMO_MEASURES = Object.freeze({
  'onboarding.sign-up': { hits: 41, total: 60 },
  'onboarding.first-project': { secs: 230, n: 34 },
  'onboarding.first-change': { secs: 470, n: 27 },
  'onboarding.found-project': { hits: 6, total: 15 },
  'bot.answered': { hits: 288, total: 300 },
  'bot.reply-cost': { homeroom: { value: 3.1, n: 210 }, others: { value: 6.4, n: 80 } },
  'bot.reply-time': { homeroom: { secs: 12, n: 210 }, others: { secs: 16, n: 80 } },
  'bot.merged': { rate: 0.58, n: 24, other: 0.64 },
  'bot.merged-cost': { homeroom: { value: 5.9, n: 9 }, others: { value: 2.4, n: 5 } },
  'bot.request-to-proposal': { homeroom: { secs: 4800, n: 12 }, others: { secs: 2900, n: 8 } },
  'pipeline.checks-time': { homeroom: { secs: 310, n: 140 }, others: { secs: 95, n: 259 } },
  'pipeline.checks-couldnt-run': { homeroom: { hits: 3, total: 143 }, others: { hits: 2, total: 262 } },
  'pipeline.shots': { homeroom: { hits: 30, total: 32 }, others: { hits: 26, total: 29 } },
  'pipeline.vote-to-merged': { homeroom: { secs: 540, n: 18 }, others: { secs: 240, n: 13 } },
  'infra.merge-to-live': { homeroom: { secs: 1140, n: 18 }, others: { secs: 80, n: 56 } },
  'infra.deploys-failed': { hits: 3, total: 74 },
  'infra.apps-up': { hits: 1204, total: 1213 },
  'infra.restarts': { n: 4, apps: 3 },
  'infra.limits-filled': { n: 2 },
});

/** The demo strip for `ids`. Pure. */
function demoFiguresFor(ids) {
  const known = knownFigureIds(ids);
  return {
    ...layoutFor(known),
    demo: true,
    figures: known.map((id) => present(id, DEMO_MEASURES[id] || null)),
  };
}

function _resetForTests() {
  cache.clear();
  platformIdsCache = null;
}

module.exports = {
  FIGURES,
  FIGURE_IDS,
  SIDES,
  COVERS,
  MAX_TOPIC_FIGURES,
  NOTE_PEOPLE,
  isFigureId,
  knownFigureIds,
  formatDuration,
  formatUsd,
  formatPercent,
  peopleRate,
  peopleDuration,
  present,
  layoutFor,
  readsFor,
  windowFor,
  figuresFor,
  demoFiguresFor,
  _resetForTests,
};
