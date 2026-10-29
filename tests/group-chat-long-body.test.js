// A long thread message folds behind "Show more" (#6022).
//
// The fold lives in frontend/src/features/group-chat/long-body.tsx and every
// thread row draws its body through it: a request's and a change's stream,
// a channel, a reply thread, and a request's GitHub comments. This holds it
// to its promises:
//
//   1. Long is MEASURED from the laid-out box: more than twenty lines folds,
//      twenty or fewer renders as it always did (no clamp, no control).
//   2. A folded body shows fifteen lines' height, faded at the foot, with
//      "Show more" under it; open, it is whole and the control says
//      "Show less". The control carries aria-expanded.
//   3. The first render is the old markup exactly, so a short body and the
//      declared checks' `.gc-msg > .min-w-0 > div > .gc-msg-content` chain
//      are untouched.
//
// Effects do not run under renderToStaticMarkup, so the decision is a pure
// function tested here, and each state renders from the presentational half.
//
// Run with: node --test tests/group-chat-long-body.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const root = path.join(__dirname, '..');
const LONG_BODY = 'frontend/src/features/group-chat/long-body.tsx';
const TRANSCRIPT = 'frontend/src/features/group-chat/transcript.tsx';
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const mod = () => loadTsx(LONG_BODY);

// ── 1. The measurement ────────────────────────────────────────────────

test('a body is long only past twenty of its lines', () => {
  const { isLongBody, LONG_BODY_LINES } = mod();
  assert.equal(LONG_BODY_LINES, 20);
  const line = 19.5; // 13px at the body's 1.5 line height
  // Three lines, and exactly twenty: no fold.
  assert.equal(isLongBody(line * 3, line), false);
  assert.equal(isLongBody(line * 20, line), false);
  // Sub-pixel rounding a fraction over twenty is still twenty lines.
  assert.equal(isLongBody(line * 20 + 0.6, line), false);
  // Twenty-one lines, or a plan with its screenshots, folds.
  assert.equal(isLongBody(line * 21, line), true);
  assert.equal(isLongBody(2400, line), true);
  // A box with no layout (a hidden pane, the inline editor's display:none)
  // is unmeasured, not long; the observer asks again once it has a box.
  assert.equal(isLongBody(0, line), false);
  assert.equal(isLongBody(2400, 0), false);
});

test('the line height is read off the box, and `normal` counts as 1.5', () => {
  const { lineHeightPx } = mod();
  assert.equal(lineHeightPx({ lineHeight: '19.5px', fontSize: '13px' }), 19.5);
  assert.equal(lineHeightPx({ lineHeight: 'normal', fontSize: '15px' }), 22.5);
  assert.equal(lineHeightPx({ lineHeight: '', fontSize: '' }), 0);
});

