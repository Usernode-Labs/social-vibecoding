'use strict';

// Where app code lives: a git server Homeroom runs itself (Forgejo, in the
// cluster), used as plain storage behind this small interface.
//
// On 25 Oct 2026 GitHub suspended the account that owned every app
// repository, and with it went app source, the merge transport and the
// request boards (docs/plans/github-independence.md). The lesson: Homeroom
// owns requests, proposals and merges itself, and a git server is dumb
// storage it could swap in an afternoon. So this module offers only what
// storage is for, and everything else (compare, merge-tree, changed files,
// tree equality) is done locally on a clone (services/repo-mirror.js,
// services/native-merge.js):
//
//   createRepo(name)              an empty repository in the apps org
//   repoUrl(name) / parseRepoUrl  the address stored in apps.repo_url
//   cloneUrl(name, { internal })  where git reads it from
//   readRef(name, ref)            a branch's commit, or null
//   pushRefs / casUpdateRef       move refs, compare-and-swap for main
//   deleteRef(name, ref)          drop a branch
//
// Configuration (dapp.json platform_env, the Helm chart):
//   GIT_HOST_URL           the public base people and agents see,
//                          e.g. https://git.onhomeroom.com
//   GIT_HOST_INTERNAL_URL  the in-cluster base the platform reads and
//                          writes through (defaults to GIT_HOST_URL)
//   GIT_HOST_ORG           the organisation app repositories live in
//                          (default `apps`)
//   GIT_HOST_USER / GIT_HOST_TOKEN
//                          the platform's service account on it. Never
//                          given to workers, agents or people.
//
// The token never goes into argv, a URL, git config or disk: git asks a
// credential helper that reads it from the environment of that one
// process, as services/worker-git-push.js does for its push.

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const log = require('./logger');

const GIT_TIMEOUT_MS = 120_000;
const API_TIMEOUT_MS = 20_000;

class GitHostError extends Error {
  constructor(message, { status = 0, code = 'git_host_error' } = {}) {
    super(message);
    this.name = 'GitHostError';
    this.status = status;
    this.code = code;
  }
}

// A compare-and-swap that found the ref somewhere else: the same sentinel
// (`headMoved`) as GitHub's 409 on a pinned merge, so the proposal
// machine's callers treat it the same way.
class RefMovedError extends Error {
  constructor(message) {
    super(message || 'The branch moved since it was read');
    this.name = 'RefMovedError';
    this.headMoved = true;
    this.refMoved = true;
  }
}

function trimBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function settings() {
  const url = trimBase(process.env.GIT_HOST_URL);
  return {
    url,
    internalUrl: trimBase(process.env.GIT_HOST_INTERNAL_URL) || url,
    org: String(process.env.GIT_HOST_ORG || 'apps').trim() || 'apps',
    user: String(process.env.GIT_HOST_USER || '').trim(),
    token: String(process.env.GIT_HOST_TOKEN || '').trim(),
  };
}

