// What a proposal's required checks leave behind that is not the preview
// machine's own row: the vocabularies, the trimmed results, the unit suite's
// answer, and the app's check history. One copy, shared by the preview
// machine (whose verdict writers are src/workflow/preview/check-store.ts)
// and the code not migrated yet (services/visuals.js,
// services/check-history.js), which imports it back.

import type { Queryable } from './db.ts';

export interface CheckResult {
  state: 'passing' | 'failing' | 'skipped' | 'error' | string;
  results?: unknown[];
  platformFault?: boolean;
  // The run confirmed the repo unit suite does not apply to this head
  // (unitAnswer below).
  unitSuiteAbsent?: boolean;
  // An error whose retries are counted by another rule than the row's own
  // streak (the preview machine's lostAgain): the failures to record and
  // when the retry comes, null when none will.
  retry?: { failures: number; nextRetryAt: string | null };
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

export interface StoreOptions {
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

// #3180: a skipped verdict always carries a reason. The checks panel, the
// status pill and the agent session's card each print it as "Automated
// checks were skipped: <reason>.", so a caller that passes none records the
// same fallback those surfaces show for a row without one.
export const DEFAULT_CHECKS_SKIPPED_REASON = 'there was nothing to test';

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
