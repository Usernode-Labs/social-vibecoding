'use strict';

const sharedObjects = require('./shared-objects');
const messageBookmarks = require('./message-bookmarks');

const MAX_ID = 2147483647;
const MAX_MESSAGE_LENGTH = 8000;
const MAX_GROUP_MEMBERS = 100;
const MAX_OBJECTS = 6;
const GENERIC_NOT_FOUND = 'Conversation not found';

function strictId(value) {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n <= MAX_ID ? n : null;
}

function strictIds(value, { max = MAX_GROUP_MEMBERS } = {}) {
  if (!Array.isArray(value) || value.length > max) return null;
  const ids = [];
  for (const item of value) {
    const id = strictId(item);
    if (!id) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function normalizeTitle(raw) {
  if (typeof raw !== 'string') return null;
  const title = raw.trim().replace(/\s+/g, ' ');
  return title && title.length <= 80 ? title : null;
}

function normalizeContent(raw, { allowEmpty = false } = {}) {
  if (typeof raw !== 'string') return null;
  const content = raw.trim();
  if ((!content && !allowEmpty) || content.length > MAX_MESSAGE_LENGTH) return null;
  return content;
}

function normalizeIdempotencyKey(raw) {
  if (raw == null) return null;
  return typeof raw === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/.test(raw)
    ? raw
    : null;
}

function normalizeEmoji(raw) {
  if (typeof raw !== 'string') return null;
  const emoji = raw.trim();
  return emoji && emoji.length <= 16 && !/[\s\u0000-\u001f]/u.test(emoji) ? emoji : null;
}

function normalizeAttachmentIds(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > 4) return null;
  const ids = [];
  for (const value of raw) {
    if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) return null;
    if (!ids.includes(value)) ids.push(value);
  }
  return ids;
}

async function transaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

function normalizePair(a, b) {
  return a < b ? [a, b] : [b, a];
}

async function lockPair(client, a, b) {
  const [low, high] = normalizePair(a, b);
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`conversation-direct:${low}:${high}`]
  );
  return [low, high];
}

async function lockPairsFor(client, actorId, otherIds) {
  const pairs = [...new Set(otherIds || [])]
    .filter((id) => id && id !== actorId)
    .map((id) => normalizePair(actorId, id))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [low, high] of pairs) await lockPair(client, low, high);
}

async function blockedEitherWay(db, a, b) {
  if (!a || !b || a === b) return true;
  const { rows } = await db.query(
    `SELECT 1 FROM user_blocks
      WHERE (blocker_id = $1 AND blocked_user_id = $2)
         OR (blocker_id = $2 AND blocked_user_id = $1)
      LIMIT 1`,
    [a, b]
  );
  return rows.length > 0;
}

async function loadMembership(db, conversationId, userId, { forUpdate = false, allowInvited = false } = {}) {
  const { rows } = await db.query(
    `SELECT c.id, c.kind, c.title, c.status AS conversation_status,
            c.created_by, c.created_at, c.updated_at,
            cm.role, cm.status AS membership_status, cm.invited_by,
            cm.joined_at, cm.last_read_message_id
       FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id
      WHERE c.id = $1 AND cm.user_id = $2
        AND c.status = 'active'
        AND cm.status ${allowInvited ? "IN ('member', 'invited')" : "= 'member'"}
      ${forUpdate ? 'FOR UPDATE OF c, cm' : ''}`,
    [conversationId, userId]
  );
  return rows[0] || null;
}

async function loadDirectPeer(db, conversationId, userId, { forShare = false } = {}) {
  const { rows } = await db.query(
    `SELECT CASE WHEN user_low_id = $2 THEN user_high_id ELSE user_low_id END AS other_id
       FROM conversation_direct_pairs
      WHERE conversation_id = $1
        AND (user_low_id = $2 OR user_high_id = $2)
      ${forShare ? 'FOR SHARE' : ''}`,
    [conversationId, userId]
  );
  return rows[0]?.other_id || null;
}

async function canDirectInteract(db, membership, userId) {
  if (membership.kind !== 'direct') return true;
  const otherId = await loadDirectPeer(db, membership.id, userId, { forShare: true });
  return !!otherId && !(await blockedEitherWay(db, userId, otherId));
}

// Canonical ordering for every direct-conversation write:
// read-only preflight -> normalized pair advisory lock -> row locks -> block
// recheck. `setBlock` starts with the same advisory lock, so neither side can
// commit behind the other's consent check and no transaction inverts locks.
async function lockInteractionMembership(db, conversationId, userId, { allowInvited = false } = {}) {
  const preflight = await loadMembership(db, conversationId, userId, { allowInvited });
  if (!preflight) return null;
  const directPeer = preflight.kind === 'direct'
    ? await loadDirectPeer(db, conversationId, userId)
    : null;
  if (preflight.kind === 'direct') {
    if (!directPeer) return null;
    await lockPair(db, userId, directPeer);
  }
  const membership = await loadMembership(
    db, conversationId, userId, { forUpdate: true, allowInvited }
  );
  if (!membership) return null;
  if (membership.kind === 'direct') {
    const currentPeer = await loadDirectPeer(db, conversationId, userId);
    if (!currentPeer || currentPeer !== directPeer
        || await blockedEitherWay(db, userId, currentPeer)) return null;
  }
  return membership;
}

// Execute an ephemeral fanout while the same normalized direct-pair lock used
// by block mutations is held. The mutation that prompted the event has
// already committed; this second short transaction suppresses the event if a
// block won the race, or makes a concurrent block wait until the send is
// complete. Group conversations deliberately ignore pairwise blocks.
async function withLockedAudience(pool, user, conversationId, callback) {
  return transaction(pool, async (db) => {
    const membership = await lockInteractionMembership(db, conversationId, user.id);
    if (!membership) return null;
    const memberIds = await activeMemberIds(db, conversationId);
    await callback(memberIds, membership);
    return memberIds;
  });
}

async function activeMemberIds(db, conversationId) {
  const { rows } = await db.query(
    `SELECT user_id FROM conversation_members
      WHERE conversation_id = $1 AND status = 'member'
      ORDER BY user_id`,
    [conversationId]
  );
  return rows.map((row) => row.user_id);
}

