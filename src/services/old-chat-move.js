'use strict';

// The one-time move of agent chats and dev chats into Homeroom bot threads
// (15 Nov 2026).
//
// Two kinds of conversation are retired: an agent chat (a person's
// conversation with the Mayor, an `agent_sessions` row) and a dev chat (a
// classic change's own chat: a `chat_sessions` row with no agent chat above
// it that is neither an unattended run, an imported pull request, a CLI
// hand-off nor a request's planning record). A person works with Homeroom
// bot in its threads now, or with their own coding agent.
//
// What was SAID in each of them is copied into the person's chat with
// Homeroom bot as one thread: their messages as theirs, the agent's replies
// as the bot's, in the order and at the times they were said. Only what was
// said moves: a coding run's log, a status line, a confirmation card and an
// attached file stay behind in `chat_session_messages`, which is the
// change's record and is not touched.
//
// THE THREAD IS FINISHED WHEN IT ARRIVES. Its `private_threads` row is done,
// as of the conversation's last message, so it is listed in the Homeroom bot
// page's History (or Live this week, when it ended in the last week) and
// never in Needs you. Writing in it reopens it, like any done thread, and
// the bot answers there with what was said above it. It is named by the
// conversation's old title (`metadata.movedChat.title` on its first
// message: ai-work.js and ai-history.js read it).
//
// NOTHING IS UNREAD, NOTHING RINGS, AND THE CHAT'S ROW DOES NOT MOVE. The
// thread's read cursor is its newest message. No notification is made. Every
// copied message carries `metadata.movedChat`, which the Messages list skips
// when it reads the chat's latest message (conversations.js MOVED_CHAT), so
// the row for Homeroom bot keeps the time and words of what was last
// actually said.
//
// SAFE TO RUN AGAIN, AND WHILE PEOPLE CHAT. One conversation's move is one
// transaction under the lock every message sent in that person's chat with
// the bot takes first (conversations.js lockPair). `moved_chats` records
// where it went and the last row copied, so a second run finds nothing, and
// a message an older instance wrote in an agent chat during a rolling
// release is added under the same thread by the next run. An old link is
// answered from that table (whereMoved; GET /api/ai/where).
//
// A conversation in which nothing was said, one whose owner is a synthetic
// account, and one whose owner blocked the bot get no thread.

const log = require('./logger');
const conversations = require('./conversations');

const BATCH = 100;
// conversation_messages.content holds 8000 characters; a longer reply is
// continued in the next message.
const MAX_CONTENT = 8000;
const MAX_TITLE = 200;

// What was said: a person's message or the agent's reply, with words in it.
const SAID = `m.role IN ('user', 'assistant') AND btrim(m.content) <> ''`;

// A dev chat: a change whose chat was its own (classic-sessions' rule, as
// it stood when they were retired).
const CLASSIC = `s.agent_session_id IS NULL AND s.is_headless IS NOT TRUE
   AND COALESCE(s.source, '') NOT IN ('imported', 'cli_handoff', 'request_spec')`;

// The conversations that still hold something to copy, a batch at a time by
// id. $1 the last id seen, $2 how many.
const PENDING_SQL = {
  agent: `
    SELECT a.id, a.user_id, a.title, a.focus_app_id AS app_id,
           mc.root_message_id, COALESCE(mc.through_id, 0) AS through_id
      FROM agent_sessions a
      JOIN users u ON u.id = a.user_id AND u.is_synthetic IS NOT TRUE
      LEFT JOIN moved_chats mc ON mc.source = 'agent' AND mc.source_id = a.id
     WHERE a.id > $1
       AND EXISTS (SELECT 1 FROM chat_session_messages m
                    WHERE m.agent_session_id = a.id AND m.id > COALESCE(mc.through_id, 0) AND ${SAID})
     ORDER BY a.id
     LIMIT $2`,
  session: `
    SELECT s.id, s.user_id, COALESCE(NULLIF(btrim(s.session_title), ''), s.pr_title) AS title, s.app_id,
           mc.root_message_id, COALESCE(mc.through_id, 0) AS through_id
      FROM chat_sessions s
      JOIN users u ON u.id = s.user_id AND u.is_synthetic IS NOT TRUE
      LEFT JOIN moved_chats mc ON mc.source = 'session' AND mc.source_id = s.id
     WHERE s.id > $1 AND ${CLASSIC}
       AND EXISTS (SELECT 1 FROM chat_session_messages m
                    WHERE m.session_id = s.id AND m.agent_session_id IS NULL
                      AND m.id > COALESCE(mc.through_id, 0) AND ${SAID})
     ORDER BY s.id
     LIMIT $2`,
};

