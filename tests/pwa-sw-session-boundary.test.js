// Runtime proof for the legacy worker's cross-tab logout boundary.
//
// Client A starts an authenticated GET and holds its network response. Client B
// advances the session epoch through the worker's logout message. When A's old
// response finally arrives, the real worker runtime must refuse to cache it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ORIGIN = 'https://social-vibecoding.example';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

function cacheKey(value) {
  return typeof value === 'string'
    ? new URL(value, ORIGIN).href
    : value.url;
}

function createWorkerRuntime(network) {
  const listeners = new Map();
  const stores = new Map();
  const puts = [];

  function cacheFor(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    const entries = stores.get(name);
    return {
      async add() {},
      async delete(request) {
        return entries.delete(cacheKey(request));
      },
      async keys() {
        return [...entries.keys()].map((url) => new Request(url));
      },
      async match(request) {
        return entries.get(cacheKey(request))?.clone();
      },
      async put(request, response) {
        puts.push({ cache: name, key: cacheKey(request) });
        entries.set(cacheKey(request), response.clone());
      },
    };
  }

  const caches = {
    async delete(name) {
      return stores.delete(name);
    },
    async keys() {
      return [...stores.keys()];
    },
    async open(name) {
      return cacheFor(name);
    },
  };
  const self = {
    clients: { async claim() {} },
    location: { origin: ORIGIN },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    async skipWaiting() {},
  };
  const context = vm.createContext({
    URL,
    Headers,
    Request,
    Response,
    Promise,
    Date,
    console,
    caches,
    fetch: network,
    self,
  });
  vm.runInContext(fs.readFileSync(require.resolve('../public/sw.js'), 'utf8'), context);
  return { caches, listeners, puts };
}

function dispatchFetch(listener, request) {
  const background = [];
  let response;
  listener({
    request,
    respondWith(value) {
      response = Promise.resolve(value);
    },
    waitUntil(value) {
      background.push(Promise.resolve(value));
    },
  });
  return {
    background,
    response: () => response,
  };
}

test('a delayed authenticated response cannot cross a logout epoch', async () => {
  const oldSessionResponse = deferred();
  const runtime = createWorkerRuntime(() => oldSessionResponse.promise);
  const fetchListener = runtime.listeners.get('fetch');
  const messageListener = runtime.listeners.get('message');
  assert.equal(typeof fetchListener, 'function');
  assert.equal(typeof messageListener, 'function');

  // Client A begins the request and captures epoch 0 before waiting on the
  // network response.
  const request = new Request(`${ORIGIN}/api/auth/me`, {
    headers: { accept: 'application/json' },
  });
  const clientA = dispatchFetch(fetchListener, request);
  await new Promise((resolve) => setImmediate(resolve));

  // Client B logs out while A's response is still in flight.
  const logoutWork = [];
  let logoutReply;
  messageListener({
    data: { type: 'clear-api-cache' },
    ports: [{ postMessage(value) { logoutReply = value; } }],
    waitUntil(value) { logoutWork.push(Promise.resolve(value)); },
  });
  await Promise.all(logoutWork);
  assert.equal(logoutReply.done, true);
  assert.equal(Number.isSafeInteger(logoutReply.epoch), true);

  oldSessionResponse.resolve(new Response(JSON.stringify({ user: { id: 7 } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  assert.equal((await clientA.response()).status, 200);
  await Promise.all(clientA.background);

  assert.equal(
    runtime.puts.some(({ cache }) => cache.startsWith('usernode-api-')),
    false,
    'the old-session response must not be written after logout',
  );
  const api = await runtime.caches.open('usernode-api-v1');
  assert.equal(await api.match(request), undefined);
});
