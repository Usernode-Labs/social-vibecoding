'use strict';

// One owner per screen root's `hidden` class.
//
// A converted screen renders its own `hidden` through
// `useVisibilityHiddenClass(ref, id, shippedVisible)`, which re-applies on
// EVERY publish of ANY id (the store notifies all listeners) and treats an
// unpublished id as its shipped state. So the moment an island takes that
// hook, app.js has to publish that id rather than toggle the class itself —
// which is what listing it in App.REACT_SCREEN_IDS does. Miss the listing and
// there are two owners: app.js toggles the class off, the next unrelated
// publish (a header toggle, an admin button, a badge — all fetch-driven and
// variably timed) re-applies it, and the screen is visible or not by the
// order in which things arrived. That is how #messages-screen went missing
// from six declared checks on proposals that had not touched it.
//
// This pins the invariant for every screen at once, derived from the sources
// rather than from a hand-kept list, so the next conversion cannot repeat it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');

function arrayLiteral(name) {
  // `(?<![A-Z_])` so SCREEN_IDS does not match inside REACT_SCREEN_IDS, and
  // comments are dropped before the quote scan: a prose apostrophe
  // ("the anonymous shell's screens") desynchronises a naive '…' match and
  // turns every entry after it into garbage.
  const m = new RegExp(`(?<![A-Z_])${name}:\\s*\\[([\\s\\S]*?)\\]`).exec(app);
  assert.ok(m, `${name} is an array literal in app.js`);
  const body = m[1].replace(/\/\/[^\n]*/g, '');
  return [...body.matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(p);
  }
  return out;
}

test('every screen root an island owns through useVisibilityHiddenClass is in REACT_SCREEN_IDS', () => {
  const screenIds = new Set(arrayLiteral('SCREEN_IDS'));
  const reactOwned = new Set(arrayLiteral('REACT_SCREEN_IDS'));
  const hookIds = new Set();
  for (const file of walk(path.join(ROOT, 'frontend/src'))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/useVisibilityHiddenClass\([^,]+,\s*'([^']+)'/g)) hookIds.add(m[1]);
  }
  const islandScreens = [...hookIds].filter((id) => screenIds.has(id)).sort();
  assert.ok(islandScreens.length > 0, 'at least one screen root uses the hook (the seam exists)');
  const missing = islandScreens.filter((id) => !reactOwned.has(id));
  assert.deepEqual(missing, [],
    `screens whose island owns \`hidden\` but app.js still toggles it: ${missing.join(', ')}`);
});

test('REACT_SCREEN_IDS names only real screen roots or auth screens', () => {
  // The other direction, so a stale entry cannot make app.js publish an id
  // nothing renders: every listed id is a SCREEN_IDS root or an auth screen.
  const screenIds = new Set(arrayLiteral('SCREEN_IDS'));
  for (const id of arrayLiteral('REACT_SCREEN_IDS')) {
    assert.ok(screenIds.has(id) || /^auth-/.test(id), `${id} is a screen root or an auth screen`);
  }
});
