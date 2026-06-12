const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const models = require('../services/models');
const { listActiveUserIds } = require('../services/active-users');
const appAccess = require('../services/app-access');

function chatRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Models the UI may offer in its dropdown. Backed by the same
  // allowlist src/routes/sessions.js validates inbound `model`
  // against, so the dropdown and server enforcement can never drift.
  router.get('/api/models', (_req, res) => {
    res.json({ models: models.list(), default: models.DEFAULT_MODEL });
  });

  router.get('/api/apps/:slug/messages', async (req, res) => {
    const before = req.query.before;
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);

    // #194: optional thread scoping. Absent → general chat only
    // (thread_type IS NULL) — this is what keeps thread messages out of
    // the general stream. Both params must be present and valid to
    // select a thread; a malformed pair is a 400 rather than silently
    // falling back to general chat.
    const THREAD_TYPES = new Set(['issue', 'session', 'governance']);
    const threadType = req.query.thread_type || null;
    const threadRef = req.query.thread_ref != null ? parseInt(req.query.thread_ref, 10) : null;
    if (threadType || req.query.thread_ref != null) {
      if (!THREAD_TYPES.has(threadType) || !Number.isInteger(threadRef) || threadRef <= 0) {
        return res.status(400).json({ error: 'Invalid thread_type/thread_ref' });
      }
    }

    try {
      // Group chat is a collaboration surface — collab-level access (404
      // on deny so private apps aren't enumerable).
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', appAccess.ACCESS_COLUMNS
      );
      if (!app) {
        return res.status(404).json({ error: 'App not found' });
      }

      const appId = app.id;

      // Thread filter: a specific thread when requested, else the
      // general stream (thread_type IS NULL — all legacy rows).
      const params = [appId];
      let threadClause;
      if (threadType) {
        params.push(threadType, threadRef);
        threadClause = `m.thread_type = $2 AND m.thread_ref = $3`;
      } else {
        threadClause = `m.thread_type IS NULL`;
      }
      let beforeClause = '';
      if (before) {
        params.push(before);
        beforeClause = ` AND m.id < $${params.length}`;
      }
      params.push(limit);

      const query = `
        SELECT m.id, m.user_id, u.username, m.content, m.msg_type, m.metadata,
               m.thread_type, m.thread_ref, m.created_at
        FROM chat_messages m
        LEFT JOIN users u ON m.user_id = u.id
        WHERE m.app_id = $1 AND ${threadClause}${beforeClause}
        ORDER BY m.id DESC
        LIMIT $${params.length}`;

      const { rows } = await pool.query(query, params);
      const messages = rows.reverse();

      // #25: attach emoji reactions so the chat renders them on load (live
      // updates arrive separately over the per-app WS 'reaction' event).
      try {
        const { getReactionsForMessages } = require('../services/ws');
        const byId = await getReactionsForMessages(pool, messages.map((m) => m.id));
        for (const m of messages) m.reactions = byId[m.id] || [];
      } catch (err) {
        log.warn('chat', 'reaction hydrate failed', { message: err.message });
      }

      // Per-message unread dot: flag any message this user has an unread
      // mention/reply/reaction notification for, so the chat renders a dot
      // next to it. Live messages (over the WS) can't yet carry this flag,
      // so the dot is driven by this loaded-history flag plus client-side
      // reconciliation on notifications_changed. Non-fatal: a failure here
      // must never break loading the chat.
      if (req.user) {
        try {
          const notifications = require('../services/notifications');
          const unreadIds = await notifications.unreadMessageIdsForUser(
            pool, req.user.id, messages.map((m) => m.id)
          );
          for (const m of messages) m.has_unread_notification = unreadIds.has(m.id);
        } catch (err) {
          log.warn('chat', 'unread-dot hydrate failed', { message: err.message });
        }
      }

      res.json({ messages });
    } catch (err) {
      log.error('chat', 'Failed to load messages', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // @mention autocomplete candidate set for one app's group chat (#87).
  // Returns the union of:
  //   1. distinct authors of this app's chat messages,
  //   2. the app's active users (same definition that gates voting,
  //      so suggestions match who can actually act on a mention),
  //   3. the app creator.
  // De-duplicated, alphabetical, capped. The client caches this once per
  // app mount and filters by prefix locally; usernames are returned in
  // canonical casing so the inserted @mention renders correctly. Auth is
  // enforced by the global JWT gate (this is a GET under /api/).
  router.get('/api/apps/:slug/mention-suggestions', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', appAccess.ACCESS_COLUMNS
      );
      if (!app) {
        return res.status(404).json({ error: 'App not found' });
      }
      const appId = app.id;
      const createdBy = app.created_by;

      // Active-user ids, via the shared definition. Non-fatal: if this
      // lookup fails we still return chat authors + creator.
      let activeIds = [];
      try {
        activeIds = await listActiveUserIds(pool, appId);
      } catch (err) {
        log.warn('chat', 'active-user lookup failed for mentions', { message: err.message });
      }

      const ids = [...new Set([
        ...activeIds,
        ...(createdBy != null ? [createdBy] : []),
      ])];

      // Sort case-insensitively (by lowercased username) so uppercase
      // names don't all sort before lowercase ones; the returned value
      // keeps the canonical/original casing. LOWER(u.username) must be in
      // the SELECT list because SELECT DISTINCT requires ORDER BY
      // expressions to appear there.
      const { rows } = await pool.query(
        `SELECT DISTINCT u.username, LOWER(u.username) AS sort_name
           FROM users u
          WHERE u.id = ANY($2::int[])
             OR u.id IN (
               SELECT m.user_id FROM chat_messages m
                WHERE m.app_id = $1 AND m.user_id IS NOT NULL
             )
          ORDER BY sort_name
          LIMIT 500`,
        [appId, ids]
      );

      res.json({ users: rows.map((r) => ({ username: r.username })) });
    } catch (err) {
      log.error('chat', 'Failed to load mention suggestions', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { chatRoutes };
