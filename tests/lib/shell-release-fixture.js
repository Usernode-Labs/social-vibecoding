'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { buildShellRelease } = require('../../scripts/build-shell-release');
const { SHELL_ASSETS } = require('../../public/sw');
const ROOT = path.join(__dirname, '../..');
const ORIGIN = 'https://homeroom.test';

function fixture(t, letter, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-release-'));
  t?.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const revision = letter.repeat(40);
  const put = (url, body) => {
    const file = path.join(root, 'public', url);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  for (const url of SHELL_ASSETS) put(url, `/* stable ${url} */`);
  put('/index.html', `<!doctype html><html><head><meta name="platform-build" content="${revision}"><link rel="stylesheet" href="/b/${revision}/css/app.css"></head><body><div id="version"></div><input id="draft"><script type="module" src="/b/${revision}/js/app.js"></script></body></html>`);
  put('/js/app.js', `document.querySelector('#version').textContent = '${letter}';
    window.loadLazy = () => import('../shell/assets/shell-lazy.js');
    const report = () => navigator.serviceWorker.controller?.postMessage({ type: 'shell-client-build', build: document.querySelector('meta[name="platform-build"]').content });
    navigator.serviceWorker.addEventListener('controllerchange', report); report();
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});`);
  put('/css/app.css', 'body { color: rgb(10, 20, 30); }');
  put('/shell/assets/shell-lazy.js', `export const version = '${letter}';`);
  put('/sw.js', fs.readFileSync(path.join(ROOT, 'public/sw.js')));
  put('/sw-release.js', fs.readFileSync(path.join(ROOT, 'public/sw-release.js')));
  for (const [url, body] of Object.entries(overrides)) put(url, body);
  const manifest = buildShellRelease(root, { revision });
  return { root, revision, manifest, put, read: url => fs.readFileSync(path.join(root, 'public', url)) };
}

function memoryCaches() {
  const stores = new Map();
  const keyOf = request => new URL(typeof request === 'string' ? request : request.url, ORIGIN).href;
  return {
    stores,
    keys: async () => [...stores.keys()],
    delete: async name => stores.delete(name),
    open: async name => {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        match: async request => entries.get(keyOf(request))?.clone(),
        put: async (request, response) => { entries.set(keyOf(request), response.clone()); },
        keys: async () => [...entries.keys()].map(url => new Request(url)),
        delete: async request => entries.delete(keyOf(request)),
      };
    },
  };
}

function harness(initial, caches = memoryCaches()) {
  let serving = initial;
  const requests = [];
  const clients = [];
  let failedPath = null;
  let offline = false;
  let lockTail = Promise.resolve();
  const locks = { request: (_name, action) => {
    const run = lockTail.then(action); lockTail = run.catch(() => {}); return run;
  } };
  const fetcher = async request => {
    const url = new URL(typeof request === 'string' ? request : request.url, ORIGIN);
    requests.push(url.pathname);
    if (offline) throw new Error('offline');
    const pathname = url.pathname.replace(/^\/b\/[a-f0-9]{40}/, '') || '/index.html';
    if (failedPath === pathname) return new Response('unavailable', { status: 503 });
    const headers = { 'x-platform-build': serving.revision,
      'x-platform-build-time': String(serving.revision.charCodeAt(0) * 1000) };
    try { return new Response(serving.read(pathname), { headers }); }
    catch { return new Response('missing', { status: 404 }); }
  };
  function worker(release) {
    const handlers = {};
    const lifecycle = [];
    vm.runInNewContext(release.read('/shell/worker.js').toString(), {
      self: { location: { origin: ORIGIN }, crypto: webcrypto, navigator: { locks },
        addEventListener: (name, handler) => { handlers[name] = handler; },
        skipWaiting: async () => { lifecycle.push('skipWaiting'); },
        clients: { matchAll: async () => clients, claim: async () => { lifecycle.push('claim'); } },
      },
      caches, fetch: fetcher, URL, Headers, Request, Response, AbortSignal,
      setTimeout, clearTimeout,
    });
    async function dispatch(name, extra = {}) {
      const waits = [];
      let result;
      handlers[name]({ ...extra, waitUntil: promise => waits.push(promise), respondWith: promise => { result = promise; } });
      const response = await result;
      await Promise.all(waits);
      return response;
    }
    return {
      lifecycle, dispatch,
      install: () => dispatch('install'), activate: () => dispatch('activate'),
      get: (pathname, clientId = 'tab-a', navigate = false) => dispatch('fetch', {
        clientId, resultingClientId: navigate ? clientId : '',
        request: { method: 'GET', url: ORIGIN + pathname, headers: new Headers(), mode: navigate ? 'navigate' : 'cors' },
      }),
      note: (id, build) => dispatch('message', { source: { id }, data: { type: 'shell-client-build', build } }),
      prefetch: async sha => {
        let reply;
        await dispatch('message', { data: { type: 'prefetch-shell', sha }, ports: [{ postMessage: value => { reply = value; } }] });
        return reply;
      },
    };
  }
  return {
    caches, requests, clients, worker,
    serve: next => { serving = next; },
    fail: pathname => { failedPath = pathname; },
    offline: value => { offline = value; },
  };
}

module.exports = { fixture, memoryCaches, harness };
