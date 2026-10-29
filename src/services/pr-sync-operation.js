'use strict';

// `pr.sync`, a platform operation (services/platform-operations.js): a
// change's pull-request metadata written to the code host on a conductor.
//
// Which writes need a conductor. On Homeroom's git host a pull request is a
// row (services/native-pulls.js), so its title and body are SQL and need no
// credential; on GitHub every owner but the platform repository's is
// refused before a request is sent (services/github.js assertActingOwner),
// which needs none either. What is left is a change to the platform's own
// repository, written as the GitHub App: that is the one write here a web
// process cannot make (onConductor). The routes keep their checks, their
// database writes and their answers; only the write to GitHub moves.
//
// The writes (`input.write`), each read from the row as it stands on the
// conductor, never from what the route saw, so two asked close together
// leave the newest on GitHub:
//
//   summary  the author's description leading the pull request's body
//            (PATCH /api/sessions/:id/description, proposal-description-edit.js),
//            under the proposal's lock; the route waits for its status
//   issues   the `Closes #N` lines for the links asked added and removed
//            (PATCH /api/sessions/:id/linked-issues, proposal-update.js
//            projectLinkedIssues), under the proposal's lock; waited for
//   title    the change's name (PATCH /api/sessions/:id/title); waited for
//   create   the pull request of a change that has none (openMissingPr):
//            a preview rebuilt for a change whose turn never opened it
//            (`from: 'staging'`, services/staging-recovery.js) and a clone of
//            an unattended run that carries its code (`from: 'clone'`,
//            POST /api/sessions/:id/clone-headless). Appended, as nobody
//            waits on it, and tried again while the host fails; one already
//            open for the branch is adopted, so a retry never opens two.
//
// The waited writes answer a host failure as their routes always did (a
// status, once) rather than being tried again: the person or the agent
// asks again, and the same write is made.

const github = require('./github');
const repoRef = require('./repo-ref');
const appAccess = require('./app-access');
const communities = require('./communities');
const log = require('./logger');
const { permanent } = require('../workflow/work-errors.ts');

const OP = 'pr.sync';
const WRITES = new Set(['summary', 'issues', 'title', 'create']);
const CREATE_FROM = new Set(['staging', 'clone']);
const OPEN_STATUSES = ['active', 'paused', 'promoted', 'merging'];

function proposalUpdate() { return require('./proposal-update'); }
function prMetadata() { return require('./pr-metadata'); }

// Whether a write to this repository's pull request needs GitHub's
// credential, so is made on a conductor: the platform repository on GitHub.
function onConductor(repoUrl) {
  const parsed = repoRef.parse(repoUrl);
  if (!parsed || parsed.host !== 'github') return false;
  const acting = github.actingOwner();
  return !!acting && acting.toLowerCase() === String(parsed.owner).toLowerCase();
}

// The route's side. `ask` waits for the write's answer, and never throws:
// the route has already made its own writes, so a request that could not be
// made is an answer like a refusal (`ok: false`), which each route says as
// it says GitHub failing. `append` records it with nothing waiting (db: the
// caller's pool or transaction).
async function ask({ appId, userId, sessionId, write, ...rest }) {
  try {
    return await require('./platform-operations').request({
      op: OP, appId, userId, input: { sessionId: Number(sessionId), write, ...rest },
    });
  } catch (err) {
    log.warn('pr-sync', 'Could not ask a conductor for a pull request write', { sessionId: Number(sessionId), write, err: err.message });
    return { ok: false, status: 503, error: err.message };
  }
}

function append(db, { appId, userId, sessionId, write, ...rest }) {
  return require('./platform-operations').append(db, {
    op: OP, appId, userId, input: { sessionId: Number(sessionId), write, ...rest },
  });
}

async function load(pool, sessionId) {
  const { rows: [s] } = await pool.query(
    `SELECT cs.*, a.slug AS app_slug, a.repo_url
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
      WHERE cs.id = $1`,
    [sessionId]
  );
  return s || null;
}

function writeOf(request) {
  const write = request.input?.write;
  if (!WRITES.has(write) || (write === 'create' && !CREATE_FROM.has(request.input.from))) {
    throw permanent(`Unknown pull request write ${write}`);
  }
  return write;
}

const own = (s, user) => Number(s.user_id) === Number(user.id);

