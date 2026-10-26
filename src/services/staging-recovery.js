'use strict';

// Shared staging recovery helpers: the single source of truth for "does this
// session's staging preview need rebuilding?" and for handing a rebuild or a
// re-run of the checks to the preview machine (services/preview-workflow.js),
// which builds, checks and announces it. The callers are observers:
//   1. the preview-runtimes clock (lookForLostPreviews: a vote-backed
//      preview whose runtime is gone)
//   2. on-demand preview click    (routes/sessions.js ensure-staging)
//   3. a turn's recovery that found its code landed (server.js)
//   4. a person's recheck         (routes, recheckSessionChecks)
// (Checks a row owes and nothing runs are the preview machine's own
// deadline, ChecksDue: preview/machine.ts.)

const log = require('./logger');
const repoRef = require('./repo-ref');

const DEFAULT_CHECKS_STALE_MS = 10 * 60 * 1000;

function checksStaleMs() {
  const configured = Number.parseInt(
    process.env.CHECKS_STALE_MS || String(DEFAULT_CHECKS_STALE_MS),
    10
  );
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_CHECKS_STALE_MS;
}

// A missing/old timestamp is actionable only after a proposal has a submitted
// head. Runtime ownership is deliberately checked by the caller: this helper
// answers whether the durable snapshot is overdue, not whether a live process
// is still working on it.
function checkRunOverdue(session, { now = Date.now(), staleMs = checksStaleMs() } = {}) {
  if (session?.check_state != null && session.check_state !== 'pending') return false;
  // A deferred verdict is waiting on a conflict, not on a runner
  // (services/check-admission.js): no run is overdue because none was
  // started, and re-driving one would only defer it again.
  if (session?.check_phase === 'deferred') return false;
  // Nor is a run waiting for a checks slot (services/checks-queue.js): it
  // starts when one frees, and the harvest re-drives it in its place if its
  // process dies (a `queued` row is written inside the checks run, which
  // the kernel claims again if its process dies).
  if (session?.check_phase === 'queued') return false;
  // 'pending' means the preview machine has a build or run outstanding,
  // alive while its work lease is: nothing is overdue by clock (bug 9). A
  // pending verdict nothing runs is the machine's own ChecksDue
  // (preview/machine.ts).
  if (session?.check_state === 'pending') return false;
  if (!(session?.checks_commit_sha || session?.handoff_head_sha)) return false;
  const checkedAt = session?.checks_checked_at == null
    ? NaN
    : new Date(session.checks_checked_at).getTime();
  return !Number.isFinite(checkedAt) || (now - checkedAt) > staleMs;
}

// Promoted proposals retain the recovery behavior they have always had.
// Before promotion, only a submitted native CLI handoff is eligible: ordinary
// active Dev sessions have their own turn-tail recovery, a fresh draft has no
// checks to re-run, and an uploaded-but-unsubmitted commit is still waiting on
// proposal_submit_build rather than on the checks service.
//
// And any open proposal owed a run a person asked for ("Run checks again",
// services/unit-suite-reuse.js) on its current head: the route accepts the
// request for active and paused proposals, native and CLI alike, and the
// request outlives the process that took it.
function freshRunOwed(session) {
  return !!session?.unit_suite_fresh_sha && !!session?.checks_commit_sha
    && String(session.unit_suite_fresh_sha).toLowerCase() === String(session.checks_commit_sha).toLowerCase();
}

function isStuckCheckRecoveryScope(session) {
  if (session?.status === 'promoted') return true;
  if (['active', 'paused'].includes(session?.status) && freshRunOwed(session)) return true;
  if (session?.status !== 'active' || session?.source !== 'cli_handoff') return false;
  if (!(session.checks_commit_sha || session.handoff_head_sha)) return false;
  const hasUnsubmittedUpload = !!session.handoff_uploaded_sha
    && session.handoff_uploaded_sha !== session.handoff_head_sha
    && (session.checks_commit_sha || null)
      === (session.handoff_upload_checked_sha || null);
  return !hasUnsubmittedUpload;
}

