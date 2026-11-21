'use strict';

// T1.1 / T1.2 (architecture pass, 19 Nov 2026): the bot's own retries owed
// from inside the work under way, and a build's credit 402.
//
// #6859's plan retry (homeroom-bot.js queuePlanRetry) and #6867's credit
// wait (announceBuilt) are owed from inside the build, while the request's
// instance is `building`. bot-request dropped every debt with a priority
// other than 0 there unless it was a checks fix or a voice update, so the
// one retry and "picks this up again by itself" never happened (request
// #6864, 19 Nov). Pinned here on the machine itself, without a database:
// the debts are kept while the instance builds or reads, taken once the
// work ends, after their own wait; the refresh's own finds are still
// dropped; and a build that ran out of credit pauses the lane.
//
// Run with: node --test tests/bot-request-own-retries.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../src/workflow/rules/bot-loop.ts');
const requestMachine = require('../src/workflow/bot-request/machine.ts');
const buildMachine = require('../src/workflow/bot-build/machine.ts');

const APP = 101;
const ISSUE = 7;
const RUN = 900;
const CTX = (now) => ({ machine: requestMachine.MACHINE, key: rules.requestKey(APP, ISSUE), appId: APP, version: 2, now: new Date(now) });
const event = (type, payload, source = { kind: 'system', name: 'test' }) => ({
  id: 1, type, payload, source, actor: null, requestKey: 'k', appId: APP, causedBy: null,
});
const fromBuild = { kind: 'message', from: { machine: 'bot-build', key: `run:${RUN}` } };

function building(more = {}) {
  return {
    name: 'building',
    data: {
      appId: APP, issueNumber: ISSUE, owed: null, look: null, n: 1, b: 1, backoff: null, fix: null, spentRetry: null,
      lastRead: null, carried: null, slot: { grant: 4, kind: 'build', person: 'u7', appId: APP },
      build: { runId: RUN, phase: 'running', since: '2026-11-19T09:00:00.000Z', key: `run:${RUN}@w1` },
      ...more,
    },
  };
}

const machine = requestMachine.botRequest({ staging: false });
const run = (state, type, payload, at, source) => {
  const e = event(type, machine.events.get(type)(payload), source);
  return machine.entryFor(state.name, type).to(state, e, {}, CTX(at));
};
const owe = (state, payload, at) => run(state, 'Owed', { appId: APP, issueNumber: ISSUE, ...payload }, at);
const ended = (state, payload, at) => run(state, 'BuildEnded', { id: RUN, outcome: 'done', ...payload }, at, fromBuild);
const toLane = (out, type) => (out.messages || []).filter((m) => m.to?.machine === rules.BOT_LANE && m.event.type === type);

test('a plan retry owed while the request builds is kept, then taken after the build, after its own wait', () => {
  const kept = owe(building(), { reason: rules.PLAN_RETRY_REASON, priority: 2, waitMs: 3 * 60 * 1000 }, '2026-11-19T10:00:00Z');
  assert.equal(kept.next.name, 'building', 'the build goes on');
  assert.equal(kept.next.data.owed?.reason, rules.PLAN_RETRY_REASON, 'kept, not dropped');
  assert.equal(kept.next.data.owed.notBefore, '2026-11-19T10:03:00.000Z', 'its wait counts from when it was owed');
  // The reply its caller reads (queuePlanRetry) says it is owed.
  return Promise.resolve(machine.reply(null, event('Owed', {}), kept.next)).then((reply) => {
    assert.equal(reply.queued, false);
    assert.equal(reply.owed, true, 'queuePlanRetry reads this as "trying again"');
    // The build ends a minute later: queued, held until its wait is over.
    const after = ended(kept.next, {}, '2026-11-19T10:01:00Z');
    assert.equal(after.next.name, 'queued');
    assert.equal(after.next.data.owed.reason, rules.PLAN_RETRY_REASON);
    assert.ok(!('notBefore' in after.next.data.owed), 'its wait moved onto the backoff the queue row says');
    assert.equal(after.next.data.backoff.until, '2026-11-19T10:03:00.000Z');
    assert.equal(after.next.data.backoff.reason, rules.PLAN_RETRY_REASON);
    assert.equal(after.timer?.event?.type, 'Due', 'its clock is set for the wait');
    assert.equal(after.timer.at.toISOString(), '2026-11-19T10:03:00.000Z');
    assert.equal(toLane(after, 'Released').length, 1);
    assert.deepEqual(toLane(after, 'Released')[0].event.payload, { ran: true }, 'a build that ran out of nothing pauses nothing');
    assert.equal(toLane(after, 'Look').length, 1, 'the lane hears it is owed');
  });
});

