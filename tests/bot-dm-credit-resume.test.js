'use strict';

// 19 Nov 2026 (T1.3's follow-up): a chat message whose answer ended on
// OpenRouter's credit is answered once, by itself, when credit is back.
//
// The chat's turn said "I'm out of building credit" and was asked again on
// the DM's own clock (1, 3 and 10 minutes), and its last try said to ask
// again. An outage longer than that left the message unanswered for good:
// the bot-dm machine ignores a message it has answered already. Now:
//
//   - the answer's work reports `credit` (homeroom-bot-mayor.js onCredit,
//     homeroom-bot-dm.js answerOwed), and bot-dm keeps the message;
//   - the credit sweep's return of credit reaches the bot's lane
//     (CreditBack), which messages every DM keeping one;
//   - each kept message is answered once, as a later try is, under keys of
//     that round's own, and any other end of its answer drops it;
//   - the last try's line says it will be answered once credit is back.
//
// Pinned without a database.
//
// Run with: node --test tests/bot-dm-credit-resume.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const dmMachine = require('../src/workflow/bot-dm/machine.ts');
const laneMachine = require('../src/workflow/bot-lane/machine.ts');
const laneFacts = require('../src/workflow/bot-lane/facts.ts');
const rules = require('../src/workflow/rules/bot-loop.ts');
const replies = require('../src/workflow/rules/bot-replies.ts');
const { NONE } = require('../src/workflow/kernel/index.ts');

const USER = 9;
const CONV = 45;
const KEY = dmMachine.dmKey(USER);
const T0 = Date.parse('2026-11-19T10:00:00Z');
const at = (min) => new Date(T0 + min * 60 * 1000);

// ── The bot-dm machine, event by event, as the kernel applies them ──────

const machine = dmMachine.botDm();
const ROUTE = { kind: 'route', name: 'dm' };
const TIMER = { kind: 'timer' };
const LANE = { kind: 'message', from: { machine: rules.BOT_LANE, key: rules.LANE_KEY, eventId: 1 } };
let seq = 0;

// The kernel's order: who may send it, the state's entry, its guard, its move.
function deliver(state, type, payload, min, source) {
  const decode = machine.events.get(type);
  seq += 1;
  const e = { id: seq, type, payload: decode ? decode(payload) : payload, source, actor: null, requestKey: `k${seq}`, appId: null, causedBy: null };
  const allowed = machine.check(e, {}, state);
  if (allowed !== true) return { refused: allowed.reject, state };
  const entry = machine.entryFor(state.name, type);
  if (entry.ignore) return { ignored: entry.ignore, state };
  const ctx = { machine: dmMachine.MACHINE, key: KEY, appId: null, version: 2, now: at(min) };
  if (entry.guard) {
    const g = entry.guard(state, e, {}, ctx);
    if (g !== true) return { refused: g.reject, state };
  }
  const out = entry.to(state, e, {}, ctx);
  return { ...out, state: out.next };
}

const START = { name: NONE, data: null };
const wrote = (state, messageId, min = 0) =>
  deliver(state, 'Wrote', { userId: USER, messageId, conversationId: CONV }, min, ROUTE);
const answers = (out) => (out.work || []).filter((w) => w.kind === dmMachine.WORK.answer);
// The answer `out` asked for ends with `result` (WorkSucceeded unless said).
function ended(out, result, min = 0, type = 'WorkSucceeded') {
  const [w] = answers(out);
  assert.ok(w, 'an answer was asked for');
  const workId = `w${seq + 1}`;
  return deliver(out.state, type, {
    workId, kind: w.kind, workKey: w.key, attempt: 1, ...(type === 'WorkSucceeded' ? { result } : { error: { message: 'x' } }),
  }, min, { kind: 'service', workId });
}
const tryAgain = (out, min) => deliver(out.state, 'TryAgain', {}, min, TIMER);
const creditBack = (state, min = 0, source = LANE, userId = USER) => deliver(state, 'CreditBack', { userId }, min, source);
const kept = (out) => (out.state.data.credit || []).map((o) => [o.messageId, o.also || []]);
const owedBack = (out) => (out.state.data.resume || []).map((o) => [o.messageId, o.resume]);
const CREDIT_LATER = (n) => ({ sent: n === 1, later: n, skipped: null, credit: true });
const ANSWERED = { sent: true, later: null, skipped: null };

