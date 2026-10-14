'use strict';

// The First challenges (services/topochain/challenge-onboarding.js).
//
// The first four ONBOARDING challenges of a season, in the organiser's order,
// are its First challenges (Join, Try, Vote, Suggest, as evan sets them up),
// and their progress is LIFETIME: a credit on the same template in an earlier
// season counts. Any ONBOARDING challenge after them is an ordinary
// PERSISTENT one.
//
// Until #4635 they were also a GATE: a new account (`users.getting_started_gate`)
// saw nothing else of the season until it had done them and the tour, on a
// Getting started card on top of Home. Every new account gets a tour
// now, so the card and the gate went together. These tests hold what is left
// (which challenges, how far, which group) and that nothing hides behind them:
// every list returns the whole event or season, to a new account too, and
// carries no gate summary.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const onboardingModule = require('../src/services/topochain/challenge-onboarding');
const {
  buildOnboarding, loadOnboarding, challengeCategory, ONBOARDING_LIMIT,
} = onboardingModule;

const step = (id, extra = {}) => ({
  id, season_event_id: 10, challenge_template_id: id + 100,
  display_order: id, enabled: true, completed: false,
  metric_type: null, metric_target: null, activity_count: 0,
  ...extra,
});
const intro = (counts = [0, 0, 0, 0]) => [
  step(1, { metric_type: 'count', metric_target: 3, activity_count: counts[0] }),
  step(2, { activity_count: counts[1] }),
  step(3, { activity_count: counts[2] }),
  step(4, { activity_count: counts[3] }),
  step(5),
];

test('the First challenges are the season\'s first four ONBOARDING challenges, and nothing else rides on them', () => {
  assert.equal(ONBOARDING_LIMIT, 4, 'Join, Try, Vote and Suggest (2026-10-01)');
  const state = buildOnboarding(intro());
  assert.deepEqual(state.ids, [1, 2, 3, 4]);
  assert.deepEqual(state.available, [1, 2, 3, 4]);
  // Which they are and how far the viewer is: no gate, no summary, no tour.
  assert.deepEqual(Object.keys(state).sort(), ['available', 'ids', 'progress']);
  for (const gone of ['isLocked', 'gateSummary', 'visibleChallenges', 'recordUnlocked']) {
    assert.equal(gone in onboardingModule, false, `${gone} went with the gate (#4635)`);
  }
});

test('partial credit on the counted step is progress, not done', () => {
  const state = buildOnboarding(intro([2, 1, 1, 1]));
  assert.deepEqual(state.progress.get(1), { done: false, current: 2, target: 3 });
  assert.equal(state.progress.get(2).done, true);
});

test('the first four are First challenges; the rest of ONBOARDING is always open', () => {
  for (const counts of [[0, 0, 0, 0], [3, 1, 1, 1]]) {
    const state = buildOnboarding(intro(counts));
    assert.equal(challengeCategory(1, 'ONBOARDING', state), 'ONBOARDING');
    assert.equal(challengeCategory(4, 'ONBOARDING', state), 'ONBOARDING');
    assert.equal(challengeCategory(5, 'ONBOARDING', state), 'PERSISTENT');
    assert.equal(challengeCategory(6, 'ONBOARDING', state), 'PERSISTENT');
    assert.equal(challengeCategory(7, 'WEEKLY', state), 'WEEKLY');
  }
});

test('a challenge an admin adds first later becomes a First challenge', () => {
  const rows = intro([3, 1, 1, 1]);
  rows.unshift(step(9, { display_order: 0 }));
  const state = buildOnboarding(rows);
  assert.deepEqual(state.ids, [9, 1, 2, 3]);
  assert.equal(state.progress.get(9).done, false);
});

test('completed steps never rotate out and pull identity into onboarding', () => {
  const state = buildOnboarding(intro([3, 1, 0, 1]));
  assert.deepEqual(state.ids, [1, 2, 3, 4]);
});

test('an explicit completion credit finishes a counted step even when awarded in one batch', () => {
  const rows = intro([1, 1, 1, 1]);
  rows[0].completion_recorded = true;
  const state = buildOnboarding(rows);
  assert.deepEqual(state.progress.get(1), { done: true, current: 3, target: 3 });
});

