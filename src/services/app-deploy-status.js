'use strict';

/**
 * Per-app redeploy tracker.
 *
 * Whether an app's production is being redeployed right now, mirroring
 * `services/deploy-status.js` (which tracks the *platform's* own deploy via
 * a file on disk) but for individual apps' production rebuilds.
 *
 * Used by `services/staging.js` (and the fleet rollover) to flip a slug into
 * "deploying" before `rebuildProduction` does its work and back out when it
 * finishes (or throws). Consumers:
 *
 *   - Frontend version pills (header + home-screen cards) read the
 *     state from `/api/apps/...` and `/api/apps/:slug/version`, then
 *     listen for the `app_redeploy_status` WS broadcasts to flip live.
 *   - The heal pass and the fleet rollover skip an app being deployed, so
 *     they never restart or redeploy it under a deploy.
 *
 * Why a table of its own and not apps.status?
 *   The old `apps.status='redeploying'` approach was rejected on
 *   purpose (see comment block in `main-drift-poller.js`): toggling
 *   apps.status mid-rebuild also drops the URL from the home tile,
 *   because URL computation in routes/apps.js gates on
 *   status='running'.
 *
 * Why the database at all?
 *   The deploying process may not be the one reading: production deploys
 *   after a merge run in the workflow worker (workflow-worker.js), while the
 *   pill, the heal pass and the rollover run on the web Pods. So the record
 *   is an `app_deploys` row the deploying process holds and keeps fresh
 *   (services/in-flight-record.js). A process that dies mid-deploy stops
 *   its heartbeat, and its row reads as nothing within two minutes, as an
 *   in-memory record vanished with its process before.
 */

const log = require('./logger');
const { HOLDER, createHolds } = require('./in-flight-record');

// Anything claiming to be deploying for >30min is almost certainly an
// orphaned record (caller died without unwinding the try/finally) rather
// than a genuinely slow build, and we'd rather show the wrong-but-stable
// non-deploying state than a permanently spinning pill. Same TTL as the
// platform's `deploy-status.read()`.
const DEPLOY_STALE_AFTER_MS = 30 * 60 * 1000;

// This process's own deploys: slug -> { deploying, startedAt, fromSha }.
// markEnd's broadcast repeats what markStart said, and a read in this
// process still sees them if the database could not be written.
const _own = new Map();
const holds = createHolds('app-deploy-status');

const HOLD_SQL = `INSERT INTO app_deploys (app_id, holder, started_at, from_sha)
  SELECT id, $2, $3::timestamptz, $4 FROM apps WHERE slug = $1
  ON CONFLICT (app_id, holder) DO UPDATE
    SET started_at = EXCLUDED.started_at, from_sha = EXCLUDED.from_sha, heartbeat_at = NOW()`;
const RELEASE_SQL = `DELETE FROM app_deploys d USING apps a
  WHERE a.id = d.app_id AND a.slug = $1 AND d.holder = $2`;
const READ_SQL = `SELECT a.slug, d.started_at, d.from_sha
  FROM app_deploys d JOIN apps a ON a.id = d.app_id
  WHERE a.slug = ANY($1::text[]) AND d.heartbeat_at > NOW() - interval '2 minutes'
  ORDER BY d.started_at`;

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
  _own.set(slug, { deploying: true, startedAt, fromSha });
  holds.hold(slug, (pool) => pool.query(HOLD_SQL, [slug, HOLDER, startedAt, fromSha]));
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
  const prev = _own.get(slug);
  _own.delete(slug);
  holds.release(slug, (pool) => pool.query(RELEASE_SQL, [slug, HOLDER]));
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

// Stale-deploy gate. Don't delete here — the caller of rebuildProduction
// owns the lifecycle, and reading it as not deploying is enough to unstick
// the UI.
function gated(entry) {
  const age = Date.now() - new Date(entry.startedAt).getTime();
  return age > DEPLOY_STALE_AFTER_MS ? { ...entry, deploying: false, stale: true } : { ...entry };
}

// The apps among `slugs` being deployed by any process: Map slug -> entry.
async function readMany(slugs) {
  const wanted = [...new Set((slugs || []).filter(Boolean).map(String))];
  const out = new Map();
  if (!wanted.length) return out;
  let pool = null;
  try { pool = require('../db/pool').getPool(); } catch { /* memory only */ }
  if (pool) {
    try {
      const { rows } = await pool.query(READ_SQL, [wanted]);
      // Oldest first, so the newest deploy of a slug is the one kept.
      for (const r of rows) {
        out.set(r.slug, { deploying: true, startedAt: new Date(r.started_at).toISOString(), fromSha: r.from_sha || null });
      }
    } catch (err) {
      log.warn('app-deploy-status', 'Could not read deploys in flight', { err: err.message });
    }
  }
  for (const slug of wanted) {
    if (!out.has(slug) && _own.has(slug)) out.set(slug, _own.get(slug));
  }
  for (const [slug, entry] of out) out.set(slug, gated(entry));
  return out;
}

async function read(slug) {
  if (!slug) return null;
  return (await readMany([slug])).get(String(slug)) || null;
}

module.exports = { markStart, markEnd, read, readMany };
