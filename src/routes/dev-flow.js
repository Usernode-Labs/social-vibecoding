'use strict';

// #1049: the alternate development flows, offered IN the platform.
//
// Usernode has had a second way to build for a while: instead of spending
// daily AI credits here, hand a work order to the coding agent the user
// already pays for — Claude Code (claude.ai/code) or Codex
// (chatgpt.com/codex) — let it push a branch to their own fork, and turn
// the result into an ordinary proposal. Every piece of that already worked.
// Almost nobody used it, because the ONLY door was the MCP connector:
// production has 299 accounts, one linked GitHub login and three
// external-agent tasks ever, while 32 distinct users have hit their daily
// credit limit. The flow was not missing; it was invisible.
//
// So these routes put the same engine behind the browser. They are thin:
// prepareWork / submitWork / inspectFork / inspectPushedBranch in
// services/external-agent-tasks.js are plain functions with no MCP
// coupling, and this file only resolves the app, shapes a status payload
// and maps the service's structured failures onto HTTP.
//
//   GET  /api/apps/:slug/dev-flow/status         → the walkthrough's state
//   POST /api/apps/:slug/external-tasks          → prepare a work order
//   POST /api/apps/:slug/external-tasks/:id/submit → open the PR + import
//   POST /api/apps/:slug/external-tasks/:id/submit-update → advance a proposal
//
// The connector is now one way in, not the way in. Anyone who has linked
// GitHub can run the whole flow from the dev chat.
//
// AUTH: all three sit behind the global /api/* gate (middleware/auth.js) and
// re-resolve the app through appAccess with 'collab' — the same bar the
// browser's own proposal paths use. The two POSTs additionally carry the
// same-origin check the connector-management routes use, because they spend
// a rate-limit slot and open a pull request.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const appAccess = require('../services/app-access');
const externalAgentTasks = require('../services/external-agent-tasks');
const githubLink = require('../services/github-link');
const connectorLimits = require('../services/connector-limits');

// The three values the picker can send. 'external' is deliberately absent:
// it is what normalizeAgent falls back to for an unrecognised MCP client,
// not something a person chooses from a list of two products.
const PICKABLE_AGENTS = ['claude-code', 'codex'];

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
  // #1347's two. `already_shared` is a 409 for the same reason the three
  // above are: the caller's picture of the work is out of date — it is already
  // a card in the In-progress area — rather than forbidden. `share_failed`
  // matches import_failed, its exact twin on the other destination.
  already_shared: 409,
  share_failed: 502,
};

