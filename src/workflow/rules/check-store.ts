// What a proposal's required checks leave on its row, and the app's check
// history: the statements every checks run ends with. One copy. The preview
// machine runs them inside its transitions (src/workflow/preview/); the
// code not migrated yet imports them back under their old names
// (services/visuals.js, services/check-history.js), where they keep their
// never-throw wrappers and their logging.
//
// Each verdict write is fenced on the commit it describes: a verdict about
// a head the row has since left is discarded (it reports false).

import type { Queryable } from './db.ts';

export interface CheckResult {
  state: 'passing' | 'failing' | 'skipped' | 'error' | string;
  results?: unknown[];
  platformFault?: boolean;
  // The run confirmed the repo unit suite does not apply to this head
  // (unitAnswer below).
  unitSuiteAbsent?: boolean;
}

// The stages a 'pending' run can be in. 'building' and 'testing' are the two
// halves of a run; 'queued' is the wait between them, a built preview whose
// run is waiting for a checks slot (services/checks-queue.js); 'deferred' is
// a promoted head that conflicts with main and got its preview but no
// verdict (services/check-admission.js) — nothing is running for it, and
// nothing will until the head merges cleanly. Anything else (undefined, a
// typo, a value from a newer writer) collapses to NULL — the card's legacy
// wording — rather than rendering an unknown caption.
export const CHECK_PHASES: ReadonlySet<string> = new Set(['building', 'queued', 'testing', 'deferred']);
export function normalizeCheckPhase(phase: unknown): string | null {
  return typeof phase === 'string' && CHECK_PHASES.has(phase) ? phase : null;
}

// Why a check run started. The merge-gate trace used to record trigger
// 'capture' for every single run — the name of the function that opened it,
// which tells a reader nothing. Production runs 1.81 checks per proposal and
// 91 of 204 runs are re-runs; "who asked for this one" is the difference
// between a redundant re-run worth eliminating and a legitimate one.
//
// A closed vocabulary, normalised at the boundary: an unrecognised value
// stores as NULL rather than leaking a caller's private string into the card.
export const CHECK_TRIGGERS: ReadonlySet<string> = new Set([
  'proposal-open',     // the proposal's first run
  'commit-push',       // a new commit landed on the branch
  'sync-main',         // the branch was refreshed from main
  'pr-import',         // an imported GitHub PR moved its head
  'manual-recheck',    // a human pressed "Re-run checks"
  'promote-kick',      // promotion re-ran checks before merging
  'boot-reconcile',    // server boot re-drove an interrupted run
  'stuck-sweep',       // the recovery sweeper re-drove a stalled run
  'fleet-maintenance', // a fleet-wide rebuild
  'conflict-resolved', // a deferred verdict, run now that the head merges cleanly
]);
export function normalizeCheckTrigger(trigger: unknown): string | null {
  return typeof trigger === 'string' && CHECK_TRIGGERS.has(trigger) ? trigger : null;
}

// A full-ceiling snapshot (400 rows since PR #1125) with console errors
// attached can get large, and
// `test_results` rides along in every proposal payload the API serves. Cap
// the SERIALISED size and shed PASSING rows from the tail first: a passing
// row carries no diagnostic weight (the summary line already counts them),
// while every failure — blocking or advisory — is the reason someone opened
// the card. 256 KB is far above a realistic suite and far below anything
// that would bloat a proposal response.
export const TEST_RESULTS_MAX_BYTES = 256 * 1024;

export function serializeTestResults(results: unknown): { json: string; dropped: number; kept: number } {
  const rows = Array.isArray(results) ? results.slice() : [];
  const size = (s: string) => Buffer.byteLength(s, 'utf8');
  let json = JSON.stringify(rows);
  if (size(json) <= TEST_RESULTS_MAX_BYTES) return { json, dropped: 0, kept: rows.length };
  let dropped = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (size(json) <= TEST_RESULTS_MAX_BYTES) break;
    if (rows[i] && (rows[i] as { status?: string }).status === 'pass') {
      rows.splice(i, 1);
      dropped += 1;
      json = JSON.stringify(rows);
    }
  }
  // Still over after every pass is gone: the failures themselves are the
  // bulk. Truncate them too rather than write a row nobody can read.
  while (rows.length && size(json) > TEST_RESULTS_MAX_BYTES) {
    rows.pop();
    dropped += 1;
    json = JSON.stringify(rows);
  }
  return { json, dropped, kept: rows.length };
}

