'use strict';

// What the derive says over a wide, generated set of facts (every stage,
// every line code, a request with and without a change of the bot's, a first
// version, each thing that holds a vote or a merge), recorded once from the
// derive as it stood before a request's row was composed from its change's
// (review B2), and held there: tests/lib/work-state-cases.js makes the cases,
// tests/fixtures/work-state-derive.before.json is the recording.
//
// A difference from the recording is a failure unless INTENDED lists it:
// which cases (`group`, and `where` over a case's own description), which
// fields may differ (`fields`), what they read now (`to`), and why. Every
// entry must still explain a case, so the list cannot outlive what it
// describes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ws = require('../src/services/work-state');
const cases = require('./lib/work-state-cases');

const BEFORE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/work-state-derive.before.json'), 'utf8'));

// The intended differences from the recording, most particular first (a case
// is explained by the first entry that fits it). All of them are one change:
// a request whose change is up for a vote or past it now reads that change's
// own derived state (deriveChange) unless Homeroom bot is doing something
// about it (work-state.js withBot), where it had a second copy of the rules
// in another order (homeroom-bot-progress.js stageOf and fromStage, both
// gone). No change's own row says anything it did not say before, and no
// request without a change of the bot's up for a vote does either: the test
// below holds them to the recording with no entry here.
const CONFLICT = ['yes', 'syncing', 'author', 'deferred'];
const GITHUB = ['github_stuck', 'github_checks_failing', 'github_checks', 'github_refused'];
const WHOLE = ['stage', 'line', 'whoseMove', 'since', 'words', 'place', 'bot', 'busy'];
const INTENDED = [
  {
    id: 'a queued fix is the change',
    why: 'A fix of its failing checks waiting its turn (#6545) said "Checking, N tests failing" whatever the change stood at, timed from when it was queued. It reads what the change reads: the same words in the usual case, timed from the verdict, and the conflict or GitHub hold when one holds the change.',
    group: ['request', 'request-alone'], where: { bot: 'fix_queued' }, fields: WHOLE,
  },
  {
    id: 'a check being fixed, after what holds the change',
    why: 'A check that is not its own being fixed (#6807) said "Fixing" before a conflict with main or a merge GitHub holds, and for a verdict of unknown. The change says it only for a failing verdict, after those.',
    group: ['request', 'request-alone'], where: { bot: 'flake_fixing' }, fields: WHOLE,
  },
  {
    id: 'a conflict before a GitHub hold',
    why: 'A request read a merge GitHub holds before a conflict with main; a change reads the conflict first (#6531). The request says Syncing with main, Waiting to sync, or what a yes will do, not Approved.',
    group: ['request', 'request-alone'], where: { merge: CONFLICT, hold: GITHUB }, fields: WHOLE,
  },
  {
    id: 'a conflict before a first version',
    why: 'A first version that conflicts with main said "Going live" on its request and Syncing on its change. It says what the change says.',
    group: ['request', 'request-alone'], where: { merge: CONFLICT, first: true }, fields: WHOLE,
  },
  {
    id: 'a GitHub hold before the verdict and a first version',
    why: 'With its merge held by GitHub, a request with failing checks said "N tests failing" and a first version said "Going live"; the change says what GitHub holds it on (#6546).',
    group: ['request', 'request-alone'], where: { merge: 'clean', hold: GITHUB }, fields: WHOLE,
  },
  {
    id: 'an unknown verdict is still checking',
    why: 'A request read a check verdict of unknown as failing ("Tests failing"); a change reads only failing and error so, and unknown as checks still to come. Homeroom bot having stopped fixing it still reads Stopped (withBot).',
    group: ['request', 'request-alone'], where: { check: 'unknown' }, fields: WHOLE,
  },
  {
    id: 'a failing verdict about another commit',
    why: 'A request read a failing verdict about a commit that is not its head as checks still to come (N5); a change reads the failure. Kept as the change reads it, since its order wins; see the report.',
    group: ['request', 'request-alone'], where: { head: 'off', check: ['failing', 'error'] }, fields: ['line', 'words', 'since'],
  },
  {
    id: 'a conflict only its author can move',
    why: 'On a conflict only its author (or the bot) can move, a failing change says "Tests failing" with no count, as the change always did, and one whose verdict is about another commit says the failure, not "Waiting to sync".',
    group: ['request', 'request-alone'], where: { merge: 'author' }, fields: ['line', 'words', 'since'],
  },
  {
    id: 'since when, as the change says',
    why: 'A request timed a conflict from when its change was proposed and a GitHub hold from its checks; a change times a conflict from its checks and a hold from when it was proposed. A change being merged had no time at all on its request.',
    group: ['request', 'request-alone'], fields: ['since'],
  },
];

const among = (want, got) => (Array.isArray(want) ? want.includes(got) : want === got);
const matches = (rule, c) => (!rule.group || among(rule.group, c.group.split('.')[0]))
  && Object.entries(rule.where || {}).every(([k, v]) => among(v, c.a[k] === undefined ? null : c.a[k]));

