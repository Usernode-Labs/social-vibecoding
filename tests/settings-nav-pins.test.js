'use strict';
// #5997: the Settings menu was a text-only list. Each page now has a small
// glyph before its name; a viewer can pin the pages they use most into a
// Pinned group at the top, put them in their own order, and fold away groups
// they rarely open. Pins and folds are remembered on this device.
//
// The shaping runs in the real settings.js (in a vm, with a stub
// localStorage); the drawing runs through the real settings-nav.tsx.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SETTINGS_SOURCE = read('frontend/src/features/settings/settings.js');
const NAV = 'frontend/src/features/settings/settings-nav.tsx';
const ICONS_TSX = read('frontend/@/components/ui/icons.tsx');

function node(id, hidden) {
  const classes = new Set(hidden ? ['hidden'] : []);
  return {
    id, value: '', textContent: '', disabled: false, children: [],
    classList: {
      add: (...n) => n.forEach((c) => classes.add(c)),
      remove: (...n) => n.forEach((c) => classes.delete(c)),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    appendChild(child) { this.children.push(child); },
    append(...kids) { this.children.push(...kids); },
    addEventListener() {},
  };
}

/**
 * The real settings.js in a vm. `storage` is the stub localStorage's initial
 * contents, or 'throws' for storage that refuses every call; `hiddenGates`
 * names the gate nodes that are hidden (their page is not offered).
 */
function harness({ storage = {}, hiddenGates = [] } = {}) {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, node(id, hiddenGates.includes(id)));
    return nodes.get(id);
  };
  const store = storage === 'throws' ? null : { ...storage };
  const localStorage = store
    ? {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    }
    : {
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('denied'); },
      removeItem() { throw new Error('denied'); },
    };
  const context = vm.createContext({
    window: { location: { search: '', origin: 'https://example.test' } },
    document: {
      addEventListener() {},
      getElementById: get,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: (tag) => node(`created:${tag}`),
    },
    localStorage,
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval, console,
    PlatformI18n: englishPlatformI18n(),
  });
  context.window.window = context.window;
  context.window.document = context.document;
  vm.runInContext(SETTINGS_SOURCE, context);
  const Settings = context.window.Settings;
  let paints = 0;
  Settings._renderNav = () => { paints += 1; };
  Settings._loadNavPrefs();
  return { Settings, store, paints: () => paints };
}

// The vm's arrays are another realm's: compare plain copies.
const plain = (v) => JSON.parse(JSON.stringify(v));
const shape = (groups) => plain(groups.map((g) => [g.key, g.items.map((p) => p.key)]));

test('nothing saved: no Pinned group, every group open, the menu as it was', () => {
  const { Settings } = harness();
  const groups = Settings._groupedSections();
  assert.deepEqual(plain(groups.map((g) => g.key)), ['account', 'aiModels', 'integrations', 'preferences', 'helpAbout', 'advanced']);
  assert.ok(groups.every((g) => g.folded === false), 'every group starts open');
});

test('saved pins come first, in their order, and leave their groups; an emptied group goes', () => {
  const { Settings } = harness({ storage: { 'usernode:settings-pinned': 'ai,language' } });
  const groups = shape(Settings._groupedSections());
  assert.deepEqual(groups[0], ['pinned', ['ai', 'language']]);
  assert.ok(!groups.some(([key]) => key === 'aiModels'), 'AI models & usage held only the pinned page');
  const prefs = groups.find(([key]) => key === 'preferences')[1];
  assert.ok(!prefs.includes('language'), 'Language is not shown twice');
  assert.ok(prefs.includes('theme'));
  const desktop = Settings._navView();
  assert.equal(desktop[0].name, 'Pinned');
  assert.equal(desktop[0].first, true);
  assert.deepEqual(plain(desktop[0].items.map((i) => [i.key, i.pinned, i.icon])), [['ai', true, 'sparkles'], ['language', true, 'globe']]);
  assert.deepEqual(plain(desktop[0].items.map((i) => i.home)), ['aiModels', 'preferences'],
    'each pinned row names the group an unpin sends it back to');
  const menu = Settings._menuView();
  assert.equal(menu[0].key, 'pinned');
  assert.equal(menu[0].items[1].home, 'preferences');
  assert.equal(menu[0].items[1].pinned, true);
});

