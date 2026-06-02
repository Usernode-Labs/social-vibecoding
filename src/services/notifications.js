// Notifications service: @mention parsing + persistence + WS push.
//
// The DB shape (`kind` column) is generic so different notification types
// share one table + pipeline. Kinds today: 'mention' (group-chat @mention),
// 'kudos' (PR kudos), 'reply' (#15 — someone quoted your message/PR in
// group chat), and 'reaction' (#25 — someone reacted to your message;
// `detail` carries the emoji).

const log = require('./logger');

// Usernames in this app are [A-Za-z0-9_]+, length-restricted on signup.
// Match @token that is NOT preceded by a word character (so emails don't
// trigger mentions) and capture up to 32 chars.
const MENTION_RE = /(^|[^\w])@([A-Za-z0-9_]{1,32})/g;

function parseMentions(text) {
  if (!text || typeof text !== 'string') return [];
  const out = new Set();
  let m;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text)) !== null) {
    out.add(m[2].toLowerCase());
  }
  return [...out];
}

async function resolveUsers(pool, usernames) {
  if (!usernames.length) return [];
  const { rows } = await pool.query(
    `SELECT id, username FROM users WHERE LOWER(username) = ANY($1::text[])`,
    [usernames]
  );
  return rows;
}

// Creates notification rows for every mention in `content` that resolves to
// a real user (excluding the sender). Returns the inserted notification rows
// joined with recipient + app info so callers can push them over WS.
async function createMentionNotifications(pool, { appId, chatMessageId, senderId, content }) {
  const names = parseMentions(content);
  if (!names.length) return [];

  const users = await resolveUsers(pool, names);
  // Self-mentions are allowed (useful for testing and also as a "remind
  // me" pattern). If this becomes noisy we can put it behind a flag.
  const recipients = users;
  if (!recipients.length) return [];

  const values = [];
  const params = [];
  recipients.forEach((u, i) => {
    const base = i * 5;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
    params.push(u.id, appId, chatMessageId, senderId, 'mention');
  });

  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, chat_message_id, source_user_id, kind)
     VALUES ${values.join(', ')}
     RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, created_at`,
    params
  );
  return rows;
}

// #15: reply notification. Fired when a user quotes someone's message or
// PR in group chat. `replyMessageId` is the NEW reply message, so clicking
// the notification lands the recipient on the app's group chat where the
// reply lives. No-op for self-replies or authorless (system) targets.
async function createReplyNotification(pool, { appId, replyMessageId, senderId, recipientId }) {
  if (!recipientId || recipientId === senderId) return [];
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, chat_message_id, source_user_id, kind)
     VALUES ($1, $2, $3, $4, 'reply')
     RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, created_at`,
    [recipientId, appId, replyMessageId, senderId]
  );
  return rows;
}

// #25: reaction notification. Fired when a user adds an emoji reaction to
// someone else's message. `messageId` is the reacted message (so clicking
// lands on the app's group chat); `emoji` rides in the `detail` column.
// No-op for self-reactions or authorless (system) targets.
async function createReactionNotification(pool, { appId, messageId, senderId, recipientId, emoji }) {
  if (!recipientId || recipientId === senderId) return [];
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, chat_message_id, source_user_id, kind, detail)
     VALUES ($1, $2, $3, $4, 'reaction', $5)
     RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, created_at`,
    [recipientId, appId, messageId, senderId, (emoji || '').slice(0, 32)]
  );
  return rows;
}

// Stale-PR warning. Fired by the stale-promoted-PR sweeper when a PR
// proposed to the group has had no voting interest for the configured
// window. Addressed to the PR author (session.user_id) so they can nudge
// the group or merge/withdraw before the grace period elapses and it's
// auto-archived. System-generated, so source_user_id is null; references
// the session so the dropdown can render the PR title + a deep link.
async function createStalePrNotification(pool, { userId, appId, sessionId }) {
  if (!userId) return [];
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, app_id, session_id, source_user_id, kind)
     VALUES ($1, $2, $3, NULL, 'stale_pr')
     RETURNING id, user_id, app_id, session_id, source_user_id, kind, created_at`,
    [userId, appId, sessionId]
  );
  return rows;
}

// Fetch up to `limit` recent notifications for a user, newest first.
// Joins app + sender + message content so the UI dropdown can render in a
// single round-trip.
//
// Kudos notifications reference a chat_session instead of a chat_message,
// so we join both tables and the FE renderer picks the right one based on
// `kind`. Both joins are LEFT so mentions still render fine without a
// session and kudos still render fine without a message.
async function listForUser(pool, userId, { limit = 30 } = {}) {
  const { rows } = await pool.query(
    `SELECT n.id, n.kind, n.read_at, n.created_at,
            n.app_id, a.slug AS app_slug, a.name AS app_name,
            n.chat_message_id,
            cm.content AS message_content,
            n.session_id,
            cs.pr_title, cs.pr_number,
            su.username AS source_username,
            n.detail
     FROM notifications n
     LEFT JOIN apps a ON a.id = n.app_id
     LEFT JOIN chat_messages cm ON cm.id = n.chat_message_id
     LEFT JOIN chat_sessions cs ON cs.id = n.session_id
     LEFT JOIN users su ON su.id = n.source_user_id
     WHERE n.user_id = $1
     ORDER BY n.created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

async function countUnread(pool, userId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
    [userId]
  );
  return rows[0]?.c || 0;
}

async function markRead(pool, userId, { id, all = false } = {}) {
  if (all) {
    await pool.query(
      `UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`,
      [userId]
    );
    return;
  }
  if (!id) return;
  await pool.query(
    `UPDATE notifications SET read_at = NOW() WHERE id = $1 AND user_id = $2 AND read_at IS NULL`,
    [id, userId]
  );
}

// Decorate a raw notification row with the fields the client dropdown wants.
// Keeps the wire format identical whether the notif is fresh (over WS) or
// loaded from history (`GET /api/notifications`).
//
// Kudos extension: sessionId / prTitle / prNumber ride along whenever the
// row carries a session reference. The FE renderer keys off `kind` to
// decide which fields to use — kudos rows ignore chatMessageId /
// messageContent, mention rows ignore sessionId / prTitle.
function serialize(row) {
  return {
    id: row.id,
    kind: row.kind,
    readAt: row.read_at,
    createdAt: row.created_at,
    appSlug: row.app_slug,
    appName: row.app_name,
    chatMessageId: row.chat_message_id,
    messageContent: row.message_content,
    sessionId: row.session_id,
    prTitle: row.pr_title,
    prNumber: row.pr_number,
    sourceUsername: row.source_username,
    detail: row.detail,
  };
}

module.exports = {
  parseMentions,
  createMentionNotifications,
  createReplyNotification,
  createReactionNotification,
  createStalePrNotification,
  listForUser,
  countUnread,
  markRead,
  serialize,
};

// Expose for ad-hoc debugging.
if (require.main === module) {
  log.info('notifications', 'parse test', { out: parseMentions('hi @evan and @alice_1, also me@foo.com') });
}
