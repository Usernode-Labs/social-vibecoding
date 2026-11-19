'use strict';

// Review A3 (19 Nov 2026): "ready to try" has one decider.
//
// Three pieces of code decided that one of Homeroom bot's changes was ready
// (the bot-change machine's rule, the DM card's own, the stored row), and
// the first two knew nothing of a conflict with main, a merge GitHub holds
// or an update on its way: a change whose checks passed but which had to
// sync with main first got a "ready to try" card in its requester's chat
// while its page, the bot tab and the bell said "Syncing with main".
//
// The machine now reads the change's stored work state (facts.ts `ready`)
// and is told the moment that row opens (VoteOpened, sent by
// services/work-state.js with the voters' ping). These drive the pure
// machine, event by event as the kernel applies them, with no database: the
// change's facts go through the real derive (work-state.js deriveChange) to
// the row the machine reads, so nothing here hands the machine an answer
// the product would not have computed.
//
// Run with: node --test tests/bot-change-ready-on-vote-open.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const changeMachine = require('../src/workflow/bot-change/machine.ts');
const { factsOf } = require('../src/workflow/bot-change/facts.ts');
const { readyToTry } = require('../src/workflow/rules/bot-readiness.ts');
const { NONE } = require('../src/workflow/kernel/index.ts');
const ws = require('../src/services/work-state');

const machine = changeMachine.botChange();
const SESSION = 500;
const KEY = changeMachine.sessionKey(SESSION);
const HEAD = 'a'.repeat(40);
const T0 = Date.parse('2026-11-19T10:00:00Z');
const at = (min) => new Date(T0 + min * 60 * 1000);
const iso = (min) => at(min).toISOString();

// One of the bot's changes as chat_sessions stores it, up for a vote with
// its checks passed on its head. `extra` is what the case is about.
const session = (extra = {}) => ({
  id: SESSION, app_id: 1, user_id: 2, status: 'promoted', source: 'native', pr_number: 61, approval_epoch: 1,
  check_state: 'passing', check_phase: null, checks_checked_at: iso(-5), test_results: [],
  reviewed_head_sha: HEAD, checks_commit_sha: HEAD, imported_pr_head_sha: null, handoff_head_sha: null,
  merge_conflict_state: null, integration_merges_clean: true, integration_block_reasons: [],
  shots_state: null, shots_run_id: null, shots_detail: null, shots_updated_at: null, pr_diagram: null,
  built_from_session_id: null, promoted_at: iso(-30), created_at: iso(-60), last_activity_at: iso(-30), merged_at: null, live_at: null,
  ...extra,
});

/**
 * The row the machine's facts query returns for a session: its own columns,
 * its run and requester, and its stored work state, which is what the real
 * derive says of the same session (CHANGE_FACTS_SQL names two of its columns
 * differently, and adds what the votes and the bot's records say: `more`).
 */
function read(row, min, more = {}) {
  const state = ws.deriveChange({
    ...row, checks_at: row.checks_checked_at, first_version: false, votes_in: false, earlier_yes: 0,
    update_coming: null, update_failed: null, flake_fixing: false, ...more,
  }, { now: at(min) });
  const facts = factsOf({
    ...row, run_id: 9, issue_number: 7, requester_id: 3, looked: false, fix_revised: false,
    work_stage: state.stage, work_line: state.line, work_vote_open: ws.voteOpenOf(state),
  });
  return { state, facts, stored: { stage: state.stage, line: state.line, voteOpen: ws.voteOpenOf(state) } };
}

const PREVIEW = { kind: 'message', from: { machine: 'preview', key: `session:${SESSION}`, eventId: 1 } };
const PROPOSAL = { kind: 'message', from: { machine: 'proposal', key: `session:${SESSION}`, eventId: 1 } };
const WORK_STATE = { kind: 'route', name: 'work-state' };
let seq = 0;

// The kernel's order: who may send it, the state's entry, its guard, its move.
function deliver(state, type, payload, facts, min, source, version = 3) {
  const decode = machine.events.get(type);
  seq += 1;
  const e = { id: seq, type, payload: decode({ sessionId: SESSION, ...payload }), source, producer: 'platform', actor: null,
    requestKey: `k${seq}`, appId: 1, causedBy: null };
  const allowed = machine.check(e, facts, state);
  if (allowed !== true) return { refused: allowed.reject, state, work: [] };
  const entry = machine.entryFor(state.name, type);
  if (entry.ignore) return { ignored: entry.ignore, state, work: [] };
  const ctx = { machine: changeMachine.MACHINE, key: KEY, appId: 1, version, now: at(min) };
  if (entry.guard) {
    const g = entry.guard(state, e, facts, ctx);
    if (g !== true) return { refused: g.reject, state, work: [] };
  }
  const out = entry.to(state, e, facts, ctx);
  return { state: out.next, work: out.work || [], timer: out.timer };
}
const kinds = (out) => out.work.map((w) => w.kind);
const ready = (out) => out.work.filter((w) => w.kind === changeMachine.WORK.ready);