// What is left to copy of one conversation, in the order it was said.
// $1 the conversation, $2 the last row already copied.
const SAID_SQL = {
  agent: `
    SELECT m.id, m.role, m.content, m.created_at FROM chat_session_messages m
     WHERE m.agent_session_id = $1 AND m.id > $2 AND ${SAID}
     ORDER BY m.id`,
  session: `
    SELECT m.id, m.role, m.content, m.created_at FROM chat_session_messages m
     WHERE m.session_id = $1 AND m.agent_session_id IS NULL AND m.id > $2 AND ${SAID}
     ORDER BY m.id`,
};

/** Pure: a message's words as the pieces a chat message can hold, in order. */
function pieces(content, max = MAX_CONTENT) {
  const text = String(content || '').trim();
  const out = [];
  for (let at = 0; at < text.length; at += max) out.push(text.slice(at, at + max));
  return out;
}

/** Pure: the name the thread is listed by, or null when the conversation had none. */
function titleOf(title) {
  const clean = String(title || '').replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, MAX_TITLE) : null;
}

/**
 * Copy what is left of one conversation under its thread. `db` is a client
 * in a transaction that holds the lock of the person's chat with the bot;
 * `chat` is one PENDING_SQL row. Resolves { copied, rootId }: how many
 * messages were written, and the thread (null when nothing was said).
 */
async function moveInTransaction(db, { source, chat, conversationId, botId }) {
  const sourceId = Number(chat.id);
  const userId = Number(chat.user_id);
  // Read again under the lock: another instance may have moved it since.
  const { rows: [done] } = await db.query(
    `SELECT root_message_id, through_id FROM moved_chats WHERE source = $1 AND source_id = $2 FOR UPDATE`,
    [source, sourceId],
  );
  let rootId = done ? Number(done.root_message_id) : null;
  const { rows: said } = await db.query(SAID_SQL[source], [sourceId, done ? Number(done.through_id) : 0]);
  if (!said.length) return { copied: 0, rootId };
  const title = titleOf(chat.title);
  let copied = 0;
  let newest = null;
  for (const row of said) {
    const senderId = row.role === 'user' ? userId : Number(botId);
    for (const content of pieces(row.content)) {
      const moved = { source, id: sourceId, ...(rootId || !title ? {} : { title }) };
      const { rows: [written] } = await db.query(
        `INSERT INTO conversation_messages (conversation_id, sender_id, content, metadata, created_at, thread_root_id)
         VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()), $6)
         RETURNING id`,
        [Number(conversationId), senderId, content, JSON.stringify({ movedChat: moved }), row.created_at, rootId],
      );
      newest = Number(written.id);
      copied += 1;
      if (!rootId) {
        rootId = newest;
        // Their own first words make it an idea of theirs; a conversation
        // the agent opened is a note of the bot's (earlier-chat.js names the
        // same two).
        await db.query(
          `INSERT INTO private_threads
             (user_id, conversation_id, root_message_id, app_id, kind, state, done_from, done_at,
              last_read_message_id, created_at, updated_at)
           VALUES ($1, $2, $3, (SELECT id FROM apps WHERE id = $4::int), $5, 'done', 'open',
                   COALESCE($6::timestamptz, NOW()), $3, COALESCE($7::timestamptz, NOW()), COALESCE($6::timestamptz, NOW()))`,
          [userId, Number(conversationId), rootId, chat.app_id == null ? null : Number(chat.app_id),
            row.role === 'user' ? 'idea' : 'note', said[said.length - 1].created_at, row.created_at],
        );
      }
    }
  }
  const through = Number(said[said.length - 1].id);
  await db.query(
    `INSERT INTO moved_chats (source, source_id, user_id, root_message_id, through_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (source, source_id) DO UPDATE SET through_id = EXCLUDED.through_id`,
    [source, sourceId, userId, rootId, through],
  );
  // What was added to a thread moved before is read too, and its end moves
  // with it while it is still the finished thread it arrived as.
  await db.query(
    `UPDATE private_threads
        SET last_read_message_id = GREATEST(COALESCE(last_read_message_id, 0), $2),
            done_at = CASE WHEN state = 'done' THEN GREATEST(done_at, COALESCE($3::timestamptz, done_at)) ELSE done_at END
      WHERE root_message_id = $1`,
    [rootId, newest, said[said.length - 1].created_at],
  );
  return { copied, rootId };
}

