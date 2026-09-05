// The cold paint catches up: what the top bar remembers across a reload.
//
// ── The bug ────────────────────────────────────────────────────────────
//
// public/sw.js races every navigation against the cached /index.html on a
// 200ms deadline its own header calls deliberately shorter than a round trip,
// so a refresh almost always paints the PRERENDER. The prerender is
// state-free — frontend/src/prerender.tsx renders <Shell/> in Node, so every
// island draws from its store's INITIAL and nothing on disk knows which app or
// route the viewer was on. Two visible consequences on every reload:
//
//   * the chip read "dApps" (headerTitleStore's INITIAL), and
//   * the Improve button was missing (improveStore.target starts null, and the
//     button ships `hidden` until something publishes one).
//
// Neither corrected until App.init() had run on DOMContentLoaded AND
// /api/auth/me had answered AND the route had resolved.
//
// ── Why this is asserted on source ─────────────────────────────────────
//
// `npm test` runs with no frontend/node_modules (the root install never
// touches that workspace), so there is no React here to render with and no DOM
// to render into — the same reason tests/dialog-behaviour.test.js and
// tests/header-status-pane.test.js read the shipped files. The pure storage
// half IS executed below, in a vm over a localStorage stub, because it is
// plain functions over JSON and the interesting cases (a corrupt entry, an
// expired one, two writers patching different fields) are exactly the ones a
// grep cannot see.
//
// Run with: node --test tests/shell-snapshot.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const SNAPSHOT = read('frontend/src/lib/shell-snapshot.ts');
const APPLY = read('frontend/src/lib/shell-snapshot-apply.ts');
const MAIN = read('frontend/src/main.tsx');
const HEADER_MOUNT = read('frontend/src/features/header/mount.ts');
const IMPROVE = read('frontend/src/features/improve/improve-controller.js');
const APP_JS = read('public/js/app.js');

// ── the storage half, executed ──────────────────────────────────────────

