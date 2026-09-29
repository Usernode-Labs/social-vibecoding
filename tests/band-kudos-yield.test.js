'use strict';

// The board card's action band: the kudos slot gives way, never Open card,
// Preview or ⋯ (dev-card.tsx useFoldedActions, kudos.js, app-view.js,
// app.css).
//
// The band is one clipped row. Its fold measures the pills and tucks the
// ones that do not fit into ⋯ — but the kudos slot is a legacy-filled host
// with no box of its own, so the fold counted it as 0px and it could fold
// nothing: on a narrow column "Thank <author> for putting this up" pushed
// the fixed controls after it (Open card, Preview, ⋯) onto the hidden row.
// Now the slot is measured through its host and yields last, in stages:
//
//   1. the ladder: the widest face that fits the room the fixed controls
//      leave — the whole line, the name alone, the clap alone — or none,
//      when the slot folds into ⋯;
//   2. the measurement: the host measured through, excluded from the fixed
//      width, reset to its widest face first, stepped down while a fixed
//      control is still off the row, and a band whose one pill is the slot
//      still measures;
//   3. the ⋯ row for a folded slot, acting through the slot's own button;
//   4. the styles: the tail, the label and the square clap, and the folded
//      slot on the clipped row.
//
// Run with: node --test tests/band-kudos-yield.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const CARD = read('frontend/src/features/dev-board/card/dev-card.tsx');
const CSS = read('public/css/app.css');
const APP = read('public/js/app-view.js');
const KUDOS = read('frontend/src/features/leaderboard/kudos.js');

const { slotFace, slotFaces } = loadTsx('frontend/src/features/dev-board/card/dev-card.tsx');

// A pill as the measurement sees it: the wrap's width and height, and the
// tail span inside the thanks label.
const pill = (full, tail, height = 24) => ({
  offsetWidth: full,
  offsetHeight: height,
  querySelector: (sel) => (sel === '.dev-thanks-tail' && tail != null ? { offsetWidth: tail } : null),
});

// ── 1. The ladder ─────────────────────────────────────────────────────

test('slotFaces: the whole line, the name alone, the clap alone — widest first', () => {
  assert.deepEqual(slotFaces(pill(218, 112)), [
    { stage: 'full', width: 218 },
    { stage: 'short', width: 106 },
    { stage: 'clap', width: 24 },
  ]);
  assert.deepEqual(slotFaces(pill(44, null)), [
    { stage: 'full', width: 44 },
    { stage: 'clap', width: 24 },
  ], 'the count pill has no tail: the count, then the clap');
  assert.deepEqual(slotFaces(pill(218, 0)), [
    { stage: 'full', width: 218 },
    { stage: 'clap', width: 24 },
  ], 'a tail already hidden measures 0 and offers no second face');
});

test('slotFace: the widest face that fits the room, or none, at a few band widths', () => {
  const faces = slotFaces(pill(218, 112));
  // Open card 78 + Preview 85 + ⋯ 28 with two gaps = 203px of fixed
  // controls; the slot needs its own gap on top. Room = band − 203 − 6.
  const room = (band) => band - 203 - 6;
  assert.equal(slotFace(room(440), faces).stage, 'full', 'a wide column keeps the line');
  assert.equal(slotFace(room(427), faces).stage, 'full', 'exactly enough is enough');
  assert.equal(slotFace(room(426), faces).stage, 'short', 'one pixel short of the line: the name');
  assert.equal(slotFace(room(315), faces).stage, 'short');
  assert.equal(slotFace(room(314), faces).stage, 'clap', 'one pixel short of the name: the clap');
  assert.equal(slotFace(room(233), faces).stage, 'clap');
  assert.equal(slotFace(room(232), faces), null, 'not even the clap: the slot folds into ⋯');
  assert.equal(slotFace(-40, faces), null, 'the fixed controls alone over the band: nothing to add');
});

// ── 2. The measurement ────────────────────────────────────────────────

