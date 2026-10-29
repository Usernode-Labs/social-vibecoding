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
// There is no column. A proposal is code missing while it is a change made
// before its app moved and it has an open native pull request on an app on
// the git host whose head branch is not on the git host. That is the same
// thing the pull request's own head lookup says (services/native-pulls.js
// `get`: `head.sha` null while the mirror answered for main, which it
// exposes as `code_missing`), and the same thing the merge gate's reconcile
// finds (routes/votes.js
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
//
// ── Changes underway, read live before anything runs ───────────────────
//
// Most changes underway at the move (not up for a vote) had no pull
// request, and their branches only ever existed on GitHub too. A turn on
// one used to take a slot and a worker, start the coding agent on main and
// die on "branch missing upstream", a sync recorded a conflict that was not
// there, and a promote said "no commits". `branchGone` answers for one of
// them before anything is started: its app's repository is on the git host,
// the change was made before the app moved (git_host_moves.applied_at), it
// names a branch, and a LIVE read of the git host finds main and not that
// branch. Live, not the list's minute-old answer: a branch pushed back
// seconds ago reads as there, so the change goes on by itself. A change
// made after the move is never gone (its branch is made at its first turn),
// and a read that fails or is slow answers "unknown" (null), which lets
// things go on as before. The label (`applies`, `missingIds`) covers the
// same changes, from the cached list, and only changes made before the move.

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

// What a change underway is refused with when its branch did not come
// across (`branchGone`): a turn, a sync, a promote, a copy of it.
const BRANCH_GONE = "This change's code didn't come across when Homeroom moved off GitHub, so it can't be continued here. "
  + 'Nothing was changed. Start a new change from the current version (its plan comes with it), '
  + "or wait: Homeroom restores the code when GitHub's copy arrives.";

// The proposal states whose pull request is still open.
const OPEN_STATUSES = new Set(['active', 'paused', 'promoted', 'merging']);
// A change underway: its own branch is what is read when it has no open
// pull request.
const UNDERWAY_STATUSES = new Set(['active', 'paused']);

// A repository's branch names are good for a minute; a mirror that could not
// be read is asked again after a short wait rather than on every list read.
const BRANCHES_TTL_MS = 60 * 1000;
const FAILED_RETRY_MS = 15 * 1000;
// How long a list read waits for a repository's first answer.
const LIST_WAIT_MS = 1500;
// How long a live read of one change's branch may take before it answers
// "unknown" and lets the change go on.
const LIVE_WAIT_MS = 10 * 1000;

// The change's branch and repository, when the change was made before its
// app moved to the git host. No row: made after (or the app never moved).
const PRE_MOVE_SQL = `
  SELECT cs.branch_name, a.repo_url
    FROM chat_sessions cs
    JOIN apps a ON a.id = cs.app_id
    JOIN git_host_moves m ON m.app_id = cs.app_id
   WHERE cs.id = $1 AND m.applied_at IS NOT NULL AND cs.created_at < m.applied_at`;

// Of these changes, the ones made before their app moved.
const PRE_MOVE_IDS_SQL = `
  SELECT cs.id
    FROM chat_sessions cs
    JOIN git_host_moves m ON m.app_id = cs.app_id
   WHERE cs.id = ANY($1::int[]) AND m.applied_at IS NOT NULL AND cs.created_at < m.applied_at`;

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

/**
 * Whether `session` is one this can be true of at all: on the git host and
 * open, with a pull request, or underway with a branch of its own (which
 * counts only when the change predates its app's move: `missingIds`).
 */
