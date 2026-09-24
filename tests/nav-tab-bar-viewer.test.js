'use strict';

// #2760 — the fifth tab carries the signed-in user's USERNAME instead of "Me",
// on the phone's bar and the desktop rail alike (the owner asked for both).
//
// Four things are pinned, and each is a way the tab can be wrong while the bar
// still renders and every structural test still passes:
//
//   1. THE PRERENDER STILL SAYS "Me". The document is built in Node with no
//      session. A first client render that named anybody would disagree with
//      it, which is React #418 — a console error on every route, and a console
//      error on any route fails every declared check.
//   2. ONCE KNOWN, THE NAME IS THE LABEL, and the accessible name still says
//      what the tab is, not only whose it is.
//   3. THE BRIDGE CLEANS WHAT IT IS GIVEN. A user object with no username yet
//      leaves the tab saying "Me" rather than saying nothing.
//   4. APP.JS PUBLISHES IT WHEREVER `App.user` CHANGES — every boot and login,
//      the verified session replacing the snapshot, sign-out, and a rename.

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

const ui = loadTsx('tests/fixtures/tab-bar-api.ts');
const render = (viewer) => {
  const before = ui.navStore.get().viewer;
  ui.navStore.set({ viewer });
  try {
    return renderToHtml(createElement(ui.PlatformTabs, {}));
  } finally {
    ui.navStore.set({ viewer: before });
  }
};
const meTab = (html) => {
  const at = html.indexOf('id="platform-tab-me"');
  assert.ok(at > 0, '#platform-tab-me renders');
  return html.slice(html.lastIndexOf('<a', at), html.indexOf('</a>', at) + 4);
};

// ── 1. The prerender ──────────────────────────────────────────────────

test('the shipped document says "Me", with no name and no label of its own', () => {
  assert.equal(ui.navStore.get().viewer, null, 'nobody is known before the router runs');
  const shipped = meTab(HTML);
  assert.match(shipped, /class="platform-tab-label">Me</, 'the prerender can only say Me');
  assert.doesNotMatch(shipped, /aria-label=/,
    'an accessible name that differs from the text would be a second thing to keep in step');
  // …and the first client render is the same markup, or hydration fails.
  assert.equal(meTab(render(null)), shipped.replace(/ aria-current="page"/, ''),
    'the store\'s INITIAL renders exactly the shipped tab');
});

// ── 2. The name ───────────────────────────────────────────────────────

test('once somebody is signed in, the tab is their username', () => {
  const tab = meTab(render('evan'));
  assert.match(tab, /class="platform-tab-label">evan</, 'the username is the visible label');
  assert.doesNotMatch(tab, />Me</, 'and "Me" is gone');
  assert.match(tab, /aria-label="evan, your profile"/,
    'the accessible name starts with what is on screen and says what the tab is');
  assert.match(tab, /href="#profile"/, 'the destination is unchanged');
  assert.match(tab, /data-tab="me"/, 'and so is the key every selector uses');
});

test('only the fifth tab changes', () => {
  const html = render('evan');
  for (const [key, label] of [['home', 'Home'], ['discover', 'Discover'],
    ['messages', 'Messages'], ['workshop', 'Workshop']]) {
    const at = html.indexOf(`id="platform-tab-${key}"`);
    const tab = html.slice(html.lastIndexOf('<a', at), html.indexOf('</a>', at));
    assert.match(tab, new RegExp(`class="platform-tab-label">${label}<`), `${key} keeps its word`);
    // The anchor's own attributes only: the Messages badge inside it carries
    // an aria-label of its own, which is the badge's business.
    assert.doesNotMatch(tab.slice(0, tab.indexOf('>')), /aria-label=/,
      `${key} keeps its text as its name`);
  }
  assert.deepEqual(ui.tabLabel('home', 'Home', 'evan'), { text: 'Home', ariaLabel: undefined });
  assert.deepEqual(ui.tabLabel('me', 'Me', null), { text: 'Me', ariaLabel: undefined });
  assert.deepEqual(ui.tabLabel('me', 'Me', 'evan'), { text: 'evan', ariaLabel: 'evan, your profile' });
});

