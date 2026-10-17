'use strict';

// The Homeroom bot's voice (src/services/homeroom-bot-voice.js) against the
// full PostgreSQL schema, with the model scripted:
//
//   - asked to change its own change in the change's discussion, it queues
//     the change as an ask (its follow-up goes first in the queue) and says
//     so in one reply there, quoting who asked;
//   - mentioned in a project's chat, it answers in a reply thread under the
//     message, and offers to file a request with File it / Not now, which
//     only the person it was offered to decides, once;
//   - a turn (the bot-voice machine's work, runTurn) reads only what is new
//     since the place's last; a retry of the same turn finds its reply by its
//     mark and says and asks nothing twice; an older release's turn still
//     holding the place makes it wait;
//   - a tap's act (actOnOffer) is done once, and carries on after a restart
//     cut it short after its claim;
//   - when the change's update ends, the people who asked are owed what came
//     of it (reportFollowUp, an event in the asks' own transaction), said
//     once where they asked (sayReport), in the plain words when no model
//     answers.
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

const voice = require('../src/services/homeroom-bot-voice');

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
  const name = `hrbot_voice_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: String(url), max: 8 });
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end().catch(() => {});
  });
  await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
  return pool;
}

/** A model that answers each request of a turn with the next step of `script`. */
function scripted(script) {
  const seen = [];
  let i = 0;
  const chat = async (req) => {
    seen.push(req);
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    if (typeof step === 'function') return step(req);
    if (step.tool) {
      return {
        content: '',
        toolCalls: [{ id: `call${i}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args || {}) } }],
        usage: { inputTokens: 100, outputTokens: 20, costUsd: 0 },
      };
    }
    return { content: step.text || '', toolCalls: [], usage: { inputTokens: 100, outputTokens: 20, costUsd: 0 } };
  };
  return { chat, seen };
}

