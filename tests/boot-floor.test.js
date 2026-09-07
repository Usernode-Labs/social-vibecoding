// The boot has a floor: it cannot end in a blank screen, and it cannot fail
// silently.
//
// Two guarantees, and each one failed in production before it existed:
//
//   1. NOTHING ABOVE hydrateRoot IS FATAL. A throw in main.tsx aborted the
//      entry module before hydration, so React never adopted the document and
//      every island stayed the empty markup the prerender shipped. That is
//      how the iOS blank screen worked (#1670): one TypeError inside a
//      precache nicety took the whole application down.
//   2. A DEAD BOOT LEAVES A RECORD. Diagnosing (1) took four rounds of
//      inference because the failure was unobservable on the device that had
//      it. The head records every error from the first script on, and
//      `window.__unBoot.snapshot()` describes the document for a console.
//      It PAINTS NOTHING: the panel an earlier version put over a page it
//      took for blank accused pages that were fine, and is gone.
//
// (A third layer, a one-shot budget on _reconcileSession's automatic reloads,
// shipped between these two and was reverted: it guarded a loop that needs
// storage to accept a write and then refuse a delete, left a query parameter
// on the address bar, and got in the way of finishLogin's return_to check.)
//
// Both layers are driven for real; layer 2 through
// tests/lib/boot-record-harness.js.
//
// Run with: node --test tests/boot-floor.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const MAIN = read('frontend/src/main.tsx');
const HEAD = read('frontend/src/head.html');

// ── 1. Nothing above hydrateRoot is fatal ──────────────────────────────

test('bootStep swallows a throw, records it, and lets the boot continue', () => {
  const prevWindow = globalThis.window;
  globalThis.window = {};
  try {
    const { bootStep, bootErrors } = loadTsx('frontend/src/lib/boot-guard.ts');
    const ran = [];

    assert.equal(bootStep('fine', () => { ran.push('fine'); }), true,
      'a step that returns reports success');

    assert.doesNotThrow(() => bootStep('boom', () => { throw new TypeError('nope'); }),
      'a throwing step must not reach the caller');
    assert.equal(bootStep('boom2', () => { throw new TypeError('nope again'); }), false,
      'and reports failure, for a caller with a fallback');

    // The step AFTER a failure still runs: that is the whole point.
    assert.equal(bootStep('after', () => { ran.push('after'); }), true);
    assert.deepEqual(ran, ['fine', 'after']);

    const recorded = bootErrors();
    assert.equal(recorded.length, 2, 'both failures recorded');
    assert.equal(recorded[0].step, 'boom');
    assert.match(recorded[0].message, /nope/);
    assert.ok(recorded[0].stack, 'with a stack, which is what a reader needs');
  } finally {
    globalThis.window = prevWindow;
  }
});

test('bootStep writes into the same record the head watchdog reads', () => {
  // One list, whether the failure came from a classic script, this bundle or
  // a rejected promise. The watchdog prints it; a second store would mean the
  // panel silently omitted half the failures.
  const prevWindow = globalThis.window;
  globalThis.window = {};
  try {
    const { bootStep } = loadTsx('frontend/src/lib/boot-guard.ts');
    bootStep('x', () => { throw new Error('recorded here'); });
    assert.ok(Array.isArray(globalThis.window.__unBoot?.errors));
    assert.match(globalThis.window.__unBoot.errors[0].message, /recorded here/);
  } finally {
    globalThis.window = prevWindow;
  }
});

