'use strict';

// The fork flows' platform operations (services/platform-operations.js):
// the code-host writes that land a coding agent's work, from its author's
// fork or as a patch, made on a conductor (docs/plans/web-and-conductor.md,
// "Privileged operations"). The route or the service that takes the work
// keeps every check and refusal it always made, then asks for one of these
// and waits for its answer:
//
//   fork.update   POST /api/apps/:slug/proposals/:id/update-from-fork
//                 (routes/proposal-handoff.js; the connector's and the
//                 browser's update loopbacks reach it): a proposal's or a
//                 session's next commits, from a fork branch or a patch,
//                 pushed under a lease onto its branch in the app's
//                 repository, then its title, description, request links,
//                 summary and draft pull request
//                 (services/proposal-update.js updateProposalFromForkBranch)
//   work.share    POST /api/apps/:slug/work/share-in-progress: the session a
//                 shared piece of work becomes, then the same landing onto
//                 its new branch
//   work.submit   submit_work's new work (services/external-agent-tasks.js
//                 openSubmission): a patch applied onto a fresh branch, the
//                 fork branch mirrored onto one, or a cross-fork pull
//                 request, and the pull request it opens
//   work.discard  that fresh branch removed, when no proposal could be made
//                 of it
//
// What each reads again here, on every attempt, before any write it still
// has to make (the requester's account is read by platform-operations):
//
//   fork.update   collab access, the proposal on this project, its author
//                 and its being open to a revision (the ownership gate),
//                 and, off Homeroom's git host, the deployment's GitHub link
//                 and the caller's linked login. The lease is the push's own
//                 (proposal-update reads the head under its lock).
//   work.share    collab access, membership, the active-session cap and the
//                 linked login. The session it makes is its claim on a slot:
//                 once made, it is this request's, not a competitor
//                 (`steps`), and a request refused before its commits landed
//                 gives it back (abandon).
//   work.submit   the task: the requester's, open, new work and, for a
//                 branch, not already shared; collab access, membership,
//                 and off the git host the linked login, which is the
//                 attribution gate's anchor.
//   work.discard  the task, and a branch name that is that task's own.
//
// A request's large input (a patch, the notes a revision carries) is its
// payload (platform_operation_inputs): read by `run`, dropped once it ends.
// A run that ends answers in the caller's own words; one that throws is
// tried again from its last step.

const appAccess = require('./app-access');
const communities = require('./communities');
const repoRef = require('./repo-ref');
const log = require('./logger');

// How long the routes and the service wait for an answer. A fork's fetch and
// a push are minutes at worst (external-agent-head GIT_TIMEOUT_MS bounds
// each git process at two), and they used to run inside the request: past
// this the caller is told the work is still under way (503
// operation_pending), and it finishes. Under the loopbacks' own four or five
// minutes (undici's header timeout).
const WAIT_MS = 4 * 60 * 1000;

const ops = () => require('./platform-operations');
const statusByCode = () => require('../routes/dev-flow').STATUS_BY_CODE;

async function loadApp(pool, appId) {
  const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [appId]);
  return app || null;
}

// The proposal as the update route loads it, on this project.
async function loadProposal(pool, sessionId, appId) {
  const { rows: [session] } = await pool.query(
    `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url,
            a.collab_visibility, a.view_visibility
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
      WHERE cs.id = $1 AND cs.app_id = $2`,
    [sessionId, appId]
  );
  return session || null;
}

// A refusal in proposal-update's words ({ code, message, ... }) as the update
// route answers it: one code→status map (routes/dev-flow.js), the same body.
function asRouteRefusal(result) {
  return {
    status: statusByCode()[result.code] || 400,
    error: result.code,
    message: result.message,
    ...(result.retryable ? { retryable: true } : {}),
    ...(result.expectedBase ? { expectedBase: result.expectedBase } : {}),
    ...(result.headSha ? { headSha: result.headSha } : {}),
    ...(result.settingsUrl ? { settingsUrl: result.settingsUrl } : {}),
  };
}

function origin(config) {
  return (config && config.cliAuthOrigin) || null;
}

const deps = ({ config, pool }) => ({
  config, pool, gh: require('./github'), githubLink: require('./github-link'),
});

