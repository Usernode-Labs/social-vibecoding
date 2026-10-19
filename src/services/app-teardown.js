'use strict';

// Taking an app down, once whoever asked has been allowed to.
//
// The teardown used to live inline in DELETE /api/apps/:slug (routes/apps.js),
// the one path that removed an app. Retiring a test account
// (services/test-accounts.js) removes the apps that account made too, and it
// must take down exactly what the route takes down — the runtime, the app's
// database and its stored files, then the row — or a retired tester leaves a
// container or a database behind. So both call this. The gates (who may
// delete, the typed name, the shared-app rules) stay with each caller: this
// decides nothing, it only removes.
//
// Every step before the row delete is best-effort, as it always was: a
// runtime or database that is already gone must not stop the row going, and a
// failed object-store sweep leaves orphans under app/<id>/ for manual cleanup
// rather than a half-deleted app. Two steps throw: the previews' retirement,
// first (the preview machine must have applied it before the rows go, or a
// preview it adopts from its row is never retired), and the row delete.

const log = require('./logger');
const appAccess = require('./app-access');

// An app whose teardown has started. The row goes last, so for the whole
// teardown the app still reads as a running app whose runtime is missing,
// which is exactly what the self-heal sweep (services/app-heal.js) rebuilds.
// It asks here first. On 2026-10-05 it did not: a test account was retired,
// its app's database drop took 30 seconds, and the sweep rebuilt the
// production Deployment ten seconds in. The row was then deleted, and the
// Deployment crash-looped against the dropped database for a week.
//
// The teardown marks the row (apps.teardown_started_at) as it begins to
// remove anything, so every process reads it at once, and a deploy that
// finishes while it runs (the app-delivery machine's work, in whichever
// process claims it) removes what it put back. The mark goes on after the
// previews are retired, the one step that may refuse and leave the app as
// it was: a teardown refused there, or whose process dies there, leaves an
// intact app unmarked. From the mark on, the app is being removed: the mark
// stays even if a later step fails or its process dies, so a half-removed
// app is never rebuilt, and deleting it again finishes it. `app` is a row:
// one read with the column answers from it, any other is read again.
async function isTearingDown(pool, app) {
  if (app && Object.prototype.hasOwnProperty.call(app, 'teardown_started_at')) return !!app.teardown_started_at;
  const { rows: [r] } = await pool.query('SELECT teardown_started_at FROM apps WHERE id = $1', [app.id]);
  return !!r?.teardown_started_at;
}

// A deploy or a recovery takes minutes, so an app can be deleted while one
// runs: the teardown removes the runtime, then the deploy puts it back. Its
// caller asks this once it has finished (app-heal's recovery, app-delivery's
// deploy): an app that is gone or going by then keeps no runtime. A lookup
// that fails removes nothing. Resolves whether it removed one.
async function removeRuntimeIfDeleted(config, pool, app, { who = 'deploy' } = {}) {
  try {
    const { rows: [r] } = await pool.query('SELECT teardown_started_at FROM apps WHERE id = $1', [app.id]);
    if (r && !r.teardown_started_at) return false;
    const applicationRuntime = require('./application-runtime');
    const ref = applicationRuntime.productionRef(config, app);
    await applicationRuntime.remove(config, { ...ref, appId: app.id }, {
      deleteBuilds: ref.runtimeKind === 'kubernetes',
    });
    log.warn('app-teardown', `App was deleted during a ${who}; runtime removed`, { slug: app.slug });
    return true;
  } catch (err) {
    log.warn('app-teardown', `Could not check for a deleted app after a ${who}`, { slug: app.slug, err: err.message });
    return false;
  }
}

async function teardownApp(pool, config, app) {
  await removeApp(pool, config, app);
}

