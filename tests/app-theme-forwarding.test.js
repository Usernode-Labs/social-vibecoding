// The platform's light/dark theme, forwarded into the app frame (#3257).
//
// `prefers-color-scheme` inside a cross-origin frame follows the OS, not the
// shell around it, so a viewer who picked Dark on a light-mode OS saw every
// app and every staging preview light. The shell now forwards the RESOLVED
// theme two ways, and the bridge turns both into `usernode.theme` plus a
// `usernode:theme-changed` event:
//   - `?un-theme=` on the app frame and staging preview URLs (pre-paint);
//   - a `__usernode_theme` message family (get / response / changed).
//
// These tests run the real bridge block in a vm and the real AppView
// methods against a stub document, rather than pinning source text.
//
// Run with: node --test tests/app-theme-forwarding.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const BRIDGE = read('public/usernode-bridge/v1/bridge.js');
const BLOCK = BRIDGE.slice(
  BRIDGE.indexOf('/* __USERNODE_THEME_BEGIN__ */'),
  BRIDGE.indexOf('/* __USERNODE_THEME_END__ */'),
);

// ── The bridge ───────────────────────────────────────────────────────────

function runBridge({ search = '', standalone = false } = {}) {
  const posted = [];
  const events = [];
  const listeners = [];
  const parent = { postMessage(msg, origin) { posted.push({ msg, origin }); } };
  const win = {
    location: { search },
    usernode: {},
    addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
    dispatchEvent(ev) { events.push(ev); return true; },
  };
  win.parent = standalone ? win : parent;
  const context = {
    window: win,
    URLSearchParams,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    Math,
    Date,
    String,
  };
  vm.runInNewContext(BLOCK, context);
  const deliver = (data, source = parent) => listeners.forEach((fn) => fn({ data, source }));
  return { win, parent, posted, events, listeners, deliver };
}

test('the block is delimited, and both bridge copies carry it', () => {
  assert.ok(BLOCK.length > 100, 'the theme block must sit between its markers');
  assert.equal(read('public/usernode-bridge.js'), BRIDGE, 'the unversioned mirror matches');
});

test('usernode.theme is seeded synchronously from ?un-theme=, before any answer', () => {
  const b = runBridge({ search: '?token=abc&un-theme=dark' });
  assert.equal(b.win.usernode.theme, 'dark', 'readable by a bootstrap that runs right after the bridge tag');
  assert.equal(b.events.length, 0, 'seeding is not a change');
  assert.equal(runBridge({ search: '?un-theme=purple' }).win.usernode.theme, null, 'junk is not a theme');
  assert.equal(runBridge({ search: '?theme=dark' }).win.usernode.theme, null,
    'only the namespaced parameter: a bare ?theme= belongs to the app');
});

test('it asks the shell once at load and takes only the answer to its own request', () => {
  const b = runBridge({ search: '?un-theme=light' });
  assert.equal(b.posted.length, 1);
  const { msg } = b.posted[0];
  assert.equal(msg.__usernode_theme, 'get');
  assert.ok(msg.id, 'the request carries an id to match the answer to');

  b.deliver({ __usernode_theme: 'response', id: 'someone-else', value: { theme: 'dark' } });
  assert.equal(b.win.usernode.theme, 'light', 'an answer to another request is ignored');

  b.deliver({ __usernode_theme: 'response', id: msg.id, value: { theme: 'dark' } });
  assert.equal(b.win.usernode.theme, 'dark', 'the URL is only as fresh as the last navigation');
  // Compared as JSON: the event detail was built in the vm's own realm.
  assert.equal(JSON.stringify(b.events.map((e) => [e.type, e.detail])),
    JSON.stringify([['usernode:theme-changed', { theme: 'dark' }]]));
});

