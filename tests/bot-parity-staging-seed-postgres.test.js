'use strict';
const { dmStream } = require('./lib/bot-dm-stream');

// Homeroom bot parity (P1-P9): the staging preview's three private threads
// with Homeroom bot (services/staging-messages.js ensureBotParityThreads),
// which the before & after shots open: a conversation there with its new
// cards, since a staging copy's bot never runs its model.
//
//   - opening the demo DM gives the viewer three open private threads, each
//     named by their own first words in it, once (a second opening adds none);
//   - the bot's replies carry the cards as stored messages: options with the
//     "Looked at" line, a question set, a batch with its roll-up, a note
//     delivered to a build, and an investigation whose times are real;
//   - each of those cards draws with its own component, every id in the
//     catalog, so the shots never meet a blank card;
//   - the DM's newest message is still the one it was (the demo's story).
//
// Skips when no PostgreSQL is reachable, like the repository's other
// postgres tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent(memberIds) { return memberIds.length; },
    pushToUser() { return 1; },
    pushNotificationToUser() { return 1; },
  },
};
const pushId = require.resolve('../src/services/mobile-push');
require.cache[pushId] = {
  id: pushId, filename: pushId, loaded: true,
  exports: { scheduleBadgeSync() { return false; } },
};

const conversations = require('../src/services/conversations');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { englishPlatformI18n } = require('./lib/platform-i18n');