test('the cases are the ones the recording was made from', () => {
  const now = cases.record(ws);
  assert.equal(now.cases, BEFORE.cases, 'cases are added as a new group at the end, with a new recording of them');
  assert.equal(now.names, BEFORE.names, 'a case was renamed, moved or removed: the recording is read by position');
});

test('the derive says what it said before, but for the differences listed', () => {
  const all = cases.allCases();
  const used = new Set();
  const unexplained = [];
  all.forEach((c, i) => {
    const before = cases.read(BEFORE.outputs[BEFORE.seq[i]]);
    const now = cases.fieldsOf(ws, cases.subject(ws, c));
    const differs = cases.FIELDS.filter((f) => before[f] !== now[f]);
    if (!differs.length) return;
    const rule = INTENDED.find((r) => matches(r, c) && differs.every((f) => r.fields.includes(f))
      && (!r.to || Object.entries(r.to).every(([f, v]) => among(v, now[f]))));
    if (rule) { used.add(rule.id); return; }
    unexplained.push(`${c.group}: ${c.name}\n    was ${cases.write(before)}\n    now ${cases.write(now)}`);
  });
  assert.equal(unexplained.length, 0,
    `${unexplained.length} case(s) differ from the recording with no entry in INTENDED:\n  ${unexplained.slice(0, 12).join('\n  ')}`);
  for (const rule of INTENDED) assert.ok(used.has(rule.id), `INTENDED "${rule.id}" explains no case any more: remove it`);
});

// The composition itself: with Homeroom bot doing nothing about it, a
// request's row is its change's row, whatever holds the change.
test('a request the bot is doing nothing about reads exactly as its change does', () => {
  let read = 0;
  for (const c of cases.allCases()) {
    if (c.kind !== 'request' || !c.change || c.row.proposal_status !== 'promoted') continue;
    if (c.a.bot && !['none', 'fix_queued', 'flake_fixing', 'question_closed'].includes(c.a.bot)) continue;
    const request = cases.fieldsOf(ws, cases.subject(ws, c));
    const change = cases.fieldsOf(ws, ws.deriveChange(c.change, { now: cases.NOW }));
    assert.deepEqual(request, change, `${c.group}: ${c.name}`);
    read += 1;
  }
  assert.ok(read > 3000, `${read} requests read against their changes`);
});

// What the bot is doing about it is the request's own, over the same change.
test('what Homeroom bot is doing about a change is said on its request, never on the change', () => {
  const core = { check: 'failing', head: 'on', merge: 'clean', hold: null, shots: false, first: false, votes: false };
  const find = (bot) => cases.allCases().find((c) => c.group === 'request.bot'
    && Object.entries({ ...core, bot }).every(([k, v]) => c.a[k] === v));
  const said = (bot) => {
    const c = find(bot);
    const st = cases.subject(ws, c);
    return [st.stage, st.why || st.reason || (st.line && st.line.code) || '', ws.deriveChange(c.change, { now: cases.NOW }).line.code].join(' ');
  };
  assert.equal(said('fixing'), 'building fixing checks_failing');
  assert.equal(said('revising'), 'building revising checks_failing');
  assert.equal(said('followup_queued'), 'building update_queued checks_failing');
  assert.equal(said('question'), 'waiting_for_you question checks_failing');
  assert.equal(said('fix_stopped'), 'stopped fix_stopped checks_failing');
  // A closed request's open question waits on nobody: it reads as the change.
  assert.equal(said('question_closed'), 'checking checks_failing checks_failing');
});

test('the cases reach every stage, why, reason and line the derive writes', () => {
  const seen = { stages: new Set(), lines: new Set(), whys: new Set(), reasons: new Set() };
  for (const text of BEFORE.outputs) {
    const f = cases.read(text);
    seen.stages.add(f.stage);
    if (f.why) seen.whys.add(f.why);
    if (f.reason) seen.reasons.add(f.reason);
    if (f.line) seen.lines.add(JSON.parse(f.line).code);
  }
  assert.deepEqual([...seen.stages].sort(), [...ws.STAGES].sort());
  assert.deepEqual([...seen.whys].sort(), [...ws.WHYS].sort());
  assert.deepEqual([...seen.reasons].sort(), [...ws.REASONS].sort());
  for (const code of ['queued', 'first_version_wait', 'held_builds', 'held_waiting', 'on_hold', 'cooldown', 'reply', 'retry_plan',
    'starting', 'proposing', 'fixing', 'revising', 'update_queued', 'checks_failing', 'sync_wait', 'conflict_on_yes',
    'github_checks', 'github_checks_failing', 'github_wait', 'github_stuck', 'first_version', 'planning_with_you', 'waiting',
    'shots', 'approved_checking', 'bot_fix_failed', 'fixing_check', 'credit_wait', 'reviewing', 'checks_running',
    'earlier_yes', 'claimed', 'reason', 'syncing']) {
    assert.ok(seen.lines.has(code), `a case derives the line ${code}`);
  }
});