test('a pushed change updates the value and fires one event; repeats and junk do nothing', () => {
  const b = runBridge({ search: '?un-theme=light' });
  b.deliver({ __usernode_theme: 'changed', value: { theme: 'dark' } });
  b.deliver({ __usernode_theme: 'changed', value: { theme: 'dark' } });
  b.deliver({ __usernode_theme: 'changed', value: { theme: 'system' } });
  b.deliver({ __usernode_theme: 'changed', value: null });
  assert.equal(b.win.usernode.theme, 'dark');
  assert.equal(b.events.length, 1, 'an unchanged or invalid value must not re-dispatch');
});

test('only the embedding shell may set it', () => {
  const b = runBridge({ search: '?un-theme=light' });
  b.deliver({ __usernode_theme: 'changed', value: { theme: 'dark' } }, { postMessage() {} });
  assert.equal(b.win.usernode.theme, 'light', 'a message from any other window is ignored');
});

test('standalone it reads the URL and nothing else: no shell to ask', () => {
  const b = runBridge({ search: '', standalone: true });
  assert.equal(b.win.usernode.theme, null, 'null tells the app to fall back to prefers-color-scheme');
  assert.equal(b.posted.length, 0);
  assert.equal(b.listeners.length, 0);
});

test('it reports and never restyles the app', () => {
  assert.ok(!/document\./.test(BLOCK),
    'no class, attribute or style is written: what dark means is the app\'s call');
});

// ── The shell ────────────────────────────────────────────────────────────

const AppView = require('../public/js/app-view.js');

function frame() {
  const received = [];
  return { contentWindow: { postMessage(msg, origin) { received.push({ msg, origin }); } }, received };
}

function withDocument(t, { dark, byId = {}, kept = [] }) {
  const prev = global.document;
  global.document = {
    documentElement: { classList: { contains: (c) => c === 'dark' && dark } },
    getElementById: (id) => byId[id] || null,
    querySelectorAll: (sel) => (sel === '.app-launch-host iframe' ? [...kept, byId['app-iframe']].filter(Boolean) : []),
  };
  t.after(() => { global.document = prev; });
}

test('resolvedTheme reads the theme the shell actually painted', (t) => {
  withDocument(t, { dark: true });
  assert.equal(AppView.resolvedTheme(), 'dark');
  global.document.documentElement.classList.contains = () => false;
  assert.equal(AppView.resolvedTheme(), 'light');
});

test('a get from an owned frame is answered with the resolved theme; anything else is not', (t) => {
  const app = frame();
  const stranger = frame();
  withDocument(t, { dark: true, byId: { 'app-iframe': app } });
  AppView.handleThemeBridgeMessage({ data: { __usernode_theme: 'get', id: 'r1' }, source: app.contentWindow });
  assert.deepEqual(app.received.map((r) => r.msg), [
    { __usernode_theme: 'response', id: 'r1', value: { theme: 'dark' } },
  ]);
  AppView.handleThemeBridgeMessage({ data: { __usernode_theme: 'get', id: 'r2' }, source: stranger.contentWindow });
  assert.equal(stranger.received.length, 0, 'only frames this shell owns');
});

test('a change reaches the app, the staging preview, the landing viewer and parked apps', (t) => {
  const app = frame();
  const staging = frame();
  const viewer = frame();
  const parked = frame();
  withDocument(t, {
    dark: false,
    byId: { 'app-iframe': app, 'staging-iframe': staging, 'app-viewer-frame': viewer },
    kept: [parked],
  });
  AppView.broadcastTheme();
  for (const f of [app, staging, viewer, parked]) {
    assert.deepEqual(f.received.map((r) => r.msg), [{ __usernode_theme: 'changed', value: { theme: 'light' } }],
      'each frame gets exactly one push, the active app included only once');
  }
});

