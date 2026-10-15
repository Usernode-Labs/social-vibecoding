// capture/capture.js: the pod-wide store of build-static files the checks'
// browser contexts share (createSharedAssetStore), its switch, and the
// checks-timing line each run writes at its end.
//
// The store is driven here through a fake CDP session that records what the
// store sends and answers Fetch.getResponseBody, so what is and is not served
// from the store is exercised as behaviour, not read off the source. That the
// same holds in real Chromium (a second context sees none of the first one's
// cookies, storage or service-worker registration, and its document comes
// from the preview) was checked by hand in the capture image; see the
// proposal's spec.
//
// Run with: node --test tests/capture-shared-assets.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  sharedAssetsEnabled, checkOrigins, sharedAssetPatterns, sharedAssetUrlOk, sharedAssetLifetimeMs,
  createSharedAssetStore, installSharedAssetStore, timingSummary, runTests, setFrameSink,
} = require('../capture/capture');
const { parseDiagnostics } = require('../src/services/visuals');

const ORIGIN = 'https://usernode-2d5619--s9001.onhomeroom.com';
const SHELL = `${ORIGIN}/b/fee179cea19f030be0eab47c8a6078152f972a8b/shell/assets/shell.js`;
const IMMUTABLE = [
  { name: 'Content-Type', value: 'application/javascript; charset=UTF-8' },
  { name: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
  { name: 'Content-Encoding', value: 'br' },
  { name: 'Content-Length', value: '12' },
  { name: 'X-Platform-Build', value: 'fee179cea19f030be0eab47c8a6078152f972a8b' },
  { name: 'Vary', value: 'Accept-Encoding' },
];

// A CDP session that records every command and answers getResponseBody with
// whatever `bodies` holds for the paused request.
function fakeSession({ bodies = {}, failOn = new Set() } = {}) {
  const s = new EventEmitter();
  s.sent = [];
  s.send = async (method, params) => {
    s.sent.push({ method, params });
    if (failOn.has(method)) throw new Error(`${method} failed`);
    if (method === 'Fetch.getResponseBody') return bodies[params.requestId] || { body: '', base64Encoded: false };
    return {};
  };
  s.last = () => s.sent[s.sent.length - 1];
  return s;
}

let seq = 0;
const reqEvent = (url, extra = {}) => ({
  requestId: `r${(seq += 1)}`,
  resourceType: 'Script',
  request: { url, method: 'GET', headers: {} },
  ...extra,
});
const respEvent = (req, { status = 200, headers = IMMUTABLE, error } = {}) => ({
  ...req,
  ...(error ? { responseErrorReason: error } : { responseStatusCode: status, responseHeaders: headers }),
});

// Drives one request through the store the way Chromium would: request
// stage, then (when the store asked for it) the response stage.
async function load(store, session, url, { status, headers, reqExtra } = {}) {
  const req = reqEvent(url, reqExtra);
  await store.onPaused(req);
  const first = session.last();
  if (first.method === 'Fetch.continueRequest' && first.params.interceptResponse) {
    await store.onPaused(respEvent(req, { status, headers }));
  }
  return { req, first };
}

function storeWith(opts = {}) {
  const session = fakeSession(opts.session);
  // Answer every getResponseBody with this body.
  const realSend = session.send;
  session.send = async (method, params) => {
    if (method === 'Fetch.getResponseBody') {
      session.sent.push({ method, params });
      return { body: opts.body == null ? 'console.log("shell")' : opts.body, base64Encoded: false };
    }
    return realSend(method, params);
  };
  const store = createSharedAssetStore({ session, origins: [ORIGIN], ...opts.store });
  return { store, session };
}

// ── The switch ───────────────────────────────────────────────────────────

test('the store is off unless CAPTURE_SHARED_ASSETS turns it on', () => {
  assert.equal(sharedAssetsEnabled({}), false, 'off by default: measured slower on a CPU-bound pod');
  assert.equal(sharedAssetsEnabled({ CAPTURE_SHARED_ASSETS: '0' }), false);
  assert.equal(sharedAssetsEnabled({ CAPTURE_SHARED_ASSETS: '' }), false);
  assert.equal(sharedAssetsEnabled({ CAPTURE_SHARED_ASSETS: 'nope' }), false);
  assert.equal(sharedAssetsEnabled({ CAPTURE_SHARED_ASSETS: '1' }), true);
  assert.equal(sharedAssetsEnabled({ CAPTURE_SHARED_ASSETS: 'true' }), true);
});

test('installing: nothing when off, when there is nothing to share, or when the browser cannot give a session', async () => {
  const tests = [{ url: `${ORIGIN}/?token=t#apps` }];
  let attached = 0;
  const session = fakeSession();
  const browser = { target: () => ({ createCDPSession: async () => { attached += 1; return session; } }) };
  assert.equal(await installSharedAssetStore(browser, tests, {}), null);
  assert.equal(await installSharedAssetStore(browser, tests, { CAPTURE_SHARED_ASSETS: '0' }), null);
  assert.equal(attached, 0, 'off means no Fetch session at all');
  assert.equal(await installSharedAssetStore(browser, [{ url: 'about:blank' }], { CAPTURE_SHARED_ASSETS: '1' }), null);
  assert.equal(await installSharedAssetStore({ newPage() {} }, tests, { CAPTURE_SHARED_ASSETS: '1' }), null,
    'a browser without a browser target (the unit fakes)');
  const broken = { target: () => ({ createCDPSession: async () => { throw new Error('no'); } }) };
  const origWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.equal(await installSharedAssetStore(broken, tests, { CAPTURE_SHARED_ASSETS: '1' }), null,
      'failing to install never fails a run');
  } finally { process.stderr.write = origWrite; }

  const store = await installSharedAssetStore(browser, tests, { CAPTURE_SHARED_ASSETS: '1' });
  assert.ok(store);
  const enable = session.sent.find((m) => m.method === 'Fetch.enable');
  assert.ok(enable, 'Fetch is enabled on the browser-level session');
  for (const p of enable.params.patterns) {
    assert.ok(p.urlPattern.startsWith(`${ORIGIN}/*.`), `only the checks' origin: ${p.urlPattern}`);
    assert.equal(p.requestStage, 'Request');
  }
  assert.ok(!enable.params.patterns.some((p) => p.urlPattern === '*' || /\/api\//.test(p.urlPattern)),
    'never a pattern that pauses every request or the API');
});

test('origins and patterns come from the checks\' own URLs', () => {
  assert.deepEqual(checkOrigins([
    { url: `${ORIGIN}/?token=a#x` }, { url: `${ORIGIN}/debug` }, { url: 'https://other.example/' },
    { url: 'about:blank' }, { url: 'nonsense' }, null,
  ]), [ORIGIN, 'https://other.example']);
  const patterns = sharedAssetPatterns([ORIGIN]).map((p) => p.urlPattern);
  assert.ok(patterns.includes(`${ORIGIN}/*.js`) && patterns.includes(`${ORIGIN}/*.js?*`));
  assert.ok(patterns.includes(`${ORIGIN}/*.woff2`) && patterns.includes(`${ORIGIN}/*.css`));
  assert.ok(!patterns.some((p) => /\.(html|json)\b/.test(p)), 'no documents, no data');
});

// ── What may be stored ───────────────────────────────────────────────────

test('only static files on the checks\' origin, never the API or a token', () => {
  const ok = (u) => sharedAssetUrlOk(u, [ORIGIN]);
  assert.equal(ok(SHELL), true);
  assert.equal(ok(`${ORIGIN}/fonts/inter.woff2?v=3`), true);
  assert.equal(ok(`${ORIGIN}/`), false, 'the document');
  assert.equal(ok(`${ORIGIN}/index.html`), false);
  assert.equal(ok(`${ORIGIN}/api/apps.js`), false, 'anything under /api/');
  assert.equal(ok(`${ORIGIN}/app.js?token=secret`), false, 'a token in the query');
  assert.equal(ok(`${ORIGIN}/app.js?access_token=secret`), false);
  assert.equal(ok('https://cdn.example/app.js'), false, 'another origin');
  assert.equal(ok('not a url'), false);
});

test('what HTTP lets a shared cache keep, and narrower', () => {
  const h = (cc, more = {}) => ({ 'cache-control': cc, ...more });
  const life = (headers, extra = {}) => sharedAssetLifetimeMs({ method: 'GET', status: 200, headers, ...extra });
  assert.equal(life(h('public, max-age=31536000, immutable')), 31536000 * 1000);
  assert.equal(life(h('immutable')), Infinity, 'immutable alone: the run');
  assert.equal(life(h('public, max-age=86400')), 86400 * 1000);
  assert.equal(life(h('public, max-age=3600')), 0, 'fresh for less than a day: asked again');
  assert.equal(life(h('public, max-age=0')), 0, 'the brand icons');
  assert.equal(life(h('max-age=0, s-maxage=604800')), 604800 * 1000, 'a shared cache reads s-maxage');
  assert.equal(life(h('no-cache, must-revalidate')), 0, 'the document and sw.js');
  assert.equal(life(h('public, max-age=31536000, no-store')), 0);
  assert.equal(life(h('private, max-age=31536000, immutable')), 0, 'private to the viewer');
  assert.equal(life({}), 0, 'no freshness at all');
  assert.equal(life(h('max-age=31536000', { 'set-cookie': 'sid=1' })), 0, 'anything that sets a cookie');
  assert.equal(life(h('max-age=31536000', { vary: 'Accept-Encoding' })), 31536000 * 1000);
  assert.equal(life(h('max-age=31536000', { vary: 'Accept-Encoding, Cookie' })), 0, 'depends on who asks');
  assert.equal(life(h('max-age=31536000', { vary: '*' })), 0);
  assert.equal(life(h('immutable'), { status: 206 }), 0);
  assert.equal(life(h('immutable'), { status: 304 }), 0);
  assert.equal(life(h('immutable'), { method: 'POST' }), 0);
  assert.equal(life(h('immutable'), { requestHeaders: { range: 'bytes=0-9' } }), 0);
});

// ── The store, driven like Chromium drives it ────────────────────────────

test('the first request fills the store and goes on untouched; the next is served from it', async () => {
  const { store, session } = storeWith({ body: 'console.log("shell")' });
  const { req, first } = await load(store, session, SHELL);
  assert.deepEqual(first, { method: 'Fetch.continueRequest', params: { requestId: req.requestId, interceptResponse: true } });
  const [read, onward] = session.sent.slice(-2);
  assert.equal(read.method, 'Fetch.getResponseBody');
  assert.deepEqual(onward, { method: 'Fetch.continueRequest', params: { requestId: req.requestId } },
    'the response that was read reaches its page as the preview sent it');

  const again = reqEvent(SHELL);
  await store.onPaused(again);
  const served = session.last();
  assert.equal(served.method, 'Fetch.fulfillRequest');
  assert.equal(served.params.requestId, again.requestId);
  assert.equal(served.params.responseCode, 200);
  assert.equal(Buffer.from(served.params.body, 'base64').toString('utf8'), 'console.log("shell")');
  const names = served.params.responseHeaders.map((x) => x.name.toLowerCase());
  assert.ok(!names.includes('content-encoding'), 'the body is stored decoded, so its encoding is not claimed');
  assert.equal(served.params.responseHeaders.find((x) => x.name === 'Content-Length').value,
    String(Buffer.byteLength('console.log("shell")')));
  assert.equal(names.filter((n) => n === 'content-length').length, 1);
  assert.equal(served.params.responseHeaders.find((x) => x.name === 'X-Platform-Build').value,
    'fee179cea19f030be0eab47c8a6078152f972a8b', 'the build header the service worker reads is kept');
  assert.deepEqual(store.stats().served, 1);
  assert.deepEqual(store.stats().stored, 1);
});

test('base64 bodies (fonts, images) are kept as bytes', async () => {
  const bytes = Buffer.from([0, 1, 2, 250, 251, 252]);
  const session = fakeSession();
  session.send = async (method, params) => {
    session.sent.push({ method, params });
    return method === 'Fetch.getResponseBody' ? { body: bytes.toString('base64'), base64Encoded: true } : {};
  };
  const store = createSharedAssetStore({ session, origins: [ORIGIN] });
  const font = `${ORIGIN}/b/abc/fonts/inter.woff2`;
  await load(store, session, font, { headers: [{ name: 'Cache-Control', value: 'max-age=31536000, immutable' }] });
  await store.onPaused(reqEvent(font, { resourceType: 'Font' }));
  assert.deepEqual(Buffer.from(session.last().params.body, 'base64'), bytes);
});

test('the document, the API, other origins and other methods always go to the network', async () => {
  const { store, session } = storeWith();
  const cases = [
    reqEvent(`${ORIGIN}/?token=t`, { resourceType: 'Document' }),
    reqEvent(`${ORIGIN}/main.js`, { resourceType: 'Document' }),
    reqEvent(`${ORIGIN}/api/version.js`),
    reqEvent('https://elsewhere.example/app.js'),
    reqEvent(SHELL, { request: { url: SHELL, method: 'POST', headers: {} } }),
    reqEvent(SHELL, { request: { url: SHELL, method: 'GET', headers: { Range: 'bytes=0-10' } } }),
  ];
  for (const ev of cases) {
    await store.onPaused(ev);
    assert.deepEqual(session.last(), { method: 'Fetch.continueRequest', params: { requestId: ev.requestId } },
      `${ev.request.method} ${ev.request.url} (${ev.resourceType})`);
  }
  assert.equal(store.stats().entries, 0);
});

test('a request that asks to bypass caches is not served from the store', async () => {
  const { store, session } = storeWith();
  await load(store, session, SHELL);
  const ev = reqEvent(SHELL, { request: { url: SHELL, method: 'GET', headers: { 'Cache-Control': 'no-cache' } } });
  await store.onPaused(ev);
  assert.deepEqual(session.last(), { method: 'Fetch.continueRequest', params: { requestId: ev.requestId } });
  const pragma = reqEvent(SHELL, { request: { url: SHELL, method: 'GET', headers: { Pragma: 'no-cache' } } });
  await store.onPaused(pragma);
  assert.equal(session.last().method, 'Fetch.continueRequest');
  assert.equal(store.stats().bypassed, 2);
});

test('a response that may not be shared is never served, and is not read again', async () => {
  const { store, session } = storeWith();
  const icon = `${ORIGIN}/brand/homeroom-mark.png`;
  const zero = [{ name: 'Cache-Control', value: 'public, max-age=0' }];
  await load(store, session, icon, { headers: zero });
  assert.ok(!session.sent.some((m) => m.method === 'Fetch.getResponseBody'), 'its body is not even read');
  const again = reqEvent(icon, { resourceType: 'Image' });
  await store.onPaused(again);
  assert.deepEqual(session.last(), { method: 'Fetch.continueRequest', params: { requestId: again.requestId } },
    'straight to the network, without asking for the response again');

  for (const headers of [
    [...IMMUTABLE, { name: 'Set-Cookie', value: 'sid=abc' }],
    [{ name: 'Cache-Control', value: 'private, max-age=31536000' }],
  ]) {
    const url = `${ORIGIN}/b/x/${Math.random().toString(36).slice(2)}.js`;
    await load(store, session, url, { headers });
    const next = reqEvent(url);
    await store.onPaused(next);
    assert.equal(session.last().method, 'Fetch.continueRequest');
  }
  const failed = reqEvent(`${ORIGIN}/b/x/gone.js`);
  await store.onPaused(failed);
  await store.onPaused(respEvent(failed, { error: 'ConnectionReset' }));
  assert.deepEqual(session.last(), { method: 'Fetch.continueRequest', params: { requestId: failed.requestId } });
  assert.equal(store.stats().entries, 0);
});

test('a 404 or a redirect is not stored', async () => {
  const { store, session } = storeWith();
  for (const status of [404, 302, 500]) {
    const url = `${ORIGIN}/b/x/s${status}.js`;
    await load(store, session, url, { status });
    await store.onPaused(reqEvent(url));
    assert.equal(session.last().method, 'Fetch.continueRequest', `HTTP ${status}`);
  }
  assert.equal(store.stats().entries, 0);
});

test('while one request fills a URL, the others go to the network as they always did', async () => {
  const { store, session } = storeWith();
  const a = reqEvent(SHELL);
  const b = reqEvent(SHELL);
  await store.onPaused(a);
  await store.onPaused(b);
  assert.deepEqual(session.last(), { method: 'Fetch.continueRequest', params: { requestId: b.requestId } },
    'not held waiting on a fetch whose page may be about to close');
  await store.onPaused(respEvent(a));
  await store.onPaused(reqEvent(SHELL));
  assert.equal(session.last().method, 'Fetch.fulfillRequest');
});

test('a fill whose page closed mid-load does not block the URL for the rest of the run', async () => {
  let t = 1000;
  const { store, session } = storeWith({ store: { now: () => t } });
  await store.onPaused(reqEvent(SHELL)); // never answered: its context closed
  const blocked = reqEvent(SHELL);
  await store.onPaused(blocked);
  assert.equal(session.last().params.interceptResponse, undefined, 'claimed by the first');
  t += 31000;
  const later = reqEvent(SHELL);
  await store.onPaused(later);
  assert.deepEqual(session.last().params, { requestId: later.requestId, interceptResponse: true },
    'the claim expired, so this one fills it');
});

test('a copy is served only while its own freshness lasts', async () => {
  let t = 0;
  const { store, session } = storeWith({ store: { now: () => t } });
  const url = `${ORIGIN}/b/x/day.js`;
  await load(store, session, url, { headers: [{ name: 'Cache-Control', value: 'public, max-age=86400' }] });
  t = 86400 * 1000 - 1;
  await store.onPaused(reqEvent(url));
  assert.equal(session.last().method, 'Fetch.fulfillRequest');
  t = 86400 * 1000;
  const stale = reqEvent(url);
  await store.onPaused(stale);
  assert.deepEqual(session.last().params, { requestId: stale.requestId, interceptResponse: true },
    'expired: fetched again, and the new answer replaces it');
  await store.onPaused(respEvent(stale, { headers: [{ name: 'Cache-Control', value: 'public, max-age=86400' }] }));
  assert.equal(store.stats().entries, 1);
});

test('bounds: an entry too big, or a store that is full, is passed through', async () => {
  const { store, session } = storeWith({ body: 'x'.repeat(100), store: { maxEntryBytes: 50 } });
  await load(store, session, SHELL);
  await store.onPaused(reqEvent(SHELL));
  assert.deepEqual(session.last().params.interceptResponse, undefined);
  assert.equal(session.last().method, 'Fetch.continueRequest');
  assert.equal(session.sent.filter((m) => m.method === 'Fetch.getResponseBody').length, 1,
    'read once, then left to the network');

  const full = storeWith({ body: 'y'.repeat(40), store: { maxTotalBytes: 60 } });
  await load(full.store, full.session, `${ORIGIN}/b/x/one.js`);
  await load(full.store, full.session, `${ORIGIN}/b/x/two.js`);
  assert.equal(full.store.stats().entries, 1);
});

test('a failed fulfil falls back to the network; a failed body read still lets the response through', async () => {
  const { store, session } = storeWith();
  await load(store, session, SHELL);
  const realSend = session.send;
  session.send = async (method, params) => {
    if (method === 'Fetch.fulfillRequest') { session.sent.push({ method, params }); throw new Error('Invalid InterceptionId'); }
    return realSend(method, params);
  };
  const ev = reqEvent(SHELL);
  await store.onPaused(ev);
  assert.deepEqual(session.last(), { method: 'Fetch.continueRequest', params: { requestId: ev.requestId } });

  const s2 = fakeSession({ failOn: new Set(['Fetch.getResponseBody']) });
  const store2 = createSharedAssetStore({ session: s2, origins: [ORIGIN] });
  const req = reqEvent(SHELL);
  await store2.onPaused(req);
  await store2.onPaused(respEvent(req));
  assert.deepEqual(s2.last(), { method: 'Fetch.continueRequest', params: { requestId: req.requestId } });
  assert.equal(store2.stats().entries, 0);
});

test('every group is served the same bytes, each through its own paused request', async () => {
  // Isolation lives in the contexts (one per group, see runTestGroup); the
  // store only ever answers a paused request with a stored body and headers.
  // It never sets a cookie, and nothing it stores came with one.
  const { store, session } = storeWith({ body: 'shared' });
  await load(store, session, SHELL);
  const served = [];
  for (let g = 0; g < 5; g += 1) {
    const ev = reqEvent(SHELL);
    await store.onPaused(ev);
    served.push(session.last());
  }
  assert.ok(served.every((m) => m.method === 'Fetch.fulfillRequest'));
  assert.equal(new Set(served.map((m) => m.params.requestId)).size, 5);
  assert.ok(served.every((m) => !m.params.responseHeaders.some((h) => /^set-cookie$/i.test(h.name))));
});

// ── The run's timing line ────────────────────────────────────────────────

function collect() {
  const chunks = [];
  setFrameSink((s) => chunks.push(s));
  return () => chunks.join('');
}

function fakeBrowser() {
  let contexts = 0;
  const newPage = async () => ({
    on() {}, async setViewport() {}, async goto() { return { status: () => 200 }; },
    async waitForNetworkIdle() {}, async $() { return {}; }, async evaluate() { return true; }, async close() {},
  });
  return {
    contexts: () => contexts,
    async createBrowserContext() { contexts += 1; return { newPage, async close() {} }; },
    newPage,
  };
}

const FAST = { settleQuietMs: 5, settleMaxMs: 50, assertMaxMs: 20, assertPollMs: 5 };

test('a run ends with one checks-timing line: groups, cold loads and the store', async () => {
  const tests = Array.from({ length: 7 }, (_, i) => ({
    index: i, name: `c${i}`, path: `/p${i}`, url: `${ORIGIN}/p${i}?token=t`,
  }));
  const stats = { entries: 3, served: 9, servedBytes: 900, fetched: 3, stored: 3, storedBytes: 300,
    notShareable: 0, bypassed: 0, errors: 0 };
  const read = collect();
  const browser = fakeBrowser();
  await runTests(browser, tests, { concurrency: 3, testTimeoutMs: 5000, ...FAST, assetStore: { stats: () => stats } });
  const text = read();
  const timing = parseDiagnostics(text).filter((d) => d.kind === 'checks-timing');
  assert.equal(timing.length, 1);
  const d = timing[0].data;
  assert.equal(d.groups.n, 7);
  assert.equal(d.loads.n, 7, 'every cold load timed');
  assert.equal(d.lanes, 3);
  assert.ok(Number.isFinite(d.wallMs));
  assert.deepEqual(d.sharedAssets, stats);
  assert.equal(browser.contexts(), 7, 'still one fresh context per group');
  assert.ok(text.indexOf('__USERNODE_DIAG__ kind=checks-timing') < text.indexOf('__USERNODE_TESTS_DONE__'));
  assert.ok(!/token=t/.test(Buffer.from(text.match(/kind=checks-timing (\S+)/)[1], 'base64').toString()),
    'no URL, so no token, in the line');
});

test('the same suite gives the same verdicts with and without a store handed in', async () => {
  const tests = Array.from({ length: 4 }, (_, i) => ({
    index: i, name: `c${i}`, path: `/p${i}`, url: `${ORIGIN}/p${i}`, expectSelector: '#x',
  }));
  const verdicts = async (opts) => {
    const read = collect();
    await runTests(fakeBrowser(), tests, { concurrency: 2, testTimeoutMs: 5000, ...FAST, ...opts });
    return [...read().matchAll(/__USERNODE_TEST__ index=(\d+) status=(\w+)/g)].map((m) => `${m[1]}:${m[2]}`).sort();
  };
  assert.deepEqual(await verdicts({}), await verdicts({ assetStore: { stats: () => ({}) } }));
});

test('timing summaries', () => {
  assert.deepEqual(timingSummary([]), { n: 0, p50: 0, p90: 0, max: 0, mean: 0 });
  assert.deepEqual(timingSummary([100, 200, 300, 400, 1000]), { n: 5, p50: 300, p90: 1000, max: 1000, mean: 400 });
  assert.equal(timingSummary([1, NaN, 3]).n, 2);
});

test('the platform reads every shard\'s timing line without crowding out the other diagnostics', () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
  const lines = [
    ...Array.from({ length: 9 }, (_, i) => `__USERNODE_DIAG__ kind=network-changed ${b64({ n: i })}`),
    ...Array.from({ length: 12 }, (_, i) => `__USERNODE_DIAG__ kind=checks-timing ${b64({ shard: `${i}/9` })}`),
  ];
  const out = parseDiagnostics(lines.join('\n'));
  assert.equal(out.filter((d) => d.kind === 'network-changed').length, 5, 'their cap is unchanged');
  assert.equal(out.filter((d) => d.kind === 'checks-timing').length, 9, 'eight shards and a sweep');
});
