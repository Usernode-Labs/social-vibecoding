'use strict';

// 14 Oct 2026 (#5162's follow-up): never evict a worker under a durable build.
//
// #5162 made ensureWorker keep a worker on an old image while a durable build
// holds its session (services/build-runs.js holdsSession: the session's
// workflow_owner set and its build still 'building'), and flagged a risk it
// did not test. When a release replaces a process, the draining process
// forgets its idle warm workers (server.js cleanup) and the new leader
// adopts them (adoptOrphanWorker, which keeps a durable build's worker).
// The new process's own sweeps could then stop the worker a DRAINING
// process's build is still using between its turns: the idle eviction (idle
// 10 minutes) and the idle pause (idle minutes, then the pause destroys the
// worker). Idle workers are the worker-eviction clock's now
// (services/worker-eviction.js), one for every process, read from
// session_workers. The idle pause is the proposal machine's
// IdleCheck now (src/workflow/proposal/machine.ts), which reads the build's
// hold under the session's lock with everything else it decides on; slot
// eviction is the same machine's Pause guard (P8 in
// tests/workflow-proposal-postgres.test.js).
//
// Pinned here: the worker-eviction clock never evicts a worker a durable
// build holds (its candidates exclude what session-work.ts workedOnSql
// reads, the build's hold included: tests/worker-eviction-postgres.test.js
// drives it), and the idle check's own decision, driven as the pure
// transition it is.
//
// Run with: node --test tests/durable-build-worker-sweeps.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';
require('./platform-keys').setPlatformKeys();

const MIN = 60 * 1000;
const NOW = Date.parse('2026-10-14T12:00:00Z');
const idleFor = (min) => NOW - min * MIN;

// The idle pause: the proposal machine's IdleCheck, a timer's event to a
// session holding its slot. Idle past the window, it pauses (its worker is
// destroyed as the pause's work); held by a durable build, it waits and
// looks again a minute on, as it does while somebody works on it.
test('the idle check leaves a session a durable build holds, and pauses the others', () => {
  const { proposal, WORK, IDLE_RECHECK_MS } = require('../src/workflow/proposal/machine.ts');
  const machine = proposal({ idleMs: 5 * MIN, exemptFixtures: false, reviewCheckMs: 60 * MIN, staleNotifyMs: 0, staleGraceMs: 0 });
  const now = new Date(NOW);
  const idleCheck = (row) => {
    const s = { name: 'underway', data: {
      sessionId: row.id, appId: 1, imported: false, slot: 'held', promoting: null, answer: null, reason: null,
      claim: null, pr: { running: null, next: null }, n: 0 } };
    const event = { id: 1, type: 'IdleCheck', payload: {}, source: { kind: 'timer' } };
    const f = { row: { id: row.id, appId: 1, appSlug: 'shop', lastActivityAt: new Date(idleFor(10)).toISOString(),
      activeTurn: false, workedOn: false, moving: false, shotsRunning: false, buildHold: false, fixture: false, ...row } };
    const entry = machine.entryFor('underway', 'IdleCheck');
    assert.equal(entry.guard(s, event, f, { now }), true);
    return entry.to(s, event, f, { now });
  };
  const held = idleCheck({ id: 51, buildHold: true });
  assert.equal(held.next.data.slot, 'held', 'a durable build keeps its session\'s slot');
  assert.deepEqual(held.work || [], [], 'and its worker');
  assert.equal(held.timer.event.type, 'IdleCheck');
  assert.equal(held.timer.at.getTime(), NOW + IDLE_RECHECK_MS, 'it looks again a minute on');
  for (const id of [52, 53]) {
    const idle = idleCheck({ id });
    assert.equal(idle.next.data.slot, 'released', 'an idle session nobody holds gives its slot back');
    assert.deepEqual(idle.work.map((w) => w.kind), [WORK.destroy]);
  }
  // Not idle long enough: nothing yet, looked at again when it may be.
  const fresh = idleCheck({ id: 54, lastActivityAt: new Date(idleFor(2)).toISOString() });
  assert.equal(fresh.next.data.slot, 'held');
  assert.equal(fresh.timer.at.getTime(), idleFor(2) + 5 * MIN);
  // The hold is read under the session's lock with the rest of its facts.
  const facts = fs.readFileSync(path.join(__dirname, '..', 'src/workflow/proposal/facts.ts'), 'utf8');
  assert.match(facts, /buildHoldSql\(/);
});

test('no sweep stops a worker a durable build holds: the eviction clock reads its hold; adoption keeps its worker', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // Nothing in server.js evicts an idle worker or pauses a session: idle
  // workers are the worker-eviction clock's, and every session holding a
  // slot is the proposal machine's from its INSERT (the wf_enrol_proposal
  // trigger, src/db/schema.sql); the machine's idle check is the pause.
  assert.doesNotMatch(src, /sweepIdleWarmWorkers|startIdleEvictionSweeper|sweepLeftWarmWorkers|forgetWorker/);
  assert.doesNotMatch(src, /autoPauseIdleSessions/);
  assert.doesNotMatch(src, /adoptProposals|startSessionAutoPauseSweeper/, 'no leader pass adopts or pauses');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src/db/schema.sql'), 'utf8');
  assert.match(schema, /CREATE TRIGGER chat_sessions_wf_enrol_proposal\n {2}AFTER INSERT ON chat_sessions\n {2}FOR EACH ROW\n {2}WHEN \(NEW\.status IN \('active', 'promoted', 'merging'\)\)\n {2}EXECUTE FUNCTION wf_enrol_proposal\(\);/);
  const platform = fs.readFileSync(path.join(__dirname, '..', 'src/workflow/platform.ts'), 'utf8');
  assert.match(platform, /\['proposals', \(\) => adoptProposals\(\)\],/);
  // The clock's candidates leave out whatever works on the session, a
  // durable build's hold among them.
  const eviction = fs.readFileSync(path.join(__dirname, '..', 'src/services/worker-eviction.js'), 'utf8');
  assert.match(eviction, /AND NOT \$\{workedOnSql\(\)\}/);
  const work = fs.readFileSync(path.join(__dirname, '..', 'src/workflow/session-work.ts'), 'utf8');
  assert.match(work.slice(work.indexOf('export function workedOnSql(')), /OR \$\{buildHoldSql\('cs'\)\}/);
  // Adoption keeps a durable build's worker as it is
  // (tests/homeroom-bot-restart-recovery.test.js).
  // (Moved out of server.js unchanged: services/turn-recovery.js. A turn's
  // own item adopts with `owned`, past this check: services/turns.js.)
  const recovery = fs.readFileSync(path.join(__dirname, '..', 'src/services/turn-recovery.js'), 'utf8');
  const adopt = recovery.slice(recovery.indexOf('async function adoptOrphanWorker('));
  assert.match(adopt.slice(0, 6000), /if \(session\.workflow_owned && !owned\) \{\s*if \(containerState === 'running'\) worker\.adoptWarmWorker\(sessionId, containerName\);/);
});
