'use strict';

// #5996: Settings' "Find a setting" box remembers recent searches, answers
// Ctrl+K (⌘K) and /, and finds a setting by more of the words on its
// controls. Highlighting and the no-match suggestion shipped earlier (#5946)
// and are pinned in tests/settings-screen.test.js.
//
// What is pinned, each a way it can be quietly wrong:
//
//   1. THE STORE. Five at most, newest first, one per query whatever its
//      capitals, blank ignored, garbage in localStorage read as nothing. The
//      signed-in account's own: keyed by its id, never shown to the next
//      person on the browser. Memory is the source of truth, so a storage
//      that throws loses nothing from this visit.
//   2. WHEN A SEARCH IS REMEMBERED. Choosing a result (click or Enter), not a
//      keystroke, and never Sign out.
//   3. THE BLOCK. Drawn on both hosts only while the box is empty, each row
//      fills the box rather than opening a page, Clear forgets them all; the
//      prerender is still the two empty hosts.
//   4. THE SHORTCUT. Only the chord or a bare /, only while Settings shows a
//      box, never while a dialog is up or comment mode is on, / never from a
//      field; when it answers it prevents the default so the community
//      shortcut's ⌘K stands down.
//   5. THE WORDS. "system", "automatic", "high contrast", "english" find
//      their settings through the real catalog.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderComponent } = require('./lib/render-tsx');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const NAV = 'frontend/src/features/settings/settings-nav.tsx';
const RECENT = 'frontend/src/features/settings/recent-searches.js';
const SHORTCUT = 'frontend/src/features/settings/filter-shortcut.ts';

function fakeStorage(entries = {}) {
  const data = new Map(Object.entries(entries));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
}

const broken = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceededError'); },
  removeItem() { throw new Error('SecurityError'); },
};

// One device's recent searches, with the signed-in account switchable.
function device(storage) {
  const r = loadTsx(RECENT);
  const who = { id: 7 };
  const recent = r.createRecentSearches({ storage: () => storage, owner: () => who.id });
  const shown = () => recent.visible(recent.store.get());
  return { r, who, recent, shown };
}

// ── 1. The store ────────────────────────────────────────────────────────

test('recent searches: five, newest first, one per query whatever its capitals', () => {
  const s = fakeStorage();
  const { r, recent, shown } = device(s);
  assert.equal(r.MAX_RECENT, 5);
  assert.equal(r.recentSearchesKey(7), 'usernode.settings.recentSearches.7', 'one key per account');
  assert.equal(r.recentSearchesKey(null), null, 'nobody signed in has none');
  recent.load();
  assert.deepEqual(shown(), [], 'nothing stored is nothing listed');
  recent.remember('  theme  ');
  assert.deepEqual(shown(), ['theme'], 'trimmed');
  recent.remember('   ');
  assert.deepEqual(shown(), ['theme'], 'blank is not remembered');
  recent.remember('password');
  recent.remember('THEME');
  assert.deepEqual(shown(), ['THEME', 'password'], 'a repeat moves to the top, once');
  for (const q of ['a1', 'a2', 'a3', 'a4']) recent.remember(q);
  assert.deepEqual(shown(), ['a4', 'a3', 'a2', 'a1', 'THEME'], 'five kept');
  assert.deepEqual(JSON.parse(s.data.get('usernode.settings.recentSearches.7')), shown(), 'persisted under the account');
  assert.equal(r.addRecent([], 'x'.repeat(200))[0].length, r.MAX_QUERY_LENGTH, 'a paste is bounded');
  recent.forget();
  assert.deepEqual(shown(), []);
  assert.equal(s.data.has('usernode.settings.recentSearches.7'), false, 'Clear empties storage too');
  // A later visit reads what was stored.
  recent.remember('language');
  const again = device(s);
  again.recent.load();
  assert.deepEqual(again.shown(), ['language']);
});

