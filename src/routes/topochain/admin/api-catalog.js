// Topochain v4 admin API — the /api/v4 route catalog.
//
// One read-only endpoint whose whole job is to answer "what can the API
// tester actually call?". The admin console's API tester used to ship a
// single hardcoded placeholder path (`/season-events`, which is not even a
// mounted route — the real one is `/admin/season-events`), so an operator
// had to already know the surface to use the tool. This endpoint hands the
// tester the real list.
//
// DERIVED, NOT HARDCODED. The catalog is introspected from Express's own
// router stack at request time, so it is by construction the set of routes
// this build actually mounted: a route added, renamed or deleted anywhere
// under src/routes/topochain/ shows up here on the next request with no
// edit to this file, and a hand-maintained list can never drift out of
// date. Only the METHOD and PATH are exposed — never a handler, never a
// middleware name, never anything about auth internals.
//
// Why walking the stack is exact here: every /api/v4 router is mounted
// UNSCOPED in server.js (`app.use(topochainAdminRoutes(config))`, no path
// argument) and declares absolute paths inside, so a route layer's own
// `route.path` is already the full public path. The walker below still
// carries a mount prefix for path-mounted routers it may meet on the way
// down, and tests/topochain-api-catalog.test.js pins both the shape and a
// floor on the count so a future re-mount that broke the assumption fails
// loudly instead of quietly returning an empty list.
'use strict';

const { Router } = require('express');
const log = require('../../../services/logger');
const { ok, fail } = require('../helpers');

const V4_PREFIX = '/api/v4';

// The verbs the tester offers. `head` and `_all` are deliberately dropped:
// Express registers HEAD alongside every GET, and an `.all()` layer is not
// a callable endpoint an operator would pick from a list.
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const METHOD_RANK = new Map(METHODS.map((m, i) => [m, i]));

// Group headings the tester renders as <optgroup> labels. Derived from the
// path, with the handful of segments whose title-cased form reads wrong
// spelled out.
const SEGMENT_LABELS = {
  __ping: 'Ping',
  'api-catalog': 'API catalog',
  'app-version-configs': 'App version',
  'bp-queue': 'BP queue',
  'sql-query': 'SQL query',
};

// Non-admin, non-prefixed v4 paths (`/api/v4/delegations`,
// `/api/v4/slot-outcomes`, …) belong to the partner and ingest routers but
// carry no distinguishing prefix, so they share one heading rather than
// fragmenting into a group per path.
const OTHER_GROUP = 'Other v4 routes';

// Heading order: the admin surface first (it is what an operator on this
// screen is almost always after), alphabetical within itself, then the
// token-authenticated groups, then the unprefixed leftovers.
const GROUP_RANK = { Mobile: 1, Partner: 2, Ingest: 3, [OTHER_GROUP]: 4 };

function titleize(seg) {
  if (SEGMENT_LABELS[seg]) return SEGMENT_LABELS[seg];
  const words = String(seg).replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// `/admin/seasons/:id` -> "Admin · Seasons"; `/mobile/me` -> "Mobile".
function groupFor(relPath) {
  const segs = relPath.split('/').filter(Boolean);
  if (segs[0] === 'admin') return segs[1] ? `Admin · ${titleize(segs[1])}` : 'Admin';
  if (segs[0] === 'mobile' || segs[0] === 'partner' || segs[0] === 'ingest') {
    return titleize(segs[0]);
  }
  return OTHER_GROUP;
}

function groupRank(group) {
  return group in GROUP_RANK ? GROUP_RANK[group] : 0;
}

// Express 4 compiles a string mount path into `/^\/api\/v4\/foo\/?(?=\/|$)/i`
// and records the literal segments on `layer.keys`-less regexps as
// `regexp.source`. `fast_slash` marks the unscoped `app.use(fn)` case,
// which is the one every v4 router actually uses.
function mountPrefix(layer) {
  const re = layer && layer.regexp;
  if (!re || re.fast_slash) return '';
  const m = /^\^\\\/(.*?)\\\/\?\(\?=\\\/\|\$\)/.exec(re.source);
  if (!m) return null; // unrecognised (parameterised mount) — don't guess
  return `/${m[1].replace(/\\(.)/g, '$1')}`;
}

// Depth-first walk of a router stack, collecting `${METHOD} ${path}` pairs.
function collectRoutes(stack, prefix, out) {
  for (const layer of stack || []) {
    if (layer.route && layer.route.path) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) {
        if (typeof p !== 'string') continue; // a RegExp route has no listable path
        const full = `${prefix}${p}`;
        if (!full.startsWith(V4_PREFIX)) continue;
        for (const method of METHODS) {
          if (layer.route.methods && layer.route.methods[method.toLowerCase()]) {
            out.add(`${method} ${full}`);
          }
        }
      }
      continue;
    }
    const nested = layer.handle && layer.handle.stack;
    if (!nested) continue;
    const sub = mountPrefix(layer);
    if (sub === null) continue;
    collectRoutes(nested, `${prefix}${sub}`, out);
  }
}

// The catalog the tester renders, sorted into its display order.
function buildCatalog(app) {
  const seen = new Set();
  // Express 5 moved the stack to `app.router`; keep both spellings so an
  // upgrade doesn't silently empty the list.
  const root = (app && app._router) || (app && app.router) || null;
  collectRoutes(root && root.stack, '', seen);

  const routes = [...seen].map((entry) => {
    const sp = entry.indexOf(' ');
    const method = entry.slice(0, sp);
    const fullPath = entry.slice(sp + 1);
    const path = fullPath.slice(V4_PREFIX.length) || '/';
    return {
      method,
      path,
      full_path: fullPath,
      group: groupFor(path),
      // A path with an `:id`-style segment can't be called as-is — the
      // tester keeps its free-text field open for these so the operator
      // can substitute the value.
      has_params: /:[A-Za-z0-9_]+/.test(path),
    };
  });

  routes.sort((a, b) => (
    groupRank(a.group) - groupRank(b.group)
    || a.group.localeCompare(b.group)
    || a.path.localeCompare(b.path)
    || (METHOD_RANK.get(a.method) - METHOD_RANK.get(b.method))
  ));

  const groups = [];
  for (const r of routes) if (!groups.includes(r.group)) groups.push(r.group);
  return { routes, groups };
}

function apiCatalogAdminRoutes() {
  const router = Router();

  // Read-only: covered by ../admin.js's router-wide adminReadGate, so a
  // view-only admin may list the surface (they simply get the platform's
  // own 403 if they then fire a mutation at it).
  router.get('/api/v4/admin/api-catalog', (req, res) => {
    try {
      const { routes, groups } = buildCatalog(req.app);
      return ok(res, { data: routes }, {
        prefix: V4_PREFIX,
        groups,
        count: routes.length,
      });
    } catch (err) {
      log.error('[topochain] api-catalog introspection failed', err);
      return fail(res, 500, 'Could not read the route catalog.');
    }
  });

  return router;
}

module.exports = { apiCatalogAdminRoutes, buildCatalog };
