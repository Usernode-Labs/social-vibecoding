'use strict';

// The one table of a work state's stages, whys, reasons and line codes
// (src/services/work-stages.json, read through work-stages.js). Every list a
// surface used to keep is read off it, so these hold the table to the
// catalog and to itself, and show a new line code reaching each reader from
// its one entry.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const stages = require('../src/services/work-stages');
const ws = require('../src/services/work-state');

const core = JSON.parse(fs.readFileSync(path.join(__dirname, '../frontend/locales/en/core.json'), 'utf8'));
const inCatalog = (id) => {
  const key = String(id).replace(/^core:/, '');
  return !!core[key] || (!!core[`${key}_one`] && !!core[`${key}_other`]);
};

test('the table is plain data the browser can read, and requires nothing', () => {
  // Loaded by itself, it brings in the table and nothing else: no service,
  // no database, nothing a browser bundle or a test could not take.
  const loaded = require('node:child_process').spawnSync(process.execPath, ['-e',
    "require('./src/services/work-stages'); process.stdout.write(Object.keys(require.cache).map((f) => require('node:path').basename(f)).sort().join(','))",
  ], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(loaded.stdout, 'work-stages.js,work-stages.json', loaded.stderr);
  assert.deepEqual(JSON.parse(JSON.stringify(stages.TABLE)), stages.TABLE, 'nothing but JSON in it');
  assert.throws(() => { stages.LINE.queued.ready = false; }, TypeError, 'and nobody changes it');
});

test('every phrase the table names is in the core catalog', () => {
  const ids = [
    ...Object.values(stages.TABLE.words),
    ...stages.STAGES.map((s) => stages.STAGE[s].phrase),
    ...stages.WHYS.flatMap((w) => [stages.WHY[w].phrase, stages.WHY[w].phraseOthers]),
    ...stages.REASONS.map((r) => stages.REASON[r].phrase),
    ...stages.LINE_CODES.flatMap((code) => {
      const line = stages.LINE[code];
      return [line.phrase, line.valued && line.valued.phrase, ...Object.values(line.stageWord || {})];
    }),
  ].filter(Boolean);
  for (const id of ids) assert.ok(inCatalog(id), `${id} is in frontend/locales/en/core.json`);
  assert.ok(ids.length > 60);
});

test('every line names the stages it is written on, and says something there', () => {
  for (const code of stages.LINE_CODES) {
    const line = stages.LINE[code];
    assert.ok(Array.isArray(line.stages) && line.stages.length, `${code}: where it is written`);
    for (const stage of line.stages) assert.ok(stages.STAGES.includes(stage), `${code}: ${stage} is a stage`);
    for (const stage of Object.keys(line.stageWord || {})) assert.ok(line.stages.includes(stage), `${code}: its word for ${stage}`);
    for (const stage of Object.keys(line.bot || {})) assert.ok(line.stages.includes(stage), `${code}: the bot's work on ${stage}`);
    // Its words, with the values a stored line carries.
    const stored = { code, place: 2, round: 1, of: 2, failing: 3, minutes: 4, count: 2, by: 'ada', text: 'Why.' };
    for (const stage of line.stages) {
      const words = ws.phrasesOf({ stage, line: stored });
      for (const phrase of [words.stage, words.stageOthers, words.line].filter(Boolean)) assert.ok(inCatalog(phrase.id), `${code}: ${phrase.id}`);
      assert.ok(words.line || line.stageWord, `${code} on ${stage}: a second line, or a stage word of its own`);
      assert.ok(ws.says({ stage, line: stored }), `${code} on ${stage} says something`);
    }
  }
});

test('the lists every reader used to keep are the table\'s', () => {
  // A line that waits is never the bot at work, on any stage it is written on.
  for (const code of stages.WAITING_LINES) {
    for (const stage of stages.LINE[code].stages) {
      assert.equal(ws.busyNow({ stage, line: { code }, whoseMove: 'bot' }), false, `${code}: not busy`);
    }
  }
  // Nobody has started on a request that is not started; a ready build is
  // listed under Waiting unless a person has it.
  for (const code of stages.NOT_STARTED) {
    assert.equal(ws.stageSays({ stage: 'reading', line: { code } }), core['work.stage.notStarted'].text, code);
    assert.equal(ws.botWorkOf({ stage: 'reading', line: { code } }), null, `${code}: not the bot's yet`);
  }
  for (const code of stages.READY) {
    assert.equal(ws.stageSays({ stage: 'building', line: { code } }), core['work.stage.readyToBuild'].text, code);
    assert.equal(ws.placeFor({ stage: 'building', line: { code } }, { own: true }), 'waiting', code);
    assert.equal(ws.busyNow({ stage: 'building', line: { code }, whoseMove: 'bot' }), false, code);
  }
  // The request's track and a project chat's card read the same two lists.
  const track = require('../src/services/homeroom-bot-track');
  const chat = require('../src/services/homeroom-bot-chat');
  for (const code of stages.READY) {
    assert.equal(chat.cardStageOfWork({ stage: 'building', line: { code } }), 'waiting', `${code}: the card says it waits`);
    assert.equal(track.trackOf({ job: { key: 'k' }, work: { stage: 'building', line: { code }, whoseMove: 'bot' } }).busy, false, `${code}: its track is not busy`);
  }
  for (const stage of stages.STAGES) assert.equal(track.STEP_OF_STAGE[stage], stages.STAGE[stage].step, stage);
  // The predicate lists and SQL read the same codes.
  assert.match(ws.APPROVED_SQL('w'), /IN \('approved_checking', 'github_checks'\)/);
});

// Review A4: the project chat's card kept its own list of the lines that
// wait, which missed `credit_wait`, and said "Building it now" while the row
// said "Ready to build · Waiting for building credit". From the facts a
// credit wait really leaves (#6867: the run keeps its ready verdict, and the
// request is owed in the bot's queue for `credit_wait`).
test('a build waiting for building credit says it waits on every surface that reads the row', () => {
  const now = new Date('2026-11-19T12:00:00Z');
  const work = ws.derive({
    app_id: 1, issue_number: 7, mode: 'live', verdict: 'ready', build_ok: null, run_proposal: null,
    run_at: '2026-11-19T11:00:00Z', build_session_id: 40, build_status: 'archived',
    queue_id: 9, enqueued_at: '2026-11-19T11:30:00Z', queue_reason: 'credit_wait', request_closed: false,
  }, { now });
  assert.deepEqual([work.stage, work.line], ['building', { code: 'credit_wait' }]);
  assert.equal(ws.says(work), `${core['work.stage.readyToBuild'].text} · ${core['work.line.creditWait'].text}`);
  assert.match(ws.says(work), /^Ready to build · Waiting for building credit/);
  const chat = require('../src/services/homeroom-bot-chat');
  assert.equal(chat.stageOf({ kind: 'filed' }, { work }), 'waiting', 'the project chat\'s card: waiting, not building');
  assert.equal(ws.placeFor(work, { own: true }), 'waiting');
  assert.equal(ws.busyNow(work), false);
  assert.deepEqual(ws.botWorkOf(work), { what: 'queued', since: work.since }, 'the bot\'s, to pick up by itself');
});
