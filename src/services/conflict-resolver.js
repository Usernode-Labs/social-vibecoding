const log = require('./logger');
const github = require('./github');
const limits = require('./limits');
const { runSyncMain, persistConflictState } = require('./sync-main');

const { getPool } = require('../db/pool');

// GitHub computes PR mergeability asynchronously: for a few seconds
// after the base branch (main) changes it returns `mergeable: null`
// while a background job recomputes. The old resolver checked once,
// immediately, un-awaited, and treated `null` as "nothing to do" — so
// it almost always no-op'd right after a merge. We now poll until the
// value settles before deciding.
const MERGEABLE_POLL_TRIES = parseInt(process.env.CONFLICT_MERGEABLE_POLL_TRIES, 10) || 6;
// Env-overridable so tests can drop it to 0 (the default 2s × up to 5
// sleeps would make the suite crawl).
const MERGEABLE_POLL_DELAY_MS = Number.isFinite(parseInt(process.env.CONFLICT_MERGEABLE_POLL_DELAY_MS, 10))
  ? parseInt(process.env.CONFLICT_MERGEABLE_POLL_DELAY_MS, 10)
  : 2000;

// Post-sync gate: after the worker pushes the integration commit (or for
// an already-clean branch) we must wait for GitHub to report
// `mergeable === true` BEFORE calling pulls.merge. Right after a push,
// GitHub flips mergeable to null while it recomputes; merging in that
// window 405s with "Pull Request has merge conflicts" even though the
// branch is clean. This is exactly the 405 we hit on the first #25/#26
// run. A longer, true-only wait closes it.
const MERGEABLE_TRUE_TRIES = parseInt(process.env.CONFLICT_MERGEABLE_TRUE_TRIES, 10) || 8;
const MERGEABLE_TRUE_DELAY_MS = Number.isFinite(parseInt(process.env.CONFLICT_MERGEABLE_TRUE_DELAY_MS, 10))
  ? parseInt(process.env.CONFLICT_MERGEABLE_TRUE_DELAY_MS, 10)
  : 2500;
// Give GitHub a beat to invalidate the pre-push mergeable cache before
// we start polling, so we don't read a stale `true`.
const MERGEABLE_AFTER_PUSH_INITIAL_MS = Number.isFinite(parseInt(process.env.CONFLICT_MERGEABLE_AFTER_PUSH_INITIAL_MS, 10))
  ? parseInt(process.env.CONFLICT_MERGEABLE_AFTER_PUSH_INITIAL_MS, 10)
  : 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseRepo(repoUrl) {
  const [, owner, repo] = (repoUrl || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/) || [];
  return owner && repo ? { owner, repo } : null;
}

// Poll GitHub until it has computed PR mergeability. Returns the final
// boolean (`true` mergeable / `false` conflicting) or `null` if it
// never settled within the budget. Throws are surfaced to the caller.
async function pollMergeable(owner, repo, prNumber) {
  // getOctokit (PAT-preferred), NOT getInstallationOctokit: the
  // self-app's repo owner (e.g. Usernode-Labs) has no GitHub App
  // installation, so the installation path throws on every poll and
  // the resolver flies blind on exactly the PR class (selfHosted)
  // where a wrong merge decision hurts most. mergePR already goes
  // through the PAT path; mergeability reads must match.
  const octokit = await github.getOctokit(owner);
  for (let i = 0; i < MERGEABLE_POLL_TRIES; i++) {
    const { data: pr } = await octokit.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}',
      { owner, repo, pull_number: prNumber }
    );
    if (pr.mergeable === true || pr.mergeable === false) return pr.mergeable;
    if (i < MERGEABLE_POLL_TRIES - 1) {
      await sleep(MERGEABLE_POLL_DELAY_MS);
    }
  }
  return null;
}