// #237: how many 'error' verdicts in a row the error lane above re-runs on
// its own, and the day a platform fault is retried past it, are
// rules/check-retries.ts: one reader of CHECK_MAX_AUTO_RETRIES, one rule.
const { checkMaxAutoRetries, withinAutoRetries } = require('../workflow/rules/check-retries.ts');

// Does the error lane still run this stored 'error' again on its own, as far
// as the streak goes? The preview machine's errorTimer rule, read off the
// row. The connector reads it to say whether a re-run is coming
// (mcp-tools.erroredRunWillRetry).
function errorWithinAutoRetries(session, { maxAutoRetries = checkMaxAutoRetries(), now = Date.now() } = {}) {
  if (!session) return false;
  return withinAutoRetries({
    streak: Number(session.consecutive_check_failures) || 0,
    platformFault: session.check_error_platform === true,
    firstFailureAt: session.first_check_failure_at || null,
  }, maxAutoRetries, now);
}

// What a red run that overlapped a platform rollout used to record instead
// of 'failing' (#3828). Nothing writes it any more: red runs followed load,
// not rollouts (701 runs from 5 Oct 2026, red at 9% under 10 cores of check
// Jobs and 24 to 29% above, a rollout adding little at equal load), so the
// relabel excused real failures and the checks queue (services/checks-
// queue.js) addresses the load. A run that crossed a restart is judged on its
// own results now. The rows already stored with it were given a retry by
// storeChecks and are run again by the error lane, so the surfaces that word
// them as "will run again" (the card, the merge gate, the connector) still
// read them that way until they settle. It is user-facing copy: plain words,
// no em dashes.
const ROLLOUT_RETRY_DETAIL = 'Checks ran while Homeroom was updating, so they will run again.';

