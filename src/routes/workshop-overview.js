'use strict';

// The Workshop screen's two numbers per app, and the rows behind them.
//
//   GET /api/workshop/counts
//        → { counts: { '<slug>': { working, needs }, … } }
//   GET /api/workshop/items   (#3051, see ITEMS_SQL below)
//        → { items: { '<slug>': { working: Item[], needs: Item[] }, … } }
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
// And "governance proposals" in both definitions means the five kinds in
// services/governance-kinds.js, never every open row in `issues`. The table
// also holds a `general` TWIN row per request filed through the platform:
// the request board's own rows, which the deck excludes and which the
// paragraph above says this endpoint excludes too. Counting them is what
// made this screen report forty-six votes waiting on an app whose board had
// three open requests — a twin is only ever closed by a passed close-issue
// vote, so it outlives its GitHub issue by however long that issue has been
// closed. Both `issues` CTEs below carry governanceKindsSql for that reason,
// and tests/workshop-screen.test.js pins it there.
//
// ── Scope ──────────────────────────────────────────────────────────────
//
// Every app the viewer may SEE, under the same visibility filter as
// GET /api/apps: self-hosted rows are admin-only, and a view-private app is
// absent unless they are a member. Which of those are the viewer's
// communities is not decided here — that is `Home.isJoined` over the
// `is_member` flag GET /api/apps serves (services/communities.js), one answer
// the platform already has, and the screen composes these counts onto the
// rows it gets from /api/apps rather than this endpoint growing a second
// copy of it. Apps with nothing on either number are omitted; the client
// reads a missing slug as two zeroes.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { currentVotePredicateSql } = require('../services/pr-vote-revision');
const { governanceKindsSql } = require('../services/governance-kinds');

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
// a declared check can assert them. Three of them are the viewer's
// communities under ?demo=1 — `staging-demo-your-app` (a Community),
// `staging-demo-long-name` (a Group) and `staging-demo-emoji-icon` (Just
// you), one per Workshop section — and the fourth is named anyway, so a
// preview where it has been joined shows numbers rather than two zeroes.
// Display-only: nothing in the platform reads these back, and strictly a
// no-op in production.
const DEMO_COUNTS = {
  'staging-demo-your-app': { working: 2, needs: 3 },
  'staging-demo-emoji-icon': { working: 0, needs: 5 },
  'staging-demo-image-icon': { working: 1, needs: 0 },
  'staging-demo-long-name': { working: 4, needs: 1 },
};

// ── The five populations, spelled ONCE ────────────────────────────────
//
// Each is the WHERE body of a query over its own table, and both queries in
// this file read them: COUNTS_SQL counts them per app, ITEMS_SQL (#3051)
// lists the rows behind those counts for the all-apps Workshop's two tabs. A
// second copy of any of these predicates would be a number on a row that
// stopped agreeing with the list under the tab beside it.
//
// `$1` is the viewer. Every predicate names it explicitly, so an anonymous
// caller (NULL) would make `IS DISTINCT FROM` true for every row and count
// the whole platform's promoted proposals as owed, which is why both routes
// below refuse one outright rather than relying on the SQL to degrade.
const MY_SESSIONS_WHERE = `cs.user_id = $1
       AND cs.status IN ('active', 'paused')
       AND cs.is_headless = FALSE`;

const MY_PROPOSALS_WHERE = `cs.user_id = $1
       AND cs.status IN ('promoted', 'merging')`;

const MY_GOVERNANCE_WHERE = `i.status = 'open'
       AND ${governanceKindsSql('i')}
       AND i.created_by = $1`;

const OWED_PROPOSALS_WHERE = `cs.status = 'promoted'
       AND cs.user_id IS DISTINCT FROM $1
       AND NOT EXISTS (
         SELECT 1 FROM pr_votes pv
          WHERE pv.session_id = cs.id
            AND pv.user_id = $1
            AND ${currentVotePredicateSql('pv', 'cs')}
       )`;

const OWED_GOVERNANCE_WHERE = `i.status = 'open'
       AND ${governanceKindsSql('i')}
       AND i.created_by IS DISTINCT FROM $1
       AND NOT EXISTS (
         SELECT 1 FROM issue_votes iv
          WHERE iv.issue_id = i.id AND iv.user_id = $1
       )`;

