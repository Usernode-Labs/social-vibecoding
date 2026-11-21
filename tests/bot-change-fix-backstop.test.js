'use strict';

// Review 3e (19 Nov 2026): `with_the_bot` in Homeroom bot's change machine
// had no timer. A change handed back to the bot waited for the answer to
// the round it asked for (bot-request's FixRoundEnded or FixRefused) with no
// clock of its own: every path that ends a look answers or keeps the debt
// today, but nothing would notice one that someday did not. It now asks
// again after FIX_ANSWER_MS, as the same round (never counted as a lost
// one, so a long outage of the bot's lane hands nobody the change).
//
// These drive the pure machine, event by event as the kernel applies them
// (its producer check, the state's entry, its move), with no database.
//
// Run with: node --test tests/bot-change-fix-backstop.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const changeMachine = require('../src/workflow/bot-change/machine.ts');
const { factsOf } = require('../src/workflow/bot-change/facts.ts');
const { NONE } = require('../src/workflow/kernel/index.ts');

const machine = changeMachine.botChange();
const SESSION = 700;
const KEY = changeMachine.sessionKey(SESSION);
const HEAD = 'c'.repeat(40);
const NEXT = 'd'.repeat(40);
const T0 = Date.parse('2026-11-19T10:00:00Z');
const at = (min) => new Date(T0 + min * 60 * 1000);

// One of the bot's changes, up for a vote, one of its checks failing on its head.
const facts = (extra = {}) => factsOf({
  id: SESSION, app_id: 1, user_id: 2, status: 'promoted', source: 'native', pr_number: 70, approval_epoch: 1,
  check_state: 'failing', checks_checked_at: at(-5).toISOString(), test_results: [{ name: 'votes', status: 'fail' }],
  reviewed_head_sha: HEAD, checks_commit_sha: HEAD, imported_pr_head_sha: null, handoff_head_sha: null,
  shots_state: null, shots_detail: null, pr_diagram: null, built_from_session_id: null,
  run_id: 9, issue_number: 7, requester_id: 3, looked: false, fix_revised: false,
  work_stage: 'checking', work_line: { code: 'checks_failing' }, work_vote_open: false,
  ...extra,
});

const PREVIEW = { kind: 'message', from: { machine: 'preview', key: KEY, eventId: 1 } };
const TIMER = { kind: 'timer', setAtVersion: 1 };
const REQUEST = { kind: 'message', from: { machine: 'bot-request', key: 'request:1:7', eventId: 2 } };
let seq = 0;

function deliver(state, type, payload, f, min, source, version = 1) {
  const decode = machine.events.get(type);
  seq += 1;
  const e = { id: seq, type, payload: decode({ sessionId: SESSION, ...payload }), source, producer: 'platform', actor: null,
    requestKey: `k${seq}`, appId: 1, causedBy: null };
  const allowed = machine.check(e, f, state);
  if (allowed !== true) return { refused: allowed.reject, state, work: [] };
  const entry = machine.entryFor(state.name, type);
  if (entry.ignore) return { ignored: entry.ignore, state, work: [] };
  const ctx = { machine: changeMachine.MACHINE, key: KEY, appId: 1, version, now: at(min) };
  if (entry.guard) {
    const g = entry.guard(state, e, f, ctx);
    if (g !== true) return { refused: g.reject, state, work: [] };
  }
  const out = entry.to(state, e, f, ctx);
  return { state: out.next, work: out.work || [], timer: out.timer };
}
const fixes = (out) => out.work.filter((w) => w.kind === changeMachine.WORK.fix);

test('a round asked of the bot arms a backstop clock, kept while it waits', () => {
  const asked = deliver({ name: NONE }, 'Verdict', { head: HEAD, state: 'failing' }, facts(), 0, PREVIEW);
  assert.equal(asked.state.name, 'with_the_bot');
  assert.equal(fixes(asked).length, 1, 'the round is asked');
  assert.deepEqual(asked.timer, {
    at: new Date(T0 + changeMachine.FIX_ANSWER_MS), event: { type: 'FixUnanswered', payload: { head: HEAD } },
  });
  // Another look while it waits (the shots settle) keeps the clock running.
  const meanwhile = deliver(asked.state, 'ShotsSettled', {}, facts(), 30, { kind: 'message', from: { machine: 'shots', key: KEY, eventId: 3 } });
  assert.equal(meanwhile.state.name, 'with_the_bot');
  assert.equal(meanwhile.timer, undefined, 'undefined keeps the deadline');
  assert.deepEqual(fixes(meanwhile), [], 'and asks nothing twice');
});

test('unanswered for FIX_ANSWER_MS: asked again, as the same round, with the clock armed again', () => {
  const asked = deliver({ name: NONE }, 'Verdict', { head: HEAD, state: 'failing' }, facts(), 0, PREVIEW);
  const later = changeMachine.FIX_ANSWER_MS / 60000;
  const again = deliver(asked.state, 'FixUnanswered', { head: HEAD }, facts(), later, TIMER, 2);
  assert.equal(again.state.name, 'with_the_bot');
  assert.equal(fixes(again).length, 1, 'asked again');
  assert.notEqual(fixes(again)[0].key, fixes(asked)[0].key, 'under a key of its own');
  assert.equal(again.state.data.fix.lost, 0, 'not counted as a lost round');
  assert.equal(again.timer.at.getTime(), T0 + 2 * changeMachine.FIX_ANSWER_MS);
  // The answer that comes then is read as usual: the round looked.
  const looked = deliver(again.state, 'FixRoundEnded', { head: HEAD, outcome: 'looked' }, facts({ looked: true }), later + 10, REQUEST, 3);
  assert.notEqual(looked.state.name, 'with_the_bot');
  assert.deepEqual(fixes(looked), []);
});

test('the clock decides nothing new once the round is moot', () => {
  const asked = deliver({ name: NONE }, 'Verdict', { head: HEAD, state: 'failing' }, facts(), 0, PREVIEW);
  const later = changeMachine.FIX_ANSWER_MS / 60000;
  // A new head meanwhile (the bot's round revised it): not the same round.
  const moved = deliver(asked.state, 'FixUnanswered', { head: HEAD }, facts({ reviewed_head_sha: NEXT, checks_commit_sha: NEXT, check_state: 'pending', test_results: [] }), later, TIMER, 2);
  assert.deepEqual(fixes(moved), [], 'nothing asked for a head it left');
  // Its checks pass now: nothing is due, nothing asked.
  const passed = deliver(asked.state, 'FixUnanswered', { head: HEAD }, facts({ check_state: 'passing', test_results: [] }), later, TIMER, 2);
  assert.deepEqual(fixes(passed), []);
  assert.notEqual(passed.state.name, 'with_the_bot');
  // Only the clock may send it, and a state it does not wait in ignores or reads it as a look.
  assert.equal(deliver(asked.state, 'FixUnanswered', { head: HEAD }, facts(), later, REQUEST).refused, 'timer_only');
  assert.equal(deliver({ name: 'closed', data: asked.state.data }, 'FixUnanswered', { head: HEAD }, facts(), later, TIMER).ignored, 'ended');
});
