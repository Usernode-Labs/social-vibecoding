'use strict';

// The checks queue (services/checks-queue.js): at most
// CHECKS_MAX_CONCURRENT_RUNS proposal checks runs have Jobs on the cluster at
// once, main-watch has a slot of its own, and everyone else waits after their
// preview is built and before any Job exists.
//
// Red checks followed load, not rollouts: across 701 runs from 5 Oct 2026
// that no rollout overlapped, 9% came back red while the check Jobs used
// under 10 cores of the cluster and 24 to 29% above it, because every preview
// under test loads the one shared Postgres primary. Nothing bounded how many
// runs went at once.
//
// This file holds the rules that need no database: the order and the slot
// rule (planAdmission), how a waiting run is read (never overdue), where the
// gate sits in captureForSession, and what people and agents are told while a
// run waits. tests/checks-queue-postgres.test.js runs the queue on a real
// Postgres: two processes, a freed slot, a superseded run, a restart.
//
// Run with: node --test tests/checks-queue.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

// The scripts under test read their text from the language runtime's
// global; give them the real English one.
globalThis.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const checksQueue = require('../src/services/checks-queue');
const stagingRecovery = require('../src/services/staging-recovery');
const mergeRequirements = require('../src/services/merge-requirements');
const tools = require('../src/services/mcp-tools');
const visuals = require('../src/services/visuals');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (src) => src.replace(/^[ \t]*\/\/.*$/gm, '');

// A row as QUEUE_SQL returns it. `admitted` stamps admitted_at; a dead row
// has stopped heartbeating; `withinDeadline` is an admitted row whose Jobs
// may still be on the cluster.
let seq = 0;
function row(over = {}) {
  seq += 1;
  const { admitted = false, alive = true, withinDeadline = true, expired = false, ...rest } = over;
  return {
    run_id: `run-${seq}`, kind: 'proposal', session_id: seq, app_id: null, commit_sha: `sha${seq}`,
    owner: 'pod-a:1', queued_at: new Date(Date.UTC(2026, 9, 8, 12, 0, seq)),
    admitted_at: admitted ? new Date(Date.UTC(2026, 9, 8, 12, 1, seq)) : null,
    alive, within_deadline: admitted ? withinDeadline : false, expired, class: 4, ...rest,
  };
}
const promoted = (over) => row({ class: 2, ...over });
const handoff = (over) => row({ class: 3, ...over });
const draft = (over) => row({ class: 4, ...over });
const main = (over) => row({ kind: 'main', class: 1, session_id: null, app_id: 7, ...over });

// ── The slot count ──────────────────────────────────────────────────────

test('the cap defaults to four, reads CHECKS_MAX_CONCURRENT_RUNS, and 0 turns the queue off', (t) => {
  const saved = process.env.CHECKS_MAX_CONCURRENT_RUNS;
  t.after(() => {
    if (saved === undefined) delete process.env.CHECKS_MAX_CONCURRENT_RUNS;
    else process.env.CHECKS_MAX_CONCURRENT_RUNS = saved;
  });
  delete process.env.CHECKS_MAX_CONCURRENT_RUNS;
  assert.equal(checksQueue.maxConcurrentRuns(), 4);
  assert.equal(checksQueue.isEnabled(), true);
  process.env.CHECKS_MAX_CONCURRENT_RUNS = '6';
  assert.equal(checksQueue.maxConcurrentRuns(), 6);
  process.env.CHECKS_MAX_CONCURRENT_RUNS = '0';
  assert.equal(checksQueue.maxConcurrentRuns(), 0);
  assert.equal(checksQueue.isEnabled(), false, 'every run starts at once, as before the queue');
  process.env.CHECKS_MAX_CONCURRENT_RUNS = 'lots';
  assert.equal(checksQueue.maxConcurrentRuns(), 4, 'a value that is not a count falls back to the default');
});

test('a dead admitted run holds its slot only while its Jobs may still be running', () => {
  assert.ok(checksQueue.jobHoldMs() >= visuals.RUN_TIMEOUT_MS,
    'past the capture Job\'s own deadline, plus slack for the preparation between admission and the Job');
  const plan = checksQueue.planAdmission([
    promoted({ admitted: true, alive: false, withinDeadline: true }),
    promoted({ admitted: true, alive: false, withinDeadline: false }),
    promoted(),
  ], { cap: 2 });
  assert.deepEqual(plan.holding, { main: 0, proposal: 2 },
    'the first still counts (its Jobs may run on); the second is past its Jobs\' deadline');
  assert.equal(plan.admit.length, 1, 'so the waiting run takes the second slot');
});

// 23 Nov 2026: PR 7029's run settled at 17:27 (its preview work item
// succeeded), but its row's delete was lost on a draining conductor. The
// row, admitted at 17:18, counted until its Jobs' deadline ran out at about
// 17:36, nine minutes of one slot in four, and then sat in the table.
test('a row whose preview work item reported holds no slot, alive or within its deadline', () => {
  const settled = promoted({ admitted: true, alive: false, withinDeadline: true, run_status: 'settled', run_finished: true });
  const reported = promoted({ admitted: true, alive: true, run_status: 'reported', run_finished: true });
  const running = promoted({ admitted: true, alive: false, withinDeadline: true, run_status: 'running', run_finished: false });
  const waiting = promoted();
  const plan = checksQueue.planAdmission([settled, reported, running, waiting], { cap: 2 });
  assert.equal(plan.byRun.get(settled.run_id).holding, false, 'its run is over: nobody reads its Jobs');
  assert.equal(plan.byRun.get(reported.run_id).holding, false, 'a heartbeat not yet stale says nothing once the handler returned');
  assert.equal(plan.byRun.get(running.run_id).holding, true, 'a run still going holds until its deadline, as before');
  assert.deepEqual(plan.admit, [waiting.run_id], 'so the waiting run takes the freed slot');

  // The machine cancelled the run, and the clean-up that stops its Jobs
  // (checks.cancel) has not run yet: QUEUE_SQL leaves run_finished false.
  const cancelled = promoted({ admitted: true, alive: false, withinDeadline: true, run_status: 'settled', run_finished: false });
  assert.equal(checksQueue.planAdmission([cancelled], { cap: 1 }).byRun.get(cancelled.run_id).holding, true,
    'its Jobs may still be on the cluster');

  // A row of a finished run waiting in line (its finally lost the delete) is not in line.
  const left = promoted({ run_status: 'settled', run_finished: true });
  const behind = promoted();
  const line = checksQueue.planAdmission([left, behind], { cap: 1 });
  assert.equal(line.byRun.get(left.run_id).ahead, null);
  assert.deepEqual(line.admit, [behind.run_id]);
});

