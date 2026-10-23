'use strict';

const fs = require('node:fs');
const vm = require('node:vm');
const ORIGIN = 'https://platform.test';
const SCOPE_HEADER = 'X-Usernode-Cache-Scope';
const A = 'a'.repeat(64), B = 'b'.repeat(64);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const json = (body, scope = A, { status = 200, policy = 'private', headers = {} } = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': policy, [SCOPE_HEADER]: scope, ...headers },
});

// Real worker code and native Request/Response/streams, with only the browser
// storage/network/lifecycle APIs replaced. Cache handles survive deletion,
// matching Cache Storage's behavior rather than hiding late-write races.
function worker({ source = fs.readFileSync(require.resolve('../../public/sw.js'), 'utf8'), fetcher } = {}) {
  const stores = new Map(), handlers = {}, messages = [], requests = [], lifetime = [];
  let network = fetcher || (async () => json({ fake: 'A' }));
  const keyOf = key => new URL(typeof key === 'string' ? key : key.url, ORIGIN).href;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const data = stores.get(name);
      return {
        async match(key) { return data.get(keyOf(key))?.clone(); },
        async put(key, response) { data.set(keyOf(key), response.clone()); },
        async delete(key) { return data.delete(keyOf(key)); },
        async keys() { return [...data.keys()].map(key => new Request(key)); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  const fetch = async (request, init) => {
    const req = new Request(typeof request === 'string' ? new URL(request, ORIGIN) : request, init);
    requests.push(req);
    return network(req);
  };
  vm.runInNewContext(source, {
    self: { location: { origin: ORIGIN }, addEventListener(name, fn) { handlers[name] = fn; },
      clients: { claim: async () => {}, matchAll: async () => [{ postMessage: m => messages.push(m) }] },
      skipWaiting: async () => {} },
    URL, Headers, Request, Response, ReadableStream, DOMException,
    caches, fetch, setTimeout, clearTimeout,
  });
  const waitUntil = promise => { lifetime.push(Promise.resolve(promise)); };
  return {
    stores, caches, handlers, requests, messages,
    setNetwork(fn) { network = fn; },
    async get(scope = A, path = '/api/private-fixture', init = {}) {
      const headers = new Headers(init.headers);
      if (scope) headers.set(SCOPE_HEADER, scope);
      const request = new Request(new URL(path, ORIGIN), { cache: 'reload', ...init, headers });
      let result;
      handlers.fetch({ request, waitUntil, respondWith(promise) { result = promise; } });
      return result === undefined ? fetch(request) : result;
    },
    async message(data) {
      handlers.message({ data, waitUntil });
      await this.drain();
    },
    async activate() {
      handlers.activate({ waitUntil });
      await this.drain();
    },
    async drain() {
      let handled = 0;
      while (handled < lifetime.length) {
        const batch = lifetime.slice(handled); handled = lifetime.length;
        await Promise.all(batch);
      }
    },
  };
}

module.exports = { worker, json, deferred, A, B, ORIGIN, SCOPE_HEADER };
