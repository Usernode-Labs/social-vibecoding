// The status bar over a surface with a tone of its own (#26).
//
// Inside the Homeroom app the status bar's clock and battery are drawn from
// the app's theme, which is the shell's appearance (setAppearance,
// tests/native-appearance.test.js). Over the fullscreen staging preview's
// near-black bar on the light shell that meant dark glyphs on dark, which
// nobody could read; a dark app under the light shell (or the reverse) had
// the same problem.
//
// The web half has three parts, and this file pins each:
//
//   1. publishStatusBarTone (public/js/native-chrome.js): the tone of the
//      ground UNDER the status bar. 'dark' while the before/after compare
//      overlay is open, on a project's pages (the community's colour) and
//      on a phone's top-level screens (the tab bar's blue, Mobile 01), else
//      the running app's `data-app-tone`, else null. Sent only when it
//      changes, only to a build that advertises `setStatusBarTone`.
//   2. The bridge wrapper (public/usernode-bridge.js): unprivileged, and on
//      an older build that drops the unknown method it rejects after its
//      timeout, with no console.error anywhere on the way.
//   3. The stopgap in public/css/app.css: until a build takes the tone, the
//      preview bar's safe-area band is painted in the shell's ground, so the
//      theme's glyphs sit on the ground they were picked for.
//
// Run with: node --test tests/native-status-bar-tone.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const nativeChromeSource = read('public', 'js', 'native-chrome.js');

const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fakeElement(classes = []) {
  const set = new Set(classes);
  const attributes = new Map();
  return {
    classes: set,
    attributes,
    classList: {
      contains: (name) => set.has(name),
      add: (name) => set.add(name),
      remove: (name) => set.delete(name),
    },
    getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
  };
}

/**
 * Boot native-chrome.js with a document that has the two overlays and an
 * <html> whose `data-app-tone` the test controls, plus a MutationObserver
 * the test fires by hand.
 *
 * opts: { capabilities, native, framed, setStatusBarToneImpl,
 *         getBridgeInfoImpl, withOverlays (default true), noMethod,
 *         phone (the window is under 768px; default false),
 *         screen (the root on show at boot), noMatchMedia }
 *
 * The page has the header (shown) and every screen root the phone's blue bar
 * is drawn on, all hidden, plus the app view (hidden, on the platform's
 * surface): `screens`, which the test shows and hides as the router does.
 */
const PHONE_QUERY = '(max-width: 767.98px)';
const SCREEN_IDS = ['home-screen', 'leaderboard-screen', 'profile-screen',
  'settings-screen', 'messages-screen', 'workshop-screen', 'weekly-digest-screen',
  'communities-screen', 'ai-screen', 'profile-proposals-screen'];

