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
