// #1085 chunk H, step 1 — THE REHEARSAL for the app viewer's iframe.
//
// `#staging-overlay` is a React island now (frontend/src/features/staging/), and
// it holds `#staging-iframe`. Every state change the overlay has — open, close,
// the #771 docked ↔ fullscreen toggle, the #816 loader copy, the #127 testing
// panel, a "Test this change" retarget — must leave that iframe ELEMENT alone.
// Re-creating it (a changed `key`, a conditional wrapper, a `src` prop React
// decides to re-apply) reloads the previewed app and throws away whatever the
// user was doing inside it. #771 states the requirement outright: "Same element,
// same iframe: toggling never reloads the preview."
//
// This file proves it two ways, and both matter:
//
//   1. BEHAVIOURALLY. The real public/js/app-view.js is loaded into a vm and
//      driven through the whole preview lifecycle, wired to the REAL React
//      bridge over the REAL store (frontend/src/features/staging/*.js — plain
//      JS, no React import, exactly so this test can import them). After every
//      step we assert the element identity is unchanged, that its stubbed
//      `contentWindow` is the same object, and that the navigation counter only
//      moved when a genuine `src` assignment was asked for.
//   2. STRUCTURALLY. React's contribution to identity is in the JSX, which this
//      suite cannot render (there is no frontend/node_modules in CI). So the
//      island is asserted at source level for the three properties that make
//      the element stable: rendered unconditionally, no `key`, and no `src`
//      prop — plus the absence of any DOM write from the legacy module into the
//      React-owned subtree.
//
// Run with: node --test tests/staging-iframe-identity.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const SRC = read('public/js/app-view.js');

const OVERLAY = read('frontend/src/features/staging/staging-overlay.tsx');
const STORE = read('frontend/src/features/staging/staging-store.js');
const BRIDGE = read('frontend/src/features/staging/staging-bridge.js');
const MOUNT = read('frontend/src/features/staging/mount.ts');
const COMPARE = read('frontend/src/features/staging/visual-compare-overlay.tsx');
const MAIN = read('frontend/src/main.tsx');
const SHELL = read('frontend/src/Shell.tsx');

// ── the fake iframe ──────────────────────────────────────────────────────
//
// Stands in for what React renders. `contentWindow` is a fresh object on every
// navigation and `loads` counts them, which is how a reload would be caught even
// if the element object itself were somehow reused.
function makeIframe() {
  const el = {
    id: 'staging-iframe',
    tagName: 'IFRAME',
    loads: 0,
    _src: '',
    contentWindow: { name: 'win-0' },
    onload: null,
    onerror: null,
    style: {},
    classList: {
      _set: new Set(['absolute', 'inset-0', 'w-full', 'h-full', 'border-0']),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    setAttribute() {},
    removeAttribute() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 800, height: 600 }),
  };
  Object.defineProperty(el, 'src', {
    get() { return el._src; },
    set(v) {
      el._src = v;
      // A real browser only navigates (and so only replaces contentWindow) for
      // a non-empty src; `src = ''` drops the document in place.
      if (v) {
        el.loads += 1;
        el.contentWindow = { name: `win-${el.loads}` };
      }
    },
  });
  return el;
}

