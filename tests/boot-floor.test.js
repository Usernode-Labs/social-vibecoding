// The boot has a floor: it cannot end in a blank screen, cannot loop, and
// cannot fail silently.
//
// Three independent guarantees, and each one failed in production before it
// existed:
//
//   1. NOTHING ABOVE hydrateRoot IS FATAL. A throw in main.tsx aborted the
//      entry module before hydration, so React never adopted the document and
//      every island stayed the empty markup the prerender shipped. That is
//      how the iOS blank screen worked (#1670): one TypeError inside a
//      precache nicety took the whole application down.
//   2. THE AUTOMATIC RELOAD HAS A CEILING. _reconcileSession's reloads were
//      safe only because they first cleared the session snapshot, and every
//      one of those clears is a localStorage call in a try/catch. Where
//      storage silently fails -- a WebView with a non-persistent store -- the
//      snapshot survived and the document reloaded forever.
//   3. A DEAD BOOT REPORTS ITSELF. Diagnosing (1) took four rounds of
//      inference because the failure was unobservable on the device that had
//      it. The head's watchdog paints what went wrong instead.
//
// Layers 2 and 3 live in a classic script and an inline <head> block, neither
// of which can be required in Node (app.js touches the DOM at module scope),
// so those are pinned against the shipped source. Layer 1 is driven for real.
//
// Run with: node --test tests/boot-floor.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const APP_JS = read('public/js/app.js');
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

// ── 2. The automatic reload has a ceiling ──────────────────────────────

