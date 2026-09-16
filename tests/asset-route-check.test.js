'use strict';

// Asset-route check (#2315, phase 2 of #2047): one synthetic row reporting
// whether the preview's OWN origin serves the platform's hosted assets.
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
//   * A transient miss is retried for a bounded window, while a persistent
//     bad route still produces the same blocking/advisory failure row.
//   * It runs only where the probe means something: Kubernetes capture, an
//     https preview origin. The docker capture origin is the bare container,
//     with the edge that routes these prefixes out of the path.
//   * Same earned gating as the unit suite: advisory until the app has
//     passed it once, blocking after, and an advisory failure never flips a
//     green run.
//   * Nothing about it can throw into the checks run.
//
// Run with: node --test tests/asset-route-check.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const check = require('../src/services/asset-route-check');
const checkHistory = require('../src/services/check-history');
const visuals = require('../src/services/visuals');

const K8S = { captureRuntime: 'kubernetes' };

function stub(t, obj, overrides) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) { saved[k] = obj[k]; obj[k] = v; }
  t.after(() => { Object.assign(obj, saved); });
}

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

test('a route that converges after an initial 403 is retried and passes', async () => {
  let calls = 0;
  const out = await check.probeAssetRouteUntilSettled('https://a--s1.example.invalid', {
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? { status: 403, headers: { get: () => 'text/plain' }, text: async () => 'Access denied' }
        : { status: 200, headers: { get: () => 'application/javascript' }, text: async () => '' };
    },
    attempts: 3,
    retryMs: 0,
    sleep: async () => {},
  });
  assert.equal(calls, 2);
  assert.equal(out.attempts, 2);
  assert.equal(out.verdict.passed, true);
});

