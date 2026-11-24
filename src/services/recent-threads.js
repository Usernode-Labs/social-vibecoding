'use strict';

// The threads a person TOOK PART IN, newest activity first, for the
// notifications sheet's Recent threads tab (#6785).
//
// The sheet's own feed (services/notifications.js, GET /api/notifications)
// cannot answer this: it holds only notifications sent TO the viewer, and the
// bell skips the viewer's own actions — a message they posted leaves no row
// (createThreadNotifications skips the sender), filing a request leaves none
// (createIssueOpenedNotifications drops the author) and a vote on their own
// change leaves none (self-votes are skipped). So this reads the threads
// themselves.
//
// What counts as taking part is threads.js's followers rule read the other
// way round (threadsInSql in services/ai-work.js), less the two branches that
// are not participation:
//
//   - thread_followers: choosing Notify me (or Mute) is a subscription, not
//     taking part. A thread they only follow is not listed.
//   - issue_claims: a Claim that ran out is not something they did in the
//     thread either; the AI tab's week-limited version is its own.
//
// and plus the two mention kinds: a 'mention' notification in a thread's
// chat, and an 'issue_mention' naming a request. Since 24 Nov 2026 (mobile
// 04) the AI tab reads them too (threadsInSql's `named` branches, and
// services/thread-mentions.js for its Needs you row).
//
// A thread's row is the thread it was merged INTO when it was merged away
// (`threads.merged_into`), so one discussion is one row.
//
// Visibility is the project's, the rule services/notifications.js applies to
// a notification's app (APP_ACCESS_SQL): a suspended project, one the viewer
// blocked, and a private one they are not a member of are not listed. A
// self-hosted project is shown only to an admin or a member, as
// services/ai-work.js VISIBLE_APP_WHERE reads it.
//
// Last activity is the newest of the thread's creation, a message posted in
// it, its request being updated, and its change moving — the seed the spec
// was written from.

const aiWork = require('./ai-work');

// A thread that was merged away is answered by the thread it became. Kept in
// one place so the participation set and the row's own read cannot disagree.
const RESOLVED_THREAD_SQL = `COALESCE(t.merged_into, t.id)`;

// The threads one person took part in (`viewer` is the SQL parameter that
// names them, e.g. '$1'): one thread id per branch, duplicates harmless — the
// read below resolves and groups them.
//
// Every branch is a plain table read so `npm run lint:sql` can check the
// whole statement; the two mention branches reach the thread through the row
// they point at, and `issue_mention`'s detail is cast only inside a CASE that
// has already matched digits.
function participatedSql(viewer) {
  return `SELECT thread_id FROM (
    SELECT r.thread_id FROM requests r
     WHERE r.created_by = ${viewer} AND r.thread_id IS NOT NULL
    UNION ALL SELECT i.thread_id FROM issues i
     WHERE i.created_by = ${viewer} AND i.thread_id IS NOT NULL
    UNION ALL SELECT t.id FROM homeroom_bot_requesters b
                JOIN threads t ON t.app_id = b.app_id AND t.number = b.issue_number
               WHERE b.user_id = ${viewer}
    UNION ALL SELECT s.thread_id FROM chat_sessions s
               WHERE s.user_id = ${viewer} AND s.thread_id IS NOT NULL AND s.is_headless = FALSE
    UNION ALL SELECT s.thread_id FROM pr_votes v
                JOIN chat_sessions s ON s.id = v.session_id
               WHERE v.user_id = ${viewer} AND s.thread_id IS NOT NULL
    UNION ALL SELECT i.thread_id FROM issue_votes v
                JOIN issues i ON i.id = v.issue_id
               WHERE v.user_id = ${viewer} AND i.thread_id IS NOT NULL
    UNION ALL SELECT m.thread_id FROM chat_messages m
               WHERE m.user_id = ${viewer} AND m.thread_id IS NOT NULL
                 AND m.msg_type = 'message' AND m.deleted_at IS NULL
    -- Named with @ in a thread's chat.
    UNION ALL SELECT m.thread_id FROM notifications n
                JOIN chat_messages m ON m.id = n.chat_message_id
               WHERE n.user_id = ${viewer} AND n.kind = 'mention' AND m.thread_id IS NOT NULL
    -- Named with @ in a request (detail is its number). The cast happens only
    -- in the branch the digits check already matched.
    UNION ALL SELECT t.id FROM notifications n
                JOIN threads t ON t.app_id = n.app_id
                 AND t.number = (CASE WHEN n.detail ~ '^[0-9]{1,9}$' THEN n.detail::int END)
               WHERE n.user_id = ${viewer} AND n.kind = 'issue_mention'
  ) part WHERE thread_id IS NOT NULL`;
}

