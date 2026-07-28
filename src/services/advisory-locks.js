'use strict';

/**
 * Postgres advisory-lock ids shared across route files.
 *
 * These are process-wide magic numbers: two call sites that mean "serialize
 * with each other" MUST pass the same integer, and two that don't must not
 * collide. Keeping them in one module is what makes that checkable — the
 * previous arrangement had ADMIN_MUTATION_LOCK as a private literal in
 * routes/admin.js, so the platform-variable writes that moved out of the
 * admin console onto routes/apps.js would otherwise have had to duplicate
 * the number and hope it stayed in sync.
 *
 * ADMIN_MUTATION_LOCK: taken (as a transaction-scoped lock) by every admin
 * mutation whose correctness depends on a read-modify-write not
 * interleaving with another admin's — promoting/demoting admins, and
 * setting/clearing the platform's own environment variables. Deliberately
 * ONE lock rather than one per resource: admin mutations are rare and
 * serializing all of them costs nothing, while a per-resource scheme is a
 * standing invitation to pick the wrong id.
 */
const ADMIN_MUTATION_LOCK = 991001;

module.exports = { ADMIN_MUTATION_LOCK };