async function openDatabase(t) {
  let pg;
  try { pg = require('pg'); } catch { t.skip('the pg driver is not installed'); return null; }
  const admin = new pg.Pool({ connectionString: DSN, connectionTimeoutMillis: 3000, max: 1 });
  try {
    await admin.query('SELECT 1');
  } catch (err) {
    await admin.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip(`no postgres reachable at ${DSN}: ${err.message}`);
    return null;
  }
  const name = `bot_parity_seed_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: String(url), max: 4 });
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end().catch(() => {});
  });
  await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
  return pool;
}

globalThis.window = globalThis.window || {
  App: { user: { id: 9, username: 'viewer' } },
  location: { search: '', hash: '#homeroom-bot' },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: (fn) => fn(),
  setTimeout, clearTimeout,
};

const COMPONENTS = Object.freeze({
  options: ['options.tsx', 'OptionsCard'],
  questions: ['questions.tsx', 'QuestionsCard'],
  batch: ['batch.tsx', 'BatchCard'],
  build_note: ['build-note.tsx', 'BuildNoteCard'],
  investigation: ['investigation.tsx', 'InvestigationCard'],
});

function drawCard(message, card) {
  const [file, name] = COMPONENTS[card.type];
  const mod = loadTsx(`frontend/src/features/messages/bot-cards/${file}`, {
    stubs: {
      '../../../lib/i18n/react': { useMessages: () => englishPlatformI18n().t },
      '../../../lib/i18n/runtime': { getLanguage: () => 'en-US' },
      './index': { decideCard: async () => ({ ok: true }), sayAsMe: async () => {} },
    },
  });
  return renderToHtml(createElement(mod[name], { message, conversationId: message.conversationId, card }));
}

test('the staging preview\'s private threads with Homeroom bot, with their new cards', { timeout: 120000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;
  const staging = require('../src/services/staging-messages');
  const env = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  t.after(() => { if (env === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = env; });
  const { rows: [viewer] } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ('parity-viewer', 'x', TRUE) RETURNING id, username`,
  );
  // #6250: the filed thread names this demo project, which the preview's
  // boot seed creates.
  await pool.query(
    `INSERT INTO apps (slug, name, repo_url) VALUES ('staging-demo-app', 'Staging demo app', 'https://github.com/staging/demo')
     ON CONFLICT DO NOTHING`,
  );

  const conversationId = await staging.ensureBotDmFixture(pool, viewer);
  assert.ok(conversationId, 'the demo DM is there');
  const before = await pool.query('SELECT COUNT(*)::int AS n FROM conversation_messages WHERE conversation_id = $1', [conversationId]);
  await staging.ensureBotDmFixture(pool, viewer);
  const after = await pool.query('SELECT COUNT(*)::int AS n FROM conversation_messages WHERE conversation_id = $1', [conversationId]);
  assert.equal(after.rows[0].n, before.rows[0].n, 'a second opening sends nothing');

  const { rows: threads } = await pool.query(
    `SELECT p.root_message_id, p.kind, p.state, p.app_id, p.result_ref,
            m.metadata->'homeroomBot'->>'kind' AS root_kind,
            (SELECT f.content FROM conversation_messages f
              WHERE f.thread_root_id = p.root_message_id AND f.sender_id = $1 ORDER BY f.id LIMIT 1) AS first_own
       FROM private_threads p JOIN conversation_messages m ON m.id = p.root_message_id
      WHERE p.user_id = $1 ORDER BY p.root_message_id`,
    [viewer.id],
  );
  // #6250: the fourth is filed as a request, so the list keeps its row and
  // says where it went; the other three are open.
  assert.equal(threads.length, 4, 'four private threads');
  const filed = threads.find((th) => th.state === 'filed');
  assert.ok(filed, 'one of them is filed');
  assert.deepEqual([filed.result_ref, filed.app_id != null], [404, true], 'and names the demo project and a request');
  for (const thread of threads) {
    assert.equal(thread.kind, 'ask');
    assert.equal(thread.root_kind, 'opened_thread');
    if (thread !== filed) assert.equal(thread.state, 'open');
    assert.match(thread.first_own, /^Staging demo: /, 'named by the viewer\'s own first words, obviously fake');
  }

  const { rows: replies } = await pool.query(
    `SELECT id, conversation_id, thread_root_id, content, metadata FROM conversation_messages
      WHERE conversation_id = $1 AND thread_root_id = ANY($2::int[]) AND metadata->'homeroomBot' ? 'card'
      ORDER BY id`,
    [conversationId, threads.map((th) => th.root_message_id)],
  );
  const cards = replies.map((r) => r.metadata.homeroomBot.card);
  assert.deepEqual(cards.map((c) => c.type), ['options', 'questions', 'batch', 'build_note', 'investigation']);
  const options = replies[0].metadata.homeroomBot;
  assert.equal(options.looked.items.length, 3, 'the options reply says what it looked at');
  const investigation = cards[4];
  assert.ok(Date.parse(investigation.nextAt) > Date.now(), 'its next check-in is ahead');
  assert.ok(investigation.checkins.every((c) => Date.parse(c.at) < Date.now()), 'its check-ins are behind');
  assert.equal(investigation.checkins[0].hoursAgo, undefined, 'stored with real times only');

  for (const row of replies) {
    const card = row.metadata.homeroomBot.card;
    const message = {
      id: Number(row.id), conversationId: Number(row.conversation_id), content: row.content, deleted: false,
      createdAt: new Date().toISOString(), sender: { id: 2, username: 'homeroom_bot', bot: true },
      attachments: [], objects: [], reactions: [], threadRootId: Number(row.thread_root_id),
      metadata: { homeroomBot: row.metadata.homeroomBot },
    };
    const html = drawCard(message, card);
    assert.ok(html.length > 200, `the ${card.type} card draws`);
    assert.doesNotMatch(html, /botCards\.|messages:/, `every ${card.type} id is in the catalog`);
    assert.doesNotMatch(html, /—|gray-|indigo-/);
  }

  // #6207: what the fixture wrote; Main itself leaves a request's news out.
      const page = await dmStream(pool, viewer, conversationId);
  const main = [...(page.messages || page)].sort((a, b) => a.id - b.id);
  assert.equal(main.at(-1).metadata?.homeroomBot?.issueNumber, 18, 'the DM still ends with the demo\'s story card');
});

