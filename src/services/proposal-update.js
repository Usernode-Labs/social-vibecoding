'use strict';

// ── Updating a proposal that is already up for a vote (#1054) ──────────
//
// Until this existed, a connector-submitted proposal was a one-shot: an agent
// pushed a branch to its own fork, Usernode copied that branch into the app's
// own repository and opened a pull request, and from then on the proposal
// tracked a BOT-OWNED branch the agent had no way to write to. The advice in
// get_proposal's own description — "fix the named tests and push again to the
// same branch" — was therefore false for exactly the proposals that most
// needed it: a failing check gates merge, and the agent that wrote the code
// could not land the one-line fix.
//
// So a proposal now has a stated BRANCH HOME, and when it is the app repo
// there is a path for its author to advance it:
//
//   the author pushes to their own fork, as always
//     → Usernode verifies the fork branch is theirs and sits AHEAD of the
//       proposal's current head
//     → Usernode pushes that branch onto the proposal's bot-owned branch
//       under a `--force-with-lease`, with the platform's own credentials
//     → the EXISTING head-moved machinery clears the votes, posts the
//       "please re-review" note and rebuilds the preview and the checks.
//
// Three properties this file exists to keep, all of them checked by
// tests/proposal-update.test.js:
//
//   1. NO USER GITHUB CREDENTIAL. The fork is read unauthenticated (it is
//      public) and the app repository is written with the platform's own bot
//      credential, resolved by services/external-agent-head.js exactly as
//      every other platform push resolves it. Nothing here asks for, stores
//      or forwards a token belonging to the user.
//   2. THE ATTRIBUTION GATE IS NEVER RELAXED. `verifyForkBranch` runs against
//      a FRESHLY READ `githubLink.linkStatus`, and `fork_owner` is that
//      linked login — never a value the caller passed in. It runs here for
//      the ancestry read and again inside `pushForkBranchToAppBranch`; there
//      is no path from a caller's arguments to a push that skips it.
//   3. NOTHING IS CLOBBERED. The push carries a lease pinned to the head this
//      call actually read from GitHub a moment earlier, so a proposal that
//      somebody else advanced in the meantime produces `branch_moved` rather
//      than a silently discarded revision.
//
// Deliberately NOT here: any call to services/sync-main.js's
// `recordPlatformPush`. The head this path installs is the AUTHOR'S work, so
// it must classify as an `author_push` and clear the tally. Recording it as a
// platform push would carry every existing approval onto code nobody in the
// group has read.

const log = require('./logger');
const externalAgentHead = require('./external-agent-head');
const { PROPOSAL_UPDATE_LOCK } = require('./advisory-locks');

const SHA_RE = /^[0-9a-f]{40}$/i;

// The two homes a proposal's head can live in. Derived, never stored: the
// source column has always said which, and a second column recording the
// same thing is a second thing to keep true.
//
//   'user_fork' — an IMPORTED pull request. Its head is a branch in the
//                 author's own fork and the platform only tracks it
//                 (`imported_pr_head_sha`); the author pushes to GitHub and
//                 the proposal follows.
//   'app_repo'  — every other source (a platform build, a CLI hand-off, a
//                 connector submission). The head is `branch_name` inside
//                 the app's own repository, and ONLY the platform bot can
//                 write it — which is why this file exists.
function branchHomeOf(session) {
  return String(session && session.source) === 'imported' ? 'user_fork' : 'app_repo';
}

// Can the author move this proposal's head with a plain `git push`? True for
// an imported PR (they own the branch) and false for a bot-owned branch,
// where the answer is "not directly — submit the fork branch instead".
function authorCanPush(session) {
  return branchHomeOf(session) === 'user_fork';
}

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

// `verifyForkBranch` and `pushForkBranchToAppBranch` speak the mirror path's
// vocabulary. This path's refusals are named for what the CALLER did wrong,
// so the two fork-shaped codes are renamed and everything else — including
// `branch_moved`, `invalid_request` and `platform_unavailable` — is passed
// through with its message intact.
function renameHeadFailure(result, branch) {
  if (result.code === 'fork_mismatch') {
    return fail(
      'not_your_fork',
      `${branch} was not found in a repository owned by the GitHub account linked to your Usernode profile. `
      + 'A proposal is only advanced from its author\'s own fork — push the branch to your fork and try again.',
      { retryable: false }
    );
  }
  if (result.code === 'branch_not_found') {
    return fail(
      'fork_branch_not_found',
      `Your fork has no branch called ${branch}. Push it first — GitHub creates branches on push, and Usernode `
      + 'reads it from your fork rather than from your machine.',
      { retryable: true }
    );
  }
  return fail(result.code, result.message, {
    ...(result.retryable ? { retryable: true } : {}),
  });
}

