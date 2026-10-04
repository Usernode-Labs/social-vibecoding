'use strict';

// A project's first version goes first, against the FULL PostgreSQL schema.
//
// Flat 4B Chores, 4 to 5 October 2026: the bot built the project's first
// version (request #1, a chores rota) and put it up for approval. Six
// minutes after the invite, the invitee's idea became request #2, and the
// bot read and built it at once, on `main`: the template's starter, not the
// first version. Its change was a different app altogether ("The starter
// demo screen is gone"), and both were up for approval side by side. Then a
// fix to the first version (#5) was queued to build on the starter too,
// where the button it fixes does not exist.
//
// Pinned here, through the real queries (homeroom-bot.js
// FIRST_VERSION_PENDING_SQL):
//   - while the first version is not live, no other request on the project
//     is read (liveCandidates) and no other build starts
//     (liveBuildCandidates); the request keeps its queue row and its place;
//   - the first version's own request, a follow-up on a change of the
//     bot's already up for a vote, and an admin's Run now are not held;
//   - once the first version merges, the waiting requests come back in
//     their usual order, and the merge wakes the loop for them;
//   - a first version that ended short of a merge holds nothing (filing
//     failed, left to the group, build failed, change closed, request
//     closed, a background look only), and one taken up again holds again;
//   - a project with no first version the bot builds is never held;
//   - what the person reads (homeroom-bot-progress.js requestStates) says
//     what the request waits for.
//
// Like the repository's other postgres tests it skips when no database is
// reachable, unless TEST_DATABASE_URL insists on one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const bot = require('../src/services/homeroom-bot');
const progress = require('../src/services/homeroom-bot-progress');
const logger = require('../src/services/logger');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a project\'s first version goes first, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_fvhold_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  t.after(async () => {
    bot._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ($1, 'x', $2) RETURNING id, username`,
    [username, synthetic],
  )).rows[0];
  const botUser = await user('homeroom_bot', true);
  const maker = await user('ada');
  const invitee = await user('sam');

  const slugs = [];
  // A project, its requests' platform rows, and (unless `firstVersion` is
  // null) the first version the bot builds for its maker.
  const project = async (slug, { firstVersion = {} } = {}) => {
    slugs.push(slug);
    const { rows: [app] } = await pool.query(
      `INSERT INTO apps (name, slug, status, repo_url, created_by) VALUES ($1, $1, 'running', $2, $3)
       RETURNING id, slug, name, repo_url`,
      [slug, `https://github.com/usernode-bot/${slug}`, maker.id],
    );
    for (const n of [1, 2, 3, 5]) {
      await pool.query(
        `INSERT INTO issues (app_id, github_issue_number, title, kind, created_by) VALUES ($1, $2, $3, 'general', $4)`,
        [app.id, n, `#${n}`, n === 1 ? maker.id : invitee.id],
      );
    }
    if (firstVersion) {
      const { status = 'filed', issue = 1, botBuilds = true, createdAgo = '1 hour', filedAgo = '1 hour' } = firstVersion;
      await pool.query(
        `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, status, issue_number, bot_builds, created_at, filed_at)
         VALUES ($1, $2, 'A chores rota for our flat', $3, $4, $5, NOW() - $6::interval,
                 CASE WHEN $3 = 'filed' THEN NOW() - $7::interval END)`,
        [app.id, maker.id, status, status === 'filed' ? issue : null, botBuilds, createdAgo, filedAgo],
      );
      if (status === 'filed') {
        await pool.query(
          `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, first_version)
           VALUES ($1, $2, $3, 'First version', TRUE)`,
          [app.id, issue, maker.id],
        );
      }
    }
    return app;
  };
  const queue = async (app, issue, { priority = 1, reason = 'new', ago = 0 } = {}) => (await pool.query(
    `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, enqueued_at)
     VALUES ($1, $2, $3, $4, NOW() - make_interval(secs => $5)) RETURNING id`,
    [app.id, issue, priority, reason, ago],
  )).rows[0].id;
  const change = async (app, issue, status = 'promoted') => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues)
     VALUES ($1, $2, $3, $4, FALSE, $5::int[]) RETURNING id`,
    [app.id, botUser.id, `dev/homeroom_bot-${crypto.randomBytes(3).toString('hex')}`, status, [issue]],
  )).rows[0].id;
  const run = async (app, issue, {
    mode = 'live', verdict = 'ready', buildOk = null, proposal = null, waiting = false, error = null,
  } = {}) => (await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_ok, proposal_session_id,
                                    live_build_waiting_at, error, build_note)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7 THEN NOW() END, $8, 'build it') RETURNING id`,
    [app.id, issue, mode, verdict, buildOk, proposal, waiting, error],
  )).rows[0].id;
  // The first version built and up for approval: the moment request #2 came.
  const firstVersionProposed = async (app) => {
    const pr = await change(app, 1, 'promoted');
    await run(app, 1, { buildOk: true, proposal: pr });
    return pr;
  };

  const readable = async (app) => (await bot.liveCandidates(pool, {
    liveSlugs: [app.slug], excludeAppIds: [], pausedApps: [], busyAppIds: [], botId: botUser.id,
  })).map((r) => Number(r.issue_number));
  const buildable = async (app) => (await bot.liveBuildCandidates(pool, { liveSlugs: [app.slug] }))
    .map((r) => Number(r.issue_number));
  const holds = async (app) => bot.firstVersionHolds(pool, [app.id]);
  const held = async (app) => (await holds(app)).has(Number(app.id));

  await t.test('Flat 4B Chores: with the first version up for approval, the other requests wait in their places', async () => {
    const app = await project('flat-4b-chores');
    const pr = await firstVersionProposed(app);
    const idea = await queue(app, 2, { priority: 1, reason: 'new', ago: 600 });
    const fix = await queue(app, 5, { priority: 0, reason: 'chat_request', ago: 60 });

    assert.deepEqual(await holds(app), new Map([[Number(app.id), 1]]), 'held by request #1, the first version');
    assert.deepEqual(await readable(app), [], 'neither the idea nor the fix is read on the starter');
    const { rows: still } = await pool.query(
      'SELECT id, started_at FROM homeroom_bot_queue WHERE app_id = $1 ORDER BY id', [app.id],
    );
    assert.deepEqual(still.map((r) => Number(r.id)), [idea, fix], 'both keep their queue rows: waiting, not dropped');
    assert.ok(still.every((r) => r.started_at === null), 'and nothing claimed them');

    // A ready request whose build had not started yet waits too.
    await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [idea]);
    await run(app, 2, { waiting: true });
    assert.deepEqual(await buildable(app), [], 'no build on the starter starts');

    // What the people it is for read: the card, the tray, "how far along?".
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, 2, $2, 'Bin day'), ($1, 5, $2, 'Mark as done')`,
      [app.id, invitee.id],
    );
    const settings = { mode: 'shadow', liveApps: [app.slug], perPerson: 2 };
    const states = await progress.requestStates(pool, { userId: invitee.id, settings });
    const byNumber = new Map(states.filter((s) => Number(s.row.app_id) === Number(app.id))
      .map((s) => [Number(s.row.issue_number), s.state]));
    assert.equal(byNumber.get(5).stage, 'queued');
    assert.equal(byNumber.get(5).doing, progress.FIRST_VERSION_WAIT);
    assert.deepEqual(byNumber.get(5).waitingFor, { reason: 'first_version_pending', number: 1 });
    assert.equal(byNumber.get(2).stage, 'build_queued');
    assert.equal(byNumber.get(2).doing, progress.FIRST_VERSION_BUILD_WAIT);
    assert.deepEqual(byNumber.get(2).waitingFor, { reason: 'first_version_pending', number: 1 });

    // The first version merges: the waiting requests come back in their
    // usual order, and the merge wakes the loop for them.
    const said = [];
    const realInfo = logger.info;
    logger.info = (cat, msg, data) => { said.push({ msg, data }); };
    try {
      await pool.query(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW() WHERE id = $1`, [pr]);
      const out = await bot.noteRequestMerged(pool, { id: pr }, { worker: { async stopTurn() {} } });
      assert.deepEqual(out, { skipped: 0, stopped: 0, withdrawn: 0, dequeued: 0 }, 'what it returns is unchanged');
    } finally {
      logger.info = realInfo;
    }
    assert.ok(said.some((s) => /first version is live; what waited for it is picked up now/.test(s.msg)
      && s.data.issueNumber === 1), 'the loop is woken for what waited');
    assert.equal(await held(app), false);
    assert.deepEqual(await readable(app), [5], 'the fix is read now, on the new main');
    assert.deepEqual(await buildable(app), [2], 'and the idea\'s build starts');
    const after = await progress.requestStates(pool, { userId: invitee.id, settings });
    const fixState = after.find((s) => Number(s.row.app_id) === Number(app.id) && Number(s.row.issue_number) === 5).state;
    assert.notEqual(fixState.doing, progress.FIRST_VERSION_WAIT, 'and it no longer says it waits for the first version');
    assert.equal(fixState.waitingFor?.reason === 'first_version_pending', false);
  });

  await t.test('what is not held: the first version itself, a follow-up on a change already up, an admin\'s Run now', async () => {
    const app = await project('not-held');
    await queue(app, 2, { ago: 300 });
    await queue(app, 1, { ago: 100 });
    assert.deepEqual(await readable(app), [1], 'the first version is read; the request behind it waits');

    // A request whose change of the bot's is already up for a vote (PR 4,
    // in flight when this shipped): what people say on it is followed up.
    await change(app, 3, 'promoted');
    await queue(app, 3, { reason: 'changed', priority: 2 });
    assert.deepEqual((await readable(app)).sort(), [1, 3]);

    // An admin's Run now is theirs to decide.
    await pool.query(`UPDATE homeroom_bot_queue SET priority = 0, reason = 'admin' WHERE app_id = $1 AND issue_number = 2`, [app.id]);
    assert.deepEqual((await readable(app)).sort(), [1, 2, 3]);

    // The first version's own build is never held.
    await run(app, 1, { waiting: true });
    assert.deepEqual(await buildable(app), [1]);
  });

  await t.test('a project with no first version the bot builds is never held', async () => {
    const imported = await project('imported', { firstVersion: null });
    await queue(imported, 2);
    assert.equal(await held(imported), false);
    assert.deepEqual(await readable(imported), [2]);

    const forTheGroup = await project('for-the-group', { firstVersion: { botBuilds: false } });
    await queue(forTheGroup, 2);
    assert.equal(await held(forTheGroup), false, 'a first version left to the group: nobody may ever build it');
    assert.deepEqual(await readable(forTheGroup), [2]);
  });

  await t.test('while the project is set up, for a day at most', async () => {
    const fresh = await project('setting-up', { firstVersion: { status: 'waiting', createdAgo: '10 minutes' } });
    await queue(fresh, 2);
    assert.deepEqual(await holds(fresh), new Map([[Number(fresh.id), null]]), 'not filed yet: nothing has its number');
    assert.deepEqual(await readable(fresh), []);

    const stuck = await project('stuck-filing', { firstVersion: { status: 'filing', createdAgo: '2 days' } });
    await queue(stuck, 2);
    assert.equal(await held(stuck), false, 'a filing stuck past a day holds nothing');

    const failed = await project('filing-failed', { firstVersion: { status: 'failed', createdAgo: '10 minutes' } });
    await queue(failed, 2);
    assert.equal(await held(failed), false, 'nor one that could not be filed');
  });

  await t.test('filed and not looked at yet: held for the day it takes to be picked up, not for ever', async () => {
    const fresh = await project('just-filed', { firstVersion: { filedAgo: '2 minutes' } });
    assert.equal(await held(fresh), true);
    const old = await project('never-looked-at', { firstVersion: { filedAgo: '3 days', createdAgo: '3 days' } });
    await queue(old, 2);
    assert.equal(await held(old), false, 'a first version nothing ever looked at (it predates the bot acting on it) holds nothing');
    await queue(old, 1);
    assert.equal(await held(old), true, 'until a look at it is queued');
  });

  await t.test('a first version that ended short of a merge holds nothing; taken up again, it holds again', async () => {
    const ended = async (slug, setup) => {
      const app = await project(slug);
      await queue(app, 2);
      await setup(app);
      return app;
    };
    const closed = await ended('change-closed', async (app) => {
      const pr = await change(app, 1, 'closed');
      await run(app, 1, { buildOk: true, proposal: pr });
    });
    assert.equal(await held(closed), false, 'its change was closed without going live');

    const withdrawn = await ended('change-archived', async (app) => {
      const pr = await change(app, 1, 'archived');
      await run(app, 1, { buildOk: true, proposal: pr });
      await run(app, 1, { verdict: 'answer' });
    });
    assert.equal(await held(withdrawn), false, 'withdrawn, after a follow-up on it');

    const buildFailed = await ended('build-failed', (app) => run(app, 1, { buildOk: false }));
    assert.equal(await held(buildFailed), false, 'its build did not succeed');

    const leftToGroup = await ended('left-to-group', (app) => run(app, 1, { verdict: 'person' }));
    assert.equal(await held(leftToGroup), false, 'the bot left it for the group');

    const nothing = await ended('nothing-to-build', (app) => run(app, 1, { verdict: 'empty' }));
    assert.equal(await held(nothing), false);

    const lookFailed = await ended('look-failed', (app) => run(app, 1, { verdict: 'failed', buildOk: null }));
    assert.equal(await held(lookFailed), false, 'its look failed and nobody has taken it up again');
    await queue(lookFailed, 1);
    assert.equal(await held(lookFailed), true, 'a look at it queued again (a reply, Try again): held again');

    const background = await ended('background-only', (app) => run(app, 1, { mode: 'shadow' }));
    assert.equal(await held(background), false, 'looked at only in the background: the bot is not building it');

    const closedRequest = await ended('request-closed', async (app) => {
      await run(app, 1, { verdict: 'question' });
      await pool.query(`UPDATE issues SET status = 'closed' WHERE app_id = $1 AND github_issue_number = 1`, [app.id]);
    });
    assert.equal(await held(closedRequest), false, 'its request was closed on the platform');

    const mergedByAPerson = await ended('merged-by-a-person', async (app) => {
      await pool.query(
        `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues)
         VALUES ($1, $2, 'dev/ada-1', 'merged', FALSE, '{1}')`,
        [app.id, maker.id],
      );
    });
    assert.equal(await held(mergedByAPerson), false, 'live, whoever built it');
  });

  await t.test('a first version still on its way holds: a question to its maker, a plan, a build, a rebuild after a closed change', async () => {
    const onItsWay = async (slug, setup) => {
      const app = await project(slug);
      await queue(app, 2);
      await setup(app);
      return app;
    };
    assert.equal(await held(await onItsWay('asked-its-maker', (app) => run(app, 1, { verdict: 'question' }))), true);
    assert.equal(await held(await onItsWay('plan-waiting', async (app) => {
      const id = await run(app, 1);
      await pool.query('UPDATE homeroom_bot_runs SET awaiting_go_at = NOW() WHERE id = $1', [id]);
    })), true, 'its plan waits for Build it');
    assert.equal(await held(await onItsWay('building', (app) => run(app, 1, { waiting: true }))), true);
    assert.equal(await held(await onItsWay('rebuilding', async (app) => {
      const pr = await change(app, 1, 'closed');
      await run(app, 1, { buildOk: true, proposal: pr });
      await run(app, 1, { waiting: true });
    })), true, 'its change was closed and the bot is building it again');
    assert.equal(await held(await onItsWay('merging', async (app) => {
      const pr = await change(app, 1, 'merging');
      await run(app, 1, { buildOk: true, proposal: pr });
    })), true, 'approved, and going live now');
    assert.equal(await held(await onItsWay('collateral', async (app) => {
      await run(app, 1, { waiting: true });
      await run(app, 1, { verdict: 'failed', error: 'collateral: stopped with another turn' });
    })), true, 'a turn killed as collateral is not a look at it');
  });

  // Everything above, at once, as the loop reads it: one query over every
  // project, each held or not on its own.
  await t.test('one read over many projects keeps each one\'s own answer', async () => {
    const { rows } = await pool.query('SELECT id, slug FROM apps WHERE slug = ANY($1::text[])', [slugs]);
    const all = await bot.firstVersionHolds(pool, rows.map((r) => r.id));
    const heldSlugs = rows.filter((r) => all.has(Number(r.id))).map((r) => r.slug).sort();
    assert.deepEqual(heldSlugs, [
      'asked-its-maker', 'building', 'collateral', 'just-filed', 'look-failed', 'merging',
      'never-looked-at', 'not-held', 'plan-waiting', 'rebuilding', 'setting-up',
    ]);
  });
});
