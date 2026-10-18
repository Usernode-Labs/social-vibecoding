// Every phone page bounces at its foot, however short it is (#3566).
//
// ── The bug ────────────────────────────────────────────────────────────
//
// "Should be able to over scroll on home page down, doesn't feel as native
// because can't", in the installed iPhone app. iOS rubber-bands only a box
// that has scroll range; a page whose content exactly fills the screen has
// none, so the drag falls through to the document, which the installed shell
// holds still on purpose. #3520 solved the same thing for a project's short
// tabs with one invisible pixel hung below the scroller's bottom edge.
//
// ── What is pinned ─────────────────────────────────────────────────────
//
//   * Every screen root in App.SCREEN_IDS opts in with `data-page-bounce`,
//     except a named few whose root is not the page's scroller (a running
//     app, a chat that opens at its newest line, a thread).
//   * The reported screen, Communities, and the Messages list — the one
//     page whose root is `overflow: hidden`, so the list itself is the
//     scroller — carry it.
//   * The rule is the same one-pixel mechanism: a touch screen only, not in
//     a phone browser (where #3591's document bounce already owns it), and
//     `position: relative` plus an absolute 1px `::after` at `bottom: -1px`.
//   * Communities' Needs you, fitted to the screen on purpose, is exempted
//     by a rule of its own, so an engine without `:has()` drops only the
//     exemption and never the pixel.
//
// Run with: node --test tests/page-overscroll.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CSS = read('public/css/app.css');
/** The stylesheet without its comments, so a selector can be read on its own. */
const CSS_NC = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const APP_JS = read('public/js/app.js');
const DAPP = JSON.parse(read('dapp.json'));

/** Root ids that are screen roots but not a page's scroller, and why. */
const EXEMPT = new Map([
  ['app-view', 'a running app is somebody else\'s document'],
  ['messages-screen', 'the root is overflow:hidden; .messages-list-scroll scrolls'],
  ['global-chat-screen', 'a chat opens at its newest line, not a page'],
  ['agent-session-screen', 'an agent session is a chat, not a page'],
]);

// ── helpers ────────────────────────────────────────────────────────────

/** The body of the `@media (pointer: coarse)` block that holds `needle`. */
function coarseMediaBlock(needle) {
  const opener = '@media (pointer: coarse) {';
  let from = 0;
  while (from < CSS.length) {
    const start = CSS.indexOf(opener, from);
    if (start < 0) break;
    let depth = 0;
    let end = start;
    for (let i = CSS.indexOf('{', start); i < CSS.length; i += 1) {
      if (CSS[i] === '{') depth += 1;
      else if (CSS[i] === '}') {
        depth -= 1;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    const block = CSS.slice(start, end);
    if (block.includes(needle)) return block;
    from = end;
  }
  return null;
}

/** Every rule (selector + body) whose selector text mentions `needle`. */
function rulesMentioning(needle) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(CSS_NC))) {
    const selector = m[1].trim();
    if (selector.startsWith('@') || !selector.includes(needle)) continue;
    out.push({ selector, body: m[2] });
  }
  return out;
}

/** Source files under frontend/src, so a screen root can be found by id. */
function reactSources(dir = path.join(ROOT, 'frontend/src'), out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) reactSources(full, out);
    else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) {
      out.push({ rel: path.relative(ROOT, full), text: fs.readFileSync(full, 'utf8') });
    }
  }
  return out;
}

/** The React element whose opening tag declares `id="<id>"`, source and tag. */
function rootTag(id, sources) {
  for (const src of sources) {
    const re = new RegExp(`<[A-Za-z][^>]*\\bid="${id}"[^>]*>`, 'g');
    const m = re.exec(src.text);
    if (m) return { rel: src.rel, tag: m[0] };
  }
  return null;
}

const SOURCES = reactSources();

// ── Every screen root that is a page opts in ───────────────────────────

const screenIds = (() => {
  const i = APP_JS.indexOf('SCREEN_IDS: [');
  assert.ok(i >= 0, 'App.SCREEN_IDS not found in public/js/app.js');
  const j = APP_JS.indexOf(']', i);
  return [...APP_JS.slice(i, j).matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
})();

test('App.SCREEN_IDS names the screens this test walks', () => {
  assert.ok(screenIds.length >= 10, `expected the screen roots, got ${screenIds.join(', ')}`);
  for (const id of EXEMPT.keys()) {
    assert.ok(screenIds.includes(id), `${id} is exempted but is no longer a screen root`);
  }
});

for (const id of screenIds) {
  if (EXEMPT.has(id)) {
    test(`${id} is still a screen root, and exempt: ${EXEMPT.get(id)}`, () => {
      assert.ok(rootTag(id, SOURCES), `expected a root with id="${id}"`);
    });
    continue;
  }
  test(`#${id} opts into the page bounce`, () => {
    const found = rootTag(id, SOURCES);
    assert.ok(found, `expected a React root with id="${id}"`);
    assert.match(found.tag, /\bdata-page-bounce=""/,
      `${found.rel}: the #${id} root must carry data-page-bounce="" so a short page bounces`);
  });
}

test('the reported screens opt in: Communities, and the Messages list', () => {
  const workshop = rootTag('workshop-screen', SOURCES);
  assert.ok(workshop, 'expected a root with id="workshop-screen"');
  assert.match(workshop.tag, /\bdata-page-bounce=""/, '#workshop-screen must carry data-page-bounce=""');

  // Messages' root is overflow:hidden, so the LIST is the scroller.
  const messages = SOURCES.find((s) => s.rel.endsWith('features/messages/index.tsx'));
  assert.ok(messages, 'expected frontend/src/features/messages/index.tsx');
  const re = /className="messages-list-scroll[^"]*"[\s\S]{0,200}?>/;
  const m = messages.text.match(re);
  assert.ok(m, 'expected the .messages-list-scroll element');
  assert.match(m[0], /\bdata-page-bounce=""/,
    'the Messages list, not its overflow:hidden root, must carry data-page-bounce=""');
});

