'use strict';

// Live updates in the ready-made apps ("Add SSE to all of the templated
// apps", Evan, 20 Oct 2026: a tier list showed other people's changes only
// after a long delay). Both halves, as files, the way services/template.js
// writes them into every ready-made app:
//
//   app-templates/_scaffold/live-updates.js         GET /api/changes, an
//     event stream server.js mounts after the sign-in check and before
//     api.js, which says "something changed" after every write to /api/*
//     that succeeds;
//   app-templates/_scaffold/public/live-updates.js  the page's half, which
//     listens and calls the screen's own load again.
//
// Each ready-made app's wiring (its page loads the script, its app.js
// watches) is pinned in tests/app-templates.test.js, and the stream is
// driven against a running app in tests/app-templates-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');

const SERVER_HALF = path.join(__dirname, '..', 'app-templates', '_scaffold', 'live-updates.js');
const PAGE_HALF = path.join(__dirname, '..', 'app-templates', '_scaffold', 'public', 'live-updates.js');

// The module keeps who is listening for the process: a fresh copy per test.
function freshLive() {
  delete require.cache[require.resolve(SERVER_HALF)];
  return require(SERVER_HALF);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function appWith(live) {
  const app = express();
  live.mount(app);
  app.post('/api/ok', (_req, res) => res.status(201).json({ id: 1 }));
  app.put('/api/ok', (_req, res) => res.json({ ok: true }));
  app.post('/api/bad', (_req, res) => res.status(400).json({ error: 'no' }));
  app.get('/api/read', (_req, res) => res.json({ rows: [] }));
  app.post('/outside', (_req, res) => res.json({ ok: true }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    call: (method, url) => fetch(base + url, { method }).then((r) => r.status),
    close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
  };
}

/** An open stream: its response, everything read so far, and a wait for more. */
function stream(base) {
  return new Promise((resolve, reject) => {
    const req = http.get(base + '/api/changes', (res) => {
      const s = { res, req, text: '', ended: false };
      res.setEncoding('utf8');
      res.on('data', (chunk) => { s.text += chunk; });
      res.on('end', () => { s.ended = true; });
      s.events = () => (s.text.match(/^event: change\ndata: \{\}\n\n/gm) || []).length;
      s.until = async (check, ms = 2000) => {
        const end = Date.now() + ms;
        while (!check(s)) {
          if (Date.now() > end) throw new Error('not in time: ' + JSON.stringify(s.text));
          await sleep(10);
        }
      };
      resolve(s);
    });
    req.on('error', reject);
  });
}

test('the stream: an event stream nothing holds back, opened at once', async (t) => {
  const live = freshLive();
  const app = await appWith(live);
  t.after(() => { live.close(); return app.close(); });
  const s = await stream(app.base);
  assert.equal(s.res.statusCode, 200);
  assert.equal(s.res.headers['content-type'], 'text/event-stream');
  assert.equal(s.res.headers['cache-control'], 'no-cache, no-transform', 'nothing that compresses holds an event back');
  assert.equal(s.res.headers['x-accel-buffering'], 'no');
  await s.until((x) => x.text.length > 0);
  assert.equal(s.text, 'retry: 3000\n:ok\n\n', 'opened at once, and how long a dropped one waits');
  assert.equal(live.PATH, '/api/changes');
  assert.equal(live.count(), 1);
});

test('every write to /api/* that succeeds says so, once for a burst; nothing else does', async (t) => {
  const live = freshLive();
  const app = await appWith(live);
  t.after(() => { live.close(); return app.close(); });
  const a = await stream(app.base);
  const b = await stream(app.base);
  await a.until(() => live.count() === 2);

  assert.equal(await app.call('POST', '/api/ok'), 201);
  await a.until((x) => x.events() === 1);
  await b.until((x) => x.events() === 1);
  assert.doesNotMatch(a.text, /id|ok"|\{"/, 'the event carries nothing about what changed');

  // A burst is one event.
  await Promise.all([app.call('PUT', '/api/ok'), app.call('POST', '/api/ok'), app.call('PUT', '/api/ok')]);
  await a.until((x) => x.events() === 2);
  await sleep(live.BATCH_MS * 3);
  assert.equal(a.events(), 2, 'writes close together are one event');

  // A refused write, a read and a write outside /api/ say nothing.
  assert.equal(await app.call('POST', '/api/bad'), 400);
  assert.equal(await app.call('GET', '/api/read'), 200);
  assert.equal(await app.call('POST', '/outside'), 200);
  await sleep(live.BATCH_MS * 3);
  assert.equal(a.events(), 2);

  // A change made some other way calls notify().
  live.notify();
  await a.until((x) => x.events() === 3);
});

test('a heartbeat every 15 seconds while anybody listens, and none after', async (t) => {
  const live = freshLive();
  const app = await appWith(live);
  t.after(() => { live.close(); return app.close(); });
  assert.equal(live.HEARTBEAT_MS, 15000, 'well inside the proxies\' 60 second idle timeout');
  const real = { set: global.setInterval, clear: global.clearInterval };
  const beats = [];
  global.setInterval = (fn, ms) => { const h = { fn, ms, cleared: false, unref() { return h; } }; beats.push(h); return h; };
  global.clearInterval = (h) => { if (h && beats.includes(h)) h.cleared = true; else real.clear(h); };
  try {
    const s = await stream(app.base);
    await s.until((x) => x.text.includes(':ok'));
    assert.equal(beats.length, 1);
    assert.equal(beats[0].ms, 15000);
    beats[0].fn();
    await s.until((x) => x.text.endsWith(':heartbeat\n\n'));
    // The last listener gone: the heartbeat stops with it.
    s.req.destroy();
    const end = Date.now() + 2000;
    while (live.count() && Date.now() < end) await sleep(10);
    assert.equal(live.count(), 0);
    assert.equal(beats[0].cleared, true);
  } finally {
    global.setInterval = real.set;
    global.clearInterval = real.clear;
  }
});

test('on SIGTERM close() ends every stream and opens no more', async (t) => {
  const live = freshLive();
  const app = await appWith(live);
  t.after(() => app.close());
  const s = await stream(app.base);
  await s.until((x) => x.text.includes(':ok'));
  live.close();
  await s.until((x) => x.ended);
  assert.equal(live.count(), 0);
  const res = await fetch(app.base + '/api/changes');
  assert.equal(res.status, 503, 'a page asking again reaches the next container instead');
  live.notify();
});

// ── The page's half ──────────────────────────────────────────────────────

/** A page with a clock that moves only when told, an EventSource that does what it is told, and the script. */
function page({ search = '?token=abc.def' } = {}) {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  const sources = [];
  const docListeners = {};
  const winListeners = {};
  class EventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.closed = false;
      this.listeners = {};
      sources.push(this);
    }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    close() { this.closed = true; this.readyState = 2; }
    fire(type) { (this.listeners[type] || []).forEach((fn) => fn({ type, data: '{}' })); }
  }
  EventSource.CONNECTING = 0;
  EventSource.OPEN = 1;
  EventSource.CLOSED = 2;
  const sandbox = {
    EventSource,
    URLSearchParams,
    Promise,
    Math,
    document: {
      hidden: false,
      addEventListener: (type, fn) => { (docListeners[type] = docListeners[type] || []).push(fn); },
    },
    setTimeout: (fn, ms) => { nextId += 1; timers.set(nextId, { fn, at: now + (ms || 0) }); return nextId; },
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: (fn, ms) => { nextId += 1; timers.set(nextId, { fn, at: now + ms, every: ms }); return nextId; },
    clearInterval: (id) => { timers.delete(id); },
  };
  sandbox.window = {
    location: { search },
    addEventListener: (type, fn) => { (winListeners[type] = winListeners[type] || []).push(fn); },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PAGE_HALF, 'utf8'), sandbox);
  const flush = () => new Promise((r) => setImmediate(r));
  return {
    LiveUpdates: sandbox.window.LiveUpdates,
    sources,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        let due = null;
        for (const [id, t] of timers) if (t.at <= end && (!due || t.at < due[1].at)) due = [id, t];
        if (!due) break;
        now = due[1].at;
        if (due[1].every) due[1].at += due[1].every; else timers.delete(due[0]);
        due[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
    hide(hidden) { sandbox.document.hidden = hidden; (docListeners.visibilitychange || []).forEach((fn) => fn()); },
    shell(hidden) { (winListeners['usernode:visibility-changed'] || []).forEach((fn) => fn({ detail: { hidden } })); },
  };
}

