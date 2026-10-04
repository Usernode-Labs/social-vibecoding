'use strict';

// Fix in place, and cards that follow their request (5 October run-through).
//
// "Flat 4B Chores", a group project. Its first version, a change Homeroom
// bot built, waited for approval with a bug in it. Sam wrote in the
// project's chat: "@homeroom_bot can you fix mark as done in Jordan's first
// version instead?" The bot filed a NEW request, to be built from the
// starter as one more competing version, and Sam's private card read "Got
// it: Fix mark as done feature in Jordan's first version. Usually about 11
// minutes." Sam's earlier card ("Got it: Add a night-before reminder for bin
// day") still read that way 50 minutes later, with the change built and
// waiting for approval.
//
// Now a mention asking to fix one of the bot's changes still waiting for
// approval goes to that change (the DM's revise_proposal, every gate kept):
// its words are posted in the change's discussion and the bot's follow-up is
// queued. The room sees Fixing on the message. And every card says where its
// request stands, read from the records, not what it said when it was filed.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-chat-revise.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const botChat = require('../src/services/homeroom-bot-chat');

const FIRST = { id: 70, issueNumber: 1, title: 'Chores for two with undo', firstVersion: true };
const BINS = { id: 71, issueNumber: 4, title: 'Add a night-before reminder for bin day', firstVersion: false };

test('which pending change a message names itself, without the model', () => {
  const changes = [BINS, FIRST];
  const pick = (words, extra = {}) => botChat.pickChange({ words, changes, slug: 'flat-4b', ...extra });
  assert.deepEqual(pick('can you fix mark as done in Jordan\'s first version instead?'), { change: FIRST, why: 'first_version' });
  assert.deepEqual(pick('the Add a night-before reminder for bin day one is wrong'), { change: BINS, why: 'title' });
  assert.deepEqual(pick('fix this https://onhomeroom.com/app/flat-4b/dev/proposals/71 please'), { change: BINS, why: 'link' });
  assert.deepEqual(pick('fix this #app/flat-4b/dev/proposals/70'), { change: FIRST, why: 'link' });
  assert.equal(pick('fix #app/other-app/dev/proposals/70'), null, 'another project\'s link names none of these');
  assert.deepEqual(pick('can you make it earlier', { quoted: { sessionIds: [71], issueNumbers: [] } }), { change: BINS, why: 'reply' });
  assert.deepEqual(pick('can you make it earlier', { quoted: { sessionIds: [], issueNumbers: [1] } }), { change: FIRST, why: 'reply' });
  assert.equal(pick('can you make the list sortable?'), null, 'nothing named: the read decides');
  assert.equal(botChat.pickChange({ words: 'fix the first version', changes: [BINS] }), null, 'no first version among them');
  assert.equal(botChat.pickChange({ words: 'fix it', changes: [] }), null);
  assert.deepEqual(botChat.offeredChanges(changes), [
    { id: 'c1', title: BINS.title, firstVersion: false },
    { id: 'c2', title: FIRST.title, firstVersion: true },
  ]);
});