test('a row of a merged or archived session holds no slot once its owner is gone', () => {
  const dead = promoted({ admitted: true, alive: false, withinDeadline: true, session_ended: true });
  const live = promoted({ admitted: true, alive: true, session_ended: true });
  const plan = checksQueue.planAdmission([dead, live, promoted()], { cap: 2 });
  assert.equal(plan.byRun.get(dead.run_id).holding, false, 'the retire stops an ended session\'s Jobs');
  assert.equal(plan.byRun.get(live.run_id).holding, true, 'a run its owner is still running holds until it ends');
  assert.equal(plan.admit.length, 1);
});

test('a settled run whose early unit Jobs are still stopping counts only until their deadline', () => {
  const lingering = promoted({ admitted: true, alive: false, withinDeadline: true, lingering: true, run_finished: true });
  const past = promoted({ admitted: true, alive: false, withinDeadline: false, lingering: true });
  const plan = checksQueue.planAdmission([lingering, past], { cap: 4 });
  assert.equal(plan.byRun.get(lingering.run_id).holding, true, 'its work item reported, but its Pods may still run');
  assert.equal(plan.byRun.get(past.run_id).holding, false);
  assert.deepEqual(plan.sweep.map((s) => [s.runId, s.why]), [[past.run_id, 'deadline']],
    'and the pass deletes it then, not before');
});

test('the sweep takes finished, ended and abandoned rows, and never a live, waiting or main-watch one', () => {
  const finished = promoted({ admitted: true, alive: true, run_status: 'settled', run_finished: true });
  const ended = draft({ admitted: true, alive: false, withinDeadline: true, session_ended: true });
  const leftover = promoted({
    admitted: true, alive: false, withinDeadline: false, owner: 'conductor-6b85:7:exited', exited: true,
    run_status: null, run_finished: null,
  });
  const silent = promoted({ admitted: true, alive: false, withinDeadline: false, expired: true });
  const kept = [
    // A run under way, admitted or waiting in line.
    promoted({ admitted: true, alive: true, run_status: 'running', run_finished: false }),
    promoted({ alive: true, run_status: 'running', run_finished: false }),
    // Dead, but its work item will come back for it: the retry collects its
    // Jobs, or asks for a slot in its place.
    promoted({ admitted: true, alive: false, withinDeadline: false, exited: true, run_status: 'queued' }),
    promoted({ alive: false, exited: true, run_status: 'running' }),
    promoted({ admitted: true, alive: false, withinDeadline: true, session_ended: true, run_status: 'running' }),
    // Handed over moments ago: its Jobs may still be running.
    promoted({ admitted: true, alive: false, withinDeadline: true, exited: true, run_status: null }),
    // Dead a while, but neither handed over nor silent for long.
    promoted({ admitted: true, alive: false, withinDeadline: false }),
    // main-watch's: its next attempt adopts it.
    main({ admitted: true, alive: false, withinDeadline: false, exited: true, expired: true }),
  ];
  const self = promoted({ run_status: 'settled', run_finished: true });
  const plan = checksQueue.planAdmission([finished, ended, leftover, silent, ...kept, self], { cap: 4, self: self.run_id });
  assert.deepEqual(plan.sweep.map((s) => [s.runId, s.why]), [
    [finished.run_id, 'finished'], [ended.run_id, 'ended'], [leftover.run_id, 'abandoned'], [silent.run_id, 'abandoned'],
  ]);
  assert.equal(plan.sweep[0].sessionId, finished.session_id, 'the log names the proposal');
  for (const r of kept) assert.equal(checksQueue.sweepReason(r, r.alive), null, JSON.stringify(r));
});

