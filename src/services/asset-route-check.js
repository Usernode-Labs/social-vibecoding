// Asset-route check: does the preview's OWN origin serve the platform's
// hosted assets? One synthetic row in the proposal checks run (#2315,
// phase 2 of #2047).
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
// What it does. After the preview is up, a bounded sequence of unauthenticated
// GETs of the bridge on the preview's public origin. Ingress changes can
// converge just after workload readiness, so an initial miss gets two short
// retries; a persistent miss still fails. The prefixes are public by design
// (they bypass the per-app visibility gate), so no token is sent — a 401
// here is itself evidence that the prefix was not routed. The verdict is the
// status plus the content type, never the bytes: a 200 that is not JavaScript
// is exactly the failure this row exists for.
//
// Where it does NOT run: the platform's own self-app. deployApplication
// deliberately strips these three prefixes from the self app's Ingress
// (kubernetes.js, "route only for child apps") so its preview serves the
// asset bytes from the revision under review rather than the shared
// backend's copy of production. With no asset route, the probe falls through
// to the preview container itself, which sits behind the private-app access
// gate — and this probe sends no credential on purpose. So the row could
// only ever fail there, on every self-app proposal, describing a routing
// rule the platform is not supposed to have. It is skipped instead.
//
// Where it runs. Kubernetes capture only. There the preview origin is the
// public ingress hostname, which is what a browser sees. On the docker
// runtime the capture origin is the bare container (`http://<name>:3000`)
// and the edge in front of it — the thing that routes these prefixes — is
// not in the path, so a probe there would describe the wrong hop.
//
// Gating. Same #1019 earned gating as the unit-suite row: ADVISORY until
// this app has been observed passing it once, merge-BLOCKING from then on.
// Turning it on fleet-wide therefore never blocks an app whose routing was
// already broken before the check existed — it shows up, muted, on its
// next proposal instead.

'use strict';

const checkHistory = require('./check-history');
const appManifest = require('./app-manifest');
const log = require('./logger');

const ASSET_CHECK_NAME = "Platform assets load from the app's own address";
const ASSET_CHECK_PATH = '/usernode-bridge/v1/bridge.js';
// Synthetic-row index namespace: -1 the missing-advisory rollup, -2 the
// over-ceiling guard (visuals.js), -3 the unit suite (unit-suite.js).
const ASSET_CHECK_INDEX = -4;

