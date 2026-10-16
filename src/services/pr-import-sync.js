'use strict';

// #687 Slice 3 — sync poller for IMPORTED PR proposals.
//
// An imported row tracks a GitHub PR whose branch the platform does
// NOT own; the external author keeps pushing to it. Votes and checks are
// cast/run against a specific commit (imported_pr_head_sha), so when the
// author pushes new commits the head moves. This module notices that on the
// next sweeper pass and advances the row to the new head:
//
//   - update imported_pr_head_sha to the new head,
//   - once the row is promoted, ask services/integration.js what the move
//     cost the approvals — the platform's own sync commit (the merge queue
//     pushes those onto imported branches too, #2038) is mechanical and
//     keeps them; an author push moves the approval epoch on and asks for
//     re-review,
//   - refresh behind_main / conflict state from GitHub (the native path's
//     drift snapshot), and
//   - re-run the proposal checks against the new head via the SHA-pinned
//     staging build from Slice 1, unless a settled verdict carries across a
//     mechanical merge.
//
// The same reconciliation is available WITHOUT a GitHub read for a branch
// the app's mirror can see (reconcileImportedHead); the merge path uses it
// so an exact-sha merge is never offered a pin the platform itself just
// superseded.
//
// It is also the only pass that can correct a STALE conflict snapshot
// (#1365). The drift refresh above runs only on a head change, and GitHub
// answers `mergeable: null` for the first read after a push — the very read
// that head change triggers — so a snapshot could be stranded claiming a
// conflict the author had already resolved. See refreshStrandedConflictState.
//
// Purely additive to the native proposal/vote/merge path.

const log = require('./logger');
const summaryFreshness = require('./summary-freshness');
const github = require('./github');
const githubMock = require('./github-mock');
const { usesMockGithubForImports } = require('../config');
const { sameSha } = require('./pr-vote-revision');

