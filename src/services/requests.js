'use strict';

// Requests (feature ideas, bug reports), stored by Homeroom itself.
//
// Until 26 Oct 2026 every request was a GitHub issue that one machine
// account filed, and GitHub suspended that account: no request could be
// filed, and the boards lived only in each process's memory
// (docs/plans/github-independence.md §2). Requests are rows now, for every
// app, the platform's own included: Homeroom is the only place to request.
//
// The functions keep the shapes of the GitHub helpers they replace
// (services/github.js delegates its issue functions here), keyed the same
// way, by the repository's owner and name, so the ~100 places that read and
// write requests work unchanged:
//
//   listOpen(owner, repo)            { issues, truncatedList }   (the board)
//   getOne(owner, repo, n)           { issue } | { issue: null, note }
//   comments(owner, repo, n)         { comments, truncated }
//   create / update / close / reopen / comment / findByMarker
//                                    GitHub's raw issue shapes
//
// `htmlUrl` is the request's page on Homeroom. Numbers come from the app's
// one sequence (services/app-numbers.js). The discussion people have about a
// request stays in chat_messages (thread 'issue'); request_comments holds
// what used to be GitHub comments: the bot's posts, close notes, specs.

const log = require('./logger');
const repoRef = require('./repo-ref');
const appNumbers = require('./app-numbers');

const LIST_MAX = 1000;
const APPS_TTL_MS = 30 * 1000;

let pool = null;
function setPool(p) { pool = p; appNumbers.setPool(p); }
function db() { return pool || appNumbers.getPool(); }

class RequestError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
  }
}

// ── Which app a repository is ─────────────────────────────────────────

let appsCache = { at: 0, rows: [] };

async function apps() {
  if (Date.now() - appsCache.at < APPS_TTL_MS) return appsCache.rows;
  const { rows } = await db().query(
    `SELECT id, slug, repo_url, github_repo_url FROM apps
      WHERE repo_url IS NOT NULL OR github_repo_url IS NOT NULL`);
  appsCache = { at: Date.now(), rows };
  return rows;
}

function invalidateApps() { appsCache = { at: 0, rows: [] }; }

/**
 * The app whose repository is owner/repo: its address now, or the GitHub
 * one it had (a key written before the move). Null when none is.
 */
async function appFor(owner, repo) {
  const o = String(owner || '').toLowerCase();
  const r = String(repo || '').toLowerCase().replace(/\.git$/, '');
  if (!o || !r) return null;
  const match = (url) => {
    const p = repoRef.ownerRepo(url);
    return !!(p && p.owner.toLowerCase() === o && p.repo.toLowerCase() === r);
  };
  let found = (await apps()).find((a) => match(a.repo_url) || match(a.github_repo_url));
  if (!found && appsCache.at) {
    // A repository made in the last half minute (a new app files its first
    // request at once): read again before saying there is none.
    invalidateApps();
    found = (await apps()).find((a) => match(a.repo_url) || match(a.github_repo_url));
  }
  return found ? { id: found.id, slug: found.slug } : null;
}

function origin() {
  const domain = String(process.env.USERNODE_DOMAIN || '').trim();
  return domain ? `https://${domain}` : '';
}

function requestUrl(slug, number) {
  return `${origin()}/#app/${encodeURIComponent(slug)}/dev/issues/${number}`;
}

function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// GitHub's raw issue object, which the writers' callers read.
function rawOf(row, slug) {
  return {
    number: row.number,
    title: row.title || '',
    body: row.body || '',
    state: row.state === 'closed' ? 'closed' : 'open',
    state_reason: row.state_reason || null,
    labels: (row.labels || []).map((name) => ({ name })),
    user: row.author_login ? { login: row.author_login } : null,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    closed_at: iso(row.closed_at),
    html_url: requestUrl(slug, row.number),
  };
}

// The board's row (what services/github.js normalizeIssue made of GitHub's).
function normalizedOf(row, slug) {
  return {
    number: row.number,
    title: row.title || '',
    body: row.body || '',
    labels: [...(row.labels || [])],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    htmlUrl: requestUrl(slug, row.number),
    user: row.author_login || null,
    state: row.state === 'closed' ? 'closed' : 'open',
    closedAt: iso(row.closed_at),
  };
}

const COLUMNS = 'number, title, body, state, state_reason, labels, author_login, created_at, updated_at, closed_at';

async function requireApp(owner, repo) {
  const app = await appFor(owner, repo);
  if (!app) throw new RequestError(`No app has the repository ${owner}/${repo}`, 404);
  return app;
}