test('a persistent bad route still fails after the bounded retry window', async () => {
  let calls = 0;
  const out = await check.probeAssetRouteUntilSettled('https://a--s1.example.invalid', {
    fetchImpl: async () => {
      calls += 1;
      return { status: 403, headers: { get: () => 'text/plain' }, text: async () => 'Access denied' };
    },
    attempts: 3,
    retryMs: 0,
    sleep: async () => {},
  });
  assert.equal(calls, 3);
  assert.equal(out.attempts, 3);
  assert.equal(out.verdict.passed, false);
  assert.match(out.verdict.reason, /403 text\/plain/);
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

// ── maybeRunAssetRouteCheck ────────────────────────────────────────────

function fakeFetch(status, contentType, body = '') {
  return async () => ({
    status,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  });
}

test('it only runs on Kubernetes capture against an https preview origin', async () => {
  const fetchImpl = async () => assert.fail('must not probe');
  assert.equal(await check.maybeRunAssetRouteCheck({ config: { captureRuntime: 'docker' }, stagingOrigin: 'https://a--s1.example.invalid', fetchImpl }), null);
  assert.equal(await check.maybeRunAssetRouteCheck({ config: K8S, stagingOrigin: 'http://sv-app:3000', fetchImpl }), null);
  assert.equal(await check.maybeRunAssetRouteCheck({ config: K8S, stagingOrigin: '', fetchImpl }), null);
});

test('it can be switched off', async (t) => {
  const before = process.env.ASSET_ROUTE_CHECK_ENABLED;
  process.env.ASSET_ROUTE_CHECK_ENABLED = 'off';
  t.after(() => { if (before === undefined) delete process.env.ASSET_ROUTE_CHECK_ENABLED; else process.env.ASSET_ROUTE_CHECK_ENABLED = before; });
  assert.equal(await check.maybeRunAssetRouteCheck({
    config: K8S, stagingOrigin: 'https://a--s1.example.invalid', fetchImpl: async () => assert.fail('must not probe'),
  }), null);
});

test('a pass is a non-advisory row plus a passing history entry', async () => {
  const out = await check.maybeRunAssetRouteCheck({
    config: K8S, appId: 7, stagingOrigin: 'https://a--s1.example.invalid',
    fetchImpl: fakeFetch(200, 'application/javascript'),
  });
  assert.deepEqual(out.row, {
    index: check.ASSET_CHECK_INDEX, name: check.ASSET_CHECK_NAME, path: check.ASSET_CHECK_PATH,
    status: 'pass', advisory: false, consoleErrors: [],
  });
  assert.equal(out.history.passed, true);
  assert.equal(out.history.name, check.ASSET_CHECK_NAME);
});

test('a failure on an app that never passed it is advisory', async (t) => {
  stub(t, checkHistory, { loadGraduated: async () => new Set() });
  const out = await check.maybeRunAssetRouteCheck({
    config: K8S, pool: {}, appId: 7, stagingOrigin: 'https://a--s1.example.invalid',
    fetchImpl: fakeFetch(200, 'text/html', '<!doctype html>'), probeAttempts: 1,
  });
  assert.equal(out.row.status, 'fail');
  assert.equal(out.row.advisory, true);
  assert.match(out.row.failureReason, /200 text\/html/);
  assert.equal(out.history.passed, false);
});

test('a failure on an app that has passed it before blocks', async (t) => {
  stub(t, checkHistory, { loadGraduated: async () => new Set([out0().history.checkKey]) });
  const out = await check.maybeRunAssetRouteCheck({
    config: K8S, pool: {}, appId: 7, stagingOrigin: 'https://a--s1.example.invalid',
    fetchImpl: fakeFetch(503, 'text/plain'), probeAttempts: 1,
  });
  assert.equal(out.row.advisory, false);
});

function out0() {
  // The checkKey the module derives, without reaching into its internals.
  return { history: { checkKey: require('../src/services/app-manifest').checkKey(check.ASSET_CHECK_NAME, check.ASSET_CHECK_PATH) } };
}

test('a graduation lookup error falls back to advisory, and nothing throws', async (t) => {
  stub(t, checkHistory, { loadGraduated: async () => { throw new Error('db down'); } });
  const out = await check.maybeRunAssetRouteCheck({
    config: K8S, pool: {}, appId: 7, stagingOrigin: 'https://a--s1.example.invalid',
    fetchImpl: fakeFetch(200, 'text/html'), probeAttempts: 1,
  });
  assert.equal(out.row.advisory, true);
  const thrown = await check.maybeRunAssetRouteCheck({
    config: K8S, pool: {}, appId: 7, stagingOrigin: 'https://a--s1.example.invalid',
    fetchImpl: async () => { throw new Error('socket hang up'); }, probeAttempts: 1,
  });
  assert.equal(thrown.row.status, 'fail');
  assert.match(thrown.row.failureReason, /socket hang up/);
});

// ── the row in a checks run ────────────────────────────────────────────

function frame(index) {
  return { index, status: 'pass', name: `Loads /p${index}`, path: `/p${index}`, consoleErrors: [], failureReason: '' };
}
function assetRow(status, advisory) {
  return {
    index: check.ASSET_CHECK_INDEX, name: check.ASSET_CHECK_NAME, path: check.ASSET_CHECK_PATH,
    status, advisory, consoleErrors: [], failureReason: status === 'pass' ? undefined : '200 text/html',
  };
}

test('an advisory asset-route failure shows but leaves a green run green', () => {
  const out = visuals.classifyTests([frame(0)], 1, { extraRows: [assetRow('fail', true)] });
  assert.equal(out.state, 'passing');
  assert.ok(out.results.some((r) => r.index === check.ASSET_CHECK_INDEX && r.advisory));
});

test('a blocking asset-route failure fails the run', () => {
  const out = visuals.classifyTests([frame(0)], 1, { extraRows: [assetRow('fail', false)] });
  assert.equal(out.state, 'failing');
});

test('settlement probes, carries the row, and records it in check history', () => {
  // Source pin: the settlement half is shared with the harvester, so the
  // wiring has to live in settleCaptureRun rather than beside the launch.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'visuals.js'), 'utf8');
  const body = src.slice(src.indexOf('async function settleCaptureRun('));
  assert.match(body, /const assetOutcome = shotsOnly \? null : await assetRouteCheck\.maybeRunAssetRouteCheck\(\{/);
  assert.match(body, /if \(assetOutcome\) extraRows\.push\(assetOutcome\.row\);/);
  assert.match(body, /\(dispatched \|\| unitOutcome \|\| assetOutcome\) && checksResult\.state !== 'error'/);
  assert.match(body, /if \(assetOutcome\) historyRows\.push\(assetOutcome\.history\);/);
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

test('its synthetic index does not collide with the other synthetic rows', () => {
  const unitSuite = require('../src/services/unit-suite');
  assert.equal(check.ASSET_CHECK_INDEX, -4);
  assert.notEqual(check.ASSET_CHECK_INDEX, unitSuite.UNIT_CHECK_INDEX);
});