interface StoreOptions {
  // Told when the snapshot was trimmed to fit (the old module logs it).
  onTrim?: (t: { dropped: number; kept: number }) => void;
}

// ── The repo unit suite and a person's "Run checks again" ───────────────
//
// A person who asks for a head's checks again is owed a unit suite that
// really runs on it (chat_sessions.unit_suite_fresh_sha, set by the
// 'manual-recheck' pending stamp below and by the routes that take the
// request; services/unit-suite-reuse.js). What a verdict's unit-suite row
// says about that request:
//   * `reused`: the row was copied from an earlier pass of the commit
//     instead of the suite running. Never the answer: refused, error or not.
//   * `unanswered`: no answer at all, a copied row, or no unit-suite row
//     while the suite was not confirmed absent (`unitSuiteAbsent`, which
//     visuals.settleCaptureRun sets only with evidence). A verdict that is
//     not an error is refused for it, so an owed head never stores a pass
//     nothing will run again.
//   * `ran`: the suite ran (pass or fail), or was confirmed absent: the
//     request is answered and the marker cleared. A suite that could not
//     run, on an 'error' verdict, is not: the error lane runs it again.
// While the head is not owed a fresh run, none of this changes anything.

// The unit suite's row, as services/unit-suite-row.js isUnitSuiteRow knows
// it (its index -3, or its name and path); tests/unit-suite-reuse.test.js
// pins that the two agree.
const UNIT_ROW_INDEX = -3;
const UNIT_ROW_NAME = 'Repo unit suite (npm test) passes';
const UNIT_ROW_PATH = 'package.json';
export function isUnitSuiteRow(r: unknown): boolean {
  const x = r as { index?: unknown; name?: unknown; path?: unknown } | null;
  return !!x && typeof x === 'object'
    && (x.index === UNIT_ROW_INDEX || (x.name === UNIT_ROW_NAME && x.path === UNIT_ROW_PATH));
}

export function unitAnswer(result: CheckResult | null | undefined): { reused: boolean; unanswered: boolean; ran: boolean } {
  const rows = Array.isArray(result?.results) ? result!.results! : [];
  const row = rows.find(isUnitSuiteRow) as { reused?: unknown; couldNotRun?: unknown } | undefined;
  const absent = result?.unitSuiteAbsent === true;
  const reused = !!(row && row.reused);
  return {
    reused,
    unanswered: reused || (!row && !absent),
    ran: row ? (!reused && !(row.couldNotRun && result?.state === 'error')) : absent,
  };
}

