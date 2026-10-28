'use strict';

// `app.remove`, a platform operation (services/platform-operations.js): an
// app's teardown (services/app-teardown.js removeApp: its previews, runtime,
// custom domain edge, database and stored files, then its row) run on a
// conductor, where the runtime and database administration credentials are
// used. DELETE /api/apps/:slug and a test account's retirement keep their
// gates and confirmations and ask for this; the conductor reads the app and
// the requester's standing again first.

const contributors = require('./contributors');

async function loadApp(pool, request) {
  const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [request.appId]);
  return app || null;
}

async function authorize({ config, pool }, request, user) {
  const app = await loadApp(pool, request);
  // Already gone: the run finds nothing left to do.
  if (!app) return null;
  const { deleteBlockReason } = require('../routes/apps');
  const counts = await contributors.loadContributorCounts(pool, [app.id]);
  const blocked = deleteBlockReason(app, user, counts.get(app.id) || 0, config.selfAppSlug);
  if (blocked) return { status: 403, error: 'You can no longer delete this app.', reason: blocked };
  return null;
}

async function run({ config, pool }, request, _user, steps) {
  const app = await loadApp(pool, request);
  const teardown = require('./app-teardown');
  try {
    if (app) await steps.once('removed', () => teardown.removeApp(pool, config, app).then(() => true));
  } catch (err) {
    // Nothing was removed yet: answered, and a delete asked again finishes it.
    if (err instanceof teardown.PreviewNotRetiredError) {
      return { ok: false, status: 409, error: err.message, reason: err.code, sessionId: err.sessionId };
    }
    throw err;
  }
  return { removed: true };
}

module.exports = { authorize, run };
