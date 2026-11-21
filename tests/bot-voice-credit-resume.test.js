'use strict';

// #6920 (20 Nov 2026): a thread answer, and a look, that met OpenRouter's
// credit waits and comes back by itself when credit does, as the chat's
// does. Part 2 of request 6914.
//
//   - the voice's turn reports `held` (with the messages and people it was
//     for) instead of sending "ask me again"; the bot-voice machine keeps
//     them in `credit`;
//   - the lane tells every place that kept one (CreditBack), and each is
//     answered once, oldest first;
//   - a look whose turn met credit waits in bot-look `held` and runs once
//     under `run:r<n>`, unless a newer look replaced it.
//
// Run with: node --test tests/bot-voice-credit-resume.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const voiceMachine = require('../src/workflow/bot-voice/machine.ts');
const lookMachine = require('../src/workflow/bot-look/machine.ts');
const laneMachine = require('../src/workflow/bot-lane/machine.ts');
const laneFacts = require('../src/workflow/bot-lane/facts.ts');
const rules = require('../src/workflow/rules/bot-loop.ts');
const replies = require('../src/workflow/rules/bot-replies.ts');
const { NONE } = require('../src/workflow/kernel/index.ts');

const voiceSvc = require('../src/services/homeroom-bot-voice');
const look = require('../src/services/homeroom-bot-thread-tools/look-into');

const APP = 3;
const PLACE = { type: 'issue', ref: 61 };
const KEY = replies.voiceKey(APP, PLACE);
const T0 = Date.parse('2026-11-20T10:00:00Z');
const at = (min) => new Date(T0 + min * 60 * 1000);
const LANE = { kind: 'message', from: { machine: rules.BOT_LANE, key: rules.LANE_KEY, eventId: 1 } };
const ROUTE = { kind: 'route', name: 'voice' };
const TIMER = { kind: 'timer' };

// ── The bot-voice machine, event by event ───────────────────────────────

const voice = voiceMachine.botVoice();
let seq = 0;

function deliver(machine, key, state, type, payload, min, source, facts = {}, appId = null) {
  const decode = machine.events.get(type);
  seq += 1;
  const e = { id: seq, type, payload: decode ? decode(payload) : payload, source, actor: null, requestKey: `k${seq}`, appId, causedBy: null };
  const allowed = machine.check(e, facts, state);
  if (allowed !== true) return { refused: allowed.reject, state };
  const entry = machine.entryFor(state.name, type);
  if (entry.ignore) return { ignored: entry.ignore, state };
  const ctx = { machine: machine.name, key, appId, version: 2, now: at(min) };
  if (entry.guard) {
    const g = entry.guard(state, e, facts, ctx);
    if (g !== true) return { refused: g.reject, state };
  }
  const out = entry.to(state, e, facts, ctx);
  return { ...out, state: out.next };
}
const vdeliver = (state, type, payload, min, source = ROUTE, facts = {}) =>
  deliver(voice, KEY, state, type, payload, min, source, facts, APP);

const START = { name: NONE, data: null };
const heard = (state, messageId, min = 0, place = PLACE) =>
  vdeliver(state, 'Heard', { appId: APP, place, messageId }, min);
const settled = (out, min = 0) => vdeliver(out.state, 'Settled', {}, min, TIMER);
const turns = (out) => (out.work || []).filter((w) => w.kind === voiceMachine.WORK.turn);
const oneTurn = (out) => {
  const [w] = turns(out);
  assert.ok(w, 'a turn was asked for');
  return w;
};
function ended(out, result, min = 0, type = 'WorkSucceeded') {
  const w = oneTurn(out);
  return vdeliver(out.state, type, {
    workId: `w${seq + 1}`, kind: w.kind, workKey: w.key, attempt: 1,
    ...(type === 'WorkSucceeded' ? { result } : { error: { message: 'x' } }),
  }, min, { kind: 'service', workId: `w${seq + 1}` });
}
const HELD = (messageId, speakerId) => ({
  outcome: 'held', throughId: null, replyId: null, speakerIds: [speakerId], held: { ids: [messageId], speakers: [speakerId] },
});
const REPLIED = (speakerId, throughId = null) => ({
  outcome: 'replied', throughId, replyId: 900, speakerIds: [speakerId],
});
const creditBack = (state, min = 0, source = LANE, place = PLACE, appId = APP) =>
  vdeliver(state, 'CreditBack', { appId, place }, min, source);