test('a pin whose page is not offered is skipped, and kept for when it is', () => {
  const { Settings, store } = harness({
    storage: { 'usernode:settings-pinned': 'wallet,about,language' },
    hiddenGates: ['wallet-section'],
  });
  assert.deepEqual(shape(Settings._groupedSections())[0], ['pinned', ['about', 'language']]);
  // Moving Language up swaps it with About, the pin above it on screen, and
  // the hidden Wallet pin keeps its own first slot.
  Settings._movePinned('language', -1);
  assert.equal(store['usernode:settings-pinned'], 'wallet,language,about');
  assert.deepEqual(shape(Settings._groupedSections())[0], ['pinned', ['language', 'about']]);
});

test('pin, move and unpin write this device\'s list and repaint', () => {
  const { Settings, store, paints } = harness();
  Settings._setPinned('language', true);
  Settings._setPinned('ai', true);
  assert.equal(store['usernode:settings-pinned'], 'language,ai', 'a new pin goes to the bottom');
  Settings._movePinned('language', -1);
  assert.equal(store['usernode:settings-pinned'], 'language,ai', 'the top pin cannot move up');
  Settings._movePinned('ai', 1);
  assert.equal(store['usernode:settings-pinned'], 'language,ai', 'the bottom pin cannot move down');
  Settings._movePinned('ai', -1);
  assert.equal(store['usernode:settings-pinned'], 'ai,language');
  Settings._setPinned('ai', false);
  assert.equal(store['usernode:settings-pinned'], 'language');
  Settings._setPinned('language', false);
  assert.ok(!('usernode:settings-pinned' in store), 'no pins, no key');
  assert.ok(paints() >= 4, 'each change repaints the menu');
});

test('fold and unfold a group; Pinned never folds', () => {
  const { Settings, store } = harness();
  Settings._setGroupFolded('advanced', true);
  assert.equal(store['usernode:settings-folded'], 'advanced');
  assert.equal(Settings._groupedSections().find((g) => g.key === 'advanced').folded, true);
  assert.equal(Settings._navView().find((g) => g.key === 'advanced').folded, true);
  Settings._setGroupFolded('pinned', true);
  assert.equal(store['usernode:settings-folded'], 'advanced');
  Settings._setGroupFolded('advanced', false);
  assert.ok(!('usernode:settings-folded' in store));
});

test('storage that throws still works for the visit', () => {
  const { Settings } = harness({ storage: 'throws' });
  assert.deepEqual(plain(Settings._navPrefs), { pinned: [], folded: [] });
  Settings._setPinned('about', true);
  Settings._setGroupFolded('account', true);
  const groups = Settings._groupedSections();
  assert.deepEqual(shape(groups)[0], ['pinned', ['about']]);
  assert.equal(groups.find((g) => g.key === 'account').folded, true);
});

test('every page has a glyph from the shell\'s own icon set', () => {
  const { Settings } = harness();
  const nav = loadTsx(NAV, {
    stubs: {
      './settings-nav-store.js': { settingsNavStore: { get: () => ({}), subscribe: () => () => {} } },
      '../../lib/i18n/react': { useMessages: () => englishPlatformI18n().t },
    },
  });
  for (const page of Settings._visiblePages()) {
    const name = Settings.ICONS[page.key];
    assert.ok(name, `${page.key} has a glyph`);
    assert.ok(nav.NAV_ICONS[name], `${name} is drawn by NAV_ICONS`);
  }
  const navSrc = read(NAV);
  const imported = navSrc.match(/import \{([^}]+)\} from '@\/components\/ui\/icons';/)[1].split(',').map((s) => s.trim()).filter(Boolean);
  for (const icon of imported) {
    assert.match(ICONS_TSX, new RegExp(`export (const|function) ${icon}\\b`), `${icon} is the shell's own`);
  }
  assert.doesNotMatch(navSrc, /<svg|<path/, 'no glyph drawn inline');
});

test('the catalog names the controls', () => {
  assert.equal(message('settings:nav.group.pinned'), 'Pinned');
  assert.equal(message('settings:nav.pin.add'), 'Pin {{page}} to the top');
  assert.equal(message('settings:nav.pin.remove'), 'Unpin {{page}}');
  assert.equal(message('settings:nav.pin.up'), 'Move {{page}} up');
  assert.equal(message('settings:nav.pin.down'), 'Move {{page}} down');
  assert.equal(message('settings:nav.fold.hide'), 'Hide {{group}}');
  assert.equal(message('settings:nav.fold.show'), 'Show {{group}}');
});

// ── Drawing ────────────────────────────────────────────────────────────