// Wait specifically for `mergeable === true` (clean) before a merge
// attempt. Returns true (clean), false (GitHub still sees a real
// conflict), or null (never finished recomputing within budget — caller
// should NOT merge, to avoid the null-window 405). `afterPush` adds a
// short initial delay so we don't read the stale pre-push value.
async function waitForMergeableTrue(owner, repo, prNumber, { afterPush = false } = {}) {
  // PAT-preferred for the same reason as pollMergeable above.
  const octokit = await github.getOctokit(owner);
  if (afterPush && MERGEABLE_AFTER_PUSH_INITIAL_MS > 0) {
    await sleep(MERGEABLE_AFTER_PUSH_INITIAL_MS);
  }
  for (let i = 0; i < MERGEABLE_TRUE_TRIES; i++) {
    const { data: pr } = await octokit.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}',
      { owner, repo, pull_number: prNumber }
    );
    if (pr.mergeable === true) return true;
    if (pr.mergeable === false) return false;
    if (i < MERGEABLE_TRUE_TRIES - 1) {
      await sleep(MERGEABLE_TRUE_DELAY_MS);
    }
  }
  return null;
}

// Re-fetch a session joined with its app so callers always work from a
// fresh row (status / behind_main / votes may have moved since the
// trigger fired).
async function loadSession(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT cs.*, a.slug AS app_slug, a.repo_url, a.name AS app_name,
            a.self_hosted AS app_self_hosted
     FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
     WHERE cs.id = $1`,
    [sessionId]
  );
  return rows[0] || null;
}

// App-level single-flight: at most ONE resolve+merge runs per app at a
// time. Direct votes (routes/votes.js behind_main / conflict paths), the
// post-merge sibling sweep, and the drift poller ALL funnel through here,
// so concurrent triggers for the same app coalesce into one sequential
// drain instead of spinning up N parallel worker syncs against the same
// main. That parallelism was both a budget sink (N concurrent system-token
// syncs) and wasted work — the instant one PR merges, the others are
// behind again and their just-finished sync is stale. Serializing here is
// what makes "one proposal at a time per app" actually hold across every
// trigger, not just the post-merge cascade.
const _appDraining = new Map(); // appId -> Promise (in-flight drain)
const _appRekick = new Set();   // appId -> a re-evaluation was requested mid-drain

// True while a resolve/merge drain is running for the app. Per-session
// state still lives in isResolving / _inFlightResolves.
function isAppResolving(appId) {
  return _appDraining.has(appId);
}

// Entry point for every resolve trigger. `trigger.app_id` is required;
// `trigger.excludeSessionId` (or legacy `trigger.id`) skips the just-merged
// session so the post-merge sweep never re-picks it. If a drain is already
// running for the app we flag a re-kick (the running drain re-queries each
// pass and the teardown re-fires if a trigger raced in) and return its
// promise rather than starting a concurrent resolve.
async function checkAndResolveConflicts(config, trigger) {
  const appId = trigger && trigger.app_id;
  if (appId == null) return;

  if (_appDraining.has(appId)) {
    _appRekick.add(appId);
    return _appDraining.get(appId);
  }

  const excludeId = trigger.excludeSessionId != null
    ? trigger.excludeSessionId
    : (trigger.id || 0);

  const run = drainApp(config, appId, excludeId)
    .catch((err) => log.error('conflict', 'drainApp threw', { appId, err: err.message }))
    .finally(() => {
      _appDraining.delete(appId);
      // A trigger that raced in during teardown starts a fresh drain so it
      // isn't dropped.
      if (_appRekick.delete(appId)) {
        checkAndResolveConflicts(config, { app_id: appId }).catch((err) => {
          log.error('conflict', 'drain re-kick failed', { appId, err: err.message });
        });
      }
    });
  _appDraining.set(appId, run);
  return run;
}

// Resolve eligible promoted PRs for one app sequentially — ONE at a time —
// until none remain. Each successful resolve+merge re-fires
// checkAndResolveConflicts (routes/votes.js); because a drain is already
// running that just flags a re-kick, and this loop's next pass picks the
// next eligible sibling. A PR that does NOT merge this pass (unresolved
// conflict, awaiting GitHub recompute, over budget) is recorded in
// `attempted` so the loop moves on instead of re-picking it forever; it's
// healed by the next externally-triggered drain (a fresh vote / drift
// redeploy). The eligibility bar is the same active-user majority
// checkAndMerge gates the actual merge on, so we only ever touch a PR that
// is genuinely ready to merge — nothing below threshold is resolved
// pre-emptively (#380).
//
// #391: the drain runs in TWO phases so a blocked PR never holds up clean
// siblings behind it. Phase 1 merges every directly-mergeable eligible PR
// first (vote-priority order); a PR that needs a worker sync is set aside
// (`mergeOnly:true` → 'deferred_needs_sync') instead of syncing inline.
// Phase 2 then resolves those deferred (blocked) PRs — sync allowed — in
// the order Phase 1 visited them. Before #391 the highest-voted PR was
// always attempted first AND its (potentially minutes-long) worker sync ran
// inline inside the single-flight drain, freezing clean lower-voted PRs
// behind it.
async function drainApp(config, appId, excludeId) {
  const pool = getPool(config);
  const attempted = [];
  const deferred = [];

  // Phase 1: merge directly-mergeable eligible PRs, never running a worker
  // sync.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    _appRekick.delete(appId);

    // #646: governance-aware eligibility. Under the default settings
    // this is the old active-user electorate + raw tallies; under
    // 'invited' only approver votes qualify; under at-least-N the gate
    // is the clock-free approval count.
    const governance = require('./governance');
    const gov = await governance.getGovernance(pool, appId);
    const electorate = await governance.getElectorate(pool, appId, gov);
    // Highest-voted eligible promoted sibling, excluding the just-merged
    // trigger ($2) and any PR already attempted this drain ($3); tie-break
    // longest-waiting (promoted_at ASC NULLS LAST) then created_at for
    // determinism. #391: a leading sort key floats PRs the DB already knows
    // are unblocked (behind_main = 0 AND no conflict/failed/resolving
    // snapshot) ahead of known-blocked ones, so clean PRs are attempted —
    // and merged — before any blocked sibling is even touched. NULL
    // merge_conflict_state (never checked) counts as clean.
    //
    // Eligibility is the dynamic merge gate (services/active-users.js
    // mergeGate), NOT the fixed majority: threshold path (eased Yes count +
    // elapsed visibility window) or lazy-consensus path (unopposed Yes lead
    // whose count-based clock has elapsed — silence is consent). A clock-
    // gated PR isn't attempted until its window elapses. The gate helpers
    // are JS, so candidates are fetched and the gate is applied here;
    // checkAndMerge re-validates the same gate before actually merging.
    const { rows: candidates } = await pool.query(
      `SELECT cs.id, cs.promoted_at, cs.created_at,
              ((cs.behind_main IS NULL OR cs.behind_main = 0)
                AND COALESCE(cs.merge_conflict_state, 'clean') NOT IN ('conflict', 'failed', 'resolving')
                AND COALESCE(cs.check_state, '') IN ('passing', 'skipped')) AS unblocked,
              (SELECT COUNT(*)::int FROM pr_votes WHERE session_id = cs.id AND vote = 'yes') AS yes_count,
              (SELECT COUNT(*)::int FROM pr_votes WHERE session_id = cs.id AND vote = 'no')  AS no_count
       FROM chat_sessions cs
       WHERE cs.app_id = $1 AND cs.status = 'promoted' AND cs.id != $2
         AND NOT (cs.id = ANY($3::int[]))`,
      [appId, excludeId, attempted]
    );
    const toMs = (v) => {
      if (v == null) return null;
      if (v instanceof Date) return v.getTime();
      if (typeof v === 'number') return v;
      const ms = Date.parse(v);
      return Number.isFinite(ms) ? ms : null;
    };
    const qualifiedByRow = electorate.approverIds
      ? await governance.qualifiedCountsBatch(
        pool, 'pr', candidates.map((r) => r.id), electorate.approverIds
      )
      : null;
    const rows = candidates
      .filter((r) => {
        const q = qualifiedByRow
          ? (qualifiedByRow.get(r.id) || { yes: 0, no: 0 })
          : { yes: r.yes_count, no: r.no_count };
        return governance.computeGate(
          gov, electorate.active, q.yes, q.no, r.promoted_at || r.created_at
        ).mergeable;
      })
      .sort((a, b) => {
        if (a.unblocked !== b.unblocked) return a.unblocked ? -1 : 1;
        if (b.yes_count !== a.yes_count) return b.yes_count - a.yes_count;
        const ap = toMs(a.promoted_at), bp = toMs(b.promoted_at);
        if (ap == null && bp != null) return 1; // NULLS LAST
        if (ap != null && bp == null) return -1;
        if (ap != null && bp != null && ap !== bp) return ap - bp; // ASC
        return (toMs(a.created_at) || 0) - (toMs(b.created_at) || 0); // ASC
      })
      .slice(0, 1);

    if (!rows.length) {
      // Nothing eligible right now. If a trigger arrived mid-pass (e.g. a
      // vote just pushed a sibling over threshold) loop again to pick it up;
      // otherwise Phase 1 is complete.
      if (_appRekick.has(appId)) continue;
      break;
    }

    const { id } = rows[0];
    // Don't re-pick this PR this pass regardless of outcome: a merge removes
    // it from 'promoted'; a non-merge means it's stuck for now.
    attempted.push(id);
    try {
      const result = await resolveAndMaybeRetry(config, { sessionId: id }, { mergeOnly: true });
      // #391: needs a worker sync — set it aside for Phase 2 so it doesn't
      // block clean siblings still queued behind it.
      if (result && result.reason === 'deferred_needs_sync') deferred.push(id);
    } catch (err) {
      log.error('conflict', 'resolveAndMaybeRetry (phase 1) failed', { sessionId: id, err: err.message });
    }
  }

  // Phase 2: every directly-mergeable PR is merged; now resolve the deferred
  // (blocked) PRs with the worker sync allowed, in Phase 1's visit order
  // (vote-priority). A PR that still can't merge stays 'promoted' and is
  // healed by the next externally-triggered drain (fresh vote / drift sweep).
  for (const id of deferred) {
    try {
      await resolveAndMaybeRetry(config, { sessionId: id }, { mergeOnly: false });
    } catch (err) {
      log.error('conflict', 'resolveAndMaybeRetry (phase 2) failed', { sessionId: id, err: err.message });
    }
  }
}

// Sync one promoted PR with main via the worker when it's drifted /
// conflicting, then — once GitHub confirms the branch is mergeable —
// re-attempt the merge for an already-approved PR. Also merges an
// already-clean approved PR that was left stuck (e.g. a prior merge
// 405'd in GitHub's post-push mergeable-recompute window).
//
// `target` is either { session } (a pre-loaded joined row) or
// { sessionId } (we'll load it). Returns a small status object; never
// throws (logs + group-chat on failure).
//
// Per-session coalescing: this is fired from multiple places that can
// overlap on the SAME session — an explicit trigger and the post-merge
// sibling sweep, or two sweeps from back-to-back merges. Two concurrent
// resolves for one session both call runSyncMain(id), and the second
// hits the worker's "a turn is already in flight for session N" guard
// (the exact error seen on the whiteboard #26 run). We dedupe by
// sessionId so concurrent callers share one in-flight resolve (and thus
// one worker turn / one merge attempt) and receive the same result.
const _inFlightResolves = new Map(); // sessionId -> Promise<result>

// Process-local "is a resolve currently in flight for this session?" —
// authoritative because the platform runs as a single Node process.
// Read by GET /api/sessions/:id/status (the banner's reload-recovery
// poll) and GET /api/apps/:slug/promoted (the vote-panel badge).
function isResolving(sessionId) {
  return _inFlightResolves.has(sessionId);
}

// #239: map the inner resolve's exit `reason` onto the coarse outcome
// the client banner switches on. `failed` covers every exit where the
// branch is still broken (or the sync never ran for a budget/error
// reason after a real conflict was detected); `synced` means the branch
// is fixed but the merge still needs votes; everything that did nothing
// user-visible is `noop`.
function resolutionOutcomeFor(reason) {
  if (reason === 'synced_and_merged' || reason === 'merged') return 'merged';
  if (reason === 'synced_awaiting_votes' || reason === 'mergeable_recompute_pending') return 'synced';
  if (['unresolved_conflict', 'sync_threw', 'still_conflicting', 'over_budget', 'retry_threw'].includes(reason)) {
    return 'failed';
  }
  return 'noop';
}

async function resolveAndMaybeRetry(config, target, options = {}) {
  const sessionId = target.sessionId != null ? target.sessionId : target.session?.id;
  if (sessionId != null && _inFlightResolves.has(sessionId)) {
    return _inFlightResolves.get(sessionId);
  }
  const p = resolveAndMaybeRetryInner(config, target, options);
  if (sessionId != null) {
    _inFlightResolves.set(sessionId, p);
    p.finally(() => {
      if (_inFlightResolves.get(sessionId) === p) _inFlightResolves.delete(sessionId);
    });
  }
  // #239: terminal lifecycle broadcast — exactly once per in-flight
  // resolve (deduped callers share `p`, so they share this too). The
  // inner resolve decorates its result with appSlug/selfHosted once the
  // session row is loaded; exits before that (session_not_found) carry
  // no appSlug and are skipped. Clients use this to clear the resolving
  // banner / vote-panel badge.
  p.then((result) => {
    if (!result || !result.appSlug) return;
    // #391: a Phase-1 mergeOnly deferral did no work and changed no state —
    // stay silent so it can't flash a stale badge. Phase 2 re-runs this same
    // session with sync allowed and owns its lifecycle broadcasts.
    if (result.reason === 'deferred_needs_sync') return;
    try {
      const { pushVoteUpdate } = require('./ws');
      const outcome = resolutionOutcomeFor(result.reason);
      // #361: map the terminal resolve outcome onto the persisted
      // merge-conflict snapshot so open cards update their badge without
      // a refetch. 'failed' covers every still-broken exit; 'merged'/
      // 'synced'/'noop' all leave the branch clean.
      const mergeConflictState = outcome === 'failed' ? 'failed' : 'clean';
      pushVoteUpdate({
        sessionId: result.sessionId != null ? result.sessionId : sessionId,
        appSlug: result.appSlug,
        resolving: false,
        resolutionOutcome: outcome,
        mergeConflictState,
        selfHosted: !!result.selfHosted,
      });
    } catch (_) { /* ws non-fatal */ }
  }).catch(() => { /* inner never throws by contract; belt-and-braces */ });
  return p;
}

async function resolveAndMaybeRetryInner(config, target, options = {}) {
  const pool = getPool(config);
  let session = target.session || null;
  if (!session) {
    session = await loadSession(pool, target.sessionId);
    if (!session) return { ok: false, reason: 'session_not_found' };
  }
  const result = await resolveWithSession(config, pool, session, options);
  // #239: decorate every loaded-session exit with the fields the
  // wrapper's terminal broadcast needs. Pre-loaded sessions from
  // checkAndMerge already carry app_slug / app_self_hosted; loadSession
  // selects them too.
  return {
    ...result,
    sessionId: session.id,
    appSlug: session.app_slug,
    selfHosted: !!session.app_self_hosted,
  };
}

// Map the inner resolve's exit `reason` onto a terminal /debug run status.
function resolutionRunStatus(reason) {
  if (reason === 'synced_and_merged' || reason === 'merged') return 'merged';
  if (reason === 'unresolved_conflict' || reason === 'still_conflicting') return 'conflict_failed';
  if (reason === 'mergeable_recompute_pending') return 'awaiting_github';
  if (reason === 'synced_awaiting_votes' || reason === 'awaiting_votes') return 'blocked';
  if (reason === 'over_budget' || reason === 'sync_threw' || reason === 'retry_threw') return 'error';
  return 'noop';
}

// Admin /debug wrapper. Lazily opens a 'conflict_resolution' run on the
// first step (so the no-op deferral / no_conflict early returns never spawn
// an empty run), threads its id into the worker sync + retry merge, and
// stamps a terminal status from the inner reason. The capture is
// fire-and-forget — a failure here never affects the resolve.
async function resolveWithSession(config, pool, session, options = {}) {
  const md = require('./merge-debug');
  const ctx = { runId: null, started: false };
  ctx.ensure = async () => {
    if (!ctx.started) {
      ctx.started = true;
      ctx.runId = await md.startRun(pool, {
        appId: session.app_id, sessionId: session.id, prNumber: session.pr_number,
        kind: 'conflict_resolution', trigger: options.trigger || 'conflict_resolver',
      });
    }
    return ctx.runId;
  };
  ctx.step = async (o) => { await ctx.ensure(); md.step(pool, ctx.runId, o); };
  const result = await resolveWithSessionInner(config, pool, session, options, ctx);
  if (ctx.started) {
    md.endRun(pool, ctx.runId, {
      status: resolutionRunStatus(result && result.reason),
      summary: result && result.reason ? `reason: ${result.reason}` : null,
    });
  }
  return result;
}

async function resolveWithSessionInner(config, pool, session, options = {}, ctx = { step: async () => {} }) {
  // #391: `mergeOnly` (Phase 1 of the drain) merges a PR only if it's
  // directly mergeable; one that needs a worker sync is deferred (no sync
  // run, no state change) so it can't block clean siblings. Phase 2 re-runs
  // with mergeOnly:false to actually resolve it.
  //
  // Force-carry-through: `force`/`forceBy` arrive when this resolve was
  // dispatched from an admin force-merge that hit a conflict (routes/
  // votes.js). The synced-branch retry below re-enters checkAndMerge, and
  // without the flag that retry would re-apply the vote gate the admin
  // explicitly bypassed — landing right back in "below threshold, not
  // merged" after a successful sync. The drain never sets these (its
  // triggers are all vote/sweep-driven), so normal resolution semantics
  // are unchanged.
  const { mergeOnly = false, force = false, forceBy = null } = options;
  if (!github.isEnabled() || !session.repo_url || !session.pr_number) {
    return { ok: false, reason: 'github_disabled_or_no_pr' };
  }
  if (session.status !== 'promoted') {
    // Only promoted PRs are candidates — anything else (active, merging,
    // merged) is either not up for a vote or already in flight.
    return { ok: false, reason: `status_${session.status}` };
  }

  const repo = parseRepo(session.repo_url);
  if (!repo) return { ok: false, reason: 'unparseable_repo' };

  // Decide whether a worker sync is needed: recorded drift, or GitHub
  // currently reporting a real conflict (mergeable === false) once its
  // computation settles.
  let mergeable0;
  try {
    mergeable0 = await pollMergeable(repo.owner, repo.repo, session.pr_number);
  } catch (err) {
    log.warn('conflict', 'pollMergeable failed', { sessionId: session.id, err: err.message });
    mergeable0 = null;
  }
  const behind = session.behind_main || 0;
  const needsSync = behind > 0 || mergeable0 === false;

  // #361/#384: persist a derived merge-conflict snapshot so proposal
  // cards reflect drift state. We deliberately do NOT write 'conflict'
  // here off a `mergeable0 === false` mergeability *check* — that's
  // speculative (no auto-merge was attempted), and #384 requires the
  // ⚠ warning to appear only after a real attempt failed. The 'conflict'
  // state is owned by the merge-time 405 path (routes/votes.js), and
  // 'failed' by an actual auto-resolve failure (services/sync-main.js);
  // the 'resolving' transition is written below as the turn runs. When
  // GitHub confirms the branch is mergeable we still record 'behind'
  // (informational, no warning) / 'clean', which also clears any stale
  // 'conflict'/'failed' snapshot once the branch merges again.
  if (mergeable0 === true) {
    await persistConflictState(pool, session, { state: behind > 0 ? 'behind' : 'clean', files: [] });
  }

  // #391: Phase 1 only merges directly-mergeable PRs. If this one needs a
  // worker sync, defer it WITHOUT touching GitHub, the worker, the budget,
  // any snapshot, or any broadcast — Phase 2 owns all of that. We do this
  // after the mergeable0===true snapshot above (a clean/behind 'clean'
  // write is correct and cheap) but before the sync gate, so a blocked PR
  // never holds a single-flight drain hostage to its sync.
  if (mergeOnly && needsSync) {
    return { ok: true, reason: 'deferred_needs_sync' };
  }

  let didSync = false;
  let syncResult = null;

  if (needsSync) {
    log.info('conflict', 'Conflict/drift detected, syncing PR with main', {
      sessionId: session.id, pr: session.pr_number, behind, mergeable0,
    });
    await ctx.step({ phase: 'pollMergeable', message: `GitHub mergeability settled: mergeable = ${mergeable0}.`, detail: { mergeable: mergeable0, behind } });
    await ctx.step({ phase: 'needs_sync', message: `Branch needs a worker sync with main (behind ${behind}${mergeable0 === false ? ', conflicting' : ''}).`, detail: { behind, mergeable: mergeable0 } });

    // #361: the worker sync draws from the dedicated "system tokens"
    // budget (platform housekeeping, not the owner's spend). Skip — and
    // surface it in group chat — when that budget is exhausted, so a
    // runaway conflict loop can't blow past the system cap. runSyncMain
    // re-checks the same gate at turn time.
    const sysBudget = await limits.checkSystemBudget(pool);
    if (sysBudget.error) {
      log.info('conflict', 'Skipped — system token budget exhausted', {
        sessionId: session.id, reason: sysBudget.error,
      });
      await postGroupMessage(pool, session,
        `Auto-conflict-resolution skipped on PR #${session.pr_number}: the system token budget is exhausted — resolve manually via "Sync with main" or wait for the midnight-UTC reset.`
      );
      await ctx.step({ phase: 'budget', level: 'error', message: 'Skipped — system token budget exhausted.', detail: { reason: sysBudget.error } });
      return { ok: false, reason: 'over_budget' };
    }

    // #239: start lifecycle broadcast — emitted only here, past the
    // needsSync + billing gates, so the frequent no-op sweeps (post-merge
    // sibling sweep / drift poller calls that find nothing to do) never
    // flash the resolving banner. Clients arm the non-blocking
    // "resolving merge conflicts" banner (self-hosted) and the
    // vote-panel badge off this.
    // #361: snapshot the in-flight state so a reload (or a card rendered
    // mid-resolve) shows the animated "Resolving conflicts…" badge.
    await persistConflictState(pool, session, { state: 'resolving', files: session.conflict_files || [] });
    await ctx.step({ phase: 'persist:resolving', message: 'Snapshot → resolving. Dispatching the worker sync with main.' });
    try {
      const { pushVoteUpdate } = require('./ws');
      pushVoteUpdate({
        sessionId: session.id,
        appSlug: session.app_slug,
        resolving: true,
        mergeConflictState: 'resolving',
        selfHosted: !!session.app_self_hosted,
      });
    } catch (_) { /* ws non-fatal */ }

    let sync;
    try {
      sync = await runSyncMain(config, pool, session.id, { sessionRow: session, trigger: 'conflict_resolver', debugRunId: ctx.runId });
    } catch (err) {
      log.error('conflict', 'runSyncMain threw', { sessionId: session.id, err: err.message });
      await postGroupMessage(pool, session,
        `Couldn't auto-resolve conflicts on PR #${session.pr_number} (sync failed: ${err.message}). Try "Sync with main" from the session's dev-chat.`
      );
      await ctx.step({ phase: 'sync_result', level: 'error', message: `Worker sync threw: ${err.message}` });
      return { ok: false, reason: 'sync_threw' };
    }
    didSync = true;
    syncResult = sync.syncResult;

    if (sync.syncResult === 'conflict') {
      const owner = session.user_id ? `<@${session.user_id}>` : 'the session owner';
      await postGroupMessage(pool, session,
        `PR #${session.pr_number} couldn't be auto-merged with main — Claude couldn't resolve the conflicts. ${owner}: open the session's dev-chat to resolve it.`
      );
      await ctx.step({ phase: 'sync_result', level: 'error', message: 'Claude could not resolve the conflicts; branch left unchanged.', detail: { syncResult: 'conflict', conflictFiles: sync.conflictFiles || sync.conflict_files || [] } });
      await ctx.step({ phase: 'group_chat', message: "Posted to group chat: couldn't auto-merge — owner must resolve in dev-chat.", detail: { reason: 'unresolved_conflict' } });
      return { ok: false, reason: 'unresolved_conflict' };
    }
    await ctx.step({ phase: 'sync_result', message: `Worker sync ${sync.syncResult}${sync.sha ? ` — pushed ${String(sync.sha).slice(0, 9)}` : ''}.`, detail: { syncResult: sync.syncResult, sha: sync.sha || null, behind: sync.behind } });
  } else if (mergeable0 !== true) {
    // No recorded drift and GitHub never settled to a definite state
    // (null). Nothing actionable — don't risk a 405 on an unknown state.
    return { ok: true, reason: 'no_conflict' };
  }

  // Before retrying the merge, wait for GitHub to confirm the branch is
  // mergeable. After our sync push it returns mergeable:null for a few
  // seconds; merging in that window 405s even though the branch is
  // clean (the failure mode on the first #25/#26 run).
  let mergeableNow;
  try {
    mergeableNow = await waitForMergeableTrue(repo.owner, repo.repo, session.pr_number, { afterPush: didSync });
  } catch (err) {
    log.warn('conflict', 'waitForMergeableTrue failed', { sessionId: session.id, err: err.message });
    mergeableNow = null;
  }

  if (didSync || mergeable0 === true) {
    await ctx.step({ phase: 'waitForMergeableTrue', message: `Waiting for GitHub to confirm mergeability… mergeable = ${mergeableNow}.`, detail: { mergeable: mergeableNow, afterPush: didSync } });
  }

  if (mergeableNow === false) {
    // GitHub still sees a real conflict (shouldn't happen right after a
    // resolved sync, but bail cleanly rather than 405).
    if (didSync) {
      const owner = session.user_id ? `<@${session.user_id}>` : 'the session owner';
      await postGroupMessage(pool, session,
        `PR #${session.pr_number} still conflicts with main after an auto-sync. ${owner}: open the session's dev-chat to resolve it.`
      );
    }
    return { ok: false, reason: 'still_conflicting', syncResult };
  }
  if (mergeableNow !== true) {
    // null: GitHub hasn't finished recomputing within our budget. Don't
    // risk the null-window 405 — the next vote or drift sweep retries.
    // Forced resolves get accurate guidance instead: a below-threshold PR
    // won't be picked up by any sweep, but the branch IS synced now, so a
    // second click of the admin merge button completes it.
    if (didSync) {
      await postGroupMessage(pool, session,
        force
          ? `PR #${session.pr_number} is synced with main and conflict-free — GitHub is still finalizing mergeability. Retry the admin merge to complete it.`
          : `PR #${session.pr_number} is synced with main and conflict-free — GitHub is still finalizing mergeability, the merge will complete on the next vote or sweep.`
      );
    }
    return { ok: true, reason: 'mergeable_recompute_pending', syncResult };
  }

  // mergeable === true → re-attempt the merge for an approved PR. Pass
  // autoResolve:false so checkAndMerge's own conflict paths don't
  // re-trigger us — bounds the resolve+retry to a single cycle.
  const fresh = await loadSession(pool, session.id);
  if (!fresh || fresh.status !== 'promoted') {
    return { ok: true, reason: 'no_longer_promoted', syncResult };
  }

  let mergeResult;
  try {
    const { checkAndMerge } = require('../routes/votes');
    // Pass our run id so the retry merge's gate/merge steps nest under this
    // conflict-resolution run instead of opening a second run. `force` and
    // `forceBy` ride along so an admin-forced merge that conflicted stays
    // forced on the post-sync retry (see the options doc at the top).
    mergeResult = await checkAndMerge(config, pool, fresh, {
      autoResolve: false, debugRunId: ctx.runId, force, forceBy,
    });
  } catch (err) {
    log.error('conflict', 'retry checkAndMerge threw', { sessionId: session.id, err: err.message });
    await ctx.step({ phase: 'retry_merge', level: 'error', message: `Retry merge threw: ${err.message}` });
    return { ok: true, reason: 'retry_threw', syncResult };
  }

  if (mergeResult?.merged) {
    await ctx.step({ phase: 'retry_merge', message: 'Re-attempted merge after sync — merged.', detail: { syncResult } });
    try {
      const { pushVoteUpdate } = require('./ws');
      pushVoteUpdate({ sessionId: fresh.id, appSlug: fresh.app_slug, merged: true });
    } catch (_) { /* ws non-fatal */ }
    return { ok: true, reason: didSync ? 'synced_and_merged' : 'merged', syncResult };
  }

  // Not merged — almost always "not enough yes votes yet". Only announce
  // when we actually synced, so the post-merge sibling sweep doesn't spam
  // vote-status lines for every clean-but-unapproved promoted PR.
  if (didSync && typeof mergeResult?.yesCount === 'number' && typeof mergeResult?.needed === 'number') {
    await postGroupMessage(pool, fresh,
      `PR #${fresh.pr_number} is now synced with main and conflict-free — ${mergeResult.yesCount}/${mergeResult.needed} yes votes needed to merge.`
    );
  }
  return { ok: true, reason: didSync ? 'synced_awaiting_votes' : 'awaiting_votes', syncResult };
}

async function postGroupMessage(pool, session, content) {
  try {
    const { sendSystemMessage } = require('./ws');
    await sendSystemMessage(pool, session.app_id, content, 'conflict');
  } catch (err) {
    log.warn('conflict', 'Failed to post group-chat message', { sessionId: session?.id, err: err.message });
  }
}

module.exports = { checkAndResolveConflicts, resolveAndMaybeRetry, pollMergeable, isResolving, isAppResolving };
