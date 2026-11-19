'use strict';

// The bot's machines, driven as the kernel drives them, with no database
// (review B7, 19 Nov 2026). The machines are pure: who may send an event,
// the state's entry, its guard, its move. Until now their grants, pauses and
// transitions were checked only by four large Postgres suites, which skip on
// a developer's machine, and the bot-look machine had no transition test at
// all. These run on every local run.
//
// The request machine's debts are in tests/bot-request-own-retries.test.js,
// the DM's credit resume in tests/bot-dm-credit-resume.test.js, and the
// lane's credit pause in tests/bot-turn-failure.test.js.
//
// Run with: node --test tests/bot-machines-pure.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { NONE } = require('../src/workflow/kernel/index.ts');
const rules = require('../src/workflow/rules/bot-loop.ts');
const lookMachine = require('../src/workflow/bot-look/machine.ts');
const laneMachine = require('../src/workflow/bot-lane/machine.ts');
const investigationMachine = require('../src/workflow/bot-investigation/machine.ts');
const investigation = require('../src/workflow/rules/investigation.ts');

// The kernel's order for one event (kernel/pipeline.ts): decode, authorize,
// the state's entry, its guard, its move.
function driver(machine, { key = 'k', appId = null, version = machine.version } = {}) {
  let seq = 0;
  return function deliver(state, type, payload, { source = { kind: 'system', name: 'test' }, actor = null, facts = {}, now = new Date('2026-11-19T10:00:00Z') } = {}) {
    const decode = machine.events.get(type);
    seq += 1;
    const e = { id: seq, type, payload: decode ? decode(payload) : payload, source, actor, requestKey: `k${seq}`, appId, causedBy: null };
    const allowed = machine.check(e, facts, state);
    if (allowed !== true) return { refused: allowed.reject, state };
    const entry = machine.entryFor(state.name, type);
    if (!entry) return { refused: 'no_entry', state };
    if (entry.ignore) return { ignored: entry.ignore, state };
    const ctx = { machine: machine.name, key, appId, version, now };
    if (entry.guard) {
      const g = entry.guard(state, e, facts, ctx);
      if (g !== true) return { refused: g.reject, state };
    }
    const out = entry.to(state, e, facts, ctx);
    return { ...out, state: out.next };
  };
}
const START = { name: NONE, data: null };
const workResult = (kind, workKey, more = {}) => ({ workId: 'w1', kind, workKey, attempt: 1, ...more });
const SERVICE = { kind: 'service', workId: 'w1' };

// ── bot-look ────────────────────────────────────────────────────────────

test('bot-look: a look is asked for once, runs, and ends done', () => {
  const m = lookMachine.botLook();
  const send = driver(m, { key: lookMachine.lookKey(41) });
  const asked = send(START, 'Requested', { lookId: 41, userId: 9 });
  assert.equal(asked.state.name, 'looking');
  assert.deepEqual(asked.state.data, { lookId: 41, userId: 9, requestedAt: '2026-11-19T10:00:00.000Z' });
  assert.deepEqual(asked.work, [{ kind: lookMachine.WORK.run, key: 'run', input: { lookId: 41 } }]);
  // Asked again (a retried chat turn): the same look, no second run.
  assert.equal(send(asked.state, 'Requested', { lookId: 41, userId: 9 }).ignored, 'already_looking');
  const done = send(asked.state, 'WorkSucceeded', workResult(lookMachine.WORK.run, 'run', { result: { state: 'done' } }),
    { source: SERVICE, now: new Date('2026-11-19T10:04:00Z') });
  assert.equal(done.state.name, 'done');
  assert.equal(done.state.data.endedAt, '2026-11-19T10:04:00.000Z');
  assert.ok(!done.work || done.work.length === 0, 'nothing more to do');
  assert.deepEqual(m.terminal ? [...m.terminal].sort() : ['done', 'failed'], ['done', 'failed']);
});

test('bot-look: a run that failed for good is recorded and said; another work item\'s result changes nothing', () => {
  const m = lookMachine.botLook();
  const send = driver(m, { key: lookMachine.lookKey(42) });
  const looking = send(START, 'Requested', { lookId: 42, userId: 9 }).state;
  // Not the look's own run.
  const other = send(looking, 'WorkFailed', workResult(lookMachine.WORK.failed, 'failed', { error: { message: 'x' } }), { source: SERVICE });
  assert.equal(other.refused, 'not_the_look');
  for (const type of ['WorkFailed', 'WorkExhausted']) {
    const out = send(looking, type, workResult(lookMachine.WORK.run, 'run', { error: { message: 'the worker would not start' } }),
      { source: SERVICE, now: new Date('2026-11-19T10:06:00Z') });
    assert.equal(out.state.name, 'failed', type);
    assert.equal(out.state.data.error, 'the worker would not start');
    assert.equal(out.state.data.endedAt, '2026-11-19T10:06:00.000Z');
    assert.deepEqual(out.work, [{ kind: lookMachine.WORK.failed, key: 'failed', input: { lookId: 42 } }], 'the chat that asked hears it');
    // Ended: its own later results are taken and change nothing.
    const late = send(out.state, 'WorkSucceeded', workResult(lookMachine.WORK.failed, 'failed', { result: {} }), { source: SERVICE });
    assert.ok(late.ignored, 'ignored, not refused');
    assert.equal(late.state.name, 'failed');
    assert.equal(send(out.state, 'Requested', { lookId: 42, userId: 9 }).ignored, 'ended', 'and it is never looked at again');
  }
});

