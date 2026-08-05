'use strict';

const { Router } = require('express');
const { getPool } = require('../db/pool');
const appAccess = require('../services/app-access');
const log = require('../services/logger');
const {
  directMessageSendLimiter,
  directMessageActionLimiter,
} = require('../middleware/rate-limits');

const MAX_ID = 2147483647;
const MAX_MESSAGE_LEN = 2000;
const MAX_REPORT_LEN = 1000;

function parseId(value) {
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id <= MAX_ID ? id : null;
}

function parsePage(query, defaultLimit = 50) {
  let limit = defaultLimit;
  if (query.limit != null) {
    if (!/^[1-9]\d*$/.test(String(query.limit))) return null;
    limit = Number(query.limit);
    if (!Number.isSafeInteger(limit)) return null;
    limit = Math.min(limit, 100);
  }
  let before = null;
  if (query.before != null) {
    before = parseId(query.before);
    if (before == null) return null;
  }
  return { limit, before };
}

function normalizeUsername(value) {
  if (typeof value !== 'string' || !value || value.length > 255) return null;
  // Exact means exact: do not trim, case-fold or fuzzy-match the account key.
  if (value.trim() !== value || value.includes('\0')) return null;
  return value;
}

function orderedPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

async function withTransaction(pool, fn) {
  const cx = await pool.connect();
  try {
    await cx.query('BEGIN');
    const result = await fn(cx);
    await cx.query('COMMIT');
    return result;
  } catch (err) {
    try { await cx.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    cx.release();
  }
}

async function lockPair(cx, appId, lowId, highId) {
  // One stable 64-bit advisory key serializes request/accept/block/send for
  // the pair. Hash collisions merely serialize unrelated pairs; they cannot
  // weaken correctness.
  await cx.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`dm:${appId}:${lowId}:${highId}`]
  );
}

async function hasEitherBlock(cx, appId, lowId, highId) {
  const { rows } = await cx.query(
    `SELECT 1 FROM direct_message_blocks
      WHERE app_id = $1
        AND ((blocker_id = $2 AND blocked_user_id = $3)
          OR (blocker_id = $3 AND blocked_user_id = $2))
      LIMIT 1`,
    [appId, lowId, highId]
  );
  return rows.length > 0;
}

async function loadUsers(cx, ids) {
  const { rows } = await cx.query(
    `SELECT id, username, is_admin, admin_readonly
       FROM users WHERE id = ANY($1::int[])`,
    [ids]
  );
  return new Map(rows.map((row) => [row.id, {
    id: row.id,
    username: row.username,
    isAdmin: !!row.is_admin,
    adminReadonly: !!row.admin_readonly,
    canAdminWrite: !!row.is_admin && !row.admin_readonly,
  }]));
}

async function participantsCanCollaborate(cx, appId, lowId, highId) {
  // Reload current visibility under a row lock inside the pair transaction.
  // A public→private change racing a request/send must not inherit the stale
  // public row resolved by the outer HTTP gate.
  const { rows: apps } = await cx.query(
    `SELECT ${appAccess.ACCESS_COLUMNS} FROM apps WHERE id = $1 FOR SHARE`,
    [appId]
  );
  const app = apps[0];
  if (!app) return false;
  const users = await loadUsers(cx, [lowId, highId]);
  if (!users.has(lowId) || !users.has(highId)) return false;
  return (await appAccess.checkAppAccess(cx, app, users.get(lowId), 'collab'))
    && (await appAccess.checkAppAccess(cx, app, users.get(highId), 'collab'));
}

function serializeConversation(row, viewerId) {
  return {
    id: row.id,
    otherUser: { username: row.other_username },
    status: row.status,
    requestedByMe: row.requested_by === viewerId,
    requiresAction: row.status === 'pending' && row.requested_by !== viewerId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acceptedAt: row.accepted_at || null,
  };
}

function serializeMessage(row, viewerId) {
  return {
    id: row.id,
    sender: row.sender_username ? { username: row.sender_username } : null,
    isMine: row.sender_id === viewerId,
    content: row.deleted_at ? null : row.content,
    deleted: !!row.deleted_at,
    createdAt: row.created_at,
    deletedAt: row.deleted_at || null,
  };
}

function unavailable(res) {
  return res.status(404).json({ error: 'Resource not found' });
}

async function resolveDmApp(pool, req, res) {
  if (!req.user?.id) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  const app = await appAccess.getAppForUser(
    pool, req.params.slug, req.user, 'collab', appAccess.ACCESS_COLUMNS
  );
  if (!app) unavailable(res);
  return app;
}

function directMessageRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Keep every response non-sniffable JSON. This API never renders or
  // accepts HTML; clients must use textContent/their normal escaping layer.
  router.use('/api/apps/:slug/direct-conversations', (_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, no-store');
    next();
  });
  router.use('/api/apps/:slug/direct-blocks', (_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, no-store');
    next();
  });
  router.use('/api/admin/direct-message-reports', (_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, no-store');
    next();
  });

  router.get('/api/apps/:slug/direct-conversations', async (req, res) => {
    const page = parsePage(req.query);
    if (!page) return res.status(400).json({ error: 'Invalid pagination' });
    try {
      const app = await resolveDmApp(pool, req, res);
      if (!app) return undefined;
      const params = [app.id, req.user.id];
      const beforeSql = page.before == null ? '' : ` AND dc.id < $${params.push(page.before)}`;
      params.push(page.limit);
      const { rows } = await pool.query(
        `SELECT dc.id, dc.requested_by, dc.status, dc.accepted_at,
                dc.created_at, dc.updated_at,
                other.username AS other_username
           FROM direct_conversations dc
           JOIN users other ON other.id = CASE
             WHEN dc.user_low_id = $2 THEN dc.user_high_id ELSE dc.user_low_id END
          WHERE dc.app_id = $1
            AND (dc.user_low_id = $2 OR dc.user_high_id = $2)
            ${beforeSql}
          ORDER BY dc.id DESC
          LIMIT $${params.length}`,
        params
      );
      const conversations = rows.map((row) => serializeConversation(row, req.user.id));
      return res.json({
        conversations,
        nextBefore: rows.length === page.limit ? rows[rows.length - 1].id : null,
      });
    } catch (err) {
      log.error('direct-messages', 'conversation list failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post(
    '/api/apps/:slug/direct-conversations',
    directMessageActionLimiter,
    async (req, res) => {
      try {
        const app = await resolveDmApp(pool, req, res);
        if (!app) return undefined;
        const username = normalizeUsername(req.body?.username);
        if (!username) return res.status(400).json({ error: 'An exact username is required' });

        const { rows: recipientRows } = await pool.query(
          `SELECT id, username, is_admin, admin_readonly
             FROM users WHERE username = $1`,
          [username]
        );
        const recipient = recipientRows[0];
        if (!recipient || recipient.id === req.user.id) return unavailable(res);
        const [lowId, highId] = orderedPair(req.user.id, recipient.id);

        const outcome = await withTransaction(pool, async (cx) => {
          await lockPair(cx, app.id, lowId, highId);
          if (!(await participantsCanCollaborate(cx, app.id, lowId, highId))) return null;
          if (await hasEitherBlock(cx, app.id, lowId, highId)) return null;

          const { rows: existingRows } = await cx.query(
            `SELECT * FROM direct_conversations
              WHERE app_id = $1 AND user_low_id = $2 AND user_high_id = $3
              FOR UPDATE`,
            [app.id, lowId, highId]
          );
          let row = existingRows[0];
          if (!row) {
            const inserted = await cx.query(
              `INSERT INTO direct_conversations
                 (app_id, user_low_id, user_high_id, requested_by)
               VALUES ($1, $2, $3, $4) RETURNING *`,
              [app.id, lowId, highId, req.user.id]
            );
            row = inserted.rows[0];
          } else if (row.status === 'pending' && row.requested_by !== req.user.id) {
            const accepted = await cx.query(
              `UPDATE direct_conversations
                  SET status = 'accepted', accepted_at = NOW(), updated_at = NOW()
                WHERE id = $1 RETURNING *`,
              [row.id]
            );
            row = accepted.rows[0];
          } else if (row.status === 'declined') {
            return null;
          }
          return row;
        });
        if (!outcome) return unavailable(res);
        outcome.other_username = recipient.username;
        return res.status(outcome.status === 'pending' ? 201 : 200).json({
          conversation: serializeConversation(outcome, req.user.id),
        });
      } catch (err) {
        log.error('direct-messages', 'conversation request failed', { message: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  router.post(
    '/api/apps/:slug/direct-conversations/:id/respond',
    directMessageActionLimiter,
    async (req, res) => {
      const id = parseId(req.params.id);
      if (id == null || !['accept', 'decline'].includes(req.body?.action)) {
        return res.status(400).json({ error: 'Invalid response' });
      }
      try {
        const app = await resolveDmApp(pool, req, res);
        if (!app) return undefined;
        const outcome = await withTransaction(pool, async (cx) => {
          const first = await cx.query(
            `SELECT * FROM direct_conversations
              WHERE id = $1 AND app_id = $2
                AND (user_low_id = $3 OR user_high_id = $3)`,
            [id, app.id, req.user.id]
          );
          const initial = first.rows[0];
          if (!initial) return null;
          await lockPair(cx, app.id, initial.user_low_id, initial.user_high_id);
          const current = await cx.query(
            `SELECT * FROM direct_conversations WHERE id = $1 FOR UPDATE`, [id]
          );
          const row = current.rows[0];
          if (!row || row.status !== 'pending' || row.requested_by === req.user.id) return null;
          if (await hasEitherBlock(cx, app.id, row.user_low_id, row.user_high_id)) return null;
          if (req.body.action === 'accept'
              && !(await participantsCanCollaborate(cx, app.id, row.user_low_id, row.user_high_id))) {
            return null;
          }
          const status = req.body.action === 'accept' ? 'accepted' : 'declined';
          const updated = await cx.query(
            `UPDATE direct_conversations
                SET status = $1,
                    accepted_at = CASE WHEN $1 = 'accepted' THEN NOW() ELSE NULL END,
                    updated_at = NOW()
              WHERE id = $2 RETURNING *`,
            [status, id]
          );
          return updated.rows[0];
        });
        if (!outcome) return unavailable(res);
        const otherId = outcome.user_low_id === req.user.id
          ? outcome.user_high_id : outcome.user_low_id;
        const users = await loadUsers(pool, [otherId]);
        outcome.other_username = users.get(otherId)?.username || 'deleted-user';
        return res.json({ conversation: serializeConversation(outcome, req.user.id) });
      } catch (err) {
        log.error('direct-messages', 'conversation response failed', { message: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  router.get('/api/apps/:slug/direct-conversations/:id/messages', async (req, res) => {
    const id = parseId(req.params.id);
    const page = parsePage(req.query);
    if (id == null || !page) return res.status(400).json({ error: 'Invalid request' });
    try {
      const app = await resolveDmApp(pool, req, res);
      if (!app) return undefined;
      const { rows: conversations } = await pool.query(
        `SELECT 1 FROM direct_conversations
          WHERE id = $1 AND app_id = $2 AND status = 'accepted'
            AND (user_low_id = $3 OR user_high_id = $3)`,
        [id, app.id, req.user.id]
      );
      if (!conversations.length) return unavailable(res);
      const params = [id];
      const beforeSql = page.before == null ? '' : ` AND dm.id < $${params.push(page.before)}`;
      params.push(page.limit);
      const { rows } = await pool.query(
        `SELECT dm.id, dm.sender_id, u.username AS sender_username,
                dm.content, dm.created_at, dm.deleted_at
           FROM direct_messages dm
           LEFT JOIN users u ON u.id = dm.sender_id
          WHERE dm.conversation_id = $1 ${beforeSql}
          ORDER BY dm.id DESC LIMIT $${params.length}`,
        params
      );
      return res.json({
        messages: rows.reverse().map((row) => serializeMessage(row, req.user.id)),
        nextBefore: rows.length === page.limit ? rows[0].id : null,
      });
    } catch (err) {
      log.error('direct-messages', 'message list failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post(
    '/api/apps/:slug/direct-conversations/:id/messages',
    directMessageSendLimiter,
    async (req, res) => {
      const id = parseId(req.params.id);
      if (id == null) return res.status(400).json({ error: 'Invalid conversation' });
      try {
        const app = await resolveDmApp(pool, req, res);
        if (!app) return undefined;
        if (typeof req.body?.content !== 'string') {
          return res.status(400).json({ error: 'A message is required' });
        }
        const content = req.body.content.trim();
        if (!content || content.length > MAX_MESSAGE_LEN || content.includes('\0')) {
          return res.status(400).json({ error: `Messages must be 1-${MAX_MESSAGE_LEN} characters` });
        }
        const row = await withTransaction(pool, async (cx) => {
          const first = await cx.query(
            `SELECT * FROM direct_conversations
              WHERE id = $1 AND app_id = $2
                AND (user_low_id = $3 OR user_high_id = $3)`,
            [id, app.id, req.user.id]
          );
          const initial = first.rows[0];
          if (!initial) return null;
          await lockPair(cx, app.id, initial.user_low_id, initial.user_high_id);
          const current = await cx.query(
            `SELECT * FROM direct_conversations WHERE id = $1 FOR UPDATE`, [id]
          );
          const conversation = current.rows[0];
          if (!conversation || conversation.status !== 'accepted') return null;
          if (await hasEitherBlock(
            cx, app.id, conversation.user_low_id, conversation.user_high_id
          )) return null;
          if (!(await participantsCanCollaborate(
            cx, app.id, conversation.user_low_id, conversation.user_high_id
          ))) return null;
          const inserted = await cx.query(
            `INSERT INTO direct_messages (conversation_id, sender_id, content)
             VALUES ($1, $2, $3)
             RETURNING id, sender_id, content, created_at, deleted_at`,
            [id, req.user.id, content]
          );
          await cx.query('UPDATE direct_conversations SET updated_at = NOW() WHERE id = $1', [id]);
          return inserted.rows[0];
        });
        if (!row) return unavailable(res);
        row.sender_username = req.user.username;
        return res.status(201).json({ message: serializeMessage(row, req.user.id) });
      } catch (err) {
        log.error('direct-messages', 'message send failed', { message: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  router.delete(
    '/api/apps/:slug/direct-conversations/:id/messages/:messageId',
    directMessageActionLimiter,
    async (req, res) => {
      const id = parseId(req.params.id);
      const messageId = parseId(req.params.messageId);
      if (id == null || messageId == null) return res.status(400).json({ error: 'Invalid request' });
      try {
        const app = await resolveDmApp(pool, req, res);
        if (!app) return undefined;
        const result = await withTransaction(pool, async (cx) => {
          const { rows } = await cx.query(
            `SELECT dm.id, dm.sender_id, dm.deleted_at
               FROM direct_messages dm
               JOIN direct_conversations dc ON dc.id = dm.conversation_id
              WHERE dm.id = $1 AND dc.id = $2 AND dc.app_id = $3
                AND (dc.user_low_id = $4 OR dc.user_high_id = $4)
              FOR UPDATE OF dm`,
            [messageId, id, app.id, req.user.id]
          );
          const row = rows[0];
          if (!row || row.sender_id !== req.user.id) return false;
          if (!row.deleted_at) {
            await cx.query(
              `UPDATE direct_messages SET content = NULL, deleted_at = NOW() WHERE id = $1`,
              [messageId]
            );
          }
          return true;
        });
        if (!result) return unavailable(res);
        return res.status(204).end();
      } catch (err) {
        log.error('direct-messages', 'message deletion failed', { message: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  router.post(
    '/api/apps/:slug/direct-conversations/:id/reports',
    directMessageActionLimiter,
    async (req, res) => {
      const id = parseId(req.params.id);
      const messageId = req.body?.messageId == null ? null : parseId(req.body.messageId);
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      if (id == null || (req.body?.messageId != null && messageId == null)
          || !reason || reason.length > MAX_REPORT_LEN || reason.includes('\0')) {
        return res.status(400).json({ error: 'Invalid report' });
      }
      try {
        const app = await resolveDmApp(pool, req, res);
        if (!app) return undefined;
        const report = await withTransaction(pool, async (cx) => {
          const { rows: conversations } = await cx.query(
            `SELECT * FROM direct_conversations
              WHERE id = $1 AND app_id = $2
                AND (user_low_id = $3 OR user_high_id = $3)`,
            [id, app.id, req.user.id]
          );
          if (!conversations.length) return null;
          let reportedSenderId = null;
          let reportedContent = null;
          if (messageId != null) {
            const { rows: messages } = await cx.query(
              `SELECT sender_id, content FROM direct_messages
                WHERE id = $1 AND conversation_id = $2 FOR SHARE`,
              [messageId, id]
            );
            if (!messages.length) return null;
            reportedSenderId = messages[0].sender_id;
            reportedContent = messages[0].content;
          }
          const inserted = await cx.query(
            `INSERT INTO direct_message_reports
               (app_id, conversation_id, message_id, reporter_id,
                reported_sender_id, reported_content, reason)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, created_at`,
            [app.id, id, messageId, req.user.id, reportedSenderId, reportedContent, reason]
          );
          return inserted.rows[0];
        });
        if (!report) return unavailable(res);
        return res.status(201).json({ report: { id: report.id, createdAt: report.created_at } });
      } catch (err) {
        log.error('direct-messages', 'report creation failed', { message: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  router.post(
    '/api/apps/:slug/direct-blocks',
    directMessageActionLimiter,
    async (req, res) => {
      try {
        const app = await resolveDmApp(pool, req, res);
        if (!app) return undefined;
        const username = normalizeUsername(req.body?.username);
        if (!username) return res.status(400).json({ error: 'An exact username is required' });
        const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
        const target = rows[0];
        if (target && target.id !== req.user.id) {
          const [lowId, highId] = orderedPair(req.user.id, target.id);
          await withTransaction(pool, async (cx) => {
            await lockPair(cx, app.id, lowId, highId);
            const hasConversation = await cx.query(
              `SELECT 1 FROM direct_conversations
                WHERE app_id = $1 AND user_low_id = $2 AND user_high_id = $3`,
              [app.id, lowId, highId]
            );
            const eligible = hasConversation.rows.length
              || await participantsCanCollaborate(cx, app.id, lowId, highId);
            if (eligible) {
              await cx.query(
                `INSERT INTO direct_message_blocks (app_id, blocker_id, blocked_user_id)
                 VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
                [app.id, req.user.id, target.id]
              );
            }
          });
        }
        // Idempotent and deliberately identical for absent/ineligible users.
        return res.status(204).end();
      } catch (err) {
        log.error('direct-messages', 'block failed', { message: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  router.delete(
    '/api/apps/:slug/direct-blocks/:username',
    directMessageActionLimiter,
    async (req, res) => {
      try {
        const app = await resolveDmApp(pool, req, res);
        if (!app) return undefined;
        const username = normalizeUsername(req.params.username);
        if (username) {
          const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
          const target = rows[0];
          if (target && target.id !== req.user.id) {
            const [lowId, highId] = orderedPair(req.user.id, target.id);
            await withTransaction(pool, async (cx) => {
              await lockPair(cx, app.id, lowId, highId);
              await cx.query(
                `DELETE FROM direct_message_blocks
                  WHERE app_id = $1 AND blocker_id = $2 AND blocked_user_id = $3`,
                [app.id, req.user.id, target.id]
              );
            });
          }
        }
        return res.status(204).end();
      } catch (err) {
        log.error('direct-messages', 'unblock failed', { message: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  router.get('/api/admin/direct-message-reports', async (req, res) => {
    if (!req.user?.canAdminWrite) return res.status(403).json({ error: 'Admin access required' });
    const page = parsePage(req.query);
    if (!page) return res.status(400).json({ error: 'Invalid pagination' });
    try {
      const params = [];
      const beforeSql = page.before == null ? '' : `WHERE dmr.id < $${params.push(page.before)}`;
      params.push(page.limit);
      const { rows } = await pool.query(
        `SELECT dmr.id, dmr.app_id, a.slug AS app_slug, dmr.conversation_id,
                dmr.message_id, reporter.username AS reporter_username,
                reported.username AS reported_username, dmr.reported_content,
                dmr.reason, dmr.status, dmr.created_at, dmr.resolved_at
           FROM direct_message_reports dmr
           JOIN apps a ON a.id = dmr.app_id
           LEFT JOIN users reporter ON reporter.id = dmr.reporter_id
           LEFT JOIN users reported ON reported.id = dmr.reported_sender_id
           ${beforeSql}
          ORDER BY dmr.id DESC LIMIT $${params.length}`,
        params
      );
      return res.json({
        reports: rows,
        nextBefore: rows.length === page.limit ? rows[rows.length - 1].id : null,
      });
    } catch (err) {
      log.error('direct-messages', 'report list failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.patch(
    '/api/admin/direct-message-reports/:id',
    directMessageActionLimiter,
    async (req, res) => {
      if (!req.user?.canAdminWrite) return res.status(403).json({ error: 'Admin access required' });
      const id = parseId(req.params.id);
      const status = req.body?.status;
      if (id == null || !['resolved', 'dismissed'].includes(status)) {
        return res.status(400).json({ error: 'Invalid report resolution' });
      }
      try {
        const { rows } = await pool.query(
          `UPDATE direct_message_reports SET status = $1, resolved_at = NOW()
            WHERE id = $2 RETURNING id, status, resolved_at`,
          [status, id]
        );
        if (!rows.length) return unavailable(res);
        return res.json({ report: rows[0] });
      } catch (err) {
        log.error('direct-messages', 'report resolution failed', { message: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  return router;
}

module.exports = {
  directMessageRoutes,
  parseId,
  parsePage,
  normalizeUsername,
  orderedPair,
  serializeConversation,
  serializeMessage,
  MAX_MESSAGE_LEN,
  MAX_REPORT_LEN,
};
