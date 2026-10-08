'use strict';

// The Workshop screen's two numbers per app, and the rows behind them.
//
//   GET /api/workshop/counts
//        → { counts: { '<slug>': { working, needs, owed, unchosen? }, … } }
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
// three open requests — a twin was only ever closed by a passed close-issue
// vote, so it outlived its GitHub issue by however long that issue had been
// closed (merges close it now; a close by hand on GitHub still does not).
// Both `issues` CTEs below carry governanceKindsSql for that reason,
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
const { currentVotePredicateSql, countedVotePredicateSql } = require('../services/pr-vote-revision');
const { governanceKindsSql } = require('../services/governance-kinds');
const communities = require('../services/communities');
const governance = require('../services/governance');

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
  // `owed` names DEMO_NEEDS_FEED's four, below, so a vote swiped past in
  // the demo feed takes its count off the row, as a real one does (#3526).
  'staging-demo-your-app': {
    working: 2, needs: 3, owed: ['proposal:-103@0', 'proposal:-104@0', 'governance:-105'],
  },
  // #4313: the Just-you demo row, so a preview can show the approval wording.
  'staging-demo-emoji-icon': { working: 0, needs: 1, owed: ['proposal:-106@0'] },
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
// A suspended app is left out for everyone, admins included: it refuses to
// open (checkAppAccess), so a row for it would lead nowhere.
const VISIBLE_APP_WHERE = `a.moderation_suspended_at IS NULL
     AND (NOT a.self_hosted OR $2::boolean)
     AND ($3::boolean OR a.view_visibility = 'public' OR me.user_id IS NOT NULL)`;

// Counts for every app the viewer can see that has a non-zero one.
//
// Four aggregates rather than one scan with four FILTERs: `issues` and
// `chat_sessions` are different tables, and the two owed counts each need
// their own NOT EXISTS. Each CTE groups by app_id, so the join at the bottom
// is over at most one row per app per source.
//
// `owed` (#3526) names the votes `needs` counts, in the keys the client's
// Needs you record uses (frontend/src/features/workshop/needs-seen.ts): a
// change as `proposal:<id>@<approval epoch>`, a group decision as
// `governance:<id>`. A vote swiped past in a Needs you feed is remembered on
// the viewer's device, and every badge leaves it out; with only a number
// the badges could not tell a vote seen from a new one that took its place,
// and would have taken the new one off. The epoch is in the key because it
// is what moves when a change is rewritten, which is when a vote seen
// before counts again (as a vote cast before stops counting).
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
    SELECT cs.app_id, COUNT(*)::int AS n,
           array_agg('proposal:' || cs.id || '@' || cs.approval_epoch) AS keys
      FROM chat_sessions cs
     WHERE ${OWED_PROPOSALS_WHERE}
     GROUP BY cs.app_id
  ),
  owed_governance AS (
    SELECT i.app_id, COUNT(*)::int AS n,
           array_agg('governance:' || i.id) AS keys
      FROM issues i
     WHERE ${OWED_GOVERNANCE_WHERE}
     GROUP BY i.app_id
  )
  SELECT a.slug,
         (COALESCE(ms.n, 0) + COALESCE(mp.n, 0) + COALESCE(mg.n, 0)) AS working,
         (COALESCE(op.n, 0) + COALESCE(og.n, 0)) AS needs,
         (COALESCE(op.keys, '{}'::text[]) || COALESCE(og.keys, '{}'::text[])) AS owed
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

// GET /api/workshop/needs-feed (#3270)
//      → { items: FeedItem[] }
//   FeedItem = { kind: 'proposal'|'governance', id, title, summary, author,
//                number, epoch, at, yes, no, approve?,
//                app: { slug, name, icon_url, icon_emoji } }
//
// The Communities screen's Needs you tab as ONE FEED: every decision owed by
// the viewer, across all the projects they are a member of, newest first and
// mixed together rather than grouped under each project, so the tab reads
// like a project's own Needs you page (one decision per screen) instead of a
// list of lists. The SAME owed predicates as the counts and ITEMS_SQL above,
// so the number on a row and the feed agree; narrowed to MEMBER projects,
// because a vote is a member's (communities.requireSessionMembership) and a
// feed of cards the viewer could not answer would be a feed of Join prompts.
//
// What a card needs to be decided from its own screen: the words (the
// proposal's summary, or a group decision's description), who asked, the
// tally so far, and the approval epoch a vote must carry (#2038). Bounded to
// NEEDS_FEED_MAX; the tab says so when it stops there.
//
// And whether it is approved rather than voted on (#4270, B7): `approve` on a
// change on a project that is just the viewer's whose Yes is the one it
// needs, so the feed says Approve / Don't approve where its card does. The
// query says which rows are on such a project (`solo`: the audience is
// 'solo' and the viewer's vote counts there); withVotesRequired works out
// how many Yes votes those need; approvedAlone decides.
//
// The words are the Description sheet's as well since #3488 (the feed is a
// project's own NeedsFeed now, which renders them in full there), so they
// are cut at NEEDS_FEED_SUMMARY_MAX rather than at a card's length. A
// summary is a few paragraphs; the cap is for the one that is not.
const NEEDS_FEED_MAX = 60;
const NEEDS_FEED_SUMMARY_MAX = 2000;

