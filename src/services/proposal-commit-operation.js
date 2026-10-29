'use strict';

// `proposal.commit`, a platform operation (services/platform-operations.js):
// a commit a local coding agent made and tested, rebuilt by the code host on
// a change's branch, on a conductor. Two routes take one, check it, answer
// their own refusals and ask for this, waiting for its answer:
//
//   handoff  POST /api/sessions/:id/proposal-handoff/commits
//            (routes/proposal-handoff.js): a CLI hand-off's upload. Under the
//            proposal lock, as every revision writer of a proposal is; then a
//            draft PR for a change that has none yet, and for a promoted
//            proposal the head people vote on (proposal-update.js
//            reconcileManagedCommitUpload);
//   turn     POST /api/cli/agent/turns/:id/commit (routes/cli-agent.js): the
//            commit of a local agent's build turn, under its lease, recorded
//            as the turn's head.
//
// On every attempt, before any write it still has to make, the conductor
// reads again what the route checked: the change is the requester's and
// still open, a hand-off's collab access and that nothing else works on it,
// a turn's live lease and its own build turn, the branch and repository the
// route saw, and the head the route expected to build on. A head this very
// request moved (its `commit` step) is its own, not a competing one.
//
// The commit (services/github.js createProposalCommit: the tested tree
// rebuilt exactly, the branch moved only from the expected parent), its
// record and the draft PR are separate steps, so a retry after a lost reply
// never commits twice. A client that asks again after its answer was lost is
// a new request: the branch is then at its own commit, which
// createProposalCommit recognises, so it is answered 200 with the same head
// and `uploaded: false`, as it always was.
//
// Input: { surface, sessionId, branch, repoUrl, expectedParent,
//          localCommitSha, parentSha, parentTreeSha, treeSha, authoredAt,
//          committedAt, turnId?, leaseId? }
// Payload: { message, files }, the commit itself (platform-operations, "an
// operation's large input"), read by the commit step and dropped once it is
// made or refused.

const github = require('./github');
const githubBudget = require('./github-budget');
const appAccess = require('./app-access');
const localAgent = require('./local-agent');
const prMetadata = require('./pr-metadata');
const proposalUpdate = require('./proposal-update');
const previewWorkflow = require('./preview-workflow');
const repoRef = require('./repo-ref');
const summaryFreshness = require('./summary-freshness');
const durableSteps = require('./durable-steps');
const { beginSessionOperation } = require('./active-workers');
const log = require('./logger');

const SURFACES = new Set(['handoff', 'turn']);
const STATE_CHANGED = Object.freeze({ status: 409, error: 'session_state_changed' });
// The payload is gone (never in practice: it is dropped only once no write
// needs it): the same commit asked again is a new request with its files.
const INPUT_GONE = Object.freeze({
  status: 503, code: 'operation_unavailable',
  error: 'The platform could not take this right now. Try again in a moment.',
});

// The hand-off's own helpers (the row as the route reads it, the head it
// builds on, what is working on it): one definition for the route and this.
function handoff() {
  return require('../routes/proposal-handoff');
}

function surfaceOf(request) {
  const surface = request.input?.surface;
  if (!SURFACES.has(surface)) throw Object.assign(new Error('Unknown commit surface'), { permanent: true });
  return surface;
}

// A head this request's own commit step made.
function ownHead(steps, head) {
  const made = steps?.get?.('commit');
  return !!made && !!head && made.sha === head;
}

// The route's target, as it saw it: a change moved to another branch or
// repository since is asked again.
function sameTarget(session, input) {
  return session.branch_name === input.branch && session.repo_url === input.repoUrl;
}

async function handoffState(pool, request, user, steps) {
  const h = handoff();
  const input = request.input;
  const session = await h.loadOwnedHandoff(pool, input.sessionId, user.id);
  if (!session || Number(session.app_id) !== Number(request.appId)) {
    return { refusal: { status: 404, error: 'Handoff session not found' } };
  }
  const revisionKind = h.managedRevisionKind(session);
  if (!revisionKind) {
    return { refusal: {
      status: 409, error: 'proposal_closed',
      message: `This proposal is ${session.status || 'no longer open'}, so it cannot take a managed revision.`,
    } };
  }
  if (!(await appAccess.checkAppAccess(pool, h.accessRow(session), user, 'collab'))) {
    return { refusal: { status: 404, error: 'Active handoff session not found' } };
  }
  const runtime = h.checkRuntime(session);
  if (runtime.session || runtime.pipeline) {
    return { refusal: {
      status: 409, error: 'session_busy',
      message: 'The shared proposal is currently changing. Retry when it finishes.',
    } };
  }
  const repo = h.repoCoordinates(session);
  if (!github.isEnabled() || !repo) return { refusal: { status: 400, error: 'No GitHub repo configured for this app' } };
  if (!sameTarget(session, input)) return { refusal: STATE_CHANGED };
  const head = h.currentProposalBranchHead(session);
  if (head !== input.expectedParent && !ownHead(steps, head)) return { refusal: STATE_CHANGED };
  return { refusal: null, session, revisionKind, repo };
}

