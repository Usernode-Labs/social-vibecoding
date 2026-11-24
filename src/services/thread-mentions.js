'use strict';

// Being named is Needs you until you answer or dismiss it (24 Nov 2026,
// mobile 04, Evan): when somebody names a person with @ in a thread, the
// Homeroom bot tab lists that thread in Needs you, with Reply and Dismiss.
//
// WHAT STARTS IT. An @ of them in a thread's chat (a 'mention' notification
// whose message has a thread) or in a request's own text (an
// 'issue_mention', the request's number in `detail`): the two branches
// Recent threads reads (recent-threads.js participatedSql). Not an @ in
// Messages or in a project's channel: those are not threads, and the bell and
// Messages carry them. Homeroom bot naming them counts as a person's @ does.
// Naming yourself does not.
//
// ONE ROW A THREAD, however many times they were named: the newest @ that
// still stands, which says who named them and when, and is the message Reply
// opens the thread at (a request's own text has no message: its page opens).
//
// WHAT ENDS IT, read every time, never swept:
//   1. they write in that thread after the @ (a message; a reaction is not
//      an answer);
//   2. they press Dismiss (thread_mention_dismissals; a newer @ starts the
//      row again);
//   3. the thread finishes: it is no longer open (threads_refresh_state: no
//      open request, no change being made or up for a vote, no open vote);
//   4. the @ is more than NAMED_DAYS old. Only an @ from the last week starts
//      a row, so nobody opens the tab on the day this ships to hundreds of
//      old ones, and a row leaves on its own when its @ turns a week old.
// Opening the thread ends nothing, and neither does reading the bell.
//
// A thread they muted is not listed (Mute removes a thread from the tab), and
// neither is one in a project they may not see (ai-work.js VISIBLE_APP_WHERE).
// The tab draws one row a thread in Needs you: a vote it owes them, or any
// other Needs you row for it, wins (frontend/src/features/ai/model.ts
// needsYou), and while the row stands the thread is in no other list.

const aiWork = require('./ai-work');

// How long an @ can start a row, in days (Evan's number).
const NAMED_DAYS = 7;
// The most rows one read lists.
const NAMED_MAX = 100;

// $1 viewer, $2 show self-hosted, $3 admin, $4 days an @ starts a row, $5 the
// most rows. The newest standing @ in each thread, newest first.
const NAMED_SQL = `
SELECT * FROM (
SELECT DISTINCT ON (x.thread_id)
       x.thread_id AS id, x.at, x.message_id, x.by_id, u.username AS by_username,
       t.app_id, t.number, t.kind, t.title AS thread_title,
       a.slug, a.name, a.icon_emoji, a.icon_image_id, a.repo_url,
       req.id AS request_id, req.title AS request_title,
       ch.id AS change_id, ch.pr_number, ch.title AS change_title,
       dec.id AS decision_id
  FROM (
    -- Named with @ in a thread's chat.
    SELECT m.thread_id, m.created_at AS at, m.id AS message_id, n.source_user_id AS by_id
      FROM notifications n
      JOIN chat_messages m ON m.id = n.chat_message_id
     WHERE n.user_id = $1 AND n.kind = 'mention' AND m.thread_id IS NOT NULL AND m.deleted_at IS NULL
       AND n.source_user_id IS DISTINCT FROM $1
       AND m.created_at > NOW() - make_interval(days => $4)
    UNION ALL
    -- Named with @ in a request's own text (detail is its number). The cast
    -- happens only in the branch the digits check already matched.
    SELECT t.id, n.created_at, NULL::int, n.source_user_id
      FROM notifications n
      JOIN threads t ON t.app_id = n.app_id
       AND t.number = (CASE WHEN n.detail ~ '^[0-9]{1,9}$' THEN n.detail::int END)
     WHERE n.user_id = $1 AND n.kind = 'issue_mention'
       AND n.source_user_id IS DISTINCT FROM $1
       AND n.created_at > NOW() - make_interval(days => $4)
  ) x
  JOIN threads t ON t.id = x.thread_id
  JOIN apps a ON a.id = t.app_id
  LEFT JOIN app_collaborators me ON me.app_id = a.id AND me.user_id = $1 AND me.status = 'member'
  LEFT JOIN users u ON u.id = x.by_id
  -- The thread's lead request, its newest change and its decision, as the
  -- tab's other rows name and address a thread (ai-work.js THREADS_SQL).
  LEFT JOIN LATERAL (
    SELECT r.id, r.title FROM requests r
     WHERE r.thread_id = t.id
     ORDER BY (r.number = t.number) DESC, r.number
     LIMIT 1
  ) req ON TRUE
  LEFT JOIN LATERAL (
    SELECT cs.id, cs.pr_number, COALESCE(NULLIF(cs.pr_title, ''), NULLIF(cs.session_title, '')) AS title
      FROM chat_sessions cs
     WHERE cs.thread_id = t.id AND cs.is_headless = FALSE
       AND cs.status IN ('active', 'paused', 'promoted', 'merging', 'merged', 'archived')
       AND (cs.status NOT IN ('active', 'paused') OR cs.shared_at IS NOT NULL OR cs.user_id = $1)
     ORDER BY CASE cs.status WHEN 'merged' THEN 0 WHEN 'merging' THEN 1 WHEN 'promoted' THEN 2 ELSE 3 END,
              cs.id DESC
     LIMIT 1
  ) ch ON TRUE
  LEFT JOIN LATERAL (
    SELECT i.id FROM issues i
     WHERE t.kind = 'decision' AND i.thread_id = t.id
     ORDER BY i.id DESC
     LIMIT 1
  ) dec ON TRUE
 WHERE t.merged_into IS NULL
   -- 3. The thread has not finished.
   AND t.state = 'open'
   -- 1. They have not written in it since.
   AND NOT EXISTS (SELECT 1 FROM chat_messages w
                    WHERE w.thread_id = x.thread_id AND w.user_id = $1
                      AND w.msg_type = 'message' AND w.deleted_at IS NULL
                      AND w.created_at > x.at)
   -- 2. They have not dismissed it since.
   AND NOT EXISTS (SELECT 1 FROM thread_mention_dismissals d
                    WHERE d.user_id = $1 AND d.thread_id = x.thread_id AND d.dismissed_at >= x.at)
   AND NOT EXISTS (SELECT 1 FROM thread_followers f
                    WHERE f.thread_id = t.id AND f.user_id = $1 AND f.muted_at IS NOT NULL)
   AND ${aiWork.VISIBLE_APP_WHERE}
 ORDER BY x.thread_id, x.at DESC, x.message_id DESC NULLS LAST
) named
 ORDER BY at DESC, id DESC
 LIMIT $5`;

