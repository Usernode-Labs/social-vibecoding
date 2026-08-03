// #439 front-end: AppView.ensureStaging opens the "spinning back up" loader
// and, when the server says `rebuilding`, parks a pending marker that the
// staging_ready / staging_failed WS path (onStagingRebuildResult) resolves —
// opening the NEW url on success or showing the failure in the loader. Also
// guards that a `ready` response opens immediately and a `demo` response
// shows the unavailable copy.
//
// #816 extends this to the thing the user actually complained about: a
// preview that is already live must not be fronted by a screen promising a
// 20–60 second rebuild. The added cases pin that the rebuild copy appears
// ONLY on the `rebuilding` branch, that a server-verified `ready` response
// skips the readiness poll entirely (zero probe fetches) and drives the
// iframe off its own load event, and that the fallback poll keeps its
// tightened schedule and makes no claims about TLS.
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

// `stubSwap: false` keeps the REAL swapToStaging so the verified fast path /
// fallback poll can be exercised end to end (#816).
function makeAppView(fetchImpl, { stubSwap = true } = {}) {
  const dom = makeDom();
  const sandbox = {
    console,
    relTime: () => 'now',
    App: { user: { id: 1 }, currentTab: 'dev' },
    Kudos: { renderButton: () => '' },
    document: dom.document,
    fetch: fetchImpl,
    alert: () => {},
    // unref'd so a still-pending safety timeout (the iframe load watchdog)
    // can't hold the test process open after its case has passed.
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
    clearTimeout, setInterval, clearInterval,
    AbortController, URL,
    // The real swapToStaging normalises the url through dev-host.js and
    // composes the iframe src with the URL API.
    resolveDevHost: (u) => u,
    location: { origin: 'https://platform.example', hostname: 'platform.example' },
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  // Spy on swapToStaging — the terminal "open the iframe" step. We don't want
  // its real readiness machinery, just to know it was called and with what.
  const swaps = [];
  if (stubSwap) {
    AppView.swapToStaging = (url, testing, opts) => { swaps.push({ url, testing, opts }); };
  }
  return { AppView, dom, swaps, sandbox };
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

// ── #816: the rebuild estimate is reserved for actual rebuilds ───────────
//
// The reported bug in one assertion: clicking Preview on a live preview
// used to paint "this usually takes 20–60 seconds" BEFORE the server had
// been asked anything, so a sub-second open read as a minute-long wait.

const REBUILD_COPY = /20[–-]60 seconds/;

function loaderText(dom) {
  return `${dom.els['staging-loader-title'].textContent} ${dom.els['staging-loader-sub'].textContent}`;
}

test('#816 the opening state is neutral — no rebuild estimate before the server answers', async () => {
  let loaderWhileInFlight = null;
  const { AppView, dom } = makeAppView(async () => {
    // Sampled at the moment the POST is in flight: this is exactly the
    // screen the user stares at on every single Preview click.
    loaderWhileInFlight = loaderText(dom);
    return { ok: true, json: async () => ({ status: 'ready', url: 'https://live.example', verified: true }) };
  });
  await AppView.ensureStaging(7, null, null, {});
  assert.doesNotMatch(loaderWhileInFlight, REBUILD_COPY, 'no 20–60s promise before we know a rebuild is needed');
  assert.doesNotMatch(loaderWhileInFlight, /paused/i, 'does not claim the preview was paused');
  assert.match(loaderWhileInFlight, /opening preview/i, 'neutral opening copy');
});

test('#816 a verified {ready} opens the iframe with ZERO readiness probes', async () => {
  const calls = [];
  const { AppView, dom } = makeAppView(async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ status: 'ready', url: 'https://live.example', verified: true }) };
  }, { stubSwap: false });

  await AppView.ensureStaging(7, null, null, {});

  assert.deepEqual(calls, ['/api/sessions/7/ensure-staging'],
    'the ensure POST is the only request — the host is never probed');
  assert.equal(dom.els['staging-iframe'].src, 'https://live.example/',
    'iframe pointed at the preview immediately');
  assert.doesNotMatch(loaderText(dom), REBUILD_COPY, 'never shows the rebuild estimate');
  assert.equal(dom.els['staging-loader'].classList._hidden, false,
    'spinner stays up across the render instead of leaving a black rectangle');
});

test('#816 a verified {ready,checksRunning} explains the slower first load', async () => {
  const { AppView, dom } = makeAppView(
    okJson({ status: 'ready', url: 'https://live.example', verified: true, checksRunning: true }),
    { stubSwap: false }
  );
  await AppView.ensureStaging(7, null, null, {});
  assert.match(dom.els['staging-loader-sub'].textContent, /automated checks are running/i);
  assert.doesNotMatch(loaderText(dom), /\d+[–-]\d+ seconds/, 'no invented duration');
});

