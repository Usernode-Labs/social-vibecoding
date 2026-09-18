'use strict';

// #1688 follow-up: on touch the vote picker is a kit bottom sheet with the
// line box INLINE under the rows — not a native action sheet followed by
// the kit's prompt card (dev-card.tsx VoteButton / VotePicker).
//
//   1. the picker's rows and box are ONE drawing (`VotePicker`) that both
//      homes render: the wording, the "Vote No stays off until there is a
//      line" rule and the Skip on a Yes cannot drift between desktop and
//      touch;
//   2. the touch branch presents a kit sheet first and hands it the picker;
//      the action sheet + prompt-card pair survives only as the fallback
//      when no sheet can be presented;
//   3. the sheet variant's styles: tap-target rows, a 16px box (no iOS zoom),
//      and nothing that would fight the kit's keyboard inset.
//
// Run with: node --test tests/vote-picker-touch.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');

const CARD = 'frontend/src/features/dev-board/card/dev-card.tsx';
const SRC = fs.readFileSync(path.join(__dirname, '..', CARD), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'public/css/app.css'), 'utf8');

const yes = { key: 'yes', cls: 'gc-vote-btn gc-vote-btn-yes', title: 'Yes', label: 'Yes (2/3)', act: { fn: 'castVote', args: [7, 'yes', 3] } };
const no = { key: 'no', cls: 'gc-vote-btn gc-vote-btn-no', title: 'No', label: 'No (0/3)', act: { fn: 'castVote', args: [7, 'no', 3] } };
const tally = (a) => (/\(([^)]*)\)\s*$/.exec(a.label || '') || [])[1] || '';
const noop = () => {};
const picker = (over) => renderComponent(CARD, 'VotePicker', {
  yes, no, mine: null, prior: null, asking: null, line: '', reasonId: 'dev-vote-reason-7', tally,
  onPick: noop, onLine: noop, onBoxKey: noop, onCancel: noop, onSend: noop, ...(over || {}),
});

// ── 1. One drawing ────────────────────────────────────────────────────

test('the rows: Yes and No with their tallies; "Still yes" / "Not this time" on a prior Yes', () => {
  const html = picker();
  assert.match(html, /class="dev-vote-opt dev-vote-opt-yes"[^>]*data-act="castVote"[^>]*>[\s\S]*?Yes<span class="dev-vote-n">2\/3<\/span>/);
  assert.match(html, /class="dev-vote-opt dev-vote-opt-no"[^>]*>[\s\S]*?No<span class="dev-vote-n">0\/3<\/span>/);
  assert.doesNotMatch(html, /dev-vote-reason/, 'no box until a side is picked');
  const prior = picker({ prior: 'yes' });
  assert.match(prior, />Still yes<span/);
  assert.match(prior, />Not this time<span/);
});

test('a No asks for its line and keeps Vote No off until there is one; a Yes may Skip', () => {
  const empty = picker({ asking: 'no' });
  assert.match(empty, /<div class="dev-vote-reason" data-vote-reason="no">/);
  assert.match(empty, /<label class="dev-vote-reason-label" for="dev-vote-reason-7">What’s not working for you\? One line is plenty\.<\/label>/);
  assert.match(empty, /<textarea id="dev-vote-reason-7" class="dev-vote-reason-box" rows="2" maxLength="280" placeholder="What would you want to change\?"/);
  assert.match(empty, /<button type="button" class="dev-vote-reason-cancel">Cancel<\/button>/);
  assert.match(empty, /<button type="button" class="dev-vote-reason-send dev-vote-reason-send-no" disabled="">Vote No<\/button>/);
  const typed = picker({ asking: 'no', line: '  The colors  clash ' });
  assert.match(typed, /<button type="button" class="dev-vote-reason-send dev-vote-reason-send-no">Vote No<\/button>/, 'a line turns it on');
  const yesBox = picker({ asking: 'yes' });
  assert.match(yesBox, /Add a line for the group, if you like\./);
  assert.match(yesBox, /placeholder="What do you like about it\?"/);
  assert.match(yesBox, /class="dev-vote-reason-cancel">Skip<\/button>/);
  assert.match(yesBox, /class="dev-vote-reason-send dev-vote-reason-send-yes">Vote Yes<\/button>/, 'never off on a Yes');
  assert.match(yesBox, /aria-checked="true"[^>]*class="dev-vote-opt dev-vote-opt-yes"/, 'the picked side reads as chosen');
});

// ── 2. The two homes ──────────────────────────────────────────────────