/** Move one conversation, in its own transaction. Resolves { copied, rootId }, or null when the person has no chat with the bot to move it into. */
async function moveOne(pool, { source, chat, botId }) {
  const dm = await conversations.ensureAdmittedDirect(pool, Number(botId), Number(chat.user_id));
  if (!dm) return null;
  return conversations.transaction(pool, async (db) => {
    await conversations.lockPair(db, Number(chat.user_id), Number(botId));
    return moveInTransaction(db, { source, chat, conversationId: dm.conversationId, botId });
  });
}

/**
 * Move every agent chat and dev chat that still holds something to copy.
 * Resolves { chats, copied }. A conversation whose move fails is logged and
 * left for the next run; it never throws for one of them.
 */
async function moveAll(pool, { batch = BATCH } = {}) {
  const totals = { chats: 0, copied: 0 };
  const { rows: [bot] } = await pool.query(
    `SELECT id FROM users WHERE username = 'homeroom_bot' AND is_synthetic = TRUE`);
  if (!bot) return totals;
  for (const source of ['agent', 'session']) {
    let after = 0;
    for (;;) {
      const { rows } = await pool.query(PENDING_SQL[source], [after, batch]);
      if (!rows.length) break;
      for (const chat of rows) {
        after = Number(chat.id);
        try {
          const done = await moveOne(pool, { source, chat, botId: bot.id });
          if (done && done.copied) {
            totals.chats += 1;
            totals.copied += done.copied;
          }
        } catch (err) {
          log.warn('old-chat-move', 'Could not move a conversation into a Homeroom bot thread (left for the next run)', {
            source, id: Number(chat.id), err: err.message,
          });
        }
      }
      if (rows.length < batch) break;
    }
  }
  return totals;
}

/**
 * The thread an agent chat or a dev chat of `userId` was moved under: its
 * first message's id, or null when it was not theirs or nothing of it moved.
 */
async function whereMoved(db, { userId, source, id }) {
  const sourceId = Number(id);
  if (!userId || (source !== 'agent' && source !== 'session')) return null;
  if (!Number.isSafeInteger(sourceId) || sourceId <= 0 || sourceId > 2147483647) return null;
  const { rows: [row] = [] } = await db.query(
    `SELECT root_message_id FROM moved_chats WHERE source = $1 AND source_id = $2 AND user_id = $3`,
    [source, sourceId, Number(userId)],
  );
  return row ? Number(row.root_message_id) : null;
}

module.exports = {
  PENDING_SQL, SAID_SQL, MAX_CONTENT, pieces, titleOf,
  moveInTransaction, moveOne, moveAll, whereMoved,
};
