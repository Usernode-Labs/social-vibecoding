// Every full page gives a little when a phone drags past its end (#3566).
//
// ── The bug ────────────────────────────────────────────────────────────
//
// On a phone, dragging past the end of a page should move it a little and
// spring back. iOS does that for a document, and the paged screens already
// get it from lib/browser-scroll.ts (`data-browser-past-top` plus the
// `contain` rule in app.css). A page that scrolls in its OWN root only
// rubber-bands when the scroller has a range; a short one has none, so the
// drag is handed to the document, which the bounded shell holds still.
//
// ── The fix these pin ──────────────────────────────────────────────────
//
// Every page scroller carries `data-page-bounce`, and app.css gives it one
// transparent pixel below its content (`::after` at bottom: -1px) under
// `@media (pointer: coarse)`. The pixel is the whole mechanism, so it must
// stay scoped to a phone and to a screen the document does not page, and
// the fitted Needs you pane must keep removing it.
//
// Run with: node --test tests/page-overscroll.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const APP = read('public/js/app.js');
const CSS = read('public/css/app.css');
const BROWSER_SCROLL = read('frontend/src/lib/browser-scroll.ts');

// The screen roots the router swaps. The list lives in app.js and is the
// same one `_showOnlyScreen` walks, so a new screen is a new page here too.
function screenIds() {
  const block = APP.match(/SCREEN_IDS:\s*\[([\s\S]*?)\]/);
  assert.ok(block, 'App.SCREEN_IDS is still declared in public/js/app.js');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

// Screens that deliberately do not take the marker, each with the reason.
// A page fitted to the screen (a chat, a running app) must not gain a pixel
// of range; the Messages list is its screen's scroller instead of the root.
const EXEMPT = {
  'app-view': 'A project page scrolls in #dev-forum-scroll, whose growing tab '
    + 'already gives it the pixel; Needs you and Discussion are fitted on purpose. '
    + 'A running app is another document entirely.',
  'messages-screen': 'The root is overflow: hidden. Its list '
    + '(.messages-list-scroll) is the page scroller and carries the attribute.',
  'global-chat-screen': 'A chat: the transcript opens on its newest line and stays there.',
  'agent-session-screen': 'A chat with an agent: the transcript opens on its newest line and '
    + 'stays there, as Global Chat.',
};

// The JSX that renders each root. Only TSX/JSX can hold an element.
function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(tsx|jsx)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const SOURCES = sourceFiles(path.join(ROOT, 'frontend', 'src')).map((file) => ({
  rel: path.relative(ROOT, file),
  text: fs.readFileSync(file, 'utf8'),
}));

/**
 * The opening tag starting at `at` (an index of `<`), with JSX braces
 * skipped so an arrow's `>` (`onClick={(e) => {`) does not end it early.
 */
function openingTagAt(text, at) {
  let depth = 0;
  let quote = null;
  for (let i = at; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') { depth += 1; continue; }
    if (ch === '}') { depth = Math.max(0, depth - 1); continue; }
    if (ch === '>' && depth === 0) return text.slice(at, i + 1);
  }
  return null;
}

/** Every JSX opening tag in the frontend sources that carries `id="<id>"`. */
function tagsWithId(id) {
  const needle = `id="${id}"`;
  const tags = [];
  for (const src of SOURCES) {
    let from = 0;
    let at;
    while ((at = src.text.indexOf(needle, from)) >= 0) {
      const open = src.text.lastIndexOf('<', at);
      const closed = src.text.lastIndexOf('>', at);
      // Only an element, never the needle inside a string or a comment.
      if (open > closed) {
        const tag = openingTagAt(src.text, open);
        if (tag && tag.includes(needle)) tags.push({ rel: src.rel, tag });
      }
      from = at + needle.length;
    }
  }
  return tags;
}

test('every screen root bounces on a phone, or is exempt with a reason', () => {
  const ids = screenIds();
  assert.ok(ids.length >= 12, `App.SCREEN_IDS has ${ids.length} screens; expected the full set`);

  const missing = [];
  for (const id of ids) {
    if (id in EXEMPT) continue;
    const tags = tagsWithId(id);
    if (!tags.length) {
      missing.push(`#${id} — no JSX root found in frontend/src`);
    } else if (!tags.every((t) => t.tag.includes('data-page-bounce=""'))) {
      missing.push(`#${id} — ${tags.map((t) => t.rel).join(', ')}`);
    }
  }
  assert.deepEqual(
    missing, [],
    'a page scroller without data-page-bounce has no range when it is short, so a phone drag '
    + 'past its end stops dead (#3566). Add `data-page-bounce=""` to the root, or name it in '
    + 'EXEMPT with the reason it stays fitted:\n  ' + missing.join('\n  '),
  );
});

test('every exemption still names a screen, with a reason', () => {
  const ids = screenIds();
  for (const [id, reason] of Object.entries(EXEMPT)) {
    assert.ok(ids.includes(id), `EXEMPT names #${id}, which is no longer in App.SCREEN_IDS`);
    assert.ok(reason && reason.length > 40, `EXEMPT's reason for #${id} is too thin to audit`);
  }
});

test('the Communities page and the Messages list carry the marker', () => {
  assert.match(
    read('frontend/src/features/workshop/index.tsx'),
    /id="workshop-screen"[\s\S]{0,200}?data-page-bounce=""/,
    '#workshop-screen is the page measured with no range once it holds a few cards',
  );
  assert.match(
    read('frontend/src/features/messages/index.tsx'),
    /className="messages-list-scroll platform-safe-scroll"[\s\S]{0,80}?data-page-bounce=""/,
    'the Messages screen root is overflow: hidden, so its list is the page scroller',
  );
});

// ── The CSS mechanism ──────────────────────────────────────────────────

function cssRule(selector) {
  const at = CSS.indexOf(`${selector} {`);
  assert.ok(at >= 0, `expected a \`${selector}\` rule in app.css`);
  let depth = 0;
  for (let i = at; i < CSS.length; i += 1) {
    if (CSS[i] === '{') depth += 1;
    else if (CSS[i] === '}') {
      depth -= 1;
      if (depth === 0) return CSS.slice(at, i + 1);
    }
  }
  return null;
}

/** [start, end] ranges of each `@media <query> { … }` block. */
function mediaBlocks(query) {
  const marker = `@media ${query} {`;
  const blocks = [];
  let from = 0;
  let at;
  while ((at = CSS.indexOf(marker, from)) >= 0) {
    let depth = 0;
    for (let i = at; i < CSS.length; i += 1) {
      if (CSS[i] === '{') depth += 1;
      else if (CSS[i] === '}') {
        depth -= 1;
        if (depth === 0) { blocks.push([at, i]); break; }
      }
    }
    from = at + marker.length;
  }
  return blocks;
}

const MAIN = 'html:not([data-browser-scroller]) [data-page-bounce]';
const AFTER = `${MAIN}::after`;
const NEEDS = `${MAIN}:has([data-workshop-pane="needs"])::after`;

test('the one pixel sentinel is phone-only and page-scroller-only', () => {
  const coarse = mediaBlocks('(pointer: coarse)');
  assert.ok(coarse.length > 0, 'app.css still has an @media (pointer: coarse) block');

  for (const selector of [MAIN, AFTER, NEEDS]) {
    const at = CSS.indexOf(`${selector} {`);
    assert.ok(
      coarse.some(([start, end]) => at > start && at < end),
      `\`${selector}\` must sit inside @media (pointer: coarse): a mouse would otherwise get a `
      + 'scrollbar over a page with nothing to scroll',
    );
  }

  assert.match(cssRule(MAIN), /position:\s*relative/, 'the scroller is the sentinel\'s containing block');
  assert.doesNotMatch(cssRule(MAIN), /:has\(/, 'the main rule must not depend on :has()');

  const after = cssRule(AFTER);
  assert.match(after, /content:\s*''/);
  assert.match(after, /position:\s*absolute/);
  assert.match(after, /bottom:\s*-1px/);
  assert.match(after, /width:\s*1px/);
  assert.match(after, /height:\s*1px/);
  assert.match(after, /pointer-events:\s*none/);

  assert.match(
    cssRule(NEEDS), /content:\s*none/,
    'a project\'s Needs you feed is fitted and scrolls inside itself, so it keeps no pixel',
  );
});

test('no [data-page-bounce] rule reaches a document the browser already pages', () => {
  const selectors = [...CSS.matchAll(/(?:^|\n)([^\n{}]*\[data-page-bounce\][^\n{}]*)\{/g)]
    .map((m) => m[1].trim());
  assert.ok(selectors.length >= 3, 'the marker\'s three rules are in app.css');
  for (const selector of selectors) {
    assert.ok(
      selector.startsWith('html:not([data-browser-scroller]) [data-page-bounce]'),
      `a [data-page-bounce] rule is unscoped and would also apply to a paged document: ${selector}`,
    );
  }
});

test('the paged document keeps its own 64px bounce rule', () => {
  assert.match(BROWSER_SCROLL, /PAST_TOP_PX\s*=\s*64/,
    'the document pages Home, Discover, Leaderboard, Profile and Settings after 64px');

  const at = CSS.indexOf('html[data-browser-scroller][data-browser-past-top]');
  assert.ok(at >= 0, 'app.css still gives the paged viewport its far-edge bounce');
  assert.match(CSS.slice(at, at + 160), /overscroll-behavior-y:\s*contain/);
});