// Message 501 through its first try and all three later ones, every one out
// of credit: its last try says the credit line and leaves it kept.
function outOfCreditThroughItsTries() {
  const a = wrote(START, 501);
  const b = ended(a, CREDIT_LATER(1));
  const c = tryAgain(b, 1);
  const d = ended(c, CREDIT_LATER(2), 1);
  const e = tryAgain(d, 4);
  const f = ended(e, CREDIT_LATER(3), 4);
  const g = tryAgain(f, 14);
  return { b, c, d, f, g, last: ended(g, { sent: true, later: null, skipped: null, credit: true }, 14) };
}

test('a message whose answer ended on credit is kept, through its later tries and its last line', () => {
  assert.equal(machine.version, 2, 'its data has the credit record: an older release leaves what this one wrote alone');
  const a = wrote(START, 501);
  assert.equal(a.state.name, 'answering');
  assert.deepEqual(answers(a).map((w) => w.key), ['msg:501']);
  const b = ended(a, CREDIT_LATER(1));
  assert.equal(b.state.name, 'trying_later', 'the DM\'s own clock still asks it again');
  assert.equal(b.timer.event.type, 'TryAgain');
  assert.equal(b.timer.at.toISOString(), at(1).toISOString());
  assert.deepEqual(b.state.data.credit, [{ messageId: 501, conversationId: CONV, attempt: 0 }], 'kept on its first credit line');
  const { c, d, g, last } = outOfCreditThroughItsTries();
  assert.deepEqual(answers(c).map((w) => w.key), ['msg:501:d1']);
  assert.deepEqual(kept(d), [[501, []]], 'once, however many tries meet it');
  assert.deepEqual(answers(g).map((w) => w.key), ['msg:501:d3']);
  assert.equal(last.state.name, 'idle', 'nothing more on the clock');
  assert.equal(last.timer, null);
  assert.deepEqual(kept(last), [[501, []]], 'its last line promised the answer once credit is back');
  // An answer that did not end on credit keeps nothing.
  const plain = ended(wrote(START, 502), ANSWERED);
  assert.deepEqual(plain.state.data.credit || [], []);
});

test('credit\'s return answers each kept message once, on the answer\'s own path; a second return does nothing', () => {
  const { last } = outOfCreditThroughItsTries();
  // Only the lane (or the system) says credit is back, and only for this DM.
  assert.equal(creditBack(last.state, 30, ROUTE).refused, 'not_the_lane');
  assert.equal(creditBack(last.state, 30, LANE, 12).refused, 'key_mismatch');
  assert.equal(creditBack(START, 30).ignored, 'nothing_owed', 'an instance that kept nothing owes nothing');
  const back = creditBack(last.state, 30);
  assert.equal(back.state.name, 'answering');
  const [w] = answers(back);
  assert.equal(w.key, 'msg:501:r1', 'a round of its own: its work and its reply have keys of their own');
  assert.deepEqual(w.input, { userId: USER, conversationId: CONV, messageId: 501, attempt: 0, key: 'msg:501:r1', resume: 1 });
  assert.deepEqual(kept(back), [], 'taken off the record as it is answered');
  assert.equal(back.state.data.rounds, 1);
  const done = ended(back, ANSWERED, 30);
  assert.equal(done.state.name, 'idle');
  assert.deepEqual([kept(done), owedBack(done)], [[], []]);
  // The sweep finds credit back again (a second outage that never touched
  // this DM, or the same return told twice): nothing is answered again.
  const again = creditBack(done.state, 45);
  assert.equal(again.state.name, 'idle');
  assert.deepEqual(again.work || [], []);
  assert.equal(again.state.data.rounds, 1, 'no round for nothing');
});