// The run reads it on every attempt; one swept or dropped is answered, not
// retried: nothing was written for it that a retry could finish.
function gone() {
  return {
    ok: false, code: 'platform_unavailable', retryable: true,
    message: 'Homeroom lost this request before it could finish it. Send it again.',
  };
}

// The update's own fields, as the route parsed them.
function updateParams(payload) {
  return {
    branch: payload.branch ?? null,
    patch: payload.patch != null ? Buffer.from(String(payload.patch), 'base64').toString('utf8') : null,
    forkRepo: payload.forkRepo ?? null,
    expectedHeadSha: payload.expectedHeadSha ?? null,
    testing: payload.testing,
    ...(payload.visibleChanges !== undefined ? { visibleChanges: payload.visibleChanges } : {}),
    title: payload.title ?? null,
    description: payload.description ?? null,
    summary: payload.summary ?? null,
    recheck: payload.recheck === true,
    linkedIssues: payload.linkedIssues ?? null,
  };
}

// ── fork.update ──────────────────────────────────────────────────────

const forkUpdate = {
  async authorize({ config, pool }, request, user) {
    const app = await loadApp(pool, request.appId);
    if (!app || !(await appAccess.checkAppAccess(pool, app, user, 'collab'))) return { status: 404, error: 'App not found' };
    const session = await loadProposal(pool, request.input.sessionId, app.id);
    if (!session) return { status: 404, error: 'not_found', message: 'That proposal is not on this app.' };
    const authority = await require('./proposal-update').updateAuthority(deps({ config, pool }), {
      session, user, origin: origin(config),
    });
    return authority.refusal ? asRouteRefusal(authority.refusal) : null;
  },

  async run({ config, pool }, request, user, steps, payload) {
    const session = await loadProposal(pool, request.input.sessionId, request.appId);
    if (!session) return { ok: false, status: 404, error: 'not_found', message: 'That proposal is not on this app.' };
    return require('./proposal-update').updateProposalFromForkBranch({ pool, config, steps }, {
      user, session, ...updateParams(payload), origin: origin(config),
    });
  },
};

// ── work.share ───────────────────────────────────────────────────────

async function sharedSession(pool, request, steps) {
  const saved = steps.get('session');
  if (saved) return saved;
  const branch = steps.get('branch-name');
  if (!branch) return null;
  const { rows: [found] } = await pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND user_id = $2 AND branch_name = $3',
    [request.appId, request.userId, branch]
  );
  return found?.id || null;
}

