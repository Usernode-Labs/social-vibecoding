const { Router } = require('express');
const path = require('path');
const { getPool } = require('../db/pool');
const status = require('../services/status');
const log = require('../services/logger');

// GET /api/status is intentionally public. We resolve the session cookie
// ourselves here (bypassing authMiddleware) so that anonymous visitors see a
// sanitized summary while admins see the full dashboard.
//
// #860 folded the /status PAGE into the SPA's #admin/status console section,
// so the route below now serves a client-side redirect stub. The JSON
// endpoint keeps its own cookie resolution and stays open to anyone — it is
// the anonymous surface for external monitoring now that the page requires
// a session. Progressive disclosure still happens in
// src/services/status.js redact(), which is the real boundary; the console
// section only mirrors it visually.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// ── Staging mock data (#860) ─────────────────────────────────────────────
// Overlay two fake stuck sessions and a day of fake LLM spend onto an
// already-gathered ADMIN payload, so the #admin/status section's admin-only
// cards have something to draw in a staging preview. Everything else in the
// snapshot (containers, host stats, drift, the in-memory event ring buffer)
// is live in staging already and is left untouched.
function withStagingDemo(data) {
  const ageSeconds = (m) => m * 60;
  const stuckSessions = [
    {
      id: 980001,
      appSlug: 'staging-demo',
      username: 'staging-demo-user01',
      branchName: 'usernode/staging-demo-stuck-1',
      ageSeconds: ageSeconds(47),
    },
    {
      id: 980002,
      appSlug: 'staging-demo',
      username: 'staging-demo-user02',
      branchName: 'usernode/staging-demo-stuck-2',
      ageSeconds: ageSeconds(133),
    },
  ];
  const llmUsage = [
    { username: 'staging-demo-user01', costCents: 1840 },
    { username: 'staging-demo-user02', costCents: 920 },
    { username: 'staging-demo-user03', costCents: 145 },
  ];
  const globalSpendCents = llmUsage.reduce((a, r) => a + r.costCents, 0);
  return {
    ...data,
    stuckSessions,
    llmUsage,
    stagingPerUser: { 'staging-demo-user01': 2, 'staging-demo-user02': 1 },
    summary: {
      ...(data.summary || {}),
      stuckSessions: stuckSessions.length,
      globalSpendCents,
    },
    demo: true,
  };
}

function statusRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  async function resolveUser(req) {
    const token = req.cookies?.session;
    if (!token) return null;
    try {
      const { rows } = await pool.query(
        `SELECT s.expires_at, u.is_admin, u.username, u.id AS user_id
         FROM sessions s JOIN users u ON s.user_id = u.id
         WHERE s.token = $1`,
        [token]
      );
      if (!rows.length || new Date(rows[0].expires_at) < new Date()) return null;
      return { id: rows[0].user_id, username: rows[0].username, isAdmin: rows[0].is_admin };
    } catch {
      return null;
    }
  }

  router.get('/status', (_req, res) => {
    res.sendFile(path.join(__dirname, '../../public/status.html'));
  });

  router.get('/api/status', async (req, res) => {
    try {
      const user = await resolveUser(req);
      const isAdmin = !!user?.isAdmin;
      const data = await status.gather(config, { isAdmin });
      // Staging mock data (#860): `chat_sessions` and `llm_usage` are both
      // staging:private, so in a prod-cloned staging DB the admin-only
      // "Stuck sessions" and "LLM today" cards render empty and a reviewer
      // can't tell them from broken. Under IS_STAGING + ?demo=1, and only
      // for an ADMIN viewer (these are the admin-only blocks; a non-admin's
      // payload has them stripped by redact() and must stay that way),
      // inject obviously-fake rows. Read-path only — nothing is written —
      // and a strict no-op in production.
      if (IS_STAGING && req.query.demo === '1' && isAdmin) {
        res.json(withStagingDemo(data));
        return;
      }
      res.json(data);
    } catch (err) {
      log.error('status', 'Failed to gather status', { message: err.message });
      res.status(500).json({ error: 'Failed to gather status' });
    }
  });

  return router;
}

module.exports = { statusRoutes };
