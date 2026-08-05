// Safe-area forwarding into the app frame (issue #970).
//
// The bug: #app-view carried the kit's `un-safe-bottom` unconditionally,
// so its padding was subtracted from the flex height of EVERY surface in
// #app-content — the running app's iframe included. On a phone that left
// the app ~34px short of the screen's rounded bottom edge with the shell's
// own background showing through, while the shell itself painted edge to
// edge.
//
// The fix has two halves, and this file pins both:
//   1. The shell's bottom inset is SURFACE-DEPENDENT — reserved only for
//      platform-rendered surfaces (`data-app-surface="platform"`), never
//      for an app frame.
//   2. The insets are FORWARDED into the frame instead of eaten, over a
//      `__usernode_safe_area` message family, and published by the bridge
//      as `--un-safe-inset-*` custom properties that the native kit's CSS
//      reads. This is load-bearing: `env(safe-area-inset-*)` is 0px inside
//      a cross-origin iframe, so without it every kit safe-area rule stays
//      inert inside an app and the app's own bottom chrome would sit under
//      the home indicator.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const INDEX = read('public/index.html');
const APP_CSS = read('public/css/app.css');
const APP_JS = read('public/js/app.js');
const APP_VIEW = read('public/js/app-view.js');
const NATIVE_CSS = read('public/usernode-native/v1/native.css');
const BRIDGE = read('public/usernode-bridge/v1/bridge.js');
const BRIDGE_MIRROR = read('public/usernode-bridge.js');

// ── 1. Shell layout: the inset is surface-dependent ──────────────────

test('#app-view no longer reserves the bottom inset for every surface', () => {
  assert.ok(!/<div id="app-view"[^>]*un-safe-bottom/.test(INDEX),
    '#app-view must not carry a blanket un-safe-bottom — that IS the bug');
  assert.ok(/<div id="app-view"[^>]*data-app-surface="platform"/.test(INDEX),
    '#app-view needs data-app-surface, defaulting to platform so a first '
    + 'paint before any render keeps the old clearance');
});