async function loadMembers(db, conversationId) {
  const { rows } = await db.query(
    `SELECT cm.user_id AS id, u.username, ua.id AS avatar_id,
            cm.role, cm.status, cm.joined_at, cm.invited_by
       FROM conversation_members cm
       JOIN users u ON u.id = cm.user_id
       LEFT JOIN user_avatars ua ON ua.user_id = u.id
      WHERE cm.conversation_id = $1
      ORDER BY (cm.role = 'owner') DESC, cm.created_at, cm.user_id`,
    [conversationId]
  );
  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    avatarUrl: row.avatar_id ? `/avatars/${row.avatar_id}` : null,
    role: row.role,
    status: row.status,
    joinedAt: row.joined_at,
    invitedBy: row.invited_by,
  }));
}

function reactionGroups(rows, viewerId) {
  const map = new Map();
  for (const row of rows || []) {
    if (!map.has(row.message_id)) map.set(row.message_id, new Map());
    const byEmoji = map.get(row.message_id);
    if (!byEmoji.has(row.emoji)) {
      byEmoji.set(row.emoji, { emoji: row.emoji, count: 0, reacted: false, users: [] });
    }
    const item = byEmoji.get(row.emoji);
    item.count += 1;
    item.reacted ||= row.user_id === viewerId;
    if (row.username) item.users.push(row.username);
  }
  return new Map([...map].map(([id, byEmoji]) => [id, [...byEmoji.values()]]));
}

function attachmentGroups(rows, conversationId) {
  const map = new Map();
  for (const row of rows || []) {
    if (!map.has(row.message_id)) map.set(row.message_id, []);
    const base = `/api/conversations/${conversationId}/attachments/${row.id}`;
    map.get(row.message_id).push({
      id: row.id,
      name: row.filename,
      size: row.size_bytes,
      contentType: row.content_type,
      kind: row.kind,
      meta: row.meta || null,
      url: base,
      viewUrl: row.kind === 'html' ? `${base}/view` : null,
    });
  }
  return map;
}

async function hydrateMessages(db, user, rows) {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const [reactionResult, attachmentResult, objects, savedIds] = await Promise.all([
    db.query(
      `SELECT r.message_id, r.user_id, r.emoji, u.username
         FROM conversation_message_reactions r
         LEFT JOIN users u ON u.id = r.user_id
        WHERE r.message_id = ANY($1::int[])
        ORDER BY r.message_id, r.created_at, r.id`,
      [ids]
    ),
    db.query(
      `SELECT id, message_id, kind, filename, content_type, size_bytes, meta
         FROM conversation_message_attachments
        WHERE message_id = ANY($1::int[])
        ORDER BY created_at, id`,
      [ids]
    ),
    sharedObjects.hydrateForMessages(db, user, ids),
    // Which of these the viewer has saved, so the row's bookmark renders
    // already filled rather than flashing empty and correcting itself. It
    // rides this Promise.all for the same reason the other three do — one
    // round of latency for the whole page — and returns an empty Set for an
    // anonymous viewer, so no branch is needed below.
    messageBookmarks.savedConversationMessageIdsFor(db, user && user.id, ids),
  ]);
  const reactions = reactionGroups(reactionResult.rows, user.id);
  const attachments = attachmentGroups(attachmentResult.rows, rows[0].conversation_id);
  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    sender: {
      id: row.sender_id || 0,
      username: row.sender_username || 'deleted user',
      avatarUrl: row.sender_avatar_id ? `/avatars/${row.sender_avatar_id}` : null,
    },
    content: row.content,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    reply: row.reply_id ? {
      id: row.reply_id,
      sender: {
        id: row.reply_sender_id || 0,
        username: row.reply_sender_username || 'deleted user',
        avatarUrl: row.reply_sender_avatar_id ? `/avatars/${row.reply_sender_avatar_id}` : null,
      },
      content: row.reply_content || '',
    } : null,
    reactions: reactions.get(row.id) || [],
    attachments: attachments.get(row.id) || [],
    objects: objects.get(row.id) || [],
    saved: savedIds.has(row.id),
  }));
}

const MESSAGE_SELECT = `
  SELECT m.id, m.conversation_id, m.sender_id, m.content, m.created_at, m.edited_at,
         su.username AS sender_username, sua.id AS sender_avatar_id,
         rm.id AS reply_id, rm.sender_id AS reply_sender_id, rm.content AS reply_content,
         ru.username AS reply_sender_username, rua.id AS reply_sender_avatar_id
    FROM conversation_messages m
    LEFT JOIN users su ON su.id = m.sender_id
    LEFT JOIN user_avatars sua ON sua.user_id = su.id
    LEFT JOIN conversation_messages rm ON rm.id = m.reply_to_id
    LEFT JOIN users ru ON ru.id = rm.sender_id
    LEFT JOIN user_avatars rua ON rua.user_id = ru.id`;

async function getMessage(db, user, conversationId, messageId) {
  const { rows } = await db.query(
    `${MESSAGE_SELECT} WHERE m.id = $1 AND m.conversation_id = $2`,
    [messageId, conversationId]
  );
  const hydrated = await hydrateMessages(db, user, rows);
  return hydrated[0] || null;
}

async function listMessages(pool, user, conversationId, { before = null, limit = 50 } = {}) {
  const membership = await loadMembership(pool, conversationId, user.id);
  if (!membership || !(await canDirectInteract(pool, membership, user.id))) return null;
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const params = [conversationId];
  let beforeSql = '';
  if (before) {
    params.push(before);
    beforeSql = `AND m.id < $${params.length}`;
  }
  params.push(safeLimit + 1);
  const { rows } = await pool.query(
    `${MESSAGE_SELECT}
      WHERE m.conversation_id = $1 ${beforeSql}
      ORDER BY m.id DESC LIMIT $${params.length}`,
    params
  );
  const hasMore = rows.length > safeLimit;
  const page = rows.slice(0, safeLimit).reverse();
  const messages = await hydrateMessages(pool, user, page);
  return {
    messages,
    nextBefore: hasMore && page.length ? page[0].id : null,
  };
}

