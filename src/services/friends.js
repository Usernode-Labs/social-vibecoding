'use strict';

// Mutual friends (#2386).
//
// ── The relationship ───────────────────────────────────────────────────
//
// A sends a request; B accepts or declines. One `friendships` row per
// unordered pair (schema.sql explains the shape), and what each side SEES of
// that row is `stateFor` below — four answers, never more:
//
//   none      nothing between you, or a request you declined
//   outgoing  you asked — pending, or declined without your being told
//   incoming  they asked and you have not answered
//   friends   both of you said yes
//
// ── Silence is part of the contract ────────────────────────────────────
//
// A decline tells the sender nothing: their row keeps reading "outgoing", so
// even the pending-outgoing cap counts it (a cap that dropped on a decline
// would announce it). The recipient is not re-notified by the same sender for
// DECLINE_QUIET_DAYS, even across a cancel and a fresh request — the new row
// is written straight into `declined`. Unfriending is silent too, and so is a
// block: both simply leave the other person looking at "none", which is also
// what a cancel or an unfriend leaves.
//
// A refused request never says WHY. Blocked in either direction, a missing
// account, yourself, a synthetic demo partner: one `not_found`, the same
// generic refusal a direct message gives (services/conversations.js
// createDirect → 404).
//
// ── Locking ────────────────────────────────────────────────────────────
//
// Every write takes the normalised pair advisory lock direct messages and
// blocks already use (conversations.lockPair → `conversation-direct:<lo>:<hi>`)
// before any row lock, so a request, an accept, a DM and a block on one pair
// serialise, and a block's removal of the row (removePairOnBlock, called from
// conversations.setBlock inside its own transaction) cannot race a send. The
// sender's caps take one more advisory lock AFTER the pair lock — never
// before it, and never two pair locks in one transaction — so no two writes
// can wait on each other in opposite orders.
//
// ── What friendship buys ───────────────────────────────────────────────
//
// Friends lead the people pickers (the Messages user search, an app's
// mention suggestions, the Messages composer's @ list), and a direct message
// between friends skips its invitation: createDirect makes the recipient a
// member at once, and becoming friends accepts any invitation still pending
// between the two (acceptPendingDirect).

const conversations = require('./conversations');

const MAX_PENDING_OUTGOING = 20;
const MAX_REQUESTS_PER_DAY = 50;
const DECLINE_QUIET_DAYS = 30;
const STATES = Object.freeze(['none', 'outgoing', 'incoming', 'friends']);
const NOTIFICATION_KINDS = Object.freeze(['friend_request', 'friend_accept']);

class FriendsError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'FriendsError';
    this.status = status;
    this.code = code;
  }
}

function notFound() {
  return new FriendsError(404, 'not_found', 'User not found');
}

/** What `viewerId` sees of a pair's row. Pure, for tests. */
function stateFor(row, viewerId) {
  if (!row) return 'none';
  if (row.status === 'accepted') return 'friends';
  if (row.requester_id === viewerId) return 'outgoing';
  return row.status === 'pending' ? 'incoming' : 'none';
}

function avatarUrl(id) {
  return id ? `/avatars/${id}` : null;
}

async function loadPair(db, a, b) {
  const [low, high] = conversations.normalizePair(a, b);
  const { rows } = await db.query(
    `SELECT requester_id, status, created_at, responded_at
       FROM friendships
      WHERE user_low_id = $1 AND user_high_id = $2`,
    [low, high]
  );
  return rows[0] || null;
}

async function lockPairRow(db, a, b) {
  const [low, high] = conversations.normalizePair(a, b);
  const { rows } = await db.query(
    `SELECT requester_id, status, created_at, responded_at
       FROM friendships
      WHERE user_low_id = $1 AND user_high_id = $2
      FOR UPDATE`,
    [low, high]
  );
  return rows[0] || null;
}

async function areFriends(db, a, b) {
  if (!a || !b || a === b) return false;
  const row = await loadPair(db, a, b);
  return !!row && row.status === 'accepted';
}

function assertOther(actorId, targetId) {
  if (!targetId || targetId === actorId) throw notFound();
}

// The gate a NEW request passes: a real, non-synthetic account that is not the
// actor and is not blocked by or blocking them. One refusal for all of it.
// Answering, withdrawing and unfriending need no such gate: each acts only on
// a row that exists, and a block deletes the pair's row under the same lock.
async function assertReachable(db, actorId, targetId) {
  assertOther(actorId, targetId);
  const { rows } = await db.query(
    `SELECT id FROM users WHERE id = $1 AND NOT is_synthetic FOR SHARE`,
    [targetId]
  );
  if (!rows.length || await conversations.blockedEitherWay(db, actorId, targetId)) {
    throw notFound();
  }
}