// Does a session need its staging preview (re)built?
//
// THREE failure shapes leave a card without a working preview:
//   1. staging_url IS NULL — GC reclaimed it (or it was GC'd before
//      promotion). The Preview button is hidden (gated on staging_url).
//   2. staging_url is set but the staging container is gone — the
//      Preview button renders but the hostname has no upstream, so the
//      iframe 502s / fails to connect. (Pre-wildcard-Caddy this also
//      surfaced as "secure connection failed" when the per-host route
//      was dropped; routing is now container-name based so the only
//      remaining cause is a missing/stopped container.)
//   3. #851: the container is running, but its ENVIRONMENT is out of date —
//      it was assembled by an older platform build. This shape is invisible
//      to a liveness check and is why #850 needed a manual sweep at all: a
//      pre-#848 preview boots fine and then cannot recognise the signed-in
//      user, so the on-demand route answered {status:'ready'} and opened the
//      app's login screen. Detected by comparing the `usernode.env.fp` label
//      stamped at build time (services/staging-env.js) against the digest the
//      platform would produce today.
// All three are healable by a rebuild. We deliberately do NOT rebuild on a
// merely-unhealthy-but-running container (that's a 502, an app bug, not
// a missing preview) to avoid churn.
//
//   4. The preview is of ANOTHER COMMIT than the head the caller is about to
//      test. A clean platform sync of main carries the checks verdict forward
//      (sync-main.advanceReviewAfterPlatformSync, carryChecks) and builds
//      nothing, so the preview stays at the pre-sync commit while the branch
//      tip — and the dapp.json the capture reads from it — moves on. A
//      "Re-run checks" then ran the new head's checks against the old build
//      and reported failures that were not the proposal's (#1710 collected
//      seven that way). Detected by comparing `staging_commit_sha`, stamped
//      at build time from the clone's HEAD, against `headSha`.
// All four are healable by a rebuild. We deliberately do NOT rebuild on a
// merely-unhealthy-but-running container (that's a 502, an app bug, not
// a missing preview) to avoid churn.
//
//
//   5. The preview's DATABASE is gone, or is on a server being emptied.
//      Only possible with a separate preview database server
//      (STAGING_DB_ADMIN_URL, db-manager.js), which holds nothing but copies
//      and may be wiped and come back empty. The container built against it
//      keeps running and answers an error for every page that reads its
//      database, so a liveness check sees nothing wrong and a checks run
//      would record those errors against the proposal. Detected from the
//      runtime's own labels, which name the exact database it was given and
//      the server it was made on (dbManager.previewDatabaseVerdict): a
//      session can have older clones elsewhere, and they must not vouch for
//      this one. A server that cannot be read is "cannot tell". The rebuild
//      rebuilds the app's template on the empty server and copies again.
//      The same look moves previews off a preview server that is being
//      drained before it is removed. With one server the question is not
//      asked, and a preview built before the setting has no such labels.
//
// `config` is optional. Without it the staleness comparison is skipped and
// the verdict is liveness-only — the pre-#851 behaviour. Every real caller
// passes one; the fallback keeps the function usable from a context that has
// no config and makes the added parameter non-breaking. `headSha` is likewise
// optional: without it (or without a recorded build commit — previews built
// before the column existed) the commit comparison is skipped, so a caller
// that only wants liveness, and every pre-existing preview, behave as before.
// `envCheck: false` (the preview-runtimes clock): the environment is not
// judged, because an older build running it during a rollout would judge
// the new build's previews by its own fingerprint; the preview-env clock,
// acting only in the newest build, does that (staging-reap tellStaleEnv).
async function stagingNeedsRebuild(session, { config = null, headSha = null, envCheck = true } = {}) {
  if (!session.staging_url) return true;
  let state;
  if (session.staging_runtime_kind === 'kubernetes') {
    if (!session.staging_runtime_name) return true;
    const applicationRuntime = require('./application-runtime');
    const runtimeConfig = {
      ...config, appRuntime: 'kubernetes',
      kubernetes: { appNamespace: process.env.APP_NAMESPACE || 'social-apps', ...config?.kubernetes },
    };
    try {
      state = await applicationRuntime.inspect(runtimeConfig, {
        runtimeKind: 'kubernetes', runtimeName: session.staging_runtime_name,
      });
    } catch (_) { return false; } // An API outage is not evidence of a stale preview.
  } else {
    if (!session.staging_container_id) return true;
    const docker = require('./docker');
    state = await docker.inspectContainer(session.staging_container_id);
  }
  // The inspect could not be PERFORMED (unreachable daemon). Distinct from
  // 'not_found', which means the container is genuinely gone and is handled
  // below by the status check. Leave the preview strictly alone here: a docker
  // hiccup must never be read as evidence that a preview is broken or stale,
  // because the heal sweep and the reap pass both act on this verdict.
  if (!state) return false;
  // Covers 'not_found' (shape 2 — the container is gone) as well as
  // exited/dead/created.
  if (state.status !== 'running') return true;
  if (previewIsOfAnotherCommit(session, headSha)) return true;
  if (await previewDatabaseNeedsRebuild(session, state)) return true;
  if (!config || !envCheck) return false;

  const stagingEnv = require('./staging-env');
  const expected = stagingEnv.expectedStagingFingerprint(config);
  const actual = state.labels?.[stagingEnv.LABEL_ENV_FP] || null;
  if (actual === expected) return false;

  log.info('staging-recovery', 'Preview env is stale — rebuild needed', {
    sessionId: session.id, expected, actual,
  });
  return true;
}