test('a plan retry whose wait passed while the build ran is taken at once', () => {
  const kept = owe(building(), { reason: rules.PLAN_RETRY_REASON, priority: 2, waitMs: 3 * 60 * 1000 }, '2026-11-19T10:00:00Z');
  const after = ended(kept.next, {}, '2026-11-19T10:30:00Z');
  assert.equal(after.next.name, 'queued');
  assert.equal(after.next.data.backoff, null, 'nothing holds it');
  assert.equal(after.timer, null);
});

test('a credit wait owed from a build that ran out of credit is kept, and the build\'s end pauses the lane', () => {
  const kept = owe(building(), { reason: rules.CREDIT_WAIT_REASON, priority: 2 }, '2026-11-19T10:00:00Z');
  assert.equal(kept.next.data.owed?.reason, rules.CREDIT_WAIT_REASON);
  assert.ok(!kept.next.data.owed.notBefore, 'no wait of its own: the lane\'s pause holds it');
  const after = ended(kept.next, { credit: true }, '2026-11-19T10:00:05Z');
  assert.equal(after.next.name, 'queued', 'owed again, for when credit is back');
  assert.deepEqual(toLane(after, 'Released')[0].event.payload, { ran: true, credit: true }, 'the lane starts nothing until CreditBack');
});

test('the refresh\'s own finds are still dropped while the request builds or reads', () => {
  for (const reason of ['changed', 'new', 'backlog']) {
    const out = owe(building(), { reason, priority: 2 }, '2026-11-19T10:00:00Z');
    assert.equal(out.next.data.owed, null, `${reason}: read again by the next refresh`);
  }
  const reading = {
    name: 'reading',
    data: { ...building().data, build: null, look: { n: 2, kind: 'read', sessionId: 5, owed: { reason: 'changed', priority: 2 }, startedAt: '2026-11-19T09:59:00Z', interrupted: false } },
  };
  assert.equal(owe(reading, { reason: 'changed', priority: 2 }, '2026-11-19T10:00:00Z').next.data.owed, null);
  const retry = owe(reading, { reason: rules.PLAN_RETRY_REASON, priority: 2, waitMs: 60_000 }, '2026-11-19T10:00:00Z');
  assert.equal(retry.next.data.owed?.reason, rules.PLAN_RETRY_REASON, 'the bot\'s own retry is kept during a read too');
});

test('a person\'s ask is never held by a retry\'s wait', () => {
  const asked = owe(building(), { reason: 'dm_answer', priority: 0 }, '2026-11-19T10:00:00Z');
  const both = owe(asked.next, { reason: rules.PLAN_RETRY_REASON, priority: 2, waitMs: 3 * 60 * 1000 }, '2026-11-19T10:00:10Z');
  assert.equal(both.next.data.owed.reason, 'dm_answer', 'the person\'s ask keeps its place');
  assert.ok(!both.next.data.owed.notBefore, 'and no wait');
  const after = ended(both.next, {}, '2026-11-19T10:00:20Z');
  assert.equal(after.next.data.backoff, null);
  assert.equal(after.timer, null);
});

