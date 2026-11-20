'use strict';

// Review B5 (19 Nov 2026): one list of a work state's stages, whys, reasons
// and line codes, shared by the server and the client.
//
// The list is src/services/work-stages.json. The server derives and words a
// row with it (work-stages.js, work-state.js phrasesOf); the shell reads the
// same file (frontend/src/lib/work-stages.ts) and keeps no copy of its own.
// Where a client table must stay (an icon, a tone, a note, a pill: what the
// screen does with a stage, which the server has no say in), it is keyed by
// the shared codes and covers every one of them, or says which it leaves to
// the row's own words, as data (`null` entries, or a list this test reads).
//
// So this fails when the server and the client disagree on any stage, why,
// reason or line code:
//   1. the client's lists are the table's;
//   2. every client table keyed by a stage or a why covers exactly the
//      table's, and every table keyed by another of the server's codes (an
//      activity card's ending, a stop's cause, a batch row's why, a chat
//      card's stage) covers exactly the server's list of them;
//   3. normalizeWorkState keeps every code of the table, and an unknown one;
//   4. every surface says each state of the table in the server's words
//      (the one rule, lib/work-state.ts), fed the row the server stores;
//   5. the classic script's copies (public/js/app-view.js, which cannot
//      import the table) are the table's, and where its reading of the bot's
//      work differs from the server's it says so.
// Every list here is generated from the table or read from the server's own
// module: nothing is kept by hand.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx } = require('./lib/render-tsx');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const { storedRow, storedChange } = require('./lib/stored-row');
const table = require('../src/services/work-stages');
const ws = require('../src/services/work-state');

const ROOT = path.join(__dirname, '..');
const plain = (x) => JSON.parse(JSON.stringify(x));
const sorted = (xs) => [...xs].sort();
const keysOf = (o) => sorted(Object.keys(o));
const say = (p) => message(p.id, p.values);
const sayId = (id, values) => message(id, values);

globalThis.window = globalThis.window || {
  App: { user: { id: 42, username: 'ada' } },
  location: { search: '', hash: '' },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: (fn) => fn(),
  setTimeout, clearTimeout, setInterval, clearInterval,
};

const LIB = loadTsx('frontend/src/lib/work-stages.ts');
const STATE = loadTsx('frontend/src/lib/work-state.ts');

// The values a stored line may carry, so every valued line says its words.
const LINE_VALUES = { place: 2, round: 1, of: 2, failing: 3, minutes: 4, count: 2, by: 'ada', text: 'Why.' };

/** The fields a line's `bot` (or firstVersionReady) reads, each of which makes it a different state. */
function flagsOf(def) {
  const flags = new Set();
  for (const spec of Object.values(def.bot || {})) if (spec && spec.when) flags.add(spec.when);
  if (def.firstVersionReady) flags.add('ready');
  return [...flags];
}

/**
 * Every state the table can write: each stage on its own, each why and
 * reason, and each line on each stage it is written on (with each flag its
 * `bot` reads), whose move it is as the derive says (a claim is the
 * builder's).
 */
function tableStates() {
  const out = [];
  const move = (stage) => table.STAGE[stage].whoseMove || null;
  for (const stage of table.STAGES) {
    out.push({ stage, whoseMove: move(stage) });
    if (stage === 'waiting_for_you') for (const why of table.WHYS) out.push({ stage, why, whoseMove: move(stage) });
    if (stage === 'stopped') for (const reason of table.REASONS) out.push({ stage, reason, whoseMove: move(stage) });
  }
  for (const code of table.LINE_CODES) {
    const def = table.LINE[code];
    for (const stage of def.stages) {
      const base = {
        stage, whoseMove: code === 'claimed' ? 'builder' : move(stage), line: { code, ...LINE_VALUES },
        ...(stage === 'waiting_for_you' ? { why: 'decide' } : {}),
      };
      out.push(base);
      for (const flag of flagsOf(def)) out.push({ ...base, line: { ...base.line, [flag]: true } });
    }
  }
  return out;
}
const STATES = tableStates();
const named = (s) => `${s.stage}${s.why ? `/${s.why}` : ''}${s.reason ? `/${s.reason}` : ''}${s.line ? `/${s.line.code}` : ''}`
  + (s.line ? Object.keys(s.line).filter((k) => !(k in LINE_VALUES) && k !== 'code').map((k) => `+${k}`).join('') : '');
