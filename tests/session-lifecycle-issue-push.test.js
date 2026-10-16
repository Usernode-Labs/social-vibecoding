// A close (archiveSession) and a reopen (unarchiveSession) must fire an
// issue_update when the session carries linked_issues: that broadcast is
// what clears (or restores) the issue list's derived "In progress" chip on
// every open Dev panel the moment a session is withdrawn, auto-rejected or
// stale-swept (all of which are one close) or brought back. With no linkage
// there is nothing to repaint, so no broadcast fires.
//
// Both moves are the proposal machine's now (src/workflow/proposal/
// machine.ts), and the broadcast is one of its transition's pushes, which
// the kernel publishes in the move's transaction. So this suite drives the
// machine's transitions as the pure functions they are: the close from
// review, the reopen from closed, each with and without linked issues.
// tests/workflow-proposal-postgres.test.js (P13) holds the same push end to
// end against the full schema.
//
// Run with: node --test tests/session-lifecycle-issue-push.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const { proposal } = require('../src/workflow/proposal/machine.ts');

const machine = proposal({ idleMs: 0, exemptFixtures: false, reviewCheckMs: 60 * 60 * 1000, staleNotifyMs: 0, staleGraceMs: 0 });

function row(over = {}) {
  return {
    id: 5, appId: 1, appSlug: 'demo', selfHosted: false, repo: null, userId: 7, ownerName: 'tester',
    ownerSynthetic: false, status: 'promoted', imported: false, headless: false, prNumber: null, prTitle: null,
    branch: 'dev/tester', head: null, reviewedHead: null, importedHead: null, epoch: 0, promotedAt: null,
    createdAt: '2026-10-01T00:00:00Z', staleNotifiedAt: null, lastActivityAt: null, linkedIssues: [],
    agentSessionId: null, explicitApproval: false, explicitReason: null, mergeAttemptAt: null, shots: false,
    fixture: false, activeTurn: false, workedOn: false, moving: false, shotsRunning: false, buildHold: false,
    pendingSecret: false,
    ...over,
  };
}

function state(name, over = {}) {
  return {
    name,
    data: {
      sessionId: 5, appId: 1, imported: false, slot: 'none', promoting: null, answer: null,
      reason: name === 'closed' ? 'manual' : null, claim: null, pr: { running: null, next: null }, n: 3, ...over,
    },
  };
}

const ctx = { now: new Date('2026-10-16T12:00:00Z'), key: 'session:5' };

// Runs `type` from `s` with the row as its facts: the guard must let it
// through, and the transition's pushes are what it broadcasts.
function run(s, type, payload, facts) {
  const event = { id: 99, type, payload: { sessionId: 5, ...payload }, source: { kind: 'route', name: 'test' } };
  const entry = machine.entryFor(s.name, type);
  assert.strictEqual(entry.guard(s, event, facts, ctx), true, `${type} from ${s.name} is allowed`);
  return entry.to(s, event, facts, ctx);
}

const issueUpdates = (out) => (out.push || []).filter((p) => p.data && p.data.type === 'issue_update');
const sessionUpdates = (out) => (out.push || []).filter((p) => p.data && p.data.type === 'session_update');

test('a close broadcasts an issue_update when linked_issues is non-empty', () => {
  const out = run(state('in_review'), 'Close', { from: 'promoted', reason: 'manual', userId: null },
    { row: row({ linkedIssues: [4, 9] }) });
  assert.strictEqual(out.next.name, 'closed');
  assert.strictEqual(sessionUpdates(out).length, 1);
  const [push] = issueUpdates(out);
  assert.ok(push, 'an issue_update is pushed');
  assert.strictEqual(issueUpdates(out).length, 1);
  assert.strictEqual(push.data.action, 'updated');
  assert.strictEqual(push.data.source, 'session_archived');
  assert.strictEqual(push.data.appSlug, 'demo');
  assert.strictEqual(push.data.appId, 1);
});

test('a close stays silent on the issue channel with no linkage', () => {
  const out = run(state('in_review'), 'Close', { from: 'promoted', reason: 'manual', userId: null }, { row: row() });
  assert.strictEqual(out.next.name, 'closed');
  assert.strictEqual(sessionUpdates(out).length, 1, 'session update still fires');
  assert.strictEqual(issueUpdates(out).length, 0, 'no issue update without linked issues');
});

test('a reopen broadcasts an issue_update when linked_issues is non-empty', () => {
  const out = run(state('closed'), 'Reopen', { from: 'archived', userId: 7 },
    { row: row({ status: 'archived', linkedIssues: [4] }) });
  assert.strictEqual(out.next.name, 'underway');
  assert.strictEqual(issueUpdates(out).length, 1);
  assert.strictEqual(issueUpdates(out)[0].data.source, 'session_unarchived');
});

test('a reopen stays silent on the issue channel with no linkage', () => {
  const out = run(state('closed'), 'Reopen', { from: 'archived', userId: 7 }, { row: row({ status: 'archived' }) });
  assert.strictEqual(out.next.name, 'underway');
  assert.strictEqual(issueUpdates(out).length, 0);
});
