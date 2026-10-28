'use strict';

// `branch.ensure`, a platform operation (services/platform-operations.js):
// the working branch a new change starts on, created on a conductor. Three
// routes ask for one after their own checks and slot claims:
//
//   proposal-start   a local agent's native proposal (routes/proposal-handoff.js):
//                    `dev/cli-u<requester>-<request>` at the exact base the
//                    agent and Homeroom agreed on; a different existing ref
//                    is a conflict, never moved
//   headless         an issue's unattended run (routes/sessions.js): `dev/…`
//                    off main
//   clone-headless   a clone of that run (routes/sessions.js): `dev/…` off the
//                    source run's own branch, or main when that is gone
//   session          a change's branch on its first turn, asked by a web
//                    process (services/session-lifecycle.js
//                    ensureSessionBranch): `dev/…` off main, while the
//                    change records no other branch
//
// The conductor reads the requester's standing in the project and the
// branch's shape again, and resolves the start commit once, so a retry
// makes the same branch at the same commit.

const github = require('./github');
const repoRef = require('./repo-ref');
const appAccess = require('./app-access');
const communities = require('./communities');
const branchNames = require('./branch-names');
const githubBudget = require('./github-budget');
const log = require('./logger');

const SHA = /^[0-9a-f]{40}$/;

function branchAllowed(purpose, branch, userId) {
  if (!branchNames.isValidBranchName(branch)) return false;
  if (purpose === 'proposal-start') return new RegExp(`^dev/cli-u${Number(userId)}-[a-z0-9-]+$`).test(branch);
  return /^dev\/[^/]+$/.test(branch);
}

async function target(pool, request) {
  const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [request.appId]);
  if (!app) return null;
  const { owner, repo } = repoRef.ownerRepo(app.repo_url) || {};
  return owner && repo ? { app, owner, repo } : null;
}

// The change a first turn's branch is for: it records none yet, or this one.
async function sessionFree(pool, request) {
  const { rows: [cs] } = await pool.query(
    'SELECT app_id, branch_name FROM chat_sessions WHERE id = $1', [request.input.sessionId]);
  return !!cs && cs.app_id === request.appId && (!cs.branch_name || cs.branch_name === request.input.branch);
}

// The source run a clone starts from: its own branch, read now.
async function sourceBranch(pool, request) {
  const { rows: [src] } = await pool.query(
    'SELECT app_id, branch_name FROM chat_sessions WHERE id = $1', [request.input.sourceSessionId]);
  return src && src.app_id === request.appId ? { branch: src.branch_name || null } : null;
}

async function authorize({ pool }, request, user) {
  const { purpose, branch, baseSha } = request.input || {};
  if (!['proposal-start', 'headless', 'clone-headless', 'session'].includes(purpose)) {
    throw Object.assign(new Error('Unknown branch purpose'), { permanent: true });
  }
  const t = await target(pool, request);
  if (!t || !(await appAccess.checkAppAccess(pool, t.app, user, 'collab'))) return { status: 404, error: 'App not found' };
  const join = await communities.appNeedsJoin(pool, t.app.slug, user);
  if (join) return { status: 403, ...join };
  if (!branchAllowed(purpose, branch, user.id)) return { status: 400, error: 'bad_branch_name' };
  if (purpose === 'proposal-start' && !SHA.test(String(baseSha || ''))) return { status: 400, error: 'bad_base_sha' };
  if (purpose === 'clone-headless' && !(await sourceBranch(pool, request))) return { status: 404, error: 'Auto session not found' };
  if (purpose === 'session' && !(await sessionFree(pool, request))) return { status: 409, error: 'The change already has another branch' };
  if (!github.isEnabled()) return { status: 503, error: 'github_unavailable' };
  return null;
}

async function run({ pool }, request, _user, steps) {
  const { purpose, branch, baseSha } = request.input;
  const t = await target(pool, request);
  if (!t) throw Object.assign(new Error('App not found'), { permanent: true });
  // Where the branch starts, resolved once: a retry makes the same branch.
  const start = await steps.once('start', async () => {
    if (purpose === 'proposal-start') return { sha: baseSha, inherited: false };
    if (purpose === 'clone-headless') {
      const src = await sourceBranch(pool, request);
      const sha = src?.branch ? await github.getBranchSha(t.owner, t.repo, src.branch).catch(() => null) : null;
      if (sha) return { sha, inherited: true };
    }
    return { sha: await github.getBranchSha(t.owner, t.repo, 'main'), inherited: false };
  });
  try {
    await steps.once('branch', () => github.ensureBranchAtSha(t.owner, t.repo, branch, start.sha).then(() => true));
  } catch (err) {
    if (err.code === 'branch_conflict') return { ok: false, status: 409, error: 'branch_conflict' };
    // A host that refuses now is answered at once, with the reason when it
    // has one (an hour's limit used up), as these routes always answered:
    // the person or the local agent asks again, and the same request makes
    // the same branch.
    if (steps.stopped) throw err;
    log.warn('branch-operation', 'Branch creation failed', { purpose, branch, ...github.describeGithubError(err) });
    return { ok: false, status: 503, ...githubBudget.githubUnavailableBody(err) };
  }
  return { branch, sha: start.sha, inheritedCodeBranch: start.inherited };
}

module.exports = { authorize, run, branchAllowed };
