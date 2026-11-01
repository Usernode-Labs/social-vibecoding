'use strict';

// The Homeroom bot's reply machines (src/workflow/bot-voice/, bot-dm/)
// against the full PostgreSQL schema, with the work that answers faked: what
// a person writes is owed an answer from the moment it is stored, a burst in
// a place is one turn, a person's DM messages are answered one at a time in
// the order written, a later try is the instance's own timer, a tap is
// decided once, and what a place or a DM owes others (reports, held answers,
// hellos) is said once. The [main] bugs fixed are named where each is pinned
// (workflow-foundation's trace-bot-replies.md §5).
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/workflow-bot-replies-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createRuntime } = require('../src/workflow/kernel/index.ts');
const voice = require('../src/workflow/bot-voice/machine.ts');
const dm = require('../src/workflow/bot-dm/machine.ts');
const { SETTLE_MS, SETTLE_CAP_MS, DEFER_DELAYS_MS } = require('../src/workflow/rules/bot-replies.ts');
const platform = require('../src/workflow/platform.ts');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the Homeroom bot\'s reply machines against the full PostgreSQL schema', { timeout: 240000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'wf_botreplies_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  pool.on('error', () => {});
  const runtimes = [];
  t.after(async () => {
    for (const r of runtimes) await r.stop();
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  // ── Fixture ─────────────────────────────────────────────────────────
  let seq = 0;
  const user = async (name = `p${++seq}`) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`, [name])).rows[0];
  const { rows: [bot] } = await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id`);
  const ada = await user('ada');
  const ben = await user('ben');
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by, status) VALUES ('Clubs', 'clubs', $1, 'running') RETURNING id`, [ada.id]);
  const asTransition = async (fn) => {
    const cl = await pool.connect();
    try { await cl.query(`BEGIN; SET LOCAL app.wf_writer = 'transition'`); await fn(cl); await cl.query('COMMIT'); } finally { cl.release(); }
  };

  // Fake work: each call recorded; `answer` per kind.
  const work = { calls: [], answer: new Map() };
  const fake = (kind) => ({
    maxAttempts: 2, backoffMs: () => 0, leaseMs: 600,
    async run({ input, key }) {
      work.calls.push({ kind, key, input });
      const a = work.answer.get(kind);
      if (typeof a === 'function') return a(input, key);
      return a ?? { ok: true };
    },
  });
  const services = Object.fromEntries([...Object.values(voice.WORK), ...Object.values(dm.WORK)].map((k) => [k, fake(k)]));
  const rt = createRuntime({ pool, machines: [voice.botVoice(), dm.botDm()], pollMs: 50, publish: async () => {}, services });
  runtimes.push(rt);
  const settle = async () => {
    for (let i = 0; i < 60; i++) {
      await rt.drain();
      if (!(await rt.runServices())) { await rt.drain(); return; }
    }
  };
  const calls = (kind) => work.calls.filter((c) => c.kind === kind);
  const reset = () => { work.calls.length = 0; work.answer.clear(); };
  const until = async (check, what, ms = 20000) => {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() >= deadline) assert.fail(`never: ${what}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const inst = async (machine, key) => (await pool.query('SELECT * FROM wf_instances WHERE machine = $1 AND key = $2', [machine, key])).rows[0];
  const fire = async (machine, key) => {
    await asTransition((cl) => cl.query('UPDATE wf_instances SET deadline_at = now() WHERE machine = $1 AND key = $2', [machine, key]));
    await rt.fireTimers();
    await settle();
  };
  // The deadline made due and its event applied, no work run (for a case
  // that holds a work item open while it looks).
  const fireOnly = async (machine, key) => {
    await asTransition((cl) => cl.query('UPDATE wf_instances SET deadline_at = now() WHERE machine = $1 AND key = $2', [machine, key]));
    await rt.fireTimers();
    await rt.drain();
  };
  let rk = 0;
  const send = async (machine, key, type, payload, source = { kind: 'route' }) => {
    const id = await rt.append(machine, key, { type, payload }, { requestKey: `t-${++rk}`, source });
    await settle();
    return (await pool.query('SELECT result, reason, reply FROM wf_events WHERE id = $1', [id])).rows[0];
  };

  // A person's message in a project, as ws.js stores it: the row and its
  // Heard event in one statement.
  const chat = async (who, content, thread = null) => {
    const [row] = await platform.insertHeard(pool,
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref)
       VALUES ($1, $2, $3, 'message', '{}', $4, $5) RETURNING id, created_at`,
      [app.id, who.id, content, thread?.type || null, thread?.ref ?? null], { appId: app.id, thread });
    await rt.drain();
    return row.id;
  };
  const chatKey = `place:${app.id}:chat:`;

  await t.test('V-heard: a message and its Heard commit in one statement; a vote\'s thread is not heard', async () => {
    reset();
    const id = await chat(ada, 'hello all');
    const { rows: [e] } = await pool.query(`SELECT machine, key, type, payload, request_key FROM wf_events WHERE request_key = $1`, [`heard:${id}`]);
    assert.deepEqual([e.machine, e.key, e.type, e.payload.messageId, e.payload.place], ['bot-voice', chatKey, 'Heard', id, { type: 'chat', ref: null }]);
    const i = await inst('bot-voice', chatKey);
    assert.equal(i.state, 'settling', 'decoded and applied: the place settles');
    const { rows: [vote] } = await pool.query(
      `INSERT INTO issues (app_id, title, kind, created_by) VALUES ($1, 'Rename', 'rename', $2) RETURNING id`, [app.id, ada.id]);
    const voteMsg = await chat(ada, 'yes', { type: 'governance', ref: vote.id });
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM wf_events WHERE request_key = $1`, [`heard:${voteMsg}`])).rows[0].n, 0);
    await fire('bot-voice', chatKey);
  });

  await t.test('V-burst: a message and its mention seconds later are one turn, settled 8 s after the last, never 25 s after the first', async () => {
    reset();
    await settle();
    const before = calls(voice.WORK.turn).length;
    await chat(ada, 'can someone add tags');
    const first = await inst('bot-voice', chatKey);
    assert.equal(first.state, 'settling');
    const at1 = new Date(first.deadline_at).getTime();
    await chat(ada, '@Homeroom bot');
    const second = await inst('bot-voice', chatKey);
    assert.ok(new Date(second.deadline_at).getTime() >= at1, 'moved on by the later message');
    assert.ok(new Date(second.deadline_at).getTime() - Date.now() <= SETTLE_MS + 1000);
    // The burst began 30 s ago: the cap has passed, so it settles at once.
    await asTransition((cl) => cl.query(
      `UPDATE wf_instances SET data = jsonb_set(data, '{first}', to_jsonb((now() - interval '30 seconds')::text)) WHERE machine = 'bot-voice' AND key = $1`,
      [chatKey]));
    await chat(ben, 'me too');
    const capped = await inst('bot-voice', chatKey);
    assert.ok(new Date(capped.deadline_at).getTime() <= Date.now() - (30000 - SETTLE_CAP_MS) + 1000, 'never past 25 s after the first');
    await fire('bot-voice', chatKey);
    assert.equal(calls(voice.WORK.turn).length, before + 1, 'one turn for the burst');
    assert.equal((await inst('bot-voice', chatKey)).state, 'quiet');
  });

  await t.test('V-again: written to while a turn ran, the place settles again after it, reading on from where the turn read', async () => {
    reset();
    let gate;
    const held = new Promise((r) => { gate = r; });
    let lastId = 0;
    work.answer.set(voice.WORK.turn, async (input) => {
      if (!input.through) await held;
      return { outcome: 'replied', throughId: lastId };
    });
    const place = { type: 'issue', ref: 7 };
    const key = `place:${app.id}:issue:7`;
    lastId = await chat(ada, '@Homeroom bot is it done?', place);
    await fireOnly('bot-voice', key);
    const turn = rt.runServices();
    let during;
    try {
      await until(() => calls(voice.WORK.turn).length === 1, 'the turn started');
      during = await chat(ben, 'and the other part?', place);
      await rt.drain();
      assert.equal((await inst('bot-voice', key)).data.again, true);
    } finally {
      gate();
      await turn;
    }
    await settle();
    const after = await inst('bot-voice', key);
    assert.equal(after.state, 'settling', 'a turn of its own for what came during');
    assert.equal(after.data.through, lastId);
    lastId = during;
    await fire('bot-voice', key);
    const turns = calls(voice.WORK.turn);
    assert.equal(turns.length, 2);
    assert.equal(turns[1].input.through, after.data.through, 'it reads on from where the first turn read');
    assert.equal((await inst('bot-voice', key)).data.through, during);
  });

  await t.test('V-sorry: a turn that fails for good is followed by one that says it could not answer (Q3), once', async () => {
    reset();
    const place = { type: 'issue', ref: 8 };
    const key = `place:${app.id}:issue:8`;
    work.answer.set(voice.WORK.turn, (input) => {
      if (!input.sorry) throw new Error('the database went away');
      return { outcome: 'fallback', throughId: 99 };
    });
    await chat(ada, '@Homeroom bot hello?', place);
    await rt.drain();
    await fire('bot-voice', key);
    const turns = calls(voice.WORK.turn);
    assert.deepEqual(turns.map((c) => c.input.sorry), [false, false, true], 'two tries, then the sorry turn');
    const i = await inst('bot-voice', key);
    assert.deepEqual([i.state, i.data.sorry, i.data.through], ['quiet', false, 99]);
    // A sorry turn that fails too does not loop.
    reset();
    work.answer.set(voice.WORK.turn, () => { throw new Error('still down'); });
    await chat(ada, '@Homeroom bot hello again?', place);
    await rt.drain();
    await fire('bot-voice', key);
    assert.deepEqual(calls(voice.WORK.turn).map((c) => c.input.sorry), [false, false, true, true]);
    assert.equal((await inst('bot-voice', key)).state, 'quiet');
  });

  await t.test('V-tap: a tap under an offer is decided once, by the person it was offered to, and its act is work (bug 7)', async () => {
    reset();
    const root = await chat(ada, '@Homeroom bot sort by date?');
    const thread = { type: 'message', ref: root };
    const { rows: [reply] } = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref) VALUES ($1, $2, 'File it?', 'message', '{}', 'message', $3) RETURNING id`,
      [app.id, bot.id, root]);
    const { rows: [offer] } = await pool.query(
      `INSERT INTO homeroom_bot_voice_offers (app_id, kind, args, for_user_id, message_id) VALUES ($1, 'file_request', '{}', $2, $3) RETURNING id`,
      [app.id, ada.id, reply.id]);
    const key = `place:${app.id}:message:${root}`;
    const tap = (who, choice = 'yes') => send('bot-voice', key, 'OfferTapped', { appId: app.id, place: thread, offerId: offer.id, userId: who.id, choice });
    assert.deepEqual(await tap(ben), { result: 'rejected', reason: 'not_for_you', reply: null });
    assert.equal((await tap(ada)).result, 'accepted');
    assert.equal((await tap(ada, 'no')).reason, 'already_decided', 'decided once, even before its act ran');
    assert.equal(calls(voice.WORK.act).length, 1);
    assert.deepEqual(calls(voice.WORK.act)[0].input, { offerId: offer.id, userId: ada.id, choice: 'yes', key: `offer:${offer.id}` });
    // Its act failed for good: it is settled as failed and said, by work
    // (never left deciding with its buttons up: bug 7).
    reset();
    const { rows: [o2] } = await pool.query(
      `INSERT INTO homeroom_bot_voice_offers (app_id, kind, args, for_user_id, message_id) VALUES ($1, 'file_request', '{}', $2, NULL) RETURNING id`,
      [app.id, ada.id]);
    const { rows: [reply2] } = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata, thread_type, thread_ref) VALUES ($1, $2, 'Again?', 'message', '{}', 'message', $3) RETURNING id`,
      [app.id, bot.id, root]);
    await pool.query('UPDATE homeroom_bot_voice_offers SET message_id = $2 WHERE id = $1', [o2.id, reply2.id]);
    work.answer.set(voice.WORK.act, (input) => { if (!input.gaveUp) throw new Error('GitHub is down'); return { decision: 'failed' }; });
    assert.equal((await send('bot-voice', key, 'OfferTapped', { appId: app.id, place: thread, offerId: o2.id, userId: ada.id, choice: 'yes' })).result, 'accepted');
    assert.deepEqual(calls(voice.WORK.act).map((c) => [c.key, !!c.input.gaveUp, c.input.key]),
      [[`offer:${o2.id}`, false, `offer:${o2.id}`], [`offer:${o2.id}`, false, `offer:${o2.id}`], [`offer:${o2.id}:failed`, true, `offer:${o2.id}`]]);
    // An offer of another place is not this place's to decide.
    const other = await send('bot-voice', chatKey, 'OfferTapped', { appId: app.id, place: { type: 'chat', ref: null }, offerId: offer.id, userId: ada.id, choice: 'yes' });
    assert.equal(other.reason, 'no_such_offer');
  });

  await t.test('V-report: a follow-up\'s report is owed by its place, said once per follow-up (bug 8)', async () => {
    reset();
    const place = { type: 'session', ref: 50 };
    const key = `place:${app.id}:session:50`;
    const payload = { appId: app.id, place, sessionId: 50, runTag: 'fu-1', asks: [1, 2], outcome: { action: 'revise' } };
    await send('bot-voice', key, 'Report', payload, { kind: 'system' });
    await send('bot-voice', key, 'Report', payload, { kind: 'system' });
    assert.equal(calls(voice.WORK.report).length, 1);
    assert.equal(calls(voice.WORK.report)[0].key, 'report:fu-1');
    assert.equal((await send('bot-voice', key, 'Report', payload, { kind: 'route' })).reason, 'not_a_producer', 'the bot\'s loop says it, never a browser');
  });

  await t.test('V-held: a held request\'s answer is owed from the decision: its post row pending, then said (bugs 20, 21)', async () => {
    reset();
    const place = { type: 'issue', ref: 75 };
    const key = `place:${app.id}:issue:75`;
    const payload = { appId: app.id, place, kind: 'going_ahead', text: 'Taking it up.', mentionId: 4242, mention: null, mentions: ['ada'] };
    let seenPending = null;
    work.answer.set(voice.WORK.post, async () => {
      seenPending = (await pool.query(`SELECT pending FROM homeroom_bot_posts WHERE app_id = $1 AND issue_number = 75`, [app.id])).rows[0]?.pending;
      return { postId: 1 };
    });
    await send('bot-voice', key, 'HeldAnswer', payload, { kind: 'system' });
    await send('bot-voice', key, 'HeldAnswer', payload, { kind: 'system' });
    assert.equal(seenPending, true, 'written with the decision, before it is said');
    assert.equal(calls(voice.WORK.post).length, 1, 'once per mention');
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM homeroom_bot_posts WHERE app_id = $1 AND issue_number = 75`, [app.id])).rows[0].n, 1);
  });

  // ── bot-dm ─────────────────────────────────────────────────────────
  const dmKey = (u) => `person:${u.id}`;
  const wrote = (u, messageId, attempt = 0) => send('bot-dm', dmKey(u), 'Wrote', { userId: u.id, conversationId: 1, messageId, attempt });

  await t.test('D-order: one answer at a time, in the order written, wherever it runs (bug 13)', async () => {
    reset();
    let gate;
    const held = new Promise((r) => { gate = r; });
    work.answer.set(dm.WORK.answer, async (input) => { if (input.messageId === 101) await held; return { sent: true }; });
    await rt.append('bot-dm', dmKey(ada), { type: 'Wrote', payload: { userId: ada.id, conversationId: 1, messageId: 101, attempt: 0 } },
      { requestKey: `t-${++rk}`, source: { kind: 'route' } });
    await rt.drain();
    const first = rt.runServices();
    try {
      await until(() => calls(dm.WORK.answer).length === 1, 'the answer to 101 started');
      // Written while it answers (appended and applied, no work run).
      for (const id of [102, 103]) {
        await rt.append('bot-dm', dmKey(ada), { type: 'Wrote', payload: { userId: ada.id, conversationId: 1, messageId: id, attempt: 0 } },
          { requestKey: `t-${++rk}`, source: { kind: 'route' } });
      }
      await rt.drain();
      assert.deepEqual(calls(dm.WORK.answer).map((c) => c.input.messageId), [101], 'the next waits for the one before');
      const i = await inst('bot-dm', dmKey(ada));
      assert.deepEqual([i.state, i.data.queue.map((q) => q.messageId)], ['answering', [102, 103]]);
    } finally {
      gate();
      await first;
    }
    await settle();
    assert.deepEqual(calls(dm.WORK.answer).map((c) => c.input.messageId), [101, 102, 103]);
    assert.equal((await inst('bot-dm', dmKey(ada))).state, 'idle');
    // The same message heard again (an adoption, a retried route) is one
    // answer, and leaves nothing waiting.
    await wrote(ada, 103);
    await wrote(ada, 102);
    assert.equal(calls(dm.WORK.answer).length, 3);
    assert.equal((await inst('bot-dm', dmKey(ada))).state, 'idle', 'not left answering for a work item never made');
  });

  await t.test('D-later: an answer the model could not give is asked again by the instance\'s timer; a newer message drops it (bugs 11, 12)', async () => {
    reset();
    work.answer.set(dm.WORK.answer, (input) => ({ sent: true, later: input.attempt < DEFER_DELAYS_MS.length ? input.attempt + 1 : null }));
    await wrote(ben, 201);
    let i = await inst('bot-dm', dmKey(ben));
    assert.equal(i.state, 'trying_later');
    assert.ok(Math.abs(new Date(i.deadline_at).getTime() - Date.now() - DEFER_DELAYS_MS[0]) < 5000, 'a minute on');
    await fire('bot-dm', dmKey(ben));
    i = await inst('bot-dm', dmKey(ben));
    assert.ok(Math.abs(new Date(i.deadline_at).getTime() - Date.now() - DEFER_DELAYS_MS[1]) < 5000, 'then three');
    assert.deepEqual(calls(dm.WORK.answer).map((c) => c.key), ['msg:201', 'msg:201:d1']);
    // Written to since: that try is dropped, the new message answered.
    await wrote(ben, 202);
    assert.deepEqual(calls(dm.WORK.answer).map((c) => c.key), ['msg:201', 'msg:201:d1', 'msg:202']);
    // 31 Oct 2026: and that answer owes 201 too: it was promised and never came.
    assert.deepEqual(calls(dm.WORK.answer)[2].input.also, [201]);
    assert.equal('also' in calls(dm.WORK.answer)[0].input, false, 'nothing owed on a first answer');
    i = await inst('bot-dm', dmKey(ben));
    assert.equal(i.data.later?.messageId, 202, 'the new one is now the one tried later');
    await fire('bot-dm', dmKey(ben));
    await fire('bot-dm', dmKey(ben));
    await fire('bot-dm', dmKey(ben));
    assert.deepEqual(calls(dm.WORK.answer).map((c) => c.key).slice(3), ['msg:202:d1', 'msg:202:d2', 'msg:202:d3']);
    assert.deepEqual(calls(dm.WORK.answer).slice(3).map((c) => c.input.also), [[201], [201], [201]], 'every later try of 202 owes 201');
    assert.equal((await inst('bot-dm', dmKey(ben))).state, 'idle', 'the last try said it could not, and nothing more is asked');
  });

  await t.test('D-owed: an answer that would be asked again, dropped for a message written meanwhile, is owed by that message\'s answer', async () => {
    reset();
    const dora = await user('dora');
    let gate;
    const held = new Promise((r) => { gate = r; });
    // 31 Oct 2026, as Evan's thread went: each answer the model could not
    // give, and the next message already waiting.
    work.answer.set(dm.WORK.answer, async (input) => {
      if (input.messageId === 401) await held;
      return { sent: true, later: input.messageId < 403 ? 1 : null };
    });
    await rt.append('bot-dm', dmKey(dora), { type: 'Wrote', payload: { userId: dora.id, conversationId: 1, messageId: 401, attempt: 0 } },
      { requestKey: `t-${++rk}`, source: { kind: 'route' } });
    await rt.drain();
    const first = rt.runServices();
    try {
      await until(() => calls(dm.WORK.answer).length === 1, 'the answer to 401 started');
      for (const id of [402, 403]) {
        await rt.append('bot-dm', dmKey(dora), { type: 'Wrote', payload: { userId: dora.id, conversationId: 1, messageId: id, attempt: 0 } },
          { requestKey: `t-${++rk}`, source: { kind: 'route' } });
      }
      await rt.drain();
    } finally {
      gate();
      await first;
    }
    await settle();
    const answers = calls(dm.WORK.answer).filter((c) => c.input.userId === dora.id);
    assert.deepEqual(answers.map((c) => [c.key, c.input.also || []]),
      [['msg:401', []], ['msg:402', [401]], ['msg:403', [401, 402]]]);
    assert.equal((await inst('bot-dm', dmKey(dora))).state, 'idle', 'answered: nothing is asked again');
  });

  await t.test('D-sorry: an answer that fails for good gets one fixed line, and the next message is answered', async () => {
    reset();
    const carl = await user('carl');
    work.answer.set(dm.WORK.answer, (input) => { if (input.messageId === 301) throw new Error('boom'); return { sent: true }; });
    await wrote(carl, 301);
    await wrote(carl, 302);
    await settle();
    assert.deepEqual(calls(dm.WORK.sorry).map((c) => c.input.messageId), [301]);
    assert.deepEqual(calls(dm.WORK.answer).map((c) => c.input.messageId), [301, 301, 302]);
    assert.equal((await inst('bot-dm', dmKey(carl))).state, 'idle');
  });

  await t.test('D-tap: a tap is decided once in the person\'s DM, its act is work (bug 14)', async () => {
    reset();
    const opened = await require('../src/services/conversations').ensureAdmittedDirect(pool, bot.id, ada.id);
    const { rows: [action] } = await pool.query(
      `INSERT INTO homeroom_bot_dm_actions (user_id, conversation_id, app_id, kind, title) VALUES ($1, $2, $3, 'file_request', 'Tags') RETURNING id`,
      [ada.id, opened.conversationId, app.id]);
    const { rows: [plan] } = await pool.query(
      `INSERT INTO homeroom_bot_dm_actions (user_id, conversation_id, app_id, kind, title) VALUES ($1, $2, $3, 'build_plan', 'Plan') RETURNING id`,
      [ada.id, opened.conversationId, app.id]);
    const tap = (who, actionId, choice) => send('bot-dm', dmKey(who), 'Tapped', { userId: who.id, actionId, choice, answers: [] });
    assert.equal((await tap(ben, action.id, 'yes')).reason, 'no_such_choice', 'only theirs');
    assert.equal((await tap(ada, action.id, 'build')).reason, 'wrong_choice');
    assert.equal((await tap(ada, plan.id, 'yes')).reason, 'wrong_choice');
    const yes = await tap(ada, action.id, 'yes');
    assert.deepEqual([yes.result, yes.reply], ['accepted', { ok: true, choice: 'yes' }]);
    assert.equal((await tap(ada, action.id, 'no')).reason, 'already_decided');
    assert.equal((await tap(ada, plan.id, 'build')).result, 'accepted');
    assert.deepEqual(calls(dm.WORK.act).map((c) => [c.input.actionId, c.input.choice, c.key]),
      [[action.id, 'yes', `action:${action.id}`], [plan.id, 'build', `action:${plan.id}`]]);
    // An act that failed for good is settled as failed and said, by work.
    reset();
    const { rows: [third] } = await pool.query(
      `INSERT INTO homeroom_bot_dm_actions (user_id, conversation_id, app_id, kind, title) VALUES ($1, $2, $3, 'file_request', 'Pins') RETURNING id`,
      [ada.id, opened.conversationId, app.id]);
    work.answer.set(dm.WORK.act, (input) => { if (!input.gaveUp) throw new Error('down'); return { done: false, why: 'gave_up' }; });
    await tap(ada, third.id, 'yes');
    assert.deepEqual(calls(dm.WORK.act).map((c) => [c.key, !!c.input.gaveUp]),
      [[`action:${third.id}`, false], [`action:${third.id}`, false], [`action:${third.id}:failed`, true]]);
    // The route's answers.
    const out = await platform.tapDmAction({ userId: ada.id, actionId: action.id, choice: 'yes' }).catch((err) => err);
    assert.match(String(out.message || ''), /not running/, 'the route needs the runtime of its process');
  });

  await t.test('D-greet: a hello owed is said once per kind, by work (bug 18)', async () => {
    reset();
    const dee = await user('dee');
    const { rows: [other] } = await pool.query(
      `INSERT INTO apps (name, slug, created_by, status) VALUES ('Books', 'books', $1, 'running') RETURNING id`, [ada.id]);
    await platform.greet(pool, { userId: dee.id, kind: 'joiner', appId: app.id });
    await platform.greet(pool, { userId: dee.id, kind: 'joiner', appId: app.id });
    // A later join of another project owes its own (the first may have
    // greeted nobody: the bot was off, or did not build for them yet).
    await platform.greet(pool, { userId: dee.id, kind: 'joiner', appId: other.id });
    await platform.greet(pool, { userId: dee.id, kind: 'tour' });
    await settle();
    assert.deepEqual(calls(dm.WORK.hello).map((c) => [c.input.kind, c.key]),
      [['joiner', `hello:joiner:${app.id}`], ['joiner', `hello:joiner:${other.id}`], ['tour', 'hello:tour']],
      'each trigger owes its own; the send keeps one hello per person (sendDm\'s claim)');
  });

  await t.test('D-mail: a message that rang owes its email in its own transaction, sent once as work', async () => {
    reset();
    const eve = await user('eve');
    const mail = { kind: 'build_ready', appName: 'Shop', appSlug: 'shop', conversationId: 7, threadRootId: null };
    await platform.dmMailOwed(pool, { userId: eve.id, messageId: 501, mail });
    await platform.dmMailOwed(pool, { userId: eve.id, messageId: 501, mail });
    await platform.dmMailOwed(pool, { userId: eve.id, messageId: 502, mail });
    await settle();
    assert.deepEqual(calls(dm.WORK.mail).map((c) => [c.key, c.input.userId, c.input.messageId, c.input.kind]),
      [['mail:501', eve.id, 501, 'build_ready'], ['mail:502', eve.id, 502, 'build_ready']], 'one email per message that rang');
    const i = await inst(dm.MACHINE, dmKey(eve));
    assert.equal(i.state, 'idle');
    assert.deepEqual(i.data.notes, {}, 'nothing waits on an email: its result is not kept');
    const { rows: results } = await pool.query(
      `SELECT result FROM wf_events WHERE machine = $1 AND key = $2 AND type = 'WorkSucceeded'`, [dm.MACHINE, dmKey(eve)]);
    assert.deepEqual(results.map((r) => r.result), ['accepted', 'accepted']);
    // Owed by the message's own transaction: a send that fails after the
    // insert owes nothing.
    const conversations = require('../src/services/conversations');
    const opened = await conversations.ensureAdmittedDirect(pool, bot.id, eve.id);
    await assert.rejects(conversations.sendMessage(pool, { id: bot.id }, opened.conversationId, { content: 'ready' }, {
      afterInsert: async (db, m) => { await platform.dmMailOwed(db, { userId: eve.id, messageId: m.messageId, mail }); throw new Error('cut'); },
    }));
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM wf_events WHERE type = 'MailOwed' AND key = $1`, [dmKey(eve)])).rows[0].n, 3);
  });

  await t.test('D-heard: a DM to the bot is heard in its own transaction; a DM between people is not', async () => {
    reset();
    const conversations = require('../src/services/conversations');
    const { heardInDm } = require('../src/services/homeroom-bot-dm');
    const opened = await conversations.ensureAdmittedDirect(pool, bot.id, ben.id);
    const sent = await conversations.sendMessage(pool, { ...ben, hasPlatformAccess: true }, opened.conversationId, { content: 'hi bot' }, {
      afterInsert: (db, m) => heardInDm(db, { user: ben, conversationId: opened.conversationId, messageId: m.messageId, membership: m.membership, memberIds: m.memberIds }),
    });
    const { rows: [e] } = await pool.query(`SELECT machine, key, payload FROM wf_events WHERE request_key = $1`, [`wrote:${sent.messageId}`]);
    assert.deepEqual([e.machine, e.key, e.payload.messageId], ['bot-dm', dmKey(ben), sent.messageId]);
    // A failure after the insert takes both back: never a message owed
    // nothing, nor an answer owed for no message.
    await assert.rejects(conversations.sendMessage(pool, { ...ben, hasPlatformAccess: true }, opened.conversationId, { content: 'and again' }, {
      afterInsert: async (db, m) => { await heardInDm(db, { user: ben, conversationId: opened.conversationId, messageId: m.messageId, membership: m.membership, memberIds: m.memberIds }); throw new Error('cut'); },
    }));
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM conversation_messages WHERE content = 'and again'`)).rows[0].n, 0);
    const friends = await conversations.ensureAdmittedDirect(pool, ada.id, ben.id);
    const between = await conversations.sendMessage(pool, { ...ben, hasPlatformAccess: true }, friends?.conversationId, { content: 'hi ada' }, {
      afterInsert: (db, m) => heardInDm(db, { user: ben, conversationId: friends.conversationId, messageId: m.messageId, membership: m.membership, memberIds: m.memberIds }),
    }).catch(() => null);
    if (between?.messageId) {
      assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM wf_events WHERE request_key = $1`, [`wrote:${between.messageId}`])).rows[0].n, 0);
    }
  });
});
