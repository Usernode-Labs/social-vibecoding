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
//        → { registry: [{ key, title }], hidden: [key…], panels: [ … ] }
//        `registry` + `hidden` always describe every panel this platform
//        has (so Settings can render its checkboxes from the same
//        response); `panels` carries the BUILT payload for the visible
//        ones only.
//   POST /api/home-panels/:key/visibility  body { hidden: boolean }
//        → { hidden: [key…] }
//
// Placement model: `users.home_panels_hidden` is a TEXT[] of keys the
// viewer has dismissed. ABSENCE MEANS VISIBLE — that's what makes the
// challenges panel default-on for every existing and future account
// with no backfill. Keys are validated against PANEL_REGISTRY on write
// so the column can never accumulate junk.
//
// Only ONE panel exists today (`challenges`). The registry indirection is
// deliberate: adding a second panel is a new entry + a builder, not a
// refactor of the route or the client.

'use strict';

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { homePanelPrefLimiter } = require('../middleware/rate-limits');
const { TEMPLATE_JOIN_COLUMNS_SQL } = require('./topochain/challenge-view');

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

// The current active PUBLIC season — the same predicate GET /challenges
// resolves its default scope with (mobile.js). Null when nothing is
// running, which is production's state between seasons and is what makes
// the card silently absent rather than an empty box on every home screen.
async function fetchCurrentSeason(pool) {
  const { rows } = await pool.query(
    `SELECT id, name FROM seasons
      WHERE internal = FALSE AND is_active = TRUE
        AND starts_at <= NOW() AND ends_at >= NOW()
      ORDER BY starts_at DESC, id DESC LIMIT 1`
  );
  return rows[0] || null;
}

async function buildChallengesPanel(pool, user) {
  const season = await fetchCurrentSeason(pool);
  if (!season) {
    return { season: null, total: 0, done: 0, points_remaining: null, challenges: [] };
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
      WHERE se.season_id = $2 AND ${OPEN_CHALLENGE_WHERE}
      ORDER BY (${DONE_EXPR}) ASC,
               (c.featured IS NOT TRUE) ASC,
               COALESCE(c.featured_order, 2147483647) ASC,
               c.display_order ASC, c.id ASC
      LIMIT $3`,
    [user.id, season.id, CHALLENGE_ROW_LIMIT]
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
      WHERE se.season_id = $2 AND ${OPEN_CHALLENGE_WHERE}`,
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

  return {
    season: { id: Number(season.id), name: season.name },
    total: totalRows[0]?.total ?? challenges.length,
    done: totalRows[0]?.done ?? 0,
    points_remaining: pointsRemaining,
    challenges,
  };
}

// Staging-only demo payload (see "Staging mock data" in the platform
// conventions). The boot seed gives the three capture/admin identities
// real rows, but ANY staging reviewer signed in as their cloned prod
// identity would see zero progress; this makes every state visible
// deterministically regardless of who is looking. Read-only, obviously
// fake, written nowhere, and a strict no-op outside staging.
function demoChallengesPanel() {
  const rows = [
    {
      id: 900512,
      label: 'ONCHAIN',
      goal: 'Staging demo challenge — test the demo dApps',
      task: 'Open eight of the demo dApps and leave a note on each.',
      reward: 'Up to 2,100 pts',
      cta: { label: 'Get Started', link: 'https://example.invalid/staging-demo' },
      metric: { kind: 'count', label: 'Apps tested', target: 8 },
      progress: { done: false, current: 3, target: 8 },
      earned_points: 600,
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
  ];
  // `total` is exactly the row budget (4) on purpose, so every one of the
  // four states — including the DONE row — is on screen for the before/
  // after captures and the dapp.json check. Rows sort not-done-first, so a
  // total above the budget would spend the last slot on the "See all N"
  // link and drop the ✓ row; the OVERFLOW slot is exercised instead by the
  // real query path, where the boot seed leaves five challenges open (see
  // seedStagingTopochain in src/db/migrate.js).
  return {
    season: { id: 900500, name: 'Staging Demo Season — Topochain' },
    total: 4,
    done: 1,
    points_remaining: null,
    challenges: rows,
    demo: true,
  };
}

// ─── Registry ────────────────────────────────────────────────────────
//
// key → { title, build(pool, user), demo() }. Order here IS the order the
// panels render in on the home screen.
const PANEL_REGISTRY = [
  {
    key: 'challenges',
    title: 'Challenges',
    build: buildChallengesPanel,
    demo: demoChallengesPanel,
  },
];

const PANEL_KEYS = new Set(PANEL_REGISTRY.map((p) => p.key));

// The viewer's dismissed keys, filtered to the live registry so a key
// retired from the code stops affecting anything without a migration.
async function readHidden(pool, userId) {
  const { rows } = await pool.query(
    'SELECT home_panels_hidden FROM users WHERE id = $1',
    [userId]
  );
  const raw = rows[0]?.home_panels_hidden;
  if (!Array.isArray(raw)) return [];
  return raw.filter((k) => PANEL_KEYS.has(k));
}

function homePanelRoutes() {
  const router = Router();
  const pool = getPool();

  router.get('/api/home-panels', async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    const registry = PANEL_REGISTRY.map((p) => ({ key: p.key, title: p.title }));
    try {
      const hidden = await readHidden(pool, req.user.id);
      const demo = IS_STAGING && req.query.demo === '1';
      const panels = [];
      for (const panel of PANEL_REGISTRY) {
        if (hidden.includes(panel.key)) continue;
        try {
          const data = demo && panel.demo
            ? panel.demo()
            : await panel.build(pool, req.user);
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

  router.post('/api/home-panels/:key/visibility', homePanelPrefLimiter, async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Not authenticated' });
    const key = String(req.params.key || '');
    if (!PANEL_KEYS.has(key)) return res.status(400).json({ error: 'Unknown panel' });
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

  return router;
}

module.exports = {
  homePanelRoutes,
  // Exported for tests / future panels.
  PANEL_REGISTRY,
  parseRewardPoints,
  resolveProgress,
  buildChallengeRow,
};