/**
 * The viewer's relationship with one person, for the profile payload. Null
 * when the viewer may not use friends at all (no platform access, or a
 * synthetic account), so the page draws no button rather than a dead one.
 */
async function relationshipFor(db, viewerId, otherId) {
  if (!viewerId || !otherId || viewerId === otherId) return null;
  const { rows } = await db.query(
    `SELECT f.requester_id, f.status
       FROM users viewer
       LEFT JOIN friendships f
         ON f.user_low_id = LEAST($1::int, $2::int)
        AND f.user_high_id = GREATEST($1::int, $2::int)
      WHERE viewer.id = $1
        AND (viewer.has_platform_access OR viewer.is_admin)
        AND NOT viewer.is_synthetic`,
    [viewerId, otherId]
  );
  if (!rows.length) return null;
  return { userId: otherId, state: stateFor(rows[0].status ? rows[0] : null, viewerId) };
}

/** The viewer's own lists. Nobody else can ever read them. */
async function listFor(db, userId) {
  const { rows } = await db.query(
    `SELECT u.id, u.username, av.id AS avatar_id,
            f.requester_id, f.status, f.created_at, f.responded_at
       FROM friendships f
       JOIN users u
         ON u.id = CASE WHEN f.user_low_id = $1 THEN f.user_high_id ELSE f.user_low_id END
       LEFT JOIN user_avatars av ON av.user_id = u.id
      WHERE f.user_low_id = $1 OR f.user_high_id = $1
      ORDER BY LOWER(u.username), u.id
      LIMIT 2000`,
    [userId]
  );
  const friends = [];
  const incoming = [];
  const outgoing = [];
  for (const row of rows) {
    const person = { id: row.id, username: row.username, avatarUrl: avatarUrl(row.avatar_id) };
    const state = stateFor(row, userId);
    if (state === 'friends') friends.push({ ...person, since: row.responded_at || row.created_at });
    else if (state === 'incoming') incoming.push({ ...person, requestedAt: row.created_at });
    else if (state === 'outgoing') outgoing.push({ ...person, requestedAt: row.created_at });
  }
  const newestFirst = (a, b) => new Date(b.requestedAt) - new Date(a.requestedAt) || a.id - b.id;
  incoming.sort(newestFirst);
  outgoing.sort(newestFirst);
  return { friends, incoming, outgoing };
}

/** The viewer's friend ids, for ordering a picker they already loaded. */
async function friendIdsFor(db, userId) {
  const { rows } = await db.query(
    `SELECT CASE WHEN user_low_id = $1 THEN user_high_id ELSE user_low_id END AS id
       FROM friendships
      WHERE (user_low_id = $1 OR user_high_id = $1) AND status = 'accepted'`,
    [userId]
  );
  return rows.map((row) => row.id);
}

async function insertNotification(db, { userId, sourceUserId, kind }) {
  const { rows } = await db.query(
    `INSERT INTO notifications (user_id, source_user_id, kind)
     SELECT $1, $2, $3
      WHERE NOT EXISTS (SELECT 1 FROM user_blocks b
                         WHERE b.blocker_id = $1 AND b.blocked_user_id = $2)
     RETURNING id, user_id, source_user_id, kind, created_at`,
    [userId, sourceUserId, kind]
  );
  return rows[0] || null;
}

// A request that has been answered (or withdrawn) is no longer a question in
// the recipient's bell: read once answered, gone once withdrawn.
async function resolveRequestNotification(db, recipientId, requesterId) {
  const { rowCount } = await db.query(
    `UPDATE notifications SET read_at = NOW()
      WHERE user_id = $1 AND source_user_id = $2
        AND kind = 'friend_request' AND read_at IS NULL`,
    [recipientId, requesterId]
  );
  return rowCount || 0;
}

async function deleteRequestNotification(db, recipientId, requesterId) {
  const { rowCount } = await db.query(
    `DELETE FROM notifications
      WHERE user_id = $1 AND source_user_id = $2 AND kind = 'friend_request'`,
    [recipientId, requesterId]
  );
  return rowCount || 0;
}

