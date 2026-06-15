const { Router } = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { getPool } = require('../db/pool');
const { adminMiddleware, requireAdminWrite } = require('../middleware/admin');
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
        `SELECT u.id, u.username, u.is_admin, u.admin_readonly, u.app_quota, u.created_at,
                u.daily_limit_cents,
                (u.id = $1) AS is_self,
                ac.code as activation_code,
                COALESCE(lu.total_cost_cents, 0) as cost_today_cents,
                COALESCE(ac2.n, 0) AS apps_created
         FROM users u
         LEFT JOIN activation_codes ac ON ac.used_by = u.id
         LEFT JOIN llm_usage lu ON lu.user_id = u.id AND lu.date = CURRENT_DATE
         LEFT JOIN (
           SELECT created_by, COUNT(*) FILTER (WHERE status <> 'error') AS n
           FROM apps
           GROUP BY created_by
         ) ac2 ON ac2.created_by = u.id
         ORDER BY u.created_at ASC`,
        [req.user.id]
      );
      res.json(rows);
    } catch (err) {
      log.error('admin', 'List users failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Bulk set every user's app-creation quota (see users.app_quota in
  // schema.sql). Body `{ quota }` — a non-negative integer applied to ALL
  // users. Admins are included; since they bypass enforcement this is
  // harmless and keeps the operation simple ("set all to 0", "set all to
  // 3"). Declared BEFORE the per-user `:id` route below: Express matches
  // this distinctly (different segment count), but ordering keeps intent
  // obvious.
  router.put('/api/admin/users/app-quota', requireAdminWrite, async (req, res) => {
    const { quota } = req.body || {};
    const n = Number(quota);
    if (!Number.isInteger(n) || n < 0) {
      return res.status(400).json({ error: 'quota must be a non-negative integer' });
    }
    try {
      await pool.query('UPDATE users SET app_quota = $1', [n]);
      log.info('admin', 'App quota set for all users', { quota: n, by: req.user.username });
      res.json({ ok: true, quota: n });
    } catch (err) {
      log.error('admin', 'Bulk app-quota update failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Set one user's app-creation quota (see users.app_quota in schema.sql).
  // Body `{ quota }` — a non-negative integer. Modeled on the per-user
  // daily-limit handler below. Quota 0 means the user cannot create apps;
  // admins bypass enforcement regardless (their quota is cosmetic).
  router.put('/api/admin/users/:id/app-quota', requireAdminWrite, async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    const { quota } = req.body || {};
    const n = Number(quota);
    if (!Number.isInteger(n) || n < 0) {
      return res.status(400).json({ error: 'quota must be a non-negative integer' });
    }
    try {
      const { rows } = await pool.query(
        `UPDATE users SET app_quota = $1 WHERE id = $2
         RETURNING id, username, app_quota`,
        [n, userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'User not found' });
      log.info('admin', 'App quota updated', {
        id: rows[0].id, username: rows[0].username,
        appQuota: rows[0].app_quota, by: req.user.username,
      });
      res.json({ ok: true, app_quota: rows[0].app_quota });
    } catch (err) {
      log.error('admin', 'App quota update failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Set a user's role (issue #311). The three-way role selector in
  // public/admin.html posts here. Role is read live on every request
  // (src/middleware/auth.js), so a change takes effect on the target's
  // next request — no session invalidation needed.
  //
  //   user       → is_admin = FALSE, admin_readonly = FALSE
  //   view_admin → is_admin = TRUE,  admin_readonly = TRUE   (see-only)
  //   admin      → is_admin = TRUE,  admin_readonly = FALSE  (full)
  //
  // Back-compat: an older client posting `{ isAdmin: boolean }` is mapped
  // (true → 'admin', false → 'user').
  //
  // Two server-authoritative guardrails (mirrored in the UI for UX only),
  // both counting FULL admins only — a view-only admin can't promote anyone
  // back, so they don't satisfy the "at least one admin" requirement:
  //   - A full admin can't lower their OWN role (self-lockout).
  //   - The platform must always retain at least one full admin. Enforced
  //     inside a transaction that takes the ADMIN_MUTATION_LOCK advisory
  //     lock, then counts full admins and performs the UPDATE atomically —
  //     two concurrent demotions can't both observe >1 and race to zero.
  //   Setting the last full admin to `view_admin` is blocked the same way
  //   as demoting them to `user`.
  router.post('/api/admin/users/:id/is-admin', requireAdminWrite, async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    let role = req.body?.role;
    if (role === undefined && typeof req.body?.isAdmin === 'boolean') {
      role = req.body.isAdmin ? 'admin' : 'user';
    }
    const ROLE_COLUMNS = {
      user:       { is_admin: false, admin_readonly: false },
      view_admin: { is_admin: true,  admin_readonly: true },
      admin:      { is_admin: true,  admin_readonly: false },
    };
    const target = ROLE_COLUMNS[role];
    if (!target) {
      return res.status(400).json({ error: "role must be one of 'user', 'view_admin', 'admin'" });
    }

    const endsFullAdmin = target.is_admin && !target.admin_readonly;

    // Self-protection: a full admin can't set their own role to anything
    // that isn't full admin (re-affirming 'admin' on yourself is a no-op).
    if (userId === req.user.id && !endsFullAdmin) {
      return res.status(400).json({ error: "You can't lower your own admin role." });
    }

    // A change that ENDS in full admin never reduces the full-admin count,
    // so it needs no lock.
    if (endsFullAdmin) {
      try {
        const { rows } = await pool.query(
          `UPDATE users SET is_admin = $1, admin_readonly = $2 WHERE id = $3
           RETURNING id, username, is_admin, admin_readonly`,
          [target.is_admin, target.admin_readonly, userId]
        );
        if (!rows.length) return res.status(404).json({ error: 'User not found' });
        log.info('admin', 'Role set', {
          id: rows[0].id, username: rows[0].username, role, by: req.user.username,
        });
        return res.json({
          ok: true, role,
          isAdmin: rows[0].is_admin, adminReadonly: rows[0].admin_readonly,
        });
      } catch (err) {
        log.error('admin', 'Role set failed', { message: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }

    // Demotion path (→ user or → view_admin): serialize on the advisory
    // lock, re-count FULL admins, and update inside one transaction so the
    // last-full-admin invariant holds under concurrency.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_MUTATION_LOCK]);

      const { rows: existing } = await client.query(
        'SELECT id, is_admin, admin_readonly FROM users WHERE id = $1',
        [userId]
      );
      if (!existing.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User not found' });
      }

      const wasFullAdmin = existing[0].is_admin && !existing[0].admin_readonly;
      if (wasFullAdmin) {
        const { rows: countRows } = await client.query(
          'SELECT COUNT(*)::int AS n FROM users WHERE is_admin = TRUE AND admin_readonly = FALSE'
        );
        if (countRows[0].n <= 1) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: "Can't drop the last full admin." });
        }
      }

      const { rows } = await client.query(
        `UPDATE users SET is_admin = $1, admin_readonly = $2 WHERE id = $3
         RETURNING id, username, is_admin, admin_readonly`,
        [target.is_admin, target.admin_readonly, userId]
      );
      await client.query('COMMIT');
      log.info('admin', 'Role set', {
        id: rows[0].id, username: rows[0].username, role, by: req.user.username,
      });
      res.json({
        ok: true, role,
        isAdmin: rows[0].is_admin, adminReadonly: rows[0].admin_readonly,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      log.error('admin', 'Role set failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  });

  router.delete('/api/admin/users/:id', requireAdminWrite, async (req, res) => {
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
        'SELECT id, is_admin, admin_readonly FROM users WHERE id = $1',
        [userId]
      );
      if (!existing.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User not found' });
      }
      // Only a FULL admin counts toward the "at least one admin" invariant
      // (issue #311) — deleting a view-only admin never threatens it.
      if (existing[0].is_admin && !existing[0].admin_readonly) {
        const { rows: countRows } = await client.query(
          'SELECT COUNT(*)::int AS n FROM users WHERE is_admin = TRUE AND admin_readonly = FALSE'
        );
        if (countRows[0].n <= 1) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: "Can't delete the last full admin." });
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

  // Admin-issued temporary password (issue #282). The universal recovery
  // path for accounts that can't self-reset with a wallet (no wallet
  // linked, or on plain desktop web). Gated by the same router-level
  // adminMiddleware as every other user route — any admin may issue one,
  // consistent with the rest of admin user-management.
  //
  // We generate a one-time temporary password, store only its bcrypt hash,
  // and return the plaintext exactly ONCE in the response for the admin to
  // relay out-of-band. The plaintext is never logged. Resetting deletes all
  // of the target's sessions so a leaked/old session can't outlive it. No
  // last-admin concern — this doesn't touch is_admin — and an admin may
  // reset their own password too.
  router.post('/api/admin/users/:id/reset-password', requireAdminWrite, async (req, res) => {
    const userId = parseInt(req.params.id, 10);
    if (!Number.isFinite(userId)) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    try {
      // URL-safe, ~12-char temporary password. base64url avoids +/=
      // so it's painless to relay over chat or read aloud.
      const tempPassword = crypto.randomBytes(9).toString('base64url');
      const hash = await bcrypt.hash(tempPassword, 12);

      const { rows } = await pool.query(
        'UPDATE users SET password = $1 WHERE id = $2 RETURNING id, username',
        [hash, userId]
      );
      if (!rows.length) return res.status(404).json({ error: 'User not found' });

      await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);

      log.info('admin', 'Password reset issued', {
        id: rows[0].id, username: rows[0].username, by: req.user.username,
      });
      res.json({ ok: true, username: rows[0].username, tempPassword });
    } catch (err) {
      log.error('admin', 'Password reset failed', { message: err.message });
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

  router.post('/api/admin/codes', requireAdminWrite, async (req, res) => {
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

  router.delete('/api/admin/codes/:id', requireAdminWrite, async (req, res) => {
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

  router.put('/api/admin/limits', requireAdminWrite, async (req, res) => {
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
  router.put('/api/admin/users/:id/daily-limit', requireAdminWrite, async (req, res) => {
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