async function turnState(pool, request, user, steps) {
  const input = request.input;
  const { rows: [lease] } = await pool.query(
    `SELECT * FROM session_agent_leases
      WHERE id = $1 AND user_id = $2 AND released_at IS NULL AND expires_at > NOW()`,
    [input.leaseId, user.id]
  );
  if (!lease) return { refusal: { status: 409, error: 'lease_lost' } };
  const turn = await localAgent.getTurn(pool, input.turnId);
  if (!turn || String(turn.lease_id) !== String(lease.id)) return { refusal: { status: 404, error: 'not_found' } };
  if (!['accepted', 'running'].includes(turn.status)) return { refusal: { status: 409, error: 'turn_not_running' } };
  if (turn.mode !== 'build') return { refusal: { status: 409, error: 'read_only_turn' } };
  const { rows: [session] } = await pool.query(
    `SELECT cs.id, cs.app_id, cs.branch_name, a.repo_url
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
      WHERE cs.id = $1 AND cs.user_id = $2 AND cs.status = 'active'`,
    [turn.session_id, user.id]
  );
  if (!session || Number(session.id) !== Number(input.sessionId)
      || Number(session.app_id) !== Number(request.appId)) return { refusal: STATE_CHANGED };
  const repo = repoRef.ownerRepo(session.repo_url);
  if (!github.isEnabled() || !repo || !session.branch_name) return { refusal: { status: 400, error: 'repo_unavailable' } };
  if (!sameTarget(session, input)) return { refusal: STATE_CHANGED };
  const head = turn.head_sha || turn.base_sha || null;
  if (head !== input.expectedParent && !ownHead(steps, head)) return { refusal: STATE_CHANGED };
  return { refusal: null, session, repo };
}

function stateOf(pool, request, user, steps) {
  return surfaceOf(request) === 'turn'
    ? turnState(pool, request, user, steps)
    : handoffState(pool, request, user, steps);
}

async function authorize({ pool }, request, user, { steps = null } = {}) {
  return (await stateOf(pool, request, user, steps)).refusal;
}

function operations() {
  return require('./platform-operations');
}

// Never instead of the answer: one left behind is swept.
function dropPayload(pool, request) {
  return operations().dropInput(pool, request.requestId).catch((err) => log.warn('proposal-commit',
    'Could not drop a commit\'s files', { requestId: request.requestId, err: err.message }));
}

// A refused request keeps nothing: its files are dropped.
async function abandon({ pool }, request) {
  await dropPayload(pool, request);
}

// What the code host's refusal is answered with, in each route's own words.
async function hostRefusal(pool, request, session, err) {
  const handoffSurface = request.input.surface === 'handoff';
  if (err.code === 'branch_moved') {
    return handoffSurface ? {
      status: 409, error: 'branch_moved',
      message: 'The proposal branch changed. Fetch its current head and rebase the local commit before retrying.',
    } : { status: 409, error: 'branch_moved' };
  }
  if (err.code === 'tree_mismatch') {
    return handoffSurface ? {
      status: 409, error: 'tree_mismatch',
      message: 'The uploaded files did not reconstruct the tested local Git tree.',
    } : { status: 409, error: 'tree_mismatch' };
  }
  if (err.code === 'parent_tree_mismatch') {
    return handoffSurface ? {
      status: 409, error: 'parent_tree_mismatch',
      message: 'The local commit parent does not match the current proposal tree. Upload local commits in order or rebase onto the current proposal branch.',
    } : { status: 409, error: 'parent_tree_mismatch' };
  }
  // The change's branch did not come across when Homeroom moved off GitHub
  // (services/code-missing.js, read live): said so, not as GitHub being
  // unavailable, which invites a retry.
  const codeMissing = require('./code-missing');
  if (err.status === 404 && await codeMissing.branchGone(pool, session) === true) {
    return { status: 409, error: codeMissing.CODE, message: codeMissing.BRANCH_GONE };
  }
  const detail = github.describeGithubError(err);
  // Never log the host's response data here: a provider validation error may
  // echo fields from the source upload.
  log.warn('proposal-commit', handoffSurface ? 'Bot-owned commit upload failed' : 'Local agent commit upload failed', {
    sessionId: Number(session.id), status: detail.status, requestId: detail.requestId, message: detail.message,
  });
  return { status: 503, ...githubBudget.githubUnavailableBody(err) };
}