async function conversationRow(db, user, conversationId) {
  const { rows } = await db.query(
    `SELECT c.id, c.kind, c.title, c.status, c.created_by, c.created_at, c.updated_at,
            me.role AS my_role, me.status AS membership_status, me.invited_by,
            me.last_read_message_id,
            inviter.username AS requester_username,
            inviter_avatar.id AS requester_avatar_id,
            peer.user_id AS peer_id, peer_user.username AS peer_username,
            peer_avatar.id AS peer_avatar_id,
            latest.id AS latest_message_id
       FROM conversations c
       JOIN conversation_members me ON me.conversation_id = c.id AND me.user_id = $2
       LEFT JOIN users inviter ON inviter.id = me.invited_by
       LEFT JOIN user_avatars inviter_avatar ON inviter_avatar.user_id = inviter.id
       LEFT JOIN LATERAL (
         SELECT other.user_id FROM conversation_members other
          WHERE other.conversation_id = c.id AND other.user_id <> $2
          ORDER BY other.created_at LIMIT 1
       ) peer ON c.kind = 'direct'
       LEFT JOIN users peer_user ON peer_user.id = peer.user_id
       LEFT JOIN user_avatars peer_avatar ON peer_avatar.user_id = peer.user_id
       LEFT JOIN LATERAL (
         SELECT id FROM conversation_messages m
          WHERE m.conversation_id = c.id ORDER BY id DESC LIMIT 1
       ) latest ON TRUE
      WHERE c.id = $1 AND c.status = 'active'
        AND me.status IN ('member', 'invited')`,
    [conversationId, user.id]
  );
  return rows[0] || null;
}

// #1343: mirror of conversationMessageSummarySql (src/services/notifications.js)
// for already-hydrated message rows. A message that carries only a shared
// object card or only attachments has empty content; without a fallback the
// conversation list row reads as "No messages yet" for a thread whose latest
// message is a shared spec. Keys on the card's public type; keep the labels
// in sync with the SQL fragment.
const OBJECT_SUMMARY_LABELS = Object.freeze({
  spec: 'Shared a spec version',
  app: 'Shared an app',
  issue: 'Shared an issue',
  proposal: 'Shared a code proposal',
  governance: 'Shared a governance proposal',
});

function messageSummary(message) {
  if (!message) return '';
  if (message.content) return message.content;
  const objectType = Array.isArray(message.objects) && message.objects[0]
    ? message.objects[0].type
    : null;
  if (objectType && OBJECT_SUMMARY_LABELS[objectType]) return OBJECT_SUMMARY_LABELS[objectType];
  if (Array.isArray(message.attachments) && message.attachments.length) return 'Shared an attachment';
  return '';
}

async function serializeConversation(db, user, row, { includeMembers = true } = {}) {
  const accepted = row.membership_status === 'member';
  const members = accepted && includeMembers ? await loadMembers(db, row.id) : [];
  const latest = accepted && row.latest_message_id
    ? await getMessage(db, user, row.id, row.latest_message_id)
    : null;
  let unread = 0;
  if (row.membership_status === 'member') {
    const result = await db.query(
      `SELECT COUNT(*)::int AS count FROM conversation_messages
        WHERE conversation_id = $1 AND id > COALESCE($2, 0) AND sender_id IS DISTINCT FROM $3`,
      [row.id, row.last_read_message_id, user.id]
    );
    unread = result.rows[0]?.count || 0;
  }
  // An invitation is a consent envelope, not conversation access. The
  // requester identity is shown so the recipient can decide; roster, peer,
  // retained messages/cards/attachments, and unread state stay hidden until
  // acceptance.
  const peer = accepted && row.peer_id ? {
    id: row.peer_id,
    username: row.peer_username,
    avatarUrl: row.peer_avatar_id ? `/avatars/${row.peer_avatar_id}` : null,
  } : null;
  const requester = row.invited_by ? {
    id: row.invited_by,
    username: row.requester_username,
    avatarUrl: row.requester_avatar_id ? `/avatars/${row.requester_avatar_id}` : null,
  } : null;
  const title = row.kind === 'direct' ? (peer?.username || 'Direct message') : row.title;
  return {
    id: row.id,
    kind: row.kind,
    title,
    status: row.status,
    archived: row.status === 'archived',
    members,
    memberCount: accepted ? members.filter((member) => member.status === 'member').length : 0,
    membershipStatus: row.membership_status,
    myRole: row.my_role,
    requester,
    peer,
    latestMessage: latest,
    latestSummary: accepted ? messageSummary(latest) : '',
    lastActivityAt: latest?.createdAt || row.updated_at || row.created_at,
    unreadCount: unread,
    canSend: row.membership_status === 'member' && row.status === 'active',
    canInvite: row.kind === 'group' && row.membership_status === 'member' && row.status === 'active',
    canManage: row.kind === 'group' && row.my_role === 'owner' && row.membership_status === 'member',
  };
}

async function getConversation(pool, user, conversationId) {
  const row = await conversationRow(pool, user, conversationId);
  if (!row || !(await canDirectInteract(pool, row, user.id))) return null;
  return serializeConversation(pool, user, row);
}

async function listConversations(pool, user) {
  const { rows } = await pool.query(
    `SELECT c.id FROM conversations c
      JOIN conversation_members me ON me.conversation_id = c.id
      WHERE me.user_id = $1 AND c.status = 'active'
        AND me.status IN ('member', 'invited')
      ORDER BY c.updated_at DESC, c.id DESC
      LIMIT 200`,
    [user.id]
  );
  const out = [];
  for (const row of rows) {
    const conversation = await getConversation(pool, user, row.id);
    if (conversation) out.push(conversation);
  }
  return out;
}

async function insertNotification(db, { userId, conversationId, messageId = null, sourceUserId, kind, detail = null }) {
  const { rows } = await db.query(
    `INSERT INTO notifications
       (user_id, conversation_id, conversation_message_id, source_user_id, kind, detail)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_id, conversation_id, conversation_message_id,
               source_user_id, kind, detail, created_at`,
    [userId, conversationId, messageId, sourceUserId || null, kind, detail]
  );
  return rows[0];
}

