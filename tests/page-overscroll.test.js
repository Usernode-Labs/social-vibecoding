'use strict';

// Every page bounces at its foot on a phone, however short it is (#3566).
//
// A page that fits entirely on the screen has nothing to scroll, so iOS hands
// the drag to the document, which the shell holds still. The fix is the one a
// project page's growing tabs already use (see the `#dev-forum-scroll` block
// in app.css): a 1px box hung 1px below the page scroller, which puts a pixel
// of scrollable overflow into it whatever the content does. A page opts in
// with `data-page-bounce`.
//
// These pin three things: every screen root carries the attribute or is named
// below with a reason; the two roots whose scroller is a child rather than the
// root itself are pointed at correctly; and the CSS keeps the pixel hung below
// the scroller, on a touch screen, only where the screen is the scroller.
//
// Run with: node --test tests/page-overscroll.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CSS = read('public/css/app.css');
const APP_JS = read('public/js/app.js');

// The pages that do not opt in, and why. Each one is still a screen root.
const EXEMPT = {
  'app-view': 'a project page and a running app: #dev-forum-scroll has the bounce for its growing tabs',
  'messages-screen': 'the root is overflow: hidden; the list scrolls inside it',
  'global-chat-screen': 'a chat, not a page: it stays on its newest line',
  'agent-session-screen': 'a chat, not a page: it stays on its newest line',
};

const SCREEN_IDS = (() => {
  const m = APP_JS.match(/SCREEN_IDS:\s*\[([^\]]*)\]/);
  assert.ok(m, 'expected App.SCREEN_IDS in public/js/app.js');
  return [...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]);
})();

/** Every .tsx source under frontend/src. */
function tsxSources() {
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.tsx')) {
        out.push({ rel: path.relative(ROOT, full), src: fs.readFileSync(full, 'utf8') });
      }
    }
  })(path.join(ROOT, 'frontend/src'));
  return out;
}

/**
 * The whole opening tag that carries `id="<id>"` (or `id="<id>"`-less
 * selectors such as a class), found with a brace-aware scan so a `=>` inside
 * an attribute does not end it early.
 */
function openingTagWith(src, needle) {
  const at = src.indexOf(needle);
  if (at < 0) return null;
  const start = src.lastIndexOf('<', at);
  assert.ok(start >= 0, `no opening tag before ${needle}`);
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (c === '>' && depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`unterminated tag carrying ${needle}`);
}

/** A rule's body by exact selector, the selector line trimmed of indentation. */
function ruleIn(block, selector) {
  const i = block.indexOf(`${selector} {`);
  assert.ok(i >= 0, `expected a \`${selector}\` rule`);
  return block.slice(i, block.indexOf('\n  }', i) + 1);
}

test('every screen root is a page that bounces, or says why not', () => {
  const sources = tsxSources();
  const missing = [];
  for (const id of SCREEN_IDS) {
    if (id in EXEMPT) continue;
    const holders = sources
      .map(({ rel, src }) => ({ rel, tag: openingTagWith(src, `id="${id}"`) }))
      .filter((h) => h.tag);
    assert.ok(holders.length > 0, `no TSX opening tag carries id="${id}"`);
    assert.equal(holders.length, 1, `id="${id}" is on more than one tag`);
    if (!/data-page-bounce=""/.test(holders[0].tag)) missing.push(`${id} (${holders[0].rel})`);
  }
  assert.deepEqual(missing, [],
    'these screen roots do not opt into the one-pixel bounce; add '
    + 'data-page-bounce="" to their root tag, or name them in EXEMPT with a reason');

  // An exemption that names something which is no longer a screen root is
  // stale, and the next reader would believe it.
  for (const id of Object.keys(EXEMPT)) {
    assert.ok(SCREEN_IDS.includes(id), `EXEMPT names "${id}", which is not a screen root any more`);
  }
});

test('Communities and the Messages list carry the attribute', () => {
  const workshop = tsxSources().find((s) => s.rel === 'frontend/src/features/workshop/index.tsx');
  assert.ok(workshop);
  assert.equal([...workshop.src.matchAll(/id="workshop-screen"/g)].length, 1,
    'expected exactly one #workshop-screen root');
  const wsTag = openingTagWith(workshop.src, 'id="workshop-screen"');
  assert.match(wsTag, /data-page-bounce=""/);

  const messages = tsxSources().find((s) => s.rel === 'frontend/src/features/messages/index.tsx');
  assert.ok(messages);
  const listTag = openingTagWith(messages.src, 'className="messages-list-scroll platform-safe-scroll"')
    || openingTagWith(messages.src, '.messages-list-scroll');
  assert.ok(listTag, 'expected the .messages-list-scroll list in frontend/src/features/messages/index.tsx');
  assert.match(listTag, /data-page-bounce=""/,
    'the Messages root is overflow: hidden; the list inside it is the scroller');
});

test('the pixel is hung below the scroller, on a touch screen, only where the scroller is the page', () => {
  const mediaAt = CSS.indexOf('@media (pointer: coarse) {\n  html:not([data-browser-scroller]) [data-page-bounce] {');
  assert.ok(mediaAt >= 0, 'expected the data-page-bounce block inside @media (pointer: coarse)');
  const block = CSS.slice(mediaAt, CSS.indexOf('\n}\n', CSS.indexOf('[data-page-bounce]:has([data-workshop-pane="needs"])::after', mediaAt)));

  const scroller = ruleIn(block, '  html:not([data-browser-scroller]) [data-page-bounce]');
  assert.match(scroller, /position:\s*relative/,
    'the scroller is the pseudo-element\'s containing block');

  const pixel = ruleIn(block, '  html:not([data-browser-scroller]) [data-page-bounce]::after');
  assert.match(pixel, /content:\s*''/);
  assert.match(pixel, /position:\s*absolute/);
  assert.match(pixel, /bottom:\s*-1px/);
  assert.match(pixel, /height:\s*1px/);
  assert.match(pixel, /pointer-events:\s*none/);
  assert.doesNotMatch(scroller, /:has\(/, 'the bounce must not depend on :has()');

  const exclusion = ruleIn(block,
    '  html:not([data-browser-scroller]) [data-page-bounce]:has([data-workshop-pane="needs"])::after');
  assert.match(exclusion, /content:\s*none/,
    'the Communities Needs you feed is fitted on purpose and keeps no pixel');
});

test('the paged document keeps its own foot and none of this pixel', () => {
  assert.match(CSS, /html\[data-browser-scroller\]\[data-browser-past-top\],\s*\n\s*html\[data-browser-scroller\]\[data-browser-past-top\] body \{\s*\n\s*overscroll-behavior-y:\s*contain;/,
    'the document bounce that already covers a phone browser\'s pages is left alone');

  // In a phone browser the root is `overflow: visible`, so a pixel below it
  // would only lengthen a page the browser already bounces.
  const pixelSelectors = [...CSS.matchAll(/[^\n{}]*\[data-page-bounce\][^\n{}]*::after[^{]*\{/g)]
    .map((m) => m[0].trim());
  assert.ok(pixelSelectors.length >= 2, 'expected the pixel and its Needs you exclusion');
  for (const selector of pixelSelectors) {
    assert.match(selector, /^html:not\(\[data-browser-scroller\]\) /,
      `a data-browser-scroller route must not receive the pixel: ${selector}`);
  }
});
