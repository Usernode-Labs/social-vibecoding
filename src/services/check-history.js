// Durable per-check history — the "earned gating" half of running every
// declared dapp.json check on every build.
//
// The problem it solves: the manifest reader used to keep only the first 12
// declared checks, so this repo's own 229 tail checks had never executed.
// Turning them all on at once with merge-blocking power would have blocked
// the very next proposal on hundreds of failures it did not cause. So a
// check's power is EARNED:
//
//   * observed passing at least once for this app → BLOCKING. A later
//     failure blocks the merge, exactly like the 12 always did.
//   * never observed passing                     → ADVISORY. It runs, its
//     failures show on the card, but they do not block anybody.
//
// Graduation is derived, never stored: a check is blocking iff its row has
// a non-null `first_passed_at`. There is no demotion — a graduated check
// that starts failing STAYS blocking, which is the entire point. The
// promotion path is automatic: fix an advisory check, it passes once, it is
// a permanent guard rail from then on with no manifest edit and no ticket.
//
// Keyed by appManifest.checkKey(name, path) — the same (name+path) pair the
// reader de-duplicates on. Renaming a check mints a new key and drops it
// back to advisory; an edited check re-earns its status.

const appManifest = require('./app-manifest');
const log = require('./logger');

// Rows for checks nobody has declared in this long are pruned on the next
// run that touches the app, so renamed / deleted checks age out instead of
// accumulating forever. Comfortably longer than any plausible gap between
// two builds of a live app.
const PRUNE_AFTER_DAYS = 90;

// Bound the per-run upsert so a pathological manifest can't build an
// unbounded statement. Matches the reader's own ceiling.
const MAX_ROWS_PER_RUN = appManifest.MAX_DECLARED_TESTS;

// Every check this app has ever been seen passing. One query per checks
// run; a few hundred rows is nothing.
async function loadGraduated(pool, appId) {
  const out = new Set();
  if (!pool || !appId) return out;
  try {
    const { rows } = await pool.query(
      `SELECT check_key FROM app_check_history
        WHERE app_id = $1 AND first_passed_at IS NOT NULL`,
      [appId]
    );
    for (const r of rows) out.add(r.check_key);
  } catch (err) {
    // Fail SAFE, not open: an unreadable history means we cannot prove any
    // check has earned gating, so everything is advisory for this run. The
    // alternative (assume everything gates) would block every proposal on
    // a transient DB hiccup.
    log.warn('check-history', 'Graduated-set load failed — treating all checks as advisory', {
      appId, err: err.message,
    });
  }
  return out;
}

// Has this app ever recorded a checks run? Distinguishes "brand new app,
// nothing has run yet" from "app whose checks have all been failing".
async function hasHistory(pool, appId) {
  if (!pool || !appId) return false;
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM app_check_history WHERE app_id = $1 LIMIT 1', [appId]
    );
    return rows.length > 0;
  } catch (err) {
    log.warn('check-history', 'History probe failed', { appId, err: err.message });
    // Claim history exists so the bootstrap can't fire off a bad read and
    // graduate a head that was already graduated.
    return true;
  }
}

// One-time-per-app continuity bootstrap.
//
// Before this change the merge gate was "the first 12 declared checks must
// pass". If the first build after deploy started with an empty history,
// every check would be advisory and a proposal that broke one of those 12
// would sail through — a gating GAP opened by a change whose whole purpose
// is more gating. So an app with no history at all has its first
// LEGACY_GATING_HEAD declared checks pre-marked as graduated: the blocking
// set on build one is exactly the blocking set on build zero.
//
// Idempotent (ON CONFLICT DO NOTHING against the unique key) and only ever
// fires for an app with a genuinely empty history.
async function bootstrapIfEmpty(pool, appId, declaredTests) {
  if (!pool || !appId || !Array.isArray(declaredTests) || !declaredTests.length) return 0;
  if (await hasHistory(pool, appId)) return 0;
  const head = declaredTests.slice(0, appManifest.LEGACY_GATING_HEAD);
  try {
    const values = [];
    const params = [appId];
    for (const t of head) {
      const base = params.length;
      params.push(appManifest.checkKey(t.name, t.path), String(t.name || ''), String(t.path || ''));
      values.push(`($1, $${base + 1}, $${base + 2}, $${base + 3}, NOW(), NOW(), NOW())`);
    }
    if (!values.length) return 0;
    await pool.query(
      `INSERT INTO app_check_history
         (app_id, check_key, check_name, check_path, first_passed_at, last_passed_at, last_seen_at)
       VALUES ${values.join(', ')}
       ON CONFLICT (app_id, check_key) DO NOTHING`,
      params
    );
    log.info('check-history', 'Bootstrapped legacy gating head', { appId, checks: head.length });
    return head.length;
  } catch (err) {
    log.warn('check-history', 'Legacy-head bootstrap failed (non-fatal)', {
      appId, err: err.message,
    });
    return 0;
  }
}