const held = (out) => (out.state.data.credit || []).map((h) => [h.ids, h.speakers]);
const owed = (out) => (out.state.data.resume || []).map((h) => [h.ids, h.speakers]);

// One burst in `place`: a person writes, it settles, its turn ends `result`.
function burst(state, messageId, speakerId, min, result = HELD(messageId, speakerId), place = PLACE) {
  const a = heard(state, messageId, min, place);
  assert.equal(a.state.name, 'settling');
  const b = settled(a, min);
  assert.equal(b.state.name, 'answering');
  return ended(b, result, min);
}

test('a thread answer that met credit is held, and says so once in HELD_TEXT; nothing asks them to ask again', () => {
  assert.equal(voice.version, 2, 'the data keeps the asks: an older release leaves what this one wrote alone');
  assert.equal(voiceSvc.HELD_TEXT, 'OpenRouter\'s credit ran out. I\'ll answer this here as soon as it\'s back.');
  assert.doesNotMatch(voiceSvc.HELD_TEXT, /ask me again|—|–/i);
  const out = burst(START, 501, 9, 0);
  assert.equal(out.state.name, 'quiet');
  assert.deepEqual(held(out), [[[501], [9]]]);
  assert.deepEqual(owed(out), []);
  assert.equal(out.state.data.turns, 1);
});

test('credit\'s return answers each held ask exactly once, oldest first; a second return does nothing', () => {
  // Only the lane (or the system) says credit is back.
  const first = burst(START, 501, 9, 0);
  assert.equal(creditBack(first.state, 30, ROUTE).refused, 'not_the_lane');
  assert.equal(creditBack(first.state, 30, LANE, { type: 'issue', ref: 62 }).refused, 'key_mismatch');
  assert.equal(vdeliver(START, 'CreditBack', { appId: APP, place: PLACE }, 30, LANE).ignored, 'nothing_owed');
  // Two people asked, in this order: 501 then 502.
  const two = burst(first.state, 502, 10, 1);
  assert.deepEqual(held(two), [[[501], [9]], [[502], [10]]]);
  const back = creditBack(two.state, 30);
  assert.equal(back.state.name, 'answering');
  const w = oneTurn(back);
  assert.equal(w.key, 'turn:3');
  assert.deepEqual(w.input.resume, { ids: [501] }, 'the oldest first');
  assert.equal(w.input.sorry, false);
  assert.deepEqual(held(back), [], 'taken off the record as it is answered');
  assert.deepEqual(owed(back), [[[502], [10]]]);
  const answered = ended(back, REPLIED(9), 30);
  // The second is answered next, in a turn of its own.
  assert.equal(answered.state.name, 'answering');
  const next = oneTurn(answered);
  assert.equal(next.key, 'turn:4');
  assert.deepEqual(next.input.resume, { ids: [502] });
  assert.deepEqual(owed(answered), []);
  const done = ended(answered, REPLIED(10), 30);
  assert.equal(done.state.name, 'quiet');
  assert.deepEqual([held(done), owed(done)], [[], []]);
  // The sweep finds credit back again: nothing is answered again.
  const again = creditBack(done.state, 45);
  assert.equal(again.state.name, 'quiet');
  assert.deepEqual(again.work || [], []);
});

test('a second outage before the first is answered keeps it, with no second line, and the next return answers it', () => {
  const first = burst(START, 501, 9, 0);
  const back = creditBack(first.state, 30);
  assert.deepEqual(oneTurn(back).input.resume, { ids: [501] });
  // It met the 402 again: the service says nothing (the thread already
  // says it) and reports held again.
  const again = ended(back, HELD(501, 9), 30);
  assert.equal(again.state.name, 'quiet');
  assert.deepEqual(held(again), [[[501], [9]]], 'kept, with nobody else');
  assert.deepEqual(owed(again), []);
  const second = creditBack(again.state, 60);
  assert.equal(oneTurn(second).key, 'turn:3');
  assert.deepEqual(oneTurn(second).input.resume, { ids: [501] });
  const done = ended(second, REPLIED(9), 60);
  assert.deepEqual(held(done), []);
});