// Same-origin guard for the two writes, copied in spirit from
// routes/mcp-remote.js's browserCsrf: these are cookie-authenticated
// mutations that spend a slot and can open a pull request, so a
// cross-origin form post must not reach them.
function sameOrigin(config, req, res) {
  if (req.headers.origin && req.headers.origin !== config.cliAuthOrigin) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite != null && fetchSite !== 'same-origin') {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

function sendFailure(res, result) {
  const status = STATUS_BY_CODE[result.code] || 400;
  return res.status(status).json({
    error: result.message || 'That did not work.',
    code: result.code || 'error',
    retryable: !!result.retryable,
    ...(result.settingsUrl ? { settingsUrl: result.settingsUrl } : {}),
    // `expectedBase` and `headSha` come from the update path (#1054): a
    // `base_mismatch` is only actionable if the client can say which commit to
    // rebase onto, and a `branch_moved` only if it can say where the proposal
    // is now.
    ...(result.expectedBase ? { expectedBase: result.expectedBase } : {}),
    ...(result.headSha ? { headSha: result.headSha } : {}),
  });
}

// The origin the service stamps into work orders and settings links. The
// canonical public origin, never the Host header a caller controls.
function originOf(config) {
  return config.cliAuthOrigin || '';
}

// The loopback the import runs through, so the browser flow reuses
// POST /api/apps/:slug/pr-import EXACTLY as the browser's own import button
// does — same access check, same announcement, same staging build kick.
// 127.0.0.1 + this process's own port, so it cannot leave the box.
function loopbackBase(config) {
  return `http://127.0.0.1:${config.port || 3000}`;
}

function taskDeps(pool, config) {
  return {
    pool,
    config,
    gh: require('../services/github'),
    githubLink,
    limits: connectorLimits,
    prompts: require('../services/prompts'),
  };
}

// How many live connector grants this account has. Advisory only — the
// walkthrough never requires one — but worth showing at the hand-off step,
// where "you already have Claude connected" changes the instructions from
// "paste this" to "or just tell Claude to pick it up".
async function connectorCount(pool, userId) {
  if (IS_STAGING) return 0;
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT t.grant_id)::int AS n
         FROM mcp_tokens t
        WHERE t.user_id = $1
          AND t.revoked_at IS NULL
          AND t.expires_at > clock_timestamp()`,
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

// The prepare path's version: the caller named a target, so its refusals are
// the CALLER's answer and are returned rather than swallowed. Shares the row
// and the describe function with the resume path below, so a hand-off the
// menu offered cannot be described one way here and another way on reload.
async function describeRequestedTarget(pool, user, app, origin, proposalId) {
  let session = null;
  try {
    session = await loadTargetSession(pool, proposalId);
  } catch (err) {
    log.warn('dev-flow', 'target proposal load failed', { proposalId, err: err.message });
    return {
      session: null,
      described: {
        ok: false,
        code: 'platform_unavailable',
        message: 'Usernode cannot read that session right now. Try again shortly.',
      },
    };
  }
  if (!session) {
    return {
      session: null,
      described: { ok: false, code: 'invalid_request', message: `Proposal ${proposalId} does not exist.` },
    };
  }
  return {
    session,
    described: externalAgentTasks.describeTargetProposal(session, user, app, origin),
  };
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
        // `?demo=1` is the promoted-proposal update order; `?demo=session`
        // (#1071) is the same walkthrough continuing a session nobody has
        // voted on. Two payloads because the difference a reviewer has to
        // check is entirely in the copy, and one of them cannot show both.
        const demoKind = req.query.demo === 'session' ? 'session' : 'proposal';
        return res.json(req.query.demo === '1' || req.query.demo === 'session'
          ? demoStatus(app, parsed, demoKind)
          : {
            // The venue sheet's own state: the web hand-offs are offerable,
            // nothing is linked, no work order exists. Fixture session
            // 990403 renders against exactly this, so ?shot=venue-sheet
            // shows the rows as a first-time user meets them; ?demo=1 moves
            // it on to the walkthrough behind one of them.
            // Nothing here can DO anything — both writes answer 503 in
            // staging — so this only decides what a reviewer can see.
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
      const task = await externalAgentTasks.loadLatestOpenTaskForSlug(pool, req.user.id, app.slug);
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

  // ── Prepare a work order ─────────────────────────────────────────────
  //
  // body { agent, brief?, issueNumber?, restart?, proposalId? }
  //
  // `proposalId` (#1071) names an existing session or promoted proposal this
  // work order CONTINUES rather than opening new work beside it. The options
  // menu sends it whenever it offered "Continue this session" or "Continue
  // this proposal"; the same predicate that decided the label is applied again
  // here, so a target that stopped being continuable in between is refused
  // instead of silently downgraded to a new change.
  //
  // Idempotent per (user, app, request) exactly as the connector's
  // prepare_work is — asking twice returns the task that already exists,
  // and only genuinely new work counts against the open-work-order cap.
  router.post('/api/apps/:slug/external-tasks', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!sameOrigin(config, req, res)) return undefined;

    // Not String(...): String(['codex']) is 'codex', so an array would slip
    // past the allowlist and reach prepareWork as a non-string.
    const agent = typeof req.body?.agent === 'string' ? req.body.agent : '';
    if (!PICKABLE_AGENTS.includes(agent)) {
      return res.status(400).json({ error: `agent must be one of ${PICKABLE_AGENTS.join(', ')}`, code: 'invalid_request' });
    }
    const brief = typeof req.body?.brief === 'string' ? req.body.brief : '';
    const rawIssue = req.body?.issueNumber;
    const issueNumber = Number.isInteger(rawIssue) && rawIssue > 0 ? rawIssue : null;
    // Same shape the submit-update route validates: an integer id, or absent.
    // A malformed one is a 400 rather than a quietly ignored field, because
    // ignoring it would open NEW work when the user asked to continue.
    const rawProposal = req.body?.proposalId;
    const hasProposal = rawProposal !== undefined && rawProposal !== null;
    if (hasProposal && !(Number.isInteger(rawProposal) && rawProposal > 0)) {
      return res.status(400).json({ error: 'proposalId must be a positive integer', code: 'invalid_request' });
    }
    const proposalId = hasProposal ? rawProposal : null;
    if (!brief.trim() && !issueNumber) {
      return res.status(400).json({
        error: 'Describe the change you want first: the work order needs something to hand your agent.',
        code: 'invalid_request',
      });
    }

    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab', '*');
      if (!app) return res.status(404).json({ error: 'App not found' });
      if (IS_STAGING) {
        return res.status(503).json({
          error: 'Preparing work for an external agent is disabled in a staging preview.',
          code: 'platform_unavailable',
        });
      }

      let targetSession = null;
      if (proposalId) {
        const target = await describeRequestedTarget(
          pool, req.user, app, originOf(config), proposalId
        );
        if (!target.described.ok) return sendFailure(res, target.described);
        targetSession = target.session;
      }

      const result = await externalAgentTasks.prepareWork(taskDeps(pool, config), {
        user: req.user,
        app,
        issueNumber,
        brief,
        agent,
        // prepareWork describes it again itself, which is deliberate: the
        // describe above is what turns a stale target into the caller's error
        // instead of a 500 further in.
        targetProposal: targetSession,
        // Recorded on the row, and the SAME string normalizeAgent reads
        // back on the status route — so the picked agent survives a reload
        // without adding a column.
        clientId: `usernode-web:${agent}`,
        clientName: 'Usernode',
        origin: originOf(config),
        restart: !!req.body?.restart,
      });
      if (!result.ok) return sendFailure(res, result);

      log.info('dev-flow', 'work order prepared', {
        userId: req.user.id, slug: app.slug, agent, taskId: result.taskId, reused: result.reused,
      });
      return res.json(result);
    } catch (err) {
      log.error('dev-flow', 'prepare failed', { slug: req.params.slug, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Submit the pushed branch ─────────────────────────────────────────
  //
  // body { title?, body?, branch?, forkRepo? }
  //
  // Opens the cross-fork pull request with the platform's own credentials
  // and hands it to /api/apps/:slug/pr-import, so what lands is an ordinary
  // imported proposal. Every gate the connector path applies (attribution,
  // promoted cap, proposal rate) applies here too — they live in
  // submitWork, not in the transport.
  router.post('/api/apps/:slug/external-tasks/:id/submit', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!sameOrigin(config, req, res)) return undefined;

    // Digits only — parseInt('1.5.2') is 1, which would submit a DIFFERENT
    // task than the one the caller named.
    const taskId = /^\d+$/.test(req.params.id) ? parseInt(req.params.id, 10) : NaN;
    if (!Number.isInteger(taskId) || taskId <= 0) {
      return res.status(400).json({ error: 'Bad task id', code: 'invalid_request' });
    }

    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab', '*');
      if (!app) return res.status(404).json({ error: 'App not found' });
      if (IS_STAGING) {
        return res.status(503).json({
          error: 'Submitting external work is disabled in a staging preview.',
          code: 'platform_unavailable',
        });
      }

      const cookie = req.headers.cookie || '';
      const importProposal = async (targetSlug, prNumber, extra = {}) => {
        try {
          const resp = await fetch(`${loopbackBase(config)}/api/apps/${encodeURIComponent(targetSlug)}/pr-import`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
              // The caller's OWN session, replayed: the import then runs
              // under exactly the authorization the browser had, and the
              // proposal is attributed to them rather than to the platform.
              cookie,
            },
            // `linkedIssues` is the request the task was prepared for
            // (#1217), forwarded so a browser-relayed submission links it
            // exactly as the connector's own does.
            body: JSON.stringify({
              pr: prNumber,
              promote: true,
              ...(extra.linkedIssues && extra.linkedIssues.length
                ? { linkedIssues: extra.linkedIssues }
                : {}),
            }),
          });
          const text = await resp.text();
          let parsed = null;
          try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
          return { ok: resp.ok, status: resp.status, body: parsed };
        } catch (err) {
          log.warn('dev-flow', 'pr-import loopback failed', { err: err.message });
          return { ok: false, status: 0, body: null, networkError: true };
        }
      };

      const result = await externalAgentTasks.submitWork(taskDeps(pool, config), {
        user: req.user,
        clientName: 'Usernode',
        clientId: 'usernode-web',
        taskId,
        slug: app.slug,
        branch: typeof req.body?.branch === 'string' ? req.body.branch : undefined,
        forkRepo: typeof req.body?.forkRepo === 'string' ? req.body.forkRepo : undefined,
        title: typeof req.body?.title === 'string' ? req.body.title : undefined,
        body: typeof req.body?.body === 'string' ? req.body.body : undefined,
        source: 'web',
        importProposal,
      });
      if (!result.ok) return sendFailure(res, result);

      log.info('dev-flow', 'external work submitted', {
        userId: req.user.id, slug: app.slug, taskId,
        proposalId: result.proposalId, via: result.submittedVia,
      });
      return res.json(result);
    } catch (err) {
      log.error('dev-flow', 'submit failed', { slug: req.params.slug, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Advance a proposal that is already up for a vote (#1054) ──────────
  //
  // body { proposalId, branch?, forkRepo?, expectedHeadSha? }
  //
  // The browser twin of submit_work's proposalId shape. It is the same
  // submitWork entry point, and it reaches the push through the same loopback
  // POST /api/apps/:slug/proposals/:id/update-from-fork the connector uses —
  // so the ownership gate, the fork-attribution gate and the lease all live in
  // one place, and this file cannot be the path that skips one.
  //
  // `:id` is the TASK, matching the submit route beside it. The proposal it
  // advances comes from the body, and submitUpdate refuses the pair when the
  // task was prepared for a different proposal.
  router.post('/api/apps/:slug/external-tasks/:id/submit-update', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!sameOrigin(config, req, res)) return undefined;

    const taskId = /^\d+$/.test(req.params.id) ? parseInt(req.params.id, 10) : NaN;
    if (!Number.isInteger(taskId) || taskId <= 0) {
      return res.status(400).json({ error: 'Bad task id', code: 'invalid_request' });
    }
    const rawProposal = req.body?.proposalId;
    const proposalId = Number.isInteger(rawProposal) && rawProposal > 0 ? rawProposal : null;
    if (!proposalId) {
      return res.status(400).json({
        error: 'proposalId must be the id of one of your proposals that is up for a vote.',
        code: 'invalid_request',
      });
    }

    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab', '*');
      if (!app) return res.status(404).json({ error: 'App not found' });
      if (IS_STAGING) {
        return res.status(503).json({
          error: 'Updating a proposal is disabled in a staging preview.',
          code: 'platform_unavailable',
        });
      }

      const cookie = req.headers.cookie || '';
      const updateProposal = async (targetSlug, id, payload) => {
        try {
          const resp = await fetch(
            `${loopbackBase(config)}/api/apps/${encodeURIComponent(targetSlug)}/proposals/${encodeURIComponent(id)}/update-from-fork`,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                accept: 'application/json',
                // The caller's OWN session, replayed — same reasoning as the
                // import loopback above.
                cookie,
              },
              body: JSON.stringify(payload),
            }
          );
          const text = await resp.text();
          let parsed = null;
          try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
          return { ok: resp.ok, status: resp.status, body: parsed };
        } catch (err) {
          log.warn('dev-flow', 'update-from-fork loopback failed', { err: err.message });
          return { ok: false, status: 0, body: null, networkError: true };
        }
      };

      const result = await externalAgentTasks.submitWork(taskDeps(pool, config), {
        user: req.user,
        clientName: 'Usernode',
        clientId: 'usernode-web',
        taskId,
        proposalId,
        slug: app.slug,
        branch: typeof req.body?.branch === 'string' ? req.body.branch : undefined,
        forkRepo: typeof req.body?.forkRepo === 'string' ? req.body.forkRepo : undefined,
        expectedHeadSha: typeof req.body?.expectedHeadSha === 'string' ? req.body.expectedHeadSha : undefined,
        source: 'web',
        updateProposal,
      });
      if (!result.ok) return sendFailure(res, result);

      log.info('dev-flow', 'proposal updated', {
        userId: req.user.id, slug: app.slug, taskId, proposalId,
        via: result.submittedVia, votesCleared: result.votesCleared,
      });
      return res.json(result);
    } catch (err) {
      log.error('dev-flow', 'update failed', { slug: req.params.slug, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

// Staging mock data. Same rules as every other ?demo=1 branch on the
// platform: obviously fake, read-only, written nowhere, impossible in
// production (IS_STAGING gates the caller). It puts the walkthrough at
// step 4 — GitHub linked, fork ready, work order in hand, branch not yet
// pushed — because that is the step with the most to review.
//
// The work order is an UPDATE one (#1054): the update branch is the harder of
// the two to review, it renders every ordinary step as well, and a reviewer
// who only ever sees the new-proposal copy cannot check the difference.
function demoStatus(app, parsed, targetKind) {
  const owner = (parsed && parsed.owner) || 'usernode-apps';
  const repo = (parsed && parsed.repo) || app.slug;
  const login = 'octo-contributor';
  const continuing = targetKind === 'session';
  const branch = continuing
    ? 'staging-fixture/session-options'
    : 'usernode/staging-fixture-1049';
  const baseSha = '0123456789abcdef0123456789abcdef01234567';
  return {
    available: true,
    reason: null,
    demo: true,
    repo: { owner, repo },
    github: { linked: true, login, available: true },
    connectors: { count: 1 },
    fork: {
      state: 'ready',
      owner: login,
      repo,
      url: `https://github.com/${login}/${repo}`,
      pageUrl: `https://github.com/${owner}/${repo}/fork`,
    },
    task: {
      id: 990501,
      agent: 'claude-code',
      branch,
      baseSha,
      forkOwner: login,
      forkRepo: repo,
      forkUrl: `https://github.com/${login}/${repo}`,
      forkPageUrl: `https://github.com/${owner}/${repo}/fork`,
      issueNumber: null,
      brief: continuing
        ? 'Finish the options menu this session started.'
        : 'Add a dark-mode toggle to the settings screen.',
      // An array, exactly as renderPreparedTask returns — a reviewer looking
      // at the demo payload should see the real shape, not a stand-in one.
      guidance: [
        `Fork ${owner}/${repo} on GitHub. Your fork is ${login}/${repo}.`,
        'Open https://claude.ai/code and start a new session.',
        `Choose ${login}/${repo} as its repository.`,
        'Paste the work order below in exactly as written.',
        'Come back here when it has pushed; Usernode submits the change itself.',
      ],
      workOrder: (continuing
        ? [
          `You are CONTINUING work in progress on the Usernode app "${app.name || app.slug}".`,
          '',
          `Repository to fork from: https://github.com/${owner}/${repo}`,
          `Your fork: https://github.com/${login}/${repo}`,
          `Branch to create: ${branch}`,
          `Base commit: ${baseSha}`,
          '',
          'THE WORK YOU ARE CONTINUING',
          '- Usernode session id:                   990405',
          '- Its title:                             [staging fixture] Session and billing options',
          '- Where its head lives:                  a branch in the app\'s own repository',
          '',
          'NOBODY HAS VOTED ON THIS YET, so there is nothing to invalidate, but this is',
          'a session somebody is still working in, and they may take more turns on it',
          'after you.',
          '',
          'TASK',
          'Finish the options menu this session started.',
          '',
          'When you are done, commit and push the branch, then come back to',
          'Usernode and press "Submit the update".',
        ]
        : [
          `You are UPDATING a proposal on the Usernode app "${app.name || app.slug}".`,
          '',
          `Repository to fork from: https://github.com/${owner}/${repo}`,
          `Your fork: https://github.com/${login}/${repo}`,
          `Branch to create: ${branch}`,
          `Base commit: ${baseSha}`,
          '',
          'THE PROPOSAL YOU ARE UPDATING',
          '- Usernode proposal id:                  990601',
          '- Its title:                             Add a dark-mode toggle',
          '- Where its head lives:                  a branch in your own fork',
          '',
          'TASK',
          'The dark-mode toggle proposal has a failing check. Fix it.',
          '',
          'When you are done, commit and push the branch, then come back to',
          'Usernode and press "Submit the update".',
        ]).join('\n'),
      // The proposal or session this order continues. `null` on an ordinary
      // work order.
      targetProposal: continuing
        ? {
          id: 990405,
          title: '[staging fixture] Session and billing options',
          targetKind: 'session',
          branchHome: 'app_repo',
          webPath: `/#app/${app.slug}/dev/sessions/990405`,
        }
        : {
          id: 990601,
          title: 'Add a dark-mode toggle',
          targetKind: 'proposal',
          branchHome: 'user_fork',
          webPath: `/#app/${app.slug}/dev/sessions/990601`,
        },
    },
    branch: shapeBranch('missing'),
  };
}

module.exports = { devFlowRoutes, PICKABLE_AGENTS, STATUS_BY_CODE, shapeBranch };