const PROBE_TIMEOUT_MS = parseInt(process.env.ASSET_ROUTE_CHECK_TIMEOUT_MS, 10) || 10 * 1000;
const PROBE_ATTEMPTS = parseInt(process.env.ASSET_ROUTE_CHECK_ATTEMPTS, 10) || 3;
const PROBE_RETRY_MS = parseInt(process.env.ASSET_ROUTE_CHECK_RETRY_MS, 10) || 2 * 1000;
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
function classifyAssetResponse({ status = 0, contentType = '', bodyStart = '', error = null } = {}) {
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
async function probeAssetRoute(origin, { fetchImpl = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const url = `${String(origin).replace(/\/+$/, '')}${ASSET_CHECK_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { redirect: 'manual', signal: controller.signal });
    const contentType = (res.headers && typeof res.headers.get === 'function')
      ? (res.headers.get('content-type') || '') : '';
    let bodyStart = '';
    // Only a failure needs the body, and only its start.
    if (!(res.status === 200 && /javascript|ecmascript/i.test(contentType))) {
      try { bodyStart = (await res.text()).slice(0, 400); } catch { bodyStart = ''; }
    }
    return { status: res.status, contentType, bodyStart };
  } catch (err) {
    const message = err && err.name === 'AbortError'
      ? `no response within ${Math.round(timeoutMs / 1000)}s`
      : String((err && (err.cause?.code || err.message)) || err);
    return { error: message };
  } finally {
    clearTimeout(timer);
  }
}

async function probeAssetRouteUntilSettled(origin, {
  fetchImpl = globalThis.fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
  attempts = PROBE_ATTEMPTS,
  retryMs = PROBE_RETRY_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const limit = Math.max(1, Number.isInteger(attempts) ? attempts : PROBE_ATTEMPTS);
  let response;
  let verdict;
  for (let attempt = 1; attempt <= limit; attempt += 1) {
    response = await probeAssetRoute(origin, { fetchImpl, timeoutMs });
    verdict = classifyAssetResponse(response);
    if (verdict.passed || attempt === limit) {
      return { response, verdict, attempts: attempt };
    }
    await sleep(retryMs);
  }
  return { response, verdict, attempts: limit };
}

function shapeOutcome({ passed, reason, graduated }) {
  const checkKey = appManifest.checkKey(ASSET_CHECK_NAME, ASSET_CHECK_PATH);
  return {
    row: {
      index: ASSET_CHECK_INDEX,
      name: ASSET_CHECK_NAME,
      path: ASSET_CHECK_PATH,
      status: passed ? 'pass' : 'fail',
      advisory: passed ? false : !graduated,
      consoleErrors: [],
      ...(passed ? {} : { failureReason: reason }),
    },
    history: { checkKey, name: ASSET_CHECK_NAME, path: ASSET_CHECK_PATH, passed },
  };
}

// Returns { row, history } or null when the check does not apply. Never
// throws: the checks run must not die because this probe did.
// The self app is the SOURCE of the three asset trees, so there is no
// cross-hostname routing to verify on it — see the header.
function isSelfApp(config, appSlug) {
  const slug = String(config?.selfAppSlug || '');
  return !!slug && String(appSlug || '') === slug;
}

async function maybeRunAssetRouteCheck({
  config, pool, appId, appSlug = null, sessionId = null, stagingOrigin, fetchImpl,
  probeAttempts, probeRetryMs, sleep,
} = {}) {
  try {
    if (!isEnabled()) return null;
    if (!config || config.captureRuntime !== 'kubernetes') return null;
    if (isSelfApp(config, appSlug)) return null;
    if (typeof stagingOrigin !== 'string' || !/^https:\/\//i.test(stagingOrigin)) return null;

    // Ingress replacement and edge routing converge just after the preview
    // itself becomes ready. A single probe can therefore observe the old
    // 403/404/HTML route even though the reconciler has already committed
    // the replacement. Retry only this synthetic probe for a short bounded
    // window; a persistent routing failure still produces the same row.
    const probed = await probeAssetRouteUntilSettled(stagingOrigin, {
      fetchImpl,
      ...(probeAttempts === undefined ? {} : { attempts: probeAttempts }),
      ...(probeRetryMs === undefined ? {} : { retryMs: probeRetryMs }),
      ...(sleep === undefined ? {} : { sleep }),
    });
    const { response, verdict: { passed, reason }, attempts } = probed;

    let graduated = false;
    if (!passed) {
      const checkKey = appManifest.checkKey(ASSET_CHECK_NAME, ASSET_CHECK_PATH);
      try {
        graduated = (await checkHistory.loadGraduated(pool, appId)).has(checkKey);
      } catch (err) {
        log.warn('asset-route-check', 'Graduation lookup failed — treating as advisory', {
          sessionId, appId, err: err.message,
        });
      }
    }
    log.info('asset-route-check', 'Asset route probed', {
      sessionId, appId, origin: stagingOrigin, passed,
      status: response.status, contentType: response.contentType || undefined,
      error: response.error || undefined, attempts,
      graduated: passed ? undefined : graduated,
    });
    return shapeOutcome({ passed, reason, graduated });
  } catch (err) {
    log.warn('asset-route-check', 'Asset route check failed to run (non-fatal)', {
      sessionId, appId, err: err.message,
    });
    return null;
  }
}

module.exports = {
  isSelfApp,
  ASSET_CHECK_NAME,
  ASSET_CHECK_PATH,
  ASSET_CHECK_INDEX,
  isEnabled,
  classifyAssetResponse,
  probeAssetRoute,
  probeAssetRouteUntilSettled,
  maybeRunAssetRouteCheck,
};
