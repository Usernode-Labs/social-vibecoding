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
// Shared by deployments; exclusive during successful kpack Build pruning.
const BUILD_RETENTION_LOCK = 991004;
// Exclusive across platform Pods; separate domains avoid id-space collisions.
const STAGING_BUILD_LOCK = 991005;
const PRODUCTION_BUILD_LOCK = 991006;
const STAGING_TEMPLATE_LOCK = 991007;
const PREVIEW_LIFECYCLE_LOCK = 991008;
// #1374: the once-a-day "what needs your vote" digest. Exclusive across
// platform Pods, because every instance runs the same interval and a digest
// sent twice is worse than one sent late.
const VOTE_DIGEST_LOCK = 991009;
// The automatic challenge scorer's tick. Exclusive across platform Pods for
// the same reason the digest is: every instance runs the same interval, and
// two of them planning the same credits at once would both read an empty
// ledger before either wrote to it. The unique index on `source_key` would
// still refuse the duplicate row, so this lock is about not doing the work
// (and not spending the grading calls) twice, rather than about correctness.
const CHALLENGE_SCORER_LOCK = 991010;
// #1688: the Friday "this week on <app>" card. Exclusive across platform
// Pods for the digest's reason: every instance runs the interval, and a card
// posted twice into one chat is worse than one posted an hour late.
const WEEKLY_DIGEST_LOCK = 991011;

module.exports = { ADMIN_MUTATION_LOCK, EXTERNAL_TASK_SUBMIT_LOCK, PROPOSAL_UPDATE_LOCK, BUILD_RETENTION_LOCK,
  STAGING_BUILD_LOCK, PRODUCTION_BUILD_LOCK, STAGING_TEMPLATE_LOCK, PREVIEW_LIFECYCLE_LOCK,
  VOTE_DIGEST_LOCK, CHALLENGE_SCORER_LOCK, WEEKLY_DIGEST_LOCK };
