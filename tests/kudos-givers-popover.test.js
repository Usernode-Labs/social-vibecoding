'use strict';

// #2994: the kudos popover's giver list (features/leaderboard/kudos.js).
//
// Hovering a kudos button with a non-zero count lazy-loads who gave it. When
// that request failed, the popover used to fall through to "No kudos yet. Be
// the first." beside a count that said otherwise, and because the in-flight
// promise was never cleared, every later hover repeated the false claim
// without asking again. Pins:
//
//   1. `fetchGivers` resolves true on success, false on a non-2xx or a
//      network error;
//   2. a failed load shows "Couldn't load who gave kudos.", never "No kudos
//      yet";
//   3. the next hover retries, and shows the givers when it succeeds;
//   4. a second hover while the load is still in flight keeps "Loading…".
//
// Run with: node --test tests/kudos-givers-popover.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');

if (!globalThis.window) globalThis.window = globalThis;
// kudos.js escapes through a scratch element and refreshes buttons through
// querySelectorAll; neither needs more than this here.
globalThis.document = {
  createElement: () => ({
    _t: '',
    set textContent(v) { this._t = String(v); },
    get innerHTML() { return this._t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
  }),
  querySelectorAll: () => [],
};
globalThis.App = { user: { id: 1, username: 'alice' } };
globalThis.AppView = { readOnly: false };
loadTsx('frontend/src/features/leaderboard/kudos.js');
const Kudos = globalThis.window.Kudos;

// A kudos wrapper with just enough DOM for Kudos.attach: a classList that
// tracks `hidden`, listeners by event name, and an innerHTML slot.
function fakeWrap(sid) {
  const classes = new Set(['hidden']);
  const popover = {
    innerHTML: '',
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
  };
  const listeners = {};
  const wrap = {
    dataset: { kudosSession: String(sid) },
    querySelector: (sel) => (sel === '[data-kudos-popover]' ? popover : null),
    addEventListener: (ev, fn) => { listeners[ev] = fn; },
  };
  const root = { querySelectorAll: () => [wrap] };
  Kudos.attach(root);
  return {
    popover,
    hover: () => listeners.mouseenter(),
    leave: () => listeners.mouseleave(),
  };
}

// Swap global fetch for a queue of canned outcomes; each call takes the next.
function queueFetch(outcomes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    const next = outcomes.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return calls;
}
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status) => ({ ok: false, status, json: async () => ({}) });
const flush = () => new Promise((r) => setImmediate(r));

const quietWarn = console.warn;
test.before(() => { console.warn = () => {}; });
test.after(() => { console.warn = quietWarn; });

test('fetchGivers: true when the list is cached, false on a non-2xx or network error', async () => {
  queueFetch([fail(500), new Error('offline'), ok({ count: 1, givers: [{ username: 'bob' }] })]);
  assert.equal(await Kudos.fetchGivers(100), false);
  assert.equal(Kudos._ensureCache(100).givers, null, 'a failed load caches nothing');
  assert.equal(await Kudos.fetchGivers(100), false);
  assert.equal(await Kudos.fetchGivers(100), true);
  assert.deepEqual(Kudos._ensureCache(100).givers, [{ username: 'bob' }]);
});

test('popover: a failed load says it could not load, not that nobody gave kudos; the next hover retries', async () => {
  Kudos.primeFromPr({ id: 200, kudos_count: 3 });
  const calls = queueFetch([
    fail(503),
    ok({ count: 3, givers: [{ username: 'bob' }, { username: 'carol' }, { username: 'dan' }] }),
  ]);
  const { popover, hover, leave } = fakeWrap(200);

  hover();
  assert.match(popover.innerHTML, /Loading/);
  await flush();
  assert.match(popover.innerHTML, /Couldn’t load who gave kudos\./);
  assert.doesNotMatch(popover.innerHTML, /No kudos yet/);
  assert.equal(calls.length, 1);

  leave();
  hover();
  assert.equal(calls.length, 2, 'the next hover asks again');
  assert.equal(calls[1], '/api/sessions/200/kudos');
  await flush();
  assert.match(popover.innerHTML, /Kudos givers \(3\)/);
  assert.match(popover.innerHTML, /@bob/);
  assert.doesNotMatch(popover.innerHTML, /Couldn/);

  // Cached now: another hover renders from the cache without a request.
  leave();
  hover();
  assert.equal(calls.length, 2);
  assert.match(popover.innerHTML, /@carol/);
});

test('popover: a network error reads the same as a failed response', async () => {
  Kudos.primeFromPr({ id: 300, kudos_count: 1 });
  queueFetch([new Error('offline')]);
  const { popover, hover } = fakeWrap(300);
  hover();
  await flush();
  assert.match(popover.innerHTML, /Couldn’t load who gave kudos\./);
  assert.doesNotMatch(popover.innerHTML, /No kudos yet/);
});

test('popover: re-hovering while the load is in flight keeps Loading, with one request', async () => {
  Kudos.primeFromPr({ id: 400, kudos_count: 1 });
  let release;
  const calls = [];
  globalThis.fetch = (url) => {
    calls.push(url);
    return new Promise((r) => { release = () => r(ok({ count: 1, givers: [{ username: 'erin' }] })); });
  };
  const { popover, hover, leave } = fakeWrap(400);
  hover();
  leave();
  hover();
  assert.match(popover.innerHTML, /Loading/);
  assert.doesNotMatch(popover.innerHTML, /No kudos yet/);
  assert.equal(calls.length, 1);
  release();
  await flush();
  assert.match(popover.innerHTML, /@erin/);
});

test('popover: a zero count still says "No kudos yet" without a request', () => {
  Kudos.primeFromPr({ id: 500, kudos_count: 0 });
  const calls = queueFetch([]);
  const { popover, hover } = fakeWrap(500);
  hover();
  assert.match(popover.innerHTML, /No kudos yet\. Be the first\./);
  assert.equal(calls.length, 0);
});