// $1 viewer, $2 limit, $3 admin, $4 the cursor's last_at (or NULL), $5 its id.
// A thread is one row: the participation set is resolved to the thread a
// merged one became and grouped, so several kinds of taking part in one
// discussion are one row.
const LIST_SQL = `
WITH part AS (${participatedSql('$1')}),
mine AS (
  SELECT DISTINCT ${RESOLVED_THREAD_SQL} AS thread_id
    FROM part JOIN threads t ON t.id = part.thread_id
)
SELECT * FROM (
  SELECT t.id, t.kind, t.number, t.title, t.created_at,
         a.slug, a.name AS app_name, a.icon_emoji, a.icon_image_id,
         req.number AS request_number, req.title AS request_title,
         ch.pr_number, ch.title AS change_title,
         dec.id AS decision_id,
         GREATEST(
           t.created_at,
           COALESCE((SELECT MAX(cm.created_at) FROM chat_messages cm
                      WHERE cm.thread_id = t.id AND cm.deleted_at IS NULL), t.created_at),
           COALESCE(req.updated_at, t.created_at),
           COALESCE(ch.last_activity_at, t.created_at)
         ) AS last_at,
         -- How many there are in all, counted before the cursor's own WHERE
         -- trims the page (a window is worked out first). Home's card says
         -- how many more it has than the rows it could list (#6816).
         COUNT(*) OVER () AS total
    FROM mine
    JOIN threads t ON t.id = mine.thread_id
    JOIN apps a ON a.id = t.app_id
    -- The lead request: a thread made for a request opens on its page, and
    -- the row says Request #N with its title.
    LEFT JOIN LATERAL (
      SELECT r.number, r.title, r.updated_at FROM requests r
       WHERE r.thread_id = t.id
       ORDER BY r.id ASC
       LIMIT 1
    ) req ON TRUE
    -- The newest change a person (not a headless auto session) made in it.
    -- Its title is its pull request's, then its session's (as the AI tab's
    -- rows read it, services/ai-work.js): a change handed in through the
    -- connector has a pull request title and no session title, and its row
    -- used to fall back to the project's name.
    LEFT JOIN LATERAL (
      SELECT s.pr_number, COALESCE(NULLIF(s.pr_title, ''), NULLIF(s.session_title, '')) AS title,
             s.last_activity_at FROM chat_sessions s
       WHERE s.thread_id = t.id AND s.is_headless = FALSE
       ORDER BY s.id DESC
       LIMIT 1
    ) ch ON TRUE
    -- A decision thread's group vote, whose own page the row opens.
    LEFT JOIN LATERAL (
      SELECT i.id FROM issues i
       WHERE i.thread_id = t.id AND i.kind = 'decision'
       ORDER BY i.id DESC
       LIMIT 1
    ) dec ON TRUE
   WHERE a.moderation_suspended_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM user_app_blocks b WHERE b.app_id = a.id AND b.user_id = $1)
     AND ($3::boolean OR a.view_visibility = 'public'
          OR EXISTS (SELECT 1 FROM app_collaborators m
                      WHERE m.app_id = a.id AND m.user_id = $1 AND m.status = 'member'))
     AND (NOT a.self_hosted OR $3::boolean
          OR EXISTS (SELECT 1 FROM app_collaborators m
                      WHERE m.app_id = a.id AND m.user_id = $1 AND m.status = 'member'))
     -- A thread they muted is not listed, even one they wrote in (the same
     -- exclusion THREADS_SQL makes).
     AND NOT EXISTS (SELECT 1 FROM thread_followers f
                      WHERE f.thread_id = t.id AND f.user_id = $1 AND f.muted_at IS NOT NULL)
) listed
 WHERE ($4::timestamptz IS NULL OR (last_at, id) < ($4::timestamptz, $5::bigint))
 ORDER BY last_at DESC, id DESC
 LIMIT $2`;

