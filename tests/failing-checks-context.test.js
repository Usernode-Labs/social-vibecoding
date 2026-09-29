// Tests for buildFailingChecksBlock (src/routes/sessions.js) — the block
// that carries a proposal's failing staging checks into the NEXT build
// turn's prompt. Production proposal 3284 is the motivating case: five
// failing checks, none visible to the agent, whose own `npm test` was
// green — so it ended the turn convinced everything passed. The block is
// how the agent stops flying blind on its own merge gate.
//
// Run with: node --test tests/failing-checks-context.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildFailingChecksBlock } = require('../src/routes/sessions');

const failRow = (over = {}) => ({
  name: 'feedback queue survives offline',
  path: '/?shot=feedback-queued',
  status: 'fail',
  advisory: false,
  failureReason: 'Expected element "[data-shot-done]" was not found',
  consoleErrors: [],
  ...over,
});

test('no block unless the state is failing AND rows actually failed', () => {
  assert.equal(buildFailingChecksBlock('passing', [failRow()]), '');
  assert.equal(buildFailingChecksBlock('error', [failRow()]), '');
  assert.equal(buildFailingChecksBlock('failing', []), '');
  assert.equal(buildFailingChecksBlock('failing', [failRow({ status: 'pass' })]), '');
  assert.equal(buildFailingChecksBlock('failing', null), '');
});

test('failing rows render with name, route, reason and blocking/advisory power', () => {
  const block = buildFailingChecksBlock('failing', [
    failRow(),
    failRow({ name: 'landing renders', path: '/?shot=anon-back#landing', advisory: true, failureReason: '2 console errors on load' }),
    { name: 'ok row', path: '/x', status: 'pass' },
  ]);
  assert.match(block, /PROPOSAL CHECKS — CURRENTLY FAILING/);
  assert.match(block, /2 of them are\nFAILING and 1 of those are MERGE-BLOCKING/);
  assert.match(block, /\[BLOCKING\] "feedback queue survives offline" \(path: \/\?shot=feedback-queued\)/);
  assert.match(block, /\[advisory\] "landing renders"/);
  assert.match(block, /Expected element/);
  assert.match(block, /usernode-run-checks/, 'points the agent at the in-loop runner');
  assert.doesNotMatch(block, /ok row/, 'passing rows stay out of the block');
});

test('an all-advisory failure set says so instead of claiming a blocked merge count', () => {
  const block = buildFailingChecksBlock('failing', [failRow({ advisory: true })]);
  assert.match(block, /all advisory for now/);
});

test('the first console error rides along for diagnosis', () => {
  const block = buildFailingChecksBlock('failing', [
    failRow({
      failureReason: '1 console error on load',
      consoleErrors: [{ kind: 'pageerror', message: 'TypeError: x is undefined', source: '' }],
    }),
  ]);
  assert.match(block, /first console error: TypeError: x is undefined/);
});

test('the row list is bounded and says how many more are failing', () => {
  const rows = Array.from({ length: 20 }, (_, i) => failRow({ name: `check ${i}`, path: `/p${i}` }));
  const block = buildFailingChecksBlock('failing', rows);
  assert.match(block, /\(\+8 more failing\)/);
  assert.doesNotMatch(block, /"check 19"/);
});

test('hostile row content is truncated, not trusted', () => {
  const block = buildFailingChecksBlock('failing', [
    failRow({ name: 'x'.repeat(500), failureReason: 'y'.repeat(1000) }),
  ]);
  assert.ok(block.includes('x'.repeat(160)) && !block.includes('x'.repeat(161)), 'name capped at 160');
  assert.ok(block.includes('y'.repeat(300)) && !block.includes('y'.repeat(301)), 'reason capped at 300');
});

// Change 4868: the repo unit suite's row is appended after the browser
// checks and its reason is a per-file list of every failing test. Cut at
// 300 characters it held a few names and no file, and behind twelve
// failing browser checks it was not in the block at all — so the fix turn
// re-ran the whole suite to find what failed.
const UNIT_REASON = [
  ...['tests/agent-sessions-postgres.test.js (8): one Mayor turn at a time; a dead turn\'s lease is taken over…'],
  'tests/dev-board-fold.test.js (1): the manifest declares exactly the checks this file accounts for',
  'tests/improve-session-spinner.test.js (1): the busy spinner is one check',
  'tests/proposal-tests-manifest.test.js (1): this repo\'s own manifest fits under the ceiling',
  '# tests 13015', '# pass 13000', '# fail 15', '# cancelled 0',
].join(' | ').padEnd(1500, '.');
const unitRow = () => ({
  index: -3, name: 'Repo unit suite (npm test) passes', path: 'package.json',
  status: 'fail', advisory: false, failureReason: UNIT_REASON, consoleErrors: [],
});

test('the unit suite row leads the block, whole, however many checks fail', () => {
  const browser = Array.from({ length: 20 }, (_, i) => failRow({ name: `check ${i}`, path: `/p${i}` }));
  const block = buildFailingChecksBlock('failing', [...browser, unitRow()]);
  assert.match(block, /:\n\n- \[BLOCKING\] "Repo unit suite \(npm test\) passes" \(path: package\.json\) — tests\/agent-sessions-postgres/,
    'first in the list, where the row cap cannot drop it');
  assert.ok(block.includes(UNIT_REASON), 'the whole reason, not 300 characters of it');
  assert.ok(block.includes('tests/proposal-tests-manifest.test.js (1)'), 'down to the last file');
  assert.match(block, /\(\+9 more failing\)/, 'the row cap still holds for the browser checks');
  assert.match(block, /Re-run just those files/);
});

test('without a unit suite row the block does not mention re-running test files', () => {
  assert.doesNotMatch(buildFailingChecksBlock('failing', [failRow()]), /Re-run just those files/);
});
