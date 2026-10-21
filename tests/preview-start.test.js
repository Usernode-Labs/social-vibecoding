// #4917 — the page a change's preview opens on.
//
// A preview of a change always opened on the app's first screen, so a
// reviewer pressing Try it on a settings change had to find the changed page
// themselves. services/preview-start.js reads the page off the change: the
// first declared shots story start path that is not `/`, else the build's
// testing deep link when it is not `/`, else null (root, as before). This
// suite pins that order and the guard rails around it; the route-level shape
// of the answer is pinned in tests/ensure-staging.test.js and the iframe
// opening in tests/staging-iframe-identity.test.js.
//
// Run with: node --test tests/preview-start.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const previewStart = require('../src/services/preview-start');

// A story as the plan contract stores it (services/visible-changes.js): the
// declared change with its intent, whose startPath names where its shots
// begin.
function sessionWithStories(stories, extra = {}) {
  return {
    shots_detail: { version: 1, intent: { impact: 'ui', stories } },
    ...extra,
  };
}

function story(startPath) {
  return { id: 's1', claim: 'It works', persona: 'member', intent: { startPath } };
}

test('the first story start path that is not the root wins', () => {
  const session = sessionWithStories([story('/'), story('/settings')]);
  assert.equal(previewStart.startPathFor(session), '/settings',
    'a story that starts at `/` says nothing about where the change shows');
});

test('stories are taken in declaration order', () => {
  const session = sessionWithStories([story('/rota?week=2'), story('/settings')]);
  assert.equal(previewStart.startPathFor(session), '/rota?week=2');
});

test('a start path of `/` alone counts as no page: the testing link wins over it', () => {
  const session = sessionWithStories([story('/')], { testing_path: '/rota?week=2' });
  assert.equal(previewStart.startPathFor(session), '/rota?week=2');
});

test('a declared page beats the testing deep link', () => {
  const session = sessionWithStories([story('/settings')], { testing_path: '/rota?week=2' });
  assert.equal(previewStart.startPathFor(session), '/settings');
});

test('with no declaration, the testing deep link is the start page', () => {
  assert.equal(previewStart.startPathFor({ shots_detail: null, testing_path: '/rota?week=2' }),
    '/rota?week=2');
});

test('root-testing path with nothing declared is no page either', () => {
  assert.equal(previewStart.startPathFor({ testing_path: '/' }), null);
});

test('nothing declared anywhere opens at the root (null)', () => {
  assert.equal(previewStart.startPathFor({}), null);
  assert.equal(previewStart.startPathFor(null), null);
  assert.equal(previewStart.startPathFor({ shots_detail: { intent: { impact: 'none', stories: [] } } }), null,
    'an impact "none" declaration has no stories and names no page');
});

test('a stored path that fails validatePath is skipped, not an error', () => {
  // Protocol-relative, whitespace-laden and missing-slash paths all fail
  // testing-notes.validatePath; the walk moves on to the next candidate.
  assert.equal(previewStart.startPathFor(sessionWithStories([story('//evil.example'), story('/settings')])),
    '/settings');
  assert.equal(previewStart.startPathFor(sessionWithStories([story('settings')])), null);
  assert.equal(previewStart.startPathFor(sessionWithStories([story('  ')])), null);
});

test('a valid-looking start path that is `/` after validation falls through to testing_path', () => {
  assert.equal(previewStart.startPathFor(sessionWithStories([story('/')]), {}),
    null);
  assert.equal(previewStart.startPathFor(sessionWithStories([story('/')], { testing_path: '/rota' })),
    '/rota');
});

test('malformed shots_detail gives null, never a throw', () => {
  assert.equal(previewStart.startPathFor({ shots_detail: 'not an object' }), null);
  assert.equal(previewStart.startPathFor({ shots_detail: { intent: null } }), null);
  assert.equal(previewStart.startPathFor({ shots_detail: { intent: { stories: 'nope' } } }), null);
  assert.equal(previewStart.startPathFor({ shots_detail: { intent: { stories: [null, 7, 'x'] } } }), null,
    'junk entries are skipped, not fatal');
  assert.equal(previewStart.startPathFor({ shots_detail: { intent: { stories: [{ intent: {} }] } } }), null);
});

test('previewAnswer carries startPath only when there is one', () => {
  assert.deepEqual(previewStart.previewAnswer(sessionWithStories([story('/settings')])),
    { startPath: '/settings' });
  assert.deepEqual(previewStart.previewAnswer({}), {},
    'an answer without a page is empty, so every other answer stays byte-identical');
  assert.deepEqual(previewStart.previewAnswer(null), {});
});

test('a self-app hash-route path passes through as-is', () => {
  // The self-app's pages are hash routes behind a clean /app/<slug> path;
  // validatePath accepts it and the client's _selfAppHashPath turns it into
  // a fragment route. preview-start must not get in the way of that.
  assert.equal(previewStart.startPathFor({ testing_path: '/app/x/dev' }), '/app/x/dev');
});