function parseRepo(url) {
  const [, owner, repo] = (url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  return owner && repo ? { owner, repo } : null;
}

// #687: talk to the in-memory mock GitHub source in staging previews (no
// GitHub credentials there — see usesMockGithubForImports in config.js);
// the real client everywhere else.
function activeGithub() {
  return usesMockGithubForImports() ? githubMock : github;
}

// Human label for the proposal in thread notes ("PR #123 — Fix the footer").
function prLabel(session) {
  return session.pr_title
    ? `PR #${session.pr_number}: ${session.pr_title}`
    : `PR #${session.pr_number}`;
}

// #866: post a note into an imported proposal's VISIBLE thread.
//
// The native staging flows narrate build start/finish/failure into
// chat_session_messages — the dev-chat transcript. An imported proposal has
// no dev chat (nobody in the app owns its session), so those rows render
// nowhere and every minute of a multi-minute build looks like nothing
// happening. The thread an imported proposal DOES have is the group
// discussion keyed ('session', id) — the same channel checkAndMerge and the
// head-change note use. Best-effort by construction: narration must never
// affect the build's outcome.
async function postProposalNote(pool, session, text, metadata) {
  try {
    const { sendSystemMessage } = require('./ws');
    await sendSystemMessage(
      pool, session.app_id, text, 'system',
      { prNumber: session.pr_number || null, ...(metadata || {}) },
      { type: 'session', ref: session.id }
    );
  } catch (err) {
    log.warn('pr-import-sync', 'proposal thread note failed (non-fatal)', {
      sessionId: session.id, err: err.message,
    });
  }
}

// Fetch the imported PR's current head SHA and, when it has moved since the
// stored imported_pr_head_sha, reset the proposal against the new head.
//
// Returns one of:
//   'skipped'   — not an imported row, GitHub not configured, or
//                 the getPR fetch failed (transient — retried next sweep).
//   'unchanged' — the head SHA matches the stored one (the common case).
//                 One getPR call, and no head machinery. It may still heal
//                 two things the same fetch has the answer to: a drifted
//                 description mirror, and (#1365) a conflict snapshot left
//                 claiming the proposal is blocked after GitHub decided it
//                 is not. Both are no-ops unless there is something wrong.
//   'updated'   — the head moved: tally cleared, note posted, drift +
//                 checks refreshed against the new head.
//
// `session` must carry (at least): id, app_id, app_slug, source, pr_number,
// pr_title, branch_name, repo_url, imported_pr_head_sha — i.e. the
// `cs.*, a.slug AS app_slug, a.repo_url` shape the sweeper selects. Never
// throws: infrastructure failures are logged and swallowed so one bad PR
// can't wedge the sweep.
async function syncImportedProposal({ config, pool, session }) {
  try {
    if (!session || session.source !== 'imported' || !session.pr_number) return 'skipped';
    const repo = parseRepo(session.repo_url);
    const gh = activeGithub();
    if (!repo || !gh.isEnabled()) return 'skipped';

    let pr;
    try {
      pr = await gh.getPR(repo.owner, repo.repo, session.pr_number);
    } catch (err) {
      log.warn('pr-import-sync', 'getPR failed — will retry next sweep', {
        sessionId: session.id, prNumber: session.pr_number, err: err.message,
      });
      return 'skipped';
    }

    // #1333. Every sweep already has a fresh PR in hand, so the description
    // mirror is refreshed here BEFORE the head check returns. That is what
    // heals rows written before the column existed — and what keeps the
    // description current when an author edits it on GitHub rather than
    // through submit_work. Best-effort: a sweep must never fail over a
    // display field.
    const freshBody = typeof pr.body === 'string' ? pr.body : null;
    if (freshBody !== (session.pr_body == null ? null : session.pr_body)) {
      try {
        await pool.query(
          `UPDATE chat_sessions SET pr_body = $1, ${summaryFreshness.INVALIDATE_SQL} WHERE id = $2`,
          [freshBody, session.id]
        );
        session.pr_summary_stale = session.pr_summary_stale || !!session.pr_summary_md;
        session.pr_body = freshBody;
      } catch (err) {
        log.warn('pr-import-sync', 'description mirror refresh failed (non-fatal)', {
          sessionId: session.id, err: err.message,
        });
      }
    }

    const newHead = pr.head && pr.head.sha ? pr.head.sha : null;
    if (!newHead) return 'skipped';
    const oldHead = session.imported_pr_head_sha || null;
    if (newHead === oldHead) {
      // #1365. The head is where we left it — but the CONFLICT SNAPSHOT may
      // not be, and this is the only pass that can put it right.
      await refreshStrandedConflictState({ pool, session, pr, repo });
      return 'unchanged';
    }

    await applyHeadChange({ config, pool, session, pr, repo, newHead, oldHead });
    return 'updated';
  } catch (err) {
    log.warn('pr-import-sync', 'syncImportedProposal failed', {
      sessionId: session && session.id, err: err.message,
    });
    return 'skipped';
  }
}

// What did this head move cost the approvals? The same question, and the
// same answer, as the native path (routes/votes.js reconcileNativeReviewedHead):
// services/integration.js redoes the merge from the local mirror and compares
// trees, so nothing here trusts the shape of the new commit.
//
// This used to be assumed rather than asked. The comment read "an imported
// head moving is always an author push by definition: the platform does not
// write to the author's fork" — which stopped being true the day the merge
// queue (#2038) started bringing imported proposals up to date with main by
// pushing a merge commit onto their branch. Every one of those syncs then
// came back through the poller as an "author push", cleared the votes, and
// asked the group to re-review a change nobody had changed (#2100, #2095).
//
// 'unknown' — the mirror cannot answer — is treated by the caller as
// authored. Failing open here would let a real push inherit approvals.
async function classifyImportedHeadMove({ session, oldHead, newHead }) {
  // The staging mock has no repository to redo the merge from, and a mock
  // "push" (github-mock.bumpHead) is an author push by construction.
  if (usesMockGithubForImports()) return { kind: 'authored', reason: 'mock_github' };
  const integration = require('./integration');
  const mirror = require('./repo-mirror');
  const parsed = integration._parseRepo(session.repo_url);
  if (!parsed) return { kind: 'unknown', reason: 'no_repo' };
  try {
    const dir = await mirror.ensureMirror(parsed.owner, parsed.repo, { refs: [oldHead, newHead] });
    const mainSha = await mirror.defaultBranchSha(dir);
    return await integration.classifyHeadMove(dir, { approvedHead: oldHead, newHead, mainSha });
  } catch (err) {
    log.warn('pr-import-sync', 'head-move classification failed; treating as authored', {
      sessionId: session.id, oldHead, newHead, err: err.message,
    });
    return { kind: 'unknown', reason: err.message };
  }
}

// Verdicts that can be carried onto a mechanically merged head. Only a
// GREEN one: a 'pending' verdict is a run still going (or one the sync just
// superseded), and carrying its stamp forward would leave the row 'pending'
// with nothing building — the ten-minute stale wait of #1728. 'error' is
// left out too: it usually means the preview did not boot, which a rebuild
// against the merged commit is the right way to find out about. And a
// 'failing' verdict never carries (#2693): it used to, on the premise that a
// merge of main does not change what the author must fix — which is false
// exactly when main is what fixes it (a red base repaired, a test main
// mended, a dependency main bumped). Proposal 4654 sat red, pinned to a
// commit that contained the fix, with nothing building and no way to re-run
// short of an authored push. The merged tree is the only thing that can turn
// the verdict green, and nobody has tested it, so it is tested.
const CARRIABLE_CHECK_STATES = new Set(['passing', 'skipped']);

// Apply a head change: advance the stored SHA, decide what the move costs the
// approvals and the checks, refresh drift, and re-run SHA-pinned checks where
// the verdict cannot carry. An active import has no votes to protect and
// simply follows the new head.
//
// `move` is the classification when the caller already has it (the
// mirror-driven path below); otherwise it is computed here for a row up for
// vote. `pr`/`repo` are the GitHub read the poller had in hand and are only
// used for the drift snapshot; the mirror-driven path has neither.
//
// `checks`:
//   'await'      — (default; the poller) run the rebuild here and wait for
//                  it, so the sweep's per-session cooldown bounds concurrency.
//   'background' — kick the rebuild and return.
//   'defer'      — leave the rebuild to the caller's checkAndMerge, whose
//                  checks gate rebuilds exactly the pinned head when the
//                  verdict's commit does not match it. Only honoured while
//                  the approvals survive: a run that cleared them stops at
//                  the approvals gate and would never reach the checks gate,
//                  so that case degrades to 'background'.
//
// `notify: false` suppresses the group message and the vote broadcast for a
// caller that is about to say something more specific itself (the merge
// path's 409 handler).
//
// Returns { applied, votesKept, checksCarry, kind, epoch }. `applied` is
// false when the row's pin no longer matched `oldHead` — another pass got
// there first — and NOTHING was written or posted. The sweep and the queue
// can both notice the same move; the second must be a no-op, not a second
// epoch bump and a second "please re-review" (PR #2101 saw both).
async function applyHeadChange({
  config, pool, session, pr = null, repo = null, newHead, oldHead,
  move = null, checks = 'await', notify = true,
}) {
  const { sendSystemMessage, pushVoteUpdate } = require('./ws');
  const upForVote = session.status === 'promoted' || session.status === 'merging';

  // 1. What the move costs. Only a proposal up for vote has approvals to
  //    protect, so only it pays for the classification.
  if (upForVote && !move) {
    move = await classifyImportedHeadMove({ session, oldHead, newHead });
  }
  const kind = upForVote ? ((move && move.kind) || 'unknown') : 'authored';
  const keepsApprovals = upForVote && (kind === 'mechanical' || kind === 'resolved');
  const bumpEpoch = upForVote && !keepsApprovals;
  // Checks policy follows who wrote the tree, as on the native path: a
  // mechanical merge is pure git over a tested branch and a tested main, so
  // a settled verdict carries. A 'resolved' tree is one nobody has tested.
  let checksCarry = kind === 'mechanical'
    && sameSha(session.checks_commit_sha, oldHead)
    && CARRIABLE_CHECK_STATES.has(session.check_state);

  // 2. One move, the proposal machine's (Q3): the head installed and, unless
  //    the move kept the approvals, the epoch moved on, in one statement, so
  //    a crash can never leave a row whose approvals describe neither the old
  //    code nor the new. It is refused if the pin is no longer the one this
  //    decision was made about (another pass got there first), or the
  //    proposal has closed or merged meanwhile.
  const moved = await require('../workflow/platform.ts').moveReviewHead({
    sessionId: session.id, appId: session.app_id, column: 'imported', from: oldHead || null, to: newHead,
    keepVotes: !bumpEpoch, reason: `imported_head_${kind}`,
  });
  if (moved.status !== 'accepted' && moved.status !== 'replayed') {
    log.info('pr-import-sync', 'Head change already applied by another pass; nothing to do', {
      sessionId: session.id, prNumber: session.pr_number, oldHead, newHead, refused: moved.reason || moved.status,
    });
    // Let the caller carry on with the row as it now is, not as it was read:
    // a merge attempt that kept the stale pin would offer GitHub the old
    // commit and buy exactly the 409 this path exists to avoid.
    const { rows: current } = await pool.query(
      `SELECT imported_pr_head_sha, approval_epoch, checks_commit_sha, check_state
         FROM chat_sessions WHERE id = $1`,
      [session.id]
    ).catch(() => ({ rows: [] }));
    if (current[0]) Object.assign(session, current[0]);
    return { applied: false, votesKept: false, checksCarry: false, kind, epoch: null };
  }
  const claimed = [{ approval_epoch: moved.reply?.epoch, pr_summary_stale: moved.reply?.prSummaryStale }];
  const epoch = parseInt(claimed[0].approval_epoch, 10);
  session.imported_pr_head_sha = newHead;
  // #3344: read back, because an author summary recorded for this very head
  // stays fresh (summaryFreshness.invalidateHeadMoveSql).
  session.pr_summary_stale = typeof claimed[0].pr_summary_stale === 'boolean'
    ? claimed[0].pr_summary_stale
    : (session.pr_summary_stale || !!session.pr_summary_md);
  session.approval_epoch = epoch;
  // A carried verdict is the preview machine's to move, as on the native
  // path (votes.js reconcileNativeReviewedHead): it keeps a green verdict of
  // the old head for the merged one, and checks the new head otherwise.
  // A carry the machine never received is not one: the new head's checks
  // are re-run instead (needsChecks below).
  if (checksCarry) {
    checksCarry = await require('./preview-workflow').revision({ pool, session, head: newHead, source: 'imported',
      trigger: 'commit-push', carryFrom: oldHead }).then(() => true, (err) => {
      log.warn('pr-import-sync', 'Carrying the verdict failed; the new head is checked instead', {
        sessionId: session.id, oldHead, newHead, err: err.message,
      });
      return false;
    });
    if (checksCarry) session.checks_commit_sha = newHead;
  }
  // The shots machine hears the head moved from the proposal machine, in the
  // move's own transaction.
  if (bumpEpoch) {
    log.info('integration', 'Approvals cleared', {
      sessionId: session.id, epoch, reason: `imported_head_${kind}`,
    });
  }

  const label = prLabel(session);
  const shortHead = String(newHead).slice(0, 8);
  const needsChecks = !checksCarry && !sameSha(session.checks_commit_sha, newHead);
  const rebuildClause = needsChecks
    ? ' The staging preview and automated checks are being rebuilt against the new commit.'
    : '';
  let message;
  if (!upForVote) {
    message = `${label} was updated on GitHub.${rebuildClause}`;
  } else if (kind === 'mechanical') {
    message = `${label} was brought up to date with main. Nothing in the proposal changed, so its votes still stand.`
      + (needsChecks ? ' The automated checks are re-running against the merged commit.' : '');
  } else if (kind === 'resolved') {
    const n = Array.isArray(move.conflictPaths) ? move.conflictPaths.length : 0;
    message = `${label} was brought up to date with main and ${n || 'its'} conflicting file${n === 1 ? '' : 's'} `
      + 'were resolved automatically. The votes still stand; the staging preview and automated checks are '
      + 'being rebuilt against the merged commit, and it will merge on its own once they pass.';
  } else if (kind === 'unknown') {
    message = `${label} moved to commit ${shortHead}, which the platform could not verify`
      + `${move && move.reason ? ` (${move.reason})` : ''}. Earlier votes were cleared, so please re-review the new changes.${rebuildClause}`;
  } else {
    message = `${label} was updated on GitHub. Earlier votes were cleared, so please re-review the new changes.${rebuildClause}`;
  }

  if (upForVote) {
    await require('./app-admins').refreshExplicitApproval(pool, session, session);
  }
  if (notify) {
    await sendSystemMessage(
      pool, session.app_id, message, 'system',
      { headChanged: true, votesKept: keepsApprovals, prNumber: session.pr_number, headSha: newHead },
      { type: 'session', ref: session.id }
    ).catch((err) => log.warn('pr-import-sync', 'head-change note failed', {
      sessionId: session.id, err: err.message,
    }));
    if (upForVote) {
      try {
        pushVoteUpdate({
          sessionId: session.id, appSlug: session.app_slug || null, merged: false,
          headMoved: true, ...(keepsApprovals ? { votesKept: true } : {}),
        });
      } catch (_) { /* ws failures are non-fatal */ }
    }
  }

  // 3. Refresh behind_main / conflict snapshot the way the native path does —
  //    only when the caller had the GitHub read in hand. The mirror-driven
  //    callers have just measured the integration record instead.
  if (pr && repo) {
    await refreshDriftState({ pool, session, pr, repo }).catch((err) =>
      log.warn('pr-import-sync', 'drift refresh failed', { sessionId: session.id, err: err.message }));
  }

  // 4. Re-run the proposal checks against the NEW head — the SHA-pinned
  //    staging build from Slice 1 (storeChecks / storeChecksSkipped) — unless
  //    the verdict carried, or the caller's merge attempt is about to do it.
  if (needsChecks) {
    const mode = (checks === 'defer' && !keepsApprovals) ? 'background' : checks;
    if (mode === 'await') {
      await rerunChecksForNewHead({ config, pool, session, newHead }).catch((err) =>
        log.warn('pr-import-sync', 'checks re-run failed', { sessionId: session.id, err: err.message }));
    } else if (mode === 'background') {
      rerunChecksForNewHead({ config, pool, session, newHead }).catch((err) =>
        log.warn('pr-import-sync', 'checks re-run failed', { sessionId: session.id, err: err.message }));
    }
  }

  log.info('pr-import-sync', 'Imported PR head changed', {
    sessionId: session.id, prNumber: session.pr_number, oldHead, newHead, upForVote,
    moveKind: kind, votesKept: keepsApprovals, checksCarry, checksRerun: needsChecks ? checks : 'none',
  });
  return { applied: true, votesKept: keepsApprovals, checksCarry, kind, epoch };
}

// Re-pin an imported proposal to the live head of its branch WITHOUT asking
// GitHub — the imported analogue of routes/votes.js reconcileNativeReviewedHead.
//
// The poller above learns of a head move from getPR on its own cadence. Two
// callers cannot wait for that: the merge queue, which has just pushed a sync
// commit onto this very branch and is about to offer GitHub the pinned
// commit (a pin still on the pre-sync head is a guaranteed 409 — the
// "wasn't merged, because the PR was updated on GitHub" loop of #2100); and
// the 409 handler itself, which would otherwise release the claim and leave
// the row waiting for the next sweep. A third is submit_work's app-repo
// revision (services/proposal-update.js), when GitHub's pull request still
// reads the commit before the one it just pushed.
//
// `fresh` is the native reconcile's #2619 option, for the same reason: the
// mirror coalesces one fetch per repository, and a caller reading back its
// own push must not join a fetch that started before it. Pass it when the
// push and this call are in the same request.
//
// Only answers for a head the mirror can see: a branch in the app's own
// repository. A head on the author's fork is left to the poller, exactly as
// before. Never throws.
async function reconcileImportedHead({
  config, pool, session, checks = 'defer', notify = true, fresh = false,
}) {
  try {
    if (!session || session.source !== 'imported' || !session.pr_number) {
      return { reconciled: false, reason: 'not_imported' };
    }
    const oldHead = session.imported_pr_head_sha || null;
    if (!oldHead) return { reconciled: false, reason: 'unpinned' };
    if (!session.branch_name || !session.repo_url) return { reconciled: false, reason: 'no_branch' };
    if (require('./proposal-update').branchHomeOf(session) !== 'app_repo') {
      return { reconciled: false, reason: 'fork_head' };
    }
    const integration = require('./integration');
    const mirror = require('./repo-mirror');
    const parsed = integration._parseRepo(session.repo_url);
    if (!parsed) return { reconciled: false, reason: 'no_repo' };

    let dir; let mainSha; let liveHead;
    try {
      dir = await mirror.ensureMirror(parsed.owner, parsed.repo, { refs: [oldHead], fresh });
      mainSha = await mirror.defaultBranchSha(dir);
      liveHead = await mirror.resolveBranch(dir, session.branch_name);
    } catch (err) {
      log.warn('pr-import-sync', 'mirror unreadable; leaving the imported pin as it stands', {
        sessionId: session.id, err: err.message,
      });
      return { reconciled: false, reason: 'mirror_unreadable' };
    }
    if (!liveHead) return { reconciled: false, reason: 'branch_missing' };
    if (sameSha(liveHead, oldHead)) {
      return { reconciled: true, changed: false, headSha: liveHead };
    }

    const move = await integration.classifyHeadMove(dir, {
      approvedHead: oldHead, newHead: liveHead, mainSha,
    });
    const applied = await applyHeadChange({
      config, pool, session, newHead: liveHead, oldHead, move, checks, notify,
    });
    return {
      reconciled: true,
      changed: applied.applied,
      // The row's pin as it stands — liveHead when this call installed it,
      // whatever the other pass installed when it got there first.
      headSha: session.imported_pr_head_sha || liveHead,
      kind: move.kind,
      votesKept: applied.votesKept,
      checksCarry: applied.checksCarry,
    };
  } catch (err) {
    log.warn('pr-import-sync', 'reconcileImportedHead failed', {
      sessionId: session && session.id, err: err.message,
    });
    return { reconciled: false, reason: err.message };
  }
}

// The snapshot states that say a proposal is BLOCKED. Only these are worth
// re-reading on an unchanged head: 'clean' and 'behind' are settled answers,
// and re-deriving them every sweep would spend a compareCommits per open
// imported proposal per tick to learn nothing. A null snapshot is excluded
// too — it renders no banner and the merge-candidate ordering already reads
// it as clean, so there is no stale claim to correct.
//
// 'resolving' is deliberately absent: the conflict-resolver owns that state
// for as long as its attempt is in flight and transitions out of it itself,
// and overwriting it from here would race the resolver rather than help it.
const STRANDED_CONFLICT_STATES = new Set(['conflict', 'failed']);

// #1365 — the missing half of refreshDriftState's "the next sweep re-checks".
//
// That comment was never true for an imported row. refreshDriftState only
// ever runs from applyHeadChange, which only runs when the head MOVES, and
// it declines to write anything when GitHub answers `mergeable: null`.
// GitHub computes mergeability asynchronously and returns null for the first
// read after a push — which is exactly the read applyHeadChange makes,
// BECAUSE it fires when the head just moved. So the snapshot was written at
// the one moment GitHub was least likely to have an answer, and every later
// sweep returned at the unchanged-head check before reaching the re-check.
//
// The visible cost: an author who did what the card told them to do — resolve
// the conflict and push — kept being told "the last automatic conflict
// resolution failed" on a pull request that was by then a clean fast-forward,
// with no way out but pushing another commit and hoping the timing landed
// better (which clears the vote tally again, for nothing).
//
// So: on an unchanged head, if the stored snapshot still claims the proposal
// is blocked and GitHub has since made its mind up, re-derive it. Cheap by
// construction — a settled snapshot returns before any API call, and an
// undecided `mergeable` returns before the compareCommits, leaving the next
// sweep to try again.
async function refreshStrandedConflictState({ pool, session, pr, repo }) {
  if (!STRANDED_CONFLICT_STATES.has(session.merge_conflict_state || null)) return false;
  // Still computing. Nothing to write, and no reason to pay for drift here.
  if (pr.mergeable !== true && pr.mergeable !== false) return false;
  await refreshDriftState({ pool, session, pr, repo });
  log.info('pr-import-sync', 'Re-derived a stranded conflict snapshot on an unchanged head', {
    sessionId: session.id, prNumber: session.pr_number,
    was: session.merge_conflict_state, mergeable: pr.mergeable,
  });
  return true;
}

// Refresh the proposal card's behind_main + merge-conflict snapshot from
// GitHub, mirroring the native drift path (services/sync-main.js
// persistBehindMain / persistConflictState) — but WITHOUT a worker turn,
// because the platform doesn't own an imported PR's branch. behind_by comes
// from compareCommits(base…head); the conflict verdict from GitHub's
// mergeable flag (true → clean, false → conflict; null = still computing,
// left as-is for the next sweep).
async function refreshDriftState({ pool, session, pr, repo }) {
  const syncMain = require('./sync-main');
  const base = (pr.base && pr.base.ref) || 'main';
  const head = session.branch_name || (pr.head && pr.head.ref) || null;
  if (!head) return;

  let behindBy = null;
  try {
    // A read: through the App installation (services/github.js
    // getReadOctokit), not the bot token's hourly budget. A stranded
    // conflict re-derives here every few minutes.
    const octokit = await activeGithub().getReadOctokit(repo.owner);
    const { data } = await octokit.rest.repos.compareCommits({
      owner: repo.owner, repo: repo.repo, base, head,
    });
    behindBy = Number.isFinite(data.behind_by) ? data.behind_by : null;
  } catch (err) {
    log.warn('pr-import-sync', 'compareCommits failed', { sessionId: session.id, err: err.message });
  }

  if (behindBy != null) {
    await syncMain.persistBehindMain(pool, session, behindBy);
  }

  // GitHub's mergeable is true / false / null (null = still being computed).
  if (pr.mergeable === true) {
    await syncMain.persistConflictState(pool, session, { state: 'clean', files: [] });
  } else if (pr.mergeable === false) {
    await syncMain.persistConflictState(pool, session, { state: 'conflict', files: [] });
  }
  // mergeable === null: leave the prior snapshot; the next sweep re-checks.
}

// Re-run the proposal's checks against the new head: the preview machine
// builds a fresh preview pinned to `newHead` and checks it (or, in
// mock-GitHub mode, records the gate-passing 'skipped' verdict).
async function rerunChecksForNewHead({
  config, pool, session, newHead, trigger = 'pr-import',
}) {
  void config;
  await handOffImported({ pool, session, head: newHead, trigger });
}

// The preview machine's side of the two paths here: the new head goes to
// the machine, or, in mock-GitHub mode, the gate-passing 'skipped' verdict
// does. #687: in mock-GitHub mode (staging previews) there is no real repo
// to clone, so the whole preview flow (import → vote → merge) stays
// clickable on a neutral, mergeable verdict.
async function handOffImported({ pool, session, head, trigger }) {
  const workflow = require('./preview-workflow');
  if (usesMockGithubForImports()) {
    await workflow.skipped({ session, head, reason: 'mock GitHub preview: automated checks not run' });
  } else {
    await workflow.revision({ pool, session, head, source: 'imported', trigger });
  }
}

// #687 Slice 1 / #846 — the IMPORT-TIME checks kick. Called (un-awaited) by
// POST /api/apps/:slug/pr-import once the proposal row exists, so the route
// can answer immediately: the preview machine builds and checks the pinned
// head behind it (its own notes and pushes say when the preview is up).
// Never throws.
async function kickImportedChecks({ config, pool, session, app, headSha }) {
  void config; void app;
  try {
    await handOffImported({ pool, session, head: headSha, trigger: 'pr-import' });
  } catch (err) {
    log.warn('pr-import-sync', 'import checks hand-off failed', {
      sessionId: session.id, err: err.message,
    });
  }
}

module.exports = {
  syncImportedProposal,
  refreshStrandedConflictState,
  applyHeadChange,
  classifyImportedHeadMove,
  reconcileImportedHead,
  refreshDriftState,
  rerunChecksForNewHead,
  kickImportedChecks,
  parseRepo,
  // #866: exported for the thread-narration tests.
  prLabel,
  postProposalNote,
};