/** Whether a git host is configured at all (a URL and a service account). */
function isConfigured() {
  const s = settings();
  return !!(s.url && s.user && s.token);
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function assertName(name) {
  const n = String(name || '');
  if (!NAME_RE.test(n) || n.endsWith('.git') || n.includes('..')) {
    throw new GitHostError(`Invalid repository name: ${n.slice(0, 120)}`, { code: 'invalid_name' });
  }
  return n;
}

/** The address apps.repo_url stores for `name`: the repository's web page. */
function repoUrl(name, { org } = {}) {
  const s = settings();
  if (!s.url) throw new GitHostError('GIT_HOST_URL is not set', { code: 'not_configured' });
  return `${s.url}/${org || s.org}/${assertName(name)}`;
}

/**
 * { owner, name } for an address on this git host (with or without .git,
 * either base URL), else null. The one place a hosted address is parsed.
 */
function parseRepoUrl(value) {
  const s = settings();
  const raw = String(value || '').trim();
  if (!raw) return null;
  for (const base of new Set([s.url, s.internalUrl].filter(Boolean))) {
    if (raw.toLowerCase().startsWith(`${base.toLowerCase()}/`)) {
      const rest = raw.slice(base.length + 1).replace(/\/+$/, '').replace(/\.git$/i, '');
      const parts = rest.split('/');
      if (parts.length !== 2 || !parts[0] || !NAME_RE.test(parts[1])) return null;
      return { owner: parts[0], name: parts[1] };
    }
  }
  return null;
}

/** Whether `value` is an address on this git host. */
function isHostedUrl(value) {
  return !!parseRepoUrl(value);
}

function nameOf(repo) {
  if (repo && typeof repo === 'object') return { owner: repo.owner || settings().org, name: assertName(repo.name) };
  const parsed = parseRepoUrl(repo);
  if (parsed) return parsed;
  return { owner: settings().org, name: assertName(repo) };
}

/**
 * Where git reads `repo` (a name, an address, or { owner, name }) from.
 * Internal by default: the platform's own clones and builds. `internal:
 * false` is the public address, for people and outside agents.
 */
function cloneUrl(repo, { internal = true } = {}) {
  const s = settings();
  const { owner, name } = nameOf(repo);
  const base = internal ? s.internalUrl : s.url;
  if (!base) throw new GitHostError('GIT_HOST_URL is not set', { code: 'not_configured' });
  return `${base}/${owner}/${name}.git`;
}

// ── git, with the service account ─────────────────────────────────────

const CREDENTIAL_HELPER = '!f() { if [ "$1" = get ]; then printf "%s\\n" "username=$USERNODE_GIT_HOST_USER" "password=$USERNODE_GIT_HOST_TOKEN"; fi; }; f';

function gitEnv(extra = {}) {
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME || os.tmpdir(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
    LC_ALL: 'C',
    ...extra,
  };
}

function redact(text) {
  const { token } = settings();
  let out = String(text || '');
  if (token) for (const t of [token, encodeURIComponent(token)]) out = out.split(t).join('***');
  return out;
}

/**
 * Run git. `auth: true` lets this one invocation answer the git host's
 * credential prompt with the service account; nothing else ever sees it.
 * Resolves { stdout, stderr }; rejects with stderr redacted.
 */
function git(args, { cwd = undefined, auth = false, timeout = GIT_TIMEOUT_MS, input = null, env: extra = {} } = {}) {
  const s = settings();
  const config = [
    '-c', 'credential.helper=',
    ...(auth ? ['-c', `credential.helper=${CREDENTIAL_HELPER}`] : []),
    '-c', 'http.followRedirects=false',
    '-c', 'core.hooksPath=/dev/null',
  ];
  // `extra`: the few variables a caller sets for one invocation (an index
  // file, commit identities and dates); never a credential.
  const env = gitEnv({ ...extra, ...(auth ? { USERNODE_GIT_HOST_USER: s.user, USERNODE_GIT_HOST_TOKEN: s.token } : {}) });
  return new Promise((resolve, reject) => {
    const child = execFile('git', [...config, ...args], { cwd, env, timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = new GitHostError(`git ${args[0]} failed: ${redact(stderr || err.message).trim().slice(0, 500)}`, { code: 'git_failed' });
        e.stderr = redact(stderr);
        // `push --porcelain` says why a ref was rejected on stdout.
        e.stdout = redact(stdout);
        e.exitCode = err.code;
        return reject(e);
      }
      resolve({ stdout: String(stdout), stderr: redact(stderr) });
    });
    if (input != null) child.stdin.end(input);
  });
}

// ── The host's API (only what git cannot do: making a repository) ─────

