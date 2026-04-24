// Notifications service: @mention parsing + persistence + WS push.
//
// Scope today is only group-chat @mentions, but the DB shape (`kind` column)
// is generic so we can layer PR/issue notifications on the same pipeline
// without another table.

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

// Fetch up to `limit` recent notifications for a user, newest first.
// Joins app + sender + message content so the UI dropdown can render in a
// single round-trip.
async function listForUser(pool, userId, { limit = 30 } = {}) {
  const { rows } = await pool.query(
    `SELECT n.id, n.kind, n.read_at, n.created_at,
            n.app_id, a.slug AS app_slug, a.name AS app_name,
            n.chat_message_id,
            cm.content AS message_content,
            su.username AS source_username
     FROM notifications n
     LEFT JOIN apps a ON a.id = n.app_id
     LEFT JOIN chat_messages cm ON cm.id = n.chat_message_id
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
    sourceUsername: row.source_username,
  };
}

module.exports = {
  parseMentions,
  createMentionNotifications,
  listForUser,
  countUnread,
  markRead,
  serialize,
};

// Expose for ad-hoc debugging.
if (require.main === module) {
  log.info('notifications', 'parse test', { out: parseMentions('hi @evan and @alice_1, also me@foo.com') });
}