// The row work-state.js stores for a change, as its refresh hands a changed
// one on: whether the machine is to be told (tryOpened, the same moment the
// change's voters are asked).
const changedRow = (now, prev) => ({ kind: 'change', ref: SESSION, sessionId: SESSION, state: now, prev });

test('checks pass, but the change must sync with main first: no card until the row opens for votes', () => {
  // Promoted; its checks passed on its head; it conflicts with main and the
  // lane is catching it up. Every screen says "Syncing with main".
  const conflicting = session({ merge_conflict_state: 'conflict', integration_merges_clean: false, integration_block_reasons: ['integrating'] });
  const syncing = read(conflicting, 0);
  assert.deepEqual([syncing.state.stage, syncing.state.line], ['checking', { code: 'syncing' }]);
  assert.equal(syncing.stored.voteOpen, false);

  let s = { name: NONE, data: null };
  let out = deliver(s, 'Proposed', {}, syncing.facts, 0, PROPOSAL);
  s = out.state;
  // The preview's passing verdict: the old rule called this ready.
  out = deliver(s, 'Verdict', { head: HEAD, state: 'passing' }, syncing.facts, 1, PREVIEW);
  s = out.state;
  assert.equal(s.name, 'checking');
  assert.deepEqual(ready(out), [], 'no "ready to try" while it syncs with main');
  assert.equal(s.data.told, null);
  assert.equal(out.timer, null, 'and no clock of its own: it waits to be told');
  // Told again by anything else, it decides the same.
  out = deliver(s, 'ShotsSettled', {}, syncing.facts, 2, { kind: 'message', from: { machine: 'shots', key: 'k', eventId: 2 } });
  assert.deepEqual(ready(out), []);
  s = out.state;

  // The sync lands: it merges cleanly, and its row opens for votes. The
  // refresh that stores it tells the machine (work-state.js tryOpened).
  const clean = read(session(), 6);
  assert.equal(clean.stored.voteOpen, true);
  assert.equal(ws.tryOpened(changedRow(clean.stored, syncing.stored)), true, 'the row opening is the moment');
  out = deliver(s, 'VoteOpened', {}, clean.facts, 6, WORK_STATE);
  s = out.state;
  assert.equal(s.name, 'ready');
  assert.deepEqual(ready(out).map((w) => [w.key, w.input.sessionId, w.input.epoch, w.input.broken]), [['ready:1', SESSION, 1, []]]);
  assert.equal(s.data.told, 1);
  assert.ok(kinds(out).includes(changeMachine.WORK.followups), 'whoever asked to hear it is ready to vote on is told with it');

  // Said once per epoch, however often it is told.
  out = deliver(s, 'VoteOpened', {}, clean.facts, 7, WORK_STATE);
  assert.deepEqual(ready(out), [], 'one card');
  assert.equal(ws.tryOpened(changedRow(clean.stored, clean.stored)), false, 'a row still open is told to nobody again');
});

test('whatever holds the vote on the row holds the card: GitHub, an update on its way, its shots', () => {
  const held = {
    'GitHub holds its approved merge': read(session({ integration_block_reasons: ['github_checks'] }), 0, { votes_in: true }),
    'an update is on its way': read(session(), 0, { update_coming: 'queued' }),
    'an update is being made': read(session(), 0, { update_coming: 'running' }),
    'its verdict is about another commit': read(session({ checks_commit_sha: 'b'.repeat(40) }), 0),
    'its checks still run': read(session({ check_state: 'pending' }), 0),
  };
  for (const [name, it] of Object.entries(held)) {
    assert.equal(readyToTry(it.stored), false, `${name}: the row is not open for votes`);
    let s = deliver({ name: NONE, data: null }, 'Proposed', {}, it.facts, 0, PROPOSAL).state;
    const out = deliver(s, 'Verdict', { head: HEAD, state: 'passing' }, it.facts, 1, PREVIEW);
    s = out.state;
    assert.deepEqual(ready(out), [], `${name}: no card`);
    assert.equal(s.name, 'checking', name);
    // A VoteOpened that arrives late or was forged decides nothing either:
    // the row is read again.
    assert.deepEqual(ready(deliver(s, 'VoteOpened', {}, it.facts, 2, WORK_STATE)), [], `${name}: nor on a stray VoteOpened`);
  }

  // Its before & after shots are being taken: the row says so, and so does
  // the machine's state, with no timer of its own (the row's due time ends
  // the hold, and the row opening tells it).
  const shooting = session({
    shots_state: 'exploring', shots_run_id: 'r'.repeat(32), shots_updated_at: iso(-1),
    shots_detail: { headSha: HEAD, required: true, intent: { stories: [{ claim: 'A story' }] } },
  });
  const taking = read(shooting, 0);
  assert.deepEqual([taking.state.stage, taking.state.line], ['checking', { code: 'shots' }]);
  let s = deliver({ name: NONE, data: null }, 'Proposed', {}, taking.facts, 0, PROPOSAL).state;
  let out = deliver(s, 'Verdict', { head: HEAD, state: 'passing' }, taking.facts, 1, PREVIEW);
  s = out.state;
  assert.equal(s.name, 'waiting_on_shots');
  assert.deepEqual([ready(out), out.timer], [[], null]);
  // No settle ever comes: 45 minutes on, the derive no longer holds it.
  const lapsed = read(shooting, 60);
  assert.equal(ws.tryOpened(changedRow(lapsed.stored, taking.stored)), true);
  out = deliver(s, 'VoteOpened', {}, lapsed.facts, 60, WORK_STATE);
  assert.equal(out.state.name, 'ready');
  assert.equal(ready(out).length, 1);
});

