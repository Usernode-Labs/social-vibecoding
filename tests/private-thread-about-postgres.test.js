'use strict';

// Threads, one loop (phase B, 1 Nov 2026): a private thread about a request
// or a change, and the hold it puts on Homeroom bot, against the FULL
// PostgreSQL schema in a throwaway database, through the real code
// (routes/threads.js and routes/issues.js over services/private-threads.js,
// homeroom-bot-dm.js sendDm and messageThread, rules/bot-loop.ts).
//
// What this pins:
//   1. POST /api/apps/:slug/threads/:number/private opens a thread in the
//      person's chat with the bot, hanging off the bot's line in Main that
//      names what it is about (metadata kind 'opened_about', which the chat
//      never takes for a request's story), with its private_threads row
//      (kind 'ask', the about columns), and answers its bot-tab address. A
//      second tap opens the same thread. A change is named by its pull
//      request number. Refusals: signed out, a project they cannot see, a
//      number that is nothing, a kind that is neither, another origin.
//   2. The bot's turn in it reads what it is about: a request's title, words
//      and discussion, a change's title, summary and where it stands, as
//      untrusted content.
//   3. Opened by whoever asked for the request, the bot waits for their
//      plan: the lane neither reads (READ_CANDIDATES_SQL) nor builds
//      (BUILD_CANDIDATES_SQL) it, the queue says awaiting_plan, the bot tab
//      lists it as Waiting for your plan, and the request page is told
//      (holdsFor). Somebody else's thread holds nothing; a follow-up and an
//      admin's Run now are not held.
//   4. The hold lifts when a plan is posted on the request, when they tap
//      Let the bot build it now (POST /api/apps/:slug/issues/:number/bot-go),
//      or once the thread has been quiet for 7 days.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/private-thread-about-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a private thread about a request or a change, and the hold, against the full schema', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `pt_about_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  require('../src/db/pool').getPool = () => pool;
  require('../src/services/app-numbers').setPool?.(pool);
  const wsBus = require('../src/services/ws-bus');
  wsBus.publish = () => {};
  wsBus.publishBatched = () => {};
  const privateThreads = require('../src/services/private-threads');
  const dm = require('../src/services/homeroom-bot-dm');
  const rules = require('../src/workflow/rules/bot-loop.ts');
  const bot = require('../src/services/homeroom-bot');
  const aiWork = require('../src/services/ai-work');
  const progress = require('../src/services/homeroom-bot-progress');
  const conversations = require('../src/services/conversations');

  const users = {};
  async function user(username, { synthetic = false } = {}) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO users (username, password, is_synthetic, has_platform_access) VALUES ($1, 'x', $2, TRUE)
       RETURNING id, username`,
      [username, synthetic],
    );
    users[row.id] = { id: row.id, username: row.username, isAdmin: false, ...(synthetic ? { isSynthetic: true } : {}) };
    return users[row.id];
  }
  const botUser = await user('homeroom_bot', { synthetic: true });
  const ada = await user('pa_ada');
  const sam = await user('pa_sam');
  async function project(slug, view = 'public') {
    const { rows: [row] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
       VALUES ($1, $2, 'running', $3, $4, $5, $5) RETURNING id`,
      [slug === 'pa-plants' ? 'Plant Pal' : slug, slug, ada.id, `https://github.com/usernode-bot/${slug}`, view],
    );
    return (await pool.query('SELECT id, slug, name, community_id FROM apps WHERE id = $1', [row.id])).rows[0];
  }
  const app = await project('pa-plants');
  const hidden = await project('pa-hidden', 'private');
  await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2), ($1, $3)', [app.community_id, ada.id, sam.id]);

  // Request #18, Ada's, with its issue mirror (who the lane says asked for
  // it), words and a discussion; #19, Sam's; and change #406 for #18.
  async function request(number, title, by, body) {
    const { rows: [r] } = await pool.query(
      `INSERT INTO requests (app_id, number, title, body, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING thread_id`,
      [app.id, number, title, body, by.id],
    );
    await pool.query(
      `INSERT INTO issues (app_id, github_issue_number, title, kind, created_by, thread_id) VALUES ($1, $2, $3, 'general', $4, $5)`,
      [app.id, number, title, by.id, r.thread_id],
    );
    return Number(r.thread_id);
  }
  const thread18 = await request(18, 'Dark mode', ada, '**Source:** Homeroom user (pa_ada)\n\nThe screen is too bright at night.');
  await request(19, 'Bigger buttons', sam, 'Hard to tap.');
  await pool.query(
    // An hour ago: settled, so only the hold keeps the bot off it.
    `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref, created_at) VALUES
       ($1, $2, 'Follow the phone''s own setting, please.', 'issue', 18, NOW() - INTERVAL '1 hour'),
       ($1, $3, 'A toggle in the header would do.', 'issue', 18, NOW() - INTERVAL '1 hour')`,
    [app.id, sam.id, ada.id],
  );
  const { rows: [change] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, pr_number, pr_summary_md, linked_issues, is_headless)
     VALUES ($1, $2, 'dark', 'promoted', 'Night mode by schedule', 406, 'Turns the theme dark after sunset.', ARRAY[18], FALSE)
     RETURNING id, thread_id`,
    [app.id, sam.id],
  );

  const httpApp = express();
  httpApp.use(express.json());
  httpApp.use((req, _res, next) => { req.user = users[Number(req.get('x-test-user'))]; next(); });
  httpApp.use(require('../src/routes/threads').threadsRoutes({}));
  httpApp.use(require('../src/routes/issues').issueRoutes({}));
  server = await new Promise((resolve) => {
    const listening = httpApp.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function post(who, path, body = {}, headers = {}) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(who ? { 'x-test-user': String(who.id) } : {}), ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  const open = (who, number, kind, slug = app.slug) => post(who, `/api/apps/${slug}/threads/${number}/private`, { kind });
  const root = async (id) => (await pool.query(
    'SELECT sender_id, thread_root_id, content, metadata FROM conversation_messages WHERE id = $1', [id],
  )).rows[0];

  let adaRoot;
  await t.test('Work on this with Homeroom bot opens a thread about the request in her chat with the bot, once', async () => {
    const made = await open(ada, 18, 'request');
    assert.equal(made.status, 200, JSON.stringify(made.body));
    adaRoot = made.body.rootId;
    assert.equal(made.body.href, `#homeroom-bot/thread/${adaRoot}`);
    assert.equal(made.body.holds, true, 'her own request: the bot waits for her plan');
    const line = await root(adaRoot);
    assert.equal(line.sender_id, botUser.id);
    assert.equal(line.thread_root_id, null, 'a line of Main the thread hangs off');
    assert.equal(line.content, 'New thread about #18 Dark mode. Only you can see it. I\'ll wait for your plan before I build it.');
    const meta = line.metadata.homeroomBot;
    assert.ok(meta.kind.startsWith('opened_'), 'a thread, never a request\'s story (request-page.ts)');
    assert.deepEqual({ kind: meta.kind, appSlug: meta.appSlug, aboutKind: meta.aboutKind, aboutNumber: meta.aboutNumber, aboutTitle: meta.aboutTitle },
      { kind: 'opened_about', appSlug: 'pa-plants', aboutKind: 'request', aboutNumber: 18, aboutTitle: 'Dark mode' });
    assert.equal(meta.issueNumber, undefined, 'nothing that names it as the request\'s news');
    const { rows: [row] } = await pool.query(
      `SELECT user_id, kind, state, app_id, about_thread_id, about_kind, about_number, holds_bot, hold_lifted_at
         FROM private_threads WHERE root_message_id = $1`, [adaRoot]);
    assert.deepEqual({ ...row, about_thread_id: Number(row.about_thread_id) }, {
      user_id: ada.id, kind: 'ask', state: 'open', app_id: app.id, about_thread_id: thread18,
      about_kind: 'request', about_number: 18, holds_bot: true, hold_lifted_at: null,
    });
    const again = await open(ada, 18, 'request');
    assert.deepEqual({ rootId: again.body.rootId, reused: again.body.reused, holds: again.body.holds }, { rootId: adaRoot, reused: true, holds: true },
      'a second tap opens the same thread');
    const { rows: [{ n }] } = await pool.query('SELECT COUNT(*)::int AS n FROM private_threads WHERE user_id = $1', [ada.id]);
    assert.equal(n, 1);
    // 1 Nov 2026 (C1): the bot tab lists it by its request ("#18 Dark mode"),
    // not by the bot's opening line.
    const aiWork = require('../src/services/ai-work');
    const listed = (await pool.query(aiWork.PRIVATE_SQL, [ada.id, botUser.id, aiWork.PRIVATE_MAX, aiWork.LIVE_DAYS])).rows.map(aiWork.shapePrivate);
    const mine = listed.find((p) => p.rootId === adaRoot);
    assert.deepEqual({ title: mine.title, about: mine.about }, { title: 'Dark mode', about: { kind: 'request', number: 18 } });
  });

  let samChange;
  await t.test('anyone who can see the project opens one; a change by its number; and what is refused', async () => {
    const samOn18 = await open(sam, 18, 'request');
    assert.equal(samOn18.status, 200);
    assert.equal(samOn18.body.holds, false, 'somebody else\'s private thread never holds a request');
    assert.equal((await root(samOn18.body.rootId)).content, 'New thread about #18 Dark mode. Only you can see it.');
    const onChange = await open(sam, 406, 'change');
    assert.equal(onChange.status, 200);
    samChange = onChange.body.rootId;
    assert.equal((await root(samChange)).content, 'New thread about change #406 Night mode by schedule. Only you can see it.');
    const { rows: [row] } = await pool.query('SELECT about_kind, about_number, about_thread_id, holds_bot FROM private_threads WHERE root_message_id = $1', [samChange]);
    assert.deepEqual({ ...row, about_thread_id: Number(row.about_thread_id) },
      { about_kind: 'change', about_number: 406, about_thread_id: Number(change.thread_id), holds_bot: false });

    assert.equal((await open(null, 18, 'request')).status, 401, 'signed out');
    assert.equal((await open(sam, 1, 'request', hidden.slug)).status, 404, 'a project she cannot see');
    assert.equal((await open(sam, 999, 'request')).status, 404, 'no such request');
    assert.equal((await open(sam, 18, 'change')).status, 404, '#18 is no change');
    assert.equal((await open(sam, 18, 'idea')).status, 422);
    assert.equal((await post(sam, `/api/apps/${app.slug}/threads/18/private`, { kind: 'request' }, { 'sec-fetch-site': 'cross-site' })).status, 403,
      'their own tap only');
    assert.equal((await open(botUser, 18, 'request')).status, 403, 'nobody synthetic');
  });

  await t.test('the bot\'s turn there reads what the thread is about, as untrusted content', async () => {
    const opened = await conversations.ensureAdmittedDirect(pool, botUser.id, ada.id);
    const said = (await conversations.sendMessage(pool, ada, opened.conversationId, { content: 'How should the toggle look?', thread_root_id: adaRoot })).message;
    const where = await dm.messageThread(pool, { userId: ada.id, conversationId: opened.conversationId, message: said });
    assert.deepEqual(where, {
      rootId: adaRoot,
      draft: {
        kind: 'ask', state: 'open', appSlug: 'pa-plants', appName: 'Plant Pal', changeKind: 'any',
        about: { kind: 'request', number: 18 }, holds: true,
      },
    });
    const told = await privateThreads.aboutContext(pool, { user: ada, draft: where.draft });
    assert.match(told, /^WHAT THIS THREAD IS ABOUT\n/);
    assert.match(told, /from request #18 on Plant Pal \(project "pa-plants"\)/);
    assert.match(told, /you wait for their plan before you build it/);
    const inside = told.slice(told.indexOf('<untrusted-content>'));
    assert.match(inside, /^<untrusted-content>Title: Dark mode\n\nRequest:\nThe screen is too bright at night\.\n\nWhat people said on it, oldest first:\n- pa_sam: Follow the phone's own setting, please\.\n- pa_ada: A toggle in the header would do\.<\/untrusted-content>$/);
    assert.ok(!told.includes('**Source:**'), 'the filing line is the platform\'s, not the request\'s words');

    const samChat = await conversations.ensureAdmittedDirect(pool, botUser.id, sam.id);
    const asked = (await conversations.sendMessage(pool, sam, samChat.conversationId, { content: 'Could it follow sunrise too?', thread_root_id: samChange })).message;
    const there = await dm.messageThread(pool, { userId: sam.id, conversationId: samChat.conversationId, message: asked });
    assert.deepEqual(there.draft.about, { kind: 'change', number: 406 });
    const onChange = await privateThreads.aboutContext(pool, { user: sam, draft: there.draft });
    assert.match(onChange, /from change #406 on Plant Pal/);
    assert.match(onChange, /It is up for a vote\./);
    assert.match(onChange, /Title: Night mode by schedule\n\nSummary:\nTurns the theme dark after sunset\./);
    // A project they can no longer see is told nothing.
    assert.equal(await privateThreads.aboutContext(pool, { user: sam, draft: { ...there.draft, appSlug: hidden.slug } }), null);
    // The prompt names it, and never as a "+" thread.
    const mayor = require('../src/services/homeroom-bot-mayor');
    const prompt = mayor.systemPrompt({ username: 'pa_ada', thread: { draft: where.draft } });
    assert.match(prompt, /They opened this thread from request #18 on Plant Pal \(project "pa-plants"\) to work on it with/);
    assert.ok(!/with your "\+"/.test(prompt));
  });

  // The lane, as tests/homeroom-bot-first-version-hold-postgres.test.js reads it.
  const instance = async (number, state, data = {}) => {
    const cl = await pool.connect();
    try {
      await cl.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`);
      await cl.query(
        `INSERT INTO wf_instances (machine, key, app_id, state, data, machine_version) VALUES ($1, $2, $3, $4, $5, 1)
         ON CONFLICT (machine, key) DO UPDATE SET state = EXCLUDED.state, data = EXCLUDED.data`,
        [rules.BOT_REQUEST, rules.requestKey(app.id, number), app.id, state, { appId: app.id, issueNumber: number, ...data }],
      );
      await cl.query('COMMIT');
    } finally { cl.release(); }
  };
  const queue = async (number, { reason = 'new' } = {}) => {
    await instance(number, 'queued');
    await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, enqueued_at)
       VALUES ($1, $2, 1, $3, NOW() - INTERVAL '10 minutes')
       ON CONFLICT DO NOTHING`,
      [app.id, number, reason],
    );
  };
  const readable = async () => (await pool.query(rules.READ_CANDIDATES_SQL, [botUser.id, []])).rows
    .filter((r) => Number(r.app_id) === Number(app.id)).map((r) => Number(r.issue_number)).sort((a, b) => a - b);
  const buildable = async () => (await pool.query(rules.BUILD_CANDIDATES_SQL, [[]])).rows
    .filter((r) => Number(r.app_id) === Number(app.id)).map((r) => Number(r.issue_number));

  await t.test('while she works on her own request there, the bot neither reads nor builds it, and says why', async () => {
    await queue(18);
    await queue(19);
    // Without her thread it would be read: the hold is the one thing in the way.
    await pool.query('UPDATE private_threads SET holds_bot = FALSE WHERE root_message_id = $1', [adaRoot]);
    assert.deepEqual(await readable(), [18, 19]);
    await pool.query('UPDATE private_threads SET holds_bot = TRUE WHERE root_message_id = $1', [adaRoot]);
    assert.deepEqual(await readable(), [19], 'her #18 waits for her plan; Sam\'s thread on #18 holds nothing, and #19 is read');
    const snapshot = await bot.queueSnapshot(pool, { pausedApps: [] }, { botId: botUser.id, memory: { inFlight: [], backoff: [], fault: null, budgetUntil: 0 } });
    const listed = snapshot.items.find((item) => Number(item.issueNumber ?? item.issue_number) === 18);
    assert.ok(listed, JSON.stringify(snapshot.items));
    assert.equal(listed.waiting?.reason ?? listed.wait?.reason, 'awaiting_plan');
    assert.equal(bot.queueWait({ awaiting_plan: true, follow_up_session_id: 7 }), null, 'a follow-up on the bot\'s change is not held');
    assert.equal(bot.queueWait({ awaiting_plan: true, reason: 'admin' }), null, 'nor an admin\'s Run now');

    // Her page is told; Sam's is not.
    assert.deepEqual([...(await privateThreads.holdsFor(pool, { appId: app.id, userId: ada.id, numbers: [18, 19] })).keys()], [18]);
    assert.equal((await privateThreads.holdsFor(pool, { appId: app.id, userId: sam.id, numbers: [18, 19] })).size, 0);

    // Her bot tab: Waiting for your plan.
    const { rows } = await pool.query(aiWork.THREADS_SQL, [ada.id, false, false, aiWork.THREADS_MAX, aiWork.LIVE_DAYS]);
    const row18 = rows.find((r) => Number(r.number) === 18);
    assert.equal(row18.awaiting_plan, true);
    // Its stored work state says the same (services/work-state.js: planHoldSql).
    const stored = await aiWork.statesFor(pool, [row18]);
    const shaped = aiWork.arrange([{ ...row18, change_status: null }], ada.id, new Date(), botUser.id, stored);
    assert.deepEqual([shaped.waiting[0].work.stage, shaped.waiting[0].work.line], ['planning', { code: 'planning_with_you' }]);
    assert.equal(aiWork.threadSays(shaped.waiting[0]), 'Planning · Planning it with you in a private thread');

    // What she is told when she asks how far along it is.
    await pool.query(`INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, 18, $2, 'Dark mode')`, [app.id, ada.id]);
    const states = await progress.requestStates(pool, { userId: ada.id, settings: { mode: 'shadow', perPerson: 2 } });
    const state18 = states.find((s) => Number(s.row.app_id) === app.id && Number(s.row.issue_number) === 18)?.state;
    assert.equal(state18?.doing, progress.PLAN_WAIT);
    assert.deepEqual(state18.waitingFor, { reason: 'awaiting_plan' });

    // A ready verdict waiting for its build slot waits too.
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 18', [app.id]);
    const { rows: [run] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, live_build_waiting_at, build_note)
       VALUES ($1, 18, 'live', 'ready', NOW(), 'build it') RETURNING id`, [app.id]);
    await instance(18, 'building', { build: { runId: run.id, phase: 'waiting', since: new Date().toISOString(), key: null } });
    assert.deepEqual(await buildable(), [], 'no build of it starts');

    // 13 Nov 2026: and it says so, whatever it had reached. A tester's read
    // "Ready to build · Number 1 in line" beside Let the bot build it now:
    // the queue's words, for a build her own thread held. Its stored work
    // state is the hold now, drawn as the one still waiting to be read is.
    const workState = require('../src/services/work-state');
    const stands = async () => {
      await workState.refresh(pool, [{ appId: app.id, issueNumber: 18 }]);
      return (await workState.forItems(pool, [{ appId: app.id, issueNumber: 18 }]))[0];
    };
    const atLine = await stands();
    assert.deepEqual([atLine.stage, atLine.line, atLine.whoseMove], ['planning', { code: 'planning_with_you', ready: true }, 'requester']);
    assert.equal(workState.says(atLine), 'Planning · Planning it with you in a private thread');
    assert.deepEqual(atLine.words.line, { id: 'core:work.line.planningWithYou' });
    // Her bot tab's row, and what she is told when she asks.
    const { rows: tab } = await pool.query(aiWork.THREADS_SQL, [ada.id, false, false, aiWork.THREADS_MAX, aiWork.LIVE_DAYS]);
    const tab18 = tab.find((r) => Number(r.number) === 18);
    const shown = aiWork.arrange([{ ...tab18, change_status: null }], ada.id, new Date(), botUser.id, await aiWork.statesFor(pool, [tab18]));
    assert.equal(aiWork.threadSays(shown.waiting[0]), 'Planning · Planning it with you in a private thread');
    const told = (await progress.requestStates(pool, { userId: ada.id, settings: { mode: 'shadow', perPerson: 2 } }))
      .find((s) => Number(s.row.app_id) === app.id && Number(s.row.issue_number) === 18)?.state;
    assert.equal(told?.doing, progress.PLAN_WAIT);
    assert.equal(told.waitingOn, 'them');
    // Her card under the message that asked for it, in the project's chat.
    assert.equal(require('../src/services/homeroom-bot-chat').cardStageOfWork(atLine), 'waiting_plan');
    // Without her hold the same build is in the bot's line, and says so.
    await pool.query('UPDATE private_threads SET holds_bot = FALSE WHERE root_message_id = $1', [adaRoot]);
    const inLine = await stands();
    assert.deepEqual([inLine.stage, inLine.line, inLine.whoseMove], ['building', { code: 'queued', place: 1 }, 'bot']);
    assert.equal(workState.says(inLine), 'Ready to build · Number 1 in line');
    assert.deepEqual(await buildable(), [18], 'and it may start');
    await pool.query('UPDATE private_threads SET holds_bot = TRUE WHERE root_message_id = $1', [adaRoot]);
    assert.equal((await stands()).stage, 'planning');
    await pool.query('DELETE FROM homeroom_bot_runs WHERE id = $1', [run.id]);
    await queue(18);
  });

  await t.test('Let the bot build it now lifts her hold, and only hers', async () => {
    assert.equal((await post(sam, `/api/apps/${app.slug}/issues/18/bot-go`)).body.lifted, 0, 'Sam has no hold to lift');
    assert.deepEqual(await readable(), [19]);
    assert.equal((await post(ada, `/api/apps/${app.slug}/issues/18/bot-go`, {}, { 'sec-fetch-site': 'cross-site' })).status, 403);
    const go = await post(ada, `/api/apps/${app.slug}/issues/18/bot-go`);
    assert.deepEqual({ status: go.status, body: go.body }, { status: 200, body: { ok: true, lifted: 1 } });
    assert.deepEqual(await readable(), [18, 19], 'the bot reads it now');
    const { rows: [row] } = await pool.query('SELECT hold_lifted_by FROM private_threads WHERE root_message_id = $1', [adaRoot]);
    assert.equal(row.hold_lifted_by, 'go');
    assert.deepEqual((await open(ada, 18, 'request')).body.holds, false, 'opening it again holds nothing again');
  });

  await t.test('a plan posted on the request lifts the hold, and so do 7 quiet days', async () => {
    // A new request of hers, held.
    await request(20, 'Plant photos', ada, 'Add a photo to each plant.');
    await queue(20);
    const held = await open(ada, 20, 'request');
    assert.equal(held.body.holds, true);
    assert.ok(!(await readable()).includes(20));
    const specs = require('../src/services/request-specs');
    await specs.postRequestSpec(pool, {
      app, repo: null, issueNumber: 20, issueTitle: 'Plant photos', user: ada, text: '# Photos\n\nA camera button on each plant.',
    }, { ws: { sendBotMessage: async () => true }, github: { isEnabled: () => false } });
    assert.ok((await readable()).includes(20), 'a plan on the request: the bot may build it');
    const { rows: [lifted] } = await pool.query('SELECT hold_lifted_by FROM private_threads WHERE root_message_id = $1', [held.body.rootId]);
    assert.equal(lifted.hold_lifted_by, 'plan');
    assert.deepEqual(await privateThreads.liftHold(pool, { appId: app.id, issueNumber: 20 }), { lifted: 0 }, 'once');

    // Another, held, then quiet for 8 days.
    await request(21, 'Watering reminders', ada, 'Remind me to water.');
    await queue(21);
    const quiet = await open(ada, 21, 'request');
    const opened = await conversations.ensureAdmittedDirect(pool, botUser.id, ada.id);
    await conversations.sendMessage(pool, ada, opened.conversationId, { content: 'Every three days?', thread_root_id: quiet.body.rootId });
    assert.ok(!(await readable()).includes(21));
    await pool.query(`UPDATE private_threads SET created_at = NOW() - INTERVAL '8 days' WHERE root_message_id = $1`, [quiet.body.rootId]);
    await pool.query(`UPDATE conversation_messages SET created_at = NOW() - INTERVAL '8 days' WHERE thread_root_id = $1`, [quiet.body.rootId]);
    assert.ok((await readable()).includes(21), 'quiet for a week: it holds no longer');
    assert.equal((await privateThreads.holdsFor(pool, { appId: app.id, userId: ada.id, numbers: [21] })).size, 0);
  });

  await t.test('a closed request of hers is talked over, not held', async () => {
    await request(22, 'Old idea', ada, 'Done already.');
    await pool.query(`UPDATE requests SET state = 'closed' WHERE app_id = $1 AND number = 22`, [app.id]);
    const made = await open(ada, 22, 'request');
    assert.equal(made.status, 200);
    assert.equal(made.body.holds, false);
    assert.equal((await root(made.body.rootId)).content, 'New thread about #22 Old idea. Only you can see it.');
  });

  await t.test('the opening line, pure', () => {
    assert.equal(privateThreads.aboutLine({ kind: 'request', number: 18, title: 'Dark mode' }), 'New thread about #18 Dark mode. Only you can see it.');
    assert.equal(privateThreads.aboutLine({ kind: 'change', number: 406, title: null }), 'New thread about change #406. Only you can see it.');
    assert.match(rules.READ_CANDIDATES_SQL, /planHold|private_threads ph/);
    assert.ok(rules.BUILD_CANDIDATES_SQL.includes(rules.planHoldActiveSql('ph')));
  });
});
