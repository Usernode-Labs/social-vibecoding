'use strict';

// `draft.update`, a platform operation (services/platform-operations.js):
// 20 Nov 2026 (live-draft review, C). A live draft survives Propose: its
// proposal is a change of its own, and the edits made after it stay on the
// draft's branch until its author taps Update proposal (POST
// /api/live-drafts/:id/update, live-drafts.js updateProposal). That route
// checks the draft and asks for this, waiting for its answer. Here, on a
// conductor:
//
//   advance   the proposal's branch moved to the draft's head, as a
//             fast-forward only (github.js advanceBranchToSha): the proposal
//             began at the draft's head and every edit since is on top of
//             it, so anything else means the proposal moved some other way
//             (brought up to date with main, say), and it is refused rather
//             than overwritten
//   settle    the head-moved machinery the bot's own commits go through
//             (proposal-update.js settleLandedHead): an authored move clears
//             the votes, says so in the change's discussion, and builds the
//             preview and the checks again
//
// Both under the proposal lock every revision writer of a proposal takes,
// and each kept as a step, so a retry after a lost reply never moves the
// branch twice. Input: { draftId, sessionId, head }.

const github = require('./github');
const repoRef = require('./repo-ref');
const appAccess = require('./app-access');
const communities = require('./communities');
const log = require('./logger');

const SHA = /^[0-9a-f]{40}$/i;

async function draftOf(pool, request) {
  const { draftId, sessionId } = request.input || {};
  const { rows: [row] } = await pool.query(
    `SELECT d.id, d.user_id, d.app_id, d.state, d.head_sha, d.proposal_session_id, d.proposed_head_sha,
            a.slug AS app_slug, a.repo_url, ps.status AS proposal_status, ps.branch_name AS proposal_branch
       FROM live_drafts d
       JOIN apps a ON a.id = d.app_id
       LEFT JOIN chat_sessions ps ON ps.id = d.proposal_session_id
      WHERE d.id = $1`,
    [Number(draftId)],
  );
  if (!row || Number(row.app_id) !== Number(request.appId)) return null;
  if (Number(row.proposal_session_id) !== Number(sessionId)) return null;
  return row;
}

async function authorize({ pool }, request, user, { steps = null } = {}) {
  const draft = await draftOf(pool, request);
  if (!draft || Number(draft.user_id) !== Number(user.id)) return { status: 404, error: 'No such draft of yours.' };
  if (draft.state !== 'proposed') return { status: 409, error: 'This draft is no longer up for a vote.' };
  if (!SHA.test(String(request.input?.head || ''))) return { status: 400, error: 'bad_head' };
  const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [draft.app_id]);
  if (!app || !(await appAccess.checkAppAccess(pool, app, user, 'collab'))) return { status: 404, error: 'No such draft of yours.' };
  const join = await communities.appNeedsJoin(pool, app.slug, user);
  if (join) return { status: 403, ...join };
  // A move this very request made already (its `advance` step) is its own.
  if (!steps?.has?.('advance') && draft.proposal_status !== 'promoted') {
    return { status: 409, error: 'The proposal cannot be updated right now: it may be going live. Try again in a minute.' };
  }
  if (!draft.proposal_branch) return { status: 409, error: 'The proposal has no branch.' };
  return null;
}

async function run({ config, pool }, request, _user, steps) {
  const draft = await draftOf(pool, request);
  if (!draft) return { ok: false, status: 404, error: 'No such draft of yours.' };
  const { owner, repo } = repoRef.ownerRepo(draft.repo_url) || {};
  if (!owner || !repo) return { ok: false, status: 409, error: 'That project has no code.' };
  const head = String(request.input.head).toLowerCase();
  const sessionId = Number(draft.proposal_session_id);
  const proposalUpdate = require('./proposal-update');
  return proposalUpdate.withProposalLock(pool, sessionId, async () => {
    const moved = await steps.once('advance', async () => {
      try {
        const out = await github.advanceBranchToSha(owner, repo, draft.proposal_branch, head);
        return { ok: true, previousSha: out.previousSha || null, updated: !!out.updated };
      } catch (err) {
        if (err.code === 'non_fast_forward') return { ok: false };
        throw err;
      }
    });
    if (!moved.ok) {
      log.warn('live-draft-update', 'A draft\'s proposal moved some other way', { draftId: draft.id, sessionId });
      return {
        ok: false, status: 409, code: 'branch_moved',
        error: 'The proposal changed since this draft was proposed (it may have been brought up to date with main), so the draft cannot update it.',
      };
    }
    await pool.query(
      'UPDATE live_drafts SET proposed_head_sha = $2, proposed_at = NOW(), updated_at = NOW() WHERE id = $1',
      [draft.id, head],
    );
    const settled = await steps.once('settle', async () => {
      const { rows: [session] } = await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [sessionId]);
      if (!session) return { tail: 'none', rebuilding: false };
      const out = await proposalUpdate.settleLandedHead({ config, pool, session, headSha: head, via: 'homeroom' });
      return { tail: out?.tail || 'none', rebuilding: !!out?.rebuilding };
    });
    log.info('live-draft-update', 'A draft\'s proposal moved to the draft\'s head', {
      draftId: draft.id, sessionId, head, previousSha: moved.previousSha, tail: settled.tail,
    });
    return { updated: true, head, rebuilding: !!settled.rebuilding };
  });
}

module.exports = { authorize, run };
