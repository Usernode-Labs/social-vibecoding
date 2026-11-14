'use strict';

// Task 2148: Stop, in a person's chat with Homeroom bot, end to end against
// the full PostgreSQL schema: the route a browser presses, their DM
// machine's mark, the answer's own work reading it, the turn ending at its
// next safe point, and the one line it says. The model is a script here
// (the work's real handler runs, handed a `chat` in the model's place), so
// what is checked is everything around it:
//
//   - a Stop pressed while the bot works ends the turn before its next tool
//     call, posts no reply, and says one line where they wrote, once, under
//     the answer's own key, naming what the turn had already done;
//   - a model request in flight is cut off when the work reads the mark
//     (whichever process took the Stop), and is never asked again;
//   - a Stop before the try began is said without anything being done;
//   - the turn is recorded with what it cost and no error, no apology
//     follows, and a retry finds the message answered;
//   - the bot's typing names the message it answers, in the thread a
//     drawing moved it to as well, and the design bot's turn stops the same;
//   - the route is the person's own chat with the bot only.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-stop-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { waitFor } = require('./lib/wait-for');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// What reaches the readers' sockets: the bot's typing events among it.
const pushed = [];
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent(memberIds, payload) { pushed.push(payload); return memberIds.length; },
    pushToUser() { return 1; },
    pushNotificationToUser() { return 1; },
    pushSessionUpdate() {},
    pushIssueUpdate() {},
    async sendSystemMessage() { return { id: 1 }; },
  },
};
const pushId = require.resolve('../src/services/mobile-push');
require.cache[pushId] = { id: pushId, filename: pushId, loaded: true, exports: { scheduleBadgeSync() { return false; } } };

const express = require('express');
const conversations = require('../src/services/conversations');
const dm = require('../src/services/homeroom-bot-dm');
const mayor = require('../src/services/homeroom-bot-mayor');
const botStop = require('../src/services/homeroom-bot-stop');
const { conversationRoutes } = require('../src/routes/conversations');
const { botDmServices, stopAsked } = require('../src/workflow/bot-dm/services.ts');
const { WORK } = require('../src/workflow/bot-dm/machine.ts');

const CONFIG = { openrouterApiBase: 'https://openrouter.test/api/v1', openrouterOrigin: 'https://test', openrouterDefaultCodexModel: 'z-ai/glm-5.3-flash' };

const callsOf = (round, list) => {
  const calls = list.map((c, n) => ({ id: `call_${round}_${n}`, type: 'function', function: { name: c[0], arguments: JSON.stringify(c[1] || {}) } }));
  return {
    content: '', toolCalls: calls, assistantMessage: { role: 'assistant', content: null, tool_calls: calls },
    usage: { inputTokens: 1000, outputTokens: 100, costUsd: 0.0021 },
  };
};

