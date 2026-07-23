'use strict';

const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { appPlatformAuth } = require('../middleware/app-llm-auth');
const { getPool } = require('../db/pool');
const governance = require('../services/governance');
const log = require('../services/logger');

// App-facing read-only platform API (issue #744). First endpoint:
//
//   GET /api/app-platform/governance/feed
//
// Returns the CALLING app's own recent proposal/vote/merge activity so
// apps can render live "what's changing" strips and changelogs instead
// of hand-maintained shadow tables. Auth is the app's opaque per-app
// credential (apps.llm_proxy_token, injected into production
// containers as USERNODE_LLM_PROXY_TOKEN) behind the same private-IP
// gate as the LLM proxy — see appPlatformAuth in
// middleware/app-llm-auth.js. No user token: the feed contains only
// what any viewer of the app can already see in its vote panel, and
// the token → app-id resolution is itself the scoping (no slug
// parameter exists to tamper with).
//
// Status vocabulary (mapped from the chat_sessions lifecycle):
//   proposed — DB 'promoted' with zero votes cast yet (promotion opens
//              voting immediately; this is just "no one has voted").
//   voting   — DB 'promoted' with at least one vote.
//   merging  — DB 'merging' (claimed by the GitHub merge pipeline).
//   merged   — DB 'merged' (merged_at carries the time).
// 'active' / 'paused' / 'archived' rows are NEVER returned — private
// in-progress sessions must not leak, and auto-rejected proposals drop
// out of the feed exactly as they do from the vote panel.
//
// `eta` is the governed gate's windowEndsAt — the earliest time the
// proposal can auto-merge while a visibility-window or lazy-consensus
// clock is armed. It is an "earliest possible merge time", not a
// guarantee; null when no clock is running (e.g. approvals_required
// mode, or not enough support yet) and for merging/merged rows.

// Feed page-size bounds — same defaults/clamps as GET /api/apps/:slug/merged.
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const OPEN_STATUSES = ['promoted', 'merging'];
const ALL_STATUSES = ['promoted', 'merging', 'merged'];

// ?status=open|merged|all → the DB statuses to query. Unknown values
// fall back to 'all' (defensive; the param is a convenience filter).
function dbStatusesFor(filter) {
  if (filter === 'open') return OPEN_STATUSES;
  if (filter === 'merged') return ['merged'];
  return ALL_STATUSES;
}

// Wire status from a row: see the vocabulary block above.
function feedStatus(row) {
  if (row.status === 'merged') return 'merged';
  if (row.status === 'merging') return 'merging';
  const votes = (parseInt(row.yes_count, 10) || 0) + (parseInt(row.no_count, 10) || 0);
  return votes === 0 ? 'proposed' : 'voting';
}

