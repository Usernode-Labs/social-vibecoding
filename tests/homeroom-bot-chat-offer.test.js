'use strict';

// WP-C: somebody new to a project adds something back from its chat.
//
// A newcomer (joined in the last two weeks, nothing asked for there yet)
// need not mention Homeroom bot: when a message of theirs reads as an idea
// for the app, their own card offers "Suggest it" / "Not now". Suggest it
// files it as a request in their name, whether or not the bot is theirs; the
// first request somebody files says it stays with their name on it. Never
// for the project's maker, a member of long standing, somebody who has asked
// already, a message of a few words, or past the budget of reads.
//
// Run with: TEST_DATABASE_URL=postgres://... node --test tests/homeroom-bot-chat-offer.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

// The card's two fixed lines, as the catalog holds them (bot-request.tsx reads them by id).
const STAYS_LINE = 'It stays in the project’s requests with your name on it.';
const SHARED_LINE = message('chat:group.botCard.shared');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const botChat = require('../src/services/homeroom-bot-chat');

test('WP-C: the offer card, and the line under a first request', () => {
  const { BotRequestCardView, cardWords } = loadTsx('frontend/src/features/group-chat/bot-request.tsx');
  assert.equal(cardWords({ kind: 'offer', title: 'Add a Sunday reminder' }),
    'Suggest this to the group? It goes in the project’s requests as “Add a Sunday reminder”, in your name.');
  const offer = renderToHtml(createElement(BotRequestCardView, { card: { messageId: 5, kind: 'offer', title: 'Add tags', issueNumber: null } }));
  assert.match(offer, /data-bot-request-card="offer"/);
  assert.match(offer, /data-bot-request-action="file"><span>Suggest it/);
  assert.match(offer, /data-bot-request-action="not-now"><span>Not now/);
  assert.equal(cardWords({ kind: 'group', title: 'Add tags', first: true }), `Filed as a request for the group: Add tags. ${STAYS_LINE}`);
  // The line is the end of a whole catalog message that follows what the card already said.
  assert.equal(cardWords({ kind: 'group', title: 'Add tags', first: true }), message('chat:group.botCard.withStays', { words: 'Filed as a request for the group: Add tags.' }));
  assert.equal(cardWords({ kind: 'group', title: 'Add tags' }), 'Filed as a request for the group: Add tags.', 'only the first says it');
  assert.equal(message('chat:group.botCard.withStays', { words: 'X.' }), `X. ${STAYS_LINE}`);
});