test('Stop in the chat with Homeroom bot, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_stop_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  pool.on('error', () => {});
  // The workflow runtime runs here, on this database: its pipeline only, so
  // a message is heard and a Stop decided, and no work runs by itself. The
  // answer's work is run by hand below, as a worker process would.
  const platform = require('../src/workflow/platform.ts');
  require('../src/db/pool').getPool = () => pool;
  const realAnswerOwed = dm.answerOwed;
  t.after(async () => {
    dm.answerOwed = realAnswerOwed;
    await platform.stopWorkflow();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await platform.startWorkflow({ databaseUrl: String(url), dataEncryptionKey: 'synthetic-key', wfPoolMax: 4, wfSlots: 2 }, { loops: false });

  let seq = 0;
  async function user(prefix, { synthetic = false } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_synthetic)
       VALUES ($1, 'x', TRUE, $2) RETURNING id, username, has_platform_access AS "hasPlatformAccess"`,
      [synthetic ? prefix : `${prefix}_${++seq}`, synthetic],
    );
    return rows[0];
  }
  const bot = await user('homeroom_bot', { synthetic: true });
  const ada = await user('ada');
  const sam = await user('sam');
  await pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ('homeroom_bot_mode', 'shadow')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const opened = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
  const conversationId = Number(opened.conversationId);
  const samsChat = Number((await conversations.ensureAdmittedDirect(pool, bot.id, sam.id)).conversationId);
  const friends = Number((await conversations.ensureAdmittedDirect(pool, ada.id, sam.id)).conversationId);

  const instance = async (u) => (await pool.query(
    `SELECT state, data FROM wf_instances WHERE machine = 'bot-dm' AND key = $1`, [`person:${u.id}`])).rows[0];
  // The instance, with no answer under way: this suite runs each answer's
  // work by hand, so nothing reports its end to the machine.
  const forget = async (u) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL app.wf_writer = 'transition'");
      await c.query(`DELETE FROM wf_work WHERE machine = 'bot-dm' AND key = $1`, [`person:${u.id}`]);
      await c.query(`DELETE FROM wf_instances WHERE machine = 'bot-dm' AND key = $1`, [`person:${u.id}`]);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
  };
  // A person's message in their chat with the bot, as the route stores it:
  // heard by their DM machine in the message's own transaction.
  async function write(who, where, text, extra = {}) {
    const sent = await conversations.sendMessage(pool, who, where, { content: text, ...extra }, {
      afterInsert: (db, m) => dm.heardInDm(db, { user: who, conversationId: where, messageId: m.messageId, membership: m.membership, memberIds: m.memberIds }),
    });
    const id = Number(sent.messageId);
    await waitFor(async () => {
      const i = await instance(who);
      return i?.state === 'answering' && Number(i.data.current?.messageId) === id;
    }, { label: `the answer to message ${id} to be owed`, timeoutMs: 15000 });
    return id;
  }
  const botSaid = async (afterId) => (await pool.query(
    `SELECT id, content, idempotency_key, reply_to_id, thread_root_id FROM conversation_messages
      WHERE conversation_id = $1 AND sender_id = $2 AND id > $3 AND deleted_at IS NULL ORDER BY id`,
    [conversationId, bot.id, afterId])).rows;
  const turnOf = async (messageId) => (await pool.query(
    `SELECT rounds, tools, error, fallback, cost_usd::float8 AS cost FROM homeroom_bot_dm_turns WHERE message_id = $1 ORDER BY id`, [messageId])).rows;

  // The answer's work, as its machine's handler runs it, with a script in
  // the model's place.
  const services = botDmServices({ config: CONFIG, pool });
  let script = null;
  dm.answerOwed = (p, config, args) => realAnswerOwed(p, config, {
    ...args,
    deps: {
      bot, chat: (request) => script(request), apiKey: 'sk-test', seesImages: false, sleep: async () => {},
      openMcp: async () => { throw new Error('no platform tools here'); },
    },
  });
  const runAnswer = (who, where, messageId, { tries = 1, kept = null, checkpoints = [] } = {}) => services[WORK.answer].run({
    input: { userId: who.id, conversationId: where, messageId, attempt: 0, key: `msg:${messageId}` },
    key: `msg:${messageId}`, resumeFrom: kept, attempt: tries,
    checkpoint: async (value) => { checkpoints.push(JSON.parse(JSON.stringify(value))); },
  });

  // The route, as the signed-in person's browser reaches it.
  const app = express();
  app.use(express.json());
  let actor = ada;
  app.use((req, _res, next) => { req.user = actor; next(); });
  app.use(conversationRoutes(CONFIG, { pool }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const press = async (as, where, body, headers = {}) => {
    actor = as;
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/conversations/${where}/bot-stop`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  await t.test('pressed while the bot works: the turn ends before its next tool call and says one line, with what it had done', async () => {
    pushed.length = 0;
    const messageId = await write(ada, conversationId, 'I want an app to remind me to water plants');
    const checkpoints = [];
    let requests = 0;
    let pressed = null;
    script = async (request) => {
      requests += 1;
      if (requests === 1) return callsOf(1, [['close_thread', {}]]);
      // The bot is writing its answer when she presses Stop; the request
      // still comes back, with the reply the turn was about to send.
      pressed = await press(ada, conversationId, { messageId });
      await waitFor(() => request.signal.aborted, { label: 'the answer\'s work to read the mark', timeoutMs: botStop.STOP_POLL_MS + 4000 });
      return callsOf(2, [['reply', { text: 'Tell me what its first screen shows.' }]]);
    };
    const out = await runAnswer(ada, conversationId, messageId, { checkpoints });
    assert.deepEqual(pressed, { status: 200, body: { ok: true, stopping: true } });
    assert.deepEqual(out, { sent: true, later: null, skipped: null });
    assert.equal(requests, 2, 'nothing more was asked of the model');

    const said = await botSaid(messageId);
    // The one line of the Stop, with what the turn had done.
    assert.equal(said.length, 1);
    const line = said[0];
    assert.equal(line.content, 'Stopped. I had already marked this thread done; it stays done.');
    assert.equal(line.idempotency_key, `hrbot-mayor-${messageId}`, 'under the answer\'s own key');
    assert.equal(line.reply_to_id, null, 'right under what she wrote, which starts the thread: nothing to quote');
    assert.equal(Number(line.thread_root_id), messageId, 'in the thread her message started (14 Nov 2026: every message is in one)');
    assert.ok(!said.some((m) => /first screen/.test(m.content)), 'the reply it was writing is not sent');

    // Recorded as a turn that cost what it cost; the model did not fail.
    const turns = await turnOf(messageId);
    assert.equal(turns.length, 1);
    assert.deepEqual([turns[0].rounds, turns[0].tools, turns[0].error, turns[0].fallback], [2, ['close_thread'], null, 'stopped']);
    assert.ok(turns[0].cost > 0);
    // What it did was kept as it was done (the work's checkpoint).
    assert.deepEqual(checkpoints.at(-1).did, [{ did: 'marked this thread done', stays: 'it stays done' }]);
    // Her machine holds the mark; the answer's work was not cancelled.
    const i = await instance(ada);
    assert.deepEqual([i.state, i.data.current.stop], ['answering', true]);
    const { rows: [item] } = await pool.query(
      `SELECT status FROM wf_work WHERE machine = 'bot-dm' AND key = $1 AND work_key = $2`, [`person:${ada.id}`, `msg:${messageId}`]);
    assert.equal(item.status, 'queued', 'left to its own work (which this suite runs by hand)');

    // The bot's typing named the message it was answering, on every event,
    // and stopped when the line was said: the working card goes with it.
    const typing = pushed.filter((p) => p.type === 'conversation_typing' && p.conversationId === conversationId);
    assert.ok(typing.length >= 2);
    assert.ok(typing.filter((p) => p.typing).every((p) => p.answering === messageId));
    assert.deepEqual([typing.at(-1).typing, 'answering' in typing.at(-1)], [false, false]);

    // Nothing more follows: a retry finds it answered, no apology, no second line.
    script = async () => assert.fail('the model is not asked again');
    assert.deepEqual(await runAnswer(ada, conversationId, messageId, { tries: 2 }), { sent: true, later: null, skipped: 'answered' });
    assert.equal(await dm.sayCouldNotAnswer(pool, { userId: ada.id, conversationId, messageId, deps: { bot } }), null);
    assert.equal(await dm.sayStopped(pool, { userId: ada.id, conversationId, messageId, deps: { bot } }), null);
    assert.equal((await botSaid(messageId)).length, 1);
    // Pressed again: harmless.
    assert.deepEqual(await press(ada, conversationId, { messageId }), { status: 200, body: { ok: true, stopping: true } });
    assert.equal((await botSaid(messageId)).length, 1);
    await forget(ada);
  });

  await t.test('a model request in flight is cut off when the work reads the mark, and is not asked again', async () => {
    const messageId = await write(ada, conversationId, 'what am I waiting on?');
    let requests = 0;
    script = (request) => new Promise((_resolve, reject) => {
      requests += 1;
      assert.ok(request.signal, 'the transport is handed the turn\'s signal');
      // As openrouter.js streamChat ends on its caller's signal.
      request.signal.addEventListener('abort', () => reject(Object.assign(new Error('OpenRouter model cancelled'), { code: 'cancelled' })));
      // The Stop was taken by some other process: the mark is all there is.
      (async () => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          await c.query("SET LOCAL app.wf_writer = 'transition'");
          await c.query(
            `UPDATE wf_instances SET data = jsonb_set(data, '{current,stop}', 'true'::jsonb) WHERE machine = 'bot-dm' AND key = $1`, [`person:${ada.id}`]);
          await c.query('COMMIT');
        } finally {
          c.release();
        }
      })().catch(reject);
    });
    const started = Date.now();
    const out = await runAnswer(ada, conversationId, messageId);
    assert.ok(Date.now() - started < botStop.STOP_POLL_MS + 3000, 'within the next read of the mark');
    assert.deepEqual(out, { sent: true, later: null, skipped: null });
    assert.equal(requests, 1, 'not retried');
    const said = await botSaid(messageId);
    assert.deepEqual(said.map((m) => m.content), ['Stopped. Nothing was filed or changed.']);
    const [turn] = await turnOf(messageId);
    assert.deepEqual([turn.error, turn.fallback, turn.tools], [null, 'stopped', []]);
    await forget(ada);
  });

  await t.test('pressed before the try began: said at once, with nothing done; after an earlier try, it rules nothing out', async () => {
    const messageId = await write(ada, conversationId, 'never mind this one');
    assert.equal(await stopAsked(pool, { userId: ada.id, messageId, attempt: 0 }), false);
    assert.deepEqual(await press(ada, conversationId, { messageId }), { status: 200, body: { ok: true, stopping: true } });
    assert.equal(await stopAsked(pool, { userId: ada.id, messageId, attempt: 0 }), true);
    script = async () => assert.fail('the model is never asked');
    assert.deepEqual(await runAnswer(ada, conversationId, messageId), { sent: true, later: null, skipped: null, stopped: true });
    assert.deepEqual((await botSaid(messageId)).map((m) => [m.content, m.idempotency_key]),
      [['Stopped. Nothing was filed or changed.', `hrbot-mayor-${messageId}`]]);
    assert.equal((await turnOf(messageId)).length, 0, 'no turn ran');
    await forget(ada);

    // A try after one that ended in a failure: what that one did is known
    // only as far as it was kept.
    const second = await write(ada, conversationId, 'nor this one');
    await press(ada, conversationId, { messageId: second });
    assert.deepEqual(await runAnswer(ada, conversationId, second, { tries: 2 }), { sent: true, later: null, skipped: null, stopped: true });
    assert.deepEqual((await botSaid(second)).map((m) => m.content), ['Stopped. Anything I had already done stays done.']);
    await forget(ada);
    const third = await write(ada, conversationId, 'or this');
    await press(ada, conversationId, { messageId: third });
    await runAnswer(ada, conversationId, third, { tries: 2, kept: { effects: {}, did: [{ did: 'started work on request #7', stays: 'it carries on' }] } });
    assert.deepEqual((await botSaid(third)).map((m) => m.content), ['Stopped. I had already started work on request #7; it carries on.']);
    await forget(ada);
  });

  await t.test('a screen handed to the designer: it draws in her thread, and a Stop there says so in it', async () => {
    pushed.length = 0;
    const messageId = await write(ada, conversationId, 'draw me a plant list screen');
    let requests = 0;
    script = async (request) => {
      requests += 1;
      if (requests === 1) return callsOf(1, [['draw_screen', { what: 'A list of plants with when each was last watered.', title: 'Plant list' }]]);
      // The designer's first request: she presses Stop while it draws.
      await press(ada, conversationId, { messageId });
      await waitFor(() => request.signal.aborted, { label: 'the answer\'s work to read the mark', timeoutMs: botStop.STOP_POLL_MS + 4000 });
      return callsOf(2, [['write_screen', { title: 'Plant list', size: 'phone', html: '<main><h1>Plants</h1></main>', note: 'First drawing' }]]);
    };
    const out = await runAnswer(ada, conversationId, messageId);
    assert.deepEqual(out, { sent: true, later: null, skipped: null });
    const said = await botSaid(messageId);
    // 14 Nov 2026: her message is in a thread already (every message is), so
    // the designer draws there. No thread is opened for the screen, and the
    // one line of the Stop is said where the working card was.
    assert.deepEqual(said.map((m) => [m.content, Number(m.thread_root_id), m.idempotency_key]),
      [['Stopped. Nothing was filed or changed.', messageId, `hrbot-mayor-${messageId}`]]);
    const { rows: [thread] } = await pool.query('SELECT id FROM private_threads WHERE root_message_id = $1', [messageId]);
    assert.ok(thread, 'her thread stays');
    const { rows: versions } = await pool.query('SELECT version FROM design_versions WHERE private_thread_id = $1', [thread.id]);
    assert.equal(versions.length, 0, 'no version of the screen was saved');
    // The designer's turn is recorded as stopped too (the turn that handed it the screen went through).
    const turns = await turnOf(messageId);
    assert.deepEqual(turns.map((r) => [r.error, r.fallback]), [[null, null], [null, 'stopped']]);
    // Its typing stayed in her thread, still naming her message.
    const there = pushed.filter((p) => p.type === 'conversation_typing' && p.typing && Number(p.threadRootId) === messageId);
    assert.ok(there.length >= 1);
    assert.ok(there.every((p) => p.answering === messageId));
    await forget(ada);
  });

  await t.test('the route is the person\'s own chat with the bot, from the Homeroom page, and answers whether anything is being stopped', async () => {
    const messageId = await write(ada, conversationId, 'one more');
    // Somebody else's chat with the bot, and a chat between people: not found.
    assert.equal((await press(sam, conversationId, { messageId })).status, 404);
    assert.equal((await press(ada, samsChat, { messageId })).status, 404);
    assert.equal((await press(ada, friends, { messageId })).status, 404);
    assert.equal((await press(ada, 'homeroom', { messageId })).status, 404);
    assert.equal((await press(ada, 99999999, { messageId })).status, 404);
    // No message named, or not a message id: nothing to stop.
    assert.equal((await press(ada, conversationId, {})).status, 404);
    assert.equal((await press(ada, conversationId, { messageId: 'all' })).status, 404);
    // Not a person, or not sent by the Homeroom page.
    assert.equal((await press({ ...ada, isSynthetic: true }, conversationId, { messageId })).status, 403);
    assert.equal((await press(ada, conversationId, { messageId }, { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await press(ada, conversationId, { messageId }, { 'sec-fetch-site': 'same-site' })).status, 403);
    // None of those stopped her answer.
    assert.equal(await stopAsked(pool, { userId: ada.id, messageId, attempt: 0 }), false);
    // An answer that is not the one under way (it ended first, or it is an
    // older message): nothing is stopped, and the route says so.
    assert.deepEqual(await press(ada, conversationId, { messageId: messageId - 1 }), { status: 200, body: { ok: true, stopping: false } });
    assert.equal(await stopAsked(pool, { userId: ada.id, messageId, attempt: 0 }), false);
    // Sam, whom the bot is answering nothing for.
    assert.deepEqual(await press(sam, samsChat, { messageId }), { status: 200, body: { ok: true, stopping: false } });
    assert.equal(await instance(sam), undefined, 'a Stop makes no instance');
    // Hers, from her own page.
    assert.deepEqual(await press(ada, conversationId, { messageId }, { 'sec-fetch-site': 'same-origin' }), { status: 200, body: { ok: true, stopping: true } });
    assert.equal(await stopAsked(pool, { userId: ada.id, messageId, attempt: 0 }), true);
    // A browser's own press only: it is on no connector's or CLI's list.
    const policy = require('node:fs').readFileSync(require.resolve('../src/services/cli-api-policy.js'), 'utf8');
    assert.doesNotMatch(policy, /bot-stop/);
    await forget(ada);
  });

  await t.test('an answer that went out before the Stop landed gets nothing extra', async () => {
    const messageId = await write(ada, conversationId, 'thanks!');
    script = async () => callsOf(1, [['reply', { text: 'Any time.' }]]);
    assert.deepEqual(await runAnswer(ada, conversationId, messageId), { sent: true, later: null, skipped: null });
    // Pressed as the answer arrived: the machine still holds the answer
    // here (nothing reports its end in this suite), so the Stop is taken,
    // and the work that would say it finds the message answered.
    assert.deepEqual(await press(ada, conversationId, { messageId }), { status: 200, body: { ok: true, stopping: true } });
    assert.deepEqual(await runAnswer(ada, conversationId, messageId, { tries: 2 }), { sent: true, later: null, skipped: 'answered' });
    assert.equal(await dm.sayStopped(pool, { userId: ada.id, conversationId, messageId, deps: { bot } }), null);
    assert.deepEqual((await botSaid(messageId)).map((m) => m.content), ['Any time.']);
    await forget(ada);
  });
});
