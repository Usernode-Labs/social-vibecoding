// Anonymous-shell probe: figures out, per app, whether its HTML shell is
// reachable without a platform session. The landing page's app directory
// uses this to gray out "account required" apps instead of letting an
// anonymous visitor tap through into a 401.
//
// How: fetch `http://usernode-app-<slug>:3000/` (the app's container on
// the shared docker network — the same address Caddy proxies to) with NO
// cookies and NO Sec-Fetch-Dest header, exactly like an anonymous
// browser hitting the app subdomain, and classify the response:
//
//   2xx                      -> 'public'  (echo / lastwin style open shell)
//   401 / 403                -> 'gated'   (scaffold's "Open in Usernode" page)
//   3xx off-origin           -> 'gated'   (bounce to the platform login)
//   3xx same-origin          -> followed (<= 3 hops), then classified
//   anything else / timeout  -> 'unknown' (never claim public on a guess)
//
// Results land on apps.anon_shell + anon_shell_checked_at (schema.sql).
// The sweep runs every SWEEP_INTERVAL_MS and re-probes an app when it has
// never been probed, was deployed since its last probe, or its result is
// older than RECHECK_AFTER_MS — so fresh deploys converge within one
// sweep tick without hooking every deploy call site.

const http = require('http');
const log = require('./logger');
const { getPool } = require('../db/pool');

const APP_CONTAINER_PORT = 3000;
const PROBE_TIMEOUT_MS = 5000;
const MAX_REDIRECT_HOPS = 3;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const RECHECK_AFTER_MS = 60 * 60 * 1000;
// Probes are cheap (one intra-network GET) but keep the fan-out bounded
// anyway so a 200-app fleet doesn't burst 200 sockets on one tick.
const SWEEP_CONCURRENCY = 4;

let intervalHandle = null;
let sweepInFlight = false;
let lastSweepAt = null;
let lastError = null;

function appShellUrl(slug) {
  return `http://usernode-app-${slug}:${APP_CONTAINER_PORT}/`;
}

// Pure classifier over (statusCode, Location header, probed URL) so tests
// can exercise the decision table without sockets. Returns 'public',
// 'gated', 'unknown', or { follow: <absolute next URL> }.
function classifyResponse(statusCode, location, currentUrl) {
  if (statusCode >= 200 && statusCode < 300) return 'public';
  if (statusCode === 401 || statusCode === 403) return 'gated';
  if (statusCode >= 300 && statusCode < 400) {
    if (!location) return 'unknown';
    let next;
    try { next = new URL(location, currentUrl); } catch { return 'unknown'; }
    const cur = new URL(currentUrl);
    // Off-origin redirect = the app is punting anonymous traffic somewhere
    // else (in practice: the platform's login). Same-origin = internal
    // routing (e.g. / -> /home.html); follow it and judge the destination.
    if (next.host !== cur.host) return 'gated';
    return { follow: next.toString() };
  }
  return 'unknown';
}

// One GET without cookies/Sec-Fetch-Dest; resolves to the raw
// { statusCode, location } pair. Rejects on network error / timeout.
function fetchShell(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, {
      headers: { accept: 'text/html' },
      timeout: PROBE_TIMEOUT_MS,
    }, (res) => {
      // Drain so the socket is reusable; the body content is irrelevant.
      res.resume();
      resolve({ statusCode: res.statusCode, location: res.headers.location || null });
    });
    req.on('timeout', () => req.destroy(new Error('probe timeout')));
    req.on('error', reject);
  });
}

// Full probe for one URL: follows same-origin redirects up to
// MAX_REDIRECT_HOPS, returns 'public' | 'gated' | 'unknown'.
async function probeUrl(url) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    let res;
    try {
      res = await fetchShell(current);
    } catch {
      return 'unknown';
    }
    const verdict = classifyResponse(res.statusCode, res.location, current);
    if (typeof verdict === 'string') return verdict;
    current = verdict.follow;
  }
  return 'unknown';
}

async function probeApp(pool, app) {
  const verdict = await probeUrl(appShellUrl(app.slug));
  await pool.query(
    `UPDATE apps SET anon_shell = $1, anon_shell_checked_at = NOW() WHERE id = $2`,
    [verdict, app.id]
  );
  if (verdict !== app.anon_shell) {
    log.info('shell-probe', 'App anon-shell classification changed', {
      slug: app.slug, from: app.anon_shell, to: verdict,
    });
  }
  return verdict;
}

// Apps worth (re-)probing this tick. Only running, platform-hosted,
// view-public apps: self-hosted containers aren't on our network, and
// view-private apps never appear on the landing page anyway.
async function selectDueApps(pool) {
  const { rows } = await pool.query(
    `SELECT id, slug, anon_shell FROM apps
      WHERE status = 'running'
        AND self_hosted IS NOT TRUE
        AND view_visibility = 'public'
        AND (
          anon_shell_checked_at IS NULL
          OR last_deploy_at > anon_shell_checked_at
          OR anon_shell_checked_at < NOW() - ($1 * INTERVAL '1 millisecond')
        )
      ORDER BY anon_shell_checked_at ASC NULLS FIRST`,
    [RECHECK_AFTER_MS]
  );
  return rows;
}

async function sweep(config) {
  if (sweepInFlight) return;
  sweepInFlight = true;
  try {
    const pool = getPool(config);
    const due = await selectDueApps(pool);
    if (due.length) {
      log.info('shell-probe', 'Probing app shells', { count: due.length });
    }
    // Simple bounded worker pool over the due list.
    let idx = 0;
    const workers = Array.from({ length: Math.min(SWEEP_CONCURRENCY, due.length) }, async () => {
      while (idx < due.length) {
        const app = due[idx++];
        try {
          await probeApp(pool, app);
        } catch (err) {
          log.warn('shell-probe', 'Probe failed', { slug: app.slug, err: err.message });
        }
      }
    });
    await Promise.all(workers);
    lastSweepAt = new Date();
    lastError = null;
  } catch (err) {
    lastError = err.message;
    log.warn('shell-probe', 'Sweep failed', { err: err.message });
  } finally {
    sweepInFlight = false;
  }
}

function start(config) {
  if (intervalHandle) return;
  // First pass shortly after boot (give app containers a moment to come
  // up alongside the platform), then steady-state ticks.
  setTimeout(() => { sweep(config); }, 15 * 1000);
  intervalHandle = setInterval(() => { sweep(config); }, SWEEP_INTERVAL_MS);
  intervalHandle.unref?.();
}

function stop() {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
}

function getStatus() {
  return { lastSweepAt, lastError, sweepInFlight };
}

module.exports = {
  start,
  stop,
  sweep,
  getStatus,
  // Exported for tests:
  classifyResponse,
  probeUrl,
  probeApp,
  selectDueApps,
  appShellUrl,
};
