'use strict';

// #4482: a C comment's pin over its screenshot in the request view.
// frontend/src/features/dev-board/topic/screenshot-pins.ts draws the dot
// and the bubble over the embedded image, and request-head.tsx carries the
// toggle that hides them. Pure helpers here; the toggle is a source check
// on the component, which the fold's own suite shape already uses.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const { loadTsx } = require('./lib/render-tsx');
const pins = loadTsx('frontend/src/features/dev-board/topic/screenshot-pins.ts');

const ID = 'ab'.repeat(16);
const img = (id) => `<p><img src="https://app.onhomeroom.com/issue-images/${id}" alt="Screenshot"></p>`;
const PIN = { x: 0.25, y: 0.75, comment: 'had to refresh' };

// ── the ids the body embeds ───────────────────────────────────────────

test('issueImageIds finds the embedded ids, dedupes and caps at 3', () => {
  assert.deepEqual(pins.issueImageIds(img(ID)), [ID]);
  assert.deepEqual(pins.issueImageIds('<p>no images here</p>'), []);
  assert.deepEqual(pins.issueImageIds(''), []);
  const b = 'bb'.repeat(16);
  const c = 'cc'.repeat(16);
  assert.deepEqual(pins.issueImageIds(img(ID) + img(b) + img(ID) + img(c)), [ID, b, c], 'deduped, in order');
  const d = 'dd'.repeat(16);
  const e = 'ee'.repeat(16);
  assert.deepEqual(pins.issueImageIds(img(b) + img(c) + img(d) + img(e) + img(ID)),
    [b, c, d], 'at most 3, as the server caps one request’s images');
});

// ── the overlay wrapped around a pinned image ────────────────────────

test('withPins wraps only the pinned image, with the dot and bubble at the pin’s spot', () => {
  const b = 'bb'.repeat(16);
  const html = img(ID) + img(b);
  const out = pins.withPins(html, { [ID]: PIN });
  assert.ok(out.includes(`src="https://app.onhomeroom.com/issue-images/${ID}"`), 'the image itself is untouched underneath');
  assert.match(out, new RegExp(`<span class="dev-request-pin-shot"><img[^>]*issue-images/${ID}[^>]*>`));
  assert.match(out, /<span class="dev-request-pin-dot" style="left:25%;top:75%"><\/span>/);
  assert.match(out, /<span class="dev-request-pin-bubble is-up" style="left:25%;top:75%">had to refresh<\/span>/,
    'y = 0.75 is past the bottom threshold, so the bubble opens upward');
  assert.ok(out.includes(img(b)), 'an image without a pin is byte-identical');
});

test('withPins escapes the comment’s words, and flips the bubble at the thresholds', () => {
  const out = pins.withPins(img(ID), { [ID]: { x: 0.9, y: 0.95, comment: '<script>alert(1)</script>' } });
  assert.ok(out.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the words stay text');
  assert.ok(!out.includes('<script>'), 'nothing runs');
  assert.match(out, /dev-request-pin-bubble is-left is-up/, 'flipped left and up at the edges');
  assert.match(pins.withPins(img(ID), { [ID]: { x: 0.6, y: 0.61, comment: 'x' } }), / is-left(?![\w-])/);
  assert.match(pins.withPins(img(ID), { [ID]: { x: 0.55, y: 0.6, comment: 'x' } }),
    /dev-request-pin-bubble" /, 'exactly at a threshold, not flipped');
});

test('withPins leaves html with no pins byte-identical', () => {
  const html = `<p>words</p>${img(ID)}<p>more</p>`;
  assert.equal(pins.withPins(html, {}), html);
  assert.equal(pins.withPins(html, null), html);
  assert.equal(pins.withPins(html, { [ID]: null }), html);
});

// ── the toggle in the request's words ────────────────────────────────

test('the request’s words carry the toggle and the hide switch', () => {
  const head = read('frontend/src/features/dev-board/topic/request-head.tsx');
  for (const label of ['Hide comment', 'Show comment', 'Hide comments', 'Show comments']) {
    assert.ok(head.includes(`'${label}'`), `the ${label} label`);
  }
  assert.match(head, /aria-pressed=\{hidePins\}/);
  assert.match(head, /data-pins-hidden=\{hidePins \? '' : undefined\}/);
  assert.match(head, /dev-request-pins-toggle/);
  assert.match(head, /pinCount > 0 && \(!folds \|\| open\)/, 'the button only shows when the screenshot can be seen');
  // The words only ever render through withPins, keyed on the body html.
  assert.match(head, /withPins\(html, pins\)/);
  assert.match(head, /issueImageIds\(html\)/);
});

// ── the styles, where the words are drawn ────────────────────────────

test('app.css draws the overlay, and the hide switch takes it away', () => {
  const css = read('public/css/app.css');
  assert.match(css, /\.dev-request-pin-shot \{[^}]*position: relative/, 'the overlay hangs off the image’s wrapper');
  assert.match(css, /\.dev-request-pin-overlay \{[^}]*pointer-events: none/, 'a tap still reaches the image viewer');
  assert.match(css, /\.dev-request-pin-dot \{[^}]*#0a6ee0/);
  assert.match(css, /\.dev-request-pin-bubble \{[^}]*-webkit-line-clamp: 6/, 'at most six lines, like the painted bubble');
  assert.match(css, /\.dev-request-ask\[data-pins-hidden\] \.dev-request-pin-overlay \{ display: none; \}/);
  assert.match(css, /\.dev-request-pin-bubble\.is-left/);
  assert.match(css, /\.dev-request-pin-bubble\.is-up/);
});
