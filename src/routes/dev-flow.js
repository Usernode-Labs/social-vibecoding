'use strict';

// #1049: the alternate development flow's status, for the browser.
//
// Instead of spending AI credits here, a person can hand the work to the
// coding agent they already pay for — Claude Code (claude.ai/code) or Codex
// (chatgpt.com/codex) — which mints its own work order through the Homeroom
// connector (prepare_work), pushes a branch to their fork, and turns the
// result into an ordinary proposal (submit_work). The request page's "own
// agent" link reads where that stands for the viewer:
//
//   GET  /api/apps/:slug/dev-flow/status         → the walkthrough's state
//
// AUTH: behind the global /api/* gate (middleware/auth.js), and the app is
// re-resolved through appAccess with 'collab', the same bar the browser's
// own proposal paths use.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const appAccess = require('../services/app-access');
const externalAgentTasks = require('../services/external-agent-tasks');
const prompts = require('../services/prompts');
const githubLink = require('../services/github-link');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// Service failure code → HTTP status. Anything unmapped is a 400: the
// service's failures are all "you or your GitHub account needs to do
// something", never a bug on this side, and the client renders the
// service's own wording either way. The keys are the complete set of codes
// external-agent-tasks.js, proposal-update.js and connector-limits.js can
// emit, and tests/dev-flow-routes.test.js scrapes all three files to keep it
// that way — an unmapped code would answer 400 for something that is really a
// 429 or a 502, which is what a retry policy reads.
const STATUS_BY_CODE = {
  no_repository: 409,
  platform_unavailable: 503,
  // Homeroom did not decide the move in time: nothing changed, ask again.
  not_decided: 503,
  github_link_unavailable: 503,
  github_not_linked: 409,
  unknown_task: 404,
  no_access: 403,
  fork_mismatch: 403,
  fork_collab_denied: 403,
  branch_not_found: 409,
  no_commits: 409,
  already_submitted: 409,
  pr_open_failed: 502,
  import_failed: 502,
  invalid_request: 400,
  invalid_visible_changes: 400,
  at_capacity: 429,
  // The update path (#1054). Three of these are 409 rather than 403 on
  // purpose: `base_mismatch` and `branch_moved` mean the caller's picture of
  // the proposal is out of date, and `session_busy` means "not now", which is
  // a conflict with the world's state, not a permission problem.
  not_your_proposal: 403,
  not_your_fork: 403,
  proposal_closed: 409,
  base_mismatch: 409,
  branch_moved: 409,
  session_busy: 409,
  fork_branch_not_found: 404,
  // #1350: the session exists and is the caller's, but no turn has run on
  // it yet so there is no branch to continue from. A 409 for the same
  // reason as the three above: the caller's picture of the session is out
  // of date, and the remedy is an action, not a permission.
  session_not_started: 409,
  // #1347's two. `already_shared` is a 409 for the same reason the three
  // above are: the caller's picture of the work is out of date — it is already
  // a card in the In-progress area — rather than forbidden. `share_failed`
  // matches import_failed, its exact twin on the other destination.
  already_shared: 409,
  share_failed: 502,
  // #4266: closeWorkOrder's answer for a work order closed before. Only the
  // connector's close_work_order emits it today; mapped like already_submitted,
  // its sibling, so no service code answers a bare 400 here.
  already_closed: 409,
  // An app on Homeroom's own git host takes a patch, never a branch or a pull
  // request number: the caller's request was the wrong shape, as for
  // invalid_request. And a proposal there whose code did not come across from
  // GitHub (services/code-missing.js) cannot be revised: a 409, the state of
  // the world rather than the caller's request.
  patch_required: 400,
  code_missing: 409,
};

// The origin the service stamps into work orders and settings links. The
// canonical public origin, never the Host header a caller controls.
function originOf(config) {
  return config.cliAuthOrigin || '';
}

