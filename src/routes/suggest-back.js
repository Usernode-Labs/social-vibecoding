'use strict';

// "Suggest this back": a remix's owner sends the copy's changes to the app it
// was copied from, as a proposal there. The rules and the chain are
// services/suggest-back.js; this file is the two HTTP doors to them.
//
//   GET  /api/apps/:slug/suggest-back   what the confirmation shows: the
//                                       original, the commits since the
//                                       remix, and whether Send can go ahead.
//   POST /api/apps/:slug/suggest-back   send them.
//
// `:slug` is the COPY's. Both answer only its owner (the service decides,
// after the copy is found and visible to the caller), and the POST:
//
//   * mounts the matching membership gate for the copy it names
//     (communities.requireAppMembership; the owner is a member of their own
//     copy, so it passes) and checks membership of the ORIGINAL itself,
//     answering `join_required` for it so the client's fetch wrapper offers
//     Join and retries (frontend/src/lib/join-required.ts);
//   * answers only the Homeroom page itself (sameOriginBrowserOnly): it
//     writes into another app's repository with the platform's credentials;
//   * is drain-guarded, as every route that starts work is.
//
// Both reach GitHub, so both share the per-user GitHub lookup budget.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const appAccess = require('../services/app-access');
const communities = require('../services/communities');
const suggestBack = require('../services/suggest-back');
const { drainGuard } = require('../services/lifecycle');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');
const { githubLookupLimiter } = require('../middleware/rate-limits');

function suggestBackRoutes(config, { pool = getPool(config), deps } = {}) {
  const router = Router();
  const requireAppMembership = communities.requireAppMembership(pool);

  // The copy, as the caller may see it: 404 for a slug that does not resolve
  // or that they cannot view, as every app route answers.
  async function loadCopy(req, res) {
    const { rows } = await pool.query('SELECT * FROM apps WHERE slug = $1', [req.params.slug]);
    const fork = rows[0] || null;
    if (!fork || !(await appAccess.checkAppAccess(pool, fork, req.user, 'view'))) {
      res.status(404).json({ error: 'App not found' });
      return null;
    }
    return fork;
  }

  router.get('/api/apps/:slug/suggest-back', githubLookupLimiter, async (req, res) => {
    try {
      const fork = await loadCopy(req, res);
      if (!fork) return;
      const view = await suggestBack.preview({ pool, user: req.user, fork, ...(deps ? { deps } : {}) });
      res.json(view);
    } catch (err) {
      log.error('suggest-back', 'Preview failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post(
    '/api/apps/:slug/suggest-back',
    drainGuard,
    githubLookupLimiter,
    sameOriginBrowserOnly,
    requireAppMembership,
    async (req, res) => {
      try {
        const fork = await loadCopy(req, res);
        if (!fork) return;
        const result = await suggestBack.suggest({
          pool, config, user: req.user, fork, ...(deps ? { deps } : {}),
        });
        if (!result.ok) return res.status(result.status).json(result.body);
        const { ok: _ok, ...sent } = result;
        res.status(201).json({ ok: true, ...sent });
      } catch (err) {
        log.error('suggest-back', 'Send failed', { slug: req.params.slug, message: err.message });
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  return router;
}

module.exports = { suggestBackRoutes };
