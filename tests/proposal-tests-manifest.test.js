// #47 "CI for proposals": app-manifest.readTests parses the top-level
// `tests` array — validating paths (same rules as a testing-block path),
// defaulting the name, carrying the optional assertions, deduping, and
// capping. Invalid / over-cap entries are dropped, never crash.
//
// Run with: node --test tests/proposal-tests-manifest.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const appManifest = require('../src/services/app-manifest');
const checkCap = require('./lib/check-cap');

test('absent / non-array tests resolve to []', () => {
  assert.deepEqual(appManifest.readTests({}), []);
  assert.deepEqual(appManifest.readTests({ tests: null }), []);
  assert.deepEqual(appManifest.readTests({ tests: 'nope' }), []);
  assert.deepEqual(appManifest.readTests(undefined), []);
});

test('a valid entry carries path, defaulted name, and assertions', () => {
  const out = appManifest.readTests({
    tests: [{ path: '/board?demo=1', name: 'Board renders', expectSelector: '.board' }],
  });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    name: 'Board renders',
    path: '/board?demo=1',
    expectSelector: '.board',
    expectText: null,
    allowConsoleErrors: false,
  });
});

test('name defaults to the path when missing/blank', () => {
  const out = appManifest.readTests({ tests: [{ path: '/x' }, { path: '/y', name: '  ' }] });
  assert.equal(out[0].name, '/x');
  assert.equal(out[1].name, '/y');
});