async function createDirect(pool, user, targetUserId) {
  if (!targetUserId || targetUserId === user.id) return null;
  const result = await transaction(pool, async (db) => {
    const [low, high] = await lockPair(db, user.id, targetUserId);
    const target = await db.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [targetUserId]);
    if (!target.rows.length || await blockedEitherWay(db, user.id, targetUserId)) return null;
    const existing = await db.query(
      `SELECT c.id, c.status, c.created_by,
              mine.status AS my_status, theirs.status AS their_status
         FROM conversation_direct_pairs p
         JOIN conversations c ON c.id = p.conversation_id
         JOIN conversation_members mine
           ON mine.conversation_id = c.id AND mine.user_id = $3
         JOIN conversation_members theirs
           ON theirs.conversation_id = c.id AND theirs.user_id = $4
        WHERE p.user_low_id = $1 AND p.user_high_id = $2
        FOR UPDATE OF c, mine, theirs`,
      [low, high, user.id, targetUserId]
    );
    if (existing.rows.length) {
      const row = existing.rows[0];
      // A reciprocal request is affirmative consent: accept the pending
      // invitation atomically instead of creating a second pair. Following a
      // decline, only the former recipient may reverse their decision; the
      // original requester cannot use retries to harass them.
      const reciprocalPending = row.my_status === 'invited' && row.their_status === 'member';
      const recipientReopens = row.created_by !== user.id
        && ['declined', 'left', 'removed'].includes(row.my_status)
        && row.their_status === 'member';
      if (reciprocalPending || recipientReopens) {
        await db.query(
          `UPDATE conversation_members
              SET status = 'member', responded_at = NOW(), joined_at = COALESCE(joined_at, NOW()),
                  left_at = NULL
            WHERE conversation_id = $1 AND user_id = $2`,
          [row.id, user.id]
        );
        await db.query(
          `UPDATE conversations SET status = 'active', updated_at = NOW() WHERE id = $1`,
          [row.id]
        );
        await db.query(
          `UPDATE notifications SET read_at = NOW()
            WHERE conversation_id = $1 AND user_id = $2
              AND kind = 'conversation_invite' AND read_at IS NULL`,
          [row.id, user.id]
        );
        return { conversationId: row.id, notifications: [], memberIds: [user.id, targetUserId] };
      }
      if (row.status === 'active' && row.my_status === 'member') {
        return { conversationId: row.id, notifications: [], memberIds: [user.id, targetUserId] };
      }
      return null;
    }
    const created = await db.query(
      `INSERT INTO conversations (kind, created_by) VALUES ('direct', $1) RETURNING id`,
      [user.id]
    );
    const conversationId = created.rows[0].id;
    await db.query(
      `INSERT INTO conversation_direct_pairs (conversation_id, user_low_id, user_high_id)
       VALUES ($1, $2, $3)`, [conversationId, low, high]
    );
    await db.query(
      `INSERT INTO conversation_members
         (conversation_id, user_id, role, status, invited_by, responded_at, joined_at)
       VALUES ($1, $2, 'member', 'member', $2, NOW(), NOW()),
              ($1, $3, 'member', 'invited', $2, NULL, NULL)`,
      [conversationId, user.id, targetUserId]
    );
    const notification = await insertNotification(db, {
      userId: targetUserId, conversationId, sourceUserId: user.id, kind: 'conversation_invite',
    });
    return { conversationId, notifications: [notification], memberIds: [user.id, targetUserId] };
  });
  if (!result) return null;
  return { ...result, conversation: await getConversation(pool, user, result.conversationId) };
}

async function ensureEligibleInvitees(db, inviterId, ids) {
  if (!ids.length) return true;
  const users = await db.query('SELECT id FROM users WHERE id = ANY($1::int[]) FOR SHARE', [ids]);
  if (users.rows.length !== ids.length) return false;
  for (const id of ids) {
    if (await blockedEitherWay(db, inviterId, id)) return false;
  }
  return true;
}

async function createGroup(pool, user, title, memberIds) {
  const safeTitle = normalizeTitle(title);
  const ids = strictIds(memberIds);
  if (!safeTitle || !ids) return null;
  const invitees = ids.filter((id) => id !== user.id);
  if (invitees.length + 1 > MAX_GROUP_MEMBERS) return null;
  const result = await transaction(pool, async (db) => {
    // Pair advisory locks always precede user/conversation row locks. The
    // block mutation takes the same normalized locks, making consent checks
    // stable through commit without a row-lock/advisory-lock inversion.
    await lockPairsFor(db, user.id, invitees);
    if (!(await ensureEligibleInvitees(db, user.id, invitees))) return null;
    const created = await db.query(
      `INSERT INTO conversations (kind, title, created_by)
       VALUES ('group', $1, $2) RETURNING id`,
      [safeTitle, user.id]
    );
    const conversationId = created.rows[0].id;
    await db.query(
      `INSERT INTO conversation_members
         (conversation_id, user_id, role, status, invited_by, responded_at, joined_at)
       VALUES ($1, $2, 'owner', 'member', $2, NOW(), NOW())`,
      [conversationId, user.id]
    );
    const notifications = [];
    for (const inviteeId of invitees) {
      await db.query(
        `INSERT INTO conversation_members
           (conversation_id, user_id, role, status, invited_by)
         VALUES ($1, $2, 'member', 'invited', $3)`,
        [conversationId, inviteeId, user.id]
      );
      notifications.push(await insertNotification(db, {
        userId: inviteeId, conversationId, sourceUserId: user.id, kind: 'conversation_invite',
      }));
    }
    return { conversationId, notifications, memberIds: [user.id, ...invitees] };
  });
  if (!result) return null;
  return { ...result, conversation: await getConversation(pool, user, result.conversationId) };
}

async function updateTitle(pool, user, conversationId, title) {
  const safeTitle = normalizeTitle(title);
  if (!safeTitle) return null;
  const result = await pool.query(
    `UPDATE conversations c SET title = $1, updated_at = NOW()
      FROM conversation_members cm
     WHERE c.id = $2 AND c.kind = 'group' AND c.status = 'active'
       AND cm.conversation_id = c.id AND cm.user_id = $3
       AND cm.status = 'member' AND cm.role = 'owner'
     RETURNING c.id`,
    [safeTitle, conversationId, user.id]
  );
  return result.rows.length ? getConversation(pool, user, conversationId) : null;
}