// Each write's authority as its route checks it, read again here: who may
// ask (the owner; for the links, a full write admin the route let repair it)
// and the change still in a state the route would take.
const MAY = new Map([
  ['summary', (s, user) => own(s, user) && !s.is_headless && OPEN_STATUSES.includes(s.status)],
  ['issues', (s, user, input) => own(s, user) || (input.admin === true && user.canAdminWrite)],
  ['title', (s, user) => own(s, user) && !s.is_headless && s.source !== 'imported' && OPEN_STATUSES.includes(s.status)],
  // A rebuild is the owner's, or any member's for a change up for a vote or
  // shared (routes/sessions.js mayOpenPreview); a clone is its new owner's.
  ['create', (s, user, input) => s.source !== 'imported' && !s.is_headless && OPEN_STATUSES.includes(s.status)
    && (own(s, user) || (input.from === 'staging'
      && (s.status === 'promoted' || s.status === 'merging' || !!s.shared_at)))],
]);

async function authorize({ pool }, request, user) {
  const write = writeOf(request);
  const session = await load(pool, request.input.sessionId);
  if (!session || Number(session.app_id) !== Number(request.appId)) return { status: 404, error: 'Session not found' };
  const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [session.app_id]);
  if (!app || !(await appAccess.checkAppAccess(pool, app, user, 'collab'))) return { status: 404, error: 'Session not found' };
  if (write === 'create' && request.input.from === 'clone') {
    const join = await communities.appNeedsJoin(pool, app.slug, user);
    if (join) return { status: 403, ...join };
  }
  if (!MAY.get(write)(session, user, request.input)) return { status: 404, error: 'Session not found' };
  return null;
}

// ── The writes ─────────────────────────────────────────────────────────

// The stored description leading the pull request's body, as the route's
// own sync would lead it (proposal-update.js syncSummaryIntoBody).
async function syncSummary(pool, sessionId) {
  return proposalUpdate().withProposalLock(pool, sessionId, async () => {
    const s = await load(pool, sessionId);
    if (!s) return { prBodyStatus: 'no_pull_request', prBody: null };
    if (s.source === 'imported') return { prBodyStatus: 'imported_pr', prBody: s.pr_body || null };
    if (!s.pr_number) return { prBodyStatus: 'no_pull_request', prBody: s.pr_body || null };
    const repo = repoRef.ownerRepo(s.repo_url);
    const rejected = !repo ? 'github_unavailable' : !s.pr_summary_md ? null
      : await proposalUpdate().syncSummaryIntoBody({
        pool, gh: github, ...repo, session: s, summary: s.pr_summary_md, previousSummary: s.pr_summary_previous_md,
      });
    return { prBodyStatus: rejected || 'synced', prBody: s.pr_body || null };
  });
}

async function projectIssues(pool, sessionId, input) {
  return proposalUpdate().withProposalLock(pool, sessionId, async () => {
    const s = await load(pool, sessionId);
    if (!s) return { prBodyUpdated: false, prBodyStatus: 'no_pr' };
    const repo = repoRef.ownerRepo(s.repo_url) || {};
    return proposalUpdate().projectLinkedIssues({
      pool, gh: github, session: s, owner: repo.owner, repo: repo.repo,
      addIssues: input.addIssues || [], removeIssues: input.removeIssues || [],
    });
  });
}

// GitHub is a cosmetic mirror of the name: a failure is said, never retried.
async function syncTitle(pool, sessionId) {
  const s = await load(pool, sessionId);
  const full = s && s.pr_number && s.pr_title ? proposalUpdate().repoNameFromUrl(s.repo_url) : null;
  if (!full) return { githubUpdated: false };
  const [owner, repo] = full.split('/');
  try {
    await github.updatePR(owner, repo, Number(s.pr_number), { title: s.pr_title });
    return { githubUpdated: true };
  } catch (err) {
    log.warn('pr-sync', 'Proposal title saved but GitHub rename failed', {
      sessionId: Number(sessionId), prNumber: s.pr_number, message: err.message,
    });
    return { githubUpdated: false };
  }
}

