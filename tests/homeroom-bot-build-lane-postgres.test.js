'use strict';

// The Homeroom bot's shadow-build lane, executed against the FULL PostgreSQL
// schema: the claim (slots dealt to apps in turns, oldest first, an idle
// slot filled by an app already building, paused apps waiting,
// never more than the free slots), the release of a build an earlier process
// never finished, the supersede and the dashboard's counts. The bot acts for real on every app but a paused
// one, so the lane builds only on a staging copy (live.liveScope), which is
// what this runs as. The builds themselves are stubbed; everything
// the lane asks of the database runs through the real planner, in a
// throwaway database built from src/db/schema.sql as a boot applies it.
//
// Like the repository's other postgres tests it skips when no database is
// reachable, unless TEST_DATABASE_URL insists on one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// PostgreSQL work may outlast a fixed sleep, especially in the full suite.
async function waitFor(check, message) {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function deps() {
  return {
    github: {
      isEnabled: () => true,
      getBotUsername: async () => 'usernode-bot',
      async fetchPublicIssue(_o, _r, n) { return { issue: { number: n, title: `Issue ${n}`, state: n === 99 ? 'closed' : 'open' } }; },
      async fetchIssueComments() { return { comments: [] }; },
    },
    limits: { async checkBudget() { return { ok: true }; }, async recordSpend() {} },
    threadContext: { async loadIssueThread() { return { messages: [] }; } },
    managedOpenRouter: { async usesIncludedKey() { return false; } },
    sessions: { buildHeadlessSeed: (n) => `ISSUE #${n}` },
    worker: {}, agentTurn: {}, activeWorkers: new Set(), sessionLifecycle: {},
  };
}

test('the shadow-build lane against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_lane_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const realBuild = live.buildAndPropose;
  // Every app is live outside a staging copy: the shadow lane is a staging
  // copy's.
  const realEnv = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  t.after(async () => {
    if (realEnv === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = realEnv;
    live.buildAndPropose = realBuild;
    bot._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent, the lane's columns and index included

  const setting = (key, value) => pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value],
  );
  const app = async (slug, repo) => (await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ($1, $1, 'running', $2) RETURNING id, slug`,
    [slug, repo],
  )).rows[0];
  const run = async (appRow, issue, { verdict = 'ready', queuedAgo = null, buildAgo = null, attempts = 0, buildOk = null, buildError = null } = {}) => (await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note,
                                    build_queued_at, build_at, build_attempts, build_ok, build_error)
     VALUES ($1, $2, 'shadow', $3, 'build it',
             CASE WHEN $4::int IS NULL THEN NULL ELSE NOW() - make_interval(secs => $4::int) END,
             CASE WHEN $5::int IS NULL THEN NULL ELSE NOW() - make_interval(secs => $5::int) END,
             $6, $7, $8)
     RETURNING id`,
    [appRow.id, issue, verdict, queuedAgo, buildAgo, attempts, buildOk, buildError],
  )).rows[0].id;
  const row = async (id) => (await pool.query(
    'SELECT build_queued_at, build_at, build_ok, build_error, build_attempts, build_branch FROM homeroom_bot_runs WHERE id = $1', [id],
  )).rows[0];

  await setting('homeroom_bot_mode', 'shadow');
  await setting(bot.KEY_SHADOW_BUILDS, 'on');
  await setting(bot.KEY_BUILD_CONCURRENCY, '2');
  await setting('homeroom_bot_paused_apps', '["paused-app"]');

  const todo = await app('todo', 'https://github.com/usernode-bot/todo');
  const notes = await app('notes', 'https://github.com/usernode-bot/notes');
  const paused = await app('paused-app', 'https://github.com/usernode-bot/paused');
  const platform = await app('homeroom', 'https://github.com/Usernode-Labs/social-vibecoding');

  const gates = new Map();
  const builtFor = [];
  live.buildAndPropose = async (args) => {
    builtFor.push(`${args.app.slug}#${args.issueNumber}`);
    assert.equal(args.propose, false);
    await new Promise((resolve) => gates.set(`${args.app.slug}#${args.issueNumber}`, resolve));
    return { ok: true, sessionId: null, branchName: `dev/b-${args.app.slug}-${args.issueNumber}`, sha: 'a'.repeat(40), commits: 1, costUsd: 0.01 };
  };

  await t.test('the claim: one per app before any gets a second, oldest first, the free slots only, paused apps waiting', async () => {
    bot._resetForTests();
    const todo1 = await run(todo, 1, { queuedAgo: 300 });
    const todo2 = await run(todo, 2, { queuedAgo: 200 });
    const notes3 = await run(notes, 3, { queuedAgo: 100 });
    const paused4 = await run(paused, 4, { queuedAgo: 400 });

    const first = await bot.drainBuilds(pool, {}, deps());
    assert.equal(first.started, 2);
    await waitFor(() => gates.has('todo#1') && gates.has('notes#3'), 'both claimed builds should start');
    assert.deepEqual(builtFor.sort(), ['notes#3', 'todo#1'], 'notes#3 goes ahead of the older todo#2, todo\'s second; the paused app waits');
    assert.equal((await row(todo1)).build_attempts, 1);
    assert.equal((await row(todo2)).build_at, null);
    assert.equal((await row(paused4)).build_at, null);

    const full = await bot.drainBuilds(pool, {}, deps());
    assert.equal(full.started, 0, 'both slots are taken');

    gates.get('todo#1')();
    await waitFor(() => !bot._buildsInFlightForTests().includes(todo1), 'the completed build should release its slot');
    const done = await row(todo1);
    assert.equal(done.build_ok, true);
    assert.equal(done.build_branch, 'dev/b-todo-1');

    const next = await bot.drainBuilds(pool, {}, deps());
    assert.equal(next.started, 1, 'todo is free again');
    await waitFor(() => gates.has('todo#2'), 'the next build should start after its app is free');
    assert.ok(builtFor.includes('todo#2'));
    gates.get('notes#3')();
    gates.get('todo#2')();
    await bot._awaitBuildsForTests();
    assert.equal((await row(notes3)).build_ok, true);
    assert.equal((await row(todo2)).build_ok, true);
  });

  await t.test('an app alone in the queue fills every idle slot; a newcomer goes ahead of its next', async () => {
    bot._resetForTests();
    builtFor.length = 0;
    const todo5 = await run(todo, 5, { queuedAgo: 300 });
    const todo6 = await run(todo, 6, { queuedAgo: 200 });
    const todo7 = await run(todo, 7, { queuedAgo: 150 });

    const first = await bot.drainBuilds(pool, {}, deps());
    assert.equal(first.started, 2, 'no other app wants a slot, so todo takes both');
    await waitFor(() => gates.has('todo#5') && gates.has('todo#6'), 'both of todo\'s oldest builds should start');
    assert.equal((await row(todo7)).build_at, null, 'the third waits for a slot');

    const notes8 = await run(notes, 8, { queuedAgo: 10 });
    gates.get('todo#5')();
    await waitFor(() => !bot._buildsInFlightForTests().includes(todo5), 'the completed build should release its slot');
    const next = await bot.drainBuilds(pool, {}, deps());
    assert.equal(next.started, 1);
    await waitFor(() => gates.has('notes#8'), 'notes\' first build should take the free slot');
    assert.equal((await row(todo7)).build_at, null, 'todo already has one under way, so the newer notes#8 goes first');

    gates.get('todo#6')();
    await waitFor(() => !bot._buildsInFlightForTests().includes(todo6), 'the completed build should release its slot');
    const last = await bot.drainBuilds(pool, {}, deps());
    assert.equal(last.started, 1);
    await waitFor(() => gates.has('todo#7'), 'todo#7 should start once a slot is free');
    gates.get('notes#8')();
    gates.get('todo#7')();
    await bot._awaitBuildsForTests();
    for (const id of [todo5, todo6, todo7, notes8]) assert.equal((await row(id)).build_ok, true);
    // Out of the way of the dashboard counts below.
    await pool.query('DELETE FROM homeroom_bot_runs WHERE id = ANY($1::int[])', [[todo5, todo6, todo7, notes8]]);
  });

  await t.test('a closed issue is skipped with its reason, and not built', async () => {
    bot._resetForTests();
    const closed = await run(notes, 99, { queuedAgo: 10 });
    const out = await bot.drainBuilds(pool, {}, deps());
    assert.equal(out.started, 1);
    await bot._awaitBuildsForTests();
    const r = await row(closed);
    assert.equal(r.build_queued_at, null);
    assert.equal(r.build_at, null);
    assert.equal(r.build_ok, null);
    assert.equal(r.build_error, 'skipped: the issue is no longer open');
    assert.ok(!builtFor.includes('notes#99'));
  });

  await t.test('a build an earlier process never finished is retried once, then recorded failed', async () => {
    bot._resetForTests();
    await setting('homeroom_bot_turn_seconds', '60');
    const once = await run(todo, 30, { queuedAgo: 5000, buildAgo: 4000, attempts: 1 });
    const twice = await run(notes, 31, { queuedAgo: 5000, buildAgo: 4000, attempts: 2 });
    const fresh = await run(paused, 32, { queuedAgo: 60, buildAgo: 30, attempts: 1 });
    // Past one turn and the margin (660s), but inside the longest a build
    // can take: a platform build's doubled spec and turn (#3396), 1920s.
    const platformLong = await run(paused, 33, { queuedAgo: 2000, buildAgo: 1500, attempts: 1 });
    // Long past any bound, but its worker outlived a restart and recovery
    // still owns the turn (#3401): the session carries it in flight.
    const recovering = await run(paused, 34, { queuedAgo: 9000, buildAgo: 8000, attempts: 1 });
    const { rows: [owner] } = await pool.query(
      `INSERT INTO users (username, password) VALUES ('recovery-owner', 'x') RETURNING id`,
    );
    const { rows: [inFlight] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, active_turn)
       VALUES ($1, $2, 'active', '{"mode":"build","journal":"/j.log"}'::jsonb) RETURNING id`,
      [paused.id, owner.id],
    );
    await pool.query('UPDATE homeroom_bot_runs SET build_session_id = $2 WHERE id = $1', [recovering, inFlight.id]);
    // Paused apps never start, so this pass only releases.
    await setting(bot.KEY_SHADOW_BUILDS, 'on');
    await setting(bot.KEY_BUILD_CONCURRENCY, '1');
    const realLimits = deps();
    realLimits.limits.checkBudget = async () => ({ error: 'hold' });
    const out = await bot.drainBuilds(pool, {}, realLimits);
    assert.equal(out.released, 2);
    const r1 = await row(once);
    assert.equal(r1.build_at, null, 'back in the queue');
    assert.equal(r1.build_ok, null);
    const r2 = await row(twice);
    assert.equal(r2.build_ok, false);
    assert.equal(r2.build_error, 'interrupted: the build never finished');
    assert.notEqual((await row(fresh)).build_at, null, 'one inside its time is left alone');
    assert.notEqual((await row(platformLong)).build_at, null, 'a platform build on its doubled clocks is left alone');
    assert.notEqual((await row(recovering)).build_at, null, 'a build restart recovery is finishing is left to it');
    await setting(bot.KEY_BUILD_CONCURRENCY, '2');
    await setting('homeroom_bot_turn_seconds', '1200');
    await pool.query('UPDATE homeroom_bot_runs SET build_queued_at = NULL, build_at = NULL WHERE id = ANY($1::int[])', [[once, fresh, platformLong, recovering]]);
  });

  await t.test('the supersede drops only a queued, unstarted build of the same issue', async () => {
    const older = await run(todo, 40, { queuedAgo: 50 });
    const started = await run(todo, 41, { queuedAgo: 50, buildAgo: 10 });
    const newer = await run(todo, 40, { verdict: 'question' });
    await bot.supersedeQueuedBuilds(pool, { appId: todo.id, issueNumber: 40, runId: newer });
    await bot.supersedeQueuedBuilds(pool, { appId: todo.id, issueNumber: 41, runId: newer + 1 });
    const r = await row(older);
    assert.equal(r.build_queued_at, null);
    assert.match(r.build_error, /^superseded/);
    assert.notEqual((await row(started)).build_queued_at, null, 'a build under way is not dropped');
    await pool.query('UPDATE homeroom_bot_runs SET build_queued_at = NULL, build_at = NULL WHERE id = $1', [started]);
  });

  await t.test('"Triage this app again" queues every open issue of a live app, oldest first, as the loop takes new ones (#3480)', async () => {
    const shop = await app('shop', 'https://github.com/usernode-bot/shop');
    const issues = [
      { number: 7, state: 'open', createdAt: '2026-09-03T00:00:00Z', updatedAt: '2026-09-03T00:00:00Z' },
      { number: 3, state: 'open', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z' },
      { number: 5, state: 'open', createdAt: '2026-09-02T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z' },
      { number: 9, state: 'closed', createdAt: '2026-09-04T00:00:00Z', updatedAt: '2026-09-04T00:00:00Z' },
      { number: 11, state: 'open', createdAt: '2026-09-06T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z' },
      { number: 13, state: 'open', createdAt: '2026-09-07T00:00:00Z', updatedAt: '2026-09-07T00:00:00Z' },
    ];
    const github = { async fetchPublicIssues() { return { issues }; } };
    const queue = async () => (await pool.query(
      `SELECT issue_number, priority, reason, started_at, thread_seen_at
         FROM homeroom_bot_queue WHERE app_id = $1 ORDER BY priority, enqueued_at`, [shop.id],
    )).rows;

    assert.equal((await bot.retriageApp(pool, { slug: 'shop', deps: { github } })).status, 409, 'a staging copy never acts: nothing is queued');
    assert.deepEqual(await queue(), []);

    // Outside a staging copy every app but a paused one is live.
    const env = process.env.USERNODE_ENV;
    delete process.env.USERNODE_ENV;
    try {
      // #11 is somebody's: a person claimed it. #13 is the one the bot is on now.
      const { rows: [person] } = await pool.query(
        `INSERT INTO users (username, password) VALUES ('shopkeeper', 'x') RETURNING id`,
      );
      await pool.query('INSERT INTO issue_claims (app_id, github_issue_number, user_id) VALUES ($1, 11, $2)', [shop.id, person.id]);
      await pool.query(
        `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, started_at)
         VALUES ($1, 13, 2, 'new', NOW())`, [shop.id],
      );

      const out = await bot.retriageApp(pool, { slug: 'shop', deps: { github } });
      assert.equal(out.ok, true);
      assert.deepEqual(out.left, { busy: 1, closed: 1 });
      const rows = await queue();
      const waiting = rows.filter((r) => !r.started_at);
      assert.deepEqual(waiting.map((r) => r.issue_number), [3, 5, 7], 'oldest first, closed and claimed left out');
      assert.ok(waiting.every((r) => r.priority === 0 && r.reason === 'app_again'), 'kept by the refresh, like a Run now');
      assert.equal(new Date(waiting[0].thread_seen_at).toISOString(), '2026-09-05T00:00:00.000Z', 'seen as of its last change, so it is not queued again after');
      const onNow = rows.find((r) => r.issue_number === 13);
      assert.ok(onNow.started_at, 'the row the bot is on is left alone');
      assert.equal(onNow.reason, 'new');
      assert.equal(out.queued, 4, 'the one in progress is counted but not touched');

      await setting('homeroom_bot_paused_apps', '["paused-app","shop"]');
      assert.equal((await bot.retriageApp(pool, { slug: 'shop', deps: { github } })).status, 409, 'not while paused');
      await setting('homeroom_bot_paused_apps', '["paused-app"]');
    } finally {
      process.env.USERNODE_ENV = env;
    }
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1', [shop.id]);
  });

  await t.test('the dashboard counts and the export read the lane columns', async () => {
    // What waits in the lane is set here: only the finished builds of the
    // subtests above stay, and two are queued, one per app.
    await pool.query('DELETE FROM homeroom_bot_runs WHERE build_ok IS NULL');
    await run(notes, 51, { queuedAgo: 60 });
    await run(todo, 52, { queuedAgo: 60 });
    const summary = await bot.buildLaneSummary(pool);
    assert.equal(summary.queued, 2);
    assert.equal(summary.built, 3);
    assert.equal(summary.failed, 1);
    assert.equal(summary.building, 0);
    assert.ok(Math.abs(summary.costUsd - 0.03) < 1e-9);
    const rows = [];
    for await (const chunk of bot.iterateRunsForExport(pool, { app: 'notes' })) rows.push(...chunk);
    assert.ok(rows.length > 0);
    assert.ok('build_queued_at' in rows[0]);
  });

  await t.test('a live build is recorded in the same columns, and the lane never counts it (#3509)', async () => {
    const before = await bot.buildLaneSummary(pool);
    const liveRun = async (issue) => (await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, build_spec_md)
       VALUES ($1, $2, 'live', 'ready', 'build it', 'the spec') RETURNING id`, [todo.id, issue],
    )).rows[0].id;
    const proposed = await liveRun(801);
    await bot.recordLiveBuild(pool, proposed, {
      ok: true, sessionId: null, branchName: 'homeroom_bot/s1', sha: 'c'.repeat(40), commits: 3, costUsd: 0.4,
    });
    const blocked = await liveRun(802);
    await bot.recordLiveBuild(pool, blocked, {
      ok: false, blocked: 'no image generation', costUsd: 0.05,
      specNote: 'no spec (x); the build worked from the plan',
    });
    const { rows: [p] } = await pool.query(
      `SELECT build_ok, build_error, build_branch, build_sha, build_commits, build_cost_usd::float8 AS cost,
              build_spec_md, build_at, build_queued_at
         FROM homeroom_bot_runs WHERE id = $1`, [proposed],
    );
    assert.deepEqual(
      { ...p },
      { build_ok: true, build_error: null, build_branch: 'homeroom_bot/s1', build_sha: 'c'.repeat(40), build_commits: 3,
        cost: 0.4, build_spec_md: 'the spec', build_at: null, build_queued_at: null },
      'the spec already on the run is kept; the lane\'s own markers stay empty',
    );
    assert.equal((await row(blocked)).build_error, 'blocked: no image generation; no spec (x); the build worked from the plan');
    assert.equal((await row(blocked)).build_ok, false);
    assert.deepEqual(await bot.buildLaneSummary(pool), before, 'the shadow lane\'s counts and cost are its own');
  });
});