function renderNav(descriptor, which) {
  const real = require(require.resolve('react', { paths: [path.join(ROOT, 'frontend')] }));
  const React = {
    ...real,
    useState: () => ['', () => {}],
    useEffect() {},
    useSyncExternalStore: (subscribe, get) => get(),
  };
  const nav = loadTsx(NAV, {
    stubs: {
      react: React,
      './settings-nav-store.js': { settingsNavStore: { get: () => descriptor, subscribe: () => () => {} } },
      '../../lib/i18n/react': { useMessages: () => englishPlatformI18n().t },
    },
  });
  return nav[which]();
}

/** Expand function components as React would, so the whole tree is plain elements. */
function expand(n) {
  if (!n || typeof n !== 'object') return n;
  if (Array.isArray(n)) return n.map(expand);
  if (typeof n.type === 'function') return expand(n.type(n.props));
  if (n.type && n.type.render) return expand(n.type.render(n.props, null));
  if (!n.props) return n;
  return { ...n, props: { ...n.props, children: expand(n.props.children) } };
}

function all(tree, pred) {
  const out = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (pred(n)) out.push(n);
    if (n.props) walk(n.props.children);
  })(tree);
  return out;
}

const item = (key, label, extras) => ({
  key, label, terms: label.toLowerCase(), parts: [], subtitle: '', status: '', tag: '', icon: '', pinned: false,
  active: false, className: 'c', ...extras,
});

const DESKTOP = [
  { name: 'Pinned', key: 'pinned', folded: false, first: true, items: [
    item('ai', 'AI usage & models', { icon: 'sparkles', pinned: true }),
    item('language', 'Language', { icon: 'globe', pinned: true }),
  ] },
  { name: 'Account', key: 'account', folded: false, first: false, items: [
    item('account', 'Account', { icon: 'user', active: true }),
    item('phones', 'Linked phones', { icon: 'phone', status: '2 linked' }),
  ] },
  { name: 'Advanced', key: 'advanced', folded: true, first: false, items: [
    item('experimental', 'Experimental', { icon: 'bulb', tag: 'Beta' }),
  ] },
];

test('the sidebar draws a glyph, the pin controls and the fold arrows', () => {
  const tree = expand(renderNav({ desktop: DESKTOP, mobile: null, visit: 1 }, 'SettingsNavDesktop'));
  const rows = all(tree, (n) => n.props && n.props['data-settings-nav'] !== undefined && n.type === 'button');
  assert.deepEqual(rows.map((r) => r.props['data-settings-nav']), ['ai', 'language', 'account', 'phones'],
    'the folded Advanced group shows no rows (none of them is current)');
  for (const r of rows) assert.equal(all(r, (n) => n.type === 'svg').length, 1, 'one glyph per row');

  const labels = (pred) => all(tree, pred).map((n) => [n.props['aria-label'], !!n.props.disabled]);
  assert.deepEqual(labels((n) => n.props && n.props['data-settings-control'] === 'up'),
    [['Move AI usage & models up', true], ['Move Language up', false]]);
  assert.deepEqual(labels((n) => n.props && n.props['data-settings-control'] === 'down'),
    [['Move AI usage & models down', false], ['Move Language down', true]]);
  assert.deepEqual(labels((n) => n.props && n.props['data-settings-control'] === 'pin'), [
    ['Unpin AI usage & models', false], ['Unpin Language', false],
    ['Pin Account to the top', false], ['Pin Linked phones to the top', false],
  ]);
  const folds = all(tree, (n) => n.props && n.props['data-settings-group-fold'] !== undefined);
  assert.deepEqual(folds.map((f) => [f.props['data-settings-group-fold'], f.props['aria-expanded'], f.props['aria-label']]),
    [['account', true, 'Hide Account'], ['advanced', false, 'Show Advanced']], 'Pinned has no fold arrow');
  // Controls are siblings of the row's button, never inside it, and never a
  // [data-settings-nav] of their own (declared checks select on that).
  for (const r of rows) assert.equal(all(r.props.children, (n) => n.type === 'button').length, 0);
});

test('a folded sidebar group still shows the page you are on', () => {
  const desktop = [{ name: 'Advanced', key: 'advanced', folded: true, first: true, items: [
    item('experimental', 'Experimental', { icon: 'bulb', active: true }),
    item('other', 'Other', { icon: 'info' }),
  ] }];
  const tree = expand(renderNav({ desktop, mobile: null, visit: 1 }, 'SettingsNavDesktop'));
  const rows = all(tree, (n) => n.props && n.props['data-settings-nav'] !== undefined && n.type === 'button');
  assert.deepEqual(rows.map((r) => [r.props['data-settings-nav'], r.props['aria-current']]), [['experimental', 'page']]);
});