function watched(p, opts = {}) {
  const calls = { refresh: 0 };
  let quiet = true;
  const handle = p.LiveUpdates.watch({
    refresh: () => { calls.refresh += 1; return Promise.resolve(); },
    quiet: () => quiet,
    ...opts,
  });
  return { calls, handle, setQuiet: (q) => { quiet = q; } };
}

test('the page listens with its own token and fetches once for a burst of changes', async () => {
  const p = page();
  const w = watched(p);
  assert.equal(p.sources.length, 1);
  assert.equal(p.sources[0].url, '/api/changes?token=abc.def');
  const es = p.sources[0];
  es.fire('open');
  await p.advance(1000);
  assert.equal(w.calls.refresh, 0, 'the first open is the page\'s own first load');
  es.fire('change');
  es.fire('change');
  await p.advance(100);
  es.fire('change');
  await p.advance(149);
  assert.equal(w.calls.refresh, 0, 'it waits a moment for the rest of a burst');
  await p.advance(1);
  assert.equal(w.calls.refresh, 1, 'three changes, one fetch, a quarter second after the first');
  await p.advance(1000);
  assert.equal(w.calls.refresh, 1);
  // At its own address there is no ?token=: the edge signs the request.
  const bare = page({ search: '' });
  bare.LiveUpdates.watch({ refresh() {} });
  assert.equal(bare.sources[0].url, '/api/changes');
});

