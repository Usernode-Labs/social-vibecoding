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
// #780: for field='category' both of the above also carry `categories` —
// the app's full vocabulary (built-ins + custom) — because the dropdown
// must list options this card has no votes for yet. A third route serves
// that vocabulary on its own for the Dev tab's first paint:
//
//   GET  /api/apps/:slug/topic-categories
//        → { categories: [{ value, label, custom }] }
//
// There is deliberately NO create endpoint: typing a new category IS
// casting a vote for it (the POST above registers it), mirroring how
// suggesting an assignee and voting for one are the same operation.
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

// #639: a promoted proposal inherits its priority/assignee tally from the
// issue(s) it was started from, so the dropdown must know those linked issue
// numbers to show the same options the card chip does. Look them up from the
// session row (scoped to this app); non-proposal targets never inherit.
async function linkedIssuesFor(pool, appId, t) {
  if (t.targetType !== 'proposal') return [];
  const { rows } = await pool.query(
    'SELECT linked_issues FROM chat_sessions WHERE id = $1 AND app_id = $2',
    [t.targetRef, appId]
  );
  const li = rows[0] && rows[0].linked_issues;
  return Array.isArray(li) ? li : [];
}

function topicAttributeRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/api/apps/:slug/topics/:targetType/:targetRef/attributes', async (req, res) => {
    try {
      // View-level (#621): priority/assignee summaries are read-only;
      // casting an attribute vote (POST below) stays collab-gated.
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      const t = parseTarget(req);
      if (!t) return res.status(400).json({ error: 'Invalid target' });
      const field = String(req.query.field || '');
      if (!attrs.FIELDS.includes(field)) {
        return res.status(400).json({ error: 'Invalid field' });
      }

      const linkedIssues = await linkedIssuesFor(pool, app.id, t);
      const data = await attrs.listOptions(
        pool, app.id, t.targetType, t.targetRef, field, req.user?.id || null, linkedIssues
      );
      // #780: the category dropdown must list every option the APP offers,
      // not just the ones this card has votes for, so ship the vocabulary
      // alongside the tally. Also self-heals a stale FE cache on each open.
      if (field === 'category') {
        data.categories = await attrs.listCategories(pool, app.id);
      }
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
      // #780: a category is now free text, so keep the normalized pair —
      // castVote needs the typed LABEL to register a brand-new option with
      // the casing the user typed, while the vote itself stores the slug.
      const category = field === 'category'
        ? attrs.normalizeCategoryInput(req.body?.value) : null;
      const value = field === 'category'
        ? (category && category.slug) : attrs.normalizeValue(field, req.body?.value);
      if (value == null) {
        let error;
        if (field === 'priority') {
          error = 'Priority must be low, medium or high';
        } else if (field === 'category') {
          error = `Category must be 1–${attrs.MAX_CATEGORY_LEN} characters`;
        } else {
          error = `Name must be 1–${attrs.MAX_ASSIGNEE_LEN} characters`;
        }
        return res.status(400).json({ error });
      }

      const linkedIssues = await linkedIssuesFor(pool, app.id, t);
      let data;
      try {
        data = await attrs.castVote(
          pool, app.id, t.targetType, t.targetRef, field, value, req.user.id, linkedIssues,
          category ? category.label : null
        );
      } catch (err) {
        // The app is already at its custom-category cap and this is a NEW
        // slug — a user error, not a server fault.
        if (err.message === attrs.CATEGORY_CAP_ERROR) {
          return res.status(400).json({
            error: `This app already has the maximum of ${attrs.MAX_CUSTOM_CATEGORIES_PER_APP} custom categories.`,
          });
        }
        throw err;
      }
      if (field === 'category') {
        data.categories = await attrs.listCategories(pool, app.id);
      }
      res.json(data);
    } catch (err) {
      log.error('topic-attrs', 'Failed to cast attribute vote', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #780: the app's category vocabulary (six built-ins + this app's custom
  // options). The Dev tab fetches this once per mount so the chips can label
  // + colour a custom category and the kanban / PM filter bar can offer it.
  // View-level like the attributes GET — reading the taxonomy is not a
  // collaborator-only act.
  router.get('/api/apps/:slug/topic-categories', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });
      const categories = await attrs.listCategories(pool, app.id);
      res.json({ categories });
    } catch (err) {
      log.error('topic-attrs', 'Failed to list categories', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Withdraw the caller's own vote for a (target, field). Backs the PM view's
  // drag-to-Unassigned gesture (remove your assignee vote) — the card only
  // becomes unassigned when no other votes remain. Collab-gated + rate-limited
  // like the POST; returns the refreshed option list (same shape as GET/POST).
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

      const linkedIssues = await linkedIssuesFor(pool, app.id, t);
      const data = await attrs.clearVote(
        pool, app.id, t.targetType, t.targetRef, field, req.user.id, linkedIssues
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