/** The server's words for a state (phrasesOf). */
const wordsOf = (s) => ws.phrasesOf({ why: null, reason: null, line: null, ...s });

// ── 1. The client's lists are the table's ────────────────────────────────

test('the client\'s stages, whys, reasons and line codes are the table\'s, read off it', () => {
  assert.deepEqual([...LIB.STAGES], [...table.STAGES]);
  assert.deepEqual([...LIB.WHYS], [...table.WHYS]);
  assert.deepEqual([...LIB.REASONS], [...table.REASONS]);
  assert.deepEqual([...LIB.LINE_CODES], [...table.LINE_CODES]);
  for (const name of ['NOT_STARTED', 'READY', 'WAITING_LINES', 'APPROVED_LINES', 'FAILING_LINES']) {
    assert.deepEqual(sorted(LIB[name]), sorted(table[name]), name);
  }
  for (const stage of table.STAGES) {
    assert.equal(LIB.stagePhrase(stage), table.STAGE[stage].phrase, stage);
    assert.equal(LIB.isStage(stage), true);
    assert.equal(STATE.isStage(stage), true);
  }
  for (const code of table.LINE_CODES) assert.equal(LIB.isLineCode(code), true, code);
  assert.equal(LIB.isStage('nope'), false);
  assert.equal(LIB.isLineCode('nope'), false);
  assert.deepEqual([...STATE.STAGES], [...table.STAGES], 'lib/work-state.ts hands on the same list');
});

// ── 2. Every client table keyed by a shared code covers the server's ────

test('every client table keyed by a stage or a why covers exactly the table\'s', () => {
  const byStage = [
    ['frontend/src/lib/work-stages.ts', 'STAGE_LOOK'],
    ['frontend/src/features/dev-board/topic/rail-model.ts', 'STAGE_ICON'],
    ['frontend/src/features/dev-board/topic/card-model.ts', 'STAGE_NOTES'],
    ['frontend/src/features/dev-board/topic/thread-model.ts', 'STAGE_PILLS'],
  ];
  const byWhy = [
    ['frontend/src/features/dev-board/topic/card-model.ts', 'WHY_NOTES'],
    ['frontend/src/features/messages/bot-track.tsx', 'NAMED_WAITING_LINES'],
  ];
  for (const [file, name] of byStage) assert.deepEqual(keysOf(loadTsx(file)[name]), sorted(table.STAGES), `${file} ${name}`);
  for (const [file, name] of byWhy) assert.deepEqual(keysOf(loadTsx(file)[name]), sorted(table.WHYS), `${file} ${name}`);
  // Each phrase they name is in the catalog (message throws otherwise).
  for (const [file, name] of [...byWhy, ['frontend/src/features/dev-board/topic/card-model.ts', 'STAGE_NOTES']]) {
    for (const id of Object.values(loadTsx(file)[name])) if (id) assert.ok(message(id, { username: 'ada' }), id);
  }
  // The stages a track counts as finished are the table's ended ones.
  const { ENDED_STAGES } = loadTsx('frontend/src/features/messages/bot-track.tsx');
  assert.deepEqual(sorted(ENDED_STAGES), sorted(table.STAGES.filter((s) => LIB.STAGE_LOOK[s].ended)));
});

