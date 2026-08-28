// #app/<slug>/board and #app/<slug>/activity are ALIASES onto the existing dev
// vocabulary, not new screens — and they are aliases onto the SAME one: both
// resolve to the forum card area, and what tells them apart is the layout it
// is drawn in. Board is the kanban of work in flight; Activity is the same
// cards newest-first.
//
// That is a change of meaning for `activity`, which named the app's general
// chat for one round. The chat keeps `dev/chat`, the address it always had.
// The reason is recorded in public/js/app.js's own alias block: Kanban and
// Feed were the Improve panel's sub-strip under the Board row, and a display
// preference that changes what the screen is CALLED is a destination — so the
// layout rides the hash and the sub-strip is retired.
//
// Static-assertion style (cf. tests/hash-route-idempotence.test.js): the
// behaviour itself is covered by declared dapp.json checks on both hashes;
// what must not regress meanwhile is that old `dev` / `dev/chat` links and the
// two aliases resolve to the states they name.
//
// Run with: node --test tests/streamlined-route-aliases.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appJs = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

const body = (start, len = 2400) => {
  const from = appJs.indexOf(start);
  assert.ok(from > -1, `${start} exists`);
  return appJs.slice(from, from + len);
};

test('restoreFromHash rewrites the aliases onto the dev vocabulary', () => {
  const fn = body("if (parts[0] === 'app' && parts[1]) {", 3600);
  // Both aliases are the CARD AREA — `parts[3] = null`, the forum — and each
  // carries the layout the destination is named for.
  assert.match(fn, /tab === 'activity'.*parts\[3\] = null; boardView = 'feed'/s,
    'activity parses as the card area, drawn as the recency stream');
  assert.match(fn, /tab === 'board'.*parts\[3\] = null; boardView = 'kanban'/s,
    'board parses as the card area, drawn as the kanban');
  // Both rewrites must land BEFORE the dev-section switch reads parts[3],
  // or the aliases would fall through to the plain App tab.
  assert.ok(
    fn.indexOf("tab === 'activity'") < fn.indexOf("const sec = parts[3]"),
    'the rewrites precede the dev-section parse');
});

test('the route applies the layout, and re-renders when only the layout moved', () => {
  const fn = body("if (parts[0] === 'app' && parts[1]) {", 7400);
  // Set BEFORE the dispatch, so a cold entry paints the named layout on the
  // board's first frame instead of flashing the stored one.
  assert.match(fn, /AppView\._setViewMode\(boardView\)/,
    'the resolved layout is published to the module');
  assert.ok(
    fn.indexOf('AppView._setViewMode(boardView)') < fn.indexOf('App.navigateToApp('),
    'and published before the dispatch that renders the board');
  // Board ⇄ Activity leaves `tab` and `subTab` identical, so without this the
  // guarded re-dispatch below would decide nothing had changed and the switch
  // would silently do nothing.
  assert.match(fn, /AppView\._getViewMode\(\) !== boardView/,
    'the change is detected against the mode already resolved');
  assert.match(fn, /\|\| boardViewChanged\) \{/,
    'and forces the re-render the tab/sub-tab comparison would skip');
});

test('updateHash names the card area for the layout it is drawn in', () => {
  const fn = body('newHash = `#app/${App.currentApp}/dev/sessions/', 1600);
  assert.match(fn, /App\.currentSubTab === 'chat'[\s\S]{0,320}\/dev\/chat`/,
    'the general chat writes its own address, not /activity');
  assert.match(fn, /AppView\._getViewMode\(\) === 'feed'[\s\S]{0,200}feed \? 'activity' : 'board'/,
    'and the card area writes whichever of the two names its layout gives it');
});

test('updateHash treats the two aliases and the canonical form as one screen', () => {
  const fn = body('const screenIdOf = (h) => {', 1200);
  // ONE screen for history, deliberately: switching layout is not somewhere to
  // go back FROM, which is also why the retired Kanban|Feed strip pushed no
  // entry. What this pins is that neither alias can produce a spurious push
  // against the canonical `dev` form updateHash computes.
  assert.match(fn, /segs\[2\] === 'activity' \|\| segs\[2\] === 'board'[\s\S]{0,160}splice\(2, 1, 'dev'\)/,
    'both aliases normalize to dev for screen identity');
});
