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
//
// AN OPERATION'S LARGE INPUT. A request carries at most 64 KB
// (src/workflow/platform-operation/machine.ts MAX_INPUT_BYTES): what a route
// captured, never a file. What a write needs beyond that (a commit's files,
// a patch) is its `payload`, any JSON value but null, kept in
// platform_operation_inputs under the request's id:
//
//   request({ op, appId, userId, input, requestId?, payload? }, opts)
//       a request a route waits for: the payload is written before the
//       request is appended, so the conductor always finds it, and dropped
//       if the request is refused (it never runs);
//   admit(db, { op, appId, userId, requestId, input, payload? })
//       one nobody waits on: kept in the caller's transaction (`db`), with
//       the request; dropped if `settle()` says it was refused;
//   inputOf(pool, requestId) -> payload | null
//       the op's run reads it on every attempt (never into a step: a step
//       is kept with the work item). Null: it is gone (dropped, or swept);
//       the run answers that rather than retry;
//   dropInput(pool, requestId)
//       the op's run, once no write still needs it (after its last step
//       that does; a retry resumes past those steps and does not read it).
//
// Anything left after two days, the machine's own retention, is swept
// (pruneInputs, the upload-gc clock: services/upload-retention.js). Bytes
// travel base64: JSONB holds no NUL character. The route bounds what it
// accepts, as it always has; this stores what it is given.

const durableSteps = require('./durable-steps');
const { permanent } = require('../workflow/work-errors.ts');

const OPERATIONS = new Map([
  ['manifest.propose', () => require('./manifest-proposal-operation')],
  ['branch.ensure', () => require('./branch-operation')],
  ['revert.open', () => require('./revert-operation')],
  ['domain.check', () => require('./domain-operation')],
  ['domain.teardown', () => require('./domain-operation')],
  ['app.remove', () => require('./app-removal-operation')],
  ['openrouter.provision', () => require('./openrouter-key-operation')],
  ['openrouter.sync', () => require('./openrouter-key-operation')],
  ['openrouter.disable', () => require('./openrouter-key-operation')],
  ['openrouter.remove', () => require('./openrouter-key-operation')],
  ['previewProject.create', () => require('./preview-project-operation')],
  ['previewProject.build', () => require('./preview-project-operation')],
  ['previewProject.deploy', () => require('./preview-project-operation')],
  ['previewProject.restart', () => require('./preview-project-operation')],
  ['previewProject.remove', () => require('./preview-project-operation')],
  // commits
  ['proposal.commit', () => require('./proposal-commit-operation')],
  // git-host flows
  ['suggestBack.open', () => require('./suggest-back-operation')],
  ['upstream.open', () => require('./upstream-operation')],
  ['upstream.skip', () => require('./upstream-operation')],
  ['bench.scaffold', () => require('./bench-reference-operation')],
  ['bench.reference', () => require('./bench-reference-operation')],
  ['demo.propose', () => require('./demo-operation')],
  ['demo.reset', () => require('./demo-operation')],
  // PR metadata
  ['pr.sync', () => require('./pr-sync-operation')],
  // fork flows
  ['fork.update', () => require('./fork-operations')],
  ['work.share', () => require('./fork-operations')],
  ['work.submit', () => require('./fork-operations')],
  ['work.discard', () => require('./fork-operations')],
]);

// The requester as the auth middleware builds `req.user`, read now: an
// account erased or shut out of the platform since asking asks nothing.
// `anyAccount`: an operation an account may ask for on its own behalf before
// it has platform access (its included OpenRouter key, made as it is created).
async function requester(pool, userId, { anyAccount = false } = {}) {
  const { rows: [u] } = await pool.query(
    `SELECT id, username, is_admin, admin_readonly, has_platform_access, private_member_since, anonymised_at
       FROM users WHERE id = $1`, [userId]);
  if (!u || u.anonymised_at) return null;
  const privateMember = !u.has_platform_access && !u.is_admin && u.private_member_since != null;
  if (!anyAccount && !u.has_platform_access && !u.is_admin && !privateMember) return null;
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
  const user = await requester(deps.pool, request.userId, { anyAccount: !!op.anyAccount?.(request) });
  const refused = user ? await op.authorize(deps, request, user, { steps })
    : { status: 403, error: 'You can no longer do this.', code: 'not_authorized' };
  if (refused) {
    if (op.abandon) await op.abandon(deps, request, steps);
    return { ok: false, ...refused };
  }
  const result = await op.run(deps, request, user, steps);
  return result?.ok === false ? result : { ok: true, ...(result || {}) };
}