async function removeApp(pool, config, app) {
  await retirePreviews(pool, app);
  // From here on the app is being removed (isTearingDown above).
  await pool.query('UPDATE apps SET teardown_started_at = COALESCE(teardown_started_at, NOW()) WHERE id = $1', [app.id]);
  // Teardown through the backend that owns this app. Historical rows
  // without runtime_kind/runtime_name remain Docker-compatible.
  if (app.runtime_name || app.container_id) {
    const applicationRuntime = require('./application-runtime');
    await applicationRuntime.remove(config, {
      runtimeKind: app.runtime_kind || 'docker',
      runtimeName: app.runtime_name || app.container_id,
      appId: app.id,
    }, { deleteBuilds: app.runtime_kind === 'kubernetes' }).catch(() => {});
    if (!app.runtime_kind || app.runtime_kind === 'docker') {
      await applicationRuntime.remove(config, {
        runtimeKind: 'docker', runtimeName: `usernode-app-${app.slug}`,
      }).catch(() => {});
    }
  }

  // The custom domain's edge resources (#4405): its Ingress and the
  // certificate Secret on Kubernetes; on Docker nothing, as below. The row
  // itself goes with the app (ON DELETE CASCADE).
  try {
    const appDomains = require('./app-domains');
    const domain = await appDomains.forApp(pool, app.id);
    if (domain) {
      await appDomains.teardownEdge(config, domain);
      appDomains.invalidateHost(domain.hostname);
    }
  } catch (err) {
    log.warn('apps', 'Custom domain teardown failed on app delete', { appId: app.id, err: err.message });
  }

  // No Caddy route to remove — the wildcard site maps hostnames to
  // container names dynamically, so removing the container above
  // takes the app offline. The on-demand cert lingers harmlessly and
  // the ask endpoint stops vouching once the app row is deleted below.

  // Drop app database
  const dbManager = require('./db-manager');
  await dbManager.dropDatabase(dbManager.appDbName(app.slug)).catch(() => {});

  // Remove the app's stored user files from the object store (#752)
  // BEFORE the row delete cascades away the app_files metadata.
  // Best-effort with a loud log: a failure here leaves orphaned
  // objects under app/<id>/ for manual cleanup, never a broken
  // delete.
  try {
    const appFilesSvc = require('./app-files');
    const store = appFilesSvc.getStore(config);
    if (store) {
      const removed = await store.removeAppPrefix(app.id);
      if (removed) log.info('apps', 'Removed app files from object store', { appId: app.id, count: removed });
    }
  } catch (err) {
    log.warn('apps', 'Object-store cleanup failed on app delete (orphans remain under app/<id>/)', {
      appId: app.id, err: err.message,
    });
  }

  // Delete from DB (cascades to chat_messages, sessions, etc.)
  await pool.query('DELETE FROM apps WHERE id = $1', [app.id]);
  appAccess.invalidateVisibility(app.id, app.slug);
}

// The app's previews are retired by the preview machine, by identity: the
// ones it holds, and any a row still points at, which it adopts from the row
// when it applies the request. Its work needs only the names it recorded, so
// the rows can go afterwards, but only once each request has RETIRED it: one
// the machine has only recorded would find the row gone and never retire what
// it named, and one it refused or faulted on retires nothing. First, so a
// refusal leaves the app as it was; a delete asked again finishes it.
const RETIRE_WAIT_MS = 30_000;

// A preview the machine has not retired (yet): nothing of the app was
// removed, and asking again in a minute finishes it. The delete route
// answers it with 409 and Retry-After, not as a fault.
class PreviewNotRetiredError extends Error {
  constructor(sessionId, why) {
    super(`The preview of proposal ${sessionId} is not retired yet (${why}); delete the app again in a minute`);
    this.name = 'PreviewNotRetiredError';
    this.code = 'preview_retiring';
    this.sessionId = sessionId;
    this.retryAfterSeconds = 60;
  }
}

async function retirePreviews(pool, app) {
  const previewWorkflow = require('./preview-workflow');
  const { rows } = await pool.query(
    `SELECT cs.id FROM chat_sessions cs
       LEFT JOIN wf_instances w ON w.machine = 'preview' AND w.key = 'session:' || cs.id
      WHERE cs.app_id = $1
        AND ((w.key IS NOT NULL AND w.state NOT IN ('retired', 'detached'))
             OR cs.staging_url IS NOT NULL OR cs.staging_runtime_name IS NOT NULL)`, [app.id]);
  for (const r of rows) {
    const out = await previewWorkflow.retire({ session: { id: r.id, app_id: app.id }, reason: 'app_deleted', terminal: true,
      waitMs: RETIRE_WAIT_MS });
    if (!out.retired) {
      // Not decided in time: asking again in a minute may. Anything else (a
      // faulted instance, a refusal) answers the same again: an error for an
      // admin, not a minute's wait.
      if (out.status !== 'pending') throw new Error(`preview of session ${r.id} not retired: ${out.reason || out.status}`);
      throw new PreviewNotRetiredError(r.id, out.reason || out.status);
    }
  }
}

module.exports = { teardownApp, isTearingDown, removeRuntimeIfDeleted, PreviewNotRetiredError };