// The preview-runtimes clock's run (src/workflow/clock/services.ts): every
// preview that backs a vote and that the preview machine says serves is
// looked at, every run, and one whose runtime or database is gone is
// reported lost, so the machine builds it again (PreviewLost). One the
// machine is building, retiring or retrying is its own already
// (preview-workflow.working). The leader's heal looked only at the 50
// oldest. `signal` ends the look early (the run's lease is gone).
async function lookForLostPreviews(config, { signal = null } = {}) {
  const pool = require('../db/pool').getPool(config);
  const { rows } = await pool.query(
    `SELECT cs.id, cs.app_id, cs.staging_url, cs.staging_runtime_kind, cs.staging_runtime_name,
            cs.staging_container_id, cs.staging_commit_sha
       FROM wf_instances w JOIN chat_sessions cs ON w.key = 'session:' || cs.id
      WHERE w.machine = 'preview' AND w.state IN ('settled', 'deferred')
        AND NOT (w.state = 'settled' AND w.data->>'verdict' = 'error')
        AND jsonb_typeof(w.data->'serving') = 'object'
        AND cs.status IN ('promoted', 'merging')
      ORDER BY cs.id`);
  const previewWorkflow = require('./preview-workflow');
  let lost = 0;
  for (const session of rows) {
    if (signal?.aborted) break;
    if (!(await stagingNeedsRebuild(session, { config, envCheck: false }))) continue;
    if (await previewWorkflow.lost({ session, detail: 'runtime gone' })) lost++;
  }
  return { examined: rows.length, lost };
}

// The state and labels of a session's preview runtime, as stagingNeedsRebuild
// reads them, for a caller that only wants to look (the drain status in
// staging-reap). Null when there is no runtime to read or it could not be
// read. Never throws.
async function inspectPreviewRuntime(session, config = null) {
  try {
    if (session.staging_runtime_kind === 'kubernetes') {
      if (!session.staging_runtime_name) return null;
      return await require('./application-runtime').inspect({
        ...config, appRuntime: 'kubernetes',
        kubernetes: { appNamespace: process.env.APP_NAMESPACE || 'social-apps', ...config?.kubernetes },
      }, { runtimeKind: 'kubernetes', runtimeName: session.staging_runtime_name });
    }
    if (!session.staging_container_id) return null;
    return await require('./docker').inspectContainer(session.staging_container_id);
  } catch (_) { return null; }
}

// Shape 5 above. Never throws: a failed look is "cannot tell".
async function previewDatabaseNeedsRebuild(session, state) {
  let dbManager;
  try { dbManager = require('./db-manager'); } catch (_) { return false; }
  if (typeof dbManager.previewDatabaseVerdict !== 'function') return false;
  let verdict = null;
  try { verdict = await dbManager.previewDatabaseVerdict(state?.labels || null); } catch (_) { return false; }
  if (verdict === 'gone') {
    log.info('staging-recovery', 'Preview database is gone from the server it was made on, so a rebuild is needed', {
      sessionId: session.id,
    });
  } else if (verdict === 'draining') {
    log.info('staging-recovery', 'Preview database is on a server being drained, so a rebuild is needed', {
      sessionId: session.id,
    });
  }
  return !!verdict;
}

// Shape 4 above. Only a KNOWN mismatch counts: a missing build commit (a
// preview from before the column) or a missing head is "cannot tell", which
// keeps the old answer rather than sweeping every legacy preview at once.
function previewIsOfAnotherCommit(session, headSha) {
  const built = typeof session.staging_commit_sha === 'string' ? session.staging_commit_sha.trim().toLowerCase() : '';
  const head = typeof headSha === 'string' ? headSha.trim().toLowerCase() : '';
  if (!built || !head || built === head) return false;
  log.info('staging-recovery', 'Preview is of another commit than the head — rebuild needed', {
    sessionId: session.id, built, head,
  });
  return true;
}

// A proposal up for approval: its reviewed head is the head its votes and
// the merge gate are about (routes/votes.js keeps it current on every head
// move). Any other row's reviewed head may be left over from an earlier
// review (unpromote keeps it), so it is not read as the head.
const UP_FOR_APPROVAL = new Set(['promoted', 'merging']);

// The head a proposal is up for approval on: an imported row's own PR head,
// a native proposal's reviewed head; null for anything else, or none
// recorded.
function approvedHeadSha(session) {
  if (!session) return null;
  if (session.source === 'imported') return session.imported_pr_head_sha || null;
  return UP_FOR_APPROVAL.has(session.status) ? (session.reviewed_head_sha || null) : null;
}

