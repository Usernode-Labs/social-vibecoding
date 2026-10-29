'use strict';

// `bench.scaffold` and `bench.reference`, platform operations
// (services/platform-operations.js, "git-host flows"): the App bench
// studio's writes to its host app's repository for reference builds
// (services/bench/studio.js), made on a conductor.
//
//   bench.scaffold   a brief's first commit, for a reference order that
//                    found none: GET /api/bot-studio/runs/:id/reference-order
//                    (routes/bench-studio.js, the connector's
//                    get_bench_reference_order) answers "come back shortly"
//                    as it always did and asks for this, nobody waiting
//                    (studio.askScaffold). The conductor makes it as the
//                    run's first trial would (studio.makeScaffold), claimed
//                    as this request's own so a retry takes its own claim
//                    over at once, and never waits for another's.
//   bench.reference  a reference build handed in:
//                    POST /api/bot-studio/runs/:id/references answers its own
//                    checks (studio.referencePrecheck) and asks; the
//                    conductor checks them again and writes the trial, the
//                    patch's push or the branch's copy and the trial's
//                    branch, each a step (studio.handInReference).
//
// Both are a full admin's, as their doors are (requireAdminWrite): read
// again on every attempt. Input: { runId, taskId, packId }. A hand-in's
// label, patch, repository and branch are its payload ({ label, patchB64?,
// repo?, branch? }), dropped once its run has answered.

const studio = require('./bench/studio');
const flows = require('./git-host-flows');

const ADMIN_WRITE = { status: 403, error: 'Full admin access required' };

// What a test hands the studio in place of the code host and the model
// (tests/bench-studio-postgres.test.js).
let testDeps = null;
const depsOf = () => testDeps || {};

const target = (request) => ({
  runId: Number(request.input.runId), taskId: Number(request.input.taskId), packId: Number(request.input.packId) || 0,
});

async function handIn(pool, request) {
  const payload = await require('./platform-operations').inputOf(pool, request.requestId);
  if (!payload) return null;
  return { label: payload.label, patch: flows.patchOf(payload), repo: payload.repo ?? null, branch: payload.branch ?? null };
}

async function authorize({ config, pool }, request, user, { steps = null } = {}) {
  if (!user.canAdminWrite) return ADMIN_WRITE;
  if (steps?.has('result')) return null;
  if (request.op === 'bench.scaffold') {
    const t = await studio.scaffoldTarget(pool, target(request));
    return t.ok ? null : t;
  }
  if (request.op === 'bench.reference') {
    const given = await handIn(pool, request);
    if (!given) return { status: 409, error: 'This hand-in has expired. Hand it in again.', code: 'expired' };
    const checked = await studio.referencePrecheck(pool, config, {
      ...target(request), label: given.label, patch: given.patch, branch: given.branch, deps: depsOf(), kick: false,
    });
    return checked.ok ? null : checked;
  }
  throw Object.assign(new Error(`Unknown bench operation ${request.op}`), { permanent: true });
}

async function run({ config, pool }, request, user, steps) {
  if (request.op === 'bench.scaffold') {
    const made = await steps.once('scaffold', () => studio.makeScaffold(pool, config, {
      ...target(request), deps: depsOf(), claimant: `op:${request.requestId}`, waitMs: 0,
    }));
    return made && made.ok ? { made: true, sha: made.sha, branch: made.branch } : { made: false, error: (made && made.error) || null };
  }
  const operations = require('./platform-operations');
  const out = await steps.once('result', async () => {
    const given = await handIn(pool, request);
    if (!given) return { ok: false, status: 409, error: 'This hand-in has expired. Hand it in again.', code: 'expired' };
    const checked = await studio.referencePrecheck(pool, config, {
      ...target(request), label: given.label, patch: given.patch, branch: given.branch, deps: depsOf(), kick: false,
    });
    return checked.ok ? await studio.handInReference(pool, config, {
      runId: target(request).runId, taskId: target(request).taskId, order: checked.order, label: checked.label,
      patch: given.patch, repo: given.repo, branch: given.branch, user: { id: user.id, username: user.username }, deps: depsOf(), steps,
    }) : checked;
  });
  // Answered: nothing reads the hand-in again (a throw is tried again, and
  // keeps it).
  await operations.dropInput(pool, request.requestId);
  return out;
}

module.exports = {
  authorize, run,
  _setDepsForTests(deps) { const prior = testDeps; testDeps = deps; return prior; },
};
