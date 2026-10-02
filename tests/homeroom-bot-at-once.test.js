'use strict';

// #3624 stage 2: how much the Homeroom bot works on at once.
//
// Live work (an app it acts on for real, or a project it builds for
// somebody) is started one issue at a time: never two on one app (the bot
// has one session per app), at most `perPerson` for one person, at most
// `liveAtOnce` in all. Shadow triage of every other app runs in slots of its
// own. And a pass does not wait for the work it starts, so a long build on
// one app never holds up an answer on another.
//
// Run with: node --test tests/homeroom-bot-at-once.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const bot = require('../src/services/homeroom-bot');

const row = (id, appId, personId, extra = {}) => ({
  id, app_id: appId, issue_number: id, priority: 1, reason: 'new', person_id: personId, ...extra,
});

test('pickLive: one per app, at most perPerson for anybody, at most `slots` in all, in queue order', () => {
  const candidates = [
    row(1, 10, 7), row(2, 10, 7), // two on app 10: only the first
    row(3, 11, 7), row(4, 12, 7), // a third app for person 7: over their 2
    row(5, 13, 8), row(6, 14, null), // person 8, and an issue nobody on Homeroom filed
  ];
  const picks = bot.pickLive(candidates, { busyAppIds: [], active: [], slots: 6, perPerson: 2 });
  assert.deepEqual(picks.map((p) => p.id), [1, 3, 5, 6]);
  assert.deepEqual(picks.map((p) => p.person), ['u7', 'u7', 'u8', 'a14'], 'nobody filed it: it counts as its app');

  // What already runs counts: person 7 has one going, app 13 is busy.
  const more = bot.pickLive(candidates, {
    busyAppIds: [13], active: [{ person: 'u7' }], slots: 6, perPerson: 2,
  });
  assert.deepEqual(more.map((p) => p.id), [1, 6]);

  // The platform ceiling.
  assert.deepEqual(bot.pickLive(candidates, { slots: 1, perPerson: 2 }).map((p) => p.id), [1]);
  assert.deepEqual(bot.pickLive(candidates, { slots: 0, perPerson: 2 }), []);
});

