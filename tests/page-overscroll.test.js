// ── A SHORT PAGE STILL HAS SOMETHING TO SCROLL (#3566) ────────────────────
//
// "Should be able to over scroll on home page down, doesn't feel as native
// because can't."
//
// iOS only rubber-bands a scroller that has something to scroll. A page
// shorter than the screen (Home on a new account, All communities with a few
// cards, the Messages list) measures scrollHeight equal to clientHeight, so a
// drag at either end is handed to the document, which the shell holds still
// on purpose, and neither end moved. The fix is the same one-pixel repair the
// project page's short tabs got in #3520: every page scroller declares itself
// with `data-page-bounce`, and a 1px box hung 1px below its bottom edge gives
// it range, so iOS's own bounce comes back at both ends.
//
// What is pinned here:
//
//   1. The enumeration: every screen root in App.SCREEN_IDS carries the
//      attribute, or is named in EXEMPT with the reason it is not a page.
//   2. The report's screens carry it: All communities (#workshop-screen) and
//      the Messages list, the one page that scrolls inside its root.
//   3. The rule: the pixel, on a coarse pointer, only where the scroller is
//      the page, with the Needs you opt-out a rule of its own.
//   4. The paged document keeps its own fix (#3565), untouched.
//
// Run with: node --test tests/page-overscroll.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const CSS = read('public/css/app.css');
const APP_JS = read('public/js/app.js');

/** The screen roots app.js swaps between (the list is the enumeration). */
function screenIds() {
  const m = APP_JS.match(/SCREEN_IDS:\s*\[([^\]]*)\]/);
  assert.ok(m, 'App.SCREEN_IDS is readable in public/js/app.js');
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

/**
 * Every JSX opening tag in `source` whose element carries `id="<id>"`.
 * A tag's `>` is the first one that does not close an arrow function
 * (`=>`) inside it, since attribute callbacks are written inline.
 */
function openingTagsFor(source, needle) {
  const tags = [];
  let i = source.indexOf(needle);
  while (i >= 0) {
    const start = source.lastIndexOf('<', i);
    let end = -1;
    for (let j = i + needle.length; j < source.length; j++) {
      if (source[j] === '>' && source[j - 1] !== '=' && source[j - 1] !== '-') { end = j; break; }
    }
    if (start >= 0 && end > start) tags.push(source.slice(start, end + 1));
    i = source.indexOf(needle, i + 1);
  }
  return tags;
}

/** Every file under frontend/src that renders `id="<id>"`. */
function filesRendering(id) {
  const dir = path.join(__dirname, '..', 'frontend/src');
  const hits = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, name.name);
      if (name.isDirectory()) walk(p);
      else if (/\.(tsx|ts|jsx|js)$/.test(name.name)) {
        const src = fs.readFileSync(p, 'utf8');
        if (src.includes(`id="${id}"`)) hits.push({ file: p, src });
      }
    }
  };
  walk(dir);
  return hits;
}

/** The screens that are not pages, with the reason each is not one. */
const EXEMPT = {
  // A project page scrolls in #dev-forum-scroll, which the #3520 rule already
  // gives its pixel for the growing tabs; Needs you and Discussion are fitted
  // on purpose and scroll inside. A running app is somebody else's document.
  'app-view': 'a running app is not this shell\'s page',
  // The root is overflow: hidden; the list scrolls in .messages-list-scroll,
  // which carries the attribute. A thread is a chat.
  'messages-screen': 'the page is .messages-list-scroll inside it',
  // A chat: the transcript opens on its newest line and stays there.
  'global-chat-screen': 'a chat transcript, not a page',
  // A chat with an agent, as Global Chat.
  'agent-session-screen': 'an agent chat transcript, not a page',
};

test('#3566: every screen root bounces or says why it is not a page', () => {
  const ids = screenIds();
  assert.ok(ids.length >= 10, `the enumeration is held (${ids.length} screen ids)`);
  assert.ok(ids.includes('home-screen') && ids.includes('workshop-screen'),
    'the report\'s screens are in the enumerated list');
  for (const key of Object.keys(EXEMPT)) {
    assert.ok(ids.includes(key), `EXEMPT key "${key}" is still a real screen id`);
  }
  const carrying = [];
  for (const id of ids) {
    const files = filesRendering(id);
    assert.ok(files.length > 0, `"${id}" is rendered somewhere under frontend/src`);
    for (const { file, src } of files) {
      const tags = openingTagsFor(src, `id="${id}"`);
      assert.ok(tags.length > 0, `a JSX tag renders id="${id}" in ${path.basename(file)}`);
      for (const tag of tags) {
        if (tag.includes('data-page-bounce')) { carrying.push(id); continue; }
        assert.ok(Object.prototype.hasOwnProperty.call(EXEMPT, id),
          `id="${id}" in ${path.basename(file)} must carry data-page-bounce or be exempt`);
      }
    }
  }
  // Non-vacuous: the attribute is doing the work, not the exemptions.
  assert.ok(carrying.filter((id) => id !== 'messages-screen').length >= 8,
    `at least eight screen roots carry the attribute (${carrying.join(', ')})`);
});