test('asked again meanwhile: the newer answer drops the older held ask, so it is not answered twice', () => {
  const first = burst(START, 501, 9, 0);
  // The same person writes again and the turn answers them (done).
  const again = burst(first.state, 502, 9, 1, REPLIED(9, 502));
  assert.equal(again.state.name, 'quiet');
  assert.deepEqual(held(again), [], 'their older ask is dropped');
  assert.deepEqual(creditBack(again.state, 30).work || [], []);
  // An entry shared by two people keeps the other one.
  const one = burst(START, 501, 9, 0);
  const two = burst(one.state, 502, 10, 1);
  assert.deepEqual(held(two), [[[501], [9]], [[502], [10]]]);
  const keptOther = burst(two.state, 503, 9, 2, REPLIED(9, 503));
  assert.deepEqual(held(keptOther), [[[502], [10]]], 'only 9 was answered');
});

test('a retried resume that fails for good says sorry once on the same messages, then drops them', () => {
  const first = burst(START, 501, 9, 0);
  const back = creditBack(first.state, 30);
  const failed = ended(back, null, 30, 'WorkExhausted');
  assert.equal(failed.state.name, 'answering', 'one more turn, saying sorry');
  const w = oneTurn(failed);
  assert.equal(w.input.sorry, true);
  assert.deepEqual(w.input.resume, { ids: [501] });
  assert.deepEqual(held(failed), []);
  // A second failure for good drops it: nothing left to answer.
  const done = ended(failed, null, 31, 'WorkExhausted');
  assert.equal(done.state.name, 'quiet');
  assert.deepEqual([held(done), owed(done)], [[], []]);
});

test('a burst written while a resumed ask is answered gets its normal turn after it', () => {
  const first = burst(START, 501, 9, 0);
  const back = creditBack(first.state, 30);
  // Someone writes while the resumed turn answers.
  const written = heard(back.state, 502, 30.1);
  assert.equal(written.state.name, 'answering');
  assert.equal(written.state.data.again, true);
  const answered = ended({ ...back, state: written.state }, REPLIED(9), 30.2);
  assert.equal(answered.state.name, 'settling', 'the normal burst follows the resume');
  const normal = settled(answered, 30.3);
  assert.equal(oneTurn(normal).input.resume, undefined);
  assert.equal(oneTurn(normal).key, 'turn:3');
});

// ── The lane tells them ─────────────────────────────────────────────────

test('credit\'s return reaches every DM, place and look that kept something, in the lane\'s own event', () => {
  const m = laneMachine.botLane({ staging: false });
  const now = new Date('2026-11-20T11:00:00Z');
  const data = {
    grants: 0, fault: null, budget: null, credit: { since: '2026-11-20T09:00:00.000Z', words: null },
    refresh: { due: '2026-11-20T12:00:00.000Z', asked: [], soon: null, n: 1, running: null },
  };
  const ctx = { machine: laneMachine.MACHINE, key: laneMachine.KEY, appId: null, version: 1, now };
  const e = { id: 1, type: 'CreditBack', payload: {}, source: { kind: 'system', name: 'credit' } };
  const voicePlace = { type: 'issue', ref: 61 };
  const facts = {
    ...laneMachine.NO_FACTS,
    creditDms: [{ key: 'person:9', userId: 9 }],
    creditVoices: [{ key: replies.voiceKey(APP, voicePlace), appId: APP, place: voicePlace }],
    creditLooks: [{ key: 'look:7' }],
  };
  const out = m.entryFor('open', 'CreditBack').to({ name: 'open', data }, e, facts, ctx);
  assert.equal(out.next.data.credit, null, 'the pause lifts');
  const told = out.messages || [];
  assert.deepEqual(told.map((msg) => [msg.to.machine, msg.to.key, msg.event.type]),
    [[replies.DM, 'person:9', 'CreditBack'], [replies.VOICE, replies.voiceKey(APP, voicePlace), 'CreditBack'],
      ['bot-look', 'look:7', 'CreditBack']]);
  assert.deepEqual(told[1].event.payload, { appId: APP, place: voicePlace });
  assert.deepEqual(told[2].event.payload, {}, 'a look hears only that credit is back');
});

