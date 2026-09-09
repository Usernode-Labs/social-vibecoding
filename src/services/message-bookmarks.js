// #1280: personal bookmarks on messages — an app's group chat, and the
// Messages area's direct and group conversations.
//
// A user saves any message they can read; the saved rows render in a pinned
// "Saved" section at the TOP of the notifications drawer until unsaved —
// either from the message's own bookmark button or from that section.
//
// TWO TABLES, ONE SECTION. The two halves of this file are the same feature
// over two message tables (`chat_messages` and `conversation_messages`) that
// a single foreign key cannot both point at. They differ in exactly one
// respect worth knowing — the access rule re-checked on read, because an app
// can be view-public and a conversation is only ever its members\' — and the
// second half says so where it defines CONVERSATION_ACCESS_SQL.
//
// Why this is its own service rather than a corner of ./notifications.js:
// a bookmark is not a notification. It is never created for you by someone
// else, it has no unread state, it never pushes, and it never expires. The
// only thing the two share is the drawer they render in, which is a
// rendering fact, not a data one — src/routes/notifications.js folds this
// list into that one payload so the drawer still opens in a single
// round-trip.
//
// Everything here is scoped to ONE user's own rows. There is no read path
// for another user's saves and there is deliberately no aggregate ("N
// people saved this"): unlike a reaction, a save is private, which is also
// why the toggle is REST rather than a chat-WebSocket broadcast.

const log = require('./logger');

// Newest-save-first, capped. The section is a pinned strip above the
// notification list rather than a browsable archive, so it does not
// paginate; a user who saves more than this sees their most recent saves
// and unsaves to reveal older ones.
const MAX_SAVED = 50;

// View access, in SQL, mirroring app-access.checkAppAccess('view'): an
// admin sees everything, a view-public app is visible to anyone, and a
// view-private one only to its member collaborators.
//
// This is applied on READ, not just on save, and that is the point — an app
// can go view-private (or drop a collaborator) long after a message was
// saved, and the drawer must stop showing that message's content the moment
// it does. $1 is the viewer's id and $2 their admin flag.
const VIEW_ACCESS_SQL = `(
  $2::boolean
  OR a.view_visibility = 'public'
  OR EXISTS (
    SELECT 1 FROM app_collaborators ac
     WHERE ac.app_id = a.id AND ac.user_id = $1 AND ac.status = 'member'
  )
)`;

// Save a message. Idempotent: re-saving an already-saved message keeps the
// original `created_at`, so a double-tap (or two tabs) can't reorder the
// section. Returns true when the row exists afterwards, which is every
// non-throwing case.
async function save(pool, userId, messageId) {
  if (!userId || !messageId) return false;
  await pool.query(
    `INSERT INTO message_bookmarks (user_id, message_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, message_id) DO NOTHING`,
    [userId, messageId]
  );
  return true;
}

// Unsave. Returns the number of rows removed (0 when it wasn't saved), so
// the route can answer honestly without a second lookup.
async function remove(pool, userId, messageId) {
  if (!userId || !messageId) return 0;
  const { rowCount } = await pool.query(
    `DELETE FROM message_bookmarks WHERE user_id = $1 AND message_id = $2`,
    [userId, messageId]
  );
  return rowCount || 0;
}

// Which of `messageIds` this user has saved — the chat-history hydrate, so
// a loaded page of messages renders its bookmark buttons already filled in.
// Same shape and contract as notifications.unreadMessageIdsForUser: a Set,
// and an empty one for an anonymous viewer or an empty id list.
async function savedMessageIdsFor(pool, userId, messageIds) {
  if (!userId || !Array.isArray(messageIds) || !messageIds.length) return new Set();
  const ids = messageIds.filter((id) => Number.isInteger(id));
  if (!ids.length) return new Set();
  const { rows } = await pool.query(
    `SELECT message_id FROM message_bookmarks
      WHERE user_id = $1 AND message_id = ANY($2::int[])`,
    [userId, ids]
  );
  return new Set(rows.map((r) => r.message_id));
}

// The drawer's pinned section: this user's saved messages, newest save
// first, joined to everything a row needs to render and to route on click
// (the app it lives in, its author, and the thread it belongs to so the
// click can open the topic discussion rather than the general stream).
//
// Messages whose app the viewer can no longer see are dropped by
// VIEW_ACCESS_SQL rather than rendered blank.
async function listForUser(pool, userId, { isAdmin = false, limit = MAX_SAVED } = {}) {
  if (!userId) return [];
  const { rows } = await pool.query(
    `SELECT b.message_id, b.created_at AS saved_at,
            m.content, m.thread_type, m.thread_ref, m.created_at AS message_created_at,
            a.id AS app_id, a.slug AS app_slug, a.name AS app_name,
            u.username AS author
       FROM message_bookmarks b
       JOIN chat_messages m ON m.id = b.message_id
       JOIN apps a ON a.id = m.app_id
       LEFT JOIN users u ON u.id = m.user_id
      WHERE b.user_id = $1 AND ${VIEW_ACCESS_SQL}
      ORDER BY b.created_at DESC, b.message_id DESC
      LIMIT $3`,
    [userId, !!isAdmin, limit]
  );
  return rows.map(serialize);
}

function serialize(row) {
  return {
    messageId: row.message_id,
    appId: row.app_id,
    appSlug: row.app_slug,
    appName: row.app_name,
    author: row.author,
    content: row.content,
    threadType: row.thread_type,
    threadRef: row.thread_ref,
    savedAt: row.saved_at,
    messageCreatedAt: row.message_created_at,
  };
}

