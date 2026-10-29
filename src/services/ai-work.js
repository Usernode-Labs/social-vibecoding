'use strict';

// The AI tab's main view (#6019 follow-up, plan v3: "what needs you comes
// first, then your private threads, with a lock on the tile, then Up next:
// what's moving without you, soonest first"). frontend/src/features/ai/ draws
// it; this reads what it lists, for one person, across every project they
// can see:
//
//   private  their private threads in the chat with Homeroom bot that have
//            gone nowhere yet: the threads they started (services/
//            private-threads.js) and the drafts the bot opened for them, each
//            with the project it is for, if it has one;
//   threads  the public threads they are in, by the rule a thread's
//            followers are worked out by (threads.js FOLLOWERS_SQL, read the
//            other way round): they asked for it, built a change in it, voted
//            in it, wrote in it, or chose Notify me, and did not choose Mute.
//            Each says which list it is in:
//              next     moving without them: a change being made, up for a
//                       vote they have voted on (or that is theirs), merging,
//                       or merged and going live;
//              waiting  nothing in flight: a request nobody has picked up;
//              live     a change of it went live in the last week.
//            A change up for a vote that still owes their vote is the Needs
//            you feed's (GET /api/workshop/needs-feed), which the view puts
//            first, so it is not listed here twice.
//
// The projects are the ones the Workshop's own reads show the viewer
// (routes/workshop-overview.js VISIBLE_APP_WHERE): not suspended, a
// self-hosted one only for an admin or where public voting is on, and a
// private one only to its members.

const THREADS_MAX = 80;
const PRIVATE_MAX = 30;
const LIVE_DAYS = 7;

const VISIBLE_APP_WHERE = `a.moderation_suspended_at IS NULL
     AND (NOT a.self_hosted OR $2::boolean)
     AND ($3::boolean OR a.view_visibility = 'public' OR me.user_id IS NOT NULL)`;

// $1 viewer, $2 show self-hosted, $3 admin, $4 the most rows, $5 days a
// closed thread stays listed (Live this week).
const THREADS_SQL = `
WITH mine AS (
  SELECT thread_id FROM requests WHERE created_by = $1 AND thread_id IS NOT NULL
  UNION SELECT thread_id FROM issues WHERE created_by = $1 AND thread_id IS NOT NULL
  UNION SELECT t.id FROM homeroom_bot_requesters b
          JOIN threads t ON t.app_id = b.app_id AND t.number = b.issue_number
         WHERE b.user_id = $1
  UNION SELECT thread_id FROM chat_sessions
         WHERE user_id = $1 AND thread_id IS NOT NULL AND is_headless = FALSE
  UNION SELECT s.thread_id FROM pr_votes v JOIN chat_sessions s ON s.id = v.session_id
         WHERE v.user_id = $1 AND s.thread_id IS NOT NULL
  UNION SELECT i.thread_id FROM issue_votes v JOIN issues i ON i.id = v.issue_id
         WHERE v.user_id = $1 AND i.thread_id IS NOT NULL
  UNION SELECT thread_id FROM chat_messages
         WHERE user_id = $1 AND thread_id IS NOT NULL AND msg_type = 'message' AND deleted_at IS NULL
  UNION SELECT thread_id FROM thread_followers WHERE user_id = $1 AND muted_at IS NULL
)
SELECT t.id, t.number, t.kind, t.title AS thread_title, t.state, t.created_at, t.closed_at,
       a.slug, a.name, a.icon_emoji, a.icon_color, a.icon_image_id,
       req.title AS request_title, req.state AS request_state, req.updated_at AS request_at,
       ch.id AS change_id, ch.pr_number, ch.status AS change_status, ch.user_id AS change_user,
       ch.title AS change_title, ch.promoted_at, ch.merged_at, ch.live_at, ch.last_activity_at,
       ch.voted
  FROM threads t
  JOIN mine ON mine.thread_id = t.id
  JOIN apps a ON a.id = t.app_id
  LEFT JOIN app_collaborators me ON me.app_id = a.id AND me.user_id = $1 AND me.status = 'member'
  LEFT JOIN LATERAL (
    SELECT r.title, r.state, r.updated_at FROM requests r
     WHERE r.thread_id = t.id
     ORDER BY (r.number = t.number) DESC, r.number
     LIMIT 1
  ) req ON TRUE
  LEFT JOIN LATERAL (
    SELECT cs.id, cs.pr_number, cs.status, cs.user_id, cs.promoted_at, cs.merged_at, cs.live_at,
           cs.last_activity_at,
           COALESCE(NULLIF(cs.pr_title, ''), NULLIF(cs.session_title, '')) AS title,
           EXISTS (SELECT 1 FROM pr_votes v
                    WHERE v.session_id = cs.id AND v.user_id = $1
                      AND v.approval_epoch IS NOT DISTINCT FROM cs.approval_epoch) AS voted
      FROM chat_sessions cs
     WHERE cs.thread_id = t.id AND cs.is_headless = FALSE
       AND cs.status IN ('active', 'paused', 'promoted', 'merging', 'merged')
       AND (cs.status NOT IN ('active', 'paused') OR cs.shared_at IS NOT NULL OR cs.user_id = $1)
     ORDER BY CASE cs.status WHEN 'merged' THEN 0 WHEN 'merging' THEN 1 WHEN 'promoted' THEN 2 ELSE 3 END,
              cs.id DESC
     LIMIT 1
  ) ch ON TRUE
 WHERE t.merged_into IS NULL
   AND (t.state = 'open' OR t.closed_at > NOW() - make_interval(days => $5))
   AND NOT EXISTS (SELECT 1 FROM thread_followers f
                    WHERE f.thread_id = t.id AND f.user_id = $1 AND f.muted_at IS NOT NULL)
   AND ${VISIBLE_APP_WHERE}
 ORDER BY COALESCE(ch.live_at, ch.merged_at, ch.promoted_at, ch.last_activity_at, req.updated_at, t.created_at) DESC
 LIMIT $4`;

