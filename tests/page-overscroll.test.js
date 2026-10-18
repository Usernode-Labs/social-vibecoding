// Every page bounces at its foot on a phone, however short it is (#3566).
//
// ── The bug ────────────────────────────────────────────────────────────
//
// "Should be able to over scroll on home page down, doesn't feel as native
// because can't." On a phone, a screen that scrolls itself only rubber-bands
// when it has a scroll range. A short page has `scrollHeight === clientHeight`,
// so a drag at its foot has nowhere to move and chains to the document, which
// the installed shell holds still on purpose. A project's short tabs already
// carry the fix (#3520/#3544): a transparent 1px box hung below the scroller,
// which adds exactly the range the platform needs. This applies the same
// mechanism to every page scroller.
//
// ── What is pinned ─────────────────────────────────────────────────────
//
// Each page root is marked `data-page-bounce`, the CSS gives a marked scroller
// its pixel only on a touch screen and only where the scroller is the page,
// and the paged-document bounce from #3565 keeps its own behaviour. Chats, a
// running project and the Communities Needs you feed are not pages and say so
// in EXEMPT.
//
// Run with: node --test tests/page-overscroll.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CSS = read('public/css/app.css');
const APP = read('public/js/app.js');
const SRC = path.join(ROOT, 'frontend', 'src');

const ATTR = 'data-page-bounce=""';

// Roots that are not pages. #app-view scrolls in #dev-forum-scroll (a project
// is somebody else's document and its growing tabs already carry the pixel);
// #messages-screen is `overflow: hidden` and the list inside it is the page;
// the two chat roots open on their newest line and stay there.
const EXEMPT = {
  'app-view': 'a running project scrolls in #dev-forum-scroll, which already carries the pixel',
  'messages-screen': 'overflow: hidden; .messages-list-scroll inside it is the page and carries the attribute',
  'global-chat-screen': 'a chat transcript, not a page',
  'agent-session-screen': 'a chat transcript, not a page',
};

function tsxFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (/\.(tsx|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const FILES = tsxFiles(SRC).map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));