test('the lane reads the places and looks that kept something only on the pass that lifts the pause', async () => {
  const queries = [];
  const tx = {
    async query(text) {
      const sql = String(text);
      queries.push(sql);
      if (sql === laneFacts.CREDIT_OWED_DMS_SQL) return { rows: [{ key: 'person:9', user_id: '9' }] };
      if (sql === laneFacts.CREDIT_OWED_VOICES_SQL) {
        return { rows: [{ key: 'place:3:issue:61', app_id: '3', place: { type: 'issue', ref: 61 } }, { key: 'place:x', app_id: null, place: {} }] };
      }
      if (sql === laneFacts.CREDIT_OWED_LOOKS_SQL) return { rows: [{ key: 'look:7' }] };
      return { rows: [] };
    },
  };
  const m = laneMachine.botLane({ staging: false });
  const ctx = { machine: laneMachine.MACHINE, key: laneMachine.KEY, appId: null, version: 1, now: new Date('2026-11-20T11:00:00Z') };
  const data = {
    grants: 0, fault: null, budget: null, credit: { since: '2026-11-20T09:00:00.000Z', words: null },
    refresh: { due: '2026-11-20T12:00:00.000Z', asked: [], soon: null, n: 1, running: null },
  };
  const lifted = await m.facts(tx, { name: 'open', data }, { type: 'CreditBack' }, ctx);
  assert.deepEqual(lifted.creditVoices, [{ key: 'place:3:issue:61', appId: 3, place: { type: 'issue', ref: 61 } }]);
  assert.deepEqual(lifted.creditLooks, [{ key: 'look:7' }]);
  assert.deepEqual(lifted.creditDms, [{ key: 'person:9', userId: 9 }]);
  // An ordinary pass reads none of them.
  queries.length = 0;
  const look2 = await m.facts(tx, { name: 'open', data: { ...data, credit: null } }, { type: 'Look' }, ctx);
  assert.equal(look2.creditVoices, undefined);
  assert.equal(queries.some((q) => q === laneFacts.CREDIT_OWED_VOICES_SQL), false);
  assert.match(laneFacts.CREDIT_OWED_VOICES_SQL, /machine = \$1 AND jsonb_typeof\(data->'credit'\) = 'array' AND data->'credit' <> '\[\]'::jsonb/);
  assert.match(laneFacts.CREDIT_OWED_LOOKS_SQL, /machine = 'bot-look' AND state = 'held'/);
});

// ── A look held for credit ──────────────────────────────────────────────

const botLook = lookMachine.botLook();
const LOOK_KEY = lookMachine.lookKey(7);
const ldeliver = (state, type, payload, min, source = { kind: 'system', name: 'look' }, facts = { newer: false }) =>
  deliver(botLook, LOOK_KEY, state, type, payload, min, source, facts);

function lookHeld(min = 0) {
  const requested = ldeliver(START, 'Requested', { lookId: 7, userId: 9 }, min);
  assert.equal(requested.state.name, 'looking');
  const w = (requested.work || []).find((x) => x.kind === lookMachine.WORK.run);
  assert.equal(w.key, 'run');
  return ldeliver(requested.state, 'WorkSucceeded', {
    workId: 'w1', kind: w.kind, workKey: w.key, attempt: 1, result: { state: 'failed', credit: true },
  }, min, { kind: 'service', workId: 'w1' });
}

