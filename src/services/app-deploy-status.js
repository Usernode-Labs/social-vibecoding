'use strict';

/**
 * Per-app redeploy tracker.
 *
 * Tiny in-memory map of `slug → { deploying, startedAt, fromSha, toSha }`
 * mirroring `services/deploy-status.js` (which tracks the *platform's*
 * own deploy via a file on disk) but for individual apps' production
 * rebuilds.
 *
 * Used by `services/staging.js` to flip a slug into "deploying" before
 * `rebuildProduction` does its docker work and back out when it
 * finishes (or throws). Consumers:
 *
 *   - Frontend version pills (header + home-screen cards) read the
 *     state from `/api/apps/...` and `/api/apps/:slug/version`, then
 *     listen for the `app_redeploy_status` WS broadcasts to flip live.
 *
 * Why in-memory and not a DB column?
 *   The old `apps.status='redeploying'` approach was rejected on
 *   purpose (see comment block in `main-drift-poller.js`): toggling
 *   apps.status mid-rebuild also drops the URL from the home tile,
 *   because URL computation in routes/apps.js gates on
 *   status='running'. Keeping deploy-progress out-of-band preserves
 *   the existing UX while still letting the UI surface it.
 *
 * Why no persistence across restarts?
 *   If the platform restarts mid-deploy, the rebuild job dies with
 *   it — there's nothing to track. A fresh process should naturally
 *   show no in-flight deploys, exactly the same as if the deploy had
 *   never started.
 */

const log = require('./logger');

// Same TTL as the platform's `deploy-status.read()` — anything claiming
// to be deploying for >30min is almost certainly an orphaned record
// (caller died without unwinding the try/finally) rather than a
// genuinely slow build, and we'd rather show the wrong-but-stable
// non-deploying state than a permanently spinning pill.
const DEPLOY_STALE_AFTER_MS = 30 * 60 * 1000;

// slug → { deploying, startedAt: ISO, fromSha, toSha? }
const _state = new Map();

// Lazy-required to dodge a require-cycle: ws.js doesn't import this
// module, but rebuildProduction (which calls into here) is reachable
// from server.js's wiring through routes which themselves load ws —
// so we keep the import lazy to be safe.
function broadcast(payload) {
  try {
    const { broadcastGlobal } = require('./ws');
    broadcastGlobal(payload);
  } catch (err) {
    log.warn('app-deploy-status', 'broadcast failed', { err: err.message });
  }
}

function markStart(slug, opts) {
  if (!slug) return;
  const startedAt = new Date().toISOString();
  const fromSha = opts && opts.fromSha ? String(opts.fromSha) : null;
  _state.set(slug, { deploying: true, startedAt, fromSha });
  broadcast({
    type: 'app_redeploy_status',
    appSlug: slug,
    deploying: true,
    startedAt,
    fromSha,
  });
}

function markEnd(slug, opts) {
  if (!slug) return;
  const prev = _state.get(slug);
  _state.delete(slug);
  if (!prev) return;
  broadcast({
    type: 'app_redeploy_status',
    appSlug: slug,
    deploying: false,
    startedAt: prev.startedAt,
    fromSha: prev.fromSha,
    toSha: opts && opts.toSha ? String(opts.toSha) : null,
    failed: !!(opts && opts.failed),
  });
}

function read(slug) {
  if (!slug) return null;
  const entry = _state.get(slug);
  if (!entry) return null;
  // Stale-deploy gate. Don't auto-delete here — the caller of
  // rebuildProduction owns the lifecycle, and pretending the entry
  // doesn't exist anymore is enough to unstick the UI.
  const age = Date.now() - new Date(entry.startedAt).getTime();
  if (age > DEPLOY_STALE_AFTER_MS) return { ...entry, deploying: false, stale: true };
  return { ...entry };
}

function readMany(slugs) {
  const out = {};
  for (const slug of slugs || []) {
    const entry = read(slug);
    if (entry) out[slug] = entry;
  }
  return out;
}

module.exports = { markStart, markEnd, read, readMany };
