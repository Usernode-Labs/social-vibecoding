'use strict';

// A small private group's discussion reaches the rest of the group
// (notification kind 'channel_message').
//
// ── Why ───────────────────────────────────────────────────────────────
//
// A project's channel is its discussion: the app chat's general stream
// (chat_messages with a null thread type), drawn on the project's hub and its
// Discussion tab. Until this, only an @mention, a quote-reply or a reply
// thread rang anybody from it. In a group of two that is a conversation that
// stalls: one person asks the other a question there, the other hears
// nothing unless they happen to open the hub, and the answer comes back the
// same way. In a small group the discussion IS the group chat, and people
// expect a message there to reach the others the way a group chat does.
//
// Nothing here writes into the channel (AGENTS.md: a channel is what people
// said). It tells the group's people that a PERSON said something.
//
// ── Who it is for ──────────────────────────────────────────────────────
//
// A PRIVATE project (not view-public, so the Group audience; never the
// platform's own, whose old channel is read-only) whose people number
// MAX_GROUP_PEOPLE or fewer. "People" are the community's members who can
// read the discussion: real accounts (never the Homeroom bot) that are
// collaborators of the private app and have not blocked it. A pending invite
// is not counted: they cannot read it yet.
//
// Eight, and counted as everybody who can read rather than who was active
// lately:
//   * up to about eight, everybody in the room knows everybody: a household,
//     a team, a few friends. That is the size at which group chats ring every
//     member by default and nobody calls it noise;
//   * past it, a discussion behaves more like a community forum, where
//     mentions (which already ring) are the right signal and every message
//     would be a firehose;
//   * the cost is bounded: one message reaches at most seven people, and each
//     of them holds ONE row per discussion (below), not one per message;
//   * the quiet member is exactly who this is for (the person who never
//     opened the hub), so an activity rule would leave them out; and an
//     activity count would turn the rule on and off as people come and go
//     during a week, where membership changes only when somebody joins or
//     leaves.
// Larger groups and public communities keep the behaviour they had.
//
// ── What rings it, and what does not ───────────────────────────────────
//
// Only a person typing in the main stream: an ordinary message, by a real
// account, not posted through a connector (posted_via 'agent', which the
// Homeroom bot's chat reading and the invite "said hi" also leave alone). A
// system line, the bot's own messages (thread posts through
// ws.sendBotMessage, never this path) and its private "Only you can see
// this" cards (chat_bot_requests, pushed to the requester's sockets and never
// written to chat_messages) cannot reach it. A reply thread or a request's or
// proposal's discussion is not the channel either.
//
// Never the author, and never twice for one message: whoever this message
// already reached with a more specific row (an @mention, a quote-reply, the
// invite maker's "said hi") is passed in `excludeUserIds` and skipped.
// Nobody blocked either way, nobody who has already read past it (they are
// looking at the discussion), and nobody who switched the project's
// "Every message in the discussion" off (notification-preferences.js
// `channel_messages`, per project, then account-wide, then on by default).
//
// ── One row per discussion, one ring per stretch ───────────────────────
//
// The first message somebody has not seen inserts a row, and that INSERT is
// what rings the phone (schema.sql enqueue_mobile_push_deliveries is AFTER
// INSERT, under the Messages push category, so mobile-push-preferences,
// app blocks and the per-device rules all apply). Every later message while
// that row is unread and its newest message unread folds into it: the count
// in `detail` goes up, the newest author and message replace the old ones,
// and the row moves to the top of the bell. It does not ring again. Reading
// the discussion (the read cursor, or posting in it) marks the row read, so
// the next message after that is news again and rings.

const log = require('./logger');
const notifications = require('./notifications');
const notificationPreferences = require('./notification-preferences');

const KIND = 'channel_message';
const CATEGORY = 'channel_messages';
const MAX_GROUP_PEOPLE = 8;
// `detail` carries the folded count as digits; a count past this stays put.
const MAX_COUNT = 999999;