// ── The lock ───────────────────────────────────────────────────────────
//
// Two agents can hold the same proposal id: the coding agent that wrote the
// change and the chat assistant the user told about it. Without this they
// both read the same head, both pass the lease check, and the second push
// either loses its own commits or lands on a proposal whose votes were
// cleared for a revision that no longer exists.
//
// Keyed on the SESSION id, on a dedicated client, held across the whole
// update and released in `finally` — the same shape as
// external-agent-tasks.js's task lock, and for the same reason: a git fetch
// and push take seconds of network, and holding a transaction open across
// that is worse than the race it prevents. Degrades to running unlocked when
// the pool has no `connect()`, which is never a reason to refuse an update.
async function withProposalLock(pool, sessionId, fn) {
  const id = Number(sessionId);
  if (!Number.isSafeInteger(id) || id <= 0 || !pool || typeof pool.connect !== 'function') {
    return fn();
  }
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    log.warn('proposal-update', 'update lock unavailable, proceeding unlocked', {
      sessionId: id, err: err.message,
    });
    return fn();
  }
  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', [PROPOSAL_UPDATE_LOCK, id]);
    return await fn();
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [PROPOSAL_UPDATE_LOCK, id]);
    } catch { /* releasing the client drops the session lock anyway */ }
    client.release();
  }
}

// The proposal, re-read under the lock. The caller's copy was loaded before
// the queue, and in the seconds spent waiting it may have merged, closed, or
// moved its head — so every gate below is applied to THIS row. Best-effort:
// a read that fails leaves the caller's copy in place rather than refusing an
// update over a transient database hiccup.
async function reloadSession(pool, sessionId) {
  try {
    const { rows } = await pool.query(
      `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url,
              a.collab_visibility, a.view_visibility
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
        WHERE cs.id = $1`,
      [sessionId]
    );
    return rows[0] || null;
  } catch (err) {
    log.warn('proposal-update', 'proposal re-read failed, using the caller\'s snapshot', {
      sessionId, err: err.message,
    });
    return null;
  }
}