async function api(method, apiPath, body = undefined, { allow = [] } = {}) {
  const s = settings();
  if (!isConfigured()) throw new GitHostError('The git host is not configured', { code: 'not_configured' });
  const resp = await fetch(`${s.internalUrl}/api/v1${apiPath}`, {
    method,
    headers: {
      Authorization: `token ${s.token}`,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
    redirect: 'error',
  });
  if (!resp.ok && !allow.includes(resp.status)) {
    const text = await resp.text().catch(() => '');
    throw new GitHostError(`git host ${method} ${apiPath} answered ${resp.status}: ${redact(text).slice(0, 300)}`, { status: resp.status });
  }
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  return { status: resp.status, data };
}

/**
 * Make an empty repository `name` in the apps organisation and resolve
 * { owner, name, url } (url: what apps.repo_url stores). `adoptExisting`
 * takes one that already exists (a retried create) instead of failing.
 */
async function createRepo(name, { description = '', private: isPrivate = false, adoptExisting = false } = {}) {
  const n = assertName(name);
  const s = settings();
  const { status } = await api('POST', `/orgs/${encodeURIComponent(s.org)}/repos`, {
    name: n,
    description: String(description || '').slice(0, 255),
    private: !!isPrivate,
    auto_init: false,
    default_branch: 'main',
  }, { allow: [409] });
  if (status === 409 && !adoptExisting) {
    throw new GitHostError(`A repository named ${n} already exists`, { status: 409, code: 'repo_exists' });
  }
  if (status === 409) log.info('git-host', 'Adopted an existing repository', { name: n });
  else log.info('git-host', 'Created a repository', { name: n });
  return { owner: s.org, name: n, url: repoUrl(n) };
}

/** Whether `repo` exists on the host. */
async function repoExists(repo) {
  const { owner, name } = nameOf(repo);
  const { status } = await api('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, undefined, { allow: [404] });
  return status !== 404;
}

/** Make the repository private or public (code visibility, plan §5). */
async function setPrivate(repo, isPrivate) {
  const { owner, name } = nameOf(repo);
  await api('PATCH', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, { private: !!isPrivate });
}

// ── Refs ──────────────────────────────────────────────────────────────

const SHA_RE = /^[0-9a-f]{40}$/;

function branchRef(ref) {
  const r = String(ref || '');
  return r.startsWith('refs/') ? r : `refs/heads/${r}`;
}

/** The commit `ref` (a branch name or full ref) points at, or null. */
async function readRef(repo, ref = 'main') {
  const full = branchRef(ref);
  const { stdout } = await git(['ls-remote', cloneUrl(repo), full], { auth: true, timeout: 30_000 });
  const line = stdout.split('\n').find((l) => l.endsWith(`\t${full}`));
  return line ? line.split('\t')[0] : null;
}

/** Every branch on the host: { name: sha }. */
async function listBranches(repo) {
  const { stdout } = await git(['ls-remote', '--heads', cloneUrl(repo)], { auth: true, timeout: 30_000 });
  const out = {};
  for (const line of stdout.split('\n')) {
    const [sha, ref] = line.split('\t');
    if (sha && ref && ref.startsWith('refs/heads/')) out[ref.slice('refs/heads/'.length)] = sha;
  }
  return out;
}

/**
 * Push `refspecs` (['<sha>:refs/heads/x', ...]) from the local repository
 * at `gitDir`, which holds the objects. `force` allows non-fast-forwards.
 */
async function pushRefs(repo, gitDir, refspecs, { force = false } = {}) {
  if (!refspecs.length) return;
  await git(['-C', gitDir, 'push', '--porcelain', ...(force ? ['--force'] : []), cloneUrl(repo), ...refspecs], { auth: true });
}

/**
 * Move `ref` from `expected` to `newSha`, only if it is still at
 * `expected` (null: only if it does not exist yet). The objects come from
 * the local repository at `gitDir`. Rejects with RefMovedError when the ref
 * has moved: the merge-time guarantee GitHub's pinned merge gave (its 409),
 * kept by the git server's own ref lock.
 */
async function casUpdateRef(repo, gitDir, ref, expected, newSha) {
  if (!SHA_RE.test(String(newSha || ''))) throw new GitHostError('casUpdateRef needs a full commit sha', { code: 'invalid_sha' });
  if (expected != null && !SHA_RE.test(String(expected))) throw new GitHostError('casUpdateRef needs a full expected sha', { code: 'invalid_sha' });
  const full = branchRef(ref);
  const lease = `--force-with-lease=${full}:${expected || ''}`;
  try {
    await git(['-C', gitDir, 'push', '--porcelain', lease, cloneUrl(repo), `${newSha}:${full}`], { auth: true });
  } catch (err) {
    if (/stale info|\(fetch first\)|non-fast-forward|\[rejected\]/i.test(`${err.stdout || ''}\n${err.stderr || err.message}`)) {
      throw new RefMovedError(`${full} is no longer at ${expected ? String(expected).slice(0, 8) : 'nothing'}`);
    }
    throw err;
  }
}

/**
 * Delete branch `ref` on the host. A branch already gone is fine. A git
 * push, not the API: Forgejo records a pushed branch in its database a
 * moment after the push, and an API delete in that moment answers 404,
 * which reads exactly like "already gone".
 */
async function deleteRef(repo, ref) {
  const full = branchRef(ref);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-host-delete-'));
  try {
    await git(['init', '-q', '--bare', dir]);
    await git(['-C', dir, 'push', '--porcelain', cloneUrl(repo), `:${full}`], { auth: true });
  } catch (err) {
    if (!/remote ref does not exist/i.test(`${err.stdout || ''}\n${err.stderr || err.message}`)) throw err;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ── Making a repository's first commit from files ─────────────────────

/**
 * Commit `files` ({ path: content } or [{ path, content }]) as the root
 * commit of an empty working repository and push it to `branch`. Resolves
 * the new commit's sha. For app creation, starters and remixes.
 */
async function pushInitialFiles(repo, files, { branch = 'main', message = 'Initial commit', author = defaultAuthor() } = {}) {
  const list = Array.isArray(files) ? files : Object.entries(files).map(([p, content]) => ({ path: p, content }));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-host-init-'));
  try {
    await git(['init', '-q', '-b', branch, dir]);
    for (const f of list) {
      const rel = String(f.path || '').replace(/^\/+/, '');
      if (!rel || rel.split('/').includes('..')) throw new GitHostError(`Invalid file path: ${rel.slice(0, 120)}`, { code: 'invalid_path' });
      const abs = path.join(dir, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, f.encoding === 'base64' ? Buffer.from(f.content, 'base64') : String(f.content ?? ''));
      if (f.mode === '100755') await fs.chmod(abs, 0o755);
    }
    await git(['-C', dir, 'add', '-A']);
    await git(['-C', dir, '-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`,
      'commit', '-q', '--no-verify', '-m', message]);
    const { stdout } = await git(['-C', dir, 'rev-parse', 'HEAD']);
    const sha = stdout.trim();
    await casUpdateRef(repo, dir, branch, null, sha);
    return sha;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Who the platform's own commits are by. */
function defaultAuthor() {
  return {
    name: process.env.GIT_HOST_COMMIT_NAME || 'Homeroom',
    email: process.env.GIT_HOST_COMMIT_EMAIL || 'homeroom@users.noreply.onhomeroom.com',
  };
}

module.exports = {
  GitHostError,
  RefMovedError,
  settings,
  isConfigured,
  repoUrl,
  parseRepoUrl,
  isHostedUrl,
  cloneUrl,
  git,
  api,
  createRepo,
  repoExists,
  setPrivate,
  readRef,
  listBranches,
  pushRefs,
  casUpdateRef,
  deleteRef,
  pushInitialFiles,
  defaultAuthor,
  redact,
};
