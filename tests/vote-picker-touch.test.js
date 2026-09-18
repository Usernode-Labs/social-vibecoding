'use strict';

// The vote picker is ONE panel (dev-card.tsx VoteButton / VotePicker): a
// two-way switch across the top with Yes on by default, the line box under
// it from the start, and Cancel beside the one button that reads "Vote yes"
// or "Vote no" with the switch. The same panel is the anchored popover on
// desktop and a kit bottom sheet on touch (#1688 follow-ups).
//
//   1. the panel: the switch and its tallies, "Still yes" / "Not this time"
//      on a prior Yes, the label and placeholder that follow the side, and
//      the button that is off on a No until there is a line;
//   2. VoteButton draws the panel once for both homes; on touch the kit
//      sheet comes first and the action sheet + prompt card are the
//      fallback; the box takes focus with the tap that needs it;
//   3. the styles: the switch's two states, the popover's even inset, and
//      the sheet variant at tap-target size.
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
  yes, no, prior: null, side: 'yes', line: '', reasonId: 'dev-vote-reason-7', tally, withLine: true,
  onSide: noop, onLine: noop, onBoxKey: noop, onCancel: noop, onSend: noop, ...(over || {}),
});

// ── 1. The panel ──────────────────────────────────────────────────────

test('the switch: Yes on by default with its tally, No beside it; "Still yes" / "Not this time" on a prior Yes', () => {
  const html = picker();
  assert.match(html, /<div class="dev-vote-switch" role="group" aria-label="Yes or No">/);
  assert.match(html, /<button type="button" class="dev-vote-switch-opt dev-vote-switch-yes" aria-pressed="true"[^>]*data-act="castVote"[^>]*>[\s\S]*?Yes<span class="dev-vote-n">2\/3<\/span><\/button>/);
  assert.match(html, /<button type="button" class="dev-vote-switch-opt dev-vote-switch-no" aria-pressed="false"[^>]*>[\s\S]*?No<span class="dev-vote-n">0\/3<\/span><\/button>/);
  const flipped = picker({ side: 'no' });
  assert.match(flipped, /dev-vote-switch-yes" aria-pressed="false"/);
  assert.match(flipped, /dev-vote-switch-no" aria-pressed="true"/);
  const prior = picker({ prior: 'yes' });
  assert.match(prior, />Still yes<span/);
  assert.match(prior, />Not this time<span/);
});

test('the box is there from the start and its words follow the switch; Vote no is off until there is a line', () => {
  const onYes = picker();
  assert.match(onYes, /<div class="dev-vote-reason" data-vote-reason="yes">/);
  assert.match(onYes, /<label class="dev-vote-reason-label" for="dev-vote-reason-7">Add a line for the group, if you like\.<\/label>/);
  assert.match(onYes, /<textarea id="dev-vote-reason-7" class="dev-vote-reason-box" rows="2" maxLength="280" placeholder="What do you like about it\?"/);
  assert.match(onYes, /<button type="button" class="dev-vote-reason-cancel">Cancel<\/button><button type="button" class="dev-vote-reason-send dev-vote-reason-send-yes">Vote yes<\/button>/,
    'Cancel, then the one button: a Yes is one click');
  const onNo = picker({ side: 'no' });
  assert.match(onNo, /<div class="dev-vote-reason" data-vote-reason="no">/);
  assert.match(onNo, /What’s not working for you\? One line is plenty\.<\/label>/);
  assert.match(onNo, /placeholder="What would you want to change\?"/);
  assert.match(onNo, /<button type="button" class="dev-vote-reason-send dev-vote-reason-send-no" disabled="">Vote no<\/button>/);
  const typed = picker({ side: 'no', line: '  The colors  clash ' });
  assert.match(typed, /<button type="button" class="dev-vote-reason-send dev-vote-reason-send-no">Vote no<\/button>/, 'a line turns it on');
  const blank = picker({ side: 'no', line: '   ' });
  assert.match(blank, /dev-vote-reason-send-no" disabled=""/, 'whitespace is not a line');
});

test('a governance vote has no line: the switch and the button only', () => {
  const html = picker({ withLine: false });
  assert.doesNotMatch(html, /dev-vote-reason-box|dev-vote-reason-label/);
  assert.match(html, /class="dev-vote-reason-send dev-vote-reason-send-yes">Vote yes<\/button>/);
  const noSide = picker({ withLine: false, side: 'no' });
  assert.match(noSide, /class="dev-vote-reason-send dev-vote-reason-send-no">Vote no<\/button>/, 'never off without a line to wait for');
});

// ── 2. The two homes ──────────────────────────────────────────────────

test('VoteButton draws the panel once for both homes, opens on Yes, and sends one call with the line', () => {
  const fn = SRC.slice(SRC.indexOf('export function VoteButton('), SRC.indexOf('export function VotePicker('));
  assert.equal((fn.match(/<VotePicker\b/g) || []).length, 1, 'one VotePicker element');
  assert.equal((fn.match(/\{picker\}/g) || []).length, 2, 'rendered into the popover and into the sheet');
  assert.match(fn, /createPortal\(\s*<div\s+ref=\{popRef\}\s+className="dev-vote-pop"\s+role="dialog"\s+aria-label="Your vote"\s+data-side=\{side\}/,
    'desktop: the anchored popover, a dialog now that it holds a form');
  assert.match(fn, /createPortal\(\s*<div className="dev-vote-sheet" role="dialog" aria-label="Your vote" data-vote-sheet="" data-side=\{side\}>\s*\{picker\}\s*<\/div>,\s*sheetEl,/,
    'touch: the same panel inside the kit sheet\'s content element');
  assert.match(fn, /aria-haspopup="dialog"/, 'the face says what it opens');
  assert.match(fn, /const startSide = \(\): 'yes' \| 'no' => \(mine === 'no' \? 'no' : 'yes'\);/, 'Yes by default; a viewer who voted No starts from No');
  assert.match(fn, /if \(open \|\| sheetRef\.current\) \{ shut\(\); return; \}\s*setSide\(startSide\(\)\);\s*setLine\(''\);/, 'reset on every open');
  assert.match(fn, /const canSend = !isVote \|\| side === 'yes' \|\| !!trimmed;/);
  assert.match(fn, /send\(spec, isVote \? \(trimmed \|\| null\) : null\);/, 'one call: the side\'s spec with the line, null for none');
  assert.match(fn, /if \(!isVote\) \{ call\(a\.act\); return; \}/, 'a governance vote is the spec\'s own call');
  assert.doesNotMatch(fn, /dev-vote-reason-box|dev-vote-opt|data-asking|setAsking/, 'the rows and the two-step are gone');
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
  assert.match(openSheet, /onDismiss: \(\) => \{\s*sheetRef\.current = null;\s*setSheetEl\(null\);\s*setLine\(''\);/,
    'a backdrop tap or a drag clears the picker the same way a send does');
  assert.equal(SRC.split('const pickTouch = (').length - 1, 1, 'defined once');
  assert.equal(SRC.split('pickTouch(').length - 1, 2, 'called from the two fallback rows only');
  const shut = SRC.slice(SRC.indexOf('const shut = () => {'), SRC.indexOf('const send = ('));
  assert.match(shut, /sheet\.dismiss\(\);/, 'closing the picker takes the sheet down');
  assert.match(SRC, /useEffect\(\(\) => \(\) => \{\s*const sheet = sheetRef\.current;\s*if \(sheet\) \{ sheetRef\.current = null; sheet\.dismiss\(\); \}\s*\}, \[\]\);/,
    'and so does the card going away under it');
  assert.match(SRC, /useIsoLayoutEffect\(\(\) => \{\s*if \(open \|\| \(sheetEl && side === 'no'\)\) boxRef\.current\?\.focus\(\);\s*\}, \[open, sheetEl, side\]\);/,
    'focus with the popover, and on touch only when the switch lands on No — a keyboard over a one-tap Yes would be in the way');
});

// ── 3. The styles ─────────────────────────────────────────────────────

test('the switch has two filled states, the popover one even inset, and the sheet variant tap-target rows', () => {
  const rule = (sel) => (new RegExp(`\\n${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(CSS) || [])[1] || '';
  assert.match(rule('.dev-vote-pop'), /width: 312px/);
  assert.match(rule('.dev-vote-pop'), /padding: 10px 10px 8px/, 'the switch sits off the edges like the box and the buttons');
  assert.match(rule('.dev-vote-switch'), /display: flex/);
  assert.match(rule('.dev-vote-switch-opt'), /flex: 1 1 0/, 'equal halves');
  assert.match(rule('.dev-vote-switch-opt'), /height: 34px/);
  assert.match(rule('.dev-vote-switch-yes[aria-pressed="true"]'), /background: var\(--accent\); color: var\(--accent-ink\)/, 'Yes on: the accent fill');
  assert.match(rule('.dev-vote-switch-no[aria-pressed="true"]'), /background: var\(--state-blocked-bg\); color: var\(--state-blocked\)/, 'No on: the blocked tint');
  assert.doesNotMatch(CSS, /\.dev-vote-opt\b|data-asking/, 'the rows and their growing width are gone');
  assert.match(rule('.dev-vote-sheet .dev-vote-switch-opt'), /height: 44px/, 'tap-target rows in the sheet');
  assert.match(rule('.dev-vote-sheet .dev-vote-reason-box'), /font-size: 16px/, '16px so iOS does not zoom the page on focus');
  assert.match(rule('.dev-vote-sheet .dev-vote-reason-cancel, .dev-vote-sheet .dev-vote-reason-send'), /height: 44px/);
  const block = CSS.slice(CSS.indexOf('.dev-vote-sheet {'), CSS.indexOf('.dev-vote-sheet .dev-vote-reason-cancel'));
  assert.doesNotMatch(block, /position: fixed|bottom: |un-kb-inset|touch-action/, 'the kit owns the sheet\'s placement and keyboard inset; nothing here fights it');
  assert.doesNotMatch(block, /#[0-9a-f]{3,6}\b|rgb\(/i, 'tokens only');
});