// How many votes the update is about to invalidate. Counted BEFORE the write,
// because both reconciliation paths delete the rows — and "your update
// cleared 4 votes" is the one consequence the caller must be able to relay to
// the user without guessing.
async function countVotes(pool, sessionId) {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM pr_votes WHERE session_id = $1`,
      [sessionId]
    );
    return Number(rows[0] && rows[0].n) || 0;
  } catch {
    return 0;
  }
}

// deps: { pool, config, gh, githubLink, head, votes, prImportSync,
//         githubPublic, serialize, busy, beginOperation }
//   Everything after `pool`/`config` is injectable purely so the tests can
//   drive this without a database, a git binary or a GitHub account; the
//   defaults are the real modules.
//
// params: { user, session, branch, forkRepo, expectedHeadSha, origin }
//   `session` is the joined chat_sessions row the route loaded and
//   access-checked. `branch` is the branch in the caller's OWN fork that
//   carries the new work. `forkRepo` is only its NAME, for an agent that
//   forked under a name the platform did not predict — the OWNER always
//   comes from the verified GitHub link.
async function updateProposalFromForkBranch(deps, params) {
  const { pool, config } = deps;
  const gh = deps.gh || require('./github');
  const githubLink = deps.githubLink || require('./github-link');
  const head = deps.head || externalAgentHead;
  const votes = deps.votes || require('../routes/votes');
  const prImportSync = deps.prImportSync || require('./pr-import-sync');
  const githubPublic = deps.githubPublic || require('./external-agent-tasks').githubPublic;
  const serialize = deps.serialize
    || require('./handoff-pipeline').serializeHandoffSubmission;

  const { user, origin } = params;

  // ── Argument shapes, before anything is read ─────────────────────────
  //
  // The branch name reaches a `git fetch` argv and the fork name reaches a
  // URL path, so both are validated by the same predicates the submit path
  // uses. One definition, in services/external-agent-head.js.
  const branch = params.branch ? String(params.branch).trim() : '';
  if (!head.validRef(branch)) {
    return fail('invalid_request', 'branch must be the git branch you pushed to your fork.');
  }
  const forkRepoName = params.forkRepo ? String(params.forkRepo).trim() : null;
  if (forkRepoName && !head.validSegment(forkRepoName)) {
    return fail('invalid_request', 'That fork name is not a valid GitHub repository name.');
  }
  const expectedHeadSha = params.expectedHeadSha
    ? String(params.expectedHeadSha).trim().toLowerCase()
    : null;
  if (expectedHeadSha && !SHA_RE.test(expectedHeadSha)) {
    return fail('invalid_request', 'expectedHeadSha must be a 40-character commit id.');
  }

  const gate = ownershipGate(params.session, user);
  if (gate) return gate;

  if (!gh.isEnabled()) {
    return fail('platform_unavailable', 'Usernode cannot reach GitHub right now. Try again shortly.', { retryable: true });
  }
  // An unconfigured deployment and an unlinked user are two different
  // refusals, and the deployment is checked first — otherwise an operator's
  // missing value is reported as the user's missing click.
  if (!githubLink.isEnabled(config)) {
    return fail(
      'github_link_unavailable',
      'This Usernode deployment has no GitHub OAuth app configured, so it cannot verify which GitHub account is '
      + 'yours — and a proposal is only advanced from its author\'s verified fork. Ask an admin to set '
      + 'GITHUB_LINK_CLIENT_ID and GITHUB_LINK_CLIENT_SECRET in the platform variables panel.',
      { retryable: false }
    );
  }

  // FRESHLY READ, every time, and the only source of the fork owner. A
  // linked account can be disconnected or re-linked to a different GitHub
  // login between the submission that opened this proposal and this update.
  const link = await githubLink.linkStatus(pool, user.id);
  if (!link || !link.linked || !link.login) {
    return fail(
      'github_not_linked',
      'Connect your GitHub account first: Usernode only advances a proposal from a fork it can confirm is yours.',
      { ...(origin ? { settingsUrl: `${origin}/#settings/connectors` } : {}) }
    );
  }

  const sessionId = Number(params.session.id);
  return serialize(sessionId, () => withProposalLock(pool, sessionId, async () => {
    // Everything from here on judges the row as it is NOW, not as it was
    // when the caller queued.
    const session = (await reloadSession(pool, sessionId)) || params.session;
    const reGate = ownershipGate(session, user);
    if (reGate) return reGate;

    const parsed = gh.parseGithubUrl(session.repo_url);
    if (!parsed) {
      return fail('no_repository', 'That app has no GitHub repository, so its proposals have no branch to advance.');
    }
    const { owner, repo } = parsed;
    const forkRepo = forkRepoName || repo;

    const busy = deps.busy || defaultBusyCheck;
    if (busy(session)) {
      return fail(
        'session_busy',
        'This proposal is in the middle of a build right now. Retry in a minute — pushing onto it mid-build '
        + 'would leave its preview and its checks describing two different commits.',
        { retryable: true }
      );
    }

    const beginOperation = deps.beginOperation
      || require('./active-workers').beginSessionOperation;
    const releaseOperation = beginOperation(sessionId);
    try {
      const ctx = {
        pool, config, gh, head, votes, prImportSync, githubPublic,
        session, owner, repo, forkOwner: link.login, forkRepo, branch,
        expectedLogin: link.login, expectedHeadSha, sessionId,
        // Carried through so the session tails' three real-work modules stay
        // injectable from the caller's deps — sessionParts() below fills in
        // the live modules for every key nobody overrode.
        visuals: deps.visuals,
        pipeline: deps.pipeline,
        lifecycle: deps.lifecycle,
        pushSessionUpdate: deps.pushSessionUpdate,
      };
      return branchHomeOf(session) === 'user_fork'
        ? await advanceForkHead(ctx)
        : await advanceAppRepoBranch(ctx);
    } finally {
      releaseOperation();
    }
  }));
}

// ── What a push may land on ────────────────────────────────────────────
//
// One predicate, three answers, and every caller shares it — the options menu
// (through describeTargetProposal), the ownership gate below, and the tails of
// advanceAppRepoBranch. That matters more than it looks: if the menu offered
// "continue this session" for a status the gate then refused, the user would
// have followed a button straight into an error, and a second copy of this
// list is exactly how that drifts into being.
//
//   'proposal' — promoted: up for a vote. A push moves it and CLEARS the votes
//                it has already collected.
//   'session'  — active or paused: still being built, nobody is voting on it,
//                so a push is just the next commit.
//   null       — everything else. merging/merged are frozen by definition, and
//                archived is an explicit put-away that a push must not
//                silently reopen.
function isContinuableStatus(status) {
  const s = status == null ? '' : String(status);
  if (s === 'promoted') return 'proposal';
  if (s === 'active' || s === 'paused') return 'session';
  return null;
}

// Whose proposal it is, and whether it can still take a revision. Applied
// twice — once cheaply before the queue and once under the lock — so a
// proposal that merged while the caller waited is refused rather than pushed
// onto.
function ownershipGate(session, user) {
  if (!session || !user || Number(session.user_id) !== Number(user.id)) {
    return fail(
      'not_your_proposal',
      'That proposal was not opened by you. Only its author advances it — anyone else contributes by opening '
      + 'their own proposal, which the group votes on separately.',
      { retryable: false }
    );
  }
  if (!isContinuableStatus(session.status)) {
    return fail(
      'proposal_closed',
      session.status === 'merging' || session.status === 'merged'
        ? 'That proposal has already passed its vote and is merging, so its code is frozen. Anything further is a '
          + 'new proposal — call prepare_work again.'
        : `That proposal is ${session.status || 'no longer open'}, so it cannot take a new revision. Open a new `
          + 'proposal with prepare_work.',
      { retryable: false }
    );
  }
  return null;
}