test('a change heard mid-drag or mid-typing waits for quiet, and is never dropped', async () => {
  const p = page();
  const w = watched(p);
  w.setQuiet(false);
  p.sources[0].fire('change');
  await p.advance(5000);
  assert.equal(w.calls.refresh, 0, 'nothing redraws under somebody busy');
  w.setQuiet(true);
  await p.advance(300);
  assert.equal(w.calls.refresh, 1, 'fetched the moment it is quiet');
  // The screen can say so itself (a load it dropped mid-drag).
  w.handle.changed();
  await p.advance(250);
  assert.equal(w.calls.refresh, 2);
});

test('a stream that drops is the browser\'s to reconnect; one refused is tried again, less often', async () => {
  const p = page();
  const w = watched(p);
  const first = p.sources[0];
  first.fire('open');
  // Dropped: the browser reconnects it (CONNECTING); nothing to do here.
  first.readyState = 0;
  first.fire('error');
  assert.equal(first.closed, false);
  assert.equal(p.sources.length, 1);
  // Reconnected: changes made meanwhile were not heard, so fetch.
  first.readyState = 1;
  first.fire('open');
  await p.advance(250);
  assert.equal(w.calls.refresh, 1);
  // Refused (a token that ran out): closed, and opened again after 2 s, then 4 s.
  first.readyState = 2;
  first.fire('error');
  assert.equal(first.closed, true);
  await p.advance(1999);
  assert.equal(p.sources.length, 1);
  await p.advance(1);
  assert.equal(p.sources.length, 2);
  p.sources[1].readyState = 2;
  p.sources[1].fire('error');
  await p.advance(3999);
  assert.equal(p.sources.length, 2);
  await p.advance(1);
  assert.equal(p.sources.length, 3);
  p.sources[2].fire('open');
  await p.advance(250);
  assert.equal(w.calls.refresh, 2, 'back after being refused: fetch what was missed');
});

test('nobody looking: it lets go of the stream; back on screen it fetches and listens again', async () => {
  const p = page();
  const w = watched(p);
  p.hide(true);
  assert.equal(p.sources[0].closed, true, 'a hidden tab holds no connection');
  await p.advance(120000);
  assert.equal(w.calls.refresh, 0, 'and looks at nothing');
  p.hide(false);
  await p.advance(250);
  assert.equal(w.calls.refresh, 1, 'what changed while it was hidden');
  assert.equal(p.sources.length, 2);
  assert.equal(p.sources[1].closed, false);
  // Homeroom keeping the app loaded but hidden is the same.
  p.shell(true);
  assert.equal(p.sources[1].closed, true);
  p.sources[1].fire('change');
  await p.advance(1000);
  assert.equal(w.calls.refresh, 1);
  p.shell(false);
  await p.advance(250);
  assert.equal(w.calls.refresh, 2);
  assert.equal(p.sources.length, 3);
});

test('it looks every minute whatever the stream says', async () => {
  const p = page();
  const w = watched(p);
  await p.advance(59999);
  assert.equal(w.calls.refresh, 0);
  await p.advance(1 + 250);
  assert.equal(w.calls.refresh, 1);
  await p.advance(60000);
  assert.equal(w.calls.refresh, 2);
});
