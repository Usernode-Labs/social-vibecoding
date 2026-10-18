'use strict';

// #3571: tapping the Messages field on mobile Safari sent the message box off
// screen as the keyboard came up. iOS pans the page to reveal the focused
// field, and nothing puts that pan back while the keyboard is up — with the
// keyboard reservation (.platform-kb-column) having lifted the composer above
// the keys, the pan alone decided what was on screen, and the band had
// already moved to the page's foot: the box ended above it, off screen.
//
// The fix focuses the field INSIDE the tap with preventScroll — the kit's own
// pattern for modal fields (native.js attachModalFieldFocus, #3150) — which
// raises the same keyboard with no pan. This file pins the decision the tap
// makes, and that the composer's field actually makes it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const { fieldTapDecision, TAP_SLOP } = loadTsx('frontend/src/lib/tap-focus.ts');
const COMPOSER = fs.readFileSync(
  path.join(__dirname, '..', 'frontend/src/features/messages/composer.tsx'), 'utf8'
);

// A tap that lands where it started, one finger, cancelable.
const TAP = { touches: [], changedTouches: [1], cancelable: true };
const tap = (dx = 0, dy = 0) => ({
  touches: [],
  changedTouches: [{ clientX: 10 + dx, clientY: 20 + dy }],
  cancelable: true,
});

test('a tap on the unfocused field takes focus, inside the tap, without scrolling', () => {
  assert.equal(
    fieldTapDecision({ x: 10, y: 20 }, { x: 10, y: 20 }, tap(), false),
    'focus',
    'the first tap on the field is the one that must not let iOS pan'
  );
});

test('a tap on the already-focused field stays native, so the caret places itself', () => {
  assert.equal(
    fieldTapDecision({ x: 10, y: 20 }, { x: 12, y: 19 }, tap(2, -1), true),
    'native'
  );
});

test('anything that is not a tap keeps every native behaviour', () => {
  assert.equal(fieldTapDecision(null, { x: 10, y: 20 }, tap(), false), 'ignore', 'no touchstart');
  assert.equal(fieldTapDecision({ x: 10, y: 20 }, undefined, tap(), false), 'ignore', 'no end point');
  assert.equal(
    fieldTapDecision({ x: 10, y: 20 }, { x: 10 + TAP_SLOP + 1, y: 20 }, tap(TAP_SLOP + 1), false),
    'ignore', 'a drag is not a tap'
  );
  assert.equal(
    fieldTapDecision({ x: 10, y: 20 }, { x: 10, y: 20 + TAP_SLOP }, { ...TAP, touches: [1] }, false),
    'ignore', 'a second finger is still down'
  );
  assert.equal(
    fieldTapDecision({ x: 10, y: 20 }, { x: 10, y: 20 }, { ...TAP, changedTouches: [1, 2] }, false),
    'ignore', 'a multi-touch ending is not one tap'
  );
  assert.equal(
    fieldTapDecision({ x: 10, y: 20 }, { x: 10, y: 20 }, { ...TAP, cancelable: false }, false),
    'ignore', 'an event the browser will not let us answer'
  );
});

test('movement within the slop is still a tap', () => {
  assert.equal(
    fieldTapDecision({ x: 10, y: 20 }, { x: 10 + TAP_SLOP, y: 20 - TAP_SLOP }, tap(TAP_SLOP, -TAP_SLOP), false),
    'focus'
  );
});

test('the composer wires the decision to its field', () => {
  assert.match(COMPOSER, /onTouchStart=\{onFieldTouchStart\} onTouchEnd=\{onFieldTouchEnd\}/,
    'the textarea carries both touch handlers');
  assert.match(COMPOSER, /document\.activeElement === inputRef\.current/,
    'the focused check the native branch reads');
  assert.match(COMPOSER, /decision === 'focus'[\s\S]*?event\.preventDefault\(\);[\s\S]*?inputRef\.current\?\.focus\(\{ preventScroll: true \}\);/,
    'the focus branch preventDefaults the tap and focuses with preventScroll');
});