// ISO-serialize a timestamp column (pg returns Date objects; mocked
// pools in tests may return strings) — null-safe.
function iso(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function appPlatformApiRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  const feedLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `app:${req.appPlatform?.appId || 'anon'}`,
    handler: (req, res) => {
      log.warn('app-platform-api', 'Rate-limited', { appId: req.appPlatform?.appId });
      res.status(429).json({ ok: false, code: 'rate_limited' });
    },
  });

  const auth = appPlatformAuth(pool);

  router.get('/api/app-platform/governance/feed', auth, feedLimiter, async (req, res) => {
    const { appId } = req.appPlatform;
    try {
      let limit = parseInt(req.query.limit, 10);
      if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
      if (limit > MAX_LIMIT) limit = MAX_LIMIT;

      const statuses = dbStatusesFor(req.query.status);

      // Keyset cursor over (activity_at, id), same scheme as
      // /api/apps/:slug/merged: activity_at is COALESCE(merged_at,
      // promoted_at, created_at) — merged rows sort by merge time, open
      // rows by promotion time — with id as the tiebreaker. A cursor only
      // applies when BOTH parts parse cleanly; otherwise it's ignored and
      // the newest page is returned (defensive against malformed query
      // strings). Keyset (not OFFSET) because new activity inserts at the
      // top and would drift an offset between pages.
      const beforeRaw = req.query.before;
      const beforeIdRaw = parseInt(req.query.before_id, 10);
      const before = new Date(beforeRaw);
      const hasCursor = beforeRaw != null && !Number.isNaN(before.getTime())
        && Number.isFinite(beforeIdRaw);

      const activityExpr = 'COALESCE(cs.merged_at, cs.promoted_at, cs.created_at)';
      const params = [appId, statuses];
      let cursorClause = '';
      if (hasCursor) {
        cursorClause = `AND (${activityExpr}, cs.id) < ($3, $4)`;
        params.push(before.toISOString(), beforeIdRaw);
      }
      // Fetch limit+1 so an extra row signals there's another page.
      params.push(limit + 1);

      const { rows } = await pool.query(
        `SELECT cs.id, cs.pr_number, cs.pr_title, cs.pr_summary_md, cs.status,
                cs.promoted_at, cs.created_at, cs.merged_at, cs.votes_required,
                u.username AS author,
                ${activityExpr} AS activity_at,
                (SELECT COUNT(*)::int FROM pr_votes WHERE session_id = cs.id AND vote = 'yes') AS yes_count,
                (SELECT COUNT(*)::int FROM pr_votes WHERE session_id = cs.id AND vote = 'no')  AS no_count
           FROM chat_sessions cs
           LEFT JOIN users u ON u.id = cs.user_id
          WHERE cs.app_id = $1 AND cs.status = ANY($2::text[])
            ${cursorClause}
          ORDER BY ${activityExpr} DESC, cs.id DESC
          LIMIT $${params.length}`,
        params
      );

      let hasMore = false;
      if (rows.length > limit) {
        hasMore = true;
        rows.length = limit;
      }

      // Governed merge gate for the open rows — the exact pattern of the
      // /promoted serializer (routes/votes.js): under the default
      // settings this is the per-row mergeGate over the raw tallies;
      // under approver_policy='invited' the qualifying counts are
      // batch-fetched and the electorate is the approver roster; under
      // approvals_required=N the gate is the clock-free "at least N"
      // check (windowEndsAt null — no eta). All lookups are TTL-cached
      // in services/governance.js.
      const gates = new Map(); // session id -> gate
      const openRows = rows.filter((r) => r.status !== 'merged');
      if (openRows.length) {
        const gov = await governance.getGovernance(pool, appId);
        const electorate = await governance.getElectorate(pool, appId, gov);
        let qualifiedByRow = null;
        if (electorate.approverIds) {
          qualifiedByRow = await governance.qualifiedCountsBatch(
            pool, 'pr', openRows.map((r) => r.id), electorate.approverIds
          );
        }
        for (const row of openRows) {
          const q = qualifiedByRow
            ? (qualifiedByRow.get(row.id) || { yes: 0, no: 0 })
            : { yes: row.yes_count, no: row.no_count };
          gates.set(row.id, governance.computeGate(
            gov, electorate.active, q.yes, q.no,
            row.promoted_at || row.created_at
          ));
        }
      }

      const items = rows.map((row) => {
        const gate = gates.get(row.id) || null;
        const status = feedStatus(row);
        return {
          id: row.id,
          pr_number: row.pr_number ?? null,
          title: row.pr_title || `PR #${row.pr_number ?? row.id}`,
          summary_md: row.pr_summary_md || null,
          status,
          votes_for: parseInt(row.yes_count, 10) || 0,
          votes_against: parseInt(row.no_count, 10) || 0,
          // Open rows: the live governed threshold. Merged rows: the
          // at-merge snapshot (nullable for pre-#58 merges).
          votes_required: gate
            ? gate.required
            : (row.votes_required != null ? parseInt(row.votes_required, 10) : null),
          contested: gate ? !!gate.contested : false,
          // Earliest possible auto-merge time while a clock is armed —
          // only meaningful pre-pipeline ('merging' is imminent).
          eta: status === 'proposed' || status === 'voting'
            ? (gate?.windowEndsAt ?? null)
            : null,
          author: row.author || null,
          proposed_at: iso(row.promoted_at || row.created_at),
          merged_at: iso(row.merged_at),
        };
      });

      const last = rows[rows.length - 1];
      res.json({
        items,
        has_more: hasMore,
        next_cursor: hasMore && last
          ? { before: iso(last.activity_at), before_id: last.id }
          : null,
      });
    } catch (err) {
      log.error('app-platform-api', 'Governance feed failed', { appId, message: err.message });
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = appPlatformApiRoutes;
// Exposed for tests (status mapping + filter resolution).
module.exports.feedStatus = feedStatus;
module.exports.dbStatusesFor = dbStatusesFor;
