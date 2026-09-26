'use strict';

/**
 * Sending a collaborator invite: the pending `app_collaborators` row, the
 * invitee's notification pushed live, and the analytics event. Two callers
 * send one: POST /api/apps/:slug/invites (routes/collaborators.js), one at a
 * time from Members & approvals, and POST /api/apps (routes/apps.js), for the
 * people a Group is created with (communities, stage 3). One function, so an
 * invite sent at creation is the same invite, with the same notification the
 * invitee accepts or declines, as one sent from the project's page.
 *
 * A pending invite grants nothing: accepting it (routes/collaborators.js)
 * makes the row a `member`, and that is what joins the project's community
 * (the collaborator trigger in src/db/schema.sql). The pending row already
 * makes the project read as a Group (communities.audienceSql).
 */

const log = require('./logger');
const notifications = require('./notifications');
const events = require('./events');
const appAccess = require('./app-access');

// Hydrate freshly inserted notification rows into the serialize() wire shape
// (the column set listForUser produces) and push them live.
async function hydrateAndPush(pool, notifRows) {
  if (!notifRows.length) return;
  const { rows: hydrated } = await pool.query(
    `SELECT n.id, n.kind, n.read_at, n.created_at,
            n.app_id, a.slug AS app_slug, a.name AS app_name,
            n.chat_message_id, NULL AS message_content,
            n.session_id, NULL AS pr_title, NULL AS pr_number,
            su.username AS source_username, n.user_id, n.detail
       FROM notifications n
       LEFT JOIN apps a ON a.id = n.app_id
       LEFT JOIN users su ON su.id = n.source_user_id
      WHERE n.id = ANY($1::int[])`,
    [notifRows.map((r) => r.id)]
  );
  const { pushNotificationToUser } = require('./ws');
  for (const row of hydrated) {
    pushNotificationToUser(row.user_id, {
      type: 'notification_new',
      notification: notifications.serialize(row),
    });
  }
}

/**
 * Invite `target` ({ id, username }) into `app` ({ id, slug }) on behalf of
 * `inviterId`. Returns `{ ok: true }`, or `{ ok: false, status }` when a row
 * already existed (`status` is that row's: 'member' or 'invited'). The
 * notification and the event are best-effort; the row is not.
 */
async function sendInvite(pool, { app, target, inviterId }) {
  const { rows: inserted } = await pool.query(
    `INSERT INTO app_collaborators (app_id, user_id, status, invited_by)
     VALUES ($1, $2, 'invited', $3)
     ON CONFLICT (app_id, user_id) DO NOTHING
     RETURNING user_id`,
    [app.id, target.id, inviterId]
  );
  if (!inserted.length) {
    const { rows: existing } = await pool.query(
      'SELECT status FROM app_collaborators WHERE app_id = $1 AND user_id = $2',
      [app.id, target.id]
    );
    return { ok: false, status: existing[0]?.status || null };
  }

  // Badge bump + drawer history row, pushed live.
  try {
    const notifRows = await notifications.createCollabInviteNotification(pool, {
      appId: app.id,
      recipientId: target.id,
      inviterId,
    });
    await hydrateAndPush(pool, notifRows);
  } catch (err) {
    log.warn('collab', 'invite notify failed', { err: err.message });
  }

  events.record(pool, {
    type: events.EVENT_TYPES.COLLAB_INVITED,
    userId: inviterId,
    appId: app.id,
    metadata: { invitedUserId: target.id },
  });
  return { ok: true };
}

/**
 * Accept `user`'s pending invite into app `appId`. Two callers: the
 * notification's Accept (POST /api/invites/:appId/accept) and the first-run
 * join screen, where a new account ticks the group it was invited into
 * (services/onboarding.js). Idempotent: accepting when already a member is
 * `{ ok: true, alreadyMember: true }`, for two-tab races.
 *
 * Returns `{ ok: true, appSlug }` or `{ ok: false, status, error }`; the
 * inviter's notification, the chat line and the event are best-effort.
 */
async function acceptInvite(pool, { appId, user }) {
  const { rows: updated } = await pool.query(
    `UPDATE app_collaborators
        SET status = 'member', accepted_at = NOW()
      WHERE app_id = $1 AND user_id = $2 AND status = 'invited'
      RETURNING invited_by`,
    [appId, user.id]
  );

  const { rows: appRows } = await pool.query(
    'SELECT id, slug, name FROM apps WHERE id = $1', [appId]
  );
  if (!appRows.length) return { ok: false, status: 404, error: 'App not found' };
  const app = appRows[0];

  if (!updated.length) {
    // No pending invite: already a member (idempotent ok) or never
    // invited (404 — don't disclose anything else).
    const isMember = await appAccess.isCollaborator(pool, appId, user.id);
    if (isMember) return { ok: true, appSlug: app.slug, alreadyMember: true };
    return { ok: false, status: 404, error: 'Invite not found' };
  }

  await notifications.markInviteNotificationsRead(pool, user.id, appId).catch(() => {});
  appAccess.invalidateVisibility(appId, app.slug);

  const wsSvc = require('./ws');
  try { wsSvc.pushNotificationToUser(user.id, { type: 'notifications_changed' }); } catch {}

  // Tell the inviter their invite landed.
  const inviterId = updated[0].invited_by;
  if (inviterId && inviterId !== user.id) {
    try {
      const notifRows = await notifications.createCollabInviteAcceptedNotification(pool, {
        appId,
        recipientId: inviterId,
        accepterId: user.id,
      });
      await hydrateAndPush(pool, notifRows);
    } catch (err) {
      log.warn('collab', 'accept notify failed', { err: err.message });
    }
  }

  await wsSvc.sendSystemMessage(pool, appId,
    `${user.username} joined as a collaborator`, 'system'
  ).catch((err) => log.warn('collab', 'join chat msg failed', { err: err.message }));

  events.record(pool, {
    type: events.EVENT_TYPES.COLLAB_JOINED,
    userId: user.id,
    appId,
    metadata: { invitedBy: inviterId || null },
  });

  log.info('collab', 'Invite accepted', { appId, userId: user.id });
  return { ok: true, appSlug: app.slug };
}

module.exports = { acceptInvite, hydrateAndPush, sendInvite };