// GET /api/apps's visibility filter, over `a` (apps) and `me` (the viewer's
// membership row). `$2` is "may see self-hosted rows", `$3` "is an admin".
const VISIBLE_APP_WHERE = `(NOT a.self_hosted OR $2::boolean)
     AND ($3::boolean OR a.view_visibility = 'public' OR me.user_id IS NOT NULL)`;

// Counts for every app the viewer can see that has a non-zero one.
//
// Four aggregates rather than one scan with four FILTERs: `issues` and
// `chat_sessions` are different tables, and the two owed counts each need
// their own NOT EXISTS. Each CTE groups by app_id, so the join at the bottom
// is over at most one row per app per source.
const COUNTS_SQL = `
  WITH my_sessions AS (
    SELECT cs.app_id, COUNT(*)::int AS n
      FROM chat_sessions cs
     WHERE ${MY_SESSIONS_WHERE}
     GROUP BY cs.app_id
  ),
  my_proposals AS (
    SELECT cs.app_id, COUNT(*)::int AS n
      FROM chat_sessions cs
     WHERE ${MY_PROPOSALS_WHERE}
     GROUP BY cs.app_id
  ),
  my_governance AS (
    SELECT i.app_id, COUNT(*)::int AS n
      FROM issues i
     WHERE ${MY_GOVERNANCE_WHERE}
     GROUP BY i.app_id
  ),
  owed_proposals AS (
    SELECT cs.app_id, COUNT(*)::int AS n
      FROM chat_sessions cs
     WHERE ${OWED_PROPOSALS_WHERE}
     GROUP BY cs.app_id
  ),
  owed_governance AS (
    SELECT i.app_id, COUNT(*)::int AS n
      FROM issues i
     WHERE ${OWED_GOVERNANCE_WHERE}
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
   WHERE ${VISIBLE_APP_WHERE}
     AND (COALESCE(ms.n, 0) + COALESCE(mp.n, 0) + COALESCE(mg.n, 0)
          + COALESCE(op.n, 0) + COALESCE(og.n, 0)) > 0
`;

// ── The rows behind the counts (#3051) ─────────────────────────────────
//
//   GET /api/workshop/items
//        → { items: { '<slug>': { working: Item[], needs: Item[] } } }
//   Item = { kind: 'session'|'proposal'|'governance', id, title, status, at }
//
// The all-apps Workshop's two tabs, Current status and Needs you, list these
// grouped by app. The SAME five populations as COUNTS_SQL, read through the
// same predicates above, so a row's two numbers and the list under the tab
// beside it cannot disagree about what is counted.
//
// BOUNDED twice. At most ITEMS_PER_APP rows per app per section (newest
// first), because the tab is a digest that sends you into the app's own
// Workshop for the rest, and at most ITEMS_TOTAL rows in all, so an account
// on a hundred busy apps is still one small response. The client knows each
// app's full count from /api/workshop/counts and says how many were left out.
const ITEMS_PER_APP = 5;
const ITEMS_TOTAL = 300;

