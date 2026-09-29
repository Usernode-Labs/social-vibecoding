// GET /api/v4/season-history and the History segment it feeds — the
// navigation prototype's Challenges page, fourth segment: past seasons, who
// won each, who won each of its events, and where the viewer finished.
//
// Server half: src/services/topochain/season-history.js (the rules and the
// cache) and the route in src/routes/topochain/public.js. Client half:
// frontend/src/features/leaderboard/history.js (the words) and
// history-pane.tsx (the markup).
//
// Run with: node --test tests/season-history.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const collapse = (sql) => sql.replace(/\s+/g, ' ').trim();
const history = require('../src/services/topochain/season-history');

const standing = (userId, rank, points, extra = {}) => ({
  user_id: userId, rank, total_points: points, is_non_podium: false,
  email: null, telegram: null, discord: null, display_name: null, username: `u${userId}`, ...extra,
});

// ─── The rules ──────────────────────────────────────────────────────────

test('a season lists its winner, every event winner in order, and each finisher', () => {
  const base = history.assembleHistory({
    seasons: [{ id: '2', name: 'Season 2', starts_at: '2026-05-01T00:00:00Z', ends_at: '2026-06-30T00:00:00Z' }],
    events: [
      { id: 22, name: 'Epoch 1', season_id: 2, ends_at: '2026-05-19T00:00:00Z' },
      { id: 23, name: 'Epoch 2', season_id: 2, ends_at: '2026-06-09T00:00:00Z' },
    ],
    eventWinners: [
      { season_event_id: 23, user_id: 4, total_points: '1040.40', display_name: 'Lee' },
      { season_event_id: 22, user_id: 3, total_points: 980, display_name: 'Maya' },
    ],
    standingsBySeason: new Map([[2, [standing(4, 1, 3100.2, { display_name: 'Lee' }), standing(7, 2, 1520)]]]),
  });
  assert.equal(base.seasons.length, 1);
  const [season] = base.seasons;
  assert.equal(season.name, 'Season 2');
  assert.deepEqual(season.winner, { name: 'Lee', points: 3100 });
  assert.equal(season.participants, 2);
  assert.deepEqual(season.events.map((e) => [e.name, e.winner && e.winner.name]),
    [['Epoch 1', 'Maya'], ['Epoch 2', 'Lee']], 'events keep their own order; winners are matched by id');
  assert.deepEqual(history.forViewer(base, 7)[0].you, { rank: 2, points: 1520 });
  assert.equal(history.forViewer(base, 99)[0].you, null, 'did not take part');
  assert.equal(history.forViewer(base, null)[0].you, null, 'signed out');
});

test('podium-excluded accounts never win, and finish without a rank', () => {
  const base = history.assembleHistory({
    seasons: [{ id: 1, name: 'S1' }],
    events: [],
    eventWinners: [],
    standingsBySeason: new Map([[1, [
      standing(9, 1, 5000, { is_non_podium: true, display_name: 'Staff' }),
      standing(3, 1, 2700, { display_name: 'Maya' }),
    ]]]),
  });
  assert.deepEqual(base.seasons[0].winner, { name: 'Maya', points: 2700 });
  assert.deepEqual(history.forViewer(base, 9)[0].you, { rank: null, points: 5000 });
});

test('a season with nobody on its board and no event decided is left out', () => {
  const base = history.assembleHistory({
    seasons: [{ id: 5, name: 'Pre Season 2' }],
    events: [{ id: 50, name: 'Week 1', season_id: 5 }],
    eventWinners: [],
    standingsBySeason: new Map([[5, []]]),
  });
  assert.deepEqual(base.seasons, []);
});