test('the boot reconcile has no unbounded reload left in it', () => {
  const at = APP_JS.indexOf('  async _reconcileSession(');
  assert.ok(at > 0, '_reconcileSession is still where the boot reconciles');
  const fn = APP_JS.slice(at, APP_JS.indexOf('\n  },', at));
  assert.doesNotMatch(fn, /location\.reload\(\)/,
    'every automatic reload goes through the budget');
  const guarded = fn.match(/App\._bootReload\(/g) || [];
  assert.equal(guarded.length, 3, 'all three branches are budgeted');
  // Each one degrades in place rather than simply giving up.
  assert.match(fn, /if \(!App\._bootReload\('session ended'\)\) await App\.enterAnonymous\(\)/);
  assert.match(fn, /if \(!App\._bootReload\('different account'\)\) await App\.enterAnonymous\(\)/);
  assert.match(fn, /if \(!App\._bootReload\('platform access changed'\)\) await App\.enterAuthed\(user\)/);
});

test('the reload budget lives in the URL, not in storage', () => {
  // sessionStorage is the obvious place and the wrong one: if localStorage is
  // unavailable — the condition that makes the loop unbounded in the first
  // place — sessionStorage is unavailable too, so the counter would fail in
  // exactly the case it exists for.
  const at = APP_JS.indexOf('  _bootReload(reason) {');
  assert.ok(at > 0);
  const fn = APP_JS.slice(at, APP_JS.indexOf('\n  },', at));
  assert.doesNotMatch(fn, /sessionStorage|localStorage/);
  assert.match(APP_JS, /BOOT_RETRY_PARAM: 'un-boot-retry'/);
  assert.match(fn, /searchParams\.set\(App\.BOOT_RETRY_PARAM, '1'\)/);
  assert.match(fn, /location\.replace\(/, 'a retry is not a place to go back to');

  // Fails CLOSED: no marker writable means no reload, because an unmarkable
  // reload is precisely the unbounded one.
  const spent = APP_JS.slice(APP_JS.indexOf('  _bootRetrySpent() {'));
  assert.match(spent.slice(0, spent.indexOf('\n  },')), /catch[\s\S]*return true;/,
    'an unreadable URL counts the budget as spent');
});

test('a settled boot takes the marker back off the address bar', () => {
  assert.match(APP_JS, /App\._clearBootRetryMark\(\);/, 'called once the session verifies');
  const at = APP_JS.indexOf('  _clearBootRetryMark() {');
  const fn = APP_JS.slice(at, APP_JS.indexOf('\n  },', at));
  assert.match(fn, /searchParams\.delete\(App\.BOOT_RETRY_PARAM\)/);
  assert.match(fn, /history\.replaceState/, 'without adding a history entry');
});

// ── 3. A dead boot reports itself ──────────────────────────────────────

test('the head watchdog is inline, classic, and captures from the start', () => {
  // It reports on the bundle, the framework and the stylesheet, so it cannot
  // depend on any of them.
  const at = HEAD.indexOf('The boot watchdog');
  assert.ok(at > 0, 'the watchdog is in the head');
  const block = HEAD.slice(at, HEAD.indexOf('</script>', at));
  assert.match(block, /addEventListener\('error'/);
  assert.match(block, /addEventListener\('unhandledrejection'/);
  assert.match(block, /window\.__unBoot/, 'shares one record with boot-guard.ts');
  assert.doesNotMatch(block, /import |require\(/, 'no dependencies of any kind');
  // Thrown values are never markup.
  assert.doesNotMatch(block, /innerHTML/);
  assert.match(block, /textContent/);
  // It must run BEFORE the bundle it watches. Asserted against the BUILT
  // document, because build-shell.mjs is what appends the module tag — the
  // head source has no bundle reference to be ahead of.
  const doc = read('public/index.html');
  const watchdogAt = doc.indexOf('__unBoot');
  const bundleAt = doc.indexOf('/shell/assets/shell.js');
  assert.ok(watchdogAt > 0 && bundleAt > 0, 'both are in the generated document');
  assert.ok(watchdogAt < bundleAt, 'the watchdog is installed ahead of the bundle');
});

test('the watchdog opts out of capture and check routes, except its own probe', () => {
  // Those routes render one state deterministically; a panel arriving
  // mid-assertion is the nondeterminism they exist to be free of. Same guard,
  // same reason, as prefetchSettings() and AdminConsole.prefetchSections().
  const at = HEAD.indexOf('The boot watchdog');
  const block = HEAD.slice(at, HEAD.indexOf('</script>', at));
  assert.match(block, /q\.get\('shot'\) === 'boot-failed'/, 'the probe route forces it');
  assert.match(block, /optedOut = !forced && \(!!q\.get\('shot'\) \|\| !!q\.get\('demo'\)\)/);
  assert.match(block, /if \(optedOut\) return;/);
});

test('the watchdog asks the PIXELS, not the tree', () => {
  // The original predicate asked "does any unhidden screen root have text",
  // which is not "can the reader see anything". #auth-landing-screen is
  // `fixed inset-0 z-40` with no children, and a failed boot reveals it OVER
  // a #home-screen that is still unhidden and still carries its prerendered
  // text. The predicate found that text and stayed silent while the reader
  // looked at a white rectangle — silence in the one case it exists for.
  const at = HEAD.indexOf('function bootProducedSomething');
  assert.ok(at > 0);
  const fn = HEAD.slice(at, HEAD.indexOf('\n      }', at));
  assert.match(fn, /document\.elementFromPoint\(/,
    'what is ON TOP at a coordinate, not what exists in the tree');
  assert.doesNotMatch(fn, /innerText/,
    'innerText on a root counts content something opaque is covering');
  assert.match(fn, /catch \(e\) \{ return true; \}/,
    'a watchdog that cannot tell must not accuse');
  assert.match(HEAD, /var DEADLINE_MS = 8000;/,
    'well past the slowest boot this repo has measured (~2.4s)');
});

test('a background image is NOT taken as content', () => {
  // It reads like a reasonable "an icon drawn as a background counts" signal
  // and it is exactly wrong here: the platform's wallpaper IS a background
  // image, painted on the very screen roots this samples. Measured — with
  // that branch in, all six sample points landed on #auth-landing-screen
  // with no text and a `url(data:image/png…)` wallpaper, so every empty
  // overlay came back as content and the panel never painted.
  const at = HEAD.indexOf('function hasVisibleContent');
  assert.ok(at > 0, 'the per-element judgement is its own function');
  const fn = HEAD.slice(at, HEAD.indexOf('\n      }', at));
  assert.doesNotMatch(fn, /backgroundImage/,
    'a ground is not content — the wallpaper would mask every blank screen');
  assert.match(fn, /nodeType === 3/, 'its OWN text, not a descendant\'s');
  assert.match(fn, /'img'|'svg'|'canvas'|'video'/, 'real media still counts');
});

test('the watchdog arms at script time, not on a boot milestone', () => {
  // It used to start its timer inside a DOMContentLoaded listener, so a boot
  // that died before that event never armed it. A synchronous hang in any of
  // the ~47 classic scripts is enough, and then the panel can never paint.
  const at = HEAD.indexOf('ARMED HERE, NOT ON DOMContentLoaded');
  assert.ok(at > 0, 'the arming is deliberate and explained');
  const tail = HEAD.slice(at, HEAD.indexOf('}());', at));
  assert.match(tail, /setTimeout\(judge, DEADLINE_MS\);/,
    'armed unconditionally, not from an event');
  // …but a document that is merely still arriving is not accused: one grace
  // window while the parser is demonstrably still working, then judge anyway.
  assert.match(tail, /document\.readyState === 'loading' && !extended/);
  assert.match(tail, /setTimeout\(judge, GRACE_MS\)/);
  assert.match(HEAD, /var GRACE_MS = \d+;/);
});

test('the probe route is a declared check, so the panel cannot rot', () => {
  const dapp = JSON.parse(read('dapp.json'));
  const t = dapp.tests.find((x) => x.path === '/?shot=boot-failed');
  assert.ok(t, 'the panel has a route a check can reach');
  assert.match(t.expectSelector, /#boot-watchdog/);
  assert.equal(t.expectText, 'This screen did not finish loading');
});

// ── 3b. The watchdog, driven for real ──────────────────────────────────
//
// Everything above pins the head's SOURCE. Both flaws found on a real device
// (#1675) sat in lines the pins already covered, so from here the script is
// evaluated against a fake document and a hand-advanced clock
// (tests/lib/boot-watchdog-harness.js) and judged on what it DOES.

const { bootWatchdog } = require('./lib/boot-watchdog-harness');

const VIEWPORT = { width: 390, height: 780 };
const emptyOverlay = (make) => make('main', { id: 'auth-landing-screen', rect: VIEWPORT, bg: 'rgb(255, 255, 255)' });

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
    // One record, the one the head prints.
    assert.equal(globalThis.window.__unBoot.steps, bootSteps());
    assert.equal(globalThis.window.__unBoot.errors, bootErrors());
  } finally {
    globalThis.window = prevWindow;
  }
});

test('a blank document paints the panel, and the panel says what it saw', () => {
  const h = bootWatchdog({
    topAt: null,
    globals: {
      App: { user: { id: 1, hasPlatformAccess: false }, _sessionFromSnapshot: true, _authedBooted: true },
      AuthScreens: { _current: 'landing' },
      UsernodeReact: { mount: { ensure() {} } },
      __unBoot: { errors: [], steps: [{ step: 'hydrate', at: 1200 }] },
      __usernodeMounted: { mounted: { 'auth-landing-screen': true } },
      __usernodeVisibility: { visible: { 'home-screen': true, 'auth-login-screen': false } },
    },
  });
  const landing = emptyOverlay(h.make);
  h.setTop(landing);
  h.doc.querySelectorAll = () => [
    landing,
    h.make('main', { id: 'home-screen', innerText: 'Welcome to the feed' }),
    h.make('main', { id: 'settings-screen', classes: ['hidden'], innerText: 'Settings' }),
  ];
  h.doc.body.__reactContainer$test = {};

  h.clock.advance(7999);
  assert.equal(h.panel(), null, 'not before the deadline');
  h.clock.advance(1);
  assert.ok(h.panel(), 'the panel painted at the deadline');
  assert.equal(h.panel()['attr:role'], 'alert');

  const state = h.state();
  assert.ok(state, 'the state block is on the panel');
  assert.match(state, /^judged: deadline at 8000ms$/m);
  assert.match(state, /^document: complete, visible, online, 390x780$/m);
  assert.match(state, /^on top: main#auth-landing-screen( main#auth-landing-screen){5}$/m,
    'what elementFromPoint returned at each sample point');
  assert.match(state, /^screens shown: auth-landing-screen\(text=0\) home-screen\(text=19\)$/m,
    'unhidden roots and how much text each holds');
  assert.match(state, /^globals: present App,AuthScreens,UsernodeReact,UsernodeReact\.mount; missing Home,Offline,NativeChrome$/m);
  assert.match(state, /^react: adopted the document$/m);
  assert.match(state, /^boot steps: hydrate@1200ms$/m);
  assert.match(state, /^session: user held \(no platform access\), fromSnapshot=true, authedBooted=true, authScreen=landing$/m);
  assert.match(state, /^interiors asked for: auth-landing-screen$/m);
  assert.match(state, /^visibility published: home-screen$/m);
  assert.match(state, /^storage: throws$/m, 'no localStorage on this window, and it says so');
  assert.match(state, /^worker: not controlling this page$/m);
  assert.match(state, /^retry mark: unspent$/m);
  // With nothing recorded the errors block says where to look instead.
  assert.match(h.errorsShown().textContent, /What the page looked like is below/);
  assert.equal(h.record().trigger, 'deadline');
});

test('a working document is never accused, however long it runs', () => {
  const h = bootWatchdog({ topAt: null });
  h.setTop(h.make('p', { text: 'Sign in' }));
  h.clock.advance(60_000);
  h.doc.dispatch('sv:session');
  h.doc.dispatch('sv:authed');
  h.win.dispatch('hashchange');
  h.doc.dispatch('visibilitychange');
  h.clock.advance(60_000);
  assert.equal(h.panel(), null);
});

test('a script that failed to LOAD is recorded, and named on the panel', () => {
  // A resource error fires on the element and does not bubble; the bubble
  // listener never hears it. That is the one failure that left the record
  // empty while the boot produced nothing.
  const h = bootWatchdog({ topAt: null });
  h.setTop(emptyOverlay(h.make));
  const script = h.make('script', { src: 'http://x/b/abc123/shell/assets/shell.js?v=9#frag' });
  h.win.dispatch('error', { target: script }, { bubbles: false });
  assert.deepEqual(h.record().errors, [{
    step: 'resource',
    message: 'script failed to load: http://x/b/abc123/shell/assets/shell.js',
    stack: '',
  }], 'recorded once, with the query and fragment cut off');
  h.clock.advance(8000);
  const rows = h.errorsShown().children.map((c) => c.textContent);
  assert.deepEqual(rows, ['1. [resource] script failed to load: http://x/b/abc123/shell/assets/shell.js']);
});

test('a thrown error is recorded once, not once per listener', () => {
  const h = bootWatchdog({ topAt: null });
  h.win.dispatch('error', { target: h.win, message: 'Home is not defined', error: { stack: 'ReferenceError: Home is not defined\n  at app.js:1' } });
  assert.deepEqual(h.record().errors.map((e) => [e.step, e.message]),
    [['error', 'Home is not defined']]);
});

test('an iframe on top is content', () => {
  // The landing directory's app viewer and #app-view are iframes; what the
  // reader sees is the framed document, which this script cannot read.
  const h = bootWatchdog({ topAt: null });
  h.setTop(h.make('iframe', { rect: { width: 390, height: 600 } }));
  h.clock.advance(8000);
  assert.equal(h.panel(), null);
});

test('text inside the element on top is content; the old ancestor failure is not reopened', () => {
  // A full-viewport root exposed at a padding point, with its text elsewhere:
  // content, because nothing is over it at that point.
  const h = bootWatchdog({ topAt: null });
  h.setTop(h.make('main', { id: 'home-screen', innerText: 'Latest builds', rect: VIEWPORT }));
  h.clock.advance(8000);
  assert.equal(h.panel(), null);
  // The empty overlay OVER that root is still blank: elementFromPoint hands
  // us the overlay, and the overlay has no text of its own or inside it.
  const h2 = bootWatchdog({ topAt: null });
  h2.setTop(emptyOverlay(h2.make));
  h2.clock.advance(8000);
  assert.ok(h2.panel());
});

test('a painted box smaller than the screen is content; a ground is not', () => {
  // A skeleton block: no text, a colour, well short of the viewport.
  const skeleton = bootWatchdog({ topAt: null });
  skeleton.setTop(skeleton.make('div', { rect: { width: 200, height: 100 }, bg: 'rgb(228, 228, 231)' }));
  skeleton.clock.advance(8000);
  assert.equal(skeleton.panel(), null, 'a skeleton is a screen on its way');

  // The same colour filling the viewport: that is a ground, and grounds are
  // what every blank screen is made of.
  const ground = bootWatchdog({ topAt: null });
  ground.setTop(ground.make('div', { rect: VIEWPORT, bg: 'rgb(228, 228, 231)' }));
  ground.clock.advance(8000);
  assert.ok(ground.panel(), 'a painted viewport is still blank');

  // A small transparent box: nothing to see.
  const clear = bootWatchdog({ topAt: null });
  clear.setTop(clear.make('div', { rect: { width: 200, height: 100 }, bg: 'rgba(0, 0, 0, 0)' }));
  clear.clock.advance(8000);
  assert.ok(clear.panel());
});

test('a blank that arrives AFTER login is judged, however long the login took', () => {
  // Login is in place (auth-screens.js finishLogin -> App.enterAuthed), so
  // the blank it produces arrives whenever the login does. Typed by hand it
  // lands long after the 8s deadline judged the login form and went quiet.
  const h = bootWatchdog({ topAt: null });
  h.setTop(h.make('p', { text: 'Password' }));
  h.clock.advance(30_000);
  assert.equal(h.panel(), null, 'the login form was content');

  // enterAuthed: sv:session, then sv:authed, and nothing shows.
  h.setTop(emptyOverlay(h.make));
  h.doc.dispatch('sv:session');
  h.clock.advance(1000);
  h.doc.dispatch('sv:authed');
  h.clock.advance(4999);
  assert.equal(h.panel(), null, 'one judgement per transition, REJUDGE_MS after the LAST signal');
  h.clock.advance(1);
  assert.ok(h.panel(), 'the post-login blank was judged');
  assert.match(h.state(), /^judged: sv:authed at 36000ms$/m);
});

test('re-judgement is bounded', () => {
  const h = bootWatchdog({ topAt: null });
  h.setTop(h.make('p', { text: 'feed' }));
  for (let i = 0; i < 3; i++) {
    h.win.dispatch('hashchange');
    h.clock.advance(5000);
  }
  assert.equal(h.panel(), null);
  // The fourth transition is not judged, even though it IS blank: a page
  // that keeps changing gets three looks, not a watcher for life.
  h.setTop(emptyOverlay(h.make));
  h.win.dispatch('hashchange');
  h.clock.advance(60_000);
  assert.equal(h.panel(), null);
});

test('a suspended document is not accused on resume', () => {
  // The deadline fires late by the whole absence (an app switch, a
  // password-manager sheet). What it would sample is a page that has not
  // laid out since. Re-arm once instead; judge on the fresh window.
  const h = bootWatchdog({ topAt: null });
  h.setTop(emptyOverlay(h.make));
  h.clock.suspend(30_000);
  h.clock.advance(8000);
  assert.equal(h.panel(), null, 'late by 30s: re-armed, not judged');
  h.clock.advance(4999);
  assert.equal(h.panel(), null);
  h.clock.advance(1);
  assert.ok(h.panel(), 'judged on the fresh window, and still blank');
  assert.match(h.state(), /^judged: deadline at 13000ms$/m);
});

test('a hidden document waits to be seen', () => {
  const h = bootWatchdog({ topAt: null, visibilityState: 'hidden' });
  h.setTop(emptyOverlay(h.make));
  h.clock.advance(8000);
  assert.equal(h.panel(), null, 'a hidden document may not have laid out');
  h.doc.visibilityState = 'visible';
  h.doc.dispatch('visibilitychange');
  h.clock.advance(5000);
  assert.ok(h.panel());
  assert.match(h.state(), /^judged: visible at 13000ms$/m);
});

test('a document still parsing gets one grace window, then is judged anyway', () => {
  const h = bootWatchdog({ topAt: null, readyState: 'loading' });
  h.setTop(emptyOverlay(h.make));
  h.clock.advance(8000);
  assert.equal(h.panel(), null, 'the parser is demonstrably still working');
  h.clock.advance(6000);
  assert.ok(h.panel(), 'and a document that never finishes parsing does not escape judgement');
});

test('the route is printed without its secrets', () => {
  const h = bootWatchdog({
    topAt: null,
    location: { pathname: '/', search: '?token=abc123&return_to=/cli/authorize', hash: '#more/deadbeef0123' },
  });
  h.setTop(emptyOverlay(h.make));
  h.clock.advance(8000);
  const state = h.state();
  assert.match(state, /^route: \/\?token,return_to#more\/\.\.\.$/m,
    'query KEYS and the first fragment segment; never a value, never a token');
  assert.doesNotMatch(state, /abc123|deadbeef/);
});

test('every ?shot= / ?demo= route but the probe is left alone, in practice', () => {
  const h = bootWatchdog({ topAt: null, location: { search: '?shot=home' } });
  h.setTop(emptyOverlay(h.make));
  assert.equal(h.clock.pending(), 0, 'nothing armed at all');
  h.clock.advance(60_000);
  assert.equal(h.panel(), null);
});

test('the probe route paints at once, with the state block', () => {
  const ready = bootWatchdog({ topAt: null, location: { search: '?shot=boot-failed' } });
  ready.setTop(ready.make('p', { text: 'a perfectly healthy page' }));
  ready.clock.advance(0);
  assert.ok(ready.panel(), 'forced, regardless of content');
  assert.deepEqual(ready.record().errors.map((e) => e.step), ['probe']);
  assert.match(ready.state(), /^judged: probe at 0ms$/m);

  // Still parsing: it waits for a body to paint into.
  const parsing = bootWatchdog({ topAt: null, readyState: 'loading', location: { search: '?shot=boot-failed' } });
  parsing.clock.advance(1000);
  assert.equal(parsing.panel(), null);
  parsing.doc.dispatch('DOMContentLoaded');
  parsing.clock.advance(0);
  assert.ok(parsing.panel());
});

test('a parser still stuck past the grace window is judged strictly', () => {
  // The lenient rules (text in a child, a painted box) recognise a LIVE
  // page's skeletons and cards. A document that has not finished parsing
  // 14s in has no live page: what is on screen is the static prerender, and
  // a header from that must not pass for a boot.
  const stuck = bootWatchdog({ topAt: null, readyState: 'loading' });
  stuck.setTop(stuck.make('main', { id: 'home-screen', innerText: 'Usernode', rect: VIEWPORT }));
  stuck.clock.advance(14_000);
  assert.ok(stuck.panel(), 'the prerendered header is not a boot');
  assert.match(stuck.state(), /^document: loading,/m);
  assert.match(stuck.state(), /^boot steps: none completed$/m);

  // The same screen on a document that DID finish parsing is a live page
  // with its text in a child: content.
  const live = bootWatchdog({ topAt: null, readyState: 'complete' });
  live.setTop(live.make('main', { id: 'home-screen', innerText: 'Usernode', rect: VIEWPORT }));
  live.clock.advance(14_000);
  assert.equal(live.panel(), null);

  // Own text is content in either mode: a stuck document whose sampled
  // point lands ON the text is still showing the reader something.
  const onText = bootWatchdog({ topAt: null, readyState: 'loading' });
  onText.setTop(onText.make('h1', { text: 'Usernode' }));
  onText.clock.advance(14_000);
  assert.equal(onText.panel(), null);
});
