'use strict';

// A proposal's "pull request", for an app whose repository is on Homeroom's
// git host.
//
// A proposal is already a chat_sessions row with a branch, votes and checks;
// on GitHub it also had a pull request, and the proposal machine, the merge
// path, settings changes and reverts all speak to that object (open it,
// retitle it, read its head and mergeability, close it, merge it). GitHub
// suspended the account that owned every app repository on 25 Oct 2026, so
// for a repository on the git host that object is a row here (native_pulls)
// and services/github.js's pull-request helpers come here, in GitHub's
// shapes:
//
//   create / get / findOpenByBranch / listOpen / update / close / reopen /
//   markReady / commitShas / merge
//
// The head is a branch on the git host; mergeability is the mirror's own
// `git merge-tree` (services/repo-mirror.js). A read that finds main but not
// the head branch says so as `code_missing` (services/code-missing.js): the
// proposals open when Homeroom moved off GitHub kept their branch names, and
// most of those branches never reached the git host. A merge is a squash Homeroom
// makes itself (services/native-merge.js). `html_url` is the change's page on
// Homeroom. Numbers come from the app's one sequence (services/app-numbers.js),
// shared with its requests, so "#N" names one thing.

const log = require('./logger');
const appNumbers = require('./app-numbers');
const repoMirror = require('./repo-mirror');
const codeMissing = require('./code-missing');

function requests() { return require('./requests'); }
function db() { return appNumbers.getPool(); }

class PullError extends Error {
  constructor(message, { status = 422, code = null } = {}) {
    super(message);
    this.name = 'PullError';
    this.status = status;
    if (code) this.code = code;
  }
}

function origin() {
  const domain = String(process.env.USERNODE_DOMAIN || '').trim();
  return domain ? `https://${domain}` : '';
}

function changeUrl(slug, number) {
  return `${origin()}/#app/${encodeURIComponent(slug)}/dev/changes/${number}`;
}

function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function requireApp(owner, repo) {
  const app = await requests().appFor(owner, repo);
  if (!app) throw new PullError(`No app has the repository ${owner}/${repo}`, { status: 404 });
  return app;
}

const COLUMNS = `number, title, body, head_branch, base_branch, draft, state, merged, merged_at,
  merge_commit_sha, merged_head_sha, created_at, updated_at, closed_at`;

async function rowOf(appId, number) {
  const { rows: [row] } = await db().query(
    `SELECT ${COLUMNS} FROM native_pulls WHERE app_id = $1 AND number = $2`, [appId, Number(number)]);
  return row || null;
}

/**
 * Where the branches are right now: { head, base } shas from a fresh look
 * at the mirror, null for a branch that is gone.
 */
async function shasOf(owner, repo, row, { fresh = true } = {}) {
  try {
    const dir = await repoMirror.ensureMirror(owner, repo, { fresh });
    const [head, base] = await Promise.all([
      repoMirror.resolveBranch(dir, row.head_branch),
      repoMirror.resolveBranch(dir, row.base_branch),
    ]);
    return { dir, head, base };
  } catch (err) {
    log.warn('native-pulls', 'Could not read the branches', { repo: `${owner}/${repo}`, number: row.number, err: err.message });
    return { dir: null, head: null, base: null };
  }
}

// GitHub's mergeable / mergeable_state, answered exactly by merge-tree
// instead of lazily.
async function mergeability(dir, row, head, base) {
  if (row.merged || row.state !== 'open' || !dir || !head || !base) return { mergeable: null, mergeable_state: 'unknown' };
  try {
    const result = await repoMirror.mergeTree(dir, base, head);
    if (!result.clean) return { mergeable: false, mergeable_state: 'dirty' };
    return { mergeable: true, mergeable_state: row.draft ? 'draft' : 'clean' };
  } catch (err) {
    return { mergeable: null, mergeable_state: 'unknown' };
  }
}

