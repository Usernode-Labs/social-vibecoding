'use strict';

// #platform-parked — the app you left, one tap above the tab bar (#2718), and
// at the foot of the desktop rail.
//
// The bar makes the platform's five places one tap each, and in doing so it
// makes the app you were IN the one thing that is not: no tab, no header strip
// once you leave, and Home's grid is every app rather than the one you were
// halfway through. This is the handle back.
//
// #2762 is why most of this file exists. The strip, its store and its CSS all
// shipped with #2718, and no app was ever parked: every way out of an app
// nulls `App.currentApp` before its transition starts and runs AppView.close()
// (which nulls AppView.appData) before the screen swap that parked, so the
// parking code always found nothing to park. Its tests only ever parked
// through the bridge by hand, which is why nobody saw. The tests below drive
// the REAL router in a vm, through every route out of an app.
//
// What is pinned, and each is a way it can be quietly useless:
//
//   1. THE ROOT SHIPS EMPTY. It is in the frozen shell inventory, so it has to
//      be in the prerendered document — with nothing inside it, because the
//      app comes from localStorage and a read during a first render is a
//      hydration mismatch.
//   2. THE WHOLE STRIP RESUMES, back INTO the app, from wherever you are.
//   3. LEAVING PARKS, BY EVERY ROUTE OUT — the close button, each tab, Back,
//      and the hop from the running app to its own Workshop — with the name
//      and icon the app was drawn with.
//   4. ENTERING THE APP CLEARS IT. Resuming the app you are in is a shortcut
//      to where you already are.
//   5. IT RIDES ON THE BAR: never over the running app, the signed-out shell,
//      the keyboard, or a folded desktop rail.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const HTML = read('public/index.html');
const APP_JS = read('public/js/app.js');
const CSS = read('public/css/app.css');
const STRIP = read('frontend/src/features/nav/parked-strip.tsx');

const ui = loadTsx('tests/fixtures/parked-strip-api.ts');
const render = (app) => {
  const before = ui.parkedStore.get().app;
  ui.parkedStore.set({ app });
  try {
    return renderToHtml(createElement(ui.ParkedStrip, {}));
  } finally {
    ui.parkedStore.set({ app: before });
  }
};

test('the root ships in the document, hidden and empty', () => {
  const at = HTML.indexOf('id="platform-parked"');
  assert.ok(at > 0, 'the strip is part of the shipped shell');
  const el = HTML.slice(HTML.lastIndexOf('<div', at), HTML.indexOf('</div>', at) + 6);
  assert.match(el, /class="platform-parked hidden"/,
    'hidden, with the class a CONSTANT — app.css reads it to reserve the band');
  assert.doesNotMatch(el, /platform-parked-resume|platform-parked-forget/,
    'and empty: the app comes from storage in an effect, never a first render');
});

test('the whole strip resumes, and the pill is a label inside it', () => {
  const html = render({ slug: 'notes-ab12', name: 'Notes', iconUrl: null, iconEmoji: null });
  assert.match(html, /id="platform-parked-resume"/);
  const anchor = html.slice(html.indexOf('<a '), html.indexOf('</a>') + 4);
  assert.match(anchor, /href="\/app\/notes-ab12"/,
    'a REAL path, so a modified click opens the app in a tab');
  assert.match(anchor, />Notes</, 'the app is named in full');
  assert.match(anchor, /platform-parked-pill">Resume</,
    'and Resume is inside the target, not beside it');
  assert.doesNotMatch(anchor, /<button/,
    'a button inside an anchor is invalid markup and browsers split it');
  assert.match(anchor, /app-icon-tile platform-parked-tile/, 'with the app’s own artwork');
  // BACK INTO THE APP, whichever screen the strip is on (#2762). From the
  // app's own Workshop the router still has the app open, and navigateToApp
  // would re-open it from scratch; openAppTab switches tabs for the open app
  // and navigates for any other — what the retired App segment did.
  assert.match(STRIP, /window\.App\?\.openAppTab\?\.\(app\.slug, 'app'\);/);
  assert.doesNotMatch(STRIP, /navigateToApp/);
});

test('the dismiss means forget, and says whose', () => {
  // A strip that comes back on the next screen swap is a strip you cannot get
  // rid of, and the handle's promise is that it is there until you are done.
  const html = render({ slug: 'notes-ab12', name: 'Notes', iconUrl: null, iconEmoji: null });
  assert.match(html, /id="platform-parked-forget"[^>]*aria-label="Forget Notes"/);
  const SRC = read('frontend/src/features/nav/parked-strip.tsx');
  assert.match(SRC, /onClick=\{\(\) => setParked\(null\)\}/,
    'it clears the store AND storage, which is what forgetting is');
});

