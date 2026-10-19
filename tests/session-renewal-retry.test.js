'use strict';

// frontend/src/lib/session-renewal-retry.ts (#5049): in the mobile app the
// web session is renewed through the native bridge, and the server rotates it,
// so a request it reached in between was refused 401 with nothing wrong. Such
// a request is sent again once the renewal has landed. Driven with a fake
// window whose `fetch` answers from a script and whose NativeChrome reports a
// renewal the test moves by hand.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const MOD = 'frontend/src/lib/session-renewal-retry.ts';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function response(status) {
  return { status, ok: status < 400, json: async () => ({}) };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness({ answers, native = true, onSend = null }) {
  const mod = loadTsx(MOD);
  const calls = [];
  const renewal = { epoch: 0, settled: null };
  const win = {
    location: { href: 'https://app.onhomeroom.com/app/notes/dev/changes/42', origin: 'https://app.onhomeroom.com' },
    fetch: async (input, init) => {
      calls.push({ input, method: (init && init.method) || 'GET', body: init && init.body });
      if (onSend) onSend(calls.length, renewal);
      return answers.shift() || response(200);
    },
  };
  if (native) win.NativeChrome = { webSessionRenewal: () => ({ ...renewal }) };
  mod.installSessionRenewalRetry(win);
  return { win, calls, renewal };
}

test('a 401 that meets a renewal still running waits for it, then is sent again', async () => {
  const run = deferred();
  const h = harness({
    answers: [response(401), response(200)],
    onSend: (n, renewal) => { if (n === 1) renewal.settled = run.promise; },
  });
  const pending = h.win.fetch('/api/apps/notes/changes/42');
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.length, 1, 'nothing is resent before the renewal lands');
  h.renewal.epoch = 1;
  h.renewal.settled = null;
  run.resolve(true);
  const res = await pending;
  assert.equal(res.status, 200, 'the caller sees the retry, as if the first request had landed');
  assert.deepEqual(h.calls.map((c) => c.input), ['/api/apps/notes/changes/42', '/api/apps/notes/changes/42']);
});

test('a 401 whose request was out while a renewal landed is sent again', async () => {
  const h = harness({
    answers: [response(401), response(200)],
    onSend: (n, renewal) => { if (n === 1) renewal.epoch = 1; },
  });
  const res = await h.win.fetch('/api/sessions/7/vote', { method: 'POST', body: '{"vote":"yes"}' });
  assert.equal(res.status, 200);
  assert.deepEqual(h.calls.map((c) => [c.method, c.body]), [
    ['POST', '{"vote":"yes"}'],
    ['POST', '{"vote":"yes"}'],
  ], 'a write refused at the auth check is sent again unchanged');
});

test('with no renewal, outside the app, or across origins, a 401 is returned as it arrived', async () => {
  const quiet = harness({ answers: [response(401)] });
  assert.equal((await quiet.win.fetch('/api/auth/me')).status, 401);
  assert.equal(quiet.calls.length, 1, 'signed out is signed out');

  const web = harness({ answers: [response(401)], native: false });
  assert.equal((await web.win.fetch('/api/apps/notes')).status, 401);
  assert.equal(web.calls.length, 1);

  const foreign = harness({
    answers: [response(401)],
    onSend: (n, renewal) => { renewal.epoch = 1; },
  });
  assert.equal((await foreign.win.fetch('https://api.example.test/thing')).status, 401);
  assert.equal(foreign.calls.length, 1, 'another origin never carried this cookie');
});

test('a renewal that fails retries nothing', async () => {
  const run = deferred();
  const h = harness({
    answers: [response(401)],
    onSend: (n, renewal) => { renewal.settled = run.promise; },
  });
  const pending = h.win.fetch('/api/apps/notes');
  run.reject(new Error('offline'));
  assert.equal((await pending).status, 401);
  assert.equal(h.calls.length, 1);
});

test('a second 401 is returned, not retried again: there is no loop', async () => {
  const h = harness({
    answers: [response(401), response(401)],
    onSend: (n, renewal) => { renewal.epoch = n; },
  });
  assert.equal((await h.win.fetch('/api/apps/notes')).status, 401);
  assert.equal(h.calls.length, 2);
});

test('a Request is cloned before it is first sent, and a streamed body is never resent', async () => {
  const sent = [];
  const req = { url: '/api/apps/notes/issues', clone() { sent.push('clone'); return { url: this.url, cloned: true }; } };
  const prior = global.Request;
  global.Request = function Request() {};
  Object.setPrototypeOf(req, global.Request.prototype);
  try {
    const h = harness({
      answers: [response(401), response(200)],
      onSend: (n, renewal) => { renewal.epoch = 1; },
    });
    await h.win.fetch(req);
    assert.deepEqual(sent, ['clone']);
    assert.equal(h.calls[1].input.cloned, true, 'the retry sends the clone');
  } finally {
    if (prior === undefined) delete global.Request; else global.Request = prior;
  }
  if (typeof ReadableStream !== 'undefined') {
    const h = harness({
      answers: [response(401)],
      onSend: (n, renewal) => { renewal.epoch = 1; },
    });
    const res = await h.win.fetch('/api/uploads', { method: 'POST', body: new ReadableStream() });
    assert.equal(res.status, 401);
    assert.equal(h.calls.length, 1);
  }
});

test('the shell installs it before app.js boots, beside the join wrapper', () => {
  const main = read('frontend/src/main.tsx');
  const join = main.indexOf("bootStep('installJoinRequired'");
  const retry = main.indexOf("bootStep('installSessionRenewalRetry'");
  assert.ok(join > 0 && retry > join, 'installed at module scope, with the other fetch wrapper');
  assert.ok(retry < main.indexOf('hydrateRoot(document.body'), 'before hydration, so before DOMContentLoaded runs App.init');
});
