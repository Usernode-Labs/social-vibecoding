'use strict';

// The overnight UI audit's chat, sheet and dialog findings (1 to 2 Nov 2026,
// batch 5b): what each fix holds, pinned where it lives.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const CSS = read('public/css/app.css');

/** The phone drawer's block of app.css (max-width 767.98px), as the drawer's rows read it. */
function drawerRules() {
  const start = CSS.indexOf('.messages-layout.messages-drawer { position: relative;');
  assert.ok(start > 0, 'the drawer block is there');
  return CSS.slice(start, CSS.indexOf('/* ── The hero\'s rows', start));
}

test('C03: the phone\'s Messages list keeps the rows\' own type and time', () => {
  const block = drawerRules();
  assert.doesNotMatch(block, /\.messages-row-name \{ font-size: 15px; font-weight: 400; \}/, 'no 400-weight title');
  assert.doesNotMatch(block, /\.messages-row-preview \{ font-size: 12px;/, 'no 12px last line');
  assert.doesNotMatch(block, /\.messages-row-time[^{]*\{ display: none; \}/, 'the time stays');
  // The house rule the column now inherits: 15 over 13 at 650.
  assert.match(CSS, /\n\.messages-row-name \{ color: var\(--text-primary\); font-size: 15px; font-weight: 650;/);
  assert.match(CSS, /\n\.messages-row-preview \{ margin-top: 2px; color: var\(--text-muted\); font-size: 13px;/);
});
