'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
  buildOnboarding, loadOnboarding, visibleChallenges, challengeCategory,
} = require('../src/services/topochain/challenge-onboarding');

const step = (id, extra = {}) => ({
  id, season_event_id: 10, challenge_template_id: id + 100,
  display_order: id, enabled: true, completed: false,
  metric_type: null, metric_target: null, activity_count: 0,
  ...extra,
});
const intro = (counts = [0, 0, 0]) => [
  step(1, { metric_type: 'count', metric_target: 3, activity_count: counts[0] }),
  step(2, { activity_count: counts[1] }),
  step(3, { activity_count: counts[2] }),
  step(4), step(5),
];

test('new users see exactly three introductory challenges out of the nine-card catalog', () => {
  const state = buildOnboarding(intro());
  assert.deepEqual(state.ids, [1, 2, 3]);
  assert.deepEqual(state.summary, { total: 3, completed: 0, unlocked: false, event_id: 10 });
  assert.deepEqual(visibleChallenges(Array.from({ length: 9 }, (_, i) => ({ id: i + 1 })), state),
    [{ id: 1 }, { id: 2 }, { id: 3 }]);
});

test('partial credit on the counted step cannot unlock persistent or weekly challenges', () => {
  const state = buildOnboarding(intro([2, 1, 1]));
  assert.equal(state.summary.completed, 2);
  assert.equal(state.summary.unlocked, false);
  assert.deepEqual(state.progress.get(1), { done: false, current: 2, target: 3 });
});

test('all three completed steps unlock both groups and retain the completed introduction', () => {
  const state = buildOnboarding(intro([3, 1, 1]));
  const items = Array.from({ length: 9 }, (_, i) => ({ id: i + 1 }));
  assert.equal(state.summary.unlocked, true);
  assert.equal(visibleChallenges(items, state).length, 9);
  assert.equal(challengeCategory(1, 'ONBOARDING', state), 'ONBOARDING');
  assert.equal(challengeCategory(4, 'ONBOARDING', state), 'PERSISTENT');
  assert.equal(challengeCategory(5, 'ONBOARDING', state), 'PERSISTENT');
  assert.equal(challengeCategory(6, 'WEEKLY', state), 'WEEKLY');
});

test('completed steps never rotate out and pull identity into onboarding', () => {
  const state = buildOnboarding(intro([3, 1, 0]));
  assert.deepEqual(state.ids, [1, 2, 3]);
  assert.equal(state.summary.unlocked, false);
});

test('an explicit completion credit finishes a counted step even when awarded in one batch', () => {
  const rows = intro([1, 1, 1]);
  rows[0].completion_recorded = true;
  const state = buildOnboarding(rows);
  assert.equal(state.summary.unlocked, true);
  assert.deepEqual(state.progress.get(1), { done: true, current: 3, target: 3 });
});

test('disabled, retired and unavailable steps do not block users or replace the original three', () => {
  for (const availability of [
    { enabled: false }, { completed: true },
    { schedule_end: '2020-01-01T00:00:00Z' },
    { schedule_start: '2100-01-01T00:00:00Z' },
  ]) {
    const rows = intro([0, 1, 1]);
    Object.assign(rows[0], availability);
    const state = buildOnboarding(rows);
    assert.deepEqual(state.ids, [1, 2, 3]);
    assert.equal(state.summary.total, 2);
    assert.equal(state.summary.unlocked, true);
    // An organiser's completed flag did not create a personal completion.
    assert.equal(state.progress.get(1).done, false);
  }
});

test('selection follows organiser order and deduplicates repeated template instances', () => {
  const rows = intro();
  rows.push(step(9, { challenge_template_id: 101, display_order: 1 }));
  const state = buildOnboarding(rows.reverse());
  assert.deepEqual(state.ids, [1, 2, 3]);
});

test('seasons without onboarding keep their existing challenge lists', () => {
  const items = [{ id: 6, category: 'WEEKLY' }];
  assert.equal(buildOnboarding([]), null);
  assert.equal(visibleChallenges(items, null), items);
});

test('event-scoped reads resolve onboarding across the season and reuse prior template credits', async () => {
  let query;
  const state = await loadOnboarding({ query: async (sql, params) => {
    query = { sql, params };
    return { rows: intro([3, 1, 1]) };
  } }, 42, { eventId: 11 });
  assert.deepEqual(query.params, [42, 11]);
  assert.match(query.sql, /se\.season_id = \(SELECT season_id FROM season_events WHERE id = \$2\)/);
  assert.match(query.sql, /credited\.challenge_template_id = c\.challenge_template_id/);
  assert.match(query.sql, /ua\.user_id = \$1/);
  assert.equal(state.summary.unlocked, true);
});