// Latest-only checks snapshot, tied to the commit it describes (staleness
// signal for the merge gate). Fenced on a person's "Run checks again" too
// (unitAnswer above).
export async function storeChecks(db: Queryable, sessionId: number, commitSha: string | null, result: CheckResult,
  errorDetail: string | null = null, opts: StoreOptions = {}): Promise<boolean> {
  const serialized = serializeTestResults(result.results);
  if (serialized.dropped && opts.onTrim) opts.onTrim({ dropped: serialized.dropped, kept: serialized.kept });
  const { reused: unitReused, unanswered, ran: unitRan } = unitAnswer(result);
  if (result && result.state === 'error') {
    // A build/boot/capture failure — record a TERMINAL 'error' verdict plus
    // the failure-streak bookkeeping that powers the sweeper's backoff and
    // the owner escalation. Backoff on check_next_retry_at grows
    // 2m → 4m → 8m → 16m → … capped at 30m; it uses the PRE-increment
    // failure count (so the first failure waits ~2m). `errorDetail` is the
    // concise reason (see summarizeBootFailure) — kept across retries via
    // COALESCE so a later retry that fails to collect logs doesn't blank it.
    // `result.platformFault` (classifyTests: the unit suite's Job refused or
    // lost before any code ran) is written with every error, true or false,
    // so it always describes the error stored.
    // The exponent is capped: power(2, n) times 120 overflows a double past
    // about 1,017 failures, and the whole write then failed. On 10 Oct 2026
    // proposal 5638's preview, at 1,018, could no longer store its error, so
    // its retry never moved and the heal rebuilt it every few minutes.
    const write = await db.query(
      `UPDATE chat_sessions
          SET check_state = $1,
              checks_progress = NULL,
              test_results = $2,
              checks_commit_sha = $3::text,
              checks_checked_at = NOW(),
              check_phase = NULL,
              check_error_detail = COALESCE($5, check_error_detail),
              check_error_platform = $6::boolean,
              unit_suite_fresh_sha = CASE WHEN $8::boolean AND lower(unit_suite_fresh_sha) = lower($3::text)
                                          THEN NULL ELSE unit_suite_fresh_sha END,
              consecutive_check_failures = consecutive_check_failures + 1,
              first_check_failure_at = COALESCE(first_check_failure_at, NOW()),
              last_check_failure_at = NOW(),
              check_next_retry_at = NOW() + make_interval(
                secs => LEAST(120 * power(2, LEAST(consecutive_check_failures, 10)), 1800)::double precision)
        WHERE id = $4
          AND status IN ('active', 'paused', 'promoted', 'merging')
          AND NOT ($7::boolean AND COALESCE(lower(unit_suite_fresh_sha) = lower($3::text), false))
          AND checks_commit_sha IS NOT DISTINCT FROM $3::text`,
      [result.state, serialized.json, commitSha || null, sessionId, errorDetail, result.platformFault === true,
        unitReused, unitRan]
    );
    return write.rowCount !== 0;
  }
  // A real verdict ('passing' / 'failing'): clear the failure streak so a
  // later transient error starts its backoff fresh, and drop the now-stale
  // error detail / retry schedule / notify stamp.
  //
  // #2170: the live progress is REDUCED here rather than dropped. What the
  // card can still use once the verdict stands is what the run cost — the
  // finished build block (kept only once it reads 'done'; a step still
  // 'now' would draw a live pipeline under a verdict) and how long the
  // checks took — so a reviewer sees "built in 20s · checked in 9m 40s"
  // after the run as well as during it. The checking time needs no new
  // column: checks_checked_at at this point is the stamp the testing half
  // opened with (captureForSession → setChecksPending 'testing'), and an
  // UPDATE reads the row's old value on its right-hand side, so it is
  // NOW() minus that even though the same statement overwrites it. The
  // counts are not kept — test_results carries the verdict — and the next
  // run's setChecksPending clears the whole thing, as it always did. One
  // exception: a unit suite this run copied from an earlier pass of the
  // commit (services/unit-suite-reuse.js) keeps its snapshot, which says so,
  // because the card has no other place that reads a passing row.
  const write = await db.query(
    `UPDATE chat_sessions
       SET check_state = $1, test_results = $2, checks_commit_sha = $3::text, checks_checked_at = NOW(),
           check_phase = NULL,
           checks_progress = NULLIF(jsonb_strip_nulls(jsonb_build_object(
             'build', CASE WHEN checks_progress #>> '{build,step}' = 'done'
                           THEN checks_progress -> 'build' END,
             'unit', CASE WHEN checks_progress #> '{unit,reused}' IS NOT NULL
                          THEN checks_progress -> 'unit' END,
             'checksMs', ROUND(EXTRACT(EPOCH FROM (NOW() - checks_checked_at)) * 1000)::bigint
           )), '{}'::jsonb),
           check_error_detail = NULL,
           check_error_platform = false,
           unit_suite_fresh_sha = CASE WHEN $6::boolean AND lower(unit_suite_fresh_sha) = lower($3::text)
                                       THEN NULL ELSE unit_suite_fresh_sha END,
           consecutive_check_failures = 0,
           first_check_failure_at = NULL,
           last_check_failure_at = NULL,
           check_next_retry_at = NULL,
           check_error_notified_at = NULL
     WHERE id = $4
       AND status IN ('active', 'paused', 'promoted', 'merging')
       AND NOT ($5::boolean AND COALESCE(lower(unit_suite_fresh_sha) = lower($3::text), false))
       AND checks_commit_sha IS NOT DISTINCT FROM $3::text`,
    [result.state, serialized.json, commitSha || null, sessionId, unanswered, unitRan]
  );
  return write.rowCount !== 0;
}