const NEEDS_FEED_SQL = `
  WITH owed AS (
    SELECT 'proposal'::text AS kind, cs.app_id, cs.id,
           COALESCE(NULLIF(cs.pr_title, ''), NULLIF(cs.session_title, ''))::text AS title,
           LEFT(COALESCE(cs.pr_summary_md, ''), ${NEEDS_FEED_SUMMARY_MAX})::text AS summary,
           u.username::text AS author,
           cs.pr_number AS number,
           cs.approval_epoch AS epoch,
           cs.last_activity_at AS at,
           (SELECT COUNT(*) FROM pr_votes pv
             WHERE pv.session_id = cs.id AND pv.vote = 'yes'
               AND ${countedVotePredicateSql('pv', 'cs')})::int AS yes,
           (SELECT COUNT(*) FROM pr_votes pv
             WHERE pv.session_id = cs.id AND pv.vote = 'no'
               AND ${countedVotePredicateSql('pv', 'cs')})::int AS no
      FROM chat_sessions cs
      LEFT JOIN users u ON u.id = cs.user_id
     WHERE ${OWED_PROPOSALS_WHERE}
    UNION ALL
    SELECT 'governance', i.app_id, i.id, i.title::text,
           LEFT(COALESCE(i.description, ''), ${NEEDS_FEED_SUMMARY_MAX})::text,
           u.username::text, NULL::int, NULL::int, i.created_at,
           NULL::int, NULL::int
      FROM issues i
      LEFT JOIN users u ON u.id = i.created_by
     WHERE ${OWED_GOVERNANCE_WHERE}
  )
  SELECT a.id AS app_id, a.slug, a.name, a.icon_image_id, a.icon_emoji,
         o.kind, o.id, o.title, o.summary, o.author, o.number, o.epoch,
         o.at, o.yes, o.no,
         (o.kind = 'proposal'
           AND (${communities.audienceSql('a', '(SELECT COUNT(*) FROM community_members m WHERE m.community_id = a.community_id)')}) = 'solo'
           AND counts_toward_outcome($1, a.id)) AS solo
    FROM owed o
    JOIN apps a ON a.id = o.app_id
    LEFT JOIN app_collaborators me
      ON me.app_id = a.id AND me.user_id = $1 AND me.status = 'member'
   WHERE ${VISIBLE_APP_WHERE}
     AND EXISTS (SELECT 1 FROM community_members cm
                  WHERE cm.community_id = a.community_id AND cm.user_id = $1)
   ORDER BY o.at DESC NULLS LAST, o.id DESC
   LIMIT $4
`;

// The same feed, counted per project and in the order the viewer joined
// them: what the Getting started card's Vote step reads (services/
// onboarding.js), so the step and the Needs you tab it sends people to agree
// on what is waiting and where. The SAME owed predicates, the same
// visibility filter and the same membership rule as NEEDS_FEED_SQL; only the
// shape differs. `$1` is the viewer, `$2` "may see self-hosted rows", `$3`
// "is an admin", as above.
//
// `paying` is how many of a project's `waiting` the card's Vote step can
// send somebody to: the ones whose vote the scorer's VOTE_CAST pays
// (services/topochain/challenge-scorer.js VOTE_CAST_SQL, the same two
// tests). Not a proposal the Homeroom bot built from a request the viewer
// made, and nothing in a project only the viewer is in ("Just you"): the
// bot's first version of their own solo app waits in their Needs you like
// any other proposal, but voting on it is not judging somebody else's
// change. The feed itself still lists them; only the card skips them.
const OWED_BY_COMMUNITY_SQL = `
  WITH owed AS (
    SELECT cs.app_id,
           NOT EXISTS (SELECT 1 FROM homeroom_bot_requesters r
                        WHERE r.app_id = cs.app_id
                          AND r.issue_number = cs.created_from_issue_number
                          AND r.user_id = $1) AS pays
      FROM chat_sessions cs
     WHERE ${OWED_PROPOSALS_WHERE}
    UNION ALL
    SELECT i.app_id, TRUE AS pays
      FROM issues i
     WHERE ${OWED_GOVERNANCE_WHERE}
  )
  SELECT a.id, a.slug, a.name, COUNT(*)::int AS waiting,
         (CASE WHEN a.view_visibility = 'public'
                 OR (SELECT COUNT(*) FROM community_members om WHERE om.community_id = a.community_id) > 1
                 OR EXISTS (SELECT 1 FROM app_collaborators ic
                             WHERE ic.app_id = a.id AND ic.status = 'invited')
               THEN COUNT(*) FILTER (WHERE o.pays) ELSE 0 END)::int AS paying,
         MIN(cm.joined_at) AS joined_at
    FROM owed o
    JOIN apps a ON a.id = o.app_id
    JOIN community_members cm ON cm.community_id = a.community_id AND cm.user_id = $1
    LEFT JOIN app_collaborators me
      ON me.app_id = a.id AND me.user_id = $1 AND me.status = 'member'
   WHERE ${VISIBLE_APP_WHERE}
   GROUP BY a.id, a.slug, a.name
   ORDER BY MIN(cm.joined_at) ASC, a.id ASC
`;

