// Tests for the proposal-state issue icon (#250): issue cards on the Dev
// page swap their amber chip for a sky document chip when a headless
// auto-solve run is generating (pulsing) or ready (steady). app-view.js
// has no DOM harness, so these are regex-over-source invariants in the
// style of app-conventions.test.js — cheap insurance against the icon
// branch being lost in a future refactor of _renderIssueRow.
//
// Run with: node --test tests/issue-proposal-icon.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf-8'
);

test('DEV_CARD_ICONS carries an issueProposal entry with the sky tint', () => {
  assert.match(src, /issueProposal:\s*\['bg-sky-500\/15 text-sky-500'/);
});

test('_renderIssueRow selects issueProposal for the generating status', () => {
  assert.match(
    src,
    /h\.status === 'generating'\s*\n?\s*\?\s*AppView\._devCardIcon\('issueProposal'/
  );
});

test('the generating branch pulses the chip', () => {
  assert.match(src, /_devCardIcon\('issueProposal',\s*\{\s*pulse:\s*true/);
});

test('_renderIssueRow selects a sky proposal chip for the ready status (mine vs not)', () => {
  // ready → issueProposalMine when the viewer already has a session cloned
  // off this issue (h.mySessionId), else issueProposal. Both are sky
  // document chips, so the "ready ⇒ sky proposal chip" invariant holds
  // either way.
  assert.match(
    src,
    /h\.status === 'ready'\s*\?\s*\(h\.mySessionId\s*\?\s*AppView\._devCardIcon\('issueProposalMine'[\s\S]*?:\s*AppView\._devCardIcon\('issueProposal'/
  );
});

test('DEV_CARD_ICONS issueProposalMine is also a sky chip', () => {
  assert.match(src, /issueProposalMine:\s*\['bg-sky-500\/15 text-sky-500'/);
});

test('_devCardIcon supports the pulse and title opts', () => {
  assert.match(src, /opts && opts\.pulse \? ' animate-pulse' : ''/);
  assert.match(src, /opts && opts\.title \? ` title="\$\{escapeAttr\(opts\.title\)\}"` : ''/);
});
