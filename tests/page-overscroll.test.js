// A page that fits the screen still bounces at its foot.
//
// ── The bug ────────────────────────────────────────────────────────────
//
// iOS rubber-bands a scroll area only when it has scroll RANGE. A page
// whose content fits has none, so the drag is handed to the document, which
// the bounded shell holds still (`html, body`: overflow hidden,
// overscroll-behavior-y: none), and neither end moves. Home on a new
// account read as stuck rather than as the end of a list (#3566).
//
// ── What is pinned here ────────────────────────────────────────────────
//
// Every page scroller declares `data-page-bounce`; one coarse-pointer rule
// gives it a transparent 1px box hanging past its bottom edge, which is the
// one pixel of range the browser's own rubber band needs. The rule is
// scoped to the bounded shell because a page the document scrolls keeps the
// #3565 rule instead. The fitted Needs you panes opt out.
//
// Chats and the running app are deliberately NOT listed: their roots are
// exempt with a reason below. A new screen root has to choose.
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
const MESSAGES = read('frontend/src/features/messages/index.tsx');

const BOUNCE = 'data-page-bounce';

/** The screen roots App swaps, read from the one list that names them. */
function screenIds() {
  const m = APP.match(/SCREEN_IDS:\s*\[([\s\S]*?)\]/);
  assert.ok(m, 'App.SCREEN_IDS is still a literal list of screen root ids');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** Every .tsx source in the frontend tree, as [relative path, text]. */
function tsxFiles(dir = 'frontend/src') {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.tsx')) out.push([child, read(child)]);
    }
  };
  walk(dir);
  return out;
}

/** The opening tag that carries `id="<id>"`, wherever it is rendered. */
function rootTag(id) {
  const needle = `id="${id}"`;
  for (const [rel, src] of tsxFiles()) {
    const at = src.indexOf(needle);
    if (at < 0) continue;
    const start = src.lastIndexOf('<', at);
    const end = src.indexOf('>', at);
    assert.ok(start >= 0 && end > at, `${rel}: cannot read the opening tag of #${id}`);
    return { rel, tag: src.slice(start, end + 1) };
  }
  return null;
}

const ids = screenIds();

// Roots that scroll differently on purpose and therefore do not carry the
// attribute. Each says WHY, and the test fails if its id is no longer a
// screen root, so a stale exemption cannot linger.
const EXEMPT = new Map([
  ['app-view', 'a running project page already bounces its Workshop tabs (#3520); its Needs you and Discussion panes stay fitted'],
  ['messages-screen', 'the root is overflow: hidden; the conversations list inside it is the scroller and carries the attribute'],
  ['global-chat-screen', 'Global Chat is a conversation: its transcript opens on its newest line and is not a page'],
  ['agent-session-screen', 'a session with the Mayor is a conversation, not a page'],
]);

// ── The markers ────────────────────────────────────────────────────────

test('every page scroller declares the bounce, except the roots that say why not', () => {
  for (const id of EXEMPT.keys()) {
    assert.ok(ids.includes(id), `the exemption for #${id} names a screen root that no longer exists`);
  }
  const missing = [];
  for (const id of ids) {
    if (EXEMPT.has(id)) continue;
    const found = rootTag(id);
    if (!found) { missing.push(`#${id}: no id="${id}" opening tag found in frontend/src`); continue; }
    if (!found.tag.includes(`${BOUNCE}=""`)) {
      missing.push(`#${id} in ${found.rel}: ${found.tag.replace(/\s+/g, ' ').trim()}`);
    }
  }
  assert.deepEqual(missing, [],
    'a screen root the browser scrolls itself does not declare data-page-bounce, so a page '
    + 'whose content fits still refuses to move at its foot:\n  ' + missing.join('\n  '));
});

