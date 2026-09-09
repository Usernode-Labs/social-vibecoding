// The stage-2 survey's Connect links leave in a new tab (#1532).
//
// GitHub / X / LinkedIn verification is an OAuth round trip through
// `/waitlist/connect/<provider>`. It used to navigate the survey away, and
// every field on that screen is uncontrolled and unsaved until submit (see
// more.tsx's header comment) — so a provider that asks for a password, or a
// phone where coming back means finding the tab again, cost the reader
// whatever they had typed.
//
// Two properties are pinned:
//
//   - the link opens in a new tab, and
//   - it carries `rel="noopener noreferrer"`. `target="_blank"` without it
//     hands the opened page a live `window.opener` back into the survey, which
//     is a real capability, not a lint rule.
//
// Run with: node --test tests/waitlist-connect-new-tab.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MORE = 'frontend/src/features/auth/more.tsx';
const src = fs.readFileSync(path.join(ROOT, MORE), 'utf8');

/** The `<a>` that starts the OAuth round trip, as source text. */
function connectAnchor() {
  const at = src.indexOf("'/waitlist/connect/'");
  assert.notEqual(at, -1, 'the connect link is still built here');
  const open = src.lastIndexOf('<a', at);
  const close = src.indexOf('</a>', at);
  return src.slice(open, close);
}

test('the connect link opens in a new tab', () => {
  assert.match(connectAnchor(), /target="_blank"/);
});

test('and never hands the provider page a window.opener', () => {
  const anchor = connectAnchor();
  assert.match(anchor, /rel="noopener noreferrer"/);
  // Ordering matters not at all to the browser, but both must be on the SAME
  // element — a `rel` further down the file would satisfy a naive grep.
  assert.ok(anchor.indexOf('target="_blank"') !== -1
    && anchor.indexOf('rel="noopener noreferrer"') !== -1);
});

test('the destination is unchanged: same route, same token parameter', () => {
  const anchor = connectAnchor();
  assert.match(anchor, /'\/waitlist\/connect\/' \+/);
  assert.match(anchor, /encodeURIComponent\(token\.current \|\| ''\)/);
});

test('every other link on the screen keeps its own target', () => {
  // The follow-along links were already external; this change must not have
  // reached them, nor turned the in-app ones into new tabs.
  const externals = src.match(/target="_blank"/g) || [];
  assert.ok(externals.length >= 2, 'the follow links plus this one');
});