async function respond(pool, user, conversationId, action) {
  if (!['accept', 'decline'].includes(action)) return null;
  const result = await transaction(pool, async (db) => {
    const preflight = await loadMembership(db, conversationId, user.id, { allowInvited: true });
    if (!preflight || preflight.membership_status !== 'invited') return null;
    const directPeer = preflight.kind === 'direct'
      ? await loadDirectPeer(db, conversationId, user.id)
      : null;
    await lockPairsFor(db, user.id, [preflight.invited_by, directPeer].filter(Boolean));
    const membership = await loadMembership(db, conversationId, user.id, { forUpdate: true, allowInvited: true });
    if (!membership || membership.membership_status !== 'invited') return null;
    if (action === 'accept' && membership.invited_by) {
      if (await blockedEitherWay(db, user.id, membership.invited_by)) return null;
    }
    if (membership.kind === 'direct' && action === 'accept') {
      const pair = await db.query(
        `SELECT user_low_id, user_high_id FROM conversation_direct_pairs
          WHERE conversation_id = $1`, [conversationId]
      );
      const otherId = pair.rows[0]?.user_low_id === user.id
        ? pair.rows[0]?.user_high_id : pair.rows[0]?.user_low_id;
      if (!otherId || otherId !== directPeer || await blockedEitherWay(db, user.id, otherId)) return null;
    }
    const status = action === 'accept' ? 'member' : 'declined';
    await db.query(
      `UPDATE conversation_members
          SET status = $1::varchar, responded_at = NOW(),
              joined_at = CASE WHEN $1::varchar = 'member' THEN NOW() ELSE joined_at END
        WHERE conversation_id = $2 AND user_id = $3`,
      [status, conversationId, user.id]
    );
    await db.query(
      `UPDATE notifications SET read_at = NOW()
        WHERE conversation_id = $1 AND user_id = $2
          AND kind = 'conversation_invite' AND read_at IS NULL`,
      [conversationId, user.id]
    );
    const ids = await activeMemberIds(db, conversationId);
    if (action === 'decline' && membership.kind === 'direct') {
      await db.query(`UPDATE conversations SET status = 'archived', updated_at = NOW() WHERE id = $1`, [conversationId]);
    } else {
      await db.query(`UPDATE conversations SET updated_at = NOW() WHERE id = $1`, [conversationId]);
    }
    return { memberIds: ids };
  });
  if (!result) return null;
  return {
    ...result,
    conversation: action === 'accept' ? await getConversation(pool, user, conversationId) : null,
  };
}

async function addMembers(pool, user, conversationId, rawIds) {
  const ids = strictIds(rawIds);
  if (!ids?.length) return null;
  const result = await transaction(pool, async (db) => {
    const preflight = await loadMembership(db, conversationId, user.id);
    if (!preflight || preflight.kind !== 'group') return null;
    const newIds = ids.filter((id) => id !== user.id);
    await lockPairsFor(db, user.id, newIds);
    const membership = await loadMembership(db, conversationId, user.id, { forUpdate: true });
    if (!membership || membership.kind !== 'group') return null;
    const existing = await db.query(
      `SELECT user_id, status FROM conversation_members
        WHERE conversation_id = $1 AND user_id = ANY($2::int[])
        FOR UPDATE`,
      [conversationId, newIds]
    );
    const statuses = new Map(existing.rows.map((row) => [row.user_id, row.status]));
    const inviteIds = newIds.filter((id) => !['member', 'invited'].includes(statuses.get(id)));
    const countResult = await db.query(
      `SELECT COUNT(*)::int AS count FROM conversation_members
        WHERE conversation_id = $1 AND status IN ('member', 'invited')`,
      [conversationId]
    );
    if (countResult.rows[0].count + inviteIds.length > MAX_GROUP_MEMBERS) return null;
    if (!(await ensureEligibleInvitees(db, user.id, inviteIds))) return null;
    const notifications = [];
    for (const id of inviteIds) {
      if (statuses.has(id)) {
        await db.query(
          `UPDATE conversation_members
              SET status = 'invited', role = 'member', invited_by = $3,
                  responded_at = NULL, joined_at = NULL, left_at = NULL
            WHERE conversation_id = $1 AND user_id = $2`,
          [conversationId, id, user.id]
        );
      } else {
        await db.query(
          `INSERT INTO conversation_members
             (conversation_id, user_id, role, status, invited_by)
           VALUES ($1, $2, 'member', 'invited', $3)`,
          [conversationId, id, user.id]
        );
      }
      notifications.push(await insertNotification(db, {
        userId: id, conversationId, sourceUserId: user.id, kind: 'conversation_invite',
      }));
    }
    await db.query(`UPDATE conversations SET updated_at = NOW() WHERE id = $1`, [conversationId]);
    return { memberIds: [...await activeMemberIds(db, conversationId), ...inviteIds], notifications };
  });
  if (!result) return null;
  return { ...result, conversation: await getConversation(pool, user, conversationId) };
}

async function transferOrArchive(db, conversationId, leavingUserId) {
  const { rows } = await db.query(
    `SELECT user_id FROM conversation_members
      WHERE conversation_id = $1 AND status = 'member' AND user_id <> $2
      ORDER BY joined_at NULLS LAST, created_at, user_id
      FOR UPDATE`,
    [conversationId, leavingUserId]
  );
  if (!rows.length) {
    const pending = await db.query(
      `SELECT user_id FROM conversation_members
        WHERE conversation_id = $1 AND status = 'invited'
        ORDER BY user_id FOR UPDATE`,
      [conversationId]
    );
    await db.query(
      `UPDATE conversation_members SET status = 'declined', responded_at = NOW()
        WHERE conversation_id = $1 AND status = 'invited'`,
      [conversationId]
    );
    await db.query(
      `DELETE FROM notifications
        WHERE conversation_id = $1 AND kind = 'conversation_invite'`,
      [conversationId]
    );
    await db.query(`UPDATE conversations SET status = 'archived', updated_at = NOW() WHERE id = $1`, [conversationId]);
    return pending.rows.map((row) => row.user_id);
  }
  await db.query(
    `UPDATE conversation_members SET role = 'owner'
      WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, rows[0].user_id]
  );
  return rows.map((row) => row.user_id);
}

async function leave(pool, user, conversationId) {
  return transaction(pool, async (db) => {
    const membership = await lockInteractionMembership(db, conversationId, user.id);
    if (!membership) return null;
    await db.query(
      `UPDATE conversation_members
          SET status = 'left', role = 'member', left_at = NOW(), responded_at = NOW()
        WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, user.id]
    );
    await db.query(`DELETE FROM notifications WHERE conversation_id = $1 AND user_id = $2`, [conversationId, user.id]);
    let memberIds = await activeMemberIds(db, conversationId);
    if (membership.kind === 'direct') {
      await db.query(`UPDATE conversations SET status = 'archived', updated_at = NOW() WHERE id = $1`, [conversationId]);
    } else if (membership.role === 'owner') {
      memberIds = await transferOrArchive(db, conversationId, user.id);
    } else {
      await db.query(`UPDATE conversations SET updated_at = NOW() WHERE id = $1`, [conversationId]);
    }
    return { memberIds: [...new Set([...memberIds, user.id])] };
  });
}

