// #47 "CI for proposals": app-manifest.readTests parses the top-level
// `tests` array — validating paths (same rules as a testing-block path),
// defaulting the name, carrying the optional assertions, deduping, and
// capping. Invalid / over-cap entries are dropped, never crash.
//
// Run with: node --test tests/proposal-tests-manifest.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const appManifest = require('../src/services/app-manifest');

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
    steps: [],
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

test('workflow steps are closed, bounded, and normalize safe assertions', () => {
  const many = Array.from({ length: appManifest.MAX_TEST_STEPS + 2 }, (_, i) => ({
    action: i % 2 ? 'expect' : 'click',
    selector: ` #step-${i} `,
    text: 'Visible',
    valueExcludes: 'token=',
    attribute: 'href',
    attributeIncludes: 'http',
  }));
  const [entry] = appManifest.readTests({ tests: [{ path: '/', steps: many }] });
  assert.equal(entry.steps.length, appManifest.MAX_TEST_STEPS);
  assert.deepEqual(entry.steps[0], { action: 'click', selector: '#step-0' });
  assert.deepEqual(entry.steps[1], {
    action: 'expect', selector: '#step-1', text: 'Visible',
    valueExcludes: 'token=', attribute: 'href', attributeIncludes: 'http',
  });
});

test('invalid workflow actions, selectors, and attribute names fail closed without forwarding input', () => {
  const steps = appManifest.readTestSteps([
    { action: 'evaluate', selector: '#x', source: 'danger()' },
    { action: 'click', selector: '  ' },
    { action: 'expect', selector: '#ok', attribute: 'href onclick', attributeIncludes: 'x', valueIncludes: 'safe' },
  ]);
  assert.deepEqual(steps, [
    { action: 'invalid', selector: 'html' },
    { action: 'invalid', selector: 'html' },
    { action: 'invalid', selector: 'html' },
  ]);
});

test('duplicate (name+path) entries collapse', () => {
  const out = appManifest.readTests({
    tests: [{ path: '/a', name: 'A' }, { path: '/a', name: 'A' }, { path: '/a', name: 'B' }],
  });
  // Same name+path collapses; a different name is a distinct test.
  assert.equal(out.length, 2);
});

test('the list is capped at MAX_TESTS', () => {
  const many = Array.from({ length: appManifest.MAX_TESTS + 5 }, (_, i) => ({ path: `/r${i}` }));
  const out = appManifest.readTests({ tests: many });
  assert.equal(out.length, appManifest.MAX_TESTS);
});

test('read() includes a tests array (empty when absent)', () => {
  // ENOENT path: a directory with no dapp.json returns the empty shape.
  const m = appManifest.read('/definitely/not/a/real/dir/xyz');
  assert.deepEqual(m.tests, []);
});