/**
 * The votes waiting for a viewer, per project they are a member of, in the
 * order they joined them: `[{ slug, name, waiting, paying }]`, projects with
 * nothing waiting left out. The Needs you feed's population (NEEDS_FEED_SQL),
 * counted rather than listed; `paying` is how many of them a vote on would
 * count for the Vote on an app challenge (OWED_BY_COMMUNITY_SQL).
 */
async function owedByCommunity(pool, userId, { showSelfHosted = false, isAdmin = false } = {}) {
  const { rows } = await pool.query(OWED_BY_COMMUNITY_SQL, [userId, !!showSelfHosted, !!isAdmin]);
  return rows.map((row) => ({
    slug: row.slug,
    name: row.name || row.slug,
    waiting: Number(row.waiting) || 0,
    paying: Number(row.paying) || 0,
  }));
}

/**
 * #4270: how many Yes votes each of NEEDS_FEED_SQL's `solo` rows needs, as
 * `votes_required` on the row, worked out as GET /api/apps/:slug/promoted
 * works it out for the change's card: the project's governance and
 * electorate, then the merge gate over the counted votes. One read per
 * project, and only for those rows; a project whose read fails is left
 * without one. Resolves the rows. Exported for tests.
 */
async function withVotesRequired(pool, rows) {
  const byApp = new Map();
  for (const row of rows) {
    if (row.solo !== true) continue;
    if (!byApp.has(row.app_id)) byApp.set(row.app_id, []);
    byApp.get(row.app_id).push(row);
  }
  await Promise.all([...byApp].map(async ([appId, list]) => {
    try {
      const gov = await governance.getGovernance(pool, appId);
      const electorate = await governance.getElectorate(pool, appId, gov);
      for (const row of list) {
        row.votes_required = governance.computeGate(gov, electorate.active, row.yes, row.no, row.at, null).required;
      }
    } catch (err) {
      log.warn('workshop-overview', 'Could not work out the votes a solo project needs', { appId, message: err.message });
    }
  }));
  return rows;
}

/**
 * B7 for one of the feed's rows, the rule AppView._approveSolo applies to a
 * card: a change on a project that is just the viewer's, whose vote counts,
 * and whose Yes is the one it needs. A row with no count worked out needs
 * one, as a card without votes_required does.
 */
function approvedAlone(row) {
  if (row.solo !== true) return false;
  const needed = parseInt(row.votes_required, 10);
  return !Number.isFinite(needed) || needed <= 1;
}

/** Shape NEEDS_FEED_SQL's rows for the client. Exported for tests. */
function shapeNeedsFeed(rows) {
  return rows.map((row) => ({
    kind: row.kind === 'governance' ? 'governance' : 'proposal',
    id: Number(row.id),
    title: row.title || '',
    summary: (row.summary || '').trim() || null,
    author: row.author || null,
    number: row.number == null ? null : Number(row.number),
    epoch: row.epoch == null ? null : Number(row.epoch),
    at: row.at instanceof Date ? row.at.toISOString() : (row.at || null),
    yes: row.yes == null ? null : Number(row.yes),
    no: row.no == null ? null : Number(row.no),
    ...(approvedAlone(row) ? { approve: true } : {}),
    app: {
      slug: row.slug,
      name: row.name || row.slug,
      icon_url: row.icon_image_id ? `/app-icons/${row.icon_image_id}` : null,
      icon_emoji: row.icon_emoji || null,
    },
  }));
}

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

