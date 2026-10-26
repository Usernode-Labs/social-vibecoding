'use strict';

// A proposal whose code did not come across from GitHub: "code missing".
//
// GitHub suspended the account that held every app repository on 25 Oct
// 2026, and since the 26th app code lives on Homeroom's git host. Each app's
// main was rebuilt there from its running image, and the boot migration gave
// every proposal that was open at the move a native pull request
// (native_pulls, services/github-move.js) under its old branch name. Those
// branches only ever existed on GitHub, so for most of them there is no such
// branch on the git host. Until a branch is pushed back under the same name
// (from rescued data, or from GitHub's export of the account) the proposal
// has nothing to merge, build or compare, and every sweep that touched it
// failed and logged, every few minutes.
//
// ── Derived, never stored ──────────────────────────────────────────────
//
// There is no column. A proposal is code missing while it has an open
// native pull request on an app on the git host whose head branch is not on
// the git host. That is the same thing the pull request's own head lookup
// says (services/native-pulls.js `get`: `head.sha` null while the mirror
// answered for main, which it exposes as `code_missing`), and the same thing
// the merge gate's reconcile finds (routes/votes.js
// reconcileNativeReviewedHead). Pushing the branch back under its name
// clears it on the next look, with nothing to undo.
//
// ── Cheap where lists are drawn ────────────────────────────────────────
//
// A list (the board's proposals, a proposal page, the Communities Needs you)
// does not resolve each row's head. `missingIds` reads the rows' pull
// requests in one query and each repository's branch names in one local
// read of its mirror (repo-mirror.js listBranches), kept for a minute per
// repository in this process. A read that is not back within `waitMs`
// answers from what this process already knows, and the next list read
// finds the answer the read left behind. An unreadable mirror is never
// "missing": it answers nothing.

const log = require('./logger');
const repoRef = require('./repo-ref');

const CODE = 'code_missing';

// The server's own sentence, for refusals and logs. The screens say it from
// the language catalogs (changes:badge.reason.codeMissing.*,
// project:topic.change.codeMissing).
const REASON = "This proposal's code didn't come across when Homeroom moved off GitHub. "
  + "Its creator can submit it again, or Homeroom restores it when GitHub's copy of the code arrives.";

// What a merge is refused with, and what a vote on one is answered with.
const MERGE_REFUSAL = `Not merged: ${REASON}`;
const VOTE_NOTE = `Your vote is recorded, but this proposal can't go live until its code is back. ${REASON}`;

// The proposal states whose pull request is still open.
const OPEN_STATUSES = new Set(['active', 'paused', 'promoted', 'merging']);

// A repository's branch names are good for a minute; a mirror that could not
// be read is asked again after a short wait rather than on every list read.
const BRANCHES_TTL_MS = 60 * 1000;
const FAILED_RETRY_MS = 15 * 1000;
// How long a list read waits for a repository's first answer.
const LIST_WAIT_MS = 1500;

/** An error a caller can tell apart: the proposal's code is not on the git host. */
function error(message = REASON, extra = {}) {
  return Object.assign(new Error(message), { code: CODE, codeMissing: true }, extra);
}

function isError(err) {
  return !!err && (err.code === CODE || err.codeMissing === true);
}

/**
 * The pull request's own answer (services/native-pulls.js): open, not
 * merged, and its head branch did not resolve while the base did. A look
 * that could not read the mirror resolves neither, and says nothing.
 */
function fromHeads(row, { head = null, base = null } = {}) {
  return !!row && row.state === 'open' && !row.merged && !head && !!base;
}

/** A pull request as services/github.js getPR answers it, on the git host. */
function fromPull(pull) {
  return !!(pull && pull.code_missing === true);
}

/** Whether `session` is one this can be true of at all. */
function applies(session) {
  return !!session
    && Number(session.pr_number) > 0
    && OPEN_STATUSES.has(session.status)
    && repoRef.isHosted(session.repo_url);
}

// ── Each repository's branches ─────────────────────────────────────────

// `${owner}/${repo}` → { at, branches: Set | null, failedAt, pending }
const _branches = new Map();

const TIMED_OUT = Symbol('timed out');

