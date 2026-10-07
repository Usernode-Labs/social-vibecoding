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
// rather than a half-deleted app. The row delete is the one step that throws.

const log = require('./logger');
const appAccess = require('./app-access');

async function teardownApp(pool, config, app) {
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

  // With WF_PREVIEWS_ENABLED on, the previews the preview machine holds for
  // this app are retired by it, by identity. Its work needs only the names
  // it recorded, so the rows can go below.
  try {
    const previewWorkflow = require('./preview-workflow');
    if (previewWorkflow.enabled()) {
      const { rows } = await pool.query(
        `SELECT cs.id FROM chat_sessions cs JOIN wf_instances w ON w.machine = 'preview' AND w.key = 'session:' || cs.id
          WHERE cs.app_id = $1 AND w.state NOT IN ('retired', 'detached', '(none)')`, [app.id]);
      for (const r of rows) await previewWorkflow.retire({ session: { id: r.id, app_id: app.id }, reason: 'app_deleted', terminal: true });
    }
  } catch (err) {
    log.warn('apps', 'Could not hand the app\'s previews to the preview machine', { appId: app.id, err: err.message });
  }

  // Delete from DB (cascades to chat_messages, sessions, etc.)
  await pool.query('DELETE FROM apps WHERE id = $1', [app.id]);
  appAccess.invalidateVisibility(app.id, app.slug);
}

module.exports = { teardownApp };
