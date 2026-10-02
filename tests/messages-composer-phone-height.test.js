'use strict';

// #3735: the one-line Messages composer carried ~19px of padding and a 40px
// send disc on a phone, all of it air around a field that is itself only
// 22px of text. These pins hold the phone overrides to the sizes the change
// chose, and the desktop rules to what they were — the media block sits
// after the base rules, so only the phone wins the cascade.

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

test('desktop keeps the base sizes it had', () => {
  const bar = rule('.messages-composer,\n.messages-composer-disabled');
  assert.match(bar, /padding: 6px 12px 8px;/);
  const card = rule('.messages-composer-card');
  assert.match(card, /padding: 8px 8px 8px 12px;/);
  const input = rule('.messages-composer-input');
  assert.match(input, /min-height: 40px;/);
  assert.match(input, /max-height: 140px;/);
  assert.match(input, /padding: 9px 4px;/);
  const send = rule('.messages-send');
  assert.match(send, /width: 40px;/);
  assert.match(send, /height: 40px;/);
});

test('the phone-width overrides tighten the four parts of the bar', () => {
  const i = CSS.indexOf('@media (max-width: 767px) {\n  .messages-composer {');
  assert.ok(i >= 0, 'expected a phone-width composer block after the base rules');
  const block = CSS.slice(i, CSS.indexOf('\n}', i));
  assert.match(block, /\.messages-composer \{ padding: 4px 12px 6px; \}/);
  assert.match(block, /\.messages-composer-card \{ padding: 5px 6px 5px 12px; \}/);
  assert.match(block, /\.messages-composer-input \{ min-height: 28px; padding: 5px 4px; \}/);
  assert.match(block, /\.messages-send \{ width: 36px; height: 36px; \}/);
  // The overrides sit after the base rules so the cascade carries them.
  const base = CSS.indexOf('\n.messages-composer-card {');
  assert.ok(i > base, 'the phone block must come after the base composer rules');
});

// The count row is always laid out (QA 2026-09-24) so it cannot push the
// composer up with the first keystroke; the phone change compacts it, and
// the aria state that hides it from readers when empty stays as it was.
test('the count row stays always laid out and carries the compacted classes', () => {
  assert.match(COMPOSER, /<div className="mt-0\.5 px-1 flex justify-end h-\[12px\]" aria-hidden=\{!value\.length\}>/);
  assert.match(COMPOSER, /leading-\[12px\]/);
  assert.doesNotMatch(COMPOSER, /h-\[15px\]/);
  assert.doesNotMatch(COMPOSER, /leading-\[15px\]/);
});