test('the admission pass deletes the swept rows, proposal rows only, and says how many', async (t) => {
  t.mock.method(require('../src/services/kubernetes'), 'checkPoolCapacity', async () => ({ available: true, cap: 4 }));
  const finished = promoted({ admitted: true, alive: false, withinDeadline: true, run_status: 'settled', run_finished: true });
  const running = promoted({ admitted: true, alive: true, run_status: 'running', run_finished: false });
  const statements = [];
  const client = {
    async query(sql, params) {
      statements.push({ sql: String(sql), params });
      if (/FROM check_runs cr/.test(sql)) return { rows: [finished, running] };
      if (/^DELETE FROM check_runs WHERE run_id = ANY/.test(String(sql).trim())) {
        return { rows: params[0].map((run_id) => ({ run_id })), rowCount: params[0].length };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const logged = [];
  t.mock.method(require('../src/services/logger'), 'info', (scope, msg, data) => logged.push({ msg, data }));
  const plan = await checksQueue.admit({ async connect() { return client; } });
  const sweep = statements.find((s) => /DELETE FROM check_runs WHERE run_id = ANY\(\$1::uuid\[\]\) AND kind = 'proposal'/.test(s.sql));
  assert.ok(sweep, 'one delete, under the admission lock');
  assert.deepEqual(sweep.params[0], [finished.run_id]);
  assert.ok(statements.findIndex((s) => /pg_advisory_xact_lock/.test(s.sql)) < statements.indexOf(sweep));
  assert.deepEqual(plan.swept, [{ runId: finished.run_id, sessionId: finished.session_id, why: 'finished' }]);
  const line = logged.find((l) => l.msg === 'Cleared the checks rows of runs that are over');
  assert.equal(line.data.removed, 1);
});

test('QUEUE_SQL reads a preview run against its work item by its identity key, and the cancel that follows a cancel', () => {
  const src = stripComments(read('src/services/checks-queue.js'));
  const sql = src.slice(src.indexOf('const QUEUE_SQL = `'), src.indexOf('function runOver('));
  assert.match(sql, /w\.machine = 'preview' AND w\.key = 'session:' \|\| cr\.session_id::text\s+AND w\.kind = 'checks\.run' AND w\.work_key = cr\.manifest->>'runKey'/,
    'machine, key, kind and work key: wf_work\'s unique identity, one index lookup a row');
  assert.match(sql, /\(wk\.status IN \('reported', 'settled'\) AND \(NOT wk\.cancelled OR wk\.cancel_done\)\) AS run_finished/);
  assert.match(sql, /c\.kind = 'checks\.cancel'\s+AND c\.work_key = 'cancel:' \|\| w\.work_key/);
  assert.match(sql, /cs\.status IN \('merged', 'archived'\)\)\) AS session_ended/);
  // The preview machine's names for them.
  const machine = read('src/workflow/preview/machine.ts');
  assert.match(machine, /run: 'checks\.run',/);
  assert.match(machine, /cancel: 'checks\.cancel',/);
  assert.match(machine, /\{ kind: WORK\.cancel, key: `cancel:\$\{d\.run\.key\}`/);
  assert.match(machine, /\{ kind: WORK\.run, key, input: \{\s+sessionId: d\.sessionId, appId: d\.appId, n: served\.n, head: served\.head, runId: key,/);
});

test('an unavailable dedicated pool queues proposals and main-watch without revoking running work', () => {
  const running = promoted({ admitted: true });
  const waiting = [main(), promoted(), draft()];
  const blocked = checksQueue.planAdmission([running, ...waiting], { cap: 4, available: false });
  assert.deepEqual(blocked.admit, []);
  assert.equal(blocked.byRun.get(running.run_id).holding, true);
  assert.ok(waiting.every((r) => !blocked.byRun.get(r.run_id).admitted));
  const recovered = checksQueue.planAdmission([running, ...waiting], { cap: 4, available: true });
  assert.equal(recovered.admit.length, 3);
});

test('required batch admission cannot bypass the queue after a failed insert or a lost row', async (t) => {
  const prior = process.env.CHECK_NODE_POOL_REQUIRED;
  process.env.CHECK_NODE_POOL_REQUIRED = 'true';
  t.after(() => {
    if (prior === undefined) delete process.env.CHECK_NODE_POOL_REQUIRED;
    else process.env.CHECK_NODE_POOL_REQUIRED = prior;
  });
  await assert.rejects(checksQueue.enqueue({ async query() { throw new Error('database unavailable'); } },
    { runId: 'run' }), /database unavailable/);
  t.mock.method(require('../src/services/kubernetes'), 'checkPoolCapacity', async () => ({ available: true, cap: 4 }));
  const client = { async query() { return { rows: [] }; }, release() {} };
  await assert.rejects(checksQueue.waitForSlot({ async connect() { return client; } }, { runId: 'gone' }),
    /lost its queue row/);
});

// ── The order ───────────────────────────────────────────────────────────

test('slots go to main-watch, then promoted proposals, then submitted hand-offs, then drafts', () => {
  // Enqueued in the reverse order, so FIFO alone would get it wrong.
  const rows = [main(), promoted(), handoff(), draft()].reverse()
    .map((r, i) => ({ ...r, queued_at: new Date(Date.UTC(2026, 9, 8, 12, 0, i)) }));
  // QUEUE_SQL sorts; planAdmission keeps the order it is given.
  rows.sort((a, b) => a.class - b.class || a.queued_at - b.queued_at);
  const plan = checksQueue.planAdmission(rows, { cap: 1 });
  const by = (cls) => plan.runs.find((r) => r.class === cls);
  assert.equal(by(1).admitted, true, 'main-watch: its own slot');
  assert.equal(by(2).admitted, true, 'the promoted proposal: the one shared slot');
  assert.equal(by(3).admitted, false);
  assert.equal(by(3).ahead, 0, 'the hand-off is next');
  assert.equal(by(4).ahead, 1, 'the draft after it');
});

test('first come, first served within a class, and the line is strict', () => {
  const first = promoted({ queued_at: new Date(Date.UTC(2026, 9, 8, 12, 0, 1)) });
  const second = promoted({ queued_at: new Date(Date.UTC(2026, 9, 8, 12, 0, 2)) });
  const third = promoted({ queued_at: new Date(Date.UTC(2026, 9, 8, 12, 0, 3)) });
  const holder = promoted({ admitted: true });
  const plan = checksQueue.planAdmission([holder, first, second, third], { cap: 2 });
  assert.deepEqual(plan.admit, [first.run_id]);
  assert.equal(plan.byRun.get(second.run_id).ahead, 0);
  assert.equal(plan.byRun.get(third.run_id).ahead, 1);
  assert.equal(plan.waiting, 2);
});

test('a dead waiting run neither holds a slot nor stands in line; the asking run always does', () => {
  const dead = promoted({ alive: false });
  const live = promoted();
  const plan = checksQueue.planAdmission([dead, live], { cap: 1 });
  assert.deepEqual(plan.admit, [live.run_id], 'the harvest re-drives the dead one in its place');
  assert.equal(plan.byRun.get(dead.run_id).ahead, null);
  // A waiter whose own heartbeat lapsed (a slow UPDATE) still counts itself.
  const late = promoted({ alive: false });
  assert.deepEqual(checksQueue.planAdmission([late], { cap: 1, self: late.run_id }).admit, [late.run_id]);
});

// ── Main-watch's slot ───────────────────────────────────────────────────

test('main-watch has a slot of its own besides the cap, and goes first for any free shared one', () => {
  const full = [promoted({ admitted: true }), promoted({ admitted: true })];
  // The shared slots are full: the first main-watch run still goes.
  const m1 = main();
  let plan = checksQueue.planAdmission([m1, ...full], { cap: 2 });
  assert.deepEqual(plan.admit, [m1.run_id]);
  assert.deepEqual(plan.holding, { main: 1, proposal: 2 }, 'cap + 1 runs on the cluster, at most');

  // Its slot taken, a second main-watch run (another app's merge) waits for
  // a shared one, ahead of every proposal.
  const m2 = main({ app_id: 8 });
  const p = promoted();
  plan = checksQueue.planAdmission([main({ admitted: true }), m2, ...full, p], { cap: 2 });
  assert.deepEqual(plan.admit, []);
  assert.equal(plan.byRun.get(m2.run_id).ahead, 0);
  assert.equal(plan.byRun.get(p.run_id).ahead, 1);
  // One shared slot frees: the main-watch run takes it, not the proposal.
  plan = checksQueue.planAdmission([main({ admitted: true }), m2, full[0], p], { cap: 2 });
  assert.deepEqual(plan.admit, [m2.run_id]);

  // With no main-watch run at all, proposals never take its slot.
  const waiting = promoted();
  plan = checksQueue.planAdmission([...full, waiting], { cap: 2 });
  assert.deepEqual(plan.admit, [], 'the reserved slot is main-watch\'s alone');
});

test('the pilot lends one slot to the first waiting proposal while extra main-watch already holds a slot', () => {
  const mains = [main({ admitted: true }), main({ admitted: true })];
  const waitingMain = main();
  const proposals = Array.from({ length: 3 }, () => promoted({ admitted: true }));
  const first = promoted();
  const second = handoff();
  const rows = [...mains, waitingMain, ...proposals, first, second];

  assert.deepEqual(checksQueue.planAdmission(rows, { cap: 4, poolCap: 5 }).admit, []);
  const plan = checksQueue.planAdmission(rows, { cap: 4, poolCap: 5, proposalOverflowPilot: true });
  assert.deepEqual(plan.admit, [first.run_id]);
  assert.equal(plan.proposalOverflowRunId, first.run_id);
  assert.deepEqual(plan.holding, { main: 2, proposal: 4 });
  assert.equal(plan.byRun.get(waitingMain.run_id).ahead, 0);
  assert.equal(plan.byRun.get(second.run_id).ahead, 1);

  const nextPass = rows.map((r) => r === first ? { ...r, admitted_at: new Date() } : r);
  assert.deepEqual(checksQueue.planAdmission(nextPass,
    { cap: 4, poolCap: 6, proposalOverflowPilot: true }).admit, [],
  'repeated passes keep the single overflow grant and four-proposal ceiling');
});

test('the pilot requires a finite capacity of five and a healthy pool with the ordinary cap of four', () => {
  const waiting = promoted();
  const rows = [
    main({ admitted: true }), main({ admitted: true }),
    ...Array.from({ length: 3 }, () => promoted({ admitted: true })),
    waiting,
  ];
  for (const options of [
    { cap: 4, poolCap: Infinity }, { cap: 4, poolCap: 4 },
    { cap: 3, poolCap: 5 }, { cap: 4, poolCap: 5, available: false },
  ]) {
    assert.deepEqual(checksQueue.planAdmission(rows, { ...options, proposalOverflowPilot: true }).admit, []);
  }
});

test('a waiting main-watch run takes the first ordinary slot and only existing main holds activate the pilot', () => {
  const firstMain = main({ admitted: true });
  const secondMain = main();
  const proposals = Array.from({ length: 3 }, () => promoted({ admitted: true }));
  const waiting = promoted();
  const options = { cap: 4, poolCap: 5, proposalOverflowPilot: true };
  assert.deepEqual(checksQueue.planAdmission([firstMain, secondMain, ...proposals, waiting], options).admit,
    [secondMain.run_id]);

  const started = { ...secondMain, admitted_at: new Date() };
  assert.deepEqual(checksQueue.planAdmission([firstMain, started, ...proposals, waiting], options).admit,
    [waiting.run_id]);
  const reserved = checksQueue.planAdmission([secondMain, ...proposals, promoted({ admitted: true }), waiting], options);
  assert.deepEqual(reserved.admit, [secondMain.run_id], 'the first main-watch slot remains reserved');
});

test('an existing pilot proposal keeps its slot through lower capacity and main-watch completion', () => {
  const firstMain = main({ admitted: true });
  const extraMain = main({ admitted: true, alive: false, withinDeadline: true });
  const proposals = Array.from({ length: 3 }, () => promoted({ admitted: true }));
  const waiting = promoted();
  const pilot = checksQueue.planAdmission([firstMain, extraMain, ...proposals, waiting],
    { cap: 4, poolCap: 5, proposalOverflowPilot: true });
  assert.deepEqual(pilot.admit, [waiting.run_id], 'a main-watch run with Jobs still within deadline counts');

  const holder = { ...waiting, admitted_at: new Date() };
  const next = promoted();
  const reduced = checksQueue.planAdmission([firstMain, extraMain, ...proposals, holder, next],
    { cap: 4, poolCap: 4, proposalOverflowPilot: true });
  assert.deepEqual(reduced.admit, []);
  assert.equal(reduced.byRun.get(holder.run_id).holding, true);
  const released = checksQueue.planAdmission([firstMain, ...proposals, holder, next],
    { cap: 4, poolCap: 5, proposalOverflowPilot: true });
  assert.deepEqual(released.admit, []);
  assert.deepEqual(released.holding, { main: 1, proposal: 4 });
});

test('the admission transaction passes physical capacity and the runtime pilot flag to the planner', async (t) => {
  const flag = 'CHECKS_PROPOSAL_OVERFLOW_PILOT';
  const previous = process.env[flag];
  delete process.env[flag];
  t.after(() => {
    if (previous === undefined) delete process.env[flag];
    else process.env[flag] = previous;
  });
  const capacity = t.mock.method(require('../src/services/kubernetes'), 'checkPoolCapacity',
    async () => ({ available: true, cap: 5 }));
  const waiting = promoted();
  const rows = [
    main({ admitted: true }), main({ admitted: true }),
    ...Array.from({ length: 3 }, () => promoted({ admitted: true })),
    waiting,
  ];
  const grants = [];
  const client = {
    async query(sql, params) {
      if (sql.includes('FROM check_runs cr')) return { rows };
      if (sql.includes('SET admitted_at = NOW()')) grants.push(...params[0]);
      return { rows: [] };
    },
    release() {},
  };
  const pool = { async connect() { return client; } };
  assert.deepEqual((await checksQueue.admit(pool, { cap: 4 })).admit, []);
  process.env[flag] = 'true';
  assert.deepEqual((await checksQueue.admit(pool, { cap: 4 })).admit, [waiting.run_id]);
  assert.deepEqual(grants, [waiting.run_id]);

  capacity.mock.mockImplementation(async () => ({ available: true }));
  assert.deepEqual((await checksQueue.admit(pool, { cap: 4 })).admit, [], 'missing capacity cannot grant a slot');
});

// ── A waiting run is not stuck ──────────────────────────────────────────

test('checkRunOverdue never reads a run waiting for a slot as overdue, however long it has waited', () => {
  const now = Date.now();
  const old = new Date(now - 6 * 3600 * 1000);
  assert.equal(stagingRecovery.checkRunOverdue({
    check_state: 'pending', check_phase: 'queued', checks_commit_sha: 'head', checks_checked_at: old,
  }, { now, staleMs: 600000 }), false);
  // Nor a running one: 'pending' is the preview machine's outstanding work,
  // alive while its lease is, never overdue by clock.
  assert.equal(stagingRecovery.checkRunOverdue({
    check_state: 'pending', check_phase: 'testing', checks_commit_sha: 'head', checks_checked_at: old,
  }, { now, staleMs: 600000 }), false, 'a run that is running is the machine\'s to time');
  assert.equal(stagingRecovery.checkRunOverdue({
    check_state: null, checks_commit_sha: 'head', checks_checked_at: old,
  }, { now, staleMs: 600000 }), true, 'a head nothing ever recorded is still judged by clock');
});

test('a queued run whose process died is carried on by its checks run\'s retry, from its place in line', () => {
  // No sweep re-drives a queued session (the leader's stuck-checks sweep is
  // gone): the wait is inside the preview machine's checks run, a work item
  // with a lease, and the claim after a lost one asks for its slot as of the
  // place the earlier claim had. tests/checks-queue-postgres.test.js runs it.
  const services = stripComments(read('src/workflow/preview/services.ts'));
  const run = services.slice(services.indexOf('[WORK.run]: {'));
  assert.match(run, /if \(attempt > 1\) \{[\s\S]*?SELECT min\(queued_at\) AS at FROM check_runs WHERE session_id = \$1 AND manifest->>'runKey' = \$2/);
  assert.match(run, /queuedSince, report,/);
  assert.equal(stagingRecovery.findStuckCheckSessions, undefined);
});

test('the merge gate kicks no recheck for a queued run, and says it is waiting', () => {
  const src = stripComments(read('src/routes/votes.js'));
  assert.match(src, /const checksQueued = checkRows\[0\]\?\.check_state === 'pending'\s+&& checkRows\[0\]\?\.check_phase === 'queued';/);
  assert.match(src, /const stalePending = !checksDeferred && !checksQueued && \(checkState === null/);
  assert.match(src, /checksQueued \? 'is waiting for a checks slot' : 'is still running its tests'/);
});

test('the merge queue counts a queued run as in flight, so nothing re-drives it', () => {
  const src = stripComments(read('src/workflow/merge-queue/facts.ts'));
  assert.match(src, /runInFlight: r\.check_state === 'pending' && r\.check_phase !== 'deferred' && onHead/);
});

test('a main run a restart interrupted is carried on by its work item, through the queue row it named', () => {
  // No sweep: the main-check machine's main.suite work is resumable, keeps
  // the queue row's run id as its checkpoint, and the next attempt adopts
  // that run's Jobs only once its row was admitted (a waiting row had none).
  // tests/main-watch.test.js and workflow-main-check-postgres pin what follows.
  const run = stripComments(read('src/services/main-watch.js'));
  assert.match(run.slice(run.indexOf('async function runMainSuite(')),
    /SELECT owner FROM check_runs WHERE run_id = \$1 AND admitted_at IS NOT NULL/);
  const services = stripComments(read('src/workflow/main-check/services.ts'));
  assert.match(services, /resumable: true,/);
  assert.match(services, /onRunId: \(runId: string\) => ctx\.checkpoint\(\{ runId \}\)/);
});

test('the orphan listing leaves main-watch rows to main-watch, and a row not yet admitted is a waiting one', () => {
  const runs = stripComments(read('src/services/check-runs.js'));
  assert.match(runs, /FROM check_runs\s+WHERE kind = 'proposal' AND session_id IS NOT NULL/);
  assert.equal(checksQueue.isWaitingRow({ admitted_at: null }), true);
  assert.equal(checksQueue.isWaitingRow({ admitted_at: new Date() }), false);
  assert.equal(checksQueue.isWaitingRow({}), false, 'a row that does not say is not a waiting one');
});

// ── Where the gate sits ─────────────────────────────────────────────────

test('captureForSession waits for its slot after the preview is up and before anything a slot is for', () => {
  // It runs only as the preview machine's checks.run, once the attempt
  // serves: the preview is up by the time it asks.
  const src = read('src/services/visuals.js');
  const live = src.slice(src.indexOf('async function captureForSession('), src.indexOf('function workflowOperation('));
  const enqueue = live.indexOf('checksQueue.enqueue(pool');
  const wait = live.indexOf('await waitForChecksSlot(pool');
  const testing = live.indexOf("setChecksPhase(pool, session.id, commitHash, 'testing')");
  const token = live.indexOf('mintCaptureToken(captureUser, app.id, { previewOnly: app.slug === config.selfAppSlug })');
  const cookie = live.indexOf("'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)'");
  const unit = live.indexOf('unitSuite.maybeRunUnitSuite({');
  const capture = live.indexOf('kubernetes.runCaptureJob(');
  assert.ok(enqueue > 0 && wait > enqueue, 'the run joins the line, then waits in it');
  assert.ok(testing > wait, '"testing" only once it has a slot');
  assert.ok(token > wait && cookie > wait,
    'the capture tokens and the 15-minute "before" cookie are minted after the wait, not before it');
  assert.ok(unit > wait && capture > wait, 'no Job exists, so no Job deadline runs, while it waits');
  assert.match(live, /if \(slot\.outcome === 'superseded'\) \{[\s\S]{0,300}traceStatus = 'superseded';\s+settledRun = true;\s+return \{ outcome: 'blocked', reason: /,
    'a superseded waiting run leaves with no verdict; its finally clears its row');
  assert.match(live, /if \(!place && checksQueue\.isEnabled\(\)\) \{\s+place = await checksQueue\.enqueue\(pool, \{ \.\.\.provisional, queuedSince: workflow\.queuedSince \|\| null \}\);\s+\}\s+if \(!place\) await checkRuns\.record\(pool, provisional\);/,
    'the queue row is the provisional manifest; without the queue it is written as before');
});

test('a run the machine cancels while it waits leaves the line at once', () => {
  // A newer head, a retirement or an admin: the machine cancels the work
  // item, and its lease's signal ends the wait.
  const src = read('src/services/visuals.js');
  const fn = src.slice(src.indexOf('async function waitForChecksSlot('), src.indexOf('async function captureForSession('));
  assert.match(fn, /const \{ signal \} = operation;/);
  assert.match(fn, /checksQueue\.waitForSlot\(pool, \{ runId, signal, stillWanted, onPosition \}\)/);
});

test('every run\'s row going wakes this process\'s waiters', () => {
  const src = stripComments(read('src/services/check-runs.js'));
  assert.match(src, /async function finish\(pool, runId, \{[^}]*\} = \{\}\) \{[\s\S]{0,900}\} finally \{\s+require\('\.\/checks-queue'\)\.slotFreed\(\);/);
});

test('a retried run asks for its slot in the place its earlier claim had in line', () => {
  const services = stripComments(read('src/workflow/preview/services.ts'));
  const run = services.slice(services.indexOf('[WORK.run]: {'), services.indexOf('[WORK.cancel]: {'));
  assert.match(run, /SELECT min\(queued_at\) AS at FROM check_runs WHERE session_id = \$1 AND manifest->>'runKey' = \$2/);
  assert.match(run, /unitRunId: unitEarlyRunId\(input\.sessionId, input\.n\), queuedSince,/);
  assert.ok(run.indexOf('min(queued_at)') < run.indexOf('await clearRun(input.sessionId, input.runId);'),
    'read before the earlier claims\' rows go');
});

// ── What people and agents read ─────────────────────────────────────────

const QUEUED = {
  id: 77, app_slug: 'recipe-box', status: 'promoted', pr_number: 41, branch_name: 'usernode/s77',
  check_state: 'pending', check_phase: 'queued', check_trigger: 'commit-push',
  checks_commit_sha: 'abc123', checks_checked_at: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
  checks_progress: { queue: { ahead: 2, since: new Date().toISOString() } },
  test_results: [],
};

test('the phase is in the closed vocabulary every surface normalises to', () => {
  assert.ok(visuals.CHECK_PHASES.has('queued'));
  const schema = read('src/db/schema.sql');
  assert.match(schema, /'queued'\s+— the preview is healthy and the run is waiting for a\s+--\s+checks slot/);
});

test('the merge requirements read a queued run as in progress, waiting its turn', () => {
  const step = mergeRequirements.provisional(QUEUED).find((s) => s.key === 'checks');
  assert.equal(step.state, 'active');
  assert.equal(step.detail.note, 'waiting for a checks slot; they start on their own');
});

test('the connector tells an agent it is waiting and not to push again', () => {
  const shaped = tools.shapeProposal(QUEUED, 'https://social-vibecoding.usernodelabs.org');
  assert.equal(shaped.checks.phase, 'queued');
  assert.deepEqual(shaped.checks.progress.queue.ahead, 2);
  assert.match(shaped.nextStep, /the staging preview is built and the run is waiting for a checks slot/);
  assert.match(shaped.nextStep, /Poll get_proposal rather than pushing again/);
  const change = tools.changeNextStep(QUEUED, tools.shapeChecks(QUEUED), {}, 'external');
  assert.match(change, /are waiting for a checks slot; they start on their own\. Call get_change again for the verdict\./);
});



function makeAppView() {
  const sandbox = {
    console,
    relTime: () => '40 minutes ago',
    App: { user: { id: 1 }, currentTab: 'dev', currentSubTab: 'topic' },
    Kudos: { renderButton: () => '' },
    DOMPurify: { sanitize: (s) => s },
    document: {
      getElementById: () => null,
      querySelector: () => ({ innerHTML: '' }),
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
      hidden: false,
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { search: '', hash: '' },
    URLSearchParams,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext([
    read('public/js/merge-status.js'),
    read('public/js/app-view.js'),
    ';globalThis.__AppView = AppView;',
  ].join('\n'), sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 3, activeUsers: 5, locked: false };
  AppView.appData = { slug: 'app' };
  return AppView;
}

test('the card says "Waiting for a checks slot (2 ahead)", offers no re-run, and does not call it stuck', () => {
  const AppView = makeAppView();
  assert.equal(AppView._checksPhaseCopy('queued', QUEUED).title, 'Waiting for a checks slot (2 ahead)');
  assert.equal(AppView._checksPhaseCopy('queued', { checks_progress: { queue: { ahead: 0 } } }).title,
    'Waiting for a checks slot (next in line)');
  assert.equal(AppView._checksPhaseCopy('queued').title, 'Waiting for a checks slot', 'a row that does not say');
  assert.equal(AppView._checksPhaseCopy('testing', QUEUED).title, 'Running the automated tests…', 'other phases are untouched');

  const [note] = AppView._checksStatusNotes(QUEUED);
  assert.equal(note.heading, 'Waiting for a checks slot (2 ahead)');
  assert.equal(note.spinner, true, 'in progress');
  assert.equal(note.action, null, 'forty minutes in line is not stuck, so no "Re-run checks"');
  const text = note.rows.map((r) => (r.parts || []).join('')).join(' ');
  assert.match(text, /these start on their own when a slot frees up/);
  assert.match(text, /Waiting since 40\S* ago\./, 'since when, rather than "Started"');
  assert.doesNotMatch(text, /Started /);
  assert.doesNotMatch(text, /re-runs the checks automatically/);
  assert.doesNotMatch(`${note.heading} ${text}`, /—/, 'user-facing copy carries no em dash');

  assert.equal(AppView._checksLine({ state: 'active' }, QUEUED, false), 'Waiting for a slot · 2 ahead');
  // #4452: the change page's Testing card says it, still moving, as the
  // first sentence of its note (23 Nov 2026: with its own full stop).
  assert.equal(AppView._changeTestingView(QUEUED).note.join(' '), 'Waiting for a checks slot (2 ahead).');
  assert.equal(AppView._changeTestingView({ ...QUEUED, checks_progress: null }).note.join(' '), 'Waiting for a checks slot.');
  assert.equal(AppView._changeTestingView(QUEUED).figure, 'Waiting for a slot');
  assert.equal(AppView._changeTestingView(QUEUED).done, false);
});

test('the status pill says the run is waiting, with its place, and keeps the running treatment', () => {
  const MergeStatus = require('../public/js/merge-status.js');
  const pill = MergeStatus.lifecycle(QUEUED);
  assert.equal(pill.key, 'checks_queued');
  assert.equal(pill.label, 'Checks waiting · 2 ahead');
  assert.equal(pill.spinner, true);
  assert.match(pill.title, /^The preview is up, and its checks are waiting for a slot/);
  assert.doesNotMatch(pill.title, /—/);
  assert.equal(MergeStatus.lifecycle({ ...QUEUED, checks_progress: { queue: { ahead: 0 } } }).label, 'Checks waiting · next');
  assert.equal(MergeStatus.lifecycle({ ...QUEUED, checks_progress: null }).label, 'Checks waiting');
});

test('the ?demo=1 fixture serves a queued run, and a declared check reads its card', () => {
  const src = read('src/routes/votes.js');
  const start = src.indexOf('function stagingMockProposals(viewer)');
  let depth = 0; let end = -1;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) { end = j + 1; break; } }
  }
  const ctx = { module: {}, console, connectionExhaustionMessage: () => '', ROLLOUT_RETRY_DETAIL: '' };
  ctx.globalThis = ctx;
  ctx.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(start, end)}\n;globalThis.__rows = stagingMockProposals;`, ctx);
  const mock = JSON.parse(JSON.stringify(ctx.__rows('me').find((r) => r.id === 9000054)));
  assert.equal(mock.check_phase, 'queued');
  assert.equal(mock.checks_progress.queue.ahead, 2);
  assert.match(mock.pr_title, /^\[Mock\] /);
  assert.equal(makeAppView()._checksStatusNotes({ ...mock, status: 'promoted' })[0].heading,
    'Waiting for a checks slot (2 ahead)');

  // #4502: a clearly labelled deferred example uses the actual conflict
  // shape, independently of this transient state existing in a cloned DB.
  const deferred = JSON.parse(JSON.stringify(ctx.__rows('me').find((r) => r.id === 9000055)));
  assert.match(deferred.pr_title, /^\[Mock\] /);
  assert.equal(deferred.check_state, 'pending');
  assert.equal(deferred.check_phase, 'deferred');
  assert.equal(deferred.integration_merges_clean, false);
  assert.equal(deferred.mergeability, 'conflict');
  assert.deepEqual(deferred.test_results, []);
  assert.equal(deferred.checks_progress.build.step, 'done');
  assert.match(makeAppView()._changeTestingView(deferred).noteDetail, /conflicts with main/);
  assert.match(src, /const IS_STAGING = process\.env\.USERNODE_ENV === 'staging'/);
  assert.match(src, /const demoMode = IS_STAGING && req\.query\.demo === '1'/);
  assert.match(src, /if \(!proposal && IS_STAGING && req\.query\.demo === '1'\)/);

  const declared = JSON.parse(read('dapp.json')).tests.filter((t) => String(t.path).includes('/proposals/9000054'));
  assert.equal(declared.length, 1);
  assert.equal(declared[0].expectText, 'Waiting for a checks slot (2 ahead)');
});

// The declared check on 9000054 reads the page's innerText, case-blind
// (capture/capture.js), and Details is a sheet kept hidden until opened. So
// the words have to be on the page itself: the Testing card's line, the one
// line about the checks a reader sees without opening anything. The mock's
// own title must not carry them, or the check would pass on the title alone
// (as "running the automated tests" does on 9000026's).
test('the proposal page itself says where a waiting run is in line, without opening Details', () => {
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const { ChangeDetail } = loadTsx('frontend/src/features/dev-board/topic/topic-head.tsx');
  const src = read('src/routes/votes.js');
  const start = src.indexOf('function stagingMockProposals(viewer)');
  let depth = 0; let end = -1;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) { end = j + 1; break; } }
  }
  const ctx = { module: {}, console, connectionExhaustionMessage: () => '', ROLLOUT_RETRY_DETAIL: '' };
  ctx.globalThis = ctx;
  ctx.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(start, end)}\n;globalThis.__rows = stagingMockProposals;`, ctx);
  const mock = JSON.parse(JSON.stringify(ctx.__rows('me').find((r) => r.id === 9000054)));
  // As the list route serves it: with the merge requirements it computes.
  mock.mergeRequirements = JSON.parse(JSON.stringify(mergeRequirements.readRequirements(mock)));
  const [declared] = JSON.parse(read('dapp.json')).tests.filter((t) => String(t.path).includes('/proposals/9000054'));
  const want = declared.expectText.toLowerCase();
  assert.ok(!mock.pr_title.toLowerCase().includes(want), 'the title alone cannot satisfy the check');

  const AppView = makeAppView();
  AppView.appData = { slug: 'usernode-2d5619', can_collaborate: true };
  const v = AppView._topicViewFor('proposal', mock);
  const page = renderToHtml(createElement(ChangeDetail, { card: v.card, body: v.body, item: mock }));
  const text = page.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  assert.ok(text.includes(want), `the page says "${declared.expectText}"; it read: ${text.slice(0, 600)}`);
  assert.match(page, /data-change-gate="testing" data-done="false"[\s\S]*?<p class="dev-change-gate-note">Waiting for a checks slot \(2 ahead\)\.<\/p>/,
    'on the Testing card\'s line');
});

// 23 Nov 2026: the Testing card's note read "Waiting for a checks slot (2
// ahead) This wait is longer than usual.": the place in line is the
// heading's words, with no full stop, joined to the next sentence by the
// catalog's pair (project:sentences.pair, which expects each to end as a
// sentence). The note now opens with the place in line as a sentence of its
// own, a whole message per case, so every language ends it as it ends a
// sentence; the heading, the chip and the status pill keep the title.
test('a queued run\'s note reads as two sentences: its place in line, then its wait', () => {
  const { loadTsx } = require('./lib/render-tsx');
  const { sentences } = loadTsx('frontend/src/features/dev-board/topic/request-head.tsx');
  const AppView = makeAppView();
  const est = { buildMs: 180000, checksMs: 540000, runs: 12, rough: false, slots: 4 };
  const now = Date.now();
  const at = (ms) => new Date(now - ms).toISOString();
  const queued = (ahead, sinceMs) => ({ ...QUEUED, checks_estimate: est, checks_checked_at: at(sinceMs),
    checks_progress: { ...QUEUED.checks_progress, queue: { ahead, since: at(sinceMs) } } });
  // Waited past what its place in line suggested.
  assert.equal(sentences(AppView._changeTestingView(queued(2, 60 * 60000)).note),
    'Waiting for a checks slot (2 ahead). This wait is longer than usual.');
  // Still inside its wait.
  assert.match(sentences(AppView._changeTestingView(queued(2, 3 * 60000)).note),
    /^Waiting for a checks slot \(2 ahead\)\. About \d+ minutes? until it starts\.$/);
  assert.equal(sentences(AppView._changeTestingView(queued(0, 60 * 60000)).note),
    'Waiting for a checks slot (next in line). This wait is longer than usual.');
  assert.equal(sentences(AppView._changeTestingView(queued(1, 60 * 60000)).note),
    'Waiting for a checks slot (1 ahead). This wait is longer than usual.');
  // The heading and its chip keep the title, which is not a sentence.
  assert.equal(AppView._checksPhaseCopy('queued', queued(2, 0)).title, 'Waiting for a checks slot (2 ahead)');
  assert.equal(AppView._checksPhaseCopy('queued', queued(2, 0)).sentence, 'Waiting for a checks slot (2 ahead).');
  assert.equal(AppView._checksPhaseCopy('testing').sentence, AppView._checksPhaseCopy('testing').title,
    'a title that already ends as a sentence is its own sentence');

  // Every sentence form ends with the full stop its title has not, in the
  // English the translations are made from.
  const english = JSON.parse(read('frontend/locales/en/changes.json'));
  for (const [title, sentence] of [
    ['checks.phase.queued.title', 'checks.phase.queued.sentence'],
    ['checks.phase.queued.titleNext', 'checks.phase.queued.sentenceNext'],
    ['checks.phase.queued.titleAhead_one', 'checks.phase.queued.sentenceAhead_one'],
    ['checks.phase.queued.titleAhead_other', 'checks.phase.queued.sentenceAhead_other'],
  ]) {
    assert.equal(english[sentence].text, `${english[title].text}.`, sentence);
  }
});

test('the Helm chart passes the cap through, documented beside CAPTURE_CPUS', () => {
  const template = read('deploy/helm/social-vibecoding-platform/templates/platform.yaml');
  assert.match(template, /- \{name: CHECKS_MAX_CONCURRENT_RUNS, value: \{\{ \.Values\.config\.checksMaxConcurrentRuns \| int64 \| quote \}\}\}/);
  const values = read('deploy/helm/social-vibecoding-platform/values.yaml');
  assert.match(values, /\n {2}checksMaxConcurrentRuns: 4\n/);
  assert.match(read('deploy/helm/social-vibecoding-platform/README.md'), /`config\.checksMaxConcurrentRuns` \(`CHECKS_MAX_CONCURRENT_RUNS`, default 4\)/);
});
