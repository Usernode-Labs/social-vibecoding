// Tests for the proposal-state issue icon (#250): issue cards on the Dev
// page swap their amber chip for a blue document chip when a headless
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

// TWO NAMES, ONE HUE — the tint string is half gradient, half Tailwind ramp,
// and only one half moved. `dev-icon-aura-sky` names a GRADIENT in app.css
// and keeps its brand-kit name; the `text-*` half is a Tailwind ink, and
// stock `sky` ceased to be a product hue at the reskin, so the ink is the
// platform's own blue now. 700 (#1D81CD, the WORKING ink — the brand hex
// #3090E1 is azure-500, and reading the key instead of the hex is the trap
// this repo keeps warning about) with the 300 dark partner, not the -400 the
// WCAG era left here — the 800/200 headroom step is reserved for link ink,
// and this is a fallback glyph on a wash.
const BLUE_TINT = 'dev-icon-aura-sky text-azure-700 dark:text-azure-300';
const wearsBlue = (key) => new RegExp(`${key}:\\s*\\[\\s*'${BLUE_TINT}'`);

test('DEV_CARD_ICONS carries an issueProposal entry with the sky-aura blue tint', () => {
  // subtle-y2k v2 respelled the tint (a soft sky-aura wash instead of the
  // flat bg-sky-500/15) and the stock-hue pass respelled its ink; the
  // invariant this test protects is unchanged — "blue = proposal", shared
  // with the PR cards.
  assert.match(src, wearsBlue('issueProposal'), `issueProposal wears '${BLUE_TINT}'`);
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

test('_renderIssueRow selects a blue proposal chip for the ready status (mine vs not)', () => {
  // ready → issueProposalMine when the viewer already has a session cloned
  // off this issue (h.mySessionId), else issueProposal. Both are sky-aura
  // document chips, so the "ready ⇒ blue proposal chip" invariant holds
  // either way.
  assert.match(
    src,
    /h\.status === 'ready'\s*\?\s*\(h\.mySessionId\s*\?\s*AppView\._devCardIcon\('issueProposalMine'[\s\S]*?:\s*AppView\._devCardIcon\('issueProposal'/
  );
});

test('DEV_CARD_ICONS issueProposalMine is also a sky-aura blue chip', () => {
  // Identical tint to its base entry — the "mine" variants are distinguished
  // by GLYPH only, so a hue drift between the two is the regression here.
  assert.match(src, wearsBlue('issueProposalMine'), `issueProposalMine wears '${BLUE_TINT}'`);
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
