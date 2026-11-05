'use strict';

// #6230 (3 Nov 2026): ONE detail column beside a thread, for a design's
// preview, a plan and a change's before and after, on the Homeroom bot page,
// in the Workshop's request panel and on a request's own page.
//
// What this pins:
//   1. The layout rule per surface at each real breakpoint.
//   2. One store: opening another detail replaces the open one, and closing
//      is one call.
//   3. The address carries the detail (kind, reference and version), and a
//      text plan has no address of its own.
//   4. The bot page's parse round-trips an item with its detail, and a plain
//      item is still a plain item.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadTsx, ROOT, fs } = require('./lib/render-tsx');

test('the layout rule: three where the surface has room, halves where it does not, full on a phone', () => {
  const { detailLayout } = loadTsx('frontend/src/features/ai/detail.ts');
  // A phone is the whole screen whatever the surface and window.
  for (const surface of ['bot', 'workshop', 'topic']) {
    assert.equal(detailLayout(surface, { phone: true, wide: true }), 'full', surface);
  }
  // Bot page: THREE_COLUMNS is 1500px; below that the thread and the detail
  // are in halves and the list steps aside.
  assert.equal(detailLayout('bot', { phone: false, wide: true }), 'three');
  assert.equal(detailLayout('bot', { phone: false, wide: false }), 'halves');
  // Workshop: WORKSHOP_THREE is 1760px; the panel only exists from 1180px,
  // so below it the panel's own width gives halves.
  assert.equal(detailLayout('workshop', { phone: false, wide: true }), 'three');
  assert.equal(detailLayout('workshop', { phone: false, wide: false }), 'halves');
  // A request's own page: TOPIC_DOCK is 1024px, where the detail docks.
  assert.equal(detailLayout('topic', { phone: false, wide: true }), 'three');
  assert.equal(detailLayout('topic', { phone: false, wide: false }), 'halves');
});

test('the breakpoints are the surfaces\' real widths', () => {
  const detail = loadTsx('frontend/src/features/ai/detail.ts');
  assert.equal(detail.THREE_COLUMNS, '(min-width: 1500px)');
  assert.equal(detail.WORKSHOP_THREE, '(min-width: 1760px)');
  assert.equal(detail.TOPIC_DOCK, '(min-width: 1024px)');
  assert.equal(detail.DETAIL_PHONE, '(max-width: 767px)');
});

test('one store: opening a detail replaces the open one (the chosen answer)', () => {
  const detail = loadTsx('frontend/src/features/ai/detail.ts');
  assert.equal(detail.isDetailOpen(), false);
  detail.openDetail({ kind: 'design', ref: { conversationId: 7, rootId: 42 }, version: 2 });
  assert.equal(detail.isDetailOpen(), true);
  assert.equal(detail.detailEntry().kind, 'design');
  detail.openDetail({ kind: 'plan', ref: {}, version: null, payload: { title: 'A plan', markdown: '# hi' } });
  assert.equal(detail.isDetailOpen(), true);
  assert.equal(detail.detailEntry().kind, 'plan', 'the new detail replaces the old one');
  detail.closeDetail();
  assert.equal(detail.isDetailOpen(), false);
});

