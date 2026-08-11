// /api/home-panels — the home screen's Challenges card (#911) and the
// per-user show/hide behind it.
//
// Contracts guarded here:
//
//   1. Me-scoped: no req.user -> 401, never anonymous data.
//   2. "Open" means enabled AND NOT organiser-completed AND inside the
//      effective schedule window, on a PUBLIC event of the season that is
//      running right now. No live season -> an empty panel, not an error.
//   3. Progress is DERIVED (no authoritative per-user value exists — see
//      resolveProgress's comment): binary from "any activity row", numeric
//      from the ledger row count, 'blocks_produced' from the newest
//      snapshot, clamped to the target.
//   4. points_remaining is withheld (null) unless EVERY open row's reward
//      parses as a plain number — organiser prose is never guessed at.
//   5. A hidden panel is dropped from `panels` but still described by
//      `registry` + `hidden`, so Settings renders from the same response.
//   6. The visibility write validates its key against the registry.
//   7. ?demo=1 is a no-op outside staging.
//
// Pure-function tests plus HTTP tests against a throwaway express app and
// a substring-dispatching mock pool (the idiom of
// tests/challenges-web-routes.test.js) — no live DB.
//
// Run with: node --test tests/home-panels-api.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function collapse(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

// ─── Mock pool ────────────────────────────────────────────────────────
//
// `state` carries the fixture: the current season (or null), the joined
// challenge rows the row query should return, and the hidden array.
function makeMockPool(state) {
  const calls = [];
  const pool = {
    async query(rawSql, params = []) {
      const sql = collapse(rawSql);
      calls.push({ sql, params });

      // Placement moved to user_home_layout (src/routes/home-layout.js);
      // this route reads only the per-user hidden set now.
      if (sql.includes('SELECT home_panels_hidden FROM users')) {
        return { rows: [{ home_panels_hidden: state.hidden ?? [] }] };
      }
      if (sql.startsWith('UPDATE users SET home_panels_hidden')) {
        const key = params[1];
        const cur = (state.hidden ?? []).filter((k) => k !== key);
        state.hidden = sql.includes('array_append') ? [...cur, key] : cur;
        return { rows: [{ home_panels_hidden: state.hidden }] };
      }
      if (sql.includes('FROM seasons')) {
        return { rows: state.season ? [state.season] : [] };
      }
      // The COUNT(*) totals query.
      if (sql.includes('COUNT(*)::int AS total')) {
        // The totals query runs over the WHOLE open set, so the fixture
        // may declare `allRows` (what the season really has) separately
        // from `rows` (the capped page the row query returns). Defaults to
        // `rows` when a test doesn't care about the difference.
        const all = state.allRows || state.rows || [];
        const isDone = (r) => Number(r.my_activity_count) > 0;
        return {
          rows: [{
            total: state.total != null ? state.total : all.length,
            done: all.filter(isDone).length,
            // array_agg(COALESCE(c.reward, ct.reward)) FILTER (NOT done)
            open_rewards: all.filter((r) => !isDone(r))
              .map((r) => (r.reward != null ? r.reward : r.t_reward)),
          }],
        };
      }
      // The desktop LEADERBOARD fill's PRIMARY board: the Topochain
      // standings, via src/services/topochain/event-standings.js. Three
      // reads, one per step of that module.
      //
      //   1. which public event has standings (resolveDefaultPublicEvent)
      if (sql.includes('FROM season_events') && sql.includes('display_leaderboard = TRUE')) {
        if (state.eventThrows) throw new Error('event resolution exploded');
        return { rows: state.event ? [state.event] : [] };
      }
      //   2. a 'regular' event's stored snapshot rows (EVENT_LEADERBOARD_SQL).
      //      Matched on its DISTINCT ON, not on the table name: the
      //      challenges row/COUNT queries read leaderboard_snapshots too
      //      (MY_BLOCKS_SQL) and would be swallowed by a looser guard.
      if (sql.includes('DISTINCT ON (ls.user_id) ls.*')) {
        if (state.standingsThrows) throw new Error('standings exploded');
        return { rows: state.standings || [] };
      }
      //   3. any other event type -> the shared §4.10 standings aggregate
      if (sql.includes('SUM(l.total_points)')) {
        if (state.standingsThrows) throw new Error('standings exploded');
        return { rows: state.seasonStandings || [] };
      }
      // The FALLBACK board — src/services/leaderboard-users.js ranking every
      // user. `fillUsers` is the ranked list the fixture wants; absent means
      // "no board", which the route must survive.
      if (sql.includes('FROM users u') && sql.includes('kudos_received_prs_merged')) {
        if (state.fillThrows) throw new Error('leaderboard exploded');
        return { rows: state.fillUsers || [] };
      }
      // The row query.
      if (sql.includes('FROM challenges c')) {
        // Honour the real LIMIT the route passes ($3) rather than a
        // hardcoded page size, so the row cap is genuinely exercised.
        const limit = Number(params[2]) || (state.rows || []).length;
        return { rows: (state.rows || []).slice(0, limit) };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    },
  };
  return { pool, calls };
}

// A joined challenges⋈challenge_templates row with the per-user aggregates,
// as the route's own SELECT produces it.
function row(over = {}) {
  return {
    id: 1,
    season_event_id: 100,
    goal: null, task: null, reward: null,
    schedule_start: null, schedule_end: null,
    cta_label: null, cta_link: null,
    metric_type: null, metric_target: null, metric_label: null,
    enabled: true, completed: false, display_order: 1,
    featured: false, featured_order: null,
    t_id: 10, t_category: 'community',
    t_goal: 'Template goal', t_task: 'Template task', t_reward: '250 pts',
    t_cta_label: null, t_cta_link: null,
    t_metric_type: null, t_metric_target: null, t_metric_label: null,
    t_schedule_start: null, t_schedule_end: null,
    my_activity_count: 0, my_points: 0, my_blocks: null,
    ...over,
  };
}

// Builds an app with req.user injected (or not) and the route's pool
// swapped for the mock.
function makeApp(state, { user } = {}) {
  const { pool, calls } = makeMockPool(state);
  const poolModule = require('../src/db/pool');
  const originalGetPool = poolModule.getPool;
  poolModule.getPool = () => pool;
  let routes;
  try {
    delete require.cache[require.resolve('../src/routes/home-panels')];
    routes = require('../src/routes/home-panels').homePanelRoutes();
  } finally {
    poolModule.getPool = originalGetPool;
  }
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use(routes);
  return { app, calls, state };
}

const USER = { id: 7, username: 'viewer', isAdmin: false };
const SEASON = { id: 1, name: 'Season 1' };

async function get(app, url) {
  const server = app.listen(0);
  // The harness preload (tests/lib/test-net.js) pins hostless listens to
  // 127.0.0.1, which makes the bind complete on the next tick instead of
  // synchronously — so wait for it before reading the assigned port.
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${url}`);
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } finally {
    server.close();
  }
}

async function post(app, url, payload) {
  const server = app.listen(0);
  // The harness preload (tests/lib/test-net.js) pins hostless listens to
  // 127.0.0.1, which makes the bind complete on the next tick instead of
  // synchronously — so wait for it before reading the assigned port.
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } finally {
    server.close();
  }
}

// ─── Pure functions ───────────────────────────────────────────────────

const { parseRewardPoints, resolveProgress, buildChallengeRow, PANEL_REGISTRY } =
  require('../src/routes/home-panels');

test('parseRewardPoints: only confidently-numeric rewards yield a number', () => {
  assert.equal(parseRewardPoints('1500'), 1500);
  assert.equal(parseRewardPoints('300 pts'), 300);
  assert.equal(parseRewardPoints('250 points'), 250);
  assert.equal(parseRewardPoints('Up to 6,500 pts'), 6500);
  assert.equal(parseRewardPoints('6,500'), 6500);
  // Organiser prose is never guessed at.
  assert.equal(parseRewardPoints('½ of your final credits'), null);
  assert.equal(parseRewardPoints('Unlocks future rewards'), null);
  assert.equal(parseRewardPoints('Up to 500 pts / issue'), null);
  assert.equal(parseRewardPoints(null), null);
  assert.equal(parseRewardPoints(''), null);
});

test('resolveProgress: no metric target is binary, credited by any ledger row', () => {
  assert.deepEqual(resolveProgress({ metricKind: null, metricTarget: null, activityCount: 0 }),
    { done: false, current: null, target: null });
  assert.deepEqual(resolveProgress({ metricKind: null, metricTarget: null, activityCount: 1 }),
    { done: true, current: null, target: null });
  // A metric_type with no usable target falls back to binary rather than
  // rendering a bar against NaN.
  assert.deepEqual(resolveProgress({ metricKind: 'count', metricTarget: 0, activityCount: 2 }),
    { done: true, current: null, target: null });
  assert.deepEqual(resolveProgress({ metricKind: 'count', metricTarget: null, activityCount: 0 }),
    { done: false, current: null, target: null });
});

test('resolveProgress: numeric counts ledger rows and clamps to the target', () => {
  assert.deepEqual(resolveProgress({ metricKind: 'count', metricTarget: 8, activityCount: 3 }),
    { done: false, current: 3, target: 8 });
  assert.deepEqual(resolveProgress({ metricKind: 'count', metricTarget: 8, activityCount: 8 }),
    { done: true, current: 8, target: 8 });
  // Over-target never exceeds the bar.
  assert.deepEqual(resolveProgress({ metricKind: 'count', metricTarget: 3, activityCount: 9 }),
    { done: true, current: 3, target: 3 });
  assert.deepEqual(resolveProgress({ metricKind: 'count', metricTarget: 5, activityCount: 0 }),
    { done: false, current: 0, target: 5 });
});

test("resolveProgress: 'blocks_produced' reads the snapshot, not the ledger", () => {
  assert.deepEqual(
    resolveProgress({ metricKind: 'blocks_produced', metricTarget: 10, activityCount: 0, blocks: 4 }),
    { done: false, current: 4, target: 10 }
  );
  // target <= 1 with ledger credit is done even when the snapshot lags.
  assert.deepEqual(
    resolveProgress({ metricKind: 'blocks_produced', metricTarget: 1, activityCount: 1, blocks: 0 }),
    { done: true, current: 0, target: 1 }
  );
});

test('buildChallengeRow: the challenge row overrides the template per field', () => {
  const built = buildChallengeRow(row({
    goal: 'Challenge goal',
    reward: null,               // falls back to the template
    metric_type: 'count', metric_target: '4.0000', metric_label: 'Votes cast',
    cta_link: 'https://example.invalid/go', cta_label: null,
    my_activity_count: 2, my_points: '400',
  }));
  assert.equal(built.goal, 'Challenge goal');
  assert.equal(built.task, 'Template task');       // template wins when unset
  assert.equal(built.reward, '250 pts');
  assert.equal(built.label, 'COMMUNITY');          // template category, uppercased
  assert.deepEqual(built.metric, { kind: 'count', label: 'Votes cast', target: 4 });
  assert.deepEqual(built.progress, { done: false, current: 2, target: 4 });
  assert.equal(built.earned_points, 400);
  assert.deepEqual(built.cta, { label: 'Get Started', link: 'https://example.invalid/go' });
});

test('buildChallengeRow: no cta_link means no cta, and a missing category is OTHER', () => {
  const built = buildChallengeRow(row({ t_category: null }));
  assert.equal(built.cta, null);
  assert.equal(built.label, 'OTHER');
});

test('the registry is ordered and carries the challenges panel', () => {
  assert.ok(PANEL_REGISTRY.some((p) => p.key === 'challenges' && p.title === 'Challenges'));
  for (const p of PANEL_REGISTRY) {
    assert.equal(typeof p.build, 'function', `${p.key} needs a builder`);
  }
});

// ─── GET /api/home-panels ─────────────────────────────────────────────

test('GET /api/home-panels: 401 without a signed-in user', async () => {
  const { app } = makeApp({ season: SEASON, rows: [] });
  const { status } = await get(app, '/api/home-panels');
  assert.equal(status, 401);
});

test('GET /api/home-panels: no live season -> an empty panel, not an error', async () => {
  const { app } = makeApp({ season: null, rows: [] }, { user: USER });
  const { status, body } = await get(app, '/api/home-panels');
  assert.equal(status, 200);
  assert.deepEqual(body.registry.map((r) => r.key), ['challenges', 'discover', 'create']);
  // Three built entries: the challenges payload plus the two MARKER widgets
  // (discover / create), which build nothing but still ride the response so
  // the client can find every renderable in one place.
  assert.deepEqual(body.panels.map((p) => p.key), ['challenges', 'discover', 'create']);
  const ch = body.panels.find((p) => p.key === 'challenges');
  assert.equal(ch.total, 0);
  assert.equal(ch.season, null);
  assert.deepEqual(ch.challenges, []);
});

test('GET /api/home-panels: the open-challenge filter is in the SQL, both queries', async () => {
  const { app, calls } = makeApp({ season: SEASON, rows: [row()] }, { user: USER });
  await get(app, '/api/home-panels');
  const challengeQueries = calls.filter((c) => c.sql.includes('FROM challenges c'));
  assert.equal(challengeQueries.length, 2, 'rows + totals');
  for (const q of challengeQueries) {
    assert.match(q.sql, /se\.internal = FALSE/);
    assert.match(q.sql, /c\.enabled = TRUE/);
    assert.match(q.sql, /c\.completed = FALSE/);
    assert.match(q.sql, /COALESCE\(c\.schedule_start, ct\.schedule_start/);
    assert.match(q.sql, /COALESCE\(c\.schedule_end, ct\.schedule_end/);
    assert.match(q.sql, /se\.season_id = \$2/);
  }
});

test('GET /api/home-panels: rows are capped and totals report the real count', async () => {
  const rows = Array.from({ length: 8 }, (_, i) => row({ id: i + 1, display_order: i + 1 }));
  const { app } = makeApp({ season: SEASON, rows }, { user: USER });
  const { body } = await get(app, '/api/home-panels');
  const panel = body.panels[0];
  assert.equal(panel.challenges.length, 4,
    'four 44px rows is what fits under the two-app-row height cap');
  assert.equal(panel.total, 8, 'so the client can say "See all 8 challenges"');
});

test('GET /api/home-panels: done/earned come from the viewer\'s own ledger rows', async () => {
  const rows = [
    row({ id: 1, my_activity_count: 0, my_points: 0 }),
    row({ id: 2, my_activity_count: 1, my_points: '250' }),
  ];
  const { app } = makeApp({ season: SEASON, rows }, { user: USER });
  const { body } = await get(app, '/api/home-panels');
  const panel = body.panels[0];
  assert.equal(panel.done, 1);
  const byId = new Map(panel.challenges.map((c) => [c.id, c]));
  assert.equal(byId.get(1).progress.done, false);
  assert.equal(byId.get(1).earned_points, 0);
  assert.equal(byId.get(2).progress.done, true);
  assert.equal(byId.get(2).earned_points, 250);
});

test('GET /api/home-panels: ordering is not-done-first, then featured, then display order', async () => {
  const { app, calls } = makeApp({ season: SEASON, rows: [row()] }, { user: USER });
  await get(app, '/api/home-panels');
  const rowQuery = calls.find((c) => c.sql.includes('FROM challenges c')
    && c.sql.includes('ORDER BY'));
  // The OUTER ORDER BY — the my_blocks subquery has one of its own.
  const order = rowQuery.sql.slice(rowQuery.sql.lastIndexOf('ORDER BY ('));
  // The sort keys, in order: done-ness (the CASE, not a bare row count —
  // see below), then featured, then the organiser's order.
  assert.match(order, /^ORDER BY \(\s*CASE/);
  assert.ok(order.indexOf('featured IS NOT TRUE') > order.indexOf('CASE'));
  assert.ok(order.indexOf('c.display_order ASC') > order.indexOf('featured IS NOT TRUE'));
  assert.ok(order.indexOf('c.id ASC') > order.indexOf('c.display_order ASC'));
});

test('the SQL done rule mirrors resolveProgress — "has a ledger row" is NOT done', async () => {
  const { app, calls } = makeApp({ season: SEASON, rows: [row()] }, { user: USER });
  await get(app, '/api/home-panels');
  const queries = calls.filter((c) => c.sql.includes('FROM challenges c'));
  assert.equal(queries.length, 2);
  for (const q of queries) {
    // A numeric challenge is done only at/over its target. Regression lock:
    // an earlier version keyed off "any activity row", which sorted a 3-of-8
    // row in with the finished ones and counted it as done.
    assert.match(q.sql, />= COALESCE\(c\.metric_target, ct\.metric_target\)/);
    // Binary (no metric) still means "any activity row".
    assert.match(q.sql, /WHEN COALESCE\(c\.metric_type, ct\.metric_type\) IS NULL/);
    // …and blocks come from the snapshot, not the ledger.
    assert.match(q.sql, /= 'blocks_produced' THEN COALESCE\(\(SELECT ls\.event_total_produced_blocks/);
  }
  // The totals COUNT uses the same expression, so "N of M done" and the
  // per-row chips cannot disagree.
  const totals = queries.find((q) => q.sql.includes('COUNT(*)::int AS total'));
  assert.match(totals.sql, /COUNT\(\*\) FILTER \(WHERE CASE/);
});

test('GET /api/home-panels: the query\'s done verdict wins over recomputation', async () => {
  // my_done is what the SQL decided; the payload must echo it rather than
  // re-deriving a different answer from the same row.
  const rows = [row({ id: 1, my_activity_count: 3, my_done: false,
    metric_type: 'count', metric_target: 8, metric_label: 'Apps tested' })];
  const { app } = makeApp({ season: SEASON, rows }, { user: USER });
  const { body } = await get(app, '/api/home-panels');
  const ch = body.panels[0].challenges[0];
  assert.equal(ch.progress.done, false, 'a 3-of-8 row is not done');
  assert.deepEqual(ch.progress, { done: false, current: 3, target: 8 });
});

test('GET /api/home-panels: a challenge whose template vanished is skipped, not fatal', async () => {
  const rows = [row({ id: 1 }), row({ id: 2, t_id: null })];
  const { app } = makeApp({ season: SEASON, rows }, { user: USER });
  const { status, body } = await get(app, '/api/home-panels');
  assert.equal(status, 200);
  assert.deepEqual(body.panels[0].challenges.map((c) => c.id), [1]);
});

test('GET /api/home-panels: points_remaining totals open rewards only when all are numeric', async () => {
  const numeric = [
    row({ id: 1, reward: '300 pts', my_activity_count: 0 }),
    row({ id: 2, reward: 'Up to 1,000 pts', my_activity_count: 0 }),
    // A done row does not count toward what's still on the table.
    row({ id: 3, reward: '500', my_activity_count: 1 }),
  ];
  const { app } = makeApp({ season: SEASON, rows: numeric }, { user: USER });
  const { body } = await get(app, '/api/home-panels');
  assert.equal(body.panels[0].points_remaining, 1300);

  const prose = [
    row({ id: 1, reward: '300 pts', my_activity_count: 0 }),
    row({ id: 2, reward: '½ of your final credits', my_activity_count: 0 }),
  ];
  const { app: app2 } = makeApp({ season: SEASON, rows: prose }, { user: USER });
  const { body: body2 } = await get(app2, '/api/home-panels');
  assert.equal(body2.panels[0].points_remaining, null,
    'one bit of prose withholds the whole figure');
});

test('GET /api/home-panels: points_remaining covers ALL open rows, not just the page', async () => {
  // Six open challenges, only four returned (the row cap). "pts left" has
  // to count all six — summing the page would understate it the moment a
  // fifth challenge opens, which is exactly the regression the cap invites.
  const allRows = Array.from({ length: 6 }, (_, i) =>
    row({ id: i + 1, reward: '100 pts', my_activity_count: 0 }));
  const { app } = makeApp(
    { season: SEASON, rows: allRows.slice(0, 4), allRows, total: 6 },
    { user: USER }
  );
  const { body } = await get(app, '/api/home-panels');
  const panel = body.panels[0];
  assert.equal(panel.challenges.length, 4, 'the page is capped');
  assert.equal(panel.total, 6);
  assert.equal(panel.points_remaining, 600,
    'six open rows at 100 each — not 400 from the four returned');
});

test('GET /api/home-panels: prose in an OFF-page open reward still withholds the total', async () => {
  // The prose row is beyond the cap, so a page-scoped sum would have
  // happily reported a number that ignores it.
  const allRows = [
    ...Array.from({ length: 4 }, (_, i) =>
      row({ id: i + 1, reward: '100 pts', my_activity_count: 0 })),
    row({ id: 5, reward: '½ of your final credits', my_activity_count: 0 }),
  ];
  const { app } = makeApp(
    { season: SEASON, rows: allRows.slice(0, 4), allRows, total: 5 },
    { user: USER }
  );
  const { body } = await get(app, '/api/home-panels');
  assert.equal(body.panels[0].points_remaining, null);
});

test('the totals query asks for the open rewards, and the row query is capped at 4', async () => {
  const { app, calls } = makeApp({ season: SEASON, rows: [row()] }, { user: USER });
  await get(app, '/api/home-panels');
  const totals = calls.find((c) => c.sql.includes('COUNT(*)::int AS total'));
  assert.match(totals.sql, /array_agg\(COALESCE\(c\.reward, ct\.reward\)\) FILTER \(WHERE NOT \(/,
    'open rewards come from the full-predicate query, not the page');
  const rowQuery = calls.find((c) => c.sql.includes('LIMIT $3'));
  // Four 40px rows is what fits the DESKTOP tile under --home-panel-max-h;
  // the footer reads "See all N" when total exceeds it. The phone shape draws
  // only two of them (#968) but the server still sends four: it has no idea
  // what viewport is asking, and sending the desktop budget is what lets a
  // window dragged across 640px repaint from cache with no refetch.
  assert.equal(rowQuery.params[2], 4);
  const route = read('src/routes/home-panels.js');
  assert.match(route, /const CHALLENGE_ROW_LIMIT = 4;/);
});

test('GET /api/home-panels: a hidden panel is dropped from panels but still described', async () => {
  const { app } = makeApp(
    { season: SEASON, rows: [row()], hidden: ['challenges'] },
    { user: USER }
  );
  const { body } = await get(app, '/api/home-panels');
  // Only the hidden one drops out; the rest still build.
  assert.deepEqual(body.panels.map((p) => p.key), ['discover', 'create']);
  assert.deepEqual(body.hidden, ['challenges']);
  assert.deepEqual(body.registry.map((r) => r.key), ['challenges', 'discover', 'create']);
});

test('GET /api/home-panels: unknown keys in the column are filtered out', async () => {
  const { app } = makeApp(
    { season: SEASON, rows: [row()], hidden: ['challenges', 'retired-panel'] },
    { user: USER }
  );
  const { body } = await get(app, '/api/home-panels');
  assert.deepEqual(body.hidden, ['challenges']);
});

test('GET /api/home-panels: ?demo=1 is a no-op outside staging', async () => {
  assert.notEqual(process.env.USERNODE_ENV, 'staging', 'test env sanity');
  const { app } = makeApp({ season: SEASON, rows: [row({ goal: 'Real goal' })] }, { user: USER });
  const { body } = await get(app, '/api/home-panels?demo=1');
  assert.equal(body.panels[0].challenges[0].goal, 'Real goal');
  assert.equal(body.panels[0].demo, undefined);
});

// The demo payload is what the before/after screenshots and the dapp.json
// check actually render (/?demo=1), so the states a reviewer is meant to
// compare have to survive the four-slot budget — not merely exist in the
// fixture and fall off the bottom.
test('GET ?demo=1 in staging spends its four slots on both kinds of DONE', async () => {
  const prev = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  let body;
  try {
    const { app } = makeApp({ season: SEASON, rows: [row()] }, { user: USER });
    ({ body } = await get(app, '/api/home-panels?demo=1'));
  } finally {
    process.env.USERNODE_ENV = prev;
  }
  const p = body.panels[0];
  assert.equal(p.demo, true);
  assert.equal(p.challenges.length, 4, 'the collapsed block draws four rows');

  // Not-done first (the client mirrors this order), then the two finished
  // ones ADJACENT: a ✓ with no bar, and a ✓ over a bar filled end to end.
  // Seeing the two kinds of "done" side by side is the point.
  const done = p.challenges.filter((c) => c.progress.done);
  assert.equal(done.length, 2);
  assert.deepEqual(p.challenges.map((c) => !!c.progress.done),
    [false, false, true, true], 'the done pair sits at the bottom, together');
  const binaryDone = done.find((c) => !c.metric);
  const numericDone = done.find((c) => c.metric);
  assert.ok(binaryDone, 'a finished BINARY challenge (✓, no bar)');
  assert.ok(numericDone, 'a finished NUMERIC challenge (✓ over a full bar)');
  assert.equal(numericDone.progress.current, numericDone.progress.target,
    'full target, or the bar is not full and the state is not the one being shown');

  // And a part-filled numeric is still up top, so "in progress" and
  // "finished" are both readable in one shot.
  const partial = p.challenges.find((c) => c.metric && !c.progress.done
    && c.progress.current > 0);
  assert.ok(partial, 'the part-filled bar keeps its slot');
  assert.equal(p.done, 2, 'the header counter agrees with the glyphs');
});

// ─── POST /api/home-panels/:key/visibility ────────────────────────────

test('POST visibility: 401 unauthenticated', async () => {
  const { app } = makeApp({ season: SEASON, rows: [] });
  const { status } = await post(app, '/api/home-panels/challenges/visibility', { hidden: true });
  assert.equal(status, 401);
});

test('POST visibility: unknown key -> 400', async () => {
  const { app } = makeApp({ season: SEASON, rows: [] }, { user: USER });
  const { status } = await post(app, '/api/home-panels/nope/visibility', { hidden: true });
  assert.equal(status, 400);
});

test('POST visibility: a non-boolean hidden -> 400', async () => {
  const { app } = makeApp({ season: SEASON, rows: [] }, { user: USER });
  for (const bad of [{ hidden: 'true' }, { hidden: 1 }, {}]) {
    const { status } = await post(app, '/api/home-panels/challenges/visibility', bad);
    assert.equal(status, 400, JSON.stringify(bad));
  }
});

test('POST visibility: hide then show round-trips, and hiding twice cannot duplicate', async () => {
  const { app, state } = makeApp({ season: SEASON, rows: [], hidden: [] }, { user: USER });
  let res = await post(app, '/api/home-panels/challenges/visibility', { hidden: true });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.hidden, ['challenges']);
  res = await post(app, '/api/home-panels/challenges/visibility', { hidden: true });
  assert.deepEqual(res.body.hidden, ['challenges'], 'array_remove-then-append, no dupes');
  res = await post(app, '/api/home-panels/challenges/visibility', { hidden: false });
  assert.deepEqual(res.body.hidden, []);
  assert.deepEqual(state.hidden, []);
});

// ─── Expand mode ──────────────────────────────────────────────────────

test('GET ?expand=challenges drops the not-completed/in-window filters', async () => {
  const { app, calls } = makeApp({ season: SEASON, rows: [row()] }, { user: USER });
  await get(app, '/api/home-panels?expand=challenges');
  const queries = calls.filter((c) => c.sql.includes('FROM challenges c'));
  for (const q of queries) {
    // Still scoped to the season's PUBLIC events and organiser-enabled…
    assert.match(q.sql, /se\.internal = FALSE/);
    assert.match(q.sql, /c\.enabled = TRUE/);
    // …but the two filters that define "open" are gone, which is how the
    // expanded list can show finished challenges and their ✓ marks.
    assert.doesNotMatch(q.sql, /c\.completed = FALSE/);
    assert.doesNotMatch(q.sql, /COALESCE\(c\.schedule_start/);
  }
  // And the row cap lifts.
  const rowQuery = calls.find((c) => c.sql.includes('LIMIT $3'));
  assert.equal(rowQuery.params[2], 40);
});

test('GET without expand keeps the strict open filter and the 4-row cap', async () => {
  const { app, calls } = makeApp({ season: SEASON, rows: [row()] }, { user: USER });
  const { body } = await get(app, '/api/home-panels');
  const queries = calls.filter((c) => c.sql.includes('FROM challenges c'));
  for (const q of queries) assert.match(q.sql, /c\.completed = FALSE/);
  assert.equal(calls.find((c) => c.sql.includes('LIMIT $3')).params[2], 4);
  assert.equal(body.panels[0].expanded, false);
});

test('GET ?expand names ONE panel — an unknown name expands nothing', async () => {
  const { app, calls } = makeApp({ season: SEASON, rows: [row()] }, { user: USER });
  const { body } = await get(app, '/api/home-panels?expand=not-a-panel');
  assert.equal(body.panels[0].expanded, false);
  for (const q of calls.filter((c) => c.sql.includes('FROM challenges c'))) {
    assert.match(q.sql, /c\.completed = FALSE/);
  }
});

// ─── Drag position ────────────────────────────────────────────────────

// The registry is what Settings renders its checkboxes from and what the
// grid places, so it has to describe EVERY widget — including the two
// marker widgets that build no payload at all.
test('the registry describes every widget, with its footprint and removability', async () => {
  const { app } = makeApp({ season: SEASON, rows: [row()] }, { user: USER });
  const { body } = await get(app, '/api/home-panels');
  const byKey = Object.fromEntries(body.registry.map((r) => [r.key, r]));
  assert.deepEqual(Object.keys(byKey), ['challenges', 'discover', 'create']);
  // Footprints are per column count and live server-side, so the layout
  // route's overlap check and the client lay out against the same numbers.
  // Challenges is asymmetric (#968): one row on a phone, where the widget is
  // full width and a two-row footprint reserved space its content-height
  // block never drew; its original two on desktop, where it is a tile among
  // app icons and the leftover goes to the leaderboard fill.
  assert.deepEqual(byKey.challenges.sizes, { 4: [4, 1], 5: [2, 2] });
  // Discover is asymmetric (#949): one row on a phone, where it is full
  // width and its content is a single lane; its original two on desktop,
  // where the second row carries the Popular lane.
  assert.deepEqual(byKey.discover.sizes, { 4: [4, 1], 5: [2, 2] });
  // Create app takes a whole phone row (4 wide, 1 tall) and one desktop cell.
  assert.deepEqual(byKey.create.sizes, { 4: [4, 1], 5: [1, 1] });
  // Discover is the shell's only door to the app directory.
  assert.equal(byKey.discover.removable, false);
  assert.equal(byKey.challenges.removable, true);
  assert.equal(byKey.create.removable, true);
  // Placement is no longer this route's business.
  assert.equal(body.positions, undefined);
});

test('POST …/visibility refuses to hide a non-removable widget', async () => {
  const { app, state } = makeApp({ season: SEASON, rows: [], hidden: [] }, { user: USER });
  const res = await post(app, '/api/home-panels/discover/visibility', { hidden: true });
  assert.equal(res.status, 400);
  assert.deepEqual(state.hidden, [], 'nothing was written');
  // Un-hiding it is harmless and still allowed (it is already visible).
  const show = await post(app, '/api/home-panels/discover/visibility', { hidden: false });
  assert.equal(show.status, 200);
});

// The create widget is on every home screen regardless of app quota, so
// hiding it must be equally available to everyone — the route must not
// consult canCreateApps or app_quota on any path.
test('the create widget hides for any account, quota or not', async () => {
  const { app, state } = makeApp({ season: SEASON, rows: [], hidden: [] }, { user: USER });
  const res = await post(app, '/api/home-panels/create/visibility', { hidden: true });
  assert.equal(res.status, 200);
  assert.deepEqual(state.hidden, ['create']);
  const route = read('src/routes/home-panels.js');
  assert.doesNotMatch(route.replace(/^\s*\/\/.*$/gm, ''), /canCreateApps|app_quota/,
    'no quota check anywhere in the registry or its routes');
});

// The placement endpoint is gone: a widget's home is a real (column, row)
// cell now, written for the whole grid at once by PUT /api/home-layout.
test('the card-count position endpoint is retired', async () => {
  const { app } = makeApp({ season: SEASON, rows: [] }, { user: USER });
  const res = await post(app, '/api/home-panels/challenges/position', { index: 4 });
  assert.equal(res.status, 404);
  const route = read('src/routes/home-panels.js');
  assert.doesNotMatch(route, /router\.post\('\/api\/home-panels\/:key\/position'/);
  assert.doesNotMatch(route, /MAX_PANEL_POSITION =/);
  // The column survives (this schema file is append-only) but nothing reads
  // it — a stale reader would silently resurrect the old placement model.
  const schema = read('src/db/schema.sql');
  assert.match(schema, /home_panel_positions JSONB NOT NULL DEFAULT '\{\}'/);
  assert.match(schema, /RETIRED — superseded by the `user_home_layout` table/);
  // Matched against code, not comments — the one remaining mention is the
  // note in readPrefs explaining why it is gone.
  assert.doesNotMatch(route.replace(/^\s*\/\/.*$/gm, ''), /home_panel_positions/);
});

// ─── Source pins ──────────────────────────────────────────────────────

test('schema declares users.home_panels_hidden, defaulting to visible-for-all', () => {
  const schema = read('src/db/schema.sql');
  assert.match(
    schema,
    /ALTER TABLE users ADD COLUMN IF NOT EXISTS home_panels_hidden TEXT\[\] NOT NULL DEFAULT '\{\}'/,
    'absence of a key must mean visible, so the default is an empty array'
  );
});

test('the route is mounted in server.js', () => {
  const server = read('server.js');
  assert.match(server, /require\('\.\/src\/routes\/home-panels'\)/);
  assert.match(server, /app\.use\(homePanelRoutes\(config\)\)/);
});

test('the visibility write is rate limited per user', () => {
  const limits = read('src/middleware/rate-limits.js');
  assert.match(limits, /homePanelPrefLimiter = makeLimiter\(\{[\s\S]*?keyByUser: true/);
  assert.match(limits, /module\.exports = \{[^}]*homePanelPrefLimiter/);
  const route = read('src/routes/home-panels.js');
  assert.match(route, /visibility', homePanelPrefLimiter/);
});

test('staging seeds open challenges covering every card state', () => {
  const migrate = read('src/db/migrate.js');
  // Four open (enabled, not completed, in-window) challenges…
  for (const id of [900510, 900511, 900512, 900513]) {
    assert.ok(migrate.includes(`(${id}, $1,`), `challenge ${id} seeded`);
  }
  // …two numeric templates behind them…
  assert.match(migrate, /\(900505, 'onchain'[\s\S]*?'count', 8, 'Apps tested'/);
  assert.match(migrate, /\(900506, 'social'[\s\S]*?'count', 5, 'Kudos'/);
  // …and viewer progress: one binary completion + three numeric units.
  assert.match(migrate, /\$\{base \+ 2\}, \$1, \$2, 'challenge_completion', 50/);
  assert.match(migrate, /\$\{base \+ 5\}[\s\S]*?900512/);
});

// ── The desktop LEADERBOARD fill ─────────────────────────────────────
//
// At five columns the widget is a fixed-height tile, so whatever the
// challenge rows don't use is dead space. The panel therefore carries a
// `leaderboard` block whenever the collapsed list leaves room; the client
// decides how many of its rows fit (and draws none at all on a phone, where
// the block shrinks instead).
//
// The PRIMARY board is the Topochain standings — the same board the
// Leaderboard screen's primary tab shows, so the widget and the screen can
// never disagree about who is #1. The kudos board is the FALLBACK, for a
// deployment with no public standings at all, and it says so (`kind`).

// A ranked-users row as src/services/leaderboard-users.js returns it.
const lbUser = (username, score) => ({
  user_id: username.length, username, kudos_received_prs_merged: score,
});

const FILL_USERS = [
  lbUser('ada', 41), lbUser('grace', 27), lbUser('linus', 18),
  lbUser('kay', 9), lbUser('viewer', 6), lbUser('nobody', 0),
];

// The resolved event, and a stored-snapshot row as EVENT_LEADERBOARD_SQL
// returns it (only the columns the board actually reads).
const EVENT = { id: 77, name: 'Block Production Sprint', season_id: 5, type: 'regular' };
const tcRow = (over = {}) => ({
  user_id: 1, rank: 1, total_points: '100', exclude_podium: false,
  email: null, telegram: null, discord: null, display_name: null, ...over,
});

// Points are NUMERIC in Postgres, so they arrive as strings — and as
// decimals in production (59145.66). The board rounds them.
const STANDINGS = [
  tcRow({ user_id: 11, rank: 1, total_points: '59145.66', discord: 'validator' }),
  tcRow({ user_id: 12, rank: 2, total_points: '41230.10', display_name: 'Grace' }),
  tcRow({ user_id: 13, rank: 3, total_points: '27515', email: 'linus@example.invalid' }),
  tcRow({ user_id: 7, rank: 9, total_points: '6480', discord: 'me' }),
];

test('the fill is the Topochain standings when a public event has them', async () => {
  const { app } = makeApp({
    season: SEASON, rows: [row(), row({ id: 2 })],
    event: EVENT, standings: STANDINGS, fillUsers: FILL_USERS,
  }, { user: USER });
  const { body } = await get(app, '/api/home-panels');
  const panel = body.panels.find((p) => p.key === 'challenges');
  assert.equal(panel.challenges.length, 2);
  const lb = panel.leaderboard;
  assert.ok(lb, 'two challenges leave two slots to fill');
  assert.equal(lb.kind, 'topochain', 'the standings board, not the kudos one');
  assert.equal(lb.label, 'Leaderboard', 'and it is simply called that');
  assert.deepEqual(lb.event, { id: 77, name: 'Block Production Sprint' });
  // Names come from the SAME chain the standings table uses — discord,
  // then display_name, then the masked identifier — so the widget can never
  // unmask a row the screen masks.
  assert.deepEqual(lb.top, [
    { rank: 1, name: 'validator', score: 59146, you: false },
    { rank: 2, name: 'Grace', score: 41230, you: false },
    { rank: 3, name: 'lin***@***.invalid', score: 27515, you: false },
  ]);
  assert.equal(lb.total, 4);
});

// USER is { id: 7, … }: the platform users.id IS the topochain users.id, so
// the viewer's own row needs no wallet and no username match.
test('the viewer is matched by user_id, and flagged rather than name-matched', async () => {
  const { app } = makeApp({
    season: SEASON, rows: [row()], event: EVENT, standings: STANDINGS,
  }, { user: USER });
  const { body } = await get(app, '/api/home-panels');
  const lb = body.panels.find((p) => p.key === 'challenges').leaderboard;
  assert.deepEqual(lb.viewer, { rank: 9, name: 'me', score: 6480, you: true });
  assert.ok(lb.top.every((r) => r.you === false), 'nobody in the top slice is them');
});

test('a viewer inside the top slice is flagged there instead of repeated', async () => {
  const { app } = makeApp({
    season: SEASON, rows: [row()], event: EVENT, standings: STANDINGS,
  }, { user: { id: 12, username: 'grace' } });
  const { body } = await get(app, '/api/home-panels');
  const lb = body.panels.find((p) => p.key === 'challenges').leaderboard;
  assert.deepEqual(lb.top.map((r) => r.you), [false, true, false]);
  assert.equal(lb.viewer.you, true);
});

// Most platform accounts have no standings at all (they are earned by
// participating in an event, not by having an account). That is NOT a reason
// to serve them a different board — the slot just goes to one more
// participant, which the client renders as a full top slice.
test('a viewer with no standings row gets a full top slice and no "you" line', async () => {
  const { app } = makeApp({
    season: SEASON, rows: [row()], event: EVENT, standings: STANDINGS,
    fillUsers: FILL_USERS,
  }, { user: { id: 9999, username: 'ghost' } });
  const { body } = await get(app, '/api/home-panels');
  const lb = body.panels.find((p) => p.key === 'challenges').leaderboard;
  assert.equal(lb.kind, 'topochain', 'still the standings — no per-viewer fallback');
  assert.equal(lb.viewer, null);
  assert.equal(lb.top.length, 3);
});

// exclude_podium rows are excluded from podium RANKING by definition, so
// they can't take one of three podium slots — but the viewer still sees
// their own line, rank-less (the screen's table draws those as "—").
test('podium-excluded rows never take a top slot, but are still your row', async () => {
  const excluded = [
    tcRow({ user_id: 5, rank: 1, total_points: '99999', discord: 'houseAccount', exclude_podium: true }),
    ...STANDINGS,
  ];
  const { app } = makeApp({
    season: SEASON, rows: [row()], event: EVENT, standings: excluded,
  }, { user: { id: 5, username: 'house' } });
  const { body } = await get(app, '/api/home-panels');
  const lb = body.panels.find((p) => p.key === 'challenges').leaderboard;
  assert.deepEqual(lb.top.map((r) => r.name), ['validator', 'Grace', 'lin***@***.invalid']);
  assert.deepEqual(lb.viewer, { rank: null, name: 'houseAccount', score: 99999, you: true });
});

// Production's newest public event with standings is a type='season' one,
// whose rows come from the shared §4.10 aggregate rather than from stored
// per-event snapshots. A board that only read snapshots would be EMPTY in
// production while the screen beside it is full.
test('a season-type event is served by the shared standings aggregate', async () => {
  const { app, calls } = makeApp({
    season: SEASON, rows: [row()],
    event: { id: 7, name: 'Season 1', season_id: 1, type: 'season' },
    seasonStandings: [
      { user_id: 11, total_points: '5000', extra_points: '0', events_participated: 2,
        total_produced_blocks: 10, total_produced_blocks_last_event: 4,
        is_non_podium: false, email: null, telegram: null, discord: 'first', display_name: null },
      { user_id: 12, total_points: '2500', extra_points: '0', events_participated: 1,
        total_produced_blocks: 5, total_produced_blocks_last_event: 5,
        is_non_podium: false, email: null, telegram: null, discord: 'second', display_name: null },
    ],
  }, { user: USER });
  const { body } = await get(app, '/api/home-panels');
  const lb = body.panels.find((p) => p.key === 'challenges').leaderboard;
  assert.equal(lb.kind, 'topochain');
  assert.deepEqual(lb.top.map((r) => [r.rank, r.name, r.score]),
    [[1, 'first', 5000], [2, 'second', 2500]]);
  assert.ok(!calls.some((c) => c.sql.includes('DISTINCT ON (ls.user_id) ls.*')),
    'the per-event snapshot query is not even attempted for this type');
});

// #999 made the season-type event the DEFAULT board, so the podium-skip is
// now exercised on the path production actually serves — not just on the
// per-event one. A podium-excluded row leading on POINTS must be dropped
// from `top` (it is excluded from podium ranking by definition) while still
// resolving through `byUserId`, so an excluded viewer sees their own
// rank-less line. Same contract as the per-event test above; different path.
test('the season board skips a podium-excluded leader in its podium rows', async () => {
  const { app } = makeApp({
    season: SEASON, rows: [row()],
    event: { id: 7, name: 'Season 1', season_id: 1, type: 'season' },
    seasonStandings: [
      // Leads on points, excluded from the podium — assignSharedRanks gives
      // it the CURRENT counter value without consuming the slot, so the next
      // real user is still rank 1.
      { user_id: 90, total_points: '9999', extra_points: '0', events_participated: 3,
        total_produced_blocks: 20, total_produced_blocks_last_event: 8,
        is_non_podium: true, email: null, telegram: null, discord: 'houseAccount', display_name: null },
      { user_id: 11, total_points: '5000', extra_points: '0', events_participated: 2,
        total_produced_blocks: 10, total_produced_blocks_last_event: 4,
        is_non_podium: false, email: null, telegram: null, discord: 'first', display_name: null },
      { user_id: 12, total_points: '2500', extra_points: '0', events_participated: 1,
        total_produced_blocks: 5, total_produced_blocks_last_event: 5,
        is_non_podium: false, email: null, telegram: null, discord: 'second', display_name: null },
    ],
  }, { user: { id: 90, username: 'houseAccount' } });
  const { body } = await get(app, '/api/home-panels');
  const lb = body.panels.find((p) => p.key === 'challenges').leaderboard;
  assert.deepEqual(lb.top.map((r) => [r.rank, r.name]), [[1, 'first'], [2, 'second']],
    'the excluded leader must not occupy a podium row');
  assert.deepEqual(lb.viewer, { rank: null, name: 'houseAccount', score: 9999, you: true },
    'but the excluded viewer still sees their own rank-less line');
});

test('the fill is omitted when the tile is full, and when expanded', async () => {
  // Four challenges fill the row budget: nothing left to fill.
  const four = [row(), row({ id: 2 }), row({ id: 3 }), row({ id: 4 })];
  const full = makeApp({ season: SEASON, rows: four, event: EVENT, standings: STANDINGS },
    { user: USER });
  const { body: fullBody } = await get(full.app, '/api/home-panels');
  assert.equal(fullBody.panels.find((p) => p.key === 'challenges').leaderboard, undefined);

  // Expanded is all challenges — the fill steps aside.
  const exp = makeApp({ season: SEASON, rows: [row()], event: EVENT, standings: STANDINGS },
    { user: USER });
  const { body: expBody } = await get(exp.app, '/api/home-panels?expand=challenges');
  assert.equal(expBody.panels.find((p) => p.key === 'challenges').leaderboard, undefined);
});

test('between seasons the panel is empty AND carries the fill', async () => {
  const { app } = makeApp({ season: null, rows: [], event: EVENT, standings: STANDINGS },
    { user: USER });
  const { body } = await get(app, '/api/home-panels');
  const panel = body.panels.find((p) => p.key === 'challenges');
  assert.equal(panel.total, 0);
  assert.deepEqual(panel.challenges, []);
  // This is the state production is in right now, and the one the desktop
  // tile has the most space to fill. Note the standings outlive the season:
  // the event resolution deliberately falls back to the most recent event
  // that HAS standings, exactly as the Leaderboard screen does.
  assert.equal(panel.leaderboard.kind, 'topochain');
  assert.equal(panel.leaderboard.top.length, 3);
  assert.equal(panel.leaderboard.viewer.name, 'me');
});

// ── The kudos FALLBACK board ──────────────────────────────────────────

test('no public standings at all falls back to the kudos board, labelled as such', async () => {
  const { app } = makeApp({
    season: SEASON, rows: [row()], event: null, fillUsers: FILL_USERS,
  }, { user: USER });
  const { body } = await get(app, '/api/home-panels');
  const lb = body.panels.find((p) => p.key === 'challenges').leaderboard;
  assert.equal(lb.kind, 'kudos');
  assert.equal(lb.label, 'Kudos', 'it must not call itself the Leaderboard');
  assert.equal(lb.event, null);
  assert.deepEqual(lb.top, [
    { rank: 1, name: 'ada', score: 41, you: false },
    { rank: 2, name: 'grace', score: 27, you: false },
    { rank: 3, name: 'linus', score: 18, you: false },
  ]);
  assert.deepEqual(lb.viewer, { rank: 5, name: 'viewer', score: 6, you: true });
  assert.equal(lb.total, 6);
});

test('an event with no rows falls back too', async () => {
  const { app } = makeApp({
    season: SEASON, rows: [row()], event: EVENT, standings: [], fillUsers: FILL_USERS,
  }, { user: USER });
  const { body } = await get(app, '/api/home-panels');
  assert.equal(body.panels.find((p) => p.key === 'challenges').leaderboard.kind, 'kudos');
});

test('kudos username matching is case-insensitive', async () => {
  const { app } = makeApp({
    season: SEASON, rows: [row()], event: null,
    fillUsers: [lbUser('ada', 41), lbUser('Viewer', 3)],
  }, { user: USER });
  const { body } = await get(app, '/api/home-panels');
  const lb = body.panels.find((p) => p.key === 'challenges').leaderboard;
  assert.deepEqual(lb.viewer, { rank: 2, name: 'Viewer', score: 3, you: true });
});

// The panel must survive a broken board: the widget's whole job is to sit
// quietly on the home screen, and one flaky aggregate must not cost the
// viewer their challenges (the same rule the route already applies per-panel).
test('a failing standings read degrades to the kudos board, not to nothing', async () => {
  const { app } = makeApp({
    season: SEASON, rows: [row()], event: EVENT, standingsThrows: true,
    fillUsers: FILL_USERS,
  }, { user: USER });
  const { body } = await get(app, '/api/home-panels');
  const panel = body.panels.find((p) => p.key === 'challenges');
  assert.equal(panel.leaderboard.kind, 'kudos', 'the other board still works');
  assert.equal(panel.challenges.length, 1, 'the challenges still render');
});

test('both boards failing omits the fill and keeps the challenges', async () => {
  const { app } = makeApp({
    season: SEASON, rows: [row()], eventThrows: true, fillThrows: true,
  }, { user: USER });
  const { body } = await get(app, '/api/home-panels');
  const panel = body.panels.find((p) => p.key === 'challenges');
  assert.equal(panel.leaderboard, undefined);
  assert.equal(panel.challenges.length, 1, 'the challenges still render');
});

test('an empty board attaches nothing rather than an empty block', async () => {
  const { app } = makeApp({ season: SEASON, rows: [row()], event: null, fillUsers: [] },
    { user: USER });
  const { body } = await get(app, '/api/home-panels');
  assert.equal(body.panels.find((p) => p.key === 'challenges').leaderboard, undefined);
});

// Both boards are queried ONCE per TTL, not once per home-screen paint: each
// is identical for every viewer, and only "which row is me" is per-request.
test('the standings board is memoised across requests', async () => {
  const { app, calls } = makeApp({
    season: SEASON, rows: [row()], event: EVENT, standings: STANDINGS,
  }, { user: USER });
  await get(app, '/api/home-panels');
  await get(app, '/api/home-panels');
  const reads = calls.filter((c) => c.sql.includes('DISTINCT ON (ls.user_id) ls.*'));
  assert.equal(reads.length, 1, 'second request served from the memo');
});

test('the ranked list is memoised across requests', async () => {
  const { app, calls } = makeApp({
    season: SEASON, rows: [row()], event: null, fillUsers: FILL_USERS,
  }, { user: USER });
  await get(app, '/api/home-panels');
  await get(app, '/api/home-panels');
  const ranked = calls.filter((c) => c.sql.includes('kudos_received_prs_merged'));
  assert.equal(ranked.length, 1, 'second request served from the memo');
  // And it asks for the SLIM projection — the three display-only LATERALs
  // are not in the ORDER BY, so the widget shouldn't pay for them.
  assert.ok(!ranked[0].sql.includes('active_apps'), 'no active_apps LATERAL');
  assert.ok(!ranked[0].sql.includes('issues_created'), 'no issues LATERAL');
  assert.ok(!ranked[0].sql.includes('kudos_given'), 'no kudos_given LATERAL');
});

// ── Staging demo variants (#947) ──────────────────────────────────────
//
// ?demo=1&challenges=few|none reach the SHORT-LIST states, which a staging
// clone can't otherwise show while its seeded season is live. Both are what
// the dapp.json checks and the before/after screenshots navigate to.

test('demoChallengesPanel: the few / none variants and their demo fill', () => {
  const { demoChallengesPanel } = require('../src/routes/home-panels');

  const few = demoChallengesPanel({ variant: 'few', username: 'tester' });
  assert.equal(few.challenges.length, 2, 'two rows: the shrink state');
  assert.equal(few.total, 2, 'nothing past the cap to "see all" of');
  // One metered and one binary, so the progress-bar lane is still exercised.
  assert.ok(few.challenges.some((c) => c.metric), 'a metered row');
  assert.ok(few.challenges.some((c) => !c.metric), 'a binary row');
  assert.equal(few.leaderboard.top.length, 3);
  assert.equal(few.leaderboard.kind, 'topochain', 'the demo shows the primary board');
  assert.equal(few.leaderboard.viewer.name, 'tester', 'the viewer is whoever is signed in');

  const none = demoChallengesPanel({ variant: 'none', username: 'tester' });
  assert.equal(none.total, 0);
  assert.deepEqual(none.challenges, []);
  assert.equal(none.season, null);
  assert.equal(none.leaderboard.top[0].name, 'staging-demo-validator', 'obviously fake');
  assert.equal(none.leaderboard.kind, 'topochain');
  assert.match(none.leaderboard.event.name, /^Staging Demo Event/, 'named like the real one');

  // ?board=kudos reaches the FALLBACK board — the one a seeded staging clone
  // (which HAS standings) can never otherwise show, and which the
  // before/after screenshots therefore have no other way to capture.
  const kudos = demoChallengesPanel({ variant: 'none', board: 'kudos', username: 'tester' });
  assert.equal(kudos.leaderboard.kind, 'kudos');
  assert.equal(kudos.leaderboard.label, 'Kudos');
  assert.equal(kudos.leaderboard.event, null);
  assert.equal(kudos.leaderboard.viewer.name, 'tester');

  // No variant → byte-for-byte the payload that shipped before, with no fill
  // (four rows leave no room), so the existing ?demo=1 check is untouched.
  const base = demoChallengesPanel({});
  assert.equal(base.challenges.length, 4);
  assert.equal(base.total, 7);
  assert.equal(base.leaderboard, undefined);

  // An unknown value falls through to that default rather than erroring.
  assert.equal(demoChallengesPanel({ variant: 'wat' }).challenges.length, 4);
});

test('the demo variants are staging-only, like ?demo=1 itself', async () => {
  // USERNODE_ENV is not 'staging' in the test process, so the query param
  // must be inert: the real builder runs and the season fixture wins.
  const { app } = makeApp({ season: null, rows: [], fillUsers: FILL_USERS },
    { user: USER });
  const { body } = await get(app, '/api/home-panels?demo=1&challenges=few');
  const panel = body.panels.find((p) => p.key === 'challenges');
  assert.equal(panel.demo, undefined, 'no demo payload outside staging');
  assert.deepEqual(panel.challenges, []);
  // The demo fill's obviously-fake names must never reach a real response.
  assert.notEqual(panel.leaderboard.top[0].name, 'staging-demo-validator');
  assert.notEqual(panel.leaderboard.top[0].name, 'staging-demo-lead');
});

// Declared checks used to be a capped resource — the reader kept only the
// first MAX_TESTS entries, so position decided whether a check ever ran and
// each new one cost an older one its slot. #1019 runs every declared check,
// so the assertion here is the one that still bites: the reader KEEPS this
// entry (malformed ones are dropped silently) and the manifest hasn't grown
// past MAX_DECLARED_TESTS and started shedding its tail again.
test('dapp.json checks the new state, and the reader keeps it', () => {
  const appManifest = require('../src/services/app-manifest');
  const meta = appManifest.readTestsWithMeta(
    JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dapp.json'), 'utf8'))
  );
  assert.equal(meta.ceilingDropped, 0,
    `dapp.json declares more than ${appManifest.MAX_DECLARED_TESTS} valid checks — `
    + 'checks past the ceiling never run');
  const kept = meta.tests;
  const none = kept.find((t) => t.path === '/?demo=1&challenges=none');
  assert.ok(none, 'the no-challenges check must survive the manifest reader');
  // The checks run at the desktop frame, so it asserts the FILLED tile.
  assert.match(none.expectSelector, /data-rows="0"/);
  assert.match(none.expectSelector, /data-fill="3"/);
  assert.match(none.expectSelector, /home-panel-lb-row/);
  // The copy is identical at both breakpoints, so this holds whatever
  // viewport the checker uses.
  assert.equal(none.expectText, 'No challenges are running right now');

  // The #911 check must keep running unchanged: four challenges leave no room
  // to fill, so that payload's markup is untouched by this change.
  assert.ok(kept.some((t) => t.path === '/?demo=1' && /home-panel-bar-fill/.test(t.expectSelector)),
    'the existing challenges-widget check still runs');
});