test('#816 the loader clears on the iframe load event, and a stale load id is ignored', async () => {
  const { AppView, dom } = makeAppView(
    okJson({ status: 'ready', url: 'https://live.example', verified: true }),
    { stubSwap: false }
  );
  await AppView.ensureStaging(7, null, null, {});
  const iframe = dom.els['staging-iframe'];
  assert.equal(typeof iframe.onload, 'function', 'the render is actually observed');

  iframe.onload();
  assert.equal(dom.els['staging-loader'].classList._hidden, true, 'spinner cleared once the page painted');

  // A late event from a superseded open must not resurrect the loader.
  await AppView.ensureStaging(7, null, null, {});
  const staleHandler = iframe.onload;
  AppView._stagingLoadId += 1;             // simulate a newer open / a close
  AppView._setStagingLoader(false);
  staleHandler();
  assert.equal(dom.els['staging-loader'].classList._hidden, true, 'stale load event is a no-op');
});

test('#816 an UNVERIFIED {ready} falls back to the readiness poll', async () => {
  const calls = [];
  const { AppView, dom } = makeAppView(async (url) => {
    calls.push(url);
    if (url === '/api/sessions/7/ensure-staging') {
      return { ok: true, json: async () => ({ status: 'ready', url: 'https://live.example', verified: false }) };
    }
    return {}; // the host answers the probe
  }, { stubSwap: false });

  await AppView.ensureStaging(7, null, null, {});
  await new Promise((r) => setTimeout(r, 10)); // let the poll's promise settle

  assert.equal(calls.length, 2, 'the host IS probed when the server could not verify it');
  assert.equal(calls[1], 'https://live.example', 'probes the origin root, not a deep link');
  assert.equal(dom.els['staging-iframe'].src, 'https://live.example/', 'opens once the host answers');
});

test('#816 only the {rebuilding} branch shows the 20–60 second estimate', async () => {
  const ready = makeAppView(okJson({ status: 'ready', url: 'https://live.example', verified: true }), { stubSwap: false });
  await ready.AppView.ensureStaging(7, null, null, {});
  assert.doesNotMatch(loaderText(ready.dom), REBUILD_COPY);

  const rebuilding = makeAppView(okJson({ status: 'rebuilding' }));
  await rebuilding.AppView.ensureStaging(7, null, null, {});
  assert.match(loaderText(rebuilding.dom), REBUILD_COPY,
    'a real rebuild still tells the user how long it takes');
});

// ── #816: the fallback poll's schedule + copy ────────────────────────────

test('#816 the readiness poll starts immediately and backs off 300/600/1200/2000', () => {
  const { AppView } = makeAppView(okJson({}));
  // Spread: the array is built inside the vm realm, so its prototype isn't
  // this realm's Array and a strict deep-equal would fail on identical values.
  assert.deepEqual([...AppView.STAGING_POLL_BACKOFF_MS], [300, 600, 1200],
    'tight early retries — a live preview answers in tens of ms');
  assert.equal(AppView.STAGING_POLL_BACKOFF_MAX_MS, 2000, 'ceiling');
  assert.equal(AppView.STAGING_POLL_ATTEMPT_TIMEOUT_MS, 5000, 'per-attempt cut-off');
  assert.equal(AppView.STAGING_IFRAME_LOAD_TIMEOUT_MS, 20000, 'iframe safety net');

  const schedule = [0, 1, 2, 3, 4, 9].map((i) => AppView._stagingPollBackoffMs(i));
  assert.deepEqual(schedule, [300, 600, 1200, 2000, 2000, 2000], 'escalates then holds at the ceiling');
});

test('#816 the readiness poll retries on the tightened schedule', async () => {
  const sleeps = [];
  let attempts = 0;
  const { AppView, sandbox } = makeAppView(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error('not answering yet');
    return {};
  }, { stubSwap: false });
  // Record the waits without actually sleeping through them.
  sandbox.setTimeout = (fn, ms) => { sleeps.push(ms); return setTimeout(fn, 0); };

  const started = Date.now();
  const ready = await AppView._waitForStagingReady('https://live.example', AppView._stagingLoadId);
  assert.equal(ready, true, 'resolves once the host answers');
  assert.equal(attempts, 3, 'first attempt fires immediately, then retries');
  // The abort timers are registered alongside the sleeps; keep only the waits.
  const waits = sleeps.filter((ms) => ms !== AppView.STAGING_POLL_ATTEMPT_TIMEOUT_MS);
  assert.deepEqual(waits, [300, 600], 'two failures cost 0.9s, not the old 5s');
  assert.ok(Date.now() - started < 1000, 'no fixed multi-second floor on the fast path');
});

test('#816 no loader copy anywhere claims a TLS certificate is being issued', async () => {
  const { AppView, dom } = makeAppView(async () => { throw new Error('down'); }, { stubSwap: false });
  // Kick the poll once so it paints its initial state, then abandon it.
  AppView._waitForStagingReady('https://dead.example', AppView._stagingLoadId);
  await new Promise((r) => setTimeout(r, 5));
  AppView._stagingLoadId += 1;

  const text = loaderText(dom);
  assert.match(text, /waiting for the preview/i, 'says what is actually happening');
  for (const dead of [/TLS/i, /certificate/i, /provisioning/i, /certificate authority/i]) {
    assert.doesNotMatch(text, dead, `stale premise removed: ${dead}`);
  }
  // And the markup default must not reintroduce it before JS runs.
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const loaderBlock = html.slice(html.indexOf('id="staging-loader"'), html.indexOf('id="staging-loader"') + 700);
  assert.doesNotMatch(loaderBlock, /TLS certificate/i, 'index.html default copy is neutral too');
});