test('recent searches are the signed-in account\'s: a switch or a sign-out never shows the last one\'s', () => {
  const s = fakeStorage();
  const { who, recent, shown } = device(s);
  recent.load();
  recent.remember('password');
  assert.deepEqual(shown(), ['password']);

  // A signs out: nothing is shown, even before anything reloads the list.
  who.id = null;
  assert.deepEqual(shown(), [], 'the stale list stays off the screen');
  recent.load();
  assert.deepEqual(recent.store.get().items, [], 'and memory is dropped on the next load');
  recent.remember('theme');
  assert.deepEqual(shown(), [], 'nobody signed in remembers nothing');
  assert.deepEqual([...s.data.keys()], ['usernode.settings.recentSearches.7'], 'and stores nothing');

  // B signs in on the same browser.
  who.id = 8;
  assert.deepEqual(shown(), []);
  recent.load();
  assert.deepEqual(shown(), [], 'B starts with their own (empty) list');
  recent.remember('language');
  assert.deepEqual(shown(), ['language']);
  assert.deepEqual(JSON.parse(s.data.get('usernode.settings.recentSearches.7')), ['password'], 'A\'s list untouched');

  // Back to A, without a load in between: remember() switches first.
  who.id = 7;
  recent.remember('theme');
  assert.deepEqual(shown(), ['theme', 'password'], 'A\'s own list, never B\'s');
});

test('recent searches: garbage reads as nothing, and memory survives a storage that throws', () => {
  const r = loadTsx(RECENT);
  const key = r.recentSearchesKey(7);
  assert.deepEqual(r.readRecent(fakeStorage({ [key]: '{not json' }), 7), []);
  assert.deepEqual(r.readRecent(fakeStorage({ [key]: '{"a":1}' }), 7), []);
  assert.deepEqual(r.readRecent(fakeStorage({ [key]: JSON.stringify(['ok', 3, null, '  ', ' two ']) }), 7), ['ok', 'two']);
  assert.deepEqual(r.readRecent(null, 7), []);
  assert.deepEqual(r.readRecent(broken, 7), []);

  // Consecutive searches with storage blocked keep each other.
  const { recent, shown } = device(broken);
  recent.load();
  recent.remember('theme');
  recent.remember('password');
  assert.deepEqual(shown(), ['password', 'theme'], 'memory is the source of truth');
  recent.forget();
  assert.deepEqual(shown(), []);

  // The app's own instance, with no window at all (the SSG pass, Node).
  r.loadRecent();
  r.rememberSearch('theme');
  assert.deepEqual(r.visibleRecent(r.recentSearchesStore.get()), [], 'nobody is signed in there');
  r.forgetSearches();
});

// ── 2 & 3. When a search is remembered, and the block ──────────────────

const DESCRIPTOR = {
  desktop: [{ name: 'Account', first: true, items: [{ key: 'account', label: 'Account', active: true, className: 'x', terms: 'account', parts: [{ key: 'password', label: 'Password', terms: 'password sign in login' }] }] }],
  mobile: [{ name: 'Account', items: [{ key: 'account', label: 'Account', terms: 'account', parts: [{ key: 'password', label: 'Password', terms: 'password sign in login' }] }] }],
  visit: 1,
};

// The hosts, run as plain functions with the query a viewer typed, the
// descriptor settings.js publishes and the recent searches on this device.
function hostsWith(query, items, calls = []) {
  const real = require(require.resolve('react', { paths: [path.join(ROOT, 'frontend')] }));
  const React = {
    ...real,
    useState: () => [query, (q) => calls.push(['setQuery', q])],
    useEffect() {},
    useSyncExternalStore: (subscribe, get) => get(),
  };
  const nav = loadTsx(NAV, {
    stubs: {
      react: React,
      './settings-nav-store.js': { settingsNavStore: { get: () => DESCRIPTOR, subscribe: () => () => {} } },
      './recent-searches.js': {
        recentSearchesStore: { get: () => ({ items }), subscribe: () => () => {} },
        visibleRecent: (state) => state.items,
        loadRecent: () => calls.push(['load']),
        rememberSearch: (q) => calls.push(['remember', q]),
        forgetSearches: () => calls.push(['forget']),
      },
      '../../lib/i18n/react': { useMessages: () => englishPlatformI18n().t, RichMessage: () => null },
    },
  });
  return { nav, desktop: nav.SettingsNavDesktop(), mobile: nav.SettingsMobileMenu() };
}

