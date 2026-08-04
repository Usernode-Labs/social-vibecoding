'use strict';

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const visuals = require('../services/visuals');
const galleryDemo = require('../services/gallery-demo');

// Admin gallery API — read-only, behind an isAdmin guard (any admin, full
// or view-only; this is diagnostics, so no requireAdminWrite gate). Backs
// the #admin/gallery console section (the standalone /gallery page it used
// to back is a redirect stub since #860): merged proposals newest-first
// with their stored before/after capture groups, keyset-paged, filterable
// by app and by capture-problem class, plus a stats strip for the current
// filter.
//
// Staging mock data: chat_sessions + session_visuals are both
// `staging:private`, so a prod-cloned staging DB has nothing to show here.
// Under IS_STAGING + ?demo=1 all three endpoints below inject the
// obviously-fake rows from services/gallery-demo.js (read-path only,
// nothing written; no-op in prod) so a reviewer can exercise the tiles, the
// fell-back caption and the no-artifacts branch.
//
// The image BYTES are not served from here — tiles point at the existing
// public GET /visuals/:id (src/routes/visuals.js), which is deliberately
// mounted pre-auth so GitHub's camo proxy can fetch PR-body embeds
// anonymously. That asymmetry is intentional and must not be "fixed":
// this admin gate protects the INDEX (which proposals exist, what shape
// their captures are, why they failed), not the artifacts, which are
// already public in PR bodies on GitHub.

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// Capture-problem filters. Anything not in this set is IGNORED (returns the
// unfiltered page) rather than erroring, matching the STATUS_VALUES stance
// in routes/debug.js.
//
// Each entry is a SQL fragment over the outer `cs` row. `relaxVisuals` marks
// the one filter that must drop the "has artifacts" precondition: a failed /
// console-only session has no artifacts by definition, so requiring them
// would make the filter always empty.
// Each `sql` must be SELF-CONTAINED and true only when the problem really
// applies: the stats endpoint splices these into COUNT(*) FILTER (WHERE …)
// over a row set that can include artifact-less proposals, and a bare
// NOT EXISTS is VACUOUSLY true for those. A console-only proposal is not
// "missing a recording" — it never wanted one — so the three
// artifact-dependent filters carry their own HAS_VISUALS guard rather than
// leaning on the list query's precondition.
const PROBLEM_FILTERS = {
  // Stills but no recording — the top failure mode this page scores.
  missing_recording: {
    sql: `EXISTS (SELECT 1 FROM session_visuals v WHERE v.session_id = cs.id)
          AND NOT EXISTS (SELECT 1 FROM session_visuals v WHERE v.session_id = cs.id AND v.media = 'webm')`,
  },
  // No "before" side at all (prod was down, or both navigations failed).
  missing_before: {
    sql: `EXISTS (SELECT 1 FROM session_visuals v WHERE v.session_id = cs.id)
          AND NOT EXISTS (SELECT 1 FROM session_visuals v WHERE v.session_id = cs.id AND v.kind = 'before')`,
  },
  // The deep "before" path 404'd on prod and was re-shot at '/'.
  before_fell_back: {
    sql: `EXISTS (SELECT 1 FROM session_visuals v WHERE v.session_id = cs.id AND v.before_fell_back)`,
  },
  // Every shot was of the app root — the change's own screen was never shown.
  root_only: {
    sql: `EXISTS (SELECT 1 FROM session_visuals v WHERE v.session_id = cs.id)
          AND NOT EXISTS (SELECT 1 FROM session_visuals v
                           WHERE v.session_id = cs.id
                             AND v.captured_path IS NOT NULL AND v.captured_path <> '/')`,
  },
  // Ran but produced no / partial media, per the persisted outcome.
  failed_or_skipped: {
    sql: `cs.capture_state IN ('failed', 'console_only', 'partial')`,
    relaxVisuals: true,
  },
};

// Base predicate: merged proposals only, newest-first orderable. `merged_at
// IS NOT NULL` both drives the index scan (chat_sessions_merged_at_idx) and
// keeps the keyset cursor total — measured on production, all merged
// sessions carrying visuals have a merged_at, so this excludes nothing real.
const BASE_WHERE = `cs.status = 'merged' AND cs.merged_at IS NOT NULL`;
const HAS_VISUALS = `EXISTS (SELECT 1 FROM session_visuals v WHERE v.session_id = cs.id)`;