// 5 October 2026 (Evan, on his phone): "if you choose to submit it an idea,
// it should also at that point share it with the group that homeroom bot is
// looking at it? Not just stay private at that point". The room's sign is the
// chip on the message, so Suggest it must put it there itself, in the same
// request, rather than leave it to the bot's next moment; and the chip must
// say in words that Homeroom bot has it. Without PostgreSQL: the pool answers
// the path's own queries, and nothing but Suggest it runs.
test('WP-C: Suggest it puts the chip on the message for the whole room at once, saying Homeroom bot has it', async (t) => {
  const { BotStatusChip, BotRequestCardView, cardWords, sharedNow } = loadTsx('frontend/src/features/group-chat/bot-request.tsx');
  const APP = { id: 7, slug: 'page-turners', name: 'Page Turners', repo_url: 'https://github.com/example/page-turners' };
  const priya = { id: 21, username: 'priya', hasPlatformAccess: true };
  const MSG = 501;
  const TITLE = 'Keep a list of the books we have read';
  const TEXT = 'Could it also keep a list of the books we have read, with star ratings?';
  const suggest = async ({ held }) => {
    const order = [];
    const frames = [];
    const pushed = [];
    let request = {
      chat_message_id: MSG, app_id: APP.id, requester_id: priya.id, kind: 'offer', title: TITLE, issue_number: null, session_id: null,
    };
    let chip = null;
    const pool = {
      async query(sql, params = []) {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        if (s.startsWith('SELECT id, user_id, content, thread_type')) {
          return { rows: [{ id: MSG, user_id: priya.id, content: TEXT, thread_type: null, msg_type: 'message', deleted_at: null, posted_via: null }] };
        }
        if (s.startsWith('SELECT * FROM chat_bot_requests WHERE chat_message_id')) return { rows: [request] };
        if (s.startsWith('SELECT COUNT(*)::int AS n FROM chat_bot_requests')) return { rows: [{ n: 0 }] };
        if (s.startsWith('INSERT INTO chat_bot_requests')) {
          request = { ...request, kind: params[3], issue_number: params[4], title: params[5], session_id: params[6] };
          order.push('recorded');
          return { rows: [request] };
        }
        if (s.startsWith('SELECT n.id FROM notifications')) return { rows: [] };
        if (s.includes("m.metadata->'botRequest' AS chip")) {
          return {
            rows: [{
              chat_message_id: MSG, kind: request.kind, issue_number: request.issue_number, app_id: APP.id, chip,
              queued: true, queue_waiting: true, queue_reason: 'chat_request', first_version: false, issue_status: 'open',
              run_id: null, session_id: null, session_status: null, check_state: null,
            }],
          };
        }
        if (s.startsWith('SELECT MIN(github_issue_number)')) return { rows: [{ n: request.issue_number }] };
        if (s.startsWith('UPDATE chat_messages SET metadata')) {
          chip = params[2] ? JSON.parse(params[2]) : null;
          order.push('chip');
          return { rows: [{ id: MSG }] };
        }
        throw new Error(`a query Suggest it should not make: ${s.slice(0, 90)}`);
      },
    };
    const deps = {
      dm: { hasBot: () => true, botAccount: async () => ({ id: 1 }), typicalMinutes: async () => 10 },
      botSvc: {
        readSettings: async () => ({}),
        firstVersionHolds: async () => new Set(held ? [APP.id] : []),
        heldForFirstVersion: (holds, { appId }) => holds.has(Number(appId)),
      },
      liveSvc: { isLiveFor: () => true },
      mayor: { fileRequest: async () => { order.push('filed'); return { issueNumber: 4, queueId: null }; } },
      ws: {
        broadcast: (appId, frame) => { order.push('broadcast'); frames.push({ appId, frame }); },
        pushToUser: (userId, frame) => pushed.push({ userId, frame }),
      },
    };
    const out = await botChat.requestFromMessage(pool, null, { app: APP, user: priya, messageId: MSG, deps });
    return { out, order, frames, pushed, chip };
  };

  await t.test('the first version is live: Homeroom bot is looking at it', async () => {
    const { out, order, frames, pushed, chip } = await suggest({ held: false });
    assert.equal(out.ok, true);
    assert.deepEqual([out.card.kind, out.card.issueNumber, out.card.first, out.card.state.stage], ['filed', 4, true, 'reading']);
    // Filed, recorded, then the chip set and sent to everybody in the room,
    // all before Suggest it answers.
    assert.deepEqual(order, ['filed', 'recorded', 'chip', 'broadcast']);
    assert.deepEqual(chip, { issueNumber: 4, status: 'reading' });
    assert.deepEqual(frames, [{ appId: APP.id, frame: { type: 'bot_request_status', messageId: MSG, botRequest: { issueNumber: 4, status: 'reading' } } }]);
    // The card is hers alone; the chip is the room's.
    assert.deepEqual(pushed.map((p) => [p.userId, p.frame.type]), [[priya.id, 'bot_request_card']]);
    const html = renderToHtml(createElement(BotStatusChip, { chip }));
    assert.match(html, /<span[^>]*data-bot-request="reading"[^>]*>.*👀.*Homeroom bot is looking at this</);
    // Her card says the room can see it, under what it said before.
    assert.equal(cardWords(out.card), `Got it: ${TITLE}. Usually about 10 minutes. It stays in the project’s requests with your name on it.`);
    assert.equal(sharedNow(out.card), true);
    const card = renderToHtml(createElement(BotRequestCardView, { card: out.card }));
    assert.match(card, /Only you can see this/);
    assert.ok(card.includes(`data-bot-request-shared="">${SHARED_LINE}</p>`));
  });

  await t.test('the first version is still being built: Homeroom bot has it, never looking at it yet', async () => {
    const { out, order, frames, chip } = await suggest({ held: true });
    assert.equal(out.card.state.stage, 'waiting_first_version');
    assert.deepEqual(order, ['filed', 'recorded', 'chip', 'broadcast']);
    assert.deepEqual(chip, { issueNumber: 4, status: 'waiting_first_version' });
    assert.equal(frames[0].frame.botRequest.status, 'waiting_first_version');
    const html = renderToHtml(createElement(BotStatusChip, { chip }));
    assert.match(html, /⏳.*Homeroom bot has this</);
    assert.doesNotMatch(html, /looking at/);
    assert.equal(sharedNow(out.card), true);
  });
});

