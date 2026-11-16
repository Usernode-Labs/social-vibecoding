'use strict';

// A chat request held for its project's first version (5 October run-through).
//
// "Page Turners", a group project. Its first version, which Homeroom bot was
// still building, was not live. Priya, invited that day, wrote an idea in the
// project's chat and tapped Suggest it. Request #2 was filed and held, as
// #3855 holds everything else on a project until its first version is live
// (homeroom-bot.js FIRST_VERSION_PENDING_SQL), and her DM with the bot said
// "Filed. Waiting for the first version to go live. I'll start on this as
// soon as it does." The chat said otherwise: her card read "Got it: Add list
// of books read with star ratings. Usually about 10 minutes.", and the chip
// on her message, which everybody sees, read Reading.
//
// Now a request queued, not started, while its project's first version is
// not live (the bot's own rule: firstVersionHolds, heldForFirstVersion) is at
// its own stage while its work state waits to be read (services/work-state.js).
// Its card says what the DM says from the moment it is filed. When the first
// version merges, the loop is woken for it; the moment it is picked up pushes
// her card again, and a read of the cards after the hold ends says it is no
// longer held. The room's status chip on the message is gone (5 Nov 2026).
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-chat-first-version-wait.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { settleWorkStates } = require('./lib/work-states');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const botChat = require('../src/services/homeroom-bot-chat');

const BOOKS = 'Add list of books read with star ratings';
const WAIT = 'Waiting for the first version to go live. I’ll start on this as soon as it does.';
const STAYS = 'It stays in the project’s requests with your name on it.';

test('a held request has its own stage, and only while its work state waits to be read', () => {
  // 11 Nov 2026: the hold is its stored work state's own line
  // (services/work-state.js: reading, first_version_wait), read as every
  // screen reads it.
  const held = { stage: 'reading', line: { code: 'first_version_wait' } };
  const stage = (work) => botChat.stageOf({ kind: 'filed' }, { work });
  assert.ok(botChat.CARD_STAGES.includes('waiting_first_version'));
  assert.equal(stage(held), 'waiting_first_version', 'queued behind the first version');
  assert.equal(stage({ stage: 'reading', line: { code: 'queued' } }), 'reading', 'the hold over: read as before');
  assert.equal(stage({ stage: 'reading', line: { code: 'waiting' } }), 'reading');
  // What its work state settles past reading comes first: the bot's change
  // for it (a follow-up on it is never held), or a request closed.
  assert.equal(stage({ stage: 'checking', line: null }), 'checking');
  assert.equal(stage({ stage: 'building', line: { code: 'update_queued' } }), 'checking');
  assert.equal(stage({ stage: 'closed', line: null }), 'closed');
  // With no work state read, the card says what it said before.
  assert.equal(stage(null), null);
  // A fix is never held: it runs on its change's own branch, and follows
  // that change's stored row.
  const change = { stage: 'up_for_vote', change: { status: 'promoted', voteOpen: true, update: null } };
  assert.equal(botChat.stageOf({ kind: 'revise' }, { change }), 'fixing', 'its follow-up not run yet');
  assert.equal(botChat.stageOf({ kind: 'revise', run_id: 3, verdict: 'revise' }, { change }), 'proposed');
});

// The room's status chip is gone (5 Nov 2026): the chip a held request wore, and the catch-up of one a moment missed, went with it.

