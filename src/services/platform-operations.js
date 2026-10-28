'use strict';

// The typed operations of the platform-operation machine
// (src/workflow/platform-operation/, docs/plans/web-and-conductor.md,
// "Privileged operations"): code-host and provider writes a web process
// asks a conductor to make. Each operation module exports
//
//   authorize(deps, request, user, { steps }) -> null | { status, error, ...extra }
//       the requester's current authority and the target, read again on the
//       conductor on every attempt, before any write it still has to make
//       (the route checked them when it took the request, and still answers
//       its own refusals). `steps` holds this request's own progress, so a
//       check it would trip itself (its own proposal, its own claim) tells
//       it from a competing one;
//   abandon(deps, request, steps) (optional)
//       what a request refused part way must give back (a claim), whatever
//       refused it;
//   run(deps, request, user, steps) -> result
//       the writes, each kept as a step (services/durable-steps.js), so a
//       retry or a restart carries on from the last one.
//
// A refusal is an answer ({ ok: false, status, error }), never a retry. The
// route side, `request`, appends the operation, waits for its answer and
// returns it in the shape a route answers with.

const durableSteps = require('./durable-steps');
const { permanent } = require('../workflow/work-errors.ts');

const OPERATIONS = new Map([
  ['manifest.propose', () => require('./manifest-proposal-operation')],
  ['branch.ensure', () => require('./branch-operation')],
  ['revert.open', () => require('./revert-operation')],
]);

// The requester as the auth middleware builds `req.user`, read now: an
// account erased or shut out of the platform since asking asks nothing.
async function requester(pool, userId) {
  const { rows: [u] } = await pool.query(
    `SELECT id, username, is_admin, admin_readonly, has_platform_access, private_member_since, anonymised_at
       FROM users WHERE id = $1`, [userId]);
  if (!u || u.anonymised_at) return null;
  const privateMember = !u.has_platform_access && !u.is_admin && u.private_member_since != null;
  if (!u.has_platform_access && !u.is_admin && !privateMember) return null;
  return {
    id: u.id, username: u.username, isAdmin: !!u.is_admin, adminReadonly: !!u.admin_readonly,
    canAdminWrite: !!u.is_admin && !u.admin_readonly, hasPlatformAccess: !!u.has_platform_access, privateMember,
  };
}

// On a conductor (the machine's work). `deps` is { config, pool }.
async function run(deps, request, steps = durableSteps.none()) {
  const load = OPERATIONS.get(request?.op);
  if (!load) throw permanent(`Unknown platform operation ${request?.op}`);
  const op = load();
  // The requester and their authority are read again on every attempt: one
  // shut out or revoked since an earlier attempt stops what is left, and
  // gives back what it holds.
  const user = await requester(deps.pool, request.userId);
  const refused = user ? await op.authorize(deps, request, user, { steps })
    : { status: 403, error: 'You can no longer do this.', code: 'not_authorized' };
  if (refused) {
    if (op.abandon) await op.abandon(deps, request, steps);
    return { ok: false, ...refused };
  }
  const result = await op.run(deps, request, user, steps);
  return result?.ok === false ? result : { ok: true, ...(result || {}) };
}

// The route's side: the operation's answer, or why there is none yet.
let transport = (p, o) => require('../workflow/platform.ts').runOperation(p, o);

function answer(outcome) {
  switch (outcome.status) {
    case 'done': return outcome.result && typeof outcome.result === 'object'
      ? { ...outcome.result, requestId: outcome.requestId } : { ok: true, requestId: outcome.requestId };
    // Not an answer: never a success to the route's caller, which would show
    // a proposal or a removal that has not happened yet. The work still
    // finishes, so the caller is told not to ask again at once.
    case 'pending': return { ok: false, pending: true, status: 503, code: 'operation_pending', requestId: outcome.requestId,
      error: 'This is taking longer than usual and will finish on its own. Check again in a minute before trying again.' };
    case 'refused': return outcome.reason === 'not_authorized'
      ? { ok: false, status: 403, error: 'You can no longer do this.', code: 'not_authorized' }
      : outcome.reason === 'not_found' ? { ok: false, status: 404, error: 'Not found' }
        : { ok: false, status: 503, error: 'The platform could not take this right now. Try again in a moment.', code: 'operation_unavailable' };
    default: return { ok: false, status: 500, error: outcome.error?.message || 'Internal server error' };
  }
}

async function request(p, opts) {
  return answer(await transport({ appId: null, ...p }, opts));
}

// For an operation nobody waits on, appended in the caller's transaction.
function append(db, p) {
  return require('../workflow/platform.ts').appendOperation(db, { appId: null, ...p });
}

module.exports = {
  run, request, append, requester, OPERATIONS,
  _setTransportForTests(fn) { const prior = transport; transport = fn; return prior; },
  _answerForTests: answer,
};