async function removeMember(pool, user, conversationId, targetId) {
  if (targetId === user.id) return leave(pool, user, conversationId);
  return transaction(pool, async (db) => {
    const membership = await loadMembership(db, conversationId, user.id, { forUpdate: true });
    if (!membership || membership.kind !== 'group' || membership.role !== 'owner') return null;
    const target = await db.query(
      `SELECT role, status FROM conversation_members
        WHERE conversation_id = $1 AND user_id = $2 FOR UPDATE`,
      [conversationId, targetId]
    );
    if (!target.rows.length || !['member', 'invited'].includes(target.rows[0].status)) return null;
    await db.query(
      `UPDATE conversation_members
          SET status = 'removed', role = 'member', left_at = NOW(), responded_at = NOW()
        WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, targetId]
    );
    await db.query(`DELETE FROM notifications WHERE conversation_id = $1 AND user_id = $2`, [conversationId, targetId]);
    await db.query(`UPDATE conversations SET updated_at = NOW() WHERE id = $1`, [conversationId]);
    return { memberIds: [...await activeMemberIds(db, conversationId), targetId] };
  });
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionsUsername(content, username) {
  if (!content || !username) return false;
  // Usernames are stored up to 255 characters and legacy/imported accounts
  // may contain hyphens or other punctuation. Match the exact active-member
  // username instead of first tokenizing with a narrower assumed alphabet.
  // The leading boundary prevents an address like mail@host from notifying
  // `host`; the trailing boundary prevents @ann from matching @ann-marie.
  const pattern = new RegExp(
    `(^|[^\\p{L}\\p{N}_])@${escapeRegex(username)}(?=$|[^\\p{L}\\p{N}_-])`,
    'iu'
  );
  return pattern.test(content);
}

async function sendMessage(pool, user, conversationId, input) {
  const attachmentIds = normalizeAttachmentIds(input.attachment_ids ?? input.attachmentIds);
  const refsRaw = input.objects ?? (input.object ? [input.object] : []);
  if (!Array.isArray(refsRaw) || refsRaw.length > MAX_OBJECTS || !attachmentIds) return null;
  const allowEmpty = attachmentIds.length > 0 || refsRaw.length > 0;
  const content = normalizeContent(input.content ?? '', { allowEmpty });
  const replyId = input.reply_to_id == null ? null : strictId(input.reply_to_id);
  const hasKey = Object.prototype.hasOwnProperty.call(input, 'idempotency_key');
  const key = normalizeIdempotencyKey(input.idempotency_key);
  if (content == null || (input.reply_to_id != null && !replyId) || (hasKey && !key)) return null;

  const result = await transaction(pool, async (db) => {
    const membership = await lockInteractionMembership(db, conversationId, user.id);
    if (!membership) return null;
    if (key) {
      const existing = await db.query(
        `SELECT id FROM conversation_messages
          WHERE conversation_id = $1 AND sender_id = $2 AND idempotency_key = $3`,
        [conversationId, user.id, key]
      );
      if (existing.rows.length) {
        return { messageId: existing.rows[0].id, memberIds: await activeMemberIds(db, conversationId), notifications: [], duplicate: true };
      }
    }
    if (membership.kind === 'direct') {
      // Before acceptance only the requester is an active member, and may
      // send the opening message. The invited recipient remains read-only
      // until accepting; loadMembership above already excludes them.
      const accepted = await db.query(
        `SELECT COUNT(*)::int AS count FROM conversation_members
          WHERE conversation_id = $1 AND status = 'member'`, [conversationId]
      );
      if (accepted.rows[0].count < 2) {
        if (membership.created_by !== user.id) return null;
        const existingMessages = await db.query(
          `SELECT 1 FROM conversation_messages WHERE conversation_id = $1 LIMIT 1`,
          [conversationId]
        );
        if (existingMessages.rows.length) return null;
      }
    }
    if (replyId) {
      const reply = await db.query(
        `SELECT id FROM conversation_messages WHERE id = $1 AND conversation_id = $2 FOR SHARE`,
        [replyId, conversationId]
      );
      if (!reply.rows.length) return null;
    }
    if (attachmentIds.length) {
      const attachmentRows = await db.query(
        `SELECT id FROM conversation_message_attachments
          WHERE id = ANY($1::varchar[]) AND conversation_id = $2
            AND user_id = $3 AND message_id IS NULL FOR UPDATE`,
        [attachmentIds, conversationId, user.id]
      );
      if (attachmentRows.rows.length !== attachmentIds.length) return null;
    }
    const objectRefs = [];
    for (const raw of refsRaw) {
      const validated = await sharedObjects.validateForShare(db, user, raw, { conversationId });
      if (!validated) return null;
      objectRefs.push(validated);
    }
    const inserted = await db.query(
      `INSERT INTO conversation_messages
         (conversation_id, sender_id, content, reply_to_id, idempotency_key)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [conversationId, user.id, content, replyId, key]
    );
    const messageId = inserted.rows[0].id;
    if (attachmentIds.length) {
      await db.query(
        `UPDATE conversation_message_attachments SET message_id = $1
          WHERE id = ANY($2::varchar[])`,
        [messageId, attachmentIds]
      );
    }
    for (let position = 0; position < objectRefs.length; position++) {
      const ref = objectRefs[position];
      await db.query(
        `INSERT INTO conversation_message_objects
           (message_id, position, object_type, app_id, object_ref, object_version)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [messageId, position, ref.objectType, ref.appId, ref.objectRef, ref.objectVersion]
      );
      if (ref.specShare) {
        await db.query(
          `INSERT INTO chat_session_spec_conversation_shares
             (session_id, version, conversation_id, shared_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [ref.specShare.sessionId, ref.specShare.version, conversationId, user.id]
        );
      }
    }
    await db.query(
      `UPDATE conversation_members SET last_read_message_id = $1
        WHERE conversation_id = $2 AND user_id = $3`,
      [messageId, conversationId, user.id]
    );
    await db.query(`UPDATE conversations SET updated_at = NOW() WHERE id = $1`, [conversationId]);

    const members = await db.query(
      `SELECT cm.user_id, LOWER(u.username) AS username
         FROM conversation_members cm JOIN users u ON u.id = cm.user_id
        WHERE cm.conversation_id = $1 AND cm.status = 'member' AND cm.user_id <> $2`,
      [conversationId, user.id]
    );
    const replyAuthor = replyId ? await db.query(
      `SELECT sender_id FROM conversation_messages WHERE id = $1`, [replyId]
    ) : { rows: [] };
    const replyAuthorId = replyAuthor.rows[0]?.sender_id;
    const notifications = [];
    for (const member of members.rows) {
      let kind = 'conversation_message';
      if (member.user_id === replyAuthorId) kind = 'conversation_reply';
      else if (mentionsUsername(content, member.username)) kind = 'conversation_mention';
      notifications.push(await insertNotification(db, {
        userId: member.user_id, conversationId, messageId,
        sourceUserId: user.id, kind,
      }));
    }
    return { messageId, memberIds: [user.id, ...members.rows.map((row) => row.user_id)], notifications, duplicate: false };
  });
  if (!result) return null;
  return { ...result, message: await getMessage(pool, user, conversationId, result.messageId) };
}

