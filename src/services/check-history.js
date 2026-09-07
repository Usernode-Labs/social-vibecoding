// Durable per-check history — the "earned gating" half of running every
// declared dapp.json check on every build.
//
// The problem it solves: the manifest reader used to keep only the first 12
// declared checks, so this repo's own 229 tail checks had never executed.
// Turning them all on at once with merge-blocking power would have blocked
// the very next proposal on hundreds of failures it did not cause. So a
// check's power is EARNED:
//
//   * observed passing GRADUATION_PASSES times in a row → BLOCKING. A later
//     failure blocks the merge, exactly like the 12 always did.
//   * anything less                                      → ADVISORY. It
//     runs, its failures show on the card, but they do not block anybody.
//
// The bar used to be ONE pass, and that was the hole: a check that is flaky
// from birth graduated on its first lucky run and blocked every proposal
// afterwards, permanently, because there is no demotion. Ten consecutive
// passes is not proof a check is deterministic — ten clean observations put
// the 95% upper bound on its failure rate at roughly 3/10, not at zero —
// but it is a bar a 1-in-20 flake clears about 60% of the time per window
// rather than 95%, and the ten come from ten different builds on different
// hosts with different caches, which is where the decorrelation is.
//
// There is still no demotion — a graduated check that starts failing STAYS
// blocking, which is the entire point. What a graduated check that has
// started failing intermittently now gets is VISIBILITY: `flakeRate` below
// carries its lifetime fail ratio onto the proposal's checks row.
//
// The promotion path stays automatic: fix an advisory check, let it pass
// ten runs running, and it is a permanent guard rail with no manifest edit
// and no ticket.
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

// Consecutive observed passes a check needs before its failures block a
// merge. Also the value the schema backfills onto every row that was
// already graduated under the old one-pass rule, so raising the bar demotes
// nothing that is gating today.
const GRADUATION_PASSES = 10;

// How many times a check is run on its FIRST appearance, before it has any
// history at all. Five solo cold loads catch the grossly flaky and the
// outright wrong on day one — a check failing 1 run in 5 is caught 67% of
// the time — and they preload the evidence the flake rate is computed from.
//
// They count toward GRADUATION_PASSES, which is the deliberate part and the
// arguable one: five observations from ONE build share a host, an image and
// a database clone, so they are not five independent draws and the run of
// ten they contribute to is weaker than ten across ten builds. The flake
// chip exists because of exactly that gap. What they are not is five
// assertions against one page load — see `solo` in capture/capture.js.
const NEW_CHECK_RUNS = 5;

// Ceiling on the extra loads one run will pay for. A proposal that declares
// twenty new checks at once would otherwise add a hundred navigations to
// its own gate.
const MAX_NEW_CHECK_REPEATS = 40;

