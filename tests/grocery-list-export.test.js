'use strict';

// The Grocery list's Export list (#5783): the menu's new option opens a
// dialog holding everything not ticked off yet as a plain checklist, to copy
// or to share. It only reads the list the screen already has: no request, no
// undo step, and the ticks are left exactly as they were. The starter is a
// browser script, so this reads its source and runs the one function whose
// output matters (buildChecklist) against stubbed list data.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'app-templates/grocery-list/public/app.js'), 'utf8');

// The whole body of a top-level `function name() { … }` in the starter.
function bodyOf(name) {
  const start = SOURCE.indexOf(`  function ${name}() {`);
  assert.ok(start > -1, `${name} is defined`);
  const end = SOURCE.indexOf('\n  }\n', start);
  assert.ok(end > start, `${name} ends`);
  return SOURCE.slice(start, end + 4);
}

// Run buildChecklist with its three helpers stubbed, in the start's own scope.
function checklistWith({ name = 'Groceries', categories, unchecked = {} }) {
  const context = {
    listName: () => name,
    displayCategories: () => categories,
    sectionItems: (catId, checked) => (checked ? [] : (unchecked[catId] || [])),
  };
  vm.createContext(context);
  return vm.runInContext(`${bodyOf('buildChecklist')}\nbuildChecklist();`, context);
}

test('the menu offers Export list, just above Export markdown', () => {
  const menu = bodyOf('menuItems');
  const list = menu.indexOf("{ label: 'Export list', handler: openChecklist }");
  const markdown = menu.indexOf("{ label: 'Export markdown', handler: openExport }");
  assert.ok(list > -1, 'Export list is in the menu');
  assert.ok(markdown > -1, 'Export markdown is still in the menu');
  assert.ok(list < markdown, 'Export list comes first');
});

test('buildChecklist: General first with no heading, unticked items only, empty categories left out', () => {
  const out = checklistWith({
    // In the order displayCategories() returns them: General first.
    categories: [
      { id: 1, name: 'General', is_default: 1 },
      { id: 2, name: 'Produce', is_default: 0 },
    ],
    unchecked: {
      1: [{ text: 'Milk' }, { text: 'Bread' }],
      2: [{ text: 'Apples' }],
    },
  });
  assert.equal(out, 'Groceries\n\n☐ Milk\n☐ Bread\n\nProduce\n☐ Apples\n');
  assert.doesNotMatch(out, /General/, 'the general bucket has no heading');
  assert.doesNotMatch(out, /\*|~~|#/, 'plain text, no markdown');
});

test('buildChecklist: ticked items and categories with nothing left are left out', () => {
  // sectionItems(catId, false) is what the screen shows as open, so Lemons
  // being ticked is exactly its absence here.
  const out = checklistWith({
    categories: [
      { id: 1, name: 'General', is_default: 1 },
      { id: 2, name: 'Produce', is_default: 0 },
      { id: 3, name: 'Dairy', is_default: 0 },
    ],
    unchecked: { 1: [{ text: 'Milk' }], 2: [{ text: 'Apples' }] },
  });
  assert.equal(out, 'Groceries\n\n☐ Milk\n\nProduce\n☐ Apples\n');
  assert.doesNotMatch(out, /Lemons|Dairy/);
});

test('buildChecklist: an empty string when everything is ticked off', () => {
  assert.equal(checklistWith({
    categories: [{ id: 1, name: 'General', is_default: 1 }],
    unchecked: { 1: [] },
  }), '');
  assert.equal(checklistWith({ categories: [], unchecked: {} }), '');
});

// Share is offered only where the browser can open a share sheet.
function shareAllowed({ share, policy }) {
  const context = {
    navigator: share ? { share: () => Promise.resolve() } : {},
    document: policy ? { featurePolicy: policy } : {},
  };
  vm.createContext(context);
  return vm.runInContext(`${bodyOf('canShare')}\ncanShare();`, context);
}

test('canShare: only where the browser has a share sheet, and not where its policy refuses one', () => {
  const allows = (known, yes) => ({ features: () => known, allowsFeature: () => yes });
  assert.equal(shareAllowed({ share: false }), false, 'no share sheet, no Share');
  assert.equal(shareAllowed({ share: true }), true, 'a share sheet, with no policy to ask');
  assert.equal(shareAllowed({ share: true, policy: allows(['web-share'], true) }), true);
  assert.equal(shareAllowed({ share: true, policy: allows(['web-share'], false) }), false,
    'a browser that knows web-share and refuses it hides Share (the app frame)');
  // Chromium lists no `web-share` in its features: it cannot answer, so it
  // refuses on the tap and the list is copied instead.
  assert.equal(shareAllowed({ share: true, policy: allows([], false) }), true);
  assert.equal(shareAllowed({ share: true, policy: { allowsFeature: () => { throw new Error('nope'); } } }), true);
});

test('opening the checklist writes nothing: no request, no undo step, no re-render', () => {
  const source = bodyOf('openChecklist');
  for (const call of ['api(', 'record(', 'queue(', 'saveCopy(', 'render(', 'refresh(']) {
    assert.ok(!source.includes(call), `openChecklist does not call ${call}`);
  }
  assert.doesNotMatch(source, /generation\+\+/, 'no undo step');
  // Share only exists where the browser has it.
  assert.match(source, /canShare\(\)/);
  assert.match(bodyOf('canShare'), /typeof navigator\.share/);
  // Copy and Share go through the checklist the dialog is showing.
  assert.match(source, /copyText\(text/);
  assert.match(source, /navigator\.share\(\{ title: listName\(\), text: text\.value \}\)/);
});