test('VoteButton draws the picker once for both homes, and the sheet is a portal into the kit\'s element', () => {
  const fn = SRC.slice(SRC.indexOf('export function VoteButton('), SRC.indexOf('export function VotePicker('));
  assert.equal((fn.match(/<VotePicker\b/g) || []).length, 1, 'one VotePicker element');
  assert.equal((fn.match(/\{picker\}/g) || []).length, 2, 'rendered into the popover and into the sheet');
  assert.match(fn, /createPortal\(\s*<div\s+ref=\{popRef\}\s+className="dev-vote-pop"/, 'desktop: the anchored popover, as before');
  assert.match(fn, /createPortal\(\s*<div className="dev-vote-sheet" role="menu" data-vote-sheet="" data-asking=\{asking \|\| undefined\}>\s*\{picker\}\s*<\/div>,\s*sheetEl,/,
    'touch: the same picker inside the kit sheet\'s content element');
  assert.doesNotMatch(fn, /dev-vote-reason-box/, 'the box is drawn by VotePicker, nowhere else');
});

test('on touch the kit sheet comes first; the action sheet and the prompt card are the fallback', () => {
  const toggle = SRC.slice(SRC.indexOf('const toggle = ('), SRC.indexOf('useEffect(() => {', SRC.indexOf('const toggle = (')));
  const sheetAt = toggle.indexOf('if (openSheet(pu)) return;');
  const actionAt = toggle.indexOf('pu.actionSheet({');
  assert.ok(sheetAt > -1 && actionAt > -1 && sheetAt < actionAt, 'the sheet is tried before the action sheet');
  assert.match(toggle, /pu\.isTouch\(\)\) \{\s*if \(openSheet\(pu\)\) return;/, 'inside the touch branch, first');
  const openSheet = SRC.slice(SRC.indexOf('const openSheet = ('), SRC.indexOf('const toggle = ('));
  assert.match(openSheet, /if \(typeof pu\.sheet !== 'function'[^)]*\) return false;/, 'no sheet API: fall back');
  assert.match(openSheet, /pu\.sheet\(\{\s*contentEl: panel,/, 'the panel is the kit\'s contentEl');
  assert.match(openSheet, /if \(!handle \|\| typeof handle\.dismiss !== 'function'\) return false;/, 'the kit missing (null handle): fall back');
  assert.match(openSheet, /onDismiss: \(\) => \{\s*sheetRef\.current = null;\s*setSheetEl\(null\);\s*setAsking\(null\);\s*setLine\(''\);/,
    'a backdrop tap or a drag clears the picker the same way a send does');
  // pickTouch — the path where castVote asks through the prompt card — is
  // reachable from the action-sheet fallback only.
  assert.equal(SRC.split('const pickTouch = (').length - 1, 1, 'defined once');
  assert.equal(SRC.split('pickTouch(').length - 1, 2, 'called from the two fallback rows only');
  const shut = SRC.slice(SRC.indexOf('const shut = () => {'), SRC.indexOf('const send = ('));
  assert.match(shut, /sheet\.dismiss\(\);/, 'closing the picker takes the sheet down');
  assert.match(SRC, /useEffect\(\(\) => \(\) => \{\s*const sheet = sheetRef\.current;\s*if \(sheet\) \{ sheetRef\.current = null; sheet\.dismiss\(\); \}\s*\}, \[\]\);/,
    'and so does the card going away under it');
  assert.match(SRC, /useIsoLayoutEffect\(\(\) => \{\s*if \(asking\) boxRef\.current\?\.focus\(\);/,
    'focus lands inside the tap, so the keyboard comes up with the box');
});

// ── 3. The sheet's styles ─────────────────────────────────────────────

test('the sheet variant: tap-target rows, a 16px box, and the kit\'s own keyboard handling', () => {
  const rule = (sel) => (new RegExp(`\\n${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(CSS) || [])[1] || '';
  assert.match(rule('.dev-vote-sheet'), /flex-direction: column/);
  assert.match(rule('.dev-vote-sheet .dev-vote-opt'), /height: 48px/, 'rows at tap-target size');
  assert.match(rule('.dev-vote-sheet .dev-vote-opt'), /font-size: 16px/);
  assert.match(rule('.dev-vote-sheet .dev-vote-reason-box'), /font-size: 16px/, '16px so iOS does not zoom the page on focus');
  assert.match(rule('.dev-vote-sheet .dev-vote-reason-cancel, .dev-vote-sheet .dev-vote-reason-send'), /height: 44px/);
  const block = CSS.slice(CSS.indexOf('.dev-vote-sheet {'), CSS.indexOf('.dev-vote-sheet .dev-vote-reason-cancel'));
  assert.doesNotMatch(block, /position: fixed|bottom: |un-kb-inset|touch-action/, 'the kit owns the sheet\'s placement and keyboard inset; nothing here fights it');
  assert.doesNotMatch(block, /#[0-9a-f]{3,6}\b|rgb\(/i, 'tokens only');
});