// Best-effort variant for the notifications payload: the drawer's saved
// section must never be the reason the whole dropdown 500s. Same contract
// the chat route's reaction/unread hydrates use.
async function listForUserSafe(pool, userId, options) {
  try {
    return await listForUser(pool, userId, options);
  } catch (err) {
    log.warn('message-bookmarks', 'saved list failed', { message: err.message });
    return [];
  }
}

// ── The same feature, on a conversation message ──────────────────────
//
// The Messages area is DMs and group conversations, which are
// `conversation_messages` rows — a different table from the `chat_messages`
// an app's group chat posts into, and the reason these are separate
// functions over a separate table (see the schema comment on
// `conversation_message_bookmarks` for why one widened table was not the
// cheaper answer).
//
// Everything else is deliberately identical: idempotent save, an unsave that
// reports what it removed, a Set-returning hydrate for a loaded page, and a
// list that re-checks access on READ. Only the access rule differs, because
// a conversation's is different in kind: an app can be view-public, so
// VIEW_ACCESS_SQL above admits non-members and admins; a conversation admits
// exactly its current members. Leaving a conversation, being removed from
// one, or blocking the other person must all stop the drawer showing what
// was said in it — so this is a plain membership test, with no admin
// override, applied every time the section is read.
const CONVERSATION_ACCESS_SQL = `EXISTS (
  SELECT 1 FROM conversation_members cm
   WHERE cm.conversation_id = m.conversation_id
     AND cm.user_id = $1
     AND cm.status = 'member'
)`;

// Save a conversation message. Idempotent, like save() above: the original
// `created_at` survives a re-save, so a double-tap cannot reorder the
// section.
async function saveConversationMessage(pool, userId, messageId) {
  if (!userId || !messageId) return false;
  await pool.query(
    `INSERT INTO conversation_message_bookmarks (user_id, message_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, message_id) DO NOTHING`,
    [userId, messageId]
  );
  return true;
}

// Unsave one. Returns rows removed, so the route can answer without a
// second lookup.
async function removeConversationMessage(pool, userId, messageId) {
  if (!userId || !messageId) return 0;
  const { rowCount } = await pool.query(
    `DELETE FROM conversation_message_bookmarks
      WHERE user_id = $1 AND message_id = $2`,
    [userId, messageId]
  );
  return rowCount || 0;
}

// Which of `messageIds` this user has saved — the conversation-history
// hydrate, so a loaded page renders its save buttons already filled in.
// Same contract as savedMessageIdsFor: a Set, empty for an anonymous viewer
// or an empty list.
async function savedConversationMessageIdsFor(pool, userId, messageIds) {
  if (!userId || !Array.isArray(messageIds) || !messageIds.length) return new Set();
  const ids = messageIds.filter((id) => Number.isInteger(id));
  if (!ids.length) return new Set();
  const { rows } = await pool.query(
    `SELECT message_id FROM conversation_message_bookmarks
      WHERE user_id = $1 AND message_id = ANY($2::int[])`,
    [userId, ids]
  );
  return new Set(rows.map((r) => r.message_id));
}

// This user's saved conversation messages, newest save first, joined to what
// a row needs to render and to route on click.
//
// `title` is NULL for a direct conversation — those are named by their other
// participant, not by a stored title — so the peer's username is resolved
// here and the serializer falls back to it. A group keeps its own title.
async function listConversationsForUser(pool, userId, { limit = MAX_SAVED } = {}) {
  if (!userId) return [];
  const { rows } = await pool.query(
    `SELECT b.message_id, b.created_at AS saved_at,
            m.content, m.conversation_id, m.created_at AS message_created_at,
            c.kind AS conversation_kind, c.title AS conversation_title,
            u.username AS author,
            peer.username AS peer_username
       FROM conversation_message_bookmarks b
       JOIN conversation_messages m ON m.id = b.message_id
       JOIN conversations c ON c.id = m.conversation_id
       LEFT JOIN users u ON u.id = m.sender_id
       LEFT JOIN LATERAL (
         SELECT pu.username
           FROM conversation_members pm
           JOIN users pu ON pu.id = pm.user_id
          WHERE pm.conversation_id = m.conversation_id
            AND pm.user_id <> $1
            AND pm.status = 'member'
          ORDER BY pm.user_id
          LIMIT 1
       ) peer ON c.kind = 'direct'
      WHERE b.user_id = $1 AND ${CONVERSATION_ACCESS_SQL}
      ORDER BY b.created_at DESC, b.message_id DESC
      LIMIT $2`,
    [userId, limit]
  );
  return rows.map(serializeConversation);
}

// The drawer renders one "Saved" section over both kinds, so both shapes
// carry the same field names where they mean the same thing (`messageId`,
// `author`, `content`, `savedAt`). `conversationId` is what tells the two
// apart at the click site: an app save has `appSlug` and no `conversationId`,
// a conversation save the reverse.
function serializeConversation(row) {
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    conversationKind: row.conversation_kind,
    conversationTitle: row.conversation_title
      || (row.peer_username ? `@${row.peer_username}` : 'Conversation'),
    author: row.author,
    content: row.content,
    savedAt: row.saved_at,
    messageCreatedAt: row.message_created_at,
  };
}

// Best-effort, for the notifications payload: the saved section must never
// be the reason the whole drawer 500s.
async function listConversationsForUserSafe(pool, userId, options) {
  try {
    return await listConversationsForUser(pool, userId, options);
  } catch (err) {
    log.warn('message-bookmarks', 'saved conversation list failed', { message: err.message });
    return [];
  }
}

module.exports = {
  MAX_SAVED,
  save,
  remove,
  savedMessageIdsFor,
  listForUser,
  listForUserSafe,
  serialize,
  saveConversationMessage,
  removeConversationMessage,
  savedConversationMessageIdsFor,
  listConversationsForUser,
  listConversationsForUserSafe,
  serializeConversation,
};
