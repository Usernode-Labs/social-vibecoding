// Topochain v4 — public reads (SPEC §4.2, "auth.optional" at SPEC 900).
//
// Mounted in server.js BEFORE authMiddleware (architecture decision #2):
// every route in this group carries its OWN auth via optionalSessionAuth
// (src/middleware/topochain-auth.js) — a valid platform session enriches
// the response (e.g. an admin sees fields a Resource class gates on
// is_admin), but no session is required and the request never 401s.
//
// This module is a SKELETON for Task 3 (foundation): only the mount-order
// probe route exists. Task 5 replaces this file with the real endpoints
// (`/api/v4/leaderboard*`, `/api/v4/season-events*`, `/api/v4/users/:id/profile`,
// `POST /api/v4/app-version/check`) built on `optionalSessionAuth` +
// `src/routes/topochain/helpers.js`.
'use strict';

const { Router } = require('express');
const { ok } = require('./helpers');

function topochainPublicRoutes(_config) {
  const router = Router();

  // Mount-order probe (plan Task 3): confirms this router is reachable
  // ahead of authMiddleware without requiring a session. Real public-read
  // endpoints land in Task 5.
  router.get('/api/v4/public/__ping', (_req, res) => ok(res, {}));

  return router;
}

module.exports = { topochainPublicRoutes };