// HTTP coverage of the actual list handlers. Authentication has dedicated
// suites; inject an authenticated identity here and exercise the same handler
// registered for web sessions and native tokens against one catalog/ledger.
function makeApp(counts = [0, 0, 0]) {
  const state = { counts };
  const rows = Array.from({ length: 9 }, (_, i) => {
    const id = i + 1;
    return {
      ...step(id), t_id: id + 100, t_category: id <= 5 ? 'ONBOARDING' : 'WEEKLY',
      t_goal: ['Try Three Apps', 'Propose a Change', 'Join Network Operation',
        'Identity Level 1', 'Identity Level 2'][i] || `Weekly ${id}`,
      t_task: 'Existing task', t_reward: '500 pts',
      metric_type: id === 1 ? 'count' : null,
      metric_target: id === 1 ? 3 : null,
      event_type: 'season', event_name: 'Current season',
    };
  });
  const done = (id) => (state.counts[id - 1] || 0) >= (id === 1 ? 3 : 1);
  const pool = { query: async (raw, params = []) => {
    const sql = raw.replace(/\s+/g, ' ').trim();
    if (sql.startsWith('/* challenge onboarding */')) {
      return { rows: intro(params[0] === 7 ? state.counts : [0, 0, 0]) };
    }
    if (sql.includes('SELECT home_panels_hidden FROM users')) return { rows: [{ home_panels_hidden: [] }] };
    if (sql.includes('FROM seasons')) return { rows: [{ id: 2, name: 'Current season', internal: false }] };
    if (sql.startsWith('SELECT id, type, name')) return { rows: [{ id: 10, type: 'season' }, { id: 11, type: 'regular' }] };
    if (sql.startsWith('SELECT id') && sql.includes('FROM season_events')) {
      return { rows: [{ id: params[0], internal: false }] };
    }
    if (sql.includes('FROM challenges c')) {
      if (sql.includes('my_activity_count') || sql.includes('COUNT(*)::int AS total')) {
        const totals = sql.includes('COUNT(*)::int AS total');
        const allowed = sql.includes('AND c.id = ANY') ? params[totals ? 2 : 3] : null;
        const selected = rows.filter((r) => !allowed || allowed.includes(r.id));
        if (totals) return { rows: [{
          total: selected.length, done: selected.filter((r) => done(r.id)).length,
          open_rewards: selected.filter((r) => !done(r.id)).map((r) => r.t_reward),
        }] };
        return { rows: [...selected].sort((a, b) => Number(done(a.id)) - Number(done(b.id)))
          .slice(0, params[2]).map((r) => ({ ...r, my_done: done(r.id), my_activity_count: 0 })) };
      }
      return { rows: params[0] === 11 ? rows.filter((r) => r.id > 5) : rows };
    }
    if (sql.includes('FROM user_activities')) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  } };

  const poolModule = require('../src/db/pool');
  const original = poolModule.getPool;
  poolModule.getPool = () => pool;
  const app = express();
  app.use((req, _res, next) => { req.user = { id: 7, username: 'viewer' }; next(); });
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

test('public, web-session, and mobile lists unlock on the third completion', async () => {
  const { app, state } = makeApp([2, 1, 1]);
  await withServer(app, async (get) => {
    for (const path of ['/api/v4/season-events/10/challenges',
      '/challenges-api/challenges?season_id=2', '/api/v4/mobile/challenges?season_id=2']) {
      const locked = await get(path);
      assert.deepEqual(locked.data.map((c) => c.id), [1, 2, 3]);
      assert.equal(locked.onboarding.completed, 2);
      assert.equal(locked.data[0].progress.done, false);
    }
    state.counts = [3, 1, 1];
    for (const path of ['/api/v4/season-events/10/challenges', '/api/v4/mobile/challenges?season_id=2']) {
      const unlocked = await get(path);
      assert.equal(unlocked.data.length, 9);
      assert.equal(unlocked.onboarding.unlocked, true);
      const identity = unlocked.data.find((c) => c.id === 4);
      assert.equal(identity.category || identity.activity_type.category, 'PERSISTENT');
      assert.equal(unlocked.data[0].progress.done, true);
    }
  });
});

test('weekly-event selection and nested seasons cannot skip onboarding', async () => {
  const { app, state } = makeApp();
  await withServer(app, async (get) => {
    const weekly = await get('/api/v4/mobile/challenges?season_event_id=11');
    assert.deepEqual(weekly.data, []);
    assert.equal(weekly.onboarding.event_id, 10);
    const nested = await get('/api/v4/mobile/seasons?season_id=2');
    assert.equal(nested.data[0].season_challenges.length, 3);
    assert.equal(nested.data[0].events[1].challenges.length, 0);
    state.counts = [3, 1, 1];
    const filtered = await get('/api/v4/mobile/seasons?season_id=2&challenge_category=PERSISTENT');
    assert.deepEqual(filtered.data[0].season_challenges.map((c) => c.challenge_id), [4, 5]);
    assert.equal((await get('/api/v4/mobile/challenges?season_event_id=11')).data.length, 4);
  });
});

test('home counts and expanded lists respect the same gate and existing lifetime credits', async () => {
  const { app, state } = makeApp([2, 1, 1]);
  await withServer(app, async (get) => {
    for (const path of ['/api/home-panels', '/api/home-panels?expand=challenges']) {
      const panel = (await get(path)).panels.find((p) => p.key === 'challenges');
      assert.equal(panel.total, 3);
      assert.equal(panel.done, 2);
      assert.equal(panel.points_remaining, 500);
      assert.deepEqual(panel.challenges.map((c) => c.id).sort(), [1, 2, 3]);
    }
    state.counts = [3, 1, 1];
    const panel = (await get('/api/home-panels?expand=challenges')).panels.find((p) => p.key === 'challenges');
    assert.equal(panel.total, 9);
    assert.equal(panel.done, 3);
    assert.equal(panel.onboarding.unlocked, true);
    assert.equal(panel.challenges.find((c) => c.id === 4).label, 'PERSISTENT');
    assert.equal(panel.challenges.find((c) => c.id === 1).progress.done, true);
  });
});