/** The JSX opening tag holding `index`, braces and quoted props included. */
function openingTag(text, index) {
  let start = index;
  while (start > 0 && text[start] !== '<') start -= 1;
  let i = start + 1;
  let depth = 0;
  let quote = null;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') { depth += 1; continue; }
    if (ch === '}') { depth -= 1; continue; }
    if (ch === '>' && depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** Every opening tag in frontend/src whose markup carries `needle`. */
function tagsCarrying(needle) {
  const found = [];
  for (const { file, text } of FILES) {
    let at = text.indexOf(needle);
    while (at >= 0) {
      const tag = openingTag(text, at);
      if (tag) found.push({ file: path.relative(ROOT, file), tag });
      at = text.indexOf(needle, at + needle.length);
    }
  }
  return found;
}

/** A rule body by exact single-line selector text. */
function rule(selector) {
  const marker = `\n  ${selector} {`;
  const i = CSS.indexOf(marker);
  assert.ok(i >= 0, `expected a \`${selector}\` rule in app.css`);
  return CSS.slice(i + marker.length, CSS.indexOf('\n  }', i));
}

/** The balanced `@media (pointer: coarse)` block that names [data-page-bounce]. */
function coarseBlock() {
  const opener = '@media (pointer: coarse) {';
  let at = CSS.indexOf(opener);
  while (at >= 0) {
    let depth = 0;
    for (let i = at + opener.length - 1; i < CSS.length; i += 1) {
      if (CSS[i] === '{') depth += 1;
      else if (CSS[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          const block = CSS.slice(at, i + 1);
          if (block.includes('[data-page-bounce]')) return block;
          break;
        }
      }
    }
    at = CSS.indexOf(opener, at + opener.length);
  }
  return null;
}

// ── 1. Every screen root is a page that bounces, or says why it is not ──

test('every screen root is a page that bounces, or says why it is not', () => {
  const match = APP.match(/SCREEN_IDS:\s*(\[[^\]]*\])/);
  assert.ok(match, 'App.SCREEN_IDS is an array literal in app.js');
  const roots = JSON.parse(match[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));

  const stale = Object.keys(EXEMPT).filter((id) => !roots.includes(id));
  assert.deepEqual(stale, [], 'EXEMPT names roots App.SCREEN_IDS no longer has');

  const missing = [];
  for (const id of roots) {
    const tags = tagsCarrying(`id="${id}"`);
    assert.equal(tags.length, 1, `expected exactly one #${id} opening tag in frontend/src`);
    if (EXEMPT[id]) {
      assert.ok(!tags[0].tag.includes(ATTR),
        `#${id} is not a page (${EXEMPT[id]}) and must not take the pixel`);
      continue;
    }
    if (!tags[0].tag.includes(ATTR)) missing.push(`#${id} (${tags[0].file})`);
  }
  assert.deepEqual(missing, [],
    'page scrollers with no data-page-bounce="" — a short page then cannot '
    + 'rubber-band at its foot: ' + missing.join(', '));
});

// ── 2. All communities and the Messages list carry the attribute ───────

test('All communities and the Messages list carry the attribute', () => {
  const workshop = tagsCarrying('id="workshop-screen"');
  assert.equal(workshop.length, 1, 'exactly one #workshop-screen tag');
  assert.ok(workshop[0].tag.includes(ATTR), '#workshop-screen must carry data-page-bounce=""');

  const list = tagsCarrying('className="messages-list-scroll platform-safe-scroll"');
  assert.equal(list.length, 1, 'exactly one .messages-list-scroll tag');
  assert.equal(list[0].file, 'frontend/src/features/messages/index.tsx',
    'the Messages list is drawn by features/messages/index.tsx');
  assert.ok(list[0].tag.includes(ATTR), '.messages-list-scroll must carry data-page-bounce=""');
});

// ── 3. The pixel is below the scroller, on touch, only as the page ─────

test('the pixel is hung below the scroller, on a touch screen, only where the scroller is the page', () => {
  const block = coarseBlock();
  assert.ok(block, 'the [data-page-bounce] rules live inside @media (pointer: coarse)');

  const scope = 'html:not([data-browser-scroller])';
  const base = rule(`${scope} [data-page-bounce]`);
  assert.match(base, /position:\s*relative/, '#[data-page-bounce] must be the pixel\'s containing block');
  assert.doesNotMatch(base, /:has\(/,
    'the pixel rule itself must not depend on :has(), or an engine without it drops the pixel');

  const pixel = rule(`${scope} [data-page-bounce]::after`);
  assert.match(pixel, /content:\s*''/, 'the pixel is a real box');
  assert.match(pixel, /position:\s*absolute/, 'absolute, so it adds no layout');
  assert.match(pixel, /bottom:\s*-1px/, 'hung below the scroller\'s own bottom edge');
  assert.match(pixel, /height:\s*1px/, 'exactly one pixel of extra range');
  assert.match(pixel, /pointer-events:\s*none/, 'the pixel can never take a tap');

  const needs = rule(`${scope} [data-page-bounce]:has([data-workshop-pane="needs"])::after`);
  assert.match(needs, /content:\s*none/,
    'Needs you in a community is fitted on purpose and keeps its own scrolling');
});

// ── 4. The paged document keeps its foot, and none of this pixel ───────

test('the paged document keeps its foot and none of this pixel', () => {
  assert.match(
    CSS,
    /@media \(pointer: coarse\) \{\n  html\[data-browser-scroller\]\[data-browser-past-top\],\n  html\[data-browser-scroller\]\[data-browser-past-top\] body \{\n    overscroll-behavior-y: contain;\n  \}\n\}/,
    'the #3565 bottom bounce on the paged document stays exactly as it was',
  );

  // Every rule that mentions the attribute must also exclude the paged
  // document, or the pixel would only lengthen a page the document scrolls.
  const selectors = [];
  let at = CSS.indexOf('[data-page-bounce]');
  while (at >= 0) {
    let start = at;
    while (start > 0 && CSS[start] !== '{' && CSS[start] !== '}') start -= 1;
    selectors.push(CSS.slice(start + 1, CSS.indexOf('{', at)).trim());
    at = CSS.indexOf('[data-page-bounce]', at + 1);
  }
  assert.ok(selectors.length >= 3, 'the attribute has its own rules in app.css');
  const unscoped = selectors.filter((sel) => !sel.includes(':not([data-browser-scroller])'));
  assert.deepEqual(unscoped, [],
    'a [data-page-bounce] rule that also applies where the document pages the screen');
});
