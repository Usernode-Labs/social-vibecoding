'use strict';

// 20 Nov 2026 (live-draft review, C): what the chat's turn is told about a
// live draft that is up for a vote (homeroom-bot-mayor.js draftThreadLines),
// and about a thread that holds both an artifact and a draft: which is
// which, which one is open on their screen, and that a change after Propose
// reaches the proposal only through Update proposal.

const test = require('node:test');
const assert = require('node:assert/strict');

const mayor = require('../src/services/homeroom-bot-mayor');
const liveDrafts = require('../src/services/live-drafts');

const open = { id: 4, state: 'open', app_name: 'Gym Tracker', app_slug: 'gym' };
const proposed = { ...open, state: 'proposed', proposal_session_id: 50, proposal_pr_number: 142, pending_edits: 2 };

test('an open draft is told as before', () => {
  const lines = mayor.draftThreadLines(open).join('\n');
  assert.match(lines, /A live draft of Gym Tracker is open beside this thread/);
  assert.doesNotMatch(lines, /up for a vote|Update proposal/);
});

test('a proposed draft is still this thread\'s draft: changes go into it, and reach the proposal only by Update proposal', () => {
  const lines = mayor.draftThreadLines(proposed).join('\n');
  assert.match(lines, /up for a vote as PR #142/);
  assert.match(lines, /never into an artifact and never as a\s+new draft/);
  assert.match(lines, /tap Update proposal in the preview's header, which clears the proposal's votes/);
  assert.match(lines, /Say that once/);
  assert.match(lines, /You never update or propose it\s+yourself/);
  assert.match(lines, /2 changes are not in the proposal yet/);
  assert.match(mayor.draftThreadLines({ ...proposed, pending_edits: 0 }).join('\n'), /every change in the draft so far/);
  // A draft proposed before this (its own session was the proposal) is not one.
  assert.equal(liveDrafts.editable({ state: 'proposed', proposal_session_id: null }), false);
  assert.equal(liveDrafts.editable(proposed), true);
});

test('a thread with an artifact and a draft says which is which, and which is open', () => {
  const design = { title: 'Gym Tracker style directions' };
  const both = mayor.draftThreadLines(proposed, { design }).join('\n');
  assert.match(both, /also holds an artifact, "Gym Tracker style directions": a page you wrote, not the app/);
  assert.match(both, /names which one it changed/);
  assert.doesNotMatch(both, /open beside the chat now:/, 'nothing said about what is open when the screen did not say');
  assert.match(mayor.draftThreadLines(proposed, { design, showing: { liveDraftId: 4 } }).join('\n'),
    /They have the app's live preview open beside the chat now/);
  assert.match(mayor.draftThreadLines(proposed, { design, showing: { artifactId: 9 } }).join('\n'),
    /They have the artifact "Gym Tracker style directions" open/);
});

test('describe says the proposal and how many changes are not in it yet', () => {
  const d = liveDrafts.describe({
    ...proposed, root_message_id: 9, session_id: 5, edits: 5, head_sha: 'c'.repeat(40), proposed_head_sha: 'a'.repeat(40),
    proposal_status: 'promoted', live_state: 'live',
  });
  assert.deepEqual(d.proposal, { sessionId: 50, prNumber: 142, open: true, pending: 2, headSha: 'a'.repeat(40) });
  assert.deepEqual([d.state, d.editable, d.prNumber], ['proposed', true, 142]);
  assert.equal(liveDrafts.describe({ ...proposed, root_message_id: 9, proposal_status: 'merged' }).proposal.open, false);
});
