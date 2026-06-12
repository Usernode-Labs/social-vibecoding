const { Router } = require('express');
const { getPool } = require('../db/pool');
const notifications = require('../services/notifications');
const log = require('../services/logger');

// Routes for the top-right notifications dropdown. All routes assume
// authMiddleware has already attached `req.user`.
function notificationsRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Full dropdown payload: recent notifications (read and unread) + an
  // unread count so the badge and list stay in sync on initial page load.
  //
  // Pagination (#84 scroll-to-load-more): the client passes
  // `?before=<createdAt>&before_id=<id>&limit=<n>` to fetch the page
  // strictly older than that keyset cursor. We over-fetch nothing — a
  // returned page exactly `limit` long means there may be more, so we
  // hand back `nextBefore` (the cursor for the next page) and `hasMore`.
  // The unread count is omitted on paginated follow-up requests (it's a
  // whole-account aggregate the client already has from the first page).
  router.get('/api/notifications', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const rawLimit = Number(req.query.limit);
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100)
        : 100;

      let before = null;
      if (req.query.before) {
        const beforeId = Number(req.query.before_id);
        before = {
          createdAt: req.query.before,
          id: Number.isFinite(beforeId) ? beforeId : 0,
        };
      }

      const rows = await notifications.listForUser(pool, req.user.id, { limit, before });
      const serialized = rows.map(notifications.serialize);

      const hasMore = rows.length === limit;
      const last = rows[rows.length - 1];
      const nextBefore = hasMore && last
        ? { createdAt: last.created_at, id: last.id }
        : null;

      // Only compute the account-wide unread aggregate on the first page;
      // follow-up (cursor) fetches just append older rows.
      const payload = {
        notifications: serialized,
        hasMore,
        nextBefore,
      };
      if (!before) {
        payload.unread = await notifications.countUnread(pool, req.user.id);
        // Pending collaborator invites for the drawer's pinned Invites
        // section. Sourced from app_collaborators (authoritative about
        // what's still actionable), not from collab_invite notification
        // rows. First page only — like `unread`, it's an account-wide
        // aggregate the client already has on cursor follow-ups.
        payload.pendingInvites = await notifications.listPendingInvites(pool, req.user.id);
      }
      res.json(payload);
    } catch (err) {
      log.error('notifications', 'list failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/notifications/read', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const { id, all, chat_message_id: chatMessageId, app_id: appId } = req.body || {};
    try {
      // `{ app_id }` is the per-group "Mark read" path (#84 grouping):
      // clear every unread notification this user has for one app, in a
      // single round-trip. Mirrors the chat_message_id branch below —
      // returns the fresh unread count and fans out a cross-tab refresh
      // when something actually changed.
      if (appId != null) {
        const cleared = await notifications.markReadForApp(
          pool, req.user.id, Number(appId)
        );
        const unread = await notifications.countUnread(pool, req.user.id);
        if (cleared > 0) {
          try {
            const { pushNotificationToUser } = require('../services/ws');
            pushNotificationToUser(req.user.id, { type: 'notifications_changed' });
          } catch (err) {
            log.warn('notifications', 'cross-tab push failed', { message: err.message });
          }
        }
        return res.json({ unread, cleared });
      }

      // `{ chat_message_id }` is the in-chat "click a dotted message" path:
      // clear the user's unread mention/reply/reaction notification(s) for
      // that one message. Falls through to the existing single-id / all
      // behavior otherwise.
      if (chatMessageId != null) {
        const cleared = await notifications.markReadForMessage(
          pool, req.user.id, Number(chatMessageId)
        );
        const unread = await notifications.countUnread(pool, req.user.id);
        // Sync this user's other tabs (bell badge + the same message's dot
        // in another open chat tab) only when something actually changed.
        if (cleared > 0) {
          try {
            const { pushNotificationToUser } = require('../services/ws');
            pushNotificationToUser(req.user.id, { type: 'notifications_changed' });
          } catch (err) {
            log.warn('notifications', 'cross-tab push failed', { message: err.message });
          }
        }
        return res.json({ unread, cleared });
      }

      await notifications.markRead(pool, req.user.id, { id, all: !!all });
      const unread = await notifications.countUnread(pool, req.user.id);
      res.json({ unread });
    } catch (err) {
      log.error('notifications', 'markRead failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { notificationsRoutes };