test('#3566: All communities carries it, and the Messages list carries it on the scroller', () => {
  const workshop = openingTagsFor(read('frontend/src/features/workshop/index.tsx'), 'id="workshop-screen"');
  assert.equal(workshop.length, 1);
  assert.match(workshop[0], /data-page-bounce/,
    '#workshop-screen is the screen the report names; it declares itself');
  const messages = read('frontend/src/features/messages/index.tsx');
  const listTags = openingTagsFor(messages, 'className="messages-list-scroll platform-safe-scroll"');
  assert.ok(listTags.length > 0, '.messages-list-scroll is a JSX element');
  for (const tag of listTags) {
    assert.match(tag, /data-page-bounce/,
      'the Messages list is the one page that scrolls inside its root; the scroller declares itself');
  }
});

test('#3566: the rule gives a coarse pointer one pixel, only where the scroller is the page', () => {
  const at = CSS.indexOf('[data-page-bounce]');
  assert.ok(at >= 0, 'app.css styles the attribute');
  const mediaStart = CSS.lastIndexOf('@media (pointer: coarse)', at);
  assert.ok(mediaStart >= 0, 'the rules sit inside @media (pointer: coarse)');
  // Extract the media block by brace counting, comments included.
  let depth = 0, block = '';
  for (let i = mediaStart; i < CSS.length; i++) {
    const ch = CSS[i];
    block += ch;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
  }
  assert.match(block,
    /html:not\(\[data-browser-scroller\]\) \[data-page-bounce\] \{\s*position: relative;\s*\}/,
    'the scroller becomes its own containing block, so the pixel hangs off its edge');
  const after = block.match(/html:not\(\[data-browser-scroller\]\) \[data-page-bounce\]::after \{([^}]*)\}/);
  assert.ok(after, 'a ::after draws the pixel');
  const body = after[1];
  assert.match(body, /content: ''/, 'the pixel is transparent');
  assert.match(body, /position: absolute/, 'absolute against the scroller itself');
  assert.match(body, /bottom: -1px/, 'hung 1px below the bottom edge, so no flex chain can take it back');
  assert.match(body, /height: 1px/, 'one pixel of range is all iOS needs');
  assert.match(body, /pointer-events: none/, 'the pixel takes no taps');
  // The main rules must not use :has, so an engine without it keeps the
  // pixel; the Needs you opt-out is a rule of its own and drops alone.
  for (const m of block.matchAll(/(html:not\(\[data-browser-scroller\]\)[^\n{]*)\{/g)) {
    const sel = m[1].trim();
    if (sel.includes(':has(')) {
      assert.match(sel, /\[data-workshop-pane="needs"\]/,
        'the only :has rule is the Needs you opt-out');
      assert.match(m.input.slice(m.index), /\{[^}]*content: none/,
        'the Needs you feed stays fitted to the screen: no pixel');
    } else {
      assert.doesNotMatch(sel, /:has/, `${sel.trim()} must not need :has`);
    }
  }
  assert.match(block, /html:not\(\[data-browser-scroller\]\) \[data-page-bounce\]:has\(\[data-workshop-pane="needs"\]\)::after \{\s*content: none;\s*\}/,
    'the Needs you opt-out is written as its own rule');
});

test('#3566: the paged document keeps its own fix (#3565), and never gains a pixel', () => {
  // The rule #3565 pins verbatim is still there, unchanged.
  assert.match(CSS, /@media \(pointer: coarse\) \{\n  html\[data-browser-scroller\]\[data-browser-past-top\],\n  html\[data-browser-scroller\]\[data-browser-past-top\] body \{\n    overscroll-behavior-y: contain;\n  \}\n\}/,
    'a phone\'s paged document bounces by the #3565 mark, not by this pixel');
  // No rule applies the pixel where the document is the scroller: those roots
  // are overflow: visible and a pixel would only lengthen the page.
  assert.doesNotMatch(CSS, /html\[data-browser-scroller\][^\n{]*\[data-page-bounce\]/,
    'the pixel is scoped out of browser-scroller layout');
});