// Friendship is consent in both directions, so a direct message between
// friends has nothing left to ask. Accepts an invitation still pending on the
// pair's live conversation; returns its id, or null when there was none.
async function acceptPendingDirect(db, a, b) {
  const [low, high] = conversations.normalizePair(a, b);
  const { rows } = await db.query(
    `SELECT c.id FROM conversation_direct_pairs p
       JOIN conversations c ON c.id = p.conversation_id
      WHERE p.user_low_id = $1 AND p.user_high_id = $2 AND c.status = 'active'
      FOR UPDATE OF c`,
    [low, high]
  );
  if (!rows.length) return null;
  const conversationId = rows[0].id;
  const accepted = await db.query(
    `UPDATE conversation_members
        SET status = 'member', responded_at = NOW(), joined_at = COALESCE(joined_at, NOW())
      WHERE conversation_id = $1 AND status = 'invited' AND user_id = ANY($2::int[])
      RETURNING user_id`,
    [conversationId, [low, high]]
  );
  if (!accepted.rows.length) return null;
  await db.query(`UPDATE conversations SET updated_at = NOW() WHERE id = $1`, [conversationId]);
  await db.query(
    `UPDATE notifications SET read_at = NOW()
      WHERE conversation_id = $1 AND kind = 'conversation_invite' AND read_at IS NULL`,
    [conversationId]
  );
  return conversationId;
}

// createDirect's friend branch: both people members, the conversation live,
// whatever state it was left in (an invitation never answered, a decline, a
// leave). Only ever called for a pair that is friends, under the pair lock.
async function openDirectBetweenFriends(db, conversationId) {
  await db.query(
    `UPDATE conversation_members
        SET status = 'member', responded_at = COALESCE(responded_at, NOW()),
            joined_at = COALESCE(joined_at, NOW()), left_at = NULL
      WHERE conversation_id = $1 AND status <> 'member'`,
    [conversationId]
  );
  await db.query(
    `UPDATE conversations SET status = 'active', updated_at = NOW() WHERE id = $1`,
    [conversationId]
  );
  await db.query(
    `UPDATE notifications SET read_at = NOW()
      WHERE conversation_id = $1 AND kind = 'conversation_invite' AND read_at IS NULL`,
    [conversationId]
  );
}

async function becomeFriends(db, userId, otherId) {
  const [low, high] = conversations.normalizePair(userId, otherId);
  await db.query(
    `UPDATE friendships SET status = 'accepted', responded_at = NOW()
      WHERE user_low_id = $1 AND user_high_id = $2`,
    [low, high]
  );
  // A decline between two people who are now friends protects nobody; left
  // in place, it would silence a request after some later unfriend.
  await db.query(
    `DELETE FROM friend_request_declines
      WHERE (recipient_id = $1 AND requester_id = $2)
         OR (recipient_id = $2 AND requester_id = $1)`,
    [userId, otherId]
  );
  // The person accepting answered the other's request; the other hears so.
  const cleared = await resolveRequestNotification(db, userId, otherId);
  const notification = await insertNotification(db, {
    userId: otherId, sourceUserId: userId, kind: 'friend_accept',
  });
  const conversationId = await acceptPendingDirect(db, userId, otherId);
  return {
    state: 'friends',
    notifications: notification ? [notification] : [],
    changedNotificationUserIds: cleared ? [userId] : [],
    conversationIds: conversationId ? [conversationId] : [],
  };
}

function outcome(state, extra = {}) {
  return {
    state,
    notifications: [],
    changedNotificationUserIds: [],
    conversationIds: [],
    ...extra,
  };
}

