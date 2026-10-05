const { withLanguage } = require("./lib/platform-language");
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
//      ground UNDER the status bar. 'dark' while the fullscreen preview or
//      the before/after compare overlay is open, else the running app's
//      `data-app-tone`, else null. Sent only when it changes, only to a
//      build that advertises `setStatusBarTone`.
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
  return {
    classes: set,
    classList: {
      contains: (name) => set.has(name),
      add: (name) => set.add(name),
      remove: (name) => set.delete(name),
    },
  };
}

/**
 * Boot native-chrome.js with a document that has the two overlays and an
 * <html> whose `data-app-tone` the test controls, plus a MutationObserver
 * the test fires by hand.
 *
 * opts: { capabilities, native, framed, setStatusBarToneImpl,
 *         getBridgeInfoImpl, withOverlays (default true), noMethod }
 */
function boot(opts = {}) {
  const calls = { tones: [], bridgeInfo: 0, errors: [], warnings: [] };
  const attrs = new Map();
  const html = fakeElement();
  html.getAttribute = (name) => (attrs.has(name) ? attrs.get(name) : null);
  const overlays = {
    'staging-overlay': fakeElement(['hidden']),
    'visual-compare-overlay': fakeElement(['hidden']),
  };
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
    getComputedStyle: () => ({ backgroundColor: 'rgb(244, 242, 228)' }),
    document: {
      documentElement: html,
      visibilityState: 'visible',
      getElementById(id) {
        return opts.withOverlays === false ? null : (overlays[id] || null);
      },
      createElement() { return {}; },
      addEventListener() {},
    },
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
  vm.createContext(withLanguage(sandbox));
  vm.runInContext(nativeChromeSource, sandbox);
  return {
    sandbox,
    calls,
    html,
    overlays,
    observed,
    NativeChrome: sandbox.NativeChrome,
    tones: () => plain(calls.tones).map((t) => t.tone),
    setAppTone(tone) {
      if (tone) attrs.set('data-app-tone', tone); else attrs.delete('data-app-tone');
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
  assert.equal(tone({ previewFullscreen: true }), 'dark');
  assert.equal(tone({ compareOpen: true }), 'dark');
  assert.equal(tone({ appTone: 'dark' }), 'dark');
  assert.equal(tone({ appTone: 'light' }), 'light');
  assert.equal(tone({ appTone: 'light', previewFullscreen: true }), 'dark',
    'the preview covers the app, and its bar is near-black whatever is under it');
  assert.equal(tone({ appTone: 'sepia' }), null, 'nothing but the two tones');
});

test('only the FULLSCREEN preview counts', async () => {
  const h = boot();
  const read = () => h.NativeChrome._statusBarToneState();
  assert.deepEqual(plain(read()), { previewFullscreen: false, compareOpen: false, appTone: null });

  h.overlays['staging-overlay'].classes.delete('hidden');
  assert.equal(read().previewFullscreen, true);
  h.overlays['staging-overlay'].classes.add('staging-overlay-docked');
  assert.equal(read().previewFullscreen, false, 'docked, it sits mid-page');
  h.overlays['staging-overlay'].classes.delete('staging-overlay-docked');
  h.overlays['staging-overlay'].classes.add('staging-overlay-under-chrome');
  assert.equal(read().previewFullscreen, false,
    'under a session\'s chrome, the platform header is what the bar is over');

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
  assert.deepEqual(h.tones(), [null, 'dark'], 'the fullscreen preview opened');

  await h.mutate(() => {});
  await h.NativeChrome.publishStatusBarTone();
  assert.deepEqual(h.tones(), [null, 'dark'], 'an unchanged tone is not re-sent');

  await h.mutate((o) => o['staging-overlay'].classes.add('hidden'));
  assert.deepEqual(h.tones(), [null, 'dark', null], 'closed: back to the theme');

  h.setAppTone('light');
  await h.mutate(() => {});
  await h.mutate((o) => o['visual-compare-overlay'].classes.delete('hidden'));
  await h.mutate((o) => o['visual-compare-overlay'].classes.add('hidden'));
  assert.deepEqual(h.tones(), [null, 'dark', null, 'light', 'dark', 'light'],
    'a light app, the compare overlay over it, and the app again');
  assert.deepEqual(plain(h.calls.tones[1]), { tone: 'dark' }, 'the wire shape');
});

test('it watches exactly what decides the tone', () => {
  const h = boot();
  const targets = h.observed.map(({ target, options }) => ({
    target: target === h.html ? 'html'
      : Object.keys(h.overlays).find((id) => h.overlays[id] === target),
    filter: options.attributeFilter,
  }));
  assert.deepEqual(plain(targets), [
    { target: 'html', filter: ['data-app-tone'] },
    { target: 'staging-overlay', filter: ['class'] },
    { target: 'visual-compare-overlay', filter: ['class'] },
  ]);
});

test('a change that lands while a publish is in flight is not lost', async () => {
  let release = null;
  const h = boot({
    setStatusBarToneImpl: () => new Promise((resolve) => { release = resolve; }),
  });
  await settle();
  // The boot publish (null) is in flight. The preview opens and closes
  // again before the app answers: the tone that finally holds is null.
  await h.mutate((o) => o['staging-overlay'].classes.delete('hidden'));
  release(true);
  await settle(); await settle(); await settle();
  assert.deepEqual(h.tones(), [null, 'dark'], 'the open was picked up');
  await h.mutate((o) => o['staging-overlay'].classes.add('hidden'));
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
  await h.mutate((o) => o['staging-overlay'].classes.delete('hidden'));
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
  vm.createContext(withLanguage(sandbox));
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

test('until the app takes a tone, the preview bar\'s safe-area band is the shell\'s ground', () => {
  const css = read('public', 'css', 'app.css');
  const head = read('frontend', 'src', 'head.html');
  const ground = {
    light: /html\s*\{\s*background-color:\s*(#[0-9a-f]{6})/.exec(head)[1],
    dark: /html\.dark\s*\{\s*background-color:\s*(#[0-9a-f]{6})/.exec(head)[1],
  };
  const bar = '#staging-overlay:not(.staging-overlay-docked):not(.staging-overlay-under-chrome) .staging-chrome-bar';
  const rule = (prefix) => {
    const at = css.indexOf(`${prefix} ${bar} {`);
    assert.ok(at !== -1, `missing: ${prefix} ${bar}`);
    return css.slice(at, css.indexOf('}', at));
  };
  const light = rule('html.in-native-webview:not(.native-status-bar-tone)');
  const dark = rule('html.dark.in-native-webview:not(.native-status-bar-tone)');
  const band = (color) => new RegExp(
    `linear-gradient\\(${color} var\\(--platform-safe-top\\), transparent var\\(--platform-safe-top\\)\\)`);
  assert.match(light, band(ground.light), 'the light ground, exactly the head\'s');
  assert.match(dark, band(ground.dark), 'the dark ground, exactly the head\'s');

  // The class the CSS stands down on is the one the publisher writes.
  const { NativeChrome } = boot();
  assert.equal(NativeChrome._STATUS_TONE_CLASS, 'native-status-bar-tone');

  // The inset itself is untouched (tests/platform-safe-bottom.test.js).
  assert.match(css,
    /#staging-overlay:not\(\.staging-overlay-docked\):not\(\.staging-overlay-under-chrome\) \.staging-chrome-bar\s*\{\s*padding-top:\s*calc\(0\.5rem \+ var\(--platform-safe-top\)\);\s*\}/);
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
