const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// Admin /debug API — read-only, behind adminMiddleware (any admin, full or
// view-only; this is diagnostics, so no requireAdminWrite gate). Backs the
// /debug page: a list of merge / conflict-resolution runs with keyset
// paging + filters, a single run with its ordered steps, and the distinct
// apps that have runs (for the filter dropdown).

// Allowed terminal/in-flight statuses for the ?outcome= filter. Anything
// else is ignored (returns the unfiltered page) rather than erroring.
const STATUS_VALUES = new Set([
  'running', 'merged', 'blocked', 'conflict_resolving',
  'conflict_failed', 'awaiting_github', 'noop', 'error',
]);
const KIND_VALUES = new Set(['merge', 'conflict_resolution']);

// ── Staging mock data ──────────────────────────────────────────────────
// merge_debug_runs is new + staging:private, so a staging clone has zero
// rows and the /debug view would render empty. Under IS_STAGING + ?demo=1
// we inject obviously-fake runs (ids far above anything real, a synthetic
// 'staging-demo' app) so a tester can exercise the list, the per-run
// timeline, and every outcome badge against a prod-cloned DB. Read-path
// injection only — nothing is written to the staging DB. No-op in prod.
function stagingMockMergeRuns() {
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const mk = (id, prNumber, title, kind, trigger, status, hours, durationMin, steps) => {
    const started = hoursAgo(hours);
    const ended = status === 'running'
      ? null
      : new Date(Date.now() - (hours * 3600 - durationMin * 60) * 1000).toISOString();
    return {
      id,
      app_id: 0,
      app_slug: 'staging-demo',
      app_name: 'Staging demo app',
      session_id: 80000 + (id - 9500000),
      pr_number: prNumber,
      pr_title: title,
      kind,
      trigger,
      status,
      summary: steps.length ? steps[steps.length - 1].message : null,
      started_at: started,
      ended_at: ended,
      step_count: steps.length,
      _steps: steps.map((s, i) => ({
        id: id * 100 + i,
        run_id: id,
        seq: i,
        phase: s.phase,
        level: s.level || 'info',
        message: s.message,
        detail: s.detail || {},
        created_at: new Date(new Date(started).getTime() + i * 1500).toISOString(),
      })),
    };
  };

  return [
    // 1. Clean merge.
    mk(9500001, 900201, 'Add a dark-mode toggle to the settings drawer',
      'merge', 'vote', 'merged', 2, 1, [
        { phase: 'gate:majority', message: 'Majority reached: 3 of 3 active users voted yes.', detail: { yesCount: 3, majority: 3, activeCount: 3 } },
        { phase: 'gate:lock', message: 'App is not locked — no admin-yes requirement.' },
        { phase: 'gate:behind_main', message: 'Branch is up to date with main (0 behind).', detail: { behind: 0 } },
        { phase: 'gate:checks', message: 'Checks gate: state = passing.', detail: { checkState: 'passing' } },
        { phase: 'claim', message: 'Claimed merge (promoted → merging).' },
        { phase: 'github_merge', message: 'Calling GitHub merge for PR #900201…' },
        { phase: 'github_merge', message: 'GitHub merged PR #900201 as commit abc1234.', detail: { sha: 'abc1234ef' } },
        { phase: 'prod_rebuild', message: 'Production rebuild started.' },
        { phase: 'prod_rebuild', message: 'Production rebuild finished (deployed def5678).', detail: { sha: 'def5678ab' } },
        { phase: 'staging_teardown', message: 'Staging container torn down.' },
        { phase: 'merged', message: 'Marked session merged.' },
      ]),
    // 2. Conflict auto-resolved, then merged.
    mk(9500002, 900202, 'Refactor the feed renderer for infinite scroll',
      'conflict_resolution', 'merge_conflict', 'merged', 5, 3, [
        { phase: 'github_merge', message: 'GitHub returned 405: merge conflict.', level: 'warn', detail: { status: 405 } },
        { phase: 'conflict_detected', message: 'Conflict detected — starting automatic resolution.' },
        { phase: 'pollMergeable', message: 'GitHub mergeability settled: mergeable = false.', detail: { mergeable: false } },
        { phase: 'needs_sync', message: 'Branch needs a worker sync with main (behind 2, conflicting).', detail: { behind: 2 } },
        { phase: 'persist:resolving', message: 'Snapshot → resolving.' },
        { phase: 'sync:sync_fetch_main', message: 'Worker sync: fetching main…' },
        { phase: 'sync:sync_merge', message: 'Worker sync: merging origin/main…' },
        { phase: 'sync:sync_conflict_cc', message: 'Worker sync: resolving conflicts with Claude…' },
        { phase: 'sync:sync_push', message: 'Worker sync: pushing…' },
        { phase: 'sync_result', message: 'Claude resolved conflicts in src/app.js, public/index.html and pushed 9f8e7d6.', detail: { syncResult: 'resolved', conflictFiles: ['src/app.js', 'public/index.html'], sha: '9f8e7d6c', costUsd: 0.041 } },
        { phase: 'persist:clean', message: 'Snapshot → clean.' },
        { phase: 'waitForMergeableTrue', message: 'Waiting for GitHub to confirm mergeability… mergeable = true.', detail: { mergeable: true } },
        { phase: 'retry_merge', message: 'Re-attempting merge… merged as commit 1122334.', detail: { sha: '1122334dd' } },
        { phase: 'merged', message: 'Marked session merged (synced_and_merged).' },
      ]),
    // 3. Conflict resolution failed.
    mk(9500003, 900203, 'Rework the leaderboard query for weekly windows',
      'conflict_resolution', 'drift', 'conflict_failed', 8, 2, [
        { phase: 'pollMergeable', message: 'GitHub mergeability settled: mergeable = false.', detail: { mergeable: false } },
        { phase: 'needs_sync', message: 'Branch needs a worker sync with main (behind 4, conflicting).', detail: { behind: 4 } },
        { phase: 'persist:resolving', message: 'Snapshot → resolving.' },
        { phase: 'sync:sync_conflict_cc', message: 'Worker sync: resolving conflicts with Claude…' },
        { phase: 'sync_result', message: 'Claude could not resolve the conflicts; branch left unchanged.', level: 'error', detail: { syncResult: 'conflict', conflictFiles: ['src/services/leaderboard.js', 'src/db/schema.sql'] } },
        { phase: 'persist:failed', message: 'Snapshot → failed.', level: 'warn' },
        { phase: 'group_chat', message: "Posted to group chat: couldn't auto-merge — owner must resolve in dev-chat.", detail: { reason: 'unresolved_conflict' } },
        { phase: 'outcome', message: 'Resolution failed (unresolved_conflict).', level: 'error', detail: { reason: 'unresolved_conflict' } },
      ]),
    // 4. Blocked at a gate (votes reached, checks failing) — the #421/#431 case.
    mk(9500004, 900204, 'Add a copy-link button to merged proposals',
      'merge', 'vote', 'blocked', 1, 0, [
        { phase: 'gate:majority', message: 'Majority reached: 4 of 3 active users voted yes.', detail: { yesCount: 4, majority: 3, activeCount: 3 } },
        { phase: 'gate:lock', message: 'App is not locked — no admin-yes requirement.' },
        { phase: 'gate:behind_main', message: 'Branch is up to date with main (0 behind).', detail: { behind: 0 } },
        { phase: 'gate:checks', message: 'Merge blocked: checks not passing (state = failing, 2 tests failing).', level: 'warn', detail: { checkState: 'failing', failingCount: 2 } },
        { phase: 'outcome', message: 'Blocked — votes reached but checks must pass first.', level: 'warn', detail: { checksBlocked: true } },
      ]),
  ];
}

function debugRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Admin gate for the read-only diagnostics API. Both full and view-only
  // admins pass (isAdmin covers both). We return a 403 JSON directly rather
  // than reusing adminMiddleware: that one branches on req.path, which
  // Express strips of the '/api/debug' mount prefix inside a sub-router, so
  // it would 302-redirect an API caller instead of 403ing them.
  router.use('/api/debug', (req, res, next) => {
    if (!req.user?.isAdmin) return res.status(403).json({ error: 'Admin access required' });
    next();
  });

  // List runs, newest first, keyset-paged on (started_at, id).
  router.get('/api/debug/merge-runs', async (req, res) => {
    try {
      let limit = parseInt(req.query.limit, 10);
      if (!Number.isFinite(limit) || limit < 1) limit = 30;
      if (limit > 100) limit = 100;

      const where = [];
      const params = [];
      const add = (frag, val) => { params.push(val); where.push(frag.replace('$$', `$${params.length}`)); };

      // app filter accepts a slug or a numeric id.
      const appRaw = req.query.app;
      if (appRaw != null && appRaw !== '') {
        if (/^\d+$/.test(String(appRaw))) add('r.app_id = $$', parseInt(appRaw, 10));
        else add('a.slug = $$', String(appRaw));
      }
      const sid = parseInt(req.query.session_id, 10);
      if (Number.isFinite(sid)) add('r.session_id = $$', sid);
      const prn = parseInt(req.query.pr_number, 10);
      if (Number.isFinite(prn)) add('r.pr_number = $$', prn);
      const outcome = req.query.outcome || req.query.status;
      if (outcome && STATUS_VALUES.has(String(outcome))) add('r.status = $$', String(outcome));
      if (req.query.kind && KIND_VALUES.has(String(req.query.kind))) add('r.kind = $$', String(req.query.kind));

      // Keyset cursor: strictly older than (before, before_id).
      const beforeRaw = req.query.before;
      const beforeId = parseInt(req.query.before_id, 10);
      const before = beforeRaw != null ? new Date(beforeRaw) : null;
      const hasCursor = before != null && !Number.isNaN(before.getTime()) && Number.isFinite(beforeId);
      if (hasCursor) {
        params.push(before.toISOString(), beforeId);
        where.push(`(r.started_at, r.id) < ($${params.length - 1}, $${params.length})`);
      }

      params.push(limit + 1);
      const { rows } = await pool.query(
        `SELECT r.id, r.app_id, a.slug AS app_slug, a.name AS app_name,
                r.session_id, r.pr_number, cs.pr_title,
                r.kind, r.trigger, r.status, r.summary, r.started_at, r.ended_at,
                (SELECT COUNT(*)::int FROM merge_debug_steps s WHERE s.run_id = r.id) AS step_count
           FROM merge_debug_runs r
           LEFT JOIN apps a ON a.id = r.app_id
           LEFT JOIN chat_sessions cs ON cs.id = r.session_id
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY r.started_at DESC, r.id DESC
          LIMIT $${params.length}`,
        params
      );

      let hasMore = false;
      if (rows.length > limit) { hasMore = true; rows.length = limit; }

      // Staging demo rows (?demo=1) — first page only, prepended, idempotent
      // by id. No-op in production. Mock runs carry a hidden _steps array
      // consumed by the single-run endpoint below; strip it from the list.
      if (IS_STAGING && req.query.demo === '1' && !hasCursor) {
        const have = new Set(rows.map((r) => r.id));
        const mocks = stagingMockMergeRuns()
          .filter((m) => !have.has(m.id))
          .filter((m) => !outcome || !STATUS_VALUES.has(String(outcome)) || m.status === outcome)
          .filter((m) => !req.query.kind || !KIND_VALUES.has(String(req.query.kind)) || m.kind === req.query.kind)
          .map(({ _steps, ...rest }) => rest); // eslint-disable-line no-unused-vars
        rows.unshift(...mocks);
      }

      const last = rows[rows.length - 1];
      res.json({
        runs: rows,
        hasMore,
        nextCursor: hasMore && last ? { before: last.started_at, before_id: last.id } : null,
      });
    } catch (err) {
      log.error('debug', 'List merge-runs failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Distinct apps that have runs — for the filter dropdown.
  router.get('/api/debug/apps', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT a.id, a.slug, a.name, COUNT(*)::int AS run_count
           FROM merge_debug_runs r JOIN apps a ON a.id = r.app_id
          GROUP BY a.id, a.slug, a.name
          ORDER BY a.name ASC`
      );
      if (IS_STAGING && req.query.demo === '1' && !rows.some((r) => r.slug === 'staging-demo')) {
        rows.unshift({ id: 0, slug: 'staging-demo', name: 'Staging demo app', run_count: stagingMockMergeRuns().length });
      }
      res.json({ apps: rows });
    } catch (err) {
      log.error('debug', 'List debug apps failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // One run + its ordered steps.
  router.get('/api/debug/merge-runs/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid run id' });

      // Staging demo run (?demo=1) — served from the in-memory fixture.
      if (IS_STAGING && req.query.demo === '1') {
        const mock = stagingMockMergeRuns().find((m) => m.id === id);
        if (mock) {
          const { _steps, ...run } = mock;
          return res.json({ run, steps: _steps });
        }
      }

      const { rows: runRows } = await pool.query(
        `SELECT r.id, r.app_id, a.slug AS app_slug, a.name AS app_name,
                r.session_id, r.pr_number, cs.pr_title,
                r.kind, r.trigger, r.status, r.summary, r.started_at, r.ended_at
           FROM merge_debug_runs r
           LEFT JOIN apps a ON a.id = r.app_id
           LEFT JOIN chat_sessions cs ON cs.id = r.session_id
          WHERE r.id = $1`,
        [id]
      );
      if (!runRows.length) return res.status(404).json({ error: 'Run not found' });

      const { rows: steps } = await pool.query(
        `SELECT id, run_id, seq, phase, level, message, detail, created_at
           FROM merge_debug_steps WHERE run_id = $1 ORDER BY seq ASC, id ASC`,
        [id]
      );
      res.json({ run: runRows[0], steps });
    } catch (err) {
      log.error('debug', 'Get merge-run failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { debugRoutes, stagingMockMergeRuns };
