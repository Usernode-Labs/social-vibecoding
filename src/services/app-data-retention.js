'use strict';

// What happens to an app's data once the app is deleted, and which apps have
// gone quiet (#5121). docs/app-data-retention.md is the policy; this is
// the part the platform does itself.
//
// Deleted apps. The teardown (services/app-teardown.js) writes one receipt in
// deleted_app_purges as it starts removing anything, then stamps each step as
// it finishes: the runtime, the app's database and owner role, the redacted
// staging template made from it, and its stored files. The steps were
// best-effort and silent before: a drop that failed left a database nobody
// knew about. Now a failed step keeps its message, and the reap sweep
// (server.js, beside the orphan staging-database pass) retries the data steps
// until they hold. The receipt outlives the app's row on purpose: it is the
// list an operator replays after restoring a backup taken before the delete.
//
// Inactive apps. A read-only report: apps nobody has opened, merged into or
// worked on for INACTIVE_AFTER_DAYS. Nothing is stopped or notified from
// here; the policy says what an operator does with the list.

const log = require('./logger');

const STEPS = Object.freeze(['runtime', 'database', 'template', 'files']);
// A step retried this many times is left for an operator (the admin report
// lists it); the sweep stops hammering a database it cannot drop.
const MAX_ATTEMPTS = 20;
const RETRY_AFTER_MS = 60 * 60 * 1000;
const RETRY_BATCH = 10;

const INACTIVE_AFTER_DAYS = 180;
// After the owners are told, how long before the runtime may be stopped.
const STOP_GRACE_DAYS = 30;

function isStagingEnv() {
  return process.env.USERNODE_ENV === 'staging';
}

// The receipt, written once the app is marked as being removed. A teardown
// asked again (the first one died part-way) counts one more attempt on the
// same receipt. Best-effort: a receipt that cannot be written must not keep
// the app from going.
async function recordDeletion(pool, app, { dbName }) {
  try {
    await pool.query(
      `INSERT INTO deleted_app_purges (app_id, slug, db_name, storage_prefix, attempts)
       VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT (app_id) DO UPDATE
         SET attempts = deleted_app_purges.attempts + 1, last_attempt_at = NOW()`,
      [app.id, app.slug, dbName, `app/${app.id}/`]);
  } catch (err) {
    log.warn('app-retention', 'Could not record the deleted app purge receipt', { appId: app.id, err: err.message });
  }
}

// Stamp one step done (err null) or keep why it failed. Never throws.
async function markStep(pool, appId, step, err = null) {
  if (!STEPS.includes(step)) throw new Error(`markStep: unknown step ${JSON.stringify(step)}`);
  const message = err ? String(err.message || err).slice(0, 500) : null;
  try {
    await pool.query(
      `UPDATE deleted_app_purges SET
         runtime_removed_at  = CASE WHEN $2 = 'runtime'  AND $3::text IS NULL THEN COALESCE(runtime_removed_at, NOW())  ELSE runtime_removed_at END,
         database_dropped_at = CASE WHEN $2 = 'database' AND $3::text IS NULL THEN COALESCE(database_dropped_at, NOW()) ELSE database_dropped_at END,
         template_dropped_at = CASE WHEN $2 = 'template' AND $3::text IS NULL THEN COALESCE(template_dropped_at, NOW()) ELSE template_dropped_at END,
         files_removed_at    = CASE WHEN $2 = 'files'    AND $3::text IS NULL THEN COALESCE(files_removed_at, NOW())    ELSE files_removed_at END,
         errors = CASE WHEN $3::text IS NULL THEN errors - $2::text
                       ELSE errors || jsonb_build_object($2::text, $3::text) END
       WHERE app_id = $1`,
      [appId, step, message]);
  } catch (markErr) {
    log.warn('app-retention', 'Could not stamp a purge step', { appId, step, err: markErr.message });
  }
}

// A new app's name meeting a deleted app's unfinished purge (#5121). The
// apps trigger reserve_purged_app_name (schema.sql) raises it, and refuses
// the name, while a receipt for the same database name has its database or
// template step undone.
const NAME_BEING_PURGED = 'UP121';
const NAME_BEING_PURGED_ERROR = 'This name is still being cleaned up; try again later or pick another name';

// Held by an app other than `appId` (the app being torn down still has its
// row while the teardown runs; the sweep's receipts have none). The name is
// built exactly as db-manager.appDbName builds it.
const NAME_HELD_SQL = `SELECT EXISTS (
    SELECT 1 FROM apps a
     WHERE 'app_' || regexp_replace(a.slug, '[^a-z0-9_]', '_', 'g') = $1
       AND a.id <> $2) AS held`;

class NameHeldError extends Error {
  constructor(dbName) {
    super(`database name ${dbName} is held by a live app; left for an operator`);
    this.name = 'NameHeldError';
    this.code = 'name_held';
  }
}

