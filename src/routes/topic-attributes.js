// Read / cast endpoints for the community-voted "priority" + "assigned
// person" on issues and PR proposals. The card chips themselves paint
// from the per-card summary the feed routes (github-issues / promoted /
// merged) attach via services/topic-attributes.summarizeForTargets; these
// two routes drive the dropdown the chip opens:
//
//   GET  /api/apps/:slug/topics/:targetType/:targetRef/attributes?field=…
//        → { field, options: [{ value, count, mine }], myValue }
//   POST /api/apps/:slug/topics/:targetType/:targetRef/attributes
//        body { field, value } → upsert the caller's vote, returns the
//        refreshed option list (same shape as GET) so the FE repaints the
//        chip + open dropdown in one round-trip.
//
// Access is collab-level on the app (same gate the feed routes use). The
// vote is a social signal only — no notification, no feed re-sort, no
// merge-rule impact.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const appAccess = require('../services/app-access');
const attrs = require('../services/topic-attributes');
const { attributeVoteLimiter } = require('../middleware/rate-limits');

function parseTarget(req) {
  const targetType = String(req.params.targetType || '');
  const targetRef = parseInt(req.params.targetRef, 10);
  if (!attrs.TARGET_TYPES.includes(targetType)) return null;
  if (!Number.isInteger(targetRef) || targetRef <= 0) return null;
  return { targetType, targetRef };
}

function topicAttributeRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/api/apps/:slug/topics/:targetType/:targetRef/attributes', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      const t = parseTarget(req);
      if (!t) return res.status(400).json({ error: 'Invalid target' });
      const field = String(req.query.field || '');
      if (!attrs.FIELDS.includes(field)) {
        return res.status(400).json({ error: 'Invalid field' });
      }

      const data = await attrs.listOptions(
        pool, app.id, t.targetType, t.targetRef, field, req.user?.id || null
      );
      res.json(data);
    } catch (err) {
      log.error('topic-attrs', 'Failed to list attribute options', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/apps/:slug/topics/:targetType/:targetRef/attributes', attributeVoteLimiter, async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });

      const t = parseTarget(req);
      if (!t) return res.status(400).json({ error: 'Invalid target' });

      const field = String(req.body?.field || '');
      if (!attrs.FIELDS.includes(field)) {
        return res.status(400).json({ error: 'Invalid field' });
      }
      const value = attrs.normalizeValue(field, req.body?.value);
      if (value == null) {
        return res.status(400).json({
          error: field === 'priority'
            ? 'Priority must be low, medium or high'
            : `Name must be 1–${attrs.MAX_ASSIGNEE_LEN} characters`,
        });
      }

      const data = await attrs.castVote(
        pool, app.id, t.targetType, t.targetRef, field, value, req.user.id
      );
      res.json(data);
    } catch (err) {
      log.error('topic-attrs', 'Failed to cast attribute vote', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Clear the caller's own vote for (target, field). Drives the
  // "Assigned to you" → unassign toggle on the "Assign to me" button
  // (public/js/app-view.js). Field-generic — same collab gate, target /
  // field validation, and rate limiter as POST; the field is read from
  // the query string since a DELETE carries no body. Idempotent.
  router.delete('/api/apps/:slug/topics/:targetType/:targetRef/attributes', attributeVoteLimiter, async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });

      const t = parseTarget(req);
      if (!t) return res.status(400).json({ error: 'Invalid target' });

      const field = String(req.query.field || '');
      if (!attrs.FIELDS.includes(field)) {
        return res.status(400).json({ error: 'Invalid field' });
      }

      const data = await attrs.clearVote(
        pool, app.id, t.targetType, t.targetRef, field, req.user.id
      );
      res.json(data);
    } catch (err) {
      log.error('topic-attrs', 'Failed to clear attribute vote', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { topicAttributeRoutes };