// Is the platform itself mid-write on this proposal? Same four questions the
// commit-upload route asks, and for the same reason: a staging build or a
// screenshot capture in flight is pinned to the CURRENT head, and moving the
// branch underneath it produces a preview of one commit labelled with
// another.
function defaultBusyCheck(session) {
  const { isSessionBusy } = require('./active-workers');
  const staging = require('./staging');
  const visuals = require('./visuals');
  const { hasInFlightHandoffPipeline } = require('./handoff-pipeline');
  const id = Number(session.id);
  return isSessionBusy(id)
    || hasInFlightHandoffPipeline(session.id)
    || staging.hasInFlightBuild(id)
    || visuals.hasInFlightCapture(session.id);
}

// ── The bot-owned branch ───────────────────────────────────────────────
//
// The case this whole change exists for. The proposal's head is a `dev/…`
// branch in the app's own repository that only the platform can write, so
// the author's commits are copied onto it with the platform's credential and
// under a lease.
async function advanceAppRepoBranch(ctx) {
  const {
    pool, config, gh, head, votes, githubPublic, session,
    owner, repo, forkOwner, forkRepo, branch, expectedLogin, expectedHeadSha, sessionId,
  } = ctx;
  // The session tails talk to three modules that do real work — a staging
  // build, a container teardown, a websocket fan-out. Injectable for the same
  // reason `votes` and `head` are: a test about which tail ran must not have
  // to start a container to find out.
  const parts = sessionParts(ctx);

  const targetBranch = session.branch_name;
  if (!targetBranch || !head.validRef(targetBranch)) {
    return fail(
      'platform_unavailable',
      'Usernode cannot tell which branch this proposal lives on, so it will not push anything. Its author can '
      + 'still open a new proposal.',
      { retryable: false }
    );
  }

  // The head as GITHUB has it, read now. Both the ancestry base and the
  // push's lease come from this one value: a lease pinned to anything the
  // caller supplied would be a lease against the caller's own belief.
  let liveHead;
  try {
    liveHead = await gh.getBranchSha(owner, repo, targetBranch);
  } catch (err) {
    log.warn('proposal-update', 'could not read the proposal branch head', {
      sessionId, targetBranch, err: err.message,
    });
    return fail('platform_unavailable', 'Usernode could not read this proposal\'s current commit. Try again shortly.', { retryable: true });
  }
  if (!liveHead || !SHA_RE.test(String(liveHead).trim())) {
    return fail('platform_unavailable', 'Usernode could not read this proposal\'s current commit. Try again shortly.', { retryable: true });
  }
  liveHead = String(liveHead).trim().toLowerCase();
  if (expectedHeadSha && expectedHeadSha !== liveHead) {
    return movedError(liveHead);
  }

  // THE ATTRIBUTION GATE. Run here for the ancestry comparison, and again
  // inside pushForkBranchToAppBranch immediately before the push — the
  // second run is the load-bearing one, and this one is not permitted to
  // replace it.
  const verified = await head.verifyForkBranch({
    githubPublic, forkOwner, forkRepo, branch, expectedLogin,
  });
  if (!verified.ok) return renameHeadFailure(verified, branch);

  if (verified.headSha === liveHead) return unchanged(session, liveHead, 'update_branch');

  const ancestry = await checkAncestry({ gh, owner, repo, base: liveHead, head: verified.headSha, branch });
  if (ancestry) return ancestry;

  // Which of the three tails this push takes, decided from the row read UNDER
  // the lock — `params.session` is the caller's snapshot and may be minutes
  // old, which is long enough for a proposal to have been promoted or a
  // session to have been paused.
  const kind = isContinuableStatus(session.status);
  const promoted = kind === 'proposal';

  // Votes exist only on a proposal that is up for a vote, and the count has to
  // happen BEFORE the write that deletes them. A session nobody is voting on
  // has nothing to count and nothing to clear.
  const votesCleared = promoted ? await countVotes(pool, sessionId) : 0;

  const pushed = await head.pushForkBranchToAppBranch({
    githubPublic, owner, repo, forkOwner, forkRepo, branch, expectedLogin,
    targetBranch, expectedRemoteSha: liveHead, sessionId,
  });
  if (!pushed.ok) return renameHeadFailure(pushed, branch);

  // Everything the three tails agree on. They differ only in what they do to
  // the session afterwards and in the three booleans that describe it.
  const landed = {
    ok: true,
    updated: true,
    proposalId: sessionId,
    appSlug: session.app_slug || null,
    prNumber: session.pr_number || null,
    prUrl: session.pr_url || null,
    branchHome: 'app_repo',
    branch: targetBranch,
    headSha: verified.headSha,
    previousHeadSha: liveHead,
    // What this push actually landed on, decided here and not by the work
    // order — which was written before the agent started and may be an hour
    // out of date. `submittedVia` stays 'update_branch' in all three: the
    // schema's widened CHECK already allows it and a third value would need a
    // migration for no gain.
    targetKind: promoted ? 'proposal' : 'session',
    submittedVia: 'update_branch',
  };

  // ── Tail 2: an ACTIVE session (#1071) ───────────────────────────────
  //
  // No votes, no re-review note, no reconciliation — nobody is voting on it.
  // What it needs is the thing a native session gets after every other commit:
  // its checks marked pending against the new head and the staging pipeline
  // started, so its preview describes the code that just arrived.
  if (kind === 'session' && session.status === 'active') {
    const settled = await settleActiveSession({
      config, pool, session, sessionId, headSha: verified.headSha, parts,
    });
    log.info('proposal-update', 'advanced an active session from its author\'s fork', {
      sessionId, owner, repo, targetBranch, previousHeadSha: liveHead,
      headSha: verified.headSha, rebuilding: settled.rebuilding,
    });
    return {
      ...landed,
      votesCleared: 0,
      checksRerun: settled.rebuilding,
      previewRebuilding: settled.rebuilding,
      ...(settled.rebuilding ? {} : { resumeRequired: true }),
    };
  }

  // ── Tail 3: a PAUSED session (#1071) ────────────────────────────────
  //
  // The commit is welcome; the build is not. A paused session has no
  // container, and handoff-pipeline's persistence UPDATE is scoped to
  // `status = 'active'` — so starting the pipeline here would build a preview,
  // fail to attach it, and then discard it. Instead: forget the verdict that
  // described the OLD commit (a green tick beside code nobody has run is
  // worse than no tick), tear the stale preview down, and tell the caller the
  // session has to be reopened for the rest to happen.
  if (kind === 'session') {
    await settlePausedSession({ pool, session, sessionId, parts });
    log.info('proposal-update', 'advanced a paused session from its author\'s fork', {
      sessionId, owner, repo, targetBranch, previousHeadSha: liveHead,
      headSha: verified.headSha,
    });
    return {
      ...landed,
      votesCleared: 0,
      checksRerun: false,
      previewRebuilding: false,
      resumeRequired: true,
    };
  }

  // ── Tail 1: the existing machinery, unchanged ───────────────────────
  //
  // Nothing about clearing votes, posting the re-review note or rebuilding
  // the preview is reimplemented here: the branch moved, and the platform
  // already has one place that reconciles a moved native head.
  // `fresh: true` makes it re-read GitHub rather than trust the stored pin.
  //
  // And no `recordPlatformPush` call anywhere above — which is exactly what
  // makes classifyNativeHeadMove see an `author_push` and DELETE the tally
  // instead of carrying it onto code the group has not read.
  let reconciled = null;
  try {
    reconciled = await votes.reconcileNativeReviewedHead({
      config, pool, session, fresh: true, notify: true,
    });
  } catch (err) {
    // The push landed. A reconciliation that failed is caught up by the next
    // vote (every vote reconciles first), so this is reported as a completed
    // update with an unknown vote effect rather than as a failure — the
    // alternative tells the author their work did not arrive when it did.
    log.error('proposal-update', 'head-move reconciliation failed after a successful push', {
      sessionId, err: err.message,
    });
  }
  // Boolean, not the truthy value: `checksRerun` and `previewRebuilding` are
  // reported to a client that branches on them, and `null` is neither answer.
  const settled = !!(reconciled && reconciled.updated === true);

  log.info('proposal-update', 'advanced a proposal from its author\'s fork', {
    sessionId, owner, repo, targetBranch, previousHeadSha: liveHead,
    headSha: verified.headSha, votesCleared: settled ? votesCleared : 0,
  });

  return {
    ...landed,
    // Honest about what actually happened: the votes were counted before the
    // write and are only reported cleared when the reconciliation that
    // clears them ran.
    votesCleared: settled ? votesCleared : 0,
    checksRerun: settled,
    previewRebuilding: settled,
  };
}

