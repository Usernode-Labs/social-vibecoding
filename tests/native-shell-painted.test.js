// The launch cover's signal: `shellPainted` (the polish board's #1, 19 Oct
// 2026).
//
// A cold launch of the app walked through six screens in about 3.3 s. The
// app now keeps one cover over the web view and fades it out when this
// document says its first screen is drawn. That saying is
// public/js/native-chrome.js `_initShellPainted`, and this file pins it:
//
//   1. the two pure decisions: is the first screen drawn
//      (`firstScreenDrawn`), and is it time to send (`shellPaintedDue`:
//      drawn with a non-zero top inset, or 1.5 s after DOMContentLoaded);
//   2. the sender: capability-gated, top document only, once per document,
//      after the next paint, never a console.error;
//   3. the bridge wrapper (public/usernode-bridge.js): unprivileged, `{}`;
//   4. the contract in NATIVE-BRIDGE.md, which the app's build implements.
//
// The app's half (the cover and its fade) lives in the Flutter repository;
// this side cannot be run end to end without that build.
//
// Run with: node --test tests/native-shell-painted.test.js

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
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An element with the given on-screen box (or none, for display:none). */
function box(rect, extra = {}) {
  return {
    getClientRects: () => (rect ? [{ width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, ...rect }] : []),
    getAttribute: (name) => (name === 'src' ? (extra.src ?? '/x.svg') : null),
    complete: extra.complete ?? true,
  };
}

/** A document for `firstScreenDrawn`: what is pulsing and which images are in. */
function fakeDoc({ readyState = 'complete', holds = [], pulses = [], images = [] } = {}) {
  const classes = new Set(holds);
  return {
    readyState,
    documentElement: { classList: { contains: (c) => classes.has(c) } },
    querySelectorAll(selector) {
      if (selector === 'main .animate-pulse') return pulses;
      if (selector === 'main img') return images;
      throw new Error(`unexpected selector ${selector}`);
    },
  };
}
const WIN = { innerWidth: 390, innerHeight: 844 };

/**
 * Boot native-chrome.js inside the app (or not), with a page the test
 * controls: whether the first screen is drawn, the top inset, when
 * DOMContentLoaded fired, and what the bridge answers.
 */