// Every check this app has ever been seen passing. One query per checks
// run; a few hundred rows is nothing.
async function loadGraduated(pool, appId) {
  const out = new Set();
  if (!pool || !appId) return out;
  try {
    const { rows } = await pool.query(
      `SELECT check_key FROM app_check_history
        WHERE app_id = $1 AND COALESCE(consecutive_passes, 0) >= $2`,
      [appId, GRADUATION_PASSES]
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
      // At the threshold, not at one: this row exists to REPRODUCE the
      // gating set of build zero, so it has to be blocking immediately.
      values.push(`($1, $${base + 1}, $${base + 2}, $${base + 3}, NOW(), NOW(), NOW(), ${GRADUATION_PASSES})`);
    }
    if (!values.length) return 0;
    await pool.query(
      `INSERT INTO app_check_history
         (app_id, check_key, check_name, check_path,
          first_passed_at, last_passed_at, last_seen_at, consecutive_passes)
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
      // Counts, not a boolean: a check on its first appearance runs
      // NEW_CHECK_RUNS times and lands here as one row carrying all of
      // them. A single observation is just passes=1 or fails=1, which is
      // what every caller but that one sends.
      const passes = Number.isInteger(r.passes) ? r.passes : (r.passed ? 1 : 0);
      const fails = Number.isInteger(r.fails) ? r.fails : (r.passed ? 0 : 1);
      if (passes <= 0 && fails <= 0) continue;
      params.push(r.checkKey, String(r.name || ''), String(r.path || ''), passes, fails);
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
        + `$${base + 3}::text, $${base + 4}::int, $${base + 5}::int)`
      );
    }
    if (!values.length) return 0;
    await pool.query(
      `INSERT INTO app_check_history AS h
         (app_id, check_key, check_name, check_path,
          first_passed_at, last_passed_at, last_failed_at, last_seen_at,
          pass_count, fail_count, consecutive_passes)
       SELECT v.app_id, v.check_key, v.check_name, v.check_path,
              CASE WHEN v.passes > 0 THEN NOW() ELSE NULL END,
              CASE WHEN v.passes > 0 THEN NOW() ELSE NULL END,
              CASE WHEN v.fails > 0 THEN NOW() ELSE NULL END,
              NOW(),
              v.passes,
              v.fails,
              -- One failure anywhere in the run ends the streak, however
              -- many passes came with it.
              CASE WHEN v.fails > 0 THEN 0 ELSE v.passes END
         FROM (VALUES ${values.join(', ')})
              AS v(app_id, check_key, check_name, check_path, passes, fails)
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
         fail_count = h.fail_count + EXCLUDED.fail_count,
         -- The one counter that goes DOWN. EXCLUDED's value is 1 on a pass
         -- and 0 on a failure, so this reads as "extend the run, or start
         -- it again from nothing". It is the only reason a check that
         -- passes nine times and fails once does not gate.
         consecutive_passes = CASE WHEN EXCLUDED.consecutive_passes > 0
           THEN COALESCE(h.consecutive_passes, 0) + EXCLUDED.consecutive_passes
           ELSE 0 END`,
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

// Every check this app has any record of, graduated or not. What it is for
// is the opposite of loadGraduated: a check ABSENT from this set has never
// run here, so this run is its first and it earns the repeat treatment.
async function loadSeen(pool, appId) {
  const out = new Set();
  if (!pool || !appId) return out;
  try {
    const { rows } = await pool.query(
      'SELECT check_key FROM app_check_history WHERE app_id = $1', [appId]
    );
    for (const r of rows) out.add(r.check_key);
  } catch (err) {
    // Fail toward NO repeats: an unreadable history must not turn every
    // check in the suite into five.
    log.warn('check-history', 'Seen-set load failed — no first-run repeats this run', {
      appId, err: err.message,
    });
    return null;
  }
  return out;
}

// Lifetime flake rate per check, for the proposal's checks row.
//
// A graduated check that has started failing intermittently keeps blocking
// — that is the no-demotion rule and it is deliberate — but until now it
// did so silently, and the four checks that reddened this app's own merges
// were exactly that. `fail_count / (pass_count + fail_count)` over the
// row's whole life is the cheapest honest signal: it is already stored, it
// needs no extra runs, and a check that alternates shows up immediately.
//
// Returns a Map of check_key -> { passes, fails, rate }. `rate` is null
// below MIN_OBSERVATIONS, because two runs cannot tell 50% from bad luck.
const MIN_OBSERVATIONS = 5;

async function loadFlakeRates(pool, appId) {
  const out = new Map();
  if (!pool || !appId) return out;
  try {
    const { rows } = await pool.query(
      `SELECT check_key, pass_count, fail_count FROM app_check_history
        WHERE app_id = $1 AND fail_count > 0`,
      [appId]
    );
    for (const r of rows) {
      const passes = parseInt(r.pass_count, 10) || 0;
      const fails = parseInt(r.fail_count, 10) || 0;
      const seen = passes + fails;
      out.set(r.check_key, {
        passes, fails, rate: seen >= MIN_OBSERVATIONS ? fails / seen : null,
      });
    }
  } catch (err) {
    // Cosmetic data: a failed read costs a chip, never a verdict.
    log.warn('check-history', 'Flake-rate load failed (non-fatal)', { appId, err: err.message });
  }
  return out;
}

module.exports = {
  loadGraduated,
  loadSeen,
  loadFlakeRates,
  GRADUATION_PASSES,
  NEW_CHECK_RUNS,
  MAX_NEW_CHECK_REPEATS,
  MIN_OBSERVATIONS,
  hasHistory,
  bootstrapIfEmpty,
  recordRun,
  PRUNE_AFTER_DAYS,
  MAX_ROWS_PER_RUN,
};
