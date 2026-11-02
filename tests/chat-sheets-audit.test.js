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

test('C06: an empty reply box on a request or a channel shows Send faded, as Messages does', () => {
  const composer = read('frontend/src/features/group-chat/composer.tsx');
  assert.match(composer, /const files = slot\.attachments\.length \? '' : undefined;/);
  assert.match(composer, /<form id=\{ids\.form\} className="messages-composer-card" data-gc-files=\{files\}>/);
  assert.match(composer, /<form id=\{ids\.form\} className="gc-composer-card flex items-end gap-1\.5" data-gc-files=\{files\}>/);
  assert.match(CSS, /\.messages-send:disabled \{ opacity: \.35; \}/);
  assert.match(CSS, /\.messages-composer-card:not\(\[data-gc-files\]\):has\(textarea:placeholder-shown\) \.messages-send \{ opacity: \.35; \}/);
  assert.match(CSS, /\.gc-composer-card:not\(\[data-gc-files\]\):has\(textarea:placeholder-shown\) \.gc-send \{ opacity: \.35; \}/);
});

test('C04: a desktop conversation with nothing beside it keeps a reading width', () => {
  assert.match(CSS, /\.messages-layout\.messages-list-in-rail > \.messages-thread-pane:last-child \{\s*max-width: 960px;\s*margin-inline: auto;\s*\}/);
});

test('D13: the hover bar on somebody else\'s bubble hangs off its name line, beside the message', () => {
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /const barBesideHead = sided && !mine && !grouped;/);
  assert.match(row, /\{status\}\{barBesideHead \? actions : null\}<\/div>\}/);
  assert.match(row, /\{barBesideHead \? null : actions\}\n\s*<MessageActionSheet/);
  assert.match(CSS, /\.messages-message-head > \.messages-message-actions \{ top: -10px; right: auto; left: calc\(100% \+ 8px\); \}/);
});
