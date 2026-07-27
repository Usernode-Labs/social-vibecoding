// Topochain v4 — admin API (SPEC §4.6; admin auth at SPEC 2193-2197).
//
// Mounted in server.js AFTER authMiddleware (architecture decision #2):
// this group reuses the PLATFORM's own admin auth — `adminMiddleware`
// gates every route on `is_admin` (any admin, full or view-only, may
// read), and `requireAdminWrite` additionally gates mutations on
// `canAdminWrite` (full admins only, i.e. `is_admin && !admin_readonly`).
// There is no separate topochain admin auth stack to build (SPEC 2193:
// "in v4 it is the target platform's own admin auth"). Non-admins get the
// platform's standard 403 shape from adminMiddleware itself.
//
// This module is a SKELETON for Task 3 (foundation): only the mount-order
// probe route exists, already behind adminMiddleware so its 403 behavior
// is testable now. Tasks 11-13 replace this file with the real endpoints
// (season-events, users, user-activities, challenge-templates,
// onchain-accounts, challenges, app-version-configs, settings, DB tooling).
'use strict';

const { Router } = require('express');
const { adminMiddleware } = require('../../middleware/admin');
const { ok } = require('./helpers');

function topochainAdminRoutes(_config) {
  const router = Router();

  // Every route under /api/v4/admin requires at least a (possibly
  // view-only) admin. DELIBERATE DEVIATION from src/routes/admin.js's
  // `router.use('/api/admin', adminMiddleware)` literal pattern: passing a
  // path to `.use()` makes Express strip that prefix from req.url/req.path
  // for the DURATION of that middleware's own execution (restored only
  // once it calls next() and the next layer is reached) — so INSIDE
  // adminMiddleware, req.path would already be relative (e.g. "/__ping",
  // not "/api/v4/admin/__ping"), and its `req.path.startsWith('/api/')`
  // branch would misfire, sending non-admin API callers a 302 redirect to
  // "/" instead of the documented 403 JSON. (This affects admin.js's own
  // mounting too — a pre-existing issue, out of scope here.) Mounting the
  // same middleware with NO path arg avoids the stripping entirely: this
  // router only ever receives /api/v4/admin/* requests (server.js mounts
  // it directly), so an unscoped `.use(adminMiddleware)` is equivalent in
  // effect and correct in req.path.
  router.use(adminMiddleware);

  // Mount-order + auth probe (plan Task 3): unlike the other four groups'
  // pings, this one IS gated (adminMiddleware above) so the "admin ping
  // sits behind platform admin auth" requirement is exercised even before
  // Tasks 11-13 land the real endpoints.
  router.get('/api/v4/admin/__ping', (_req, res) => ok(res, {}));

  return router;
}

module.exports = { topochainAdminRoutes };
