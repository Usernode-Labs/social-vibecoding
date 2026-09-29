// The admin Waitlist queue's Status cell, EXECUTED for both of its shapes.
//
// WHY THIS FILE EXISTS. #2674 moved an admitted signup's date OFF the badge's
// label and onto a hover title, so the column reads as one word per row
// instead of a word plus a timestamp. Nothing else about the cell moved: the
// waiting shape is the same amber "Waiting" badge it has always been.
//
// A declared browser check cannot see that. The queue opens on
// `status: 'pending'`, and the server's `pending` filter is
// `w.released_at IS NULL` (src/routes/topochain/admin/waitlist.js), so an
// admitted row is never in the table a check at `/#admin/waitlist` loads —
// reaching one takes a click on the status select, which a declared check
// does not make. One was written that way and failed for exactly that
// reason. This renders the cell instead, which is where the rule lives.
//
// Same precedent, and the same reason, as tests/topochain-waitlist-survey.js.
//
// Run with: node --test tests/admin-waitlist-status-column.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadTsx, renderToHtml } = require('./lib/render-tsx');

const ENTRY = 'frontend/src/features/admin/topochain/waitlist.tsx';

const ADMITTED_AT = '2026-03-04T09:30:00.000Z';
// What the cell itself formats with — `new Date(iso).toLocaleString()`, read
// in this process's locale and zone, so the expectation cannot drift from the
// component's own output when the suite runs somewhere else.
const ADMITTED_LABEL = `Admitted ${new Date(ADMITTED_AT).toLocaleString()}`;

const statusCell = (() => {
  const { WAITLIST_COLUMNS } = loadTsx(ENTRY);
  const col = WAITLIST_COLUMNS.find((c) => c.label === 'Status');
  assert.ok(col, 'the queue still has a Status column');
  return (row) => renderToHtml(col.cell(row));
})();

test('an admitted signup wears a bare Admitted badge, with the date on a hover title', () => {
  const html = statusCell({ id: 1, email: 'a@b.invalid', released_at: ADMITTED_AT });
  assert.match(html, new RegExp(`title="${ADMITTED_LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
    'the admission date is carried as a title attribute');
  assert.ok(!/>Admitted \d/.test(html),
    'the badge label itself is the one word, with no date rendered beside it');
  assert.match(html, />Admitted</, 'and the label is still there to read');
});

test('a waiting signup is unchanged: an amber badge and no title at all', () => {
  const html = statusCell({ id: 2, email: 'c@d.invalid', released_at: null });
  assert.match(html, />Waiting</, 'the waiting row still says so in the column');
  assert.ok(!/title=/.test(html),
    'nothing to hover over on a row that has not been admitted');
  assert.ok(!/Admitted/.test(html), 'and it is never labelled admitted');
});