function find(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => find(n, pred, out)); return out; }
  if (node.props && pred(node)) out.push(node);
  if (node.props) find(node.props.children, pred, out);
  return out;
}
const named = (name) => (n) => typeof n.type === 'function' && n.type.name === name;

test('both hosts draw Recent searches only while the box is empty and there are some', () => {
  for (const host of ['desktop', 'mobile']) {
    const shown = find(hostsWith('', ['theme', 'password'])[host], named('RecentSearches'));
    assert.equal(shown.length, 1, `${host}: the block, under an empty box`);
    assert.deepEqual(shown[0].props.items, ['theme', 'password']);
    assert.equal(shown[0].props.variant, host);
    assert.equal(find(hostsWith('pass', ['theme'])[host], named('RecentSearches')).length, 0,
      `${host}: gone while filtering`);
  }
});

test('the block: a heading, Clear, and rows that search again rather than open a page', () => {
  const calls = [];
  const { nav } = hostsWith('', [], calls);
  const setQuery = (q) => calls.push(['setQuery', q]);
  assert.equal(nav.RecentSearches({ items: [], setQuery, variant: 'desktop' }), null, 'nothing before a first search');
  for (const variant of ['desktop', 'mobile']) {
    calls.length = 0;
    const el = nav.RecentSearches({ items: ['theme', '<b>x</b>'], setQuery, variant });
    assert.equal(el.props['data-settings-recent'], '');
    const heading = find(el, (n) => n.props.children === 'Recent searches');
    assert.equal(heading.length, 1, `${variant}: headed "Recent searches"`);
    const clear = find(el, (n) => n.props['data-settings-recent-clear'] !== undefined)[0];
    assert.equal(clear.props.children, 'Clear');
    assert.equal(clear.props['aria-label'], 'Clear recent searches');
    clear.props.onClick();
    assert.deepEqual(calls, [['forget']]);
    const rows = find(el, (n) => n.props['data-settings-recent-item'] !== undefined);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].props['aria-label'], 'Search again for “theme”');
    const box = variant === 'desktop' ? 'settings-filter-desktop' : 'settings-filter-mobile';
    globalThis.document = {
      getElementById: (id) => (id === box ? { focus: () => calls.push(['focus', id]) } : null),
    };
    try {
      rows[0].props.onClick();
    } finally {
      delete globalThis.document;
    }
    assert.deepEqual(calls.slice(-2), [['focus', box], ['setQuery', 'theme']],
      'the cursor goes to the box before the row unmounts, then it fills; no navigation');
    if (variant === 'mobile') assert.equal(rows[0].props.chevron, false, 'a row searches, it opens no page');
  }
  // Text, not markup: what was typed is never parsed.
  const html = require(require.resolve('react-dom/server', { paths: [path.join(ROOT, 'frontend')] }))
    .renderToStaticMarkup(nav.RecentSearches({ items: ['<b>x</b>'], setQuery, variant: 'desktop' }));
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
});

test('a search is remembered when a result is chosen, never for Sign out', () => {
  const calls = [];
  globalThis.window = { Settings: { _navClick: (key) => calls.push(['nav', key]) } };
  try {
    const { desktop, mobile } = hostsWith('pass', [], calls);
    for (const host of [desktop, mobile]) {
      calls.length = 0;
      const hit = find(host, (n) => n.props['data-settings-nav'] === 'account')[0];
      hit.props.onClick();
      assert.deepEqual(calls, [['remember', 'pass'], ['setQuery', ''], ['nav', 'password']],
        'a click remembers what was typed, then opens the page');
    }
    // Enter goes through the same choose().
    calls.length = 0;
    const fieldEl = find(desktop, (n) => n.props.id === 'settings-filter-desktop')[0];
    const input = fieldEl.type(fieldEl.props);
    assert.equal(input.props['aria-keyshortcuts'], 'Control+K Meta+K /', 'the box announces the shortcut');
    input.props.onKeyDown({ key: 'Enter', preventDefault() {} });
    assert.deepEqual(calls[0], ['remember', 'pass']);
  } finally {
    delete globalThis.window;
  }

  const src = read(NAV);
  const signOut = src.slice(src.indexOf('function signOut('), src.indexOf('\n}\n', src.indexOf('function signOut(')));
  assert.doesNotMatch(signOut, /rememberSearch/, 'Sign out is not a search worth remembering');
  assert.match(src, /useEffect\(\(\) => \{ loadRecent\(\); \}, \[visit\]\);/, 'read from an effect, on every visit');
  assert.match(src, /useEffect\(\(\) => installFilterShortcut\(\{ doc: document \}\), \[\]\);/, 'one listener, uninstalled on unmount');
});

