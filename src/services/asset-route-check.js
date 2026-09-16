// Asset-route check: does the preview's OWN origin serve the platform's
// hosted assets? One platform readiness gate plus one public-browser row in
// the proposal checks run (#2315, #2344).
//
// Why this exists. Apps load the bridge, the native kit and the Tailwind
// runtime from `/usernode-bridge/`, `/usernode-native/` and
// `/usernode-tailwind/` on their own hostname; every deploy routes those
// prefixes to the shared asset backend (kubernetes.js appIngressManifest).
// When that routing is missing, the path falls through to the app's SPA
// fallback and answers 200 text/html where a script was expected — the app
// loses its bridge and styling, and nothing in a proposal's checks tells
// that apart from the app breaking its own markup. When the backend itself
// is down, every prefix answers 503. Both are platform problems, and this
// row says so by name instead of leaving an app author to read platform
// source.
//
// What it does. Before either checks Job exists, a bounded sequence of
// unauthenticated GETs waits for two consecutive JavaScript responses. For a
// platform preview, the public bytes must also match the preview Service, so
// a stale/shared production backend cannot satisfy readiness. Once launched,
// the capture Job visits the exact asset URL from the same public-browser
// network path as every app check and asserts a stable bridge identifier.
// That final row inherits the browser runner's isolated cold retries.
//
// Where it runs. Kubernetes capture only. There the preview origin is the
// public ingress hostname, which is what a browser sees. On Docker the
// capture origin is the bare container and the edge is not in the path.
//
// Gating. The browser row enters the ordinary dispatched-check history under
// the same stable name/path, so it keeps #1019's earned-gating semantics.

'use strict';

const crypto = require('node:crypto');

const ASSET_CHECK_NAME = "Platform assets load from the app's own address";
const ASSET_CHECK_PATH = '/usernode-bridge/v1/bridge.js';

const PROBE_TIMEOUT_MS = parseInt(process.env.ASSET_ROUTE_CHECK_TIMEOUT_MS, 10) || 10 * 1000;
const READINESS_WAIT_MS = parseInt(process.env.ASSET_ROUTE_READY_WAIT_MS, 10) || 60 * 1000;
const READINESS_ATTEMPTS = parseInt(process.env.ASSET_ROUTE_READY_ATTEMPTS, 10) || 32;
const READINESS_RETRY_MS = parseInt(process.env.ASSET_ROUTE_READY_RETRY_MS, 10) || 2 * 1000;
const READINESS_PASSES = 2;
// Enough of the body to show WHAT answered (an HTML shell, a JSON error)
// without carrying a page into test_results.
const BODY_PREVIEW_CHARS = 80;

