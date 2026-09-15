// #1945: inside an app, the bar takes the app's tone.
//
// The framed app's bridge reports its opaque page colour to the shell
// (#1581); features/app-frame/app-tone.js turns that into `data-app-tone` on
// <html>, and app.css keys the wallpaper, the sheet edge and the bar's brand
// tokens off it beside `.dark`. This file drives the module directly (it is
// plain JS, like the frame store, for exactly this reason) and pins the wiring
// around it at source level: the effect in the frame host, the theme-change
// re-publish in mount.ts, the CSS selectors, the `?theme=` pin in the head, the
// two screenshot states and their declared checks.
//
// Run with: node --test tests/app-tone.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

async function loadTone() {
  return import(new URL('../frontend/src/features/app-frame/app-tone.js', `file://${__filename}`).href);
}

// A document with just the two nodes the module writes: <html> and the
// theme-color meta.
function fakeDocument({ withMeta = true } = {}) {
  const attrs = new Map();
  const metaAttrs = new Map([['content', '#f4f2e4']]);
  const meta = {
    getAttribute: (k) => (metaAttrs.has(k) ? metaAttrs.get(k) : null),
    setAttribute: (k, v) => metaAttrs.set(k, String(v)),
  };
  return {
    documentElement: {
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
      setAttribute: (k, v) => attrs.set(k, String(v)),
      removeAttribute: (k) => attrs.delete(k),
    },
    querySelector: (sel) => (withMeta && sel === 'meta[name="theme-color"]' ? meta : null),
    attrs, meta, metaAttrs,
  };
}

const ON = (background) => ({ slug: 'demo', active: true, background });

// ── the tone itself ──────────────────────────────────────────────────────

test('toneOf splits page colours at the WCAG white-text threshold', async () => {
  const { toneOf, luminanceOf, DARK_LUMINANCE } = await loadTone();
  assert.equal(DARK_LUMINANCE, 0.179);
  // The platform's own two grounds sit far to either side.
  assert.equal(toneOf('#f4f2e4'), 'light');
  assert.equal(toneOf('#0b0d1b'), 'dark');
  // Stock black and white, and the greys either side of the line.
  assert.equal(toneOf('#000000'), 'dark');
  assert.equal(toneOf('#ffffff'), 'light');
  assert.equal(toneOf('#4a4a4a'), 'dark', 'a dark grey reads as dark');
  assert.equal(toneOf('#808080'), 'light', 'mid grey keeps black text, so it is light');
  // Saturated colours: navy is dark, a pale yellow is light, pure blue is dark
  // (blue carries little luminance), pure green is light.
  assert.equal(toneOf('#1a2239'), 'dark');
  assert.equal(toneOf('#fff7c2'), 'light');
  assert.equal(toneOf('#0000ff'), 'dark');
  assert.equal(toneOf('#00ff00'), 'light');
  // Case and whitespace are the bridge's problem, not a reason to fall over.
  assert.equal(toneOf(' #0B0D1B '), 'dark');
  // Luminance is the standard formula.
  assert.ok(Math.abs(luminanceOf('#ffffff') - 1) < 1e-9);
  assert.equal(luminanceOf('#000000'), 0);
});

test('anything that is not an opaque hex colour has no tone', async () => {
  const { toneOf, luminanceOf } = await loadTone();
  for (const bad of ['', null, undefined, '#fff', 'rgb(0,0,0)', '#0b0d1b80', 'black', 12, {}]) {
    assert.equal(toneOf(bad), null, `${JSON.stringify(bad)} has no tone`);
    assert.equal(luminanceOf(bad), null);
  }
});

test('the tone follows the frame store: on screen with a page colour, or nothing', async () => {
  const { toneForState } = await loadTone();
  assert.equal(toneForState(ON('#0b0d1b')), 'dark');
  assert.equal(toneForState(ON('#f4f2e4')), 'light');
  // No opaque ground reported: nothing is known, so the shell's theme stands.
  assert.equal(toneForState(ON('')), null);
  // Parked (the Dev tab over the frame): the app is not what is under the bar.
  assert.equal(toneForState({ slug: 'demo', active: false, background: '#0b0d1b' }), null);
  // Empty store, and the prerendered state.
  assert.equal(toneForState({ slug: '', active: false, background: '' }), null);
  assert.equal(toneForState(null), null);
});

// ── publishing it onto the document ──────────────────────────────────────

