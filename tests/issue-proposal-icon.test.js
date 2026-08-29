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
const CARD_TSX = fs.readFileSync(path.join(
  __dirname, '..', 'frontend', 'src', 'features', 'dev-board', 'card', 'dev-card.tsx'), 'utf8');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf-8'
);

test('DEV_CARD_ICONS carries an issueProposal entry with the sky tint', () => {
  // `\s*` after the `[`: the lucide move gave every DEV_CARD_ICONS entry its
  // own line per column (tint / shapes / emoji), so the tint no longer sits
  // on the same line as its key. The invariant this test protects is
  // unchanged — "sky = proposal", shared with the PR cards — and the tint
  // string itself is deliberately untouched by that move.
  assert.match(src, /issueProposal:\s*\[\s*'bg-sky-500\/15 text-sky-700/);
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
  assert.match(src, /issueProposalMine:\s*\[\s*'bg-sky-500\/15 text-sky-700/);
});

test('_devCardIcon supports the pulse and title opts', () => {
  // It returns the icon's SPEC now (card/dev-card.tsx draws it), so the two
  // opts ride on the model rather than in a class string and a title
  // attribute the builder concatenated.
  assert.match(src, /pulse: \(opts && opts\.pulse\) \? true : undefined/);
  assert.match(src, /title: \(opts && opts\.title\) \|\| undefined/);
  assert.match(CARD_TSX, /spec\.pulse \? ' animate-pulse' : ''/, 'and the chip animates');
  assert.match(CARD_TSX, /title=\{spec\.title\}/, 'and carries the tooltip');
});
