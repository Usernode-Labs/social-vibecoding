'use strict';

// #3624 stage 2: how much the Homeroom bot works on at once.
//
// Live work (an app it acts on for real, or a project it builds for
// somebody) is started one issue at a time: never two on one app (the bot
// has one session per app) unless one is a follow-up on its own proposal
// (#3703, below), at most `perPerson` for one person, at most `liveAtOnce`
// in all. Shadow triage of every other app runs in slots of its
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
        // As the query reads: nothing on a backed-off app ($2), and only a
        // follow-up on an app whose session is taken ($5).
        return {
          rows: candidates.filter((c) => !params[1].includes(c.app_id)
            && (c.follow_up_session_id != null || !(params[4] || []).includes(c.app_id))),
        };
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

// ── #3703: a reply on the bot's own proposal ─────────────────────────────
//
// evan asked a question in the discussion of the bot's proposal on his Ear
// Trainer project and heard nothing for eleven minutes: the reply was
// queued at once, but the project's one live slot was building another
// request, and when it freed a newer request was taken first. A follow-up
// runs on the proposal's own session, so it no longer waits for the app's.

const followUp = (id, appId, personId, extra = {}) => row(id, appId, personId, {
  priority: 2, reason: 'changed', follow_up_session_id: 5000 + id, ...extra,
});

test('pickLive: a follow-up on the bot\'s own proposal neither waits for its app nor holds it', () => {
  // The app's session is building another request: the reply still starts.
  let picks = bot.pickLive([followUp(1, 10, 7), row(2, 10, 7)], {
    busyAppIds: [10], active: [{ person: 'u7' }], slots: 6, perPerson: 2,
  });
  assert.deepEqual(picks.map((p) => [p.id, p.followUp]), [[1, true]]);

  // It takes no app: the app's next request can start beside it.
  picks = bot.pickLive([followUp(1, 10, 7), row(2, 10, 8), row(3, 10, 8)], { slots: 6, perPerson: 2 });
  assert.deepEqual(picks.map((p) => [p.id, p.followUp]), [[1, true], [2, false]], 'and still one request per app');

  // It is still one of its person's slots, and one of the platform's.
  assert.deepEqual(bot.pickLive([followUp(1, 10, 7)], {
    active: [{ person: 'u7' }, { person: 'u7' }], slots: 6, perPerson: 2,
  }), []);
  assert.deepEqual(bot.pickLive([followUp(1, 10, 7)], { slots: 0, perPerson: 2 }), []);
  // An app backed off after a refusal starts nothing at all.
  assert.deepEqual(bot.pickLive([followUp(1, 10, 7)], { blockedAppIds: [10], slots: 6, perPerson: 2 }), []);
});

test('the live queue reads which rows are follow-ups, lets only them past a busy app, and takes them first', async () => {
  const asked = [];
  const pool = { async query(sql, params) { asked.push({ s: String(sql), params }); return { rows: [] }; } };
  await bot.liveCandidates(pool, {
    liveSlugs: ['a1'], excludeAppIds: [103], busyAppIds: [101], botId: 77, pausedApps: [],
  });
  const { s, params } = asked[0];
  assert.deepEqual(params, [['a1'], [103], [], 200, [101], 77]);
  // The bot's own proposal on the issue, still up for a vote: what runTriage
  // follows up on (live.openBotProposal, runFollowUp).
  assert.match(s, /cs\.user_id = \$6\s+AND q\.issue_number = ANY\(cs\.linked_issues\)\s+AND cs\.status = 'promoted' AND cs\.is_headless = FALSE/);
  assert.match(s, /fu\.id AS follow_up_session_id/);
  assert.match(s, /AND NOT \(q\.app_id = ANY\(\$2::int\[\]\)\)/, 'a backed-off app: nothing');
  assert.match(s, /AND \(fu\.id IS NOT NULL OR NOT \(q\.app_id = ANY\(\$5::int\[\]\)\)\)/, 'a busy app: follow-ups only');
  assert.match(s, /ORDER BY \(q\.priority = 0\) DESC, \(fu\.id IS NOT NULL\) DESC, q\.priority, q\.enqueued_at/,
    'a Run now first, then a reply on the bot\'s proposal, then the rest in their order');
});