// Clamp a client-supplied page size. Page size is bounded by PAGE WEIGHT,
// not query cost: production averages ~503 KB of PNG per proposal (p90
// ~1 MB), so 20 rows is ~10 MB of images if every tile loads. The renderer
// mitigates with loading="lazy" / preload="none" so only the visible slice
// is fetched.
function resolveLimit(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

// Parse the keyset cursor. Both halves must be present and valid, else
// there's no cursor (first page) — a half-supplied cursor silently paging
// from the top is the correct degradation here.
function resolveCursor(beforeRaw, beforeIdRaw) {
  const beforeId = parseInt(beforeIdRaw, 10);
  if (beforeRaw == null || beforeRaw === '' || !Number.isFinite(beforeId)) return null;
  const before = new Date(beforeRaw);
  if (Number.isNaN(before.getTime())) return null;
  return { before: before.toISOString(), beforeId };
}

// Normalize the ?problem= value to a known key, or null (= no filter).
function resolveProblem(raw) {
  const key = raw == null ? '' : String(raw);
  return Object.prototype.hasOwnProperty.call(PROBLEM_FILTERS, key) ? key : null;
}

// Build the shared WHERE clause + params for both the list and the stats
// endpoint. Mirrors the incremental `add()` builder in routes/debug.js so
// the two admin pages stay recognisably the same shape.
function buildWhere({ app, problem, cursor }) {
  const where = [BASE_WHERE];
  const params = [];
  const add = (frag, val) => { params.push(val); where.push(frag.replace('$$', `$${params.length}`)); };

  // app filter accepts a slug or a numeric id, exactly like /api/debug.
  if (app != null && app !== '') {
    if (/^\d+$/.test(String(app))) add('cs.app_id = $$', parseInt(app, 10));
    else add('a.slug = $$', String(app));
  }

  const pf = problem ? PROBLEM_FILTERS[problem] : null;
  // The artifact precondition is relaxed only for failed_or_skipped, whose
  // whole point is proposals that stored nothing.
  if (!pf || !pf.relaxVisuals) where.push(HAS_VISUALS);
  if (pf) where.push(pf.sql);

  if (cursor) {
    params.push(cursor.before, cursor.beforeId);
    where.push(`(cs.merged_at, cs.id) < ($${params.length - 1}, $${params.length})`);
  }

  return { whereSql: where.join(' AND '), params };
}

function galleryRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Admin gate. Returns a 403 JSON directly rather than reusing
  // adminMiddleware: that one branches on req.path, which Express strips of
  // the '/api/gallery' mount prefix inside a sub-router, so it would
  // 302-redirect an API caller instead of 403ing them. (Same reasoning, and
  // the same bug avoided, as routes/debug.js.)
  router.use('/api/gallery', (req, res, next) => {
    if (!req.user?.isAdmin) return res.status(403).json({ error: 'Admin access required' });
    next();
  });

  // Merged proposals + their capture groups, newest first, keyset-paged on
  // (merged_at, id). Selects artifact METADATA only — never session_visuals.data
  // — so no image bytes cross this endpoint.
  router.get('/api/gallery/proposals', async (req, res) => {
    try {
      const limit = resolveLimit(req.query.limit);
      const problem = resolveProblem(req.query.problem);
      const cursor = resolveCursor(req.query.before, req.query.before_id);
      const { whereSql, params } = buildWhere({ app: req.query.app, problem, cursor });

      params.push(limit + 1);
      const { rows } = await pool.query(
        `SELECT cs.id, cs.merged_at, cs.pr_number, cs.pr_url, cs.pr_title, cs.session_title,
                cs.capture_state, cs.capture_detail, cs.captured_at,
                cs.app_id, a.slug AS app_slug, a.name AS app_name,
                (SELECT jsonb_agg(jsonb_build_object(
                          'id', v.id, 'kind', v.kind, 'media', v.media,
                          'capture_index', v.capture_index,
                          'captured_path', v.captured_path,
                          'captured_viewport', v.captured_viewport,
                          'before_fell_back', v.before_fell_back,
                          'shot_status', v.shot_status)
                        ORDER BY v.capture_index, v.kind, v.media)
                   FROM session_visuals v WHERE v.session_id = cs.id) AS artifacts
           FROM chat_sessions cs
           LEFT JOIN apps a ON a.id = cs.app_id
          WHERE ${whereSql}
          ORDER BY cs.merged_at DESC, cs.id DESC
          LIMIT $${params.length}`,
        params
      );

      let hasMore = false;
      if (rows.length > limit) { hasMore = true; rows.length = limit; }

      // Group each row's flat artifact list through services/visuals.js's
      // groupRows — the SAME implementation the proposal cards and PR bodies
      // use — so the client just renders and nothing can drift.
      const proposals = rows.map((r) => {
        const grouped = visuals.groupRows(Array.isArray(r.artifacts) ? r.artifacts : []);
        return {
          id: r.id,
          mergedAt: r.merged_at,
          prNumber: r.pr_number,
          prUrl: r.pr_url,
          title: r.session_title || r.pr_title || null,
          appId: r.app_id,
          appSlug: r.app_slug,
          appName: r.app_name,
          captureState: r.capture_state || null,
          captureReason: (r.capture_detail && r.capture_detail.reason) || null,
          captureDetail: r.capture_detail || null,
          capturedAt: r.captured_at,
          visuals: grouped,
        };
      });

      // Staging demo rows (?demo=1) — first page only, prepended, so paging
      // through real rows afterwards still behaves. Same shape/stance as
      // routes/debug.js's stagingMockMergeRuns.
      const demo = galleryDemo.IS_STAGING && req.query.demo === '1' && !cursor
        ? galleryDemo.demoProposals()
        : [];

      const last = rows[rows.length - 1];
      res.json({
        proposals: demo.concat(proposals),
        hasMore,
        nextCursor: hasMore && last ? { before: last.merged_at, before_id: last.id } : null,
      });
    } catch (err) {
      log.error('gallery', 'List gallery proposals failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Distinct apps with gallery-eligible proposals — for the filter dropdown.
  router.get('/api/gallery/apps', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT a.id, a.slug, a.name, COUNT(DISTINCT cs.id)::int AS proposal_count
           FROM chat_sessions cs
           JOIN apps a ON a.id = cs.app_id
          WHERE cs.status = 'merged' AND cs.merged_at IS NOT NULL
            AND EXISTS (SELECT 1 FROM session_visuals v WHERE v.session_id = cs.id)
          GROUP BY a.id, a.slug, a.name
          ORDER BY a.name ASC`
      );
      // Staging demo (?demo=1): surface the synthetic app so the filter
      // dropdown isn't empty next to the injected rows.
      const demoApps = galleryDemo.IS_STAGING && req.query.demo === '1'
        && !rows.some((r) => r.slug === galleryDemo.DEMO_APP.slug)
        ? [galleryDemo.DEMO_APP]
        : [];
      res.json({ apps: demoApps.concat(rows) });
    } catch (err) {
      log.error('gallery', 'List gallery apps failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Counters for the current filter — the "is capture still failing?"
  // scoreboard. Same predicate set as the list, minus the cursor and the
  // artifact aggregate.
  router.get('/api/gallery/stats', async (req, res) => {
    try {
      const problem = resolveProblem(req.query.problem);
      const { whereSql, params } = buildWhere({ app: req.query.app, problem, cursor: null });
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE ${PROBLEM_FILTERS.missing_recording.sql})::int AS missing_recording,
                COUNT(*) FILTER (WHERE ${PROBLEM_FILTERS.missing_before.sql})::int AS missing_before,
                COUNT(*) FILTER (WHERE ${PROBLEM_FILTERS.before_fell_back.sql})::int AS before_fell_back,
                COUNT(*) FILTER (WHERE ${PROBLEM_FILTERS.root_only.sql})::int AS root_only,
                COUNT(*) FILTER (WHERE ${PROBLEM_FILTERS.failed_or_skipped.sql})::int AS failed_or_skipped,
                COUNT(*) FILTER (WHERE cs.capture_state = 'captured')::int AS complete,
                COUNT(*) FILTER (WHERE cs.capture_state IS NULL)::int AS unknown_state
           FROM chat_sessions cs
           LEFT JOIN apps a ON a.id = cs.app_id
          WHERE ${whereSql}`,
        params
      );
      // Staging demo (?demo=1): the injected list rows aren't in the DB, so
      // add their counts on top of the real ones.
      if (galleryDemo.IS_STAGING && req.query.demo === '1') {
        const real = rows[0] || {};
        const demo = galleryDemo.demoStats();
        const merged = { ...real };
        for (const [k, v] of Object.entries(demo)) {
          merged[k] = (Number(real[k]) || 0) + v;
        }
        return res.json({ stats: merged, demo: true });
      }
      res.json({ stats: rows[0] || {} });
    } catch (err) {
      log.error('gallery', 'Gallery stats failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = {
  galleryRoutes,
  // Exported for unit tests (pure helpers, no DB).
  resolveLimit,
  resolveCursor,
  resolveProblem,
  buildWhere,
  PROBLEM_FILTERS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
