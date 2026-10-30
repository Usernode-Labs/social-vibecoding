'use strict';

// The platform's read-only database roles: the prod-debug role
// (services/debug-access.js) and the topochain SQL console's
// (services/topochain/db-console-role.js). Set up once per release by the
// migration step, right after the schema: the Kubernetes migration Job
// (scripts/migrate-kubernetes.js), or a compose boot's own migration under
// the migration lock (server.js start). So the new build's deny lists are
// applied to the new schema before any process of the release serves, and
// by one runner: an older build still up during a rollout never grants
// this release's new tables, and two bootstraps never race the same catalog
// rows (#891). What a role's setup made is recorded in platform_db_roles,
// which every process reads (a role's password rotated by the next release
// is read again on Postgres's refusal).
//
// A staging preview sets up neither (config.runsClusterMaintenance): its
// rows are a copy of production's. A capability's own setup failure leaves
// it unavailable. In split mode an invalid/unavailable provisioner login
// fails the migration instead of booting with the wrong database authority.

const { runsClusterMaintenance } = require('../config');
const log = require('./logger');

async function ensureRoles(config) {
  if (!runsClusterMaintenance()) return { skipped: 'staging' };
  // Role DDL uses the provisioner; table/column grants use the migrator.
  // A single administrative connection stays inside the migration budget.
  await require('./database-role-grants').withRoleAdmin(async (admin) => {
    await require('./debug-access').ensureRole(config, { admin }).catch((err) => {
      log.warn('db-roles', 'prod-debug role bootstrap failed (capability disabled)', { err: err.message });
    });
    await require('./topochain/db-console-role').ensureConsoleRole(config, { admin }).catch((err) => {
      log.warn('db-roles', 'topochain SQL console role bootstrap failed (capability disabled)', { err: err.message });
    });
  });
  return { ok: true };
}

module.exports = { ensureRoles };
