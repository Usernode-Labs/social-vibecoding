'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const activityService = require('../src/services/app-activity');

const MODULE_URL = new URL(
  '../frontend/src/features/app-frame/app-activity.js', `file://${__filename}`
).href;

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

async function collectorHarness({
  startAt = Date.parse('2026-10-01T12:00:00Z'), fetch, storage: suppliedStorage,
  collectorOptions = {},
} = {}) {
  const { EngagedAppUsage } = await import(MODULE_URL);
  let now = startAt;
  let timer = null;
  let id = 0;
  const storage = suppliedStorage || new MemoryStorage();
  const requests = [];
  let request = fetch || (async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 200 };
  });
  const usage = new EngagedAppUsage({
    now: () => now,
    storage,
    fetch: (...args) => request(...args),
    uuid: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    setInterval: (fn) => { timer = fn; return 1; },
    clearInterval: () => { timer = null; },
    flushMs: 1_000_000_000,
    ...collectorOptions,
  });
  let visible = true;
  const posts = [];
  const frame = {
    contentWindow: { postMessage: (message, origin) => posts.push({ message, origin }) },
  };
  usage.start({ slug: 'notes', userId: 7, isVisible: () => visible });
  await Promise.resolve();
  usage.frameNavigated({ slug: 'notes', frame, src: 'https://notes.apps.test/' });
  assert.equal(usage.frameLoaded(frame), true);
  const generation = posts.at(-1).message.generation;
  const signal = (kind, overrides = {}) => usage.handleFrameMessage({
    source: frame.contentWindow,
    origin: 'https://notes.apps.test',
    data: { __usernode_engagement: kind, generation },
    ...overrides,
  });
  return {
    usage, storage, requests, frame, posts, signal,
    advance(ms) { now += ms; return usage.tick(now); },
    setVisible(value) { visible = value; },
    setFetch(fn) { request = fn; },
    runTimer() { return timer && timer(); },
    now: () => now,
  };
}

test('engaged time requires bridge readiness, trusted input and a visible current frame', async () => {
  const h = await collectorHarness();
  assert.equal(h.advance(2_000), 0, 'load/probe without a ready answer is not usable');
  assert.equal(h.signal('ready'), true);
  assert.equal(h.advance(2_000), 0, 'ready without user input is still idle');
  assert.equal(h.signal('activity'), true);
  assert.equal(h.advance(1_500), 1_500);

  h.setVisible(false);
  assert.equal(h.advance(1_000), 0, 'background time is excluded');
  h.setVisible(true);
  assert.equal(h.signal('activity'), true);
  assert.equal(h.advance(10_000), 5_000, 'a delayed callback is bounded');
  assert.equal(h.advance(61_000), 0, 'the 60-second input lease expires while idle');

  const ms = Object.values(h.usage.debug().state.buffers)
    .reduce((sum, row) => sum + row.milliseconds, 0);
  assert.equal(ms, 6_500);
});

test('visibility transitions reset the clock instead of crediting a hidden gap', async () => {
  const h = await collectorHarness();
  h.signal('ready');
  h.signal('activity');
  assert.equal(h.advance(1_000), 1_000);

  h.setVisible(false);
  h.usage.visibilityChanged();
  assert.equal(h.advance(30_000), 0);
  h.setVisible(true);
  h.usage.visibilityChanged();
  h.signal('activity');
  assert.equal(h.advance(1_000), 1_000);

  const state = h.usage.debug().state;
  const ms = Object.values(state.buffers)
    .reduce((sum, row) => sum + row.milliseconds, 0);
  const stagedMs = state.batches.flatMap((batch) => batch.entries)
    .reduce((sum, row) => sum + row.seconds * 1_000, 0);
  assert.equal(ms + stagedMs, 2_000);
});

test('the early reward receipt follows engaged time once per open and preserves periodic delivery', async () => {
  const h = await collectorHarness({ collectorOptions: { flushMs: 30_000 } });
  h.advance(40_000);
  await h.usage.flushPromise;
  assert.equal(h.requests.length, 0, 'loading time does not reach the reward floor');
  h.signal('ready');
  h.signal('activity');
  h.advance(4_500);
  h.advance(4_500);
  assert.equal(h.requests.length, 0, 'nine engaged seconds are below the floor');
  h.advance(1_500);
  await h.usage.flushPromise;
  assert.equal(h.requests.length, 1, 'a bounded sample crossing ten seconds sends the early receipt');
  assert.equal(h.requests[0].body.entries[0].seconds, 10);
  for (let i = 0; i < 5; i += 1) h.advance(5_000);
  assert.equal(h.requests.length, 1, 'subsequent samples do not repeat the early flush');
  h.advance(5_000);
  await h.usage.flushPromise;
  assert.equal(h.requests.length, 2, 'the regular thirty-second delivery still runs');
  assert.equal(h.requests[1].body.entries[0].seconds, 30);
  assert.notEqual(h.requests[0].body.batchId, h.requests[1].body.batchId);

  h.usage.stop();
  await h.usage.flushPromise;
  h.usage.start({ slug: 'notes', userId: 7, isVisible: () => true });
  await h.usage.flushPromise;
  h.signal('activity');
  h.advance(5_000);
  assert.equal(h.requests.length, 2, 'a new opening starts its own engaged clock');
  h.advance(5_000);
  await h.usage.flushPromise;
  assert.equal(h.requests.length, 3, 'reopening can send its own early receipt');
  h.usage.stop();
});