test('the activity card\'s endings, tones and stop causes are the server\'s', () => {
  const activity = require('../src/services/homeroom-bot-activity');
  const decode = require('../src/services/bot-stop-cause');
  const client = loadTsx('frontend/src/features/messages/bot-activity.tsx');
  const api = loadTsx('frontend/src/features/messages/api.ts');
  const outcomes = sorted(activity.OUTCOMES);
  assert.deepEqual(keysOf(activity.OUTCOME_LABELS), outcomes);
  assert.deepEqual(keysOf(activity.OUTCOME_TONES), outcomes);
  assert.deepEqual(keysOf(client.ACTIVITY_OUTCOME_LABELS), outcomes);
  assert.deepEqual(sorted(api.ACTIVITY_OUTCOMES), outcomes, 'what the reader keeps');
  assert.deepEqual(plain(client.ACTIVITY_OUTCOME_TONES), plain(activity.OUTCOME_TONES), 'the same tone for each ending');
  for (const name of ['CARD_STATE_WORDS', 'CARD_STATE_LINES']) {
    for (const key of Object.keys(client[name])) assert.ok(outcomes.includes(key), `${name}.${key} is an ending`);
  }
  for (const key of activity.CHANGE_OUTCOMES) assert.ok(outcomes.includes(key), key);
  // Every cause a build stops by: said on the card, and kept by the reader.
  assert.deepEqual(keysOf(client.STOP_CAUSE_LINES), sorted(decode.BUILD_CAUSES));
  assert.deepEqual(sorted(api.JOB_STOP_CAUSES), sorted(decode.BUILD_CAUSES));
  for (const id of Object.values(client.STOP_CAUSE_LINES)) assert.ok(message(id), id);
  // A stopped track's line, for every cause the decoder stores on a stop.
  const { CAUSE_LINES } = loadTsx('frontend/src/features/messages/bot-track.tsx');
  const causes = new Set(Object.keys(decode.STOP_SAID).map((c) => decode.trackCauseOf(c)));
  assert.deepEqual(keysOf(CAUSE_LINES), sorted(causes));
  for (const id of Object.values(CAUSE_LINES)) if (id) assert.ok(message(id), id);
});

test('the server\'s activity cards read the row by the table\'s stages, whys, reasons and lines', () => {
  const activity = require('../src/services/homeroom-bot-activity');
  const outcomes = new Set(activity.OUTCOMES);
  assert.deepEqual(keysOf(activity.REASON_OUTCOMES), sorted(table.REASONS));
  assert.deepEqual(keysOf(activity.WHY_OUTCOMES), sorted(table.WHYS));
  for (const v of [...Object.values(activity.REASON_OUTCOMES), ...Object.values(activity.WHY_OUTCOMES)]) {
    assert.ok(v === null || outcomes.has(v), String(v));
  }
  assert.deepEqual(sorted(activity.STILL_GOING), sorted(table.STAGES.filter((s) => table.STAGE[s].works)));
  // Held: lines on a build that wait (the build's own turn and an update on
  // its way are the build's, so they are left out).
  for (const code of activity.HELD_LINES) {
    assert.ok(table.LINE[code] && table.LINE[code].stages.includes('building') && table.WAITING_LINES.has(code), code);
  }
  for (const s of STATES) {
    const out = activity.outcomeFromWork({ ...s, why: s.why || null, reason: s.reason || null });
    assert.ok(out === null || typeof out === 'symbol' || outcomes.has(out), `${named(s)}: ${String(out)}`);
    if (s.stage === 'stopped' && s.reason) assert.ok(out, `${named(s)}: every reason says what the card came to`);
  }
});

test('the bot tab\'s Needs you pills cover every why, reason and hand-back', () => {
  const { needsYou, NEED_PILLS, DECIDE_KINDS } = loadTsx('frontend/src/features/ai/model.ts');
  const decode = require('../src/services/bot-stop-cause');
  assert.deepEqual(sorted([...Object.keys(DECIDE_KINDS), 'requester']), sorted(decode.HAND_BACKS));
  const app = { slug: 'garden', name: 'Garden club' };
  const kindOf = (state) => {
    const work = STATE.normalizeWorkState(storedRow(state));
    const rows = needsYou([], { private: [], needs: [{ threadId: 1, number: 7, kind: 'work', title: 'T', app, change: null, href: '#', group: 'needs', work, at: null }], next: [], waiting: [], live: [] });
    return rows[0].key.split(':')[0];
  };
  const states = [
    ...table.WHYS.map((why) => ({ stage: 'waiting_for_you', why, whoseMove: 'requester' })),
    ...decode.HAND_BACKS.map((cause) => ({ stage: 'waiting_for_you', why: 'decide', cause, causeNames: ['maya'], whoseMove: 'requester' })),
    ...table.REASONS.map((reason) => ({ stage: 'stopped', reason, whoseMove: 'requester' })),
  ];
  for (const state of states) {
    const kind = kindOf(state);
    assert.ok(Object.prototype.hasOwnProperty.call(NEED_PILLS, kind), `${named(state)}${state.cause ? `/${state.cause}` : ''}: ${kind}`);
  }
  for (const id of Object.values(NEED_PILLS)) assert.ok(message(id), id);
});