test('the reads are public-scoped, ended-only, bounded and indexed', () => {
  assert.match(collapse(history.PAST_SEASONS_SQL), /WHERE s\.internal = FALSE AND s\.ends_at < NOW\(\) ORDER BY s\.ends_at DESC, s\.id DESC LIMIT \$1/);
  const events = collapse(history.PAST_EVENTS_SQL);
  for (const rule of ['se.internal = FALSE', 'se.display_leaderboard = TRUE', "se.type = 'regular'", 'se.ends_at < NOW()']) {
    assert.ok(events.includes(rule), rule);
  }
  const winners = collapse(history.EVENT_WINNERS_SQL);
  assert.match(winners, /WHERE ls\.season_event_id = ANY\(\$1::bigint\[\]\)/, 'one statement for every event');
  assert.match(winners, /u\.exclude_podium IS NOT TRUE/);
  assert.equal(history.HISTORY_SEASON_LIMIT, 6);
});

test('the viewer-independent build is cached, and concurrent misses share it', async () => {
  history.resetSeasonHistoryCache();
  let reads = 0;
  const pool = {
    async query(raw) {
      reads += 1;
      const sql = collapse(raw);
      if (sql.includes('FROM seasons s')) return { rows: [{ id: 1, name: 'S1', ends_at: '2026-03-31T00:00:00Z' }] };
      if (sql.includes('FROM season_events se WHERE se.season_id')) return { rows: [] };
      if (sql.includes('FROM leaderboard_snapshots ls JOIN season_events se')) {
        return { rows: [{ user_id: 3, total_points: 10, events_participated: 1, is_non_podium: false, username: 'maya' }] };
      }
      throw new Error(`unexpected: ${sql.slice(0, 60)}`);
    },
  };
  const [a, b] = await Promise.all([
    history.seasonHistory(pool, { viewerId: 3 }),
    history.seasonHistory(pool, { viewerId: 4 }),
  ]);
  const afterFirst = reads;
  await history.seasonHistory(pool, { viewerId: 3 });
  assert.equal(reads, afterFirst, 'a second viewer inside the TTL costs no query');
  assert.deepEqual(a[0].you, { rank: 1, points: 10 });
  assert.equal(b[0].you, null);
  await history.seasonHistory(pool, { viewerId: 3, now: Date.now() + history.HISTORY_TTL_MS + 1 });
  assert.ok(reads > afterFirst, 'and it is rebuilt once the TTL has passed');
  history.resetSeasonHistoryCache();
});

// ─── The route ──────────────────────────────────────────────────────────