// The commit, kept as a step: a retry resumes past it and never asks the
// host to commit again. A host that refuses is answered at once, with its
// reason, as these routes always answered; the person or the agent asks
// again, and the branch then says whether the commit is already there.
async function commit(pool, request, session, repo, steps) {
  const input = request.input;
  // Read on every attempt that still has to commit (a database that fails
  // here is tried again); a retry past the commit needs none.
  let payload = null;
  if (!steps.has('commit')) {
    payload = await operations().inputOf(pool, request.requestId);
    if (!payload || !Array.isArray(payload.files)) {
      await dropPayload(pool, request);
      return { ok: false, ...INPUT_GONE };
    }
  }
  let uploaded;
  try {
    uploaded = await steps.once('commit', () => github.createProposalCommit(repo.owner, repo.repo, {
      branchName: session.branch_name,
      expectedRemoteParentSha: input.expectedParent,
      localParentSha: input.parentSha,
      localParentTreeSha: input.parentTreeSha,
      expectedTreeSha: input.treeSha,
      localCommitSha: input.localCommitSha,
      message: payload.message,
      authoredAt: input.authoredAt,
      committedAt: input.committedAt,
      files: payload.files,
    }));
  } catch (err) {
    if (steps.stopped || durableSteps.isStopped(err)) throw err;
    await dropPayload(pool, request);
    return { ok: false, ...(await hostRefusal(pool, request, session, err)) };
  }
  // No write still needs the files.
  await dropPayload(pool, request);
  return { ok: true, uploaded };
}

// The upload, recorded on the hand-off's row from the head the route
// expected. The verdict no longer describes the branch: the preview machine
// clears it. A record this request kept before its step was saved (a retry)
// is its own.
async function recordUpload(pool, session, input, uploaded) {
  const { SOURCE } = handoff();
  const advanced = await pool.query(
    `UPDATE chat_sessions
        SET handoff_uploaded_sha = $1, handoff_local_commit_sha = $5,
            ${summaryFreshness.INVALIDATE_SQL},
            handoff_upload_checked_sha = checks_commit_sha,
            last_activity_at = NOW()
      WHERE id = $2 AND status = $6 AND source = $3
        AND (CASE
               WHEN handoff_uploaded_sha IS NOT NULL
                AND handoff_uploaded_sha IS DISTINCT FROM handoff_head_sha
                AND checks_commit_sha IS NOT DISTINCT FROM handoff_upload_checked_sha
                 THEN handoff_uploaded_sha
               ELSE COALESCE(checks_commit_sha, handoff_uploaded_sha,
                             handoff_head_sha, handoff_base_sha)
             END) IS NOT DISTINCT FROM $4`,
    [uploaded.sha, session.id, SOURCE, input.expectedParent, input.localCommitSha, session.status]
  );
  if (!advanced.rowCount) {
    const { rows: [own] } = await pool.query(
      `SELECT 1 AS own FROM chat_sessions
        WHERE id = $1 AND handoff_uploaded_sha = $2 AND handoff_local_commit_sha = $3`,
      [session.id, uploaded.sha, input.localCommitSha]
    );
    if (!own) return false;
  }
  await previewWorkflow.clear({ session, reason: 'upload' });
  return true;
}

