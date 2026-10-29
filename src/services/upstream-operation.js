'use strict';

// `upstream.open` and `upstream.skip`, platform operations
// (services/platform-operations.js, "git-host flows"): a member's press on a
// version's update from its original, run on a conductor.
// POST /api/apps/:slug/upstream/open and /skip (routes/upstream.js) keep
// their doors (drain guard, the lookup budget, same origin, membership of
// the version) and their view check, and ask for this; the conductor reads
// the requester's standing on the version again, then runs the same
// services/upstream-offers.js openUpdate the clock's job runs (and
// skipUpdate), which check the versions setting and the git host
// themselves, before anything is pushed. Their refusals are the routes'
// answers, as they always were. Each write is a step
// (upstream-offers.js openUpdate, skipUpdate), so a retry pushes nothing
// twice.
//
// Input: {} (the version is the request's project).

const appAccess = require('./app-access');
const communities = require('./communities');
const offers = require('./upstream-offers');

// What a route test hands openUpdate and skipUpdate in place of the real
// code host and machines (tests/upstream-offers.test.js).
let testDeps = null;

async function authorize({ pool }, request, user) {
  const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [request.appId]);
  if (!app || !(await appAccess.checkAppAccess(pool, app, user, 'view'))) return { status: 404, body: { error: 'App not found' } };
  const join = await communities.appNeedsJoin(pool, app.slug, user);
  if (join) return { status: 403, body: join };
  return null;
}

async function run({ config, pool }, request, user, steps) {
  const deps = testDeps || undefined;
  const versionId = request.appId;
  if (request.op === 'upstream.open') return offers.openUpdate({ config, pool, versionId, deps, steps });
  if (request.op === 'upstream.skip') {
    return offers.skipUpdate({ config, pool, versionId, user: { id: user.id, username: user.username }, deps, steps });
  }
  throw Object.assign(new Error(`Unknown upstream operation ${request.op}`), { permanent: true });
}

module.exports = {
  authorize, run,
  _setDepsForTests(deps) { const prior = testDeps; testDeps = deps; return prior; },
};