// The project and its people, in one read. `people` is every member who can
// read the discussion (see the header), lowest id first. Every message in
// every project's discussion asks this, so it stays cheap where the answer is
// no: a public project reads no members at all, and a private one reads at
// most one past the bound ($2), which is enough to know it is too big.
const GROUP_SQL = `
  SELECT a.view_visibility, a.self_hosted, a.moderation_suspended_at,
         CASE WHEN a.view_visibility <> 'public' AND a.self_hosted IS NOT TRUE THEN ARRAY(
           SELECT m.user_id
             FROM community_members m
             JOIN users u ON u.id = m.user_id AND u.is_synthetic = FALSE
             JOIN app_collaborators ac
               ON ac.app_id = a.id AND ac.user_id = m.user_id AND ac.status = 'member'
            WHERE m.community_id = a.community_id
              AND NOT EXISTS (SELECT 1 FROM user_app_blocks b
                               WHERE b.app_id = a.id AND b.user_id = m.user_id)
            ORDER BY m.user_id
            LIMIT $2
         ) ELSE '{}'::int[] END AS people
    FROM apps a
   WHERE a.id = $1`;

/**
 * Pure: whether a project (a GROUP_SQL row) is a small private group, the
 * only kind of project whose discussion rings every member.
 */
function isSmallPrivateGroup(group) {
  if (!group) return false;
  if (group.view_visibility === 'public') return false;
  if (group.self_hosted || group.moderation_suspended_at) return false;
  const people = Array.isArray(group.people) ? group.people.length : 0;
  return people >= 2 && people <= MAX_GROUP_PEOPLE;
}

async function readGroup(db, appId) {
  const { rows } = await db.query(GROUP_SQL, [appId, MAX_GROUP_PEOPLE + 1]);
  return rows[0] || null;
}

/**
 * Whether `appId` is a small private group right now. The per-project
 * notification dialog offers "Every message in the discussion" only then.
 * False on any error: a switch that is not shown is the safe failure.
 */
async function isSmallGroup(db, appId) {
  if (!appId) return false;
  try {
    return isSmallPrivateGroup(await readGroup(db, appId));
  } catch (err) {
    log.warn('group-channel-notify', 'Could not read whether a project is a small group', { appId, err: err.message });
    return false;
  }
}

// The message, if it is one a person typed in the main stream.
const MESSAGE_SQL = `
  SELECT m.id
    FROM chat_messages m
    JOIN users u ON u.id = m.user_id
   WHERE m.id = $1 AND m.app_id = $2 AND m.user_id = $3
     AND m.thread_type IS NULL
     AND m.msg_type = 'message'
     AND m.deleted_at IS NULL
     AND m.moderation_hidden_at IS NULL
     AND m.posted_via IS NULL
     AND u.is_synthetic = FALSE`;

/**
 * Tell one person about `messageId`: fold it into their unread row for this
 * discussion, or start a new row (which rings). Resolves
 * { row, fresh, retired } or null when they are not told (blocked either
 * way, or already read past it). `retired` counts an unread row the reader
 * had in fact already read past, marked read as the new one starts.
 */