test('a long username is cut with an ellipsis inside the tab, at both sizes', () => {
  // Usernames are up to 32 characters with no spaces (src/services/usernames.js),
  // so the label has to clip rather than push the bar or the rail row wider.
  assert.match(CSS, /\.platform-tab-label \{\s*max-width: 100%;\s*overflow: hidden;\s*text-overflow: ellipsis;/,
    'the phone caption clips at its column');
  const desk = CSS.slice(CSS.indexOf('@media (min-width: 768px) {\n  /* THE BAND AT THE FOOT GOES AWAY'));
  assert.match(desk, /\.platform-tab-label \{\s*max-width: none;\s*min-width: 0;\s*\}/,
    'and on the rail it may shrink, or a flex item\'s minimum is its whole text');
});

// ── 3. The bridge ─────────────────────────────────────────────────────

test('the bridge trims the name and treats a blank one as nobody', () => {
  // mount.ts installs `window.UsernodeReact.nav` only where a window exists,
  // so this loads its own copy of the bundle with one in place.
  const hadWindow = 'window' in globalThis;
  const saved = globalThis.window;
  globalThis.window = {};
  try {
    const live = loadTsx('tests/fixtures/tab-bar-api.ts');
    const nav = globalThis.window.UsernodeReact && globalThis.window.UsernodeReact.nav;
    assert.equal(typeof nav?.setViewer, 'function', 'the bridge carries setViewer');
    nav.setViewer('  evan ');
    assert.equal(live.navStore.get().viewer, 'evan');
    for (const blank of ['', '   ', null, undefined, 42]) {
      nav.setViewer('evan');
      nav.setViewer(blank);
      assert.equal(live.navStore.get().viewer, null, `${JSON.stringify(blank)} clears it`);
    }
  } finally {
    if (hadWindow) globalThis.window = saved; else delete globalThis.window;
  }
});

// ── 4. The publisher ──────────────────────────────────────────────────

function harness() {
  const context = vm.createContext({
    location: new URL('https://homeroom.test/'),
    history: { pushState() {}, replaceState() {} },
    URL, URLSearchParams, console,
    document: { title: '', getElementById: () => null, querySelector: () => null, addEventListener() {} },
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    PlatformUI: { transition(fn, opts) { fn(); opts?.after?.(); } },
  });
  context.window = context;
  vm.runInContext(APP_JS, context);
  const names = [];
  context.UsernodeReact = { nav: { setViewer: (name) => names.push(name) } };
  return { App: context.App, names };
}

test('_syncViewer publishes the signed-in username, and nobody once signed out', () => {
  const { App, names } = harness();
  App.user = { id: 1, username: 'evan' };
  App._syncViewer();
  App.user = null;
  App._syncViewer();
  App.user = { id: 1 };
  App._syncViewer();
  assert.deepEqual(names, ['evan', null, null]);
});

test('every assignment of App.user is followed by the publish', () => {
  // enterAuthed (every boot and login, snapshot or verified), the verified
  // answer in _reconcileSession, and enterAnonymous. Counted, so a fourth
  // writer added later has to decide what the tab should say.
  const assigns = APP_JS.match(/^\s*App\.user = [^;]+;$/gm) || [];
  assert.equal(assigns.length, 3, 'App.user is assigned in exactly three places');
  const followed = APP_JS.match(/^\s*App\.user = [^;]+;\n\s*App\._syncViewer\(\);$/gm) || [];
  assert.equal(followed.length, 3, 'and each one publishes the name on its next line');
});

test('a rename reaches the tab through the sweep both username writers run', () => {
  const at = APP_JS.indexOf('  resyncCurrentView() {');
  const body = APP_JS.slice(at, APP_JS.indexOf('\n  },', at));
  assert.match(body, /App\._syncViewer\(\);/, 'resyncCurrentView re-publishes the name');
  // Settings → Change username, and the first-run "Choose your username" step.
  const settings = read('frontend/src/features/settings/settings.js');
  const change = settings.slice(settings.indexOf('async changeUsername() {'));
  assert.match(change.slice(0, change.indexOf('async changePassword()')),
    /App\.user\.username = j\.username;[\s\S]{0,300}App\.resyncCurrentView\(\)/);
  const firstRun = read('frontend/src/features/auth/username-first-run.js');
  assert.match(firstRun,
    /window\.App\.user\.username = body\.username;[\s\S]{0,300}window\.App\.resyncCurrentView\?\.\(\)/);
});

test('the tour no longer sends the reader to a tab called Me', () => {
  const { TOUR_STEPS } = loadTsx('frontend/src/features/home/tour/tour-steps.ts');
  const step = TOUR_STEPS.find((s) => s.id === 'settings');
  assert.ok(step, 'the replay step is still the last word of the tour');
  assert.doesNotMatch(step.body, /\bMe\b/,
    'the tab carries your name now, so the step names the place instead of a label it no longer shows');
  assert.match(step.body, /on your profile/);
  assert.deepEqual([...step.targets], ['#platform-tab-me'], 'and still points at the tab');
});