test('every pre-hydration step in main.tsx is wrapped, hydration included', () => {
  for (const step of ['registerServiceWorker', 'initOffline', 'applyShellSnapshot']) {
    assert.match(MAIN, new RegExp(`bootStep\\('${step}',`),
      `${step}() must not be able to abort the entry module`);
  }
  assert.match(MAIN, /bootStep\('hydrate', \(\) => \{\s*flushSync\(/,
    'hydration is wrapped too, so its failure reaches the boot record');
  // The bare calls are gone — a stray one is the hole reopening.
  assert.doesNotMatch(MAIN, /^registerServiceWorker\(\);/m);
  assert.doesNotMatch(MAIN, /^initOffline\(\);/m);
  assert.doesNotMatch(MAIN, /^applyShellSnapshot\(\);/m);
});

test('boot-guard records rather than console.error-ing', () => {
  // A console.error on any route fails the platform's proposal checks, so a
  // guard that logged would turn every degraded boot into a merge blocker —
  // and continuing is the entire point.
  // Strip comments first: the header EXPLAINS why it does not call
  // console.error, and a naive scan would trip over its own reasoning.
  const guard = read('frontend/src/lib/boot-guard.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(guard, /console\.error\s*\(/);
  assert.match(guard, /console\.warn\s*\(/, 'warn still says it happened');
});

// ── 2. A dead boot leaves a record ──────────────────────────────────────

test('the boot record is inline, classic, and captures from the start', () => {
  // It reports on the bundle, the framework and the stylesheet, so it cannot
  // depend on any of them.
  const at = HEAD.indexOf('The boot record');
  assert.ok(at > 0, 'the record is in the head');
  const block = HEAD.slice(at, HEAD.indexOf('</script>', at));
  assert.match(block, /addEventListener\('error'/);
  assert.match(block, /addEventListener\('error', function \(e\) \{[\s\S]*?\}, true\);/,
    'a capture-phase listener: a resource that failed to load does not bubble');
  assert.match(block, /addEventListener\('unhandledrejection'/);
  assert.match(block, /window\.__unBoot/, 'shares one record with boot-guard.ts');
  assert.doesNotMatch(block, /import |require\(/, 'no dependencies of any kind');
  // It must run BEFORE the bundle it records. Asserted against the BUILT
  // document, because build-shell.mjs is what appends the module tag — the
  // head source has no bundle reference to be ahead of.
  const doc = read('public/index.html');
  const recordAt = doc.indexOf('__unBoot');
  const bundleAt = doc.indexOf('/shell/assets/shell.js');
  assert.ok(recordAt > 0 && bundleAt > 0, 'both are in the generated document');
  assert.ok(recordAt < bundleAt, 'the record is installed ahead of the bundle');
});

test('the boot record PAINTS NOTHING, by construction', () => {
  // An earlier version judged the page by its pixels and painted a "did not
  // finish loading" panel over anything it took for blank. On real devices
  // it accused pages that were fine. The record is passive now, and the
  // source says so: nothing in it creates an element, schedules anything,
  // or writes markup.
  const at = HEAD.indexOf('The boot record');
  // Comments stripped first: the header EXPLAINS what the old panel did, and
  // a naive scan would trip over its own reasoning.
  const block = HEAD.slice(at, HEAD.indexOf('</script>', at))
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(block, /createElement|appendChild|innerHTML|textContent =/);
  assert.doesNotMatch(block, /setTimeout|setInterval|requestAnimationFrame/);
  assert.doesNotMatch(block, /boot-watchdog|did not finish loading/);
  assert.doesNotMatch(block, /console\.error/);
});

// ── 2b. The record, driven for real ────────────────────────────────────
//
// The script is evaluated against a fake document and a hand-advanced clock
// (tests/lib/boot-record-harness.js) and judged on what it DOES.

const { bootRecord } = require('./lib/boot-record-harness');

test('bootStep records completion as well as failure, in the same record', () => {
  const prevWindow = globalThis.window;
  globalThis.window = {};
  try {
    const { bootStep, bootSteps, bootErrors } = loadTsx('frontend/src/lib/boot-guard.ts');
    bootStep('registerServiceWorker', () => {});
    bootStep('initOffline', () => { throw new Error('no storage'); });
    bootStep('hydrate', () => {});
    assert.deepEqual(bootSteps().map((s) => s.step), ['registerServiceWorker', 'hydrate']);
    assert.ok(bootSteps().every((s) => typeof s.at === 'number' && s.at >= 0),
      'each completion is stamped with when');
    assert.deepEqual(bootErrors().map((e) => e.step), ['initOffline']);
    // One record, the one the head's snapshot() prints.
    assert.equal(globalThis.window.__unBoot.steps, bootSteps());
    assert.equal(globalThis.window.__unBoot.errors, bootErrors());
  } finally {
    globalThis.window = prevWindow;
  }
});

test('nothing is painted and nothing is scheduled, on any route, however blank', () => {
  for (const search of ['', '?shot=boot-failed', '?shot=home']) {
    const h = bootRecord({ topAt: null, location: { search } });
    assert.equal(h.clock.pending(), 0, `nothing armed on "${search}"`);
    h.clock.advance(120_000);
    assert.equal(h.painted(), 0, `nothing in the document on "${search}"`);
    assert.equal(h.doc.getElementById('boot-watchdog'), null);
  }
});

test('a script that failed to LOAD is recorded once, with the query cut off', () => {
  // A resource error fires on the element and does not bubble; the bubble
  // listener never hears it. That is the one failure that leaves the record
  // empty while nothing ran.
  const h = bootRecord({ topAt: null });
  const script = h.make('script', { src: 'http://x/b/abc123/shell/assets/shell.js?v=9#frag' });
  h.win.dispatch('error', { target: script }, { bubbles: false });
  assert.deepEqual(h.record().errors, [{
    step: 'resource',
    message: 'script failed to load: http://x/b/abc123/shell/assets/shell.js',
    stack: '',
  }]);
  assert.equal(h.painted(), 0);
});

test('a thrown error and a rejected promise are recorded once each', () => {
  const h = bootRecord({ topAt: null });
  h.win.dispatch('error', { target: h.win, message: 'Home is not defined', error: { stack: 'ReferenceError: Home is not defined\n  at app.js:1' } });
  h.win.dispatch('unhandledrejection', { reason: new Error('chunk failed') });
  assert.deepEqual(h.record().errors.map((e) => [e.step, e.message]),
    [['error', 'Home is not defined'], ['unhandledrejection', 'chunk failed']]);
  assert.match(h.record().errors[0].stack, /ReferenceError/);
  assert.equal(h.painted(), 0);
});

test('snapshot() describes the document, and never its secrets', () => {
  const h = bootRecord({
    topAt: null,
    location: { pathname: '/', search: '?token=abc123&return_to=/cli/authorize', hash: '#more/deadbeef0123' },
    globals: {
      App: { user: { id: 1, hasPlatformAccess: false }, _sessionFromSnapshot: true, _authedBooted: true },
      AuthScreens: { _current: 'landing' },
      UsernodeReact: { mount: { ensure() {} } },
      __unBoot: { errors: [{ step: 'resource', message: 'script failed to load: /x.js', stack: '' }], steps: [{ step: 'hydrate', at: 1200 }] },
      __usernodeMounted: { mounted: { 'auth-landing-screen': true } },
      __usernodeVisibility: { visible: { 'home-screen': true, 'auth-login-screen': false } },
    },
  });
  const landing = h.make('main', { id: 'auth-landing-screen', rect: { width: 390, height: 780 }, bg: 'rgb(255, 255, 255)' });
  h.setTop(landing);
  h.doc.querySelectorAll = () => [
    landing,
    h.make('main', { id: 'home-screen', innerText: 'Welcome to the feed' }),
    h.make('main', { id: 'settings-screen', classes: ['hidden'], innerText: 'Settings' }),
  ];
  h.doc.body.__reactContainer$test = {};
  h.clock.advance(4200);

  const state = h.snapshot();
  assert.match(state, /^at: 4200ms$/m);
  assert.match(state, /^document: complete, visible, online, 390x780$/m);
  assert.match(state, /^route: \/\?token,return_to#more\/\.\.\.$/m,
    'query KEYS and the first fragment segment; never a value, never a token');
  assert.doesNotMatch(state, /abc123|deadbeef/);
  assert.match(state, /^on top: main#auth-landing-screen( main#auth-landing-screen){5}$/m);
  assert.match(state, /^screens shown: auth-landing-screen\(text=0\) home-screen\(text=19\)$/m);
  assert.match(state, /^globals: present App,AuthScreens,UsernodeReact,UsernodeReact\.mount; missing Home,Offline,NativeChrome$/m);
  assert.match(state, /^react: adopted the document$/m);
  assert.match(state, /^boot steps: hydrate@1200ms$/m);
  assert.match(state, /^errors: \[resource\] script failed to load: \/x\.js$/m);
  assert.match(state, /^session: user held \(no platform access\), fromSnapshot=true, authedBooted=true, authScreen=landing$/m);
  assert.match(state, /^interiors asked for: auth-landing-screen$/m);
  assert.match(state, /^visibility published: home-screen$/m);
  assert.match(state, /^storage: throws$/m, 'no localStorage on this window, and it says so');
  assert.match(state, /^worker: not controlling this page$/m);
  // Reading the state paints nothing either.
  assert.equal(h.painted(), 0);
});

test('snapshot() survives a document it cannot read', () => {
  const h = bootRecord({ topAt: null });
  h.doc.querySelectorAll = () => { throw new Error('no DOM for you'); };
  h.doc.elementFromPoint = () => { throw new Error('nor that'); };
  const state = h.snapshot();
  assert.match(state, /^on top: \?$/m);
  assert.match(state, /^screens shown: \?$/m);
  assert.match(state, /^errors: none recorded$/m, 'a failed read is not an error of the boot');
});

test('no declared check depends on the panel any more', () => {
  const dapp = JSON.parse(read('dapp.json'));
  assert.equal(dapp.tests.find((x) => /boot-failed|boot-watchdog/.test(JSON.stringify(x))), undefined);
});