test('the batch card and the project chat\'s card cover every code their server sends', () => {
  const batches = require('../src/services/homeroom-bot-batches');
  const chat = require('../src/services/homeroom-bot-chat');
  const { WHY_LINES } = loadTsx('frontend/src/features/messages/bot-cards/batch.tsx');
  const { FILED_STAGES, FILED_JUST_TAKEN } = loadTsx('frontend/src/features/group-chat/bot-request.tsx');
  assert.deepEqual(keysOf(WHY_LINES), sorted(batches.ROW_WHYS));
  for (const id of Object.values(WHY_LINES)) if (id) assert.ok(message(id), id);
  const now = Date.parse('2026-11-19T12:00:00Z');
  const runs = [null, ...['ready', 'question', 'person', 'empty'].map((verdict) => ({ verdict, question: 'Q?', reason: 'R.', created_at: '2026-11-19T11:00:00Z' })),
    { verdict: 'person', already_done: true, reason: 'Done.', created_at: '2026-11-19T11:00:00Z' }];
  const helds = [null, { limit: 'builds' }, { limit: 'allowance' }];
  for (const s of STATES) {
    const work = { why: null, reason: null, line: null, ...s };
    for (const held of helds) {
      for (const run of runs) {
        const read = batches.readOf({ track: { work, held, doneBy: null }, run, now });
        assert.ok(read.why === null || batches.ROW_WHYS.includes(read.why), `${named(s)}: ${read.why}`);
      }
    }
    assert.ok(batches.BUCKETS.includes(batches.bucketOf({ work })), named(s));
    if (s.stage === 'building' && table.READY.has(s.line?.code)) assert.equal(batches.bucketOf({ work }), 'waiting', named(s));
    // The project chat's card: a sentence of its own for every card stage a
    // filed request's row reaches, or "Got it" for one just taken.
    const stage = chat.stageOf({ kind: 'filed' }, { work });
    assert.ok(chat.CARD_STAGES.includes(stage), `${named(s)}: ${stage}`);
    assert.ok(FILED_STAGES.has(stage) || FILED_JUST_TAKEN.has(stage), `${named(s)}: ${stage}`);
  }
  for (const stage of [...FILED_STAGES, ...FILED_JUST_TAKEN]) assert.ok(chat.CARD_STAGES.includes(stage), stage);
  for (const stage of FILED_JUST_TAKEN) assert.ok(!FILED_STAGES.has(stage), stage);
});

test('a track that ended says how, for every ended stage and every reason', () => {
  const { trackEnding, endedWords, ENDINGS } = loadTsx('frontend/src/features/messages/bot-strip.tsx');
  const activity = require('../src/services/homeroom-bot-activity');
  for (const key of Object.keys(ENDINGS)) assert.ok(key === 'done_elsewhere' || activity.OUTCOMES.includes(key), key);
  const tracks = [
    ...table.STAGES.filter((s) => LIB.STAGE_LOOK[s].ended && s !== 'stopped').map((stage) => ({ work: { stage }, doneBy: null })),
    { work: { stage: 'closed' }, doneBy: { username: 'maya', prNumber: 8 } },
    { work: { stage: 'stopped' }, doneBy: null },
    ...table.REASONS.map((reason) => ({ work: { stage: 'stopped', reason }, doneBy: null })),
  ];
  for (const track of tracks) {
    assert.notEqual(endedWords(trackEnding(track), null, 'FALLBACK'), 'FALLBACK', JSON.stringify(track));
  }
});

// ── 3. normalizeWorkState keeps every code ──────────────────────────────

