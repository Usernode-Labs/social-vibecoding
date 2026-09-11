'use strict';

// #1943: the dev chat's session strip turned white when the transcript
// scrolled. The kit adds `.un-scrolled` to headers wired through
// attachScreenFx, and `.platform-chat-header.un-scrolled` repainted the strip
// with the nav-bar white, outranking `.dc-lift-strip`'s translucent fill. The
// strip now keeps its own fill and frost in the scrolled state.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const CSS = read('public/css/app.css');
const VIEW = read('frontend/src/features/dev-chat/view.tsx');

function rule(selector, from = 0) {
  const i = CSS.indexOf(`\n${selector} {`, from);
  assert.ok(i >= 0, `expected a \`${selector}\` rule in app.css`);
  return { body: CSS.slice(i, CSS.indexOf('\n}', i)), at: i };
}

test('the scrolled session strip keeps the strip fill and frost', () => {
  const { body, at } = rule('#dc-session-header.un-scrolled');
  assert.match(body, /background-color: var\(--dc-strip-fill\);/);
  assert.match(body, /backdrop-filter: var\(--dc-frost\);/);
  assert.doesNotMatch(body, /--un-navbar-bg/, 'never the nav-bar white');
  // It sits with the strip rules it preserves; the id outranks the generic
  // `.platform-chat-header.un-scrolled` wherever that rule is.
  assert.ok(at > rule('.dc-lift-strip').at);
});

test('without backdrop-filter it falls back to the opaque strip colour', () => {
  const at = CSS.indexOf('@supports not ((backdrop-filter');
  const block = CSS.slice(at, CSS.indexOf('\n}\n', at));
  assert.match(block, /\.dc-lift-strip \{ background-color: var\(--dc-strip\); \}/);
  assert.match(block, /#dc-session-header\.un-scrolled \{ background-color: var\(--dc-strip\); \}/);
});

test('the strip is still the .dc-lift-strip the rule is written for', () => {
  const at = VIEW.indexOf('id="dc-session-header"');
  assert.ok(at > 0);
  assert.match(VIEW.slice(at, VIEW.indexOf('>', at)), /dc-lift-strip/);
});