test('the Messages list, the one scroller inside an overflow-hidden root, carries it', () => {
  const at = MESSAGES.indexOf('messages-list-scroll');
  assert.ok(at >= 0, 'the conversations list is still rendered by messages/index.tsx');
  const start = MESSAGES.lastIndexOf('<', at);
  const end = MESSAGES.indexOf('>', at);
  const tag = MESSAGES.slice(start, end + 1);
  assert.ok(tag.includes(`${BOUNCE}=""`),
    'the conversations list did not declare data-page-bounce; #messages-screen is overflow: hidden, '
    + 'so the list is the element that must bounce:\n  ' + tag.replace(/\s+/g, ' ').trim());
});

// ── The rule ───────────────────────────────────────────────────────────

/** The body of the rule whose selector starts exactly at `selector`. */
function ruleBody(selector) {
  const i = CSS.indexOf(selector);
  assert.ok(i >= 0, `expected \`${selector}\` in app.css`);
  const close = CSS.indexOf('}', i);
  return CSS.slice(i + selector.length, close);
}

test('a phone gives a short page one pixel of range at its foot', () => {
  const SELECTOR = `html:not([data-browser-scroller]) [data-page-bounce] {`;
  const i = CSS.indexOf(SELECTOR);
  assert.ok(i >= 0, 'the page-bounce rule is missing from app.css');

  // Inside a coarse-pointer media query, so a mouse never gets a scrollbar
  // for content that fits.
  const media = CSS.lastIndexOf('@media', i);
  assert.match(CSS.slice(media, i), /^@media \(pointer: coarse\) \{\s*$/,
    'the pixel must live in a `@media (pointer: coarse)` block');

  const body = ruleBody(SELECTOR);
  assert.match(body, /position:\s*relative/,
    'the scroller is the containing block for the pixel');
  assert.doesNotMatch(body, /:has/,
    'the Needs you exception is its own rule, so an engine without :has() drops only it');
});

test('the pixel hangs 1px below the scroller and takes no input', () => {
  const body = ruleBody(`html:not([data-browser-scroller]) [data-page-bounce]::after {`);
  assert.match(body, /content:\s*''/, 'the box is generated');
  assert.match(body, /position:\s*absolute/, 'an absolute box cannot be taken back by a flex chain');
  assert.match(body, /bottom:\s*-1px/, 'it must sit past the scroller\'s last pixel');
  assert.match(body, /height:\s*1px/, 'one pixel is the whole range intended');
  assert.match(body, /pointer-events:\s*none/, 'it must never intercept a tap');
});

test('the Needs you pane keeps its fitted scroll', () => {
  const SELECTOR = 'html:not([data-browser-scroller]) '
    + '[data-page-bounce]:has([data-workshop-pane="needs"])::after {';
  assert.equal(ruleBody(SELECTOR).trim(), 'content: none;',
    'the exception must turn only its content off');
});

test('a page the document scrolls keeps the earlier rule, and never gets the pixel', () => {
  assert.match(CSS, /@media \(pointer: coarse\) \{\n  html\[data-browser-scroller\]\[data-browser-past-top\],\n  html\[data-browser-scroller\]\[data-browser-past-top\] body \{\n    overscroll-behavior-y: contain;\n  \}\n\}/,
    'the #3565 document bounce is unchanged');
  assert.match(read('tests/browser-scroll.test.js'),
    /#3565: only the mark gives the viewport back its bounce/,
    'tests/browser-scroll.test.js still pins the earlier fix');

  // Every rule that names the marker is scoped out of the paged document,
  // where a pixel of range would only make the page longer.
  const selectors = [...CSS.matchAll(/([^{}]*\[data-page-bounce\][^{}]*)\{/g)]
    .map((m) => m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/\s+/g, ' '));
  assert.ok(selectors.length >= 3, 'expected the pixel rules to be present');
  for (const sel of selectors) {
    assert.ok(sel.startsWith('html:not([data-browser-scroller]) '),
      `a data-page-bounce rule is not scoped to the bounded shell: ${sel}`);
  }
});
