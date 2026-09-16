'use strict';

// Asset-route readiness (#2315 / #2344): the preview's OWN public origin
// must serve the platform bridge before and during proposal checks.
//
// The rules pinned here:
//
//   * Only a 200 with a JavaScript content type passes. A 200 text/html is
//     THE failure this row exists for — the prefix was not routed and the
//     app's SPA fallback answered — and its reason must say so by status
//     and type, not leave the author to guess.
//   * The probe is a real, unauthenticated GET, exercised here against a
//     local server in both shapes: routed (bridge served as JS) and
//     unrouted (a catch-all serving the app's page for every path, which is
//     what an Ingress without the asset prefixes produces).
//   * Launch readiness is bounded and requires consecutive fresh-connection
//     successes; a platform preview also has to match its preview bytes.
//   * The final exact-path assertion rides inside the public-browser Job,
//     never through the orchestrator's source-specific hairpin route.
//
// Run with: node --test tests/asset-route-check.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const check = require('../src/services/asset-route-check');
const visuals = require('../src/services/visuals');

// ── classifyAssetResponse ──────────────────────────────────────────────

test('a JavaScript 200 passes, with or without a charset', () => {
  assert.equal(check.classifyAssetResponse({ status: 200, contentType: 'application/javascript; charset=utf-8' }).passed, true);
  assert.equal(check.classifyAssetResponse({ status: 200, contentType: 'text/javascript' }).passed, true);
});

