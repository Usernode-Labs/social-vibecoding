const { Router } = require('express');
const express = require('express');
const { getPool } = require('../db/pool');
const liveDrafts = require('../services/live-drafts');
const log = require('../services/logger');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');
const { conversationActionLimiter } = require('../middleware/rate-limits');
const { drainGuard } = require('../services/lifecycle');

// Live app drafts (services/live-drafts.js), as a private thread of the
// person's chat with Homeroom bot reaches them. Every route is the signed-in
// person's own: a draft is theirs alone until they Propose it.
//
//   GET  /api/live-drafts?rootId=<n>     the thread's open draft, or null, and whether drafts are on
//   POST /api/live-drafts {rootId}       open the thread's draft (or answer the one already open)
//   POST /api/live-drafts/:id/preview    they opened its preview: bring it up to the draft's head
//   POST /api/live-drafts/:id/propose    put it up for a vote, as their own change
//   POST /api/live-drafts/:id/close      put it away
function liveDraftRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  const json = express.json({ limit: '16kb' });
  const idOf = (value) => {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };
  const failed = (res, what, err) => {
    log.error('live-drafts', `${what} failed`, { err: err.message });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  };

  router.get('/api/live-drafts', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in first' });
    const rootId = idOf(req.query.rootId);
    if (!rootId) return res.status(400).json({ error: 'rootId is required' });
    try {
      const [draft, on, { rows: [project] }] = await Promise.all([
        liveDrafts.forThread(pool, { userId: req.user.id, rootId }),
        liveDrafts.enabled(pool),
        pool.query(
          `SELECT a.slug, a.self_hosted FROM private_threads pt JOIN apps a ON a.id = pt.app_id
            WHERE pt.root_message_id = $1 AND pt.user_id = $2`,
          [rootId, req.user.id],
        ),
      ]);
      // Homeroom itself is changed from its own Workshop, never drafted here.
      const draftable = !!project && !project.self_hosted && project.slug !== config.selfAppSlug;
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, enabled: on && draftable, draft: liveDrafts.describe(draft) });
    } catch (err) { failed(res, 'Read', err); }
  });

  router.post('/api/live-drafts', drainGuard, conversationActionLimiter, sameOriginBrowserOnly, json, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in first' });
    const rootId = idOf(req.body?.rootId);
    if (!rootId) return res.status(400).json({ error: 'rootId is required' });
    try {
      const out = await liveDrafts.open(pool, config, { user: req.user, rootId });
      res.status(out.status).json(out.body);
    } catch (err) { failed(res, 'Open', err); }
  });

  router.post('/api/live-drafts/:id/preview', sameOriginBrowserOnly, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in first' });
    const id = idOf(req.params.id);
    try {
      const draft = id ? await liveDrafts.byId(pool, id, { userId: req.user.id }) : null;
      if (!draft) return res.status(404).json({ ok: false, error: 'no_draft' });
      const synced = draft.state === 'open' ? await liveDrafts.syncPreview(pool, config, { draft }) : { ok: false };
      res.json({ ok: true, synced: !!synced.synced, draft: liveDrafts.describe(await liveDrafts.byId(pool, id)) });
    } catch (err) { failed(res, 'Preview', err); }
  });

  router.post('/api/live-drafts/:id/propose', drainGuard, conversationActionLimiter, sameOriginBrowserOnly, json, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in first' });
    const id = idOf(req.params.id);
    if (!id) return res.status(404).json({ ok: false, error: 'no_draft' });
    try {
      const title = typeof req.body?.title === 'string' ? req.body.title : null;
      const out = await liveDrafts.propose(pool, config, { user: req.user, draftId: id, title });
      res.status(out.status).json(out.body);
    } catch (err) { failed(res, 'Propose', err); }
  });

  router.post('/api/live-drafts/:id/close', conversationActionLimiter, sameOriginBrowserOnly, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in first' });
    const id = idOf(req.params.id);
    if (!id) return res.status(404).json({ ok: false, error: 'no_draft' });
    try {
      const out = await liveDrafts.close(pool, { user: req.user, draftId: id });
      res.status(out.status).json(out.body);
    } catch (err) { failed(res, 'Close', err); }
  });

  return router;
}

module.exports = { liveDraftRoutes };