function boot(opts = {}) {
  const calls = { painted: 0, bridgeInfo: 0, warnings: [], errors: [], selectors: 0 };
  const page = {
    readyState: opts.readyState || 'complete',
    drawn: opts.drawn ?? true,
    inset: opts.inset ?? 47,
    dclAt: opts.dclAt ?? 1,
  };
  const t0 = Date.now();
  const listeners = {};
  const htmlChildren = [];
  const html = {
    classList: { contains: () => false, add() {}, remove() {} },
    getAttribute: () => null,
    appendChild(child) { htmlChildren.push(child); child.parentNode = html; return child; },
    removeChild(child) { htmlChildren.splice(htmlChildren.indexOf(child), 1); child.parentNode = null; return child; },
  };
  const capabilities = opts.capabilities || ['shellPainted'];
  const usernode = opts.native === false ? { isNative: false } : {
    isNative: true,
    async getBridgeInfo() {
      calls.bridgeInfo += 1;
      if (opts.getBridgeInfoImpl) return opts.getBridgeInfoImpl(calls.bridgeInfo);
      return { version: 5, capabilities };
    },
  };
  if (opts.native !== false && !opts.noMethod) {
    usernode.shellPainted = async () => {
      calls.painted += 1;
      calls.paintedAt = Date.now() - t0;
      if (opts.shellPaintedImpl) return opts.shellPaintedImpl();
      return true;
    };
  }
  const document = {
    get readyState() { return page.readyState; },
    documentElement: html,
    visibilityState: 'visible',
    getElementById() { return null; },
    createElement() { return { setAttribute() {}, style: {} }; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    querySelectorAll(selector) {
      calls.selectors += 1;
      if (selector === 'main .animate-pulse') return page.drawn ? [] : [box({})];
      return [];
    },
  };
  const sandbox = {
    console: {
      log() {},
      warn(...args) { calls.warnings.push(args); },
      error(...args) { calls.errors.push(args); },
    },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    App: { user: null },
    usernode,
    MutationObserver: class { observe() {} disconnect() {} },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    getComputedStyle: () => ({ paddingTop: `${page.inset}px`, backgroundColor: 'rgb(244, 242, 228)' }),
    performance: {
      now: () => Date.now() - t0,
      getEntriesByType: () => [{ domContentLoadedEventStart: page.dclAt }],
    },
    requestAnimationFrame: opts.noFrames ? () => 0 : (fn) => setTimeout(fn, 1),
    innerWidth: 390,
    innerHeight: 844,
    document,
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
  const NativeChrome = sandbox.NativeChrome;
  // The real numbers are 1500 ms and 50 ms; the decisions are the same at a
  // test's pace. Set before the first tick, which waits on the probe.
  NativeChrome._SHELL_PAINTED_CAP_MS = opts.capMs ?? 400;
  NativeChrome._SHELL_PAINTED_POLL_MS = 5;
  return {
    sandbox, calls, page, htmlChildren, NativeChrome,
    fireDomContentLoaded() {
      page.readyState = 'interactive';
      for (const fn of listeners.DOMContentLoaded || []) fn();
    },
  };
}

// ── 1. The pure decisions ──────────────────────────────────────────────

test('firstScreenDrawn: parsed, no boot hold, no skeleton or unfinished image on screen', () => {
  const drawn = (doc) => boot({ native: false }).NativeChrome.firstScreenDrawn(doc, WIN);
  assert.equal(drawn(fakeDoc()), true, 'a parsed page with nothing pending');
  assert.equal(drawn(fakeDoc({ readyState: 'loading' })), false, 'still parsing: the router has not run');
  assert.equal(drawn(fakeDoc({ holds: ['first-session-boot'] })), false, 'the head holds the body hidden');
  assert.equal(drawn(fakeDoc({ holds: ['language-pending'] })), false, 'waiting on the language');
  assert.equal(drawn(fakeDoc({ pulses: [box({})] })), false, 'a skeleton is on screen');
  assert.equal(drawn(fakeDoc({ pulses: [box(null)] })), true, 'a skeleton in a hidden screen is not');
  assert.equal(drawn(fakeDoc({ pulses: [box({ top: 900, bottom: 1000 })] })), true,
    'a skeleton below the fold is not what the cover lifts on');
  assert.equal(drawn(fakeDoc({ images: [box({}, { complete: false })] })), false,
    'the challenge art on screen has not finished');
  assert.equal(drawn(fakeDoc({ images: [box({}, { complete: true })] })), true, 'it has (loaded or failed)');
  assert.equal(drawn(fakeDoc({ images: [box({}, { complete: false, src: '' })] })), true,
    'an image with no source will never finish');
  assert.equal(drawn(null), false);
});

test('shellPaintedDue: drawn with a top inset, or the cap; never the inset alone', () => {
  const { NativeChrome } = boot({ native: false });
  const due = (s) => NativeChrome.shellPaintedDue(s);
  NativeChrome._SHELL_PAINTED_CAP_MS = 1500;
  assert.equal(due({ elapsed: 200, drawn: true, insetTop: 47 }), 'drawn');
  assert.equal(due({ elapsed: 200, drawn: true, insetTop: 0 }), null,
    'laid out before the inset is known: the header is under the clock');
  assert.equal(due({ elapsed: 200, drawn: false, insetTop: 47 }), null, 'still skeletons');
  assert.equal(due({ elapsed: 1500, drawn: false, insetTop: 0 }), 'cap', '1.5 s after DOMContentLoaded, whatever is up');
  assert.equal(due({ elapsed: null, drawn: false, insetTop: 47 }), null, 'no cap before DOMContentLoaded');
  assert.equal(due(undefined), null);
  assert.match(nativeChromeSource, /_SHELL_PAINTED_CAP_MS: 1500,/, 'the shipped cap is 1.5 s');
});

// ── 2. The sender ──────────────────────────────────────────────────────

test('drawn, with a top inset: sent once, after the next paint', async () => {
  const h = boot();
  await wait(60);
  assert.equal(h.calls.painted, 1);
  assert.equal(h.NativeChrome._shellPaintedReason, 'drawn');
  assert.deepEqual(h.htmlChildren, [], 'the inset probe is taken off <html> once sent');
  await wait(60);
  await h.NativeChrome._initShellPainted();
  assert.equal(h.calls.painted, 1, 'once per document');
  assert.deepEqual(h.calls.errors, []);
});

test('the send waits for two animation frames, and a timer stands in when there are none', async () => {
  const h = boot({ noFrames: true });
  await wait(40);
  assert.equal(h.calls.painted, 0, 'no frame yet: not sent');
  await wait(160);
  assert.equal(h.calls.painted, 1, 'the 120 ms timer under the frames sent it');
});

test('drawn before the inset is known: it waits for the inset', async () => {
  const h = boot({ inset: 0, capMs: 5000 });
  await wait(80);
  assert.equal(h.calls.painted, 0, 'the header would be under the clock');
  h.page.inset = 47;
  await wait(60);
  assert.equal(h.calls.painted, 1);
  assert.equal(h.NativeChrome._shellPaintedReason, 'drawn');
});

test('still skeletons at the cap: sent anyway, and only counted from DOMContentLoaded', async () => {
  const h = boot({ drawn: false, readyState: 'loading', dclAt: 0, capMs: 60 });
  await wait(120);
  assert.equal(h.calls.painted, 0, 'not parsed yet: no cap is running');
  h.page.dclAt = h.sandbox.performance.now();
  h.fireDomContentLoaded();
  await wait(30);
  assert.equal(h.calls.painted, 0, 'inside the cap');
  await wait(80);
  assert.equal(h.calls.painted, 1, 'the cap sent it');
  assert.equal(h.NativeChrome._shellPaintedReason, 'cap');
});

test('a skeleton that goes: sent when the screen is drawn, not at the cap', async () => {
  const h = boot({ drawn: false, capMs: 5000 });
  await wait(60);
  assert.equal(h.calls.painted, 0);
  h.page.drawn = true;
  await wait(60);
  assert.equal(h.calls.painted, 1);
  assert.equal(h.NativeChrome._shellPaintedReason, 'drawn');
});

test('nothing is sent, probed or polled where nothing waits for it', async () => {
  for (const [why, opts] of [
    ['a browser', { native: false }],
    ['a framed copy of the shell', { framed: true }],
    ['a bridge without the wrapper', { noMethod: true }],
  ]) {
    const h = boot(opts);
    await wait(40);
    assert.equal(h.calls.painted, 0, why);
    assert.equal(h.calls.bridgeInfo, 0, `${why}: not even a probe`);
    assert.equal(h.calls.selectors, 0, `${why}: no polling`);
  }
  const old = boot({ capabilities: ['setStatusBarTone'] });
  await wait(40);
  assert.equal(old.calls.painted, 0, 'a build without the capability is never called');
  assert.equal(old.calls.selectors, 0, 'and the page is not polled for it');
});

test('a degraded probe is asked once more, then left to the app\'s own cap', async () => {
  const degraded = { version: 0, capabilities: [], degraded: true };
  const twice = boot({ getBridgeInfoImpl: () => degraded });
  await wait(380);
  assert.equal(twice.calls.bridgeInfo, 2, 'one more ask, never a latch');
  assert.equal(twice.calls.painted, 0);

  const once = boot({ getBridgeInfoImpl: (n) => (n === 1 ? degraded : { version: 5, capabilities: ['shellPainted'] }) });
  await wait(380);
  assert.equal(once.calls.painted, 1, 'the second answer stands');
});

test('a failed call is a console.warn, never a console.error, and is not retried', async () => {
  const h = boot({ shellPaintedImpl: async () => { throw new Error('shellPainted is not supported by this app build'); } });
  await wait(80);
  assert.equal(h.calls.painted, 1);
  assert.deepEqual(h.calls.errors, []);
  assert.equal(h.calls.warnings.length, 1);
  assert.match(String(h.calls.warnings[0][0]), /shellPainted failed/);
});

test('init starts it, beside the other presentation publishes', () => {
  const init = /\binit\(\) \{([\s\S]*?)\n {4}\},/.exec(nativeChromeSource)[1];
  assert.match(init, /NativeChrome\._initShellPainted\(\);/);
  assert.ok(init.indexOf('_initShellPainted') < init.indexOf("addEventListener('sv:session'"),
    'not behind session establishment: the launch is often the one before sign-in');
});

// ── 3. The bridge wrapper ──────────────────────────────────────────────

function loadBridge({ dropped = [] } = {}) {
  const posts = [];
  const errors = [];
  const sandbox = {
    console: { log() {}, warn() {}, error(...args) { errors.push(args); } },
    Date, Math, Promise, URL, URLSearchParams,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    setTimeout(fn, delay) { return setTimeout(fn, delay * 0.001); },
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
      if (dropped.includes(request.method)) return;
      sandbox.__usernodeResolve(request.id, true, null);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(read('public', 'usernode-bridge.js'), sandbox);
  return { sandbox, posts, errors };
}

test('the wrapper posts `shellPainted` with {} and no capability or session claim', async () => {
  const loaded = loadBridge();
  assert.equal(await loaded.sandbox.usernode.shellPainted(), true);
  const posts = loaded.posts.filter((p) => p.method === 'shellPainted');
  assert.equal(posts.length, 1);
  assert.deepEqual(plain(posts[0].args), {});
  assert.equal('privilegedCapability' in posts[0], false, 'unprivileged, like setStatusBarTone');
  assert.equal('realmSessionClaim' in posts[0], false, 'and not session-bound');
  assert.equal(loaded.posts.some((p) => p.method === 'getPrivilegedBridgeCapability'), false);
  const privileged = /_PRIVILEGED_NATIVE_METHODS\s*=\s*\{([\s\S]*?)\n\s*\};/
    .exec(read('public', 'usernode-bridge.js'));
  assert.doesNotMatch(privileged[1], /\bshellPainted\b/);
});

test('on a build that drops it, the call rejects after its timeout and logs no console.error', async () => {
  const loaded = loadBridge({ dropped: ['shellPainted'] });
  await assert.rejects(loaded.sandbox.usernode.shellPainted(), /shellPainted is not supported by this app build/);
  assert.deepEqual(loaded.errors, []);
});

test('both copies of the hosted bridge carry it', () => {
  assert.equal(read('public', 'usernode-bridge.js'), read('public', 'usernode-bridge', 'v1', 'bridge.js'));
});

// ── 4. The contract ────────────────────────────────────────────────────

test('NATIVE-BRIDGE.md carries the contract the app implements', () => {
  const doc = read('NATIVE-BRIDGE.md');
  assert.match(doc, /- `shellPainted`: /, 'listed with the additive capabilities');
  const at = doc.indexOf('### First paint (additive; `shellPainted`)');
  assert.ok(at !== -1, 'its own section');
  const section = doc.slice(at, doc.indexOf('\n### ', at + 1));
  // Compared with the line wrapping folded, as a reader reads it.
  const prose = section.replace(/\s+/g, ' ');
  for (const [needle, why] of [
    ['`shellPainted({})`', 'the method and its empty arguments'],
    ['at most once per document', 'once'],
    ['`env(safe-area-inset-top)`', 'the inset rule'],
    ['two `requestAnimationFrame`s', 'after the next paint'],
    ['1.5 s', 'the web cap'],
    ['150 ms', 'the fade'],
    ['3 s', 'the app\'s own cap'],
    ['`getBridgeInfo().capabilities`', 'feature-detected'],
  ]) assert.ok(prose.includes(needle), `${why}: ${needle}`);
});