// ── The CSS shape ──────────────────────────────────────────────────────

const BLOCK = coarseMediaBlock('[data-page-bounce]');

test('the pixel lives on a touch screen only, and not in a phone browser', () => {
  assert.ok(BLOCK, 'expected a @media (pointer: coarse) block carrying [data-page-bounce]');
  const rules = [...BLOCK.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].trim().replace(/\s+/g, ' '), body: m[2],
  }));
  assert.ok(rules.length >= 2, 'expected the scroller rule and its ::after');
  for (const r of rules) {
    assert.match(r.selector, /^html:not\(\[data-browser-scroller\]\) \[data-page-bounce\]/,
      `"${r.selector}" must sit under html:not([data-browser-scroller]), so #3591's `
      + 'document bounce is the one that applies in a phone browser');
  }
});

test('the scroller becomes a containing block', () => {
  const r = BLOCK && BLOCK.match(/html:not\(\[data-browser-scroller\]\) \[data-page-bounce\]\s*\{([^}]*)\}/);
  assert.ok(r, 'expected the [data-page-bounce] scroller rule');
  assert.match(r[1], /position:\s*relative/,
    'absolute offsets are against the padding box, so the scroller must be position: relative');
});

test('one absolute pixel hangs 1px below the scroller\'s bottom edge', () => {
  const r = BLOCK && BLOCK.match(/\[data-page-bounce\]::after\s*\{([^}]*)\}/);
  assert.ok(r, 'expected the [data-page-bounce]::after rule');
  const body = r[1];
  assert.match(body, /content:\s*''/, 'the box must have content, or it is not generated');
  assert.match(body, /position:\s*absolute/, 'absolute, so a flex fill cannot absorb it');
  assert.match(body, /bottom:\s*-1px/, 'it must sit 1px below the bottom edge, adding scroll range');
  assert.match(body, /height:\s*1px/, 'one pixel of range is the whole mechanism');
  assert.match(body, /pointer-events:\s*none/, 'the pixel must not take a tap');
});

test('the main rules do not depend on :has()', () => {
  const selectors = rulesMentioning('[data-page-bounce]').map((r) => r.selector);
  assert.ok(selectors.includes('html:not([data-browser-scroller]) [data-page-bounce]'),
    `expected the plain scroller rule, got: ${selectors.join(' | ')}`);
  assert.ok(selectors.includes('html:not([data-browser-scroller]) [data-page-bounce]::after'),
    `expected the plain ::after rule, got: ${selectors.join(' | ')}`);
});

test("Communities' Needs you is exempted by a rule of its own", () => {
  const exemption = rulesMentioning('[data-page-bounce]')
    .find((r) => r.selector.includes(':has([data-workshop-pane="needs"])'));
  assert.ok(exemption, 'expected a [data-page-bounce]:has([data-workshop-pane="needs"]) rule');
  assert.match(exemption.body, /content:\s*none/, 'the fitted Needs you feed must not get the pixel');
});

// ── The earlier document bounce is still there ─────────────────────────

test("#3591's phone-browser bounce is untouched", () => {
  const r = rulesMentioning('data-browser-past-top')
    .find((r) => r.selector.includes('html[data-browser-scroller][data-browser-past-top]'));
  assert.ok(r, 'expected the #3591 data-browser-past-top rule');
  assert.match(r.body, /overscroll-behavior-y:\s*contain/);
});

test('no [data-page-bounce] rule applies in phone-browser mode', () => {
  for (const r of rulesMentioning('[data-page-bounce]')) {
    assert.ok(r.selector.includes('html:not([data-browser-scroller])'),
      `"${r.selector}" would apply where the document scroller owns the bounce`);
    assert.doesNotMatch(r.selector, /html\[data-browser-scroller\]/,
      `"${r.selector}" positively matches phone-browser mode`);
  }
});

// ── The running app proves the attribute is there ──────────────────────

test('a declared check selects the Communities root by its new attribute', () => {
  const check = (DAPP.tests || []).find((t) => /empty-state line while it has rows/.test(t.name || ''));
  assert.ok(check, 'expected the Communities declared check');
  assert.match(check.expectSelector, /#workshop-screen[^\s]*\[data-page-bounce\]/,
    'the Communities check must require #workshop-screen[data-page-bounce] in the running app');
  assert.match(check.name, /#3566/, 'the check should name the issue it proves');
});
