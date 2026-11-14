'use strict';

// "Earlier chat": the one-time move of Main Chat into a thread (14 Nov 2026).
//
// Main Chat, the single mixed stream of a person's chat with Homeroom bot, is
// removed: every conversation with the bot is a thread. What each person and
// the bot said in Main before that is moved, once, under ONE ordinary
// private thread of theirs named "Earlier chat" (private_threads kind
// 'earlier'), which can be marked done and reopened like any other.
//
// WHAT MOVES. In a person's chat with the bot, the messages that are not a
// reply and that Main Chat drew: so never a request's news (hidden from Main
// since #6207: conversations.js REQUEST_NEWS, its request's page is its
// place) and never the first message of a thread the Homeroom bot page
// lists (a "+" opener, a draft, a design, a thread about a request: anything
// with a `private_threads` row). A message people replied under started a
// thread too: it stays where it is and gets the row that lists it (their own
// message as an idea; a line of the bot's as a note, or as its project's
// first-version thread when that is what it was about).
//
// THE THREAD'S FIRST MESSAGE is the person's earliest message of the ones
// that move (not a line written for the occasion). Message ids are the
// order things were said in, and every read of a thread orders by id, so
// promoting the earliest keeps the first message first and every other in
// its place with nothing rewritten. A line of the bot's made today would
// have the newest id of all: it would sort after the messages it introduces
// wherever a thread is read by id (the bot's own history of it, the unread
// cursor, search), and it would be a message nobody said. The thread is
// named by its kind, so it needs no opener to carry its name.
//
// NOTHING NEW IS UNREAD, AND NOTHING RINGS. The thread's read cursor starts
// where the person's Main Chat cursor was (conversation_members.
// last_read_message_id), so exactly what was unread in Main is unread in
// Earlier chat, and what was read stays read. No message is written, no
// notification is made or changed, and no timestamp moves.
//
// SAFE TO RUN AGAIN, AND WHILE PEOPLE CHAT. One person's move is one short
// transaction under the lock every message sent in that chat takes first
// (conversations.js lockPair), so no send lands halfway through it. A second
// run finds nothing left to move for a person already done, and a message an
// older instance wrote outside a thread during a rolling release is swept
// under the same thread by the next run. People are taken a batch at a time.
//
// A person with nothing to move gets no thread.

const log = require('./logger');
const conversations = require('./conversations');

const BATCH = 100;

// The first messages of one chat that are in no listed thread and that Main
// Chat drew. $1 the chat. `m` is the message, as REQUEST_NEWS reads it.
const CANDIDATES_SQL = `
  SELECT m.id, m.sender_id, (m.deleted_at IS NOT NULL) AS deleted,
         EXISTS (SELECT 1 FROM conversation_messages r WHERE r.thread_root_id = m.id) AS answered,
         (m.metadata->'homeroomBot'->>'firstVersion') = 'true' AS first_version,
         m.metadata->'homeroomBot'->>'appSlug' AS app_slug
    FROM conversation_messages m
   WHERE m.conversation_id = $1 AND m.thread_root_id IS NULL
     AND NOT ${conversations.REQUEST_NEWS}
     AND NOT EXISTS (SELECT 1 FROM private_threads p WHERE p.root_message_id = m.id)
   ORDER BY m.id`;

// A message people replied under is a thread of its own: its row. The cursor
// stops before its first reply an unread alert is about, else at its newest.
// $1 the person, $2 the chat, $3 the message, $4 its kind, $5 its project.
const LIST_ANSWERED_SQL = `
  INSERT INTO private_threads (user_id, conversation_id, root_message_id, app_id, kind, state, last_read_message_id)
  SELECT $1, $2, $3, $5, $4, 'open', COALESCE(
           (SELECT MIN(r.id) - 1 FROM notifications n
              JOIN conversation_messages r ON r.id = n.conversation_message_id
             WHERE n.user_id = $1 AND n.read_at IS NULL AND r.deleted_at IS NULL AND r.thread_root_id = $3),
           (SELECT MAX(r.id) FROM conversation_messages r WHERE r.thread_root_id = $3 OR r.id = $3))
  ON CONFLICT (root_message_id) DO NOTHING`;

/**
 * Move one person's Main Chat under their Earlier chat thread. `db` is a
 * client in a transaction that holds the chat's lock. Resolves { moved,
 * listed, rootId }: how many messages moved, how many answered messages got
 * the row that lists them, and the Earlier chat thread (null when they have
 * none).
 */
