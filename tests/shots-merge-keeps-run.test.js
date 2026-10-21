// A merge no longer waits for a proposal's before & after shots
// (src/workflow/session-work.ts NOT_MOVING_TURN_MODES), so the proposal can
// leave review while they are taken. The shots machine's Closed then lets
// a merged proposal's run finish, ends a run of a proposal that closed any
// other way, and retries nothing once it is out of review. On 21 Oct 2026
// PR 5787 was declined busy twice while its shots were taken, and merged
// only on an unrelated ask 47 s after they were published.
//
// The transitions themselves, without a database; the same paths against
// PostgreSQL are tests/workflow-shots-postgres.test.js S10/S10b and
// tests/workflow-merge-postgres.test.js M30.
//
// Run with: node --test tests/shots-merge-keeps-run.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { shots, WORK, MACHINE } = require('../src/workflow/shots/machine.ts');
const { NOT_MOVING_TURN_MODES, movingTurnSql } = require('../src/workflow/session-work.ts');

const SHA = (c) => c.repeat(40);
const machine = shots({ execute: true, agentBudgetMs: 480000, runBudgetMs: 1440000 });
const now = new Date('2026-10-21T17:42:00Z');
const ctx = { now, key: 'session:42' };

function liveState(name, { dispatches = 1 } = {}) {
  const run = {
    id: 'run-1', n: 1, head: SHA('a'), base: SHA('0'), trigger: 'preview-ready', startedAt: '2026-10-21T17:39:30Z',
    busy: 0, died: 0, dispatches, copiesAt: '2026-10-21T17:40:19Z', agentStartedAt: '2026-10-21T17:40:19Z',
    agentWaitUntil: null, platformRetry: false, afterOnly: false,
  };
  return { name, data: {
    sessionId: 42, appId: 10, appSlug: 'usernode-2d5619', declared: { intent: { version: 1 }, required: true },
    head: SHA('a'), run, last: null, n: 1, cleaning: [],
  } };
}
const facts = (status) => ({ session: { id: 42, appId: 10, appSlug: 'usernode-2d5619', status, source: null, head: SHA('a'),
  pins: { imported: null, reviewed: SHA('a'), handoff: null }, readyHeads: [SHA('a')], agentBusy: false,
  slot: { state: null, runId: null, detail: null, run: null }, temporaryWorker: false } });
const event = (type, payload) => ({ id: 7, type, payload: { sessionId: 42, ...payload },
  source: { kind: 'message', from: { machine: 'preview', key: 'session:42' } } });
const apply = (s, e, f) => machine.entryFor(s.name, e.type).to(s, e, f, ctx);

test('merged while its shots are taken: the run goes on, its clock and work untouched', () => {
  for (const name of ['building_copies', 'waiting_for_agent', 'taking_shots', 'publishing']) {
    const s = liveState(name);
    const out = apply(s, event('Closed', { reason: 'merged' }), facts('merged'));
    assert.equal(out.next, s, `${name}: nothing changes`);
    assert.equal(out.cancel, undefined, `${name}: no work is cancelled`);
    assert.equal(out.timer, undefined, `${name}: its deadline is kept`);
    assert.equal(out.writes, undefined, `${name}: nothing is said on the slot`);
  }
});

test('closed any other way: the run ends as today, its work cancelled and its copies cleaned', () => {
  const s = liveState('taking_shots');
  const out = apply(s, event('Closed', { reason: 'archived' }), facts('archived'));
  assert.equal(out.next.name, 'closed');
  assert.equal(out.next.data.run, null);
  assert.ok(out.cancel.some((w) => w.kind === WORK.agent && w.key === 'agent:1:1'), 'its agent turn is cancelled');
  assert.ok(out.work.some((w) => w.kind === WORK.cleanup), 'its copies go');
  const moved = out.writes.find((w) => w.type === 'runMoved');
  assert.deepEqual([moved.state, moved.patch.failureCode], ['failed', 'shots_closed']);
});

test('a merged proposal\'s run that the platform fails is not retried; one in review is', () => {
  const agentFailed = event('WorkSucceeded', { kind: WORK.agent, workKey: 'agent:1:1',
    result: { agent: { outcome: 'failed', code: 'shots_agent_failed', message: 'exited', fault: 'agent_exit' }, passed: false, skippedAny: false } });
  agentFailed.source = { kind: 'service', workId: 'w1' };
  const merged = apply(liveState('taking_shots'), agentFailed, facts('merged'));
  assert.equal(merged.next.name, 'failed');
  assert.equal(merged.timer, null, 'no automatic retry once out of review');
  assert.equal(merged.next.data.last.retryAt, null);
  const inReview = apply(liveState('taking_shots'), agentFailed, facts('promoted'));
  assert.equal(inReview.next.name, 'failed');
  assert.equal(inReview.timer.event.type, 'RetryDue', 'a platform fault is taken again once while in review');
});

test('only the shots agent\'s turn is exempt, and only for the merge queue\'s ask', () => {
  assert.equal(MACHINE, 'shots');
  assert.deepEqual([...NOT_MOVING_TURN_MODES], ['shots']);
  const sql = movingTurnSql('cs');
  assert.match(sql, /cs\.active_turn IS NOT NULL/);
  assert.match(sql, /COALESCE\(cs\.active_turn->>'mode', ''\) NOT IN \('shots'\)/);
  assert.throws(() => movingTurnSql('cs; DROP'), /bad alias/);
  const factsSrc = fs.readFileSync(path.join(__dirname, '../src/workflow/proposal/facts.ts'), 'utf8');
  assert.match(factsSrc, /\$\{movingTurnSql\('cs'\)\} AS moving_turn/);
  assert.match(factsSrc, /mergeMoving: !!r\.moving_turn \|\| !!r\.local_turn \|\| !!r\.moving_operations/);
  assert.match(factsSrc, /moving: !!r\.active_turn \|\| !!r\.local_turn \|\| !!r\.moving_operations/,
    'a promote, an unpromote and a sync still wait for the shots agent\'s turn');
  const machineSrc = fs.readFileSync(path.join(__dirname, '../src/workflow/proposal/machine.ts'), 'utf8');
  const ask = machineSrc.slice(machineSrc.indexOf('function askRefusal'), machineSrc.indexOf('const mergeRequested'));
  assert.match(ask, /if \(f\.row!\.mergeMoving\) return 'busy';/, 'only the merge ask reads mergeMoving');
  assert.doesNotMatch(ask, /moving\(f\.row!\)/);
});
