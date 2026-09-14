'use strict';

// #1954: focusing the Messages field highlights the WHOLE input box. The
// textarea has no box of its own (outline: none, transparent), so the ring
// goes on the composer card via :focus-within, like the dev chat's .dc-card.

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

test('the composer card rings itself while anything inside it has focus', () => {
  const body = rule('.messages-composer-card:focus-within');
  assert.match(body, /box-shadow: var\(--messages-disc-shadow\), 0 0 0 2px var\(--accent\);/,
    'keeps the resting shadow and adds a 2px accent ring');
});

test('the card is the element that wraps the textarea', () => {
  assert.match(COMPOSER, /<div className="messages-composer-card">[\s\S]*?className="messages-composer-input"/);
});

test('the field itself still draws no ring of its own', () => {
  assert.match(rule('.messages-composer-input'), /\n\s*outline: none;/);
  assert.doesNotMatch(CSS, /\.messages-composer-input:focus/);
});
