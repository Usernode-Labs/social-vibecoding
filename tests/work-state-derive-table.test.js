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

// The intended differences from the recording. Empty: nothing has changed.
const INTENDED = [];

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