// The feed's ?demo=1 rows on staging, drawn from DEMO_ITEMS' needs so the
// tab and the counts beside it tell one story. Negative ids, as there: a
// vote on one is refused, never cast on a real proposal. They come AFTER
// the real rows (withDemoNeedsFeed), the same "real rows win" rule the
// counts and items overlays keep, and the demo slug is in no database.
// #4313: the first row is on the Just-you demo community, approval-waiting
// (`approve: true`, no votes), so a preview shows the approval wording the
// reel's rows carry; display-only, like the rest.
const DEMO_NEEDS_FEED = [
  {
    kind: 'proposal', id: -106, title: 'Add a welcome note to the demo’s home screen',
    summary: 'A demo-only change on a project that is just yours, so a staging preview can show the approval wording. Voting on it is refused.',
    author: 'staging-demo-partner', number: null, epoch: 0, at: '2026-09-25T09:00:00Z', yes: 0, no: 0, approve: true,
    app: { slug: 'staging-demo-emoji-icon', name: 'Staging demo emoji icon', icon_url: null, icon_emoji: '🎮' },
  },
  {
    kind: 'proposal', id: -103, title: 'Sort recipes by rating',
    summary: 'Adds a Rating option to the sort menu, highest first, and remembers the choice per person.',
    author: 'staging-demo-partner', number: null, epoch: 0, at: '2026-09-24T12:00:00Z', yes: 2, no: 0,
    app: { slug: 'staging-demo-your-app', name: 'Staging demo app', icon_url: null, icon_emoji: null },
  },
  {
    kind: 'proposal', id: -104, title: 'Let members share a shopping list',
    summary: 'A shared list on the app\'s home screen that any member can add to and tick off.',
    author: 'staging-demo-partner', number: null, epoch: 0, at: '2026-09-22T10:00:00Z', yes: 1, no: 1,
    app: { slug: 'staging-demo-your-app', name: 'Staging demo app', icon_url: null, icon_emoji: null },
  },
  {
    kind: 'governance', id: -105, title: 'Rename the app to Recipe Box',
    summary: 'A group decision: the new name shows everywhere once it passes.',
    author: 'staging-demo-partner', number: null, epoch: null, at: '2026-09-21T08:00:00Z', yes: null, no: null,
    app: { slug: 'staging-demo-your-app', name: 'Staging demo app', icon_url: null, icon_emoji: null },
  },
];

/** The feed's demo overlay: the real feed first, then the demo cards. */
function withDemoNeedsFeed(items) {
  const seen = new Set(items.map((it) => `${it.kind}:${it.id}`));
  return [...items, ...DEMO_NEEDS_FEED.filter((it) => !seen.has(`${it.kind}:${it.id}`))];
}

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
      // `unchosen` (5 Oct 2026): a community whose votes do not put a number
      // on the Communities tab, because the viewer is in it only as every
      // account is and has not taken part there yet
      // (communities.UNCHOSEN_COMMUNITIES_SQL). Only the tab's badge reads it;
      // `needs` itself is unchanged, so the list, the switcher and Needs you
      // still say what waits. A failed read is the old behaviour: every
      // vote on the badge.
      const [{ rows }, unchosen] = await Promise.all([
        pool.query(COUNTS_SQL, [req.user.id, showSelfHosted, !!req.user.isAdmin]),
        communities.unchosenCommunities(pool, req.user.id).catch((err) => {
          log.warn('workshop-overview', 'Unchosen communities read failed; badging every vote', { message: err.message });
          return new Set();
        }),
      ]);
      const counts = {};
      for (const row of rows) {
        counts[row.slug] = {
          working: Number(row.working) || 0,
          needs: Number(row.needs) || 0,
          owed: Array.isArray(row.owed) ? row.owed.map(String) : [],
          ...(unchosen.has(row.slug) ? { unchosen: true } : {}),
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

  router.get('/api/workshop/needs-feed', async (req, res) => {
    try {
      if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
      const showSelfHosted = !!req.user.isAdmin || !!config.selfAppPublicVoting;
      const { rows } = await pool.query(NEEDS_FEED_SQL, [
        req.user.id, showSelfHosted, !!req.user.isAdmin, NEEDS_FEED_MAX,
      ]);
      const items = shapeNeedsFeed(await withVotesRequired(pool, rows));
      if (IS_STAGING && req.query.demo === '1') {
        return res.json({ items: withDemoNeedsFeed(items), max: NEEDS_FEED_MAX });
      }
      return res.json({ items, max: NEEDS_FEED_MAX });
    } catch (err) {
      log.error('workshop-overview', 'Failed to read the needs feed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = {
  workshopOverviewRoutes, withDemoCounts, DEMO_COUNTS, COUNTS_SQL,
  withDemoItems, DEMO_ITEMS, ITEMS_SQL, ITEMS_PER_APP, ITEMS_TOTAL, groupItems,
  NEEDS_FEED_SQL, NEEDS_FEED_MAX, shapeNeedsFeed, withVotesRequired, DEMO_NEEDS_FEED, withDemoNeedsFeed,
  OWED_BY_COMMUNITY_SQL, owedByCommunity,
  MY_SESSIONS_WHERE, MY_PROPOSALS_WHERE,
};