test('a slug with no record still draws a strip', () => {
  // The display data is captured at parking time and may be missing — a cold
  // deep link into an app the launcher has never listed. A handle named after
  // the slug beats no handle.
  const html = render({ slug: 'notes-ab12', name: 'notes-ab12', iconUrl: null, iconEmoji: null });
  assert.match(html, />notes-ab12</);
  assert.match(html, /data-icon="letter"/, 'and falls back to the initial, like every tile');
});

// ── Leaving parks: the real router, run in a vm (#2762) ─────────────────

const WHITEBOARD = { slug: 'whiteboard-ab12cd', name: 'Whiteboard', icon_emoji: '🎨', icon_url: null };
const PLATFORM = { slug: 'usernode-2d5619', name: 'Homeroom', self_hosted: true, icon_url: null, icon_emoji: null };

// A DOM element that remembers its classes and attributes, which is all the
// router asks of one on these paths.
function fakeElement() {
  const classes = new Set();
  const attrs = new Map();
  return {
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      toggle: (n, force) => {
        const on = force === undefined ? !classes.has(n) : !!force;
        if (on) classes.add(n); else classes.delete(n);
        return on;
      },
      contains: (n) => classes.has(n),
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => attrs.delete(k),
    style: {},
    innerHTML: '',
    textContent: '',
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild() {},
    addEventListener() {},
  };
}

// public/js/app.js in a vm, with the nav bridge recording every park and
// AppView reduced to the two facts this bug turned on: close() nulls
// `appData` (as the real one does, BEFORE the screen swap that used to park),
// and launchRecordFor() answers from the launcher's cached rows. Everything
// else AppView and Home are asked for is a no-op. PlatformUI.transition runs
// the reveal and then `after`, synchronously, and counts the parks the reveal
// made so a test can tell which frame they landed in.
function router({ launcher = [WHITEBOARD, PLATFORM], record = null } = {}) {
  const parks = [];
  const inReveal = [];
  const noop = () => undefined;
  const elements = new Map();
  const context = vm.createContext({
    location: new URL('https://homeroom.test/'),
    history: { pushState() {}, replaceState() {}, state: null },
    URL, URLSearchParams, console, setTimeout, clearTimeout,
    document: {
      title: '',
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, fakeElement());
        return elements.get(id);
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      dispatchEvent() {},
    },
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    PlatformUI: {
      transition(fn, opts) {
        const before = parks.length;
        fn();
        inReveal.push(parks.slice(before));
        opts?.after?.();
      },
    },
  });
  context.window = context;
  vm.runInContext(APP_JS, context);
  context.UsernodeReact = {
    nav: { setScreen() {}, setViewer() {}, park: (app) => parks.push(app) },
    backButton: { set() {} },
  };
  const appView = {
    appData: null,
    close() { this.appData = null; },
    launchRecordFor: (slug) => launcher.find((r) => r.slug === slug) || null,
    // The detail fetch: resolves with `record` (the app's own), or never,
    // for a leave that beats it.
    open(slug) {
      if (record === 'pending') return new Promise(() => {});
      const rec = record || launcher.find((r) => r.slug === slug) || null;
      this.appData = rec ? { ...rec } : null;
      return Promise.resolve(!!rec);
    },
  };
  context.AppView = new Proxy(appView, { get: (t, k) => (k in t ? t[k] : noop) });
  context.Home = new Proxy({}, { get: () => noop });
  return { App: context.App, AppView: context.AppView, parks, inReveal };
}

const named = (park) => (park ? park.name : null);
const LEAVES = ['navigateHome', 'navigateToBrowse', 'navigateToMessages', 'navigateToWorkshop',
  'navigateToProfile', 'navigateToSettings', 'navigateToLeaderboard', 'navigateToGlobalChat',
  'navigateToAdminConsole'];

test('THE REGRESSION (#2762): every way out of a running app parks it', async () => {
  // Each of these nulls App.currentApp before its transition and runs
  // AppView.close() before the screen swap — so parking from "the app that is
  // current" found nothing, on every route, every time.
  for (const leave of LEAVES) {
    const { App, parks } = router({ record: { ...WHITEBOARD, name: 'Whiteboard (loaded)' } });
    await App.navigateToApp('whiteboard-ab12cd');
    assert.equal(App.currentTab, 'app', `${leave}: the app is running`);
    const before = parks.length;
    App[leave]();
    assert.equal(App.currentApp, null, `${leave}: the route let go of the app`);
    assert.deepEqual(parks.slice(before).map(named), ['Whiteboard (loaded)'],
      `${leave}: leaving parks the app, once, by the name it was drawn with`);
    assert.deepEqual({ ...parks.at(-1) }, {
      slug: 'whiteboard-ab12cd', name: 'Whiteboard (loaded)', iconUrl: null, iconEmoji: '🎨',
    }, `${leave}: with its artwork, so the strip draws at once`);
  }
});

