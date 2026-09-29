'use strict';
const { Router } = require('express');
const { getPool } = require('../db/pool');
const { adminMiddleware, requireAdminWrite } = require('../middleware/admin');
const { conversationReportLimiter } = require('../middleware/rate-limits');
const svc = require('../services/moderation');
const { attachmentDisposition } = require('../services/attachments');
const log = require('../services/logger');

function moderationRoutes(config, { pool = getPool(config) } = {}) {
  const router = Router();
  const run = (fn) => async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { await fn(req, res); }
    catch (err) {
      if (!(err instanceof svc.ModerationError)) log.error('moderation', 'Request failed', { message: err.message });
      if (res.headersSent) return;
      res.status(err.status || 500).json({ error: err.status ? err.message : 'Could not complete this request' });
    }
  };
  router.post('/api/reports', conversationReportLimiter, run(async (req, res) => {
    res.status(202).json(await svc.submitReport(pool, req.user, req.body));
  }));
  // Old clients use the same service/queue; do not leave two moderation systems.
  router.post('/api/conversations/:id/messages/:messageId/report', conversationReportLimiter, run(async (req, res) => {
    const { rows } = await pool.query('SELECT id FROM conversation_messages WHERE id = $1 AND conversation_id = $2', [svc.id(req.params.messageId), svc.id(req.params.id)]);
    if (!rows.length) throw new svc.ModerationError(404, 'Target unavailable');
    const result = await svc.submitReport(pool, req.user, { ...req.body, targetType: 'conversation_message', target: req.params.messageId });
    res.status(202).json({ ok: true, ...result });
  }));
  router.post(['/api/profiles/:username/report', '/api/users/:username/report'], conversationReportLimiter, run(async (req, res) => {
    const result = await svc.submitReport(pool, req.user, { ...req.body, targetType: 'user', target: req.params.username });
    res.status(202).json({ ok: true, ...result });
  }));
  router.post('/api/apps/:slug/report', conversationReportLimiter, run(async (req,res) => {
    const result = await svc.submitReport(pool,req.user,{ ...req.body,targetType:'app',target:req.params.slug });
    res.status(202).json({ ok:true,...result });
  }));
  router.post('/api/apps/:slug/messages/:id/report', conversationReportLimiter, run(async (req,res) => {
    const { rows } = await pool.query('SELECT m.id FROM chat_messages m JOIN apps a ON a.id = m.app_id WHERE m.id = $1 AND a.slug = $2', [svc.id(req.params.id),req.params.slug]);
    if (!rows.length) throw new svc.ModerationError(404,'Target unavailable');
    const result = await svc.submitReport(pool,req.user,{ ...req.body,targetType:'app_message',target:req.params.id });
    res.status(202).json({ ok:true,...result });
  }));
  // Compatibility for older admin clients: their decisions go through the
  // same versioned service and audit log. Never mutate the legacy queue alone.
  router.post(['/api/admin/profile-reports/:id/:action', '/api/admin/conversation-reports/:id/:action', '/api/admin/app-reports/:id/:action', '/api/admin/app-message-reports/:id/:action'], adminMiddleware, requireAdminWrite, run(async (req, res) => {
    const legacyType = req.path.includes('/profile-reports/') ? 'profile' : req.path.includes('/app-message-reports/') ? 'app_message' : req.path.includes('/app-reports/') ? 'app' : 'conversation';
    const action = req.params.action;
    if (!['resolve','dismiss'].includes(action)) throw new svc.ModerationError(404, 'Action unavailable');
    const { rows } = await pool.query(`SELECT c.id, c.revision FROM moderation_cases c JOIN moderation_reports r ON r.case_id = c.id WHERE r.legacy_type = $1 AND r.legacy_id = $2`, [legacyType,svc.id(req.params.id)]);
    if (!rows[0]) throw new svc.ModerationError(404, 'Report unavailable');
    const result = await svc.moderate(pool, req.user, rows[0].id, { action, revision:rows[0].revision, reason:req.body?.reason || 'Reviewed through the previous moderation screen' });
    res.json({ report: { id:req.params.id, status:result.status } });
  }));
  router.post('/api/admin/profiles/:username/moderation', adminMiddleware, requireAdminWrite, run(async (req,res) => {
    if (typeof req.body?.disabled !== 'boolean') throw new svc.ModerationError(400, 'disabled must be a boolean');
    const reason = svc.details(req.body?.reason, true);
    const { rows } = await pool.query('SELECT id, username FROM users WHERE username = $1', [req.params.username]);
    if (!rows[0]) throw new svc.ModerationError(404, 'User unavailable');
    await pool.query(`INSERT INTO moderation_cases (target_type,target_id,target_label,target_user_id) VALUES ('user',$1::integer,$2,$1::integer) ON CONFLICT (target_type,target_id) DO NOTHING`, [rows[0].id,'@'+rows[0].username]);
    const c = (await pool.query("SELECT id,revision FROM moderation_cases WHERE target_type = 'user' AND target_id = $1", [rows[0].id])).rows[0];
    await svc.moderate(pool, req.user, c.id, { action:req.body.disabled ? 'hide_profile' : 'restore_profile',reason,revision:c.revision });
    res.json({ ok:true, username:rows[0].username,disabled:req.body.disabled });
  }));
  router.get(['/api/admin/conversation-reports/:id/attachments/:attachmentId', '/api/admin/conversation-reports/:id/attachments/:attachmentId/view'], adminMiddleware, run(async (req,res) => {
    const { rows } = await pool.query(`SELECT f.filename, f.data FROM moderation_reports r JOIN moderation_report_files rf ON rf.report_id = r.id JOIN moderation_evidence_files f ON f.id = rf.file_id WHERE r.legacy_type = 'conversation' AND r.legacy_id = $1 AND f.source_type = 'conversation_message' AND f.source_id = $2 LIMIT 1`, [svc.id(req.params.id),req.params.attachmentId]);
    if (!rows[0]) throw new svc.ModerationError(404, 'Evidence unavailable');
    res.set('Content-Type','application/octet-stream');
    res.set('Content-Disposition',attachmentDisposition('attachment',rows[0].filename));
    res.set('X-Content-Type-Options','nosniff'); res.send(rows[0].data);
  }));
  router.use('/api/admin/moderation', adminMiddleware);
  router.get('/api/admin/moderation', run(async (req, res) => {
    const status = req.query.status || 'new';
    if (status !== 'all' && !svc.STATUSES.has(status)) throw new svc.ModerationError(400, 'Invalid status');
    const type = req.query.type || null, reason = req.query.reason || null;
    if (type && !svc.TYPES.has(type)) throw new svc.ModerationError(400, 'Invalid target type');
    if (reason && !svc.REASONS.has(reason)) throw new svc.ModerationError(400, 'Invalid reason');
    const since = req.query.since || null;
    if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new svc.ModerationError(400, 'Invalid date');
    if (since && (Number.isNaN(Date.parse(since)) || new Date(since).toISOString().slice(0,10) !== since)) throw new svc.ModerationError(400, 'Invalid date');
    const before = svc.id(req.query.before);
    const { rows } = await pool.query(
      `SELECT c.*, COUNT(r.id)::int AS report_count, ARRAY_AGG(DISTINCT r.reason) AS reasons
       FROM moderation_cases c LEFT JOIN moderation_reports r ON r.case_id = c.id
       WHERE ($1 = 'all' OR c.status = $1) AND ($2::text IS NULL OR c.target_type = $2)
         AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM moderation_reports mr WHERE mr.case_id = c.id AND mr.reason = $3))
         AND ($4::date IS NULL OR c.created_at >= $4::date)
         AND ($5::bigint IS NULL OR c.id < $5)
       GROUP BY c.id ORDER BY c.id DESC LIMIT 51`, [status, type, reason, since, before]);
    res.json({ cases: rows.slice(0,50), next: rows.length > 50 ? rows[49].id : null, canWrite: !!req.user.canAdminWrite });
  }));
  router.get('/api/admin/moderation/:id', run(async (req, res) => {
    const caseId = svc.id(req.params.id);
    if (!caseId) throw new svc.ModerationError(404, 'Case not found');
    const { rows } = await pool.query('SELECT c.*, u.username AS target_username FROM moderation_cases c LEFT JOIN users u ON u.id = c.target_user_id WHERE c.id = $1', [caseId]);
    const c = rows[0]; if (!c) throw new svc.ModerationError(404, 'Case not found');
    const reportBefore = svc.id(req.query.reportBefore), actionBefore = svc.id(req.query.actionBefore);
    const [reports, actions, files] = await Promise.all([
      pool.query(`SELECT r.*, u.username AS reporter FROM moderation_reports r LEFT JOIN users u ON u.id = r.reporter_user_id WHERE r.case_id = $1 AND ($2::bigint IS NULL OR r.id < $2) ORDER BY r.id DESC LIMIT 51`, [caseId,reportBefore]),
      pool.query(`SELECT a.*, u.username AS actor FROM moderation_actions a LEFT JOIN users u ON u.id = a.actor_id WHERE a.case_id = $1 AND ($2::bigint IS NULL OR a.id < $2) ORDER BY a.id DESC LIMIT 51`, [caseId,actionBefore]),
      pool.query(`SELECT r.id AS report_id, f.id, f.filename FROM moderation_reports r JOIN moderation_report_files rf ON rf.report_id = r.id JOIN moderation_evidence_files f ON f.id = rf.file_id WHERE r.id IN (SELECT id FROM moderation_reports WHERE case_id = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT 50) ORDER BY f.id`, [caseId,reportBefore]),
    ]);
    const review = await svc.reviewState(pool, c);
    res.json({ case: c, ...review, reports: reports.rows.slice(0,50), reportsNext: reports.rows.length > 50 ? reports.rows[49].id : null, actions: actions.rows.slice(0,50), actionsNext: actions.rows.length > 50 ? actions.rows[49].id : null, files: files.rows, availableActions: svc.ACTIONS[c.target_type], canWrite: !!req.user.canAdminWrite });
  }));
  router.get('/api/admin/moderation/:id/files/:fileId', run(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT f.filename, f.content_type, f.data FROM moderation_evidence_files f
       JOIN moderation_report_files rf ON rf.file_id = f.id JOIN moderation_reports r ON r.id = rf.report_id
       WHERE r.case_id = $1 AND f.id = $2 LIMIT 1`, [svc.id(req.params.id), svc.id(req.params.fileId)]);
    if (!rows.length) throw new svc.ModerationError(404, 'Evidence unavailable');
    // Untrusted HTML/SVG are downloads, never active content in the console.
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', attachmentDisposition('attachment', rows[0].filename));
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(rows[0].data);
  }));
  router.post('/api/admin/moderation/:id/actions', requireAdminWrite, run(async (req, res) => {
    const result = await svc.moderate(pool, req.user, svc.id(req.params.id), req.body);
    if (['suspend_app','restore_app'].includes(req.body.action)) {
      const app = await pool.query('SELECT a.id, a.slug FROM apps a JOIN moderation_cases c ON c.target_id = a.id WHERE c.id = $1', [result.id]);
      if (app.rows[0]) require('../services/app-access').invalidateVisibility(app.rows[0].id, app.rows[0].slug);
    }
    res.json(result);
    // Refresh existing clients without publishing private evidence or reasons.
    const ws = require('../services/ws');
    if (result.effect?.conversationId) {
      const { rows } = await pool.query("SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND status = 'member'", [result.effect.conversationId]);
      for (const row of rows) ws.pushToUser(row.user_id, { type: 'conversation_membership_changed', conversationId: result.effect.conversationId });
    }
    if (result.effect?.appId) ws.broadcast(result.effect.appId, { type: result.effect.suspended ? 'app_suspended' : 'moderation_changed' });
  }));
  return router;
}
module.exports = { moderationRoutes };