// The commit a recheck is about to judge, from the row's own pins: the
// imported head for an imported row, the reviewed head for a proposal up
// for approval (approvedHeadSha), otherwise the checks pin (which a clean
// sync carries forward to the sync commit — exactly the case where the
// preview is a commit behind). No GitHub read: the pin is what the votes and
// the verdict describe, and a recheck is asked to judge that.
//
// The reviewed head comes before the checks pin: when the branch moved under
// a run (restart recovery rolled Club Votes' head back from a review fix to
// the commit before it, 12 October 2026), the pin is the run's old commit,
// and judging it again, or collecting its run, says nothing about the head
// people vote on. Its pass read as ready to try; its own head then failed.
function recheckHeadSha(session) {
  if (!session) return null;
  const approved = approvedHeadSha(session);
  if (approved || session.source === 'imported') return approved;
  return session.checks_commit_sha || session.handoff_head_sha || session.reviewed_head_sha || null;
}

// Recovery's own `reason` strings name the CODE PATH; visuals.CHECK_TRIGGERS
// names why a checks run started, which is the vocabulary the merge-gate trace
// and the proposal card share. Map one to the other here rather than leaking a
// recovery-internal label into either. An unmapped reason reads as the sweeper,
// which is what every unnamed recovery path actually is; a recheck hands the
// machine no trigger for one, so the machine's own map names it.
const CHECK_TRIGGER_BY_REASON = new Map(Object.entries({
  'manual-recheck': 'manual-recheck',
  'preview-click': 'manual-recheck',
  // #1199: a same-commit resubmit that corrected the proposal's capture
  // routes. It reads as a manual re-run because that is what it is — an
  // author asking for a fresh verdict on code that has not changed — and a
  // new trigger string would need a value in visuals.CHECK_TRIGGERS and
  // reviewer-facing copy in public/js/app-view.js to render as anything.
  'testing-update': 'manual-recheck',
  tail_worker_gone: 'boot-reconcile',
  dangling_tail: 'boot-reconcile',
  // A verdict that was deferred while the head conflicted with main, run
  // now that it merges cleanly (services/check-admission.js).
  'conflict-resolved': 'conflict-resolved',
}));
function checkTriggerForReason(reason) {
  return CHECK_TRIGGER_BY_REASON.get(reason) || 'stuck-sweep';
}

// The reasons that mean "produce a FRESH verdict": a person's request, so the
// machine takes the recheck as theirs rather than the system's. Keyed on the
// reason rather than on the trigger it maps to: 'preview-click' also reads as
// a manual re-run to a reviewer, but it is a page load rather than a request
// for new screenshots.
const FORCED_RECHECK_REASONS = new Set(['manual-recheck', 'testing-update']);

// The reasons that are an observation of a runtime that is gone: for a
// session the machine holds, those report PreviewLost and the machine
// rebuilds what served. A Preview
// click is one: the route rebuilds only once it found the runtime missing or
// stale (routes/sessions.js inspectPreview). Asked as a plain "ensure", the
// machine would answer that it already serves that head, and the reviewer's
// loader would wait for a preview nothing builds.
const OBSERVED_REASONS = new Set(['preview-click']);
const workflow = () => require('./preview-workflow');

