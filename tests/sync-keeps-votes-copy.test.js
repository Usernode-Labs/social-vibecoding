'use strict';

// What the agent-facing copy says a "Sync with main" costs a proposal's votes.
//
// Since #2038 votes count by chat_sessions.approval_epoch, not by commit
// (services/pr-vote-revision.js). A clean sync is plain git, so the classifier
// (services/integration.js classifyHeadMove) calls the move `mechanical` and
// the epoch does not move. A conflicted sync whose resolution stays inside the
// files git could not merge is `resolved`, which keeps the approvals too but
// re-runs the checks. Only a resolution that edits anything else is
// `authored` and clears them. The sync_change tool, get_change's nextStep and
// the charter kept saying a sync clears the votes for long after that was
// false, which taught agents to avoid a sync that cost nothing.
//
// The first test pins the policy the copy describes, so a change to which
// head moves keep approvals fails here and sends the author to this copy.
// Copy about AUTHORED updates (submit_work, revising a proposal, taking it out
// of review) still says they clear votes, correctly, and is not pinned here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tools = require('../src/services/mcp-tools');
const charter = require('../src/services/mcp-charter');
const { READ_SCOPE, WRITE_SCOPE } = require('../src/services/mcp-connect-constants');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// The old claim, in every wording it shipped in.
const CLEARS_ON_SYNC = /LOSES the votes|clears? any votes|would clear its votes|revises it and so clears|which is a revision, so it clears/;

test('a mechanical or resolved head move keeps the approvals on both reconcile paths', () => {
  assert.match(read('src/routes/votes.js'),
    /const keepsApprovals = move\.kind === 'mechanical' \|\| move\.kind === 'resolved';/,
    'native proposals: the copy below describes this policy; change both together');
  assert.match(read('src/services/pr-import-sync.js'),
    /const keepsApprovals = upForVote && \(kind === 'mechanical' \|\| kind === 'resolved'\);/,
    'imported proposals: the copy below describes this policy; change both together');
});

test('sync_change says a change up for a vote keeps its votes', () => {
  // sync_change is registered only for an agent session's Mayor
  // (services/mcp-audiences.js), so the recorder carries that delegation.
  const specs = new Map();
  tools.registerTools({
    registerTool(name, spec) { specs.set(name, spec); },
  }, {
    accessToken: 'svmcp_test',
    scopes: [READ_SCOPE, WRITE_SCOPE],
    user: { id: 7, username: 'ada' },
    clientName: 'Claude', clientId: 'c1',
    origin: 'https://usernode.example',
    baseUrl: 'http://platform.internal',
    pool: null, config: {}, tokenId: null, grantId: null,
    delegation: { kind: 'agent_mayor' },
  });
  const description = specs.get('sync_change').description;
  assert.doesNotMatch(description, CLEARS_ON_SYNC);
  assert.match(description, /KEEPS the votes it has collected/);
  assert.match(description, /a clean merge is plain git and changes nothing anyone approved/);
  assert.match(description, /edits only the files that conflicted keeps them too, though the checks run again/);
  assert.match(description, /Only a resolution that edits any other file counts as a revision and clears them/);
});

const KINDS = ['agent_mayor', 'worker_read', 'external'];

function nextStepFor(row, kind) {
  return tools.changeNextStep(row, tools.shapeChecks(row), {}, kind);
}

test('get_change: a change behind main needs no sync, and a clean one keeps its votes', () => {
  const row = {
    id: 4223, pr_number: 2151, status: 'promoted', branch_name: 'usernode/session-4223',
    check_state: 'passing', checks_commit_sha: 'a'.repeat(40),
    behind_main: 3, votes_required: 3, yes_count: 2,
  };
  for (const kind of KINDS) {
    const step = nextStepFor(row, kind);
    assert.match(step, /It is 3 commit\(s\) behind main; that alone needs no sync, and /, kind);
    assert.match(step, /keeps its votes/, kind);
    assert.doesNotMatch(step, /clear/, kind);
  }
});

test('get_change: a conflicted change keeps its votes when the resolution stays inside the conflict', () => {
  const row = {
    id: 4223, pr_number: 2151, status: 'promoted', branch_name: 'usernode/session-4223',
    check_state: 'pending', check_phase: 'deferred',
  };
  for (const kind of ['agent_mayor', 'external']) {
    const step = nextStepFor(row, kind);
    assert.match(step, /held back because it conflicts with main/, kind);
    assert.match(step, /its votes stand as long as the resolution stays inside the files that conflicted/, kind);
    assert.doesNotMatch(step, /clear/, kind);
  }
  // The worker cannot sync; it is told who can, and says nothing about votes.
  assert.match(nextStepFor(row, 'worker_read'), /The Mayor can sync it with main, with the user's confirmation\./);
});

test('the charter says a sync keeps the votes', () => {
  const changes = charter.DELEGATED_CHARTER_SECTIONS.find((s) => s.id === 'agent-mayor-changes');
  assert.doesNotMatch(changes.text, CLEARS_ON_SYNC);
  assert.match(changes.text,
    /sync_change merges the app's latest main into it and keeps any votes it has collected: a clean merge changes nothing anyone approved/);
  assert.match(changes.text, /Only a resolution that edits any other file clears them\./);

  // An external author syncs their own branch and pushes it. Homeroom redoes
  // the merge to tell that apart from new work, and a head it cannot verify
  // (the mirror never saw it) is treated as authored, hence "can confirm".
  const revising = charter.CHARTER_SECTIONS.find((s) => s.id === 'revising-a-proposal');
  assert.doesNotMatch(revising.text, CLEARS_ON_SYNC);
  assert.match(revising.text,
    /resolve anything that conflicts, and push\. That push keeps the votes when Homeroom can confirm, by redoing the merge itself, that it is only the default branch merged in, with any conflict resolved inside the files that conflicted; anything else in it is a revision and clears them\./);
  // Revising the proposal itself still clears them, and says so.
  assert.match(revising.text, /Updating clears the votes the proposal had already collected/);
});