const share = {
  async authorize({ config, pool }, request, user, { steps }) {
    const app = await loadApp(pool, request.appId);
    if (!app || !(await appAccess.checkAppAccess(pool, app, user, 'collab'))) return { status: 404, error: 'App not found' };
    const join = await communities.appNeedsJoin(pool, app.slug, user);
    if (join) return { status: 403, ...join };
    // The slot this request's own session holds is not a competitor's.
    if (!(await sharedSession(pool, request, steps))) {
      const cap = await require('./connector-limits').checkActiveCap(pool, config, user);
      if (cap) return { status: cap.code === 'not_decided' ? 503 : 429, error: cap.code, message: cap.message, retryable: true };
    }
    // The landing's first refusals (GitHub, the account link), read before
    // a session is made for it, in the landing's own words.
    const linked = await require('./proposal-update').linkAuthority(deps({ config, pool }), {
      user, hostedRepo: repoRef.isHosted(app.repo_url), origin: origin(config),
    });
    return linked.refusal ? asRouteRefusal(linked.refusal) : null;
  },

  // A request refused before its commits landed (its requester lost access)
  // gives back the session it made, as a share the landing refused always
  // has: a card with no commits behind it is worse than the refusal.
  async abandon({ pool }, request, steps) {
    const sessionId = await sharedSession(pool, request, steps);
    if (!sessionId || steps.scope('update').get('push')?.ok) return;
    await dropSession(pool, sessionId, request.userId);
  },

  async run({ config, pool }, request, user, steps, payload) {
    const app = await loadApp(pool, request.appId);
    if (!app) return { ok: false, status: 404, error: 'App not found' };
    // ── The branch the ROW carries is the app repository's, not the fork's
    //
    // `payload.branch` is a branch in the caller's own fork; `branch_name`
    // on a session is the branch in the APP's repository that everything
    // downstream reads — the landing below pushes to it, promote opens its
    // pull request from it, and `platformOwnedBranch` decides from its NAME
    // that a row with no `source` lives in the app repo. So it is minted
    // here, in `usernode/from-…`, exactly like the mirror rung's own heads,
    // and kept: a retry lands on the same branch. The branch does not exist
    // yet — the landing creates it — which is the first-landing case of
    // updateProposalFromForkBranch.
    const appRepoBranch = await steps.once('branch-name',
      () => require('./external-agent-head').shareBranchName(user.id));
    // `shared_at` at creation, not afterwards: the point of the call is that
    // the card is visible, and a row that exists unshared for even one
    // failed statement is a private session the caller never asked for. An
    // earlier try's insert whose answer was lost is this request's own,
    // found by the branch it minted.
    const sessionId = await steps.once('session', async () => {
      if (steps.active) {
        const { rows: [found] } = await pool.query(
          'SELECT id FROM chat_sessions WHERE app_id = $1 AND user_id = $2 AND branch_name = $3',
          [app.id, user.id, appRepoBranch]
        );
        if (found) return found.id;
      }
      const { rows: [created] } = await pool.query(
        `INSERT INTO chat_sessions
           (app_id, user_id, branch_name, status, shared_at, session_title,
            external_agent, last_activity_at)
         VALUES ($1, $2, $3, 'active', NOW(), $4, $5, NOW())
         RETURNING id`,
        [app.id, user.id, appRepoBranch, payload.title || null, payload.externalAgent ?? null]
      );
      return created.id;
    });
    await require('./topic-attributes').selfAssignProposal(pool, app.id, sessionId, user);

    const session = await loadProposal(pool, sessionId, app.id);
    const { patch: _patch, ...params } = updateParams(payload);
    const result = await require('./proposal-update').updateProposalFromForkBranch(
      { pool, config, steps: steps.scope('update') },
      { user, session, ...params, origin: origin(config) }
    );
    // ── Failure leaves no litter: a refused landing wrote nothing.
    if (!result.ok) {
      if (!steps.scope('update').get('push')?.ok) await dropSession(pool, sessionId, user.id);
      return result;
    }
    // Same announcement the owner's Share button makes, so an open Dev board
    // shows the card without a reload.
    await steps.once('announced', () => {
      try {
        require('./ws').pushSessionUpdate({ action: 'shared', sessionId, appId: app.id, appSlug: app.slug });
      } catch (err) {
        log.warn('fork-operations', 'share broadcast failed (non-fatal)', { sessionId, err: err.message });
      }
      return true;
    });
    log.info('fork-operations', 'work shared to in-progress', {
      userId: user.id, slug: app.slug, sessionId, branch: payload.branch,
    });
    return { ...result, sessionId, shared: true };
  },
};

async function dropSession(pool, sessionId, userId) {
  await pool.query('DELETE FROM chat_sessions WHERE id = $1 AND user_id = $2', [sessionId, userId])
    .catch((err) => log.warn('fork-operations', 'could not clean up a failed share', { sessionId, err: err.message }));
}

// ── work.submit and work.discard ─────────────────────────────────────

function loadTask(pool, userId, taskId) {
  return require('./external-agent-tasks').loadOpenTask(pool, userId, taskId);
}

// In submitWorkLocked's words: the task is the caller's and open, new work,
// and (for a branch) not a card already shared.
function taskRefusal(task, request) {
  if (!task || Number(task.app_id) !== Number(request.appId)) {
    return {
      status: 409, code: 'unknown_task',
      message: 'That piece of work is not open any more: it was submitted, closed or started over meanwhile. '
        + 'Ask for the current work order.',
    };
  }
  if (task.target_session_id) {
    return {
      status: 409, code: 'invalid_request',
      message: `Task ${task.id} revises proposal ${Number(task.target_session_id)}, so it is submitted as an update to `
        + 'that proposal, not as new work.',
    };
  }
  if (request.input.mode === 'branch' && task.session_id) {
    return {
      status: 409, code: 'already_shared',
      message: `That work is already shared as in-progress session ${Number(task.session_id)}, so submitting it `
        + 'again would open a second proposal for a branch the group can already see.',
    };
  }
  return null;
}

