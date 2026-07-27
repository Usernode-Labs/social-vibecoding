// Topochain v4 — partner API (SPEC §4.3, api.key middleware at SPEC 1320,
// architecture decision #5).
//
// Mounted in server.js BEFORE authMiddleware: partner callers authenticate
// with a per-deployment shared secret (X-API-Key), never a platform
// session — every route in this group applies `partnerApiKey(config)`
// (src/middleware/topochain-auth.js) itself.
//
// This module is a SKELETON for Task 3 (foundation): only the mount-order
// probe route exists. Task 6 replaces this file with the real endpoints
// (`POST /api/v4/user-activities`, `GET /api/v4/delegations`,
// `GET`/`PUT /api/v4/delegations/:account`) built on `partnerApiKey` +
// `src/routes/topochain/helpers.js`.
'use strict';

const { Router } = require('express');
const { ok } = require('./helpers');

function topochainPartnerRoutes(_config) {
  const router = Router();

  // Mount-order probe (plan Task 3). Deliberately NOT gated by
  // partnerApiKey — it exists only to prove this router sits ahead of
  // authMiddleware; Task 6's real endpoints apply the key check per route.
  router.get('/api/v4/partner/__ping', (_req, res) => ok(res, {}));

  return router;
}

module.exports = { topochainPartnerRoutes };
