// Proposal-approver roster + invites (issue #646), the sibling of
// routes/collaborators.js for the app_approvers table.
//
// Approvers are the electorate the merge gate counts when
// apps.approver_policy = 'invited' (see services/governance.js). The
// membership model mirrors app_collaborators: one table holds members
// (status='member') and pending invites (status='invited'); a pending
// invite grants NOTHING; declining/revoking deletes the row so
// re-invites work. The drawer's pinned Invites section is driven by
// notifications.listPendingInvites (kind='approver' rows).
//
// Deliberate differences from collaborator invites:
//   - Only the app creator or a full admin may invite/remove
//     (approvers control what merges — higher bar than the
//     any-member-can-invite collaborator rule). Approvers may still
//     remove themselves (leave).
//   - Invites are allowed regardless of the app's CURRENT policy and
//     visibility, so a roster can be lined up before flipping the
//     "who can approve" setting to invited — and, unlike collaborator
//     invites, they're allowed on the self-hosted platform app.
//   - On a collab-private app the invitee must already be a
//     collaborator member (non-members can't cast votes there at all,
//     so an approver row would be dead weight).

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const appAccess = require('../services/app-access');
const notifications = require('../services/notifications');
const events = require('../services/events');
const governance = require('../services/governance');
const approverInvites = require('../services/approver-invites');
const appAdmins = require('../services/app-admins');
const { drainGuard } = require('../services/lifecycle');

// #788: the app's own declared admins manage the approver roster too —
// they are creator-equivalent for this app. Async because the app-admin
// lookup hits a (TTL-cached) table; every call site awaits it.
function canManageApprovers(pool, app, user) {
  return appAdmins.canManageApp(pool, app, user);
}

function approverRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Members + pending invites for the Approvers panel. Collab-level
  // read access, same as the collaborator list.
  router.get('/api/apps/:slug/approvers', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab',
        appAccess.ACCESS_COLUMNS + ', approver_policy, approvals_required'
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      const { rows } = await pool.query(
        `SELECT ap.user_id, ap.status, ap.created_at, ap.accepted_at,
                u.username, inv.username AS invited_by
           FROM app_approvers ap
           JOIN users u ON u.id = ap.user_id
           LEFT JOIN users inv ON inv.id = ap.invited_by
          WHERE ap.app_id = $1
          ORDER BY (ap.status = 'member') DESC, LOWER(u.username)`,
        [app.id]
      );
      res.json({
        approvers: rows.map((r) => ({
          userId: r.user_id,
          username: r.username,
          status: r.status,
          invitedBy: r.invited_by,
          createdAt: r.created_at,
          acceptedAt: r.accepted_at,
        })),
        approverPolicy: app.approver_policy,
        approvalsRequired: app.approvals_required,
        creatorId: app.created_by,
        canManage: await canManageApprovers(pool, app, req.user),
      });
    } catch (err) {
      log.error('approvers', 'list failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Invite a user as an approver. Creator / full admin only. The
  // single-invite core (target lookup, invite-only-app collaborator
  // rule, idempotent insert, notification + event) lives in
  // services/approver-invites.js, shared with the governance-pr
  // route's initialApprovers list.
  router.post('/api/apps/:slug/approver-invites', drainGuard, async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    if (!username) return res.status(400).json({ error: 'username is required' });
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', appAccess.ACCESS_COLUMNS + ', name'
      );
      if (!app) return res.status(404).json({ error: 'App not found' });
      if (!(await canManageApprovers(pool, app, req.user))) {
        return res.status(403).json({ error: 'Only the app creator or an admin can invite approvers' });
      }

      const result = await approverInvites.inviteApprover(pool, app, username, req.user);
      if (!result.created) {
        return res.status(409).json({
          error: result.existingStatus === 'member'
            ? `@${result.username} is already an approver`
            : `@${result.username} already has a pending approver invite`,
        });
      }
      res.status(201).json({ ok: true, username: result.username });
    } catch (err) {
      if (err instanceof approverInvites.ApproverInviteError) {
        return res.status(err.status).json({ error: err.message });
      }
      log.error('approvers', 'invite failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Accept a pending approver invite. Invitee-only; idempotent.
  router.post('/api/approver-invites/:appId/accept', drainGuard, async (req, res) => {
    const appId = parseInt(req.params.appId, 10);
    if (!Number.isFinite(appId)) return res.status(400).json({ error: 'Invalid app id' });
    try {
      const { rows: updated } = await pool.query(
        `UPDATE app_approvers
            SET status = 'member', accepted_at = NOW()
          WHERE app_id = $1 AND user_id = $2 AND status = 'invited'
          RETURNING invited_by`,
        [appId, req.user.id]
      );

      const { rows: appRows } = await pool.query(
        'SELECT id, slug, name FROM apps WHERE id = $1', [appId]
      );
      if (!appRows.length) return res.status(404).json({ error: 'App not found' });
      const app = appRows[0];

      if (!updated.length) {
        const { rows: member } = await pool.query(
          `SELECT 1 FROM app_approvers WHERE app_id = $1 AND user_id = $2 AND status = 'member'`,
          [appId, req.user.id]
        );
        if (member.length) return res.json({ ok: true, appSlug: app.slug, alreadyMember: true });
        return res.status(404).json({ error: 'Invite not found' });
      }

      await notifications.markApproverInviteNotificationsRead(pool, req.user.id, appId).catch(() => {});
      governance.invalidateGovernance(appId);

      const wsSvc = require('../services/ws');
      try { wsSvc.pushNotificationToUser(req.user.id, { type: 'notifications_changed' }); } catch {}

      const inviterId = updated[0].invited_by;
      if (inviterId && inviterId !== req.user.id) {
        try {
          await notifications.createApproverInviteAcceptedNotification(pool, {
            appId,
            recipientId: inviterId,
            accepterId: req.user.id,
          });
        } catch (err) {
          log.warn('approvers', 'accept notify failed', { err: err.message });
        }
      }

      await wsSvc.sendSystemMessage(pool, appId,
        `${req.user.username} became an approver`, 'system'
      ).catch((err) => log.warn('approvers', 'join chat msg failed', { err: err.message }));

      events.record(pool, {
        type: events.EVENT_TYPES.APPROVER_JOINED,
        userId: req.user.id,
        appId,
        metadata: { invitedBy: inviterId || null },
      });

      log.info('approvers', 'Approver invite accepted', { appId, userId: req.user.id });
      res.json({ ok: true, appSlug: app.slug });
    } catch (err) {
      log.error('approvers', 'accept failed', { appId, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Decline a pending approver invite. Deletes the row; success even
  // when nothing was pending — races are fine.
  router.post('/api/approver-invites/:appId/decline', drainGuard, async (req, res) => {
    const appId = parseInt(req.params.appId, 10);
    if (!Number.isFinite(appId)) return res.status(400).json({ error: 'Invalid app id' });
    try {
      await pool.query(
        `DELETE FROM app_approvers WHERE app_id = $1 AND user_id = $2 AND status = 'invited'`,
        [appId, req.user.id]
      );
      await notifications.markApproverInviteNotificationsRead(pool, req.user.id, appId).catch(() => {});
      try {
        const { pushNotificationToUser } = require('../services/ws');
        pushNotificationToUser(req.user.id, { type: 'notifications_changed' });
      } catch {}
      log.info('approvers', 'Approver invite declined', { appId, userId: req.user.id });
      res.json({ ok: true });
    } catch (err) {
      log.error('approvers', 'decline failed', { appId, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Remove an approver or revoke a pending invite. Creator / full
  // admin, or the approver removing themself (leave).
  router.delete('/api/apps/:slug/approvers/:userId', drainGuard, async (req, res) => {
    const targetId = parseInt(req.params.userId, 10);
    if (!Number.isFinite(targetId)) return res.status(400).json({ error: 'Invalid user id' });
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      const allowed = targetId === req.user?.id
        || await canManageApprovers(pool, app, req.user);
      if (!allowed) {
        return res.status(403).json({ error: 'Only the app creator or an admin can remove approvers' });
      }

      const { rowCount } = await pool.query(
        'DELETE FROM app_approvers WHERE app_id = $1 AND user_id = $2',
        [app.id, targetId]
      );
      if (!rowCount) return res.status(404).json({ error: 'Not an approver' });

      await notifications.markApproverInviteNotificationsRead(pool, targetId, app.id).catch(() => {});
      governance.invalidateGovernance(app.id);
      try {
        const { pushNotificationToUser } = require('../services/ws');
        pushNotificationToUser(targetId, { type: 'notifications_changed' });
      } catch {}

      log.info('approvers', 'Approver removed', {
        slug: app.slug, targetId, by: req.user.username,
      });
      res.json({ ok: true });
    } catch (err) {
      log.error('approvers', 'remove failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { approverRoutes };
