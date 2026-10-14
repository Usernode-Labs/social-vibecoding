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
 *
 * With the app-delivery workflow machine on (WF_APP_DELIVERY_ENABLED), a
 * deploy is the machine's, and so is its state: apps.deploy_state, which
 * every process reads and which outlives a restart (the deploy is retried).
 * `read(slug, row)` answers from either, given the app's row.
 */

const log = require('./logger');

// Same TTL as the platform's `deploy-status.read()` — anything claiming
// to be deploying for >30min is almost certainly an orphaned record
// (caller died without unwinding the try/finally) rather than a
// genuinely slow build, and we'd rather show the wrong-but-stable
// non-deploying state than a permanently spinning pill.
const DEPLOY_STALE_AFTER_MS = 30 * 60 * 1000;

// slug → { deploying, startedAt: ISO, fromSha, toSha? }. Each is this
// process's hold on the app's deploy (services/processes.js), so another
// platform process reads it as deploying (and its heal leaves it alone).
const _state = require('./processes').heldMap('deploy');

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
  // `missingSecrets` is forwarded so the frontend can render a
  // tailored "set ECHO_APP_SECRET_KEY to deploy" toast instead of a
  // generic "build failed" — staging.js sets it from the caught
  // MissingSecretsError.
  broadcast({
    type: 'app_redeploy_status',
    appSlug: slug,
    deploying: false,
    startedAt: prev.startedAt,
    fromSha: prev.fromSha,
    toSha: opts && opts.toSha ? String(opts.toSha) : null,
    failed: !!(opts && opts.failed),
    missingSecrets: Array.isArray(opts && opts.missingSecrets) ? opts.missingSecrets : null,
  });
}

// The deploy app delivery runs for this app, from its row (null when the
// row was not read with its deploy columns, or nothing is deploying). Not
// stale after 30 minutes: the machine retries a deploy whose process died.
function fromRow(row) {
  if (!row || row.deploy_state !== 'deploying') return null;
  const started = row.deploy_started_at instanceof Date ? row.deploy_started_at.toISOString() : row.deploy_started_at;
  return { deploying: true, startedAt: started || null, fromSha: row.deploy_from_sha || null };
}

function read(slug, row = null) {
  if (!slug) return null;
  const entry = _state.get(slug);
  if (!entry) {
    const delivered = fromRow(row);
    if (delivered) return delivered;
    let elsewhere = false;
    try { elsewhere = require('./processes').heldElsewhere('deploy', slug); } catch { /* none */ }
    return elsewhere ? { deploying: true, startedAt: null, fromSha: null } : null;
  }
  // Stale-deploy gate. Don't auto-delete here — the caller of
  // rebuildProduction owns the lifecycle, and pretending the entry
  // doesn't exist anymore is enough to unstick the UI.
  const age = Date.now() - new Date(entry.startedAt).getTime();
  if (age > DEPLOY_STALE_AFTER_MS) return { ...entry, deploying: false, stale: true };
  return { ...entry };
}

// `rows`: the apps' rows by slug (a Map), when the caller has them.
function readMany(slugs, rows = null) {
  const out = {};
  for (const slug of slugs || []) {
    const entry = read(slug, rows ? rows.get(slug) || null : null);
    if (entry) out[slug] = entry;
  }
  return out;
}

module.exports = { markStart, markEnd, read, readMany, fromRow };