test('invalid paths are dropped (no scheme/host, single leading slash)', () => {
  const out = appManifest.readTests({
    tests: [
      { path: 'no-slash' },
      { path: '//evil.example' },
      { path: 'http://evil.example' },
      { path: '/ok' },
      { name: 'no path' },
      'not an object',
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].path, '/ok');
});

test('allowConsoleErrors + expectText pass through', () => {
  const out = appManifest.readTests({
    tests: [{ path: '/p', expectText: 'Hello', allowConsoleErrors: true }],
  });
  assert.equal(out[0].expectText, 'Hello');
  assert.equal(out[0].allowConsoleErrors, true);
});

test('a named visual scenario keeps its stable id and repository impact globs', () => {
  const [scenario] = appManifest.readTests({ tests: [{
    id: 'settings.profile-edit',
    name: 'Profile editor is ready',
    path: '/settings?demo=1',
    expectSelector: '#profile-editor',
    visual: true,
    impact: ['frontend/src/features/settings/**', 'public/js/profile-?.js'],
  }] });
  assert.deepEqual(scenario, {
    name: 'Profile editor is ready',
    path: '/settings?demo=1',
    expectSelector: '#profile-editor',
    expectText: null,
    allowConsoleErrors: false,
    id: 'settings.profile-edit',
    visual: true,
    impact: ['frontend/src/features/settings/**', 'public/js/profile-?.js'],
  });
});

test('bad or duplicate visual metadata never drops the underlying checks', () => {
  const meta = appManifest.readTestsWithMeta({ tests: [
    { id: 'bad id', path: '/a', visual: true, impact: ['frontend/**'] },
    { id: 'board.main', path: '/b', visual: true, impact: ['/absolute/**', '../escape/**'] },
    { id: 'board.main', path: '/c', expectSelector: '.board', visual: true, impact: ['frontend/board.js'] },
    { id: 'board.main', path: '/d', expectText: 'Board', visual: true, impact: ['frontend/other.js'] },
    { id: 'route.only', path: '/e', visual: true, impact: ['frontend/route.js'] },
  ] });
  assert.equal(meta.tests.length, 5, 'visual metadata does not control whether a check runs');
  assert.ok(meta.tests.slice(0, 2).every((t) => !('visual' in t)));
  assert.equal(meta.tests[2].visual, true);
  assert.ok(!('visual' in meta.tests[3]), 'one stable scenario id cannot name two flows');
  assert.ok(!('visual' in meta.tests[4]), 'a route without readiness is not a visual flow');
  assert.equal(meta.invalidVisualDropped, 4);
});

test('duplicate (name+path) entries collapse', () => {
  const out = appManifest.readTests({
    tests: [{ path: '/a', name: 'A' }, { path: '/a', name: 'A' }, { path: '/a', name: 'B' }],
  });
  // Same name+path collapses; a different name is a distinct test.
  assert.equal(out.length, 2);
});

// The old assertion here was `out.length === MAX_TESTS` with MAX_TESTS at
// 12 — i.e. it pinned the very cap that made 229 of this repo's declared
// checks unrunnable. #1019 replaced it with a much higher VALIDATION
// ceiling: the point is no longer to keep the suite small, it's to stop a
// pathological manifest queueing an unbounded one.
test('the list is bounded by MAX_DECLARED_TESTS, not by the old parse cap', () => {
  const many = Array.from(
    { length: appManifest.MAX_DECLARED_TESTS + 5 }, (_, i) => ({ path: `/r${i}` })
  );
  const out = appManifest.readTests({ tests: many });
  assert.equal(out.length, appManifest.MAX_DECLARED_TESTS);
  // And the ceiling is well clear of a real manifest — this repo's own is
  // the largest in the fleet and the whole bug was it being truncated.
  assert.ok(appManifest.MAX_DECLARED_TESTS >= 400,
    'a ceiling near a real manifest size silently drops checks again');
});

// The assertion above is about the constant; this one is about the actual
// manifest, which is what a ceiling can only ever be wrong RELATIVE TO. It
// crossed 300 and the tail was being dropped silently, so the ceiling is
// stated as headroom over the real count rather than as a bare number.
test("every declared selector fits the cap the reader and the capture clip at", () => {
  // readTests and capture/capture.js both `slice(0, 256)` a selector. A
  // longer one is not refused: it is cut mid-token, becomes an invalid
  // selector, and its check fails on every build with "was not found" —
  // which is how five checks of one proposal failed 6 of 6 runs while the
  // page they described was right. The cap is asserted here, on the
  // manifest as written, so the cut never happens silently again.
  const tests = require('../dapp.json').tests;
  const over = tests.filter((t) => typeof t.expectSelector === 'string' && t.expectSelector.length > 256)
    .map((t) => `${t.expectSelector.length}: ${t.name}`);
  assert.deepEqual(over, [], 'shorten these selectors: the runner clips them at 256 characters');
});

test("this repo's own manifest fits under the ceiling, with room to grow", () => {
  const meta = appManifest.readTestsWithMeta(require('../dapp.json'));
  assert.equal(meta.ceilingDropped, 0,
    `${meta.ceilingDropped} declared checks are past MAX_DECLARED_TESTS `
    + `${appManifest.MAX_DECLARED_TESTS} and are being dropped. ${checkCap.REMEDY}`);
  assert.equal(meta.tests.length, meta.rawCount,
    'every declared check survives validation, so the count here is the real one');
  // The same remedy as the other two guards (tests/lib/check-cap.js).
  checkCap.assertFloor(meta.tests.length);
});

test('readTestsWithMeta separates ceiling drops from invalid drops', () => {
  // The over-ceiling guard blocks a merge on `ceilingDropped`, so the two
  // reasons an entry can vanish must never be conflated: a manifest full of
  // malformed entries is a different complaint from one that is too long,
  // and only the second is about the limit.
  const valid = Array.from({ length: 3 }, (_, i) => ({ path: `/ok${i}` }));
  const bad = [{ path: 'no-leading-slash' }, { nope: true }, { path: '' }];
  const under = appManifest.readTestsWithMeta({ tests: valid.concat(bad) });
  assert.equal(under.tests.length, 3);
  assert.equal(under.rawCount, 6, 'rawCount counts what the manifest declared');
  assert.equal(under.ceilingDropped, 0, 'malformed entries are not ceiling drops');

  const over = appManifest.readTestsWithMeta({
    tests: Array.from({ length: appManifest.MAX_DECLARED_TESTS + 7 }, (_, i) => ({ path: `/r${i}` })),
  });
  assert.equal(over.tests.length, appManifest.MAX_DECLARED_TESTS);
  assert.equal(over.ceilingDropped, 7);
});

test('checkKey is stable, and distinguishes name from path', () => {
  // The key is the identity a check's earned gating hangs off, so it has to
  // be a pure function of (name, path) and it has to keep renames apart —
  // a rename SHOULD mint a new key and drop the check back to advisory.
  const a = appManifest.checkKey('Loads home', '/');
  assert.equal(a, appManifest.checkKey('Loads home', '/'), 'same input, same key');
  assert.notEqual(a, appManifest.checkKey('Loads Home', '/'), 'a rename is a new check');
  assert.notEqual(a, appManifest.checkKey('Loads home', '/home'), 'a repath is a new check');
  assert.match(a, /^[0-9a-f]{64}$/, 'sha256 hex, so it fits check_key VARCHAR(64)');
  // No delimiter collision: ('ab','c') and ('a','bc') must not collide.
  assert.notEqual(appManifest.checkKey('ab', '/c'), appManifest.checkKey('a', 'b/c'));
});

test('read() includes a tests array (empty when absent)', () => {
  // ENOENT path: a directory with no dapp.json returns the empty shape.
  const m = appManifest.read('/definitely/not/a/real/dir/xyz');
  assert.deepEqual(m.tests, []);
});