// ── the harness ──────────────────────────────────────────────────────────
//
// app-view.js is a classic script (`const AppView = {…}`), so it goes into a vm
// with a DOM stub for the nodes it still reads — which, after chunk H, is
// everything OUTSIDE the overlay. Nothing inside #staging-overlay is stubbed on
// purpose: if the module tried to reach in with getElementById, the DOM adapter
// would silently take over and the assertions below would be testing nothing.
// `stagingElementIds` is asserted empty by the last test in this file.
async function makeHarness() {
  // The real store + the real bridge. `import()` works because
  // frontend/package.json is `type: module` and neither file imports React.
  const storeMod = await import(
    new URL('../frontend/src/features/staging/staging-store.js', `file://${__filename}`).href
  );
  const bridgeMod = await import(
    new URL('../frontend/src/features/staging/staging-bridge.js', `file://${__filename}`).href
  );

  // Reset the module-scope stores between cases (they are singletons, like the
  // island they feed).
  storeMod.stagingStore.set({
    open: false, mode: 'fullscreen', dockRect: null, urlLabel: '',
    loaderVisible: false, loaderTitle: 'Opening preview…', loaderSub: '',
    testBtnHidden: true, testBtnTitle: '', testPanelHidden: true, testHtml: '',
    fsBtnHidden: true, fsBtnText: 'Full screen', fsBtnTitle: '',
  });
  for (const key of Object.keys(storeMod.stagingHandlers)) storeMod.stagingHandlers[key] = null;

  const iframe = makeIframe();
  storeMod.stagingRefs.iframe = iframe;

  // Elements OUTSIDE the overlay that app-view.js legitimately still reads.
  const outside = {};
  const mkPlain = (id) => {
    const el = {
      id, _text: '', _html: '', onclick: null, style: {},
      classList: {
        _set: new Set(),
        add(c) { this._set.add(c); },
        remove(c) { this._set.delete(c); },
        contains(c) { return this._set.has(c); },
        toggle(c, v) { if (v) this._set.add(c); else this._set.delete(c); },
      },
      set textContent(v) { this._text = v; }, get textContent() { return this._text; },
      set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
      getBoundingClientRect: () => ({ top: 100, left: 200, width: 480, height: 360 }),
      setAttribute() {}, removeAttribute() {},
      addEventListener() {}, removeEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      appendChild() {}, remove() {},
    };
    outside[id] = el;
    return el;
  };
  ['dc-staging-panel', 'dev-console-btn'].forEach(mkPlain);

  // Every id the module asks for that we did NOT stub, so the test can prove no
  // request for an overlay-owned node was made.
  const asked = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, debug() {} },
    relTime: () => 'now',
    App: { user: { id: 1 }, currentTab: 'dev' },
    Kudos: { renderButton: () => '' },
    DevChat: { currentSession: null },
    document: {
      getElementById(id) {
        if (outside[id]) return outside[id];
        asked.push(id);
        return null;
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {},
      createElement: () => mkPlain(`tmp-${asked.length}`),
      body: { appendChild() {} },
      documentElement: { classList: { contains: () => true } },
    },
    fetch: async () => ({ ok: true, json: async () => ({ status: 'ready' }) }),
    alert: () => {},
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
    clearTimeout,
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); if (t.unref) t.unref(); return t; },
    clearInterval,
    AbortController,
    URL,
    ResizeObserver: class { observe() {} disconnect() {} },
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    resolveDevHost: (u) => u,
    location: { origin: 'https://platform.example', hostname: 'platform.example' },
    addEventListener() {}, removeEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: (fn) => { const t = setTimeout(fn, 0); if (t.unref) t.unref(); return t; },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // THE WIRING UNDER TEST: the React bridge, exactly as main.tsx publishes it.
  sandbox.UsernodeReact = {
    staging: bridgeMod.stagingBridge,
    visualCompare: bridgeMod.visualCompareBridge,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'usernode-2d5619', self_hosted: false };
  AppView.iframeToken = 'tok-1';
  AppView.iframeTokenSlug = 'usernode-2d5619';

  return { AppView, iframe, store: storeMod.stagingStore, handlers: storeMod.stagingHandlers, bridge: bridgeMod.stagingBridge, outside, asked, sandbox };
}

// ── 1. behavioural: the element survives the whole lifecycle ─────────────

test('the preview iframe is the SAME element across every overlay state change', async () => {
  const h = await makeHarness();
  const { AppView, iframe, bridge } = h;

  // Open a verified preview: the fast path assigns src once.
  AppView.swapToStaging('https://preview.example', null, { verified: true });
  assert.equal(bridge.frame(), iframe, 'the bridge still hands out the same element');
  assert.equal(iframe.loads, 1, 'one navigation for the open');
  assert.equal(bridge.stats().navigations, 1, 'and the bridge counted exactly one');
  const win = iframe.contentWindow;
  assert.match(iframe.src, /^https:\/\/preview\.example\/\?token=tok-1$/,
    'src composed through the URL API, token attached as a query param');

  // The steps that must NOT reload: every one of them is a store write that the
  // island renders around the iframe.
  const steps = [
    ['loader copy', () => AppView._setStagingLoader(true, { title: 'Loading the preview…', sub: '' })],
    ['loader hidden', () => AppView._setStagingLoader(false)],
    ['dock', () => AppView._setStagingMode('docked')],
    ['dock geometry', () => AppView._syncStagingDockGeometry()],
    ['un-dock', () => AppView._setStagingMode('fullscreen')],
    ['re-dock', () => AppView._setStagingMode('docked')],
    ['fullscreen-button state', () => AppView._updateStagingModeUi()],
    ['testing panel open', () => bridge.setTestPanelHidden(false)],
    ['testing content', () => bridge.setTestHtml('<p>steps</p>')],
    ['testing panel close', () => bridge.setTestPanelHidden(true)],
    ['url label', () => bridge.setUrlLabel('https://preview.example')],
  ];
  for (const [what, run] of steps) {
    run();
    assert.equal(bridge.frame(), iframe, `${what}: same element object`);
    assert.equal(iframe.contentWindow, win, `${what}: same contentWindow — no reload`);
    assert.equal(iframe.loads, 1, `${what}: load count unchanged`);
    assert.equal(bridge.stats().navigations, 1, `${what}: no navigation`);
  }

  // A close-then-reopen is still the same element: `src = ''` drops the
  // document, it does not discard the node.
  AppView.closeStagingOverlay();
  assert.equal(bridge.frame(), iframe, 'close keeps the element');
  assert.equal(iframe.src, '', 'close clears the src');
  assert.equal(iframe.loads, 1, 'clearing src is not a navigation');
  assert.equal(bridge.isOpen(), false, 'and the overlay is closed');

  AppView.swapToStaging('https://preview.example', null, { verified: true });
  assert.equal(bridge.frame(), iframe, 'reopen reuses the very same iframe');
  assert.equal(iframe.loads, 2, 'the reopen is the second real navigation');
});