test('a message answered in between is not answered again when credit comes back', () => {
  // Its next try on the clock got through (credit came back within minutes).
  const { b } = outOfCreditThroughItsTries();
  const answeredLater = ended(tryAgain(b, 1), ANSWERED, 1);
  assert.equal(answeredLater.state.name, 'idle');
  assert.deepEqual(kept(answeredLater), [], 'answered: dropped from the record');
  assert.deepEqual(creditBack(answeredLater.state, 30).work || [], []);
  // A newer message's answer owed it too (it was written while 501 waited on
  // its clock), and was given: 501 rode on it, so it is not answered again.
  const newer = wrote(b.state, 502, 0.5);
  assert.deepEqual(answers(newer).map((w) => [w.key, w.input.also]), [['msg:502', [501]]]);
  const both = ended(newer, ANSWERED, 0.5);
  assert.deepEqual(kept(both), []);
  assert.deepEqual(creditBack(both.state, 30).work || [], []);
  // That newer answer ran out of credit too: one kept message, owing both.
  const bothOut = ended(newer, CREDIT_LATER(1), 0.5);
  assert.deepEqual(kept(bothOut), [[502, [501]]], '501 rides on 502, never answered on its own as well');
  const through = ended(tryAgain(bothOut, 2), ANSWERED, 2);
  assert.deepEqual(answers(tryAgain(bothOut, 2)).map((w) => w.input.also), [[501]]);
  assert.deepEqual(kept(through), [], '502 and 501 answered by its later try: nothing left');
  const back = creditBack(bothOut.state, 30);
  assert.deepEqual(answers(back).map((w) => [w.key, w.input.also]), [['msg:502:r1', [501]]]);
});

test('credit back while a kept try waits on its clock answers it now; while another answer runs, after it and what waits', () => {
  const { b } = outOfCreditThroughItsTries();
  const now = creditBack(b.state, 0.5);
  assert.equal(now.state.name, 'answering', 'no wait on the clock once credit is back');
  assert.equal(now.timer, null, 'its TryAgain is called off');
  assert.deepEqual(answers(now).map((w) => w.key), ['msg:501:r1']);
  // A try of another message waiting on its clock (a busy provider) goes first.
  const { last } = outOfCreditThroughItsTries();
  const busy = ended(wrote(last.state, 510, 20), { sent: true, later: 1, skipped: null }, 20);
  assert.equal(busy.state.name, 'trying_later');
  const meanwhile = creditBack(busy.state, 20.5);
  assert.equal(meanwhile.state.name, 'trying_later');
  assert.equal(meanwhile.timer, undefined, 'its clock is left as it was');
  assert.deepEqual(owedBack(meanwhile), [[501, 1]]);
  const its = ended(tryAgain(meanwhile, 21), ANSWERED, 21);
  assert.deepEqual(answers(its).map((w) => w.key), ['msg:501:r1'], 'then the kept one');
  // An answer under way, and a message written meanwhile, go first.
  const running = wrote(last.state, 520, 20);
  const told = creditBack(running.state, 20.2);
  assert.equal(told.state.name, 'answering');
  assert.deepEqual(told.work || [], [], 'nothing beside the answer under way');
  assert.deepEqual(answers(ended({ ...running, state: told.state }, ANSWERED, 20.4)).map((w) => w.key), ['msg:501:r1'],
    'once it ends, the kept one');
  const queued = wrote(told.state, 521, 20.3);
  const afterRunning = ended({ ...running, state: queued.state }, ANSWERED, 20.4);
  assert.deepEqual(answers(afterRunning).map((w) => w.key), ['msg:521'], 'a message written meanwhile first');
  assert.deepEqual(answers(ended(afterRunning, ANSWERED, 20.5)).map((w) => w.key), ['msg:501:r1'], 'then the kept one');
});

test('credit back while the kept message\'s own try runs: never answered twice, and never left waiting', () => {
  const { b } = outOfCreditThroughItsTries();
  const trying = tryAgain(b, 1);
  const told = creditBack(trying.state, 1.2);
  assert.deepEqual(owedBack(told), [[501, 1]], 'its resume is owed');
  // The try that was under way met the 402 before credit came back: no wait
  // on the clock, its resume answers it now.
  const raced = ended(trying, CREDIT_LATER(2), 1.3);
  const racedTold = ended({ ...trying, state: told.state }, CREDIT_LATER(2), 1.3);
  assert.equal(raced.state.name, 'trying_later', 'without the return, the clock as before');
  assert.equal(racedTold.state.name, 'answering');
  assert.deepEqual(answers(racedTold).map((w) => w.key), ['msg:501:r1']);
  // The try got through instead: the resume is dropped, never a second answer.
  const through = ended({ ...trying, state: told.state }, ANSWERED, 1.3);
  assert.equal(through.state.name, 'idle');
  assert.deepEqual([kept(through), owedBack(through), answers(through)], [[], [], []]);
});