test('a first version is ready to try when its row says it goes live without a vote', () => {
  const first = read(session(), 0, { first_version: true });
  assert.deepEqual([first.state.stage, first.state.line, first.stored.voteOpen], ['going_live', { code: 'first_version' }, false]);
  assert.equal(readyToTry(first.stored), true);
  assert.equal(ws.tryOpened(changedRow(first.stored, { stage: 'checking', line: { code: 'shots' }, voteOpen: false })), true);
  // Held by its shots, a first version is not ready either (T2.12).
  const shooting = read(session({
    shots_state: 'exploring', shots_run_id: 'r'.repeat(32), shots_updated_at: iso(-1),
    shots_detail: { headSha: HEAD, required: true, intent: { stories: [{ claim: 'A story' }] } },
  }), 0, { first_version: true });
  assert.equal(readyToTry(shooting.stored), false);
  let out = deliver({ name: NONE, data: null }, 'Proposed', {}, shooting.facts, 0, PROPOSAL);
  assert.deepEqual([out.state.name, ready(out)], ['waiting_on_shots', []]);
  out = deliver(out.state, 'VoteOpened', {}, first.facts, 1, WORK_STATE);
  assert.equal(out.state.name, 'ready');
  assert.equal(ready(out).length, 1);
});

test('what is the machine\'s own stays its own: failing checks go back to the bot whatever the row says', () => {
  const failing = session({ check_state: 'failing', test_results: [{ name: 'opens', status: 'fail', failureReason: 'It did not open' }] });
  const it = read(failing, 0);
  assert.equal(it.state.stage, 'checking');
  const s = deliver({ name: NONE, data: null }, 'Proposed', {}, it.facts, 0, PROPOSAL).state;
  // (Proposed already asked: the fix is due on this head.)
  assert.equal(s.name, 'with_the_bot');
  assert.equal(s.data.fix.head, HEAD);
  const again = deliver(s, 'VoteOpened', {}, it.facts, 1, WORK_STATE);
  assert.equal(again.state.name, 'with_the_bot', 'a round asked and not answered is waited for');
  assert.deepEqual(ready(again), []);
});

test('an instance the version before wrote keeps what it told, and the events it is sent are its own', () => {
  // Version 3 decided readiness itself and recorded the epoch it told.
  const open = read(session(), 0);
  const told = { name: 'ready', data: { sessionId: SESSION, appId: 1, told: 1, stoppedEpoch: null, fix: null, plan: null, notes: { 'ready:1': { kind: changeMachine.WORK.ready, input: {}, status: 'done' }, 'followups:vote:1': { kind: changeMachine.WORK.followups, input: {}, status: 'done' } } } };
  assert.deepEqual(ready(deliver(told, 'VoteOpened', {}, open.facts, 1, WORK_STATE)), [], 'nothing is said twice');
  // VoteOpened is work-state's to send (a route's refresh or the platform's), never a timer's or another machine's.
  assert.equal(deliver(told, 'VoteOpened', {}, open.facts, 1, { kind: 'timer', setAtVersion: 1 }).refused, 'not_a_producer');
  assert.equal(deliver(told, 'VoteOpened', {}, open.facts, 1, PREVIEW).refused, 'not_a_producer');
  assert.ok(machine.web.has('VoteOpened'), 'web may append it: a route\'s refresh stores rows too');
  assert.ok(machine.version >= 4, 'an older Pod leaves the instances this version wrote alone');
});
