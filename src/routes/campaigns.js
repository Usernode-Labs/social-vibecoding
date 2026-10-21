'use strict';

/**
 * Fleet maintenance campaign API. A campaign is the campaign machine's
 * (src/workflow/campaign/): these routes read its projections and append an
 * admin's moves, answering with the machine's outcome.
 *
 * - GET  /api/campaigns                      — admin: list campaigns w/
 *                                              counts
 * - GET  /api/campaigns/:id                  — admin: one campaign + per-app
 *                                              rows (private apps included,
 *                                              so never read-open)
 * - POST /api/campaigns/:id/merge-green      — admin: force-merge every
 *                                              campaign proposal whose
 *                                              checks pass now
 * - POST /api/campaigns/:id/apps/:appId/retry — admin: re-run one
 *                                              failed/skipped app
 * - POST /api/campaigns/:id/stop             — admin: open no further
 *                                              proposals
 * - POST /api/campaigns/:id/resume           — admin: a stopped campaign
 *                                              goes on with the apps it
 *                                              never reached
 * - POST /api/campaigns/:id/auto-merge       — admin: { on } merge each
 *                                              campaign proposal as soon
 *                                              as its checks pass
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
const platform = () => require('../workflow/platform.ts');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');

// What the machine's refusal of an admin's move answers.
const REFUSALS = new Map([
  ['not_found', [404, 'Campaign not found']],
  ['not_in_campaign', [404, 'Campaign app not found']],
  ['not_retryable', [409, 'App is not in a retryable state (failed/skipped)']],
  ['stopped', [409, 'The campaign was stopped']],
  ['done', [409, 'The campaign is already done']],
  ['running', [409, 'The campaign is already running']],
  ['nothing_to_resume', [409, 'Every app was reached before the stop: there is nothing to resume']],
  // A campaign row the machine never started (none in production).
  ['no_instance', [404, 'Campaign not found']],
]);
function refused(res, outcome) {
  if (outcome.status === 'faulted') return res.status(500).json({ error: 'Internal server error' });
  const [status, error] = REFUSALS.get(outcome.reason) || [409, outcome.reason || 'refused'];
  return res.status(status).json({ error, reason: outcome.reason || null });
}
const settled = (outcome) => outcome.status === 'accepted' || outcome.status === 'replayed';

// A campaign or app id from the path, or null when it is not a positive
// integer — answered as 404 rather than handed to Postgres as a bad cast.
function positiveId(raw) {
  return /^[1-9]\d{0,9}$/.test(String(raw)) && Number(raw) <= 2147483647 ? Number(raw) : null;
}

function campaignRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  const exists = async (id) => (await pool.query('SELECT 1 FROM maintenance_campaigns WHERE id = $1', [id])).rows.length > 0;

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
      if (!req.user?.isAdmin) {
        return res.status(403).json({ error: 'Admin access required' });
      }
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
      if (!req.user?.isAdmin) {
        return res.status(403).json({ error: 'Admin access required' });
      }
      const id = positiveId(req.params.id);
      if (!id) return res.status(404).json({ error: 'Campaign not found' });
      const status = await fleetMaintenance.campaignStatus(pool, id);
      if (!status) return res.status(404).json({ error: 'Campaign not found' });
      res.json({ campaign: status });
    } catch (err) {
      log.error('campaigns', 'Status failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/campaigns/:id/merge-green', sameOriginBrowserOnly, async (req, res) => {
    try {
      if (!req.user?.canAdminWrite) {
        return res.status(403).json({ error: 'Full admin access required' });
      }
      const id = positiveId(req.params.id);
      if (!id) return res.status(404).json({ error: 'Campaign not found' });
      const status = await fleetMaintenance.campaignStatus(pool, id);
      if (!status) return res.status(404).json({ error: 'Campaign not found' });
      log.info('campaigns', 'Merge-green requested', {
        campaignId: status.id, by: req.user.username,
      });
      // Every green proposal is forced at once, in the machine's transaction
      // (Q4); each merges through its app's queue as soon as it can, and the
      // dashboard's poll shows them land. App delivery paces the rebuilds.
      const outcome = await platform().campaignEvent(status.id, 'MergeGreen', {}, req.user);
      if (outcome.status === 'pending') return res.status(202).json({ ok: true, pending: true });
      if (!settled(outcome)) return refused(res, outcome);
      res.json({ ok: true, forced: (outcome.reply && outcome.reply.asked) || [] });
    } catch (err) {
      log.error('campaigns', 'Merge-green failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/campaigns/:id/apps/:appId/retry', sameOriginBrowserOnly, async (req, res) => {
    try {
      if (!req.user?.canAdminWrite) {
        return res.status(403).json({ error: 'Full admin access required' });
      }
      const id = positiveId(req.params.id);
      const appId = positiveId(req.params.appId);
      if (!id || !appId || !(await exists(id))) return res.status(404).json({ error: 'Campaign app not found' });
      const outcome = await platform().campaignEvent(id, 'RetryApp', { appId }, req.user);
      if (outcome.status === 'pending') return res.status(202).json({ ok: true, pending: true });
      if (!settled(outcome)) return refused(res, outcome);
      res.json({ ok: true });
    } catch (err) {
      log.error('campaigns', 'Retry failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Stop: no further app is changed, the change under way is abandoned, and
  // the proposals already opened stay up for their vote (Q3).
  router.post('/api/campaigns/:id/stop', sameOriginBrowserOnly, async (req, res) => {
    try {
      if (!req.user?.canAdminWrite) {
        return res.status(403).json({ error: 'Full admin access required' });
      }
      const id = positiveId(req.params.id);
      if (!id || !(await exists(id))) return res.status(404).json({ error: 'Campaign not found' });
      log.info('campaigns', 'Stop requested', { campaignId: id, by: req.user.username });
      const outcome = await platform().campaignEvent(id, 'Stop', {}, req.user);
      if (outcome.status === 'pending') return res.status(202).json({ ok: true, pending: true });
      if (!settled(outcome)) return refused(res, outcome);
      res.json({ ok: true });
    } catch (err) {
      log.error('campaigns', 'Stop failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Resume: a stopped campaign goes on with the apps the stop never reached,
  // at the pace its room allows (src/workflow/campaign/machine.ts holdFor).
  router.post('/api/campaigns/:id/resume', sameOriginBrowserOnly, async (req, res) => {
    try {
      if (!req.user?.canAdminWrite) {
        return res.status(403).json({ error: 'Full admin access required' });
      }
      const id = positiveId(req.params.id);
      if (!id || !(await exists(id))) return res.status(404).json({ error: 'Campaign not found' });
      log.info('campaigns', 'Resume requested', { campaignId: id, by: req.user.username });
      const outcome = await platform().campaignEvent(id, 'Resume', {}, req.user);
      if (outcome.status === 'pending') return res.status(202).json({ ok: true, pending: true });
      if (!settled(outcome)) return refused(res, outcome);
      res.json({ ok: true });
    } catch (err) {
      log.error('campaigns', 'Resume failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Auto-merge: { on: true } and the campaign merges each of its proposals
  // whose checks pass as they come in (every check, and at once), in this
  // admin's name; { on: false } stops that.
  router.post('/api/campaigns/:id/auto-merge', sameOriginBrowserOnly, async (req, res) => {
    try {
      if (!req.user?.canAdminWrite) {
        return res.status(403).json({ error: 'Full admin access required' });
      }
      const id = positiveId(req.params.id);
      if (!id || !(await exists(id))) return res.status(404).json({ error: 'Campaign not found' });
      const on = req.body && req.body.on;
      if (typeof on !== 'boolean') return res.status(400).json({ error: 'Provide on: true or false.' });
      log.info('campaigns', 'Auto-merge set', { campaignId: id, on, by: req.user.username });
      const outcome = await platform().campaignEvent(id, 'AutoMerge', { on }, req.user);
      if (outcome.status === 'pending') return res.status(202).json({ ok: true, pending: true });
      if (!settled(outcome)) return refused(res, outcome);
      res.json({ ok: true, on });
    } catch (err) {
      log.error('campaigns', 'Auto-merge failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { campaignRoutes };