test('a resume that meets the 402 again says nothing and is kept for the next return, in a round of its own', () => {
  const { last } = outOfCreditThroughItsTries();
  const back = creditBack(last.state, 30);
  const again = ended(back, { sent: false, later: null, skipped: null, credit: true }, 30);
  assert.equal(again.state.name, 'idle', 'nothing on the clock for it');
  assert.deepEqual(kept(again), [[501, []]]);
  const second = creditBack(again.state, 60);
  assert.deepEqual(answers(second).map((w) => w.key), ['msg:501:r2'], 'a fresh round: its keys are new');
  // A resume a busy provider could not answer goes on its own clock.
  const busy = ended(back, { sent: false, later: 1, skipped: null }, 30);
  assert.equal(busy.state.name, 'trying_later');
  assert.deepEqual(answers(tryAgain(busy, 31)).map((w) => w.key), ['msg:501:r1:d1']);
  assert.deepEqual(kept(busy), [], 'no longer about credit');
});

test('a stopped or failed resume is dropped, and says so under its round\'s key', () => {
  const { last } = outOfCreditThroughItsTries();
  const back = creditBack(last.state, 30);
  const stop = deliver(back.state, 'StopRequested',
    { userId: USER, conversationId: CONV, messageId: 501, at: at(30).toISOString() }, 30, ROUTE);
  assert.equal(stop.state.data.current.stop, true);
  const stopped = ended({ ...back, state: stop.state }, { sent: true, later: null, skipped: null, stopped: true, credit: true }, 30);
  assert.deepEqual([stopped.state.name, kept(stopped), owedBack(stopped)], ['idle', [], []], 'stopped: never answered after all');
  const failed = ended(back, null, 30, 'WorkExhausted');
  const sorry = (failed.work || []).filter((w) => w.kind === dmMachine.WORK.sorry);
  assert.deepEqual(sorry.map((w) => [w.key, w.input.resume, w.input.attempt]), [['sorry:501:r1', 1, 0]]);
  assert.deepEqual(kept(failed), []);
  // A Stop of a kept try waiting on its clock drops it from the record too.
  const { b } = outOfCreditThroughItsTries();
  const waiting = deliver(b.state, 'StopRequested',
    { userId: USER, conversationId: CONV, messageId: 501, at: at(0.5).toISOString() }, 0.5, ROUTE);
  assert.deepEqual((waiting.work || []).map((w) => w.key), ['stopped:501:d1']);
  assert.deepEqual(kept(waiting), []);
});

// ── The lane tells them ─────────────────────────────────────────────────

