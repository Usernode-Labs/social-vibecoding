const { nativeWebSessionIsLive } = require('../services/web-session-auth');
const { Router } = require('express');
const path = require('path');
const { getPool } = require('../db/pool');
const status = require('../services/status');
const checksQueueSvc = require('../services/checks-queue');
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
// Overlay two fake stuck sessions, a day of fake LLM spend and a fake checks
// queue onto an already-gathered ADMIN payload, so the #admin/status
// section's admin-only cards have something to draw in a staging preview.
// Everything else in the snapshot (containers, host stats, drift, the
// in-memory event ring buffer) is live in staging already and is left
// untouched.
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
  // A preview checks nothing on its own, so its queue is empty. A fake burst
  // instead: every shared slot taken, main-watch in its own, two runs in
  // line and one whose owner is gone, drawn through the same describeQueue
  // the live rows go through.
  const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000).toISOString();
  const demoRun = (n, kind, cls, queuedMin, admittedMin) => ({
    run_id: `00000000-0000-4000-8000-${String(980100 + n).padStart(12, '0')}`,
    kind,
    class: cls,
    session_id: kind === 'main' ? null : 980100 + n,
    app_slug: 'staging-demo',
    pr_number: kind === 'main' ? null : 98100 + n,
    commit_sha: null,
    queued_at: minutesAgo(queuedMin),
    admitted_at: admittedMin == null ? null : minutesAgo(admittedMin),
    heartbeat_at: minutesAgo(0),
    alive: true,
    within_deadline: admittedMin != null,
  });
  const checksQueue = {
    ...checksQueueSvc.describeQueue([
      demoRun(0, 'main', 1, 4, 4),
      demoRun(1, 'proposal', 2, 9, 7),
      demoRun(2, 'proposal', 2, 8, 6),
      demoRun(3, 'proposal', 2, 6, 3),
      demoRun(4, 'proposal', 4, 5, 2),
      demoRun(5, 'proposal', 2, 3, null),
      demoRun(6, 'proposal', 3, 2, null),
      // A run whose process went away while it waited: the harvest's to
      // re-drive, shown with its owner gone.
      { ...demoRun(7, 'proposal', 4, 12, null), alive: false, heartbeat_at: minutesAgo(10) },
    ], { cap: 4 }),
    last24h: { runs: 61, waited: 14, medianWaitMs: 76 * 1000, longestWaitMs: 446 * 1000, failedOpen: 1 },
  };
  return {
    ...data,
    stuckSessions,
    llmUsage,
    checksQueue,
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
         WHERE s.token = $1 AND ${nativeWebSessionIsLive('s')}`,
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