async function moveInTransaction(db, { conversationId, userId }) {
  const { rows: found } = await db.query(CANDIDATES_SQL, [Number(conversationId)]);
  let listed = 0;
  for (const m of found.filter((row) => row.answered)) {
    let kind = Number(m.sender_id) === Number(userId) ? 'idea' : 'note';
    let appId = null;
    if (kind === 'note' && m.first_version && m.app_slug) {
      const { rows: [app] } = await db.query('SELECT id FROM apps WHERE slug = $1', [String(m.app_slug)]);
      if (app) { kind = 'first_version'; appId = Number(app.id); }
    }
    const { rowCount } = await db.query(LIST_ANSWERED_SQL, [Number(userId), Number(conversationId), Number(m.id), kind, appId]);
    listed += rowCount;
  }
  const loose = found.filter((row) => !row.answered);
  const { rows: [earlier] } = await db.query(
    `SELECT root_message_id FROM private_threads WHERE user_id = $1 AND kind = 'earlier'`, [Number(userId)]);
  let rootId = earlier ? Number(earlier.root_message_id) : null;
  if (!rootId) {
    // The earliest message that is still there to read leads the thread.
    const first = loose.find((row) => !row.deleted);
    if (!first) return { moved: 0, listed, rootId: null };
    rootId = Number(first.id);
    await db.query(
      `INSERT INTO private_threads (user_id, conversation_id, root_message_id, kind, state, last_read_message_id)
       SELECT $1, $2, $3, 'earlier', 'open',
              COALESCE((SELECT cm.last_read_message_id FROM conversation_members cm
                         WHERE cm.conversation_id = $2 AND cm.user_id = $1), 0)
       ON CONFLICT (root_message_id) DO NOTHING`,
      [Number(userId), Number(conversationId), rootId],
    );
  }
  // Everything after the first message goes under it, in the order it was
  // said. A deleted placeholder from before the first message stays put: it
  // shows nothing, and would otherwise sort ahead of the thread's start.
  const ids = loose.map((row) => Number(row.id)).filter((id) => id > rootId);
  if (!ids.length) return { moved: 0, listed, rootId };
  const { rowCount } = await db.query(
    `UPDATE conversation_messages SET thread_root_id = $2
      WHERE id = ANY($1::int[]) AND conversation_id = $3 AND thread_root_id IS NULL`,
    [ids, rootId, Number(conversationId)],
  );
  return { moved: rowCount, listed, rootId };
}

/** Move one person's Main Chat (their chat `conversationId` with `botId`), in its own transaction. */
async function moveFor(pool, { conversationId, userId, botId }) {
  return conversations.transaction(pool, async (db) => {
    await conversations.lockPair(db, Number(userId), Number(botId));
    return moveInTransaction(db, { conversationId, userId });
  });
}

// The chats with the bot that still hold a message to move or to list, a
// batch at a time, by chat id. $1 the bot, $2 the last chat seen, $3 how many.
const PENDING_SQL = `
  SELECT d.conversation_id,
         CASE WHEN d.user_low_id = $1 THEN d.user_high_id ELSE d.user_low_id END AS user_id
    FROM conversation_direct_pairs d
   WHERE (d.user_low_id = $1 OR d.user_high_id = $1) AND d.conversation_id > $2
     AND EXISTS (
       SELECT 1 FROM conversation_messages m
        WHERE m.conversation_id = d.conversation_id AND m.thread_root_id IS NULL
          AND NOT ${conversations.REQUEST_NEWS}
          AND NOT EXISTS (SELECT 1 FROM private_threads p WHERE p.root_message_id = m.id))
   ORDER BY d.conversation_id
   LIMIT $3`;

/**
 * Move everybody's Main Chat under their Earlier chat thread. Resolves
 * { people, moved, listed }. A person whose move fails is logged and left
 * for the next run; it never throws for one of them.
 */
async function moveAll(pool, { batch = BATCH } = {}) {
  const { rows: [bot] } = await pool.query(
    `SELECT id FROM users WHERE username = 'homeroom_bot' AND is_synthetic = TRUE`);
  const totals = { people: 0, moved: 0, listed: 0 };
  if (!bot) return totals;
  let after = 0;
  for (;;) {
    const { rows } = await pool.query(PENDING_SQL, [Number(bot.id), after, batch]);
    if (!rows.length) break;
    for (const row of rows) {
      after = Number(row.conversation_id);
      try {
        const done = await moveFor(pool, { conversationId: row.conversation_id, userId: row.user_id, botId: bot.id });
        if (done.moved || done.listed) totals.people += 1;
        totals.moved += done.moved;
        totals.listed += done.listed;
      } catch (err) {
        log.warn('earlier-chat', 'Could not move a person\'s Main Chat (left for the next run)', {
          conversationId: Number(row.conversation_id), err: err.message,
        });
      }
    }
    if (rows.length < batch) break;
  }
  return totals;
}

module.exports = { CANDIDATES_SQL, PENDING_SQL, moveInTransaction, moveFor, moveAll };