// A change's pull request when it has none (`from` above), opened once: one
// already open for its branch, which the row never learned (its opener went
// before writing the number down), is adopted, and applyPrMetadata then
// brings its title and body up to date. Run in place where the credential
// is, and by this operation's `create`. Returns applyPrMetadata's answer.
async function openMissingPr({ config, pool, session, owner, repo, from, username: asked = null }) {
  if (!owner || !repo || session.pr_number) return null;
  const pm = prMetadata();
  const broadcast = from === 'staging'
    ? (event, data) => require('./ws').broadcastGlobal({ ...data, type: 'session_event', sessionId: session.id, event })
    : null;
  const open = await github.findOpenPrByBranch(owner, repo, session.branch_name);
  if (open) {
    await pm.adoptOpenPr(pool, session, open, { why: 'before opening one' });
    if (broadcast) broadcast('pr_created', { prNumber: open.number, prUrl: open.html_url, prTitle: open.title });
  }
  // The owner's name and last request give applyPrMetadata the signals a
  // build turn has; without the name the fallback title would read
  // "undefined's changes".
  const { rows: [ctx] } = await pool.query(
    `SELECT u.username,
            (SELECT content FROM chat_session_messages
              WHERE session_id = cs.id AND role = 'user'
              ORDER BY id DESC LIMIT 1) AS last_user_message
       FROM chat_sessions cs LEFT JOIN users u ON u.id = cs.user_id
      WHERE cs.id = $1`,
    [session.id]
  );
  const username = asked || ctx?.username || session.username || 'someone';
  if (from === 'clone') {
    // An unattended run's code under a person's name: reviewable at once,
    // on the deterministic draft, under the name the clone inherited.
    return pm.applyPrMetadata({
      pool, session, repoOwner: owner, repoName: repo,
      userMessage: '', ccSummary: '', username,
      userId: session.user_id, allowModelGeneration: false,
      preferredTitle: session.session_title || null,
    });
  }
  let apiKey = null;
  let allowModelGeneration = false;
  try {
    const billing = await require('./limits').resolveBillingPath(pool, config.dataEncryptionKey, session.user_id);
    if (!billing.error) {
      apiKey = billing.apiKey;
      allowModelGeneration = true;
    }
  } catch (err) {
    log.warn('pr-sync', 'PR metadata billing resolve failed; using deterministic draft', {
      sessionId: session.id, err: err.message,
    });
  }
  return pm.applyPrMetadata({
    pool, session, repoOwner: owner, repoName: repo,
    userMessage: ctx?.last_user_message || '', ccSummary: '', username,
    apiKey, userId: session.user_id, allowModelGeneration,
    // As at promote time: an author-submitted title names the PR verbatim.
    preferredTitle: session.proposed_pr_title || null,
    broadcast,
  });
}

// Answers the change's pull request; `created` is whether this request gave
// it one (opened, or adopted one opened for it).
async function create({ config, pool }, request) {
  const s = await load(pool, request.input.sessionId);
  if (!s) throw permanent('The change is gone');
  if (s.pr_number) return { prNumber: Number(s.pr_number), prUrl: s.pr_url || null, created: false };
  const { owner, repo } = repoRef.ownerRepo(s.repo_url) || {};
  if (!owner || !repo) return { ok: false, status: 400, error: 'This change has no repository to open a pull request against' };
  try {
    await openMissingPr({ config, pool, session: s, owner, repo, from: request.input.from });
  } catch (err) {
    // A branch with nothing on it is an answer; a host that fails is tried again.
    if (err.code === 'no_commits') return { ok: false, status: 409, code: 'no_commits', error: err.message };
    throw err;
  }
  // applyPrMetadata is best-effort and answers most failures with null: one
  // that opened nothing is tried again, and finds a pull request it opened
  // whose reply was lost.
  if (!s.pr_number) throw new Error('The pull request was not opened');
  return { prNumber: Number(s.pr_number), prUrl: s.pr_url || null, created: true };
}

async function run({ config, pool }, request) {
  const write = writeOf(request);
  const sessionId = Number(request.input.sessionId);
  switch (write) {
    case 'summary': return syncSummary(pool, sessionId);
    case 'issues': return projectIssues(pool, sessionId, request.input);
    case 'title': return syncTitle(pool, sessionId);
    case 'create': return create({ config, pool }, request);
    default: throw permanent(`Unknown pull request write ${write}`);
  }
}

module.exports = {
  OP, WRITES, CREATE_FROM, onConductor, ask, append, authorize, run, openMissingPr,
};