test('credit\'s return reaches every DM that kept a message, in the lane\'s own event', async () => {
  const m = laneMachine.botLane({ staging: false });
  const now = new Date('2026-11-19T11:00:00Z');
  const data = {
    grants: 0, fault: null, budget: null, credit: { since: '2026-11-19T09:00:00.000Z', words: null },
    refresh: { due: '2026-11-19T12:00:00.000Z', asked: [], soon: null, n: 1, running: null },
  };
  const ctx = { machine: laneMachine.MACHINE, key: laneMachine.KEY, appId: null, version: 1, now };
  const e = { id: 1, type: 'CreditBack', payload: {}, source: { kind: 'system', name: 'credit' } };
  const facts = (creditDms) => ({ ...laneMachine.NO_FACTS, ...(creditDms ? { creditDms } : {}) });
  const out = m.entryFor('open', 'CreditBack').to({ name: 'open', data }, e, facts([{ key: 'person:9', userId: 9 }, { key: 'person:12', userId: 12 }]), ctx);
  assert.equal(out.next.data.credit, null, 'the pause lifts');
  const told = (out.messages || []).filter((msg) => msg.to.machine === replies.DM);
  assert.deepEqual(told.map((msg) => [msg.to.key, msg.event.type, msg.event.payload, msg.appId]),
    [['person:9', 'CreditBack', { userId: 9 }, null], ['person:12', 'CreditBack', { userId: 12 }, null]]);
  const none = m.entryFor('open', 'CreditBack').to({ name: 'open', data }, e, facts(null), ctx);
  assert.deepEqual((none.messages || []).filter((msg) => msg.to.machine === replies.DM), []);
  // Who to tell is read for CreditBack only, whether the bot is on or not.
  const queries = [];
  const tx = {
    async query(text, params) {
      queries.push([String(text), params]);
      if (text === laneFacts.CREDIT_OWED_DMS_SQL) return { rows: [{ key: 'person:9', user_id: '9' }, { key: 'person:x', user_id: null }, { key: 'person:y', user_id: 'y' }] };
      return { rows: [] };
    },
  };
  const read = await m.facts(tx, { name: 'open', data }, { type: 'CreditBack' }, ctx);
  assert.deepEqual(read.creditDms, [{ key: 'person:9', userId: 9 }]);
  assert.deepEqual(queries.find(([q]) => q === laneFacts.CREDIT_OWED_DMS_SQL)[1], [replies.DM]);
  // Review A5: and for any pass that finds the stored outage gone while the
  // lane still holds its pause (the wake-up was lost): that pass lifts it,
  // so it reads who to tell too.
  queries.length = 0;
  const lifting = await m.facts(tx, { name: 'open', data }, { type: 'Look' }, ctx);
  assert.equal(lifting.credit, null, 'no outage is stored');
  assert.deepEqual(lifting.creditDms, [{ key: 'person:9', userId: 9 }]);
  // An ordinary pass (no pause held, or the outage still standing) does not.
  queries.length = 0;
  const look = await m.facts(tx, { name: 'open', data: { ...data, credit: null } }, { type: 'Look' }, ctx);
  assert.equal(look.creditDms, undefined);
  assert.equal(queries.some(([q]) => q === laneFacts.CREDIT_OWED_DMS_SQL), false);
  const standing = {
    async query(text, params) {
      queries.push([String(text), params]);
      if (/FROM platform_settings/.test(text)) {
        return { rows: [{ key: laneFacts.CREDIT_STATE_KEY, value: JSON.stringify({ outage: { since: '2026-11-19T09:00:00.000Z', words: 'Insufficient credits' } }) }] };
      }
      return { rows: [] };
    },
  };
  queries.length = 0;
  const still = await m.facts(standing, { name: 'open', data }, { type: 'Look' }, ctx);
  assert.deepEqual(still.credit, { since: '2026-11-19T09:00:00.000Z', words: 'Insufficient credits' });
  assert.equal(still.creditDms, undefined);
  assert.equal(queries.some(([q]) => q === laneFacts.CREDIT_OWED_DMS_SQL), false);
  assert.match(laneFacts.CREDIT_OWED_DMS_SQL, /WHERE machine = \$1 AND jsonb_typeof\(data->'credit'\) = 'array' AND data->'credit' <> '\[\]'::jsonb/);
  // And the DM takes the lane's message.
  const { last } = outOfCreditThroughItsTries();
  const fromLane = { kind: 'message', from: { machine: laneMachine.MACHINE, key: laneMachine.KEY, eventId: 7 } };
  assert.deepEqual(answers(creditBack(last.state, 30, fromLane)).map((w) => w.key), ['msg:501:r1']);
});

// ── The chat's turn ─────────────────────────────────────────────────────

const mayor = require('../src/services/homeroom-bot-mayor');
const dm = require('../src/services/homeroom-bot-dm');

const BOT = { id: 2, username: 'homeroom_bot' };
const EVAN = { id: USER, username: 'evan', hasPlatformAccess: true };
const MESSAGE = { id: 80, content: 'What is on my plate today?' };

const fail = (code, status) => async () => { throw Object.assign(new Error(`HTTP ${status}`), { code, status }); };
// Review A1: the chat's model request through the REAL client
// (services/openrouter.js streamChat, what runDmTurn calls in production),
// its fetch answered as OpenRouter answers. These tests built the failure by
// hand with the code the fix expected (`fail('credit_out', 402)`), which the
// real client never produced: it said `billing`, so none of this ran.
const openrouter = require('../src/services/openrouter');
const OUT_OF_CREDIT = JSON.stringify({
  error: {
    message: 'This request would exceed your available credits given your current in-flight requests. '
      + 'Retry after in-flight requests settle, or add credits.',
    code: 402,
  },
});
const throughTransport = (status, body, seen = []) => (args) => openrouter.streamChat({
  ...args,
  baseUrl: 'https://openrouter.test/api/v1',
  fetchImpl: async (url) => {
    seen.push(String(url));
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  },
});
const replyWith = (text) => async () => ({
  content: '', toolCalls: [{ id: 'c1', function: { name: 'reply', arguments: JSON.stringify({ text }) } }],
});

