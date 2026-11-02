'use strict';

// An admin's force skips a proposal's checks only on the commit it was given
// on, or one a mechanical merge of main moved it to. It lasts through a
// conflict resolution (M4), but the commit the resolution wrote merges on
// its own green checks. On 2 Nov 2026 a force carried onto a model-resolved
// head merged it 19 seconds later, never checked, and main stopped loading
// its schema migrations (#6138). The machines' end of it, with a database,
// is M11b in tests/workflow-merge-postgres.test.js.
//
// Run with: node --test tests/merge-force-checks.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { claimRefusal, forceWaivesChecks } = require('../src/workflow/rules/merge-claim.ts');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const facts = (over = {}) => ({ checkState: 'passing', checksCommitSha: A, freshSuiteOwed: false, shotsState: null,
  shotsDetail: null, locked: false, adminYes: false, mainPaused: false, ...over });
const inputs = (over = {}) => ({ head: A, force: false, forcedHead: null, shotsEnforced: false, mainPassThrough: false,
  votesMergeable: true, ...over });

test('a force skips the checks on the commit it was given on, whatever they say', () => {
  assert.equal(forceWaivesChecks(true, A, A), true);
  assert.equal(forceWaivesChecks(true, A.toUpperCase(), A), true);
  for (const checkState of ['failing', 'error', 'pending', null]) {
    assert.equal(claimRefusal(facts({ checkState }), inputs({ force: true, forcedHead: A, votesMergeable: false })), null, checkState);
  }
});

test('on any other commit the force still skips the votes and the lock, never the checks', () => {
  assert.equal(forceWaivesChecks(true, A, B), false);
  assert.equal(forceWaivesChecks(false, B, B), false);
  // The commit a resolution wrote: no verdict on it yet, or a verdict about
  // the commit before it.
  for (const f of [facts({ checkState: 'pending', checksCommitSha: B }), facts({ checksCommitSha: A }),
    facts({ checkState: 'failing', checksCommitSha: B })]) {
    assert.equal(claimRefusal(f, inputs({ head: B, force: true, forcedHead: A, votesMergeable: false })), 'checks');
  }
  // Green on that commit: the force merges it with no votes and a locked app.
  assert.equal(claimRefusal(facts({ checksCommitSha: B, locked: true }),
    inputs({ head: B, force: true, forcedHead: A, votesMergeable: false })), null);
  // A force recorded before its commit was: it skips the checks nowhere.
  assert.equal(claimRefusal(facts({ checkState: 'failing' }), inputs({ force: true, forcedHead: null })), 'checks');
});

test('without a force nothing changes: votes, then the lock, then the checks', () => {
  assert.equal(claimRefusal(facts(), inputs({ votesMergeable: false })), 'not_mergeable');
  assert.equal(claimRefusal(facts({ locked: true }), inputs()), 'awaiting_admin');
  assert.equal(claimRefusal(facts({ checkState: 'failing' }), inputs({ forcedHead: A })), 'checks');
  assert.equal(claimRefusal(facts(), inputs()), null);
});
