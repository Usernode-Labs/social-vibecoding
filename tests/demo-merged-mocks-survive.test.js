// The demo Completed mocks keep their page-one slots (#1788).
//
// GET /api/apps/:slug/merged injects staging demo rows on the FIRST page only,
// so a preview has something to review. The old order was: unshift the mocks,
// sort newest-first, then truncate to `limit`. That trims the mocks like
// anything else — and they are dated in DAYS (row 9100060 is two days old), so
// they only survived while fewer than `limit` real completed rows were newer.
//
// On a day with 63 merges they fell off page one, and being first-page-only
// they then appeared nowhere. The declared check
//
//   A task moved to Done keeps its priority/assignee/type chips
//   #dev-kanban-col-done [data-gov-row="9100060"] .attr-chip
//
// went red on unrelated proposals and was recorded as flaky, with its rate
// climbing as the platform got busier. It was never flaky: it was load
// dependent, and the load was our own merge rate.
//
// These tests pin the ordering rule directly, because the failure mode is
// invisible until real history outpaces the fixtures.
//
// Run with: node --test tests/demo-merged-mocks-survive.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'votes.js'), 'utf8'
);

// The block under test, isolated so the assertions cannot match prose
// elsewhere in a 3000-line file.
function injectionBlock() {
  const start = SRC.indexOf("if (IS_STAGING && req.query.demo === '1' && isFirstPage) {");
  assert.ok(start > 0, 'the first-page demo injection still exists');
  return SRC.slice(start, SRC.indexOf('res.json({ merged: rows, hasMore, total });', start));
}

test('#1788: room is made for the mocks BEFORE they are merged in', () => {
  const block = injectionBlock();
  const reserve = block.indexOf('rows.length = Math.max(0, limit - injected.length);');
  const unshift = block.indexOf('rows.unshift(...injected);');
  assert.ok(reserve > 0, 'the page is trimmed to leave room for the injected rows');
  assert.ok(unshift > 0, 'the mocks are still injected');
  assert.ok(reserve < unshift,
    'the trim must happen BEFORE the unshift, or the mocks compete for the page again');
});

test('#1788: the mocks are never truncated after being merged in', () => {
  const block = injectionBlock();
  const unshift = block.indexOf('rows.unshift(...injected);');
  const after = block.slice(unshift);
  // This is the regression itself: a truncation after the merge trims mocks
  // and real rows alike, and the mocks lose because they are older.
  assert.doesNotMatch(after, /rows\.length = limit;/,
    'truncating to `limit` after the merge is what dropped the mocks');
});

test('#1788: hasMore is still set, so "Load more" stays exercisable', () => {
  const block = injectionBlock();
  assert.match(block, /hasMore = true;/,
    'the fixtures exist partly so a tester can exercise Load more');
});

test('#1788: the interleaving sort is kept', () => {
  const block = injectionBlock();
  const unshift = block.indexOf('rows.unshift(...injected);');
  const sort = block.indexOf('rows.sort(completedRowCompare);');
  assert.ok(sort > unshift,
    'the sort must follow the merge, or close-issue mocks clump instead of interleaving');
});

test('#1788: the reserve arithmetic cannot produce a negative length', () => {
  // `limit` is clamped to >= 1 upstream, but the fixture count is free to
  // grow. Math.max(0, ...) is what stops `rows.length = -3` throwing.
  const block = injectionBlock();
  assert.match(block, /Math\.max\(0, limit - injected\.length\)/);
});

test('#1788: the asserted row is still two days old, which is why slots must be reserved', () => {
  // If someone re-dates this to a few hours, the check passes again today and
  // rots at a higher merge rate — and it fights #1264, which spread these
  // over ~150 days for the report's monthly strip. Pinned so that the cheap
  // fix is a deliberate choice rather than an accident.
  assert.match(SRC, /mk\(9100060, 'group-vote', 1, 2, 3\)/,
    'row 9100060 is the one the declared Done-column check selects');
});