const ITEMS_SQL = `
  WITH items AS (
    SELECT 'working'::text AS section, 'session'::text AS kind, cs.app_id, cs.id,
           COALESCE(NULLIF(cs.session_title, ''), NULLIF(cs.pr_title, ''),
                    NULLIF(cs.proposed_pr_title, ''))::text AS title,
           cs.status::text AS status, cs.last_activity_at AS at
      FROM chat_sessions cs
     WHERE ${MY_SESSIONS_WHERE}
    UNION ALL
    SELECT 'working', 'proposal', cs.app_id, cs.id,
           COALESCE(NULLIF(cs.pr_title, ''), NULLIF(cs.session_title, ''))::text,
           cs.status::text, cs.last_activity_at
      FROM chat_sessions cs
     WHERE ${MY_PROPOSALS_WHERE}
    UNION ALL
    SELECT 'working', 'governance', i.app_id, i.id, i.title::text, i.kind::text, i.created_at
      FROM issues i
     WHERE ${MY_GOVERNANCE_WHERE}
    UNION ALL
    SELECT 'needs', 'proposal', cs.app_id, cs.id,
           COALESCE(NULLIF(cs.pr_title, ''), NULLIF(cs.session_title, ''))::text,
           cs.status::text, cs.last_activity_at
      FROM chat_sessions cs
     WHERE ${OWED_PROPOSALS_WHERE}
    UNION ALL
    SELECT 'needs', 'governance', i.app_id, i.id, i.title::text, i.kind::text, i.created_at
      FROM issues i
     WHERE ${OWED_GOVERNANCE_WHERE}
  ),
  ranked AS (
    SELECT it.*,
           ROW_NUMBER() OVER (
             PARTITION BY it.app_id, it.section
             ORDER BY it.at DESC NULLS LAST, it.id DESC
           ) AS rn
      FROM items it
  )
  SELECT a.slug, r.section, r.kind, r.id, r.title, r.status, r.at
    FROM ranked r
    JOIN apps a ON a.id = r.app_id
    LEFT JOIN app_collaborators me
      ON me.app_id = a.id AND me.user_id = $1 AND me.status = 'member'
   WHERE r.rn <= $4
     AND ${VISIBLE_APP_WHERE}
   ORDER BY r.rn, a.slug, r.section
   LIMIT $5
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

// The rows behind DEMO_COUNTS, for ?demo=1 on staging (#3051): the same
// reason the counts have a mock, and the same slugs. `staging-demo-your-app`
// carries exactly its counts' 2 and 3, so the tab and the row beside it agree
// in the preview. Titles only; nothing reads these back. The ids are
// negative so a tap can never open a real proposal by accident.
const DEMO_ITEMS = {
  'staging-demo-your-app': {
    working: [
      { kind: 'session', id: -101, title: 'Add a dark theme toggle', status: 'active', at: '2026-09-24T09:00:00Z' },
      { kind: 'proposal', id: -102, title: 'Show the recipe count on the home card', status: 'promoted', at: '2026-09-23T15:00:00Z' },
    ],
    needs: [
      { kind: 'proposal', id: -103, title: 'Sort recipes by rating', status: 'promoted', at: '2026-09-24T12:00:00Z' },
      { kind: 'proposal', id: -104, title: 'Let members share a shopping list', status: 'promoted', at: '2026-09-22T10:00:00Z' },
      { kind: 'governance', id: -105, title: 'Rename the app to Recipe Box', status: 'rename', at: '2026-09-21T08:00:00Z' },
    ],
  },
};

/**
 * The demo overlay under the real items. Same rule as withDemoCounts: an app
 * the database answered for keeps its real rows.
 */
function withDemoItems(items) {
  return { ...DEMO_ITEMS, ...items };
}

/** Group ITEMS_SQL's flat rows by slug and section. Exported for tests. */
function groupItems(rows) {
  const items = {};
  for (const row of rows) {
    const slot = items[row.slug] || (items[row.slug] = { working: [], needs: [] });
    const section = row.section === 'needs' ? 'needs' : 'working';
    slot[section].push({
      kind: row.kind,
      id: Number(row.id),
      title: row.title || '',
      status: row.status || '',
      at: row.at instanceof Date ? row.at.toISOString() : (row.at || null),
    });
  }
  return items;
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

  router.get('/api/workshop/items', async (req, res) => {
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
      const showSelfHosted = !!req.user.isAdmin || !!config.selfAppPublicVoting;
      const { rows } = await pool.query(ITEMS_SQL, [
        req.user.id, showSelfHosted, !!req.user.isAdmin, ITEMS_PER_APP, ITEMS_TOTAL,
      ]);
      const items = groupItems(rows);
      if (IS_STAGING && req.query.demo === '1') {
        return res.json({ items: withDemoItems(items) });
      }
      return res.json({ items });
    } catch (err) {
      log.error('workshop-overview', 'Failed to read workshop items', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = {
  workshopOverviewRoutes, withDemoCounts, DEMO_COUNTS, COUNTS_SQL,
  withDemoItems, DEMO_ITEMS, ITEMS_SQL, ITEMS_PER_APP, ITEMS_TOTAL, groupItems,
};