test('publishAppTone writes the attribute and the theme-color meta, and clears both', async () => {
  const { publishAppTone, APP_TONE_ATTR, TONE_GROUND } = await loadTone();
  assert.equal(APP_TONE_ATTR, 'data-app-tone');
  const doc = fakeDocument();
  let applied = 0;
  const win = { Theme: { apply() { applied += 1; doc.metaAttrs.set('content', 'shell'); } } };

  assert.equal(publishAppTone(doc, ON('#0b0d1b'), win), 'dark');
  assert.equal(doc.attrs.get('data-app-tone'), 'dark');
  assert.equal(doc.metaAttrs.get('content'), TONE_GROUND.dark);

  // Same tone again: idempotent, no writes.
  doc.metaAttrs.set('content', 'untouched');
  assert.equal(publishAppTone(doc, ON('#101010'), win), 'dark');
  assert.equal(doc.metaAttrs.get('content'), 'untouched', 'a repeat of the same tone touches nothing');

  // The app flips to light: attribute and meta follow.
  assert.equal(publishAppTone(doc, ON('#fafafa'), win), 'light');
  assert.equal(doc.attrs.get('data-app-tone'), 'light');
  assert.equal(doc.metaAttrs.get('content'), TONE_GROUND.light);

  // Parked: attribute goes, and the meta is handed back to the theme module.
  assert.equal(publishAppTone(doc, { slug: 'demo', active: false, background: '#fafafa' }, win), null);
  assert.equal(doc.attrs.has('data-app-tone'), false);
  assert.equal(applied, 1);
  assert.equal(doc.metaAttrs.get('content'), 'shell');

  // Clearing an already-clear document is a no-op: the cold page never calls
  // Theme.apply from here.
  assert.equal(publishAppTone(doc, { slug: '', active: false, background: '' }, win), null);
  assert.equal(applied, 1);
});

test('publishAppTone survives a document with no meta, no Theme, or no root', async () => {
  const { publishAppTone } = await loadTone();
  const doc = fakeDocument({ withMeta: false });
  assert.equal(publishAppTone(doc, ON('#0b0d1b'), {}), 'dark');
  assert.equal(doc.attrs.get('data-app-tone'), 'dark');
  assert.equal(publishAppTone(doc, ON(''), {}), null);
  assert.equal(doc.attrs.has('data-app-tone'), false);
  assert.equal(publishAppTone(doc, ON(''), undefined), null);
  assert.equal(publishAppTone({ documentElement: null }, ON('#0b0d1b'), {}), 'dark');
  assert.equal(publishAppTone(null, ON('#0b0d1b'), {}), 'dark');
});

test('force re-asserts the meta after the theme module rewrote it', async () => {
  const { publishAppTone, TONE_GROUND } = await loadTone();
  const doc = fakeDocument();
  publishAppTone(doc, ON('#0b0d1b'), {});
  // Theme.apply() ran (the viewer toggled the shell's mode) and put the
  // shell's colour back on the meta.
  doc.metaAttrs.set('content', '#f4f2e4');
  publishAppTone(doc, ON('#0b0d1b'), {}, true);
  assert.equal(doc.metaAttrs.get('content'), TONE_GROUND.dark);
  // Force with no tone is still just a clear.
  let applied = 0;
  publishAppTone(doc, ON(''), { Theme: { apply() { applied += 1; } } }, true);
  assert.equal(doc.attrs.has('data-app-tone'), false);
  assert.equal(applied, 1);
});

test('the tone grounds match the head module\'s', async () => {
  const { TONE_GROUND } = await loadTone();
  const head = read('frontend/src/head.html');
  const m = /const GROUND = \{ light: '(#[0-9a-f]{6})', dark: '(#[0-9a-f]{6})' \};/.exec(head);
  assert.ok(m, 'head.html declares GROUND');
  assert.deepEqual(TONE_GROUND, { light: m[1], dark: m[2] });
});

// ── the wiring ───────────────────────────────────────────────────────────