function rawOf(owner, repo, slug, row, { head = null, base = null, mergeable = null, mergeable_state = 'unknown' } = {}) {
  const fullName = `${owner}/${repo}`;
  // Every hosted repository's default branch is main (services/hosted-git.js
  // createRepo); issue-close-watcher closes a merge's requests only into it.
  const hostedRepo = { full_name: fullName, owner: { login: owner }, name: repo, default_branch: 'main' };
  return {
    number: row.number,
    node_id: `native:${slug}:${row.number}`,
    title: row.title || '',
    body: row.body || '',
    state: row.state === 'closed' ? 'closed' : 'open',
    draft: !!row.draft,
    merged: !!row.merged,
    merged_at: iso(row.merged_at),
    merge_commit_sha: row.merge_commit_sha || null,
    mergeable,
    mergeable_state,
    html_url: changeUrl(slug, row.number),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    closed_at: iso(row.closed_at),
    user: { login: 'homeroom' },
    head: {
      ref: row.head_branch,
      sha: row.merged ? (row.merged_head_sha || head) : head,
      repo: hostedRepo,
    },
    base: { ref: row.base_branch, sha: base, repo: hostedRepo },
    // Not GitHub's: true when this read found main on the git host and not
    // the head branch. False for every read that did not look (no head and
    // no base), so only a real look says it.
    code_missing: codeMissing.fromHeads(row, { head, base }),
  };
}

// ── The operations, in GitHub's shapes ─────────────────────────────────

/**
 * Open a pull request for `branch` (or `head`). Refused, with GitHub's own
 * codes, when the branch adds nothing to main ('no_commits') or already has
 * an open one ('pr_exists').
 */