test('the prerendered hosts are still empty until settings.js publishes', () => {
  assert.equal(renderComponent(NAV, 'SettingsMobileMenu', {}), '<div id="settings-mobile-menu-host" class="md:hidden"></div>');
  assert.equal(renderComponent(NAV, 'SettingsNavDesktop', {}),
    '<nav id="settings-nav-desktop" aria-label="Settings sections" class="space-y-1"></nav>');
});

// ── 4. The shortcut ─────────────────────────────────────────────────────

const sc = loadTsx(SHORTCUT);
const OK = { settingsShowing: true, hasField: true, dialog: false, commentMode: false, typing: false };
const k = (init = {}) => ({ key: 'k', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, ...init });
const slash = (init = {}) => ({ key: '/', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init });

test('shortcut: Ctrl+K, ⌘K and a bare / only', () => {
  assert.equal(sc.filterShortcutKind(k()), 'k');
  assert.equal(sc.filterShortcutKind(k({ ctrlKey: false, metaKey: true })), 'k');
  assert.equal(sc.filterShortcutKind(k({ key: 'K' })), 'k');
  assert.equal(sc.filterShortcutKind(k({ shiftKey: true })), null, 'Ctrl+Shift+K is the browser\'s');
  assert.equal(sc.filterShortcutKind(k({ altKey: true })), null);
  assert.equal(sc.filterShortcutKind(k({ ctrlKey: false })), null, 'a bare k is typing');
  assert.equal(sc.filterShortcutKind(k({ repeat: true })), null);
  assert.equal(sc.filterShortcutKind(k({ isComposing: true })), null);
  assert.equal(sc.filterShortcutKind(slash()), 'slash');
  assert.equal(sc.filterShortcutKind(slash({ shiftKey: true })), 'slash', 'some keyboards need Shift for /');
  for (const mod of ['ctrlKey', 'metaKey', 'altKey']) assert.equal(sc.filterShortcutKind(slash({ [mod]: true })), null, mod);
  assert.equal(sc.filterShortcutKind({ key: 'c' }), null);
  assert.equal(sc.filterShortcutKind(null), null);
});

test('shortcut: only while Settings shows a box and nobody else wants the key', () => {
  assert.equal(sc.filterShortcutAnswer(k(), OK), 'focus');
  assert.equal(sc.filterShortcutAnswer(slash(), OK), 'focus');
  for (const [field, value] of [['settingsShowing', false], ['hasField', false], ['dialog', true], ['commentMode', true]]) {
    assert.equal(sc.filterShortcutAnswer(k(), { ...OK, [field]: value }), null, `⌘K: ${field}`);
    assert.equal(sc.filterShortcutAnswer(slash(), { ...OK, [field]: value }), null, `/: ${field}`);
  }
  assert.equal(sc.filterShortcutAnswer(slash(), { ...OK, typing: true }), null, '/ is typed in a field');
  assert.equal(sc.filterShortcutAnswer(k(), { ...OK, typing: true }), 'focus', '⌘K is not typed');
  assert.equal(sc.filterShortcutAnswer(k({ defaultPrevented: true }), OK), null);
});