const submit = {
  async authorize({ config, pool }, request, user) {
    if (!['patch', 'branch'].includes(request.input.mode)) {
      throw Object.assign(new Error('Unknown submission'), { permanent: true });
    }
    const task = await loadTask(pool, user.id, request.input.taskId);
    const refused = taskRefusal(task, request);
    if (refused) return refused;
    // The import that makes the proposal answers these too; asked here, they
    // are answered before anything is written, in the same words.
    const app = await loadApp(pool, task.app_id);
    if (!app || !(await appAccess.checkAppAccess(pool, app, user, 'collab'))) return { status: 404, error: 'App not found' };
    const join = await communities.appNeedsJoin(pool, app.slug, user);
    if (join) return { status: 403, ...join };
    const d = deps({ config, pool });
    if (!d.gh.isEnabled()) {
      return { status: 503, code: 'platform_unavailable', retryable: true, message: 'Homeroom cannot reach GitHub right now. Try again shortly.' };
    }
    if (!repoRef.isHosted(task.repo_url)) {
      const link = d.githubLink.isEnabled(config) ? await d.githubLink.linkStatus(pool, user.id) : null;
      if (!link || !link.linked || !link.login) {
        return { status: 409, code: 'github_not_linked', message: 'Connect your GitHub account in Settings before submitting work.' };
      }
    }
    return null;
  },

  run(d, request, user, steps, payload) {
    return submitHere({ ...deps(d), ...d }, request, user, payload, steps);
  },
};

// The conductor's half of submit_work's new work, with `deps` { pool, gh,
// githubLink }: the task and the link read again, the payload decoded, and
// openSubmission's writes. Exported for the service's unit tests, which run
// it with their own fakes (tests/lib/submission-here.js).
async function submitHere(d, request, user, payload, steps = require('./durable-steps').none()) {
  const tasks = require('./external-agent-tasks');
  const task = await tasks.loadOpenTask(d.pool, user.id, request.input.taskId);
  if (!task) return { ok: false, ...taskRefusal(null, request) };
  const target = await steps.once('target', () => ({
    repoUrl: task.repo_url, baseSha: task.base_sha, forkOwner: task.fork_owner,
  }));
  if (target.repoUrl !== task.repo_url || target.baseSha !== task.base_sha || target.forkOwner !== task.fork_owner) {
    return { ok: false, status: 409, code: 'branch_moved', message: 'This work order changed while its submission was running. Read it again before retrying.' };
  }
  const link = repoRef.isHosted(task.repo_url) ? null : await d.githubLink.linkStatus(d.pool, user.id);
  const patch = payload.patch != null ? Buffer.from(String(payload.patch), 'base64') : null;
  const opened = await tasks.openSubmission(d, {
    user, task, link,
    mode: request.input.mode,
    branch: request.input.branch,
    forkRepo: request.input.forkRepo,
    uploaded: !!request.input.uploaded,
    // A patch the agent pasted is the string it sent; an uploaded one the
    // exact bytes (#4264), applied as they came.
    patch: patch && !request.input.uploaded ? patch.toString('utf8') : patch,
    title: payload.title,
    body: payload.body,
  }, steps);
  // A refusal travels whole, under its own key: the operation's answer names
  // its request (`requestId`), and a refusal can name GitHub's own (a pull
  // request GitHub would not open), which must reach the caller as it was.
  return opened.ok ? opened : { ok: false, refused: opened };
}

// Only a branch a submission of THIS task wrote: the names openSubmission
// mints, in the platform's own namespace (external-agent-head.js).
function taskBranch(task, userId, branch) {
  const head = require('./external-agent-head');
  const name = String(branch || '');
  if (!head.validRef(name) || !head.isMirrorNamespace(name)) return false;
  const tail = `-t${Number(task.id)}-`;
  const mirror = `${head.MIRROR_BRANCH_PREFIX}${task.fork_owner}${tail}`;
  const patch = `${head.PATCH_BRANCH_PREFIX}u${Number(userId)}${tail}`;
  return [mirror, patch].some((prefix) => name.startsWith(prefix) && /^[0-9a-f]+$/.test(name.slice(prefix.length)));
}

