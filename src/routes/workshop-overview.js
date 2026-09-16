'use strict';

// The Workshop screen's two numbers per app.
//
//   GET /api/workshop/counts
//        → { counts: { '<slug>': { working, needs }, … } }
//
// The top-level Workshop screen (frontend/src/features/workshop/) lists the
// viewer's apps and, on each row, says how much of the app's own Workshop
// page is addressed to them: how many items its "What you are working on"
// strip holds, and how many its "Needs you" queue does. Both numbers are
// per-viewer, both come from Postgres, and one query answers for every app at
// once — the alternative is the board's own eight-request load per app, which
// at forty apps is not a page load.
//
// ── The two definitions, and where they come from ──────────────────────
//
// They are not invented here. They are the same populations the per-app
// lander builds in `AppView._workshopView()` (public/js/app-view.js), read
// back out of the tables the board's endpoints read:
//
//   WORKING — the viewer's own work in flight.
//     · their dev sessions, `active` or `paused`, non-headless: the rows
//       GET /api/me/active-sessions returns and the board keeps as
//       `_mySessions` (its `my-session` entries in the Underway lane).
//     · their proposals in review, `promoted` or `merging`: the
//       GET /api/apps/:slug/promoted rows whose `user_id` is theirs.
//     · their open governance proposals: the GET /api/apps/:slug/issues
//       rows whose `created_by` is theirs.
//     The three statuses are disjoint, so nothing is counted twice.
//
//   NEEDS — the votes they owe. `promoted` proposals that are not theirs and
//     that they have not voted on under the proposal's current approval epoch
//     (services/pr-vote-revision.js owns that predicate), plus open
//     governance proposals that are not theirs and carry no vote of theirs.
//     Exactly the deck's `owed` half.
//
// What NEEDS deliberately leaves out is the tail of that deck: the unclaimed
// open GitHub issues it offers after the votes. Those are not in Postgres —
// they come from services/github.js's five-minute per-repo cache — so
// counting them here would mean a GitHub round trip per app on a cold cache,
// for every app the viewer has. The screen's column header says "votes" for
// that reason rather than claiming the whole deck.
//
// ── Scope ──────────────────────────────────────────────────────────────
//
// Every app the viewer may SEE, under the same visibility filter as
// GET /api/apps: self-hosted rows are admin-only, and a view-private app is
// absent unless they are a member. Which of those are "Your apps" is not
// decided here — that is `Home.isYours` / `Home.partitionApps`, one answer
// the platform already has, and the screen composes these counts onto the
// rows it gets from /api/apps rather than this endpoint growing a second
// copy of it. Apps with nothing on either number are omitted; the client
// reads a missing slug as two zeroes.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { currentVotePredicateSql } = require('../services/pr-vote-revision');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// Staging-only mock counts for ?demo=1, the sibling of stagingMockIssues /
// stagingMockProposals in the board's own endpoints.
//
// `chat_sessions` is `staging:private`, so a prod-cloned staging database
// holds no sessions and no proposals at all: every row of this screen would
// read 0 / 0, and the one thing the screen exists to show would be
// unreviewable — in the preview AND in the before/after screenshots the group
// votes on.
//
// Keyed to the demo APP rows GET /api/apps injects under the same flag
// (`demoIconApps` in src/routes/apps.js), so the numbers are deterministic and
// a declared check can assert them. Only `staging-demo-your-app` reaches "Your
// apps" — the others inherit is_favorited/is_collaborator false, so
// Home.isYours excludes them — and they are named anyway, so a preview where
// one of them has been favourited shows numbers rather than a row of zeroes.
// Display-only: nothing in the platform reads these back, and strictly a
// no-op in production.
const DEMO_COUNTS = {
  'staging-demo-your-app': { working: 2, needs: 3 },
  'staging-demo-emoji-icon': { working: 0, needs: 5 },
  'staging-demo-image-icon': { working: 1, needs: 0 },
  'staging-demo-long-name': { working: 4, needs: 1 },
};