test('the address names the detail, and a text plan writes none', () => {
  const { columnAddress } = loadTsx('frontend/src/features/ai/column.ts');
  const { botDetailAt, botItemAt, botTabAt } = loadTsx('frontend/src/features/ai/door.ts');
  // A request, with its plan at version 3.
  const page = { at: 'page', route: 'app/garden/dev/issues/6227', detail: { kind: 'plan', sessionId: 912, version: 3 } };
  assert.equal(columnAddress(page), '#homeroom-bot/request/garden/6227/plan/912/3');
  // The same request's plain page, with nothing beside it.
  assert.equal(columnAddress({ at: 'page', route: 'app/garden/dev/issues/6227' }), '#homeroom-bot/request/garden/6227');
  // The address round-trips: the place is still the item, and the detail is
  // the plan at its version.
  assert.deepEqual(botItemAt('#homeroom-bot/request/garden/6227/plan/912/3'), { kind: 'request', slug: 'garden', number: 6227 });
  assert.deepEqual(botDetailAt('#homeroom-bot/request/garden/6227/plan/912/3'), { kind: 'plan', sessionId: 912, version: 3 });
  // A plan without a version: the newest.
  assert.deepEqual(botDetailAt('#homeroom-bot/request/garden/6227/plan/912'), { kind: 'plan', sessionId: 912, version: null });
  // A thread's design, and a change's before and after.
  assert.equal(columnAddress({ at: 'thread', rootId: 40, detail: { kind: 'design', version: 2 } }), '#homeroom-bot/thread/40/design/2');
  assert.deepEqual(botTabAt('#homeroom-bot/thread/40/design/2'), { threadRootId: 40, focusMessageId: null });
  assert.deepEqual(botDetailAt('#homeroom-bot/thread/40/design/2'), { kind: 'design', version: 2 });
  assert.deepEqual(botDetailAt('#homeroom-bot/change/garden/41/shots/9'), { kind: 'shots', changeId: 9 });
  // A text plan has no address of its own (detailAddress returns nothing),
  // so the column's address is the place alone, and a bare `/plan` names no
  // detail.
  const { detailAddress } = loadTsx('frontend/src/features/ai/detail.ts');
  assert.equal(detailAddress('plan', {}, null), '');
  assert.equal(botDetailAt('#homeroom-bot/request/garden/6227/plan'), null);
});

// #6315 (4 Nov 2026): Expand, and a click on a change's small before and
// after, used to open a shots entry that only the bot page drew. Every
// surface's slot opens for every kind DetailPane draws now.
test('the detail slot opens for every kind the pane draws, not only a plan', () => {
  const { slotOpens } = loadTsx('frontend/src/features/detail/detail-slot.tsx');
  assert.equal(slotOpens({ kind: 'shots' }), true);
  assert.equal(slotOpens({ kind: 'design' }), true);
  assert.equal(slotOpens({ kind: 'plan' }), true);
  assert.equal(slotOpens(null), false);
  assert.equal(slotOpens(undefined), false);
  // The slot's own open state is that rule, not a plan-only comparison.
  const src = fs.readFileSync(path.join(ROOT, 'frontend/src/features/detail/detail-slot.tsx'), 'utf8');
  assert.match(src, /const open = slotOpens\(state\.entry\);/);
  assert.doesNotMatch(src, /kind === 'plan'/);
});

test('an open in the side panel\'s frame stays there unless the top is the bot page', () => {
  const calls = [];
  const top = { location: { hash: '#app/garden/dev/issues/6227' }, UsernodeReact: { detail: { open: (arg) => calls.push(arg) } } };
  const host = { location: { hash: '#app/garden/dev/issues/6227' }, self: {}, top, UsernodeReact: {} };
  global.window = host;
  try {
    const detail = loadTsx('frontend/src/features/ai/detail.ts');
    detail.closeDetail();
    // A request's page in the panel: this document's own slot draws it.
    detail.openDetail({ kind: 'shots', ref: { changeId: 9 }, version: null, payload: { html: '<p>a</p>' } });
    assert.equal(calls.length, 0, 'nothing is forwarded to a top document that draws no column');
    assert.equal(detail.detailEntry().kind, 'shots');
    assert.equal(detail.detailEntry().ref.changeId, 9);
    // The bot page's column is the top document's.
    top.location.hash = '#homeroom-bot/main';
    detail.openDetail({ kind: 'shots', ref: { changeId: 10 }, version: null, payload: { html: '<p>b</p>' } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'shots');
    assert.equal(calls[0].ref.changeId, 10);
    assert.equal(detail.detailEntry().ref.changeId, 9, 'the frame\'s own entry is untouched');
  } finally {
    delete global.window;
    loadTsx('frontend/src/features/ai/detail.ts').closeDetail();
  }
});

test('a before and after whose page had no column opens once on the change\'s page', () => {
  const detail = loadTsx('frontend/src/features/ai/detail.ts');
  detail.markShotsArrival(9);
  assert.equal(detail.takeShotsArrival(10), false, 'another change is not the arrival');
  assert.equal(detail.takeShotsArrival(9), true);
  assert.equal(detail.takeShotsArrival(9), false, 'it answers once');
});