test("a 200 text/html fails and names the unrouted prefix and the app's page", () => {
  const out = check.classifyAssetResponse({
    status: 200, contentType: 'text/html; charset=UTF-8', bodyStart: '<!doctype html>\n<html><head><title>My App</title>',
  });
  assert.equal(out.passed, false);
  assert.match(out.reason, /answered 200 text\/html/);
  assert.match(out.reason, /not routed/);
  assert.match(out.reason, /app's own page/);
  assert.match(out.reason, /<!doctype html> <html>/, 'the start of what answered, whitespace-collapsed');
  assert.match(out.reason, /not something in this proposal/);
});

test('a 401 reads as the sign-in gate answering an unrouted prefix', () => {
  const out = check.classifyAssetResponse({ status: 401, contentType: 'text/html' });
  assert.equal(out.passed, false);
  assert.match(out.reason, /answered 401 text\/html/);
  assert.match(out.reason, /sign-in gate/);
});

test('a 5xx reads as the shared backend not serving', () => {
  const out = check.classifyAssetResponse({ status: 503, contentType: 'text/plain' });
  assert.equal(out.passed, false);
  assert.match(out.reason, /503 text\/plain/);
  assert.match(out.reason, /shared asset backend is not serving/);
});

test('a 404 and a network failure each get their own sentence', () => {
  assert.match(check.classifyAssetResponse({ status: 404, contentType: 'text/html' }).reason, /no such file/);
  const net = check.classifyAssetResponse({ error: 'ECONNREFUSED' });
  assert.equal(net.passed, false);
  assert.match(net.reason, /Could not reach .*ECONNREFUSED/);
});

test('a long body is clipped in the reason', () => {
  const out = check.classifyAssetResponse({ status: 200, contentType: 'text/html', bodyStart: 'x'.repeat(5000) });
  assert.ok(out.reason.length < 800, `reason stays short: ${out.reason.length}`);
});

test('a self-app bridge must match the preview bytes, not the shared production backend', () => {
  const missing = check.classifyAssetResponse({
    status: 200, contentType: 'application/javascript', expectedBodySha256: 'a'.repeat(64),
  });
  assert.equal(missing.passed, false);
  assert.match(missing.reason, /no readable asset digest/);
  assert.match(missing.reason, /shared production asset backend/);

  const wrong = check.classifyAssetResponse({
    status: 200, contentType: 'application/javascript', bodySha256: 'b'.repeat(64),
    expectedBodySha256: 'a'.repeat(64),
  });
  assert.equal(wrong.passed, false);
  assert.match(wrong.reason, /asset digest b+/);

  assert.equal(check.classifyAssetResponse({
    status: 200, contentType: 'application/javascript', bodySha256: 'A'.repeat(64),
    expectedBodySha256: 'a'.repeat(64),
  }).passed, true);
});

// ── probeAssetRoute against a real server ──────────────────────────────

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('routed origin: the probe reads the bridge as JavaScript and passes', async (t) => {
  const origin = await serve(t, (req, res) => {
    if (req.url === check.ASSET_CHECK_PATH) {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      return res.end('window.usernode = {};');
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!doctype html><title>app</title>');
  });
  const response = await check.probeAssetRoute(origin);
  assert.equal(response.status, 200);
  assert.equal(check.classifyAssetResponse(response).passed, true);
});

test('unrouted origin: a catch-all answers HTML for the bridge path and the probe fails', async (t) => {
  // An Ingress deployed with assetBackend: null carries only the catch-all,
  // so every path — the bridge included — reaches the app's SPA fallback.
  const origin = await serve(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=UTF-8' });
    res.end('<!doctype html><html><body>Staging demo app</body></html>');
  });
  const response = await check.probeAssetRoute(origin);
  const out = check.classifyAssetResponse(response);
  assert.equal(out.passed, false);
  assert.match(out.reason, /200 text\/html/);
  assert.match(out.reason, /Staging demo app/);
});

test('the probe sends no credentials and does not follow a redirect to a sign-in page', async (t) => {
  let seen = null;
  const origin = await serve(t, (req, res) => {
    seen = {
      auth: req.headers.authorization,
      cookie: req.headers.cookie,
      connection: req.headers.connection,
    };
    res.writeHead(302, { location: '/login' });
    res.end();
  });
  const response = await check.probeAssetRoute(origin);
  assert.deepEqual(seen, { auth: undefined, cookie: undefined, connection: 'close' });
  assert.equal(response.status, 302);
  assert.equal(check.classifyAssetResponse(response).passed, false);
});

test('a hung origin times out into a failure instead of stalling the run', async (t) => {
  const origin = await serve(t, () => { /* never answers */ });
  const response = await check.probeAssetRoute(origin, { timeoutMs: 150 });
  assert.match(response.error, /no response within/);
});

// ── readiness gate ────────────────────────────────────────────────────

function routeResponse(status, contentType, buildSha = '', body = '') {
  const bytes = Buffer.from(body, 'utf8');
  return {
    status,
    headers: { get: (name) => ({
      'content-type': contentType,
      'x-platform-build': buildSha,
    }[name.toLowerCase()] || null) },
    text: async () => body,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

test('readiness waits for two consecutive fresh-edge successes', async () => {
  const responses = [
    routeResponse(403, 'text/plain', '', 'Access denied'),
    routeResponse(200, 'application/javascript'),
    routeResponse(200, 'application/javascript'),
  ];
  const sleeps = [];
  const out = await check.waitForAssetRouteReady('https://a--s1.example.invalid', {
    fetchImpl: async () => responses.shift(), attempts: 5, maxWaitMs: 10_000,
    retryMs: 7, sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(out.ready, true);
  assert.equal(out.attempts, 3);
  assert.equal(out.consecutivePasses, 2);
  assert.deepEqual(sleeps, [7, 7]);
});

test('a miss between successes resets the readiness streak', async () => {
  const responses = [
    routeResponse(200, 'application/javascript'),
    routeResponse(403, 'text/plain', '', 'Access denied'),
    routeResponse(200, 'application/javascript'),
    routeResponse(200, 'application/javascript'),
  ];
  const out = await check.waitForAssetRouteReady('https://a--s1.example.invalid', {
    fetchImpl: async () => responses.shift(), attempts: 5, maxWaitMs: 10_000,
    retryMs: 0, sleep: async () => {},
  });
  assert.equal(out.ready, true);
  assert.equal(out.attempts, 4);
  assert.equal(out.consecutivePasses, 2);
});

test('readiness rejects a stale self-app build and exhausts a persistent 403', async () => {
  const expectedBodySha256 = crypto.createHash('sha256').update('preview bridge').digest('hex');
  const staleThenReady = [
    routeResponse(200, 'application/javascript', '', 'production bridge'),
    routeResponse(200, 'application/javascript', '', 'preview bridge'),
    routeResponse(200, 'application/javascript', '', 'preview bridge'),
  ];
  const ready = await check.waitForAssetRouteReady('https://usernode--s1.example.invalid', {
    fetchImpl: async () => staleThenReady.shift(), expectedBodySha256,
    attempts: 4, maxWaitMs: 10_000, retryMs: 0, sleep: async () => {},
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.attempts, 3);

  const failed = await check.waitForAssetRouteReady('https://a--s1.example.invalid', {
    fetchImpl: async () => routeResponse(403, 'text/plain', '', 'Access denied'),
    attempts: 3, maxWaitMs: 10_000, retryMs: 0, sleep: async () => {},
  });
  assert.equal(failed.ready, false);
  assert.equal(failed.attempts, 3);
  assert.equal(failed.consecutivePasses, 0);
  assert.match(failed.verdict.reason, /403 text\/plain/);
});

test('readiness stops at its wall-clock deadline even when attempts remain', async () => {
  let elapsed = 0;
  const out = await check.waitForAssetRouteReady('https://a--s1.example.invalid', {
    fetchImpl: async () => routeResponse(403, 'text/plain', '', 'Access denied'),
    attempts: 20, maxWaitMs: 100, retryMs: 500,
    now: () => elapsed,
    sleep: async (ms) => { elapsed += ms; },
  });
  assert.equal(out.ready, false);
  assert.equal(out.attempts, 1);
  assert.equal(elapsed, 100);
});

test('the readiness feature can be switched off', (t) => {
  const before = process.env.ASSET_ROUTE_CHECK_ENABLED;
  process.env.ASSET_ROUTE_CHECK_ENABLED = 'off';
  t.after(() => { if (before === undefined) delete process.env.ASSET_ROUTE_CHECK_ENABLED; else process.env.ASSET_ROUTE_CHECK_ENABLED = before; });
  assert.equal(check.isEnabled(), false);
});

test('the exact asset assertion rides inside the public-browser checks Job', () => {
  assert.deepEqual(
    visuals.assetRouteBrowserTest('https://a--s1.example.invalid/', 17),
    {
      index: 17,
      name: check.ASSET_CHECK_NAME,
      path: check.ASSET_CHECK_PATH,
      url: `https://a--s1.example.invalid${check.ASSET_CHECK_PATH}`,
      expectSelector: '',
      expectText: visuals.ASSET_ROUTE_PROOF_TEXT,
      allowConsoleErrors: true,
      solo: true,
    }
  );
  assert.match(visuals.ASSET_ROUTE_PROOF_TEXT, /__usernodeBridge/);

  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'visuals.js'), 'utf8');
  const capture = src.slice(src.indexOf('async function captureForSession('), src.indexOf('async function settleCaptureRun('));
  const appended = capture.indexOf('tests.push(assetRouteBrowserTest(stagingOrigin, tests.length))');
  const launched = capture.indexOf('kubernetes.runCaptureJob(config, {');
  assert.ok(appended > -1, 'the asset assertion is dispatched with the browser suite');
  assert.ok(appended < launched, 'the assertion is in the persisted Job manifest and payload');

  const settlement = src.slice(src.indexOf('async function settleCaptureRun('));
  assert.doesNotMatch(settlement, /maybeRunAssetRouteCheck/,
    'the orchestrator hairpin path cannot override the browser Job verdict');
});

test('capture gates on public asset readiness before testing state or either Job launch', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'visuals.js'), 'utf8');
  const body = src.slice(src.indexOf('async function captureForSession('), src.indexOf('async function settleCaptureRun('));
  const gate = body.indexOf('await assetRouteCheck.waitForAssetRouteReady(assetOrigin');
  const pending = body.indexOf("await setChecksPending(pool, session.id, commitHash, 'testing', trigger)");
  const unit = body.indexOf('unitSuite.maybeRunUnitSuite({');
  const capture = body.indexOf('kubernetes.runCaptureJob(config, {');
  assert.ok(gate > -1, 'the central capture path waits on the public route');
  assert.ok(gate < pending, 'readiness precedes the testing-state flip');
  assert.ok(gate < unit, 'readiness precedes the unit Job');
  assert.ok(gate < capture, 'readiness precedes the capture Job');
  assert.match(body.slice(0, pending), /internalOrigin = applicationRuntime\.appOrigin/);
  assert.match(body.slice(gate, pending), /expectedBodySha256/,
    'self-app readiness pins the public asset response to the preview bytes');
  assert.match(body.slice(gate, pending), /PLATFORM_ASSET_ROUTE_NOT_READY/,
    'bounded exhaustion takes the existing infrastructure-error path');
});