test('a folded body shows fifteen lines, as complete Tailwind literals', () => {
  const { FOLD_CLASS, FADE_CLASS } = mod();
  // 15 × the body's 1.5em line. Spelled out so the extractor compiles it.
  assert.equal(FOLD_CLASS, 'max-h-[22.5em] overflow-hidden');
  const src = read(LONG_BODY);
  assert.ok(src.includes(`'${FOLD_CLASS}'`));
  assert.ok(src.includes(`'${FADE_CLASS}'`));
  assert.match(FADE_CLASS, /^\[mask-image:linear-gradient\(/);
});

// ── 2. Each state's markup ────────────────────────────────────────────

const view = (props) => renderToHtml(createElement(mod().LongBodyView, {
  html: { __html: '<p>the plan</p>' },
  ...props,
}));

test('a short body renders exactly as before: no clamp, no control', () => {
  const html = view({ long: false, expanded: false });
  assert.equal(html, '<div class="gc-msg-content"><p>the plan</p></div>');
});

test('a long body folds, fades, and offers "Show more"', () => {
  const { FOLD_CLASS, FADE_CLASS } = mod();
  const html = view({ long: true, expanded: false });
  assert.ok(html.startsWith(`<div class="gc-msg-content ${FOLD_CLASS} ${FADE_CLASS}"><p>the plan</p></div>`),
    'the clamp goes on .gc-msg-content itself, never a wrapper around it');
  const more = message('chat:group.row.showMore');
  assert.equal(more, 'Show more');
  assert.match(html, new RegExp(`<button[^>]*aria-expanded="false"[^>]*>${more}</button>`));
  assert.match(html, /<button[^>]*class="[^"]*\bgc-msg-more\b/);
  assert.match(html, /<button[^>]*type="button"/);
});

test('opened, the body is whole and the control says "Show less"', () => {
  const html = view({ long: true, expanded: true });
  assert.ok(html.startsWith('<div class="gc-msg-content"><p>the plan</p></div>'),
    'nothing is clamped or faded once opened');
  const less = message('chat:group.row.showLess');
  assert.equal(less, 'Show less');
  assert.match(html, new RegExp(`<button[^>]*aria-expanded="true"[^>]*>${less}</button>`));
});

test('the stateful Body first renders the old markup, unfolded', () => {
  // The decision is a layout effect; before it, the row is what it was.
  const html = renderToHtml(createElement(mod().Body, { html: '<p>hi</p>' }));
  assert.equal(html, '<div class="gc-msg-content"><p>hi</p></div>');
});

test('the Body watches for growth: a resize and a picture loading', () => {
  const src = read(LONG_BODY);
  assert.match(src, /new ResizeObserver\(measure\)/);
  // Images do not bubble `load`, so it listens in the capture phase.
  assert.match(src, /addEventListener\('load', measure, true\)/);
  assert.match(src, /removeEventListener\('load', measure, true\)/);
});

// ── 3. Every thread row draws through it ──────────────────────────────

test('the transcript\'s rows use the folding Body, not a copy of the old one', () => {
  const src = read(TRANSCRIPT);
  assert.match(src, /import \{ Body \} from '\.\/long-body';/);
  assert.doesNotMatch(src, /function Body\(/);
  // MessageRow (channels, reply threads, request and change streams) and
  // GitHubRow (a request's GitHub comments).
  assert.equal((src.match(/<Body html=\{msg\.bodyHtml\} \/>/g) || []).length, 2);
});

// ── 4. Opening holds the reader's place; folded links are no hidden tab stops ──

test('Show more stops the thread\'s follow before it opens the body', () => {
  // The follow itself is driven in tests/group-chat-thread-follow.test.js.
  const src = read(LONG_BODY);
  assert.match(src, /holdReadingPosition\?\.\(bodyRef\.current\);\s*setExpanded\(true\);/);
  assert.match(read('public/js/group-chat.js'), /holdReadingPosition\(el\) \{/);
});

test('tabbing through a folded comment with links opens it at the first hidden one', () => {
  const { focusIsClipped, LONG_BODY_LINES } = mod();
  assert.equal(LONG_BODY_LINES, 20);
  const line = 19.5;
  // The folded box: 15 lines tall, the last two of them the fade.
  const box = { top: 100, bottom: 100 + line * 15 };
  const fade = line * 2;
  // The comment's links, in tab order, by where each one's line ends.
  const links = [
    { name: 'a link on line 2', bottom: 100 + line * 2 },
    { name: 'a mention on line 12', bottom: 100 + line * 12 },
    { name: 'a ref chip in the fade, line 14', bottom: 100 + line * 14 },
    { name: 'a link on line 30, clipped', bottom: 100 + line * 30 },
  ];
  let expanded = false;
  const visited = [];
  for (const link of links) {
    // The body's focusin handler is wired only while folded.
    if (!expanded && focusIsClipped(link, box, fade)) expanded = true;
    visited.push([link.name, expanded]);
  }
  assert.deepEqual(visited, [
    ['a link on line 2', false],
    ['a mention on line 12', false],
    ['a ref chip in the fade, line 14', true],
    ['a link on line 30, clipped', true],
  ]);
});

test('the focus handler is on the folded body only, and resets its inner scroll', () => {
  const src = read(LONG_BODY);
  assert.match(src, /folded && onFocusInside \? \{ onFocus:/);
  assert.match(src, /el\.scrollTop = 0;\s*open\(\);/);
  // Static markup carries no handler attribute either way.
  const html = renderToHtml(createElement(mod().LongBodyView, {
    html: { __html: '<p><a href="#x">x</a></p>' }, long: true, expanded: false, onFocusInside: () => {},
  }));
  assert.doesNotMatch(html, /onfocus/i);
});
