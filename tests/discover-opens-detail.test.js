// A Discover tap opens the app's detail page, not the app (#1562).
//
// Discover is a shelf of apps the reader has not met. Launching one on a tap
// is right on the home grid, where every tile is something they already chose;
// here it drops a stranger inside a thing they could not first read anything
// about — what it is, who builds it, how many people use it.
//
// `#apps/<slug>` is that page and it already exists, with an Open button one
// tap further on and the Add control the request wanted the card to stop
// carrying alone.
//
// Scope matters: `_wireDiscoveryCards` binds the DISCOVER lanes only (its one
// caller is panels/discover.tsx). The launcher grid is app-grid.tsx's and is
// untouched, which is the whole reason this change is safe to make.
//
// Run with: node --test tests/discover-opens-detail.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HOME = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/home/home.js'), 'utf8');
const DISCOVER = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/home/panels/discover.tsx'), 'utf8');

/** The wiring block, from the querySelectorAll to the end of `activate`. */
function wiring() {
  const at = HOME.indexOf("_wireDiscoveryCards(listEl, onChange) {");
  assert.notEqual(at, -1);
  const block = HOME.slice(at);
  return block.slice(0, block.indexOf('NavLink.wireModified'));
}

test('both the plain tap and the modified click name the detail route', () => {
  const body = wiring();
  assert.match(body, /const detailHref = \(slug\) => `#apps\/\$\{encodeURIComponent\(slug\)\}`;/);
  // hrefFor is what cmd/middle-click opens; activate is the plain tap. They
  // must agree, or a modified click would go somewhere the tap does not.
  assert.match(body, /return card\.dataset\.slug \? detailHref\(card\.dataset\.slug\) : null;/);
  assert.match(body, /location\.hash = detailHref\(card\.dataset\.slug\);/);
  // And neither launches the app any more.
  assert.doesNotMatch(body, /App\.navigateToApp\(/);
  assert.doesNotMatch(body, /_appUrl\(card\.dataset\.slug, 'app'/);
});

test('the detail page is told there is no list behind it', () => {
  // Without this its back control is a chevron to a browse list the reader
  // never saw; with it, the house. browse.js `_syncChrome` reads the note.
  assert.match(wiring(), /window\.Browse\?\.noteDetailOrigin\?\.\('home'\)/);
});

test('every guard survives, on both paths', () => {
  const body = wiring();
  const hrefFor = body.slice(body.indexOf('const hrefFor'), body.indexOf('const activate'));
  const activate = body.slice(body.indexOf('const activate'));
  for (const guard of [
    "closest('.card-add-btn')",
    "closest('.card-menu-btn')",
    "card.dataset.demo === 'true'",
    'awaiting_secrets',
  ]) {
    assert.ok(hrefFor.includes(guard), `hrefFor keeps the ${guard} guard`);
    assert.ok(activate.includes(guard), `activate keeps the ${guard} guard`);
  }
});

test('the launcher grid is not touched by this', () => {
  // One caller, and it is the Discover panel.
  const callers = HOME.match(/_wireDiscoveryCards\(/g) || [];
  assert.equal(callers.length, 1, 'defined once in home.js, called from the panel');
  assert.match(DISCOVER, /home\(\)\?\._wireDiscoveryCards\?\.\(el\)/);
});

test('the add badge stays, deliberately', () => {
  // The request also asked to drop the per-card + buttons. That badge is
  // #1567's, and a declared check ("Adding from Discover lands in Your apps
  // with no reload") exercises its round trip — so removing it is a separate
  // decision, not a consequence of this one. With the tap now going to a page
  // rather than into the app, the badge is also the only one-tap add left.
  const body = wiring();
  assert.ok(body.includes("closest('.card-add-btn')"),
    'the badge still takes its own taps');
  const wire = HOME.slice(HOME.indexOf('_wireDiscoveryCards(listEl, onChange) {'));
  assert.match(wire.slice(0, 3000), /querySelectorAll\('\.card-add-btn'\)/,
    'and is still wired');
});
