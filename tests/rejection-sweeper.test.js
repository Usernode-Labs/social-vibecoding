// Sweeper-decision tests for the auto-takedown (rejection) pass.
//
// The takedown is a thin branch over the pure gate: for a proposal in review
// the gate (`mergeGate(...)`) says merge when `gate.mergeable` and take it
// down when `gate.rejectable`. The takedown is the proposal machine's hourly
// ReviewCheck now (it closes the proposal as 'auto-rejected'); the stale-PR
// sweeper's pass that did it is gone. These tests lock that decision
// predicate (the part with all the policy in it) over a matrix of vote splits
// and ages, plus the machine's close and its rejection-specific thread line.
// They use the REAL active-users helpers: no DB or runtime spin-up.
//
// Run with: node --test tests/rejection-sweeper.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeGate } = require('../src/services/active-users');

const DAY = 24 * 60 * 60 * 1000;
const opened = '2026-06-01T00:00:00.000Z';
const openedMs = Date.parse(opened);

// The per-proposal branch over the gate: returns the action taken for it.
function sweepAction(gate) {
  if (gate.mergeable) return 'merge';
  if (gate.rejectable) return 'reject';
  return 'none';
}

test('sweeper would auto-reject a promoted PR once its rejection window elapses', () => {
  // active=20, yes=2, no=3 (slim No majority, under 1/3 support).
  const fresh = mergeGate(20, 2, 3, opened, openedMs + 60 * 1000);
  assert.equal(sweepAction(fresh), 'none', 'inside the window → no takedown yet');

  const aged = mergeGate(20, 2, 3, opened, openedMs + 8 * DAY);
  assert.equal(sweepAction(aged), 'reject', 'window elapsed → archive as auto-rejected');
});

test('sweeper never rejects a kept-alive (>=1/3 Yes) or not-losing PR', () => {
  // Kept alive: 7/20 Yes despite heavy No, even long after opening.
  const keptAlive = mergeGate(20, 7, 12, opened, openedMs + 60 * DAY);
  assert.equal(sweepAction(keptAlive), 'none');

  // Not losing: Yes still ahead. Never rejected — and since the Yes lead is
  // uncontested (4/20 No < 1/3), the lazy-consensus clock has long elapsed,
  // so the sweeper MERGES it (silence is consent) rather than leaving it.
  const ahead = mergeGate(20, 5, 4, opened, openedMs + 60 * DAY);
  assert.notEqual(sweepAction(ahead), 'reject');
  assert.equal(sweepAction(ahead), 'merge');

  // Lone No: below the min-No floor → never arms (and No leads, so the lazy
  // merge clock never arms either) → untouched.
  const loneNo = mergeGate(20, 0, 1, opened, openedMs + 60 * DAY);
  assert.equal(sweepAction(loneNo), 'none');
});

test('sweeper prefers merge over reject when a row is somehow both-eligible', () => {
  // They are mutually exclusive by construction, but the branch order must
  // still favor merge. A clear majority long after opening is mergeable.
  const majority = mergeGate(20, 11, 0, opened, openedMs + 60 * DAY);
  assert.equal(sweepAction(majority), 'merge');
});

// The takedown itself is the proposal machine's hourly ReviewCheck now
// (src/workflow/proposal/machine.ts): the stale-PR sweeper's pass and
// archiveSession's own chat line are gone. The check reads the same gate
// under its lock and, when it is rejectable, closes the proposal as
// 'auto-rejected' with the rejection's own thread line. Driven here through
// the machine's transition table, with no database or runtime.
test('the proposal machine\'s review check closes a voted-down proposal with the rejection\'s own line', () => {
  const { proposal, sessionKey } = require('../src/workflow/proposal/machine.ts');
  const m = proposal({ idleMs: 0, exemptFixtures: false, reviewCheckMs: 60 * 60 * 1000, staleNotifyMs: 0, staleGraceMs: 0 });
  const row = {
    id: 7, appId: 5, appSlug: 'widget', selfHosted: false, repo: null, userId: 3, ownerName: 'alice',
    ownerSynthetic: false, status: 'promoted', imported: false, headless: false, prNumber: 12,
    prTitle: 'Risky change', branch: 'b', head: 'a'.repeat(40), reviewedHead: 'a'.repeat(40), importedHead: null,
    epoch: 1, promotedAt: opened, createdAt: opened, staleNotifiedAt: null, lastActivityAt: opened,
    linkedIssues: [], agentSessionId: null, explicitApproval: false, explicitReason: null, mergeAttemptAt: null,
    shots: false, fixture: false, activeTurn: false, workedOn: false, moving: false, shotsRunning: false,
    buildHold: false, pendingSecret: false,
  };
  const state = {
    name: 'in_review',
    data: { sessionId: 7, appId: 5, imported: false, slot: 'held', promoting: null, answer: null, reason: null,
      claim: null, pr: { running: null, next: [] }, doomed: [], n: 1 },
  };
  const event = { id: 41, type: 'ReviewCheck', payload: {}, source: { kind: 'timer' } };
  const ctx = { now: new Date(openedMs + 8 * DAY), key: sessionKey(7) };
  const run = (gate) => {
    const facts = { row, caps: null, gate, interestAt: null, electorate: null };
    const entry = m.entryFor('in_review', 'ReviewCheck');
    assert.equal(entry.guard(state, event, facts, ctx), true);
    return entry.to(state, event, facts, ctx);
  };

  // active=20, yes=2, no=3, the rejection window elapsed: set aside.
  const out = run(mergeGate(20, 2, 3, opened, openedMs + 8 * DAY));
  assert.equal(out.next.name, 'closed');
  assert.equal(out.next.data.reason, 'auto-rejected');
  const lines = out.writes.filter((w) => w.type === 'line');
  assert.equal(lines.length, 1);
  assert.match(lines[0].content, /set aside for now \(more No than Yes/);
  assert.doesNotMatch(lines[0].content, /withdrew|went quiet/);
  assert.equal(lines[0].sessionId, 7, 'into the proposal\'s own thread');

  // Kept alive (>=1/3 Yes): looked at again in an hour, nothing closed.
  const kept = run(mergeGate(20, 7, 12, opened, openedMs + 60 * DAY));
  assert.equal(kept.next.name, 'in_review');
  assert.ok(!(kept.writes || []).some((w) => w.type === 'line'));
});
