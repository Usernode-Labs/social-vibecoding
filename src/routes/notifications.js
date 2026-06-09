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
  router.get('/api/notifications', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const [rows, unread] = await Promise.all([
        notifications.listForUser(pool, req.user.id, { limit: 30 }),
        notifications.countUnread(pool, req.user.id),
      ]);
      res.json({
        unread,
        notifications: rows.map(notifications.serialize),
      });
    } catch (err) {
      log.error('notifications', 'list failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/notifications/read', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const { id, all, chat_message_id: chatMessageId } = req.body || {};
    try {
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