test('normalizeWorkState keeps every stage, why, reason and line of the table, and a code it does not know', () => {
  for (const s of STATES) {
    const got = STATE.normalizeWorkState(storedRow(s));
    assert.ok(got, named(s));
    assert.equal(got.stage, s.stage, named(s));
    assert.equal(got.why, s.why || null, named(s));
    assert.equal(got.reason, s.reason || null, named(s));
    assert.equal(got.line ? got.line.code : null, s.line ? s.line.code : null, named(s));
  }
  // A newer server's codes: kept as they came, with the words sent for them.
  const later = STATE.normalizeWorkState({
    ...storedRow({ stage: 'stopped', reason: 'build_failed' }), reason: 'later_reason', why: 'later_why', line: { code: 'later_line' },
  });
  assert.equal(later.reason, 'later_reason');
  assert.equal(later.why, 'later_why');
  assert.equal(later.line.code, 'later_line');
  assert.equal(STATE.normalizeWorkState({ stage: 'later_stage' }), null, 'a stage it does not know is drawn nowhere');
});

// ── 4. Every surface says each state in the server's words ───────────────

test('every surface says every state of the table in the server\'s words, for its requester and for anyone else', () => {
  const { requestFoot } = loadTsx('frontend/src/features/dev-board/topic/card-model.ts');
  const { requestRail } = loadTsx('frontend/src/features/dev-board/topic/rail-model.ts');
  const { requestPill, threadLayout } = loadTsx('frontend/src/features/dev-board/topic/thread-model.ts');
  const { threadPillKind } = loadTsx('frontend/src/features/dev-board/topic/frame/topic-page.ts');
  const { trackStateWord } = loadTsx('frontend/src/features/messages/bot-track.tsx');
  // A thread with a change in it, so the header always names the work.
  const layout = threadLayout({ thread: { number: 7 }, items: [
    { type: 'request', id: 7, number: 7, status: 'open' },
    { type: 'change', id: 51, number: 8, title: 'A', status: 'promoted', state: 'underway', replies: 0, closes: [7] },
  ] }, { type: 'request', id: 7 });
  const { av } = appView();
  for (const s of STATES) {
    const server = wordsOf(s);
    const failing = s.stage === 'stopped' || table.FAILING_LINES.has(s.line?.code);
    for (const yours of [true, false]) {
      const phrase = yours ? server.stage : server.stageOthers;
      const row = storedRow({ ...s, change: storedChange() }, yours ? {} : { mine: false });
      const work = STATE.normalizeWorkState(row);
      const at = `${named(s)} (${yours ? 'yours' : 'theirs'})`;
      assert.deepEqual(plain(STATE.stageWords(work, { yours })), plain(phrase), at);
      assert.deepEqual(plain(STATE.lineWords(work)), plain(server.line), at);
      // A request's foot.
      const foot = requestFoot(work, yours);
      assert.deepEqual(plain(foot.headline), plain(phrase), `foot: ${at}`);
      if (s.stage === 'stopped') assert.equal(foot.tone, 'bad', `foot tone: ${at}`);
      // Its header pill.
      const pill = requestPill(layout, work, sayId, yours);
      assert.equal(pill.label, say(phrase), `pill: ${at}`);
      if (failing) assert.equal(pill.tone, 'blocked', `pill tone: ${at}`);
      assert.ok(['ok', 'wait', 'act', ''].includes(threadPillKind(pill)), `pill kind: ${at}`);
      // The timeline's last step: the server's words, but a stop's title is
      // the short "Stopped" (the foot says the reason).
      const steps = requestRail({ asker: 'maya', askedAt: '2026-11-07T09:12:00Z', specs: [], changes: [], standing: work, yours });
      const last = steps[steps.length - 1];
      assert.deepEqual(plain(last.title), s.stage === 'stopped' ? { id: table.STAGE.stopped.phrase } : plain(phrase), `rail: ${at}`);
      // A track.
      if (yours) assert.equal(trackStateWord({ work }), say(phrase), `track: ${at}`);
      // The classic script's own reading of the same row.
      const words = av._standingWords(JSON.parse(JSON.stringify(row)));
      assert.deepEqual(plain(words.stage), plain(phrase), `app-view: ${at}`);
      assert.deepEqual(plain(words.line), plain(server.line), `app-view line: ${at}`);
    }
  }
});

// ── 5. The classic script's copies are the table's ──────────────────────