// How many live connector grants this account has. Advisory only — the
// walkthrough never requires one — but worth showing at the hand-off step,
// where "you already have Claude connected" changes the instructions from
// "paste this" to "or just tell Claude to pick it up". A delegated grant
// (#2779) is the platform's own agent, not a connected chat product, so it
// never counts.
async function connectorCount(pool, userId) {
  if (IS_STAGING) return 0;
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT t.grant_id)::int AS n
         FROM mcp_tokens t
        WHERE t.user_id = $1
          AND t.revoked_at IS NULL
          AND t.expires_at > clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM mcp_delegations d WHERE d.grant_id = t.grant_id)`,
      [userId]
    );
    return rows[0]?.n || 0;
  } catch {
    // mcp_tokens is staging:private and the whole connector feature can be
    // switched off — an unreadable count is "none", never a failed status.
    return 0;
  }
}

// The proposal an open UPDATE task revises (#1054), re-derived so reopening
// the chat resumes the update walkthrough instead of showing a work order
// that has forgotten what it was for. Deliberately the SAME describe function
// the prepare path uses, against the same row, so the resumed order cannot
// disagree with the original one — including its refusals: a proposal that
// merged while the agent worked stops being offered here too.
// One loader for both callers, so the prepare path and the resume path read
// the same columns. `session_title` is here for #1071: a session that was
// never promoted has no `pr_title`, and the work order still wants to name the
// work it is continuing.
async function loadTargetSession(pool, proposalId) {
  const { rows } = await pool.query(
    `SELECT id, user_id, app_id, status, source, branch_name,
            imported_pr_head_sha, pr_title, session_title
       FROM chat_sessions
      WHERE id = $1`,
    [proposalId]
  );
  return rows[0] || null;
}

async function reloadTargetProposal(pool, user, app, origin, task) {
  const proposalId = Number(task && task.target_session_id);
  if (!Number.isSafeInteger(proposalId) || proposalId <= 0) return null;
  let session = null;
  try {
    session = await loadTargetSession(pool, proposalId);
  } catch (err) {
    log.warn('dev-flow', 'target proposal reload failed', { proposalId, err: err.message });
    return null;
  }
  if (!session) return null;
  const described = externalAgentTasks.describeTargetProposal(session, user, app, origin);
  return described.ok ? described : null;
}

// inspectPushedBranch answers with a bare string. The walkthrough wants a
// shape it can render three ways, so the mapping lives here rather than
// being re-derived in the client.
function shapeBranch(state) {
  return {
    state,
    pushed: state === 'pushed',
    // 'unpushed' is the one state worth naming out loud: the branch exists
    // but still points at the commit it started from, which is "you
    // committed locally and never pushed" almost every time.
    unpushed: state === 'unpushed',
    missing: state === 'missing',
  };
}

function devFlowRoutes(config) {
  const router = Router();
  const pool = getPool();

  // ── The walkthrough's state ──────────────────────────────────────────
  //
  // One request answers every step: is GitHub linked, is there a fork, is
  // there a work order already, has the branch been pushed. The client
  // re-polls this on "Check again" and when the tab regains focus, which is
  // what makes the guided flow feel like it is watching along.
  router.get('/api/apps/:slug/dev-flow/status', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab', '*');
      if (!app) return res.status(404).json({ error: 'App not found' });

      const gh = require('../services/github');
      const parsed = app.repo_url ? gh.parseGithubUrl(app.repo_url) : null;
      const linkAvailable = githubLink.isEnabled(config);

      // Staging mock data (#555 convention): external_agent_tasks and
      // mcp_tokens are both staging:private, and a staging clone has no
      // GitHub OAuth app either — so without this a reviewer sees the
      // "unavailable" branch and can review nothing. Obviously-fake,
      // read-only, written nowhere, and a strict no-op in production.
      if (IS_STAGING) {
        // The state a first-time user meets: nothing is linked, no connector,
        // no fork, no work order. The own agent link then leaves the
        // repository to the person and says a connector is needed.
        return res.json({
          available: true,
          reason: null,
          demo: true,
          repo: parsed || null,
          github: { linked: false, login: null, available: true },
          connectors: { count: 0 },
          fork: null,
          task: null,
          branch: null,
        });
      }

      if (!parsed || !gh.isEnabled() || !linkAvailable) {
        return res.json({
          available: false,
          reason: !parsed ? 'no_repository' : (!gh.isEnabled() ? 'platform_unavailable' : 'link_unavailable'),
          repo: parsed || null,
          github: { linked: false, login: null, available: linkAvailable },
          connectors: { count: await connectorCount(pool, req.user.id) },
          fork: null,
          task: null,
          branch: null,
        });
      }

      const link = await githubLink.linkStatus(pool, req.user.id);
      const linked = !!(link && link.linked && link.login);
      const payload = {
        available: true,
        reason: null,
        repo: { owner: parsed.owner, repo: parsed.repo },
        github: { linked, login: linked ? link.login : null, available: true },
        connectors: { count: await connectorCount(pool, req.user.id) },
        fork: null,
        task: null,
        branch: null,
      };

      if (!linked) return res.json(payload);

      // Step 2. Advisory exactly as it is inside prepareWork: a read that
      // fails reports 'unknown' rather than asserting the user has no fork.
      const fork = await externalAgentTasks.inspectFork(link.login, parsed);
      const forkState = ['ready', 'name_conflict', 'unknown'].includes(fork.state)
        ? fork.state
        : 'missing';
      const forkRepoName = forkState === 'name_conflict'
        ? `${parsed.repo}${externalAgentTasks.CONFLICT_FORK_SUFFIX}`
        : ((fork.fork && fork.fork.name) || parsed.repo);
      payload.fork = {
        state: forkState,
        owner: link.login,
        repo: forkRepoName,
        url: `https://github.com/${link.login}/${forkRepoName}`,
        pageUrl: `https://github.com/${parsed.owner}/${parsed.repo}/fork`,
      };

      // Steps 3-5. An open task is RE-RENDERED from its stored values —
      // same branch, same base commit — so reopening the chat resumes the
      // walkthrough instead of restarting it.
      //
      // `unexpiredOnly` because resumable is not the same as permanent. Nothing
      // sweeps expired rows, so without it a reservation nobody ever submitted
      // keeps answering for this app after it has stopped counting against the
      // cap and stopped being reusable by prepareWork — leaving the launchpad
      // showing step 3 done, with no way to say what to build instead.
      //
      // What the launchpad hands over now: short, static platform copy telling
      // the agent to ask what to build and then mint its own work order.
      //
      // Set unconditionally, and that is the point — it must NOT hang off a
      // task the way everything here used to, because the browser no longer
      // mints one.
      payload.targetKind = null;
      payload.instructions = prompts.getLaunchpadInstructions({
        appName: app.name,
        slug: app.slug,
        targetProposalId: null,
      });

      const task = await externalAgentTasks.loadLatestOpenTaskForSlug(
        pool, req.user.id, app.slug, { unexpiredOnly: true }
      );
      if (task) {
        const targetProposal = await reloadTargetProposal(
          pool, req.user, app, originOf(config), task
        );
        const rendered = externalAgentTasks.renderPreparedTask({
          task,
          app,
          owner: parsed.owner,
          repo: parsed.repo,
          origin: originOf(config),
          targetProposal,
          // The agent this task was prepared for. The browser flow records
          // it as the client id (`usernode-web:<agent>`), which is exactly
          // what normalizeAgent reads — so the choice survives a reload
          // without a column of its own.
          clientId: task.client_id,
          prompts: require('../services/prompts'),
          forkStatus: forkState,
          reused: true,
        });
        payload.task = {
          id: rendered.taskId,
          agent: rendered.agent,
          branch: rendered.branch,
          baseSha: rendered.baseSha,
          forkOwner: rendered.forkOwner,
          forkRepo: rendered.forkRepo,
          forkUrl: rendered.forkUrl,
          forkPageUrl: rendered.forkPageUrl,
          issueNumber: task.issue_number || null,
          brief: task.brief || '',
          guidance: rendered.guidance,
          workOrder: rendered.workOrder,
          // Present only for an UPDATE task (#1054). `null` on every ordinary
          // work order, which is what the client branches on: with it, the
          // walkthrough's last step submits onto an existing proposal instead
          // of opening a new one.
          targetProposal: targetProposal
            ? {
              id: targetProposal.proposalId,
              title: targetProposal.title,
              // 'proposal' | 'session' (#1071). The walkthrough says "Submit
              // the update" either way, and everything it says ABOUT the
              // submission — votes cleared or not — branches on this.
              targetKind: targetProposal.targetKind || 'proposal',
              branchHome: targetProposal.branchHome,
              webPath: targetProposal.webPath,
            }
            : null,
        };
        let branchState = 'unknown';
        try {
          branchState = await externalAgentTasks.inspectPushedBranch(
            task, task.branch_name, task.fork_repo
          );
        } catch (err) {
          log.warn('dev-flow', 'branch inspect failed', { taskId: task.id, err: err.message });
        }
        payload.branch = shapeBranch(branchState);
      }

      return res.json(payload);
    } catch (err) {
      log.error('dev-flow', 'status failed', { slug: req.params.slug, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { devFlowRoutes, STATUS_BY_CODE, shapeBranch };
