// #47 "CI for proposals": the capture-container test runner env parsing
// (capture/capture.js resolveTests) and the orchestrator-side frame
// parsing + classification (services/visuals.js parseTests / classifyTests
// / consoleSnapshotFromTests).
//
// Run with: node --test tests/proposal-checks-runner.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveTests, expectationFailure, runTestSteps } = require('../capture/capture');
const visuals = require('../src/services/visuals');

// Build a __USERNODE_TEST__ frame the way capture.js emits it.
function testFrame(index, status, loadStatus, payload) {
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return `__USERNODE_TEST__ index=${index} status=${status} loadStatus=${loadStatus}\n${b64}\n__USERNODE_TEST_END__`;
}

// ── capture resolveTests ───────────────────────────────────────────────

test('resolveTests parses TESTS json into normalized entries', () => {
  const env = { TESTS: JSON.stringify([
    { index: 0, name: 'Home', path: '/', url: 'http://s:3000/?token=x' },
    { index: 1, name: 'Board', path: '/board', url: 'http://s:3000/board?token=x', expectSelector: '.board', allowConsoleErrors: true },
  ]) };
  const out = resolveTests(env);
  assert.equal(out.length, 2);
  assert.equal(out[1].expectSelector, '.board');
  assert.equal(out[1].allowConsoleErrors, true);
  assert.equal(out[0].allowConsoleErrors, false);
});

test('resolveTests drops entries with no url and tolerates garbage', () => {
  assert.deepEqual(resolveTests({}), []);
  assert.deepEqual(resolveTests({ TESTS: 'not json' }), []);
  assert.deepEqual(resolveTests({ TESTS: '{}' }), []);
  const out = resolveTests({ TESTS: JSON.stringify([{ name: 'no url' }, { url: 'http://s/x' }]) });
  assert.equal(out.length, 1);
});

test('resolveTests carries workflows but re-caps direct input', () => {
  const steps = Array.from({ length: 20 }, (_, i) => ({ action: 'click', selector: `#s${i}` }));
  const [entry] = resolveTests({ TESTS: JSON.stringify([{ url: 'http://s/', steps }]) });
  assert.equal(entry.steps.length, 12);
});

test('expectationFailure checks text, value and attributes without echoing runtime values', () => {
  assert.equal(expectationFailure({ text: 'Join Waitlist' }, { text: 'waitlist' }), '');
  assert.match(expectationFailure({ value: 'https://app/?token=secret' }, { valueExcludes: 'token=' }), /forbidden substring/);
  assert.equal(expectationFailure({ attribute: 'https://app/' }, { attribute: 'href', attributeIncludes: 'http', attributeExcludes: 'token=' }), '');
  assert.match(expectationFailure({ value: 'runtime-secret' }, { valueIncludes: 'expected' }), /declared substring/);
});

test('runTestSteps waits for visible elements, clicks sequentially, and disposes handles', async () => {
  const events = [];
  const handles = new Map();
  for (const selector of ['#open', '#done']) {
    handles.set(selector, {
      click: async () => events.push(`click:${selector}`),
      dispose: async () => events.push(`dispose:${selector}`),
    });
  }
  const page = {
    waitForSelector: async (selector, options) => {
      events.push(`wait:${selector}:${options.visible}`);
      return handles.get(selector);
    },
    evaluate: async () => ({ text: 'Done', value: '', attribute: null }),
  };
  const failure = await runTestSteps(page, [
    { action: 'click', selector: '#open' },
    { action: 'expect', selector: '#done', text: 'done' },
  ]);
  assert.equal(failure, '');
  assert.deepEqual(events, [
    'wait:#open:true', 'click:#open', 'dispose:#open',
    'wait:#done:true', 'dispose:#done',
  ]);
});

test('runTestSteps reports the exact failed step and still disposes its handle', async () => {
  let disposed = false;
  const page = {
    waitForSelector: async () => ({ dispose: async () => { disposed = true; } }),
    evaluate: async () => ({ text: 'Wrong', value: '', attribute: null }),
  };
  const failure = await runTestSteps(page, [{ action: 'expect', selector: '#result', text: 'Ready' }]);
  assert.match(failure, /^Step 1 \(expect\): rendered text/);
  assert.equal(disposed, true);
});