function appView() {
  const c = {
    console,
    App: { user: { id: 42, username: 'evan' }, currentApp: 'garden', currentTab: 'dev' },
    relTime: () => ({ text: 'just now', title: '' }),
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => ({ forEach() {} }), addEventListener() {} },
    localStorage: { getItem: () => null },
    addEventListener() {},
    dispatchEvent() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '', hash: '' }, URLSearchParams,
    PlatformI18n: englishPlatformI18n(),
  };
  c.window = c;
  vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/js/app-view.js'), 'utf8'), c);
  vm.runInContext('globalThis.av = AppView', c);
  return { av: c.av };
}

test('app-view.js\'s copies of the table\'s lists are the table\'s', () => {
  const { av } = appView();
  assert.deepEqual(sorted(av.STANDING_NOT_STARTED), sorted(table.NOT_STARTED));
  assert.deepEqual(sorted(av.WORK_FAILING_LINES), sorted(table.FAILING_LINES));
  assert.deepEqual(keysOf(av.STANDING_PLAIN_IDS), sorted(table.STAGES));
  for (const stage of table.STAGES) assert.equal(av.STANDING_PLAIN_IDS[stage], table.STAGE[stage].phrase, stage);
  // The stages a chip spins in: the shell's busy stages, less reading and
  // planning (a row a chip leads with there is nobody's yet, or waits for a
  // plan: WORK_BUSY_STAGES says why).
  const busy = table.STAGES.filter((s) => LIB.STAGE_LOOK[s].busy && s !== 'reading' && s !== 'planning');
  assert.deepEqual(sorted(av.WORK_BUSY_STAGES), sorted(busy));
  // The bot chip's words are keyed by the table's stage words, and every
  // word a stage the bot works in can say has one.
  const stageWords = new Set([
    ...table.STAGES.map((s) => table.STAGE[s].phrase), ...Object.values(table.TABLE.words),
    ...table.LINE_CODES.flatMap((c) => Object.values(table.LINE[c].stageWord || {})),
  ]);
  for (const id of Object.keys(av.BOT_CHIP_IDS)) assert.ok(stageWords.has(id), id);
  for (const id of Object.values(av.BOT_CHIP_IDS)) assert.ok(message(id), id);
  for (const s of STATES.filter((x) => table.STAGE[x.stage].works)) {
    const id = wordsOf(s).stage.id;
    assert.ok(Object.prototype.hasOwnProperty.call(av.BOT_CHIP_IDS, id), `${named(s)}: ${id}`);
  }
});

test('app-view.js reads whether Homeroom bot is on a request as the server does, but where it says it does not', () => {
  const { av } = appView();
  const pick = (b) => (b ? { what: b.what, held: !!b.held, turn: !!b.turn, plan: !!b.plan } : null);
  const differs = new Set();
  for (const s of STATES) {
    const st = { why: null, reason: null, line: null, since: '2026-11-19T10:00:00Z', ...s };
    const server = pick(ws.botWorkOf(st));
    const client = pick(av._botOn({ number: 7, state: 'open', standing: JSON.parse(JSON.stringify(storedRow(st, { mine: false }))) }));
    const key = `${s.stage}/${s.line ? s.line.code : ''}`;
    if (JSON.stringify(server) === JSON.stringify(client)) continue;
    assert.ok(av.BOT_ON_DIFFERS.includes(key), `${named(s)}: the server reads ${JSON.stringify(server)}, the page ${JSON.stringify(client)}; agree, or list it in AppView.BOT_ON_DIFFERS with why`);
    differs.add(key);
  }
  // A listed difference that has come to agree is no longer one.
  assert.deepEqual(sorted(av.BOT_ON_DIFFERS), sorted(differs), 'BOT_ON_DIFFERS lists only what still differs');
  // T2.2: a build waiting for credit is in the bot's queue on both.
  const credit = { stage: 'building', line: { code: 'credit_wait' }, whoseMove: 'bot', since: null };
  assert.equal(av._botOn({ number: 7, state: 'open', standing: storedRow(credit) }).what, 'queued');
  assert.equal(ws.botWorkOf(credit).what, 'queued');
});
