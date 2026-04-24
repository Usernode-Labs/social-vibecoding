const { Router } = require('express');
const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { adminMiddleware } = require('../middleware/admin');
const log = require('../services/logger');

function adminRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.use('/api/admin', adminMiddleware);

  // ── Operations Overview ────────────────────────────────────
  //
  // A lightweight summary for the admin dashboard. The full tree lives on
  // `/status` (admin-gated sections there); this just surfaces the numbers
  // that warrant "something's wrong, go look" follow-up.
  router.get('/api/admin/overview', async (_req, res) => {
    try {
      const status = require('../services/status');
      const data = await status.gather(config, { isAdmin: true });

      const stuckApps = (data.apps || [])
        .filter((a) => a.dbStatus === 'creating' || a.dbStatus === 'error')
        .map((a) => ({
          id: a.id,
          name: a.name,
          slug: a.slug,
          dbStatus: a.dbStatus,
          createdBy: a.createdBy,
          createdAt: a.createdAt,
        }));

      const orphanWorkers = (data.workers || [])
        .filter((w) => w.orphan)
        .map((w) => ({
          name: w.name,
          sessionId: w.sessionId,
          appSlug: w.appSlug,
          uptimeSeconds: w.uptimeSeconds,
          sessionArchived: w.sessionArchived,
        }));

      const llmUsage = data.llmUsage || [];
      const totalSpendCents = llmUsage.reduce((sum, u) => sum + (u.costCents || 0), 0);

      res.json({
        stuckApps,
        orphanWorkers,
        llmToday: {
          totalSpendCents,
          users: llmUsage,
        },
      });
    } catch (err) {
      log.error('admin', 'Overview failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Users ──────────────────────────────────────────────────

  router.get('/api/admin/users', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT u.id, u.username, u.is_admin, u.created_at,
                ac.code as activation_code,
                COALESCE(lu.total_cost_cents, 0) as cost_today_cents
         FROM users u
         LEFT JOIN activation_codes ac ON ac.used_by = u.id
         LEFT JOIN llm_usage lu ON lu.user_id = u.id AND lu.date = CURRENT_DATE
         ORDER BY u.created_at ASC`
      );
      res.json(rows);
    } catch (err) {
      log.error('admin', 'List users failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/admin/users/:id', async (req, res) => {
    const userId = parseInt(req.params.id);

    if (userId === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }

    try {
      const result = await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      log.info('admin', 'User deleted', { id: userId, by: req.user.username });
      res.json({ ok: true });
    } catch (err) {
      log.error('admin', 'Delete user failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Activation Codes ───────────────────────────────────────

  router.get('/api/admin/codes', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT ac.id, ac.code, ac.created_at, ac.used_at,
                u.username as used_by_username
         FROM activation_codes ac
         LEFT JOIN users u ON u.id = ac.used_by
         ORDER BY ac.created_at DESC`
      );
      res.json(rows);
    } catch (err) {
      log.error('admin', 'List codes failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/admin/codes', async (req, res) => {
    try {
      const code = crypto.randomBytes(6).toString('hex');
      const { rows } = await pool.query(
        'INSERT INTO activation_codes (code) VALUES ($1) RETURNING id, code, created_at',
        [code]
      );
      log.info('admin', 'Activation code created', { code, by: req.user.username });
      res.json(rows[0]);
    } catch (err) {
      log.error('admin', 'Create code failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/admin/codes/:id', async (req, res) => {
    const codeId = parseInt(req.params.id);
    try {
      const result = await pool.query('DELETE FROM activation_codes WHERE id = $1 AND used_by IS NULL', [codeId]);
      if (result.rowCount === 0) {
        return res.status(400).json({ error: 'Code not found or already used' });
      }
      log.info('admin', 'Activation code deleted', { id: codeId, by: req.user.username });
      res.json({ ok: true });
    } catch (err) {
      log.error('admin', 'Delete code failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { adminRoutes };