// One DM turn (runDmTurn), its model scripted, everything it sends kept.
async function chatTurn(chat, deps = {}) {
  const sent = [];
  const told = { later: [], credit: 0, outage: 0 };
  const { pool = { async query() { return { rows: [] }; } }, ...rest } = deps;
  deps = rest;
  await mayor.runDmTurn(pool, { selfAppSlug: 'homeroom' }, {
    bot: BOT, user: EVAN, settings: { mode: 'live', perPerson: 2 }, conversationId: CONV, message: MESSAGE,
    deps: {
      chat, apiKey: 'sk-test', openMcp: async () => null, seesImages: false, sleep: async () => {}, streamDraft: false,
      dmSvc: { ...dm, async sendDm(_pool, args) { sent.push(args); return { messageId: 900 + sent.length, conversationId: CONV }; } },
      doing: async () => {},
      credit: { noteOutage: async () => { told.outage += 1; } },
      onLater: (n) => { told.later.push(n); },
      onCredit: () => { told.credit += 1; },
      ...deps,
    },
  });
  return { said: sent.map((s) => [s.idempotencyKey, s.content]), told };
}

test('the chat\'s turn tells its DM it ended on credit: its first line, its silent tries, its last line', async () => {
  // Through the real client, answered with OpenRouter's own 402 body.
  const requests = [];
  const out = throughTransport(402, OUT_OF_CREDIT, requests);
  assert.deepEqual(await chatTurn(out), {
    said: [['hrbot-mayor-80', mayor.CREDIT_TEXT]], told: { later: [1], credit: 1, outage: 1 },
  });
  assert.deepEqual(await chatTurn(out, { deferAttempt: 2 }), { said: [], told: { later: [3], credit: 1, outage: 1 } });
  assert.deepEqual(await chatTurn(out, { deferAttempt: 3 }), {
    said: [['hrbot-mayor-80-d3', mayor.CREDIT_GAVE_UP_TEXT]], told: { later: [], credit: 1, outage: 1 },
  });
});

test('A1, end to end: OpenRouter\'s real 402 through the real client is an outage the chat says, records and resumes from', async () => {
  // 1. The client: one request, refused, read as out of credit.
  const requests = [];
  const chat = throughTransport(402, OUT_OF_CREDIT, requests);
  await assert.rejects(chat({ apiKey: 'sk-test', model: mayor.DEFAULT_MODEL, reasoning: 'low', messages: [{ role: 'user', content: 'hi' }], tools: [] }),
    (err) => err.code === 'credit_out' && err.status === 402);
  // 2. The chat: its credit line (never the key's "an admin needs to fix
  //    that"), the outage recorded once in the one stored state, its DM told.
  const credit = require('../src/services/openrouter-credit');
  const writes = [];
  const settings = new Map();
  const pool = {
    async query(text, params) {
      const sql = String(text);
      if (/INSERT INTO platform_settings/.test(sql)) { settings.set(params[0], params[1]); writes.push(params[0]); return { rows: [] }; }
      if (/FROM platform_settings/.test(sql)) {
        const keys = Array.isArray(params[0]) ? params[0] : [params[0]];
        return { rows: keys.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k) })) };
      }
      if (/INSERT INTO events/.test(sql)) { writes.push('incident'); return { rows: [{ id: 1 }] }; }
      return { rows: [] };
    },
  };
  requests.length = 0;
  const first = await chatTurn(chat, { pool, credit: { ...credit, noteOutage: (p, what) => credit.noteOutage(p, what, { staging: true }) } });
  assert.deepEqual(first.said, [['hrbot-mayor-80', mayor.CREDIT_TEXT]]);
  assert.doesNotMatch(first.said[0][1], /access to it isn't working|admin needs to fix/);
  assert.deepEqual(first.told, { later: [1], credit: 1, outage: 0 }, 'the real noteOutage ran, not the stub');
  assert.equal(requests.length, 1, 'no plain answer is tried against the same 402');
  const stored = JSON.parse(settings.get(credit.KEY_STATE));
  assert.ok(stored.outage?.since, 'the outage is in the one stored state');
  assert.deepEqual(writes.filter((w) => w === 'incident').length, 1, 'one incident for the outage');
  assert.deepEqual(await credit.creditState(pool), { out: true, since: stored.outage.since, words: stored.outage.words });
  // 3. While that outage stands, the next message asks the stored state
  //    first and sends no request at all (review B1).
  requests.length = 0;
  const second = await chatTurn(chat, { pool, credit: { ...credit, noteOutage: (p, what) => credit.noteOutage(p, what, { staging: true }) } });
  assert.deepEqual(second.said, [['hrbot-mayor-80', mayor.CREDIT_TEXT]]);
  assert.equal(requests.length, 0, 'the model is not called to meet the 402 again');
  assert.equal(writes.filter((w) => w === 'incident').length, 1, 'still one incident');
  // 4. The DM machine: what the turn reported (credit) keeps the message
  //    through its tries, and credit's return answers it exactly once.
  assert.equal(first.told.credit, 1);
  const { last } = outOfCreditThroughItsTries();
  assert.deepEqual(kept(last), [[501, []]], 'held');
  const back = creditBack(last.state, 30);
  assert.deepEqual(answers(back).map((w) => w.key), ['msg:501:r1'], 'answered once');
  assert.deepEqual(answers(creditBack(back.state, 31)), [], 'a second return answers nothing');
});

