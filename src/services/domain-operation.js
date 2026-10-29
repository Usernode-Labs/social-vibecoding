'use strict';

// `domain.check` and `domain.teardown`, platform operations
// (services/platform-operations.js): a custom domain's edge (its Ingress and
// certificate Secret, services/kubernetes.js) written on a conductor. The
// domain routes (routes/apps.js, routes/admin.js) check who may act and
// answer their refusals; a web process asks for these
// (services/app-domains.js checkNow, teardownEdge), and the conductor reads
// the domain and the requester's standing again first.

const appDomains = require('./app-domains');
const appAdmins = require('./app-admins');

async function target(pool, request) {
  const row = await appDomains.byId(pool, Number(request.input?.domainId));
  if (!row || row.app_id !== request.appId) return null;
  const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [row.app_id]);
  return app ? { row, app } : null;
}

async function authorize({ pool }, request, user) {
  const t = await target(pool, request);
  if (!t) return { status: 404, error: 'Domain not found' };
  if (request.op === 'domain.teardown' && t.row.hostname !== request.input.hostname) {
    return { status: 409, error: 'The domain changed. Try again.' };
  }
  if (!user.canAdminWrite && !(await appAdmins.canManageApp(pool, t.app, user))) {
    return { status: 403, error: 'Only the project’s creator or an admin can change its domain.' };
  }
  return null;
}

async function run({ config, pool }, request, _user, steps) {
  const t = await target(pool, request);
  if (!t) return { ok: false, status: 404, error: 'Domain not found' };
  if (request.op === 'domain.teardown') {
    await steps.once('edge', () => appDomains.teardownEdge(config, t.row).then(() => true));
    return { domainId: t.row.id };
  }
  // The check reads DNS and the edge, sets the row's status and routes a
  // verified host: one decision, made here.
  const next = await appDomains.checkNow(pool, config, t.row);
  return { domainId: t.row.id, status: next?.status ?? null };
}

module.exports = { authorize, run };
