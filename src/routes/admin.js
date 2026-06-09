const { Router } = require('express');
const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { adminMiddleware } = require('../middleware/admin');
const log = require('../services/logger');
const limits = require('../services/limits');

// Fixed app-wide key for pg_advisory_xact_lock, dedicated to admin-status
// mutations (revoke-admin and delete-user). Any code path that could drop
// the admin count must take this lock inside its transaction so the
// "at least one admin must remain" invariant is checked and committed
// atomically — two concurrent revokes/deletes can't both observe >1 admin
// and race to zero. The number is arbitrary but must stay stable.
const ADMIN_MUTATION_LOCK = 991001;

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
        `SELECT u.id, u.username, u.is_admin, u.can_create_apps, u.created_at,
                u.daily_limit_cents,
                (u.id = $1) AS is_self,
                ac.code as activation_code,
                COALESCE(lu.total_cost_cents, 0) as cost_today_cents
         FROM users u
         LEFT JOIN activation_codes ac ON ac.used_by = u.id
         LEFT JOIN llm_usage lu ON lu.user_id = u.id AND lu.date = CURRENT_DATE
         ORDER BY u.created_at ASC`,
        [req.user.id]
      );
      res.json(rows);
    } catch (err) {
      log.error('admin', 'List users failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Toggle the per-user app-creation permission (see users.can_create_apps
  // in schema.sql). Default for every user is FALSE — set TRUE here to
  // allow them to create apps. Admins are included; there is no bypass.
  router.post('/api/admin/users/:id/can-create-apps', async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const { canCreateApps } = req.body || {};
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    if (typeof canCreateApps !== 'boolean') {
      return res.status(400).json({ error: 'canCreateApps (boolean) required in body' });
    }
    try {
      const { rows } = await pool.query(
        `UPDATE users SET can_create_apps = $1 WHERE id = $2
         RETURNING id, username, can_create_apps`,
        [canCreateApps, userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'User not found' });
      log.info('admin', 'App-creation permission toggled', {
        id: rows[0].id, username: rows[0].username,
        canCreateApps: rows[0].can_create_apps, by: req.user.username,
      });
      res.json({ ok: true, canCreateApps: rows[0].can_create_apps });
    } catch (err) {
      log.error('admin', 'App-creation toggle failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Grant / revoke admin status (see users.is_admin in schema.sql).
  // Multiple admins are supported; admin is read live on every request
  // (src/middleware/auth.js), so toggling takes effect on the target's
  // next request — no session invalidation needed.
  //
  // Two server-authoritative guardrails on REVOKE (mirrored in the UI for
  // UX only):
  //   - You can't revoke your own admin status (self-lockout).
  //   - You can't revoke the last admin (the platform must always have
  //     at least one). Enforced inside a transaction that takes the
  //     ADMIN_MUTATION_LOCK advisory lock, then counts admins and performs
  //     the UPDATE atomically — two concurrent revokes can't both observe
  //     >1 admin and race to zero.
  router.post('/api/admin/users/:id/is-admin', async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const { isAdmin } = req.body || {};
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    if (typeof isAdmin !== 'boolean') {
      return res.status(400).json({ error: 'isAdmin (boolean) required in body' });
    }

    if (!isAdmin && userId === req.user.id) {
      return res.status(400).json({ error: "You can't revoke your own admin status." });
    }

    // Grant needs no lock — it only ever increases the admin count.
    if (isAdmin) {
      try {
        const { rows } = await pool.query(
          `UPDATE users SET is_admin = TRUE WHERE id = $1
           RETURNING id, username, is_admin`,
          [userId]
        );
        if (!rows.length) return res.status(404).json({ error: 'User not found' });
        log.info('admin', 'Admin status toggled', {
          id: rows[0].id, username: rows[0].username,
          isAdmin: rows[0].is_admin, by: req.user.username,
        });
        return res.json({ ok: true, isAdmin: rows[0].is_admin });
      } catch (err) {
        log.error('admin', 'Admin toggle failed', { message: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }

    // Revoke: serialize on the advisory lock, re-count admins, and update
    // inside one transaction so the last-admin invariant holds under
    // concurrency.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_MUTATION_LOCK]);

      const { rows: existing } = await client.query(
        'SELECT id, is_admin FROM users WHERE id = $1',
        [userId]
      );
      if (!existing.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User not found' });
      }
      if (!existing[0].is_admin) {
        // Already not an admin — idempotent no-op.
        await client.query('ROLLBACK');
        return res.json({ ok: true, isAdmin: false });
      }

      const { rows: countRows } = await client.query(
        'SELECT COUNT(*)::int AS n FROM users WHERE is_admin = TRUE'
      );
      if (countRows[0].n <= 1) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: "Can't revoke the last admin." });
      }

      const { rows } = await client.query(
        `UPDATE users SET is_admin = FALSE WHERE id = $1
         RETURNING id, username, is_admin`,
        [userId]
      );
      await client.query('COMMIT');
      log.info('admin', 'Admin status toggled', {
        id: rows[0].id, username: rows[0].username,
        isAdmin: rows[0].is_admin, by: req.user.username,
      });
      res.json({ ok: true, isAdmin: rows[0].is_admin });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      log.error('admin', 'Admin toggle failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  });

  router.delete('/api/admin/users/:id', async (req, res) => {
    const userId = parseInt(req.params.id);

    if (userId === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }

    // Deleting drops the admin count just like a revoke, so it takes the
    // same advisory lock / transaction and enforces the last-admin
    // invariant server-side — even though the UI hides Delete for admins,
    // a direct API call must not be able to zero out the admins.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_MUTATION_LOCK]);

      const { rows: existing } = await client.query(
        'SELECT id, is_admin FROM users WHERE id = $1',
        [userId]
      );
      if (!existing.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User not found' });
      }
      if (existing[0].is_admin) {
        const { rows: countRows } = await client.query(
          'SELECT COUNT(*)::int AS n FROM users WHERE is_admin = TRUE'
        );
        if (countRows[0].n <= 1) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: "Can't delete the last admin." });
        }
      }

      await client.query('DELETE FROM users WHERE id = $1', [userId]);
      await client.query('COMMIT');
      log.info('admin', 'User deleted', { id: userId, by: req.user.username });
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      log.error('admin', 'Delete user failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
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

  // ── LLM Spend Limits ───────────────────────────────────────
  //
  // Admin-tunable daily caps on LLM spend. Backed by the
  // `platform_settings` table (default per-user + global) plus the
  // `users.daily_limit_cents` per-user override. Reads are cached for
  // 10s in src/services/limits.js; PUTs invalidate that cache so the
  // new value takes effect on the next request from any worker.

  router.get('/api/admin/limits', async (_req, res) => {
    try {
      const userCents = await limits.getDefaultUserLimitCents(pool);
      const globalCents = await limits.getGlobalLimitCents(pool);
      res.json({
        user_daily_limit_cents: userCents,
        global_daily_limit_cents: globalCents,
      });
    } catch (err) {
      log.error('admin', 'Read limits failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/admin/limits', async (req, res) => {
    const { user, global } = req.body || {};
    const updates = [];
    const validate = (label, v) => {
      if (v === undefined) return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) {
        return `${label} must be a non-negative integer (cents)`;
      }
      return n;
    };
    const userN = validate('user', user);
    if (typeof userN === 'string') return res.status(400).json({ error: userN });
    const globalN = validate('global', global);
    if (typeof globalN === 'string') return res.status(400).json({ error: globalN });
    if (userN === null && globalN === null) {
      return res.status(400).json({ error: 'Provide at least one of: user, global' });
    }
    if (userN !== null) updates.push([limits.KEY_USER, String(userN)]);
    if (globalN !== null) updates.push([limits.KEY_GLOBAL, String(globalN)]);

    try {
      for (const [key, value] of updates) {
        await pool.query(
          `INSERT INTO platform_settings (key, value, updated_at, updated_by)
           VALUES ($1, $2, NOW(), $3)
           ON CONFLICT (key) DO UPDATE
             SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
          [key, value, req.user.id]
        );
      }
      // Hot-flip the cache so new limits apply on the very next request
      // instead of waiting up to 10s for the TTL to expire.
      limits.invalidate(...updates.map(([k]) => k));
      log.info('admin', 'Platform limits updated', {
        by: req.user.username,
        user: userN, global: globalN,
      });
      const userCents = await limits.getDefaultUserLimitCents(pool);
      const globalCents = await limits.getGlobalLimitCents(pool);
      res.json({
        user_daily_limit_cents: userCents,
        global_daily_limit_cents: globalCents,
      });
    } catch (err) {
      log.error('admin', 'Update limits failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Per-user override. Body `{ cents }` sets a cap for this user only;
  // `{ cents: null }` clears the override and falls them back to the
  // platform default. Cache invalidation isn't needed because the per-
  // user limit is read fresh from the users table on every checkBudget
  // call (only the platform_settings rows are cached).
  router.put('/api/admin/users/:id/daily-limit', async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    const { cents } = req.body || {};
    let value;
    if (cents === null) {
      value = null;
    } else {
      const n = Number(cents);
      if (!Number.isInteger(n) || n < 0) {
        return res.status(400).json({ error: 'cents must be a non-negative integer or null' });
      }
      value = n;
    }
    try {
      const { rows } = await pool.query(
        `UPDATE users SET daily_limit_cents = $1 WHERE id = $2
         RETURNING id, username, daily_limit_cents`,
        [value, userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'User not found' });
      log.info('admin', 'Per-user daily limit updated', {
        id: rows[0].id, username: rows[0].username,
        dailyLimitCents: rows[0].daily_limit_cents,
        by: req.user.username,
      });
      res.json({ ok: true, daily_limit_cents: rows[0].daily_limit_cents });
    } catch (err) {
      log.error('admin', 'Per-user limit update failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { adminRoutes };