/** A pool that answers the loop's queries, with live candidates to start. */
function loopPool({ settings, candidates = [], apps = [] }) {
  const log = [];
  const client = {
    async query(sql) {
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    log,
    async connect() { return client; },
    async query(sql, params) {
      const s = String(sql);
      log.push({ s, params });
      if (/SELECT key, value FROM platform_settings/.test(s)) return { rows: settings };
      if (/FROM users WHERE username = \$1/.test(s)) return { rows: [{ id: 77, username: 'homeroom_bot', weekly_limit_cents: 15000 }] };
      if (/SELECT is_synthetic FROM users/.test(s)) return { rows: [{ is_synthetic: true }] };
      if (/COALESCE\(r\.user_id, i\.created_by\) AS person_id/.test(s) && /WHERE q\.started_at IS NULL/.test(s)) {
        return { rows: candidates.filter((c) => !params[1].includes(c.app_id)) };
      }
      if (/FROM apps WHERE id = ANY\(\$1::int\[\]\)/.test(s)) return { rows: apps.filter((a) => params[0].includes(a.id)) };
      if (/SET started_at = NOW\(\) WHERE id = \$1 AND started_at IS NULL RETURNING id/.test(s)) return { rows: [{ id: params[0] }] };
      return { rows: [] };
    },
  };
  return pool;
}

const LIVE = ['a1', 'a2', 'a3', 'a4'];
const APPS = LIVE.map((slug, i) => ({ id: 101 + i, slug, name: slug, repo_url: `https://github.com/o/${slug}`, self_hosted: false }));

test('runOnce starts live work and returns without waiting for it; a finished slot hands back what it did not use', async () => {
  bot._resetForTests();
  const settings = [
    { key: bot.KEY_MODE, value: 'shadow' },
    { key: bot.KEY_LIVE_APPS, value: JSON.stringify(LIVE) },
    { key: bot.KEY_PER_PERSON, value: '2' },
    { key: bot.KEY_LIVE_AT_ONCE, value: '6' },
  ];
  const candidates = [row(1, 101, 7), row(2, 102, 7), row(3, 103, 7), row(4, 104, 8)];
  const pool = loopPool({ settings, candidates, apps: APPS });
  // Each turn waits at its budget check until the test lets it go, then
  // finds the weekly cap spent: work that started and ended without a turn.
  let release;
  const gate = new Promise((r) => { release = r; });
  const deps = {
    drain: false,
    github: { isEnabled: () => true, async fetchPublicIssues() { return { issues: [] }; } },
    limits: { async checkBudget() { await gate; return { error: true, reason: 'weekly_cap' }; } },
    worker: { async listWorkerVolumes() { return []; } },
  };
  const out = await bot.runOnce(pool, {}, deps);
  assert.equal(out.dispatched, 3, 'person 7 gets two apps, person 8 one');
  assert.equal(out.inFlight, 3, 'and the pass returned while all three were still running');
  const running = bot._inFlightForTests();
  assert.deepEqual(running.map((r) => r.appId).sort(), [101, 102, 104]);
  assert.ok(running.every((r) => r.lane === 'live'));
  assert.deepEqual(pool.log.filter((l) => /SET started_at = NOW\(\) WHERE id = \$1 AND started_at IS NULL/.test(l.s)).map((l) => l.params[0]),
    [1, 2, 4], 'each row is claimed before its work starts');

  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(bot._inFlightForTests().length, 0, 'the slots are free again');
  const handedBack = pool.log.filter((l) => /UPDATE homeroom_bot_queue SET started_at = NULL WHERE id = \$1/.test(l.s)).map((l) => l.params[0]);
  assert.deepEqual(handedBack.sort(), [1, 2, 4], 'a row the cap stopped is handed back, not left claimed');

  // The cap stops dispatch until the idle pass, rather than on every completion.
  const again = await bot.runOnce(pool, {}, deps);
  assert.equal(again.paused, 'budget');
  assert.equal(again.dispatched, undefined);
  bot._resetForTests();
});

test('a pass only fills free slots: what runs keeps its app and its person\'s place', async () => {
  bot._resetForTests();
  const settings = [
    { key: bot.KEY_MODE, value: 'shadow' },
    { key: bot.KEY_LIVE_APPS, value: JSON.stringify(LIVE) },
    { key: bot.KEY_PER_PERSON, value: '2' },
    { key: bot.KEY_LIVE_AT_ONCE, value: '2' },
  ];
  const candidates = [row(1, 101, 7), row(2, 102, 8), row(3, 103, 9)];
  const pool = loopPool({ settings, candidates, apps: APPS });
  let release;
  const gate = new Promise((r) => { release = r; });
  const deps = {
    drain: false,
    github: { isEnabled: () => true, async fetchPublicIssues() { return { issues: [] }; } },
    limits: { async checkBudget() { await gate; return { error: true }; } },
    worker: { async listWorkerVolumes() { return []; } },
  };
  const first = await bot.runOnce(pool, {}, deps);
  assert.equal(first.dispatched, 2, 'the platform ceiling');
  const second = await bot.runOnce(pool, {}, deps);
  assert.equal(second.dispatched, 0, 'no free slot, nothing new starts');
  release();
  await new Promise((r) => setTimeout(r, 20));
  bot._resetForTests();
});

test('shadow triage runs in its own lane and never takes an app the bot acts on', async () => {
  bot._resetForTests();
  const heads = [];
  const settings = [
    { key: bot.KEY_MODE, value: 'shadow' },
    { key: bot.KEY_LIVE_APPS, value: JSON.stringify(['a1']) },
  ];
  const pool = loopPool({ settings });
  const real = pool.query.bind(pool);
  pool.query = async (sql, params) => {
    if (/FROM homeroom_bot_queue q JOIN apps/.test(String(sql))) heads.push(params);
    return real(sql, params);
  };
  await bot.runOnce(pool, {}, {
    github: { isEnabled: () => true, async fetchPublicIssues() { return { issues: [] }; } },
    worker: { async listWorkerVolumes() { return []; } },
  });
  assert.ok(heads.length, 'the background lane looked for a batch');
  assert.deepEqual(heads[0][2], ['a1'], 'with the live apps left out');

  // A staging copy never acts, so every app is the background lane's.
  const env = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  heads.length = 0;
  pool.log.length = 0;
  bot._resetForTests();
  try {
    await bot.runOnce(pool, {}, {
      github: { isEnabled: () => true, async fetchPublicIssues() { return { issues: [] }; } },
      worker: { async listWorkerVolumes() { return []; } },
    });
    assert.deepEqual(heads[0][2], []);
    assert.ok(!pool.log.some((l) => /AS person_id/.test(l.s) && /WHERE q\.started_at IS NULL/.test(l.s)), 'no live lane at all');
  } finally {
    if (env === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = env;
  }
  bot._resetForTests();
});

test('a row still being worked on is not handed back by the stale-claim sweep', async () => {
  bot._resetForTests();
  const settings = [
    { key: bot.KEY_MODE, value: 'shadow' },
    { key: bot.KEY_LIVE_APPS, value: JSON.stringify(LIVE) },
  ];
  const pool = loopPool({ settings, candidates: [row(9, 101, 7)], apps: APPS });
  let release;
  const gate = new Promise((r) => { release = r; });
  const deps = {
    drain: false,
    github: { isEnabled: () => true, async fetchPublicIssues() { return { issues: [] }; } },
    limits: { async checkBudget() { await gate; return { error: true }; } },
    worker: { async listWorkerVolumes() { return []; } },
  };
  await bot.runOnce(pool, {}, deps);
  pool.log.length = 0;
  await bot.runOnce(pool, {}, deps);
  const sweep = pool.log.find((l) => /SET started_at = NULL\s+WHERE started_at IS NOT NULL/.test(l.s));
  assert.match(sweep.s, /AND NOT \(id = ANY\(\$2::int\[\]\)\)/);
  assert.deepEqual(sweep.params[1], [9]);
  release();
  await new Promise((r) => setTimeout(r, 20));
  bot._resetForTests();
});

test('the loop asks for its next pass when work ends, and the tick never waits for work', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/services/homeroom-bot.js'), 'utf8');
  assert.match(src, /const out = await runOnce\(getPool\(config\), config, \{ drain: false \}\);/);
  assert.match(src, /if \(o\.paused !== 'budget' && o\.paused !== 'infra'\) requestPass\(\);/);
});