test('the phone menu draws the glyph as the row\'s leading, the controls beside it, and a folded group as its heading', () => {
  const mobile = DESKTOP.map(({ first, ...g }) => ({ ...g, items: g.items.map(({ active, className, ...i }) => i) }));
  const tree = renderNav({ desktop: null, mobile, visit: 1 }, 'SettingsMobileMenu');
  const listRows = all(tree, (n) => n.props && n.props['data-settings-nav'] !== undefined);
  assert.deepEqual(listRows.map((r) => r.props['data-settings-nav']), ['ai', 'language', 'account', 'phones'],
    'a folded group draws no rows');
  for (const r of listRows) {
    assert.ok(r.props.leading, `${r.props['data-settings-nav']} has a glyph`);
    assert.equal(r.props.inset, 'none', 'the wrapper draws the hairline');
  }
  const expanded = expand(tree);
  const pins = all(expanded, (n) => n.props && n.props['data-settings-control'] === 'pin');
  assert.equal(pins.length, 4, 'every row has its pin, always shown');
  // Every phone control is at least 44 by 44 (the shell's tap target).
  const controls = all(expanded, (n) => n.type === 'button' && n.props
    && (n.props['data-settings-control'] !== undefined || n.props['data-settings-group-fold'] !== undefined));
  assert.equal(controls.length, 4 + 2 * 2 + 2, 'four pins, two pinned rows\' arrows, two fold headings');
  for (const c of controls) {
    const { w, h } = tapSize(c.props.className);
    assert.ok(h >= 44, `${c.props['aria-label']} is at least 44px tall (${h})`);
    assert.ok(w >= 44, `${c.props['aria-label']} is at least 44px wide (${w})`);
  }
  // On a phone the whole heading is the fold button: the group's name is in it.
  const folds = all(expanded, (n) => n.props && n.props['data-settings-group-fold'] !== undefined);
  assert.deepEqual(folds.map((f) => [f.props['data-settings-group-fold'], f.props['aria-expanded']]),
    [['account', true], ['advanced', false]], 'the folded group keeps its heading');
  const text = (n) => (typeof n === 'string' ? n : Array.isArray(n) ? n.map(text).join('')
    : n && n.props ? text(n.props.children) : '');
  assert.equal(text(folds[1]), 'Advanced');
});

/**
 * The size a class string gives an element, in px: `h-N`/`w-N` (N × 4),
 * `min-h-[Npx]`, and `w-full` (wider than any tap target).
 */
function tapSize(className) {
  const size = (axis) => {
    if (axis === 'w' && /(^|\s)w-full(\s|$)/.test(className)) return Infinity;
    let best = 0;
    for (const m of className.matchAll(new RegExp(`(?:^|\\s)(?:min-)?${axis}-(\\d+(?:\\.\\d+)?|\\[(\\d+)px\\])(?=\\s|$)`, 'g'))) {
      best = Math.max(best, m[2] ? Number(m[2]) : Number(m[1]) * 4);
    }
    return best;
  };
  return { w: size('w'), h: size('h') };
}

test('after an unpin into a folded group, the keyboard lands on that group\'s fold arrow', () => {
  const nav = loadTsx(NAV, {
    stubs: {
      './settings-nav-store.js': { settingsNavStore: { get: () => ({}), subscribe: () => () => {} } },
      '../../lib/i18n/react': { useMessages: () => englishPlatformI18n().t },
    },
  });
  const focused = [];
  const el = (name) => ({ name, focus() { focused.push(name); } });
  // The host as it is after the unpin: Language's row is not drawn (its group
  // is folded), and the fold arrows are.
  const present = {
    '[data-settings-group-fold="preferences"]': el('fold:preferences'),
    '[data-settings-group-fold]': el('fold:first'),
  };
  const host = { querySelector: (sel) => present[sel] || null };
  const saved = { document: global.document, raf: global.requestAnimationFrame };
  global.document = { getElementById: (id) => (id === 'settings-nav-desktop' ? host : null) };
  global.requestAnimationFrame = (fn) => fn();
  try {
    nav.refocus('settings-nav-desktop', 'language', 'pin', 'preferences');
    assert.deepEqual(focused, ['fold:preferences']);
    // A row still drawn keeps the focus on its own control.
    const pin = el('pin:language');
    present['[data-settings-row="language"]'] = { querySelector: (sel) => (sel === '[data-settings-control="pin"]' ? pin : null) };
    nav.refocus('settings-nav-desktop', 'language', 'up', 'preferences');
    assert.deepEqual(focused, ['fold:preferences', 'pin:language'], 'a greyed-out arrow falls back to the row\'s pin');
  } finally {
    global.document = saved.document;
    global.requestAnimationFrame = saved.raf;
  }
});