async function sendRequest(pool, user, targetId) {
  assertOther(user.id, targetId);
  return conversations.transaction(pool, async (db) => {
    await conversations.lockPair(db, user.id, targetId);
    await assertReachable(db, user.id, targetId);
    const row = await lockPairRow(db, user.id, targetId);
    const state = stateFor(row, user.id);
    // Asking again changes nothing: not the row, not the caps, no notification.
    if (state === 'friends' || state === 'outgoing') return outcome(state);
    // They asked first — or they asked and you declined: sending your own
    // request is the affirmative answer, so it makes you friends. Only the
    // person who declined can reverse a decline this way; the one who was
    // declined keeps seeing "outgoing" above.
    if (row) return becomeFriends(db, user.id, targetId);

    await db.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`friend-requests:${user.id}`]
    );
    const pending = await db.query(
      `SELECT COUNT(*)::int AS count FROM friendships
        WHERE requester_id = $1 AND status IN ('pending', 'declined')`,
      [user.id]
    );
    if (pending.rows[0].count >= MAX_PENDING_OUTGOING) {
      throw new FriendsError(429, 'friend_request_pending_limit',
        `You have ${MAX_PENDING_OUTGOING} friend requests waiting for an answer. `
        + 'Cancel one before sending another.');
    }
    await db.query(
      `DELETE FROM friend_request_sends
        WHERE requester_id = $1 AND created_at <= NOW() - INTERVAL '1 day'`,
      [user.id]
    );
    const sent = await db.query(
      `SELECT COUNT(*)::int AS count FROM friend_request_sends WHERE requester_id = $1`,
      [user.id]
    );
    if (sent.rows[0].count >= MAX_REQUESTS_PER_DAY) {
      throw new FriendsError(429, 'friend_request_daily_limit',
        `You can send up to ${MAX_REQUESTS_PER_DAY} friend requests a day. Try again tomorrow.`);
    }
    await db.query(`INSERT INTO friend_request_sends (requester_id) VALUES ($1)`, [user.id]);

    const quiet = await db.query(
      `SELECT 1 FROM friend_request_declines
        WHERE recipient_id = $1 AND requester_id = $2
          AND declined_at > NOW() - make_interval(days => $3::int)`,
      [targetId, user.id, DECLINE_QUIET_DAYS]
    );
    const [low, high] = conversations.normalizePair(user.id, targetId);
    await db.query(
      `INSERT INTO friendships (user_low_id, user_high_id, requester_id, status, responded_at)
       VALUES ($1, $2, $3, $4::varchar, CASE WHEN $4::varchar = 'declined' THEN NOW() END)`,
      [low, high, user.id, quiet.rows.length ? 'declined' : 'pending']
    );
    if (quiet.rows.length) return outcome('outgoing');
    const notification = await insertNotification(db, {
      userId: targetId, sourceUserId: user.id, kind: 'friend_request',
    });
    return outcome('outgoing', { notifications: notification ? [notification] : [] });
  });
}

async function accept(pool, user, requesterId) {
  assertOther(user.id, requesterId);
  return conversations.transaction(pool, async (db) => {
    await conversations.lockPair(db, user.id, requesterId);
    const row = await lockPairRow(db, user.id, requesterId);
    // Nothing to accept (withdrawn a moment ago, already answered): say what
    // the relationship IS, so the caller's button can catch up.
    if (stateFor(row, user.id) !== 'incoming') return outcome(stateFor(row, user.id));
    return becomeFriends(db, user.id, requesterId);
  });
}

async function decline(pool, user, requesterId) {
  assertOther(user.id, requesterId);
  return conversations.transaction(pool, async (db) => {
    await conversations.lockPair(db, user.id, requesterId);
    const row = await lockPairRow(db, user.id, requesterId);
    if (stateFor(row, user.id) !== 'incoming') return outcome(stateFor(row, user.id));
    const [low, high] = conversations.normalizePair(user.id, requesterId);
    await db.query(
      `UPDATE friendships SET status = 'declined', responded_at = NOW()
        WHERE user_low_id = $1 AND user_high_id = $2`,
      [low, high]
    );
    await db.query(
      `INSERT INTO friend_request_declines (recipient_id, requester_id, declined_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (recipient_id, requester_id) DO UPDATE SET declined_at = EXCLUDED.declined_at`,
      [user.id, requesterId]
    );
    const cleared = await resolveRequestNotification(db, user.id, requesterId);
    // Nothing is sent to the requester. That is the whole feature.
    return outcome('none', { changedNotificationUserIds: cleared ? [user.id] : [] });
  });
}

async function cancel(pool, user, targetId) {
  assertOther(user.id, targetId);
  return conversations.transaction(pool, async (db) => {
    await conversations.lockPair(db, user.id, targetId);
    const row = await lockPairRow(db, user.id, targetId);
    if (stateFor(row, user.id) !== 'outgoing') return outcome(stateFor(row, user.id));
    const [low, high] = conversations.normalizePair(user.id, targetId);
    await db.query(
      `DELETE FROM friendships
        WHERE user_low_id = $1 AND user_high_id = $2
          AND requester_id = $3 AND status IN ('pending', 'declined')`,
      [low, high, user.id]
    );
    // The recipient's question goes with the request. A declined request's
    // row was already read; removing it changes nothing they can see.
    const removed = await deleteRequestNotification(db, targetId, user.id);
    return outcome('none', { changedNotificationUserIds: removed ? [targetId] : [] });
  });
}

async function unfriend(pool, user, otherId) {
  assertOther(user.id, otherId);
  return conversations.transaction(pool, async (db) => {
    await conversations.lockPair(db, user.id, otherId);
    const row = await lockPairRow(db, user.id, otherId);
    if (stateFor(row, user.id) !== 'friends') return outcome(stateFor(row, user.id));
    const [low, high] = conversations.normalizePair(user.id, otherId);
    await db.query(
      `DELETE FROM friendships
        WHERE user_low_id = $1 AND user_high_id = $2 AND status = 'accepted'`,
      [low, high]
    );
    // Silent: the other person is told nothing and simply sees "none".
    return outcome('none');
  });
}