test('entering the running app clears its own handle, in the frame it arrives', async () => {
  const { App, parks, inReveal } = router();
  await App.navigateToApp('whiteboard-ab12cd');
  // navigateToApp's reveal is the first transition: the bar leaves with the
  // app arriving, and the handle with it — not a transition later in `after`,
  // or the strip rides the zoom in and then vanishes.
  assert.deepEqual(inReveal[0], [null], 'cleared inside the reveal callback');
  assert.ok(parks.every((p) => p === null), 'and nothing parked while the app is up');
});

test('the hop from the running app to its own Workshop parks it; the way back clears it', async () => {
  // Since #2761 the mark's menu has no App segment: the parked app IS the way
  // back from the app's Workshop, its discussion or a change of it — all
  // platform screens with the bar up, behind the same #app-view.
  const { App, parks } = router();
  await App.navigateToApp('whiteboard-ab12cd');
  await App.switchTab('dev', null, 'forum');
  assert.equal(named(parks.at(-1)), 'Whiteboard', 'the Workshop offers the app back');
  await App.switchTab('app');
  assert.equal(parks.at(-1), null, 'and going back into it clears the offer');
  App.navigateHome();
  assert.equal(named(parks.at(-1)), 'Whiteboard', 'leaving again parks it again');
});

test('leaving before the app\'s record lands parks the launcher\'s row', () => {
  const { App, parks } = router({ record: 'pending' });
  App.navigateToApp('whiteboard-ab12cd');
  App.navigateHome();
  assert.equal(named(parks.at(-1)), 'Whiteboard', 'the launcher\'s cached row names it');
});

test('a cold link with no launcher row is named by slug, until its record lands', async () => {
  {
    const { App, parks } = router({ launcher: [], record: 'pending' });
    App.navigateToApp('whiteboard-ab12cd');
    App.navigateToMessages();
    assert.equal(named(parks.at(-1)), 'whiteboard-ab12cd',
      'a handle named after the slug beats no handle');
  }
  {
    // navigateToApp ends in switchTab once the record has loaded, and that
    // re-assertion replaces the capture — so the strip says what the app is.
    const { App, parks } = router({ launcher: [], record: { ...WHITEBOARD } });
    await App.navigateToApp('whiteboard-ab12cd');
    App.navigateToMessages();
    assert.equal(named(parks.at(-1)), 'Whiteboard');
  }
});

test('the platform\'s own row is never parked, and does not cost you the app you left', async () => {
  {
    const { App, parks } = router();
    await App.navigateToApp('whiteboard-ab12cd');
    App.navigateHome();
    const handle = parks.length;
    // Its App tab is Home, so the launcher row sends it straight to its
    // Workshop: a platform screen, with the handle still up.
    await App.navigateToApp('usernode-2d5619');
    App.navigateHome();
    assert.deepEqual(parks.slice(handle), [], 'Whiteboard stays the app you left');
  }
  {
    // A cold link holds `app` until the record says `self_hosted`, and
    // switchTab then turns it to the Workshop — which reaches the router as a
    // leave. It must not park the platform.
    const { App, parks } = router({ launcher: [], record: { ...PLATFORM } });
    await App.navigateToApp('usernode-2d5619');
    assert.equal(App.currentTab, 'dev');
    App.navigateHome();
    assert.ok(!parks.some((p) => p && p.slug === 'usernode-2d5619'), 'never offered as an app to resume');
  }
});

test('a handle is parked once: a forgotten app does not come back on the next swap', async () => {
  const { App, parks } = router();
  await App.navigateToApp('whiteboard-ab12cd');
  App.navigateHome();
  const after = parks.length;
  App.navigateToMessages();
  App.navigateToWorkshop();
  assert.equal(parks.length, after, 'only leaving the app parks it — the strip\'s ✕ stays meant');
});

test('nothing is parked when no app was running', () => {
  const { App, parks } = router();
  App.navigateToMessages();
  App.navigateToWorkshop();
  App.navigateHome();
  assert.deepEqual(parks, []);
});

test('the session sweep forgets the parked app', () => {
  // The same residue as the remembered header: the next account on this
  // device must not be offered the previous one's app.
  const { App, parks } = router();
  App._dropCachedSession();
  assert.deepEqual(parks, [null]);
});

