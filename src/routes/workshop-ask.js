const { Router } = require('express');
const { getPool } = require('../db/pool');
const appAccess = require('../services/app-access');
const models = require('../services/models');
const workshopAsk = require('../services/workshop-ask');
const { workshopAskLimiter } = require('../middleware/rate-limits');
const log = require('../services/logger');

// The Needs-you deck's ask box. One question about one card the viewer is
// being asked to vote on or pick up; see services/workshop-ask.js for what
// the model is given and why the client cannot contribute to it.
//
// Access is 'view', matching report-ai: the answer is built from data every
// member of the app can already see on the card itself, and the cost lands
// on the asker's own budget. The deny is a 404 like every other app route.
//
// The MODEL comes from the deck's picker, which is the dev session's own
// list, and goes through models.resolve() — the server-side allowlist —
// exactly as the session route does with its own client-supplied model.
// Absent or unrecognised means the box's own default (Haiku), not the
// session default: this is a short comprehension answer somebody is
// waiting on, not a build turn.

function workshopAskRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  const APP_COLS = `${appAccess.ACCESS_COLUMNS}, name, repo_url`;

  router.post('/api/apps/:slug/workshop/ask', workshopAskLimiter, async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'view', APP_COLS);
      if (!app) return res.status(404).json({ error: 'App not found' });

      const body = req.body || {};
      const target = workshopAsk.parseTarget(body.target);
      if (!target) return res.status(400).json({ error: 'Which item is the question about?' });

      // An empty pick is a real state — the picker is not drawn until the
      // box is in use — so only a NON-empty one is resolved. Passing '' to
      // models.resolve() would hand back the session default and quietly
      // bill a build-sized model for a two-sentence answer.
      const picked = typeof body.model === 'string' && body.model.trim()
        ? models.resolve(body.model.trim())
        : null;

      const { text, model } = await workshopAsk.ask({
        pool,
        config,
        app,
        userId: req.user.id,
        target,
        question: body.question,
        history: Array.isArray(body.history) ? body.history : [],
        model: picked,
      });
      res.json({ text, model });
    } catch (err) {
      if (err.code === 'empty_question') return res.status(400).json({ error: err.message });
      if (err.code === 'not_found') return res.status(404).json({ error: err.message });
      if (err.code === 'budget_exceeded') {
        return res.status(429).json({ error: err.message, code: 'budget_exceeded' });
      }
      if (err.code === 'llm_unavailable') return res.status(503).json({ error: err.message });
      log.error('workshop-ask', 'ask failed', { message: err.message });
      res.status(500).json({ error: 'Could not answer that just now' });
    }
  });

  return router;
}

module.exports = { workshopAskRoutes };