// Hand the rebuild of a single session's staging preview to the preview
// machine: a session that has a branch + commits ahead of main but a
// NULL/dead staging_url. Shared by the on-demand ensure-staging route and a
// turn's recovery that found its code landed, so they never drift apart.
//
// Returns 'handed_off' when the machine has it, 'skipped' when there's
// nothing to build (no owner/repo, no bot token, branch not ahead of main;
// the machine records that verdict).
//
// Creates a PR only when one is missing — the active-session recovery case
// where CC finished but post-processing died before opening the PR.
// 'promoted'/'merging' sessions always already have one, so that branch is
// a no-op for them.
async function rebuildSessionStaging({ config, pool, session, reason, headSha = null }) {
  const { broadcastGlobal } = require('./ws');
  // A preview the machine is building has nothing to heal yet, and one that
  // keeps failing waits out the machine's retry: a boot or a heal pass is not
  // a reason to try it again (on 10 Oct 2026 a restart rebuilt one to twelve
  // of them, one had failed 860 times). Asked before a lost runtime is
  // reported: a failed rebuild keeps the older attempt's receipt, and its
  // loss would start another build inside the backoff and past the cap. A
  // Preview click still asks.
  if (reason !== 'preview-click' && await workflow().working(session.id)) return 'left_to_machine';
  if (OBSERVED_REASONS.has(reason) && await workflow().held(session.id)
      && await workflow().lost({ session, detail: reason })) {
    return 'handed_off';
  }

  const { owner, repo } = repoRef.ownerRepo(session.repo_url) || {};
  if (!owner || !repo) {
    // #461: every no-op below used to return silently, leaving check_state
    // NULL — the merge gate blocks NULL as "still running its tests" and the
    // stuck-checks sweeper re-picked the row every pass, re-skipped, forever.
    // Record an explicit terminal 'skipped' verdict (gate-passing) instead.
    await recordChecksSkipped({
      session, commitSha: session.checks_commit_sha || null,
      reason: 'checks unavailable: GitHub is not configured',
    });
    return 'skipped';
  }

  const pat = process.env.GITHUB_BOT_TOKEN;
  if (!pat) {
    await recordChecksSkipped({
      session, commitSha: session.checks_commit_sha || null,
      reason: 'checks unavailable: GitHub is not configured',
    });
    return 'skipped';
  }

  // #866: what identifies this session's code in the app's own repo.
  //
  // Native rows own their branch there, so `branch_name` compares and
  // clones fine. An imported PR's branch_name is the PR's HEAD REF, which
  // for a fork-headed PR doesn't exist in the base repo at all — the
  // compare below 404s and the whole heal turns into a permanent 'error'
  // verdict ("could not compare <branch> with main"), which is exactly the
  // dead end an imported proposal used to reach the first time its preview
  // was GC'd. The head SHA is always reachable (refs/pull/<N>/head), so
  // pin to it and let staging.js's PR-ref clone fetch it.
  const imported = session.source === 'imported';
  const importedHead = imported ? (session.imported_pr_head_sha || null) : null;
  if (imported && !importedHead) {
    await recordChecksSkipped({
      session, commitSha: session.checks_commit_sha || null,
      reason: 'imported PR has no recorded head commit, so there is nothing to preview',
    });
    return 'skipped';
  }
  const compareHead = importedHead || session.branch_name;

  // Only build when the head actually carries work — a head level with
  // (or behind) main has nothing to preview.
  let compare;
  try {
    // A read, so it goes through the App installation when the owner has
    // one (services/github.js getReadOctokit), and is recorded and counted
    // like every other GitHub request. It used to be a bot-token client of
    // its own that the budget never saw.
    if (require('./repo-ref').hostOfOwner(owner) === 'git_host') {
      // On Homeroom's git host: the mirror answers (services/hosted-git.js).
      compare = await require('./hosted-git').compareCommits(owner, repo, 'main', compareHead);
    } else {
      const ok = await require('./github').getReadOctokit(owner);
      const { data } = await ok.rest.repos.compareCommits({
        owner, repo, base: 'main', head: compareHead,
      });
      compare = data;
    }
  } catch (err) {
    // The machine builds the head the row knows; a branch that is gone
    // fails its build, which its error lane bounds.
    log.info('staging-recovery', 'Could not compare the head with main; the machine builds the head the row knows', {
      sessionId: session.id, head: compareHead, err: err.message,
    });
    await workflow().revision({ pool, session, head: importedHead || session.checks_commit_sha, source: reason,
      trigger: checkTriggerForReason(reason) });
    return 'handed_off';
  }

  if (compare.ahead_by === 0) {
    await recordChecksSkipped({
      session,
      commitSha: compare.base_commit?.sha || session.checks_commit_sha || null,
      reason: imported
        ? 'imported PR has no commits beyond main, so there is nothing to test'
        : 'branch has no commits beyond main, so there is nothing to test',
    });
    return 'skipped';
  }

  log.info('staging-recovery', 'Rebuilding staging preview', {
    sessionId: session.id, status: session.status, branch: session.branch_name,
    imported, head: compareHead, aheadBy: compare.ahead_by, reason,
  });

  // #866: for an imported row the commit to build is the RECORDED head —
  // the SHA the votes and checks describe — not the compare's tip. They're
  // usually the same commit, but "usually" is how a preview ends up
  // showing code nobody voted on: a push that lands between the sweep
  // reading the row and this compare running moves the tip while
  // imported_pr_head_sha (and every vote cast against it) still points at
  // the older commit. The head-change sweep is what advances that SHA, and
  // it clears the tally when it does; this path must not front-run it.
  // The same for a native proposal up for approval: its reviewed head
  // (approvedHeadSha, or the head a recheck read for it) is the commit its
  // votes describe, and the one recheckHeadSha judges a preview by. A tip
  // past it is a push its reconcile has not taken in yet, which moves the
  // reviewed head and re-runs the checks itself. Building the tip here left
  // a preview of another commit than the head, rebuilt again on every look.
  const commitHash = importedHead
    || headSha
    || approvedHeadSha(session)
    || compare.commits[compare.commits.length - 1]?.sha
    || 'latest';

  // Create PR if missing (active-session recovery only). Route through
  // applyPrMetadata — NOT a bare createPR — so the PR gets a real
  // generated title/body and pr_title/session_title are persisted. A
  // bare createPR here used to mint PRs titled "Changes on <branch>"
  // with pr_title left NULL; the promote path then trusted pr_number's
  // presence and skipped its own metadata pass, so the throwaway title
  // stuck (the UI then renders its own "Change by <user>" NULL-fallback).
  //
  // #866: never for an imported row. It already HAS a PR (that's what it
  // tracks), and the platform doesn't own its branch — a missing pr_number
  // on an imported session is a broken row, not an invitation to open a
  // second PR from someone else's fork. The `imported` guard makes that
  // explicit rather than relying on pr_number always being set.
  if (!session.pr_number && !imported && !session.is_headless) {
    try {
      // username + latest user message give applyPrMetadata the same
      // signals the live dev-turn path has; without the username the
      // fallback title would read "undefined's changes".
      const { rows: ctxRows } = await pool.query(
        `SELECT u.username,
                (SELECT content FROM chat_session_messages
                  WHERE session_id = cs.id AND role = 'user'
                  ORDER BY id DESC LIMIT 1) AS last_user_message
           FROM chat_sessions cs LEFT JOIN users u ON u.id = cs.user_id
          WHERE cs.id = $1`,
        [session.id]
      );
      const username = ctxRows[0]?.username || session.username || 'someone';
      const recoveredUserMessage = ctxRows[0]?.last_user_message || '';
      const prMetadata = require('./pr-metadata');
      const limits = require('./limits');
      let metadataApiKey = null;
      let metadataGenerationAllowed = false;
      try {
        const billing = await limits.resolveBillingPath(
          pool, config.dataEncryptionKey, session.user_id,
        );
        if (!billing.error) {
          metadataApiKey = billing.apiKey;
          metadataGenerationAllowed = true;
        }
      } catch (err) {
        log.warn('staging-recovery', 'PR metadata billing resolve failed; using deterministic draft', {
          sessionId: session.id, err: err.message,
        });
      }
      await prMetadata.applyPrMetadata({
        pool, session, repoOwner: owner, repoName: repo,
        userMessage: recoveredUserMessage,
        ccSummary: '',
        username,
        apiKey: metadataApiKey,
        userId: session.user_id,
        allowModelGeneration: metadataGenerationAllowed,
        // Same as the promote-time lazy creation: an author-submitted title
        // names the recovered PR verbatim.
        preferredTitle: session.proposed_pr_title || null,
        broadcast: (event, data) =>
          broadcastGlobal({ ...data, type: 'session_event', sessionId: session.id, event }),
      });
    } catch (err) {
      log.warn('staging-recovery', 'Recovery PR creation via applyPrMetadata failed', {
        sessionId: session.id, code: err.code || null,
        ...require('./github').describeGithubError(err),
      });
    }
  }

  // The machine builds, checks and announces it (a Preview click on a
  // session whose machine serves nothing yet asks for the preview itself).
  if (reason === 'preview-click') {
    await workflow().request({ pool, session, head: commitHash, reason: 'ensure' });
  } else {
    await workflow().revision({ pool, session, head: commitHash, source: reason, trigger: checkTriggerForReason(reason) });
  }
  return 'handed_off';
}

