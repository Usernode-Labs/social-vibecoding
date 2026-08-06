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

test('duplicate (name+path) entries collapse', () => {
  const out = appManifest.readTests({
    tests: [{ path: '/a', name: 'A' }, { path: '/a', name: 'A' }, { path: '/a', name: 'B' }],
  });
  // Same name+path collapses; a different name is a distinct test.
  assert.equal(out.length, 2);
});

test('the list is kept up to the MAX_DECLARED_TESTS ceiling (#998)', () => {
  // readTests no longer cuts at the per-run MAX_TESTS — per-run selection
  // is selectTestsForRun's job. The reader keeps everything valid up to
  // the declared ceiling, past which entries are dropped (and visuals
  // fails the proposal that grew the list there).
  const many = Array.from({ length: appManifest.MAX_DECLARED_TESTS + 5 }, (_, i) => ({ path: `/r${i}` }));
  const out = appManifest.readTests({ tests: many });
  assert.equal(out.length, appManifest.MAX_DECLARED_TESTS);
  assert.ok(appManifest.MAX_DECLARED_TESTS > appManifest.MAX_TESTS + appManifest.TEST_ROTATION_SLOTS,
    'the ceiling sits above the per-run budget, or rotation would be pointless');
});

// #998: per-run selection — head always runs, the tail rotates.
test('selectTestsForRun runs everything when within the per-run budget', () => {
  const budget = appManifest.MAX_TESTS + appManifest.TEST_ROTATION_SLOTS;
  const list = Array.from({ length: budget }, (_, i) => ({ name: `t${i}`, path: `/r${i}` }));
  const sel = appManifest.selectTestsForRun(list, 'abc123');
  assert.equal(sel.rotated, false);
  assert.equal(sel.declared, budget);
  assert.deepEqual(sel.selected.map((t) => t.name), list.map((t) => t.name));
  assert.ok(sel.selected.every((t) => !t.rotating), 'no advisory flag when nothing rotates');
});

test('selectTestsForRun keeps the head and fills the rest from a rotating window', () => {
  const budget = appManifest.MAX_TESTS + appManifest.TEST_ROTATION_SLOTS;
  const list = Array.from({ length: budget + 15 }, (_, i) => ({ name: `t${i}`, path: `/r${i}` }));
  const sel = appManifest.selectTestsForRun(list, 'seed-1');
  assert.equal(sel.rotated, true);
  assert.equal(sel.selected.length, budget);
  // The head is verbatim, in order, non-advisory.
  for (let i = 0; i < appManifest.MAX_TESTS; i++) {
    assert.equal(sel.selected[i].name, `t${i}`);
    assert.ok(!sel.selected[i].rotating);
  }
  // The window comes from the tail only, and is flagged advisory.
  for (let i = appManifest.MAX_TESTS; i < budget; i++) {
    const idx = Number(sel.selected[i].name.slice(1));
    assert.ok(idx >= appManifest.MAX_TESTS, 'window entries come from past the head');
    assert.equal(sel.selected[i].rotating, true);
  }
});

test('selectTestsForRun is deterministic per seed and covers the tail across seeds', () => {
  const budget = appManifest.MAX_TESTS + appManifest.TEST_ROTATION_SLOTS;
  const list = Array.from({ length: budget + 15 }, (_, i) => ({ name: `t${i}`, path: `/r${i}` }));
  const a1 = appManifest.selectTestsForRun(list, 'commit-a');
  const a2 = appManifest.selectTestsForRun(list, 'commit-a');
  assert.deepEqual(a1.selected.map((t) => t.name), a2.selected.map((t) => t.name),
    'the same commit always runs the same subset (re-runs reproduce failures)');
  // Sliding the seed over many values reaches every tail entry — nothing
  // is permanently dead the way over-cap entries used to be.
  const seen = new Set();
  for (let s = 0; s < 64; s++) {
    for (const t of appManifest.selectTestsForRun(list, `commit-${s}`).selected) seen.add(t.name);
  }
  for (let i = 0; i < list.length; i++) {
    assert.ok(seen.has(`t${i}`), `t${i} runs under some seed`);
  }
});

test('the repo dapp.json itself stays inside the ceiling with unique name+path entries', () => {
  // The 234-entry pile-up (#998) is what these bounds exist to prevent —
  // keep the platform's own manifest honest: every declared check parses,
  // survives the ceiling, and no (name+path) duplicate wastes a slot.
  const fs = require('fs');
  const path = require('path');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dapp.json'), 'utf8'));
  const declared = manifest.tests.length;
  assert.ok(declared <= appManifest.MAX_DECLARED_TESTS,
    `dapp.json declares ${declared} tests — past ${appManifest.MAX_DECLARED_TESTS} they would never run`);
  const parsed = appManifest.readTests(manifest);
  assert.equal(parsed.length, declared, 'every declared entry parses (nothing invalid/duplicate)');
});

test('read() includes a tests array (empty when absent)', () => {
  // ENOENT path: a directory with no dapp.json returns the empty shape.
  const m = appManifest.read('/definitely/not/a/real/dir/xyz');
  assert.deepEqual(m.tests, []);
});