function shortcutDoc({ screenHidden = false, desktopBox = true, mobileBox = false, dialog = false, comment = false, active = null } = {}) {
  const listeners = [];
  const calls = [];
  const box = (name, shown) => ({
    tagName: 'INPUT',
    getClientRects: () => ({ length: shown ? 1 : 0 }),
    focus: () => calls.push(['focus', name]),
    select: () => calls.push(['select', name]),
  });
  const els = {
    'settings-screen': { classList: { contains: (c) => screenHidden && c === 'hidden' } },
    'settings-filter-desktop': box('desktop', desktopBox),
    'settings-filter-mobile': box('mobile', mobileBox),
    'comment-pin-host': comment ? {} : null,
  };
  const doc = {
    activeElement: active,
    getElementById: (id) => els[id] || null,
    querySelectorAll: () => (dialog ? [{ closest: () => null, checkVisibility: () => true }] : []),
    addEventListener: (type, fn) => listeners.push([type, fn]),
    removeEventListener: (type, fn) => { const i = listeners.findIndex((l) => l[1] === fn); if (i >= 0) listeners.splice(i, 1); },
  };
  const press = (init) => {
    const e = { target: { tagName: 'BODY', closest: () => null }, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
    for (const [type, fn] of [...listeners]) if (type === 'keydown') fn(e);
    return e;
  };
  return { doc, calls, listeners, press };
}

test('shortcut, installed: focuses and selects the box on screen, and claims the key only then', () => {
  let h = shortcutDoc();
  const off = sc.installFilterShortcut({ doc: h.doc });
  assert.equal(h.listeners.length, 1);
  assert.equal(h.listeners[0][0], 'keydown');
  let e = h.press(k());
  assert.equal(e.defaultPrevented, true, 'claimed, so Your communities stands down');
  assert.deepEqual(h.calls, [['focus', 'desktop'], ['select', 'desktop']]);
  off();
  assert.equal(h.listeners.length, 0, 'uninstalls');

  // The phone's box, when the sidebar is not laid out.
  h = shortcutDoc({ desktopBox: false, mobileBox: true });
  sc.installFilterShortcut({ doc: h.doc });
  h.press(slash());
  assert.deepEqual(h.calls, [['focus', 'mobile'], ['select', 'mobile']]);

  // Every refusal leaves the key alone: no preventDefault, no focus.
  const input = { tagName: 'INPUT', closest: () => null };
  for (const [opts, ev, why] of [
    [{ screenHidden: true }, k(), 'Settings is not showing'],
    [{ desktopBox: false }, k(), 'no box on screen (a phone settings page)'],
    [{ dialog: true }, k(), 'a dialog is up (Your communities closes itself)'],
    [{ comment: true }, slash(), 'comment mode is on'],
    [{}, slash({ target: input }), '/ typed in a field'],
    [{ active: input }, slash(), '/ with focus in a field'],
    [{}, { key: 'x' }, 'another key'],
  ]) {
    h = shortcutDoc(opts);
    sc.installFilterShortcut({ doc: h.doc });
    e = h.press(ev);
    assert.equal(e.defaultPrevented, false, why);
    assert.deepEqual(h.calls, [], why);
  }
});

test('the community shortcut still stands down on a claimed key', () => {
  const community = loadTsx('frontend/src/features/workshop/community-shortcut.ts');
  const ctx = { switcherOpen: false, typing: false, dialog: false, signedIn: true, embedded: false };
  assert.equal(community.communityShortcutAnswer({ key: 'k', metaKey: true, defaultPrevented: true }, ctx), null);
  assert.equal(community.communityShortcutAnswer({ key: 'k', metaKey: true }, ctx), 'open', 'and answers everywhere else');
});

// ── 5. The words ────────────────────────────────────────────────────────

test('more of the words on a setting\'s controls find it', () => {
  const kw = (key) => `${message(`settings:nav.keywords.${key}`)}`.toLowerCase();
  const finds = (key, query) => query.toLowerCase().split(/\s+/).every((w) => kw(key).includes(w));
  assert.ok(finds('theme', 'system'));
  assert.ok(finds('theme', 'automatic'));
  assert.ok(finds('theme', 'device'));
  assert.ok(finds('accessibility', 'high contrast'));
  assert.ok(finds('accessibility', 'normal'));
  assert.ok(finds('language', 'english'));
  // The words already there stay.
  assert.ok(finds('theme', 'dark light'));
  assert.ok(finds('language', 'locale'));
});

test('the new text is in the catalog', () => {
  assert.equal(message('settings:nav.filter.recent.heading'), 'Recent searches');
  assert.equal(message('settings:nav.filter.recent.clear'), 'Clear');
  assert.equal(message('settings:nav.filter.recent.clearAria'), 'Clear recent searches');
  assert.equal(message('settings:nav.filter.recent.again', { query: 'theme' }), 'Search again for “theme”');
});
