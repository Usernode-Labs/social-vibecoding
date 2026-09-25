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
    [/\.platform-tabs \{ background-color: var\(--dc-sheet-solid\); \}/, 'the tab bar'],
    [/\.platform-parked \{ background-color: var\(--dc-sheet-solid\); \}/, 'the parked strip'],
    [/body:has\(#app-view:not\(\.hidden\)\[data-app-surface="platform"\]\) #platform-header \{\s*background-color: var\(--dc-sheet-solid\);\s*\}/, 'the header, on both routes'],
    [/\.dc-lift-panel \{ background-color: var\(--dc-sheet-solid\); \}/, 'the bell and Homeroom menu sheets'],
    [/\.un-sheet, \.un-sheet::after, \.un-panel, \.un-panel::after,[\s\S]*?\{\s*background-color: var\(--dc-sheet-solid\);\s*\}/, 'kit sheets and panels'],
    [/\.un-modal \{ background-color: var\(--dc-sheet\); \}/, 'kit dialogs (a 95% fill, so the opaque sheet)'],
    [/background-color: var\(--create-modal-fill, var\(--dc-strip-solid\)\)/, 'the centred create dialog'],
    [/#dc-session-header\.un-scrolled \{ background-color: var\(--dc-strip-solid\); \}/, 'the scrolled session header'],
    [/\.dev-ws-pane-head, \.dev-ws-pane-body, \.dev-ws-ear \{ background-color: var\(--dc-sheet-solid\); \}/, 'the Workshop pane, head, body and ear together'],
    [/@media \(max-width: 767px\) \{\s*#browse-screen \.browse-pane-head,\s*#browse-screen \.browse-pane-body,\s*#browse-screen \.browse-pane-note \{ background-color: var\(--dc-sheet-solid\); \}/, 'the Browse pane, on a phone, all three together'],
    [/\.global-chat-composer \{ background: var\(--dc-sheet-solid\); \}/, 'the Global Chat composer'],
  ];
  for (const [re, what] of solid) assert.match(css, re, `${what} is solid`);
  const peek = css.slice(css.indexOf('.platform-tabs.platform-tabs-peek {'));
  assert.match(peek.slice(0, peek.indexOf('}')), /background-color: var\(--dc-sheet-solid\);/,
    'the peeked rail floats over the page, so it restates the solid');
});

test('the planes that only sit on the wallpaper keep their fills', () => {
  for (const sel of ['.dc-lift-strip', '.dc-lift-session', '.dev-ws-strip', '.dev-topic-sheet',
    '.gc-event-box', '.global-chat-result']) {
    const esc = sel.replace(/[.#]/g, (c) => `\\${c}`);
    assert.doesNotMatch(css, new RegExp(`(^|\\n)${esc} \\{ background(-color)?: var\\(--dc-(sheet|strip)(-solid)?\\); \\}`),
      `${sel} is never swapped for an opaque fill`);
  }
});