test('a reply on the bot\'s proposal starts while another request builds on the same app', async () => {
  bot._resetForTests();
  const settings = [
    { key: bot.KEY_MODE, value: 'shadow' },
    { key: bot.KEY_LIVE_APPS, value: JSON.stringify(LIVE) },
    { key: bot.KEY_PER_PERSON, value: '2' },
    { key: bot.KEY_LIVE_AT_ONCE, value: '6' },
  ];
  const candidates = [row(1, 101, 7)];
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
  assert.equal(first.dispatched, 1, 'a request on app 101 holds its session');

  // Then the person replies in the discussion of the bot's proposal there.
  candidates.push(followUp(2, 101, 7), row(3, 101, 8));
  pool.log.length = 0;
  const second = await bot.runOnce(pool, {}, deps);
  assert.equal(second.dispatched, 1, 'the reply starts; the other request still waits for the app');
  const running = bot._inFlightForTests().sort((a, b) => a.itemId - b.itemId);
  assert.deepEqual(running.map((r) => [r.appId, r.itemId, r.followUp]), [[101, 1, false], [101, 2, true]]);
  const asked = pool.log.find((l) => /AS follow_up_session_id/.test(l.s));
  assert.deepEqual(asked.params[4], [101], 'the app whose session is taken');
  assert.equal(asked.params[5], 77, 'the bot\'s own proposals');

  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(bot._inFlightForTests().length, 0);
  bot._resetForTests();
});

test('when live work ends, the next pass reads its app again, so a reply sent meanwhile is not left for the sweep', async () => {
  bot._resetForTests();
  const settings = [
    { key: bot.KEY_MODE, value: 'shadow' },
    { key: bot.KEY_LIVE_APPS, value: JSON.stringify(LIVE) },
  ];
  const pool = loopPool({ settings, candidates: [row(1, 102, 7)], apps: APPS });
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetched = [];
  const deps = {
    drain: false,
    github: {
      isEnabled: () => true,
      async fetchPublicIssues(owner, repo) { fetched.push(repo); return { issues: [] }; },
    },
    limits: { async checkBudget() { await gate; return { error: true }; } },
    worker: { async listWorkerVolumes() { return []; } },
  };
  await bot.runOnce(pool, {}, deps);
  assert.deepEqual(bot._pendingForTests().apps, [], 'nothing to read again while it runs');
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(bot._pendingForTests().apps, [102], 'the app it ran on');

  // The next pass (inside the refresh interval) refreshes just that app.
  pool.query = ((real) => async (sql, params) => {
    if (/FROM apps\s+WHERE status = 'running'/.test(String(sql))) return { rows: [APPS[1]] };
    return real(sql, params);
  })(pool.query.bind(pool));
  const next = await bot.runOnce(pool, {}, { ...deps, now: () => Date.now() });
  assert.equal(next.woken, 1);
  assert.ok(fetched.includes('a2'), 'its requests were read again');
  assert.deepEqual(bot._pendingForTests().apps, []);
  bot._resetForTests();
});

test('a row started as a follow-up whose proposal has gone is handed back untouched', async () => {
  bot._resetForTests();
  const settings = [
    { key: bot.KEY_MODE, value: 'shadow' },
    { key: bot.KEY_LIVE_APPS, value: JSON.stringify(LIVE) },
  ];
  const pool = loopPool({ settings, candidates: [followUp(4, 103, 7)], apps: APPS });
  const deps = {
    drain: false,
    github: {
      isEnabled: () => true,
      async fetchPublicIssues() { return { issues: [] }; },
      async fetchPublicIssue() { return { issue: { number: 4, title: 'x', state: 'open' } }; },
    },
    limits: { async checkBudget() { return { ok: true }; } },
    worker: { async listWorkerVolumes() { return []; } },
    dm: { async recordRequester() { return null; } },
    ws: {}, sessionLifecycle: {}, domain: 'app.onhomeroom.com',
  };
  // The proposal merged between the pick and the run: openBotProposal finds none.
  const out = await bot.runOnce(pool, {}, deps);
  assert.equal(out.dispatched, 1);
  await new Promise((r) => setTimeout(r, 20));
  const handedBack = pool.log.filter((l) => /UPDATE homeroom_bot_queue SET started_at = NULL WHERE id = \$1/.test(l.s));
  assert.deepEqual(handedBack.map((l) => l.params[0]), [4], 'to be taken in the app\'s own turn');
  assert.ok(!pool.log.some((l) => /INSERT INTO homeroom_bot_runs|DELETE FROM homeroom_bot_queue/.test(l.s)), 'no run recorded, nothing consumed');
  assert.ok(!pool.log.some((l) => /FROM chat_sessions\s+WHERE user_id = \$1 AND app_id = \$2 AND status IN \('active', 'paused'\)/.test(l.s)),
    'and the app\'s own session, which another request may be using, untouched');
  assert.ok(pool.log.some((l) => /SELECT id, status, pr_number FROM chat_sessions/.test(l.s)), 'it did look for the proposal');
  bot._resetForTests();
});
