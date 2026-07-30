'use strict';

/**
 * Fleet maintenance campaign API (services/fleet-maintenance.js).
 *
 * - GET  /api/campaigns                      — list campaigns w/ counts
 *                                              (any signed-in user; the
 *                                              dashboard is read-open,
 *                                              like proposal cards)
 * - GET  /api/campaigns/:id                  — one campaign + per-app rows
 * - POST /api/campaigns/:id/merge-green      — admin: force-merge every
 *                                              campaign proposal whose
 *                                              checks pass
 * - POST /api/campaigns/:id/apps/:appId/retry — admin: re-run one
 *                                              failed/skipped app
 *
 * Campaign CREATION is not here — a campaign starts life as a
 * kind='maintenance_campaign' governance proposal on the self-hosted app
 * (POST /api/apps/:slug/issues in routes/issues.js) and the engine run
 * begins when that vote passes.
 */

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const fleetMaintenance = require('../services/fleet-maintenance');

function campaignRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Where does a campaign proposal get created? On the self-hosted
  // app's issues surface (kind='maintenance_campaign'). The admin
  // dashboard's create form needs that slug; registered before /:id so
  // 'meta' never parses as a campaign id.
  router.get('/api/campaigns/meta', async (req, res) => {
    try {
      if (!req.user?.isAdmin) {
        return res.status(403).json({ error: 'Admin access required' });
      }
      const { rows } = await pool.query(
        'SELECT slug FROM apps WHERE self_hosted = TRUE LIMIT 1'
      );
      res.json({ selfAppSlug: rows[0]?.slug || null });
    } catch (err) {
      log.error('campaigns', 'Meta failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/campaigns', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT mc.id, mc.issue_id, mc.title, mc.status, mc.created_at, mc.completed_at,
                u.username AS created_by_username,
                (SELECT COUNT(*)::int FROM maintenance_campaign_apps WHERE campaign_id = mc.id) AS total_apps,
                (SELECT COUNT(*)::int FROM maintenance_campaign_apps mca
                   LEFT JOIN chat_sessions cs ON cs.id = mca.session_id
                  WHERE mca.campaign_id = mc.id
                    AND (mca.state = 'merged' OR cs.status = 'merged')) AS merged_apps,
                (SELECT COUNT(*)::int FROM maintenance_campaign_apps
                  WHERE campaign_id = mc.id AND state = 'failed') AS failed_apps
           FROM maintenance_campaigns mc
           LEFT JOIN users u ON u.id = mc.created_by
          ORDER BY mc.id DESC
          LIMIT 100`
      );
      res.json({ campaigns: rows });
    } catch (err) {
      log.error('campaigns', 'List failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/campaigns/:id', async (req, res) => {
    try {
      const status = await fleetMaintenance.campaignStatus(pool, req.params.id);
      if (!status) return res.status(404).json({ error: 'Campaign not found' });
      res.json({ campaign: status });
    } catch (err) {
      log.error('campaigns', 'Status failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/campaigns/:id/merge-green', async (req, res) => {
    try {
      if (!req.user?.canAdminWrite) {
        return res.status(403).json({ error: 'Full admin access required' });
      }
      const status = await fleetMaintenance.campaignStatus(pool, req.params.id);
      if (!status) return res.status(404).json({ error: 'Campaign not found' });
      log.info('campaigns', 'Merge-green requested', {
        campaignId: status.id, by: req.user.username,
      });
      // Merges run sequentially with a delay per merge (each triggers a
      // production rebuild) — for a large fleet this response can take a
      // while; the dashboard polls GET /:id for live per-app state anyway.
      const results = await fleetMaintenance.mergeGreen(config, pool, status.id, {
        forceBy: req.user,
      });
      res.json({ ok: true, results });
    } catch (err) {
      log.error('campaigns', 'Merge-green failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/campaigns/:id/apps/:appId/retry', async (req, res) => {
    try {
      if (!req.user?.canAdminWrite) {
        return res.status(403).json({ error: 'Full admin access required' });
      }
      const retried = await fleetMaintenance.retryCampaignApp(
        config, pool, req.params.id, req.params.appId
      );
      if (!retried) {
        return res.status(409).json({ error: 'App is not in a retryable state (failed/skipped)' });
      }
      res.json({ ok: true });
    } catch (err) {
      log.error('campaigns', 'Retry failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { campaignRoutes };