// Record one run's outcomes. `rows` is [{ checkKey, name, path, passed }].
//
// `first_passed_at` is stamped with COALESCE so it only ever records the
// FIRST pass; `last_failed_at` never clears it. That asymmetry is the
// no-demotion rule expressed in SQL.
//
// Called only after storeChecks() reports it actually wrote — a run whose
// snapshot was discarded as stale must not move history either.
async function recordRun(pool, appId, rows) {
  if (!pool || !appId || !Array.isArray(rows) || !rows.length) return 0;
  const capped = rows.slice(0, MAX_ROWS_PER_RUN);
  try {
    const values = [];
    const params = [appId];
    for (const r of capped) {
      if (!r || !r.checkKey) continue;
      const base = params.length;
      params.push(r.checkKey, String(r.name || ''), String(r.path || ''), !!r.passed);
      // EVERY column carries an explicit cast, not just `passed`.
      //
      // A bind parameter inside a sub-SELECT's VALUES list has nothing to
      // infer a type from, so postgres resolves it to `text`. `passed` was
      // already cast because `CASE WHEN v.passed` on a text column throws
      // outright — a loud failure. `app_id` failed the quieter way: the
      // VALUES column came out `text`, the INSERT target is `integer`, and
      // postgres refused the statement with "column app_id is of type
      // integer but expression is of type text". recordRun swallows its
      // errors as non-fatal, so every run logged one warning and wrote
      // nothing — leaving app_check_history empty, which the earned-gating
      // rule reads as "no check has ever passed", i.e. nothing blocking.
      // The check_* columns are varchar; text coerces there, but they are
      // cast too so the next reader doesn't have to work out which of the
      // five were load-bearing.
      values.push(
        `($1::int, $${base + 1}::text, $${base + 2}::text, `
        + `$${base + 3}::text, $${base + 4}::boolean)`
      );
    }
    if (!values.length) return 0;
    await pool.query(
      `INSERT INTO app_check_history AS h
         (app_id, check_key, check_name, check_path,
          first_passed_at, last_passed_at, last_failed_at, last_seen_at,
          pass_count, fail_count)
       SELECT v.app_id, v.check_key, v.check_name, v.check_path,
              CASE WHEN v.passed THEN NOW() ELSE NULL END,
              CASE WHEN v.passed THEN NOW() ELSE NULL END,
              CASE WHEN v.passed THEN NULL ELSE NOW() END,
              NOW(),
              CASE WHEN v.passed THEN 1 ELSE 0 END,
              CASE WHEN v.passed THEN 0 ELSE 1 END
         FROM (VALUES ${values.join(', ')})
              AS v(app_id, check_key, check_name, check_path, passed)
       ON CONFLICT (app_id, check_key) DO UPDATE SET
         check_name = EXCLUDED.check_name,
         check_path = EXCLUDED.check_path,
         -- COALESCE, so the first observed pass is the one that sticks and
         -- a later failure can never un-graduate the check.
         first_passed_at = COALESCE(h.first_passed_at, EXCLUDED.first_passed_at),
         last_passed_at = COALESCE(EXCLUDED.last_passed_at, h.last_passed_at),
         last_failed_at = COALESCE(EXCLUDED.last_failed_at, h.last_failed_at),
         last_seen_at = NOW(),
         pass_count = h.pass_count + EXCLUDED.pass_count,
         fail_count = h.fail_count + EXCLUDED.fail_count`,
      params
    );
    await pool.query(
      `DELETE FROM app_check_history
        WHERE app_id = $1 AND last_seen_at < NOW() - make_interval(days => $2)`,
      [appId, PRUNE_AFTER_DAYS]
    ).catch(() => {});
    return capped.length;
  } catch (err) {
    log.warn('check-history', 'Run record failed (non-fatal)', { appId, err: err.message });
    return 0;
  }
}

module.exports = {
  loadGraduated,
  hasHistory,
  bootstrapIfEmpty,
  recordRun,
  PRUNE_AFTER_DAYS,
  MAX_ROWS_PER_RUN,
};
