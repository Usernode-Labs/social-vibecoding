'use strict';

// Grocery list: a reload keeps ticks that were still being saved when the
// page reopened. The opening read and the queued PATCHes leave together; an
// answer from before the PATCHes landed must not clear the ticks on screen
// or in the copy on this device. The screen reads again instead, and the
// accepted answer is the one that has the ticks (request 6737).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'app-templates', 'grocery-list', 'public', 'app.js'),
  'utf8',
);
const KEY_QUEUE = 'grocery-list:u7:queue';

const TICKED = [
  { id: 11, text: 'Chopped tomatoes' },
  { id: 12, text: 'Garlic' },
  { id: 13, text: 'Spaghetti' },
  { id: 14, text: 'Parmesan' },
];

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function response(body) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

// The server's list: a few open items and the four the person ticked.
function listPayload(checked) {
  const items = [{ id: 1, category_id: 1, text: 'Onions', checked: false, sort_order: 1 }];
  TICKED.forEach((item, i) => {
    items.push({
      id: item.id, category_id: 1, text: item.text, checked,
      sort_order: 10 + i,
      completed_at: checked ? '2026-11-17T12:00:00.000Z' : null,
      created_by: 'you', last_checked_by: checked ? 'you' : null,
      due_date: null, due_time: null,
    });
  });
  return {
    me: { id: 7, username: 'you' },
    now: '2026-11-17T12:00:00.000Z',
    list: { id: 1, due_dates_enabled: false },
    categories: [{ id: 1, name: 'General', is_default: true, sort_order: 0 }],
    items,
    activity: null,
  };
}

// Four ticks saved on this device but not yet sent: the reported reload.
function queuedToggles() {
  return TICKED.map((item) => ({
    type: 'toggle', itemId: item.id, body: { checked: true },
    undo: { checked: false, completed_at: null, last_checked_by: null },
    at: '2026-11-17T12:00:00.000Z', by: 'you', attempts: 0,
  }));
}

function element(tag) {
  return {
    tagName: String(tag || '').toUpperCase(),
    children: [],
    attrs: {},
    listeners: {},
    className: '',
    textContent: '',
    hidden: false,
    disabled: false,
    checked: false,
    value: '',
    elements: null,
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    contains() { return false; },
    closest() { return null; },
    focus() {},
  };
}

function waitFor(check, what) {
  return (async () => {
    for (let i = 0; i < 400; i++) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('timed out waiting for ' + what);
  })();
}

// Runs the real screen in node:vm with a permissive DOM stub. The test
// answers its requests by hand, so it controls which answer lands first.
function boot(queueOps) {
  const puts = [];
  const gets = [];
  let patches = 0;
  const patchesDone = deferred();

  class MemoryStorage {
    constructor() { this._data = new Map(); }
    getItem(key) { return this._data.has(key) ? this._data.get(key) : null; }
    setItem(key, value) { this._data.set(key, String(value)); }
    removeItem(key) { this._data.delete(key); }
  }
  const localStorage = new MemoryStorage();
  if (queueOps.length) localStorage.setItem(KEY_QUEUE, JSON.stringify(queueOps));

  const elements = new Map();
  function byId(id) {
    if (!elements.has(id)) {
      const node = element('div');
      if (id === 'quick-add') node.elements = { text: element('input') };
      if (id === 'new-category') node.elements = { name: element('input') };
      elements.set(id, node);
    }
    return elements.get(id);
  }

  const document = {
    body: element('body'),
    activeElement: null,
    getElementById: byId,
    createElement: element,
    createElementNS: (_ns, tag) => element(tag),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
  };

  const claims = Buffer.from(JSON.stringify({ id: 7, username: 'you' })).toString('base64');
  const token = 'h.' + claims + '.s';

  const usernode = {
    offline: {
      get: () => Promise.resolve(null),
      put(name, value) { puts.push({ name, value: JSON.parse(JSON.stringify(value)) }); },
    },
    ready() {},
    previewNow: false,
  };

  function fetch(url, options) {
    const method = (options && options.method) || 'GET';
    if (method === 'GET' && url === '/api/list') {
      const d = deferred();
      gets.push(d);
      return d.promise;
    }
    if (method === 'PATCH') {
      patches += 1;
      if (patches === TICKED.length) patchesDone.resolve();
      return Promise.resolve(response({}));
    }
    return Promise.resolve(response({}));
  }

  const sandbox = {
    document,
    localStorage,
    navigator: { onLine: true },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    fetch,
    AbortController,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    console,
    window: {
      location: { search: '?token=' + token },
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      addEventListener() {},
      usernode,
    },
  };

  vm.runInNewContext(SRC, sandbox, { filename: 'grocery-list/public/app.js' });
  const queueLength = () => JSON.parse(localStorage.getItem(KEY_QUEUE) || '[]').length;
  return { puts, gets, patchesDone, queueLength };
}

test('a reload keeps ticks still being saved when the first answer lands', async () => {
  const app = boot(queuedToggles());

  // The four queued ticks go out first, as they do on a reload.
  await app.patchesDone;
  await waitFor(() => app.queueLength() === 0, 'the queue to drain');
  assert.equal(app.gets.length, 1, 'the opening read was sent');

  // The read is answered from the server's state before those ticks landed.
  app.gets[0].resolve(response(listPayload(false)));

  // That answer is dropped and the list is read again.
  await waitFor(() => app.gets.length === 2, 'a second read after the stale answer');

  // Nothing the dropped answer wrote to this device has an unticked row.
  for (const put of app.puts) {
    for (const item of TICKED) {
      const row = put.value.items.find((i) => i.id === item.id);
      assert.ok(!row || row.checked, 'a stale answer never clears ' + item.text);
    }
  }

  // The read after the queue emptied has the ticks, and is the copy kept.
  app.gets[1].resolve(response(listPayload(true)));
  await waitFor(() => app.puts.length > 0, 'the accepted answer kept on this device');
  const kept = app.puts[app.puts.length - 1].value;
  for (const item of TICKED) {
    const row = kept.items.find((i) => i.id === item.id);
    assert.ok(row, item.text + ' is in the kept copy');
    assert.equal(row.checked, true, item.text + ' stays ticked after the reload');
  }
});

test('a reload with nothing queued accepts its one read as it comes', async () => {
  const app = boot([]);
  assert.equal(app.gets.length, 1, 'one opening read');

  const answer = listPayload(false);
  app.gets[0].resolve(response(answer));
  await waitFor(() => app.puts.length === 1, 'the read is kept on this device');

  assert.equal(app.gets.length, 1, 'no second read when the queue did not change');
  assert.deepEqual(
    app.puts[0].value.items.map((i) => i.checked),
    answer.items.map((i) => i.checked),
    'the answer is accepted as given',
  );
});