function within(promise, ms) {
  let timer = null;
  const late = new Promise((resolve) => {
    timer = setTimeout(resolve, ms, TIMED_OUT);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

async function readBranches(owner, repo) {
  const mirror = require('./repo-mirror');
  const dir = await mirror.ensureMirror(owner, repo);
  return new Set(await mirror.listBranches(dir));
}

/**
 * The branch names on the git host for owner/repo: a Set, or null while
 * nothing is known. Once known, an answer older than a minute is still
 * answered at once while a new read runs for next time (the flag clears a
 * read or two after a branch is pushed back). Only a repository this process
 * knows nothing about waits for its read, and at most `waitMs`; 0 never
 * waits.
 */
async function branchesOf(owner, repo, { waitMs = LIST_WAIT_MS } = {}) {
  const key = `${owner}/${repo}`.toLowerCase();
  let entry = _branches.get(key);
  if (!entry) {
    entry = { at: 0, branches: null, failedAt: 0, pending: null };
    _branches.set(key, entry);
  }
  const now = Date.now();
  if (entry.branches && now - entry.at < BRANCHES_TTL_MS) return entry.branches;
  if (entry.failedAt && now - entry.failedAt < FAILED_RETRY_MS) return entry.branches;
  if (!entry.pending) {
    const read = readBranches(owner, repo).then((set) => {
      entry.branches = set;
      entry.at = Date.now();
      entry.failedAt = 0;
      return set;
    }, (err) => {
      entry.failedAt = Date.now();
      log.debug('code-missing', 'Could not read the branches on the git host', { repo: key, err: err.message });
      return entry.branches;
    });
    entry.pending = read;
    read.finally(() => { if (entry.pending === read) entry.pending = null; });
  }
  if (entry.branches || !(waitMs > 0)) return entry.branches;
  const got = await within(entry.pending, waitMs);
  return got === TIMED_OUT ? entry.branches : got;
}

// ── Lists ──────────────────────────────────────────────────────────────

/**
 * The ids of the sessions in `sessions` whose code is missing. Each needs
 * `id`, `app_id`, `pr_number`, `status` and `repo_url`. One query for their
 * pull requests, one branch list per repository. Never throws: a list that
 * cannot be told says nothing.
 */
async function missingIds(pool, sessions, { waitMs = LIST_WAIT_MS } = {}) {
  const out = new Set();
  const candidates = (Array.isArray(sessions) ? sessions : []).filter(applies);
  if (!pool || !candidates.length) return out;
  try {
    const { rows } = await pool.query(
      `SELECT np.app_id, np.number, np.head_branch
         FROM native_pulls np
         JOIN unnest($1::int[], $2::int[]) AS want(app_id, number)
           ON np.app_id = want.app_id AND np.number = want.number
        WHERE np.state = 'open' AND np.merged = FALSE`,
      [candidates.map((s) => Number(s.app_id)), candidates.map((s) => Number(s.pr_number))]
    );
    const headOf = new Map((rows || []).map((r) => [`${r.app_id}:${r.number}`, r.head_branch]));
    const byRepo = new Map();
    for (const s of candidates) {
      const branch = headOf.get(`${Number(s.app_id)}:${Number(s.pr_number)}`);
      const parsed = branch ? repoRef.ownerRepo(s.repo_url) : null;
      if (!parsed) continue;
      const key = `${parsed.owner}/${parsed.repo}`.toLowerCase();
      if (!byRepo.has(key)) byRepo.set(key, { ...parsed, list: [] });
      byRepo.get(key).list.push({ id: Number(s.id), branch });
    }
    await Promise.all([...byRepo.values()].map(async ({ owner, repo, list }) => {
      const branches = await branchesOf(owner, repo, { waitMs });
      if (!branches) return;
      for (const { id, branch } of list) if (!branches.has(branch)) out.add(id);
    }));
  } catch (err) {
    log.warn('code-missing', 'Could not tell which proposals are missing their code', { err: err.message });
  }
  return out;
}

/** One session (the fields `missingIds` reads), true or false. */
async function forSession(pool, session, opts = {}) {
  if (!applies(session)) return false;
  return (await missingIds(pool, [session], opts)).has(Number(session.id));
}

function _resetForTests() {
  _branches.clear();
}

module.exports = {
  CODE,
  REASON,
  MERGE_REFUSAL,
  VOTE_NOTE,
  OPEN_STATUSES,
  BRANCHES_TTL_MS,
  LIST_WAIT_MS,
  error,
  isError,
  fromHeads,
  fromPull,
  applies,
  branchesOf,
  missingIds,
  forSession,
  _resetForTests,
};