test('the app frame URL carries the resolved theme next to the token', (t) => {
  withDocument(t, { dark: true });
  const saved = {
    appData: AppView.appData, pendingInnerPath: AppView.pendingInnerPath, tokenForSlug: AppView.tokenForSlug,
  };
  // The browser globals the builder reads, as tests/app-frame-identity.test.js stubs them.
  const prevGlobals = { resolveDevHost: global.resolveDevHost, location: global.location };
  global.resolveDevHost = (u) => u;
  global.location = { origin: 'https://platform.example' };
  t.after(() => {
    Object.assign(AppView, saved);
    Object.assign(global, prevGlobals);
  });
  AppView.appData = { slug: 'rss-reader-4113da', url: 'https://rss-reader-4113da.onhomeroom.com' };
  AppView.pendingInnerPath = '/feeds?theme=ocean';
  AppView.tokenForSlug = () => 'tok';
  const src = new URL(AppView.buildAppIframeSrc());
  assert.equal(src.searchParams.get('un-theme'), 'dark');
  assert.equal(src.searchParams.get('token'), 'tok');
  assert.equal(src.searchParams.get('theme'), 'ocean', 'an app\'s own ?theme= is left alone');
});

test('the shell wires it up: the listener, the change hook and the staging URL', () => {
  const src = read('public/js/app-view.js');
  assert.match(src, /try \{ AppView\.handleThemeBridgeMessage\(e\); \} catch \{\}/);
  assert.match(src, /window\.Theme\.onChange\(\(\) => AppView\.broadcastTheme\(\)\)/,
    'the drawer, an OS flip in System mode and another tab all reach Theme.onChange');
  const start = src.indexOf('const buildSrc = (path) => {');
  const staging = src.slice(start, src.indexOf('const jump = !!(opts && opts.jump)', start));
  assert.match(staging, /url\.searchParams\.set\(AppView\.THEME_PARAM, AppView\.resolvedTheme\(\)\);/,
    'the staging preview gets it too: that is where #3257 was seen');
  assert.equal(AppView.THEME_PARAM, 'un-theme');
});

test('the app conventions document it', () => {
  const doc = read('src/prompts/app-conventions.md');
  assert.ok(doc.includes("## The platform's light/dark theme inside the app frame"));
  assert.match(doc, /usernode\.theme/);
  assert.match(doc, /usernode:theme-changed/);
});

// ── A theme toggle is not a new url ─────────────────────────────────────

const SAME_SRC_TABLE = [
  ['https://a.example/?token=t&un-theme=dark', 'https://a.example/?token=t&un-theme=light', true],
  ['https://a.example/?token=t', 'https://a.example/?token=t&un-theme=light', true],
  ['https://a.example/x?token=t&un-theme=dark#h', 'https://a.example/x?token=t&un-theme=light#h', true],
  ['https://a.example/?token=t&un-theme=dark', 'https://a.example/?token=u&un-theme=dark', false],
  ['https://a.example/?un-theme=dark', 'https://b.example/?un-theme=dark', false],
  ['https://a.example/x?un-theme=dark', 'https://a.example/y?un-theme=dark', false],
  ['https://a.example/?theme=dark', 'https://a.example/?theme=light', false],
  ['', 'https://a.example/', false],
  ['', '', true],
];

test('sameFrameSrc ignores un-theme and nothing else, in both copies', async () => {
  const policy = await import(
    new URL('../frontend/src/features/app-frame/app-frame-policy.js', `file://${__filename}`).href
  );
  assert.equal(policy.FRAME_THEME_PARAM, AppView.THEME_PARAM, 'one parameter name');
  for (const [a, b, want] of SAME_SRC_TABLE) {
    assert.equal(policy.sameFrameSrc(a, b), want, `bundle: ${a} vs ${b}`);
    assert.equal(AppView.sameFrameSrc(a, b), want, `legacy: ${a} vs ${b}`);
  }
});

test('every place a render compares frame urls goes through it', () => {
  const bridge = read('frontend/src/features/app-frame/app-frame-bridge.js');
  assert.match(bridge, /sameFrameSrc\(srcOf\(el\), src\)/, 'keeps(): App → Dev → App after a toggle');
  const src = read('public/js/app-view.js');
  assert.match(src, /AppView\.sameFrameSrc\(adopt\.src, iframeSrc\)/, 'the launch adoption');
  assert.match(src, /!AppView\.sameFrameSrc\(pending\.src, target\)/, 'the staging "Test this change" retarget');
});
