// What a proposal's required checks leave on its row: the verdict, the
// skipped and deferred stamps, 'pending', the console check and the capture
// outcome. The preview machine owns these columns, and only its transitions
// run these statements (src/workflow/preview/machine.ts WRITES); the
// vocabularies and the history they share with the code not migrated yet
// are ../rules/check-store.ts.
//
// Each verdict write is fenced on the commit it describes: a verdict about
// a head the row has since left is discarded (it reports false).

import type { Queryable } from '../rules/db.ts';
import type { CheckResult, StoreOptions } from '../rules/check-store.ts';
import {
  DEFAULT_CHECKS_SKIPPED_REASON, normalizeCheckPhase, normalizeCheckTrigger, serializeTestResults, unitAnswer,
} from '../rules/check-store.ts';

// The fallback reason a skipped verdict is written with.
export { DEFAULT_CHECKS_SKIPPED_REASON } from '../rules/check-store.ts';

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