test('a "Test this change" retarget navigates once, and only when the src differs', async () => {
  const h = await makeHarness();
  const { AppView, iframe, bridge } = h;

  // #127/#237: opening with testing notes + jump lands straight on the deep
  // link and auto-shows the panel.
  AppView.swapToStaging('https://preview.example', { md: 'do the thing', path: '/deep' }, { verified: true, jump: true });
  assert.equal(iframe.loads, 1, 'one navigation to the deep link');
  assert.match(iframe.src, /\/deep\?token=tok-1$/, 'jumped to the testing path');
  assert.equal(bridge.isTestPanelHidden(), false, 'the panel auto-opened for the jump path');
  const afterJump = iframe.contentWindow;

  // Re-rendering the controls while already pointing there must be a no-op:
  // re-assigning the same src would reload the app the user is testing.
  AppView._renderTestingControls((p) => `https://preview.example${p || '/'}?token=tok-1`, { src: iframe.src }, false);
  assert.equal(iframe.loads, 1, 'no re-navigation when already on the target');
  assert.equal(iframe.contentWindow, afterJump, 'same document');
  assert.equal(bridge.frame(), iframe, 'same element');
});

test('the visual-compare overlay opens over the preview without disturbing it', async () => {
  const h = await makeHarness();
  const { AppView, iframe, bridge } = h;
  AppView.swapToStaging('https://preview.example', null, { verified: true });
  const win = iframe.contentWindow;

  // openVisualComparison needs a tile; the ids are 32-hex-validated there.
  const tile = {
    dataset: {
      cmpBefore: 'a'.repeat(32), cmpAfter: 'b'.repeat(32),
      cmpPath: '/', cmpMobile: '',
    },
  };
  AppView.openVisualComparison(tile);
  assert.ok(AppView._visualCompare().openedAt() > 0, 'the compare overlay opened');
  assert.equal(iframe.loads, 1, 'the preview did not reload behind the comparison');
  assert.equal(iframe.contentWindow, win, 'same document');
  assert.equal(bridge.frame(), iframe, 'same element');

  AppView.closeVisualComparison();
  assert.equal(iframe.loads, 1, 'nor on close');
  assert.equal(bridge.frame(), iframe, 'still the same element');
});

test('a token refresh re-points the SAME element, and only for its own app', async () => {
  const h = await makeHarness();
  const { AppView, iframe, bridge } = h;
  AppView.swapToStaging('https://preview.example', null, { verified: true });
  const first = iframe.src;
  assert.equal(iframe.loads, 1);

  // A refreshed token is a genuine navigation — the URL changes — but it is an
  // imperative write through the ref, so the element is untouched.
  AppView.iframeToken = 'tok-2';
  const next = bridge.setSrc(first.replace('tok-1', 'tok-2'));
  assert.equal(next, true, 'the bridge performed the write');
  assert.equal(bridge.frame(), iframe, 'the element is the same object');
  assert.equal(iframe.loads, 2, 'exactly one further navigation');
  assert.match(iframe.src, /token=tok-2$/, 'now carrying the refreshed token');

  // The audience guard: a token minted for another app is not attached.
  AppView.iframeTokenSlug = 'someone-elses-app';
  assert.equal(AppView.tokenForSlug('usernode-2d5619'), null,
    'a token minted for another app is never reused');
});