// $1 viewer, $2 the bot, $3 the most rows. A thread they started is one of
// their own messages in the chat with the bot that has replies; a draft the
// bot opened is a row of private_threads. Only those still open: a filed or
// posted one is a public thread now, and listed there.
const PRIVATE_SQL = `
SELECT m.id AS root_id, m.content, m.created_at, p.kind, a.slug, a.name,
       a.icon_emoji, a.icon_color, a.icon_image_id,
       (SELECT MAX(r.created_at) FROM conversation_messages r
         WHERE r.thread_root_id = m.id AND r.deleted_at IS NULL) AS last_at
  FROM conversations c
  JOIN conversation_members mine ON mine.conversation_id = c.id AND mine.user_id = $1
  JOIN conversation_members bot ON bot.conversation_id = c.id AND bot.user_id = $2
  JOIN conversation_messages m ON m.conversation_id = c.id AND m.thread_root_id IS NULL AND m.deleted_at IS NULL
  LEFT JOIN private_threads p ON p.root_message_id = m.id AND p.user_id = $1
  LEFT JOIN apps a ON a.id = p.app_id AND a.moderation_suspended_at IS NULL
 WHERE c.kind = 'direct'
   AND (p.id IS NOT NULL
        OR (m.sender_id = $1 AND EXISTS (SELECT 1 FROM conversation_messages r
                                          WHERE r.thread_root_id = m.id AND r.deleted_at IS NULL)))
   AND COALESCE(p.state, 'open') = 'open'
 ORDER BY COALESCE((SELECT MAX(r.created_at) FROM conversation_messages r
                     WHERE r.thread_root_id = m.id AND r.deleted_at IS NULL), m.created_at) DESC
 LIMIT $3`;

function appOf(row) {
  if (!row.slug) return null;
  return {
    slug: row.slug,
    name: row.name || row.slug,
    iconEmoji: row.icon_emoji || null,
    iconColor: row.icon_color || null,
    iconUrl: row.icon_image_id ? `/app-icons/${row.icon_image_id}` : null,
  };
}