test('disabled, retired and unavailable steps are not available, and do not replace the original four', () => {
  for (const availability of [
    { enabled: false }, { completed: true },
    { schedule_end: '2020-01-01T00:00:00Z' },
    { schedule_start: '2100-01-01T00:00:00Z' },
  ]) {
    const rows = intro([0, 1, 1, 1]);
    Object.assign(rows[0], availability);
    const state = buildOnboarding(rows);
    assert.deepEqual(state.ids, [1, 2, 3, 4]);
    // Admin › Journey counts a newcomer's list out of these.
    assert.deepEqual(state.available, [2, 3, 4]);
    // An organiser's completed flag did not create a personal completion.
    assert.equal(state.progress.get(1).done, false);
  }
});

test('selection follows organiser order and deduplicates repeated template instances', () => {
  const rows = intro();
  rows.push(step(9, { challenge_template_id: 101, display_order: 1 }));
  const state = buildOnboarding(rows.reverse());
  assert.deepEqual(state.ids, [1, 2, 3, 4]);
});

test('seasons without onboarding keep their existing challenge lists', () => {
  assert.equal(buildOnboarding([]), null);
  assert.equal(challengeCategory(6, 'WEEKLY', null), 'WEEKLY');
  assert.equal(challengeCategory(6, 'ONBOARDING', null), 'ONBOARDING');
});

test('event-scoped reads resolve onboarding across the season and reuse prior template credits', async () => {
  let query;
  const state = await loadOnboarding({ query: async (sql, params) => {
    query = { sql, params };
    return { rows: intro([3, 1, 1, 1]) };
  } }, 42, { eventId: 11 });
  assert.deepEqual(query.params, [42, 11]);
  assert.match(query.sql, /se\.season_id = \(SELECT season_id FROM season_events WHERE id = \$2\)/);
  assert.match(query.sql, /credited\.challenge_template_id = c\.challenge_template_id/);
  assert.match(query.sql, /ua\.user_id = \$1/);
  // Nothing about the viewer's ACCOUNT decides what they see any more: the
  // read joins no `users` row (it used to carry the gate, the tour and the
  // unlock), and nothing the Getting started card drew rides on it.
  assert.doesNotMatch(query.sql, /FROM users|getting_started|tour_done/);
  assert.doesNotMatch(query.sql, /AS goal|earned_points|challenge_scoring_rules/);
  assert.equal(state.progress.get(1).done, true);
});

test('a read never writes, for a new account or a signed-out visitor', async () => {
  const pool = { query: async (sql) => {
    assert.doesNotMatch(sql, /UPDATE|INSERT/);
    return { rows: intro([3, 1, 1, 1]) };
  } };
  assert.deepEqual((await loadOnboarding(pool, 7, { seasonId: 2 })).ids, [1, 2, 3, 4]);
  assert.deepEqual((await loadOnboarding(pool, null, { seasonId: 2 })).ids, [1, 2, 3, 4]);
});

