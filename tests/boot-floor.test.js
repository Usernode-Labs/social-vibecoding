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

test('the watchdog only accuses when nothing at all is on screen', () => {
  // A false positive would put "did not finish loading" over a working app,
  // which is worse than the blank screen it exists for.
  const at = HEAD.indexOf('function bootProducedSomething');
  assert.ok(at > 0);
  const fn = HEAD.slice(at, HEAD.indexOf('\n      }', at));
  assert.match(fn, /getBoundingClientRect/, 'a hidden or zero-size root does not count');
  assert.match(fn, /innerText/, 'nor does an empty one — #1670 revealed an EMPTY overlay');
  assert.match(fn, /catch \(e\) \{ return true; \}/,
    'a watchdog that cannot tell must not accuse');
  assert.match(HEAD, /var DEADLINE_MS = 8000;/,
    'well past the slowest boot this repo has measured (~2.4s)');
});

test('the probe route is a declared check, so the panel cannot rot', () => {
  const dapp = JSON.parse(read('dapp.json'));
  const t = dapp.tests.find((x) => x.path === '/?shot=boot-failed');
  assert.ok(t, 'the panel has a route a check can reach');
  assert.match(t.expectSelector, /#boot-watchdog/);
  assert.equal(t.expectText, 'This screen did not finish loading');
});
