'use strict';

// `workflow.release`, a platform operation (services/platform-operations.js):
// an admin's release of a faulted workflow instance (Admin → Workflows:
// retry its faulted event, or skip it), made on a conductor. A release
// writes the instance and its held events, which web may not
// (src/db/migrations/0011-workflow-producers.sql). The kernel's release
// reads the admin's authority again in its own transaction
// (src/workflow/event-authority.ts), as it did on web.

const REFUSED = { status: 403, error: 'Current admin access required', code: 'not_authorized' };

async function authorize(_deps, _request, user) {
  return user.canAdminWrite ? null : REFUSED;
}

async function run(_deps, request, user) {
  const { machine, key, mode } = request.input;
  const out = await require('../workflow/platform.ts').releaseFaulted(machine, key, mode, user.id);
  if (out.reason === 'not_authorized') return { ok: false, ...REFUSED };
  return out;
}

module.exports = { authorize, run };