test('one decision: whether the running app is on screen is the bar\'s, and it parks', () => {
  const tabs = APP_JS.slice(APP_JS.indexOf('  _syncPlatformTabs(revealId) {'));
  const body = tabs.slice(0, tabs.indexOf('\n  },'));
  assert.match(body, /const inApp = screen === 'app-view' && App\.currentTab === 'app';/);
  assert.match(body, /App\._syncParkedApp\(inApp\);\s*$/, 'the bar\'s answer is handed on, last');
  assert.equal((APP_JS.match(/_syncParkedApp\(/g) || []).length, 2,
    'the definition and that one call — no second copy of the rule at a call site');
});

test('the display data is captured while the app is on screen, never looked up on the way out', () => {
  const fn = APP_JS.slice(APP_JS.indexOf('  _parkRecord(slug) {'));
  const body = fn.slice(0, fn.indexOf('\n  },'));
  assert.match(body, /AppView\.appData\?\.slug === slug \? AppView\.appData : null/,
    'the record the app view loaded, which is the fresher');
  assert.match(body, /AppView\.launchRecordFor\?\.\(slug\)/, 'or the launcher\'s cached row');
  assert.match(body, /name: rec\?\.name \|\| slug/, 'and the slug answers when neither does');
  assert.match(body, /if \(rec\?\.self_hosted\) return null;/, 'the platform itself is not an app you leave');
});

// ── It rides on the bar ─────────────────────────────────────────────────

test('the strip is drawn only where the bar is', () => {
  // Never over a running app, the signed-out shell or chromeless: the bar's
  // own visibility, applied as the class and never rendered, so a value
  // published before hydration cannot change the first render.
  assert.match(STRIP, /const barUp = useVisibility\('platform-tabs', true\);/);
  assert.match(STRIP, /useHiddenClass\(ref, !app \|\| !barUp\);/);
  assert.match(STRIP, /className="platform-parked hidden"/, 'the class string stays a constant');
  // The keyboard takes it with the bar, and a folded desktop rail takes its
  // footer with it — both presentation, so CSS rather than the class.
  assert.match(CSS, /html\.un-kb #platform-parked \{\s*display: none;\s*\}/);
  assert.match(CSS,
    /body:has\(#platform-tabs\.platform-tabs-folded:not\(\.platform-tabs-peek\)\) \.platform-parked \{\s*display: none;\s*\}/);
});

test('on a peeked rail the strip rides on top, and holds the peek while pointed at', () => {
  assert.match(CSS, /body:has\(#platform-tabs\.platform-tabs-peek\) \.platform-parked \{\s*z-index: 41;/,
    'above the peeked rail (40), not under it');
  // The pointer crossing from the rail onto the strip leaves the rail's
  // element; without these the rail and strip fade away under it. Only while
  // a peek is up — pointing at the strip never starts one.
  assert.match(STRIP, /onMouseEnter=\{peek \? enterPeek : undefined\}/);
  assert.match(STRIP, /onMouseLeave=\{peek \? leavePeek : undefined\}/);
});

test('in the desktop rail the strip has no fill of its own (#2801)', () => {
  // It is fixed OVER the rail, so the phone's frosted sheet stacked on the
  // rail's own read as a differently coloured band under the app you left.
  // The desktop rule clears it; the phone strip keeps its sheet.
  const at = CSS.indexOf('/* THE PARKED STRIP IS THE RAIL\'S FOOTER.');
  assert.ok(at > 0, 'the desktop footer rule must exist');
  const rule = CSS.slice(at, CSS.indexOf('\n  }\n', at));
  assert.match(rule, /background-color: transparent;/);
  assert.match(rule, /backdrop-filter: none;/);
  assert.match(CSS, /\.platform-parked \{[^}]*background-color: var\(--dc-sheet-fill\);/,
    'the phone strip over page content keeps its frosted sheet');
});

test('storage is read defensively and written through one key', () => {
  const SRC = read('frontend/src/features/nav/parked-store.js');
  assert.match(SRC, /const KEY = 'usernode_parked_app_v1';/);
  assert.equal(ui.PARKED_KEY, 'usernode_parked_app_v1');
  // Private mode, disabled site data, a corrupt entry: no strip is the
  // pre-existing behaviour, so there is nothing to report.
  assert.match(SRC, /function readParked\(\) \{\s*try \{/);
  assert.match(SRC, /\} catch \{/);
  // The store is written BEFORE storage, so a storage failure does not cost
  // the viewer the handle for the rest of the session.
  const set = SRC.slice(SRC.indexOf('export function setParked'));
  assert.ok(set.indexOf('parkedStore.set(') < set.indexOf('localStorage.setItem'));
});