function boot(opts = {}) {
  const calls = { tones: [], bridgeInfo: 0, errors: [], warnings: [] };
  const attrs = new Map();
  const html = fakeElement();
  html.getAttribute = (name) => (attrs.has(name) ? attrs.get(name) : null);
  const overlays = {
    'staging-overlay': fakeElement(['hidden']),
    'visual-compare-overlay': fakeElement(['hidden']),
  };
  const screens = { 'platform-header': fakeElement() };
  for (const id of SCREEN_IDS) screens[id] = fakeElement(['hidden']);
  screens['app-view'] = fakeElement(['hidden']);
  screens['app-view'].attributes.set('data-app-surface', 'platform');
  if (opts.screen) screens[opts.screen].classes.delete('hidden');
  const width = { phone: !!opts.phone, listeners: [] };
  const observed = [];
  let observerCallback = null;
  class FakeMutationObserver {
    constructor(callback) { observerCallback = callback; }
    observe(target, options) { observed.push({ target, options }); }
    disconnect() {}
  }
  const capabilities = opts.capabilities || ['setStatusBarTone'];
  const usernode = opts.native === false ? { isNative: false } : {
    isNative: true,
    async getBridgeInfo() {
      calls.bridgeInfo += 1;
      return opts.getBridgeInfoImpl
        ? opts.getBridgeInfoImpl(calls.bridgeInfo)
        : { version: 5, capabilities };
    },
  };
  if (opts.native !== false && !opts.noMethod) {
    usernode.setStatusBarTone = async (state) => {
      calls.tones.push(state);
      if (opts.setStatusBarToneImpl) return opts.setStatusBarToneImpl(state);
      return true;
    };
  }
  const sandbox = {
    console: {
      log() {},
      warn(...args) { calls.warnings.push(args); },
      error(...args) { calls.errors.push(args); },
    },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    App: { user: null },
    usernode,
    MutationObserver: FakeMutationObserver,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    getComputedStyle: () => ({ backgroundColor: 'rgb(255, 254, 234)' }),
    document: {
      documentElement: html,
      visibilityState: 'visible',
      getElementById(id) {
        return opts.withOverlays === false ? null : (overlays[id] || screens[id] || null);
      },
      createElement() { return {}; },
      addEventListener() {},
    },
    matchMedia: opts.noMatchMedia ? undefined : (query) => ({
      get matches() { return query === PHONE_QUERY && width.phone; },
      addEventListener(type, fn) { if (type === 'change') width.listeners.push(fn); },
    }),
    addEventListener() {},
    dispatchEvent() {},
    setTimeout,
    clearTimeout,
    setInterval() { return 0; },
    async fetch() { throw new Error('no network in this test'); },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  if (opts.framed) sandbox.parent = { postMessage() {} };
  vm.createContext(sandbox);
  vm.runInContext(nativeChromeSource, sandbox);
  return {
    sandbox,
    calls,
    html,
    overlays,
    screens,
    width,
    observed,
    NativeChrome: sandbox.NativeChrome,
    tones: () => plain(calls.tones).map((t) => t.tone),
    setAppTone(tone) {
      if (tone) attrs.set('data-app-tone', tone); else attrs.delete('data-app-tone');
    },
    // community-tint.ts sets it empty while a project's pages are up.
    setCommunityTint(on) {
      if (on) attrs.set('data-community-tint', ''); else attrs.delete('data-community-tint');
    },
    setAttr(name, value) {
      if (value === null || value === undefined) attrs.delete(name); else attrs.set(name, value);
    },
    // What App._showOnlyScreen does: one root shown, the rest hidden.
    showOnly(id, surface) {
      for (const key of [...SCREEN_IDS, 'app-view']) {
        if (key === id) screens[key].classes.delete('hidden'); else screens[key].classes.add('hidden');
      }
      if (surface) screens['app-view'].attributes.set('data-app-surface', surface);
    },
    // The window crossing 768px: the media query's own change event.
    async setPhone(on) {
      width.phone = on;
      for (const fn of width.listeners) fn();
      await settle();
      await settle();
    },
    // What React's useHiddenClass / useClassToggle do, then the observer.
    async mutate(fn) {
      fn(overlays);
      if (observerCallback) observerCallback([]);
      await settle();
      await settle();
    },
  };
}

// ── 1. The pure tone ───────────────────────────────────────────────────

test('statusBarToneFor: an open dark overlay wins, then the app, then nothing', () => {
  const { NativeChrome } = boot();
  const tone = (s) => NativeChrome.statusBarToneFor(s);
  assert.equal(tone({}), null, 'nothing on screen: the app\'s theme decides');
  assert.equal(tone(undefined), null);
  // Nov 2026: the change preview's header is drawn in the theme's colours,
  // so filling the screen it hands the bar back to the theme.
  assert.equal(tone({ previewFullscreen: true }), null);
  assert.equal(tone({ compareOpen: true }), 'dark');
  assert.equal(tone({ appTone: 'dark' }), 'dark');
  assert.equal(tone({ appTone: 'light' }), 'light');
  assert.equal(tone({ appTone: 'dark', previewFullscreen: true }), null,
    'the preview covers the app, and its header is the theme\'s whatever is under it');
  assert.equal(tone({ communityTint: true, previewFullscreen: true }), null,
    'and covers the community\'s navy bar too');
  assert.equal(tone({ previewFullscreen: true, compareOpen: true }), 'dark',
    'the compare overlay, opened from it, is still near-black');
  assert.equal(tone({ appTone: 'sepia' }), null, 'nothing but the two tones');
  // Polish board #6: a project's pages wear the community's colour on the
  // header, always fitted for white text, so the glyphs are light there.
  assert.equal(tone({ communityTint: true }), 'dark');
  assert.equal(tone({ communityTint: true, appTone: 'light' }), 'dark',
    'the tint is only ever on the project\'s pages; in a running app it is taken off');
  assert.equal(tone({ communityTint: false, appTone: 'light' }), 'light');
  // iPhone Duo: with the clock in the side strip, over the wallpaper, the
  // header's tint and the app's page colour are not under it. The overlays,
  // which run under the strip, still are.
  assert.equal(tone({ sideStrip: true, communityTint: true }), null,
    'the strip is the wallpaper: the app\'s theme decides');
  assert.equal(tone({ sideStrip: true, appTone: 'dark' }), null);
  assert.equal(tone({ sideStrip: true, compareOpen: true }), 'dark');
  assert.equal(tone({ sideStrip: true, previewFullscreen: true }), null);
});

test('the preview counts while it fills the screen, not docked beside a page', async () => {
  const h = boot();
  const read = () => h.NativeChrome._statusBarToneState();
  assert.deepEqual(plain(read()), { previewFullscreen: false, compareOpen: false, communityTint: false, appTone: null, sideStrip: false, phoneBar: false });

  h.overlays['staging-overlay'].classes.delete('hidden');
  assert.equal(read().previewFullscreen, true, 'shown, and full until it says otherwise');
  h.overlays['staging-overlay'].attributes.set('data-placement', 'column');
  assert.equal(read().previewFullscreen, false, 'in a column it starts below the header');
  h.overlays['staging-overlay'].attributes.set('data-placement', 'panel');
  assert.equal(read().previewFullscreen, false, 'and in the side panel');
  h.overlays['staging-overlay'].attributes.set('data-placement', 'full');
  assert.equal(read().previewFullscreen, true);

  h.overlays['visual-compare-overlay'].classes.delete('hidden');
  assert.equal(read().compareOpen, true);
  h.setAppTone('dark');
  assert.equal(read().appTone, 'dark');
});

// ── 2. The publisher ───────────────────────────────────────────────────

test('it publishes on boot, then each CHANGE, and nothing else', async () => {
  const h = boot();
  await settle();
  assert.deepEqual(h.tones(), [null],
    'the boot publish clears whatever a previous document left behind');
  assert.ok(h.html.classes.has('native-status-bar-tone'),
    'and an accepted tone retires the CSS stopgap');

  await h.mutate((o) => o['staging-overlay'].classes.delete('hidden'));
  assert.deepEqual(h.tones(), [null], 'the fullscreen preview opened: its header is the theme\'s, nothing to send');
  await h.mutate((o) => o['staging-overlay'].classes.add('hidden'));

  await h.mutate((o) => o['visual-compare-overlay'].classes.delete('hidden'));
  assert.deepEqual(h.tones(), [null, 'dark'], 'the near-black compare overlay opened');

  await h.mutate(() => {});
  await h.NativeChrome.publishStatusBarTone();
  assert.deepEqual(h.tones(), [null, 'dark'], 'an unchanged tone is not re-sent');

  await h.mutate((o) => o['visual-compare-overlay'].classes.add('hidden'));
  assert.deepEqual(h.tones(), [null, 'dark', null], 'closed: back to the theme');

  h.setAppTone('light');
  await h.mutate(() => {});
  await h.mutate((o) => o['visual-compare-overlay'].classes.delete('hidden'));
  await h.mutate((o) => o['visual-compare-overlay'].classes.add('hidden'));
  assert.deepEqual(h.tones(), [null, 'dark', null, 'light', 'dark', 'light'],
    'a light app, the compare overlay over it, and the app again');
  assert.deepEqual(plain(h.calls.tones[1]), { tone: 'dark' }, 'the wire shape');
});

test('a project\'s pages publish light glyphs over the community\'s colour (polish #6)', async () => {
  const h = boot();
  await settle();
  assert.deepEqual(h.tones(), [null]);
  h.setCommunityTint(true);
  await h.mutate(() => {});
  assert.deepEqual(h.tones(), [null, 'dark'], 'the Hub, the Workshop or a request: the navy bar');
  assert.equal(h.NativeChrome._statusBarToneState().communityTint, true);
  // Opening the running app takes the tint off and puts its own tone on.
  h.setCommunityTint(false);
  h.setAppTone('light');
  await h.mutate(() => {});
  assert.deepEqual(h.tones(), [null, 'dark', 'light'], 'the app\'s own tone wins inside it');
  h.setAppTone(null);
  await h.mutate(() => {});
  assert.deepEqual(h.tones(), [null, 'dark', 'light', null], 'off a project: the theme again');
});

test('it watches exactly what decides the tone', () => {
  const h = boot();
  const all = { ...h.overlays, ...h.screens };
  const targets = h.observed.map(({ target, options }) => ({
    target: target === h.html ? 'html'
      : Object.keys(all).find((id) => all[id] === target),
    filter: options.attributeFilter,
  }));
  assert.deepEqual(plain(targets), [
    { target: 'html', filter: ['data-app-tone', 'data-community-tint', 'data-side-strip'] },
    { target: 'staging-overlay', filter: ['class', 'data-placement'] },
    { target: 'visual-compare-overlay', filter: ['class', 'data-placement'] },
    // Mobile 01: the phone's blue bar follows the route.
    { target: 'platform-header', filter: ['class'] },
    ...SCREEN_IDS.map((id) => ({ target: id, filter: ['class'] })),
    { target: 'app-view', filter: ['class', 'data-app-surface'] },
  ]);
  assert.equal(h.width.listeners.length, 1, 'and the width, which crosses 768px with nothing in the document changing');
});

// ── 1b. The phone's top bar (Mobile 01) ────────────────────────────────

test('statusBarToneFor: the phone\'s blue top bar is a dark ground', () => {
  const { NativeChrome } = boot();
  const tone = (s) => NativeChrome.statusBarToneFor(s);
  assert.equal(tone({ phoneBar: true }), 'dark',
    'the tab bar\'s blue, #3c7bd8 light and #122a52 dark: white clock and battery in both');
  assert.equal(tone({ phoneBar: false }), null, 'off it, the app\'s theme decides as before');
  assert.equal(tone({ phoneBar: true, sideStrip: true }), null,
    'iPhone Duo: the clock is in the side strip, over the wallpaper, not over the bar');
  assert.equal(tone({ phoneBar: true, previewFullscreen: true }), null,
    'the preview fills the screen in the theme\'s own colours');
  assert.equal(tone({ phoneBar: true, compareOpen: true }), 'dark');
  assert.equal(tone({ phoneBar: true, appTone: 'light' }), 'dark',
    'the bar is blue wherever it is up, whatever tone an app frame left behind');
  assert.equal(tone({ phoneBar: true, communityTint: true }), 'dark');
});

test('the blue bar is read off the page: a phone, a top-level screen', () => {
  const h = boot({ phone: true });
  const read = () => h.NativeChrome._statusBarToneState().phoneBar;
  assert.equal(read(), false, 'no screen root on show yet');
  for (const id of SCREEN_IDS) {
    h.showOnly(id);
    assert.equal(read(), true, id);
  }
  h.showOnly('home-screen');
  h.html.classes.add('dark');
  assert.equal(read(), true, 'dark mode too: the bar is the tab bar\'s dark blue');
  assert.equal(h.NativeChrome.statusBarToneFor(h.NativeChrome._statusBarToneState()), 'dark');
  h.html.classes.delete('dark');

  h.showOnly('app-view', 'platform');
  assert.equal(read(), true, 'a project page the platform draws (its tint, once known, says the same)');
  h.showOnly('app-view', 'app');
  assert.equal(read(), false, 'a running app: its own tone decides');

  h.showOnly('home-screen');
  h.screens['platform-header'].classes.add('hidden');
  assert.equal(read(), false, 'no header, no bar');
  h.screens['platform-header'].classes.delete('hidden');
  h.width.phone = false;
  assert.equal(read(), false, 'from 768px the header is a different drawing');

  const none = boot({ phone: true, noMatchMedia: true });
  none.showOnly('home-screen');
  assert.equal(none.NativeChrome._statusBarToneState().phoneBar, false, 'no media queries: no claim');
});

test('the tone follows the route on a phone: light glyphs on the top level, the app\'s inside it', async () => {
  const h = boot({ phone: true, screen: 'home-screen' });
  await settle();
  assert.deepEqual(h.tones(), ['dark'], 'Home, at boot');

  await h.mutate(() => h.showOnly('messages-screen'));
  assert.deepEqual(h.tones(), ['dark'], 'Messages: the same bar, nothing re-sent');

  h.setCommunityTint(true);
  await h.mutate(() => h.showOnly('app-view', 'platform'));
  assert.deepEqual(h.tones(), ['dark'], 'a project\'s pages: its colour, still dark');

  h.setCommunityTint(false);
  await h.mutate(() => h.showOnly('app-view', 'app'));
  assert.deepEqual(h.tones(), ['dark', null], 'the running app, with no tone of its own: the theme');
  h.setAppTone('light');
  await h.mutate(() => {});
  assert.deepEqual(h.tones(), ['dark', null, 'light']);

  h.setAppTone(null);
  await h.mutate(() => h.showOnly('ai-screen'));
  assert.deepEqual(h.tones(), ['dark', null, 'light', 'dark'], 'back on the Homeroom bot tab');

  h.setAttr('data-side-strip', 'right');
  await h.mutate(() => {});
  assert.deepEqual(h.tones(), ['dark', null, 'light', 'dark', null], 'the Duo\'s side strip: the wallpaper');
  h.setAttr('data-side-strip', null);
  await h.mutate(() => {});

  await h.setPhone(false);
  assert.deepEqual(h.tones(), ['dark', null, 'light', 'dark', null, 'dark', null],
    'widened past 768px (an iPad\'s split view): the desktop bar, the theme');
  await h.setPhone(true);
  assert.deepEqual(h.tones().slice(-1), ['dark'], 'and narrowed again');
});

test('a change that lands while a publish is in flight is not lost', async () => {
  let release = null;
  const h = boot({
    setStatusBarToneImpl: () => new Promise((resolve) => { release = resolve; }),
  });
  await settle();
  // The boot publish (null) is in flight. The compare overlay opens and
  // closes again before the app answers: the tone that finally holds is null.
  await h.mutate((o) => o['visual-compare-overlay'].classes.delete('hidden'));
  release(true);
  await settle(); await settle(); await settle();
  assert.deepEqual(h.tones(), [null, 'dark'], 'the open was picked up');
  await h.mutate((o) => o['visual-compare-overlay'].classes.add('hidden'));
  release(true);
  await settle(); await settle(); await settle();
  assert.deepEqual(h.tones(), [null, 'dark', null], 'and so was the close');
});

test('a build without the capability is never called, and keeps the stopgap', async () => {
  const h = boot({ capabilities: ['setAppearance'] });
  await settle();
  await h.mutate((o) => o['staging-overlay'].classes.delete('hidden'));
  assert.deepEqual(h.tones(), []);
  assert.equal(h.html.classes.has('native-status-bar-tone'), false,
    'the band under the status bar stays painted in the shell\'s ground');
});

test('outside the app, in a framed copy, or with an older bridge: nothing at all', async () => {
  for (const opts of [{ native: false }, { framed: true }, { noMethod: true }]) {
    const h = boot(opts);
    await settle();
    await h.NativeChrome.publishStatusBarTone();
    assert.deepEqual(h.tones(), [], JSON.stringify(opts));
    assert.equal(h.calls.bridgeInfo, 0, `${JSON.stringify(opts)}: not even a probe`);
    assert.equal(h.observed.length, 0, `${JSON.stringify(opts)}: nothing observed`);
    assert.equal(h.width.listeners.length, 0, `${JSON.stringify(opts)}: not even the width`);
  }
});

test('a DEGRADED probe is inconclusive, not a latched "unsupported" (#978)', async () => {
  const h = boot({
    getBridgeInfoImpl: (n) => (n === 1
      ? { version: 0, capabilities: [], degraded: true }
      : { version: 5, capabilities: ['setStatusBarTone'] }),
  });
  await settle();
  assert.deepEqual(h.tones(), [], 'the boot probe hit the hiccup');
  await h.mutate((o) => o['visual-compare-overlay'].classes.delete('hidden'));
  assert.deepEqual(h.tones(), ['dark'], 're-probed on the next change');
});

test('an older build that drops the method: a warning, never a console.error', async () => {
  const h = boot({
    setStatusBarToneImpl: () => Promise.reject(
      new Error('setStatusBarTone is not supported by this app build')),
  });
  await settle();
  assert.equal(await h.NativeChrome.publishStatusBarTone(), false);
  assert.deepEqual(h.calls.errors, [],
    'proposal checks fail any route that logs a console.error');
  assert.ok(h.calls.warnings.some((args) => /status-bar tone publish failed/.test(args[0])));
  assert.equal(h.html.classes.has('native-status-bar-tone'), false,
    'nothing was accepted, so the stopgap stays');
});

test('the publisher is wired at boot, beside the appearance publish', () => {
  const init = /\n\s*init\(\)\s*\{[\s\S]*?\n\s*\},\n\s*\};/.exec(nativeChromeSource);
  assert.ok(init, 'init() must still be findable');
  const body = init[0];
  const appearance = body.indexOf('_initAppearancePublish()');
  const tone = body.indexOf('_initStatusBarTonePublish()');
  const session = body.indexOf('establishCurrentSession');
  assert.ok(appearance !== -1 && tone > appearance && tone < session,
    'presentation state, not gated on the login handoff');
});

