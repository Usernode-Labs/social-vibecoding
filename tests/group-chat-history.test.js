const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(scope) {
  const requests = [];
  const sandbox = {
    window: {}, URLSearchParams, location: { search: '' },
    document: { getElementById: () => null },
    fetch: (url) => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/group-chat.js'), 'utf8'), sandbox);
  const gc = sandbox.window.GroupChat;
  gc.appSlug = 'first-app';
  gc._demoParam = () => '';
  gc.render = gc.renderThread = gc.scrollToBottom = () => {};
  const state = () => scope === 'general' ? gc : gc._threadState('issue', 1868);
  const load = () => scope === 'general' ? gc.loadHistory() : gc.loadThreadHistory('issue', 1868);
  const reply = (index, messages) => requests[index].resolve({ ok: true, json: async () => ({ messages }) });
  const ids = () => Array.from(state().messages, m => m.id);
  return { gc, requests, state, load, reply, ids };
}

for (const scope of ['general', 'thread']) {
  test(`${scope}: overlapping initial loads display A B C only once`, async () => {
    const h = setup(scope);
    const first = h.load();
    const second = h.load();
    assert.equal(h.requests.length, 1);
    h.reply(0, [{ id: 1, content: 'A' }, { id: 2, content: 'B' }, { id: 3, content: 'C' }]);
    await Promise.all([first, second]);
    assert.deepEqual(h.ids(), [1, 2, 3]);
  });

  test(`${scope}: history overlaps live messages without losing their latest content`, async () => {
    const h = setup(scope);
    const pending = h.load();
    h.state().messages.push({ id: 3, content: 'edited live' }, { id: 4, content: 'new live' });
    h.reply(0, [{ id: 1 }, { id: 2 }, { id: '3', content: 'old history' }]);
    await pending;
    assert.deepEqual(h.ids(), [1, 2, 3, 4]);
    assert.equal(h.state().messages[2].content, 'edited live');
  });

  test(`${scope}: repeated earlier-page actions preserve order and raw page cursor`, async () => {
    const h = setup(scope);
    const initial = h.load();
    h.reply(0, Array.from({ length: 50 }, (_, i) => ({ id: 51 + i })));
    await initial;
    const page = h.load();
    const repeated = h.load();
    assert.equal(h.requests.length, 2);
    assert.match(h.requests[1].url, /before=51/);
    h.reply(1, [{ id: 49 }, { id: 50 }, { id: 51 }]);
    await Promise.all([page, repeated]);
    assert.deepEqual(h.ids(), Array.from({ length: 52 }, (_, i) => 49 + i));
    assert.equal(h.state().hasMore, false);
    assert.equal(scope === 'general' ? h.gc.oldestMessageId : h.state().oldestId, 49);
  });

  for (const failure of ['http', 'network', 'json']) {
    test(`${scope}: retries after ${failure} failure`, async () => {
      const h = setup(scope);
      const failed = h.load();
      if (failure === 'http') h.requests[0].resolve({ ok: false });
      if (failure === 'network') h.requests[0].reject(new Error('offline'));
      if (failure === 'json') h.requests[0].resolve({ ok: true, json: async () => { throw new Error('bad JSON'); } });
      await failed;
      const retry = h.load();
      assert.equal(h.requests.length, 2);
      h.reply(1, [{ id: 1 }]);
      await retry;
      assert.deepEqual(h.ids(), [1]);
    });
  }

  test(`${scope}: retired requests cannot populate or unlock a replacement conversation`, async () => {
    const h = setup(scope);
    const old = h.load();
    // Leave and return to the same app before the old request resolves.
    h.gc.disconnect();
    h.gc.appSlug = 'first-app';
    h.gc.messages = [];
    const current = h.load();
    h.reply(0, [{ id: 1 }]);
    await old;
    assert.deepEqual(h.ids(), []);
    await h.load();
    assert.equal(h.requests.length, 2);
    h.reply(1, [{ id: 2 }]);
    await current;
    assert.deepEqual(h.ids(), [2]);
  });
}

test('different threads can load independently', async () => {
  const h = setup('thread');
  const first = h.load();
  const other = h.gc.loadThreadHistory('proposal', 42);
  assert.equal(h.requests.length, 2);
  h.reply(1, [{ id: 2 }]);
  h.reply(0, [{ id: 1 }]);
  await Promise.all([first, other]);
  assert.deepEqual(h.ids(), [1]);
  assert.equal(h.gc._threadState('proposal', 42).messages[0].id, 2);
});