test('a look whose turn met credit waits in held; CreditBack runs it once under run:r1', () => {
  assert.equal(botLook.version, 2);
  const h = lookHeld();
  assert.equal(h.state.name, 'held');
  assert.equal(h.work || undefined, undefined);
  const back = ldeliver(h.state, 'CreditBack', {}, 30, LANE);
  assert.equal(back.state.name, 'looking');
  assert.equal(back.state.data.rounds, 1);
  const [w] = back.work || [];
  assert.deepEqual([w.kind, w.key], [lookMachine.WORK.run, 'run:r1']);
  assert.deepEqual(back.writes || [], [], 'the row is set running by the work, so a busy look retries it');
  const done = ldeliver(back.state, 'WorkSucceeded', {
    workId: 'w2', kind: w.kind, workKey: 'run:r1', attempt: 1, result: { state: 'done' },
  }, 30, { kind: 'service', workId: 'w2' });
  assert.equal(done.state.name, 'done');
  // A second CreditBack is ignored: the look has ended.
  assert.equal(ldeliver(done.state, 'CreditBack', {}, 60, LANE).ignored, 'ended');
});

test('a newer look of the same person replaces a held one; a second outage leaves it held without posting again', () => {
  const h = lookHeld();
  assert.equal(ldeliver(h.state, 'CreditBack', {}, 30, ROUTE).refused, 'not_the_lane');
  assert.equal(ldeliver(h.state, 'CreditBack', {}, 30, LANE, { newer: true }).state.name, 'done');
  assert.equal(ldeliver(h.state, 'CreditBack', {}, 30, LANE, { newer: true }).state.data.dropped, 'superseded');
  // It ran, met credit again: back to held, and a later return runs it.
  const back = ldeliver(h.state, 'CreditBack', {}, 30, LANE);
  const again = ldeliver(back.state, 'WorkSucceeded', {
    workId: 'w2', kind: lookMachine.WORK.run, workKey: 'run:r1', attempt: 1, result: { state: 'failed', credit: true },
  }, 30, { kind: 'service', workId: 'w2' });
  assert.equal(again.state.name, 'held');
  const third = ldeliver(again.state, 'CreditBack', {}, 60, LANE);
  assert.equal((third.work || [])[0].key, 'run:r2');
});

// ── The held look's words, and its row ──────────────────────────────────

test('a held look says it runs once credit is back, in the project\'s name, with no em dash', () => {
  const text = look.LOOK_HELD_TEXT('Plant Pal');
  assert.equal(text, 'OpenRouter\'s credit ran out, so I couldn\'t look into it in Plant Pal yet. '
    + 'I\'ll run the look and post what I find here as soon as it\'s back.');
  assert.doesNotMatch(text, /—|–|Ask me again/);
  assert.equal(look.isHeldLook({ state: 'failed', error: text }), true);
  assert.equal(look.isHeldLook({ state: 'done', error: text }), false);
});

