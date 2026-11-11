'use strict';

// 5 Nov 2026 (docs/plans/bot-one-model.md, step 2, decisions 2 and 3):
// Homeroom bot's cards in one store, against the REAL schema in a throwaway
// PostgreSQL database.
//
// What this pins:
//   1. The chat's offer table is the store, renamed (bot_cards, place 'dm');
//      its old name is a view a pod of the build before reads and writes the
//      same rows through.
//   2. A thread's new offer is a card too (place 'thread', its chat message
//      in chat_message_id), above every older offer's id, and is found and
//      decided by the same tap path; one made before in
//      homeroom_bot_voice_offers is still found and decided.
//   3. A card is open 14 days: a tap after that is refused (410) and its
//      buttons go, in a thread and in the chat.
//   4. Up to three offers under one reply, and the same one twice is one.
//   5. Step 3 (11 Nov 2026): a card is written with the message that shows
//      its buttons, in one transaction; a tap finds it by its id, and no tap
//      404s while its buttons are shown. Its buttons retire from the
//      standing: a vote on closing the request opening retires Propose to
//      close, a build starting retires an overlap question, each saying why.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/bot-cards-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('Homeroom bot\'s cards, in one store', { timeout: 180000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `bot_cards_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  require('../src/db/pool').getPool = () => pool;
  const voice = require('../src/services/homeroom-bot-voice');
  const mayor = require('../src/services/homeroom-bot-mayor');
  const realWs = require('../src/services/ws');
  const cards = require('../src/services/bot-cards');
  const workState = require('../src/services/work-state');

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const ada = await one(`INSERT INTO users (username, password, has_platform_access) VALUES ('bc_ada', 'x', TRUE) RETURNING id, username`);
  const app = await one(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Seed swap', 'bc-seeds', 'running', $1, 'public', 'public') RETURNING id, slug, name`, [ada.id]);
  const bot = await one(`INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id, username`);
  // A note with a card, as the bot writes one (ws.sendBotMessage `card`).
  const noteWith = (card, ref = 4, content = 'A note.') => realWs.sendBotMessage(pool, app.id, {
    user: bot, content, thread: { type: 'issue', ref }, card,
  });
  const broadcasts = [];
  const deps = { ws: { broadcast(appId, frame) { broadcasts.push(frame); } } };

  await t.test('the chat\'s offers are the store, renamed; its old name is a view of them', async () => {
    const { rows } = await pool.query(
      `SELECT table_name, table_type FROM information_schema.tables
        WHERE table_name IN ('bot_cards', 'homeroom_bot_dm_actions') ORDER BY table_name`);
    assert.deepEqual(rows, [{ table_name: 'bot_cards', table_type: 'BASE TABLE' }, { table_name: 'homeroom_bot_dm_actions', table_type: 'VIEW' }]);
    const viaView = await one(
      `INSERT INTO homeroom_bot_dm_actions (user_id, app_id, kind, title) VALUES ($1, $2, 'file_request', 'Old pod') RETURNING id`,
      [ada.id, app.id]);
    const stored = await one('SELECT place, status, expires_at > NOW() + INTERVAL \'13 days\' AS fortnight FROM bot_cards WHERE id = $1', [viaView.id]);
    assert.deepEqual(stored, { place: 'dm', status: 'open', fortnight: true }, 'a chat card, open 14 days');
  });

  await t.test('a thread\'s new offer is a card, found and decided by its tap', async () => {
    const old = await one(
      `INSERT INTO homeroom_bot_voice_offers (app_id, kind, args, for_user_id) VALUES ($1, 'close_request', '{}', $2) RETURNING id`,
      [app.id, ada.id]);
    const sent = await noteWith({ kind: 'copy_request', forUserId: ada.id, args: { issueNumber: 4 } });
    const offer = { id: sent.cardId };
    assert.ok(offer.id > old.id, 'above every older offer\'s id');
    const card = await one('SELECT place, kind, user_id, chat_message_id, message_id, status FROM bot_cards WHERE id = $1', [offer.id]);
    assert.deepEqual(card, { place: 'thread', kind: 'copy_request', user_id: ada.id, chat_message_id: sent.id, message_id: null, status: 'open' });
    const out = await voice.actOnOffer(pool, {}, { offerId: offer.id, userId: ada.id, choice: 'no', key: 'bc-no', deps });
    assert.equal(out.decision, 'declined');
    assert.equal((await one('SELECT status FROM bot_cards WHERE id = $1', [offer.id])).status, 'declined');

    // One made before, in the old table, still decides.
    const oldMessage = (await one(
      `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref, metadata)
       VALUES ($1, $2, 'A note.', 'issue', 4, $3) RETURNING id`,
      [app.id, bot.id, JSON.stringify({ homeroomBot: { kind: 'voice', offer: { status: 'open' } } })])).id;
    await pool.query('UPDATE homeroom_bot_voice_offers SET message_id = $2 WHERE id = $1', [old.id, oldMessage]);
    const kept = await voice.actOnOffer(pool, {}, { offerId: old.id, userId: ada.id, choice: 'no', key: 'bc-old', deps });
    assert.equal(kept.decision, 'declined');
    assert.equal((await one('SELECT status FROM homeroom_bot_voice_offers WHERE id = $1', [old.id])).status, 'declined');
  });

  await t.test('a card is open 14 days: a later tap is refused and its buttons go', async () => {
    const sent = await noteWith({ kind: 'copy_request', forUserId: ada.id, args: { issueNumber: 4 } });
    const messageId = sent.id;
    await pool.query("UPDATE bot_cards SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [sent.cardId]);
    const tapped = await voice.decideOffer(pool, {}, { app, messageId, offerId: sent.cardId, user: { id: ada.id }, choice: 'yes', deps });
    assert.deepEqual([tapped.ok, tapped.status, tapped.code], [false, 410, 'expired']);
    const { metadata } = await one('SELECT metadata FROM chat_messages WHERE id = $1', [messageId]);
    assert.deepEqual([metadata.homeroomBot.offer.status, metadata.homeroomBot.actions], ['expired', []]);

    // In the chat, the same.
    const conversation = await one(`INSERT INTO conversations (kind) VALUES ('direct') RETURNING id`);
    const said = await one(
      `INSERT INTO conversation_messages (conversation_id, sender_id, content, metadata) VALUES ($1, $2, 'File it?', '{}') RETURNING id`,
      [conversation.id, ada.id]);
    const dmCard = await one(
      `INSERT INTO bot_cards (user_id, conversation_id, message_id, app_id, kind, title, expires_at)
       VALUES ($1, $2, $3, $4, 'file_request', 'Swap by post', NOW() - INTERVAL '1 minute') RETURNING id`,
      [ada.id, conversation.id, said.id, app.id]);
    const refused = await mayor.decideOfferTap(pool, {}, { user: { id: ada.id }, actionId: dmCard.id, choice: 'yes', deps: {} });
    assert.deepEqual(refused, { ok: false, status: 410, error: 'expired', code: 'expired' });
    assert.equal((await one('SELECT status FROM bot_cards WHERE id = $1', [dmCard.id])).status, 'expired');
  });

  await t.test('#6404: answering or skipping a Questions card closes the message\'s suggested replies in one push', async () => {
    const cards = require('../src/services/homeroom-bot-cards');
    const bot = await one(`INSERT INTO users (username, password, is_synthetic) VALUES ('bc_bot', 'x', TRUE) RETURNING id`);
    const conversation = await one(`INSERT INTO conversations (kind) VALUES ('direct') RETURNING id`);
    await pool.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role, status) VALUES ($1, $2, 'member', 'member')`,
      [conversation.id, ada.id],
    );
    const botMessage = async (metadata) => (await one(
      `INSERT INTO conversation_messages (conversation_id, sender_id, content, metadata)
       VALUES ($1, $2, 'Which project?', $3) RETURNING id`,
      [conversation.id, bot.id, JSON.stringify(metadata)],
    )).id;
    const QUESTIONS_CARD = {
      type: 'questions', v: 1,
      questions: [{ question: 'Which project?', answers: ['Bread Bot', 'Sheep countrr'], guess: 0 }],
      answered: null,
    };
    const SUGGESTION = { id: 'ask-1', label: 'Bread Bot', style: 'secondary', type: 'prompt' };
    const pushes = [];
    const ws = { pushConversationEvent(to, event) { pushes.push({ to, event }); } };

    const answeredId = await botMessage({ homeroomBot: { kind: 'chat', status: 'open', card: QUESTIONS_CARD, actions: [SUGGESTION] } });
    const answered = await cards.decide(pool, {}, {
      user: { id: ada.id }, messageId: answeredId, action: 'answer', value: ['Bread Bot'], deps: { ws },
    });
    assert.equal(answered.ok, true);
    let meta = (await one('SELECT metadata FROM conversation_messages WHERE id = $1', [answeredId])).metadata;
    assert.deepEqual(meta.homeroomBot.card.answered, ['Bread Bot'], 'the card says what was sent');
    assert.equal(meta.homeroomBot.status, 'closed', 'and nothing else on the message is left to tap');
    assert.deepEqual(meta.homeroomBot.actions, [SUGGESTION], 'the suggestions stay on the row, now closed');
    assert.equal(pushes.length, 1, 'one update reaches every open tab');
    assert.equal(pushes[0].event.type, 'conversation_message_updated');

    const skippedId = await botMessage({ homeroomBot: { kind: 'chat', status: 'open', card: QUESTIONS_CARD, actions: [SUGGESTION] } });
    await cards.decide(pool, {}, { user: { id: ada.id }, messageId: skippedId, action: 'skip', deps: { ws } });
    meta = (await one('SELECT metadata FROM conversation_messages WHERE id = $1', [skippedId])).metadata;
    assert.equal(meta.homeroomBot.card.skipped, true);
    assert.equal(meta.homeroomBot.status, 'closed', 'a skip settles it too');

    const quotedId = await botMessage({
      homeroomBot: {
        kind: 'build_failed', status: 'open', card: QUESTIONS_CARD,
        actions: [{ id: 'try_again', label: 'Try again', style: 'primary', type: 'prompt', quote: true }],
      },
    });
    await cards.decide(pool, {}, { user: { id: ada.id }, messageId: quotedId, action: 'skip', deps: { ws } });
    meta = (await one('SELECT metadata FROM conversation_messages WHERE id = $1', [quotedId])).metadata;
    assert.equal(meta.homeroomBot.status, 'open', 'a step that quotes the message is not a suggestion, so it stays');

    const OPTIONS_CARD = { type: 'options', v: 1, options: [{ key: 'A', title: 'Push' }, { key: 'B', title: 'Email' }], picked: null };
    const optionsId = await botMessage({ homeroomBot: { kind: 'chat', status: 'open', card: OPTIONS_CARD, actions: [SUGGESTION] } });
    await cards.decide(pool, {}, { user: { id: ada.id }, messageId: optionsId, action: 'pick', value: 'B', deps: { ws } });
    meta = (await one('SELECT metadata FROM conversation_messages WHERE id = $1', [optionsId])).metadata;
    assert.equal(meta.homeroomBot.card.picked, 'B');
    assert.equal(meta.homeroomBot.status, 'open', 'another card type keeps its own lifecycle');
  });

  await t.test('step 3: a card is written with its message, or not at all, and a tap finds it by its id', async () => {
    const sent = await noteWith({ kind: 'close_request', forUserId: null, args: { issueNumber: 6, title: 'Dark mode' } }, 6);
    const card = await one('SELECT chat_message_id, status FROM bot_cards WHERE id = $1', [sent.cardId]);
    assert.deepEqual([Number(card.chat_message_id), card.status], [sent.id, 'open'], 'its message is set in the same transaction');
    const { metadata } = await one('SELECT metadata FROM chat_messages WHERE id = $1', [sent.id]);
    assert.deepEqual(metadata.homeroomBot.offer, { id: sent.cardId, kind: 'close_request', status: 'open', forUserId: null });
    assert.deepEqual(metadata.homeroomBot.actions.map((a) => [a.id, a.label, a.offerId]),
      [['yes', 'Propose to close', sent.cardId], ['no', 'Keep it open', sent.cardId]], 'each button names its card');

    // A write that fails after the card writes neither: no buttons without a card, no card without its message.
    const before = await one('SELECT COUNT(*)::int AS n FROM bot_cards');
    await assert.rejects(noteWith({
      kind: 'close_request', args: { issueNumber: 6 }, onInsert: async () => { throw new Error('the write failed'); },
    }, 6, 'Never shown.'), /the write failed/);
    assert.equal((await one('SELECT COUNT(*)::int AS n FROM bot_cards')).n, before.n);
    assert.equal((await one(`SELECT COUNT(*)::int AS n FROM chat_messages WHERE content = 'Never shown.'`)).n, 0);

    // The tap names its card; a screen from before names none, and the
    // message's own metadata does. Neither is ever a 404.
    const taps = [];
    const replies = { async tapVoiceOffer(args) { taps.push(args); return { ok: true }; } };
    const byId = await voice.decideOffer(pool, {}, { app, user: { id: ada.id }, messageId: sent.id, offerId: sent.cardId, choice: 'yes', deps: { replies } });
    const cached = await voice.decideOffer(pool, {}, { app, user: { id: ada.id }, messageId: sent.id, choice: 'yes', deps: { replies } });
    assert.deepEqual([byId.ok, cached.ok], [true, true]);
    assert.deepEqual(taps.map((a) => a.offerId), [sent.cardId, sent.cardId]);

    // Its id under another message: refused as not this message's, and neither note changes.
    const other = await noteWith(null, 6, 'Another note.');
    const elsewhere = await voice.decideOffer(pool, {}, { app, user: { id: ada.id }, messageId: other.id, offerId: sent.cardId, choice: 'yes', deps: { replies } });
    assert.deepEqual([elsewhere.ok, elsewhere.status, elsewhere.code], [false, 409, 'not_this_message']);
    assert.equal((await one('SELECT status FROM bot_cards WHERE id = $1', [sent.cardId])).status, 'open');

    // Another project's card, named by this project's note: gone, and the note's buttons go.
    const elsewhereApp = await one(
      `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
       VALUES ('Other', 'bc-other', 'running', $1, 'public', 'public') RETURNING id`, [ada.id]);
    const foreign = await one(
      `INSERT INTO bot_cards (place, app_id, kind, args) VALUES ('thread', $1, 'close_request', '{}') RETURNING id`, [elsewhereApp.id]);
    const naming = (await one(
      `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref, metadata)
       VALUES ($1, $2, 'A note.', 'issue', 6, $3) RETURNING id`,
      [app.id, bot.id, JSON.stringify({ homeroomBot: { kind: 'voice', offer: { id: foreign.id, status: 'open' }, actions: [{ id: 'yes' }] } })])).id;
    const lost = await voice.decideOffer(pool, {}, { app, user: { id: ada.id }, messageId: naming, choice: 'yes', deps: { replies, ...deps } });
    assert.deepEqual([lost.status, lost.code], [410, 'gone']);
    const goneMeta = (await one('SELECT metadata FROM chat_messages WHERE id = $1', [naming])).metadata;
    assert.deepEqual([goneMeta.homeroomBot.offer.status, goneMeta.homeroomBot.actions], ['gone', []]);
  });

  await t.test('step 3: buttons retire from the standing (a close vote opens, a build starts), and say why', async () => {
    // The table, as the standing reads it.
    const at = (stage, extra = {}) => ({ stage, why: null, reason: null, standing: { asks: {} }, ...extra });
    assert.equal(cards.retireReason('close_request', at('reading')), null);
    assert.equal(cards.retireReason('close_request', at('reading', { standing: { asks: { closeVote: { issueId: 1 } } } })), 'close_vote');
    assert.equal(cards.retireReason('close_request', at('closed')), 'closed');
    assert.equal(cards.retireReason('try_again', at('stopped', { reason: 'fix_stopped' })), null);
    assert.equal(cards.retireReason('try_again', at('up_for_vote')), 'moved_on');
    assert.equal(cards.retireReason('overlap', at('waiting_for_you', { why: 'plan' })), null);
    assert.equal(cards.retireReason('overlap', at('building')), 'building');
    assert.equal(cards.retireReason('build_plan', at('waiting_for_you', { why: 'plan' })), null);
    assert.equal(cards.retireReason('build_plan', at('building')), 'building');
    assert.equal(cards.retireReason('withdraw_change', at('live')), 'moved_on');
    assert.equal(cards.retireReason('post_design', at('closed')), null, 'a kind about words, not where the work stands');
    assert.equal(cards.moved(null, at('building')), false, 'nothing to compare: no move');
    assert.equal(cards.moved({ stage: 'building', why: null, reason: null, closeVote: false }, at('building')), false);

    const ask = async (n) => {
      await pool.query('INSERT INTO issues (app_id, github_issue_number, title, created_by) VALUES ($1, $2, $3, $4)',
        [app.id, n, `Request ${n}`, ada.id]);
      await pool.query('INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, asked_text) VALUES ($1, $2, $3, $4)',
        [app.id, n, ada.id, `Request ${n}`]);
      await pool.query('INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, enqueued_at) VALUES ($1, $2, 1, NOW())', [app.id, n]);
    };
    await ask(21);
    await ask(22);
    const move = async (n) => {
      const changed = await workState.refresh(pool, [{ appId: app.id, issueNumber: n }]);
      return { changed, pushes: await workState.pushesOf(pool, changed) };
    };
    assert.equal((await move(21)).changed[0].state.stage, 'reading');
    await move(22);
    const close = await noteWith({ kind: 'close_request', forUserId: null, args: { issueNumber: 21 } }, 21);
    const overlap = await noteWith({ kind: 'overlap', forUserId: ada.id, args: { issueNumber: 21, other: 22, overlap: 'part_of' } }, 21);
    const otherOverlap = await noteWith({ kind: 'overlap', forUserId: ada.id, args: { issueNumber: 22, other: 21, overlap: 'part_of' } }, 22);
    const file = await noteWith({ kind: 'file_request', forUserId: ada.id, args: { issueNumber: 21, title: 'A swap calendar too' } }, 21);
    const status = async (id) => (await one('SELECT status, retired_reason FROM bot_cards WHERE id = $1', [id]));
    // Its own cards change the standing (its open offers), but nothing moved: every button stays.
    const quiet = await move(21);
    assert.equal(quiet.changed.length, 1);
    assert.deepEqual((await status(close.cardId)).status, 'open');
    assert.deepEqual((await status(overlap.cardId)).status, 'open');

    // A vote on closing it opens: Propose to close goes, saying so; the overlap question stays.
    await pool.query(
      `INSERT INTO issues (app_id, title, kind, payload, created_by) VALUES ($1, 'Close issue #21', 'close_issue', $2, $3)`,
      [app.id, JSON.stringify({ issueNumber: 21 }), ada.id]);
    const voted = await move(21);
    assert.deepEqual(await status(close.cardId), { status: 'retired', retired_reason: 'close_vote' });
    assert.equal((await status(overlap.cardId)).status, 'open');
    assert.equal((await status(file.cardId)).status, 'open');
    const closeMeta = (await one('SELECT metadata FROM chat_messages WHERE id = $1', [close.id])).metadata;
    assert.deepEqual([closeMeta.homeroomBot.offer.status, closeMeta.homeroomBot.offer.retired, closeMeta.homeroomBot.actions],
      ['retired', 'close_vote', []], 'its words stay; its buttons go, and why is kept');
    assert.ok(voted.pushes.some((p) => p.kind === 'room' && p.data.type === 'chat_message_updated' && p.data.id === close.id),
      'everybody reading hears it when the transaction commits');
    const tapped = await voice.decideOffer(pool, {}, { app, user: { id: ada.id }, messageId: close.id, offerId: close.cardId, choice: 'yes', deps });
    assert.deepEqual([tapped.ok, tapped.status, tapped.code, tapped.reason], [false, 410, 'retired', 'close_vote']);

    // Its build starts (held for the project's build slots): the overlap question goes; another request's stays.
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 21', [app.id]);
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, cap_suppressed) VALUES ($1, 21, 'live', 'ready', 'builds_per_app')`,
      [app.id]);
    const built = await move(21);
    assert.equal(built.changed[0].state.stage, 'building');
    assert.deepEqual(await status(overlap.cardId), { status: 'retired', retired_reason: 'building' });
    assert.deepEqual(await status(file.cardId), { status: 'retired', retired_reason: 'building' });
    assert.equal((await status(otherOverlap.cardId)).status, 'open', 'another request\'s question is untouched');
    const overlapMeta = (await one('SELECT metadata FROM chat_messages WHERE id = $1', [overlap.id])).metadata;
    assert.deepEqual([overlapMeta.homeroomBot.offer.status, overlapMeta.homeroomBot.actions], ['retired', []]);
  });

  await t.test('step 3: a newer card of the same kind supersedes an older one, kept by id (the posting function\'s)', async () => {
    const older = await noteWith({ kind: 'try_again', forUserId: ada.id, args: { sessionId: 900, issueNumber: 31 } }, 31);
    const newer = await noteWith({ kind: 'try_again', forUserId: ada.id, args: { sessionId: 900, issueNumber: 31 } }, 31);
    const close = await noteWith({ kind: 'close_request', forUserId: null, args: { issueNumber: 31 } }, 31);
    const pushes = await cards.retireFor(pool, { appId: app.id, issueNumber: 31, keep: [newer.cardId] });
    const of = async (id) => (await one('SELECT status, retired_reason FROM bot_cards WHERE id = $1', [id]));
    assert.deepEqual(await of(older.cardId), { status: 'retired', retired_reason: 'superseded' });
    assert.equal((await of(newer.cardId)).status, 'open');
    assert.equal((await of(close.cardId)).status, 'open', 'another kind is not superseded by it');
    assert.deepEqual(pushes.map((p) => p.data.id), [older.id]);
  });

  await t.test('up to three offers under one reply, and the same one twice is one', () => {
    const ctx = {};
    const offerOf = (n) => ({ kind: 'file_request', app: { id: app.id }, title: `Request ${n}` });
    assert.equal(mayor.MAX_OFFERS, 3);
    for (const n of [1, 2, 3]) {
      assert.equal(mayor.offerRoom(ctx), true);
      assert.equal(mayor.addOffer(ctx, offerOf(n)), true);
    }
    assert.equal(mayor.offerRoom(ctx), false, 'a fourth has no room');
    assert.deepEqual([ctx.offer.title, ctx.moreOffers.map((o) => o.title)], ['Request 1', ['Request 2', 'Request 3']]);
    const again = {};
    mayor.addOffer(again, offerOf(1));
    assert.equal(mayor.addOffer(again, offerOf(1)), false, 'the same offer twice');
    assert.equal(again.moreOffers, undefined);
  });
});