// #461: record an explicit terminal 'skipped' verdict for a proposal whose
// checks genuinely cannot / need not run (branch has no commits beyond main,
// GitHub not configured). The merge gate treats 'skipped' like 'passing', so
// this is the "either run, or skipped from running" half of #461 — before it,
// these paths left check_state NULL and the proposal blocked on "still
// running its tests" forever. `reason` lands in check_error_detail (the same
// column the badge tooltip / gate message already surface). Clears the
// failure-streak bookkeeping exactly like a real passing/failing verdict.
// `expectedCommitSha` is normally the same SHA, but recovery may discover
// that a branch has no commits beyond a newer main commit. In that case it
// atomically replaces the prior pin with the compared base SHA without
// allowing a concurrent newer build to be overwritten.
//
// #3180: a skipped verdict always carries a reason. The checks panel, the
// status pill and the agent session's card each print it as "Automated
// checks were skipped: <reason>.", so a caller that passes none records the
// same fallback those surfaces show for a row without one.
export const DEFAULT_CHECKS_SKIPPED_REASON = 'there was nothing to test';
export async function storeChecksSkipped(db: Queryable, sessionId: number, commitSha: string | null, reason: unknown,
  expectedCommitSha: string | null = commitSha): Promise<boolean> {
  const detail = (typeof reason === 'string' && reason.trim()) || DEFAULT_CHECKS_SKIPPED_REASON;
  const write = await db.query(
    `UPDATE chat_sessions
       SET check_state = 'skipped', test_results = '[]', checks_commit_sha = $1::text,
           checks_progress = NULL,
           checks_checked_at = NOW(),
           check_phase = NULL,
           check_error_detail = $2,
           check_error_platform = false,
           -- Nothing to run: a fresh unit suite owed by a person's request
           -- (services/unit-suite-reuse.js) is moot.
           unit_suite_fresh_sha = NULL,
           consecutive_check_failures = 0,
           first_check_failure_at = NULL,
           last_check_failure_at = NULL,
           check_next_retry_at = NULL,
           check_error_notified_at = NULL
     WHERE id = $3
       AND status IN ('active', 'paused', 'promoted', 'merging')
       AND checks_commit_sha IS NOT DISTINCT FROM $4::text`,
    [commitSha || null, detail, sessionId, expectedCommitSha || null]
  );
  return write.rowCount !== 0;
}

