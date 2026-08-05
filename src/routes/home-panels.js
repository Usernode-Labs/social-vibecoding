// Home-screen panels (issue #911) — data + per-user placement for the
// cards that sit on the platform home screen alongside the app grid.
//
// NAMING — "panel", not "widget". public/js/home.js already owns a
// DIFFERENT concept called "widget": the iOS home-screen widget's pinned
// app grid (Home.renderWidgetSection / #widget-strip / .widget-tile),
// whose UI literally says "Usernode widget". These cards are a separate
// thing that lives on the SAME screen, so everything here — the route,
// the column, the client module, the CSS classes — says `panel` instead.
// User-facing copy never says "panel": the first panel is titled
// "Challenges" and the Settings row that governs them says "Home screen
// widgets", matching the language of #911.
//
// Surface:
//   GET  /api/home-panels
//        → { registry: [{ key, title, removable, sizes }], hidden: [key…],
//            panels: [ … ] }
//        `registry` + `hidden` always describe every panel this platform
//        has (so Settings can render its checkboxes from the same
//        response); `panels` carries the BUILT payload for the visible
//        ones only.
//   POST /api/home-panels/:key/visibility  body { hidden: boolean }
//        → { hidden: [key…] }
//
// Visibility model: `users.home_panels_hidden` is a TEXT[] of keys the
// viewer has dismissed. ABSENCE MEANS VISIBLE — that's what makes every
// widget default-on for every existing and future account with no
// backfill. Keys are validated against PANEL_REGISTRY on write so the
// column can never accumulate junk.
//
// PLACEMENT lives elsewhere now: src/routes/home-layout.js owns the
// free-form (column, row) cell each widget and app tile occupies, in the
// same table and the same write as the app tiles. This file is the widget
// REGISTRY plus per-widget CONTENT; it no longer stores a position.
//
// Three widgets today: `challenges` (the only one with a real builder),
// `discover` (featured apps + the way into the app directory) and `create`
// (the create-an-app tile). The registry indirection is deliberate: adding
// a fourth is a new entry + a builder, not a refactor of route or client.

'use strict';

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { homePanelPrefLimiter } = require('../middleware/rate-limits');
const { TEMPLATE_JOIN_COLUMNS_SQL } = require('./topochain/challenge-view');
const { rankedUsers } = require('../services/leaderboard-users');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// How many challenge rows the block can show. This is a LAYOUT constant:
// the block is capped at two app-grid rows tall (--home-panel-max-h in
// public/css/app.css) and that budget buys a ~28px title bar plus four
// 44px rows. `total` is reported separately, so when more are open the
// client spends its LAST slot on "See all N challenges" instead of a
// fourth challenge — overflow is fewer rows, never an inner scroller.
// Keep in step with HomePanels.ROW_SLOTS in public/js/home-panels.js.
const CHALLENGE_ROW_LIMIT = 4;