// The look's work (look-into.js runLookWork) on a row whose turn met credit:
// the row is failed with the held words, the chat stopped waiting hears the
// held line once, and findings are posted when the resumed run ends.
function lookWorkHarness() {
  const app = {
    id: APP, slug: 'plant-pal', name: 'Plant Pal', repo_url: 'https://github.com/evan/plant-pal',
    view_visibility: 'public', collab_visibility: 'public', self_hosted: false,
  };
  let row = {
    id: 7, kind: 'look', state: 'running', user_id: 9, app_id: APP, question: 'Why does the streak reset?',
    deliver: 'wait', message_id: 80, thread_root_id: null, posted_message_id: null, error: null,
  };
  const sends = [];
  const pool = {
    async query(sql, params) {
      const q = String(sql);
      if (/SELECT \* FROM homeroom_bot_looks WHERE id = \$1/.test(q)) return { rows: [{ ...row }] };
      if (/FROM users WHERE id = \$1/.test(q)) return { rows: [{ id: 9, username: 'evan', is_admin: false }] };
      if (/FROM apps\s+WHERE slug/.test(q)) return { rows: [app] };
      if (/FROM apps WHERE id = \$1/.test(q) || /FROM apps\b[\s\S]*WHERE id = \$1/.test(q)) return { rows: [app] };
      if (/FROM user_app_blocks/.test(q)) return { rows: [] };
      if (/UPDATE homeroom_bot_looks\s+SET state = \$2/.test(q)) {
        row = {
          ...row, state: params[1], summary: params[2], answered: params[3], worth_acting: params[4],
          line: params[5], files_read: params[6], files: params[7], checks: params[8], error: params[9],
        };
        return { rows: [{ ...row }] };
      }
      if (/UPDATE homeroom_bot_looks SET deliver = 'post'/.test(q)) {
        row = { ...row, deliver: 'post' };
        return { rows: [{ id: row.id }] };
      }
      if (/UPDATE homeroom_bot_looks SET state = 'running'/.test(q)) {
        row = { ...row, state: 'running', error: null, ended_at: null };
        return { rows: [{ id: row.id }] };
      }
      return { rows: [] };
    },
  };
  const deps = {
    lookInto: async () => ({ ok: false, code: 'credit', failure: 'credit', error: look.LOOK_HELD_TEXT('Plant Pal') }),
    bot: { id: 2, username: 'homeroom_bot' },
    botSvc: { readSettings: async () => ({ mode: 'live', pausedApps: [] }), ensureBotUser: async () => ({ id: 2 }) },
    live: { isLiveFor: () => true },
    limits: { checkBudget: async () => ({}) },
    credit: { creditState: async () => ({ out: false }) },
    dm: {
      overWeeklyAllowance: async () => false,
      async sendDm(_pool, args) { sends.push(args); return { messageId: 700 + sends.length }; },
    },
  };
  const steps = () => {
    const ran = new Set();
    const kept = new Map();
    return {
      turnOwner: null,
      ran,
      async once(k, fn) { if (ran.has(k)) return kept.get(k); const v = await fn(); ran.add(k); kept.set(k, v); return v; },
    };
  };
  return { pool, deps, sends, steps, row: () => row };
}

test('a look that met credit is failed with the held words and waits; a resumed run posts its findings', async () => {
  const h = lookWorkHarness();
  const out = await look.runLookWork({ input: { lookId: 7 }, key: 'run', kind: 'look.run', workId: 1, steps: h.steps }, { pool: h.pool, config: {}, deps: h.deps });
  assert.deepEqual(out, { state: 'failed', credit: true });
  assert.equal(h.row().state, 'failed');
  assert.equal(h.row().error, look.LOOK_HELD_TEXT('Plant Pal'));
  assert.equal(h.row().deliver, 'post', 'its findings go here once credit is back');
  assert.deepEqual(h.sends, [], 'the chat still waited: nothing is posted yet');
});

test('a held look whose chat stopped waiting posts the held line once', async () => {
  const h = lookWorkHarness();
  h.row().deliver = 'post';
  const steps = h.steps;
  const first = await look.runLookWork({ input: { lookId: 7 }, key: 'run', kind: 'look.run', workId: 1, steps }, { pool: h.pool, config: {}, deps: h.deps });
  assert.deepEqual(first, { state: 'failed', credit: true });
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].idempotencyKey, 'hrbot-look:7:held');
  assert.equal(h.sends[0].content, look.LOOK_HELD_TEXT('Plant Pal'));
  // The resumed run (run:r1) sets its row running again, finishes and posts
  // its findings.
  h.row().state = 'failed';
  h.row().error = look.LOOK_HELD_TEXT('Plant Pal');
  h.deps.lookInto = async () => ({
    ok: true, summary: 'The streak counts days in UTC, not your time zone.', answered: true, line: 'It counts days in UTC.',
    filesRead: 2, files: ['src/streak.js'], checks: [],
  });
  const done = await look.runLookWork({ input: { lookId: 7 }, key: 'run:r1', kind: 'look.run', workId: 2, steps }, { pool: h.pool, config: {}, deps: h.deps });
  assert.deepEqual(done, { state: 'done' });
  assert.equal(h.sends.length, 2, 'the held line once, then the findings');
  assert.equal(h.sends[1].idempotencyKey, 'hrbot-look:7');
  assert.match(h.sends[1].content, /I finished looking into it in Plant Pal/);
});