test('runTestSteps gives a bounded timeout diagnostic for a missing visible selector', async () => {
  const page = { waitForSelector: async () => { throw new Error('Timeout'); } };
  const failure = await runTestSteps(page, [{ action: 'click', selector: '#missing' }]);
  assert.equal(failure, 'Step 1 (click): visible element "#missing" was not found');
});

test('runTestSteps fails a normalized invalid step instead of passing a static load', async () => {
  const page = {
    waitForSelector: async () => ({ dispose: async () => {} }),
  };
  assert.equal(
    await runTestSteps(page, [{ action: 'invalid', selector: 'html' }]),
    'Step 1 (invalid): unsupported action'
  );
});

// ── visuals parseTests / classifyTests ─────────────────────────────────

test('parseTests reads one record per frame (latest wins on dup index)', () => {
  const stdout = [
    testFrame(0, 'pass', 200, { name: 'Home', path: '/', consoleErrors: [], failureReason: '' }),
    testFrame(1, 'fail', 200, { name: 'Feed', path: '/feed', consoleErrors: [{ kind: 'console', message: 'boom' }], failureReason: '1 console error on load' }),
  ].join('\n');
  const frames = visuals.parseTests(stdout);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].status, 'pass');
  assert.equal(frames[1].status, 'fail');
  assert.equal(frames[1].failureReason, '1 console error on load');
  assert.equal(frames[1].consoleErrors.length, 1);
});

test('classifyTests: all pass → passing', () => {
  const frames = visuals.parseTests(testFrame(0, 'pass', 200, { name: 'Home', path: '/', consoleErrors: [], failureReason: '' }));
  const r = visuals.classifyTests(frames, 1);
  assert.equal(r.state, 'passing');
  assert.equal(r.results.length, 1);
});

test('classifyTests: any fail → failing', () => {
  const stdout = [
    testFrame(0, 'pass', 200, { name: 'Home', path: '/', consoleErrors: [], failureReason: '' }),
    testFrame(1, 'fail', 200, { name: 'Feed', path: '/feed', consoleErrors: [], failureReason: 'missing element' }),
  ].join('\n');
  const r = visuals.classifyTests(visuals.parseTests(stdout), 2);
  assert.equal(r.state, 'failing');
});

test('classifyTests: no frames at all → error (fail-closed)', () => {
  assert.equal(visuals.classifyTests([], 2).state, 'error');
  assert.equal(visuals.classifyTests(visuals.parseTests('nothing here'), 1).state, 'error');
});

test('classifyTests: a partial run (fewer frames than expected) → error', () => {
  const frames = visuals.parseTests(testFrame(0, 'pass', 200, { name: 'Home', path: '/', consoleErrors: [], failureReason: '' }));
  // Expected 3 tests, only 1 frame came back → can't call it passing.
  assert.equal(visuals.classifyTests(frames, 3).state, 'error');
});

test('consoleSnapshotFromTests flattens failing tests into the legacy advisory shape', () => {
  const result = {
    state: 'failing',
    results: [
      { name: 'Home', path: '/', status: 'pass', consoleErrors: [], failureReason: '' },
      { name: 'Feed', path: '/feed', status: 'fail', consoleErrors: [{ kind: 'pageerror', message: 'boom', source: 'a.js:1' }], failureReason: '' },
    ],
  };
  const snap = visuals.consoleSnapshotFromTests(result);
  assert.equal(snap.state, 'errors');
  assert.equal(snap.errors.length, 1);
  assert.equal(snap.errors[0].message, 'boom');
});

test('consoleSnapshotFromTests: error state → unknown (no badge)', () => {
  assert.equal(visuals.consoleSnapshotFromTests({ state: 'error', results: [] }).state, 'unknown');
});

test('consoleSnapshotFromTests: passing with no console errors → clean', () => {
  const snap = visuals.consoleSnapshotFromTests({
    state: 'passing', results: [{ name: 'Home', path: '/', status: 'pass', consoleErrors: [], failureReason: '' }],
  });
  assert.equal(snap.state, 'clean');
});
