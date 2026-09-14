'use strict';

// #1955: one "+" in the Messages composer, not two unlabelled icons.
//
// The paperclip and the share tray sat side by side and both answered the
// same question — "put something in this message" — with nothing on either
// to say which was which. They are two named rows behind a single control
// now, which is also one fewer 36px target on the narrowest row in the app.
//
// Source-level, like tests/messages-composer-focus.test.js beside it: the
// composer needs a live conversation and the messages store to render, and
// what this pins is the SHAPE of the control (one trigger, two named rows,
// the cap on the row rather than the trigger) plus the CSS that positions it.
//
// Run with: node --test tests/messages-composer-add-menu.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const CSS = read('public/css/app.css');
const COMPOSER = read('frontend/src/features/messages/composer.tsx');

function rule(selector) {
  const i = CSS.indexOf(`\n${selector} {`);
  assert.ok(i >= 0, `expected a \`${selector}\` rule in app.css`);
  return CSS.slice(i, CSS.indexOf('\n}', i));
}

test('the composer offers ONE add control, not a paperclip and a tray', () => {
  const actions = COMPOSER.match(/className="messages-composer-action"/g) || [];
  assert.equal(actions.length, 1, 'exactly one round action button beside the field');
  assert.match(COMPOSER, /aria-label="Add to message"/);
  assert.match(COMPOSER, /<PlusIcon aria-hidden="true" \/>/, 'the trigger is the plus');
});

test('the trigger declares the menu it opens', () => {
  // Without these a screen reader announces a button that appears to do
  // nothing: the rows render somewhere else in the tree.
  assert.match(COMPOSER, /aria-haspopup="menu"/);
  assert.match(COMPOSER, /aria-expanded=\{addOpen\}/);
  assert.match(COMPOSER, /role="menu"/);
  assert.equal((COMPOSER.match(/role="menuitem"/g) || []).length, 2, 'two rows: attach, share');
});

test('both old actions survive, now as named rows', () => {
  // The icons are kept — they are what made the rows recognisable to anyone
  // who had learned the old bar — but each now carries its own word.
  assert.match(COMPOSER, /<PaperClipIcon aria-hidden="true" \/>\s*<span>Attach files<\/span>/);
  assert.match(COMPOSER, /<ArrowUpTrayIcon aria-hidden="true" \/>\s*<span>Share item<\/span>/);
  assert.match(COMPOSER, /dialogs\?\.messagesShare\?\.open\(\)/, 'share still opens the same dialog');
  assert.match(COMPOSER, /fileRef\.current\?\.click\(\)/, 'attach still opens the same file input');
});

test('the attachment cap disables the ROW, never the whole control', () => {
  // Four files queued must not take "Share item" away with it — which is
  // exactly what disabling a single merged trigger would have done.
  const attachRow = COMPOSER.slice(COMPOSER.indexOf('role="menuitem"'));
  assert.match(attachRow, /disabled=\{attachments\.length \+ uploading >= MAX_ATTACHMENTS\}/);
  const trigger = COMPOSER.slice(
    COMPOSER.indexOf('className="messages-composer-add"'),
    COMPOSER.indexOf('role="menu"')
  );
  assert.ok(!/disabled=/.test(trigger), 'the "+" itself is never disabled');
});

test('choosing a row closes the menu', () => {
  // Both handlers close before they act: the file dialog and the share modal
  // both take focus, and a menu still standing behind them is a second
  // dismiss the reader has to find afterwards.
  const closes = COMPOSER.match(/setAddOpen\(false\); (?:fileRef|window\.UsernodeReact)/g) || [];
  assert.equal(closes.length, 2, 'attach and share each close first');
});

test('the menu is dismissible by press-outside and Escape', () => {
  assert.match(COMPOSER, /document\.addEventListener\('mousedown', onDown\)/);
  assert.match(COMPOSER, /event\.key === 'Escape'/);
  // Bound only while open, and removed on the way out — a composer that is
  // closed should cost nothing, and a listener left behind is a leak.
  assert.match(COMPOSER, /if \(!addOpen\) return undefined;/);
  assert.match(COMPOSER, /document\.removeEventListener\('mousedown', onDown\)/);
});

test('the wrapper is the positioning context and the press boundary', () => {
  // `addRef` is on the wrapper, so a press on the MENU is inside it. Put the
  // ref on the button instead and choosing a row closes the menu by
  // outside-press before the row's own handler runs.
  assert.match(COMPOSER, /className="messages-composer-add" ref=\{addRef\}/);
  assert.match(COMPOSER, /addRef\.current\?\.contains\(event\.target as Node\)/);
  assert.match(rule('.messages-composer-add'), /position: relative;/);
});

test('the menu sits above the bar, left-aligned to the button', () => {
  const body = rule('.messages-composer-menu');
  assert.match(body, /position: absolute;/);
  assert.match(body, /bottom: calc\(100% \+ 6px\);/, 'above the composer, not over the thread');
  assert.match(body, /left: 0;/);
  assert.match(rule('.messages-composer-menu button'), /padding: 9px 12px;/);
});