const discard = {
  async authorize({ pool }, request, user) {
    const task = await loadTask(pool, user.id, request.input.taskId);
    if (!task || Number(task.app_id) !== Number(request.appId)) return { status: 404, error: 'not_found' };
    if (!taskBranch(task, user.id, request.input.branch)) return { status: 400, error: 'bad_branch_name' };
    return null;
  },

  run(d, request, user) {
    return discardHere({ ...deps(d), ...d }, request, user);
  },
};

async function discardHere(d, request, user) {
  const task = await require('./external-agent-tasks').loadOpenTask(d.pool, user.id, request.input.taskId);
  if (!task) return { ok: false, status: 404, error: 'not_found' };
  const parsed = repoRef.isHosted(task.repo_url) ? repoRef.ownerRepo(task.repo_url) : d.gh.parseGithubUrl(task.repo_url);
  if (!parsed) return { ok: false, status: 404, error: 'not_found' };
  // An import can finish after web stopped waiting. Protect its branch at
  // the final cleanup boundary too, including an import made by a peer.
  const { rows: [owner] } = await d.pool.query(
    'SELECT id FROM chat_sessions WHERE app_id = $1 AND branch_name = $2 LIMIT 1',
    [task.app_id, request.input.branch]
  );
  if (owner) return { removed: false };
  const removed = await require('./external-agent-head').removeBranch({ ...parsed, branch: request.input.branch });
  if (removed && request.input.submissionRequestId) {
    await d.pool.query(
      `UPDATE external_agent_tasks SET submit_operation = NULL
        WHERE id = $1 AND user_id = $2 AND submit_operation->>'requestId' = $3`,
      [task.id, user.id, request.input.submissionRequestId]
    );
  }
  return { removed };
}

// ── The operation module (services/platform-operations.js) ───────────

const OPS = new Map([
  ['fork.update', { ...forkUpdate, payload: true }],
  ['work.share', { ...share, payload: true }],
  ['work.submit', { ...submit, payload: true }],
  ['work.discard', { ...discard, payload: false }],
]);

function opOf(request) {
  const op = OPS.get(request?.op);
  if (!op) throw Object.assign(new Error(`Unknown fork operation ${request?.op}`), { permanent: true });
  return op;
}

function authorize(d, request, user, opts = {}) {
  // A completed run only replays its saved answer; no target is written again.
  if (opts.steps?.has('result')) return null;
  return opOf(request).authorize(d, request, user, { steps: require('./durable-steps').none(), ...opts });
}

async function abandon(d, request, steps) {
  const op = opOf(request);
  if (op.abandon) await op.abandon(d, request, steps);
  if (op.payload) await ops().dropInput(d.pool, request.requestId);
}

async function run(d, request, user, steps) {
  const op = opOf(request);
  const result = await steps.once('result', async () => {
    const payload = op.payload ? await ops().inputOf(d.pool, request.requestId) : null;
    if (op.payload && !payload) return gone();
    return op.run(d, request, user, steps, payload);
  });
  // The task outlives workflow receipt retention. Keep a successful PR
  // answer on it until web consumes it, so a retry days later cannot rerun
  // this submission after the operation's short-lived checkpoints are swept.
  if (request.op === 'work.submit' && result?.ok) {
    await d.pool.query(
      `UPDATE external_agent_tasks SET submit_operation = jsonb_set(submit_operation, '{result}', $4::jsonb)
        WHERE id = $1 AND user_id = $2 AND submit_operation->>'requestId' = $3`,
      [request.input.taskId, request.userId, request.requestId, JSON.stringify(result)]
    );
  }
  // The run ended, with its answer: nothing it could resume needs its input.
  if (op.payload) await ops().dropInput(d.pool, request.requestId);
  return result;
}

module.exports = {
  WAIT_MS, authorize, abandon, run, submitHere, discardHere, taskBranch, loadProposal,
};