// The active-session tail, in the words the rest of the platform uses for the
// same moment (see routes/proposal-handoff.js's submit_build): pin the checks
// to the new head, clear the old verdict, drop the pointers to the preview
// that described the previous commit, then run the SAME staging pipeline every
// other native commit runs, detached from this request.
//
// Returns { rebuilding } — false when the session stopped being active between
// the lock and here, which is the one case where the commit landed and the
// build deliberately did not.
// The three modules the session tails reach for, resolved once. Every one is
// overridable through ctx, and the defaults are the real ones — so production
// behaviour needs no wiring at the call sites and a test needs no container.
function sessionParts(ctx) {
  const c = ctx || {};
  return {
    visuals: c.visuals || require('./visuals'),
    pipeline: c.pipeline || require('./handoff-pipeline'),
    lifecycle: c.lifecycle || require('./session-lifecycle'),
    // A function rather than the module: ws is required lazily elsewhere in
    // this file for the same reason — it pulls in the server's socket state.
    pushSessionUpdate: c.pushSessionUpdate
      || ((payload) => require('./ws').pushSessionUpdate(payload)),
  };
}

async function settleActiveSession({ config, pool, session, sessionId, headSha, parts }) {
  const { visuals, pipeline } = parts;
  const { beginHandoffPipeline, startHandoffPipeline, OWNED_SOURCE_SQL } = pipeline;

  // Guarded on `status = 'active'`: a manual pause or archive between the
  // ownership gate and here is allowed to win, and it must not be undone by a
  // write that re-arms a check pipeline for a session that is no longer live.
  // Guarded on `checks_commit_sha` as well — the value read UNDER THE LOCK, so
  // a newer head that took the session while this push was in flight keeps it
  // rather than being regressed to an older commit's pending state.
  const adopted = await pool.query(
    `UPDATE chat_sessions
        SET check_state = 'pending', checks_commit_sha = $1,
            check_error_detail = NULL,
            staging_container_id = NULL, staging_url = NULL,
            last_activity_at = NOW()
      WHERE id = $2 AND status = 'active' AND ${OWNED_SOURCE_SQL}
        AND checks_commit_sha IS NOT DISTINCT FROM $3`,
    [headSha, sessionId, session.checks_commit_sha || null]
  );
  if (!adopted.rowCount) {
    await settlePausedSession({ pool, session, sessionId, parts });
    return { rebuilding: false };
  }

  const pending = await visuals.setChecksPending(pool, sessionId, headSha, 'building', 'commit-push')
    .catch((err) => {
      log.warn('proposal-update', 'setChecksPending failed (non-fatal)', { sessionId, err: err.message });
      return true;
    });
  if (pending === false) return { rebuilding: false };
  try { visuals.notifyChecksPending(sessionId, headSha, 'building', 'commit-push'); } catch { /* notify only */ }

  const app = {
    id: session.app_id,
    slug: session.app_slug,
    name: session.app_name,
    repo_url: session.repo_url,
  };
  const fresh = { ...session, checks_commit_sha: headSha };
  const releasePipeline = beginHandoffPipeline(sessionId);
  try {
    // Detached on purpose: the build and the visual capture take minutes, and
    // the caller is an HTTP request that has already been told the push
    // landed. startHandoffPipeline owns the release.
    startHandoffPipeline(config, pool, fresh, app, headSha, releasePipeline);
  } catch (err) {
    releasePipeline();
    log.error('proposal-update', 'could not start the staging pipeline after an update', {
      sessionId, headSha, err: err.message,
    });
    return { rebuilding: false };
  }
  return { rebuilding: true };
}

