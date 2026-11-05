'use strict';

// 5 Nov 2026 (docs/plans/bot-one-model.md, step 3): one work state per
// request and change. These pin the decider, where an item goes for each
// viewer, and the moments a change of stage rings.

const test = require('node:test');
const assert = require('node:assert/strict');
const ws = require('../src/services/work-state');

const NOW = new Date('2026-11-05T12:00:00Z');
const ago = (min) => new Date(NOW.getTime() - min * 60 * 1000).toISOString();
const base = { app_id: 1, issue_number: 7, mode: 'live', run_at: ago(30), request_closed: false };
const derive = (extra) => ws.derive({ ...base, ...extra }, { now: NOW });

test('the ten stages, and nothing else, are what a request can be in', () => {
  assert.deepEqual(ws.STAGES, ['reading', 'planning', 'waiting_for_you', 'building', 'checking',
    'up_for_vote', 'going_live', 'live', 'stopped', 'closed']);
  assert.deepEqual(ws.WHYS, ['question', 'plan', 'decide', 'already_works', 'needs_detail']);
});

test('the bot\'s own step maps to one stage, with its queue or hold on the second line', () => {
  const reading = derive({ queue_id: 3, started_at: ago(1), verdict: null });
  assert.equal(reading.stage, 'reading');
  assert.equal(reading.whoseMove, 'bot');
  const queued = derive({ queue_id: 3, enqueued_at: ago(5), queue_place: 4, verdict: null, run_at: null, mode: null });
  assert.deepEqual([queued.stage, queued.line], ['reading', { code: 'queued', place: 4 }]);
  const held = derive({ verdict: 'ready', build_ok: null, cap_suppressed: 'builds_per_app' });
  assert.deepEqual([held.stage, held.line.code], ['building', 'held_builds']);
  const building = derive({ verdict: 'ready', build_ok: null, build_session_id: 9, build_status: 'active', spec_at: ago(10) });
  assert.equal(building.stage, 'building');
  const planning = derive({ verdict: 'ready', build_ok: null, build_session_id: 9, build_status: 'active' });
  assert.equal(planning.stage, 'planning');
});

test('the requester\'s move is always waiting_for_you, with why', () => {
  const plan = derive({ verdict: 'ready', build_ok: null, plan_waiting_at: ago(20) });
  assert.deepEqual([plan.stage, plan.why, plan.whoseMove], ['waiting_for_you', 'plan', 'requester']);
  const question = derive({ question_at: ago(3), verdict: 'question' });
  assert.deepEqual([question.stage, question.why], ['waiting_for_you', 'question']);
  const decide = derive({ verdict: 'person', run_reason: 'Not a small change.\nIt touches every page.' });
  assert.deepEqual([decide.stage, decide.why, decide.line], ['waiting_for_you', 'decide', { code: 'reason', text: 'Not a small change.' }]);
  const works = derive({ verdict: 'person', run_already_done: true });
  assert.equal(works.why, 'already_works');
  const empty = derive({ verdict: 'empty' });
  assert.equal(empty.why, 'needs_detail');
  const blocked = derive({ verdict: 'ready', build_ok: false, build_error: 'blocked: no screen to draw' });
  assert.equal(blocked.why, 'needs_detail');
});

test('a change\'s stages: checking, up for a vote, going live, live; a first version goes live without a vote', () => {
  const change = { proposal_session_id: 50, proposal_at: ago(60), checks_sha: 'a', reviewed_head_sha: 'a', verdict: 'ready', build_ok: true };
  assert.equal(derive({ ...change, proposal_status: 'promoted', check_state: 'pending' }).stage, 'checking');
  const failing = derive({ ...change, proposal_status: 'promoted', check_state: 'failing', failed_checks: 2 });
  assert.deepEqual([failing.stage, failing.line], ['checking', { code: 'checks_failing', failing: 2 }]);
  const vote = derive({ ...change, proposal_status: 'promoted', check_state: 'passing' });
  assert.deepEqual([vote.stage, vote.whoseMove], ['up_for_vote', 'group']);
  const first = derive({ ...change, proposal_status: 'promoted', check_state: 'passing', first_version: true });
  assert.deepEqual([first.stage, first.line], ['going_live', { code: 'first_version' }]);
  assert.equal(derive({ ...change, proposal_status: 'merging' }).stage, 'going_live');
  assert.equal(derive({ ...change, proposal_status: 'merged', merged_at: ago(5) }).stage, 'live');
});

test('stopped says why; a closed request is closed; a claim is being built by its claimer', () => {
  const stopped = derive({ verdict: 'ready', build_ok: false, build_error: 'the build turn failed' });
  assert.deepEqual([stopped.stage, stopped.reason], ['stopped', 'build_failed']);
  assert.equal(derive({ verdict: 'failed' }).reason, 'look_failed');
  assert.equal(derive({ verdict: 'person', request_closed: true }).stage, 'closed');
  const claimed = derive({ verdict: null, mode: null, claimed_by: 'ada', claimed_at: ago(2) });
  assert.deepEqual([claimed.stage, claimed.whoseMove, claimed.line], ['building', 'builder', { code: 'claimed', by: 'ada' }]);
  const nothing = derive({ verdict: null, mode: null, run_at: null });
  assert.deepEqual([nothing.stage, nothing.line], ['reading', { code: 'waiting' }]);
});

