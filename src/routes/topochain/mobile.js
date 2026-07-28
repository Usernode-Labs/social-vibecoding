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
// Task 3 built the mount-order probe below. Task 8 (this task) composes
// in the auth sub-surface (./mobile-auth.js: check-email, login,
// otp/request, otp/verify, set-password, logout) + its mailer
// (src/services/topochain/mailer.js). Tasks 9-10 will add this router's
// remaining data endpoints (me, leaderboard, challenges, seasons, terms,
// logs, zkpassport, delegation).
'use strict';

const { Router } = require('express');
const { ok } = require('./helpers');
const { topochainMobileAuthRoutes } = require('./mobile-auth');

function topochainMobileRoutes(config) {
  const router = Router();

  // Mount-order probe (plan Task 3). Deliberately NOT gated by
  // mobileTokenAuth — it exists only to prove this router sits ahead of
  // authMiddleware; the real per-route auth lives on each endpoint below.
  router.get('/api/v4/mobile/__ping', (_req, res) => ok(res, {}));

  // Task 8: the six auth endpoints (their own throttle/token gating).
  router.use(topochainMobileAuthRoutes(config));

  return router;
}

module.exports = { topochainMobileRoutes };
