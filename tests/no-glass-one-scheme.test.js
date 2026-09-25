'use strict';

// ONE COLOUR SCHEME, NO BLUR (app.css "No glass, on any platform"). #787 and
// #3104 took the frosted glass off inside the iOS app only, which had the app
// draw the neutral no-blur fallbacks (#ffffff / #f5f5f7) while Safari, the
// PWA, Android and desktop drew warm glass: two colour schemes for one
// product. Now no platform blurs, the planes keep their translucent fills,
// and what content passes behind is solid in the plane colours, the same on
// every platform. These tests pin that there is exactly one scheme.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'public/css/app.css'), 'utf8');

function rgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgba(text) {
  const m = text.match(/rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)/);
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}
function token(block, name) {
  const m = block.match(new RegExp(`--${name}:\\s*([^;]+);`));
  assert.ok(m, `--${name} is declared`);
  return m[1].trim();
}
// The block that declares the light plane tokens, and the dark one.
function themeBlocks() {
  const starts = [...css.matchAll(/--dc-sheet-fill:/g)].map((m) => m.index);
  assert.equal(starts.length, 2, 'the plane fill is declared once per theme');
  return starts.map((at) => css.slice(css.lastIndexOf('{', at), css.indexOf('\n}', at)));
}

test('no platform blurs: the frost token is none, declared once', () => {
  const decls = [...css.matchAll(/--dc-frost\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.deepEqual(decls, ['none'], 'one declaration, for everyone, and it is none');
});

test('no surface is swapped for a different colour on any platform', () => {
  assert.doesNotMatch(css, /:where\(html\.un-ios/, 'no iPhone twins are left');
  assert.doesNotMatch(css, /@supports not \(\(backdrop-filter/,
    'no no-backdrop-filter fallback is left to swap a fill for the neutral one');
  assert.doesNotMatch(css, /html\.un-ios(\.in-native-webview)? \{\s*--dc-frost/,
    'the frost is not turned off per platform any more; it is off at the token');
});

test('the solid plane colours are the fills composited over the wallpaper', () => {
  // The wallpaper grounds the planes sit on: light cream, dark night.
  const grounds = [[244, 242, 228], [11, 13, 27]];
  themeBlocks().forEach((block, i) => {
    for (const [fill, solid] of [['dc-sheet-fill', 'dc-sheet-solid'], ['dc-strip-fill', 'dc-strip-solid']]) {
      const [r, g, b, a] = rgba(token(block, fill));
      const want = [r, g, b].map((c, k) => Math.round(c * a + grounds[i][k] * (1 - a)));
      const got = rgb(token(block, solid));
      got.forEach((c, k) => assert.ok(Math.abs(c - want[k]) <= 1,
        `${i ? 'dark' : 'light'} --${solid} ${got} is --${fill} over the ground (${want})`));
    }
  });
});

test('what content scrolls or slides behind is solid, in the plane colour', () => {
  const solid = [
    [/\.platform-parked \{ background-color: var\(--dc-sheet-solid\); \}/, 'the parked strip'],
    [/\.dc-lift-panel \{ background-color: var\(--dc-sheet-solid\); \}/, 'the bell and Homeroom menu sheets'],
    [/\.un-sheet, \.un-sheet::after, \.un-panel, \.un-panel::after,[\s\S]*?\{\s*background-color: var\(--dc-sheet-solid\);\s*\}/, 'kit sheets and panels'],
    [/\.un-modal \{ background-color: var\(--dc-sheet\); \}/, 'kit dialogs (a 95% fill, so the opaque sheet)'],
    [/\.un-modal:has\(#feedback-form\) \{ background-color: var\(--dc-sheet-solid\); \}/, 'Send Feedback, in the plane colour like the sheets'],
    [/background-color: var\(--create-modal-fill, var\(--dc-strip-solid\)\)/, 'the centred create dialog'],
    [/#dc-session-header\.un-scrolled \{ background-color: var\(--dc-strip-solid\); \}/, 'the scrolled session header'],
    [/\.dev-ws-pane-head, \.dev-ws-pane-body, \.dev-ws-ear \{ background-color: var\(--dc-sheet-solid\); \}/, 'the Workshop pane, head, body and ear together'],
    [/@media \(max-width: 767px\) \{\s*#browse-screen \.browse-pane-head,\s*#browse-screen \.browse-pane-body,\s*#browse-screen \.browse-pane-note \{ background-color: var\(--dc-sheet-solid\); \}/, 'the Browse pane, on a phone, all three together'],
    [/\.global-chat-composer \{ background: var\(--dc-sheet-solid\); \}/, 'the Global Chat composer'],
  ];
  for (const [re, what] of solid) assert.match(css, re, `${what} is solid`);
});

// THE TAB BAR AND THE HEADER KEEP THE GLASS LOOK, FAKED. The wallpaper is
// fixed, so what the glass showed over it never changed: the tint over the
// washes. Each bar paints exactly that once, from a viewport-sized fixed
// layer clipped to the bar, with no filter anywhere.
const FAKE = /\{\s*content: '';\s*position: fixed;\s*inset: 0;\s*z-index: -1;\s*pointer-events: none;[\s\S]*?background: linear-gradient\(var\(--dc-sheet-fill\), var\(--dc-sheet-fill\)\), var\(--home-washes, var\(--dc-sheet-solid\)\);\s*\}/;

test('the tab bar and the header fake their glass from the fixed wallpaper', () => {
  const tabs = css.slice(css.indexOf('.platform-tabs {\n  background-color: transparent;'));
  assert.match(tabs, /^\.platform-tabs \{\s*background-color: transparent;\s*clip-path: inset\(0\);\s*\}/,
    'the tab bar is see-through to its own layer, and clips it');
  assert.match(tabs, new RegExp('\\.platform-tabs::before ' + FAKE.source), 'the tab bar paints the tint over the washes');
  const head = css.indexOf('#platform-header::before');
  assert.ok(head > 0, 'the header has its layer');
  assert.match(css.slice(css.lastIndexOf('body:has(:is(#home-screen', head), css.indexOf('}', head) + 1), FAKE,
    'the header paints the same tint over the same washes');
  assert.match(css, /#platform-header \{\s*background-color: transparent;\s*clip-path: inset\(0 round 0 0 1\.25rem 1\.25rem\);\s*\}/,
    'the header clips to its own rounded-b-2xl notch (1.25rem, tailwind.config.js)');
  const peek = css.slice(css.indexOf('.platform-tabs.platform-tabs-peek {'));
  assert.match(peek.slice(0, peek.indexOf('}')), /background-color: transparent;/,
    'the peeked rail is the same faked glass as the docked one');
  assert.doesNotMatch(css, /(\.platform-tabs|#platform-header)[^{]*\{[^}]*backdrop-filter: blur/,
    'no live blur came back with the look');
});

test('the fake and the wallpaper paint the same washes', () => {
  // One token, so the bar's layer lines up with the body's pixel for pixel
  // and cannot drift when the wallpaper changes: every wallpaper variant
  // (light, dark, phone, wide) draws its star and grain over --home-washes.
  const wallpapers = [...css.matchAll(/--home-wallpaper:\s*([\s\S]*?);/g)].map((m) => m[1]);
  assert.equal(wallpapers.length, 4, 'four wallpaper variants');
  for (const w of wallpapers) assert.match(w, /var\(--home-grain\)[^,]*,\s*var\(--home-washes\)$/);
  const washes = [...css.matchAll(/--home-washes:\s*([\s\S]*?);/g)].map((m) => m[1]);
  assert.equal(washes.length, 4, 'each variant defines its washes');
  for (const w of washes) {
    assert.doesNotMatch(w, /home-star|home-grain/, 'no star or grain: a blur erased both');
    assert.match(w, /var\(--home-ground\)$/, 'the ground colour closes the list');
  }
});

test('the planes that only sit on the wallpaper keep their fills', () => {
  for (const sel of ['.dc-lift-strip', '.dc-lift-session', '.dev-ws-strip', '.dev-topic-sheet',
    '.gc-event-box', '.global-chat-result']) {
    const esc = sel.replace(/[.#]/g, (c) => `\\${c}`);
    assert.doesNotMatch(css, new RegExp(`(^|\\n)${esc} \\{ background(-color)?: var\\(--dc-(sheet|strip)(-solid)?\\); \\}`),
      `${sel} is never swapped for an opaque fill`);
  }
});