async function ring(pool, { userId, appId, messageId, senderId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Two messages at once must not both start a row for the same person.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`channel-message:${userId}:${appId}`]);
    const { rows: [state] } = await client.query(
      `SELECT COALESCE((SELECT r.last_read_message_id FROM app_chat_reads r
                         WHERE r.app_id = $2 AND r.user_id = $1), 0) AS read_to,
              EXISTS (SELECT 1 FROM user_blocks b
                       WHERE (b.blocker_id = $1 AND b.blocked_user_id = $3)
                          OR (b.blocker_id = $3 AND b.blocked_user_id = $1)) AS blocked`,
      [userId, appId, senderId],
    );
    const readTo = Number(state?.read_to) || 0;
    if (!state || state.blocked || readTo >= Number(messageId)) {
      await client.query('COMMIT');
      return null;
    }
    // Fold: their unread row whose newest message they have not read yet.
    // GREATEST keeps the newest message (and its author) when two sends are
    // handled out of order.
    const { rows: folded } = await client.query(
      `UPDATE notifications n
          SET detail = LEAST(CASE WHEN n.detail ~ '^[0-9]{1,6}$' THEN n.detail::int ELSE 1 END + 1, $6::int)::text,
              source_user_id = CASE WHEN $4::int > n.chat_message_id THEN $3::int ELSE n.source_user_id END,
              chat_message_id = GREATEST(n.chat_message_id, $4::int),
              created_at = GREATEST(n.created_at, NOW())
        WHERE n.id = (SELECT id FROM notifications
                       WHERE user_id = $1 AND app_id = $2 AND kind = 'channel_message'
                         AND read_at IS NULL AND chat_message_id > $5::int
                       ORDER BY id DESC
                       LIMIT 1)
        RETURNING n.id, n.user_id, n.app_id, n.chat_message_id, n.source_user_id, n.kind, n.detail, n.created_at`,
      [userId, appId, senderId, messageId, readTo, MAX_COUNT],
    );
    if (folded[0]) {
      await client.query('COMMIT');
      return { row: folded[0], fresh: false, retired: 0 };
    }
    // A row they have read past is done with: one unread row per discussion.
    const { rowCount: retired } = await client.query(
      `UPDATE notifications SET read_at = NOW()
        WHERE user_id = $1 AND app_id = $2 AND kind = 'channel_message' AND read_at IS NULL`,
      [userId, appId],
    );
    const { rows: inserted } = await client.query(
      `INSERT INTO notifications (user_id, app_id, chat_message_id, source_user_id, kind)
       VALUES ($1, $2, $3, $4, 'channel_message')
       RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, detail, created_at`,
      [userId, appId, messageId, senderId],
    );
    await client.query('COMMIT');
    return { row: inserted[0], fresh: true, retired: retired || 0 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * `senderId` wrote `messageId` in `appId`'s discussion. When the project is a
 * small private group, the rest of its people hear about it (see the
 * header). Resolves the rows written or folded, each with `fresh` (it rang);
 * an empty list when nobody is told. Throws only on a database error, which
 * the caller (ws.js, after the room already has the message) logs.
 */
async function notifyChannelMessage(pool, { appId, messageId, senderId, excludeUserIds = [] }) {
  if (!appId || !messageId || !senderId) return [];
  const { rows: message } = await pool.query(MESSAGE_SQL, [messageId, appId, senderId]);
  if (!message.length) return [];
  const group = await readGroup(pool, appId);
  if (!isSmallPrivateGroup(group)) return [];

  const skip = new Set([senderId, ...excludeUserIds].map(Number));
  let ids = group.people.map(Number).filter((id) => Number.isInteger(id) && !skip.has(id));
  if (!ids.length) return [];
  ids = await notificationPreferences.filterUsersByCategory(pool, { userIds: ids, appId, categoryKey: CATEGORY });
  if (!ids.length) return [];

  const out = [];
  for (const userId of ids) {
    const told = await ring(pool, { userId, appId, messageId, senderId });
    if (!told) continue;
    out.push({ ...told.row, fresh: told.fresh });
    await notifications.hydrateAndPush(pool, told.row);
    if (told.retired > 0) {
      // The reader's own bell still shows the row just marked read.
      try {
        require('./ws').pushNotificationToUser(userId, { type: 'notifications_changed' });
      } catch (err) {
        log.warn('group-channel-notify', 'Could not re-sync a bell', { userId, err: err.message });
      }
    }
  }
  return out;
}

/**
 * `userId` has read `appId`'s discussion up to `upToMessageId` (the read
 * cursor moved, or they posted there): their discussion rows about messages
 * up to it are read. Resolves how many were marked.
 */
async function markChannelRead(db, userId, appId, upToMessageId) {
  const upTo = Number(upToMessageId);
  if (!userId || !appId || !Number.isSafeInteger(upTo) || upTo <= 0) return 0;
  const { rowCount } = await db.query(
    `UPDATE notifications SET read_at = NOW()
      WHERE user_id = $1 AND app_id = $2 AND kind = 'channel_message'
        AND read_at IS NULL AND chat_message_id <= $3`,
    [userId, appId, upTo],
  );
  return rowCount || 0;
}

module.exports = {
  KIND,
  CATEGORY,
  MAX_GROUP_PEOPLE,
  isSmallPrivateGroup,
  isSmallGroup,
  notifyChannelMessage,
  markChannelRead,
  ring,
};