// Run one destructive step on `dbName` with the name locked: the same
// transaction-scoped advisory lock the apps trigger takes before it lets a
// slug through (APP_NAME_PURGE_LOCK), held on its own connection while the
// drop runs (DROP DATABASE cannot run in a transaction, so the drop is on
// the admin connection and only the lock is here). Re-checked under the
// lock, immediately before the step: a name a live app holds is never
// dropped, whatever a read before the lock said. An app created while the
// lock is held waits for it, then sees the receipt still pending (it is
// stamped after the lock is released) and is refused.
async function underNameLock(pool, { dbName, appId }, step) {
  const { APP_NAME_PURGE_LOCK } = require('./advisory-locks');
  const client = await pool.connect();
  let open = false;
  try {
    await client.query('BEGIN');
    open = true;
    await client.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))', [APP_NAME_PURGE_LOCK, dbName]);
    const { rows: [r] } = await client.query(NAME_HELD_SQL, [dbName, appId]);
    if (r?.held) throw new NameHeldError(dbName);
    await step();
    await client.query('COMMIT');
    open = false;
  } finally {
    if (open) await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

// The three data steps, each recorded. Never throws: the teardown goes on to
// delete the row whatever happened here, and the sweep comes back for a step
// that failed. `skip` names steps already done (a retry). The two steps that
// drop by NAME run under the name lock; files are keyed by the app id, which
// is never reused.
async function purgeData(pool, config, { appId, dbName }, { skip = [] } = {}) {
  const dbManager = require('./db-manager');
  const result = {};

  if (!skip.includes('database')) {
    try {
      // strict: a failed drop is reported, not swallowed, so it is recorded.
      await underNameLock(pool, { dbName, appId }, () => dbManager.dropDatabase(dbName, { strict: true }));
      result.database = true;
      await markStep(pool, appId, 'database');
    } catch (err) {
      result.database = false;
      log.warn('app-retention', 'Dropping a deleted app\'s database failed', { appId, dbName, err: err.message });
      await markStep(pool, appId, 'database', err);
    }
  }

  // The redacted template made from the database. After the database, so a
  // refresh that slipped in cannot rebuild it from a source still there.
  if (!skip.includes('template')) {
    try {
      await underNameLock(pool, { dbName, appId }, () => dbManager.dropStagingTemplates(dbName));
      result.template = true;
      await markStep(pool, appId, 'template');
    } catch (err) {
      result.template = false;
      log.warn('app-retention', 'Dropping a deleted app\'s staging template failed', { appId, dbName, err: err.message });
      await markStep(pool, appId, 'template', err);
    }
  }

  // Stored files (#752), BEFORE the row delete cascades away app_files.
  if (!skip.includes('files')) {
    try {
      // No object store configured: uploads answer storage_unavailable, so
      // there is nothing stored to remove.
      const store = require('./app-files').getStore(config);
      const removed = store ? await store.removeAppPrefix(appId) : 0;
      if (removed) log.info('apps', 'Removed app files from object store', { appId, count: removed });
      result.files = true;
      await markStep(pool, appId, 'files');
    } catch (err) {
      result.files = false;
      log.warn('apps', 'Object-store cleanup failed on app delete (orphans remain under app/<id>/)', {
        appId, err: err.message,
      });
      await markStep(pool, appId, 'files', err);
    }
  }
  return result;
}

// Receipts with a data step still undone, oldest attempt first.
async function pendingPurges(pool, { limit = RETRY_BATCH, retryAfterMs = RETRY_AFTER_MS } = {}) {
  const { rows } = await pool.query(
    `SELECT p.app_id, p.slug, p.db_name, p.database_dropped_at, p.template_dropped_at, p.files_removed_at,
            p.attempts,
            EXISTS (SELECT 1 FROM apps a
                     WHERE 'app_' || regexp_replace(a.slug, '[^a-z0-9_]', '_', 'g') = p.db_name) AS name_in_use
       FROM deleted_app_purges p
      WHERE (p.database_dropped_at IS NULL OR p.template_dropped_at IS NULL OR p.files_removed_at IS NULL)
        AND p.attempts < $1
        AND p.last_attempt_at < NOW() - make_interval(secs => $2::double precision / 1000)
      ORDER BY p.last_attempt_at
      LIMIT $3`,
    [MAX_ATTEMPTS, retryAfterMs, limit]);
  return rows;
}

// The sweep's pass: retry what a teardown could not finish. A receipt whose
// database name a live app now holds (the slug was taken again) retries its
// files only: dropping that database would drop the new app's. Never throws.
async function retryPendingPurges(pool, config, opts = {}) {
  const summary = { examined: 0, retried: 0, completed: 0, skippedNameInUse: 0 };
  if (isStagingEnv()) return summary;
  let rows;
  try {
    rows = await pendingPurges(pool, opts);
  } catch (err) {
    log.warn('app-retention', 'Could not read pending app purges', { err: err.message });
    return summary;
  }
  summary.examined = rows.length;
  for (const row of rows) {
    const skip = [];
    if (row.database_dropped_at) skip.push('database');
    if (row.template_dropped_at) skip.push('template');
    if (row.files_removed_at) skip.push('files');
    // A first look, to skip the lock for a name plainly taken. Not the
    // guard: purgeData re-checks under the name lock before each drop.
    if (row.name_in_use) {
      summary.skippedNameInUse++;
      for (const step of ['database', 'template']) {
        if (!skip.includes(step)) {
          skip.push(step);
          await markStep(pool, row.app_id, step, new NameHeldError(row.db_name));
        }
      }
    }
    try {
      await pool.query(
        'UPDATE deleted_app_purges SET attempts = attempts + 1, last_attempt_at = NOW() WHERE app_id = $1',
        [row.app_id]);
    } catch (err) {
      log.warn('app-retention', 'Could not count a purge retry', { appId: row.app_id, err: err.message });
      continue;
    }
    summary.retried++;
    const out = await purgeData(pool, config, { appId: row.app_id, dbName: row.db_name }, { skip });
    if (Object.values(out).every(Boolean) && !row.name_in_use) summary.completed++;
    else if (!row.name_in_use && (out.database === false || out.template === false)) {
      // Taken between the first look and the lock: counted with the others.
      const { rows: [r] } = await pool.query(NAME_HELD_SQL, [row.db_name, row.app_id]).catch(() => ({ rows: [] }));
      if (r?.held) summary.skippedNameInUse++;
    }
  }
  if (summary.examined) log.info('app-retention', 'Deleted app purge retries', summary);
  return summary;
}

// ── Admin report (read-only) ─────────────────────────────────────────────

const INACTIVE_APPS_SQL = `
  WITH opened AS (
    SELECT app_id, MAX(date)::timestamptz AS last_opened_at
      FROM app_activity GROUP BY app_id
  ),
  work AS (
    SELECT app_id,
           MAX(merged_at) AS last_merged_at,
           MAX(last_activity_at) AS last_worked_at
      FROM chat_sessions GROUP BY app_id
  ),
  apps_seen AS (
    SELECT a.id, a.slug, a.name, a.status, a.created_at, a.last_deploy_at,
           o.last_opened_at, w.last_merged_at, w.last_worked_at,
           GREATEST(a.created_at, a.last_deploy_at, o.last_opened_at, w.last_merged_at, w.last_worked_at) AS last_active_at
      FROM apps a
      LEFT JOIN opened o ON o.app_id = a.id
      LEFT JOIN work w ON w.app_id = a.id
     WHERE NOT a.self_hosted AND a.teardown_started_at IS NULL
  )
  SELECT id, slug, name, status, created_at, last_deploy_at, last_opened_at, last_merged_at, last_worked_at,
         last_active_at,
         FLOOR(EXTRACT(EPOCH FROM (NOW() - last_active_at)) / 86400)::int AS idle_days
    FROM apps_seen
   WHERE last_active_at < NOW() - make_interval(days => $1::int)
   ORDER BY last_active_at ASC, id ASC
   LIMIT 500
`;

const PURGES_SQL = `
  SELECT app_id, slug, db_name, storage_prefix, deleted_at, runtime_removed_at, database_dropped_at,
         template_dropped_at, files_removed_at, errors, attempts, last_attempt_at
    FROM deleted_app_purges
   ORDER BY deleted_at DESC, app_id DESC
   LIMIT 500
`;

// What an operator does next with an app idle this long (the policy).
function inactiveStage(idleDays, { inactiveAfterDays = INACTIVE_AFTER_DAYS, graceDays = STOP_GRACE_DAYS } = {}) {
  if (idleDays >= inactiveAfterDays + graceDays) return 'stop_eligible';
  if (idleDays >= inactiveAfterDays) return 'notify_owners';
  return 'active';
}

function purgeState(row) {
  const done = !!(row.database_dropped_at && row.template_dropped_at && row.files_removed_at);
  if (done) return 'purged';
  return row.attempts >= MAX_ATTEMPTS ? 'needs_operator' : 'pending';
}

async function adminReport(pool, { days } = {}) {
  const n = Number.parseInt(days, 10);
  const inactiveAfterDays = Number.isInteger(n) && n >= 30 && n <= 3650 ? n : INACTIVE_AFTER_DAYS;
  const [inactive, purges] = await Promise.all([
    pool.query(INACTIVE_APPS_SQL, [inactiveAfterDays]),
    pool.query(PURGES_SQL),
  ]);
  return {
    policy: {
      inactiveAfterDays,
      stopGraceDays: STOP_GRACE_DAYS,
      purgeMaxAttempts: MAX_ATTEMPTS,
    },
    inactiveApps: inactive.rows.map((r) => ({
      ...r, stage: inactiveStage(r.idle_days, { inactiveAfterDays }),
    })),
    deletedApps: purges.rows.map((r) => ({ ...r, state: purgeState(r) })),
  };
}

module.exports = {
  STEPS,
  MAX_ATTEMPTS,
  NAME_BEING_PURGED,
  NAME_BEING_PURGED_ERROR,
  NameHeldError,
  INACTIVE_AFTER_DAYS,
  STOP_GRACE_DAYS,
  recordDeletion,
  markStep,
  purgeData,
  pendingPurges,
  retryPendingPurges,
  inactiveStage,
  purgeState,
  adminReport,
};
