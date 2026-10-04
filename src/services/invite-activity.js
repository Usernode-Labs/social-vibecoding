'use strict';

// WP-E: what an invite link brings back to the person who made it.
//
//   invite_opened   Somebody opened the link (a count; never a name: most
//                   are signed out, and nobody agreed to be named for
//                   looking).
//   member_joined   A signed-in person joined through it.
//   first_message   Somebody who joined through it wrote in the project's
//                   chat for the first time ("said hi").
//
// Only the link's maker hears, and only about people who came by THEIR
// link; the invite page tells a visitor that the maker sees when they join
// (features/auth/invite-card.tsx). Time spent is never said.
//
// One push per kind, per project, per day: the first moment inserts a
// notification (which is what rings, schema.sql
// enqueue_mobile_push_deliveries is AFTER INSERT); the rest of that day's
// moments fold into it, as a count in `detail`, newest person first, and
// bring it back unread without ringing again. The bell words the count
// ("Sam and 2 others joined"), the push only ever the first.
//
// Everything here is best-effort and never throws: a join, a page view or a
// message must not fail because telling somebody about it did.

const log = require('./logger');

const KINDS = Object.freeze(['invite_opened', 'member_joined', 'first_message']);
// A first message counts as a hello for this long after joining. Past it, the
// maker has long since heard they joined, and "said hi" would be news about
// somebody who has been around for weeks.
const HELLO_WITHIN_DAYS = 30;

function notifications() { return require('./notifications'); }

/**
 * Tell `userId` about one moment on `appId`: a new notification (it rings)
 * or, within a day of the last one of this kind there, that one counted up
 * and unread again (it does not). Resolves { row, fresh } or null.
 */
async function ring(pool, { userId, appId, kind, sourceUserId = null, chatMessageId = null }) {
  if (!KINDS.includes(kind) || !userId || !appId) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Two joins at once must not both ring: one key per (person, project, kind).
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`invite-activity:${userId}:${appId}:${kind}`]);
    const { rows: bumped } = await client.query(
      `UPDATE notifications
          SET detail = (CASE WHEN detail ~ '^[0-9]{1,6}$' THEN detail::int ELSE 1 END + 1)::text,
              source_user_id = COALESCE($4, source_user_id),
              chat_message_id = COALESCE($5, chat_message_id),
              read_at = NULL
        WHERE id = (SELECT id FROM notifications
                     WHERE user_id = $1 AND app_id = $2 AND kind = $3
                       AND created_at > NOW() - INTERVAL '24 hours'
                     ORDER BY id DESC LIMIT 1)
        RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, detail, created_at`,
      [userId, appId, kind, sourceUserId, chatMessageId],
    );
    let row = bumped[0] || null;
    const fresh = !row;
    if (!row) {
      const { rows } = await client.query(
        `INSERT INTO notifications (user_id, app_id, chat_message_id, source_user_id, kind)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, user_id, app_id, chat_message_id, source_user_id, kind, detail, created_at`,
        [userId, appId, chatMessageId, sourceUserId, kind],
      );
      row = rows[0];
    }
    await client.query('COMMIT');
    await notifications().hydrateAndPush(pool, row);
    return { row, fresh };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    log.warn('invite-activity', 'Could not tell a link\'s maker', { kind, appId, err: err.message });
    return null;
  } finally {
    client.release();
  }
}

/**
 * The email that stands in for a push the maker cannot get
 * (services/activity-mail.js). Only for the first moment of the day.
 */
function mailFor(pool, result, { appName, appSlug, line }) {
  if (!result?.fresh) return;
  void require('./activity-mail').emailIfNoPush(pool, {
    userId: result.row.user_id, kind: 'invite_activity', appName, appSlug, line,
  });
}

/**
 * A signed-in person joined through `inviteId`. Its maker hears it, by
 * name, unless they are the one who joined.
 */