test('the bridge never hands out a frame it does not own', async () => {
  const storeMod = await import(
    new URL('../frontend/src/features/staging/staging-store.js', `file://${__filename}`).href
  );
  const bridgeMod = await import(
    new URL('../frontend/src/features/staging/staging-bridge.js', `file://${__filename}`).href
  );
  storeMod.stagingRefs.iframe = null;
  assert.equal(bridgeMod.stagingBridge.frame(), null, 'no element before the island mounts');
  assert.equal(bridgeMod.stagingBridge.setSrc('https://x.example'), false,
    'a src write with no registered element is refused, not queued onto the document');
  bridgeMod.stagingBridge.clearSrc(); // must not throw
});

// ── 2. structural: what makes React keep the element ─────────────────────

test('the island renders the iframe unconditionally, unkeyed, with no src prop', () => {
  // From the returned JSX only — the header comment talks about `<iframe>` too.
  const body = OVERLAY.slice(OVERLAY.indexOf('return ('));
  const open = body.indexOf('<iframe');
  assert.ok(open !== -1, 'the island renders the iframe');
  const tag = body.slice(open, body.indexOf('>', open) + 1);
  assert.ok(!/\bkey=/.test(tag), 'no key — nothing can change the element identity');
  assert.ok(!/\bsrc=/.test(tag), 'no src prop — a re-applied src prop is a reload');
  assert.match(tag, /ref=\{iframeRef\}/, 'src is assigned imperatively through this ref');
  // Exactly one <iframe> in the island, so there is no second element a branch
  // could swap in.
  assert.equal(body.split('<iframe').length - 1, 1, 'exactly one iframe element');
  // Not conditional, and not inside a conditional wrapper: a `&&`/`?:` that
  // rendered elements would be a branch whose shape can change, and a changed
  // sibling shape moves the iframe's position in the child list.
  assert.ok(!/\{[^{}]*&&\s*\(?\s*</.test(body), 'no conditionally-rendered subtree in the island');
  assert.ok(!/\{[^{}]*\?\s*\(?\s*</.test(body), 'no ternary-rendered subtree in the island');
});

test('runtime class toggles go through refs, so every className stays constant', () => {
  // A rendered className that changed would be an attribute React rewrites —
  // and app.css / the native kit write classes onto these same nodes.
  for (const [hook, target] of [
    ['useHiddenClass(overlayRef, !state.open)', 'the overlay'],
    ["useClassToggle(overlayRef, 'staging-overlay-docked', state.mode === 'docked')", 'the #771 docked class'],
    ['useHiddenClass(loaderRef, !state.loaderVisible)', 'the loader'],
    ['useHiddenClass(panelRef, state.testPanelHidden)', 'the testing panel'],
    ['useHiddenClass(testBtnRef, state.testBtnHidden)', 'the test button'],
    ['useHiddenClass(fsBtnRef, state.fsBtnHidden)', 'the fullscreen button'],
  ]) {
    assert.ok(OVERLAY.includes(hook), `${target} toggles its class through a ref`);
  }
  // No interpolated className anywhere in the island.
  assert.ok(!/className=\{/.test(OVERLAY), 'every className is a constant string literal');
  assert.ok(!/className=\{/.test(COMPARE), 'same for the compare overlay');
  // And the ids the shipped markup carried are all still there.
  for (const id of [
    'staging-overlay', 'staging-iframe', 'staging-back', 'staging-loader',
    'staging-loader-title', 'staging-loader-sub', 'staging-url-label',
    'staging-test-btn', 'staging-testing-panel', 'staging-testing-content',
    'staging-testing-close', 'staging-fullscreen-btn', 'staging-dock-close',
    'staging-dev-console-btn', 'staging-dev-console-badge',
  ]) {
    assert.ok(OVERLAY.includes(`id="${id}"`), `#${id} is still rendered`);
  }
  for (const id of ['visual-compare-overlay', 'visual-compare-back', 'visual-compare-label', 'visual-compare-body']) {
    assert.ok(COMPARE.includes(`id="${id}"`), `#${id} is still rendered`);
  }
});

test('`src` is not state, and the store starts from the shipped markup', () => {
  assert.ok(!/\bsrc\b\s*:/.test(STORE.replace(/\/\*[\s\S]*?\*\//g, '')),
    'the store has no src field');
  // The initial values ARE the prerendered document; anything else is a
  // hydration mismatch, which console.errors and fails proposal checks.
  assert.match(STORE, /open: false,/, 'the overlay ships hidden');
  assert.match(STORE, /loaderVisible: false,/, 'the loader ships hidden');
  assert.match(STORE, /loaderTitle: 'Opening preview…',/, '#816 neutral default title');
  assert.match(STORE, /loaderSub: '',/, 'no sub-line');
  assert.match(STORE, /testPanelHidden: true,/, 'the testing panel ships hidden');
  assert.match(STORE, /fsBtnText: 'Full screen',/, "#771's shipped label");
  // The bridge's writes are all store writes, except the two src ones.
  const srcWrites = BRIDGE.match(/el\.src = /g) || [];
  assert.equal(srcWrites.length, 2, 'exactly two src assignments: setSrc and clearSrc');
  assert.match(BRIDGE, /stagingRefs\.iframe/, 'both go through the registered ref');
});

test('the seam is published before hydration and drives the store synchronously', () => {
  assert.match(MAIN, /import '\.\/features\/staging\/mount';/, 'main.tsx imports the seam');
  assert.ok(
    MAIN.indexOf("import './features/staging/mount';") < MAIN.indexOf('hydrateRoot('),
    'published before hydration — app-view.js may call on DOMContentLoaded'
  );
  assert.match(MOUNT, /if \(typeof window !== 'undefined'\) \{/, 'guarded for the SSG pass');
  assert.match(MOUNT, /bridge\.staging = stagingBridge;/, 'published as UsernodeReact.staging');
  assert.match(MOUNT, /bridge\.visualCompare = visualCompareBridge;/, 'and .visualCompare');
  // flushSync, because the caller reads the DOM on its next line.
  assert.match(MOUNT, /stagingStore\.setFlush\(flushSync\);/, 'staging writes flush synchronously');
  assert.match(MOUNT, /visualCompareStore\.setFlush\(flushSync\);/, 'so do compare writes');
  // The islands are in the prerendered tree.
  assert.match(SHELL, /<StagingOverlay \/>/, '<Shell/> renders the staging island');
  assert.match(SHELL, /<VisualCompareOverlay \/>/, 'and the compare island');
});

test('the legacy module makes no DOM write into the React-owned overlay', async () => {
  // Every write goes through _staging() / _visualCompare(). What is left is the
  // reads two bridge-message handlers make to compare `event.source` against
  // the frame's contentWindow — reads, on a node they do not mutate.
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // The two fallback DOM adapters sit next to each other; everything before and
  // after them is the module proper.
  const from = code.indexOf('_stagingDom: {');
  const to = code.indexOf('_visualCompareDismissGuarded() {');
  assert.ok(from !== -1 && to > from, 'the fallback adapters are where the split expects them');
  const adapters = code.slice(from, to);
  const outside = code.slice(0, from) + code.slice(to);

  const overlayIds = [
    'staging-overlay', 'staging-back', 'staging-loader', 'staging-loader-title',
    'staging-loader-sub', 'staging-url-label', 'staging-test-btn',
    'staging-testing-panel', 'staging-testing-content', 'staging-testing-close',
    'staging-fullscreen-btn', 'staging-dock-close',
    'visual-compare-overlay', 'visual-compare-back', 'visual-compare-label',
    'visual-compare-body',
  ];
  for (const id of overlayIds) {
    assert.ok(!outside.includes(`getElementById('${id}')`),
      `no getElementById('${id}') outside the fallback DOM adapter`);
  }
  // The adapter is allowed to — it is the one that runs when the island is not
  // there at all (the vm tests, and a browser whose bundle failed to load).
  assert.ok(adapters.includes("getElementById(id)"), 'the DOM adapter resolves ids itself');

  // #staging-iframe keeps exactly the contentWindow reads, and no write.
  const frameLookups = outside.match(/getElementById\('staging-iframe'\)/g) || [];
  assert.ok(frameLookups.length > 0, 'the bridge-message handlers still resolve the frame');
  for (const m of outside.matchAll(/getElementById\('staging-iframe'\)([\s\S]{0,120})/g)) {
    assert.ok(
      /contentWindow/.test(m[1]),
      `every #staging-iframe lookup outside the adapter is a contentWindow read, got: ${m[1].slice(0, 60)}`
    );
  }

  // And the drive above never asked the document for an overlay-owned node.
  const h = await makeHarness();
  h.AppView.swapToStaging('https://preview.example', null, { verified: true });
  h.AppView._setStagingMode('docked');
  h.AppView._updateStagingModeUi();
  h.AppView.closeStagingOverlay();
  const leaked = h.asked.filter((id) => overlayIds.includes(id) || id === 'staging-iframe');
  assert.deepEqual(leaked, [], 'the module asked the document for no overlay-owned node');
});