// Set 'pending' the instant a (re)check starts so a stale 'passing' can't
// slip through the merge gate while the fresh build is being tested.
//
// Reset the failure streak ONLY when a genuinely new commit is being checked.
// A backoff RETRY of the same failing commit also flows through here, and
// zeroing the counter on those would defeat the escalation + crash-loop
// short-circuit — so the streak is preserved when checks_commit_sha is
// unchanged.
//
// `phase` records WHICH stage of the run is in flight so the card can name
// it; anything else is stored as NULL, which is the legacy display. It is
// deliberately a plain assignment rather than another CASE arm — the phase
// describes the run happening right now, not the commit, so a backoff retry
// of the same commit still updates it.
//
// `trigger` records WHY the run started (see CHECK_TRIGGERS). Written on
// every stamp, including as NULL when the caller does not name one, so a
// label can never outlive the run it described.
//
// #1442: this is also where checks_base_sha is stamped — the commit on main
// that this run's verdict is a statement ABOUT, from apps.main_sha (kept
// current by main-drift-poller) via a subquery. COALESCE keeps the previous
// value when the app row has no main_sha yet rather than blanking a good one.
//
// $2 and $3 carry explicit ::text casts: $2 is spliced into both an
// assignment to checks_commit_sha (varchar) and IS DISTINCT FROM comparisons
// (inferred text), and without the casts postgres refuses to prepare the
// statement ("inconsistent types deduced for parameter $2").
export async function setChecksPending(db: Queryable, sessionId: number, commitSha: string | null,
  phase: unknown = null, trigger: unknown = null): Promise<boolean> {
  const write = await db.query(
    `UPDATE chat_sessions
       SET check_state = 'pending', checks_commit_sha = $2::text, checks_checked_at = NOW(),
           check_phase = $3::text,
           check_trigger = $4::text,
           -- A person asked for this run ("Run checks again"): its head is
           -- owed a unit suite that really runs (services/unit-suite-reuse.js),
           -- until one settles (storeChecks).
           unit_suite_fresh_sha = CASE WHEN $4::text = 'manual-recheck' AND $2::text IS NOT NULL
                                       THEN lower($2::text) ELSE unit_suite_fresh_sha END,
           checks_progress = NULL,
           check_next_retry_at = NULL,
           checks_base_sha = COALESCE(
             (SELECT a.main_sha FROM apps a WHERE a.id = chat_sessions.app_id),
             checks_base_sha),
           consecutive_check_failures = CASE WHEN checks_commit_sha IS DISTINCT FROM $2::text
                                             THEN 0 ELSE consecutive_check_failures END,
           first_check_failure_at  = CASE WHEN checks_commit_sha IS DISTINCT FROM $2::text
                                          THEN NULL ELSE first_check_failure_at END,
           check_error_detail      = CASE WHEN checks_commit_sha IS DISTINCT FROM $2::text
                                          THEN NULL ELSE check_error_detail END,
           check_error_notified_at = CASE WHEN checks_commit_sha IS DISTINCT FROM $2::text
                                          THEN NULL ELSE check_error_notified_at END
     WHERE id = $1
       AND status IN ('active', 'paused', 'promoted', 'merging')`,
    [sessionId, commitSha || null, normalizeCheckPhase(phase), normalizeCheckTrigger(trigger)]
  );
  return write.rowCount !== 0;
}

// The deferral stamp. The run captured the preview and stopped: the verdict
// stays 'pending', the phase says why, and the commit pin keeps the stale
// sweeper (staging-recovery.checkRunOverdue) and the vote-time kick from
// re-driving a run that is waiting on a conflict rather than on a runner.
// Same commit guard as storeChecks: a stamp about a head the row has since
// left is discarded.
export async function storeChecksDeferred(db: Queryable, sessionId: number, commitSha: string | null,
  detail: unknown = null): Promise<boolean> {
  const write = await db.query(
    `UPDATE chat_sessions
        SET check_state = 'pending',
            check_phase = 'deferred',
            checks_checked_at = NOW(),
            checks_progress = NULL,
            check_next_retry_at = NULL,
            check_error_detail = $3::text
      WHERE id = $1
        AND status IN ('active', 'paused', 'promoted', 'merging')
        AND (checks_commit_sha IS NULL OR $2::text IS NULL OR checks_commit_sha = $2::text)`,
    [sessionId, commitSha || null, detail ? String(detail).slice(0, 300) : null]
  );
  return write.rowCount !== 0;
}

// The console check's latest snapshot, on the commit it describes.
export async function storeConsoleCheck(db: Queryable, sessionId: number, result: { state: string; errors?: unknown[] },
  expectedCommitSha: string | null): Promise<boolean> {
  const write = await db.query(
    `UPDATE chat_sessions
       SET console_check_state = $1, console_errors = $2, console_checked_at = NOW()
     WHERE id = $3
       AND status IN ('active', 'paused', 'promoted', 'merging')
       AND checks_commit_sha IS NOT DISTINCT FROM $4::text`,
    [result.state, JSON.stringify(result.errors || []), sessionId, expectedCommitSha || null]
  );
  return write.rowCount !== 0;
}