test('WP-C: the card says the room can see it only while the bot has it and has not started building', () => {
  const { sharedNow, BotRequestCardView } = loadTsx('frontend/src/features/group-chat/bot-request.tsx');
  assert.equal(SHARED_LINE, 'Everyone here can see Homeroom bot has it.');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/group-chat/bot-request.tsx'), 'utf8'),
    /data-bot-request-shared="">\{t\('chat:group\.botCard\.shared'\)\}<\/p>/);
  const filed = (stage) => ({ messageId: 5, kind: 'filed', title: 'Add tags', issueNumber: 3, ...(stage ? { state: { stage } } : {}) });
  for (const stage of [null, 'reading', 'waiting', 'waiting_first_version']) assert.equal(sharedNow(filed(stage)), true, String(stage));
  for (const stage of ['building', 'checking', 'proposed', 'live', 'stopped', 'question']) assert.equal(sharedNow(filed(stage)), false, stage);
  // No chip, nothing to say: filed for the group, an offer, a fix (its chip says so itself).
  assert.equal(sharedNow({ messageId: 5, kind: 'group', title: 'Add tags', issueNumber: 3 }), false);
  assert.equal(sharedNow({ messageId: 5, kind: 'offer', title: 'Add tags', issueNumber: null }), false);
  assert.equal(sharedNow({ messageId: 5, kind: 'revise', title: 'Add tags', issueNumber: 3, state: { stage: 'fixing' } }), false);
  assert.doesNotMatch(renderToHtml(createElement(BotRequestCardView, { card: filed('building') })), /data-bot-request-shared/);
  assert.doesNotMatch(SHARED_LINE, /—/);
});

test('WP-C: the reads behind offers are budgeted per person and per hour', () => {
  const budget = { people: new Map(), hour: { at: 0, n: 0 } };
  const t0 = 1_000_000_000;
  for (let i = 0; i < botChat.OFFER_READS_PER_DAY; i += 1) assert.equal(botChat.takeOfferRead(1, t0 + i, budget), true);
  assert.equal(botChat.takeOfferRead(1, t0 + 10, budget), false, 'their day is spent');
  assert.equal(botChat.takeOfferRead(2, t0 + 10, budget), true, 'somebody else\'s is not');
  assert.equal(botChat.takeOfferRead(1, t0 + 25 * 60 * 60 * 1000, budget), true, 'a new day');
  const busy = { people: new Map(), hour: { at: t0, n: botChat.OFFER_READS_PER_HOUR } };
  assert.equal(botChat.takeOfferRead(3, t0 + 1000, busy), false, 'everybody\'s hour is spent');
  assert.equal(botChat.takeOfferRead(3, t0 + 61 * 60 * 1000, busy), true, 'a new hour');
  assert.equal(botChat.wordCount('  could it   show the weather '), 5);
});

test('WP-C: an unaddressed message is read as an idea, not as something said to the bot', () => {
  const llm = read('src/services/llm.js');
  assert.match(llm, /async function readChatAsk\(\{ text, appName = null, toBot = true, changes = \[\], apiKey, telemetryContext \}\)/);
  assert.match(llm, /'Somebody new to the group wrote this'/);
  const schema = read('src/db/schema.sql');
  assert.match(schema, /CHECK \(kind IN \('filed', 'group', 'unsure', 'question', 'dismissed', 'offer', 'revise'\)\)/);
  // The invited person's tour ends where this happens, in Discussion, and
  // says who decides; one sentence per card (#4044), so the offer is the
  // bot's own to make there, not the card's to describe.
  assert.match(read('frontend/src/features/first-session/tour-steps.ts'),
    /title: translate\('onboarding:firstSession\.tour\.sayHi\.title'\),\s+text: translate\('onboarding:firstSession\.tour\.sayHi\.text'\),/);
  assert.deepEqual(['title', 'text'].map((part) => require('./lib/platform-i18n').message(`onboarding:firstSession.tour.sayHi.${part}`)),
    ['Say hi, or share an idea', 'The people using the app decide what goes in.']);
});

