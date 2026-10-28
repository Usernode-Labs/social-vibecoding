'use strict';

// `openrouter.provision`, `openrouter.sync`, `openrouter.disable` and
// `openrouter.remove`, platform operations (services/platform-operations.js):
// a company-funded OpenRouter key created, brought in line with its
// account's allowance, disabled or deleted on a conductor, with the
// management key only a conductor needs. A web process asks for these
// through services/openrouter-managed-keys.js, whose own checks (one key per
// account for life, the account's allowance, a needs-review state for an
// unconfirmed provider call) decide what is made.
//
// The account a key is for may ask for its own key and its own sync even
// before it has platform access (a key is part of creating an account,
// #2568); only a full admin syncs another account's key, or disables or
// deletes one.

const keys = require('./openrouter-managed-keys');

const OWN = new Set(['openrouter.provision', 'openrouter.sync']);

function anyAccount(request) {
  return OWN.has(request.op);
}

async function authorize(_deps, request, user) {
  if (request.op === 'openrouter.provision') return null;
  if (request.op === 'openrouter.sync' && Number(request.input?.userId) === user.id) return null;
  if (user.canAdminWrite) return null;
  return { status: 403, error: 'Full admin access required', code: 'not_authorized' };
}

// A provisioning is non-idempotent at the provider, and its own
// reservation refuses a second one (`already_issued`, `byok_configured`).
// `provisioning` is kept before it starts, so a retry whose earlier try
// issued and saved the key but went before recording its result answers
// with that key instead of the refusal the retry would meet.
async function provision({ config, pool }, user, steps) {
  if (steps.has('provisioning')) {
    const issued = await keys.issuedKey(pool, user.id);
    if (issued) return issued;
  }
  await steps.set('provisioning', true);
  return keys.provisionHere({ pool, userId: user.id, config });
}

async function run({ config, pool }, request, user, steps) {
  const input = request.input || {};
  try {
    const value = await steps.once('changed', () => {
      switch (request.op) {
        case 'openrouter.provision': return provision({ pool, config }, user, steps);
        case 'openrouter.disable': return keys.setDisabledHere({ pool, id: input.id, disabled: !!input.disabled, config, actorId: user.id });
        case 'openrouter.remove': return keys.removeHere({ pool, id: input.id, config, actorId: user.id });
        case 'openrouter.sync': return keys.stateForUser(pool, input.userId)
          .then((state) => keys.syncAllowanceHere({ pool, userId: input.userId, state, config }));
        default: throw Object.assign(new Error(`Unknown key operation ${request.op}`), { permanent: true });
      }
    });
    return { value };
  } catch (err) {
    // The service's own refusals (no allowance, already issued, needs review,
    // not configured) are answers: a provider call is never repeated.
    if (err instanceof keys.ManagedOpenRouterError) {
      return { ok: false, status: err.statusCode, code: err.code, error: err.message };
    }
    throw err;
  }
}

module.exports = { authorize, run, anyAccount };