/**
 * conversations.setBlock's hook, inside its transaction and under the pair
 * lock it already holds. A block ends a friendship and any request between
 * the two, and takes the blocked person's friend notifications out of the
 * blocker's bell. A request the BLOCKER had sent disappears from the other
 * bell exactly as a cancel would — so nothing there says "blocked".
 */
async function removePairOnBlock(db, blockerId, blockedId) {
  const removed = await db.query(
    `DELETE FROM friendships
      WHERE user_low_id = LEAST($1::int, $2::int)
        AND user_high_id = GREATEST($1::int, $2::int)`,
    [blockerId, blockedId]
  );
  const requests = await db.query(
    `DELETE FROM notifications
      WHERE kind = 'friend_request'
        AND ((user_id = $1 AND source_user_id = $2)
          OR (user_id = $2 AND source_user_id = $1))`,
    [blockerId, blockedId]
  );
  await db.query(
    `DELETE FROM notifications
      WHERE user_id = $1 AND source_user_id = $2 AND kind = 'friend_accept'`,
    [blockerId, blockedId]
  );
  return (removed.rowCount || 0) + (requests.rowCount || 0);
}

// ── Staging demo (?demo=1) ─────────────────────────────────────────────
//
// `friendships` is staging:private, so a staging clone has the table and none
// of the rows: without these the profile button and the own-profile Friends
// section could never be seen in a preview. Request-time only, never
// persisted, and a strict no-op outside staging (callers gate on
// USERNODE_ENV). The people are the Messages demo's own (routes/
// conversations.js demoConversations), one per state.
const DEMO_PEOPLE = Object.freeze([
  Object.freeze({ id: 910001, username: 'ada', state: 'friends', at: '2026-08-02T10:00:00Z' }),
  Object.freeze({ id: 910002, username: 'lin', state: 'incoming', at: '2026-08-13T09:30:00Z' }),
  Object.freeze({ id: 910003, username: 'grace', state: 'outgoing', at: '2026-08-12T16:00:00Z' }),
  Object.freeze({ id: 910004, username: 'turing', state: 'none', at: null }),
]);

function demoPerson(key) {
  const needle = String(key || '').toLowerCase();
  return DEMO_PEOPLE.find((person) => String(person.id) === needle
    || person.username === needle) || null;
}

function demoLists() {
  const shape = (person) => ({ id: person.id, username: person.username, avatarUrl: null });
  return {
    friends: DEMO_PEOPLE.filter((p) => p.state === 'friends')
      .map((p) => ({ ...shape(p), since: p.at })),
    incoming: DEMO_PEOPLE.filter((p) => p.state === 'incoming')
      .map((p) => ({ ...shape(p), requestedAt: p.at })),
    outgoing: DEMO_PEOPLE.filter((p) => p.state === 'outgoing')
      .map((p) => ({ ...shape(p), requestedAt: p.at })),
  };
}

/** A demo person's public profile, the shape routes/profiles.js publicShape returns. */
function demoProfile(username) {
  const person = demoPerson(username);
  if (!person || String(person.username) !== String(username || '').toLowerCase()) return null;
  return {
    profile: {
      username: person.username,
      displayName: null,
      bio: `[Staging demo] Here so a preview can show the friend button's "${person.state}" state.`,
      avatarUrl: null,
      links: { github: null, x: null },
      url: `/#profile/${encodeURIComponent(person.username)}`,
    },
    friendship: { userId: person.id, state: person.state },
  };
}

/** What a demo write answers, so the button's every transition is reviewable. */
function demoTransition(action, userId) {
  const person = demoPerson(userId);
  if (!person) return null;
  const next = {
    request: person.state === 'incoming' ? 'friends' : 'outgoing',
    accept: 'friends',
    decline: 'none',
    cancel: 'none',
    unfriend: 'none',
  }[action];
  return next ? { userId: person.id, state: next } : null;
}

module.exports = {
  MAX_PENDING_OUTGOING,
  MAX_REQUESTS_PER_DAY,
  DECLINE_QUIET_DAYS,
  STATES,
  NOTIFICATION_KINDS,
  FriendsError,
  stateFor,
  areFriends,
  relationshipFor,
  listFor,
  friendIdsFor,
  sendRequest,
  accept,
  decline,
  cancel,
  unfriend,
  acceptPendingDirect,
  openDirectBetweenFriends,
  removePairOnBlock,
  DEMO_PEOPLE,
  demoLists,
  demoProfile,
  demoTransition,
};