async function create(owner, repo, { branch, head, title = '', body = '', draft = false } = {}) {
  const app = await requireApp(owner, repo);
  const headBranch = String(head || branch || '').replace(/^[^:]+:/, '');
  if (!headBranch) throw new PullError('A pull request needs a branch');
  const { rows: [open] } = await db().query(
    `SELECT number FROM native_pulls WHERE app_id = $1 AND head_branch = $2 AND state = 'open' LIMIT 1`,
    [app.id, headBranch]);
  if (open) {
    const e = new PullError(`A pull request already exists for ${owner}:${headBranch}.`, { code: 'pr_exists' });
    e.existingNumber = open.number;
    throw e;
  }
  const { dir, head: headSha, base: baseSha } = await shasOf(owner, repo, { head_branch: headBranch, base_branch: 'main', number: null });
  if (!headSha || (baseSha && (await repoMirror.aheadBy(dir, baseSha, headSha)) === 0)) {
    throw new PullError(`No commits between main and ${headBranch}: the branch has no pushed commits.`, { code: 'no_commits' });
  }
  const number = await appNumbers.next(app.id, { db: db() });
  const { rows: [row] } = await db().query(
    `INSERT INTO native_pulls (app_id, number, title, body, head_branch, draft)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
    [app.id, number, String(title || ''), String(body || ''), headBranch, !!draft]);
  log.info('native-pulls', 'Pull request opened', { app: app.slug, number, branch: headBranch });
  return rawOf(owner, repo, app.slug, row, { head: headSha, base: baseSha });
}

/** One pull request with its live head, base and mergeability; 404 when none. */
async function get(owner, repo, number) {
  const app = await requireApp(owner, repo);
  const row = await rowOf(app.id, number);
  if (!row) throw new PullError(`Pull request #${number} not found`, { status: 404 });
  const { dir, head, base } = await shasOf(owner, repo, row);
  return rawOf(owner, repo, app.slug, row, { head, base, ...(await mergeability(dir, row, head, base)) });
}

async function findOpenByBranch(owner, repo, branch) {
  const app = await requests().appFor(owner, repo);
  if (!app) return null;
  const { rows: [row] } = await db().query(
    `SELECT ${COLUMNS} FROM native_pulls WHERE app_id = $1 AND head_branch = $2 AND state = 'open'
      ORDER BY number DESC LIMIT 1`, [app.id, String(branch || '').replace(/^[^:]+:/, '')]);
  return row ? rawOf(owner, repo, app.slug, row) : null;
}

async function listOpen(owner, repo, { perPage = 50 } = {}) {
  const app = await requests().appFor(owner, repo);
  if (!app) return [];
  const { rows } = await db().query(
    `SELECT ${COLUMNS} FROM native_pulls WHERE app_id = $1 AND state = 'open'
      ORDER BY created_at DESC, number DESC LIMIT $2`, [app.id, perPage]);
  return rows.map((row) => rawOf(owner, repo, app.slug, row));
}

async function updateRow(owner, repo, number, sets, params) {
  const app = await requireApp(owner, repo);
  const { rows: [row] } = await db().query(
    `UPDATE native_pulls SET ${sets}, updated_at = NOW() WHERE app_id = $1 AND number = $2 RETURNING ${COLUMNS}`,
    [app.id, Number(number), ...params]);
  if (!row) throw new PullError(`Pull request #${number} not found`, { status: 404 });
  return rawOf(owner, repo, app.slug, row);
}

async function update(owner, repo, number, { title, body } = {}) {
  const sets = [];
  const params = [];
  if (typeof title === 'string') { params.push(title); sets.push(`title = $${params.length + 2}`); }
  if (typeof body === 'string') { params.push(body); sets.push(`body = $${params.length + 2}`); }
  if (!sets.length) return get(owner, repo, number);
  return updateRow(owner, repo, number, sets.join(', '), params);
}

async function close(owner, repo, number) {
  const app = await requireApp(owner, repo);
  const row = await rowOf(app.id, number);
  if (!row) throw new PullError(`Pull request #${number} not found`, { status: 404 });
  if (row.merged || row.state === 'closed') return rawOf(owner, repo, app.slug, row);
  log.info('native-pulls', 'Pull request closed', { app: app.slug, number });
  return updateRow(owner, repo, number, `state = 'closed', closed_at = NOW()`, []);
}

/** Reopen a closed one. A merged one cannot be, as on GitHub (422). */
async function reopen(owner, repo, number) {
  const app = await requireApp(owner, repo);
  const row = await rowOf(app.id, number);
  if (!row) throw new PullError(`Pull request #${number} not found`, { status: 404 });
  if (row.merged) throw new PullError('Cannot reopen a merged pull request', { status: 422 });
  if (row.state === 'open') return rawOf(owner, repo, app.slug, row);
  const { rows: [other] } = await db().query(
    `SELECT number FROM native_pulls WHERE app_id = $1 AND head_branch = $2 AND state = 'open' AND number <> $3 LIMIT 1`,
    [app.id, row.head_branch, row.number]);
  if (other) throw new PullError(`Another pull request (#${other.number}) is open for ${row.head_branch}`, { status: 422 });
  log.info('native-pulls', 'Pull request reopened', { app: app.slug, number });
  return updateRow(owner, repo, number, `state = 'open', closed_at = NULL`, []);
}

async function markReady(owner, repo, number) {
  return updateRow(owner, repo, number, 'draft = FALSE', []);
}

/**
 * The commits the pull request carries over its base, lowercase:
 * { shas, complete }. A merged one is read up to the head it merged.
 */
async function commitShas(owner, repo, number, { cap = 300 } = {}) {
  const app = await requireApp(owner, repo);
  const row = await rowOf(app.id, number);
  if (!row) throw new PullError(`Pull request #${number} not found`, { status: 404 });
  const { dir, head, base } = await shasOf(owner, repo, row);
  const tip = row.merged ? row.merged_head_sha : head;
  if (!dir || !tip) return { shas: [], complete: false };
  const from = row.merged ? (await repoMirror.mergeBase(dir, row.merge_commit_sha || base, tip).catch(() => null)) : base;
  const { stdout } = await repoMirror._git(dir, ['rev-list', `--max-count=${cap + 1}`, from ? `${from}..${tip}` : tip]);
  const shas = String(stdout).split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return { shas: shas.slice(0, cap), complete: shas.length <= cap };
}

/** Merge it, squashed, at exactly `sha` when given (services/native-merge.js). */
async function merge(owner, repo, number, sha = null) {
  return require('./native-merge').squashMerge({ owner, repo, number, pinnedSha: sha });
}

module.exports = {
  PullError,
  changeUrl,
  create,
  get,
  findOpenByBranch,
  listOpen,
  update,
  close,
  reopen,
  markReady,
  commitShas,
  merge,
  _rowOf: rowOf,
};