test('app.css gates the bottom inset on the platform surface only', () => {
  const m = /#app-view\[data-app-surface="platform"\]\s*\{([^}]*)\}/.exec(APP_CSS);
  assert.ok(m, 'app.css must carry the surface-gated rule');
  assert.match(m[1], /padding-bottom:\s*env\(safe-area-inset-bottom/,
    'the platform surface keeps its home-indicator clearance');
  // No rule may reserve the strip for an app surface — that would put the
  // clipping straight back.
  assert.ok(!/#app-view\[data-app-surface="app"\][^}]*padding-bottom/.test(APP_CSS),
    'an app surface must reserve nothing');
});

test('every #app-content mount point declares its surface', () => {
  // The flag can only stay truthful if each place that OWNS #app-content's
  // contents sets it. Count the calls and pin the helper itself.
  assert.match(APP_VIEW, /_setSurface\(kind\)\s*\{/,
    'AppView._setSurface must exist');
  assert.match(APP_VIEW, /view\.setAttribute\('data-app-surface', next\)/,
    '_setSurface must write the attribute app.css keys on');

  const appCalls = APP_VIEW.match(/_setSurface\('app'\)/g) || [];
  const platformCalls = APP_VIEW.match(/_setSurface\('platform'\)/g) || [];
  // app: beginLaunch, showLaunchCoverShot, renderAppTab's adopt early-exit,
  // renderAppTab's iframe path.
  assert.equal(appCalls.length, 4,
    `expected 4 app-surface call sites, found ${appCalls.length}`);
  // platform: renderAppTab's status branch, its offline branch, renderDevView.
  assert.equal(platformCalls.length, 3,
    `expected 3 platform-surface call sites, found ${platformCalls.length}`);
});

test('the adopt early-exit still asserts the app surface', () => {
  // renderAppTab returns early without touching the DOM when it can adopt
  // beginLaunch's frame. It must still set the flag, or an adopted launch
  // could keep whatever surface was last on screen.
  const adopt = APP_VIEW.slice(
    APP_VIEW.indexOf("&& document.getElementById('app-iframe')) {"),
    APP_VIEW.indexOf('AppView._teardownLaunch();',
      APP_VIEW.indexOf("&& document.getElementById('app-iframe')) {"))
  );
  assert.match(adopt, /_setSurface\('app'\)/,
    'the adopt path must assert the surface before returning');
});

test('setChromeless no longer hand-manages the inset, but re-broadcasts', () => {
  assert.ok(!APP_JS.includes("classList.toggle('un-safe-bottom'"),
    'chromeless always lands on the app surface — nothing to strip (#970)');
  const fn = APP_JS.slice(
    APP_JS.indexOf('setChromeless(on) {'),
    APP_JS.indexOf('_mountChromelessPill() {')
  );
  assert.match(fn, /scheduleSafeAreaBroadcast\(\)/,
    'hiding the header changes the frame rect, so the insets change too');
});

test('the mode switch re-broadcasts the frame insets', () => {
  const fn = APP_JS.slice(
    APP_JS.indexOf('async switchTab(tab, ref, subTab) {'),
    APP_JS.indexOf('App.updateHash();', APP_JS.indexOf('async switchTab('))
  );
  assert.match(fn, /scheduleSafeAreaBroadcast\(\)/,
    'switching surface changes #app-view\'s rect');
});

// ── 2. The shell's forwarding: pure arithmetic ───────────────────────
//
// app-view.js exports AppView under node for exactly this (the scroll
// helpers do the same), so the geometry can be unit-tested with no DOM.

const AppView = require('../public/js/app-view.js');
const RAW = { top: 44, right: 0, bottom: 34, left: 0 };
const VIEWPORT = { width: 390, height: 844 };
const rect = ({ top = 0, right = 390, bottom = 844, left = 0 }) =>
  ({ top, right, bottom, left, width: right - left, height: bottom - top });

test('_frameInsets: chrome already covering an edge consumes its inset', () => {
  // The normal app view: the platform header (53px + the 44px status bar)
  // sits over the frame's top edge, and the frame runs to the viewport
  // bottom. Top is fully consumed; bottom is entirely the app's problem.
  const out = AppView._frameInsets(RAW, rect({ top: 97, bottom: 844 }), VIEWPORT);
  assert.deepEqual(out, { top: 0, right: 0, bottom: 34, left: 0 });
});

test('_frameInsets: a full-viewport frame gets the raw insets', () => {
  // The chromeless share-link view — no shell chrome over any edge.
  const out = AppView._frameInsets(RAW, rect({ top: 0, bottom: 844 }), VIEWPORT);
  assert.deepEqual(out, { top: 44, right: 0, bottom: 34, left: 0 });
});

test('_frameInsets: a frame ending above the unsafe strip gets 0 bottom', () => {
  // A docked staging panel / any frame that stops short of the home
  // indicator: the shell's own layout already cleared it.
  const out = AppView._frameInsets(RAW, rect({ top: 97, bottom: 700 }), VIEWPORT);
  assert.equal(out.bottom, 0);
});

test('_frameInsets: partial overlap keeps only the uncovered remainder', () => {
  // Frame top 20px down a 44px status-bar inset → 24px still under it.
  const out = AppView._frameInsets(RAW, rect({ top: 20, bottom: 844 }), VIEWPORT);
  assert.equal(out.top, 24);
});

test('_frameInsets: landscape notch on the leading edge forwards left', () => {
  const raw = { top: 0, right: 44, bottom: 21, left: 44 };
  const out = AppView._frameInsets(
    raw, rect({ top: 0, right: 844, bottom: 390, left: 0 }),
    { width: 844, height: 390 }
  );
  assert.equal(out.left, 44);
  assert.equal(out.right, 44);
});

test('_frameInsets: zero raw insets stay zero (desktop / no notch)', () => {
  const out = AppView._frameInsets(
    { top: 0, right: 0, bottom: 0, left: 0 },
    rect({ top: 97, bottom: 844 }), VIEWPORT
  );
  assert.deepEqual(out, { top: 0, right: 0, bottom: 0, left: 0 });
});

test('_frameInsets: clamps to [0, raw] on both ends', () => {
  // A frame that doesn't reach an edge subtracts past zero (top here) — a
  // negative px in a CSS custom property is nonsense. A frame OVERHANGING
  // the viewport subtracts a NEGATIVE, which would forward an inset larger
  // than the screen's own: the unsafe strip under a frame can never exceed
  // the display's. This shape occurs transiently — the launch zoom pins
  // #app-view as a fixed overlay.
  const out = AppView._frameInsets(
    RAW, rect({ top: 200, right: 500, bottom: 1000, left: -50 }), VIEWPORT
  );
  assert.deepEqual(out, { top: 0, right: 0, bottom: RAW.bottom, left: 0 });
  // An edge with no raw inset can never gain one from geometry alone.
  assert.equal(out.left, 0);
  assert.equal(out.right, 0);
});

test('_frameInsets: rounds, and tolerates junk input', () => {
  const out = AppView._frameInsets(RAW, rect({ top: 96.4, bottom: 844 }), VIEWPORT);
  assert.ok(Number.isInteger(out.top), 'sub-pixel rects must not leak through');
  assert.deepEqual(AppView._frameInsets(null, null, null),
    { top: 0, right: 0, bottom: 0, left: 0 });
  assert.deepEqual(AppView._frameInsets(RAW, rect({}), { width: NaN, height: NaN }),
    { top: 0, right: 0, bottom: 0, left: 0 });
});

// ── 3. The shell's message plumbing ─────────────────────────────────

test('the shell forwards to every frame it owns', () => {
  assert.deepEqual(AppView.SAFE_AREA_FRAME_IDS,
    ['app-iframe', 'app-viewer-frame', 'staging-iframe'],
    'the App tab, the anonymous landing viewer and the staging preview');
});

test('the get handler is wired into the one top-level message listener', () => {
  const listener = APP_VIEW.slice(APP_VIEW.lastIndexOf("window.addEventListener('message'"));
  assert.match(listener, /AppView\.handleSafeAreaBridgeMessage\(e\)/,
    'the bridge\'s startup request must be dispatched');
});

test('the get handler only answers frames this shell owns', () => {
  const fn = APP_VIEW.slice(
    APP_VIEW.indexOf('handleSafeAreaBridgeMessage(e) {'),
    APP_VIEW.indexOf('// ── App LLM access consent flow')
  );
  assert.match(fn, /e\.source === iframe\.contentWindow/,
    'source-gated on a frame we own, same as the locale family');
  assert.match(fn, /if \(!match\) return;/,
    'an unknown source must be ignored, not answered');
  assert.match(fn, /__usernode_safe_area: 'response'/);
});

test('the broadcast is rAF-coalesced and value-deduplicated', () => {
  const fn = APP_VIEW.slice(
    APP_VIEW.indexOf('broadcastSafeArea() {'),
    APP_VIEW.indexOf('handleSafeAreaBridgeMessage(e) {')
  );
  assert.match(fn, /__usernode_safe_area: 'changed'/);
  assert.match(fn, /if \(AppView\._safeAreaSent\[id\] === key\) return;/,
    'an unchanged recompute must post nothing');
  assert.match(fn, /requestAnimationFrame/,
    'a burst of resize events must collapse into one recompute');
});

test('a 0x0 (hidden / unlaid-out) frame is skipped, not sent page insets', () => {
  const fn = APP_VIEW.slice(
    APP_VIEW.indexOf('safeAreaForFrame(id) {'),
    APP_VIEW.indexOf('broadcastSafeArea() {')
  );
  assert.match(fn, /if \(!rect\.width \|\| !rect\.height\) return null;/,
    'a 0x0 rect reads as flush against every edge — that would over-inset');
});

test('the probe reads env() through computed padding, once', () => {
  const fn = APP_VIEW.slice(
    APP_VIEW.indexOf('_readRootInsets() {'),
    APP_VIEW.indexOf('_frameInsets(raw, rect, viewport) {')
  );
  // JS cannot read env() directly; a hidden probe element is the only way.
  assert.match(fn, /padding-top:env\(safe-area-inset-top,0px\)/);
  assert.match(fn, /padding-bottom:env\(safe-area-inset-bottom,0px\)/);
  assert.match(fn, /getComputedStyle\(probe\)/);
  assert.match(fn, /visibility:hidden/, 'the probe must never be visible');
  assert.match(fn, /pointer-events:none/, 'nor swallow a tap');
  assert.match(fn, /!probe\.isConnected/, 'reuse the probe across reads');
});

test('viewport changes re-broadcast', () => {
  const tail = APP_VIEW.slice(APP_VIEW.lastIndexOf("window.addEventListener('message'"));
  for (const ev of ['resize', 'orientationchange']) {
    assert.ok(tail.includes(`window.addEventListener('${ev}', onViewportChange`),
      `${ev} must re-broadcast`);
  }
  assert.match(tail, /window\.visualViewport\.addEventListener\('resize', onViewportChange/,
    'keyboard / toolbar collapse moves the layout viewport\'s bottom edge');
});

test('an iframe load hands the fresh document its insets', () => {
  // Covers the token-refresh re-src too: that rewrites .src without
  // re-rendering, so `load` is the only hook.
  assert.match(APP_VIEW, /AppView\.iframeFocused = true;\s*\n\s*\/\/ #970[\s\S]{0,200}?scheduleSafeAreaBroadcast\(\)/,
    'renderAppTab\'s load listener must broadcast');
  const ladder = APP_VIEW.slice(
    APP_VIEW.indexOf('iframe.onload = () => {'),
    APP_VIEW.indexOf('iframe.onerror = () => {')
  );
  assert.match(ladder, /scheduleSafeAreaBroadcast\(\)/,
    'the launch reveal ladder must broadcast too');
});

// ── 4. The bridge side ──────────────────────────────────────────────

test('hosted bridge copies stay identical through this change', () => {
  assert.equal(BRIDGE, BRIDGE_MIRROR);
});

test('the bridge publishes the forwarded insets as CSS custom properties', () => {
  for (const edge of ['top', 'right', 'bottom', 'left']) {
    assert.ok(BRIDGE.includes(`"--un-safe-inset-" + EDGES[j]`)
      || BRIDGE.includes(`--un-safe-inset-${edge}`),
      `--un-safe-inset-${edge} must be set`);
  }
  assert.match(BRIDGE, /document\.documentElement\.style\.setProperty\(\s*"--un-safe-inset-"/,
    'the properties belong on <html>, like the kit\'s --un-kb-inset');
  assert.match(BRIDGE, /EDGES\s*=\s*\["top",\s*"right",\s*"bottom",\s*"left"\]/,
    'all four edges');
});

test('the bridge exposes safeAreaInsets and the change event', () => {
  assert.match(BRIDGE, /window\.usernode\.safeAreaInsets = _insets;/);
  assert.match(BRIDGE, /new CustomEvent\("usernode:safe-area-changed"/);
  assert.match(BRIDGE, /detail: \{\s*top: _insets\.top/,
    'the event detail carries the same four numbers');
});

test('the bridge speaks both halves of the message family', () => {
  assert.match(BRIDGE, /__usernode_safe_area: "get", id: _getId/,
    'ask once at load rather than waiting for a resize');
  assert.match(BRIDGE, /data\.__usernode_safe_area === "response" && data\.id === _getId/,
    'the answer must be matched to our own request id');
  assert.match(BRIDGE, /data\.__usernode_safe_area === "changed"/,
    'the shell pushes updates on rotation / rect changes');
  assert.match(BRIDGE, /if \(e\.source !== window\.parent\) return;/,
    'only the shell may set an app\'s insets');
});

test('the bridge is a no-op standalone, leaving env() to win', () => {
  const block = BRIDGE.slice(
    BRIDGE.indexOf('__USERNODE_SAFE_AREA_BEGIN__'),
    BRIDGE.indexOf('__USERNODE_SAFE_AREA_END__')
  );
  assert.ok(block, 'the block must be delimited like the other bridge families');
  assert.match(block, /if \(window === window\.parent\) return;/,
    'no parent means no shell to ask');
  // The early return must sit AFTER safeAreaInsets is published (so the
  // property always reads) but BEFORE any property is set (so the env()
  // fallback in `var(..., env(...))` wins outside an iframe).
  assert.ok(block.indexOf('window.usernode.safeAreaInsets = _insets;')
    < block.indexOf('if (window === window.parent) return;'),
    'safeAreaInsets must exist even standalone');
  assert.ok(block.indexOf('if (window === window.parent) return;')
    < block.indexOf('window.parent.postMessage('),
    'standalone must not post');
});

test('the bridge clamps junk values instead of trusting them', () => {
  const block = BRIDGE.slice(
    BRIDGE.indexOf('__USERNODE_SAFE_AREA_BEGIN__'),
    BRIDGE.indexOf('__USERNODE_SAFE_AREA_END__')
  );
  assert.match(block, /isFinite\(n\) && n > 0 \? n : 0/,
    'a negative / NaN inset must become 0, never reach the CSS');
  assert.match(block, /if \(!changed\) return;/,
    'an unchanged value must not re-dispatch the event');
});

// ── 5. The kit consumes the forwarded value ─────────────────────────

test('native.css uses the forwarded property everywhere, env() as fallback', () => {
  const lines = NATIVE_CSS.split('\n');
  const bare = [];
  lines.forEach((line, i) => {
    // The @supports condition is a syntax-support probe and stays bare.
    if (line.includes('@supports')) return;
    const re = /env\(safe-area-inset-(top|right|bottom|left)/g;
    let m;
    while ((m = re.exec(line))) {
      const before = line.slice(0, m.index);
      if (!new RegExp(`var\\(--un-safe-inset-${m[1]},\\s*$`).test(before)) {
        bare.push(`${i + 1}: ${line.trim()}`);
      }
    }
  });
  assert.deepEqual(bare, [],
    'bare env(safe-area-inset-*) is 0px inside an app frame — it must always '
    + 'sit as the fallback of var(--un-safe-inset-*, …):\n' + bare.join('\n'));
});

test('native.css still resolves correctly with no property set', () => {
  // The platform shell and standalone apps never get the custom property,
  // so every var() needs its own env() fallback WITH a 0px default.
  const uses = NATIVE_CSS.match(/var\(--un-safe-inset-(?:top|right|bottom|left),[^)]*\)*/g) || [];
  assert.ok(uses.length >= 17, `expected the whole stylesheet rewritten, saw ${uses.length}`);
  for (const edge of ['top', 'right', 'bottom', 'left']) {
    const re = new RegExp(
      `var\\(--un-safe-inset-${edge}, env\\(safe-area-inset-${edge}, 0px\\)\\)`
    );
    assert.match(NATIVE_CSS, re, `--un-safe-inset-${edge} needs the env(…, 0px) fallback`);
  }
});

test('the @supports safe-area probe stays bare env()', () => {
  assert.match(NATIVE_CSS, /@supports \(padding: env\(safe-area-inset-top\)\) \{/,
    'wrapping the feature query in var() would test the wrong thing');
});

test('the kit keyboard inset is untouched by the safe-area rewrite', () => {
  // --un-kb-inset is a separate concern (the app's own visualViewport
  // reports the keyboard correctly inside the frame) and must not be
  // folded into the forwarded safe area.
  assert.match(NATIVE_CSS, /html\.un-kb \.un-sheet \{\s*padding-bottom: 0;/,
    'the keyboard-up suppression rules still stand');
  assert.ok(NATIVE_CSS.includes('var(--un-kb-inset, 0px)'),
    'the keyboard inset is still its own variable');
});

// ── 6. Docs stay in step ────────────────────────────────────────────

test('app-conventions documents the forwarded insets for generated apps', () => {
  const doc = read('src/prompts/app-conventions.md');
  assert.ok(doc.includes('## Safe-area insets inside the app frame'),
    'apps need to be told bare env() is 0px in the frame');
  assert.ok(doc.includes('usernode.safeAreaInsets'));
  assert.ok(doc.includes('usernode:safe-area-changed'));
  assert.ok(doc.includes('var(--un-safe-inset-bottom, env(safe-area-inset-bottom, 0px))'),
    'the doc must show the exact form apps should write');
});