test('what the card says while it waits', () => {
  const { BotRequestCardView, cardWords } = loadTsx('frontend/src/features/group-chat/bot-request.tsx');
  // The wait line is the end of a whole catalog message that starts with what was taken.
  const FIRST_VERSION_WAIT_LINE = message('chat:group.botCard.filed.firstVersionWait', { title: 'X' }).slice('Got it: X. '.length);
  assert.equal(message('chat:group.botCard.filed.firstVersionWait', { title: 'X' }), `Got it: X. ${WAIT}`);
  assert.equal(FIRST_VERSION_WAIT_LINE, WAIT);
  // The DM card's own words (homeroom-bot-activity.js), in the chat card's typography.
  const { FIRST_VERSION_WAIT_WORDS } = require('../src/services/homeroom-bot-activity');
  assert.equal(FIRST_VERSION_WAIT_LINE.replace(/’/g, '\''), FIRST_VERSION_WAIT_WORDS);
  const card = { kind: 'filed', title: BOOKS, messageId: 1, issueNumber: 2, first: true, state: { stage: 'waiting_first_version' } };
  assert.equal(cardWords(card), `Got it: ${BOOKS}. ${WAIT} ${STAYS}`);
  assert.equal(cardWords({ ...card, first: false }), `Got it: ${BOOKS}. ${WAIT}`);
  assert.ok(!/Usually about/.test(cardWords({ ...card, typicalMinutes: 10 })), 'no time while it waits');
  assert.ok(!/—/.test(cardWords(card)));
  assert.match(renderToHtml(createElement(BotRequestCardView, { card })), /data-bot-request-action="progress"><span>See progress/);
  // The room's status chip is gone (5 Nov 2026): what everybody saw on her message while it waited is not drawn.
  // The chat reads the cards again each minute while one waits.
  assert.match(read('public/js/group-chat.js'), /_BOT_CARD_GOING: new Set\(\['waiting_first_version', /);
});

// 13 Nov 2026: a tester read "Waiting for a free builder" and could not tell
// whether it waited for the bot, for another person, or for them, and
// wondered whether the project had to be public for somebody to build it.
// The card names whose line it is; and a request its requester's own private
// thread holds waits for them, never for a slot.
test('a ready request waits in Homeroom bot\'s own line; one held for her plan waits for her', () => {
  const { BotRequestCardView, cardWords, sharedNow } = loadTsx('frontend/src/features/group-chat/bot-request.tsx');
  const card = { kind: 'filed', title: BOOKS, messageId: 1, issueNumber: 2, first: false };
  const SLOT = 'Homeroom bot will build it when it has a free slot. It starts by itself.';
  const PLAN = 'It’s waiting for you: you’re planning it with Homeroom bot in a private thread.';
  const ready = { ...card, state: { stage: 'waiting' } };
  assert.equal(cardWords(ready), `Got it: ${BOOKS}. ${SLOT}`);
  assert.equal(cardWords({ ...ready, title: null }), `Got it: your request. ${SLOT}`);
  assert.equal(cardWords({ ...ready, first: true }), `Got it: ${BOOKS}. ${SLOT} ${STAYS}`);
  const planning = { ...card, state: { stage: 'waiting_plan' } };
  assert.equal(cardWords(planning), `Got it: ${BOOKS}. ${PLAN}`);
  assert.equal(cardWords({ ...planning, title: null }), `Got it: your request. ${PLAN}`);
  assert.equal(cardWords({ ...planning, first: true }), `Got it: ${BOOKS}. ${PLAN} ${STAYS}`);
  for (const c of [ready, planning]) {
    assert.ok(!/builder|Usually about|—/.test(cardWords({ ...c, typicalMinutes: 10 })), c.state.stage);
    assert.equal(sharedNow(c), true, 'the request is still the project\'s');
    assert.match(renderToHtml(createElement(BotRequestCardView, { card: c })), /data-bot-request-action="progress"><span>See progress/);
  }
  assert.ok(!/free slot/.test(cardWords(planning)), 'never the line\'s sentence for a request that waits on her');
  // Which of the two it is comes from its stored work state: held for her
  // plan whatever it had reached, the bot's line otherwise.
  const stage = (work) => botChat.stageOf({ kind: 'filed' }, { work });
  assert.equal(stage({ stage: 'planning', line: { code: 'planning_with_you', ready: true } }), 'waiting_plan');
  assert.equal(stage({ stage: 'building', line: { code: 'queued', place: 1 } }), 'waiting');
  // The chat reads the card again while it waits for her, so lifting the hold moves it on.
  assert.match(read('public/js/group-chat.js'), /_BOT_CARD_GOING: new Set\(\[[^\]]*'waiting_plan'/);
  // The retired words are gone from the card's catalog, and from what the
  // bot says in its own chat (homeroom-bot-activity.js, -progress.js).
  assert.ok(!/free builder/i.test(read('frontend/locales/en/chat.json')));
  const said = [require('../src/services/homeroom-bot-activity').QUEUED_WORDS,
    require('../src/services/homeroom-bot-progress').QUEUE_WAIT, require('../src/services/homeroom-bot-progress').QUEUE_NEXT];
  for (const words of said) assert.match(words, /^(?!.*builder).*by myself.*free slot/, words);
});

test('the merge wakes the loop for what waited, and its pick-up moves the chat request on', () => {
  const src = read('src/services/homeroom-bot.js');
  // noteRequestMerged: the first version merged, the lane is asked to
  // refresh the project soon (bot-lane RefreshAsked), and looks again.
  assert.match(src, /log\.info\('homeroom-bot', 'A project\\'s first version is live; what waited for it is picked up now', \{\s*sessionId: Number\(merged\.id\), appId, issueNumber: Number\(firstVersion\[0\]\.issue_number\),\s*\}\);\s*refresh = true;\s*\}\s*if \(refresh\) await \(deps\.platform \|\| platform\(\)\)\.botRefresh\(appId\)/);
  // The look, picking the request up: noteRequestStatus pushes the
  // requester's cards again (followCards).
  assert.match(src, /await activity\(\)\.startCard\(pool, \{[\s\S]*?deps: \{ dm: deps\.dm \},\s*\}\);\s*\/\/ B9: [^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*await require\('\.\/homeroom-bot-chat'\)\.noteRequestStatus\(pool, \{ appId: app\.id, issueNumber \}\);/);
});

test('Page Turners, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_fvwait_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  const bot = require('../src/services/homeroom-bot');
  // A request handed to the bot is owed a look by its bot-request instance
  // (its queue row the projection), and the lane (bot-lane) grants its
  // read: the workflow runtime runs here, on this database, its pipeline
  // only (no timers, no work).
  const platform = require('../src/workflow/platform.ts');
  require('../src/db/pool').getPool = () => pool;
  t.after(async () => {
    bot._resetForTests();
    await platform.stopWorkflow();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(read('src/db/schema.sql'));
  await platform.startWorkflow({ databaseUrl: String(url), dataEncryptionKey: 'synthetic-key', wfPoolMax: 4, wfSlots: 2 }, { loops: false });
  // Rows a machine owns (a request's queue row, a proposal's move into
  // merged) are fixtures here, written as the kernel writes them.
  const asKernel = async (sql, params) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL app.wf_writer = 'transition'");
      await c.query(sql, params);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
  };
  const until = async (check, what) => {
    for (let i = 0; i < 200; i += 1) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`timed out waiting: ${what}`);
  };
  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2)
     RETURNING id, username, is_synthetic AS "isSynthetic", has_platform_access AS "hasPlatformAccess", is_admin AS "isAdmin"`,
    [username, synthetic],
  )).rows[0];
  const botUser = await user('homeroom_bot', true);
  const maya = await user('maya');
  const priya = await user('priya');
  const { rows: [community] } = await pool.query('INSERT INTO communities DEFAULT VALUES RETURNING id');
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility, repo_url, community_id)
     VALUES ('Page Turners', 'page-turners', 'running', $1, 'private', 'private', 'https://github.com/example/page-turners', $2)
     RETURNING id, slug, name, repo_url, community_id`,
    [maya.id, community.id],
  );
  // Maya made it a month ago; Priya was invited today.
  await pool.query(
    `INSERT INTO community_members (community_id, user_id, joined_at) VALUES ($1, $2, NOW() - INTERVAL '30 days'), ($1, $3, NOW() - INTERVAL '1 hour')`,
    [community.id, maya.id, priya.id],
  );
  for (const person of [maya, priya]) {
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [app.id, person.id]);
  }
  const set = (key, value) => pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
  await set('homeroom_bot_mode', 'live');
  // One read per project, as this story was written for (the default is
  // three): #3 waits behind #2's read.
  await set('homeroom_bot_reads_per_app', '1');

  // Maya's first version, request #1: the bot read it and is building it.
  await pool.query(
    `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, status, issue_number, filed_at)
     VALUES ($1, $2, 'A book club: what we are reading and when we meet', 'filed', 1, NOW() - INTERVAL '20 minutes')`,
    [app.id, maya.id],
  );
  await pool.query(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, first_version)
     VALUES ($1, 1, $2, 'Page Turners, first version', TRUE)`,
    [app.id, maya.id],
  );
  await pool.query(
    `INSERT INTO issues (app_id, github_issue_number, title, description, kind, payload, created_by)
     VALUES ($1, 1, 'Page Turners, first version', 'brief', 'general', '{}', $2)`,
    [app.id, maya.id],
  );
  const { rows: [firstRun] } = await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, live_build_waiting_at, build_note)
     VALUES ($1, 1, 'live', 'ready', NOW() - INTERVAL '5 minutes', 'build it') RETURNING id`,
    [app.id],
  );

  let nextIssue = 1;
  const frames = [];
  const pushed = [];
  const deps = (answer) => ({
    readAsk: async () => answer,
    takeOfferRead: () => true,
    // The chat's own path for a mention, as it is with the bot's voice off
    // in chats (homeroom-bot-voice.js answers it otherwise).
    voice: { enabledFor: async () => false, recordAsk: async () => null, dropAsks: async () => {} },
    github: {
      isEnabled: () => true,
      safeMention: (s) => s,
      createIssue: async () => { nextIssue += 1; return { number: nextIssue }; },
    },
    ws: {
      broadcast: (appId, frame) => frames.push(frame),
      pushToUser: (userId, frame) => pushed.push({ userId, frame }),
      sendSystemMessage: async () => {},
      pushIssueUpdate: () => {},
    },
    notifications: { createIssueOpenedNotifications: async () => [] },
  });
  const say = async (who, content) => (await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata) VALUES ($1, $2, $3, 'message', '{}') RETURNING id`,
    [app.id, who.id, content],
  )).rows[0].id;
  const metaOf = async (id) => (await pool.query('SELECT metadata FROM chat_messages WHERE id = $1', [id])).rows[0].metadata;
  // The room's status chip is gone (5 Nov 2026): no frame for it goes to the room.
  const chipFrames = () => frames.filter((f) => f.type === 'bot_request_status');
  // The platform's triggers mark a request whose records changed, and its
  // clock derives it again; here that is done by hand before a read.
  const rederive = (...numbers) => require('../src/services/work-state').refresh(pool, numbers.map((n) => ({ appId: app.id, issueNumber: n })));
  const cardsTo = (who) => pushed.filter((p) => p.userId === who.id && p.frame.type === 'bot_request_card').map((p) => p.frame.card);
  // 11 Nov 2026: a card reads its request's stored work state, derived
  // again from what the triggers mark; read once the drain has run.
  const mine = async () => (await settleWorkStates(pool), await botChat.myRequests(pool, { app, user: priya, deps: deps(null) })).cards;
  // What the lane (bot-lane) may grant a read to now, in its order.
  const { READ_CANDIDATES_SQL } = require('../src/workflow/rules/bot-loop.ts');
  const readable = async () => (await pool.query(READ_CANDIDATES_SQL, [botUser.id, []])).rows
    .filter((r) => Number(r.app_id) === Number(app.id)).map((r) => Number(r.issue_number));
  const { cardWords } = loadTsx('frontend/src/features/group-chat/bot-request.tsx');

  let booksId;
  await t.test('Suggest it, while the first version is being built: the card says it waits', async () => {
    const text = 'It would be nice to keep a list of the books we have read, with star ratings';
    booksId = await say(priya, text);
    const offer = await botChat.noteChatMessage(pool, null, {
      appId: app.id, userId: priya.id, messageId: booksId, content: text, deps: deps({ kind: 'change', title: BOOKS }),
    });
    assert.equal(offer.kind, 'offer');
    frames.length = 0;
    const filed = await botChat.requestFromMessage(pool, null, { app, user: priya, messageId: booksId, deps: deps(null) });
    assert.equal(filed.ok, true);
    const { card } = filed;
    assert.deepEqual([card.kind, card.issueNumber, card.first, card.state.stage], ['filed', 2, true, 'waiting_first_version']);
    assert.equal(card.typicalMinutes, undefined, 'no "Usually about 10 minutes"');
    assert.equal(cardWords(card), `Got it: ${BOOKS}. ${WAIT} ${STAYS}`);
    // The bot's own loop agrees: #2 keeps its place and is not read.
    const { rows: [queued] } = await pool.query('SELECT started_at FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 2', [app.id]);
    assert.equal(queued.started_at, null);
    assert.deepEqual(await readable(), []);
    // Nothing is drawn on her message for the room.
    assert.equal((await metaOf(booksId)).botRequest, undefined);
    assert.deepEqual(chipFrames(), []);
    // 5 Nov 2026 (docs/plans/bot-one-model.md, step 4): a request's news is
    // said on its own page, not sent, so her DM with the bot gets no card
    // for it and no thread saying where it was asked.
    const { rows: dm } = await pool.query(
      `SELECT content FROM conversation_messages WHERE content LIKE '%request #2%'`,
    );
    assert.equal(dm.length, 0, 'nothing about it in her DM');
    // After a reload (GET my-bot-requests): the same card.
    const again = (await mine()).find((c) => c.messageId === booksId);
    assert.equal(again.state.stage, 'waiting_first_version');
    assert.equal(cardWords(again), `Got it: ${BOOKS}. ${WAIT} ${STAYS}`);
    assert.deepEqual(chipFrames(), []);
  });

  let goalId;
  await t.test('a mention while it is held waits the same way', async () => {
    const text = '@homeroom_bot could we set a reading goal for the year?';
    goalId = await say(priya, text);
    const out = await botChat.noteChatMessage(pool, null, {
      appId: app.id, userId: priya.id, messageId: goalId, content: text, deps: deps({ kind: 'change', title: 'Add a yearly reading goal' }),
    });
    assert.equal(out.ok, true);
    assert.deepEqual([out.card.issueNumber, out.card.state.stage], [3, 'waiting_first_version']);
    assert.equal(cardWords(out.card), `Got it: Add a yearly reading goal. ${WAIT}`);
    assert.equal((await metaOf(goalId)).botRequest, undefined, 'nothing on the message for the room');
    // An admin's Run now is not held, as in the bot's read lane: that card
    // reads as any queued request, and only the held one goes without a time.
    const { rows: [{ reason }] } = await pool.query('SELECT reason FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 2', [app.id]);
    await asKernel(`UPDATE homeroom_bot_queue SET reason = 'admin' WHERE app_id = $1 AND issue_number = 2`, [app.id]);
    const byId = new Map((await mine()).map((c) => [c.messageId, c]));
    assert.equal(byId.get(booksId).state.stage, 'reading');
    assert.ok(Number.isFinite(byId.get(booksId).typicalMinutes));
    assert.equal(byId.get(goalId).state.stage, 'waiting_first_version');
    assert.equal(byId.get(goalId).typicalMinutes, undefined, 'no time on the held card, even beside one that has one');
    await asKernel('UPDATE homeroom_bot_queue SET reason = $2 WHERE app_id = $1 AND issue_number = 2', [app.id, reason]);
  });

  // The room's status chip is gone (5 Nov 2026): a Reading chip a missed moment left has nothing to put right.

  await t.test('built and up for approval: still waiting', async () => {
    const { rows: [first] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, promoted_at, linked_issues, check_state, pr_number)
       VALUES ($1, $2, 'hrbot/first', 'promoted', 'Page Turners', NOW(), ARRAY[1], 'passing', 1) RETURNING id`,
      [app.id, botUser.id],
    );
    await pool.query(
      'UPDATE homeroom_bot_runs SET live_build_waiting_at = NULL, build_ok = TRUE, proposal_session_id = $2 WHERE id = $1',
      [firstRun.id, first.id],
    );
    assert.deepEqual((await mine()).map((c) => c.state.stage), ['waiting_first_version', 'waiting_first_version']);
  });

  await t.test('the first version merges: the pick-up moves her card on, and a re-read moves the rest', async () => {
    const { rows: [first] } = await pool.query(
      `SELECT id FROM chat_sessions WHERE app_id = $1 AND linked_issues = ARRAY[1]`, [app.id],
    );
    await asKernel(`UPDATE chat_sessions SET status = 'merged', merged_at = NOW(), live_at = NOW() WHERE id = $1`, [first.id]);
    const logger = require('../src/services/logger');
    const said = [];
    const realInfo = logger.info;
    logger.info = (cat, msg, data) => { said.push({ msg, data }); };
    try {
      await bot.noteRequestMerged(pool, { id: first.id }, { worker: { async stopTurn() {} } });
    } finally {
      logger.info = realInfo;
    }
    assert.ok(said.some((s) => /first version is live; what waited for it is picked up now/.test(s.msg)),
      'the loop is woken for what waited');
    // The lane looks again: #2, first in line, is granted the project's one
    // read (its row started), and #3 is next.
    const startedAt = async (n) => (await pool.query(
      'SELECT started_at FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = $2', [app.id, n],
    )).rows[0]?.started_at ?? null;
    await until(async () => (await startedAt(2)) != null, '#2 granted its read');
    assert.equal(await startedAt(3), null);
    assert.deepEqual(await readable(), [3], 'no longer held: #3 waits only for the project\'s one read');

    // The look on #2 starts: her card for it is pushed again, and reads as
    // being read (its work state: reading), never as building yet.
    await rederive(2, 3);
    pushed.length = 0;
    await botChat.noteRequestStatus(pool, { appId: app.id, issueNumber: 2, status: 'reading', deps: deps(null) });
    const books = cardsTo(priya).find((c) => c.messageId === booksId);
    assert.equal(books.state.stage, 'reading');
    assert.ok(Number.isFinite(books.typicalMinutes));
    assert.equal(cardWords(books), `Got it: ${BOOKS}. Usually about ${books.typicalMinutes} minutes. ${STAYS}`);
    assert.equal(cardsTo(priya).filter((c) => c.messageId === goalId).length, 0, 'the other request\'s moment has not come');

    // #3 is not picked up yet (the project reads one at a time). The chat's
    // minute re-read (GET my-bot-requests) says it is no longer held.
    const goal = (await mine()).find((c) => c.messageId === goalId);
    assert.equal(goal.state.stage, 'reading');
    assert.equal(cardWords(goal), `Got it: Add a yearly reading goal. Usually about ${goal.typicalMinutes} minutes.`);
    assert.deepEqual(chipFrames(), [], 'and nothing for the room, all along');
  });
});