// ── An operation's large input (above) ──────────────────────────────
const INPUT_RETAIN_DAYS = 2;

function hasPayload(payload) {
  return payload !== undefined && payload !== null;
}

// Written before (request) or with (admit) the request it is for; a second
// write for the same request (a caller asking again under its id) keeps the
// first.
async function keepInput(db, { requestId, op }, payload) {
  await db.query(
    `INSERT INTO platform_operation_inputs (request_id, op, payload) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (request_id) DO NOTHING`,
    [requestId, op, JSON.stringify(payload)]);
}

async function inputOf(pool, requestId) {
  const { rows: [row] } = await pool.query(
    'SELECT payload FROM platform_operation_inputs WHERE request_id = $1', [requestId]);
  return row ? row.payload : null;
}

async function dropInput(pool, requestId) {
  await pool.query('DELETE FROM platform_operation_inputs WHERE request_id = $1', [requestId]);
}

// What no run dropped (one that failed for good, one refused while the web
// side could not drop it) after the machine's own two days.
async function pruneInputs(pool) {
  const { rowCount } = await pool.query(
    'DELETE FROM platform_operation_inputs WHERE created_at < NOW() - make_interval(days => $1)', [INPUT_RETAIN_DAYS]);
  return rowCount || 0;
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

// `requestId` (optional) names the request, so the caller can ask again as
// the same request; `payload` (optional) is its large input (above). With
// neither, a request is what it always was.
async function request(p, opts) {
  const { payload, ...rest } = p;
  return answer(await transport({ appId: null, ...rest, ...(hasPayload(payload) ? { payload } : {}) }, opts));
}

// For an operation nobody waits on, appended in the caller's transaction.
// Answers the request's id.
let appender = (db, p) => require('../workflow/platform.ts').appendOperation(db, p);
function append(db, p) {
  return appender(db, { appId: null, ...p });
}

// For an operation nobody waits on that a conductor must take now: appended
// in the caller's transaction (`db`) under the caller's request id, with its
// `payload` when it has one (above); once that has committed, `settle()`
// says whether a conductor took it: 'accepted', 'refused' (it never runs,
// and its payload is dropped) or 'unknown' (being decided; it may run).
let admitter = {
  keep: (db, request, payload) => keepInput(db, request, payload),
  append: (db, p) => require('../workflow/platform.ts').appendOperationRequest(db, p),
  settle: (eventId, o) => require('../workflow/platform.ts').settleOperation(eventId, o),
  drop: (requestId) => require('../workflow/platform.ts').dropOperationInput(requestId),
};
async function admit(db, p) {
  const { payload, ...rest } = p;
  const req = { appId: null, ...rest };
  const kept = hasPayload(payload);
  if (kept) await admitter.keep(db, req, payload);
  const eventId = await admitter.append(db, req);
  return {
    async settle(opts) {
      const taken = await admitter.settle(eventId, opts);
      // Never instead of the answer: one left behind is swept.
      if (kept && taken.status === 'refused') {
        await admitter.drop(req.requestId).catch((err) => require('./logger').warn('platform-operations',
          'Could not drop a refused request\'s input', { op: req.op, requestId: req.requestId, err: err.message }));
      }
      return taken;
    },
  };
}

module.exports = {
  run, request, append, admit, requester, OPERATIONS,
  keepInput, inputOf, dropInput, pruneInputs, INPUT_RETAIN_DAYS,
  _setTransportForTests(fn) { const prior = transport; transport = fn; return prior; },
  _setAdmitForTests(fn) { const prior = admitter; admitter = fn; return prior; },
  _setAppendForTests(fn) { const prior = appender; appender = fn; return prior; },
  _answerForTests: answer,
};
