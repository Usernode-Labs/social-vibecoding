'use strict';

// Browser-session twin of the app-token directory endpoints (#1195).
//
//   GET /api/app-directory/users/lookup?username=<handle>
//   GET /api/app-directory/users/search?q=<prefix>[&limit=]
//
// These exist for ONE caller: the platform shell's directory relay in
// public/js/app-view.js, which answers `__usernode_directory` postMessage
// requests from the app and staging iframes on behalf of the signed-in
// user (same mechanism as the file-storage and locale bridges). An app
// iframe is cross-origin and holds no platform session, so it cannot
// call this itself — it posts to the shell, and the shell fetches here
// with `credentials: 'same-origin'`.
//
// Why a second router rather than reusing /api/users/search: that
// endpoint is the platform's own invite typeahead and carries an
// app-membership filter (`excludeApp`) whose responses leak WHO IS
// ALREADY ON AN APP. Nothing an app iframe can reach may expose that, so
// the bridge gets a surface with no membership parameter at all.
//
// This is what makes handle lookup work in STAGING: staging containers
// are injected with neither USERNODE_PLATFORM_API_URL nor an app token,
// so their server-side code cannot reach /api/app-platform/* — but the
// shell relay accepts #staging-iframe, so bridge-based lookups keep
// working in PR previews.
//
// Mounted AFTER authMiddleware in server.js: req.user is guaranteed.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const userDirectory = require('../services/user-directory');
const { userDirectoryLimiter } = require('../middleware/rate-limits');
const log = require('../services/logger');

// Directory answers are per-signed-in-user and change as people
// register; never let a shared cache hold one.
const NO_STORE = 'private, no-store, max-age=0';

function appDirectoryRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Exact-handle existence check. 200 { found:false, user:null } for a
  // miss; 400 only for input that cannot be a username at all.
  router.get('/api/app-directory/users/lookup', userDirectoryLimiter, async (req, res) => {
    res.set('Cache-Control', NO_STORE);
    const username = userDirectory.normalizeUsername(req.query.username);
    if (username === null) {
      return res.status(400).json({ error: 'username is required (1-255 characters).' });
    }
    try {
      const result = await userDirectory.lookupExact(pool, username);
      const body = { found: result.found, user: result.user };
      if (result.ambiguous) body.ambiguous = true;
      res.json(body);
    } catch (err) {
      log.error('app-directory', 'lookup failed', {
        userId: req.user?.id, message: err.message,
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Prefix typeahead. No membership filter — see the header note.
  router.get('/api/app-directory/users/search', userDirectoryLimiter, async (req, res) => {
    res.set('Cache-Control', NO_STORE);
    try {
      const { users, hasMore } = await userDirectory.searchPrefix(
        pool, req.query.q, req.query.limit
      );
      res.json({ users, has_more: hasMore });
    } catch (err) {
      log.error('app-directory', 'search failed', {
        userId: req.user?.id, message: err.message,
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = appDirectoryRoutes;
