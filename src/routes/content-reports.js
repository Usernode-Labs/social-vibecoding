'use strict';

// Private reports for mini-apps and their Workshop discussion posts. Message
// reports snapshot what the reporter saw; edits and target deletion cannot
// rewrite the evidence an admin later reviews.
const { Router } = require('express');
const { getPool } = require('../db/pool');
const appAccess = require('../services/app-access');
const { adminMiddleware, requireAdminWrite } = require('../middleware/admin');
const { contentReportLimiter } = require('../middleware/rate-limits');
const log = require('../services/logger');

const APP_REASONS = new Set(['spam', 'harassment', 'unsafe_content', 'impersonation', 'other']);
const MESSAGE_REASONS = new Set(['harassment', 'spam', 'threats', 'hate', 'sexual_content', 'other']);
const STATUSES = new Set(['pending', 'resolved', 'dismissed']);
const NO_STORE = 'private, no-store, max-age=0';

function reportInput(body, reasons) {
  if (!reasons.has(body?.reason)) return { error: 'Invalid report reason' };
  const raw = body.detail;
  if (raw != null && typeof raw !== 'string') return { error: 'detail must be a string' };
  const detail = (raw || '').normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if (/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/u.test(detail)
      || Array.from(detail).length > 500) {
    return { error: 'detail must be at most 500 characters without control characters' };
  }
  return { reason: body.reason, detail: detail || null };
}

function reportId(value) {
  return /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value))
    ? Number(value) : null;
}

function contentReportRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  async function visibleApp(req) {
    const app = await appAccess.getAppForUser(
      pool, req.params.slug, req.user, 'view', `${appAccess.ACCESS_COLUMNS}, name`
    );
    return app && (!app.self_hosted || req.user?.isAdmin || config.selfAppPublicVoting)
      ? app : null;
  }

  router.post('/api/apps/:slug/report', contentReportLimiter, async (req, res) => {
    res.set('Cache-Control', NO_STORE);
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const input = reportInput(req.body, APP_REASONS);
    if (input.error) return res.status(400).json({ error: input.error });
    try {
      const app = await visibleApp(req);
      if (!app) return res.status(404).json({ error: 'App not found' });
      if (Number(app.created_by) === Number(req.user.id)) {
        return res.status(400).json({ error: 'You cannot report your own app' });
      }
      await pool.query(
        `INSERT INTO app_reports
           (app_id, reporter_user_id, app_slug_snapshot, app_name_snapshot, reason, detail)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (app_id, reporter_user_id) WHERE status = 'pending' DO NOTHING`,
        [app.id, req.user.id, app.slug, app.name, input.reason, input.detail]
      );
      return res.status(202).json({ ok: true });
    } catch (err) {
      log.error('reports', 'App report failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/apps/:slug/messages/:id/report', contentReportLimiter, async (req, res) => {
    res.set('Cache-Control', NO_STORE);
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const id = reportId(req.params.id);
    if (!id) return res.status(404).json({ error: 'Message not found' });
    const input = reportInput(req.body, MESSAGE_REASONS);
    if (input.error) return res.status(400).json({ error: input.error });
    let client;
    try {
      const app = await visibleApp(req);
      if (!app) return res.status(404).json({ error: 'Message not found' });
      client = await pool.connect();
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT id, user_id, content, metadata, msg_type, thread_type,
                thread_ref, created_at, edited_at, posted_via
           FROM chat_messages WHERE id = $1 AND app_id = $2 FOR SHARE`,
        [id, app.id]
      );
      const message = rows[0];
      if (!message || message.msg_type !== 'message' || !message.user_id
          || Number(message.user_id) === Number(req.user.id)) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Message not found' });
      }
      const attachments = await client.query(
        `SELECT id, kind, filename, content_type, size_bytes
           FROM chat_message_attachments WHERE message_id = $1
          ORDER BY created_at, id`, [id]
      );
      await client.query(
        `INSERT INTO chat_message_reports
           (app_id, message_id, reporter_user_id, reported_user_id,
            app_slug_snapshot, reason, detail, content_snapshot, evidence_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (message_id, reporter_user_id) WHERE status = 'pending' DO NOTHING`,
        [app.id, id, req.user.id, message.user_id, app.slug,
          input.reason, input.detail, message.content, JSON.stringify({
            metadata: message.metadata, threadType: message.thread_type,
            threadRef: message.thread_ref, createdAt: message.created_at,
            editedAt: message.edited_at, postedVia: message.posted_via,
            attachments: attachments.rows.map((a) => ({
              id: a.id, kind: a.kind, name: a.filename,
              contentType: a.content_type, sizeBytes: a.size_bytes,
            })),
          })]
      );
      await client.query('COMMIT');
      return res.status(202).json({ ok: true });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      log.error('reports', 'App message report failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    } finally {
      if (client) client.release();
    }
  });

  router.get('/api/admin/app-reports', adminMiddleware, async (req, res) => {
    res.set('Cache-Control', NO_STORE);
    const status = STATUSES.has(req.query.status) ? req.query.status : 'pending';
    try {
      const { rows } = await pool.query(
        `SELECT r.id, r.app_id, r.app_slug_snapshot, r.app_name_snapshot,
                r.reason, r.detail, r.status, r.created_at, r.resolved_at,
                reporter.username AS reporter_username,
                resolver.username AS resolved_by_username
           FROM app_reports r
           LEFT JOIN users reporter ON reporter.id = r.reporter_user_id
           LEFT JOIN users resolver ON resolver.id = r.resolved_by
          WHERE r.status = $1 ORDER BY r.created_at ASC, r.id ASC LIMIT 200`,
        [status]
      );
      return res.json({ reports: rows });
    } catch (err) {
      log.error('reports', 'App report queue failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/admin/app-message-reports', adminMiddleware, async (req, res) => {
    res.set('Cache-Control', NO_STORE);
    const status = STATUSES.has(req.query.status) ? req.query.status : 'pending';
    try {
      const { rows } = await pool.query(
        `SELECT r.id, r.app_id, r.message_id, r.app_slug_snapshot,
                r.reason, r.detail, r.content_snapshot, r.evidence_snapshot,
                r.status, r.created_at, r.resolved_at,
                reporter.username AS reporter_username,
                reported.username AS reported_username,
                resolver.username AS resolved_by_username
           FROM chat_message_reports r
           LEFT JOIN users reporter ON reporter.id = r.reporter_user_id
           LEFT JOIN users reported ON reported.id = r.reported_user_id
           LEFT JOIN users resolver ON resolver.id = r.resolved_by
          WHERE r.status = $1 ORDER BY r.created_at ASC, r.id ASC LIMIT 200`,
        [status]
      );
      return res.json({ reports: rows });
    } catch (err) {
      log.error('reports', 'App message report queue failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  for (const path of [
    '/api/admin/app-reports/:id/:action',
    '/api/admin/app-message-reports/:id/:action',
  ]) {
    router.post(path, adminMiddleware, requireAdminWrite, async (req, res) => {
      res.set('Cache-Control', NO_STORE);
      const id = reportId(req.params.id);
      const status = req.params.action === 'resolve' ? 'resolved'
        : req.params.action === 'dismiss' ? 'dismissed' : null;
      if (!id || !status) return res.status(404).json({ error: 'Pending report not found' });
      try {
        const params = [status, req.user.id, id];
        const { rows } = path.includes('app-message-reports')
          ? await pool.query(
            `UPDATE chat_message_reports
                SET status = $1, resolved_at = NOW(), resolved_by = $2
              WHERE id = $3 AND status = 'pending'
              RETURNING id, status, resolved_at`, params
          )
          : await pool.query(
            `UPDATE app_reports
                SET status = $1, resolved_at = NOW(), resolved_by = $2
              WHERE id = $3 AND status = 'pending'
              RETURNING id, status, resolved_at`, params
          );
        return rows.length ? res.json({ report: rows[0] })
          : res.status(404).json({ error: 'Pending report not found' });
      } catch (err) {
        log.error('reports', 'Report moderation failed', { message: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    });
  }

  return router;
}

module.exports = { contentReportRoutes, reportInput };