// Counts for every app the viewer can see that has a non-zero one.
//
// Four aggregates rather than one scan with four FILTERs: `issues` and
// `chat_sessions` are different tables, and the two owed counts each need
// their own NOT EXISTS. Each CTE groups by app_id, so the join at the bottom
// is over at most one row per app per source.
//
// `$1` is the viewer. Every predicate names it explicitly, so an anonymous
// caller (NULL) would make `IS DISTINCT FROM` true for every row and count
// the whole platform's promoted proposals as owed — which is why the route
// below refuses one outright rather than relying on the SQL to degrade.
const COUNTS_SQL = `
  WITH my_sessions AS (
    SELECT cs.app_id, COUNT(*)::int AS n
      FROM chat_sessions cs
     WHERE cs.user_id = $1
       AND cs.status IN ('active', 'paused')
       AND cs.is_headless = FALSE
     GROUP BY cs.app_id
  ),
  my_proposals AS (
    SELECT cs.app_id, COUNT(*)::int AS n
      FROM chat_sessions cs
     WHERE cs.user_id = $1
       AND cs.status IN ('promoted', 'merging')
     GROUP BY cs.app_id
  ),
  my_governance AS (
    SELECT i.app_id, COUNT(*)::int AS n
      FROM issues i
     WHERE i.status = 'open'
       AND i.created_by = $1
     GROUP BY i.app_id
  ),
  owed_proposals AS (
    SELECT cs.app_id, COUNT(*)::int AS n
      FROM chat_sessions cs
     WHERE cs.status = 'promoted'
       AND cs.user_id IS DISTINCT FROM $1
       AND NOT EXISTS (
         SELECT 1 FROM pr_votes pv
          WHERE pv.session_id = cs.id
            AND pv.user_id = $1
            AND ${currentVotePredicateSql('pv', 'cs')}
       )
     GROUP BY cs.app_id
  ),
  owed_governance AS (
    SELECT i.app_id, COUNT(*)::int AS n
      FROM issues i
     WHERE i.status = 'open'
       AND i.created_by IS DISTINCT FROM $1
       AND NOT EXISTS (
         SELECT 1 FROM issue_votes iv
          WHERE iv.issue_id = i.id AND iv.user_id = $1
       )
     GROUP BY i.app_id
  )
  SELECT a.slug,
         (COALESCE(ms.n, 0) + COALESCE(mp.n, 0) + COALESCE(mg.n, 0)) AS working,
         (COALESCE(op.n, 0) + COALESCE(og.n, 0)) AS needs
    FROM apps a
    LEFT JOIN app_collaborators me
      ON me.app_id = a.id AND me.user_id = $1 AND me.status = 'member'
    LEFT JOIN my_sessions     ms ON ms.app_id = a.id
    LEFT JOIN my_proposals    mp ON mp.app_id = a.id
    LEFT JOIN my_governance   mg ON mg.app_id = a.id
    LEFT JOIN owed_proposals  op ON op.app_id = a.id
    LEFT JOIN owed_governance og ON og.app_id = a.id
   WHERE (NOT a.self_hosted OR $2::boolean)
     AND ($3::boolean OR a.view_visibility = 'public' OR me.user_id IS NOT NULL)
     AND (COALESCE(ms.n, 0) + COALESCE(mp.n, 0) + COALESCE(mg.n, 0)
          + COALESCE(op.n, 0) + COALESCE(og.n, 0)) > 0
`;

/**
 * The demo overlay under the real counts.
 *
 * Exported and pure so tests can exercise it with no database. REAL COUNTS
 * WIN: `issues` survives the staging clone, so a preview may genuinely have
 * governance rows against one of these slugs, and a mock that overwrote them
 * would make the demo mode a worse test of the screen than no demo mode at
 * all. The demo slugs do not exist in Postgres, so in practice nothing
 * collides — this is the rule rather than the common case.
 */
function withDemoCounts(counts) {
  return { ...DEMO_COUNTS, ...counts };
}

function workshopOverviewRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/api/workshop/counts', async (req, res) => {
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
      // The same two flags GET /api/apps resolves, so the two lists cannot
      // disagree about which apps exist for this viewer.
      const showSelfHosted = !!req.user.isAdmin || !!config.selfAppPublicVoting;
      const { rows } = await pool.query(COUNTS_SQL, [
        req.user.id, showSelfHosted, !!req.user.isAdmin,
      ]);
      const counts = {};
      for (const row of rows) {
        counts[row.slug] = {
          working: Number(row.working) || 0,
          needs: Number(row.needs) || 0,
        };
      }
      if (IS_STAGING && req.query.demo === '1') {
        return res.json({ counts: withDemoCounts(counts) });
      }
      return res.json({ counts });
    } catch (err) {
      log.error('workshop-overview', 'Failed to read workshop counts', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = {
  workshopOverviewRoutes, withDemoCounts, DEMO_COUNTS, COUNTS_SQL,
};
