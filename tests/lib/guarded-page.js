'use strict';

// A page whose `fetch` is the REAL session guard (frontend/src/lib/
// api-cache-identity.ts), with a scripted server underneath (#6014).
//
// The guard broke four screens in five days (#5931, #5934, #5936, #5951) and
// no test saw it: the screens' tests handed them a plain fake fetch, and the
// guard's own tests drove it with no screen on top. A screen test that wants
// the guard between it and its reads installs this page, runs the screen's
// real read (it calls the bare global `fetch`, which is now the guard), and
// moves the session under it the way the shell does:
//
//   - `signedOutMe()`: a signed-out boot's GET /api/auth/me answers 401, and
//     public/js/app.js drops the session it may never have had
//     (`_dropCachedSession`, then `enterAnonymous`).
//   - `signOut()`: POST /api/auth/logout clears the hint cookie, then the
//     same two calls.
//   - `signIn()`: POST /api/auth/otp/verify sets a new hint cookie, then the
//     shell publishes the new viewer (`setViewer`).
//
// Each can be split in two: `signOut({ hold: true })` returns once the
// logout request has gone out and hands back `land()`, which delivers its
// reply. A real round trip takes that long, and reads start and finish
// inside it.
//
// The server answers every same-origin request through `routes`, a map from
// a pathname to a handler `(req) => body | Response | Promise`. `hold(path)`
// makes the next request to `path` wait until the test answers it. Like
// src/services/browser-api-cache.js, a request made while a hint cookie is
// set is answered with that session's scope label.

const { loadTsx } = require('./render-tsx');

const ORIGIN = 'https://platform.test';
const SCOPE_HEADER = 'X-Usernode-Cache-Scope';
const EXPIRY_HEADER = 'X-Usernode-Cache-Expires';
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

/** Settle every microtask and timer-free continuation already queued. */
const flush = async (rounds = 5) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function guardedPage({ pathname = '/', signedIn = false, routes = {} } = {}) {
  const { installApiCacheIdentity } = loadTsx('frontend/src/lib/api-cache-identity.ts');
  let cookie = signedIn ? A : null;
  const held = new Map();
  const requests = [];
  const reloads = { count: 0 };

  const location = {
    href: ORIGIN + pathname, origin: ORIGIN, protocol: 'https:', pathname,
    reload() { reloads.count += 1; },
  };
  const respond = (req, body) => {
    if (body instanceof Response) return body;
    const headers = { 'Content-Type': 'application/json' };
    // The session this request carried, as the auth middleware stamps it.
    if (req.scope && !new URL(req.url).pathname.startsWith('/api/public/')) {
      headers[SCOPE_HEADER] = req.scope;
      headers[EXPIRY_HEADER] = new Date(Date.now() + 3600e3).toISOString();
    }
    return new Response(JSON.stringify(body), { status: 200, headers });
  };
  const server = async (input, init) => {
    const req = new Request(input, init);
    const path = new URL(req.url).pathname;
    req.scope = cookie;
    requests.push(path);
    const wait = held.get(path);
    const route = routes[path];
    if (wait) {
      held.delete(path);
      wait.arrived.resolve(req);
      // Answered with nothing, a held request gets its route's own reply.
      const body = await wait.reply.promise;
      return respond(req, body === undefined && route ? await route(req) : body);
    }
    if (!route) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    return respond(req, await route(req));
  };

  const win = {
    document: {
      get cookie() { return cookie ? `usernode_api_scope=${cookie}` : ''; },
      set cookie(value) {
        const m = /^usernode_api_scope=([a-f0-9]{64})/.exec(value);
        if (m) cookie = m[1];
      },
    },
    location,
    App: signedIn ? { user: { id: 7 } } : undefined,
    localStorage: { setItem() {} },
    addEventListener() {},
    fetch: server,
  };
  installApiCacheIdentity(win);
  const bridge = win.UsernodeReact.apiCache;
  if (signedIn) bridge.setViewer(7, true);

  const saved = { fetch: globalThis.fetch, location: Object.getOwnPropertyDescriptor(globalThis, 'location') };
  globalThis.fetch = win.fetch;
  Object.defineProperty(globalThis, 'location', { value: location, configurable: true, writable: true });

  /** The shell's half of a session ending (App._dropCachedSession, enterAnonymous). */
  const dropSession = () => {
    bridge.reset({ broadcast: true });
    bridge.setViewer(null, true);
    win.App = undefined;
  };

  /** Send an auth request through the guard; with `hold`, return before its reply. */
  async function authRound(path, method, after, hold) {
    const wait = hold ? page.hold(path) : null;
    const sent = win.fetch(path, { method, credentials: 'same-origin' }).catch((err) => err);
    if (!hold) { after(await sent); return null; }
    await wait.arrived;
    return { land: async () => { wait.answer(undefined); after(await sent); await flush(); } };
  }

  const page = {
    win, requests, reloads,
    get scope() { return cookie; },
    /** Make the next request to `path` wait; answer it with `answer(body)`. */
    hold(path) {
      const wait = { arrived: deferred(), reply: deferred() };
      held.set(path, wait);
      return { arrived: wait.arrived.promise, answer: (body) => wait.reply.resolve(body) };
    },
    async signedOutMe() {
      const res = await win.fetch('/api/auth/me', { credentials: 'same-origin' }).catch((err) => err);
      if (res && res.status === 401) dropSession();
      await flush();
    },
    signOut({ hold = false } = {}) {
      routes['/api/auth/logout'] ||= () => { cookie = null; return { ok: true }; };
      return authRound('/api/auth/logout', 'POST', dropSession, hold);
    },
    signIn({ hold = false, scope = B, id = 8 } = {}) {
      routes['/api/auth/otp/verify'] ||= () => { cookie = scope; return { ok: true }; };
      return authRound('/api/auth/otp/verify', 'POST', () => {
        win.App = { user: { id } };
        bridge.setViewer(id, true);
      }, hold);
    },
    restore() {
      globalThis.fetch = saved.fetch;
      if (saved.location) Object.defineProperty(globalThis, 'location', saved.location);
      else delete globalThis.location;
    },
  };
  routes['/api/auth/me'] ||= () => (cookie
    ? { user: { id: win.App?.user?.id ?? 7 } }
    : new Response(JSON.stringify({ error: 'Not signed in' }), { status: 401 }));
  return page;
}

module.exports = { guardedPage, deferred, flush, ORIGIN, A, B };
