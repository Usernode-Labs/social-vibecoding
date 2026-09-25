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

module.exports = { hydrateAndPush, sendInvite };