test('frame signals are scoped to the current window, origin and navigation generation', async () => {
  const h = await collectorHarness();
  assert.equal(h.signal('ready', { origin: 'https://evil.test' }), false);
  assert.equal(h.signal('ready', { source: {} }), false);
  assert.equal(h.usage.handleFrameMessage({
    source: h.frame.contentWindow,
    origin: 'https://notes.apps.test',
    data: { __usernode_engagement: 'ready', generation: 'stale' },
  }), false);
  assert.equal(h.signal('ready'), true);
  assert.equal(h.signal('activity'), true);
  assert.equal(h.advance(1_000), 1_000);

  h.usage.frameNavigated({ slug: 'notes', frame: h.frame, src: 'https://notes.apps.test/next' });
  assert.equal(h.signal('activity'), false, 'the previous document generation cannot extend the lease');
  assert.equal(h.advance(1_000), 0, 'navigation returns the collector to loading');
  h.usage.frameFailed(h.frame);
  assert.equal(h.advance(1_000), 0, 'a failed document never becomes usable from its load event');
});

test('a self-navigation load rotates the document generation', async () => {
  const h = await collectorHarness();
  assert.equal(h.signal('ready'), true);
  const oldGeneration = h.posts.at(-1).message.generation;
  assert.equal(h.usage.frameLoaded(h.frame), true);
  const nextGeneration = h.posts.at(-1).message.generation;
  assert.notEqual(nextGeneration, oldGeneration);
  assert.equal(h.usage.handleFrameMessage({
    source: h.frame.contentWindow,
    origin: 'https://notes.apps.test',
    data: { __usernode_engagement: 'ready', generation: oldGeneration },
  }), false);
  assert.equal(h.usage.handleFrameMessage({
    source: h.frame.contentWindow,
    origin: 'https://notes.apps.test',
    data: { __usernode_engagement: 'ready', generation: nextGeneration },
  }), true);
});

test('elapsed use is split across UTC occurrence days before upload', async () => {
  const h = await collectorHarness({ startAt: Date.parse('2026-09-30T23:59:59Z') });
  h.signal('ready');
  h.signal('activity');
  assert.equal(h.advance(3_000), 3_000);
  const rows = Object.values(h.usage.debug().state.buffers)
    .sort((a, b) => a.day.localeCompare(b.day));
  assert.deepEqual(rows.map((row) => [row.day, row.milliseconds]), [
    ['2026-09-30', 1_000],
    ['2026-10-01', 2_000],
  ]);
});

test('failed and lost-ack uploads retain one stable batch until acknowledgement', async () => {
  const attempts = [];
  const h = await collectorHarness({
    fetch: async (url, options) => {
      attempts.push({ url, body: JSON.parse(options.body) });
      throw new Error('response lost');
    },
  });
  h.signal('ready');
  h.signal('activity');
  h.advance(2_500);
  assert.equal(await h.usage.flush(), false);
  assert.equal(h.usage.debug().state.batches.length, 1);

  h.setFetch(async (url, options) => {
    attempts.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 200 };
  });
  assert.equal(await h.usage.flush(), true);
  assert.equal(h.usage.debug().state.batches.length, 0);
  assert.deepEqual(attempts[1].body, attempts[0].body, 'retry keeps the exact receipt and payload');
  assert.equal(attempts[0].body.entries[0].date, '2026-10-01');
  assert.equal(attempts[0].body.entries[0].seconds, 2);
});

test('transient HTTP failures retain seconds while authentication loss clears them', async () => {
  const h = await collectorHarness({
    fetch: async () => ({ ok: false, status: 503 }),
  });
  h.signal('ready');
  h.signal('activity');
  h.advance(1_000);
  assert.equal(await h.usage.flush(), false);
  assert.equal(h.usage.debug().state.batches.length, 1);

  h.setFetch(async () => ({ ok: false, status: 401 }));
  assert.equal(await h.usage.flush(), false);
  assert.deepEqual(h.usage.debug().state, { owner: null, batches: [], buffers: {} });
});

test('switching accounts clears the prior account queue and buffers', async () => {
  const h = await collectorHarness({ fetch: async () => { throw new Error('offline'); } });
  h.signal('ready');
  h.signal('activity');
  h.advance(2_000);
  await h.usage.flush();
  assert.equal(h.usage.debug().state.batches.length, 1);

  h.usage.start({ slug: 'notes', userId: 9, isVisible: () => true });
  await Promise.resolve();
  const state = h.usage.debug().state;
  assert.equal(state.owner, '9');
  assert.deepEqual(state.batches, []);
  assert.deepEqual(state.buffers, {});
});