function appWith(pool, env) {
  const poolModule = require('../src/db/pool');
  const original = poolModule.getPool;
  const originalEnv = process.env.USERNODE_ENV;
  poolModule.getPool = () => pool;
  if (env) process.env.USERNODE_ENV = env;
  let routes;
  try {
    delete require.cache[require.resolve('../src/routes/topochain/public')];
    routes = require('../src/routes/topochain/public').topochainPublicRoutes({});
  } finally {
    poolModule.getPool = original;
    if (originalEnv === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = originalEnv;
    delete require.cache[require.resolve('../src/routes/topochain/public')];
  }
  const app = express();
  app.use(routes);
  return app;
}

async function get(app, url) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`);
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    server.close();
  }
}

const EMPTY_POOL = { async query() { return { rows: [] }; } };

test('the route answers the v4 envelope, and stays public (no 401 signed out)', async () => {
  history.resetSeasonHistoryCache();
  const { status, body } = await get(appWith(EMPTY_POOL), '/api/v4/season-history');
  assert.equal(status, 200);
  assert.deepEqual(body, { success: true, data: { seasons: [] } });
  history.resetSeasonHistoryCache();
});

test('?demo=1 fills a staging preview only when no season has ended', async () => {
  history.resetSeasonHistoryCache();
  const off = await get(appWith(EMPTY_POOL, 'production'), '/api/v4/season-history?demo=1');
  assert.deepEqual(off.body.data.seasons, [], 'inert outside staging');
  history.resetSeasonHistoryCache();
  const on = await get(appWith(EMPTY_POOL, 'staging'), '/api/v4/season-history?demo=1');
  assert.equal(on.body.demo, true);
  assert.equal(on.body.data.seasons.length, 2);
  assert.ok(on.body.data.seasons.every((s) => /Staging demo/.test(s.name)), 'labelled as the fixture it is');
  history.resetSeasonHistoryCache();
  const source = read('src/routes/topochain/public.js');
  assert.match(source, /IS_STAGING && req\.query\.demo === '1' && !seasons\.length/, 'REAL DATA WINS');
});

// ─── The client: the words and the markup ───────────────────────────────

const SEASONS = [{
  season_id: 2, name: 'Season 2', ends_at: '2026-06-30T23:59:00Z', participants: 14,
  winner: { name: 'lee', points: 3100 }, you: { rank: 4, points: 1520 },
  events: [{ id: 22, name: 'Epoch 1', winner: { name: 'maya', points: 980 } }, { id: 23, name: 'Epoch 2', winner: null }],
}];

test('the view says it the prototype\'s way, with honest variants', async () => {
  const { historyView, resultLine, endedLabel } = loadTsx('frontend/src/features/leaderboard/history.js');
  assert.equal(resultLine(SEASONS[0]), 'lee won with 3,100 pts · you finished #4');
  assert.equal(resultLine({ ...SEASONS[0], you: { rank: null, points: 1 } }), 'lee won with 3,100 pts · you took part');
  assert.equal(resultLine({ ...SEASONS[0], winner: null, you: null }), 'No winner was recorded');
  const now = new Date('2026-09-23T00:00:00Z');
  assert.match(endedLabel('2026-06-30T12:00:00Z', now), /^ended June$/);
  assert.match(endedLabel('2025-06-30T12:00:00Z', now), /^ended June 2025$/, 'the year once it is not this one');
  assert.deepEqual(historyView({ mounted: false }), { kind: 'none' }, 'the prerender draws nothing');
  assert.equal(historyView({ mounted: true, status: 'loading', seasons: [] }).kind, 'loading');
  assert.equal(historyView({ mounted: true, status: 'ready', seasons: [] }).kind, 'empty');
  const view = historyView({ mounted: true, status: 'ready', seasons: SEASONS }, now);
  assert.deepEqual(view.seasons[0].events.map((e) => e.label), ['Epoch 1 · maya', 'Epoch 2 · no winner']);
  assert.equal(view.seasons[0].winnerInitial, 'L');
});

test('the pane renders a card per season, and nothing before it is opened', () => {
  const state = { mounted: true, status: 'ready', seasons: SEASONS };
  const store = { get: () => state, subscribe: () => () => {} };
  const real = loadTsx('frontend/src/features/leaderboard/history.js');
  const mod = loadTsx('frontend/src/features/leaderboard/history-pane.tsx', {
    stubs: { './history.js': { ...real, historyStore: store } },
  });
  const html = renderToHtml(createElement(mod.HistoryPane, {}));
  assert.match(html, /id="lb-history-seasons"/);
  assert.match(html, /data-history-season="2"/);
  assert.match(html, /<span class="min-w-0" data-history-result="">lee won with 3,100 pts · you finished #4<\/span>/);
  assert.match(html, /data-history-event="22"[^>]*>Epoch 1 · maya</);
  const closed = loadTsx('frontend/src/features/leaderboard/history-pane.tsx', {
    stubs: { './history.js': { ...real, historyStore: { get: () => ({ mounted: false }), subscribe: () => () => {} } } },
  });
  assert.equal(renderToHtml(createElement(closed.HistoryPane, {})), '');
});

test('the section is wired: History mounts lazily, hides the one-event bar, and addresses as #leaderboard/seasons', () => {
  const lb = read('frontend/src/features/leaderboard/leaderboard.js');
  assert.match(lb, /'leaderboard-history-root': Leaderboard\.section === 'seasons'/);
  assert.match(lb, /EVENT_SECTIONS: \['topochain', 'challenges'\]/, 'the event bar stays off History');
  assert.match(lb, /Leaderboard\.section === 'seasons' && !Leaderboard\._historyMounted/);
  assert.match(lb, /\? '#leaderboard\/seasons'/);
  const app = read('public/js/app.js');
  assert.match(app, /\|\| sub === 'seasons'\)\s*\n\s*&& window\.Leaderboard\?\._setSection/,
    'the router hands #leaderboard/seasons to the section switch');
  assert.match(read('frontend/src/features/leaderboard/history.js'), /\/api\/v4\/season-history\$\{demoQuery\(\)\}/);
});