test('the read may answer revise only naming a change it was offered', () => {
  const llm = require('../src/services/llm');
  const offered = [{ id: 'c1', title: 'x' }];
  assert.deepEqual(llm.chatAskVerdict({ kind: 'revise', title: 'Fix mark as done', change: 'c1' }, offered),
    { kind: 'revise', title: 'Fix mark as done', change: 'c1' });
  assert.equal(llm.chatAskVerdict({ kind: 'revise', title: 'Fix mark as done', change: 'c7' }, offered).kind, 'change',
    'a change it was not offered is a new request, never a guess at somebody\'s change');
  assert.equal(llm.chatAskVerdict({ kind: 'revise', title: 'Fix it', change: 'c1' }, []).kind, 'unsure', 'nothing offered, no revise');
  assert.deepEqual(llm.chatAskVerdict({ kind: 'question', title: '', change: '' }, offered), { kind: 'question', title: null, change: null });
  const src = read('src/services/llm.js');
  assert.match(src, /"revise": it asks to fix or change one of the changes above before it goes live\. Set "change" to that change's id\./);
  assert.match(src, /output_config: \{ format: \{ type: 'json_schema', schema: offered\.length \? CHAT_ASK_REVISE_SCHEMA : CHAT_ASK_SCHEMA \} \}/);
});

test('where a request stands, from its records', () => {
  const stage = (row) => botChat.stageOf({ kind: 'filed', ...row });
  assert.equal(stage({}), 'reading', 'not looked at yet');
  assert.equal(stage({ run_id: 1, verdict: 'question' }), 'question');
  assert.equal(stage({ run_id: 1, verdict: 'question', queued: true }), 'reading', 'answered, read again');
  assert.equal(stage({ run_id: 1, verdict: 'ready', build_waiting_at: new Date(), build_status: null }), 'waiting');
  assert.equal(stage({ run_id: 1, verdict: 'ready', build_status: 'active' }), 'building');
  assert.equal(stage({ session_status: 'active' }), 'building');
  assert.equal(stage({ session_status: 'promoted', check_state: 'running' }), 'checking');
  assert.equal(stage({ session_status: 'promoted', check_state: 'passing' }), 'proposed');
  assert.equal(stage({ session_status: 'merged', chip: { status: 'ready' } }), 'approved', 'live once the app answers');
  assert.equal(stage({ session_status: 'merged', chip: { status: 'live' } }), 'live');
  assert.equal(stage({ session_status: 'closed' }), 'closed');
  assert.equal(stage({ run_id: 1, verdict: 'ready', build_ok: false, build_error: 'tests failed' }), 'stopped');
  assert.equal(stage({ run_id: 1, verdict: 'person' }), 'person');
  const fix = (row) => botChat.stageOf({ kind: 'revise', session_status: 'promoted', ...row });
  assert.equal(fix({}), 'fixing');
  assert.equal(fix({ run_id: 2, verdict: 'revise', queued: true }), 'fixing', 'a follow-up still to come');
  assert.equal(fix({ run_id: 2, verdict: 'revise', check_state: 'running' }), 'checking');
  assert.equal(fix({ run_id: 2, verdict: 'revise', check_state: 'passing' }), 'proposed');
  assert.equal(fix({ run_id: 2, verdict: 'question' }), 'asked');
  assert.equal(fix({ run_id: 2, verdict: 'answer' }), 'answered');
  assert.equal(fix({ run_id: 2, verdict: 'failed' }), 'stopped');
  assert.equal(fix({ session_status: 'closed' }), 'closed');
  // The chip each settles: Try it, none, Fixing; else the moments' own.
  const row = { kind: 'revise', issue_number: 1, session_id: 70 };
  assert.deepEqual(botChat.chipFor(row, 'proposed'), { issueNumber: 1, status: 'ready', sessionId: 70 });
  assert.deepEqual(botChat.chipFor(row, 'fixing'), { issueNumber: 1, status: 'fixing', sessionId: 70 });
  assert.equal(botChat.chipFor(row, 'asked'), null);
  assert.equal(botChat.chipFor({ ...row, kind: 'filed' }, 'stopped'), null);
  assert.equal(botChat.chipFor({ ...row, kind: 'filed' }, 'building'), undefined, 'the moments say building');
  assert.equal(botChat.chipFor({ ...row, kind: 'filed' }, 'live'), undefined, 'only the app\'s answer says Live');
  for (const s of ['reading', 'proposed', 'fixing', 'asked']) assert.ok(botChat.CARD_STAGES.includes(s), s);
});

test('what the card and the chip say, at every stage', () => {
  const { BotStatusChip, BotRequestCardView, cardWords, approvalWords } = loadTsx('frontend/src/features/group-chat/bot-request.tsx');
  const bins = (stage, extra = {}) => cardWords({ kind: 'filed', title: BINS.title, messageId: 1, issueNumber: 4, state: { stage, ...extra } });
  assert.equal(cardWords({ kind: 'filed', title: BINS.title, messageId: 1, issueNumber: 4, typicalMinutes: 11 }),
    'Got it: Add a night-before reminder for bin day. Usually about 11 minutes.', 'unchanged while it is read');
  assert.equal(bins('building'), 'Building it now: Add a night-before reminder for bin day.');
  assert.equal(bins('checking'), 'Built: Add a night-before reminder for bin day. Testing it now.');
  assert.equal(bins('proposed', { sessionId: 71, youApprove: true, waitingOn: ['jordan'] }),
    'Built: Add a night-before reminder for bin day. Waiting for approval from you and @jordan.');
  assert.equal(bins('approved'), 'Approved: Add a night-before reminder for bin day. It’s going live.');
  assert.equal(bins('live'), 'Live: Add a night-before reminder for bin day.');
  assert.equal(bins('stopped'), 'I couldn’t finish this. Our chat says why.');
  assert.equal(bins('question'), 'I have a question about this. It’s in our chat.');
  assert.equal(approvalWords({ stage: 'proposed' }), 'Waiting for approval.');
  assert.equal(approvalWords({ stage: 'proposed', waitingOn: ['a', 'b', 'c'], more: 2 }), 'Waiting for approval from @a, @b, @c and 2 more.');
  const fix = (stage, extra = {}) => cardWords({ kind: 'revise', title: FIRST.title, messageId: 2, issueNumber: 1, sessionId: 70, firstVersion: true, state: { stage, sessionId: 70, ...extra } });
  assert.equal(fix('fixing'), 'Got it. I’ll fix that in the first version before it goes live.');
  assert.equal(fix('proposed', { youApprove: true, waitingOn: ['jordan'] }), 'Updated the first version. Waiting for approval from you and @jordan.');
  assert.equal(fix('live'), 'The first version is live.');
  assert.equal(fix('asked'), 'I have a question about your fix. It’s in the discussion of the first version.');
  assert.equal(cardWords({ kind: 'revise', title: BINS.title, messageId: 3, issueNumber: 4, sessionId: 71, state: { stage: 'fixing' } }),
    'Got it. I’ll fix that in “Add a night-before reminder for bin day” before it goes live.');
  assert.equal(cardWords({ kind: 'revise_refused', title: BINS.title, messageId: 3, issueNumber: 4, sessionId: 71 }),
    'I couldn’t change “Add a night-before reminder for bin day” just now. You can say what you want in its discussion.');
  for (const words of [bins('proposed', { waitingOn: ['jordan'] }), fix('fixing'), fix('stopped')]) assert.ok(!/\u2014/.test(words), words);
  // Buttons: Try it once built, See change on a fix, Open chat when it stopped.
  const view = (card) => renderToHtml(createElement(BotRequestCardView, { card }));
  const built = view({ kind: 'filed', title: BINS.title, messageId: 1, issueNumber: 4, state: { stage: 'proposed', sessionId: 71 } });
  assert.match(built, /data-bot-request-action="try"><span>Try it/);
  assert.ok(!/See progress/.test(built));
  assert.match(view({ kind: 'filed', title: 'x', messageId: 1, issueNumber: 4, state: { stage: 'building' } }), /data-bot-request-action="progress"><span>See progress/);
  assert.match(view({ kind: 'filed', title: 'x', messageId: 1, issueNumber: 4, state: { stage: 'stopped' } }), /data-bot-request-action="chat"><span>Open chat/);
  const fixing = view({ kind: 'revise', title: FIRST.title, messageId: 2, issueNumber: 1, sessionId: 70, firstVersion: true, state: { stage: 'fixing', sessionId: 70 } });
  assert.match(fixing, /data-bot-request-card="revise"/);
  assert.match(fixing, /data-bot-request-action="change"><span>See change/);
  assert.match(fixing, /Only you can see this/);
  // Everybody in the room sees the fix asked for on the message.
  assert.match(renderToHtml(createElement(BotStatusChip, { chip: { status: 'fixing', issueNumber: 1, sessionId: 70 } })),
    /data-bot-request="fixing"[^>]*>.*🔧.*Fixing/);
  // The chat draws the chip, opens the change, and reads its cards again.
  const gc = read('public/js/group-chat.js');
  assert.match(gc, /\['reading', 'building', 'ready', 'live', 'fixing'\]\.includes\(value\.status\)/);
  assert.match(gc, /openBotChange\(sessionId\) \{[\s\S]*?location\.hash = `#app\/\$\{encodeURIComponent\(GroupChat\.appSlug\)\}\/dev\/proposals\/\$\{id\}`;/);
  assert.match(gc, /_followBotCards\(\) \{[\s\S]*?\}, 60 \* 1000\);/);
  assert.match(gc, /window\.addEventListener\('homeroom-bot-work-changed', GroupChat\._botWorkListener\);/,
    'the bot\'s work moving on reads the cards again');
  const row = read('frontend/src/features/group-chat/transcript.tsx');
  assert.match(row, /onTry: \(sessionId\) => chat\?\.tryBotChange\?\.\(sessionId\),\s*onChange: \(sessionId\) => chat\?\.openBotChange\?\.\(sessionId\),/);
  // The schema keeps the change a fix went to.
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ALTER TABLE chat_bot_requests ADD COLUMN IF NOT EXISTS session_id INTEGER REFERENCES chat_sessions\(id\) ON DELETE SET NULL;/);
});

