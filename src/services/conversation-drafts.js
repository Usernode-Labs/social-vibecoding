'use strict';

// Saved drafts in a person's chat with Homeroom bot: the agent chats' list
// (routes/chat-drafts.js, routes/agent-session-drafts.js), for the place in
// that chat they are writing in: the chat itself, or one of its threads.
//
// While the bot works on their message the message box saves what they type
// instead of sending it (frontend/src/features/messages/bot-stop.ts); a draft
// is sent later by a tap, never on its own. This module is the table's
// reads and writes; who may call them is the route's to decide
// (routes/conversations.js, the bot-drafts routes).
//
// - The list is per person, per conversation, per thread (`threadRootId`, or
//   null for the chat itself, stored as 0), oldest first.
// - A save is idempotent on its client-made id, and a draft already stored
//   never trips the cap. The cap is held by a transaction-scoped advisory
//   lock on the list, so two devices saving at once cannot both squeeze
//   under it, and nothing a message send locks is touched.
// - Limits are the agent chats' own (20 drafts, the id pattern, the
//   savedAt clamp), except the length: a draft is sent as a message, so it
//   is the message's 8000 characters, not the agent chats' 10,000.

const conversations = require('./conversations');
const log = require('./logger');

const MAX_DRAFT_CHARS = conversations.MAX_MESSAGE_LENGTH;
const DRAFTS_CHANGED = 'conversation_drafts_changed';

function toWire(rows) {
  return rows.map((r) => ({ id: r.draft_id, text: r.content, savedAt: r.saved_at }));
}

/** A person's drafts for one place in a conversation, oldest first. */
async function listDrafts(db, { userId, conversationId, threadRootId = null }) {
  const { rows } = await db.query(
    `SELECT draft_id, content, saved_at
       FROM conversation_drafts
      WHERE user_id = $1 AND conversation_id = $2 AND thread_root_id = $3
      ORDER BY saved_at ASC, draft_id ASC`,
    [userId, conversationId, threadRootId || 0],
  );
  return toWire(rows);
}

/** Is `threadRootId` a main-stream message of the conversation, so a thread can hang off it? */
async function isThreadRoot(db, conversationId, threadRootId) {
  const { rows } = await db.query(
    `SELECT 1 FROM conversation_messages
      WHERE id = $1 AND conversation_id = $2 AND thread_root_id IS NULL`,
    [threadRootId, conversationId],
  );
  return rows.length > 0;
}

/**
 * Save one draft. Resolves `{ saved: true }`, or `{ full: true }` when the
 * list already holds `max` others; nothing is ever evicted to make room.
 */
async function saveDraft(pool, { userId, conversationId, threadRootId = null, draftId, text, savedAt = null, max }) {
  const root = threadRootId || 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`conversation-drafts:${userId}:${conversationId}:${root}`],
    );
    const { rows: counts } = await client.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE draft_id = $4)::int AS mine
         FROM conversation_drafts
        WHERE user_id = $1 AND conversation_id = $2 AND thread_root_id = $3`,
      [userId, conversationId, root, draftId],
    );
    if (!counts[0].mine && counts[0].total >= max) {
      await client.query('ROLLBACK');
      return { full: true };
    }
    await client.query(
      `INSERT INTO conversation_drafts (user_id, conversation_id, thread_root_id, draft_id, content, saved_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()))
       ON CONFLICT (user_id, conversation_id, thread_root_id, draft_id) DO NOTHING`,
      [userId, conversationId, root, draftId, text, savedAt],
    );
    await client.query('COMMIT');
    return { saved: true };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already unwound */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Delete one draft. Resolves whether a row went: deleting twice is fine. */
async function deleteDraft(db, { userId, conversationId, threadRootId = null, draftId }) {
  const { rowCount } = await db.query(
    `DELETE FROM conversation_drafts
      WHERE user_id = $1 AND conversation_id = $2 AND thread_root_id = $3 AND draft_id = $4`,
    [userId, conversationId, threadRootId || 0, draftId],
  );
  return rowCount > 0;
}

/**
 * Tell the person's own sockets (their other tabs and devices, on every
 * pod) that one of their lists changed; each re-reads it. Nobody else is
 * told: a draft is its writer's alone. The event names the conversation and
 * no words, and a socket gets it only while its person is still a member
 * there (services/ws-delivery.js): an event that names a conversation is
 * delivered on the standing of whoever acted in it, here the person
 * themselves, so they are named as its actor.
 */
function pushDraftsChanged(userId, conversationId, threadRootId = null) {
  try {
    require('./ws').pushToUser(userId, {
      type: DRAFTS_CHANGED, conversationId, ...(threadRootId ? { threadRootId } : {}),
    }, { actorUserId: userId });
  } catch (err) {
    log.warn('conversation-drafts', 'drafts_changed push failed', { message: err.message });
  }
}

module.exports = {
  MAX_DRAFT_CHARS,
  DRAFTS_CHANGED,
  listDrafts,
  isThreadRoot,
  saveDraft,
  deleteDraft,
  pushDraftsChanged,
};
