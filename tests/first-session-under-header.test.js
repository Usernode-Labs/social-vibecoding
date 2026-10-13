'use strict';

// The community maker from Create keeps the platform header (#4195).
//
// "The new community maker UI should keep the header, not hide it (started
// it from the home page)." The make and made screens were full-viewport
// overlays at z-[9000] over the z-10 header, with a wordmark bar of their
// own. On the first session after sign-in that is deliberate: the screen
// arrives on the wallpaper. Opened from Create
// (frontend/src/features/first-session/make.tsx, made.tsx, index.tsx), they
// now start at the header's foot instead, drop their own wordmark, keep the
// phone tab bar covered, and using the header leaves them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DIR = 'frontend/src/features/first-session';
const MAKE = `${DIR}/make.tsx`;
const MADE = `${DIR}/made.tsx`;
const ISLAND = `${DIR}/index.tsx`;
// The wordmark's own viewBox: present exactly where the mark is drawn.
const WORDMARK = 'viewBox="0 0 1236.9 319.2"';

const rootOf = (html, marker) => new RegExp(`<div role="dialog"[^>]*${marker}[^>]*>`).exec(html)[0];

test('the first session keeps its full screen, wordmark and all', () => {
  const html = renderComponent(MAKE, 'MakeScreen', { who: 'Jordan', onMade() {}, onLookAround() {} });
  assert.match(rootOf(html, 'data-first-session-make'), /class="platform-kb-surface fixed inset-0 z-\[9000\] flex flex-col text-zinc-900 dark:text-zinc-100"/);
  assert.ok(html.includes(WORDMARK));
  const made = loadTsx(MADE);
  const madeHtml = renderToHtml(createElement(made.MadeScreen, {
    made: { slug: 'notes-1', name: 'Notes', emoji: null, description: null, example: null, conversationId: null },
    me: 'sam', onContinue() {}, onOpenChat() {},
  }));
  assert.match(rootOf(madeHtml, 'data-first-session-made'), /class="fixed inset-0 z-\[9000\] flex flex-col overflow-y-auto /);
  assert.ok(madeHtml.includes(WORDMARK));
});

test('from Create, the make screen sits below the header with only its ✕ in the bar', () => {
  const html = renderComponent(MAKE, 'MakeScreen', { who: 'Jordan', onMade() {}, entry: 'create', onClose() {}, underHeader: true });
  const root = rootOf(html, 'data-first-session-make');
  // dapp.json selects on these.
  assert.match(root, /data-first-session-make=""/);
  assert.match(root, /data-make-entry="create"/);
  assert.match(root, /class="platform-kb-surface platform-under-header fixed inset-x-0 bottom-0 z-\[9000\] flex flex-col text-zinc-900 dark:text-zinc-100"/);
  assert.doesNotMatch(root, /inset-0/, 'not over the header');
  assert.ok(!html.includes(WORDMARK), 'the header carries the mark');
  assert.match(html, /data-make-close=""/, 'the ✕ stays');
  assert.doesNotMatch(html.slice(0, html.indexOf('data-first-session-make-scroll')), /safe-area-inset-top/, 'the header clears the inset');
  // The bar still comes first, the scroller under it.
  assert.ok(html.indexOf('data-make-close') < html.indexOf('data-first-session-make-scroll'));
});

test('from Create, the made screen sits below the header with no wordmark bar', () => {
  const made = loadTsx(MADE);
  const html = renderToHtml(createElement(made.MadeScreen, {
    made: { slug: 'notes-1', name: 'Notes', emoji: null, description: null, example: null, conversationId: null },
    me: 'sam', entry: 'create', underHeader: true, onContinue() {}, onOpenChat() {},
  }));
  const root = rootOf(html, 'data-first-session-made');
  assert.match(root, /data-make-entry="create"/);
  assert.match(root, /class="platform-under-header fixed inset-x-0 bottom-0 z-\[9000\] flex flex-col overflow-y-auto text-zinc-900 dark:text-zinc-100"/);
  assert.ok(!html.includes(WORDMARK));
  assert.match(html, />Share invite<\/button>/);
});

test('the island puts the door under the header only from Create, and only when the header shows', () => {
  const src = read(ISLAND);
  assert.match(src, /const underHeader = useMemo\(\(\) => createDoor && platformHeaderShown\(\), \[createDoor\]\);/);
  assert.match(src, /entry="create"\s+startImport=\{!!mode\.startImport\}\s+underHeader=\{underHeader\}/);
  assert.match(src, /entry=\{mode\.entry\}\s+underHeader=\{fromCreate && underHeader\}/);
  // The first session's make screen never gets it.
  const firstMake = src.slice(src.indexOf("if (mode.kind === 'make') {"), src.indexOf("if (mode.kind === 'made') {"));
  assert.doesNotMatch(firstMake, /underHeader/);

  const { platformHeaderShown } = loadTsx(ISLAND);
  const doc = (rects) => ({ getElementById: (id) => (id === 'platform-header' ? { getClientRects: () => ({ length: rects }) } : null) });
  assert.equal(platformHeaderShown(doc(1)), true);
  assert.equal(platformHeaderShown(doc(0)), false, 'hidden (chromeless, inside an app; the side panel): full screen as before');
  assert.equal(platformHeaderShown({ getElementById: () => null }), false);
  assert.equal(platformHeaderShown(null), false);
});

test('using the header, or any route change, leaves the door by its own leave path', () => {
  const src = read(ISLAND);
  assert.match(src, /const onRoute = \(\) => leaveDoor\(true\);/);
  assert.match(src, /const onPress = \(e: Event\) => \{ if \(leavesDoor\(e\.target\)\) leaveDoor\(true\); \};/);
  assert.match(src, /window\.addEventListener\('hashchange', onRoute\);\s+document\.addEventListener\('click', onPress, true\);/);
  assert.match(src, /window\.removeEventListener\('hashchange', onRoute\);\s+document\.removeEventListener\('click', onPress, true\);/);
  assert.match(src, /if \(!createDoor\) return undefined;\s+const onRoute/);

  const { leavesDoor } = loadTsx(ISLAND);
  // A stand-in element: `closest` walks a chain of { matches, parent }.
  const el = (chain) => ({
    closest(sel) {
      const wanted = sel.split(',').map((s) => s.trim());
      for (let at = chain; at; at = at.parent) if (wanted.some((w) => at.is.includes(w))) return el(at);
      return null;
    },
  });
  const header = { is: ['#platform-header'] };
  const bell = { is: ['a'], parent: header };
  const icon = { is: ['svg'], parent: bell };
  const title = { is: ['h1'], parent: header };
  const makeIt = { is: ['button'], parent: { is: ['[data-first-session-make]'] } };
  assert.equal(leavesDoor(el(icon)), true, 'a press on the bell\'s icon');
  assert.equal(leavesDoor(el(bell)), true);
  assert.equal(leavesDoor(el(title)), false, 'the header\'s plain text is not a control');
  assert.equal(leavesDoor(el(makeIt)), false, 'the door\'s own buttons stay in it');
  assert.equal(leavesDoor(null), false);
  assert.equal(leavesDoor({}), false);
});

test('app.css starts the box at the header\'s foot, and pads the keyboard band only past it', () => {
  const css = read('public/css/app.css');
  assert.match(css, /\.platform-under-header \{\s+top: calc\(var\(--browser-banner-h, 0px\) \+ var\(--platform-header-h\) \+ var\(--platform-safe-top\)\);\s+\}/);
  assert.match(css, /html\.platform-kb-open \.platform-kb-surface\.platform-under-header \{\s+padding-top: max\(0px, calc\(var\(--platform-vv-top, 0px\) - var\(--browser-banner-h, 0px\) - var\(--platform-header-h\) - var\(--platform-safe-top\)\)\);\s+\}/);
  // After the rule it refines, so it wins at equal specificity plus one class.
  assert.ok(css.indexOf('html.platform-kb-open .platform-kb-surface.platform-under-header') > css.indexOf('html.platform-kb-open .platform-kb-surface {'));
});
