// Topochain v4 — admin API (SPEC §4.6; admin auth at SPEC 2193-2197).
//
// Mounted in server.js AFTER authMiddleware (architecture decision #2):
// this group reuses the PLATFORM's own admin auth — `adminMiddleware`
// gates every route on `is_admin` (any admin, full or view-only, may
// read), and `requireAdminWrite` additionally gates mutations on
// `canAdminWrite` (full admins only, i.e. `is_admin && !admin_readonly`).
// There is no separate topochain admin auth stack to build (SPEC 2193:
// "in v4 it is the target platform's own admin auth"). See ./admin/auth.js
// for how the platform middlewares' OWN 403 bodies are reconciled with
// the v4-mandated error shape/wording (SPEC 2193) without touching
// src/middleware/admin.js itself.
//
// This file is a thin composer (Task 11 onward): it owns the router-wide
// auth gate, the mount-order probe, and mounts one factory per D-group —
// each named submodule under ./admin/ is a full route module in its own
// right (Router factory, absolute paths inside), just like every other
// topochain route file, kept in a subfolder purely because there are
// several of them (plan Task 11's "split into admin/ modules composed by
// admin.js" allowance).
'use strict';

const { Router } = require('express');
const { ok } = require('./helpers');
const { adminReadGate } = require('./admin/auth');
const { seasonEventsAdminRoutes } = require('./admin/season-events');
const { usersAdminRoutes } = require('./admin/users');
const { userActivitiesAdminRoutes } = require('./admin/user-activities');

function topochainAdminRoutes(config) {
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
  // "/" instead of the documented 403 JSON. Mounting the same middleware
  // with NO path arg avoids the stripping entirely (req.path stays the
  // full "/api/v4/admin/..." path throughout).
  //
  // BUT this router is mounted UNSCOPED in server.js (`app.use(topochain
  // AdminRoutes(config))`, no path — see server.js's own mount comment),
  // sitting BEFORE express.static, `/admin`, `/dashboard` and the SPA
  // catch-all (server.js:526+). `router.use(mw)` with no path runs `mw`
  // for EVERY request that reaches this router, regardless of whether any
  // route defined below actually matches — so without the guard below, a
  // logged-in NON-ADMIN hitting literally anything else in the app
  // (`/dashboard`, `/`, a static asset, ...) would hit `adminReadGate`
  // first, get its non-API-path branch (`res.redirect('/')`), and never
  // reach the real handler — worse, `/` isn't itself an /api/ path either,
  // so the redirect target hits this same gate again: an actual infinite
  // redirect loop for every non-admin user trying to load anything past
  // this mount point. (Reproduced directly: a bare `GET /dashboard` with
  // `req.user = {isAdmin:false}` came back `302 -> /`, and `GET /` came
  // back `302 -> /` again.) The guard below makes this router a no-op
  // (`next()`) for any request outside its own `/api/v4/admin/` prefix —
  // req.path is never stripped here (see above), so this check is exact —
  // restoring the "only ever receives /api/v4/admin/* requests" invariant
  // the rest of this file's comments (and adminReadGate's own req.path
  // logic) already assume.
  router.use((req, res, next) => {
    if (!req.path.startsWith('/api/v4/admin/')) return next();
    return adminReadGate(req, res, next);
  });

  // Mount-order + auth probe (plan Task 3): unlike the other four groups'
  // pings, this one IS gated (adminReadGate above) so the "admin ping
  // sits behind platform admin auth" requirement is exercised even before
  // the real endpoints below.
  router.get('/api/v4/admin/__ping', (_req, res) => ok(res, {}));

  // Task 11: D1 season-events, D2 users, D3 user-activities.
  router.use(seasonEventsAdminRoutes(config));
  router.use(usersAdminRoutes(config));
  router.use(userActivitiesAdminRoutes(config));

  return router;
}

module.exports = { topochainAdminRoutes };