test('the frame host publishes the tone from an effect on the store', () => {
  const src = read('frontend/src/features/app-frame/app-frame.tsx');
  assert.match(src, /import \{ publishAppTone \} from '\.\/app-tone\.js';/);
  assert.match(src, /useEffect\(\(\) => \{\s*publishAppTone\(document, state, window\);\s*\}, \[state\.slug, state\.active, state\.background\]\);/,
    'a plain useEffect keyed on slug, active and background');
  assert.doesNotMatch(src, /useIsomorphicLayoutEffect\(\(\) => \{\s*publishAppTone/,
    'never a layout effect: the tone is a repaint, and it must not run in the prerender');
});

test('mount.ts re-publishes with force on every theme change', () => {
  const src = read('frontend/src/features/app-frame/mount.ts');
  assert.match(src, /import \{ publishAppTone \} from '\.\/app-tone\.js';/);
  assert.match(src, /Theme\?\.onChange\?\.\(\(\) => \{\s*publishAppTone\(document, appFrameStore\.get\(\), window, true\);/);
});

test('the shipped document carries no tone', () => {
  const { shellMarkup } = require('./lib/shell-markup');
  const html = shellMarkup();
  assert.doesNotMatch(html, /data-app-tone/, 'the prerender never sets it; the effect does, in the browser');
});

test('app.css keys the wallpaper and the bar\'s tokens off the tone beside .dark', () => {
  const css = read('public/css/app.css');
  const ROOTS = 'body:has(:is(#home-screen, #app-view, ';
  // Both dark wallpaper rules (phone and the 640px layer set) fire for the
  // dark shell unless a light app is on screen, and for a dark app always.
  const dark = css.split(`:is(.dark:not([data-app-tone="light"]), [data-app-tone="dark"]) ${ROOTS}`);
  assert.equal(dark.length, 3, 'exactly two dark wallpaper rules take the tone');
  assert.doesNotMatch(css, new RegExp(`\\n\\s*\\.dark ${ROOTS.replace(/[()#.,*+?^$|[\]\\]/g, '\\$&')}`),
    'no dark wallpaper rule is left keyed on .dark alone');
  // The brand tokens and the sheet edge move with the ground, scoped to the
  // bar and the sheet — never to <html>, so the shell's theme stays its own.
  for (const sel of [
    '[data-app-tone="dark"]:not(.dark) #platform-header,\n[data-app-tone="dark"]:not(.dark) #app-frame-host {',
    '.dark[data-app-tone="light"] #platform-header,\n.dark[data-app-tone="light"] #app-frame-host {',
  ]) {
    const at = css.indexOf(sel);
    assert.ok(at > 0, `app.css has ${sel.split('\n')[0]}`);
    const block = css.slice(at, css.indexOf('}', at));
    for (const token of ['--brand-ink', '--brand-tint', '--brand-line', '--app-sheet-line', '--app-sheet-shadow-near', '--app-sheet-shadow-far']) {
      assert.ok(block.includes(token + ':'), `${sel.split('\n')[0]} sets ${token}`);
    }
  }
  // The dark-tone tokens are the .dark values and the light-tone tokens the
  // :root values, so a toned bar is byte-identical to a themed one.
  const value = (block, token) => new RegExp(`${token}: ([^;]+);`).exec(block)[1];
  const darkAt = css.indexOf('\n.dark {');
  const rootBlock = css.slice(0, darkAt);
  const darkBlock = css.slice(darkAt, css.indexOf('\n}', darkAt));
  const toneDark = css.slice(css.indexOf('[data-app-tone="dark"]:not(.dark) #platform-header,'));
  const toneLight = css.slice(css.indexOf('.dark[data-app-tone="light"] #platform-header,'));
  for (const token of ['--brand-ink', '--brand-tint', '--brand-line', '--app-sheet-line']) {
    assert.equal(value(toneDark, token), value(darkBlock, token), `${token} dark tone = .dark`);
    assert.equal(value(toneLight, token), value(rootBlock, token), `${token} light tone = :root`);
  }
  assert.doesNotMatch(css, /\[data-app-tone="dark"\]:not\(\.dark\)\s*\{/, 'nothing is set on <html> itself');
});

test('the head pins the theme from ?theme= as well as ?shot=', () => {
  const head = read('frontend/src/head.html');
  assert.match(head, /themeParam = params\.get\('theme'\)/);
  assert.match(head, /\(themeParam === 'dark' \|\| themeParam === 'light'\) \? themeParam : null/);
  // `shot` still wins when both name a mode, and nothing is stored either way.
  assert.match(head, /const PINNED = \(shot === 'dark' \|\| shot === 'light'\) \? shot\s*\n\s*: \(themeParam/);
});

test('the two screenshot states mount a frame with the page colour of that tone', () => {
  const appJs = read('public/js/app.js');
  assert.match(appJs, /if \(shot === 'app-tone-dark' \|\| shot === 'app-tone-light'\) \{/);
  assert.match(appJs, /AppView\.showAppToneShot\(tone\)/);
  const view = read('public/js/app-view.js');
  const at = view.indexOf('  showAppToneShot(tone) {');
  assert.ok(at > 0);
  const body = view.slice(at, view.indexOf('\n  },', at));
  assert.match(body, /frame\.mount\(\{ slug, faded: false \}\)/, 'a pending frame, like the settled launch shot');
  assert.match(body, /frame\.setBackground\?\.\(dark \? '#0b0d1b' : '#f4f2e4'\)/, 'the page colour goes through the bridge path');
  assert.doesNotMatch(body, /setSrc|\.src\s*=/, 'no document is loaded behind it');
  assert.match(body, /App\._setScreenVisible\('app-view', true\)/);
});

test('dapp.json checks both tones, each under the opposite shell', () => {
  const dapp = JSON.parse(read('dapp.json'));
  const dark = dapp.tests.find((t) => t.path === '/?shot=app-tone-dark');
  const light = dapp.tests.find((t) => t.path === '/?shot=app-tone-light&theme=dark');
  assert.ok(dark && light, 'both checks are declared');
  assert.match(dark.expectSelector, /^html\[data-app-tone="dark"\]:not\(\.dark\) body:has\(#app-frame-host:not\(\.hidden\)/);
  assert.match(light.expectSelector, /^html\.dark\[data-app-tone="light"\] body:has\(#app-frame-host:not\(\.hidden\)/);
  for (const t of [dark, light]) assert.match(t.expectSelector, /#app-iframe\) #platform-header$/);
});