test('the fold measures the slot through its host, excludes it from the fixed width, and resets it first', () => {
  const hook = CARD.slice(CARD.indexOf('function useFoldedActions('), CARD.indexOf('return { ref: (el) => { bandRef.current = el; }'));
  assert.match(hook, /const hasKudos = primary\.some\(\(a\) => a\.kudos != null\);/);
  assert.match(hook, /if \(!band \|\| \(!foldable && !hasKudos\)\) \{/, 'a band whose one pill is the slot still measures');
  assert.match(hook, /const host = kids\.find\(\(k\) => k\.dataset\.kudosHost != null\) \|\| null;\s*const pill = host \? \(host\.firstElementChild as HTMLElement \| null\) : null;/);
  assert.match(hook, /band\.removeAttribute\('data-thanks'\);\s*if \(host\) host\.removeAttribute\('data-folded'\);\s*const gap = 6;/,
    'the widest face before any width is read');
  assert.match(hook, /if \(k\.dataset\.fold \|\| k === host\) continue;\s*used \+= k\.offsetWidth/, 'the host is not a fixed control');
  assert.match(hook, /const faces = pill && pill\.offsetWidth \? slotFaces\(pill\) : null;\s*let face = faces \? slotFace\(avail - used - \(count \? gap : 0\), faces\) : null;/,
    'the room is what the fixed controls leave, gap included');
  assert.match(hook, /if \(faces && !face\) host\.setAttribute\('data-folded', '1'\);\s*else if \(face && face\.stage !== 'full'\) band\.setAttribute\('data-thanks', face\.stage\);/,
    'the band carries the face, the host the fold');
  assert.match(hook, /if \(face\) \{ used \+= face\.width \+ \(count \? gap : 0\); count \+= 1; \}\s*let shown = 0;/,
    'the slot is placed before the foldable pills are counted: it yields last');
  assert.match(hook, /const offRow = \(k: HTMLElement\) => k\.offsetTop - top >= band\.clientHeight;/, 'off the row: at or below the clipped height');
  assert.match(hook, /const fixed = kids\.filter\(\(k\) => !k\.dataset\.fold && k !== host\);\s*while \(faces && face && fixed\.some\(offRow\)\) \{\s*const next = faces\.indexOf\(face\) \+ 1;\s*face = next < faces\.length \? faces\[next\] : null;\s*setFace\(\);\s*\}/,
    'a fixed control still off the row steps the slot down a face, to the fold');
  assert.match(hook, /setKudosFolded\(!!faces && !face\);/);
  assert.match(hook, /\}, \[foldable, hasKudos, hasPreview, primary\.map\(\(a\) => a\.key \+ a\.label\)\.join\('\|'\)\]\);/);
});

test('a folded slot rides the menu hand-off after the folded pills', () => {
  assert.match(CARD, /const slot = kudosFolded \? primary\.filter\(\(a\) => a\.kudos != null\) : \[\];\s*av\._setFoldedCardActions\(menuKey, hidden\.concat\(slot\)\);/);
  assert.match(CARD, /\}, \[menuKey, n, kudosFolded, primary\.map\(\(a\) => a\.key \+ a\.label\)\.join\('\|'\)\]\);/);
  assert.match(CARD, /fold=\{a\.kudos == null \? i \+ 1 : undefined\}/, 'the host itself still carries no fold index: its fold is the slot\'s own');
});

// ── 3. The ⋯ row ──────────────────────────────────────────────────────

test('app-view.js keeps a kudos spec in the folded list and draws it through the slot\'s own button', () => {
  assert.match(APP, /specs\.filter\(\(a\) => a && \(\(a\.act && a\.act\.fn\) \|\| a\.kudos != null\)\)/);
  assert.match(APP, /_foldedMenuItem\(a\) \{\s*if \(a\.kudos != null\) return AppView\._kudosMenuItem\(a\.kudos\);/);
  const item = APP.slice(APP.indexOf('  _kudosMenuItem(id) {'), APP.indexOf('  _foldedMenuItem(a) {'));
  assert.match(item, /document\.querySelector\(`\[data-kudos-host="\$\{id\}"\]`\)/, 'the slot, by its host');
  assert.match(item, /host\.querySelector\('\[data-kudos-action="give"\]'\)/);
  assert.match(item, /label: label \? label\.textContent\.trim\(\) : \(retract \? 'Retract kudos' : 'Give kudos'\),/,
    'the slot\'s own line when it has one; the count pill\'s two verbs otherwise');
  assert.match(item, /icon: 'kudos',/);
  assert.match(item, /act: \(\) => \{ if \(btn && !btn\.disabled\) btn\.click\(\); \},/, 'Kudos keeps every rule it has: the click is the slot\'s');
});

test('kudos.js: the line\'s tail is its own span and the whole line is the button\'s name', () => {
  assert.match(KUDOS, /<span class="dev-thanks-label">Thank \$\{escapeHtml\(thanks\)\}<span class="dev-thanks-tail"> for putting this up<\/span><\/span>/);
  assert.match(KUDOS, /\$\{thanks \? ` aria-label="\$\{escapeAttr\(line\)\}" title="\$\{escapeAttr\(line\)\}"` : tipAttr\}/);
});

// ── 4. The styles ─────────────────────────────────────────────────────

test('the three faces and the fold, in app.css', () => {
  const rule = (sel) => (new RegExp(`\\n${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(CSS) || [])[1] || '';
  assert.match(CSS, /\n\.gc-card-actions\[data-thanks="short"\] \.dev-thanks-tail \{ display: none; \}/, 'short: the name alone');
  assert.match(CSS, /\n\.gc-card-actions\[data-thanks="clap"\] \.kudos-wrap \.dev-thanks-label,\s*\.gc-card-actions\[data-thanks="clap"\] \.kudos-wrap \[data-kudos-count\] \{ display: none; \}/,
    'clap: neither the line nor the count');
  const clap = rule('.gc-card-actions[data-thanks="clap"] .kudos-wrap > .gc-vote-btn');
  assert.match(clap, /aspect-ratio: 1 \/ 1;\s*width: auto;\s*padding: 0;/, 'a square of the pill\'s own height — what slotFaces measures');
  assert.match(CSS, /\n\.gc-card-actions > \[data-kudos-host\]\[data-folded\] > \.kudos-wrap \{ order: 1; \}/,
    'folded: the pill goes to the clipped row like any folded pill, still rendered');
  assert.doesNotMatch(CSS, /\[data-kudos-host\]\[data-folded\][^{]*\{[^}]*display: none/, 'never hidden: the measurement reads its width');
});
