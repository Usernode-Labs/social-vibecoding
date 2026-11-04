'use strict';

// #6262: the read watermark for a request's, a change's or a decision's
// thread. The Homeroom bot page says which of those threads have something
// new for the viewer; opening one marks it read, from the page or from
// anywhere else its page opens (public/js/group-chat.js).
//
//   unreadFor(db, userId, threadIds)  → Map<threadId, count>; a thread with
//                                       no row gets one at its newest
//                                       message, so every thread starts at
//                                       zero (as app_category_chat_reads
//                                       does for a topic's channel).
//   markRead(db, { userId, threadId }) → { unread }; the cursor only ever
//                                       moves forward (GREATEST), as
//                                       app_chat_reads does.
//   threadOf(db, appId, type, ref)    → a thread id from the address a page
//                                       uses: 'issue' (a request's number),
//                                       'session' (a chat_sessions id) or
//                                       'governance' (an issues id).
//
// A message counts as unread when it is above the cursor, is a person's
// message ('message', not a system line), is not deleted, is not the
// viewer's own, and is not from somebody the viewer blocked — the same
// predicate app-chat.js unreadCount applies to a project's channel.

const MAX_IDS = 500;

function idsOf(threadIds) {
  const ids = [];
  const seen = new Set();
  for (const raw of Array.isArray(threadIds) ? threadIds : []) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.slice(0, MAX_IDS);
}

/**
 * How many messages in each of `threadIds` the viewer has not read yet.
 * Rows missing for a thread are created at its newest message first, so a
 * thread never starts with a backlog the viewer never saw.
 */
async function unreadFor(db, userId, threadIds) {
  const ids = idsOf(threadIds);
  const unread = new Map();
  if (!ids.length || !userId) return unread;
  await db.query(
    `INSERT INTO thread_reads (thread_id, user_id, last_read_id)
     SELECT t.id, $1, COALESCE((
              SELECT MAX(m.id) FROM chat_messages m
               WHERE m.thread_id = t.id
                 AND m.msg_type = 'message'
                 AND m.deleted_at IS NULL
                 AND m.user_id IS NOT NULL AND m.user_id <> $1
                 AND NOT EXISTS (SELECT 1 FROM user_blocks b
                                  WHERE b.blocker_id = $1 AND b.blocked_user_id = m.user_id)), 0)
       FROM threads t
      WHERE t.id = ANY($2::bigint[])
     ON CONFLICT (thread_id, user_id) DO NOTHING`,
    [userId, ids]
  );
  const { rows } = await db.query(
    `SELECT m.thread_id, COUNT(*)::int AS unread
       FROM chat_messages m
       JOIN thread_reads tr ON tr.thread_id = m.thread_id AND tr.user_id = $1
      WHERE m.thread_id = ANY($2::bigint[])
        AND m.id > tr.last_read_id
        AND m.msg_type = 'message'
        AND m.deleted_at IS NULL
        AND m.user_id IS NOT NULL AND m.user_id <> $1
        AND NOT EXISTS (SELECT 1 FROM user_blocks b
                         WHERE b.blocker_id = $1 AND b.blocked_user_id = m.user_id)
      GROUP BY m.thread_id`,
    [userId, ids]
  );
  for (const row of rows) unread.set(Number(row.thread_id), Number(row.unread) || 0);
  return unread;
}

/**
 * Move the viewer's cursor in `threadId` to its newest message, never back.
 * Returns how many messages were unread afterwards (normally zero), or null
 * when the thread does not exist.
 */
async function markRead(db, { userId, threadId }) {
  const id = Number(threadId);
  if (!Number.isInteger(id) || id <= 0 || !userId) return null;
  const { rows } = await db.query(
    `INSERT INTO thread_reads (thread_id, user_id, last_read_id)
     SELECT t.id, $1, COALESCE((SELECT MAX(m.id) FROM chat_messages m WHERE m.thread_id = t.id), 0)
       FROM threads t
      WHERE t.id = $2
     ON CONFLICT (thread_id, user_id) DO UPDATE
       SET last_read_id = GREATEST(thread_reads.last_read_id, EXCLUDED.last_read_id),
           updated_at = NOW()
     RETURNING thread_id`,
    [userId, id]
  );
  if (!rows.length) return null;
  const unread = await unreadFor(db, userId, [id]);
  return { unread: unread.get(id) || 0 };
}

/**
 * The thread a page's address names, in `appId`: an 'issue' is a request's
 * number, a 'session' a chat_sessions id, a 'governance' an issues id. Null
 * when this project has no such thread.
 */
async function threadOf(db, appId, type, ref) {
  const n = Number(ref);
  if (!Number.isInteger(n) || n <= 0) return null;
  let sql;
  if (type === 'issue') {
    sql = `SELECT COALESCE(r.thread_id, t.id) AS thread_id
             FROM requests r
             LEFT JOIN threads t ON t.app_id = r.app_id AND t.number = r.number
            WHERE r.app_id = $1 AND r.number = $2
            ORDER BY (r.thread_id IS NOT NULL) DESC
            LIMIT 1`;
  } else if (type === 'session') {
    sql = 'SELECT thread_id FROM chat_sessions WHERE id = $2 AND app_id = $1';
  } else if (type === 'governance') {
    sql = 'SELECT thread_id FROM issues WHERE id = $2 AND app_id = $1';
  } else {
    return null;
  }
  const { rows } = await db.query(sql, [appId, n]);
  const id = rows[0]?.thread_id;
  return id == null ? null : Number(id) || null;
}

module.exports = { unreadFor, markRead, threadOf };
