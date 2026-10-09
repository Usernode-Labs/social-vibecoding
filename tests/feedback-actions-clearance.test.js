'use strict';

// The feedback dialog's pinned Cancel / Post request row must not cover the
// field a person is typing in (#4542). The kit modal is the scroller, so
// when the keyboard shrinks it and focus moves into `#feedback-text`, the
// browser scrolls the field into view without knowing the row is sticky at
// the scrollport's edge, and the row paints over the field (the reporter's
// screenshot: only the textarea's focused edges peek out under the buttons).
//
// The fix is the one the proposal vote sheet already uses
// (tests/needs-sheet-above-bars.test.js): scroll padding on the scroller,
// so focus, caret and scrollIntoView scrolling land above the row.
//
// Run with: node --test tests/feedback-actions-clearance.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(root, 'public/css/app.css'), 'utf8');

/** The body of the single-line or block rule for `selector`. */
function ruleBody(selectorRe) {
  const m = new RegExp(`(?:^|\\n)${selectorRe} \\{([^}]*)\\}`).exec(CSS);
  assert.ok(m, `a rule for ${selectorRe}`);
  return m[1];
}

test('a focused feedback field scrolls in above the pinned buttons, not under them', () => {
  // 76px is the row (12px top padding, a 36px button, 20px foot) and an 8px
  // gap, so a focused field never touches the hairline above the row.
  assert.match(
    ruleBody('\\.un-modal:has\\(#feedback-form\\)'),
    /scroll-padding-bottom: 76px;/,
    'the feedback dialog\'s scroller reserves the row\'s height as scroll padding');
});

test('the Cancel / Post row stays pinned exactly as #4033 left it', () => {
  const body = ruleBody('\\.un-modal \\.feedback-actions');
  assert.match(body, /position: sticky;/);
  assert.match(body, /bottom: 0;/);
  assert.match(body, /margin-bottom: -20px;/);
  assert.match(body, /padding: 12px 0 20px;/);
  // Scroll padding changes only where scrolling lands; it adds no layout, so
  // a short form still renders with the row meeting the form bottom.
  assert.doesNotMatch(body, /scroll-padding/, 'the row itself carries no scroll padding');
});