// The paused-session tail. Deliberately does NOT start the pipeline: a paused
// session is one nobody is watching, its preview has been reclaimed, and
// handoff-pipeline's persistence UPDATE only matches `status = 'active'` — so
// a build started here would run for minutes and then throw its own result
// away.
//
// What it MUST do is stop the old verdict from describing the new code.
// `checks_commit_sha` is left ALONE on purpose: it names the commit the last
// verdict was about, and the resume path compares it against the branch head
// to decide that a re-check is owed. Null it here and the session comes back
// looking like it had never been checked at all.
async function settlePausedSession({ pool, session, sessionId, parts }) {
  const { lifecycle: sessionLifecycle, pushSessionUpdate } = parts;
  // The same column list the CLI commit-upload route clears for a commit
  // nothing has run yet, minus the 'pending' verdict itself — nothing IS
  // running, and a 'pending' no pipeline will ever resolve is a spinner
  // forever. NULL check_state is the honest "no verdict for the current code",
  // and it blocks merge, which is the correct answer here.
  await pool.query(
    `UPDATE chat_sessions
        SET check_state = NULL, check_phase = NULL,
            check_error_detail = NULL, check_error_notified_at = NULL,
            check_next_retry_at = NULL,
            test_results = '[]'::jsonb, checks_checked_at = NULL,
            consecutive_check_failures = 0,
            first_check_failure_at = NULL, last_check_failure_at = NULL,
            capture_state = NULL, capture_detail = NULL, captured_at = NULL,
            last_activity_at = NOW()
      WHERE id = $1 AND status = 'paused'`,
    [sessionId]
  ).catch((err) => log.warn('proposal-update', 'could not clear the stale verdict', {
    sessionId, err: err.message,
  }));

  // Best effort: a leaked container is retried by the stale-preview sweeper
  // through the same chokepoint, and a teardown failure must not be reported
  // as a failed update — the commit is already on the branch.
  await sessionLifecycle.teardownStagingForSession({
    pool, sessionId, reason: 'external_update',
  }).catch((err) => log.warn('proposal-update', 'staging teardown after an update failed (non-fatal)', {
    sessionId, err: err.message,
  }));

  try {
    pushSessionUpdate({
      action: 'session_update', sessionId, appSlug: session.app_slug || null,
    });
  } catch (err) {
    log.warn('proposal-update', 'session-update notify failed (non-fatal)', { sessionId, err: err.message });
  }
}

