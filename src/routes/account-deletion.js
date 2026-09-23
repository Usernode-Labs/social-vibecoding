'use strict';

const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { getPool } = require('../db/pool');
const { requireAdminWrite } = require('../middleware/admin');
const deletion = require('../services/account-deletion');
const cleanup = require('../services/account-deletion-cleanup');
const log = require('../services/logger');

function sendError(res, err) {
  if (err instanceof deletion.AccountDeletionError) return res.status(err.status).json({ error: err.message, code: err.code });
  log.error('account-deletion', 'Account deletion failed', { code: err.code || 'internal_error' });
  return res.status(500).json({ error: 'Account deletion could not be completed. Please try again.' });
}

function accountDeletionRoutes(config, { pool = getPool(config) } = {}) {
  const router = Router();
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: req => String(req.user.id), message: { error: 'Too many attempts. Try again in 15 minutes.' } });
  const browser = (req, res, next) => {
    if (!req.user || req.cliAuthenticated || !req.cookies?.session) {
      return res.status(401).json({ error: 'Sign in in your browser before deleting your account.' });
    }
    // A JSON-only mutation cannot be issued by a cross-origin HTML form.
    if (req.method === 'DELETE' && !req.is('application/json')) return res.status(415).json({ error: 'JSON required.' });
    next();
  };
  router.get('/api/auth/account-deletion', browser, async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT password_set FROM users WHERE id = $1', [req.user.id]);
      if (!rows.length) return res.status(401).json({ error: 'Sign in again.' });
      res.json({ passwordRequired: rows[0].password_set });
    } catch (err) { sendError(res, err); }
  });
  router.delete('/api/auth/account', browser, limiter, async (req, res) => {
    try {
      res.locals.accountDeletionResponse = true;
      const result = await deletion.deleteAccount(pool, {
        userId: req.user.id, actorId: req.user.id, mode: 'self',
        confirmation: req.body?.confirmation, password: req.body?.password, sessionToken: req.cookies.session,
      });
      res.clearCookie('session', { path: '/' });
      res.json(result);
      void cleanup.sweep(pool, config).catch(() => {});
    } catch (err) { sendError(res, err); }
  });

  router.get('/api/admin/account-deletions', requireAdminWrite, async (req, res) => {
    try { res.json({ deletions: await cleanup.list(pool) }); } catch (err) { sendError(res, err); }
  });
  router.post('/api/admin/account-deletions/:id/retry', requireAdminWrite, async (req, res) => {
    try {
      if (!/^[a-f0-9]{32}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid deletion.' });
      await pool.query(`UPDATE account_deletion_tasks SET next_attempt_at = NOW()
        WHERE deletion_id = $1 AND state = 'pending'`, [req.params.id]);
      res.json({ ok: true });
      void cleanup.sweep(pool, config).catch(() => {});
    } catch (err) { sendError(res, err); }
  });
  // Ambiguous provider creation must be reconciled with the provider first.
  // An admin supplies its discovered hash, or explicitly attests no key
  // exists; neither path silently repeats a non-idempotent creation request.
  router.post('/api/admin/account-deletions/:id/reconcile-key', requireAdminWrite, async (req, res) => {
    const { hash, noKeyExists, confirmation } = req.body || {};
    if (!/^[a-f0-9]{32}$/.test(req.params.id) || confirmation !== 'RECONCILED'
        || !(typeof hash === 'string' && /^[a-zA-Z0-9_-]{16,256}$/.test(hash) || noKeyExists === true)) {
      return res.status(400).json({ error: 'Verify the provider key, then confirm RECONCILED.' });
    }
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      if (hash) await deletion.queueTask(db, req.params.id, 'openrouter_key', hash);
      await db.query(`UPDATE account_deletion_tasks SET state = 'completed', completed_at = NOW(), target = 'erased:' || id
        WHERE deletion_id = $1 AND kind = 'key_reconciliation' AND state = 'review'`, [req.params.id]);
      await db.query('UPDATE account_deletions SET completed_at = NULL WHERE id = $1', [req.params.id]);
      await db.query('COMMIT');
      res.json({ ok: true });
      void cleanup.sweep(pool, config).catch(() => {});
    } catch (err) { await db.query('ROLLBACK').catch(() => {}); sendError(res, err); }
    finally { db.release(); }
  });
  return router;
}

module.exports = { accountDeletionRoutes, sendError };