// ─── Reward parsing ──────────────────────────────────────────────────
//
// `challenges.reward` / `challenge_templates.reward` is FREE TEXT written
// by organisers. Real production values include "Up to 6,500 pts",
// "300 pts", "1500", "½ of your final credits", "Unlocks future rewards".
// It is rendered verbatim (the client only appends " pts" to a bare
// number); this parser exists solely for the optional "N pts still on the
// table" half of the summary line, which is suppressed entirely unless
// EVERY open row's reward is a plain number. Returns null when the string
// isn't confidently numeric — never a guess.
function parseRewardPoints(reward) {
  if (reward == null) return null;
  const cleaned = String(reward)
    .trim()
    .replace(/^up\s+to\s+/i, '')
    .replace(/\s*(?:pts?|points?)\s*$/i, '')
    .replace(/,/g, '')
    .trim();
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// ─── Progress resolution ─────────────────────────────────────────────
//
// THE AUTHORITATIVE PER-USER PROGRESS VALUE DOES NOT EXIST YET. The v4
// migration's `challenge_progress` deliberately returns `state: 'none'`,
// `current: null` placeholders (src/routes/topochain/mobile.js
// fetchChallengeProgress, SPEC §4.10), and `leaderboard_snapshots
// .challenge_details` cannot be joined — its `challenge_id` values are
// SOURCE-system ids (production snapshots reference 56/42/30/49 for goals
// whose platform challenges.id are 47/40/…).
//
// So this function derives progress from the points ledger:
//   * no numeric target            → binary: done once any activity row
//                                    credits the viewer for it.
//   * metric_type 'blocks_produced'→ current = the viewer's newest
//                                    snapshot's event_total_produced_blocks.
//   * any other metric with target → current = the number of the viewer's
//                                    activity rows on the challenge (one
//                                    ledger row per unit — exactly how
//                                    production challenge 58 "Test the
//                                    hackathon dApps" (target 8) is
//                                    credited, at 200 pts per app tested).
//
// The count-the-rows rule UNDER-counts where an admin credits a batch in a
// single row. It is the most honest signal available today; when a real
// per-user progress feed lands, THIS is the one function to replace.
function resolveProgress({ metricKind, metricTarget, activityCount, blocks }) {
  const count = Number(activityCount) || 0;
  const target = Number(metricTarget);
  const hasTarget = metricKind != null && Number.isFinite(target) && target > 0;
  if (!hasTarget) {
    return { done: count > 0, current: null, target: null };
  }
  const raw = metricKind === 'blocks_produced' ? (Number(blocks) || 0) : count;
  const current = Math.max(0, Math.min(raw, target));
  // target <= 1 with any credit at all is done — a "produce your first
  // block" challenge shouldn't read as 0/1 after the block was credited
  // through the ledger rather than through the snapshot.
  const done = raw >= target || (target <= 1 && count > 0);
  return { done, current, target };
}

// resolveProgress's done rule, in SQL. It has to exist in both languages:
// SQL needs it to sort not-done rows first and to pick WHICH rows survive
// the LIMIT, and to COUNT the done ones across every open challenge
// (including the ones past the cap). The row query selects it as
// `my_done`, and buildChallengeRow prefers that value over recomputing —
// so a real request has exactly one answer even if these two ever drift.
//
// The trap this closes: "has any ledger row" is NOT done-ness. A numeric
// challenge at 3 of 8 has three rows and is emphatically not finished; an
// earlier version sorted it to the bottom with the completed ones and
// counted it as done.
const DONE_SQL = `
    CASE
      WHEN COALESCE(c.metric_type, ct.metric_type) IS NULL
        OR COALESCE(c.metric_target, ct.metric_target) IS NULL
        OR COALESCE(c.metric_target, ct.metric_target) <= 0
        THEN %COUNT% > 0
      WHEN COALESCE(c.metric_type, ct.metric_type) = 'blocks_produced'
        THEN COALESCE(%BLOCKS%, 0) >= COALESCE(c.metric_target, ct.metric_target)
             OR (COALESCE(c.metric_target, ct.metric_target) <= 1 AND %COUNT% > 0)
      ELSE %COUNT% >= COALESCE(c.metric_target, ct.metric_target)
    END`;

// The two per-user aggregates DONE_SQL needs, as correlated subqueries
// (Postgres can't reference a SELECT-list alias from the same SELECT list,
// so they're substituted in rather than named).
const MY_COUNT_SQL = `(SELECT COUNT(*) FROM user_activities ua
              WHERE ua.user_id = $1 AND ua.challenge_id = c.id)`;
const MY_BLOCKS_SQL = `(SELECT ls.event_total_produced_blocks FROM leaderboard_snapshots ls
              WHERE ls.user_id = $1 AND ls.season_event_id = c.season_event_id
              ORDER BY ls.snapshot_at DESC, ls.id DESC LIMIT 1)`;

const DONE_EXPR = DONE_SQL
  .replace(/%COUNT%/g, MY_COUNT_SQL)
  .replace(/%BLOCKS%/g, MY_BLOCKS_SQL);

// One JOINed row → the panel's per-challenge shape. `r` carries the
// challenge columns unprefixed and the template columns `t_`-prefixed
// (TEMPLATE_JOIN_COLUMNS_SQL), plus the three per-user aggregates.
//
// The challenge row overrides the template for every field it shares —
// the WIDER merge rule mobile.js established for this same data (its
// MOBILE_OVERRIDE_KEYS includes metric_*/cta_*, unlike public.js's
// deliberately narrower list). `label` is the template's category
// uppercased, 'OTHER' when unset, same as mobile.js effectiveCategory.
function buildChallengeRow(r) {
  const eff = (key) => (r[key] != null ? r[key] : r[`t_${key}`]);
  const metricKind = eff('metric_type');
  const metricTarget = eff('metric_target');
  const progress = resolveProgress({
    metricKind,
    metricTarget,
    activityCount: r.my_activity_count,
    blocks: r.my_blocks,
  });
  // The query decided done-ness (DONE_EXPR) for its own ordering and for
  // the panel's done COUNT; take that value so the chips and the "N of M
  // done" line can never disagree.
  if (r.my_done != null) progress.done = !!r.my_done;
  const ctaLink = eff('cta_link');
  return {
    id: Number(r.id),
    label: String(r.t_category || 'OTHER').toUpperCase(),
    goal: eff('goal'),
    task: eff('task'),
    reward: eff('reward'),
    cta: ctaLink ? { label: eff('cta_label') || 'Get Started', link: ctaLink } : null,
    metric: progress.target == null ? null : {
      kind: metricKind,
      label: eff('metric_label'),
      target: progress.target,
    },
    progress,
    earned_points: Number(r.my_points) || 0,
  };
}

// The scope + filter predicate, shared verbatim by the row query and the
// COUNT that produces `total` — so the footer's "See all N" can never
// disagree with the rows above it.
//
// "Open" means: in the season that is running right now, on a PUBLIC
// (non-internal) event, organiser-enabled, not organiser-marked-finished,
// and inside its effective schedule window (or carrying no window at
// all). `completed` is an organiser flag about the CHALLENGE ("this one
// is over"), never a per-user signal — see the schema comment and
// public/js/topochain-challenges.js.
const OPEN_CHALLENGE_WHERE = `
        se.internal = FALSE
    AND c.enabled = TRUE
    AND c.completed = FALSE
    AND COALESCE(c.schedule_start, ct.schedule_start, NOW() - INTERVAL '1 second') <= NOW()
    AND COALESCE(c.schedule_end, ct.schedule_end, NOW() + INTERVAL '1 second') >= NOW()`;

// The EXPANDED view's predicate: the same season and public-event scope,
// still organiser-enabled, but WITHOUT the not-completed and in-window
// filters — expanding is how a viewer sees the season's finished
// challenges (and their own ✓ marks on them) without leaving home. The
// collapsed panel stays strictly "open" per OPEN_CHALLENGE_WHERE.
const ALL_CHALLENGE_WHERE = `
        se.internal = FALSE
    AND c.enabled = TRUE`;

// Hard ceiling on the expanded list. A season can accumulate dozens of
// challenges (production's Season 1 has 58 rows across its events), and
// the expanded block is still a home-screen widget, not the Challenges
// screen — the footer's own button goes there for the full list.
const CHALLENGE_EXPANDED_LIMIT = 40;

// ─── The desktop LEADERBOARD fill ────────────────────────────────────
//
// At five columns the widget is a TILE in a grid of app icons: it holds a
// fixed 2x2 footprint whatever it has to say, so a short challenge list used
// to buy nothing but a blank band. Whenever the collapsed list leaves room,
// the client spends it on the platform's own ranked-users board — the top few
// builders plus the viewer's own rank (public/js/home-panels.js decides how
// many rows fit; this just supplies enough of them).
//
// WHY THIS BOARD and not the Topochain standings: /api/v4/leaderboard resolves
// the RUNNING event and 404s between seasons — i.e. it is empty exactly when
// the fill is needed — and /leaderboard/global is keyed by wallet identity, so
// most viewers have no row and "your rank" is unanswerable. The kudos board is
// keyed by platform username, has a row for every account, and is already
// public (GET /api/leaderboard/users), so the widget discloses nothing new.
const FILL_TOP_ROWS = 3;

// The ranked list is IDENTICAL for every viewer — only the "which row is me"
// step is per-request — so one execution serves everyone who loads their home
// screen inside the TTL. Short by design: standings that lag a minute are
// fine, standings that need a query per home-screen paint are not.
const FILL_TTL_MS = 30 * 1000;
let _fillCache = { at: 0, rows: null };

async function rankedUsersCached(pool) {
  const now = Date.now();
  if (_fillCache.rows && now - _fillCache.at < FILL_TTL_MS) return _fillCache.rows;
  // `slim` drops the three display-only LATERALs (kudos_given, issues_created,
  // active_apps): none of them appears in the ORDER BY, so the ranking is
  // identical and the widget doesn't pay for columns it can't render.
  const rows = await rankedUsers(pool, { window: 'all', slim: true });
  _fillCache = { at: now, rows };
  return rows;
}

// Exported for tests: a cached ranking would otherwise leak across cases.
function _resetFillCache() {
  _fillCache = { at: 0, rows: null };
}

// { top: [{ rank, username, score }], viewer: {…} | null, total }.
// `score` is kudos_received_prs_merged — the same headline metric the Top
// users tab ranks and badges on, so the widget's number and the screen's
// number are the same number.
async function buildLeaderboardFill(pool, user) {
  const rows = await rankedUsersCached(pool);
  if (!Array.isArray(rows) || !rows.length) return null;
  const shape = (r, i) => ({
    rank: i + 1,
    username: r.username,
    score: Number(r.kudos_received_prs_merged) || 0,
  });
  const top = rows.slice(0, FILL_TOP_ROWS).map(shape);
  // Case-insensitive, like every other username match on the platform.
  const me = String(user?.username || '').toLowerCase();
  const myIndex = me
    ? rows.findIndex((r) => String(r.username || '').toLowerCase() === me)
    : -1;
  return {
    top,
    viewer: myIndex >= 0 ? shape(rows[myIndex], myIndex) : null,
    total: rows.length,
  };
}

// Attach the fill when the collapsed list leaves room for it. Never fatal: a
// leaderboard hiccup must not change the challenges panel, which is the
// invariant this whole route is built on (one broken panel never blanks the
// home screen). Skipped when EXPANDED — an expanded block is all challenges.
async function attachLeaderboardFill(pool, user, panel) {
  if (!panel || panel.expanded) return panel;
  if ((panel.challenges || []).length >= CHALLENGE_ROW_LIMIT) return panel;
  try {
    const fill = await buildLeaderboardFill(pool, user);
    if (fill) panel.leaderboard = fill;
  } catch (err) {
    log.error('home-panels', 'leaderboard fill failed', {
      userId: user?.id, message: err.message,
    });
  }
  return panel;
}

// The current active PUBLIC season — the same predicate GET /challenges
// resolves its default scope with (mobile.js). Null when nothing is
// running, which is production's state between seasons and is what makes
// the card render its compact "nothing running" state (and, on desktop,
// spend the tile on the leaderboard fill above).
async function fetchCurrentSeason(pool) {
  const { rows } = await pool.query(
    `SELECT id, name FROM seasons
      WHERE internal = FALSE AND is_active = TRUE
        AND starts_at <= NOW() AND ends_at >= NOW()
      ORDER BY starts_at DESC, id DESC LIMIT 1`
  );
  return rows[0] || null;
}

async function buildChallengesPanel(pool, user, opts) {
  // `expanded` is the in-place "See all" state: same scope, but finished
  // and out-of-window challenges come too, and the row cap lifts. The
  // client grows the block past its height cap for this and the same
  // control collapses it back — nothing is persisted.
  const expanded = !!(opts && opts.expanded);
  const scopeWhere = expanded ? ALL_CHALLENGE_WHERE : OPEN_CHALLENGE_WHERE;
  const rowLimit = expanded ? CHALLENGE_EXPANDED_LIMIT : CHALLENGE_ROW_LIMIT;

  const season = await fetchCurrentSeason(pool);
  if (!season) {
    // Between seasons. The panel still renders — a compact "nothing running"
    // line on a phone, that line plus the LEADERBOARD fill on desktop — so
    // the widget explains itself instead of vanishing.
    return attachLeaderboardFill(pool, user, {
      season: null, total: 0, done: 0, points_remaining: null,
      challenges: [], expanded,
    });
  }

  // Rows: one statement, per-user aggregates as correlated subqueries so
  // there is no second round trip and no N+1. Ordering is done in SQL —
  // not-done first (the card must lead with something actionable), then
  // organiser-featured, then the organiser's display order.
  const { rows } = await pool.query(
    `SELECT c.id, c.season_event_id, c.goal, c.task, c.reward,
            c.schedule_start, c.schedule_end,
            c.cta_label, c.cta_link,
            c.metric_type, c.metric_target, c.metric_label,
            c.enabled, c.completed, c.display_order, c.featured, c.featured_order,
            ${TEMPLATE_JOIN_COLUMNS_SQL},
            ${MY_COUNT_SQL} AS my_activity_count,
            (SELECT COALESCE(SUM(ua.points), 0) FROM user_activities ua
              WHERE ua.user_id = $1 AND ua.challenge_id = c.id) AS my_points,
            ${MY_BLOCKS_SQL} AS my_blocks,
            ${DONE_EXPR} AS my_done
       FROM challenges c
       JOIN season_events se ON se.id = c.season_event_id
       LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
      WHERE se.season_id = $2 AND ${scopeWhere}
      ORDER BY (${DONE_EXPR}) ASC,
               (c.featured IS NOT TRUE) ASC,
               COALESCE(c.featured_order, 2147483647) ASC,
               c.display_order ASC, c.id ASC
      LIMIT $3`,
    [user.id, season.id, rowLimit]
  );

  // Totals over the WHOLE open set, not the page above: `total` drives the
  // client's "See all N" slot, and `open_rewards` is what makes
  // points_remaining honest. With the row cap at four, summing only the
  // returned rows would understate "pts left" the moment a fifth challenge
  // opens — so collect every open not-done row's effective reward here (a
  // handful of short strings) and parse them below.
  const { rows: totalRows } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE ${DONE_EXPR})::int AS done,
            COALESCE(
              array_agg(COALESCE(c.reward, ct.reward)) FILTER (WHERE NOT (${DONE_EXPR})),
              '{}'
            ) AS open_rewards
       FROM challenges c
       JOIN season_events se ON se.id = c.season_event_id
       LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
      WHERE se.season_id = $2 AND ${scopeWhere}`,
    [user.id, season.id]
  );

  // A challenge whose template row vanished is skipped rather than 500ing
  // the panel — the same guard public.js applies to its own challenge
  // list (the FK should make it unreachable in practice).
  const challenges = rows.filter((r) => r.t_id != null).map(buildChallengeRow);

  // "Points still on the table": only when EVERY open row's reward parses
  // as a plain number. One "½ of your final credits" and the whole figure
  // is withheld rather than silently under-reported.
  const openRewards = Array.isArray(totalRows[0]?.open_rewards)
    ? totalRows[0].open_rewards : [];
  let pointsRemaining = 0;
  for (const reward of openRewards) {
    const n = parseRewardPoints(reward);
    if (n == null) { pointsRemaining = null; break; }
    pointsRemaining += n;
  }

  return attachLeaderboardFill(pool, user, {
    season: { id: Number(season.id), name: season.name },
    total: totalRows[0]?.total ?? challenges.length,
    done: totalRows[0]?.done ?? 0,
    points_remaining: pointsRemaining,
    challenges,
    expanded,
  });
}

// The demo LEADERBOARD fill. The real fill reads public tables that staging
// clones from production, so a preview HAS standings without any seeding —
// but the dapp.json checks and the before/after screenshots need the tile to
// be the SAME tile every run, and the viewer's own row has to exist whoever
// is signed in. Obviously fake, read-only, written nowhere.
function demoLeaderboardFill(username) {
  const name = String(username || '').trim() || 'you';
  return {
    top: [
      { rank: 1, username: 'staging-demo-lead', score: 41 },
      { rank: 2, username: 'staging-demo-builder', score: 27 },
      { rank: 3, username: 'staging-demo-tester', score: 18 },
    ],
    viewer: { rank: 7, username: name, score: 6 },
    total: 42,
  };
}

// Staging-only demo payload (see "Staging mock data" in the platform
// conventions). The boot seed gives the three capture/admin identities
// real rows, but ANY staging reviewer signed in as their cloned prod
// identity would see zero progress; this makes every state visible
// deterministically regardless of who is looking. Read-only, obviously
// fake, written nowhere, and a strict no-op outside staging.
//
// `variant` (from ?demo=1&challenges=few|none) picks the SHORT-LIST states,
// which a staging clone cannot otherwise reach while the seeded season is
// live — they are the whole point of this change and so have to be
// URL-reachable for the checks and the screenshots:
//   'few'  → two open rows: the shrink on a phone, two challenge lines plus
//            two leaderboard lines on desktop.
//   'none' → nothing open: the compact one-line block on a phone, that line
//            plus the leaderboard section on desktop.
// Absent/unknown → the four-row payload exactly as before.
function demoChallengesPanel(opts) {
  const expanded = !!(opts && opts.expanded);
  const variant = opts && opts.variant;
  const username = opts && opts.username;

  if (variant === 'none') {
    return {
      season: null, total: 0, done: 0, points_remaining: null,
      challenges: [], expanded,
      leaderboard: demoLeaderboardFill(username),
      demo: true,
    };
  }
  const rows = [
    {
      id: 900512,
      label: 'ONCHAIN',
      goal: 'Staging demo challenge — test the demo dApps',
      task: 'Open eight of the demo dApps and leave a note on each.',
      reward: 'Up to 2,100 pts',
      cta: { label: 'Get Started', link: 'https://example.invalid/staging-demo' },
      metric: { kind: 'count', label: 'Apps tested', target: 8 },
      // Roughly half — the clearest read of a part-filled outlined bar.
      progress: { done: false, current: 4, target: 8 },
      earned_points: 800,
    },
    {
      id: 900510,
      label: 'BUG',
      goal: 'Staging demo challenge — report a reproducible bug',
      task: 'Find and file a reproducible bug report against the testnet client.',
      reward: '250 points',
      cta: null,
      metric: null,
      progress: { done: false, current: null, target: null },
      earned_points: 0,
    },
    // The two DONE rows come last (the client's orderRows puts them there
    // anyway) and deliberately sit next to each other: one binary, one
    // numeric at full target. Seeing both kinds of "done" side by side —
    // a ✓ with no bar, and a ✓ over a bar filled end to end — is the whole
    // reason the numeric one exists here, and the collapsed block only has
    // four slots to spend.
    {
      id: 900511,
      label: 'SOCIAL',
      goal: 'Staging demo challenge — share the season announcement',
      task: 'Share the season announcement post on social media.',
      reward: '50 points',
      cta: null,
      metric: null,
      progress: { done: true, current: null, target: null },
      earned_points: 50,
    },
    {
      id: 900516,
      label: 'COMMUNITY',
      goal: 'Staging demo challenge — vote on five proposals',
      task: 'Cast a vote on five open proposals from other builders.',
      reward: '900 pts',
      cta: null,
      metric: { kind: 'count', label: 'Proposals voted', target: 5 },
      progress: { done: true, current: 5, target: 5 },
      earned_points: 900,
    },
  ];
  // Open, but past the four collapsed slots — the empty 0-of-5 track, which
  // is the least informative of the numeric states and so the one that
  // gives up its slot to the finished numeric above. Expanding shows it.
  const overflow = [
    {
      id: 900513,
      label: 'COMMUNITY',
      goal: 'Staging demo challenge — give kudos to five builders',
      task: 'Send kudos on five merged proposals from other builders.',
      reward: '1500',
      cta: null,
      metric: { kind: 'count', label: 'Kudos', target: 5 },
      progress: { done: false, current: 0, target: 5 },
      earned_points: 0,
    },
  ];
  // Expanding shows the season's FINISHED challenges too — the state the
  // collapsed panel filters out. Two organiser-closed rows, one of which
  // the viewer completed, so the ✓-on-a-finished-challenge case is
  // reviewable from the demo route as well as the seeded one.
  const finished = [
    {
      id: 900514,
      label: 'FLASH',
      goal: 'Staging demo challenge — closed: live feedback session',
      task: 'Joined the live feedback call and left notes.',
      reward: '500 points',
      cta: null,
      metric: null,
      progress: { done: true, current: null, target: null },
      earned_points: 500,
    },
    {
      id: 900515,
      label: 'TECHNICAL',
      goal: 'Staging demo challenge — closed: stress load round',
      task: 'The stress-load round has finished.',
      reward: 'Up to 500 pts',
      cta: null,
      metric: null,
      progress: { done: false, current: null, target: null },
      earned_points: 0,
    },
  ];

  // The SHORT-LIST variant: two open rows, one metered and one binary, so
  // the progress-bar lane is still exercised at the smaller size. `total`
  // matches the rows shown — there is nothing past the cap to "see all" of.
  if (variant === 'few') {
    const few = [rows[0], rows[1]];
    return {
      season: { id: 900500, name: 'Staging Demo Season — Topochain' },
      total: 2,
      done: 0,
      points_remaining: null,
      challenges: expanded ? [...few, ...finished] : few,
      expanded,
      leaderboard: demoLeaderboardFill(username),
      demo: true,
    };
  }

  // Collapsed `total` deliberately exceeds the four-slot budget so the
  // footer reads "See all 7 challenges" and the expand toggle has
  // something to reveal. Expanded returns the open rows PLUS the finished
  // ones, which is exactly what the real builder does when it drops the
  // not-completed filter.
  //
  // No `leaderboard` here: four rows fill the tile, so there is no room to
  // fill and the existing ?demo=1 check sees exactly the markup it always saw.
  const all = expanded ? [...rows, ...overflow, ...finished] : rows;
  return {
    season: { id: 900500, name: 'Staging Demo Season — Topochain' },
    total: expanded ? all.length : 7,
    done: expanded ? 3 : 2,
    points_remaining: null,
    challenges: all,
    expanded,
    demo: true,
  };
}

// ─── Registry ────────────────────────────────────────────────────────
//
// key → { title, removable, sizes, build(pool, user), demo() }. Order here
// is the order Settings renders its checkboxes in, and the fallback
// placement order for any widget the client has no designed home cell for.
// The three shipped widgets do have one — see HomeLayout.WIDGET_HOME_CELLS,
// which is the source of truth for where a fresh home screen puts them.
//
// `sizes` is the widget's FOOTPRINT in grid cells, per column count:
// { 4: [w, h], 5: [w, h] }. It lives here — not in the stored layout — so a
// widget can be resized in code without migrating anyone's saved cells; the
// client's HomeLayout.repair() nudges anything a size change made overlap.
// 2x2 at five columns is ~397px inside the 1024px .home-column, under the
// --home-panel-max-w 32rem cap, so the cap never binds in the grid.
//
// `removable: false` means the ⋮ menu and Settings must refuse to hide it.
// Only `discover` carries it, because #home-browse-btn (now that widget's
// footer) is the ONLY navigation into the #apps directory in the whole
// shell — hiding it would strand the viewer with no way to find apps.
//
// THE REGISTRY TAKES NO VIEWER ARGUMENT, AND MUST NOT GROW ONE. Every entry
// is unconditional: `create` is in the registry, in `panels`, in Settings and
// in the layout for EVERY account, including one with no app quota. Whether
// the create widget is tappable is decided client-side from the derived
// `canCreateApps` boolean (/api/auth/me), which is quota-derived and can flip
// mid-session — a per-viewer registry would turn each of those flips into a
// layout mutation that re-packs the user's grid.
//
// `discover` and `create` are MARKER entries: they build no payload at all.
// Discover's featured tiles are already served per-viewer by GET /api/apps
// (`featured` / `featured_order`, derived client-side by Home.featuredApps),
// and the create widget has nothing to fetch — so neither costs a query.
const PANEL_REGISTRY = [
  {
    key: 'challenges',
    title: 'Challenges',
    removable: true,
    sizes: { 4: [4, 2], 5: [2, 2] },
    build: buildChallengesPanel,
    demo: demoChallengesPanel,
  },
  {
    key: 'discover',
    title: 'Discover',
    removable: false,
    sizes: { 4: [4, 2], 5: [2, 2] },
    build: async () => ({}),
    demo: () => ({ demo: true }),
  },
  {
    key: 'create',
    title: 'Create app',
    removable: true,
    // Full-width strip on a phone, a single tile on desktop. At four columns
    // a 1x1 create tile read as one more app icon in a row of app icons —
    // the one thing on the grid that is an ACTION rather than a launcher had
    // the least presence of anything on it. One row of its own at 4x1 gives
    // it the same weight as the two full-width widgets without spending a
    // second row; the tile itself lays its icon and label out side by side
    // below 640px (see .home-create-tile in home-panels.js / app.css).
    sizes: { 4: [4, 1], 5: [1, 1] },
    build: async () => ({}),
    demo: () => ({ demo: true }),
  },
];

const PANEL_KEYS = new Set(PANEL_REGISTRY.map((p) => p.key));

// The registry as the layout route and the client need it — keys, titles,
// removability and footprints, with no builders. Exported so
// src/routes/home-layout.js validates footprints against the SAME numbers
// the client lays out with.
function panelRegistryPublic() {
  return PANEL_REGISTRY.map((p) => ({
    key: p.key,
    title: p.title,
    removable: p.removable !== false,
    sizes: { 4: [...p.sizes[4]], 5: [...p.sizes[5]] },
  }));
}

// Footprint of one widget at one column count, or null for an unknown key.
// The layout route's overlap check runs on these, so a buggy or hostile
// client can never persist a self-overlapping arrangement.
function widgetSize(key, cols) {
  const entry = PANEL_REGISTRY.find((p) => p.key === key);
  if (!entry) return null;
  const size = entry.sizes[cols] || entry.sizes[5];
  return [size[0], size[1]];
}

// The viewer's dismissed keys, filtered to the live registry so a key
// retired from the code stops affecting anything without a migration.
// `home_panel_positions` is NOT read any more — free-form placement lives in
// user_home_layout (see the retired-column comment in schema.sql).
async function readPrefs(pool, userId) {
  const { rows } = await pool.query(
    'SELECT home_panels_hidden FROM users WHERE id = $1',
    [userId]
  );
  const rawHidden = rows[0]?.home_panels_hidden;
  const hidden = Array.isArray(rawHidden)
    ? rawHidden.filter((k) => PANEL_KEYS.has(k)) : [];
  return { hidden };
}

function homePanelRoutes() {
  const router = Router();
  const pool = getPool();

  router.get('/api/home-panels', async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    const registry = panelRegistryPublic();
    try {
      const { hidden } = await readPrefs(pool, req.user.id);
      const demo = IS_STAGING && req.query.demo === '1';
      // ?expand=<key> asks one panel for its expanded list (finished
      // challenges included, row cap lifted). Per-visit UI state, so it
      // rides on the request rather than being stored.
      const expandKey = typeof req.query.expand === 'string' ? req.query.expand : '';
      // ?demo=1&challenges=few|none picks a demo variant of the challenges
      // payload — the short-list states a seeded staging season can't reach.
      // Staging-only (it rides on `demo`, which is already IS_STAGING-gated)
      // and read-only; an unknown value falls through to the default payload.
      const variant = typeof req.query.challenges === 'string' ? req.query.challenges : '';
      const panels = [];
      for (const panel of PANEL_REGISTRY) {
        if (hidden.includes(panel.key)) continue;
        const expanded = expandKey === panel.key;
        try {
          const data = demo && panel.demo
            ? panel.demo({ expanded, variant, username: req.user.username })
            : await panel.build(pool, req.user, { expanded });
          panels.push({ key: panel.key, title: panel.title, ...data });
        } catch (err) {
          // One broken panel must never blank the home screen — log it
          // and serve the rest.
          log.error('home-panels', 'panel build failed', {
            key: panel.key, userId: req.user.id, message: err.message,
          });
        }
      }
      return res.json({ registry, hidden, panels });
    } catch (err) {
      log.error('home-panels', 'GET /api/home-panels failed', {
        userId: req.user.id, message: err.message,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Show / hide one widget. Deliberately NOT gated on anything about the
  // viewer beyond being signed in: hiding `create` must work for an account
  // with no app quota exactly as it does for a creator, since the widget is
  // on every home screen either way.
  router.post('/api/home-panels/:key/visibility', homePanelPrefLimiter, async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    const key = String(req.params.key || '');
    if (!PANEL_KEYS.has(key)) return res.status(400).json({ error: 'Unknown panel' });
    const entry = PANEL_REGISTRY.find((p) => p.key === key);
    // Discover is the shell's only door to the app directory — refuse to
    // hide it rather than leaving someone with no way to find apps.
    if (entry && entry.removable === false && req.body && req.body.hidden === true) {
      return res.status(400).json({ error: 'This widget cannot be hidden' });
    }
    const { hidden } = req.body || {};
    if (typeof hidden !== 'boolean') {
      return res.status(400).json({ error: 'hidden must be a boolean' });
    }
    try {
      // array_remove first in BOTH branches so re-hiding an already-hidden
      // panel can't duplicate the key.
      const { rows } = await pool.query(
        hidden
          ? `UPDATE users
                SET home_panels_hidden =
                      array_append(array_remove(COALESCE(home_panels_hidden, '{}'), $2), $2)
              WHERE id = $1
              RETURNING home_panels_hidden`
          : `UPDATE users
                SET home_panels_hidden = array_remove(COALESCE(home_panels_hidden, '{}'), $2)
              WHERE id = $1
              RETURNING home_panels_hidden`,
        [req.user.id, key]
      );
      const next = Array.isArray(rows[0]?.home_panels_hidden)
        ? rows[0].home_panels_hidden.filter((k) => PANEL_KEYS.has(k))
        : [];
      return res.json({ hidden: next });
    } catch (err) {
      log.error('home-panels', 'visibility write failed', {
        userId: req.user.id, key, message: err.message,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // NOTE: POST /api/home-panels/:key/position is GONE. A widget's place on
  // the home screen is a real (column, row) cell now, written through
  // PUT /api/home-layout (src/routes/home-layout.js) alongside the app
  // tiles — one write for the whole arrangement instead of a card-count
  // per widget.

  return router;
}

module.exports = {
  homePanelRoutes,
  // Exported for tests / future panels, and for src/routes/home-layout.js —
  // which validates footprints against the SAME registry the client lays
  // out with, so the two can't disagree about how big a widget is.
  PANEL_REGISTRY,
  PANEL_KEYS,
  panelRegistryPublic,
  widgetSize,
  parseRewardPoints,
  resolveProgress,
  buildChallengeRow,
  // The desktop LEADERBOARD fill (exported for tests; the cache reset keeps a
  // memoised ranking from leaking between cases).
  buildLeaderboardFill,
  demoLeaderboardFill,
  demoChallengesPanel,
  _resetFillCache,
  FILL_TOP_ROWS,
};
