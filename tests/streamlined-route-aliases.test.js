// The Streamlined Concept's two destination hashes are ALIASES onto the
// existing dev vocabulary, not new screens: #app/<slug>/activity is the
// general chat stream (what dev/chat always was) and #app/<slug>/board is
// the forum card area (feed and kanban are both board modes). These
// static assertions pin the two rewrite points a refactor could silently
// undo — the router's parse and updateHash's screen-identity normalizer.
//
// Static-assertion style (cf. tests/hash-route-idempotence.test.js): the
// behaviour itself is covered by declared dapp.json checks once the
// app-context sheet lands; what must not regress meanwhile is that old
// `dev` / `dev/chat` links and the new aliases resolve to the same state.
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
  const fn = body("if (parts[0] === 'app' && parts[1]) {", 3200);
  assert.match(fn, /tab === 'activity'.*parts\[3\] = 'chat'/s,
    'activity parses as the general chat sub-view');
  assert.match(fn, /tab === 'board'.*parts\[3\] = null/s,
    'board parses as the forum card area');
  // Both rewrites must land BEFORE the dev-section switch reads parts[3],
  // or the aliases would fall through to the plain App tab.
  assert.ok(
    fn.indexOf("tab === 'activity'") < fn.indexOf("const sec = parts[3]"),
    'the rewrites precede the dev-section parse');
});

test('updateHash treats an alias and its canonical form as one screen', () => {
  const fn = body('const screenIdOf = (h) => {', 1200);
  assert.match(fn, /segs\[2\] === 'activity'.*'dev', 'chat'/s,
    'activity normalizes to dev/chat for screen identity');
  assert.match(fn, /segs\[2\] === 'board'.*'dev'/s,
    'board normalizes to dev for screen identity');
});
