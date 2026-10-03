'use strict';

// A live build always records what became of it, against the FULL
// PostgreSQL schema.
//
// Run 613 (recipebot #48, 2026-10-01): a live build had its session
// (build_session_id 5658), the session ended archived with no commits, and
// the run had no build_ok and no build_error, with nothing said on the
// issue. What happened: a redeploy interrupted the build before it had
// committed anything, and restart recovery (#3471) did what it does for a
// spec turn or a lost turn: archived the session and sent the issue back to
// be triaged again (requeueForRestart). It recorded nothing on the run, and
// the wake it sent started a refresh that read the issue as unchanged since
// that same run and deleted the restart's queue row before any pass took
// it. So the issue was never looked at again, and the run stayed a build
// with a session and no outcome.
//
// Pinned here, through the real planner:
//   - the restart row survives the refresh while its issue is open and
//     nobody else's, and recovery records the interruption on the run;
//   - the backstop: a live build nothing finished (no recovery ever saw it)
//     is recorded failed and said on the issue once, unless the issue moved
//     on or the outcome was already said.
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

// What the issue looked like when run 613 read it: nothing on it since.
const SEEN = '2026-09-30T16:43:12Z';

test('a live build always records its outcome, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_live_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const real = { post: live.post, advanceSeen: live.advanceSeen, mentionTargets: live.mentionTargets };
  t.after(async () => {
    Object.assign(live, real);
    bot._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent, checks_head_sha and the new indexes included

  const setting = (key, value) => pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value],
  );
  await setting('homeroom_bot_mode', 'shadow');
  await setting('homeroom_bot_live_apps', JSON.stringify(['recipebot']));
  const { rows: [botUser] } = await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id, username`,
  );
  const app = async (slug) => (await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ($1, $1, 'running', $2) RETURNING id, slug, name, repo_url`,
    [slug, `https://github.com/usernode-bot/${slug}`],
  )).rows[0];
  const recipebot = await app('recipebot');
  const quiet = await app('quiet-app'); // not live

  const session = async (appRow, { status = 'active', activeTurn = null } = {}) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues, active_turn)
     VALUES ($1, $2, $3, $4, FALSE, '{}', $5) RETURNING id`,
    [appRow.id, botUser.id, `dev/homeroom_bot-${crypto.randomBytes(3).toString('hex')}`, status,
      activeTurn ? JSON.stringify(activeTurn) : null],
  )).rows[0].id;
  const liveRun = async (appRow, issue, sessionId, { ago = 3 * 3600 } = {}) => (await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, thread_seen_at,
                                    build_session_id, created_at)
     VALUES ($1, $2, 'live', 'ready', 'build it', $3, $4, NOW() - make_interval(secs => $5))
     RETURNING id`,
    [appRow.id, issue, SEEN, sessionId, ago],
  )).rows[0].id;
  const runRow = async (id) => (await pool.query(
    'SELECT build_ok, build_error, proposal_session_id FROM homeroom_bot_runs WHERE id = $1', [id],
  )).rows[0];
  const statusOf = async (id) => (await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [id])).rows[0].status;
  const queueRows = async () => (await pool.query(
    'SELECT issue_number, reason FROM homeroom_bot_queue WHERE app_id = $1 ORDER BY issue_number', [recipebot.id],
  )).rows;

  const issues = (numbers) => ({
    async fetchPublicIssues() {
      return { issues: numbers.map((n) => ({ number: n, state: 'open', createdAt: SEEN, updatedAt: SEEN })) };
    },
  });
  const noSpend = { managedOpenRouter: { async usesIncludedKey() { return false; } }, limits: {} };

  await t.test('run 613: a restart interrupts the build; recovery records it, and the issue is triaged again', async () => {
    bot._resetForTests();
    const sessionId = await session(recipebot);
    const runId = await liveRun(recipebot, 48, sessionId, { ago: 600 });

    // The worker went with the restart: recovery notes the live build ...
    assert.equal(await bot.abandonRecoveredTurn({ pool, session: { id: sessionId }, why: 'the worker is gone' }), 'live_pending');
    // ... and, once the session is free, sends the issue round again.
    assert.equal(await bot.completeRecoveredLive({ pool, config: {}, sessionId, deps: noSpend }), 'requeued');
    assert.equal(await statusOf(sessionId), 'archived');
    const recorded = await runRow(runId);
    assert.equal(recorded.build_ok, false, 'the run says what became of its build');
    assert.match(recorded.build_error, /^interrupted: the worker is gone by a restart; the issue was sent back to be triaged again$/);
    assert.deepEqual(await queueRows(), [{ issue_number: 48, reason: bot.RESTART_REASON }]);

    // The wake's refresh reads #48 as unchanged since run 613. Before, it
    // deleted the restart's row here, and the issue was never looked at.
    // A refresh's own row for an unchanged issue (#49) still goes.
    await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason) VALUES ($1, 49, 2, 'changed')`, [recipebot.id],
    );
    await liveRun(recipebot, 49, null, { ago: 600 });
    const out = await bot.refreshApp(pool, recipebot, {
      github: issues([48, 49]), bot: botUser, capRoom: { proposals_per_app: 5, proposals_total: 5, question_tripwire: 10 },
    });
    assert.equal(out.removed, 1);
    assert.deepEqual(await queueRows(), [{ issue_number: 48, reason: bot.RESTART_REASON }],
      'the restart row is kept, reason and all, so the retriage does not say "looking" twice');

    // Activity on the issue keeps the reason too.
    await pool.query('UPDATE homeroom_bot_runs SET thread_seen_at = $2 WHERE id = $1', [runId, '2026-09-01T00:00:00Z']);
    await bot.refreshApp(pool, recipebot, { github: issues([48]), bot: botUser, capRoom: { proposals_per_app: 5 } });
    assert.deepEqual(await queueRows(), [{ issue_number: 48, reason: bot.RESTART_REASON }]);

    // Somebody else's (a person claimed it) or closed: it goes.
    const { rows: [ada] } = await pool.query(`INSERT INTO users (username, password) VALUES ('ada', 'x') RETURNING id`);
    await pool.query(
      'INSERT INTO issue_claims (app_id, github_issue_number, user_id) VALUES ($1, 48, $2)', [recipebot.id, ada.id],
    );
    await bot.refreshApp(pool, recipebot, { github: issues([48]), bot: botUser });
    assert.deepEqual(await queueRows(), [], 'the bot never competes with a person who started');
    await pool.query('DELETE FROM issue_claims');
    await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason) VALUES ($1, 48, 1, $2)`,
      [recipebot.id, bot.RESTART_REASON],
    );
    await bot.refreshApp(pool, recipebot, { github: issues([]), bot: botUser });
    assert.deepEqual(await queueRows(), [], 'a closed issue is not triaged again');
    await pool.query('DELETE FROM homeroom_bot_runs');
  });

  await t.test('the backstop: a live build nothing finished is recorded, and said once', async () => {
    bot._resetForTests();
    const posts = [];
    live.post = async (args) => { posts.push(args); return { postId: posts.length, githubCreatedAt: '2026-10-02T09:00:00Z' }; };
    live.advanceSeen = async () => ({ advanced: true });
    live.mentionTargets = async () => ['cyrcle_0'];
    const deps = {
      github: {
        isEnabled: () => true,
        getBotUsername: async () => 'usernode-bot',
        async fetchPublicIssue(_o, _r, n) { return { issue: { number: n, title: `Issue ${n}`, state: n === 60 ? 'closed' : 'open' } }; },
        async fetchIssueComments() { return { comments: [] }; },
      },
      ws: {}, sessionLifecycle: {}, domain: 'app.onhomeroom.com', threadContext: { async loadIssueThread() { return { messages: [] }; } },
    };
    const settings = await bot.readSettings(pool);

    // The 613 shape, with nothing ever recovered: archived, no outcome.
    const lost = await liveRun(recipebot, 48, await session(recipebot, { status: 'archived' }));
    // Its session left active, as a restart that took the worker leaves it.
    const leftActiveSession = await session(recipebot);
    const leftActive = await liveRun(recipebot, 51, leftActiveSession);
    // A newer run on its issue speaks for it.
    const superseded = await liveRun(recipebot, 52, await session(recipebot, { status: 'archived' }));
    await liveRun(recipebot, 52, null, { ago: 60 });
    // Its outcome was said before #3509 recorded outcomes.
    const said = await liveRun(recipebot, 53, await session(recipebot, { status: 'archived' }));
    await pool.query(
      `INSERT INTO homeroom_bot_posts (app_id, issue_number, run_id, kind) VALUES ($1, 53, $2, 'build_failed')`, [recipebot.id, said],
    );
    // A proposal after all: the process died between the promote and its post.
    const proposedSession = await session(recipebot, { status: 'promoted' });
    const proposed = await liveRun(recipebot, 54, proposedSession);
    // An app the bot is no longer live on, and a closed issue: recorded only.
    const notLive = await liveRun(quiet, 55, await session(quiet, { status: 'archived' }));
    const closed = await liveRun(recipebot, 60, await session(recipebot, { status: 'archived' }));
    // Left alone: a build that may still be running, one recovery still
    // follows, and one recovery has noted.
    const recent = await liveRun(recipebot, 56, await session(recipebot), { ago: 600 });
    const following = await liveRun(recipebot, 57, await session(recipebot, { activeTurn: { mode: 'build' } }));
    const notedSession = await session(recipebot);
    const noted = await liveRun(recipebot, 58, notedSession);
    await bot.abandonRecoveredTurn({ pool, session: { id: notedSession }, why: 'the worker is gone' });

    assert.equal(await bot.settleAbandonedLiveBuilds(pool, settings, deps), 7);
    for (const id of [lost, leftActive, superseded, notLive, closed]) {
      assert.deepEqual(await runRow(id), { build_ok: false, build_error: bot.ABANDONED_LIVE_ERROR, proposal_session_id: null }, `run ${id}`);
    }
    assert.match((await runRow(said)).build_error, /^not recorded when it ended; the issue was told: build_failed$/);
    assert.deepEqual(await runRow(proposed), { build_ok: true, build_error: null, proposal_session_id: proposedSession });
    for (const id of [recent, following, noted]) assert.equal((await runRow(id)).build_ok, null, `run ${id} is left alone`);
    assert.equal(await statusOf(leftActiveSession), 'archived', 'its session is put away');
    assert.equal(await statusOf(proposedSession), 'promoted', 'a proposal is never archived by this');

    assert.deepEqual(posts.map((p) => p.issueNumber).sort(), [48, 51], 'said once each, only where nothing else speaks');
    for (const p of posts) {
      assert.equal(p.kind, 'build_failed');
      assert.equal(p.sender.id, botUser.id);
      assert.match(p.text, /^Homeroom bot tried to build this but couldn't finish: the platform restarted while it was building, and the build was lost\./);
      assert.deepEqual(p.dm, { reason: bot.ABANDONED_LIVE_REASON }, 'in the requester\'s DM too');
      assert.deepEqual(p.mentions, ['cyrcle_0'], 'whoever filed it is told');
    }

    // Once: a second sweep (another Pod, the next pass) records and says nothing.
    posts.length = 0;
    assert.equal(await bot.settleAbandonedLiveBuilds(pool, settings, deps), 0);
    assert.equal(posts.length, 0);
  });

  await t.test('the sweep waits out the longest a build can take', () => {
    const seconds = bot.abandonedLiveAfterSeconds({ turnSeconds: 1200 });
    assert.equal(seconds, bot.PLATFORM_BUILD_TIME_FACTOR * (1200 + live.SPEC_TURN_MAX_MS / 1000) + 600);
    assert.ok(seconds < 3 * 3600, 'the fixtures above are past it');
  });

  await t.test('a ready verdict waits on its run for its project\'s build slot, and a newer verdict replaces it', async () => {
    const waiting = async (issue) => (await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, thread_seen_at)
       VALUES ($1, $2, 'live', 'ready', 'build it', $3) RETURNING id`,
      [recipebot.id, issue, SEEN],
    )).rows[0].id;
    const first = await waiting(80);
    await bot.queueLiveBuild(pool, { runId: first, appId: recipebot.id });
    const second = await waiting(81);
    await bot.queueLiveBuild(pool, { runId: second, appId: recipebot.id });
    const quietRun = (await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, live_build_waiting_at)
       VALUES ($1, 82, 'live', 'ready', 'x', NOW()) RETURNING id`, [quiet.id],
    )).rows[0].id;
    const candidates = await bot.liveBuildCandidates(pool, { liveSlugs: ['recipebot'] });
    assert.deepEqual(candidates.map((c) => Number(c.id)), [first, second], 'oldest first, only where the bot acts');
    assert.ok(!candidates.some((c) => Number(c.id) === quietRun));
    assert.deepEqual(bot.pickLiveBuilds(candidates, { slots: 6, perPerson: 2 }).map((p) => Number(p.id)), [first],
      'one build per project at a time');
    assert.deepEqual(await bot.liveBuildCandidates(pool, { liveSlugs: ['recipebot'], pausedApps: ['recipebot'] }), []);

    // A newer verdict on #81 (someone replied while it waited): the old wait is not built.
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note) VALUES ($1, 81, 'live', 'question', 'x')`,
      [recipebot.id],
    );
    assert.deepEqual((await bot.liveBuildCandidates(pool, { liveSlugs: ['recipebot'] })).map((c) => Number(c.id)), [first]);
    // Its session exists: restart recovery owns it, and it no longer waits.
    const sessionId = await session(recipebot);
    await pool.query('UPDATE homeroom_bot_runs SET build_session_id = $2, live_build_waiting_at = NULL WHERE id = $1', [first, sessionId]);
    assert.deepEqual(await bot.liveBuildCandidates(pool, { liveSlugs: ['recipebot'] }), []);
  });

  // Plant Pal #1 and #3 (2026-10-03): while a request's build ran, its spec
  // comment moved the issue's updated_at past what the run had recorded as
  // seen. The refresh queued it, the read lane read it again and found it
  // ready, and that second verdict was built and proposed too.
  await t.test('a request is not read again while its build waits or runs, and is never built twice', async () => {
    bot._resetForTests();
    await pool.query('DELETE FROM homeroom_bot_runs');
    await pool.query('DELETE FROM homeroom_bot_queue');
    // The spec comment, after the run's seen marker (SEEN).
    const spec = (numbers) => ({
      async fetchPublicIssues() {
        return { issues: numbers.map((n) => ({ number: n, state: 'open', createdAt: SEEN, updatedAt: '2026-10-03T16:46:40Z' })) };
      },
    });
    const capRoom = { proposals_per_app: 5, proposals_total: 5, question_tripwire: 10 };
    const readable = async () => (await bot.liveCandidates(pool, {
      liveSlugs: ['recipebot'], excludeAppIds: [], pausedApps: [], botId: botUser.id,
    })).map((c) => Number(c.issue_number));

    // Waiting its turn.
    const run = (await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, thread_seen_at, live_build_waiting_at)
       VALUES ($1, 90, 'live', 'ready', 'build it', $2, NOW()) RETURNING id, created_at`,
      [recipebot.id, SEEN],
    )).rows[0];
    let out = await bot.refreshApp(pool, recipebot, { github: spec([90]), bot: botUser, capRoom });
    assert.equal(out.queued, 0, 'its own build is the bot\'s work in progress');
    // Whatever else queues it (Run now, an answer in the DM) waits for the build.
    await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason) VALUES ($1, 90, 0, 'dm_answer')`, [recipebot.id],
    );
    assert.deepEqual(await readable(), []);

    // Under way: its session linked, the wait cleared in the same update.
    const building = await session(recipebot);
    await pool.query('UPDATE homeroom_bot_runs SET build_session_id = $2, live_build_waiting_at = NULL WHERE id = $1', [run.id, building]);
    out = await bot.refreshApp(pool, recipebot, { github: spec([90]), bot: botUser, capRoom });
    assert.equal(out.queued, 0);
    assert.deepEqual(await readable(), []);
    assert.deepEqual(await queueRows(), [{ issue_number: 90, reason: 'dm_answer' }], 'the answer waits for the build');

    // A second verdict that waited anyway (one recorded before this fix) is
    // not built once the first is up for a vote ...
    const second = (await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, live_build_waiting_at)
       VALUES ($1, 90, 'live', 'ready', 'build it', NOW()) RETURNING id, issue_number, build_note, created_at`,
      [recipebot.id],
    )).rows[0];
    await pool.query(
      `UPDATE chat_sessions SET status = 'promoted', promoted_at = NOW(), linked_issues = '{90}' WHERE id = $1`, [building],
    );
    await pool.query('UPDATE homeroom_bot_runs SET build_ok = TRUE, proposal_session_id = $2 WHERE id = $1', [run.id, building]);
    const github = { isEnabled: () => true, async fetchPublicIssue() { return { issue: { number: 90, state: 'open' } }; } };
    const skipped = await bot.buildOne(pool, {}, { bot: botUser, app: recipebot, run: second, settings: {}, deps: { github } });
    assert.deepEqual(skipped, { ran: false, reason: 'has_proposal' });
    const recorded = await runRow(second.id);
    assert.equal(recorded.build_ok, false);
    assert.equal(recorded.build_error, `skipped: the request already has a proposal (${building})`);

    // ... nor once that proposal merged after it.
    await pool.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW() WHERE id = $1`, [building]);
    const third = (await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, live_build_waiting_at, created_at)
       VALUES ($1, 90, 'live', 'ready', 'build it', NOW(), NOW() - INTERVAL '5 minutes') RETURNING id`,
      [recipebot.id],
    )).rows[0];
    // As the lane hands it over: with when its verdict was recorded.
    const [pick] = await bot.liveBuildCandidates(pool, { liveSlugs: ['recipebot'] });
    assert.equal(Number(pick.id), third.id);
    assert.ok(pick.created_at instanceof Date);
    assert.deepEqual(await bot.buildOne(pool, {}, { bot: botUser, app: recipebot, run: pick, settings: {}, deps: { github } }),
      { ran: false, reason: 'has_proposal' });

    // Once nothing of it is waiting or building, it is read again as usual.
    await pool.query('DELETE FROM homeroom_bot_runs WHERE id = ANY($1::int[])', [[second.id, third.id]]);
    out = await bot.refreshApp(pool, recipebot, { github: spec([90]), bot: botUser, capRoom });
    assert.equal(out.queued, 1);
    assert.deepEqual(await readable(), [90]);

    // A build nothing finished, past the window the abandoned-build sweep
    // reads, holds nothing.
    await pool.query('DELETE FROM homeroom_bot_runs');
    await pool.query('DELETE FROM homeroom_bot_queue');
    await liveRun(recipebot, 91, await session(recipebot), { ago: 8 * 24 * 3600 });
    out = await bot.refreshApp(pool, recipebot, { github: spec([91]), bot: botUser, capRoom });
    assert.equal(out.queued, 1);
    assert.deepEqual(await readable(), [91]);
    await pool.query('DELETE FROM homeroom_bot_runs');
    await pool.query('DELETE FROM homeroom_bot_queue');
  });
});
