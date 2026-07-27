// Topochain v4 — mobile surface (SPEC §4.5; token model + throttling at
// SPEC 1588-1599; v2+v3 merged into one token-only surface).
//
// Mounted in server.js BEFORE authMiddleware: mobile clients never hold a
// platform session cookie. Two sub-shapes live in this one router:
//   - Public, throttled auth endpoints (check-email, login, otp/request,
//     otp/verify) — share the ONE `topochainMobileAuthLimiter` bucket
//     (src/middleware/rate-limits.js), 10 req/min/IP (SPEC 1597).
//   - Session-token auth endpoints (set-password, logout, and every data
//     endpoint: me, me/ranking, me/breakdown, event/points, leaderboard,
//     challenges, seasons, terms/*, logs, zkpassport/complete,
//     delegation) — gated by `mobileTokenAuth(config, {ability})`
//     (src/middleware/topochain-auth.js); the user is ALWAYS resolved from
//     the token, never a client-supplied id (constraint #12).
//
// This module is a SKELETON for Task 3 (foundation): only the mount-order
// probe route exists. Task 8 builds the auth endpoints + mailer; Tasks 9-10
// build the data endpoints.
'use strict';

const { Router } = require('express');
const { ok } = require('./helpers');

function topochainMobileRoutes(_config) {
  const router = Router();

  // Mount-order probe (plan Task 3). Deliberately NOT gated by
  // mobileTokenAuth — it exists only to prove this router sits ahead of
  // authMiddleware; Tasks 8-10 apply the real per-route auth.
  router.get('/api/v4/mobile/__ping', (_req, res) => ok(res, {}));

  return router;
}

module.exports = { topochainMobileRoutes };