test('bot-look: only the platform asks for a look, and its ids are checked', () => {
  const m = lookMachine.botLook();
  const send = driver(m);
  assert.equal(send(START, 'Requested', { lookId: 43, userId: 9 }, { source: { kind: 'route', name: 'web' } }).refused, 'not_the_platform');
  assert.equal(send(START, 'Requested', { lookId: 43, userId: 9 }, { source: { kind: 'admin' } }).state.name, 'looking');
  assert.throws(() => m.events.get('Requested')({ lookId: 0, userId: 9 }), /lookId must be a positive integer/);
  assert.throws(() => m.events.get('Requested')({ lookId: 43 }), /userId must be a positive integer/);
});

// ── bot-lane: grants and pauses ─────────────────────────────────────────

const lane = laneMachine.botLane({ staging: false });
const laneSend = driver(lane, { key: laneMachine.KEY });
const NOW = new Date('2026-11-19T11:00:00Z');
const laneData = (more = {}) => ({
  grants: 0, fault: null, budget: null, credit: null,
  refresh: { due: '2026-11-19T12:00:00.000Z', asked: [], soon: null, n: 1, running: null }, ...more,
});
const read = (appId, issue, personId, more = {}) => ({
  app_id: appId, issue_number: issue, priority: 2, reason: 'refresh', person_id: personId,
  follow_up_session_id: null, triage_session_id: 700 + appId, machine_version: 2, ...more,
});
const build = (appId, issue, personId) => ({ app_id: appId, issue_number: issue, run_id: 900 + issue, person_id: personId });
const laneFactsOf = (more = {}) => ({
  ...laneMachine.NO_FACTS, acting: true, credit: null,
  settings: { ...laneMachine.NO_FACTS.settings, liveAtOnce: 3, perPerson: 1, readsPerApp: 1 }, ...more,
});
const lanePass = (data, type, facts, payload = {}) => laneSend({ name: 'open', data }, type, payload, { facts, now: NOW });
const grants = (out) => (out.messages || []).filter((m) => m.to.machine === rules.BOT_REQUEST && m.event.type === 'Granted')
  .map((m) => [m.event.payload.appId, m.event.payload.issueNumber, m.event.payload.kind, m.event.payload.grant]);

test('bot-lane: grants in the queue\'s order, numbered, up to what may run at once and one per person', () => {
  const facts = laneFactsOf({
    reads: [read(1, 10, 7), read(1, 11, 8), read(2, 20, 7), read(3, 30, 9)],
    builds: [build(4, 40, 12), build(5, 50, 13)],
  });
  const out = lanePass(laneData({ grants: 4 }), 'Look', facts);
  // #10 (person 7, project 1). #11 waits: project 1's one read slot is
  // taken. #20 waits: person 7 already has a look. #30 is granted. One slot
  // of three is left for a build.
  assert.deepEqual(grants(out), [[1, 10, 'read', 5], [3, 30, 'read', 6], [4, 40, 'build', 7]]);
  assert.equal(out.state.data.grants, 7, 'each grant has its own number');
  // What is in use counts: with two slots taken, one more is granted.
  const busy = lanePass(laneData(), 'Look', {
    ...facts,
    inUse: [{ kind: 'read', appId: 8, person: 'u1', readSlot: 0 }, { kind: 'build', appId: 9, person: 'u2' }],
  });
  assert.deepEqual(grants(busy), [[1, 10, 'read', 1]]);
});

test('bot-lane: nothing is granted while the bot is off, on a fault, on its weekly cap or on GitHub\'s budget; each pause ends on its clock', () => {
  const facts = laneFactsOf({ reads: [read(1, 10, 7)] });
  assert.deepEqual(grants(lanePass(laneData(), 'Look', { ...facts, acting: false })), [], 'off');
  const later = '2026-11-19T11:10:00.000Z';
  for (const [name, pause] of [['fault', { fault: { until: later, attempts: 1 } }], ['budget', { budget: { until: later } }], ['github', { github: { until: later } }]]) {
    const paused = lanePass(laneData(pause), 'Look', facts);
    assert.deepEqual(grants(paused), [], name);
    assert.equal(paused.timer.event.type, 'Tick', `${name}: its clock wakes it`);
    assert.ok(paused.timer.at.getTime() <= Date.parse(later), name);
    // Past its time, the pause is over.
    const over = laneSend({ name: 'open', data: laneData(pause) }, 'Tick', {}, { facts, now: new Date('2026-11-19T11:10:01Z'), source: { kind: 'timer' } });
    assert.equal(grants(over).length, 1, `${name} lifts`);
  }
});