test('switching apps keeps same-account memory when storage is unavailable', async () => {
  const storage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('quota'); },
    removeItem() { throw new Error('blocked'); },
  };
  const attempts = [];
  const h = await collectorHarness({
    storage,
    fetch: async (url, options) => {
      attempts.push({ url, body: JSON.parse(options.body) });
      throw new Error('offline');
    },
  });
  h.signal('ready');
  h.signal('activity');
  h.advance(2_000);
  await h.usage.flush();
  const before = h.usage.debug().state.batches[0];
  assert.ok(before);

  assert.equal(h.usage.start({ slug: 'calendar', userId: 7, isVisible: () => true }), true);
  await Promise.resolve();
  const after = h.usage.debug().state.batches[0];
  assert.deepEqual(after, before);
  assert.deepEqual(attempts[1]?.body, attempts[0].body,
    'an app switch retries the immutable in-memory batch');
});

test('storage discovery tolerates a throwing localStorage getter', async () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    get() { throw new Error('storage policy'); },
  });
  try {
    await assert.doesNotReject(import(`${MODULE_URL}?throwing-storage=${Date.now()}`));
  } finally {
    if (prior) Object.defineProperty(globalThis, 'window', prior);
    else delete globalThis.window;
  }
});

test('hung uploads time out and a prior account response cannot mutate the new account', async () => {
  let aborted = false;
  const timed = await collectorHarness({
    fetch: (_url, options) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      });
    }),
    collectorOptions: { fetchTimeoutMs: 15 },
  });
  timed.signal('ready');
  timed.signal('activity');
  timed.advance(1_000);
  assert.equal(await timed.usage.flush(), false);
  assert.equal(aborted, true);
  assert.equal(timed.usage.debug().state.batches.length, 1);

  let resolveOld;
  const epoch = await collectorHarness({
    fetch: () => new Promise((resolve) => { resolveOld = resolve; }),
    collectorOptions: { fetchTimeoutMs: 1_000 },
  });
  epoch.signal('ready');
  epoch.signal('activity');
  epoch.advance(1_000);
  const oldFlush = epoch.usage.flush();
  assert.equal(typeof resolveOld, 'function');
  epoch.usage.start({ slug: 'notes', userId: 9, isVisible: () => true });
  resolveOld({ ok: true, status: 200 });
  assert.equal(await oldFlush, false);
  assert.deepEqual(epoch.usage.debug().state, { owner: '9', batches: [], buffers: {} });
});

test('the embedded bridge only forwards trusted input after a parent probe', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/usernode-bridge/v1/bridge.js'), 'utf8');
  const mirror = fs.readFileSync(path.join(__dirname, '../public/usernode-bridge.js'), 'utf8');
  assert.equal(mirror, source, 'versioned and unversioned bridge copies agree');
  const begin = source.indexOf('/* __USERNODE_ENGAGEMENT_BEGIN__ */');
  const end = source.indexOf('/* __USERNODE_ENGAGEMENT_END__ */');
  assert.ok(begin > 0 && end > begin);
  const listeners = new Map();
  const posts = [];
  const parent = { postMessage: (message, origin) => posts.push({ message, origin }) };
  const window = {
    parent,
    addEventListener(name, fn) {
      const list = listeners.get(name) || [];
      list.push(fn);
      listeners.set(name, list);
    },
  };
  vm.runInNewContext(source.slice(begin, end), { window, Date });
  const emit = (name, event) => (listeners.get(name) || []).forEach((fn) => fn(event));
  emit('pointerdown', { isTrusted: true });
  assert.equal(posts.length, 0, 'input before the shell probe is ignored');
  emit('message', {
    source: parent,
    origin: 'https://app.onhomeroom.com',
    data: { __usernode_engagement: 'probe', generation: 'g1' },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(posts[0])), {
    message: { __usernode_engagement: 'ready', generation: 'g1' },
    origin: 'https://app.onhomeroom.com',
  });
  emit('keydown', { isTrusted: false });
  assert.equal(posts.length, 1, 'script-created input is ignored');
  emit('pointerdown', { isTrusted: true });
  assert.equal(posts[1].message.__usernode_engagement, 'activity');
});

test('server parsing keeps legacy compatibility and bounds receipt-backed days', () => {
  assert.deepEqual(activityService.parseActivityRequest({ seconds: 29.6 }), {
    legacy: true, seconds: 30,
  });
  const now = new Date('2026-10-01T18:00:00Z');
  const parsed = activityService.parseActivityRequest({
    version: 1,
    batchId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    entries: [
      { date: '2026-10-01', seconds: 12 },
      { date: '2026-09-24', seconds: 8 },
    ],
  }, now);
  assert.equal(parsed.entries[0].date, '2026-09-24');
  assert.equal(parsed.entries[1].date, '2026-10-01');
  assert.equal(parsed.payloadHash.length, 64);
  for (const entries of [
    [{ date: '2026-09-23', seconds: 1 }],
    [{ date: '2026-10-02', seconds: 1 }],
    [{ date: '2026-10-01', seconds: 3601 }],
    [{ date: '2026-10-01', seconds: 1.5 }],
  ]) {
    assert.equal(activityService.parseActivityRequest({
      version: 1,
      batchId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      entries,
    }, now), null);
  }
});
