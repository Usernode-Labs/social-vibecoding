'use strict';

// HOME'S "FOR YOU" COLUMN (#6650): the two reads Home's right-hand column
// needs that no other endpoint answers.
//
//   activity   "New in your communities": for each community the viewer is a
//              member of, what happened there since they last looked. Three
//              kinds, each counted the way the screen that shows it counts:
//                messages  unread in the project's channel (#general), by the
//                          one definition of unread services/app-chat.js
//                          keeps (another person's message, above the read
//                          cursor, not deleted, not from somebody blocked),
//                          and newer than the last look;
//                merged    changes that went live (a person's, not a
//                          headless run), as Profile's merged count does;
//                requests  requests somebody else filed.
//              "Last looked" is home_activity_seen.seen_at, moved by Mark all
//              read; with no row, the last seven days.
//   work       "Your work": the points total and this week's share of it,
//              and the votes the viewer has cast. Changes and requests are
//              Profile's own numbers (routes/profile.js SUMMARY_COUNTS_SQL
//              and MY_REQUEST_COUNTS_SQL), so the card and Profile agree.
//
// Neither read moves anything a project's own screens keep: opening a
// channel still moves app_chat_reads, and Mark all read here never does.

/** The window "since you last looked" reads when there is no look yet. */
const DEFAULT_WINDOW_DAYS = 7;
/** Rows the card draws; the rest are counted in `more`. */
const ACTIVITY_LIMIT = 3;
/** A sane bound on how many communities one read looks at. */
const MEMBER_SCAN_MAX = 300;

const ACTIVITY_SQL = `
  WITH since AS (
    SELECT COALESCE(
      (SELECT seen_at FROM home_activity_seen WHERE user_id = $1),
      NOW() - ($2::int * INTERVAL '1 day')
    ) AS at
  ),
  mine AS (
    SELECT DISTINCT ON (a.community_id)
           a.id, a.slug, a.name, a.icon_image_id, a.icon_emoji, a.icon_color
      FROM community_members m
      JOIN apps a ON a.community_id = m.community_id
     WHERE m.user_id = $1
       AND a.moderation_suspended_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM user_app_blocks b WHERE b.user_id = $1 AND b.app_id = a.id)
     ORDER BY a.community_id, a.id
     LIMIT $3
  )
  SELECT mine.slug, mine.name, mine.icon_image_id, mine.icon_emoji, mine.icon_color,
         since.at AS since,
         (SELECT COUNT(*)::int
            FROM chat_messages c
            JOIN app_chat_reads rc ON rc.app_id = c.app_id AND rc.user_id = $1
           WHERE c.app_id = mine.id
             AND c.thread_type IS NULL
             AND c.id > rc.last_read_message_id
             AND c.deleted_at IS NULL
             AND c.user_id IS NOT NULL AND c.user_id <> $1
             AND c.created_at > since.at
             AND NOT EXISTS (
               SELECT 1 FROM user_blocks blocked
                WHERE blocked.blocker_id = $1 AND blocked.blocked_user_id = c.user_id
             )) AS messages,
         (SELECT COUNT(*)::int
            FROM chat_sessions s
           WHERE s.app_id = mine.id
             AND s.is_headless = FALSE
             AND s.status = 'merged' AND s.live_at IS NOT NULL
             AND s.merged_at > since.at) AS merged,
         (SELECT COUNT(*)::int
            FROM requests q
           WHERE q.app_id = mine.id
             AND q.created_at > since.at
             AND q.created_by IS DISTINCT FROM $1) AS requests
    FROM mine, since
`;

const SEEN_SQL = `
  INSERT INTO home_activity_seen (user_id, seen_at) VALUES ($1, NOW())
  ON CONFLICT (user_id) DO UPDATE SET seen_at = EXCLUDED.seen_at
  RETURNING seen_at
`;

const WORK_SQL = `
  SELECT (SELECT COALESCE(SUM(ua.points), 0)::float8
            FROM user_activities ua WHERE ua.user_id = $1) AS points,
         (SELECT COALESCE(SUM(ua.points), 0)::float8
            FROM user_activities ua
           WHERE ua.user_id = $1 AND ua.activity_at >= NOW() - INTERVAL '7 days') AS points_week,
         (SELECT COUNT(*)::int
            FROM chat_sessions cs
           WHERE cs.user_id = $1 AND cs.is_headless = FALSE AND cs.status = 'promoted') AS changes_waiting,
         (SELECT COUNT(*)::int FROM pr_votes v WHERE v.user_id = $1) AS votes_cast
`;

function iconUrl(imageId) {
  return typeof imageId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(imageId)
    ? `/app-icons/${imageId}` : null;
}

const count = (value) => Math.max(0, Math.floor(Number(value) || 0));

/**
 * Pure (exported for tests): ACTIVITY_SQL's rows → the card's body. A
 * community with nothing new is left out; the busiest come first (ties keep
 * the name order, so the list does not shuffle between reads); `limit` rows
 * are drawn and the rest counted in `more`.
 */