function isEnabled() {
  const v = String(process.env.ASSET_ROUTE_CHECK_ENABLED ?? '1').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

function preview(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > BODY_PREVIEW_CHARS ? `${flat.slice(0, BODY_PREVIEW_CHARS)}…` : flat;
}

// Pure: the verdict and the sentence an app author reads. `error` is a
// network-level failure (no response at all).
function classifyAssetResponse({
  status = 0, contentType = '', bodyStart = '', buildSha = '',
  bodySha256 = '', expectedBodySha256 = '', error = null,
} = {}) {
  if (error) {
    return {
      passed: false,
      reason: `Could not reach ${ASSET_CHECK_PATH} on the preview's own address: ${error}. `
        + 'This is a platform or network problem, not something in this proposal.',
    };
  }
  const type = String(contentType || '').split(';')[0].trim().toLowerCase() || 'no content type';
  const body = preview(bodyStart);
  const seen = body ? ` Response started: "${body}"` : '';
  const expected = String(expectedBodySha256 || '').trim().toLowerCase();
  const served = String(bodySha256 || '').trim().toLowerCase();
  if (status === 200 && /javascript|ecmascript/.test(type) && expected && served !== expected) {
    const observed = served ? `asset digest ${served}` : 'no readable asset digest';
    return {
      passed: false,
      reason: `${ASSET_CHECK_PATH} answered 200 ${type}, but produced ${observed} instead of preview digest ${expected}. `
        + 'The public edge may still be serving the shared production asset backend or a stale preview route. '
        + 'This is platform routing, not something in this proposal.',
    };
  }
  if (status === 200 && /javascript|ecmascript/.test(type)) {
    return { passed: true, reason: null };
  }
  let why;
  if (status === 200 && type === 'text/html') {
    why = "the prefix is not routed on this address, so the app's own page answered where a script was expected.";
  } else if (status === 401 || status === 403) {
    why = "the prefix is not routed on this address, so the app's sign-in gate answered (these files are meant to be public).";
  } else if (status === 404) {
    why = 'the prefix is not routed on this address and the app has no such file.';
  } else if (status >= 500) {
    why = "the route exists but the platform's shared asset backend is not serving.";
  } else {
    why = 'this is not the platform bridge.';
  }
  return {
    passed: false,
    reason: `${ASSET_CHECK_PATH} answered ${status} ${type}: ${why}${seen} `
      + 'Apps load the bridge, native kit and Tailwind from these paths, so they will render without them. '
      + 'This is platform routing, not something in this proposal.',
  };
}

// One GET, bounded. Never throws: a network failure comes back as `error`.
async function probeAssetRoute(origin, {
  fetchImpl = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS, signal = null,
  includeBodyHash = false,
} = {}) {
  const url = `${String(origin).replace(/\/+$/, '')}${ASSET_CHECK_PATH}`;
  const controller = new AbortController();
  signal?.throwIfAborted();
  const abortFromCaller = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      redirect: 'manual', signal: controller.signal,
      // Each readiness sample must reach the edge independently. Reusing one
      // keep-alive connection can pin every retry to the same stale Cilium /
      // Envoy listener even after the rest of the data plane has converged.
      headers: { connection: 'close' },
    });
    const contentType = (res.headers && typeof res.headers.get === 'function')
      ? (res.headers.get('content-type') || '') : '';
    const buildSha = (res.headers && typeof res.headers.get === 'function')
      ? (res.headers.get('x-platform-build') || '') : '';
    let bodyStart = '';
    let bodySha256 = '';
    if (res.status === 200 && /javascript|ecmascript/i.test(contentType) && includeBodyHash) {
      try {
        const bytes = typeof res.arrayBuffer === 'function'
          ? Buffer.from(await res.arrayBuffer())
          : Buffer.from(await res.text(), 'utf8');
        bodySha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      } catch (err) {
        return { error: `could not read ${ASSET_CHECK_PATH}: ${err.message}` };
      }
    }
    // Ordinary successes need no body preview. Fingerprinted self-app
    // successes consumed the full body above; failures only need the start.
    if (!(res.status === 200 && /javascript|ecmascript/i.test(contentType))) {
      try { bodyStart = (await res.text()).slice(0, 400); } catch { bodyStart = ''; }
    }
    return { status: res.status, contentType, buildSha, bodySha256, bodyStart };
  } catch (err) {
    if (signal?.aborted) throw signal.reason || err;
    const message = err && err.name === 'AbortError'
      ? `no response within ${Math.round(timeoutMs / 1000)}s`
      : String((err && (err.cause?.code || err.message)) || err);
    return { error: message };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

// Deployment readiness proves that the preview Pod can answer; it does not
// prove that the public Ingress data plane has observed the new route. Wait at
// the one boundary proposal checks all cross, and require TWO fresh-connection
// successes so one lucky load-balancer hop cannot declare a mixed edge ready.
// The absolute deadline bounds hung requests as well as retry sleeps.
async function waitForAssetRouteReady(origin, {
  fetchImpl = globalThis.fetch,
  maxWaitMs = READINESS_WAIT_MS,
  attempts = READINESS_ATTEMPTS,
  retryMs = READINESS_RETRY_MS,
  requiredPasses = READINESS_PASSES,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
  expectedBodySha256 = '',
  signal = null,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
} = {}) {
  const limit = Math.max(1, Number.isInteger(attempts) ? attempts : READINESS_ATTEMPTS);
  const needed = Math.max(1, Number.isInteger(requiredPasses) ? requiredPasses : READINESS_PASSES);
  const deadline = now() + Math.max(1, Number(maxWaitMs) || READINESS_WAIT_MS);
  let response = {};
  let verdict = classifyAssetResponse({ error: 'no probe ran' });
  let consecutivePasses = 0;
  let ran = 0;

  while (ran < limit) {
    signal?.throwIfAborted();
    const remaining = deadline - now();
    if (remaining <= 0) break;
    ran += 1;
    response = await probeAssetRoute(origin, {
      fetchImpl,
      timeoutMs: Math.max(1, Math.min(probeTimeoutMs, remaining)),
      signal,
      includeBodyHash: !!expectedBodySha256,
    });
    verdict = classifyAssetResponse({ ...response, expectedBodySha256 });
    consecutivePasses = verdict.passed ? consecutivePasses + 1 : 0;
    if (consecutivePasses >= needed) {
      return {
        ready: true, response, verdict, attempts: ran,
        consecutivePasses, requiredPasses: needed,
      };
    }
    const afterProbe = deadline - now();
    if (ran >= limit || afterProbe <= 0) break;
    await sleep(Math.min(retryMs, afterProbe));
    signal?.throwIfAborted();
  }

  return {
    ready: false, response, verdict, attempts: ran,
    consecutivePasses, requiredPasses: needed,
  };
}

module.exports = {
  ASSET_CHECK_NAME,
  ASSET_CHECK_PATH,
  isEnabled,
  classifyAssetResponse,
  probeAssetRoute,
  waitForAssetRouteReady,
};