async function rowOf(appId, n) {
  const { rows: [row] } = await db().query(
    `SELECT ${COLUMNS} FROM requests WHERE app_id = $1 AND number = $2`, [appId, n]);
  return row || null;
}

async function isProposalNumber(appId, n) {
  const { rows } = await db().query(
    `SELECT 1 FROM native_pulls WHERE app_id = $1 AND number = $2
     UNION ALL SELECT 1 FROM chat_sessions WHERE app_id = $1 AND pr_number = $2 LIMIT 1`, [appId, n]);
  return rows.length > 0;
}

// ── Reads ─────────────────────────────────────────────────────────────

/** The open requests, most recently updated first. */
async function listOpen(owner, repo) {
  const app = await appFor(owner, repo);
  if (!app) return { issues: [], truncatedList: false, note: 'issues unavailable' };
  const { rows } = await db().query(
    `SELECT ${COLUMNS} FROM requests WHERE app_id = $1 AND state = 'open'
      ORDER BY updated_at DESC, number DESC LIMIT $2`, [app.id, LIST_MAX + 1]);
  return {
    issues: rows.slice(0, LIST_MAX).map((r) => normalizedOf(r, app.slug)),
    truncatedList: rows.length > LIST_MAX,
  };
}

/** One request, open or closed. */
async function getOne(owner, repo, number) {
  const n = Number(number);
  if (!owner || !repo || !Number.isInteger(n) || n <= 0) return { issue: null, note: 'bad issue number' };
  const app = await appFor(owner, repo);
  if (!app) return { issue: null, note: 'not found' };
  const row = await rowOf(app.id, n);
  if (row) return { issue: normalizedOf(row, app.slug) };
  if (await isProposalNumber(app.id, n)) return { issue: null, note: 'not an issue (pull request)' };
  return { issue: null, note: 'not found' };
}

/** GitHub's raw issue object, or a 404 error as Octokit threw. */
async function getRaw(owner, repo, number) {
  const app = await requireApp(owner, repo);
  const n = Number(number);
  const row = Number.isInteger(n) && n > 0 ? await rowOf(app.id, n) : null;
  if (!row) throw new RequestError(`Request #${number} not found`, 404);
  return rawOf(row, app.slug);
}

/** Its comments, oldest first: { comments: [{ author, body, createdAt, id }], truncated }. */
async function comments(owner, repo, number, { max = 300, since = null } = {}) {
  const n = Number(number);
  if (!owner || !repo || !Number.isInteger(n) || n <= 0) return { comments: [], truncated: false, note: 'bad issue number' };
  const app = await appFor(owner, repo);
  if (!app) return { comments: [], truncated: false, note: 'not found' };
  const { rows } = await db().query(
    `SELECT id, author_login, body, created_at FROM request_comments
      WHERE app_id = $1 AND number = $2 AND ($3::timestamptz IS NULL OR created_at >= $3)
      ORDER BY created_at, id LIMIT $4`, [app.id, n, since || null, max + 1]);
  return {
    comments: rows.slice(0, max).map((c) => ({
      author: c.author_login || '', body: c.body || '', createdAt: iso(c.created_at) || '', id: Number(c.id),
    })),
    truncated: rows.length > max,
  };
}

/** The most recent `recent` requests whose body carries `marker`, as { number }. */
async function findByMarker(owner, repo, marker, { recent = 30 } = {}) {
  const app = await appFor(owner, repo);
  if (!app || !marker) return null;
  const { rows: [hit] } = await db().query(
    `SELECT number FROM (
       SELECT number, body FROM requests WHERE app_id = $1 ORDER BY created_at DESC LIMIT $2
     ) recent WHERE strpos(body, $3) > 0 ORDER BY number DESC LIMIT 1`, [app.id, recent, String(marker)]);
  return hit ? { number: hit.number } : null;
}

// ── Writes ────────────────────────────────────────────────────────────

/** File a request; resolves GitHub's raw issue object. */
async function create(owner, repo, { title, body = '', labels = [], createdBy = null, authorLogin = null } = {}) {
  const app = await requireApp(owner, repo);
  const t = String(title || '').trim();
  if (!t) throw new RequestError('A request needs a title', 422);
  const number = await appNumbers.next(app.id, { db: db() });
  const { rows: [row] } = await db().query(
    `INSERT INTO requests (app_id, number, title, body, labels, created_by, author_login, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'homeroom')
     RETURNING ${COLUMNS}`,
    [app.id, number, t.slice(0, 512), String(body || ''), labels.filter(Boolean).map(String), createdBy, authorLogin]);
  log.info('requests', 'Request filed', { app: app.slug, number });
  return rawOf(row, app.slug);
}

