'use strict';

// Single-invite core for approver invites (issue #646), shared by:
//   - POST /api/apps/:slug/approver-invites (routes/approvers.js), the
//     standalone invite box in the Members & visibility panel;
//   - POST /api/apps/:slug/governance-pr (routes/apps.js), which sends
//     the `initialApprovers` picked in the "Initial approvers" step
//     when an app proposes switching to the invited-approvers policy.
// Both callers own their permission checks (creator / full admin);
// this module owns the target-user validation, the invite-only-app
// collaborator rule, the idempotent insert, and the notification +
// analytics side effects.

const log = require('./logger');
const appAccess = require('./app-access');
const notifications = require('./notifications');
const events = require('./events');

// Validation failures the caller can surface verbatim: `status` is the
// HTTP status the standalone route responds with; the governance-pr
// route folds `message` into its per-user inviteWarnings instead.
class ApproverInviteError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApproverInviteError';
    this.status = status;
  }
}

// Create a pending approver invite for `username` on `app` (must carry
// id, slug, self_hosted, collab_visibility). Returns
//   { created: true,  userId, username }  on a fresh invite row;
//   { created: false, existingStatus, username } when the user already
//     has a row ('member' or 'invited') — the insert is ON CONFLICT DO
//     NOTHING, so re-invites are a harmless no-op the caller decides
//     how to report.
// Throws ApproverInviteError for an unknown user (404) or a
// non-collaborator on an invite-only-build app (400). Notification
// failures are logged, never thrown — the invite row is what matters.
async function inviteApprover(pool, app, username, inviter) {
  const { rows: userRows } = await pool.query(
    'SELECT id, username FROM users WHERE LOWER(username) = LOWER($1)',
    [username]
  );
  if (!userRows.length) throw new ApproverInviteError(404, 'User not found');
  const target = userRows[0];

  // On an invite-only-build app, non-collaborators can't vote at
  // all, so an approver row for one would be dead weight.
  if (!app.self_hosted && app.collab_visibility === 'private') {
    const isMember = await appAccess.isCollaborator(pool, app.id, target.id);
    if (!isMember) {
      throw new ApproverInviteError(400,
        `@${target.username} must be a collaborator first. Invite them as a collaborator, then as an approver`);
    }
  }

  const { rows: inserted } = await pool.query(
    `INSERT INTO app_approvers (app_id, user_id, status, invited_by)
     VALUES ($1, $2, 'invited', $3)
     ON CONFLICT (app_id, user_id) DO NOTHING
     RETURNING user_id`,
    [app.id, target.id, inviter.id]
  );
  if (!inserted.length) {
    const { rows: existing } = await pool.query(
      'SELECT status FROM app_approvers WHERE app_id = $1 AND user_id = $2',
      [app.id, target.id]
    );
    return { created: false, existingStatus: existing[0]?.status || null, username: target.username };
  }

  // Badge bump + drawer history row, pushed live.
  try {
    const notifRows = await notifications.createApproverInviteNotification(pool, {
      appId: app.id,
      recipientId: target.id,
      inviterId: inviter.id,
    });
    await notifications.hydrateAndPush(pool, notifRows[0]);
  } catch (err) {
    log.warn('approvers', 'invite notify failed', { err: err.message });
  }

  events.record(pool, {
    type: events.EVENT_TYPES.APPROVER_INVITED,
    userId: inviter.id,
    appId: app.id,
    metadata: { invitedUserId: target.id },
  });

  log.info('approvers', 'Approver invite sent', {
    slug: app.slug, invitee: target.username, by: inviter.username,
  });
  return { created: true, userId: target.id, username: target.username };
}

module.exports = { inviteApprover, ApproverInviteError };