function applies(session) {
  return !!session
    && OPEN_STATUSES.has(session.status)
    && repoRef.isHosted(session.repo_url)
    && (Number(session.pr_number) > 0
      || (UNDERWAY_STATUSES.has(session.status) && !!String(session.branch_name || '').trim()));
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
 * `id`, `app_id`, `pr_number`, `status` and `repo_url`, and a change
 * underway its `branch_name`. One query for which of the candidates predate
 * their app's move, one for the pull requests of those that have one, one
 * branch list per repository. A change made after its app moved (or on an app
 * that never moved) is never missing: its branch is made at its first turn.
 * Never throws: a list that cannot be told says nothing.
 */
async function missingIds(pool, sessions, { waitMs = LIST_WAIT_MS } = {}) {
  const out = new Set();
  const candidates = (Array.isArray(sessions) ? sessions : []).filter(applies);
  if (!pool || !candidates.length) return out;
  try {
    const { rows: moved } = await pool.query(PRE_MOVE_IDS_SQL, [candidates.map((s) => Number(s.id))]);
    const preMove = new Set((moved || []).map((r) => Number(r.id)));
    if (!preMove.size) return out;
    const preMoveRows = candidates.filter((s) => preMove.has(Number(s.id)));
    const pullKey = (s) => `${Number(s.app_id)}:${Number(s.pr_number)}`;
    const withPull = preMoveRows.filter((s) => Number(s.pr_number) > 0);
    const headOf = new Map();
    if (withPull.length) {
      const { rows } = await pool.query(
        `SELECT np.app_id, np.number, np.head_branch
           FROM native_pulls np
           JOIN unnest($1::int[], $2::int[]) AS want(app_id, number)
             ON np.app_id = want.app_id AND np.number = want.number
          WHERE np.state = 'open' AND np.merged = FALSE`,
        [withPull.map((s) => Number(s.app_id)), withPull.map((s) => Number(s.pr_number))]
      );
      for (const r of rows || []) headOf.set(`${r.app_id}:${r.number}`, r.head_branch);
    }
    // A change underway with no open pull request: its own branch (one made
    // after the move has its branch made at its first turn, so it is not here).
    const own = new Set(preMoveRows.filter((s) => !headOf.has(pullKey(s))
      && UNDERWAY_STATUSES.has(s.status) && String(s.branch_name || '').trim())
      .map((s) => Number(s.id)));
    const byRepo = new Map();
    for (const s of preMoveRows) {
      const branch = headOf.get(pullKey(s))
        || (own.has(Number(s.id)) ? String(s.branch_name).trim() : null);
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

// ── One change underway, live ──────────────────────────────────────────

/**
 * Whether this change's branch did not come across from GitHub: true when
 * its app is on the git host, the change was made before the app moved, it
 * names a branch, and the git host has main and not that branch right now;
 * false when any of that is not so (the branch is there, pushed back or
 * never gone); null when the read failed or took longer than `waitMs`.
 * Callers refuse only on true. `session` needs its `id`; its `branch_name`
 * and `repo_url`, when the caller has them, spare a query for a change that
 * cannot be gone. `readRef(repoUrl, ref)` is the git host's (tests pass
 * their own).
 */
async function branchGone(pool, session, { waitMs = LIVE_WAIT_MS, readRef = null } = {}) {
  if (!pool || !session || !(Number(session.id) > 0)) return false;
  if (Object.prototype.hasOwnProperty.call(session, 'branch_name') && !String(session.branch_name || '').trim()) return false;
  if (session.repo_url && !repoRef.isHosted(session.repo_url)) return false;
  let row;
  try {
    ({ rows: [row] } = await pool.query(PRE_MOVE_SQL, [Number(session.id)]));
  } catch (err) {
    log.warn('code-missing', 'Could not tell whether a change predates its app\'s move; going on', {
      sessionId: Number(session.id), err: err.message,
    });
    return null;
  }
  const branch = String((row && row.branch_name) || '').trim();
  if (!branch || !repoRef.isHosted(row.repo_url)) return false;
  const read = readRef || ((repoUrl, ref) => require('./git-host').readRef(repoUrl, ref));
  try {
    const got = await within(Promise.all([read(row.repo_url, branch), read(row.repo_url, 'main')]), waitMs);
    if (got === TIMED_OUT) return null;
    const [head, main] = got;
    if (head) return false;
    return main ? true : null;
  } catch (err) {
    log.warn('code-missing', 'Could not read a change\'s branch on the git host; going on', {
      sessionId: Number(session.id), branch, err: err.message,
    });
    return null;
  }
}

/**
 * What the Mayor is handed when a dispatch on change `changeId` is refused
 * because its branch is gone: nothing ran, so no retry, and the way on.
 */
function dispatchRefusal(changeId) {
  const id = Number(changeId);
  return `${CODE}: change ${id}'s code didn't come across when Homeroom moved off GitHub (its branch is not on `
    + 'Homeroom\'s git host), so the coding agent cannot work on it. Nothing ran and nothing was changed. '
    + 'Do not suggest retrying. Offer to start a new change from the current version, carrying this change\'s '
    + `plan (start_change with fromChangeId ${id}), or to wait: Homeroom restores the code when GitHub's copy arrives.`;
}

/** The change's one status row saying so, for a refusal that has no stream of its own to say it on. */
async function noteRefused(pool, sessionId) {
  try {
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata) VALUES ($1, 'system', $2, $3)`,
      [Number(sessionId), BRANCH_GONE, JSON.stringify({ codeMissing: true, error: BRANCH_GONE })]
    );
  } catch (err) {
    log.warn('code-missing', 'Could not write the change\'s code-missing row', { sessionId: Number(sessionId), err: err.message });
  }
}

function _resetForTests() {
  _branches.clear();
}

module.exports = {
  CODE,
  REASON,
  MERGE_REFUSAL,
  VOTE_NOTE,
  BRANCH_GONE,
  OPEN_STATUSES,
  UNDERWAY_STATUSES,
  BRANCHES_TTL_MS,
  LIST_WAIT_MS,
  LIVE_WAIT_MS,
  PRE_MOVE_SQL,
  PRE_MOVE_IDS_SQL,
  error,
  isError,
  fromHeads,
  fromPull,
  applies,
  branchesOf,
  missingIds,
  forSession,
  branchGone,
  dispatchRefusal,
  noteRefused,
  _resetForTests,
};
