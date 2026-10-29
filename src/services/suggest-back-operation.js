'use strict';

// `suggestBack.open`, a platform operation (services/platform-operations.js,
// "git-host flows"): a version's own changes sent to the project it was made
// from, as a proposal there (services/suggest-back.js), made on a conductor.
// POST /api/apps/:slug/suggest-back (routes/suggest-back.js) keeps its doors
// (drain guard, the lookup budget, same origin, membership of the version)
// and the send's own checks (suggest-back.js precheck), answers their
// refusals, and asks for this. The conductor reads them all again before
// anything is built or written: the version still visible to its owner and
// joined, the owner's collab access and membership on the original, the
// promoted-proposal cap, and no other open suggestion (this request's own,
// once it has one, is no other). Then it builds the patch, pushes it into
// the original's repository and opens the proposal there, each write a step
// (suggest-back.js suggest), so a retry pushes nothing twice and opens no
// second pull request.
//
// Input: { picked } (the version is the request's project): whether the
// route was sent `picks`, which are then the request's payload, { picks },
// as they came (without them: all of the version's own changes).

const appAccess = require('./app-access');
const communities = require('./communities');
const suggestBack = require('./suggest-back');

// What a route test hands the send in place of the code host
// (tests/suggest-back.test.js).
let testDeps = null;
const depsOf = () => testDeps || suggestBack.defaultDeps();

async function loadVersion(pool, request) {
  const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [request.appId]);
  return app || null;
}

// The route's doors and checks, read again.
async function authorize({ config, pool }, request, user, { steps = null } = {}) {
  if (steps?.has('result')) return null;
  const fork = await loadVersion(pool, request);
  if (!fork || !(await appAccess.checkAppAccess(pool, fork, user, 'view'))) return { status: 404, body: { error: 'App not found' } };
  const join = await communities.appNeedsJoin(pool, fork.slug, user);
  if (join) return { status: 403, body: join };
  const checked = await suggestBack.precheck({ pool, config, user, fork, deps: depsOf(), own: suggestBack.ownOf(steps) });
  return checked.ok ? null : { status: checked.status, body: checked.body };
}

async function run({ config, pool }, request, user, steps) {
  const operations = require('./platform-operations');
  const fork = await loadVersion(pool, request);
  if (!fork) throw Object.assign(new Error('The version is gone'), { permanent: true });
  // The picks are read only while no step kept them; once one has, the
  // request's payload is not needed again and is dropped.
  const picks = request.input && request.input.picked
    ? async () => {
      const payload = await operations.inputOf(pool, request.requestId);
      if (!payload) throw Object.assign(new Error('The picks of this suggestion are gone; ask again'), { permanent: true });
      return payload.picks;
    }
    : undefined;
  const result = await steps.once('result', () => suggestBack.suggest({ pool, config, user, fork, picks, deps: depsOf(), steps }));
  if (request.input && request.input.picked) await operations.dropInput(pool, request.requestId);
  return result;
}

module.exports = {
  authorize, run,
  _setDepsForTests(deps) { const prior = testDeps; testDeps = deps; return prior; },
};