async function editMessage(pool, user, conversationId, messageId, rawContent) {
  const content = normalizeContent(rawContent);
  if (content == null) return null;
  const result = await transaction(pool, async (db) => {
    const membership = await lockInteractionMembership(db, conversationId, user.id);
    if (!membership) return null;
    const { rows } = await db.query(
      `UPDATE conversation_messages SET content = $1, edited_at = NOW()
        WHERE id = $2 AND conversation_id = $3 AND sender_id = $4
        RETURNING id`,
      [content, messageId, conversationId, user.id]
    );
    return rows.length ? { memberIds: await activeMemberIds(db, conversationId) } : null;
  });
  if (!result) return null;
  return {
    message: await getMessage(pool, user, conversationId, messageId),
    memberIds: result.memberIds,
  };
}

async function toggleReaction(pool, user, conversationId, messageId, rawEmoji) {
  const emoji = normalizeEmoji(rawEmoji);
  if (!emoji) return null;
  const result = await transaction(pool, async (db) => {
    const membership = await lockInteractionMembership(db, conversationId, user.id);
    if (!membership) return null;
    const message = await db.query(
      `SELECT id, sender_id FROM conversation_messages
        WHERE id = $1 AND conversation_id = $2 FOR UPDATE`,
      [messageId, conversationId]
    );
    if (!message.rows.length) return null;
    const deleted = await db.query(
      `DELETE FROM conversation_message_reactions
        WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
      [messageId, user.id, emoji]
    );
    const notifications = [];
    if (!deleted.rowCount) {
      await db.query(
        `INSERT INTO conversation_message_reactions (message_id, user_id, emoji)
         VALUES ($1, $2, $3)`, [messageId, user.id, emoji]
      );
      const authorId = message.rows[0].sender_id;
      if (authorId && authorId !== user.id) {
        notifications.push(await insertNotification(db, {
          userId: authorId, conversationId, messageId,
          sourceUserId: user.id, kind: 'conversation_reaction', detail: emoji,
        }));
      }
    } else {
      await db.query(
        `DELETE FROM notifications
          WHERE user_id = $1 AND conversation_id = $2 AND conversation_message_id = $3
            AND source_user_id = $4 AND kind = 'conversation_reaction' AND detail = $5`,
        [message.rows[0].sender_id, conversationId, messageId, user.id, emoji]
      );
    }
    return { notifications, memberIds: await activeMemberIds(db, conversationId) };
  });
  if (!result) return null;
  const message = await getMessage(pool, user, conversationId, messageId);
  return { ...result, reactions: message?.reactions || [] };
}

async function markRead(pool, user, conversationId, messageId) {
  return transaction(pool, async (db) => {
    const membership = await lockInteractionMembership(db, conversationId, user.id);
    if (!membership) return null;
    const message = await db.query(
      `SELECT id FROM conversation_messages WHERE id = $1 AND conversation_id = $2`,
      [messageId, conversationId]
    );
    if (!message.rows.length) return null;
    const current = membership.last_read_message_id || 0;
    const cursor = Math.max(current, messageId);
    await db.query(
      `UPDATE conversation_members SET last_read_message_id = $1
        WHERE conversation_id = $2 AND user_id = $3`,
      [cursor, conversationId, user.id]
    );
    await db.query(
      `UPDATE notifications SET read_at = NOW()
        WHERE user_id = $1 AND conversation_id = $2 AND read_at IS NULL
          AND (conversation_message_id IS NULL OR conversation_message_id <= $3)`,
      [user.id, conversationId, cursor]
    );
    return { messageId: cursor, memberIds: await activeMemberIds(db, conversationId) };
  });
}

async function reportMessage(pool, user, conversationId, messageId, rawReason, rawDetail) {
  const reasons = new Set(['harassment', 'spam', 'threats', 'hate', 'sexual_content', 'other']);
  const reason = reasons.has(rawReason) ? rawReason : null;
  const detail = typeof rawDetail === 'string' ? rawDetail.trim().slice(0, 500) : null;
  if (!reason) return null;
  return transaction(pool, async (db) => {
    const membership = await lockInteractionMembership(db, conversationId, user.id);
    if (!membership) return null;
    const message = await db.query(
      `SELECT m.id, m.sender_id, m.content, m.created_at, m.edited_at,
              COALESCE(jsonb_agg(jsonb_build_object('emoji', r.emoji, 'userId', r.user_id))
                FILTER (WHERE r.id IS NOT NULL), '[]'::jsonb) AS reactions
         FROM conversation_messages m
         LEFT JOIN conversation_message_reactions r ON r.message_id = m.id
        WHERE m.id = $1 AND m.conversation_id = $2
        GROUP BY m.id`,
      [messageId, conversationId]
    );
    if (!message.rows.length || message.rows[0].sender_id === user.id) return null;
    const row = message.rows[0];
    const [objectResult, attachmentResult] = await Promise.all([
      db.query(
        `SELECT position, object_type, app_id, object_ref, object_version
           FROM conversation_message_objects
          WHERE message_id = $1 ORDER BY position, id`,
        [messageId]
      ),
      db.query(
        `SELECT id, kind, filename, content_type, size_bytes
           FROM conversation_message_attachments
          WHERE message_id = $1 ORDER BY created_at, id`,
        [messageId]
      ),
    ]);
    await db.query(
      `INSERT INTO conversation_message_reports
         (conversation_id, message_id, reporter_user_id, reported_user_id,
          reason, detail, content_snapshot, evidence_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (message_id, reporter_user_id) WHERE status = 'pending'
       DO NOTHING`,
      [conversationId, messageId, user.id, row.sender_id, reason, detail,
       row.content, JSON.stringify({
         createdAt: row.created_at,
         editedAt: row.edited_at,
         reactions: row.reactions,
         objects: objectResult.rows.map((object) => ({
           position: object.position,
           type: object.object_type,
           appId: object.app_id,
           ref: object.object_ref,
           version: object.object_version,
         })),
         attachments: attachmentResult.rows.map((attachment) => ({
           id: attachment.id,
           kind: attachment.kind,
           filename: attachment.filename,
           contentType: attachment.content_type,
           sizeBytes: attachment.size_bytes,
         })),
       })]
    );
    return { ok: true };
  });
}

async function setBlock(pool, userId, targetId, blocked) {
  if (!targetId || targetId === userId) return false;
  return transaction(pool, async (db) => {
    await lockPair(db, userId, targetId);
    const target = await db.query('SELECT id FROM users WHERE id = $1 FOR SHARE', [targetId]);
    if (!target.rows.length) return false;
    const affected = await db.query(
      `SELECT DISTINCT conversation_id FROM (
         SELECT p.conversation_id
           FROM conversation_direct_pairs p
          WHERE p.user_low_id = LEAST($1::int, $2::int)
            AND p.user_high_id = GREATEST($1::int, $2::int)
         UNION ALL
         SELECT cm.conversation_id
           FROM conversation_members cm
          WHERE cm.status = 'invited'
            AND ((cm.user_id = $1::int AND cm.invited_by = $2::int)
              OR (cm.user_id = $2::int AND cm.invited_by = $1::int))
       ) affected_pair`,
      [userId, targetId]
    );
    const outcome = {
      ok: true,
      conversationIds: affected.rows.map((row) => row.conversation_id),
      memberIds: [userId, targetId],
    };
    const audience = await db.query(
      `SELECT cm.conversation_id,
              ARRAY_AGG(DISTINCT cm.user_id ORDER BY cm.user_id) AS user_ids
         FROM conversation_members cm
        WHERE cm.conversation_id = ANY($1::int[])
          AND (cm.status IN ('member', 'invited') OR cm.user_id = ANY($2::int[]))
        GROUP BY cm.conversation_id`,
      [outcome.conversationIds, outcome.memberIds]
    );
    outcome.conversationAudiences = audience.rows.map((row) => ({
      conversationId: row.conversation_id,
      memberIds: row.user_ids,
    }));
    if (!blocked) {
      await db.query(
        `DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_user_id = $2`,
        [userId, targetId]
      );
      return outcome;
    }
    await db.query(
      `INSERT INTO user_blocks (blocker_id, blocked_user_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`, [userId, targetId]
    );

    // A block is a consent decision for every still-pending invitation
    // between the pair (direct or group). Accepted shared groups remain
    // untouched. Deleting the invite notification also cascades its queued
    // mobile-push outbox rows immediately.
    await db.query(
      `UPDATE conversation_members
          SET status = 'declined', responded_at = NOW()
        WHERE status = 'invited'
          AND ((user_id = $1 AND invited_by = $2)
            OR (user_id = $2 AND invited_by = $1))`,
      [userId, targetId]
    );
    // A pending direct request becomes terminal when either participant
    // blocks the other. This runs after the invitation status transition so
    // the predicate observes it. The original recipient may later reopen the
    // retained pair explicitly; the original requester may not retry it.
    await db.query(
      `UPDATE conversations c
          SET status = 'archived', updated_at = NOW()
         FROM conversation_direct_pairs p
        WHERE p.conversation_id = c.id
          AND p.user_low_id = LEAST($1::int, $2::int)
          AND p.user_high_id = GREATEST($1::int, $2::int)
          AND EXISTS (
            SELECT 1 FROM conversation_members cm
             WHERE cm.conversation_id = c.id
               AND cm.status = 'declined'
               AND ((cm.user_id = $1::int AND cm.invited_by = $2::int)
                 OR (cm.user_id = $2::int AND cm.invited_by = $1::int))
          )`,
      [userId, targetId]
    );
    await db.query(
      `DELETE FROM notifications n
        USING conversation_members cm
        WHERE n.conversation_id = cm.conversation_id
          AND n.user_id = cm.user_id
          AND n.kind = 'conversation_invite'
          AND cm.status = 'declined'
          AND ((cm.user_id = $1 AND cm.invited_by = $2)
            OR (cm.user_id = $2 AND cm.invited_by = $1))`,
      [userId, targetId]
    );
    // Existing direct conversations become completely inaccessible in either
    // direction while blocked. Remove their notification rows now so unread
    // badges/snippets and already-queued push deliveries disappear at commit;
    // messages themselves remain retained and reappear only after unblock.
    await db.query(
      `DELETE FROM notifications n
        USING conversation_direct_pairs p
        WHERE n.conversation_id = p.conversation_id
          AND p.user_low_id = LEAST($1::int, $2::int)
          AND p.user_high_id = GREATEST($1::int, $2::int)`,
      [userId, targetId]
    );
    return outcome;
  });
}

async function listBlocks(pool, userId) {
  const { rows } = await pool.query(
    `SELECT b.blocked_user_id AS id, u.username, ua.id AS avatar_id, b.created_at
       FROM user_blocks b JOIN users u ON u.id = b.blocked_user_id
       LEFT JOIN user_avatars ua ON ua.user_id = u.id
      WHERE b.blocker_id = $1 ORDER BY LOWER(u.username)`,
    [userId]
  );
  return rows.map((row) => ({
    id: row.id, username: row.username,
    avatarUrl: row.avatar_id ? `/avatars/${row.avatar_id}` : null,
    createdAt: row.created_at,
  }));
}

module.exports = {
  MAX_ID,
  MAX_MESSAGE_LENGTH,
  MAX_GROUP_MEMBERS,
  GENERIC_NOT_FOUND,
  strictId,
  strictIds,
  normalizeTitle,
  normalizeContent,
  normalizeIdempotencyKey,
  normalizeEmoji,
  normalizeAttachmentIds,
  transaction,
  normalizePair,
  lockPair,
  lockPairsFor,
  blockedEitherWay,
  loadMembership,
  loadDirectPeer,
  canDirectInteract,
  lockInteractionMembership,
  withLockedAudience,
  activeMemberIds,
  getConversation,
  listConversations,
  listMessages,
  getMessage,
  createDirect,
  createGroup,
  updateTitle,
  respond,
  addMembers,
  leave,
  removeMember,
  mentionsUsername,
  messageSummary,
  sendMessage,
  editMessage,
  toggleReaction,
  markRead,
  reportMessage,
  setBlock,
  listBlocks,
};