// Strip the TypeScript that the storage module uses (interface + annotations)
// so the plain functions can run in a vm. Deliberately crude and deliberately
// asserted: if this stops producing runnable JS the tests below fail loudly
// rather than silently testing nothing.
function loadStorage(store) {
  const js = SNAPSHOT
    .replace(/export interface [\s\S]*?\n\}\n/g, '')
    .replace(/: Partial<Omit<ShellSnapshot, 'savedAt'>>/g, '')
    .replace(/: ShellSnapshot \| null/g, '')
    .replace(/: ShellSnapshot/g, '')
    .replace(/: boolean/g, '')
    .replace(/: string/g, '')
    .replace(/: void/g, '')
    .replace(/^export /gm, '');
  const ctx = {
    Date,
    JSON,
    window: {
      localStorage: {
        getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; },
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${js}\n;globalThis.__api = { readShellSnapshot, saveShellSnapshot, clearShellSnapshot };`, ctx);
  assert.ok(ctx.__api && typeof ctx.__api.saveShellSnapshot === 'function',
    'the storage module still evaluates as plain functions');
  return ctx.__api;
}

test('the two writers patch different fields without clobbering each other', () => {
  // The header bridge knows the title and nothing about the Improve target;
  // the Improve controller knows the reverse. Whole-record writes from either
  // would erase the other's field on every navigation, which would have made
  // the button flicker back off on each route change.
  const store = {};
  const api = loadStorage(store);

  api.saveShellSnapshot({ title: 'Notes', subtitle: 'Board' });
  api.saveShellSnapshot({ improveTarget: 'app' });

  const snap = api.readShellSnapshot();
  assert.equal(snap.title, 'Notes', 'the title survived the target write');
  assert.equal(snap.subtitle, 'Board');
  assert.equal(snap.improveTarget, 'app');
});

test('a cleared target is remembered as cleared, not as absent', () => {
  // Leaving an app publishes target: null. If that wrote nothing, the next
  // cold paint would restore the button on a screen that has none.
  const store = {};
  const api = loadStorage(store);
  api.saveShellSnapshot({ improveTarget: 'app' });
  api.saveShellSnapshot({ improveTarget: '' });
  assert.equal(api.readShellSnapshot().improveTarget, '');
});

test('a corrupt or foreign entry reads as nothing rather than throwing', () => {
  for (const raw of ['not json', 'null', '[]', '"a string"', '{}']) {
    const store = { 'usernode.shell.v1': raw };
    const api = loadStorage(store);
    assert.equal(api.readShellSnapshot(), null, `${raw} is ignored`);
  }
});

test('a stale entry is ignored, so a months-old app name cannot resurface', () => {
  const store = {};
  const api = loadStorage(store);
  api.saveShellSnapshot({ title: 'Notes' });
  const held = JSON.parse(store['usernode.shell.v1']);
  held.savedAt = Date.now() - (8 * 24 * 60 * 60 * 1000);
  store['usernode.shell.v1'] = JSON.stringify(held);
  assert.equal(api.readShellSnapshot(), null, 'older than the max age');
});

test('clear removes it outright', () => {
  const store = {};
  const api = loadStorage(store);
  api.saveShellSnapshot({ title: 'Notes', improveTarget: 'app' });
  api.clearShellSnapshot();
  assert.equal(api.readShellSnapshot(), null);
  assert.equal(store['usernode.shell.v1'], undefined, 'the key itself is gone');
});

// ── the wiring ──────────────────────────────────────────────────────────

test('the snapshot is applied AFTER hydration, never before it', () => {
  // THE WHOLE CONSTRAINT. Before hydration — as a store INITIAL, or from an
  // inline <head> script — the first client render disagrees with the
  // prerendered markup, React reports a hydration mismatch, and a console
  // error on any route fails proposal checks. The prerender is allowed to be
  // wrong for exactly as long as it takes to hydrate.
  const hydrateAt = MAIN.indexOf('hydrateRoot(document.body');
  // Both calls are wrapped in bootStep() now (nothing above hydrateRoot may
  // be fatal — see tests/boot-floor.test.js); the ORDERING this test exists
  // for is untouched by that.
  const applyAt = MAIN.indexOf("bootStep('applyShellSnapshot'");
  assert.ok(hydrateAt > -1, 'the entry still hydrates the body');
  assert.ok(applyAt > -1, 'and applies the snapshot');
  assert.ok(applyAt > hydrateAt, 'the apply comes after the hydration');
  // …and outside the flushSync block, not inside it.
  const flushEnd = MAIN.indexOf('});', MAIN.indexOf('flushSync(() => {'));
  assert.ok(applyAt > flushEnd, 'and outside the synchronous hydration block');
  // Nothing may read storage at module scope in the store files themselves —
  // that would land the value in the INITIAL and reintroduce the mismatch.
  for (const [name, src] of [
    ['header-title-store.js', read('frontend/src/features/header/header-title-store.js')],
    ['improve-store.js', read('frontend/src/features/improve/improve-store.js')],
  ]) {
    assert.ok(!/localStorage/.test(src), `${name} does not seed its INITIAL from storage`);
  }
});

test('both halves of the visible bug are what gets written', () => {
  // The title, from the one place every title set funnels through.
  assert.match(HEADER_MOUNT, /saveShellSnapshot\(\{ title, subtitle: sub \}\)/,
    'App.setHeaderTitle -> the bridge -> the snapshot');
  // The Improve target, on both the set and the clear path.
  assert.match(IMPROVE, /saveShellSnapshot\(\{ improveTarget: '' \}\)/,
    'clearing the target is remembered');
  assert.match(IMPROVE, /saveShellSnapshot\(\{ improveTarget: target\.kind === 'platform' \? 'platform' : 'app' \}\)/,
    'and so is setting it');
});

test('only what is ON SCREEN is restored — not a data model', () => {
  // The remembered target decides whether #improve-btn is drawn, which is the
  // reported symptom. The panel's slug/name/icon/version are deliberately NOT
  // restored: they would furnish a panel describing an app this document has
  // not loaded, and none of it is visible until someone opens the panel, by
  // which time the real target has landed.
  assert.match(APPLY, /improveStore\.set\(\{ target: snap\.improveTarget \}\)/);
  for (const field of ['slug:', 'name:', 'iconUrl', 'repoUrl', 'version:']) {
    assert.ok(!APPLY.includes(field), `the panel's ${field} is not restored from storage`);
  }
  // An empty remembered title is not restored either: a blank chip is a
  // different wrong answer, not a better one.
  assert.match(APPLY, /if \(snap\.title\) \{/);
});

test('it goes with the rest of this device’s session residue on sign-out', () => {
  const fn = APP_JS.slice(
    APP_JS.indexOf('  _dropCachedSession() {'),
    APP_JS.indexOf('\n  },', APP_JS.indexOf('  _dropCachedSession() {')),
  );
  assert.ok(fn, '_dropCachedSession is still defined');
  assert.match(fn, /shellSnapshot\?\.clear\?\.\(\)/,
    'the next cold paint must not read back the previous account’s app name');
  // Published where the other header bridges are.
  assert.match(HEADER_MOUNT, /bridge\.shellSnapshot = \{ clear: clearShellSnapshot \}/);
});

test('the storage module stays free of the store graph', () => {
  // Two files, and the split is load-bearing: shell-snapshot.ts is imported by
  // WRITERS (the header bridge, the Improve controller) and must not drag the
  // stores in behind them; shell-snapshot-apply.ts is the only importer of
  // both, and only the browser entry imports it.
  assert.ok(!/features\//.test(SNAPSHOT), 'the storage module imports no feature');
  assert.match(APPLY, /from '\.\.\/features\/header\/header-title-store\.js'/);
  assert.match(APPLY, /from '\.\.\/features\/improve\/improve-store\.js'/);
});