// ── 3. The bridge wrapper, against an app build that does not know it ──

function loadBridge({ dropped = [], timeoutScale = 0.001 } = {}) {
  const posts = [];
  const errors = [];
  const sandbox = {
    console: { log() {}, warn() {}, error(...args) { errors.push(args); } },
    Date, Math, Promise, URL, URLSearchParams,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    setTimeout(fn, delay) { return setTimeout(fn, delay * timeoutScale); },
    clearTimeout,
    location: { href: 'https://social.example/', host: 'social.example', protocol: 'https:', search: '' },
    localStorage: { getItem() { return null; }, setItem() {} },
    document: {
      currentScript: { src: 'https://social.example/usernode-bridge.js' },
      readyState: 'complete',
      head: { appendChild() {} },
      body: { appendChild() {} },
      getElementById() { return null; },
      addEventListener() {},
      createElement() { return { appendChild() {}, setAttribute() {}, addEventListener() {}, style: {} }; },
    },
    addEventListener() {},
    dispatchEvent() {},
    fetch: async () => ({ ok: false }),
  };
  sandbox.window = sandbox;
  sandbox.parent = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.Usernode = {
    postMessage(raw) {
      const request = JSON.parse(raw);
      posts.push(request);
      // An older app build logs and drops a method it does not know.
      if (dropped.includes(request.method)) return;
      sandbox.__usernodeResolve(request.id, true, null);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(read('public', 'usernode-bridge.js'), sandbox);
  return { sandbox, posts, errors };
}

test('the wrapper is unprivileged and normalises the tone', async () => {
  const loaded = loadBridge();
  assert.equal(await loaded.sandbox.usernode.setStatusBarTone({ tone: 'dark' }), true);
  await loaded.sandbox.usernode.setStatusBarTone({ tone: 'light' });
  await loaded.sandbox.usernode.setStatusBarTone({ tone: null });
  await loaded.sandbox.usernode.setStatusBarTone({ tone: 'sepia' });
  await loaded.sandbox.usernode.setStatusBarTone();
  const posts = loaded.posts.filter((p) => p.method === 'setStatusBarTone');
  assert.deepEqual(plain(posts.map((p) => p.args)), [
    { tone: 'dark' }, { tone: 'light' }, { tone: null }, { tone: null }, { tone: null },
  ]);
  for (const post of posts) {
    assert.equal('privilegedCapability' in post, false,
      'no capability handshake: it is presentation state, like setAppearance');
    assert.equal('realmSessionClaim' in post, false, 'and not session-bound');
  }
  assert.equal(loaded.posts.some((p) => p.method === 'getPrivilegedBridgeCapability'), false);

  const privileged = /_PRIVILEGED_NATIVE_METHODS\s*=\s*\{([\s\S]*?)\n\s*\};/
    .exec(read('public', 'usernode-bridge.js'));
  assert.doesNotMatch(privileged[1], /\bsetStatusBarTone\b/);
});

test('on a build that drops the method, the call rejects after its timeout '
  + 'and logs no console.error', async () => {
  const loaded = loadBridge({ dropped: ['setStatusBarTone'] });
  await assert.rejects(
    loaded.sandbox.usernode.setStatusBarTone({ tone: 'dark' }),
    /setStatusBarTone is not supported by this app build/,
  );
  assert.deepEqual(loaded.errors, []);
  const record = loaded.sandbox.usernode.getLastNativeReadError('setStatusBarTone');
  assert.equal(record && record.kind, 'timeout', 'recorded for Settings diagnostics');
});

test('both copies of the hosted bridge carry it', () => {
  assert.equal(read('public', 'usernode-bridge.js'),
    read('public', 'usernode-bridge', 'v1', 'bridge.js'),
    'public/usernode-bridge.js is served from the canonical v1 copy');
});

// ── 4. The stopgap, and the contract ───────────────────────────────────

test('the preview\'s header paints its own ground under the status bar', () => {
  // Nov 2026: the band under the clock used to be painted in the shell's
  // ground until the app took a tone, because the preview's bar was
  // near-black. Its header is the theme's own sheet now, padded down under
  // the clock, so there is no band to paint and no stopgap to retire.
  const css = read('public', 'css', 'app.css');
  assert.doesNotMatch(css, /native-status-bar-tone\)\s*#staging-overlay/, 'no stopgap band');
  assert.match(css, /\.staging-head\s*\{[^}]*background:\s*var\(--dc-sheet-solid\)/, 'the header is the theme\'s sheet');

  // The class the app's first accepted tone writes is still the publisher's.
  const { NativeChrome } = boot();
  assert.equal(NativeChrome._STATUS_TONE_CLASS, 'native-status-bar-tone');

  // The inset itself is untouched (tests/platform-safe-bottom.test.js).
  assert.match(css,
    /#staging-overlay \.staging-chrome-bar\s*\{\s*padding-top:\s*calc\(0\.5rem \+ var\(--platform-safe-top\)\);\s*\}/);
});

test('NATIVE-BRIDGE.md carries the producer contract', () => {
  const doc = read('NATIVE-BRIDGE.md');
  assert.match(doc, /- `setStatusBarTone`: /, 'listed with the additive capabilities');
  assert.match(doc, /### Status-bar tone \(additive; `setStatusBarTone`\)/);
  assert.match(doc, /`setStatusBarTone\(\{ tone \}\)`/);
  assert.match(doc, /`"dark"`: the ground is dark, so draw LIGHT status-bar glyphs\./);
  assert.match(doc, /`null`: clear the override/);
  assert.match(doc, /\*\*Do not persist it\.\*\*/);
});