function firstLine(text, max = 90) {
  const line = String(text || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

const iso = (at) => (at ? new Date(at).toISOString() : null);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pure: where one thread stands for the viewer, or null when it is not
 * theirs to see in these lists (a vote they owe is Needs you's; a change
 * live more than a week ago is history). `now` is a Date.
 */
function standing(row, viewerId, now = new Date()) {
  const status = row.change_status || null;
  const theirs = row.change_user != null && Number(row.change_user) === Number(viewerId);
  if (status === 'merged') {
    if (!row.live_at) return { group: 'next', what: 'going_live', at: iso(row.merged_at) };
    if (now - new Date(row.live_at) <= LIVE_DAYS * DAY_MS) return { group: 'live', what: 'live', at: iso(row.live_at) };
    return null;
  }
  if (row.state !== 'open') return null;
  if (status === 'merging') return { group: 'next', what: 'merging', at: iso(row.merged_at || row.promoted_at) };
  if (status === 'promoted') {
    if (!row.voted && !theirs) return null;
    return { group: 'next', what: 'vote', at: iso(row.promoted_at) };
  }
  if (status === 'active' || status === 'paused') {
    return { group: 'next', what: 'building', at: iso(row.last_activity_at), yours: theirs };
  }
  if (row.request_state === 'open' || row.kind === 'decision') {
    const at = row.request_at || row.created_at;
    const quiet = at ? Math.floor((now - new Date(at)) / DAY_MS) : 0;
    return { group: 'waiting', what: 'not_picked_up', at: iso(at), quietDays: quiet >= 7 ? quiet : 0 };
  }
  return null;
}

// Up next is soonest first: going live, then merging, then votes (the
// oldest has waited longest), then changes being made.
const NEXT_ORDER = { going_live: 0, merging: 1, vote: 2, building: 3 };

function shapeThread(row, viewerId, now) {
  const stand = standing(row, viewerId, now);
  if (!stand) return null;
  const number = row.number == null ? null : Number(row.number);
  const title = row.request_title || row.change_title || row.thread_title || null;
  return {
    threadId: Number(row.id),
    number,
    kind: row.kind,
    title,
    app: appOf(row),
    change: row.change_id ? { id: Number(row.change_id), number: row.pr_number == null ? null : Number(row.pr_number) } : null,
    ...stand,
  };
}

/** Pure: the lists, in the order the view draws them. */
function arrange(rows, viewerId, now = new Date()) {
  const shaped = rows.map((row) => shapeThread(row, viewerId, now)).filter(Boolean);
  const byAt = (a, b) => String(b.at || '').localeCompare(String(a.at || ''));
  const next = shaped.filter((s) => s.group === 'next')
    .sort((a, b) => (NEXT_ORDER[a.what] - NEXT_ORDER[b.what]) || String(a.at || '').localeCompare(String(b.at || '')));
  return {
    next,
    waiting: shaped.filter((s) => s.group === 'waiting').sort(byAt),
    live: shaped.filter((s) => s.group === 'live').sort(byAt),
  };
}

function shapePrivate(row) {
  return {
    rootId: Number(row.root_id),
    title: firstLine(row.content),
    kind: row.kind || 'idea',
    app: appOf(row),
    at: iso(row.last_at || row.created_at),
  };
}

/**
 * Everything the AI tab's main view lists for `user` beside Needs you:
 * { private, next, waiting, live }.
 */
async function workFor(pool, { user, showSelfHosted = false, deps = {} }) {
  const dm = deps.dm || require('./homeroom-bot-dm');
  const bot = deps.bot || await dm.botAccount(pool);
  const [{ rows: threadRows }, privateRows] = await Promise.all([
    pool.query(THREADS_SQL, [user.id, !!showSelfHosted, !!user.isAdmin, THREADS_MAX, LIVE_DAYS]),
    bot ? pool.query(PRIVATE_SQL, [user.id, bot.id, PRIVATE_MAX]).then((r) => r.rows) : Promise.resolve([]),
  ]);
  return {
    private: privateRows.map(shapePrivate),
    ...arrange(threadRows, user.id),
  };
}

module.exports = {
  THREADS_SQL,
  PRIVATE_SQL,
  THREADS_MAX,
  PRIVATE_MAX,
  LIVE_DAYS,
  standing,
  arrange,
  workFor,
};