async function noteJoined(pool, { inviteId, user }) {
  try {
    const { rows } = await pool.query(
      `SELECT ci.created_by, ci.app_id, a.slug, a.name, u.username
         FROM community_invites ci
         JOIN apps a ON a.id = ci.app_id
         LEFT JOIN users u ON u.id = $2
        WHERE ci.id = $1`,
      [inviteId, user?.id ?? null],
    );
    const invite = rows[0];
    if (!invite || invite.created_by == null || !user?.id || Number(invite.created_by) === Number(user.id)) return null;
    const result = await ring(pool, { userId: invite.created_by, appId: invite.app_id, kind: 'member_joined', sourceUserId: user.id });
    mailFor(pool, result, {
      appName: invite.name, appSlug: invite.slug,
      line: `${invite.username ? `@${invite.username}` : 'Someone'} joined ${invite.name} through your invite.`,
    });
    return result;
  } catch (err) {
    log.warn('invite-activity', 'Could not tell a link\'s maker about a join', { inviteId, err: err.message });
    return null;
  }
}

/**
 * Somebody opened the live link `token`: counted for its maker, never
 * named. `viewerId` is the signed-in visitor, when there is one: the maker
 * opening their own link, or somebody already in the community, is not news.
 */
async function noteOpened(pool, { token, viewerId = null }) {
  try {
    const { rows } = await pool.query(
      `SELECT ci.created_by, ci.app_id, ci.community_id,
              ($2::int IS NOT NULL AND EXISTS (
                SELECT 1 FROM community_members m WHERE m.community_id = ci.community_id AND m.user_id = $2
              )) AS viewer_is_member
         FROM community_invites ci
        WHERE ci.token = $1 AND ci.revoked_at IS NULL
          AND (ci.expires_at IS NULL OR ci.expires_at > NOW())
          AND (ci.max_uses IS NULL OR ci.uses < ci.max_uses)`,
      [token, viewerId],
    );
    const invite = rows[0];
    if (!invite || invite.created_by == null) return null;
    if (viewerId != null && (Number(viewerId) === Number(invite.created_by) || invite.viewer_is_member)) return null;
    return await ring(pool, { userId: invite.created_by, appId: invite.app_id, kind: 'invite_opened' });
  } catch (err) {
    log.warn('invite-activity', 'Could not count an invite opened', { err: err.message });
    return null;
  }
}

/**
 * `userId` just wrote `chatMessageId` in `appId`'s chat. When it is their
 * first message there, within HELLO_WITHIN_DAYS of joining through
 * somebody's link, that somebody hears they said hi.
 */
async function noteFirstMessage(pool, { appId, userId, chatMessageId }) {
  try {
    if (!appId || !userId || !chatMessageId) return null;
    const { rows } = await pool.query(
      `SELECT ci.created_by, a.slug, a.name, u.username
         FROM community_invite_redemptions r
         JOIN community_invites ci ON ci.id = r.invite_id
         JOIN apps a ON a.id = ci.app_id
         JOIN users u ON u.id = r.user_id
        WHERE r.user_id = $1 AND ci.app_id = $2 AND r.status = 'joined'
          AND ci.created_by IS NOT NULL AND ci.created_by <> r.user_id
          AND COALESCE(r.applied_at, r.created_at) > NOW() - make_interval(days => $4::int)
          AND EXISTS (SELECT 1 FROM community_members m
                       WHERE m.community_id = ci.community_id AND m.user_id = ci.created_by)
          AND NOT EXISTS (SELECT 1 FROM chat_messages cm
                           WHERE cm.app_id = $2 AND cm.user_id = $1 AND cm.id <> $3)
        ORDER BY COALESCE(r.applied_at, r.created_at) DESC
        LIMIT 1`,
      [userId, appId, chatMessageId, HELLO_WITHIN_DAYS],
    );
    const hello = rows[0];
    if (!hello) return null;
    const result = await ring(pool, {
      userId: hello.created_by, appId, kind: 'first_message', sourceUserId: userId, chatMessageId,
    });
    mailFor(pool, result, {
      appName: hello.name, appSlug: hello.slug,
      line: `@${hello.username} said hi in ${hello.name}.`,
    });
    return result;
  } catch (err) {
    log.warn('invite-activity', 'Could not tell a link\'s maker about a first message', { appId, err: err.message });
    return null;
  }
}

module.exports = {
  KINDS,
  HELLO_WITHIN_DAYS,
  ring,
  noteJoined,
  noteOpened,
  noteFirstMessage,
};