// ── The imported pull request ──────────────────────────────────────────
//
// Here the author already has write access to the head — it is a branch in
// their own fork — so there is nothing to push. Their push IS the update;
// this only advances the head the platform TRACKS, which is what clears the
// votes and rebuilds the checks. Calling it is still worth it: the sweeper
// would get there eventually, and "eventually" is minutes of the group
// voting on a revision that no longer exists.
async function advanceForkHead(ctx) {
  const {
    pool, config, gh, head, prImportSync, githubPublic, session,
    owner, repo, forkOwner, forkRepo, branch, expectedLogin, expectedHeadSha, sessionId,
  } = ctx;

  // #1071 widened the ownership gate to active and paused sessions, and every
  // one of those is a NATIVE session whose branch lives in the app repo. An
  // imported pull request is only ever continuable while it is up for a vote,
  // and this tail — advancing the head the platform tracks for a PR — has no
  // meaning outside that. Refuse rather than guess.
  if (session.status !== 'promoted') {
    return fail(
      'proposal_closed',
      `That proposal is ${session.status || 'no longer open'}, so it cannot take a new revision. Open a new `
      + 'proposal with prepare_work.',
      { retryable: false }
    );
  }

  const prNumber = Number(session.pr_number);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    return fail('platform_unavailable', 'Usernode cannot tell which pull request this proposal follows.', { retryable: false });
  }

  let pr;
  try {
    pr = await gh.getPR(owner, repo, prNumber);
  } catch (err) {
    log.warn('proposal-update', 'could not read the proposal pull request', { sessionId, prNumber, err: err.message });
    return fail('platform_unavailable', 'Usernode could not read this proposal\'s pull request. Try again shortly.', { retryable: true });
  }
  if (!pr || pr.merged || (pr.state && pr.state !== 'open')) {
    return fail(
      'proposal_closed',
      `Pull request #${prNumber} is no longer open on GitHub, so this proposal cannot take a new revision.`,
      { retryable: false }
    );
  }

  // The gate, in the shape this path allows: the head repository must be
  // owned by the freshly-read linked login. Same comparison
  // external-agent-tasks.js applies to a submitted PR, against the same
  // value, and again never against anything the caller passed in.
  const headOwner = pr.head && pr.head.repo && pr.head.repo.owner && pr.head.repo.owner.login;
  if (!headOwner || !head.sameLogin(headOwner, expectedLogin)) {
    return fail(
      'not_your_fork',
      `Pull request #${prNumber} comes from ${headOwner ? `${headOwner}'s` : 'another'} repository, not from your `
      + 'fork. Usernode only advances a proposal from its author\'s own account.',
      { retryable: false }
    );
  }
  const prBranch = pr.head && pr.head.ref ? String(pr.head.ref) : '';
  if (prBranch !== branch) {
    return fail(
      'invalid_request',
      `This proposal follows ${prBranch || 'the pull request\'s own branch'} in your fork, not ${branch}. Push your `
      + 'new commits to that branch — an open pull request cannot be repointed at a different one — or open a new '
      + 'proposal from this branch with prepare_work.',
      { retryable: false }
    );
  }

  const verified = await head.verifyForkBranch({
    githubPublic, forkOwner, forkRepo, branch, expectedLogin,
  });
  if (!verified.ok) return renameHeadFailure(verified, branch);

  const liveHead = pr.head && pr.head.sha ? String(pr.head.sha).toLowerCase() : null;
  if (!liveHead || liveHead !== verified.headSha) {
    // GitHub's own two views of the same branch disagree, which it does for a
    // second or two after a push. Nothing is written on a disagreement.
    return fail(
      'platform_unavailable',
      'GitHub is still catching up with your push — its pull request and its branch report different commits. '
      + 'Try again in a few seconds.',
      { retryable: true }
    );
  }

  const oldHead = session.imported_pr_head_sha
    ? String(session.imported_pr_head_sha).toLowerCase()
    : null;
  if (expectedHeadSha && oldHead && expectedHeadSha !== oldHead) {
    return movedError(oldHead);
  }
  if (oldHead && oldHead === liveHead) return unchanged(session, liveHead, 'update_fork_head');

  if (oldHead) {
    const ancestry = await checkAncestry({ gh, owner, repo, base: oldHead, head: liveHead, branch });
    if (ancestry) return ancestry;
  }

  const votesCleared = await countVotes(pool, sessionId);

  // The existing imported-head machinery, unchanged: it advances the tracked
  // SHA, clears the tally, re-classifies dapp.json admins, posts the
  // "earlier votes were cleared" note and re-runs the SHA-pinned checks and
  // staging build.
  try {
    await prImportSync.applyHeadChange({
      config, pool, session, pr, repo: { owner, repo }, newHead: liveHead, oldHead,
    });
  } catch (err) {
    log.error('proposal-update', 'imported head change failed', { sessionId, err: err.message });
    return fail(
      'platform_unavailable',
      'Usernode could not record your new commit against this proposal. Your push is on GitHub either way — try '
      + 'again shortly.',
      { retryable: true }
    );
  }

  log.info('proposal-update', 'advanced an imported proposal to its fork\'s head', {
    sessionId, prNumber, previousHeadSha: oldHead, headSha: liveHead, votesCleared,
  });

  return {
    ok: true,
    updated: true,
    proposalId: sessionId,
    appSlug: session.app_slug || null,
    prNumber,
    prUrl: session.pr_url || pr.html_url || null,
    branchHome: 'user_fork',
    branch,
    headSha: liveHead,
    previousHeadSha: oldHead,
    votesCleared,
    checksRerun: true,
    previewRebuilding: true,
    submittedVia: 'update_fork_head',
  };
}