test('Flat 4B Chores, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_revise_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = read('src/db/schema.sql');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent
  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2)
     RETURNING id, username, is_synthetic AS "isSynthetic", has_platform_access AS "hasPlatformAccess", is_admin AS "isAdmin"`,
    [username, synthetic],
  )).rows[0];
  const bot = await user('homeroom_bot', true);
  const jordan = await user('jordan');
  const sam = await user('sam');
  const { rows: [inserted] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility, repo_url)
     VALUES ('Flat 4B Chores', 'flat-4b', 'running', $1, 'private', 'private', 'https://github.com/example/flat-4b')
     RETURNING id`,
    [jordan.id],
  );
  const app = (await pool.query('SELECT id, slug, name, repo_url, community_id FROM apps WHERE id = $1', [inserted.id])).rows[0];
  for (const person of [jordan, sam]) {
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, person.id]);
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`, [app.id, person.id]);
  }
  const set = (key, value) => pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
  await set('homeroom_bot_dm_users', JSON.stringify(['jordan', 'sam']));
  await set('homeroom_bot_mode', 'live');
  await set('homeroom_bot_live_apps', JSON.stringify(['flat-4b']));

  // Jordan's first version: the bot's change, waiting for approval, not live.
  await pool.query(
    `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, status, issue_number, filed_at)
     VALUES ($1, $2, 'Chores for the two of us, with undo', 'filed', 1, NOW())`,
    [app.id, jordan.id],
  );
  await pool.query(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, first_version)
     VALUES ($1, 1, $2, 'Flat 4B Chores, first version', TRUE)`,
    [app.id, jordan.id],
  );
  await pool.query(
    `INSERT INTO issues (app_id, github_issue_number, title, description, kind, payload, created_by)
     VALUES ($1, 1, 'Flat 4B Chores, first version', 'brief', 'general', '{}', $2)`,
    [app.id, jordan.id],
  );
  const { rows: [first] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, promoted_at, linked_issues, check_state, pr_number)
     VALUES ($1, $2, 'hrbot/first', 'promoted', 'Chores for two with undo', NOW(), ARRAY[1], 'passing', 11) RETURNING id`,
    [app.id, bot.id],
  );

  let nextIssue = 4;
  const created = [];
  const frames = [];
  const pushed = [];
  const threadPosts = [];
  const reads = [];
  const deps = (answer) => ({
    readAsk: async (args) => { reads.push(args); return answer; },
    github: {
      isEnabled: () => true,
      safeMention: (s) => s,
      createIssue: async (owner, repo, issue) => { created.push(issue); nextIssue += 1; return { number: nextIssue }; },
    },
    ws: {
      broadcast: (appId, frame) => frames.push(frame),
      pushToUser: (userId, frame) => pushed.push({ userId, frame }),
      sendSystemMessage: async () => {},
      pushIssueUpdate: () => {},
      async handleMessage(_pool, client, msg) {
        threadPosts.push({ userId: client.user.id, appId: client.appId, msg });
        return { ok: true, message: { id: threadPosts.length } };
      },
    },
    notifications: { createIssueOpenedNotifications: async () => [] },
  });
  const say = async (who, content, metadata = {}) => (await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata) VALUES ($1, $2, $3, 'message', $4) RETURNING id`,
    [app.id, who.id, content, JSON.stringify(metadata)],
  )).rows[0].id;
  const note = (who, id, content, answer) => botChat.noteChatMessage(pool, null, {
    appId: app.id, userId: who.id, messageId: id, content, deps: deps(answer),
  });
  const metaOf = async (id) => (await pool.query('SELECT metadata FROM chat_messages WHERE id = $1', [id])).rows[0].metadata;
  const cardsTo = (who) => pushed.filter((p) => p.userId === who.id && p.frame.type === 'bot_request_card').map((p) => p.frame.card);
  const queued = async (n) => (await pool.query(
    'SELECT reason, requested_by FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = $2', [app.id, n],
  )).rows[0] || null;
  const { cardWords } = loadTsx('frontend/src/features/group-chat/bot-request.tsx');

  let binsId;
  await t.test('her earlier request, asked while the first version waits, is filed as before', async () => {
    const text = '@homeroom_bot add a night-before reminder for bin day';
    binsId = await say(sam, text);
    const out = await note(sam, binsId, text, { kind: 'change', title: BINS.title });
    assert.equal(out.ok, true);
    assert.equal(created.length, 1, 'asks for something new: a request');
    assert.deepEqual(reads.at(-1).changes, [{ id: 'c1', title: 'Chores for two with undo', firstVersion: true }],
      'the read was offered the first version beside filing');
    assert.equal(out.card.kind, 'filed');
    assert.equal(out.card.state.stage, 'reading');
  });

  let fixId;
  await t.test('"fix mark as done in Jordan\'s first version" goes to the first version, not a new request', async () => {
    const text = 'Oops haha. Let\'s keep your first one, it has us two and undo. @homeroom_bot can you fix mark as done in Jordan\'s first version instead?';
    fixId = await say(sam, text);
    pushed.length = 0;
    const out = await note(sam, fixId, text, { kind: 'change', title: 'Fix mark as done in the first version', change: null });
    assert.equal(out.ok, true);
    assert.equal(created.length, 1, 'no new request, no fourth competing version');
    const { rows: [row] } = await pool.query('SELECT kind, issue_number, session_id, title FROM chat_bot_requests WHERE chat_message_id = $1', [fixId]);
    assert.deepEqual(row, { kind: 'revise', issue_number: 1, session_id: first.id, title: 'Chores for two with undo' });
    // Her words went into the first version's discussion, as hers, and its follow-up is first in the queue.
    assert.equal(threadPosts.length, 1);
    assert.equal(threadPosts[0].userId, sam.id);
    assert.deepEqual(threadPosts[0].msg.thread, { type: 'session', ref: first.id });
    assert.match(threadPosts[0].msg.content, /^Oops haha\. Let's keep your first one, it has us two and undo\. can you fix mark as done in Jordan's first version instead\?\n\n\(Sent in a chat with Homeroom bot\. The change asked for, as Homeroom bot understood it: Fix mark as done in the first version\.\)$/);
    assert.deepEqual(await queued(1), { reason: 'dm_revise', requested_by: sam.id });
    // Everybody in the room sees it is being fixed; only she gets the card.
    assert.deepEqual((await metaOf(fixId)).botRequest, { issueNumber: 1, status: 'fixing', sessionId: first.id });
    assert.deepEqual(frames.at(-1), { type: 'bot_request_status', messageId: fixId, botRequest: { issueNumber: 1, status: 'fixing', sessionId: first.id } });
    const card = cardsTo(sam).at(-1);
    assert.deepEqual([card.kind, card.sessionId, card.firstVersion, card.state.stage], ['revise', first.id, true, 'fixing']);
    assert.equal(cardWords(card), 'Got it. I’ll fix that in the first version before it goes live.');
    assert.equal(pushed.filter((p) => p.frame.type === 'bot_request_card' && p.userId !== sam.id).length, 0, 'nobody else\'s');
    const { rows: room } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM chat_messages WHERE app_id = $1 AND thread_type IS NULL AND user_id = $2', [app.id, bot.id]);
    assert.equal(room[0].n, 0, 'the bot wrote nothing into the room');
    // Asked again (an edit, a retry): nothing more is sent.
    await note(sam, fixId, text, { kind: 'change', title: 'x' });
    assert.equal(threadPosts.length, 1);
  });

  await t.test('her card follows the fix: updated, then waiting for approval from her and Jordan', async () => {
    // The follow-up revised it; its checks run.
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 1', [app.id]);
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id) VALUES ($1, 1, 'live', 'revise', $2)`,
      [app.id, first.id],
    );
    await pool.query(`UPDATE chat_sessions SET check_state = 'running', approval_epoch = 1 WHERE id = $1`, [first.id]);
    const sams = { id: sam.id, username: 'sam', hasPlatformAccess: true };
    let mine = await botChat.myRequests(pool, { app, user: sams, deps: deps(null) });
    const fixCard = () => mine.cards.find((c) => c.messageId === fixId);
    assert.equal(fixCard().state.stage, 'checking');
    assert.equal((await metaOf(fixId)).botRequest.status, 'fixing', 'still Fixing for the room while it is tested');
    // Its checks pass: the moment (noteChangeReady) moves her chip and pushes her card.
    await pool.query(`UPDATE chat_sessions SET check_state = 'passing' WHERE id = $1`, [first.id]);
    pushed.length = 0;
    await botChat.noteRequestStatus(pool, { appId: app.id, issueNumber: 1, status: 'ready', sessionId: first.id, deps: deps(null) });
    assert.deepEqual((await metaOf(fixId)).botRequest, { issueNumber: 1, status: 'ready', sessionId: first.id }, 'Try it, for everybody');
    const card = cardsTo(sam).find((c) => c.messageId === fixId);
    assert.equal(card.state.stage, 'proposed');
    assert.equal(cardWords(card), 'Updated the first version. Waiting for approval from you and @jordan.');
    mine = await botChat.myRequests(pool, { app, user: sams, deps: deps(null) });
    assert.equal(fixCard().state.stage, 'proposed', 'and the same after a reload');
  });

  await t.test('her bin-day card follows its request: built, waiting for approval, approved, live', async () => {
    const sams = { id: sam.id, username: 'sam', hasPlatformAccess: true };
    const n = nextIssue; // the bin-day request
    const binsCard = async () => (await botChat.myRequests(pool, { app, user: sams, deps: deps(null) })).cards.find((c) => c.messageId === binsId);
    assert.equal((await binsCard()).state.stage, 'reading');
    // Read and built; its change is up and its checks passed. The ready moment was missed.
    const { rows: [built] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, promoted_at, linked_issues, check_state, pr_number)
       VALUES ($1, $2, 'hrbot/bins', 'promoted', $3, NOW(), ARRAY[$4::int], 'passing', 12) RETURNING id`,
      [app.id, bot.id, BINS.title, n],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_ok, proposal_session_id) VALUES ($1, $2, 'live', 'ready', TRUE, $3)`,
      [app.id, n, built.id],
    );
    frames.length = 0;
    const card = await binsCard();
    assert.deepEqual([card.state.stage, card.state.sessionId, card.state.youApprove, card.state.waitingOn], ['proposed', built.id, true, ['jordan']]);
    assert.equal(cardWords(card), 'Built: Add a night-before reminder for bin day. Waiting for approval from you and @jordan.');
    // The read put the chip right for the room: Try it, not Reading.
    assert.deepEqual((await metaOf(binsId)).botRequest, { issueNumber: n, status: 'ready', sessionId: built.id });
    assert.deepEqual(frames.at(-1), { type: 'bot_request_status', messageId: binsId, botRequest: { issueNumber: n, status: 'ready', sessionId: built.id } });
    // Approved and merged: going live until the app answers, then Live.
    await pool.query(`UPDATE chat_sessions SET status = 'merged' WHERE id = $1`, [built.id]);
    assert.equal(cardWords(await binsCard()), 'Approved: Add a night-before reminder for bin day. It’s going live.');
    pushed.length = 0;
    await botChat.noteRequestStatus(pool, { appId: app.id, issueNumber: n, status: 'live', deps: deps(null) });
    assert.equal((await metaOf(binsId)).botRequest.status, 'live');
    assert.equal(cardWords(cardsTo(sam).find((c) => c.messageId === binsId)), 'Live: Add a night-before reminder for bin day.');
  });

  await t.test('a request whose build failed loses its chip, and its card says so', async () => {
    const text = '@homeroom_bot add a rota for the bathroom';
    const id = await say(sam, text);
    await note(sam, id, text, { kind: 'change', title: 'Add a bathroom rota' });
    const n = nextIssue;
    assert.equal((await metaOf(id)).botRequest.status, 'reading');
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_ok, build_error) VALUES ($1, $2, 'live', 'ready', FALSE, 'the build did not finish')`,
      [app.id, n],
    );
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = $2', [app.id, n]);
    const mine = await botChat.myRequests(pool, { app, user: { id: sam.id, username: 'sam' }, deps: deps(null) });
    assert.equal(cardWords(mine.cards.find((c) => c.messageId === id)), 'I couldn’t finish this. Our chat says why.');
    assert.equal((await metaOf(id)).botRequest, undefined);
  });

  await t.test('with several pending changes and none named, the read chooses, and only among them', async () => {
    const { rows: [second] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, promoted_at, linked_issues, check_state)
       VALUES ($1, $2, 'hrbot/rota', 'promoted', 'Add a weekly rota', NOW(), ARRAY[30], 'passing') RETURNING id`,
      [app.id, bot.id],
    );
    await pool.query('INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, 30, $2, $3)', [app.id, jordan.id, 'Add a weekly rota']);
    const text = '@homeroom_bot the rota should start on Monday';
    const id = await say(jordan, text);
    const before = { posts: threadPosts.length, issues: created.length };
    await note(jordan, id, text, { kind: 'revise', title: 'Start the rota on Monday', change: 'c1' });
    assert.deepEqual(reads.at(-1).changes.map((c) => c.id), ['c1', 'c2'], 'newest first');
    assert.equal(reads.at(-1).changes[0].title, 'Add a weekly rota');
    const { rows: [row] } = await pool.query('SELECT kind, session_id FROM chat_bot_requests WHERE chat_message_id = $1', [id]);
    assert.deepEqual(row, { kind: 'revise', session_id: second.id });
    assert.equal(threadPosts.length, before.posts + 1);
    assert.equal(threadPosts.at(-1).msg.thread.ref, second.id);
    assert.equal(created.length, before.issues);
    // A revise naming nothing it was offered (the read's verdict checked) is filed.
    const other = '@homeroom_bot add a shopping list';
    const otherId = await say(jordan, other);
    await note(jordan, otherId, other, { kind: 'change', title: 'Add a shopping list', change: null });
    assert.equal(created.length, before.issues + 1, 'something new: a request');
  });

  await t.test('a fix a gate refuses is said to her, and nothing is filed, posted or recorded', async () => {
    for (let i = 0; i < 3; i += 1) {
      await pool.query(
        `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id) VALUES ($1, 1, 'live', 'revise', $2)`,
        [app.id, first.id],
      );
    }
    const text = '@homeroom_bot and fix undo in the first version too';
    const id = await say(sam, text);
    const before = { posts: threadPosts.length, issues: created.length };
    pushed.length = 0;
    const out = await note(sam, id, text, { kind: 'change', title: 'Fix undo' });
    assert.deepEqual([out.ok, out.code, out.card.kind, out.card.firstVersion], [false, 'revise_refused', 'revise_refused', true]);
    assert.equal(cardWords(out.card), 'I couldn’t change the first version just now. You can say what you want in its discussion.');
    assert.equal(cardsTo(sam).at(-1).kind, 'revise_refused');
    assert.equal(threadPosts.length, before.posts);
    assert.equal(created.length, before.issues);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM chat_bot_requests WHERE chat_message_id = $1', [id])).rows[0].n, 0);
    assert.equal((await metaOf(id)).botRequest, undefined);
  });

  await t.test('a reply to a message wearing a change\'s Try it names that change', async () => {
    const text = '@homeroom_bot make it a bit earlier';
    const id = await say(sam, text, { quote: { source: 'message', refMsgId: fixId, author: 'sam', snippet: 'x' } });
    const refs = await botChat.quotedRefs(pool, { appId: app.id, messageId: id });
    assert.deepEqual(refs, { sessionIds: [first.id], issueNumbers: [1] });
  });
});