test('bot-lane: a fault pauses and doubles, a look that ran ends it, and only its clock may tick it', () => {
  const facts = laneFactsOf();
  const first = lanePass(laneData(), 'Released', facts, { fault: true });
  assert.equal(first.state.data.fault.attempts, 1);
  const second = lanePass(first.state.data, 'Released', facts, { fault: true });
  assert.equal(second.state.data.fault.attempts, 2);
  assert.ok(Date.parse(second.state.data.fault.until) > Date.parse(first.state.data.fault.until), 'the pause grows');
  const ran = lanePass(second.state.data, 'Released', facts, { ran: true });
  assert.equal(ran.state.data.fault, null, 'a look that ran ends it');
  const budget = lanePass(laneData(), 'Released', facts, { budget: true });
  assert.ok(Date.parse(budget.state.data.budget.until) > NOW.getTime());
  assert.equal(laneSend({ name: 'open', data: laneData() }, 'Tick', {}, { facts, source: { kind: 'route', name: 'web' } }).refused, 'not_the_clock');
});

test('bot-lane: the refresh runs on its clock, once at a time, and soon after a project is asked for', () => {
  const facts = laneFactsOf();
  const due = lanePass(laneData({ refresh: { due: '2026-11-19T10:59:00.000Z', asked: [], soon: null, n: 4, running: null } }), 'Tick', facts);
  assert.deepEqual(due.work.map((w) => w.key), ['refresh:5', 'sweep:5'], 'the full refresh, and the sweeps beside it');
  assert.equal(due.state.data.refresh.running, 5);
  // One under way: the next is not started over it.
  const again = lanePass(due.state.data, 'Tick', facts);
  assert.deepEqual(again.work, []);
  // Its work ended: the next may start.
  const ended = laneSend({ name: 'open', data: due.state.data }, 'WorkSucceeded',
    workResult(laneMachine.WORK.refresh, 'refresh:5', { result: {} }), { facts, now: NOW, source: SERVICE });
  assert.equal(ended.state.data.refresh.running, null);
  // A project asked for: its own refresh soon, at once when asked so.
  const asked = lanePass(laneData(), 'RefreshAsked', facts, { appId: 3, now: true });
  assert.deepEqual(asked.work.map((w) => [w.key, w.input.apps]), [['refresh:2', [3]]], 'that project alone, with no sweep');
});

// ── bot-investigation: through an outage ────────────────────────────────

test('bot-investigation: check-ins that meet a credit outage or a platform failure are asked again and never end it', () => {
  const m = investigationMachine.botInvestigation();
  const send = driver(m, { key: 'investigation:5' });
  const data = {
    id: 5, userId: 9, appId: 3, everyMs: 6 * investigation.HOUR_MS, days: 7, budgetCents: 500, spentCents: 0,
    startedAt: '2026-11-19T08:00:00.000Z', endsAt: '2026-11-26T08:00:00.000Z', n: 1, seq: 1, failures: 2, nextAt: '2026-11-19T10:00:00.000Z',
  };
  let state = { name: 'checking', data };
  let at = Date.parse('2026-11-19T10:00:00Z');
  // Eight check-ins in a row are held: an outage of hours.
  for (let i = 0; i < 8; i += 1) {
    const result = i % 2 ? { ran: true, failed: false, held: 'credit', costCents: 0 } : { skipped: 'credit', ran: false, costCents: 0 };
    const out = send(state, 'WorkSucceeded', workResult(investigationMachine.WORK.checkIn, `checkin:${state.data.seq}`, { result }),
      { source: SERVICE, now: new Date(at) });
    assert.equal(out.state.name, 'waiting', `check-in ${i + 1}: still running`);
    assert.equal(out.state.data.failures, 2, 'the two failures before the outage are neither added to nor cleared');
    assert.equal(out.timer.event.type, 'CheckInDue');
    at = out.timer.at.getTime();
    const next = send(out.state, 'CheckInDue', {}, { source: { kind: 'timer' }, now: new Date(at) });
    assert.equal(next.state.name, 'checking');
    state = next.state;
  }
  // Credit is back and the look fails on its own account: that is the third.
  const failed = send(state, 'WorkSucceeded', workResult(investigationMachine.WORK.checkIn, `checkin:${state.data.seq}`, { result: { ran: true, failed: true, costCents: 3 } }),
    { source: SERVICE, now: new Date(at) });
  assert.equal(failed.state.name, 'ended');
  assert.equal(failed.state.data.endedReason, 'failed');
  // Or it runs clean: the count clears and it carries on.
  const clean = send(state, 'WorkSucceeded', workResult(investigationMachine.WORK.checkIn, `checkin:${state.data.seq}`, { result: { ran: true, failed: false, costCents: 3 } }),
    { source: SERVICE, now: new Date(at) });
  assert.deepEqual({ name: clean.state.name, failures: clean.state.data.failures, spent: clean.state.data.spentCents }, { name: 'waiting', failures: 0, spent: 3 });
});