async function runHandoff({ config, pool }, request, user, steps) {
  const input = request.input;
  return proposalUpdate.withProposalLock(pool, input.sessionId, async () => {
    // Read again under the lock: what the route expected is still so.
    const state = await handoffState(pool, request, user, steps);
    if (state.refusal) {
      await dropPayload(pool, request);
      return { ok: false, ...state.refusal };
    }
    const { session, revisionKind, repo } = state;
    // What the row recorded before this request wrote anything, so a retry
    // compares its commit with that, not with its own record.
    const before = await steps.once('before', () => ({
      uploaded: session.handoff_uploaded_sha || null, local: session.handoff_local_commit_sha || null,
    }));
    const releaseOperation = beginSessionOperation(session.id);
    try {
      await releaseOperation.recorded;
      const committed = await commit(pool, request, session, repo, steps);
      if (!committed.ok) return committed;
      const { uploaded } = committed;
      // The exact local/platform pair is already recorded: a retry before
      // submission or long after its checks passed. Writing the row again
      // would erase a valid verdict and preview although the branch did not
      // change. A promoted retry still reconciles below: its first answer may
      // have been lost after the branch moved but before votes were reset.
      const alreadyRecorded = before.uploaded === uploaded.sha && before.local === input.localCommitSha;
      if (!alreadyRecorded && !(await steps.once('record', () => recordUpload(pool, session, input, uploaded)))) {
        return { ok: false, ...STATE_CHANGED };
      }
      let pr = null;
      if (revisionKind === 'session' && !session.pr_number) {
        // A draft PR after the first upload. The commit is recorded whatever
        // happens here: a retry adopts a PR the host made before the
        // database write, or promotion makes it.
        pr = await steps.once('pr', async () => {
          try {
            await prMetadata.applyPrMetadata({
              pool, session, repoOwner: repo.owner, repoName: repo.repo,
              userMessage: '', ccSummary: '', username: user.username,
              userId: user.id, allowModelGeneration: false,
              preferredTitle: session.proposed_pr_title || session.session_title || null,
            });
          } catch (err) {
            if (durableSteps.isStopped(err)) throw err;
            log.warn('proposal-commit', 'Draft PR creation deferred after commit upload', {
              sessionId: session.id, code: err.code || null, err: err.message,
            });
          }
          return { number: session.pr_number || null, url: session.pr_url || null };
        });
      }
      if (revisionKind === 'proposal') {
        const reconciled = await steps.once('reconcile', async () => {
          const r = await proposalUpdate.reconcileManagedCommitUpload({ config, pool }, {
            session: { ...session, handoff_uploaded_sha: uploaded.sha, handoff_local_commit_sha: input.localCommitSha },
            expectedHeadSha: uploaded.sha,
          });
          return r.ok ? { ok: true } : {
            ok: false, code: r.code, message: r.message, retryable: !!r.retryable, headSha: r.headSha || null,
          };
        });
        if (!reconciled.ok) {
          const { STATUS_BY_CODE } = require('../routes/dev-flow');
          return {
            ok: false, status: STATUS_BY_CODE[reconciled.code] || (reconciled.retryable ? 503 : 409),
            error: reconciled.code, message: reconciled.message,
            ...(reconciled.headSha ? { headSha: reconciled.headSha } : {}),
          };
        }
      }
      return {
        surface: 'handoff',
        sessionId: Number(session.id),
        localCommitSha: input.localCommitSha,
        headSha: uploaded.sha,
        treeSha: uploaded.treeSha,
        branch: session.branch_name,
        prNumber: pr ? pr.number : (session.pr_number || null),
        prUrl: pr ? pr.url : (session.pr_url || null),
        uploaded: alreadyRecorded ? false : !!uploaded.created,
      };
    } finally {
      releaseOperation();
    }
  });
}

async function runTurn({ pool }, request, user, steps) {
  const input = request.input;
  const state = await turnState(pool, request, user, steps);
  if (state.refusal) {
    await dropPayload(pool, request);
    return { ok: false, ...state.refusal };
  }
  const { session, repo } = state;
  const committed = await commit(pool, request, session, repo, steps);
  if (!committed.ok) return committed;
  const { uploaded } = committed;
  // Multiple commits in one turn upload oldest-first; each expects the
  // previous one as its parent, which is the turn's head recorded here.
  const advanced = await steps.once('record', async () => !!(await localAgent.recordTurnHead(pool, {
    turnId: input.turnId, leaseId: input.leaseId, headSha: uploaded.sha,
  })));
  if (!advanced) return { ok: false, status: 409, error: 'turn_not_running' };
  return {
    surface: 'turn', headSha: uploaded.sha, treeSha: uploaded.treeSha, branch: session.branch_name,
    uploaded: !!uploaded.created,
  };
}

async function run(deps, request, user, steps) {
  return surfaceOf(request) === 'turn'
    ? runTurn(deps, request, user, steps)
    : runHandoff(deps, request, user, steps);
}

module.exports = { authorize, abandon, run, SURFACES };