test('a 402 that only asks for a shorter reply is not an outage for the chat', async () => {
  const shorter = JSON.stringify({ error: { message: 'This request requires more credits, or fewer max_tokens. You requested up to 4000 tokens, but can only afford 900.', code: 402 } });
  const out = await chatTurn(throughTransport(402, shorter));
  assert.equal(out.told.credit, 0);
  assert.equal(out.told.outage, 0, 'no outage is recorded and no admin is told');
  assert.notEqual(out.said[0]?.[1], mayor.CREDIT_TEXT);
});

test('the answer owed once credit came back is the turn again under its round\'s key, and says nothing when it meets the 402 again', async () => {
  assert.deepEqual(await chatTurn(replyWith('Nothing waits on you today.'), { resume: 1 }), {
    said: [['hrbot-mayor-80-r1', 'Nothing waits on you today.']], told: { later: [], credit: 0, outage: 0 },
  });
  assert.deepEqual(await chatTurn(throughTransport(402, OUT_OF_CREDIT), { resume: 1 }), {
    said: [], told: { later: [], credit: 1, outage: 1 },
  }, 'kept for the next return, with no word and nothing on the clock');
  // A busy provider is asked again on the round's own clock, quietly, and
  // the round's last try says it could not.
  const busy = fail('provider_unavailable', 503);
  assert.deepEqual(await chatTurn(busy, { resume: 2 }), { said: [], told: { later: [1], credit: 0, outage: 0 } });
  assert.deepEqual((await chatTurn(busy, { resume: 2, deferAttempt: 3 })).said,
    [['hrbot-mayor-80-r2-d3', mayor.DEFERRED_GAVE_UP_TEXT]]);
});