const iso = (at) => (at ? new Date(at).toISOString() : null);

// One thread, as the sheet's row reads it. `kind`, `number` and `title` follow
// what the page it opens says: a request names itself first (the page is its
// own), then a change, and a decision has no number. A thread with no title
// of its own has an empty one, which the rows draw as what it is ("Change
// #6872"): the project's name is on the row already, and as a title it read
// as though the change were called that.
function serialize(row) {
  const kind = row.kind === 'decision' ? 'decision'
    : (row.request_number != null && row.request_title != null ? 'request' : 'change');
  const number = kind === 'decision' ? null
    : kind === 'request' ? Number(row.request_number)
      : (row.pr_number != null ? Number(row.pr_number)
        : (row.number != null ? Number(row.number) : null));
  return {
    threadId: Number(row.id),
    kind,
    number,
    title: row.request_title || row.change_title || row.title || '',
    appSlug: row.slug,
    appName: row.app_name,
    appIconEmoji: row.icon_emoji || null,
    appIconUrl: row.icon_image_id ? `/app-icons/${row.icon_image_id}` : null,
    lastAt: iso(row.last_at),
    href: aiWork.hrefOf({
      slug: row.slug,
      number: row.request_number,
      request_title: row.request_title,
      pr_number: row.pr_number,
      kind: row.kind,
      decision_id: row.decision_id,
    }),
  };
}

/**
 * One page of the threads `viewer` took part in, newest activity first, and
 * how many there are in all (the statement counts them before the cursor
 * trims the page). The keyset cursor is the last row's `(lastAt, threadId)`;
 * a page exactly `limit` long means there may be more.
 */
async function recentThreadsPage(db, viewer, { limit = 30, before = null, beforeId = null, isAdmin = false } = {}) {
  const { rows } = await db.query(LIST_SQL, [
    viewer, limit, !!isAdmin, before || null, beforeId || 0,
  ]);
  const total = rows.length ? Number(rows[0].total) : 0;
  return { threads: rows.map(serialize), total: Number.isFinite(total) ? total : rows.length };
}

/** One page of the threads `viewer` took part in, newest activity first. */
async function listRecentThreads(db, viewer, opts = {}) {
  return (await recentThreadsPage(db, viewer, opts)).threads;
}

// ── Staging mock data ──────────────────────────────────────────────────
// ?demo=1 on staging only: three fixed rows, one request, one change and one
// decision across two demo projects, so a preview and the declared check have
// a list to show before anybody has taken part in a real thread. Fixed 99xxxx
// ids, "[Mock]" titles, request-time only, never persisted, and a strict
// no-op outside staging — the conventions stagingMockNotifications follows in
// src/routes/notifications.js.
function demoThreads(now = Date.now()) {
  const at = (minutes) => new Date(now - minutes * 60 * 1000).toISOString();
  return [
    {
      threadId: 990001,
      kind: 'request',
      number: 990301,
      title: '[Mock] A pause button for the game',
      appSlug: 'staging-demo',
      appName: 'Staging demo app',
      appIconEmoji: '🌱',
      appIconUrl: null,
      lastAt: at(5),
      href: '#app/staging-demo/dev/issues/990301',
    },
    {
      threadId: 990002,
      kind: 'change',
      number: 9906,
      title: '[Mock] Show who lent each book',
      appSlug: 'staging-demo-archive',
      appName: 'Staging demo archive',
      appIconEmoji: '📚',
      appIconUrl: null,
      lastAt: at(120),
      href: '#app/staging-demo-archive/dev/changes/9906',
    },
    {
      threadId: 990003,
      kind: 'decision',
      number: null,
      title: '[Mock] Rename the project to Page Turners',
      appSlug: 'staging-demo-archive',
      appName: 'Staging demo archive',
      appIconEmoji: '📚',
      appIconUrl: null,
      lastAt: at(3 * 24 * 60),
      href: '#app/staging-demo-archive/dev/governance/990001',
    },
  ];
}

module.exports = {
  participatedSql, listRecentThreads, recentThreadsPage, serialize, demoThreads, LIST_SQL,
};
