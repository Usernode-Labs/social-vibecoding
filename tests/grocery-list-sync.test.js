'use strict';

// A tick that is saved must not be drawn over by a list read that left
// before the save. A person ticks an item on their phone; a read that was
// already on its way (a forced one, right after the previous change drained
// or a pull to refresh) comes back with the older copy, and the item flipped
// back to open a moment later. Two people on the list then seem to fight
// over the ticks.
//
// app-templates/grocery-list/public/app.js now numbers its reads (readSeq)
// and remembers each acknowledged change (settled) against the reads that
// had already started, so applySettled() puts the saved copy back over a
// read that is older than the save. This runs the real queue, save-sending
// and reading blocks of that page in a vm, with the page's own
// fetch/render/save stubs, and races them the way two phones do.
//
// Run with: node --test tests/grocery-list-sync.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app-templates/grocery-list/public/app.js'), 'utf8');

// The page is one IIFE that builds the whole screen on load. The pieces this
// test needs are the queue of changes, the code that sends one, the code
// that adopts an add's real id, and the read. They are sliced out by their
// own markers, as tests/preview-clock.test.js slices the shell.
function slice(from, to) {
  const start = SRC.indexOf(from);
  const end = SRC.indexOf(to);
  assert.ok(start !== -1, `app.js no longer has: ${from}`);
  assert.ok(end > start, `app.js no longer has ${to} after ${from}`);
  return SRC.slice(start, end);
}

const BLOCKS = [
  // queue(), saveQueue(), commit(), coalesce(), project(), settled,
  // applySettled(), applyUndo().
  slice('var memoryQueue = [];', '  // ── Sending what waited'),
  // runOp(), which carries every answer into settled.
  slice('  // One change, sent. An add\'s answer points every change queued behind it,', '  function attemptReplay(force) {'),
  // adopt(), which moves a guard from an add's temporary id to the real one.
  slice('  // The server\'s answer to an add: the item\'s real id, everywhere it is used.', '  // ── Showing ticked items, folding categories'),
  // refresh(), the read.
  slice('  var loading = null;', '  function busy() {'),
].join('\n');

// The two helpers the slices use that live outside them.
const PRELUDE = `
  function copy(o) { var out = {}; for (var k in o) out[k] = o[k]; return out; }
  function findItem(id) {
    if (!data) return null;
    for (var i = 0; i < data.items.length; i++) if (data.items[i].id === id) return data.items[i];
    return null;
  }
`;

const item = (id, over) => Object.assign({
  id: id, category_id: 1, text: 'Milk', checked: false, sort_order: 1,
  completed_at: null, created_by: 'ada', last_checked_by: null, due_date: null, due_time: null,
}, over || {});

const listOf = (items) => ({ me: { id: 1, username: 'ada' }, now: '2026-11-17T09:00:00.000Z',
  list: { due_dates_enabled: false }, categories: [{ id: 1, name: 'General', is_default: true, sort_order: 0 }],
  items: items, activity: null });