function shapeActivity(rows, { limit = ACTIVITY_LIMIT, now = Date.now() } = {}) {
  const list = (Array.isArray(rows) ? rows : [])
    .map((r) => ({
      slug: String(r.slug || ''),
      name: r.name ? String(r.name) : String(r.slug || ''),
      iconUrl: iconUrl(r.icon_image_id),
      iconEmoji: r.icon_emoji || null,
      iconColor: r.icon_color || null,
      messages: count(r.messages),
      merged: count(r.merged),
      requests: count(r.requests),
    }))
    .filter((c) => c.slug && (c.messages + c.merged + c.requests) > 0)
    .sort((a, b) => ((b.messages + b.merged + b.requests) - (a.messages + a.merged + a.requests))
      || a.name.localeCompare(b.name));
  const first = Array.isArray(rows) && rows[0];
  const since = first && first.since
    ? new Date(first.since).toISOString()
    : new Date(now - DEFAULT_WINDOW_DAYS * 86_400_000).toISOString();
  return {
    since,
    communities: list.slice(0, Math.max(0, limit)),
    more: Math.max(0, list.length - Math.max(0, limit)),
  };
}

/** What happened in the viewer's communities since they last looked. */
async function activity(db, userId, { limit = ACTIVITY_LIMIT } = {}) {
  const { rows } = await db.query(ACTIVITY_SQL, [userId, DEFAULT_WINDOW_DAYS, MEMBER_SCAN_MAX]);
  return shapeActivity(rows, { limit });
}

/** Mark all read: the card starts counting again from now. */
async function markSeen(db, userId) {
  const { rows } = await db.query(SEEN_SQL, [userId]);
  const at = rows[0] && rows[0].seen_at;
  return { since: at ? new Date(at).toISOString() : new Date().toISOString(), communities: [], more: 0 };
}

/**
 * Pure (exported for tests): the work row plus Profile's two counts → the
 * card's body. Points are whole numbers on screen; the ledger keeps two
 * decimals, so they are rounded here once.
 */
function shapeWork(row, { summary, requests } = {}) {
  const r = row || {};
  const s = summary || {};
  const q = requests || {};
  const total = Number(s.proposals_total) || 0;
  return {
    points: Math.round(Number(r.points) || 0),
    pointsWeek: Math.round(Number(r.points_week) || 0),
    changes: { total: count(total), waiting: count(r.changes_waiting) },
    requests: { total: count((Number(q.total) || 0)), open: count((Number(q.total) || 0) - (Number(q.done) || 0)) },
    votes: { cast: count(r.votes_cast) },
  };
}

/** The viewer's own numbers for the "Your work" card. */
async function work(db, userId) {
  const { SUMMARY_COUNTS_SQL, MY_REQUEST_COUNTS_SQL } = require('../routes/profile');
  const [mine, summary, requests] = await Promise.all([
    db.query(WORK_SQL, [userId]),
    db.query(SUMMARY_COUNTS_SQL, [userId]),
    db.query(MY_REQUEST_COUNTS_SQL, [userId]),
  ]);
  return shapeWork(mine.rows[0], { summary: summary.rows[0], requests: requests.rows[0] });
}

// Staging-only ?demo=1 bodies. A preview is a copy of production whose
// chat, proposals and points are mostly private and so empty, which would
// leave both cards blank in the preview and in the before & after shots.
// REAL DATA WINS: a viewer with anything of their own sees it.
const DEMO_ACTIVITY = [
  { slug: 'demo-sample-garden', name: '[Sample] Garden club', messages: 2, merged: 0, requests: 0 },
  { slug: 'demo-sample-recipes', name: '[Sample] Recipe swap', messages: 1, merged: 1, requests: 0 },
  { slug: 'demo-sample-games', name: '[Sample] Game night', messages: 0, merged: 0, requests: 1 },
];

function withDemoActivity(body) {
  if (body && body.communities && body.communities.length) return body;
  return {
    since: body && body.since ? body.since : new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86_400_000).toISOString(),
    communities: DEMO_ACTIVITY.map((c) => ({ ...c, iconUrl: null, iconEmoji: null, iconColor: null })),
    more: 0,
  };
}

function withDemoWork(body) {
  const b = body || shapeWork(null);
  const empty = !b.points && !b.changes.total && !b.requests.total && !b.votes.cast;
  if (!empty) return b;
  return {
    points: 1240,
    pointsWeek: 180,
    changes: { total: 12, waiting: 3 },
    requests: { total: 5, open: 2 },
    votes: { cast: 48 },
  };
}

module.exports = {
  ACTIVITY_LIMIT,
  DEFAULT_WINDOW_DAYS,
  ACTIVITY_SQL,
  WORK_SQL,
  activity,
  markSeen,
  work,
  shapeActivity,
  shapeWork,
  withDemoActivity,
  withDemoWork,
};