test('the voice on the real schema', { timeout: 180000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;

  let seq = 0;
  async function user(prefix, { synthetic = false } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_synthetic)
       VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
      [synthetic ? prefix : `${prefix}_${++seq}`, synthetic],
    );
    return rows[0];
  }
  const homeroomBot = await user('homeroom_bot', { synthetic: true });
  const evan = await user('evan');
  const sam = await user('sam');
  const { rows: [inserted] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ('Todo List', 'todo-list', 'running', $1, 'https://github.com/usernode-bot/todo-list', 'public', 'public')
     RETURNING id`,
    [evan.id],
  );
  const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [inserted.id]);
  if (app.community_id != null) {
    await pool.query(
      `INSERT INTO community_members (community_id, user_id) VALUES ($1, $2), ($1, $3) ON CONFLICT DO NOTHING`,
      [app.community_id, evan.id, sam.id],
    );
  }
  await pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ('homeroom_bot_mode', 'live')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
  await pool.query(
    'INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, 12, $2, $3)',
    [app.id, evan.id, 'Blue header'],
  );
  const { rows: [change] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, linked_issues, promoted_at, pr_number)
     VALUES ($1, $2, 'dev/homeroom_bot-blue', 'promoted', 'Blue header', $3, NOW(), 31) RETURNING id`,
    [app.id, homeroomBot.id, [12]],
  );

  const sent = [];
  const broadcasts = [];
  const ws = {
    async sendBotMessage(p, appId, { user: from, content, metadata = null, thread }) {
      const { rows: [row] } = await p.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref)
         VALUES ($1, $2, $3, 'message', $4, $5, $6) RETURNING id, created_at`,
        [appId, from.id, content, JSON.stringify(metadata || {}), thread.type, thread.ref],
      );
      sent.push({ id: row.id, content, metadata, thread });
      return { id: row.id, createdAt: row.created_at };
    },
    broadcast(appId, frame) { broadcasts.push(frame); },
    async broadcastThreadSummary() {},
  };
  const notifications = { async createMentionNotifications() { return []; }, async hydrateAndPush() {} };
  const say = async (who, content, thread = null, metadata = {}) => (await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref)
     VALUES ($1, $2, $3, 'message', $4, $5, $6) RETURNING id`,
    [app.id, who.id, content, JSON.stringify(metadata), thread?.type || null, thread?.ref ?? null],
  )).rows[0].id;
  // A turn is the bot-voice machine's work (src/workflow/bot-voice/): here
  // it runs when the test says so, keyed as the machine keys it.
  const base = (model) => ({ ws, notifications, chat: model.chat, apiKey: 'test-key', noPlatform: true });
  let turns = 0;
  const turn = (place, model, { through = 0, key = `t${++turns}`, deps = {} } = {}) =>
    voice.runTurn(pool, {}, { appId: app.id, place, through, turnKey: key, deps: { ...base(model), ...deps } });

  await t.test('asked to change its own change, it queues the ask and says so where it was asked', async () => {
    sent.length = 0;
    const model = scripted([
      { tool: 'update_change', args: { instruction: 'Make the header blue on every page, not only the home page' } },
      { tool: 'reply', args: { text: 'Got it: I\'ll make the header blue on every page. Updating it resets its approvals, so the group looks again.' } },
    ]);
    const place = { type: 'session', ref: change.id };
    const id = await say(evan, 'Can the header be blue on every page, not just home?', place);
    const first = await turn(place, model, { key: 'own-1' });
    assert.equal(first.outcome, 'replied');
    assert.equal(first.throughId, id, 'what it read through is the place\'s');

    const { rows: asks } = await pool.query('SELECT * FROM homeroom_bot_change_asks WHERE session_id = $1', [change.id]);
    assert.equal(asks.length, 1);
    assert.equal(asks[0].status, 'queued');
    assert.equal(asks[0].instruction, 'Make the header blue on every page, not only the home page');
    assert.equal(asks[0].asker_id, evan.id);
    assert.equal(asks[0].message_id, id, 'where it was asked, which is where the answer goes');
    assert.equal(asks[0].place_type, 'session');
    const { rows: queue } = await pool.query('SELECT issue_number, reason, priority FROM homeroom_bot_queue WHERE app_id = $1', [app.id]);
    assert.deepEqual(queue, [{ issue_number: 12, reason: 'voice_update', priority: 0 }], 'its follow-up goes first');

    assert.equal(sent.length, 1, 'one reply');
    assert.deepEqual(sent[0].thread, place, 'in the change\'s discussion');
    assert.equal(sent[0].metadata.quote.refMsgId, id, 'quoting who it answers');
    assert.equal(sent[0].metadata.homeroomBot.kind, 'voice');
    assert.equal(sent[0].metadata.homeroomBot.turn.key, 'own-1', 'the reply carries its turn\'s mark');
    assert.doesNotMatch(sent[0].content, /^Homeroom bot/);
    // The model saw the place and the facts, and only this project.
    const seen = model.seen[0];
    assert.match(seen.messages[1].content, /Can the header be blue on every page/);
    assert.match(seen.messages[1].content, /built by you/);
    assert.ok(seen.tools.some((tl) => tl.function.name === 'update_change'));

    const { rows: [record] } = await pool.query(
      `SELECT outcome, place_key, reply_message_id, through_message_id, tools, turn_key FROM homeroom_bot_voice_turns ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(record.outcome, 'replied');
    assert.equal(record.place_key, `${app.id}:session:${change.id}`);
    assert.equal(record.reply_message_id, sent[0].id);
    assert.equal(record.turn_key, 'own-1');
    assert.deepEqual(record.tools, ['update_change', 'reply']);

    // The same turn asked again (its work retried after a restart): its
    // reply is found by its mark, nothing is said or asked twice.
    const retried = await turn(place, scripted([{ text: 'a second answer' }]), { key: 'own-1' });
    assert.deepEqual([retried.outcome, retried.replyId, retried.throughId], ['replied', sent[0].id, id]);
    assert.equal(sent.length, 1);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM homeroom_bot_change_asks WHERE session_id = $1', [change.id])).rows[0].n, 1);

    // The next turn reads after what this one read: nothing new.
    const again = await turn(place, model, { through: first.throughId });
    assert.equal(again.outcome, 'quiet');
    assert.equal(sent.length, 1);
  });

  await t.test('words a DM passed on as an ask are the follow-up\'s, not answered again', async () => {
    const place = { type: 'session', ref: change.id };
    const before = sent.length;
    const id = await say(sam, 'Make the footer smaller too', place);
    const ask = (deps) => voice.recordAsk(pool, {
      appId: app.id, sessionId: change.id, issueNumber: 12, askerId: sam.id, instruction: 'Make the footer smaller too',
      source: 'dm', place, messageId: id, deps,
    });
    const asked = await ask(base(scripted([{ text: 'x' }])));
    assert.ok(asked.id);
    assert.equal(asked.running, false);
    const twice = await ask(base(scripted([{ text: 'x' }])));
    assert.equal(twice.id, asked.id, 'one ask per change and message, whoever records it again');
    const quiet = await turn(place, scripted([{ text: 'x' }]), { through: id - 1 });
    assert.equal(quiet.outcome, 'quiet', 'queued as an ask: the follow-up answers it');
    assert.equal(sent.length, before);
  });

  await t.test('mentioned in the project\'s chat, it answers in a reply thread and offers to file it', async () => {
    sent.length = 0;
    broadcasts.length = 0;
    // No change of its own is up here for this test.
    await pool.query(`UPDATE chat_sessions SET status = 'archived' WHERE id = $1`, [change.id]);
    const model = scripted([
      { tool: 'offer_request', args: { title: 'Sort the list by due date', details: 'Could the list sort by due date?' } },
      { tool: 'reply', args: { text: 'That sounds like a good request. I drafted it: tap File it under this to send it to the group.' } },
    ]);
    const chat = { type: 'chat', ref: null };
    const since = (await pool.query('SELECT COALESCE(MAX(id), 0) AS n FROM chat_messages')).rows[0].n;
    // People talking to each other: a turn reads it and says nothing.
    const talk = await say(sam, 'thanks everyone');
    const quiet = await turn(chat, scripted([{ text: 'x' }]), { through: Number(since) });
    assert.equal(quiet.outcome, 'quiet');
    assert.equal(quiet.throughId, talk);
    assert.equal(sent.length, 0);
    const id = await say(sam, '@Homeroom bot could the list sort by due date?');
    const answered = await turn(chat, model, { through: quiet.throughId });
    assert.equal(answered.outcome, 'replied');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].thread, { type: 'message', ref: id }, 'in a reply thread under the message, not in the room\'s stream');
    const offer = sent[0].metadata.homeroomBot.offer;
    assert.equal(offer.kind, 'file_request');
    assert.equal(offer.status, 'open');
    assert.equal(offer.forUserId, sam.id);
    assert.deepEqual(sent[0].metadata.homeroomBot.actions.map((a) => a.label), ['File it', 'Not now']);
    const { rows: [row] } = await pool.query('SELECT kind, args, status, message_id FROM homeroom_bot_voice_offers WHERE id = $1', [offer.id]);
    assert.equal(row.message_id, sent[0].id);
    assert.equal(row.args.title, 'Sort the list by due date');
    assert.equal(row.args.messageId, id);

    // A tap is decided in its place's machine (the route only appends it).
    const tapped = [];
    const replies = { async tapVoiceOffer(args) { tapped.push(args); return { ok: true }; } };
    const routed = await voice.decideOffer(pool, {}, { app, user: sam, messageId: sent[0].id, choice: 'yes', deps: { replies } });
    assert.equal(routed.ok, true);
    assert.deepEqual(tapped, [{ appId: app.id, offerId: offer.id, messageId: sent[0].id, userId: sam.id, choice: 'yes' }]);
    assert.equal((await voice.decideOffer(pool, {}, { app, user: sam, messageId: 999999, choice: 'yes', deps: { replies } })).status, 404);
    // File it, its act (the machine's voice.act work), with the filing
    // itself stood in for.
    const filed = [];
    const chatSvc = {
      ...require('../src/services/homeroom-bot-chat'),
      async fileMessage(p, cfg, args) {
        filed.push(args);
        await p.query(
          `INSERT INTO chat_bot_requests (chat_message_id, app_id, requester_id, kind, issue_number, title) VALUES ($1, $2, $3, 'filed', 13, $4)`,
          [args.messageId, app.id, sam.id, args.title]);
        return { messageId: args.messageId, kind: 'filed', issueNumber: 13 };
      },
      pushCard() {},
    };
    const act = (key) => voice.actOnOffer(pool, {}, { offerId: offer.id, userId: sam.id, choice: 'yes', key, deps: { ws, chatSvc } });
    assert.deepEqual(await act('offer:1'), { decision: 'done' });
    assert.equal(filed.length, 1);
    assert.equal(filed[0].title, 'Sort the list by due date');
    assert.equal(filed[0].messageId, id, 'the chip goes on their message');
    assert.equal(filed[0].fileKey, `voice-offer:${offer.id}`, 'filed under the act\'s key');
    assert.match(sent[sent.length - 1].content, /Filed as request #13/);
    const saidCount = sent.length;
    // Its work retried after it settled: nothing is filed or said twice.
    assert.deepEqual(await act('offer:1'), { decision: 'done' });
    assert.equal(filed.length, 1);
    assert.equal(sent.length, saidCount);
    // Another act on it (a tap an older release decided) does nothing.
    assert.deepEqual(await act('offer:other'), { decision: 'already' });
    const { rows: [message] } = await pool.query('SELECT metadata FROM chat_messages WHERE id = $1', [sent[0].id]);
    assert.equal(message.metadata.homeroomBot.offer.status, 'done');
    assert.deepEqual(message.metadata.homeroomBot.actions, [], 'the buttons go for everybody');
    assert.ok(broadcasts.some((f) => f.type === 'chat_message_updated' && f.id === sent[0].id));
  });

  await t.test('a tap\'s act cut short after its claim carries on when its work is retried', async () => {
    sent.length = 0;
    const id = await say(sam, '@Homeroom bot add a dark mode');
    const { rows: [o] } = await pool.query(
      `INSERT INTO homeroom_bot_voice_offers (app_id, kind, args, for_user_id) VALUES ($1, 'file_request', $2, $3) RETURNING id`,
      [app.id, JSON.stringify({ title: 'Dark mode', details: 'Add a dark mode', messageId: id }), sam.id]);
    const reply = await say(homeroomBot, 'I drafted it.', { type: 'message', ref: id }, { homeroomBot: { kind: 'voice', offer: { id: o.id, status: 'open' } } });
    await pool.query('UPDATE homeroom_bot_voice_offers SET message_id = $2 WHERE id = $1', [o.id, reply]);
    // The first attempt claimed it, and its process went.
    await pool.query(`UPDATE homeroom_bot_voice_offers SET status = 'deciding', decided_key = 'offer:cut' WHERE id = $1`, [o.id]);
    const filed = [];
    const chatSvc = {
      ...require('../src/services/homeroom-bot-chat'),
      async fileMessage(p, cfg, args) { filed.push(args); return { messageId: args.messageId, kind: 'filed', issueNumber: 14 }; },
      pushCard() {},
    };
    const out = await voice.actOnOffer(pool, {}, { offerId: o.id, userId: sam.id, choice: 'yes', key: 'offer:cut', deps: { ws, chatSvc } });
    assert.deepEqual(out, { decision: 'done' }, 'its own claim passes');
    assert.equal(filed.length, 1);
    assert.match(sent[sent.length - 1].content, /Filed as request #14/);
  });

  await t.test('mentioned in the project\'s chat, it offers a vote on closing a request by its number', async () => {
    sent.length = 0;
    const closeCalls = [];
    const mayor = Object.create(require('../src/services/homeroom-bot-mayor'));
    mayor.closeGate = async (p, a) => {
      closeCalls.push(Number(a.issueNumber));
      return { ok: true, issueNumber: Number(a.issueNumber), issue: { title: 'X' } };
    };
    const model = scripted([
      { tool: 'offer_close_request', args: { number: 12, why: 'Already done' } },
      { tool: 'reply', args: { text: 'If #12 is done, tap Propose to close below to open a vote on closing it. Nothing happens until you do.' } },
    ]);
    const chat = { type: 'chat', ref: null };
    const words = '@Homeroom bot request #12 is done, can you propose closing it?';
    const before = (await pool.query('SELECT COALESCE(MAX(id), 0) AS n FROM chat_messages')).rows[0].n;
    const id = await say(evan, words);
    await turn(chat, model, { through: Number(before), deps: { mayor } });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].thread, { type: 'message', ref: id }, 'in a reply thread under the message');
    const offer = sent[0].metadata.homeroomBot.offer;
    assert.equal(offer.kind, 'close_request');
    assert.equal(offer.status, 'open');
    assert.equal(offer.forUserId, evan.id);
    assert.deepEqual(sent[0].metadata.homeroomBot.actions.map((a) => a.label), ['Propose to close', 'Keep it open']);
    const { rows: [row] } = await pool.query('SELECT kind, args, status, message_id FROM homeroom_bot_voice_offers WHERE id = $1', [offer.id]);
    assert.equal(row.kind, 'close_request');
    assert.equal(row.message_id, sent[0].id);
    assert.equal(row.args.issueNumber, 12);
    assert.equal(row.args.why, 'Already done');
    assert.deepEqual(closeCalls, [12], 'the gate read the request by the number the model passed');

    // No number, no offer: the tool refuses and the model answers without buttons.
    const again = scripted([
      { tool: 'offer_close_request', args: {} },
      { tool: 'reply', args: { text: 'Which request: its number, and I can offer a vote on closing it.' } },
    ]);
    await say(evan, '@Homeroom bot please propose closing it.');
    await turn(chat, again, { through: id, deps: { mayor } });
    assert.equal(sent.length, 2);
    assert.equal(sent[1].metadata.homeroomBot.offer, undefined, 'nothing offered without a number');
    assert.deepEqual(closeCalls, [12], 'the gate was not called again');
  });

  await t.test('switched off in chats, a mention is the old path\'s and the voice says nothing', async () => {
    sent.length = 0;
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ('homeroom_bot_voice_chat', 'off')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    const before = (await pool.query('SELECT COALESCE(MAX(id), 0) AS n FROM chat_messages')).rows[0].n;
    const id = await say(sam, '@Homeroom bot hello?');
    const asked = [];
    const chatSvc = { ...require('../src/services/homeroom-bot-chat'), async heardInChat(p, cfg, a) { asked.push(a); return 0; } };
    const out = await turn({ type: 'chat', ref: null }, scripted([{ text: 'x' }]), { through: Number(before), deps: { chatSvc } });
    assert.equal(out.outcome, 'quiet');
    assert.equal(out.throughId, id, 'read through, so it is not read again');
    assert.equal(sent.length, 0);
    assert.equal(await voice.enabledFor(pool, 'chat'), false);
    assert.equal(await voice.enabledFor(pool, 'session'), true);
    await pool.query(`DELETE FROM platform_settings WHERE key = 'homeroom_bot_voice_chat'`);
  });

  await t.test('one turn at a time in one place: an older release\'s turn holds it, a retried turn takes its own row up', async () => {
    const open = await pool.query('SELECT COUNT(*)::int AS n FROM homeroom_bot_voice_turns WHERE finished_at IS NULL');
    assert.equal(open.rows[0].n, 0, 'every turn let go of its place');
    const chat = { type: 'chat', ref: null };
    await pool.query(
      `INSERT INTO homeroom_bot_voice_turns (app_id, place_type, place_ref, place_key) VALUES ($1, 'chat', NULL, $2)`,
      [app.id, `${app.id}:chat:`],
    );
    await assert.rejects(turn(chat, scripted([{ text: 'x' }])), { code: 'place_busy' }, 'its work asks again later');
    await pool.query('UPDATE homeroom_bot_voice_turns SET finished_at = NOW() WHERE finished_at IS NULL');
    // A turn a restart cut short leaves its own row: its retry takes it up.
    await pool.query(
      `INSERT INTO homeroom_bot_voice_turns (app_id, place_type, place_ref, place_key, turn_key) VALUES ($1, 'chat', NULL, $2, 'cut-1')`,
      [app.id, `${app.id}:chat:`],
    );
    const latest = (await pool.query('SELECT MAX(id) AS n FROM chat_messages')).rows[0].n;
    const out = await turn(chat, scripted([{ text: 'x' }]), { key: 'cut-1', through: Number(latest) });
    assert.equal(out.outcome, 'quiet');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM homeroom_bot_voice_turns WHERE turn_key = $1', ['cut-1'])).rows[0].n, 1);
  });

  await t.test('when the update ends, the people who asked are owed what came of it, said once where they asked', async () => {
    sent.length = 0;
    await pool.query(`UPDATE chat_sessions SET status = 'promoted' WHERE id = $1`, [change.id]);
    const runTag = 'fu-test-1';
    const asks = await voice.takeAsks(pool, { sessionId: change.id, runTag });
    assert.equal(asks.length, 2, 'both asks waiting on it, oldest first');
    assert.deepEqual(asks.map((a) => a.asker), [evan.username, sam.username]);
    const { rows: [session] } = await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [change.id]);
    const outcome = { action: 'revise', moved: true, summary: 'The header is blue on every page, and the footer is smaller.' };
    // Owed, in the transaction that ends the asks: an event for the place.
    const n = await voice.reportFollowUp(pool, {}, {
      app, session, asks, outcome, runTag, finish: (db) => voice.finishAsks(db, { runTag, runId: null }),
    });
    assert.equal(n, 1, 'both were asked in the change\'s discussion: one report there');
    const { rows: events } = await pool.query(`SELECT machine, key, type, payload FROM wf_events WHERE type = 'Report'`);
    assert.equal(events.length, 1);
    assert.equal(events[0].machine, 'bot-voice');
    assert.equal(events[0].key, `place:${app.id}:session:${change.id}`);
    assert.deepEqual(events[0].payload.asks, asks.map((a) => a.id));
    const { rows } = await pool.query('SELECT status FROM homeroom_bot_change_asks WHERE session_id = $1 ORDER BY id', [change.id]);
    assert.deepEqual(rows.map((r) => r.status), ['done', 'done'], 'ended with the report owed');
    // Said by the place's work. No model answers: the plain words go.
    const failing = { chat: async () => { throw Object.assign(new Error('down'), { code: 'provider_error' }); }, sleep: async () => {} };
    const report = () => voice.sayReport(pool, {}, {
      appId: app.id, place: { type: 'session', ref: change.id }, sessionId: change.id, runTag, asks: asks.map((a) => a.id), outcome,
      deps: { ws, notifications, apiKey: 'test-key', ...failing },
    });
    const said = await report();
    assert.equal(sent.length, 1);
    assert.equal(said.id, sent[0].id);
    assert.deepEqual(sent[0].thread, { type: 'session', ref: change.id });
    assert.equal(sent[0].content, 'Done: The header is blue on every page, and the footer is smaller.');
    assert.equal(sent[0].metadata.quote.author, sam.username, 'quoting the newest ask');
    // Its work retried after it said it: said once.
    const again = await report();
    assert.equal(again.id, sent[0].id);
    assert.equal(sent.length, 1);
    assert.equal(await voice.asksWaiting(pool, change.id), false);
  });

  await t.test('an ask that keeps failing gives up after its tries, and one that never got going is not a try', async () => {
    const place = { type: 'session', ref: change.id };
    const id = await say(evan, 'Bigger buttons please', place);
    await pool.query(
      `INSERT INTO homeroom_bot_change_asks (app_id, session_id, issue_number, asker_id, instruction, place_type, place_ref, message_id)
       VALUES ($1, $2, 12, $3, 'Make the buttons bigger', 'session', $2, $4)`,
      [app.id, change.id, evan.id, id],
    );
    await voice.takeAsks(pool, { sessionId: change.id, runTag: 'r1' });
    assert.deepEqual(await voice.releaseAsks(pool, { runTag: 'r1', refund: true }), [], 'refused: waits, untried');
    await voice.takeAsks(pool, { sessionId: change.id, runTag: 'r2' });
    assert.deepEqual(await voice.releaseAsks(pool, { runTag: 'r2' }), [], 'first failure: tried again');
    assert.equal(await voice.asksWaiting(pool, change.id), true);
    await voice.takeAsks(pool, { sessionId: change.id, runTag: 'r3' });
    const gaveUp = await voice.releaseAsks(pool, { runTag: 'r3' });
    assert.equal(gaveUp.length, 1, 'second failure: gives up, and the voice says so');
    assert.equal(gaveUp[0].asker, evan.username);
    assert.equal(await voice.asksWaiting(pool, change.id), false);
    // A merge drops whatever still waits.
    await pool.query(
      `INSERT INTO homeroom_bot_change_asks (app_id, session_id, issue_number, instruction) VALUES ($1, $2, 12, 'x')`,
      [app.id, change.id],
    );
    await voice.dropAsks(pool, change.id);
    assert.equal(await voice.asksWaiting(pool, change.id), false);
  });

  await t.test('admins read its week in counts and codes, never anybody\'s words', async () => {
    // A turn that failed, with what failed on the way.
    await pool.query(
      `INSERT INTO homeroom_bot_voice_turns (app_id, place_type, place_ref, place_key, outcome, error, failures, rounds, finished_at)
       VALUES ($1, 'issue', 12, $2, 'failed', 'no_key', ARRAY['v1:rate_limited:429'], 1, NOW())`,
      [app.id, `${app.id}:issue:12`],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_change_asks (app_id, session_id, issue_number, instruction, source) VALUES ($1, $2, 12, 'Make the logo bigger', 'chat')`,
      [app.id, change.id],
    );
    const summary = await voice.voiceSummary(pool);
    assert.ok(summary.turns >= 3);
    assert.ok(summary.replied >= 2, 'the change\'s reply and the chat\'s');
    assert.equal(summary.failed, 1);
    assert.ok(summary.byPlace.session.replied >= 1);
    assert.ok(summary.byPlace.chat.replied >= 1);
    assert.equal(summary.byPlace.issue.failed, 1);
    assert.ok(summary.people >= 2);
    const failure = summary.recentFailures.find((f) => f.place === 'issue');
    assert.deepEqual({ ...failure, at: null }, {
      at: null, app: 'todo-list', place: 'issue', ref: 12, outcome: 'failed', error: 'no_key', failures: ['v1:rate_limited:429'], rounds: 1,
    });
    assert.equal(summary.asks.byStatus.queued, 1);
    assert.ok(summary.asks.byStatus.done >= 2);
    assert.equal(summary.asks.bySource.chat, 1);
    assert.deepEqual(summary.asks.waiting.map((w) => [w.change, w.status, w.asks]), [[change.id, 'queued', 1]]);
    assert.deepEqual(summary.offers.file_request, { done: 2 });
    assert.doesNotMatch(JSON.stringify(summary), /logo|header|due date|Sort the list/, 'never the words');
    // And it rides with the console's payload, which the connector reads.
    const payload = await require('../src/services/homeroom-bot').adminPayload(pool, {}, {});
    assert.equal(payload.voice.turns, summary.turns);
  });
});