// #6306: the already-works request's staging fixture (src/db/migrate.js
// seedStagingBotAlreadyWorks). The review asked for the request's bell row
// too, which the first version did not seed, so the shots had nothing to
// capture. Against a real database, seeded twice: one request, one run
// carrying already_done, one stored note, and one notification whose detail
// words it "Already works" with the bot's own sentence and links the request.
test('the staging already-works request carries its note and its bell row', { timeout: 60000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;

  const app = (await pool.query(
    `INSERT INTO apps (name, slug, self_hosted) VALUES ('Homeroom', 'usernode-seed-test', TRUE) RETURNING id`,
  )).rows[0];
  await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('usernode-capture', 'not-a-login', FALSE),
       ('homeroom_bot', 'not-a-login', TRUE)`,
  );

  const { seedStagingBotAlreadyWorks } = require('../src/db/migrate');
  const previous = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  try {
    await seedStagingBotAlreadyWorks(pool);
    await seedStagingBotAlreadyWorks(pool);
  } finally {
    if (previous === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = previous;
  }

  const runs = await pool.query(
    'SELECT verdict, already_done, reason FROM homeroom_bot_runs WHERE app_id = $1 AND issue_number = 9110',
    [app.id],
  );
  assert.deepEqual(runs.rows, [{
    verdict: 'person',
    already_done: true,
    reason: 'Staging demo: visitors can already get in and play without an account.',
  }], 'one already-done run, not two');

  const notes = await pool.query(
    `SELECT content FROM chat_messages WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = 9110`,
    [app.id],
  );
  assert.equal(notes.rows.length, 1, 'one stored note, not two');
  assert.match(notes.rows[0].content, /^Already works: /);
  // #6321: the note in the words the bot writes now, with one offer for any
  // member under it, and the second seed run added no other.
  assert.equal(notes.rows[0].content, require('../src/services/homeroom-bot-live').personHomeroomText({
    reason: 'Staging demo: visitors can already get in and play without an account.', done: true,
  }));
  const offers = await pool.query(
    `SELECT kind, user_id AS for_user_id, status, args FROM bot_cards WHERE place = 'thread' AND app_id = $1`, [app.id],
  );
  assert.equal(offers.rows.length, 1, 'one offer, not two');
  assert.equal(offers.rows[0].kind, 'close_request');
  assert.equal(offers.rows[0].for_user_id, null);
  assert.equal(offers.rows[0].status, 'open');
  assert.equal(offers.rows[0].args.issueNumber, 9110);

  const rings = await pool.query(
    `SELECT n.kind, n.detail FROM notifications n WHERE n.app_id = $1 AND n.kind = 'build_needs_you'`,
    [app.id],
  );
  assert.equal(rings.rows.length, 1, 'one bell row, not two');
  const { parseBotDetail, botMomentCopy } = require('../src/services/homeroom-bot-notify-copy');
  const parsed = parseBotDetail(rings.rows[0].detail);
  assert.equal(parsed.moment, 'needs_you');
  assert.equal(parsed.said, 'done');
  assert.equal(parsed.issueNumber, 9110);
  assert.equal(parsed.reason, 'Staging demo: visitors can already get in and play without an account.');
  const copy = botMomentCopy(rings.rows[0].detail);
  assert.equal(copy.bellLabel, 'Already works');
  assert.match(copy.body, /^Already works: .* Propose to close it\?$/);
});

// #6399: the out-of-date hand-back fixture (src/db/migrate.js
// seedStagingBotOutdatedReason). A fresh staging copy has no request whose
// reason a later release lifted, so the before & after shots of "Ask
// Homeroom bot to read this again" had nothing to capture. Seeded twice: one
// request and one run, its clock before the 6 Nov release, and the track the
// page reads marks that reason out of date.
test('the staging out-of-date request reads as a reason a release lifted', { timeout: 60000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;

  const app = (await pool.query(
    `INSERT INTO apps (name, slug, self_hosted) VALUES ('Homeroom', 'usernode-seed-outdated', TRUE) RETURNING id`,
  )).rows[0];
  await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('usernode-capture', 'not-a-login', FALSE)`,
  );

  const { seedStagingBotOutdatedReason } = require('../src/db/migrate');
  const previous = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  try {
    await seedStagingBotOutdatedReason(pool);
    await seedStagingBotOutdatedReason(pool);
  } finally {
    if (previous === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = previous;
  }

  const requests = await pool.query('SELECT number, title FROM requests WHERE app_id = $1', [app.id]);
  assert.deepEqual(requests.rows, [{
    number: 9112, title: 'Staging demo: a request handed back over a plan the bot could not read',
  }]);
  const runs = await pool.query(
    `SELECT verdict, reason, created_at FROM homeroom_bot_runs WHERE app_id = $1 AND issue_number = 9112`, [app.id],
  );
  assert.equal(runs.rows.length, 1, 'one run, not two');
  assert.deepEqual(runs.rows[0].verdict, 'person');
  assert.ok(Date.parse(runs.rows[0].created_at) < Date.parse('2026-11-06T13:05:00Z'), 'given before the fix');

  const tracks = await require('../src/services/homeroom-bot-track')
    .tracksForRequests(pool, { appId: app.id, numbers: [9112] });
  const work = tracks.get(9112)?.work;
  assert.deepEqual([work.stage, work.why], ['waiting_for_you', 'decide']);
  assert.equal(work.line.outdated, 'posted_plan');
  assert.equal(require('../src/services/work-state').outdatedReason(work), 'posted_plan');
});