// Does the new work actually build on what is under review? A revision that
// does not is the one case where accepting it would silently DELETE reviewed
// commits from the proposal — the fork branch could be cut from anywhere,
// including from main before the proposal existed.
//
// The comparison runs against the APP repository with bare commit ids: fork
// network commits are reachable through the parent repo's API, which is how
// services/external-agent-head.js's mirror path already compares them.
//
// A comparison the platform cannot make is not a licence to overwrite a
// branch under review, so an unreadable compare is a retryable refusal
// rather than a pass.
async function checkAncestry({ gh, owner, repo, base, head: newHead, branch }) {
  let cmp;
  try {
    cmp = await gh.compareCommitAncestry(owner, repo, base, newHead);
  } catch (err) {
    log.warn('proposal-update', 'ancestry comparison failed', { owner, repo, err: err.message });
    return fail(
      'platform_unavailable',
      'Usernode could not check that your branch builds on this proposal\'s current commit, so it did not move it. '
      + 'Try again shortly.',
      { retryable: true }
    );
  }
  if (!cmp || !cmp.status) {
    return fail(
      'platform_unavailable',
      'Usernode could not check that your branch builds on this proposal\'s current commit, so it did not move it. '
      + 'Try again shortly.',
      { retryable: true }
    );
  }
  if (cmp.status !== 'ahead' && cmp.status !== 'identical') {
    return fail(
      'base_mismatch',
      `${branch} is not built on this proposal's current commit — it is ${cmp.status} relative to it, so pushing it `
      + 'would drop commits that are already under review. Fetch the proposal\'s head, rebase your branch onto it '
      + 'and submit again.',
      { retryable: false, expectedBase: base }
    );
  }
  return null;
}

function movedError(headSha) {
  return fail(
    'branch_moved',
    `This proposal is now at commit ${headSha.slice(0, 8)}, not the one your update was built against — somebody `
    + 'advanced it in the meantime. Re-read the proposal, rebase onto its current head and submit again.',
    { retryable: false, headSha }
  );
}

// The fork branch is already this proposal's head. Not an error: an agent
// that submits twice, or a user who relays "it's pushed" after the agent
// already did, must not be told their work is missing.
function unchanged(session, headSha, via) {
  return {
    ok: true,
    updated: false,
    unchanged: true,
    proposalId: Number(session.id),
    appSlug: session.app_slug || null,
    prNumber: session.pr_number || null,
    prUrl: session.pr_url || null,
    branchHome: branchHomeOf(session),
    branch: session.branch_name || null,
    headSha,
    previousHeadSha: headSha,
    votesCleared: 0,
    checksRerun: false,
    previewRebuilding: false,
    submittedVia: via,
  };
}

module.exports = {
  branchHomeOf,
  authorCanPush,
  isContinuableStatus,
  withProposalLock,
  updateProposalFromForkBranch,
};