test('WP-C: offers against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_offer_${crypto.randomBytes(6).toString('hex')}`;
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
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
    [username, synthetic],
  )).rows[0];
  await user('homeroom_bot', true);
  const maya = await user('maya');
  const sam = await user('sam');
  const vet = await user('vet');
  const { rows: [community] } = await pool.query('INSERT INTO communities DEFAULT VALUES RETURNING id');
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility, repo_url, community_id)
     VALUES ('Run Club', 'run-club', 'running', $1, 'private', 'private', 'https://github.com/example/run-club', $2)
     RETURNING id, slug, name, repo_url, community_id`,
    [maya.id, community.id],
  );
  await pool.query(
    `INSERT INTO community_members (community_id, user_id, joined_at) VALUES
       ($1, $2, NOW() - INTERVAL '90 days'), ($1, $3, NOW() - INTERVAL '1 day'), ($1, $4, NOW() - INTERVAL '60 days')`,
    [community.id, maya.id, sam.id, vet.id],
  );
  // The bot is nobody's here: Sam's suggestion is filed for the group.
  const created = [];
  const pushed = [];
  let reads = 0;
  let nextIssue = 10;
  const deps = (answer) => ({
    readAsk: async (args) => { reads += 1; assert.equal(args.toBot, false); return answer; },
    takeOfferRead: () => true,
    github: {
      isEnabled: () => true,
      safeMention: (s) => s,
      createIssue: async (owner, repo, issue) => { created.push(issue); nextIssue += 1; return { number: nextIssue }; },
    },
    ws: {
      broadcast: () => {},
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
  const note = (who, id, content, answer) => botChat.noteChatMessage(pool, null, {
    appId: app.id, userId: who.id, messageId: id, content, deps: deps(answer),
  });
  const change = { kind: 'change', title: 'Show the weather for Sunday' };

  await t.test('a newcomer\'s idea is offered to them alone, and Suggest it files it in their name', async () => {
    const text = 'it would be great if it showed the weather for Sunday';
    const id = await say(sam, text);
    const card = await note(sam, id, text, change);
    assert.deepEqual([card.kind, card.title], ['offer', 'Show the weather for Sunday']);
    assert.equal(pushed.at(-1).userId, sam.id, 'his card alone');
    assert.equal(created.length, 0, 'nothing filed until he says so');
    const filed = await botChat.requestFromMessage(pool, null, {
      app, user: { id: sam.id, username: 'sam' }, messageId: id, deps: deps(null),
    });
    assert.equal(filed.ok, true);
    assert.deepEqual([filed.card.kind, filed.card.first], ['group', true]);
    assert.equal(created.length, 1);
    assert.equal(created[0].title, 'Show the weather for Sunday');
    assert.match(created[0].body, /Asked in Run Club's chat by @sam\./);
    const { rows: [issue] } = await pool.query('SELECT created_by FROM issues WHERE app_id = $1 AND github_issue_number = 11', [app.id]);
    assert.equal(issue.created_by, sam.id, 'in his name');
    // After a reload his card is still the first one.
    const mine = await botChat.myRequests(pool, { app, user: { id: sam.id, username: 'sam' } });
    assert.deepEqual(mine.cards.map((c) => [c.kind, !!c.first]), [['group', true]]);
  });

  await t.test('once somebody has asked for something, no more offers', async () => {
    const before = reads;
    const text = 'could we also have a leaderboard for the month';
    const id = await say(sam, text);
    assert.equal(await note(sam, id, text, change), null);
    assert.equal(reads, before, 'not even read');
  });

  await t.test('never for the maker, a member of long standing, or a few words', async () => {
    const before = reads;
    for (const who of [maya, vet]) {
      const text = 'it would be great if it showed the weather';
      assert.equal(await note(who, await say(who, text), text, change), null);
    }
    const { rows: [fresh] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access) VALUES ('ali', 'x', TRUE) RETURNING id, username`);
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2)', [community.id, fresh.id]);
    assert.equal(await note(fresh, await say(fresh, 'hi everyone'), 'hi everyone', change), null);
    assert.equal(reads, before, 'none of them read');
    // A newcomer's greeting is read, and is not an idea: no card, no row.
    const hello = 'hello everyone, glad to be here';
    const id = await say(fresh, hello);
    assert.equal(await note(fresh, id, hello, { kind: 'question', title: null }), null);
    assert.equal(reads, before + 1);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM chat_bot_requests WHERE chat_message_id = $1', [id])).rows[0].n, 0);
  });

  await t.test('Not now takes the offer away; two offers per project at most', async () => {
    const { rows: [lee] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access) VALUES ('lee', 'x', TRUE) RETURNING id, username`);
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2)', [community.id, lee.id]);
    const text = 'maybe the list could be sorted by distance';
    const first = await say(lee, text);
    assert.equal((await note(lee, first, text, change)).kind, 'offer');
    await botChat.requestFromMessage(pool, null, { app, user: { id: lee.id, username: 'lee' }, messageId: first, dismiss: true, deps: deps(null) });
    assert.equal((await pool.query('SELECT kind FROM chat_bot_requests WHERE chat_message_id = $1', [first])).rows[0].kind, 'dismissed');
    const second = await say(lee, text);
    assert.equal((await note(lee, second, text, change)).kind, 'offer');
    const third = await say(lee, text);
    assert.equal(await note(lee, third, text, change), null, 'two is enough');
    // An offer is only ever its own maker's to take.
    const taken = await botChat.requestFromMessage(pool, null, { app, user: { id: sam.id, username: 'sam' }, messageId: second, deps: deps(null) });
    assert.equal(taken.status, 403);
  });
});