test('bot-build tells its request a build ended on credit', () => {
  const m = buildMachine.botBuild();
  const replyTo = { machine: requestMachine.MACHINE, key: rules.requestKey(APP, ISSUE) };
  const s = { name: 'building', data: { target: 'live', id: RUN, nonce: null, replyTo, requestedAt: '2026-11-19T09:00:00Z' } };
  const done = (result) => m.entryFor('building', 'WorkSucceeded').to(s,
    event('WorkSucceeded', { kind: buildMachine.WORK.run, workKey: 'run', result }), {}, { now: new Date('2026-11-19T10:00:00Z') });
  const credit = done({ acted: 'credit_wait', creditOut: true });
  assert.equal(credit.messages[0].event.type, 'BuildEnded');
  assert.equal(credit.messages[0].event.payload.credit, true);
  const plain = done({ acted: 'proposed' });
  assert.ok(!('credit' in plain.messages[0].event.payload));
  // And the request's instance decodes it.
  assert.equal(machine.events.get('BuildEnded')({ id: RUN, credit: true }).credit, true);
  assert.equal(machine.events.get('BuildEnded')({ id: RUN }).credit, false);
});

test('a person\'s Stop of a build records who stopped it', () => {
  const m = buildMachine.botBuild();
  const s = { name: 'building', data: { target: 'live', id: RUN, nonce: null, replyTo: null, requestedAt: '2026-11-19T09:00:00Z' } };
  const out = m.entryFor('building', 'StopRequested').to(s, event('StopRequested', { sessionId: 5, by: 'ada' }, { kind: 'route' }),
    { sessionId: 5 }, { key: `run:${RUN}`, now: new Date('2026-11-19T10:00:00Z') });
  const lost = out.work.find((w) => w.kind === buildMachine.WORK.lost);
  assert.deepEqual(lost.input.error, { message: 'Stopped by ada', code: 'stopped', by: 'ada' });
});

// ── Smaller points in the machines (review of 19 Nov 2026) ──────────────

const ASK = { reason: 'reply', priority: 0, payer: 21, requestedBy: 21, changedBy: null, threadSeenAt: null, enqueuedAt: '2026-11-19T10:00:30.000Z', heldUntil: null };
function reading(more = {}) {
  const lookOwed = { reason: 'reply', priority: 0, payer: 7, requestedBy: 7, changedBy: null, threadSeenAt: null, enqueuedAt: '2026-11-19T09:59:00.000Z', heldUntil: null };
  return {
    name: 'reading',
    data: {
      appId: APP, issueNumber: ISSUE, owed: null, build: null, n: 3, b: 0, backoff: null, fix: null, spentRetry: null,
      lastRead: null, carried: null, slot: { grant: 9, kind: 'read', person: 'u7', appId: APP, readSlot: 0 },
      look: { n: 3, kind: 'read', sessionId: 55, owed: lookOwed, startedAt: '2026-11-19T10:00:00.000Z', interrupted: false },
      ...more,
    },
  };
}
const stop = (state, payload, at) => run(state, 'StopRequested', { sessionId: 55, ...payload }, at, { kind: 'route', name: 'stop' });

test('a person\'s Stop of a look keeps another person\'s ask that arrived while it ran', () => {
  // Sam (21) asked while Ada's (7) look ran; Ada stops her look.
  const out = stop(reading({ owed: ASK }), { by: 'ada', byId: 7 }, '2026-11-19T10:01:00Z');
  assert.equal(out.next.name, 'queued', 'Sam\'s ask is looked at next');
  assert.deepEqual(out.next.data.owed, ASK);
  assert.equal(out.next.data.look, null, 'the look ended');
  assert.equal(toLane(out, 'Released').length, 1);
  assert.equal(toLane(out, 'Look').length, 1, 'and the lane hears it is owed');
  assert.ok(out.cancel.some((c) => c.key === 'look:3'), 'the stopped look\'s work is cancelled');
  // The stopper's own ask made meanwhile goes with the Stop, as before.
  const own = stop(reading({ owed: { ...ASK, requestedBy: 7, payer: 7 } }), { by: 'ada', byId: 7 }, '2026-11-19T10:01:00Z');
  assert.equal(own.next.name, 'idle');
  assert.equal(own.next.data.owed, null);
  // A debt that is nobody's ask (the bot's own, a refresh's) goes too.
  const bots = stop(reading({ owed: { ...ASK, priority: 2, reason: rules.PLAN_RETRY_REASON, requestedBy: null } }), { by: 'ada', byId: 7 }, '2026-11-19T10:01:00Z');
  assert.equal(bots.next.data.owed, null);
  // A Stop that does not say whose it was (an older release's) drops all, as it did.
  const unknown = stop(reading({ owed: ASK }), { by: 'ada' }, '2026-11-19T10:01:00Z');
  assert.equal(unknown.next.data.owed, null);
});