// #461: a terminal, gate-passing 'skipped' checks verdict (with its reason)
// for a session whose checks genuinely cannot / need not run. The preview
// machine records it, tells open clients and re-drives the merge, exactly as
// it would on 'passing'. Best-effort: never throws.
async function recordChecksSkipped({ session, commitSha, reason }) {
  await workflow().skipped({ session, head: commitSha, reason }).catch((err) =>
    log.warn('staging-recovery', 'Could not hand the skipped verdict to the preview machine', {
      sessionId: session.id, err: err.message,
    }));
}

// The head a person's recheck of `session` is for, from its row as it is
// now (recheckHeadSha: a promoted proposal's reviewed head, a CLI hand-off's,
// else the checks pin), or the caller's copy when the row cannot be read.
async function requestedRecheckHead(pool, session) {
  let current = session;
  try {
    const { rows: [pins] } = await pool.query(
      `SELECT status, source, reviewed_head_sha, imported_pr_head_sha, checks_commit_sha, handoff_head_sha
         FROM chat_sessions WHERE id = $1`, [session.id]);
    if (pins) current = { ...session, ...pins };
  } catch { /* the caller's copy */ }
  return recheckHeadSha(current) || current.checks_commit_sha || null;
}

// #447: reconcile a single session's proposal checks. Used by the manual
// "Re-run checks" endpoint and the boot-time / periodic stale-check sweep.
// The machine decides between a run against what serves and a new build. A
// deferred head that merges cleanly now resumes its own episode.
async function recheckSessionChecks({ pool, session, reason }) {
  if (reason === 'conflict-resolved' && session.checks_commit_sha && await workflow().held(session.id)) {
    await require('../workflow/platform.ts').conflictResolved(Number(session.id), Number(session.app_id), session.checks_commit_sha);
    return 'handed_off';
  }
  if (checkTriggerForReason(reason) === 'manual-recheck') {
    // A person asked for the suite to run again: the head is owed a unit
    // suite that really runs (services/unit-suite-reuse.js). Recorded on the
    // head the recheck is for, read from the row now (a caller's copy, and
    // its checks pin, can name an older head). The machine records it again,
    // under the row's lock, on the head of a build or run the request joins.
    await require('./unit-suite-reuse').markFreshOwed(pool, {
      sessionId: session.id, commitSha: await requestedRecheckHead(pool, session),
    });
  }
  await workflow().recheck({ pool, session, reason, trigger: CHECK_TRIGGER_BY_REASON.get(reason) || null,
    system: !FORCED_RECHECK_REASONS.has(reason) && reason !== 'preview-click' });
  return 'handed_off';
}

module.exports = {
  DEFAULT_CHECKS_STALE_MS,
  checksStaleMs,
  checkRunOverdue,
  isStuckCheckRecoveryScope,
  errorWithinAutoRetries,
  ROLLOUT_RETRY_DETAIL,
  stagingNeedsRebuild,
  lookForLostPreviews,
  inspectPreviewRuntime,
  previewIsOfAnotherCommit,
  recheckHeadSha,
  approvedHeadSha,
  checkTriggerForReason,
  rebuildSessionStaging,
  recheckSessionChecks,
  requestedRecheckHead,
  recordChecksSkipped,
};