function harness(items) {
  const reads = [];
  const writes = [];
  const sandbox = {
    DURABLE: false,
    KEY_QUEUE: 'queue',
    storedJSON: () => null,
    store: () => true,
    syncHint() {},
    renderStrip() {},
    drain() {},
    toast() {},
    render() {},
    saveCopy() {},
    replaying: false,
    live: null,
    keptList: Promise.resolve(),
    el: { loading: { hidden: false }, error: { hidden: true }, errorText: { textContent: '' } },
    LOAD_TIMEOUT_MS: 12000,
    WRITE_TIMEOUT_MS: 8000,
    undoStack: [],
    redoStack: [],
    editingId: null,
    document: { querySelectorAll: () => [] },
    data: listOf(items || []),
    loaded: false,
    showingSaved: false,
    api(method) {
      if (method === 'GET') return new Promise((resolve, reject) => reads.push({ resolve, reject }));
      return new Promise((resolve, reject) => writes.push({ resolve, reject, method }));
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(PRELUDE + BLOCKS, sandbox);
  return {
    page: sandbox,
    // The read the page has just started, or null.
    read: () => reads.shift(),
    write: () => writes.shift(),
    of: (id) => (sandbox.data.items || []).find((i) => i.id === id),
    guard: (id) => sandbox.settled[id],
  };
}

test('a tick saved while a read was already on its way stays ticked when that read lands', async () => {
  const h = harness([item(1)]);
  // A forced read leaves (the queue drained a moment ago, or a pull to refresh).
  const reading = h.page.refresh(true);
  const firstRead = h.read();
  assert.ok(firstRead, 'the read has started');

  // The tick: queued, then acknowledged by the server while the read is in flight.
  h.page.commit({ type: 'toggle', itemId: 1, body: { checked: true }, undo: { checked: false }, at: '2026-11-17T09:01:00.000Z', by: 'ada' });
  const sending = h.page.runOp(h.page.queue()[0]);
  h.write().resolve({ item: item(1, { checked: true, completed_at: '2026-11-17T09:01:00.000Z', last_checked_by: 'ada' }) });
  await sending;
  assert.ok(h.guard(1), 'the saved tick is remembered against the read in flight');

  // The read, which left before the tick was saved, comes back with it open.
  firstRead.resolve(listOf([item(1)]));
  await reading;

  assert.equal(h.of(1).checked, true, 'the saved tick is not drawn over by the older read');
  assert.equal(h.of(1).last_checked_by, 'ada', 'nor is who ticked it');
  assert.ok(h.guard(1), 'the guard waits for a read that started after the save');

  // The next read starts after the save, so the server's copy is current.
  const again = h.page.refresh(false);
  h.read().resolve(listOf([item(1, { checked: true, completed_at: '2026-11-17T09:01:00.000Z', last_checked_by: 'ada' })]));
  await again;
  assert.equal(h.of(1).checked, true);
  assert.equal(h.guard(1), undefined, 'a read that started after the save clears the guard');
});

test('the other person unticking after my save is drawn as the server has it', async () => {
  const h = harness([item(1)]);
  // My tick goes out and is acknowledged.
  h.page.commit({ type: 'toggle', itemId: 1, body: { checked: true }, undo: { checked: false }, by: 'ada' });
  const sending = h.page.runOp(h.page.queue()[0]);
  h.write().resolve({ item: item(1, { checked: true, completed_at: '2026-11-17T09:01:00.000Z', last_checked_by: 'ada' }) });
  await sending;
  assert.ok(h.guard(1));

  // A read that starts now, after that save, brings their untick.
  const reading = h.page.refresh(false);
  h.read().resolve(listOf([item(1, { checked: false, last_checked_by: 'grace' })]));
  await reading;

  assert.equal(h.of(1).checked, false, 'the later change wins, as it does on the server');
  assert.equal(h.of(1).last_checked_by, 'grace');
  assert.equal(h.guard(1), undefined, 'the older save no longer overrides the read');
});

test('an add and a delete are guarded the same way', async () => {
  // An add: the row on screen still has its temporary id while the server answers.
  const temp = -7;
  const local = item(temp, { text: 'Bread' });
  const h = harness([local]);
  const reading = h.page.refresh(true);
  h.page.commit({ type: 'add', itemId: temp, path: '/api/items', body: { text: 'Bread' }, item: local });
  const sending = h.page.runOp(h.page.queue()[0]);
  const real = item(42, { text: 'Bread' });
  h.write().resolve({ item: real });
  await sending;
  assert.equal(h.guard(42).type, 'add', 'kept under the real id, so a read without it still shows it');
  assert.equal(h.guard(temp), undefined, 'nothing is left under the temporary id');
  // The read left before the add was saved, so it has no Bread in it.
  h.read().resolve(listOf([]));
  await reading;
  assert.equal(h.of(42).text, 'Bread', 'the new item is not lost from a read that left before it existed');

  // A delete: the read that was on its way still carries the item.
  const h2 = harness([item(1, { checked: true })]);
  const reading2 = h2.page.refresh(true);
  h2.page.commit({ type: 'delete', itemId: 1, undo: item(1) });
  const deleting = h2.page.runOp(h2.page.queue()[0]);
  h2.write().resolve({ ok: true });
  await deleting;
  assert.equal(h2.guard(1).type, 'delete');
  h2.read().resolve(listOf([item(1, { checked: true })]));
  await reading2;
  assert.equal(h2.of(1), undefined, 'a deleted item is not put back by a read that left before it went');
});

test('a save refused for good leaves no guard behind', async () => {
  const h = harness([item(1)]);
  h.page.commit({ type: 'toggle', itemId: 1, body: { checked: true }, undo: { checked: false }, by: 'ada' });
  const sending = h.page.runOp(h.page.queue()[0]);
  h.write().resolve({ item: item(1, { checked: true, completed_at: '2026-11-17T09:01:00.000Z', last_checked_by: 'ada' }) });
  await sending;
  assert.ok(h.guard(1));

  // A later change to the same item is refused (somebody deleted it): the
  // screen puts the item back as it is, so no guard may keep the old copy.
  h.page.applyUndo({ type: 'edit', itemId: 1 });
  assert.equal(h.guard(1), undefined);
});
