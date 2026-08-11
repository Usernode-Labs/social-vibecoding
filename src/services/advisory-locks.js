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
 *
 * EXTERNAL_TASK_SUBMIT_LOCK: the CLASSIFIER half of a two-key
 * `pg_advisory_lock(classifier, taskId)`, taken around submit_work's whole
 * load-open-PR-close cycle for one external_agent_task. Unlike the admin
 * lock this one is per-resource by construction — the task id is the second
 * key — because the thing it serializes is genuinely concurrent: since the
 * work order now tells the coding agent to submit for itself, the user's
 * chat assistant and their coding agent can both submit the same task within
 * seconds, and without this they open two pull requests for one piece of
 * work.
 *
 * SESSION-scoped, not transaction-scoped, and that is deliberate: the
 * critical section spans a GitHub round trip, and holding a Postgres
 * transaction open across seconds of network is worse than the race it
 * prevents. services/external-agent-tasks.js takes it on a dedicated client
 * and releases it in a `finally`.
 *
 * PROPOSAL_UPDATE_LOCK: the same two-key shape, keyed on a chat_sessions id
 * rather than a task id, taken around #1056's fetch-verify-push-reconcile
 * cycle for one proposal. A DISTINCT classifier from the task lock on purpose:
 * the second key comes from a different id space, so sharing the classifier
 * would make task 4242 and proposal 4242 serialize against each other for no
 * reason — and, worse, would let a task submission and a proposal update that
 * genuinely must not interleave believe they were already serialized.
 */
const ADMIN_MUTATION_LOCK = 991001;
const EXTERNAL_TASK_SUBMIT_LOCK = 991002;
const PROPOSAL_UPDATE_LOCK = 991003;

module.exports = { ADMIN_MUTATION_LOCK, EXTERNAL_TASK_SUBMIT_LOCK, PROPOSAL_UPDATE_LOCK };