// HTTP coverage of the actual list handlers. Authentication has dedicated
// suites; inject an authenticated identity here and exercise the same handler
// registered for web sessions and native tokens against one catalog/ledger.
//
// `user: null` is a signed-out visitor. Nothing in the fixture says whether
// the viewer is a new account, because nothing on the server asks any more.
function makeApp(counts = [0, 0, 0, 0], credits = {}, { user = { id: 7, username: 'viewer' } } = {}) {
  // `blocks` is the viewer's newest leaderboard snapshot for the event — the
  // only place a block score is ever written, and what challenge 9 below is
  // counted from.
  const state = { counts, credits, blocks: 0 };
  const rows = Array.from({ length: 9 }, (_, i) => {
    const id = i + 1;
    return {
      ...step(id), t_id: id + 100, t_category: id <= 5 ? 'ONBOARDING' : 'WEEKLY',
      t_goal: ['Try Three Apps', 'Propose a Change', 'Join Network Operation',
        'Identity Level 1', 'Identity Level 2'][i] || `Weekly ${id}`,
      t_task: 'Existing task', t_reward: '500 pts',
      // Challenge 9 is the block-production card (#2492): its metric counts
      // blocks, which never reach `user_activities`, so its progress can only
      // come from the snapshot read.
      metric_type: id === 1 ? 'count' : (id === 9 ? 'blocks_produced' : null),
      metric_target: id === 1 ? 3 : (id === 9 ? 500 : null),
      metric_label: id === 9 ? 'blocks' : null,
      event_type: 'season', event_name: 'Current season',
    };
  });
  const done = (id) => (state.counts[id - 1] || 0) >= (id === 1 ? 3 : 1);
  const pool = { query: async (raw, params = []) => {
    const sql = raw.replace(/\s+/g, ' ').trim();
    if (sql.startsWith('/* challenge event blocks */')) {
      return { rows: (params[1] || []).map((eventId) => ({ season_event_id: eventId, blocks: state.blocks })) };
    }
    if (sql.startsWith('/* challenge onboarding */')) {
      // The viewer's credits; a signed-out visitor has none.
      return { rows: intro(params[0] === 7 ? state.counts : [0, 0, 0, 0]) };
    }
    // The public list's scoring-cadence read (#3185). No rule scores anything
    // in this fixture, so every card's `scoring` is null.
    if (sql.startsWith('/* challenge scoring cadence */')) return { rows: [] };
    if (sql.includes('SELECT home_panels_hidden FROM users')) return { rows: [{ home_panels_hidden: [] }] };
    if (sql.includes('FROM seasons')) return { rows: [{ id: 2, name: 'Current season', internal: false }] };
    if (sql.startsWith('SELECT id, type, name')) return { rows: [{ id: 10, type: 'season' }, { id: 11, type: 'regular' }] };
    if (sql.startsWith('SELECT id') && sql.includes('FROM season_events')) {
      return { rows: [{ id: params[0], internal: false }] };
    }
    if (sql.includes('FROM challenges c')) {
      // The totals statement counts the open scope and the whole catalog in one
      // pass (#1824), so `AS all_total` is what identifies it now. Nothing here
      // models completion or scheduling windows, so both counts are the same.
      // Neither statement narrows by the First challenges any more (#4635):
      // a gate on either is the regression this fixture is here to catch.
      if (sql.includes('my_activity_count') || sql.includes('AS all_total')) {
        assert.doesNotMatch(sql, /AND c\.id = ANY|hidden_count|hidden_names/);
        if (sql.includes('AS all_total')) return { rows: [{
          total: rows.length, all_total: rows.length,
          done: rows.filter((r) => done(r.id)).length,
          open_rewards: rows.filter((r) => !done(r.id)).map((r) => r.t_reward),
        }] };
        return { rows: [...rows].sort((a, b) => Number(done(a.id)) - Number(done(b.id)))
          .slice(0, params[2]).map((r) => ({ ...r, my_done: done(r.id), my_activity_count: 0 })) };
      }
      return { rows: params[0] === 11 ? rows.filter((r) => r.id > 5) : rows };
    }
    // The per-viewer credit count the challenge lists now attach to EVERY
    // challenge, not only the First challenges. `state.credits` maps a challenge
    // id to how many ledger rows the viewer has on it.
    if (sql.includes('FROM user_activities') && /GROUP BY (ua\.)?challenge_id/.test(sql)) {
      const ids = params[1] || [];
      return {
        rows: Object.entries(state.credits || {})
          .filter(([id]) => ids.includes(Number(id)))
          .map(([id, credits]) => ({ challenge_id: Number(id), credits })),
      };
    }
    // The personalised list loads the viewer's rows themselves and counts
    // them in JS, where the public list asks Postgres for the count. Two
    // shapes, one fixture.
    if (sql.includes('FROM user_activities')) {
      const ids = params[1] || [];
      const out = [];
      for (const [id, credits] of Object.entries(state.credits || {})) {
        if (!ids.includes(Number(id))) continue;
        for (let i = 0; i < credits; i += 1) {
          out.push({
            challenge_id: Number(id), points: 100, description: null,
            activity_at: new Date(),
          });
        }
      }
      return { rows: out };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  } };

  const poolModule = require('../src/db/pool');
  const original = poolModule.getPool;
  poolModule.getPool = () => pool;
  const app = express();
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  try {
    for (const [file, factory] of [
      ['topochain/public', 'topochainPublicRoutes'],
      ['topochain/mobile', 'topochainMobileRoutes'],
      ['home-panels', 'homePanelRoutes'],
    ]) {
      const modulePath = require.resolve(`../src/routes/${file}`);
      delete require.cache[modulePath];
      const router = require(modulePath)[factory]({ jwtSecret: 'fixture' });
      for (const layer of router.stack) {
        if (!layer.route?.methods.get) continue;
        const route = layer.route;
        if (['/api/v4/season-events/:seasonEventId/challenges', '/challenges-api/challenges',
          '/api/v4/mobile/challenges', '/api/v4/mobile/seasons', '/api/home-panels'].includes(route.path)) {
          app.get(route.path, route.stack.at(-1).handle);
        }
      }
    }
  } finally { poolModule.getPool = original; }
  return { app, state };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await fn(async (path) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    });
  } finally { server.close(); }
}

