// #439 front-end: AppView.ensureStaging opens the "spinning back up" loader
// and, when the server says `rebuilding`, parks a pending marker that the
// staging_ready / staging_failed WS path (onStagingRebuildResult) resolves —
// opening the NEW url on success or showing the failure in the loader. Also
// guards that a `ready` response opens immediately and a `demo` response
// shows the unavailable copy.
//
// app-view.js is a plain browser script (`const AppView = {…}`). We load it
// into a vm context with a DOM stub for the staging overlay elements, spy on
// swapToStaging, and assert on the loader text + which url gets opened.
//
// Run with: node --test tests/ensure-staging-preview.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

// Minimal DOM stub: the staging overlay + loader elements ensureStaging
// touches, each recording the bits the assertions read.
function makeDom() {
  const els = {};
  const mk = (id) => {
    const el = {
      id, _text: '', _src: '',
      classList: { _hidden: true, add() { this._hidden = true; }, remove() { this._hidden = false; }, toggle(_c, v) { this._hidden = !!v; } },
      set textContent(v) { this._text = v; }, get textContent() { return this._text; },
      set src(v) { this._src = v; }, get src() { return this._src; },
      set innerHTML(_v) {}, get innerHTML() { return ''; },
      onclick: null, style: {},
      setAttribute() {}, removeAttribute() {},
      querySelector: () => null, querySelectorAll: () => ({ forEach() {} }),
      appendChild() {},
    };
    els[id] = el;
    return el;
  };
  ['staging-overlay', 'staging-iframe', 'staging-back', 'staging-loader',
    'staging-loader-title', 'staging-loader-sub', 'staging-url-label',
    'staging-test-btn', 'staging-testing-panel'].forEach(mk);
  return {
    els,
    document: {
      getElementById: (id) => els[id] || null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach() {} }),
      addEventListener() {},
      createElement: () => mk('tmp-' + Math.random()),
      body: { appendChild() {} },
    },
  };
}

function makeAppView(fetchImpl) {
  const dom = makeDom();
  const sandbox = {
    console,
    relTime: () => 'now',
    App: { user: { id: 1 }, currentTab: 'dev' },
    Kudos: { renderButton: () => '' },
    document: dom.document,
    fetch: fetchImpl,
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  // Spy on swapToStaging — the terminal "open the iframe" step. We don't want
  // its real cert-poll machinery, just to know it was called and with what.
  const swaps = [];
  AppView.swapToStaging = (url, testing, opts) => { swaps.push({ url, testing, opts }); };
  return { AppView, dom, swaps };
}

const okJson = (body) => async () => ({ ok: true, json: async () => body });

test('ensureStaging opens immediately when the server says {ready}', async () => {
  const { AppView, dom, swaps } = makeAppView(okJson({ status: 'ready', url: 'https://live.example' }));
  await AppView.ensureStaging(7, 'https://fallback.example', null, {});
  assert.equal(dom.els['staging-overlay'].classList._hidden, false, 'overlay opened');
  assert.equal(swaps.length, 1, 'swapToStaging called once');
  assert.equal(swaps[0].url, 'https://live.example', 'opens the server-returned live url');
  assert.equal(AppView._pendingStagingPreview, null, 'no pending marker on the ready path');
});

test('ensureStaging shows the "spinning back up" loader and waits on {rebuilding}', async () => {
  const { AppView, dom, swaps } = makeAppView(okJson({ status: 'rebuilding' }));
  await AppView.ensureStaging(7, 'https://stale.example', { md: 'do x', path: '/x' }, { jump: true });
  // Loader is up with the rebuild copy (viewer-neutral since #689 — shared
  // sessions route non-owners through this path too); no swap yet.
  assert.match(dom.els['staging-loader-title'].textContent, /spinning the preview back up/i);
  assert.equal(swaps.length, 0, 'does not open until the rebuild resolves');
  assert.ok(AppView._pendingStagingPreview, 'a pending marker is parked');
  assert.equal(AppView._pendingStagingPreview.sessionId, 7);
  assert.equal(AppView._pendingStagingPreview.jump, true);

  // staging_ready lands → opens the NEW url (not the stale fallback).
  AppView.onStagingRebuildResult(7, { url: 'https://rebuilt-NEW.example' });
  assert.equal(swaps.length, 1, 'opens after the rebuild');
  assert.equal(swaps[0].url, 'https://rebuilt-NEW.example', 'uses the fresh url from staging_ready');
  assert.equal(swaps[0].opts.jump, true, 'carries the original jump intent');
  assert.deepEqual(swaps[0].testing, { md: 'do x', path: '/x' }, 'carries the testing guidance');
  assert.equal(AppView._pendingStagingPreview, null, 'pending marker cleared');
});

test('onStagingRebuildResult surfaces a failed rebuild in the loader (no swap)', async () => {
  const { AppView, dom, swaps } = makeAppView(okJson({ status: 'rebuilding' }));
  await AppView.ensureStaging(7, 'https://stale.example', null, {});
  AppView.onStagingRebuildResult(7, { failed: true, error: 'Missing secret: STRIPE_KEY' });
  assert.equal(swaps.length, 0, 'no preview opened on failure');
  assert.match(dom.els['staging-loader-title'].textContent, /couldn|n.t be rebuilt/i, 'failure title shown');
  assert.match(dom.els['staging-loader-sub'].textContent, /STRIPE_KEY/, 'failure reason surfaced');
  assert.equal(AppView._pendingStagingPreview, null, 'pending marker cleared');
});

test('onStagingRebuildResult ignores a result for a different/stale session', async () => {
  const { AppView, swaps } = makeAppView(okJson({ status: 'rebuilding' }));
  await AppView.ensureStaging(7, 'https://stale.example', null, {});
  AppView.onStagingRebuildResult(999, { url: 'https://other.example' });
  assert.equal(swaps.length, 0, 'unrelated session result is a no-op');
  assert.ok(AppView._pendingStagingPreview, 'our pending marker is untouched');
});

test('ensureStaging shows the demo copy and never opens when {unavailable,demo}', async () => {
  const { AppView, dom, swaps } = makeAppView(okJson({ status: 'unavailable', reason: 'demo' }));
  await AppView.ensureStaging(7, 'https://x.example', null, {});
  assert.equal(swaps.length, 0, 'nothing opened in the demo env');
  assert.match(dom.els['staging-loader-title'].textContent, /unavailable/i);
  assert.match(dom.els['staging-loader-sub'].textContent, /demo/i, 'explains it is the demo env');
});
