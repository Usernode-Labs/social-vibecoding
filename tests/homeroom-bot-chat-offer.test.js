'use strict';
const { englishUiSource } = require("./lib/english-ui-source");

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

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const botChat = require('../src/services/homeroom-bot-chat');

test('WP-C: the offer card, and the line under a first request', () => {
  const { BotRequestCardView, cardWords, STAYS_LINE } = loadTsx('frontend/src/features/group-chat/bot-request.tsx');
  assert.equal(cardWords({ kind: 'offer', title: 'Add a Sunday reminder' }),
    'Suggest this to the group? It goes in the project’s requests as “Add a Sunday reminder”, in your name.');
  const offer = renderToHtml(createElement(BotRequestCardView, { card: { messageId: 5, kind: 'offer', title: 'Add tags', issueNumber: null } }));
  assert.match(englishUiSource(offer), /data-bot-request-card="offer"/);
  assert.match(englishUiSource(offer), /data-bot-request-action="file"><span>Suggest it/);
  assert.match(englishUiSource(offer), /data-bot-request-action="not-now"><span>Not now/);
  assert.equal(cardWords({ kind: 'group', title: 'Add tags', first: true }), `Filed as a request for the group: Add tags. ${STAYS_LINE()}`);
  assert.equal(cardWords({ kind: 'group', title: 'Add tags' }), 'Filed as a request for the group: Add tags.', 'only the first says it');
  assert.equal(STAYS_LINE(), 'It stays in the project’s requests with your name on it.');
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
  assert.match(englishUiSource(llm), /async function readChatAsk\(\{ text, appName = null, toBot = true, apiKey, telemetryContext \}\)/);
  assert.match(englishUiSource(llm), /'Somebody new to the group wrote this'/);
  const schema = read('src/db/schema.sql');
  assert.match(englishUiSource(schema), /CHECK \(kind IN \('filed', 'group', 'unsure', 'question', 'dismissed', 'offer'\)\)/);
  // The invited person's tour says the bot does this, now that it does.
  assert.match(englishUiSource(read('frontend/src/features/first-session/tour-steps.ts')),
    /Homeroom bot offers to suggest an idea to the group in your name, and the group decides what goes in\./);
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