test('the last try\'s line says the message is answered once credit is back, in the first person, with no em dash', () => {
  assert.equal(mayor.CREDIT_GAVE_UP_TEXT,
    'I\'m still out of building credit, so I couldn\'t answer your message above yet. I\'ll answer it here once credit is back.');
  assert.equal(mayor.CREDIT_GAVE_UP_OWED_TEXT,
    'I\'m still out of building credit, so I couldn\'t answer your message above, or the ones you sent before it that '
      + 'I said I\'d come back to. I\'ll answer them all here once credit is back.');
  for (const text of [mayor.CREDIT_TEXT, mayor.CREDIT_GAVE_UP_TEXT, mayor.CREDIT_GAVE_UP_OWED_TEXT]) {
    assert.doesNotMatch(text, /—|–/, 'no em dash');
    assert.doesNotMatch(text, /Homeroom bot|\bit will\b|\bthe bot\b/i, 'the first person');
    assert.doesNotMatch(text, /[Aa]sk me again/, 'nothing asks them to send it again');
  }
  // While it waits for credit, the honest line it always said.
  assert.equal(mayor.CREDIT_TEXT, 'I\'m out of building credit right now, so I couldn\'t answer yet. I\'ll try again here in '
    + 'a few minutes, and an admin has been told; you don\'t need to send it again.');
  assert.deepEqual([mayor.answerKey(80), mayor.answerKey(80, 2), mayor.answerKey(80, 0, 1), mayor.answerKey(80, 3, 2)],
    ['hrbot-mayor-80', 'hrbot-mayor-80-d2', 'hrbot-mayor-80-r1', 'hrbot-mayor-80-r2-d3']);
  // #6920: the voice and look_into hold their asks too, as the chat does.
  const read = (p) => require('node:fs').readFileSync(require.resolve(p), 'utf8');
  const voiceFile = read('../src/services/homeroom-bot-voice.js');
  assert.match(voiceFile, /HELD_TEXT = 'OpenRouter/);
  assert.doesNotMatch(voiceFile, /CREDIT_TEXT/);
  const lookFile = read('../src/services/homeroom-bot-thread-tools/look-into.js');
  assert.match(lookFile, /LOOK_HELD_TEXT/);
  assert.doesNotMatch(lookFile, /Ask me again once it\\'s back\./);
});

// ── The DM's answer and its work ────────────────────────────────────────

test('answerOwed asks the resumed answer as a later try and reports credit; one said already still owes the answer', async () => {
  const conversations = require('../src/services/conversations');
  const realGet = conversations.getMessage;
  const queries = [];
  const pool = (said, fallback) => ({
    async query(text, params) {
      queries.push([String(text), params]);
      if (/FROM conversation_messages/.test(text) && /idempotency_key ~/.test(text)) return { rows: said ? [{ '?column?': 1 }] : [] };
      if (/FROM homeroom_bot_dm_turns/.test(text)) return { rows: fallback ? [{ fallback }] : [] };
      if (/FROM users/.test(text)) {
        return { rows: [{ id: USER, username: 'evan', is_synthetic: false, has_platform_access: true, is_admin: false, private_member_since: null }] };
      }
      return { rows: [] };
    },
  });
  conversations.getMessage = async () => ({ id: 80, content: MESSAGE.content });
  try {
    let asked = null;
    const fake = {
      async answerLater(_pool, _config, args, attempt) { asked = { attempt, resume: args.deps.resume }; args.deps.onCredit(); return null; },
    };
    const out = await dm.answerOwed(pool(false), {}, {
      userId: USER, conversationId: CONV, messageId: 80, attempt: 0, resume: 1, workKey: 'msg:80:r1', deps: { bot: BOT, mayor: fake },
    });
    assert.deepEqual(asked, { attempt: 0, resume: 1 }, 'the model\'s turn again, as a later try is');
    assert.deepEqual(out, { sent: false, later: null, credit: true });
    assert.deepEqual(queries.find(([q]) => /idempotency_key ~/.test(q))[1][2], '^hrbot-mayor-80-r1$', 'found by its round\'s own key');
    // Said already (a restart cut the work short after its line went out):
    // the credit line still owes its later try and the answer once credit is back.
    assert.deepEqual(await dm.answerOwed(pool(true, 'credit'), {}, { userId: USER, conversationId: CONV, messageId: 80, deps: { bot: BOT } }),
      { sent: true, skipped: 'answered', later: 1, credit: true });
    assert.deepEqual(await dm.answerOwed(pool(true, 'credit'), {}, { userId: USER, conversationId: CONV, messageId: 80, attempt: 3, deps: { bot: BOT } }),
      { sent: true, skipped: 'answered', later: null, credit: true }, 'its last line');
    assert.deepEqual(await dm.answerOwed(pool(true, null), {}, { userId: USER, conversationId: CONV, messageId: 80, deps: { bot: BOT } }),
      { sent: true, skipped: 'answered', later: null }, 'an answer owes nothing');
  } finally {
    conversations.getMessage = realGet;
  }
});

test('the answer\'s work passes its round on and hands credit back to the machine', async () => {
  const { botDmServices } = require('../src/workflow/bot-dm/services.ts');
  const realOwed = dm.answerOwed;
  const realSorry = dm.sayCouldNotAnswer;
  const realStopped = dm.sayStopped;
  const seen = {};
  dm.answerOwed = async (_pool, _config, args) => { seen.answer = args; return { sent: false, later: null, credit: true }; };
  dm.sayCouldNotAnswer = async (_pool, args) => { seen.sorry = args; return null; };
  dm.sayStopped = async (_pool, args) => { seen.stopped = args; return null; };
  try {
    const services = botDmServices({ config: {}, pool: { async query() { return { rows: [] }; } } });
    const input = { userId: USER, conversationId: CONV, messageId: 80, attempt: 0, key: 'msg:80:r1', resume: 1 };
    const out = await services[dmMachine.WORK.answer].run({ input, key: 'msg:80:r1', resumeFrom: null, checkpoint: async () => {}, attempt: 1 });
    assert.deepEqual(out, { sent: false, later: null, skipped: null, credit: true });
    assert.equal(seen.answer.resume, 1);
    await services[dmMachine.WORK.sorry].run({ input: { ...input, key: undefined } });
    assert.equal(seen.sorry.resume, 1, 'its line goes under the round\'s key');
    await services[dmMachine.WORK.stopped].run({ input: { ...input, key: undefined } });
    assert.equal(seen.stopped.resume, 1);
  } finally {
    dm.answerOwed = realOwed;
    dm.sayCouldNotAnswer = realSorry;
    dm.sayStopped = realStopped;
  }
});
