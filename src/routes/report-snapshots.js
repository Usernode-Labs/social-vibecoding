'use strict';

const crypto = require('crypto');
const express = require('express');
const { Router } = require('express');
const { getPool } = require('../db/pool');
const appAccess = require('../services/app-access');
const appAdmins = require('../services/app-admins');
const reportAi = require('../services/report-ai');
const { reportSnapshotLimiter } = require('../middleware/rate-limits');
const log = require('../services/logger');

// Locked report snapshots (Reporting tab). Locking freezes the client's
// self-contained standalone report document (the same HTML the download
// button produces) as an immutable dated row; the app_report_ai draft
// keeps being overwritten by regeneration. Lock/share/unshare are
// canManageApp-gated (creator, declared app admins, platform admins);
// list/read need only 'view' — the document contains nothing a viewer
// can't already see on the board.
//
// The posted html is UNTRUSTED USER CONTENT: the only defenses are the
// admin gate, the shape/size checks, and — decisively — the sandbox CSP
// on every route that serves it. The sandbox directive gives the
// document an opaque origin and blocks all script execution, so even a
// malicious admin's markup cannot run code or reach the platform
// origin. Never embed snapshot html in any other page.
//
// ai_json is the SERVER's own draft cache at lock time (never the
// client's): it feeds the next generation's `previousReport` input
// (services/report-ai.js), so it must be data the server itself
// produced.

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const SANDBOX_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'";

function sendSnapshotHtml(res, html) {
  res.set('Content-Security-Policy', SANDBOX_CSP);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'no-store');
  res.type('text/html; charset=utf-8');
  res.send(html);
}

function rowShape(r) {
  return {
    id: Number(r.id),
    lockedAt: r.locked_at,
    lockedBy: r.locked_by_username || null,
    shared: !!r.share_token,
    sharePath: r.share_token ? `/reports/${r.share_token}` : null,
  };
}

function reportSnapshotRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  const APP_COLS = `${appAccess.ACCESS_COLUMNS}, name`;

  const getApp = (req) =>
    appAccess.getAppForUser(pool, req.params.slug, req.user, 'view', APP_COLS);

  router.get('/api/apps/:slug/report-snapshots', async (req, res) => {
    try {
      const app = await getApp(req);
      if (!app) return res.status(404).json({ error: 'App not found' });
      const { rows } = await pool.query(
        `SELECT s.id, s.locked_at, s.share_token, u.username AS locked_by_username
           FROM app_report_snapshots s
           LEFT JOIN users u ON u.id = s.locked_by
          WHERE s.app_id = $1
          ORDER BY s.locked_at DESC, s.id DESC`,
        [app.id]
      );
      res.json({
        snapshots: rows.map((r) => ({
          ...rowShape(r),
          htmlPath: `/api/apps/${app.slug}/report-snapshots/${r.id}/html`,
        })),
        canManage: await appAdmins.canManageApp(pool, app, req.user),
      });
    } catch (err) {
      log.error('report-snapshots', 'list failed', { message: err.message });
      res.status(500).json({ error: 'Failed to load reports' });
    }
  });

  // The standalone report HTML routinely exceeds the global 100kb JSON
  // parser cap, so server.js's parser gate skips this exact path and the
  // route owns a 3mb parser (headroom over MAX_HTML_BYTES: the byte cap
  // below is the real limit; the parser cap only bounds hostile bodies).
  router.post('/api/apps/:slug/report-snapshots',
    reportSnapshotLimiter,
    express.json({ limit: '3mb' }),
    async (req, res) => {
      try {
        const app = await getApp(req);
        if (!app) return res.status(404).json({ error: 'App not found' });
        if (!(await appAdmins.canManageApp(pool, app, req.user))) {
          return res.status(403).json({ error: 'Only app admins can lock reports' });
        }
        const html = req.body && req.body.html;
        if (typeof html !== 'string' || !/^<!doctype html>/i.test(html.trim())) {
          return res.status(400).json({ error: 'Not a report document' });
        }
        if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
          return res.status(400).json({ error: 'Report too large to lock' });
        }
        const cached = await reportAi.getCached(pool, app.id);
        const ai = cached ? {
          narrative: cached.narrative,
          highlights: cached.highlights,
          risks: cached.risks,
          owners: cached.owners,
          model: cached.model,
          generatedAt: cached.generatedAt,
        } : null;
        const { rows } = await pool.query(
          `INSERT INTO app_report_snapshots (app_id, html, ai_json, locked_by)
           VALUES ($1, $2, $3::jsonb, $4)
           RETURNING id, locked_at, share_token`,
          [app.id, html, ai ? JSON.stringify(ai) : null, req.user.id]
        );
        res.json({
          snapshot: {
            ...rowShape({ ...rows[0], locked_by_username: req.user.username }),
            htmlPath: `/api/apps/${app.slug}/report-snapshots/${rows[0].id}/html`,
          },
        });
      } catch (err) {
        log.error('report-snapshots', 'lock failed', { message: err.message });
        res.status(500).json({ error: 'Failed to lock the report' });
      }
    });

  router.get('/api/apps/:slug/report-snapshots/:id/html', async (req, res) => {
    try {
      const app = await getApp(req);
      if (!app) return res.status(404).end();
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(404).end();
      const { rows } = await pool.query(
        'SELECT html FROM app_report_snapshots WHERE id = $1 AND app_id = $2',
        [id, app.id]
      );
      if (!rows.length) return res.status(404).end();
      sendSnapshotHtml(res, rows[0].html);
    } catch (err) {
      log.error('report-snapshots', 'html serve failed', { message: err.message });
      res.status(500).end();
    }
  });

  router.post('/api/apps/:slug/report-snapshots/:id/share',
    reportSnapshotLimiter,
    async (req, res) => {
      try {
        const app = await getApp(req);
        if (!app) return res.status(404).json({ error: 'App not found' });
        if (!(await appAdmins.canManageApp(pool, app, req.user))) {
          return res.status(403).json({ error: 'Only app admins can share reports' });
        }
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return res.status(404).json({ error: 'Report not found' });
        // COALESCE keeps an existing token: clicking Share twice must not
        // rotate a link someone already sent around.
        const token = crypto.randomBytes(16).toString('hex');
        const { rows } = await pool.query(
          `UPDATE app_report_snapshots
              SET share_token = COALESCE(share_token, $3),
                  shared_at = COALESCE(shared_at, NOW())
            WHERE id = $1 AND app_id = $2
            RETURNING share_token`,
          [id, app.id, token]
        );
        if (!rows.length) return res.status(404).json({ error: 'Report not found' });
        res.json({ sharePath: `/reports/${rows[0].share_token}` });
      } catch (err) {
        log.error('report-snapshots', 'share failed', { message: err.message });
        res.status(500).json({ error: 'Failed to share the report' });
      }
    });

  router.post('/api/apps/:slug/report-snapshots/:id/unshare',
    reportSnapshotLimiter,
    async (req, res) => {
      try {
        const app = await getApp(req);
        if (!app) return res.status(404).json({ error: 'App not found' });
        if (!(await appAdmins.canManageApp(pool, app, req.user))) {
          return res.status(403).json({ error: 'Only app admins can unshare reports' });
        }
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return res.status(404).json({ error: 'Report not found' });
        const result = await pool.query(
          `UPDATE app_report_snapshots SET share_token = NULL, shared_at = NULL
            WHERE id = $1 AND app_id = $2`,
          [id, app.id]
        );
        if (!result.rowCount) return res.status(404).json({ error: 'Report not found' });
        res.json({ ok: true });
      } catch (err) {
        log.error('report-snapshots', 'unshare failed', { message: err.message });
        res.status(500).json({ error: 'Failed to unshare the report' });
      }
    });

  return router;
}

// Public serving — mounted BEFORE authMiddleware in server.js (the
// visuals.js pattern): a share link must open for anyone, so the only
// access control is the unguessable 32-hex token. no-store, because
// unshare must bite immediately (an intermediary cache holding a revoked
// report would defeat revocation).
function reportShareRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/reports/:token', async (req, res) => {
    const token = String(req.params.token || '');
    if (!/^[a-f0-9]{32}$/.test(token)) return res.status(404).end();
    try {
      const { rows } = await pool.query(
        'SELECT html FROM app_report_snapshots WHERE share_token = $1',
        [token]
      );
      if (!rows.length) return res.status(404).end();
      sendSnapshotHtml(res, rows[0].html);
    } catch (err) {
      log.error('report-snapshots', 'share serve failed', { message: err.message });
      res.status(500).end();
    }
  });

  return router;
}

module.exports = { reportSnapshotRoutes, reportShareRoutes };