test('every list gives every viewer the whole event or season, a new account included, with no gate summary', async () => {
  for (const [who, opts] of [
    ['a new account part-way through its First challenges', {}],
    ['a signed-out visitor', { user: null }],
  ]) {
    const { app } = makeApp([2, 1, 1, 1], {}, opts);
    // eslint-disable-next-line no-await-in-loop
    await withServer(app, async (get) => {
      const paths = opts.user === null
        ? ['/api/v4/season-events/10/challenges']
        : ['/api/v4/season-events/10/challenges', '/challenges-api/challenges?season_id=2',
          '/api/v4/mobile/challenges?season_id=2', '/api/home-panels'];
      for (const path of paths) {
        const body = await get(path);
        const list = path === '/api/home-panels'
          ? body.panels.find((p) => p.key === 'challenges') : body;
        const rows = list.challenges || list.data;
        assert.deepEqual(rows.map((c) => c.id).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9],
          `${who}, ${path}: every challenge`);
        assert.equal('onboarding' in list, false, `${who}, ${path}: no gate to explain`);
        assert.equal('hidden_count' in list, false, `${who}, ${path}`);
        // The grouping is everyone's: four First challenges, the fifth always open.
        const category = (id) => {
          const c = rows.find((r) => r.id === id);
          return c.label || c.category || c.activity_type.category;
        };
        assert.equal(category(1), 'ONBOARDING', `${who}, ${path}`);
        assert.equal(category(5), 'PERSISTENT', `${who}, ${path}`);
        if (opts.user !== null) {
          // The counted First challenge carries its lifetime progress.
          assert.deepEqual(rows.find((c) => c.id === 1).progress, { done: false, current: 2, target: 3 },
            `${who}, ${path}`);
        }
      }
    });
  }
});

test('weekly-event selection and nested seasons list the whole event', async () => {
  const { app } = makeApp();
  await withServer(app, async (get) => {
    const weekly = await get('/api/v4/mobile/challenges?season_event_id=11');
    assert.deepEqual(weekly.data.map((c) => c.id), [6, 7, 8, 9]);
    assert.equal('onboarding' in weekly, false);
    const publicWeekly = await get('/api/v4/season-events/11/challenges');
    assert.deepEqual(publicWeekly.data.map((c) => c.id), [6, 7, 8, 9]);
    const nested = await get('/api/v4/mobile/seasons?season_id=2');
    assert.equal(nested.data[0].season_challenges.length, 9);
    assert.equal(nested.data[0].events[1].challenges.length, 4);
    assert.equal('onboarding' in nested.data[0], false);
    const filtered = await get('/api/v4/mobile/seasons?season_id=2&challenge_category=PERSISTENT');
    assert.deepEqual(filtered.data[0].season_challenges.map((c) => c.challenge_id), [5]);
  });
});

