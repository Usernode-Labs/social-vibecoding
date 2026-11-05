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
  const voice = require('../src/services/homeroom-bot-voice');
  const mayor = require('../src/services/homeroom-bot-mayor');

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const ada = await one(`INSERT INTO users (username, password, has_platform_access) VALUES ('bc_ada', 'x', TRUE) RETURNING id, username`);
  const app = await one(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Seed swap', 'bc-seeds', 'running', $1, 'public', 'public') RETURNING id, slug, name`, [ada.id]);
  const note = async (metadata) => (await one(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref, metadata)
     VALUES ($1, $2, 'A note.', 'issue', 4, $3) RETURNING id`, [app.id, ada.id, JSON.stringify(metadata || {})])).id;
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
    const offer = await voice.threadOffer(pool, { app, kind: 'copy_request', forUserId: ada.id, args: { issueNumber: 4 } });
    assert.ok(offer.id > old.id, 'above every older offer\'s id');
    const messageId = await note({ homeroomBot: { kind: 'voice', ...offer.metadata } });
    await voice.tieThreadOffer(pool, offer.id, messageId);
    const card = await one('SELECT place, kind, user_id, chat_message_id, message_id, status FROM bot_cards WHERE id = $1', [offer.id]);
    assert.deepEqual(card, { place: 'thread', kind: 'copy_request', user_id: ada.id, chat_message_id: messageId, message_id: null, status: 'open' });
    const out = await voice.actOnOffer(pool, {}, { offerId: offer.id, userId: ada.id, choice: 'no', key: 'bc-no', deps });
    assert.equal(out.decision, 'declined');
    assert.equal((await one('SELECT status FROM bot_cards WHERE id = $1', [offer.id])).status, 'declined');

    // One made before, in the old table, still decides.
    const oldMessage = await note({ homeroomBot: { kind: 'voice', offer: { id: old.id, kind: 'close_request', status: 'open' } } });
    await pool.query('UPDATE homeroom_bot_voice_offers SET message_id = $2 WHERE id = $1', [old.id, oldMessage]);
    const kept = await voice.actOnOffer(pool, {}, { offerId: old.id, userId: ada.id, choice: 'no', key: 'bc-old', deps });
    assert.equal(kept.decision, 'declined');
    assert.equal((await one('SELECT status FROM homeroom_bot_voice_offers WHERE id = $1', [old.id])).status, 'declined');
  });

  await t.test('a card is open 14 days: a later tap is refused and its buttons go', async () => {
    const offer = await voice.threadOffer(pool, { app, kind: 'copy_request', forUserId: ada.id, args: { issueNumber: 4 } });
    const messageId = await note({ homeroomBot: { kind: 'voice', ...offer.metadata } });
    await voice.tieThreadOffer(pool, offer.id, messageId);
    await pool.query("UPDATE bot_cards SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [offer.id]);
    const tapped = await voice.decideOffer(pool, {}, { app, messageId, user: { id: ada.id }, choice: 'yes', deps });
    assert.deepEqual([tapped.ok, tapped.status], [false, 410]);
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
    assert.deepEqual(refused, { ok: false, status: 410, error: 'expired' });
    assert.equal((await one('SELECT status FROM bot_cards WHERE id = $1', [dmCard.id])).status, 'expired');
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