test('a private thread holding it for the requester\'s plan wins over waiting in line', () => {
  const held = derive({ queue_id: 3, enqueued_at: ago(5), verdict: null, mode: null, awaiting_plan: true });
  assert.deepEqual([held.stage, held.line, held.whoseMove], ['planning', { code: 'planning_with_you' }, 'requester']);
});

test('a change with no request of its own', () => {
  assert.equal(ws.deriveChange({ status: 'active', last_activity_at: ago(1) }).stage, 'building');
  assert.equal(ws.deriveChange({ status: 'promoted', check_state: 'pending' }).stage, 'checking');
  assert.equal(ws.deriveChange({ status: 'promoted', check_state: 'passing' }).stage, 'up_for_vote');
  assert.equal(ws.deriveChange({ status: 'merged', merged_at: ago(3) }).stage, 'going_live');
  assert.equal(ws.deriveChange({ status: 'merged', live_at: ago(3) }).stage, 'live');
  assert.equal(ws.deriveChange({ status: 'closed' }).stage, 'closed');
});

test('where an item goes depends on whose move it is and who is looking', () => {
  const needs = { stage: 'waiting_for_you', why: 'decide' };
  assert.equal(ws.placeFor(needs, { requester: true }), 'needs');
  assert.equal(ws.placeFor(needs, { own: true }), 'waiting');
  assert.equal(ws.placeFor(needs, {}), null);
  assert.equal(ws.placeFor({ stage: 'building' }, { own: true }), 'next');
  assert.equal(ws.placeFor({ stage: 'reading', line: { code: 'queued' } }, { own: true }), 'waiting');
  assert.equal(ws.placeFor({ stage: 'up_for_vote' }, { own: true, voteOwed: true }), null, 'the feed lists the vote');
  assert.equal(ws.placeFor({ stage: 'up_for_vote' }, { own: true }), 'waiting');
  assert.equal(ws.placeFor({ stage: 'live', since: new Date().toISOString() }, { own: true }), 'live');
  assert.equal(ws.placeFor({ stage: 'live', since: ago(60 * 24 * 8) }, { own: true }), null, 'a week on, it is history');
  assert.equal(ws.placeFor({ stage: 'closed' }, { requester: true }), null);
});

test('a change of stage rings: needs you, ready to vote, stopped, live; a moved line rings nothing', () => {
  assert.equal(ws.bellOf({ stage: 'reading' }, { stage: 'waiting_for_you', why: 'question' }), 'needs_you');
  assert.equal(ws.bellOf({ stage: 'waiting_for_you', why: 'question' }, { stage: 'waiting_for_you', why: 'question' }), null);
  assert.equal(ws.bellOf({ stage: 'waiting_for_you', why: 'question' }, { stage: 'waiting_for_you', why: 'plan' }), 'needs_you');
  assert.equal(ws.bellOf({ stage: 'checking' }, { stage: 'up_for_vote' }), 'ready');
  assert.equal(ws.bellOf({ stage: 'building' }, { stage: 'stopped', reason: 'build_failed' }), 'stopped');
  assert.equal(ws.bellOf({ stage: 'going_live' }, { stage: 'live' }), 'live');
  assert.equal(ws.bellOf({ stage: 'reading', line: { code: 'queued' } }, { stage: 'reading' }), null);
  assert.equal(ws.bellOf(null, { stage: 'building' }), null);
});

test('an instance key names what it is about', async () => {
  const db = { query: async (sql, params) => {
    if (/FROM homeroom_bot_runs WHERE id/.test(sql)) return { rows: [{ app_id: 4, issue_number: params[0] + 1 }] };
    if (/FROM work_states WHERE app_id/.test(sql)) return { rows: [{ app_id: 4, item_kind: 'request', item_ref: 12, session_id: 9 }] };
    return { rows: [] };
  } };
  assert.deepEqual(await ws.itemsOf(db, { machine: 'bot-request', key: 'request:4:12' }), [{ appId: 4, issueNumber: 12 }]);
  assert.deepEqual(await ws.itemsOf(db, { machine: 'bot-build', key: 'run:41@w123' }), [{ appId: 4, issueNumber: 42 }]);
  assert.deepEqual(await ws.itemsOf(db, { machine: 'proposal', key: 'session:9' }), [{ sessionId: 9 }]);
  assert.deepEqual(await ws.itemsOf(db, { machine: 'app-delivery', key: 'app:4' }), [{ appId: 4, issueNumber: 12 }]);
  assert.deepEqual(await ws.itemsOf(db, { machine: 'bot-dm', key: 'user:3' }), [], 'a machine that moves no request');
});