test('home counts every challenge, with the First challenges\' lifetime credits', async () => {
  const { app } = makeApp([2, 1, 1, 1]);
  await withServer(app, async (get) => {
    for (const path of ['/api/home-panels', '/api/home-panels?expand=challenges']) {
      const panel = (await get(path)).panels.find((p) => p.key === 'challenges');
      assert.equal(panel.total, 9, path);
      assert.equal(panel.done, 3, path);
      assert.equal(panel.points_remaining, 3000, path);
      assert.deepEqual(panel.challenges.map((c) => c.id).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
      assert.equal('onboarding' in panel, false, path);
      assert.equal(panel.challenges.find((c) => c.id === 5).label, 'PERSISTENT');
      assert.equal(panel.challenges.find((c) => c.id === 1).label, 'ONBOARDING');
      assert.deepEqual(panel.challenges.find((c) => c.id === 1).progress, { done: false, current: 2, target: 3 });
    }
  });
});

test('a finished challenge outside the First challenges reports done, not merely started', () => {
  // The lists used to carry progress for the First challenges alone,
  // because nothing credited the others without an admin typing it in. The
  // card reads `progress.done`, so a persistent challenge somebody had
  // finished AND been paid for showed "Started" for good. Automatic scoring
  // makes that the normal state of most of a season, so every challenge now
  // carries the viewer's progress.
  const { app, state } = makeApp([3, 1, 1, 1], { 6: 1, 7: 2 });
  return withServer(app, async (get) => {
    for (const path of ['/api/v4/season-events/10/challenges', '/challenges-api/challenges?season_id=2']) {
      const body = await get(path);
      const byId = new Map(body.data.map((c) => [c.id, c]));
      assert.equal(byId.get(6).progress.done, true, `${path}: a credited weekly challenge is done`);
      assert.equal(byId.get(8).progress.done, false, `${path}: an uncredited one is not`);
    }
    // And the First challenges keep the onboarding service's lifetime answer.
    const body = await get('/api/v4/season-events/10/challenges');
    assert.equal(body.data.find((c) => c.id === 1).progress.current, 3);
    assert.equal(state.credits[6], 1);
  });
});

test('a block-production card carries the snapshot count, as Home always has (#2492)', () => {
  // The bug: block scores live in leaderboard snapshots and never in the
  // points ledger, so these lists attached no progress at all to a
  // `blocks_produced` challenge and its card drew a ring with nothing beside
  // it — while Home, reading the same snapshot, showed "180/500 blocks" for
  // the very same challenge. The row now carries the count itself.
  const { app, state } = makeApp([3, 1, 1, 1]);
  state.blocks = 180;
  return withServer(app, async (get) => {
    for (const path of ['/api/v4/season-events/10/challenges',
      '/challenges-api/challenges?season_id=2', '/api/v4/mobile/challenges?season_id=2']) {
      const block = (await get(path)).data.find((c) => c.id === 9);
      assert.deepEqual(block.progress, { done: false, current: 180, target: 500 },
        `${path}: counted from the snapshot, not from ledger rows`);
    }
    // Nothing produced yet is still a FACT, which is what lets the card say
    // "Not started" rather than nothing at all.
    state.blocks = 0;
    const none = (await get('/api/v4/season-events/10/challenges')).data.find((c) => c.id === 9);
    assert.deepEqual(none.progress, { done: false, current: 0, target: 500 });
    // And a viewer at or past the target has finished it.
    state.blocks = 500;
    const done = (await get('/api/v4/mobile/challenges?season_id=2')).data.find((c) => c.id === 9);
    assert.deepEqual(done.progress, { done: true, current: 500, target: 500 });
  });
});

test('the snapshot read is one query, and the lists and Home share its SQL (#2492)', async () => {
  const onboarding = require('../src/services/topochain/challenge-onboarding');
  const panels = require('../src/routes/home-panels');
  assert.equal(panels.MY_BLOCKS_SQL, onboarding.NEWEST_EVENT_BLOCKS_SQL,
    'home-panels re-exports the shared subquery rather than keeping a second copy');

  let calls = 0;
  let query = null;
  const pool = { query: async (sql, params) => {
    calls += 1;
    query = { sql: sql.replace(/\s+/g, ' ').trim(), params };
    return { rows: [{ season_event_id: 10, blocks: '42' }, { season_event_id: 11, blocks: null }] };
  } };
  const blocks = await onboarding.loadEventBlocks(pool, 7, [10, 11, 10]);
  assert.equal(calls, 1, 'one query for the whole list, however many events it spans');
  assert.deepEqual(query.params, [7, [10, 11]], 'deduplicated, viewer first');
  assert.ok(query.sql.includes(onboarding.NEWEST_EVENT_BLOCKS_SQL.replace(/\s+/g, ' ')),
    'and it runs the same subquery Home embeds');
  assert.deepEqual([...blocks], [[10, 42], [11, null]]);

  // A signed-out viewer, or a list with no block card on it, asks nothing.
  calls = 0;
  assert.equal((await onboarding.loadEventBlocks(pool, null, [10])).size, 0);
  assert.equal((await onboarding.loadEventBlocks(pool, 7, [])).size, 0);
  assert.equal(calls, 0);
});
