'use strict';

// One bubble, not two: your turn is a card, the agent's is plain text.
//
// Both were filled surfaces — yours a solid `--accent`, the agent's
// `--bubble-bg` — which made a two-party conversation two competing blocks of
// colour and put the transcript's loudest element on the half a reader wrote
// themselves and does not need to re-read.
//
// The accent fill is the part worth guarding, because keeping type legible on
// it took seven rules and three contrast incidents recorded in app.css:
//
//   * white on the eyedropped #0a7cff is 3.93:1, which is why `--accent` was
//     darkened to #0a6ee0 in the first place;
//   * `--accent-ink` then had to invert the body, the header, and the two
//     header slots that declared colour INLINE and so beat every class rule;
//   * and the 0.72 opacity that quietened the stamp had to be re-scoped off
//     the role label after it took that one word to 2.7:1.
//
// None of that says anything a reader needs. Side, shape and surface already
// say whose turn it is. This file pins that the fill does not come back and
// that its machinery stayed retired.
//
// Run with: node --test tests/dev-chat-bubbles.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const APP_CSS = read('public/css/app.css');
const TRANSCRIPT = read('frontend/src/features/dev-chat/transcript.tsx');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

function rule(sel) {
  const at = APP_CSS.indexOf(`\n${sel} {`);
  assert.ok(at > 0, `${sel} must be declared`);
  return APP_CSS.slice(at, APP_CSS.indexOf('}', at));
}

test('your turn is the platform card surface, not a saturated fill', () => {
  const r = rule('.dc-msg-user');
  assert.match(r, /background: var\(--bg-secondary\)/,
    'the same card-on-page pairing the composer and the run card take');
  assert.doesNotMatch(r, /var\(--accent\)/, 'never the accent fill again');
  assert.doesNotMatch(r, /var\(--accent-ink\)/, 'and so it needs no inverted ink');
});

test('the agent\'s turn is plain text on the ground', () => {
  assert.match(rule('.dc-msg-assistant'), /background: transparent/);
});

test('the fill\'s seven-rule ink inversion is gone with the fill', () => {
  // Each of these existed ONLY to keep type readable on the accent.
  for (const gone of [
    '.dc-msg-user .dc-msg-content',
    '.dc-msg-user .dc-msg-header',
    '.dc-msg-user .dc-msg-meta',
    '.dc-msg-user .dc-msg-content a',
  ]) {
    assert.ok(!APP_CSS.includes(gone), `${gone} was a consequence of the fill`);
  }
  // And the stamp keeps the quiet it had on a neutral surface: --text-muted
  // at 9px, with no opacity — that was the fill's device, and halving an
  // already-muted token is what took the label to 2.7:1.
  const meta = rule('.dc-msg-meta');
  assert.match(meta, /color: var\(--text-muted\)/);
  assert.match(meta, /font-size: 9px/);
  assert.doesNotMatch(meta, /opacity/);
});

test('--bubble-bg is retired; --accent-ink is not', () => {
  // --bubble-bg existed only because --bg-primary IS the page ground in dark,
  // so a bubble drawn on it vanished. With the agent's turn as plain text
  // there is nothing to keep distinct and it had no other reader.
  assert.doesNotMatch(APP_CSS, /--bubble-bg\s*:/, 'the token is gone');
  assert.doesNotMatch(APP_CSS, /var\(--bubble-bg\)/, 'and so is every use');

  // --accent-ink STAYS. It is the near-black-on-light-accent pair, and
  // .messages-state button is still a real accent fill — retiring it with the
  // bubble would have taken a live button's contrast with it.
  assert.match(APP_CSS, /--accent-ink: #ffffff;/);
  assert.match(APP_CSS, /--accent-ink: #0b0b0c;/);
  assert.match(rule('.messages-state button'), /color: var\(--accent-ink\)/);
});

test('"You" is read, not shown — and the agent\'s label still is', () => {
  const { Row } = loadTsx('frontend/src/features/dev-chat/transcript.tsx');
  const mine = renderToHtml(createElement(Row, {
    r: { t: 'msg', key: 'a', who: 'user', model: '', stamp: '#1', contentHtml: '<p>hi</p>' },
  }));
  // Present for a screen reader — alignment is not available to one, and it
  // is the audience the word was actually telling.
  assert.match(mine, /class="sr-only">You</,
    'the role stays in the accessible tree');

  const theirs = renderToHtml(createElement(Row, {
    r: { t: 'msg', key: 'b', who: 'ai', model: 'claude-opus · reply $0.03', stamp: '#2', contentHtml: '<p>ok</p>' },
  }));
  assert.match(theirs, /text-emerald-700 dark:text-emerald-400">AI</,
    'the agent keeps a visible label: it opens a meta line that also carries '
    + 'the model and the cost, so it is a sentence rather than a tag');
  assert.match(theirs, /claude-opus · reply \$0\.03/);
});

test('the two rows are still told apart by side and surface', () => {
  assert.match(rule('.dc-msg-user'), /margin-left: auto/);
  assert.match(rule('.dc-msg-assistant'), /margin-right: auto/);
  // Same radius on both: the deck's bubbles rely on side and surface, not on
  // a tail notch. (The notch went in the reskin; this keeps it gone.)
  assert.match(rule('.dc-msg-user'), /border-radius: 1\.25rem/);
  assert.match(rule('.dc-msg-assistant'), /border-radius: 1\.25rem/);
});