function queuedState(more = {}) {
  return {
    name: 'queued',
    data: {
      appId: APP, issueNumber: ISSUE, owed: null, look: null, build: null, slot: null, n: 3, b: 0, backoff: null, fix: null,
      spentRetry: null, lastRead: null, carried: null, ...more,
    },
  };
}

test('queued: a debt with its own wait never delays a person\'s ask already waiting, nor resets a back-off', () => {
  // A person's ask waits; the bot's own plan retry arrives with a 3-minute wait.
  const waiting = queuedState({ owed: ASK });
  const merged = owe(waiting, { reason: rules.PLAN_RETRY_REASON, priority: 2, waitMs: 3 * 60 * 1000 }, '2026-11-19T10:02:00Z');
  assert.equal(merged.next.data.owed.priority, 0, 'the ask is still what is owed');
  assert.equal(merged.next.data.backoff, null, 'and nothing holds it back');
  assert.equal(merged.timer, null);
  // A back-off from two platform faults stands until 10:30; a 3-minute wait
  // neither shortens it nor resets its count.
  const backed = queuedState({
    owed: { ...ASK, priority: 2, reason: 'refresh', requestedBy: null },
    backoff: { failures: 2, until: '2026-11-19T10:30:00.000Z', reason: 'platform' },
  });
  const kept = owe(backed, { reason: rules.CREDIT_WAIT_REASON, priority: 2, waitMs: 3 * 60 * 1000 }, '2026-11-19T10:02:00Z');
  assert.deepEqual(kept.next.data.backoff, { failures: 2, until: '2026-11-19T10:30:00.000Z', reason: 'platform' });
  // With nothing standing, the debt's own wait holds it, as before (#6859).
  const fresh = owe(queuedState(), { reason: rules.PLAN_RETRY_REASON, priority: 2, waitMs: 3 * 60 * 1000 }, '2026-11-19T10:02:00Z');
  assert.equal(fresh.next.data.backoff.until, '2026-11-19T10:05:00.000Z');
  assert.equal(fresh.next.data.backoff.failures, 0);
  assert.equal(fresh.timer.at.toISOString(), '2026-11-19T10:05:00.000Z');
});

test('queued: a person\'s ask clears a back-off as it clears a hold', () => {
  const backed = queuedState({
    owed: { ...ASK, priority: 2, reason: 'refresh', requestedBy: null, heldUntil: '2026-11-19T11:00:00.000Z', heldFor: 'cooldown' },
    backoff: { failures: 5, until: '2026-11-19T10:45:00.000Z', reason: 'platform' },
  });
  const asked = owe(backed, { reason: 'reply', priority: 0, requestedBy: 21, payer: 21 }, '2026-11-19T10:02:00Z');
  assert.equal(asked.next.name, 'queued');
  assert.equal(asked.next.data.owed.priority, 0);
  assert.equal(asked.next.data.owed.heldUntil, null, 'the hold is gone');
  assert.equal(asked.next.data.backoff, null, 'and so is the back-off');
  assert.equal(asked.timer, null, 'nothing to wait for');
  assert.equal(toLane(asked, 'Look').length, 1, 'the lane looks now');
});
