const express = require('express');
const crypto = require('crypto');
const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const models = require('../services/models');
const { listActiveUserIds } = require('../services/active-users');
const appAccess = require('../services/app-access');
const attachmentsSvc = require('../services/attachments');
const { attachmentUploadLimiter } = require('../middleware/rate-limits');

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
      // Reading chat history only needs view access (#621): anyone who
      // can see the app gets a read-only look at the dev surface.
      // Posting stays collab-gated at the WS layer (404 on deny so
      // private apps aren't enumerable).
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
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
               m.thread_type, m.thread_ref, m.created_at, m.edited_at
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

  // ── Group-chat file attachments (#694) ───────────────────────────
  //
  // Upload happens BEFORE send, mirroring dev-chat (#450,
  // src/routes/sessions.js): the client POSTs raw bytes here per file,
  // gets back an attachment id, and passes the ids on the WS 'chat'
  // message, whose handler links them to the message row. The body is
  // always application/octet-stream (real type derived server-side from
  // extension + magic-byte sniff), deliberately sidestepping the global
  // express.json() parser.
  router.post(
    '/api/apps/:slug/chat-attachments',
    attachmentUploadLimiter,
    // Limit must exceed the largest single-file cap (10 MB binaries).
    express.raw({ type: 'application/octet-stream', limit: '11mb' }),
    async (req, res) => {
      try {
        // Uploading is posting: same collab gate as the WS write path
        // (404 on deny so private apps aren't enumerable).
        const app = await appAccess.getAppForUser(
          pool, req.params.slug, req.user, 'collab', appAccess.ACCESS_COLUMNS
        );
        if (!app) return res.status(404).json({ error: 'App not found' });

        const filename = String(req.query.filename || '').trim();
        const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const verdict = attachmentsSvc.validateChatUpload({ filename, data });
        if (!verdict.ok) return res.status(400).json({ error: verdict.error });

        // Per-app storage cap — the retention bound for linked rows
        // (orphans are GC'd by the server.js sweeper after 24h).
        const { rows: sumRows } = await pool.query(
          `SELECT COALESCE(SUM(size_bytes), 0)::bigint AS total
             FROM chat_message_attachments WHERE app_id = $1`,
          [app.id]
        );
        if (Number(sumRows[0].total) + data.length > attachmentsSvc.MAX_APP_CHAT_BYTES) {
          return res.status(400).json({
            error: `This app's chat attachment storage is full (${Math.round(attachmentsSvc.MAX_APP_CHAT_BYTES / 1024 / 1024)} MB max)`,
          });
        }

        const id = crypto.randomBytes(16).toString('hex');
        await pool.query(
          `INSERT INTO chat_message_attachments
             (id, app_id, user_id, kind, filename, content_type, size_bytes, meta, data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [id, app.id, req.user.id, verdict.kind, filename, verdict.contentType, data.length,
           verdict.meta ? JSON.stringify(verdict.meta) : null, data]
        );
        return res.json({
          id, kind: verdict.kind, filename,
          contentType: verdict.contentType, sizeBytes: data.length,
          meta: verdict.meta || null,
        });
      } catch (err) {
        // express.raw over-limit bodies raise PayloadTooLargeError before
        // the handler runs; anything landing here is a genuine failure.
        log.error('chat', 'Chat attachment upload failed', { slug: req.params.slug, err: err.message });
        return res.status(500).json({ error: 'Upload failed' });
      }
    }
  );

  // Serve attachment bytes. View-gated like message history (#621 —
  // read-only viewers can download what they can read). Unlinked rows
  // (message_id NULL, upload not yet sent) are only readable by their
  // uploader. Rows are immutable and ids unguessable, so a long private
  // immutable cache is safe. Disposition/type rules: images render
  // inline with their stored type; markdown/html/text serve as
  // text/plain + attachment (stored text/html is NEVER sent inline from
  // this route — HTML only executes on the sandboxed /view route below);
  // binary serves as application/octet-stream + attachment.
  router.get('/api/apps/:slug/chat-attachments/:attId', async (req, res) => {
    const attId = String(req.params.attId || '');
    if (!/^[a-f0-9]{32}$/.test(attId)) return res.status(404).end();
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).end();
      const { rows } = await pool.query(
        `SELECT kind, filename, content_type, data, message_id, user_id
           FROM chat_message_attachments
          WHERE id = $1 AND app_id = $2`,
        [attId, app.id]
      );
      if (!rows.length) return res.status(404).end();
      const att = rows[0];
      if (att.message_id == null && att.user_id !== req.user?.id) {
        return res.status(404).end();
      }
      const safeName = String(att.filename || 'file').replace(/["\\\r\n]/g, '_');
      const inline = att.kind === 'image';
      const contentType = att.kind === 'image'
        ? (att.content_type || 'application/octet-stream')
        : (att.kind === 'binary' ? 'application/octet-stream' : 'text/plain; charset=utf-8');
      res.set('Content-Type', contentType);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`);
      res.set('Cache-Control', 'private, max-age=31536000, immutable');
      return res.send(att.data);
    } catch (err) {
      log.error('chat', 'Chat attachment serve failed', { attId, err: err.message });
      return res.status(500).end();
    }
  });

  // Sandboxed HTML preview (#694): serves an 'html' attachment as a real
  // text/html document under `Content-Security-Policy: sandbox
  // allow-scripts`. The document gets an OPAQUE origin — its scripts can
  // run, but cannot read platform cookies/localStorage or make
  // credentialed same-origin API calls (the SameSite=Lax session cookie
  // rides the top-level navigation that authenticates this GET, never
  // subresource/fetch requests from the opaque-origin document). Never
  // add allow-same-origin here.
  router.get('/api/apps/:slug/chat-attachments/:attId/view', async (req, res) => {
    const attId = String(req.params.attId || '');
    if (!/^[a-f0-9]{32}$/.test(attId)) return res.status(404).end();
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).end();
      const { rows } = await pool.query(
        `SELECT kind, filename, data, message_id, user_id
           FROM chat_message_attachments
          WHERE id = $1 AND app_id = $2`,
        [attId, app.id]
      );
      if (!rows.length || rows[0].kind !== 'html') return res.status(404).end();
      const att = rows[0];
      if (att.message_id == null && att.user_id !== req.user?.id) {
        return res.status(404).end();
      }
      const safeName = String(att.filename || 'file.html').replace(/["\\\r\n]/g, '_');
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Content-Security-Policy', 'sandbox allow-scripts');
      res.set('Referrer-Policy', 'no-referrer');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Disposition', `inline; filename="${safeName}"`);
      res.set('Cache-Control', 'private, max-age=31536000, immutable');
      return res.send(att.data);
    } catch (err) {
      log.error('chat', 'Chat attachment view failed', { attId, err: err.message });
      return res.status(500).end();
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
