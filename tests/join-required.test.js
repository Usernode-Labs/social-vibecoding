'use strict';

// frontend/src/lib/join-required.ts: a write refused with `join_required`
// (src/services/communities.js) becomes a Join prompt, and on a yes the same
// request is sent again, whoever sent it. Driven with a fake window: its
// `fetch` answers from a script, ConfirmModal answers the question, and
// Home.setMembership records the join.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const MOD = 'frontend/src/lib/join-required.ts';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function response(status, body) {
  const text = JSON.stringify(body);
  const make = () => ({ status, ok: status < 400, json: async () => JSON.parse(text), clone: () => make() });
  return make();
}

const REFUSED = { code: 'join_required', error: 'Join Notes to take part.', app: { slug: 'notes', name: 'Notes' } };

function harness({ answers, confirm = true, joins = true }) {
  const mod = loadTsx(MOD);
  const calls = [];
  const asked = [];
  const joined = [];
  const names = [];
  const win = {
    fetch: async (url, init) => {
      calls.push({ url, method: (init && init.method) || 'GET', body: init && init.body });
      const next = answers.shift();
      return next || response(200, { ok: true });
    },
    ConfirmModal: { show: async (o) => { asked.push(o); return confirm; } },
    Home: { setMembership: async (slug, desired, _onChange, opts) => { joined.push([slug, desired]); names.push(opts && opts.name); return joins; } },
  };
  const prior = global.window;
  global.window = win;
  mod.installJoinRequired(win);
  return { mod, win, calls, asked, joined, names, restore: () => { if (prior === undefined) delete global.window; else global.window = prior; } };
}

test('a refused write asks to join, joins, and sends the same request again', async () => {
  const h = harness({ answers: [response(403, REFUSED), response(200, { ok: true, merged: false })] });
  try {
    const res = await h.win.fetch('/api/sessions/7/vote', { method: 'POST', body: '{"vote":"yes"}' });
    assert.equal(res.status, 200, 'the caller sees the retry, as if the first press had landed');
    assert.equal(h.asked.length, 1);
    assert.equal(h.asked[0].title, 'Join Notes?');
    assert.equal(h.asked[0].confirmLabel, 'Join');
    assert.deepEqual(h.joined, [['notes', true]], 'through Home.setMembership, like Discover\'s pill');
    assert.deepEqual(h.names, ['Notes'], 'with the name the refusal carried, for the toast');
    assert.deepEqual(h.calls.map((c) => [c.url, c.method, c.body]), [
      ['/api/sessions/7/vote', 'POST', '{"vote":"yes"}'],
      ['/api/sessions/7/vote', 'POST', '{"vote":"yes"}'],
    ]);
  } finally { h.restore(); }
});

test('a No returns the original refusal to the caller, readable, and sends nothing more', async () => {
  const h = harness({ answers: [response(403, REFUSED)], confirm: false });
  try {
    const res = await h.win.fetch('/api/apps/notes/issues', { method: 'POST', body: '{}' });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'join_required', 'its body was read from a clone');
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.joined, []);
  } finally { h.restore(); }
});

test('a second refusal is returned, not asked about again: there is no loop', async () => {
  const h = harness({ answers: [response(403, REFUSED), response(403, REFUSED)] });
  try {
    const res = await h.win.fetch('/api/apps/notes/sessions', { method: 'POST' });
    assert.equal(res.status, 403);
    assert.equal(h.asked.length, 1);
    assert.equal(h.calls.length, 2);
  } finally { h.restore(); }
});

test('reads and other refusals pass through untouched', async () => {
  const h = harness({ answers: [response(403, REFUSED), response(403, { error: 'Forbidden' }), response(404, { error: 'App not found' })] });
  try {
    assert.equal((await h.win.fetch('/api/apps/notes/community')).status, 403, 'a GET is never retried');
    assert.equal((await h.win.fetch('/api/x', { method: 'POST' })).status, 403, 'a 403 that is not join_required');
    assert.equal((await h.win.fetch('/api/y', { method: 'POST' })).status, 404);
    assert.equal(h.asked.length, 0);
  } finally { h.restore(); }
});

test('two refusals for one app share one question', async () => {
  const h = harness({ answers: [response(403, REFUSED), response(403, REFUSED)] });
  let release;
  h.win.ConfirmModal.show = (o) => { h.asked.push(o); return new Promise((r) => { release = r; }); };
  try {
    const a = h.win.fetch('/api/sessions/7/vote', { method: 'POST' });
    const b = h.win.fetch('/api/apps/notes/messages', { method: 'POST' });
    await new Promise((r) => setTimeout(r, 0));
    release(true);
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(h.asked.length, 1, 'one prompt');
    assert.deepEqual([ra.status, rb.status], [200, 200], 'both presses land');
    assert.deepEqual(h.joined, [['notes', true]], 'one join');
  } finally { h.restore(); }
});

test('installed once, before hydration, and shared with the WebSocket chat path', () => {
  const h = harness({ answers: [] });
  try {
    const first = h.win.fetch;
    h.mod.installJoinRequired(h.win);
    assert.equal(h.win.fetch, first, 'a second install does not wrap the wrapper');
    assert.equal(typeof h.win.UsernodeReact.offerJoin, 'function', 'group-chat.js asks through this');
  } finally { h.restore(); }
  const main = read('frontend/src/main.tsx');
  assert.ok(main.indexOf("bootStep('installJoinRequired'") < main.indexOf("bootStep('hydrate'"),
    'installed before hydration, so no island\'s first write slips past it');
  const chat = read('public/js/group-chat.js');
  assert.match(chat, /case 'join_required':/);
  assert.match(chat, /window\.UsernodeReact\?\.offerJoin/);
  assert.match(chat, /msg\.retry/, 'the refused message is sent again, not retyped');
});

test('with an anchor on screen the question is asked there, not in a dialog', async () => {
  const h = harness({ answers: [response(403, REFUSED), response(200, { ok: true })] });
  try {
    const asked = [];
    const off = h.mod.registerJoinAnchor('notes', {
      visible: () => true,
      ask: async (body) => { asked.push(body.app.slug); return true; },
    });
    const res = await h.win.fetch('/api/apps/notes/issues', { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(asked, ['notes'], 'the community card asked, under its Join button');
    assert.equal(h.asked.length, 0, 'and the dialog did not');
    assert.deepEqual(h.joined, [['notes', true]], 'the join itself is still offerJoin\'s');
    off();
  } finally { h.restore(); }
});

test('a hidden or removed anchor falls back to the dialog', async () => {
  const h = harness({ answers: [response(403, REFUSED), response(200, { ok: true }), response(403, REFUSED), response(200, { ok: true })] });
  try {
    const off = h.mod.registerJoinAnchor('notes', { visible: () => false, ask: async () => { throw new Error('asked'); } });
    await h.win.fetch('/api/apps/notes/messages', { method: 'POST' });
    assert.equal(h.asked.length, 1, 'a card on a hidden screen does not swallow the question');
    off();
    await h.win.fetch('/api/apps/notes/messages', { method: 'POST' });
    assert.equal(h.asked.length, 2, 'nor does one that has gone');
  } finally { h.restore(); }
});