const iso = (at) => (at ? new Date(at).toISOString() : null);

/**
 * Pure: one @ row as the tab draws it: the thread, named and addressed as
 * its other rows are (ai-work.js shapeThread, hrefOf), who named them and
 * when, and the message Reply opens at. `botId` is Homeroom bot's account.
 */
function shapeNamed(row, botId = null) {
  const number = row.number != null ? Number(row.number) : row.pr_number != null ? Number(row.pr_number) : null;
  const byBot = botId != null && row.by_id != null && Number(row.by_id) === Number(botId);
  return {
    threadId: Number(row.id),
    number,
    kind: row.change_id && row.request_id == null ? 'change' : row.kind,
    title: row.request_title || row.change_title || row.thread_title || null,
    app: aiWork.appOf(row),
    change: row.change_id ? { id: Number(row.change_id), number: row.pr_number == null ? null : Number(row.pr_number) } : null,
    href: aiWork.hrefOf(row),
    at: iso(row.at),
    // Who named them: Homeroom bot, a person by username, or nobody known
    // (an account since removed).
    ...(byBot ? { byBot: true } : {}),
    by: byBot ? null : row.by_username || null,
    messageId: row.message_id != null ? Number(row.message_id) : null,
  };
}

/** The viewer's @ rows, newest first. `bot` is Homeroom bot's account, or null. */
async function namedFor(pool, { user, showSelfHosted = false, bot = null }) {
  const { rows } = await pool.query(NAMED_SQL, [user.id, !!showSelfHosted, !!user.isAdmin, NAMED_DAYS, NAMED_MAX]);
  return rows.map((row) => shapeNamed(row, bot ? bot.id : null));
}

/**
 * Dismiss: the viewer waves off the @ in one thread, now. A newer @ starts
 * the row again (NAMED_SQL compares the moments). Resolves true when the
 * thread is a thread.
 */
async function dismiss(pool, { userId, threadId }) {
  const { rows } = await pool.query(
    `INSERT INTO thread_mention_dismissals (user_id, thread_id, dismissed_at)
     SELECT $1, t.id, NOW() FROM threads t WHERE t.id = $2
     ON CONFLICT (user_id, thread_id) DO UPDATE SET dismissed_at = EXCLUDED.dismissed_at
     RETURNING thread_id`,
    [userId, threadId],
  );
  return rows.length > 0;
}

module.exports = { NAMED_DAYS, NAMED_MAX, NAMED_SQL, shapeNamed, namedFor, dismiss };
