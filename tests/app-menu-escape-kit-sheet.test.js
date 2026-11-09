// #5927 item 10: Esc closes the Homeroom menu on a phone or tablet too.
//
// There the menu is adopted into the kit's bottom sheet (presentSheet), which
// answers a swipe and a tap on its backdrop but never Escape: it does not join
// the kit's modal stack. The island used to skip every key while the menu was
// adopted, on the belief that the kit owned Escape, so on an iPad or an
// Android phone with a keyboard Esc did nothing. Now the island closes the
// adopted sheet itself, unless something above it takes the key.
//
// Run with: node --test tests/app-menu-escape-kit-sheet.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const { kitSheetTakesEscape } = loadTsx('frontend/src/features/app-context/kit-escape.ts');

// A page just big enough for the helper: elements in document order, each
// with a class list and a parent, and the three lookups it makes.
function page({ before } = {}) {
  const all = [];
  const el = (cls, parent = null, attrs = {}) => {
    const node = {
      cls, parent, attrs,
      contains(other) {
        for (let n = other; n; n = n.parent) if (n === node) return true;
        return false;
      },
    };
    all.push(node);
    return node;
  };
  const matches = (node, selector) => selector.split(',').some((part) => {
    const s = part.trim();
    if (s.startsWith('.')) return node.cls.split(' ').includes(s.slice(1));
    if (s.startsWith('[') && s.endsWith(']')) return Object.hasOwn(node.attrs, s.slice(1, -1));
    if (s.startsWith('#')) return node.attrs.id === s.slice(1);
    return false;
  });
  const doc = {
    querySelectorAll: (sel) => all.filter((n) => matches(n, sel)),
    querySelector: (sel) => all.find((n) => matches(n, sel)) || null,
    getElementById: (id) => all.find((n) => n.attrs.id === id) || null,
  };
  // The kit's sheet with the menu adopted into its body, as presentSheet
  // builds it: backdrop, then .un-sheet > .un-sheet-body > #apps-switcher-sheet.
  if (before) before(el);
  el('un-backdrop');
  const sheet = el('un-sheet');
  const body = el('un-sheet-body', sheet);
  el('fixed z-50', body, { id: 'apps-switcher-sheet' });
  return { doc, el };
}

// The same page with one more kit surface created BEFORE the menu's sheet.
function pageWith(cls) {
  const { doc, el } = page({ before: (mk) => mk(cls) });
  return { doc, el };
}

const key = (k, defaultPrevented = false) => ({ key: k, defaultPrevented });

test('Escape on the adopted menu closes it', () => {
  const { doc } = page();
  assert.equal(kitSheetTakesEscape(key('Escape'), doc, 'apps-switcher-sheet'), true);
});

test('other keys are left alone', () => {
  const { doc } = page();
  for (const k of ['ArrowDown', 'Enter', 'Tab', 'Esc ']) {
    assert.equal(kitSheetTakesEscape(key(k), doc, 'apps-switcher-sheet'), false, k);
  }
});

test('a key a kit modal or popover already took does not also close the menu', () => {
  const { doc } = page();
  assert.equal(kitSheetTakesEscape(key('Escape', true), doc, 'apps-switcher-sheet'), false);
});

test('a kit surface opened above the menu keeps the menu open', () => {
  // An alert that cannot be dismissed takes Escape without preventing it.
  for (const cls of ['un-alert', 'un-modal', 'un-action-sheet', 'un-panel', 'un-popover', 'un-sheet']) {
    const { doc, el } = page();
    el('un-backdrop un-backdrop-fade');
    el(cls);
    assert.equal(kitSheetTakesEscape(key('Escape'), doc, 'apps-switcher-sheet'), false, cls);
  }
});

test('a modal, alert or popover keeps the menu open even when it opened first', () => {
  // native.css stacks these at 9992, over the sheet's 9991, so an earlier
  // one is still on top of the menu whatever the document order says.
  for (const cls of ['un-alert', 'un-modal', 'un-popover']) {
    const { doc } = pageWith(cls);
    assert.equal(kitSheetTakesEscape(key('Escape'), doc, 'apps-switcher-sheet'), false, cls);
  }
  // A sheet that opened BEFORE the menu is under it, so Escape is the menu's.
  const { doc } = pageWith('un-sheet');
  assert.equal(kitSheetTakesEscape(key('Escape'), doc, 'apps-switcher-sheet'), true);
});

test('an overlay that owns Escape keeps it', () => {
  const { doc, el } = page();
  el('picture', null, { 'data-owns-escape': '' });
  assert.equal(kitSheetTakesEscape(key('Escape'), doc, 'apps-switcher-sheet'), false);
});

test('nothing to close when the menu is not in a kit sheet', () => {
  const { doc } = page();
  assert.equal(kitSheetTakesEscape(key('Escape'), doc, 'no-such-sheet'), false);
});

test('the island hands Escape on the adopted menu to the helper and closes it', () => {
  const ISLAND = read('frontend/src/features/app-context/index.tsx');
  assert.match(ISLAND, /import \{ kitSheetTakesEscape \} from '\.\/kit-escape';/);
  assert.match(ISLAND,
    /if \(AppContext\._sheet\) \{\s*if \(kitSheetTakesEscape\(event, document, 'apps-switcher-sheet'\)\) void AppContext\.close\(\);\s*return;\s*\}/,
    'adopted: Escape closes the kit sheet, every other key stays the kit\'s');
  // The listener is registered whenever the menu is open, adopted or not.
  assert.match(ISLAND, /useEffect\(\(\) => \{\s*if \(!open\) return undefined;\s*const sheet = \(\) => document\.getElementById\('apps-switcher-sheet'\);/);

  // And the premise: the kit's sheet really has no Escape of its own, so
  // without this the key would do nothing. presentSheet never joins the
  // modal stack the kit's Escape listener reads.
  const KIT = read('public/usernode-native/v1/native.js');
  const start = KIT.indexOf('function presentSheet(options)');
  const end = KIT.indexOf('\n  }\n', start);
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(KIT.slice(start, end), /modalStack|Escape/);
});
