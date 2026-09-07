// The stage-2 survey's two open questions grow with what is typed (#1530).
//
// Both ship `rows={3}`, which is a poor window for the paragraph the prompt
// asks for — the answer scrolls away from the person writing it. The box is
// resized to its content instead, and three things about HOW are pinned here
// because each one has a failure mode that is invisible in a diff:
//
//   1. The height is written imperatively, never as a `style` prop. The first
//      render has to stay byte-identical to the prerendered document
//      (AGENTS.md), and a rendered `style=""` is a difference — a hydration
//      mismatch console.errors, and a console error on any route fails
//      proposal checks.
//   2. `height = 'auto'` comes FIRST. With an explicit height still set,
//      `scrollHeight` can only grow, so deleting text would never shrink the
//      box back.
//   3. The height is only written when the element measures. A screen that is
//      still `hidden` reports `scrollHeight === 0`, and pinning that would
//      collapse the box to nothing.
//
// Run with: node --test tests/waitlist-long-answers.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { interiorHtmlFor } = require('./lib/lazy-interiors');

const ROOT = path.join(__dirname, '..');
const MORE = 'frontend/src/features/auth/more.tsx';
const source = () => fs.readFileSync(path.join(ROOT, MORE), 'utf8');

const LONG_ANSWER_IDS = ['more-group-need', 'more-loss-story'];

test('both long-answer fields are multiline, and keep their three-row floor', () => {
  const html = interiorHtmlFor('auth-more-screen');
  for (const id of LONG_ANSWER_IDS) {
    const el = html.match(new RegExp(`<textarea[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(el, `#${id} is a textarea`);
    assert.match(el, /rows="3"/, 'rows is the floor the box can shrink back to');
  }
});

test('the first render carries no inline height, so the prerender still matches', () => {
  const html = interiorHtmlFor('auth-more-screen');
  for (const id of LONG_ANSWER_IDS) {
    const el = html.match(new RegExp(`<textarea[^>]*id="${id}"[^>]*>`))?.[0];
    assert.doesNotMatch(el, /style=/,
      'a rendered style attribute is a hydration mismatch waiting to happen');
  }
});

test('typing resizes the box, and deleting can shrink it again', () => {
  const src = source();
  // `auto` first, then the measured height — in that order.
  const fn = src.match(/function autoGrow[\s\S]*?\n\}/)?.[0];
  assert.ok(fn, 'autoGrow is a named helper, not an inline closure per field');
  assert.ok(
    fn.indexOf("el.style.height = 'auto'") < fn.indexOf('scrollHeight'),
    'height must be released before it is measured, or the box can only grow');
  assert.match(fn, /if \(el\.scrollHeight > 0\)/,
    'a hidden screen measures 0; pinning that would collapse the box');

  // Both fields are wired, and through the same helper.
  const wires = src.match(/onInput=\{\(e\) => autoGrow\(e\.currentTarget\)\}/g) || [];
  assert.equal(wires.length, LONG_ANSWER_IDS.length);
});

test('a stored answer is sized on load and on reveal, not only while typing', () => {
  const src = source();
  // Assigning `.value` fires no input event, so reopening the form would
  // otherwise show a long saved answer through a three-line window.
  assert.match(src, /autoGrow\(groupNeed\.current\)/);
  assert.match(src, /autoGrow\(lossStory\.current\)/);
  // The loss story starts inside a hidden block, so it has no height to read
  // until that block is revealed.
  assert.match(src, /if \(!lossDetailHidden\) autoGrow\(lossStory\.current\)/);
});