async function updateRow(owner, repo, number, sets, params) {
  const app = await requireApp(owner, repo);
  const { rows: [row] } = await db().query(
    `UPDATE requests SET ${sets}, updated_at = NOW()
      WHERE app_id = $1 AND number = $2 RETURNING ${COLUMNS}`,
    [app.id, Number(number), ...params]);
  if (!row) throw new RequestError(`Request #${number} not found`, 404);
  return rawOf(row, app.slug);
}

function setTitle(owner, repo, number, title) {
  return updateRow(owner, repo, number, 'title = $3', [String(title || '').slice(0, 512)]);
}

function setBody(owner, repo, number, body) {
  return updateRow(owner, repo, number, 'body = $3', [String(body || '')]);
}

function setContent(owner, repo, number, { title, body }) {
  return updateRow(owner, repo, number, 'title = $3, body = $4', [String(title || '').slice(0, 512), String(body || '')]);
}

/** Close it. `reason`: 'completed' (the default, as GitHub's) or 'not_planned'. */
async function close(owner, repo, number, { reason = null, closedBy = null } = {}) {
  const why = reason === 'not_planned' ? 'not_planned' : 'completed';
  const raw = await updateRow(owner, repo, number,
    `state = 'closed', state_reason = $3, closed_at = COALESCE(closed_at, NOW()), closed_by = COALESCE($4, closed_by)`,
    [why, closedBy]);
  log.info('requests', 'Request closed', { repo: `${owner}/${repo}`, number, reason: why });
  await closeWithItsParts(owner, repo, number);
  return raw;
}

// #6019 follow-up: a request broken up into smaller ones (a thread move,
// workflow/rules/thread-moves.ts applyBreakup) closes with the last of its
// parts. Never fails the close it follows.
async function closeWithItsParts(owner, repo, number) {
  try {
    const app = await requireApp(owner, repo);
    const { rows: [part] } = await db().query(
      'SELECT part_of FROM requests WHERE app_id = $1 AND number = $2 AND part_of IS NOT NULL', [app.id, Number(number)]);
    if (!part) return;
    const { rows: open } = await db().query(
      `SELECT 1 FROM requests WHERE app_id = $1 AND part_of = $2 AND state = 'open' LIMIT 1`, [app.id, part.part_of]);
    if (open.length) return;
    const { rows: [big] } = await db().query(
      `SELECT state FROM requests WHERE app_id = $1 AND number = $2`, [app.id, part.part_of]);
    if (!big || big.state !== 'open') return;
    await close(owner, repo, part.part_of, { reason: 'completed' });
    log.info('requests', 'A broken-up request closed with its last part', { repo: `${owner}/${repo}`, number: part.part_of });
  } catch (err) {
    log.warn('requests', 'Could not close a broken-up request with its last part', { number, err: err.message });
  }
}

async function reopen(owner, repo, number) {
  const raw = await updateRow(owner, repo, number,
    `state = 'open', state_reason = 'reopened', closed_at = NULL, closed_by = NULL`, []);
  log.info('requests', 'Request reopened', { repo: `${owner}/${repo}`, number });
  return raw;
}

/** Add a comment (what was a GitHub comment); resolves GitHub's raw comment shape. */
async function comment(owner, repo, number, body, { userId = null, authorLogin = 'homeroom' } = {}) {
  const app = await requireApp(owner, repo);
  const n = Number(number);
  if (!(await rowOf(app.id, n))) throw new RequestError(`Request #${number} not found`, 404);
  const { rows: [row] } = await db().query(
    `INSERT INTO request_comments (app_id, number, author_login, user_id, body)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, body, author_login, created_at`,
    [app.id, n, authorLogin, userId, String(body || '')]);
  await db().query('UPDATE requests SET updated_at = NOW() WHERE app_id = $1 AND number = $2', [app.id, n]);
  return {
    id: Number(row.id),
    body: row.body,
    user: { login: row.author_login || 'homeroom' },
    created_at: iso(row.created_at),
    html_url: `${requestUrl(app.slug, n)}`,
  };
}

function _resetForTests() {
  pool = null;
  invalidateApps();
}

module.exports = {
  RequestError,
  setPool,
  appFor,
  invalidateApps,
  requestUrl,
  listOpen,
  getOne,
  getRaw,
  comments,
  findByMarker,
  create,
  setTitle,
  setBody,
  setContent,
  close,
  reopen,
  comment,
  _resetForTests,
};