// What the capture run produced and why anything is missing (latest run
// only). With `expectedCommitSha`, only while the row's checks still
// describe that commit: a stale run never overwrites a newer one's outcome.
export async function storeCaptureOutcome(db: Queryable, sessionId: number, state: string, detail: unknown,
  expectedCommitSha?: string | null): Promise<void> {
  if (expectedCommitSha === undefined) {
    await db.query(
      `UPDATE chat_sessions SET capture_state = $1, capture_detail = $2, captured_at = NOW() WHERE id = $3`,
      [state, JSON.stringify(detail || {}), sessionId]);
    return;
  }
  await db.query(
    `UPDATE chat_sessions SET capture_state = $1, capture_detail = $2, captured_at = NOW()
      WHERE id = $3 AND checks_commit_sha IS NOT DISTINCT FROM $4::text`,
    [state, JSON.stringify(detail || {}), sessionId, expectedCommitSha]);
}

// ── App check history ───────────────────────────────────────────────────

export interface HistoryRow { checkKey: string; name?: string; path?: string; passed?: boolean; passes?: number; fails?: number }

// Record one run's outcomes. `first_passed_at` is stamped with COALESCE so
// it only ever records the FIRST pass; `last_failed_at` never clears it.
// That asymmetry is the no-demotion rule expressed in SQL. It is the first
// pass ANYWHERE, kept for the record; what gates is merged_pass_at.
//
// With `sessionId`, the checks this run passed that no merge has made
// blocking yet are added to that proposal's own checks_earned_keys: they
// block its later heads, and everybody's once it merges.
//
// Rows are written in check_key order, so two runs of one app settling at
// once lock the same rows in the same order. Called only after the verdict
// was stored: a run whose snapshot was discarded as stale must not move
// history either. Throws on a database error (the old module's wrapper
// swallows it; inside a transition it fails the event, as it must).
export async function recordRun(db: Queryable, appId: number, rows: HistoryRow[],
  { sessionId = null, maxRows = Infinity, pruneAfterDays = 90 }: { sessionId?: number | null; maxRows?: number; pruneAfterDays?: number } = {}): Promise<number> {
  if (!appId || !Array.isArray(rows) || !rows.length) return 0;
  const capped = rows.slice(0, maxRows).filter((r) => r && r.checkKey)
    .sort((a, b) => (String(a.checkKey) < String(b.checkKey) ? -1 : String(a.checkKey) > String(b.checkKey) ? 1 : 0));
  const values: string[] = [];
  const params: unknown[] = [appId];
  for (const r of capped) {
    const base = params.length;
    // Counts, not a boolean: a check on its first appearance runs
    // NEW_CHECK_RUNS times and lands here as one row carrying all of
    // them. A single observation is just passes=1 or fails=1.
    const passes = Number.isInteger(r.passes) ? r.passes! : (r.passed ? 1 : 0);
    const fails = Number.isInteger(r.fails) ? r.fails! : (r.passed ? 0 : 1);
    if (passes <= 0 && fails <= 0) continue;
    params.push(r.checkKey, String(r.name || ''), String(r.path || ''), passes, fails);
    // EVERY column carries an explicit cast: a bind parameter inside a
    // sub-SELECT's VALUES list has nothing to infer a type from, so postgres
    // resolves it to `text`, and an integer column then refuses it.
    values.push(`($1::int, $${base + 1}::text, $${base + 2}::text, $${base + 3}::text, $${base + 4}::int, $${base + 5}::int)`);
  }
  if (!values.length) return 0;
  await db.query(
    `INSERT INTO app_check_history AS h
       (app_id, check_key, check_name, check_path,
        first_passed_at, last_passed_at, last_failed_at, last_seen_at,
        pass_count, fail_count, consecutive_passes, merged_pass_known)
     SELECT v.app_id, v.check_key, v.check_name, v.check_path,
            CASE WHEN v.passes > 0 THEN NOW() ELSE NULL END,
            CASE WHEN v.passes > 0 THEN NOW() ELSE NULL END,
            CASE WHEN v.fails > 0 THEN NOW() ELSE NULL END,
            NOW(),
            v.passes,
            v.fails,
            -- One failure anywhere in the run ends the streak, however
            -- many passes came with it.
            CASE WHEN v.fails > 0 THEN 0 ELSE v.passes END,
            -- Written explicitly, so the schema's one-time backfill of
            -- merged_pass_at (which reads a NULL here as "from before
            -- the merged rule") never reaches a row made under it.
            TRUE
       FROM (VALUES ${values.join(', ')})
            AS v(app_id, check_key, check_name, check_path, passes, fails)
     ON CONFLICT (app_id, check_key) DO UPDATE SET
       check_name = EXCLUDED.check_name,
       check_path = EXCLUDED.check_path,
       merged_pass_known = TRUE,
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
  const passed = capped
    .filter((r) => (Number.isInteger(r.passes) ? r.passes! > 0 : !!r.passed))
    .map((r) => String(r.checkKey));
  await recordEarned(db, appId, sessionId, passed);
  await db.query(
    `DELETE FROM app_check_history
      WHERE app_id = $1 AND last_seen_at < NOW() - make_interval(days => $2)`,
    [appId, pruneAfterDays]
  );
  return capped.length;
}

// Add `keys` to the proposal's own earned checks (checks_earned_keys): they
// block its later heads, and everybody's once it merges. Only what a merge
// has not already made blocking for everybody, so the list stays the handful
// of new or backlog checks, not the suite; a row already folded in after its
// merge is left alone. recordRun calls it for the checks a run passed. A run
// that copied an earlier unit-suite pass of its commit instead of running it
// (services/unit-suite-reuse.js) calls it alone: the proposal earns the gate
// that pass earns, and the app's counts, which the pass moved when it ran,
// are not moved again. Throws on a database error, as recordRun does.
export async function recordEarned(db: Queryable, appId: number, sessionId: number | null, keys: string[]): Promise<boolean> {
  const own = Number.isSafeInteger(Number(sessionId)) && Number(sessionId) > 0 ? Number(sessionId) : null;
  const list = (keys || []).filter(Boolean).map(String);
  if (!appId || !own || !list.length) return false;
  await db.query(
    `UPDATE chat_sessions cs
        SET checks_earned_keys = NULLIF(ARRAY(
              SELECT DISTINCT k
                FROM unnest(COALESCE(cs.checks_earned_keys, '{}'::text[]) || $3::text[]) AS k
               WHERE NOT EXISTS (
                 SELECT 1 FROM app_check_history h
                  WHERE h.app_id = $2 AND h.check_key = k AND h.merged_pass_at IS NOT NULL)
               ORDER BY k), '{}'::text[])
      WHERE cs.id = $1 AND cs.app_id = $2 AND cs.checks_earned_settled_at IS NULL`,
    [own, appId, list]
  );
  return true;
}

// The unit-suite passes this proposal's run recorded for `commitSha`
// (unit_suite_passes, services/unit-suite-reuse.js) may now be copied: the
// verdict that carries their row was stored and the row's observation is in
// the app's history, in the same transaction. A pass whose run errored, was
// discarded or whose history row was not written stays unobserved, and is
// never copied.
export async function markUnitPassObserved(db: Queryable, { appId, sessionId, commitSha }:
  { appId: number; sessionId: number; commitSha: string }): Promise<number> {
  if (!appId || !sessionId || !/^[0-9a-f]{40}$/i.test(String(commitSha || ''))) return 0;
  const { rowCount } = await db.query(
    `UPDATE unit_suite_passes SET observed_at = NOW()
      WHERE app_id = $1 AND session_id = $2 AND commit_sha = $3 AND observed_at IS NULL`,
    [appId, sessionId, String(commitSha).toLowerCase()]);
  return rowCount || 0;
}
