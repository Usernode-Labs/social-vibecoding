'use strict';

const platformJwt = require('./platform-jwt');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createReadStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const docker = require('./docker');
const gitHost = require('./git-host');
const repoRef = require('./repo-ref');

// A platform checkout may recurse into someone else's submodules. Scope the
// Forgejo credential to the canonical clone URL for this project.
function checkoutGit(repoUrl, cloneUrl, publicGit = (args, options) => docker.execFileAsync('git', args, options)) {
  if (!repoRef.isHosted(repoUrl)) return publicGit;
  return (args, options) => gitHost.git(args, { ...options, auth: true, readUrl: cloneUrl });
}

const PREFIX = 'svgs_';
const SHA = /^[a-f0-9]{40}$/;
const NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const INTERNAL_PATH = '/api/internal/project-source';
const MAX_SOURCE_TIME_MS = 120_000;

function selected(repo) {
  const targets = String(process.env.GIT_HOST_PRIVATE_PROJECTS || '').toLowerCase().split(',').map(s => s.trim());
  return targets.includes('*') || targets.includes(String(repo).toLowerCase());
}

function hostedOwner(owner) {
  return repoRef.hostOfOwner(owner) === 'git_host';
}

function normalizeName(repo) {
  const name = String(repo).toLowerCase();
  if (!NAME.test(name) || name.includes('..') || name.endsWith('.git')) {
    throw new Error('Invalid project source repository');
  }
  return name;
}

function internalUrl(suffix) {
  const base = process.env.PLATFORM_INTERNAL_URL || 'http://usernode:3000';
  return new URL(`${INTERNAL_PATH}/${suffix}`, base).href;
}

function issueGrant(repo, kind, claims, expiresIn) {
  return PREFIX + platformJwt.signProjectSourceToken({
    ...claims, repo: normalizeName(repo), kind, host: gitHost.settings().url, owner: gitHost.settings().org,
  }, expiresIn);
}

function verifyGrant(raw, kind, repo) {
  if (typeof raw !== 'string' || !raw.startsWith(PREFIX) || raw.length > 2048) return null;
  try {
    const grant = platformJwt.verifyProjectSourceToken(raw.slice(PREFIX.length));
    const host = gitHost.settings();
    if (grant.kind === kind && grant.repo === normalizeName(repo) && grant.host === host.url
        && grant.owner === host.org && Number.isFinite(grant.exp)) return grant;
  } catch { /* an invalid, expired or differently scoped credential */ }
  return null;
}

function fromAuthorization(value) {
  return /^Bearer (svgs_[A-Za-z0-9_.-]+)$/.exec(value || '')?.[1] || null;
}

// Choose the authenticated path for a selected repository even while it is
// still public so the same path can be exercised before the backfill.
function workloadRead(owner, repo, { expiresIn = 3600 } = {}) {
  if (!hostedOwner(owner) || !selected(repo)) return null;
  const name = normalizeName(repo);
  return {
    url: internalUrl(`git/${name}.git`),
    canonical: gitHost.cloneUrl({ owner, name: repo }),
    token: issueGrant(name, 'git', {}, expiresIn),
  };
}

async function workerTurnRead(pool, sessionId) {
  if (!pool || !gitHost.isConfigured() || !process.env.GIT_HOST_PRIVATE_PROJECTS) return null;
  const { rows: [session] } = await pool.query(
    'SELECT a.repo_url FROM chat_sessions s JOIN apps a ON a.id = s.app_id WHERE s.id = $1', [sessionId],
  );
  const parsed = repoRef.parse(session?.repo_url);
  if (parsed?.host !== 'git_host') return null;
  return workloadRead(parsed.owner, parsed.repo, { expiresIn: 7200 });
}

function managedRepo(repoUrl) {
  const parsed = repoRef.parse(repoUrl);
  return parsed?.host === 'git_host' && hostedOwner(parsed.owner) && selected(parsed.repo)
    ? normalizeName(parsed.repo) : null;
}

function privateApp(app) {
  return app && !app.self_hosted && app.view_visibility === 'private' && !!managedRepo(app.repo_url);
}

function workOrderRead({ app, task, userId, origin }) {
  if (!privateApp(app)) return null;
  const repo = managedRepo(app.repo_url);
  const revision = task.base_sha;
  if (!SHA.test(revision)) throw new Error('Work order source requires a full revision');
  const url = new URL(`/api/external-tasks/${Number(task.id)}/source/${repo}`, origin);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.href.includes("'")) {
    throw new Error('Invalid work order source origin');
  }
  return {
    url: url.href,
    token: issueGrant(repo, 'work-order', { taskId: Number(task.id), userId: String(userId), revision }, 3600),
  };
}

function buildArchiveUrl(repoUrl, revision, expiresIn) {
  const name = managedRepo(repoUrl);
  if (!name) return null;
  const sha = String(revision).toLowerCase();
  if (!SHA.test(sha)) throw new Error('Project source requires a full revision');
  const url = new URL(internalUrl(`archive/${name}/${sha}.tar.gz`));
  url.searchParams.set('grant', issueGrant(name, 'archive', { revision: sha }, expiresIn));
  return url.href;
}

// The filesystem checkout used by kpack must match Git's working tree. Git
// archive itself honors export-ignore/export-subst, which can change builds.
async function archive(repo, revision, response, fileName = 'source.tar.gz') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'homeroom-source-'));
  const work = path.join(dir, 'work');
  const output = path.join(dir, 'source.tar.gz');
  const url = gitHost.cloneUrl(repo);
  const sourceGit = checkoutGit(url, url);
  try {
    await fs.mkdir(work);
    await gitHost.git(['-C', work, 'init', '--quiet']);
    await sourceGit(['-C', work, 'fetch', '-q', '--depth', '1', '--no-tags', url, revision]);
    await gitHost.git(['-C', work, 'checkout', '--quiet', '--detach', revision]);
    await fs.rm(path.join(work, '.git'), { recursive: true, force: true });
    await docker.execFileAsync('tar', ['-czf', output, '-C', work, '.'], { timeout: MAX_SOURCE_TIME_MS });
    response.set('Cache-Control', 'private, no-store');
    response.attachment(fileName);
    await pipeline(createReadStream(output), response);
  } finally {
    await fs.rm(dir, { force: true, recursive: true });
  }
}

// Keep only the chosen commit and its ancestors. The recipient gets real
// Git objects for exact-base patch submission and no other refs.
async function bundle(repo, revision, response, fileName = 'source.bundle') {
  if (!SHA.test(revision)) throw new Error('Project bundle requires a full revision');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'homeroom-bundle-'));
  const bare = path.join(dir, 'repo');
  const output = path.join(dir, 'source.bundle');
  const url = gitHost.cloneUrl(repo);
  const sourceGit = checkoutGit(url, url);
  try {
    await gitHost.git(['init', '-q', '--bare', bare]);
    await sourceGit(['-C', bare, 'fetch', '-q', '--no-tags', url, `${revision}:refs/heads/source`]);
    await gitHost.git(['-C', bare, 'symbolic-ref', 'HEAD', 'refs/heads/source']);
    await gitHost.git(['-C', bare, 'bundle', 'create', output, 'refs/heads/source', 'HEAD']);
    response.set('Cache-Control', 'private, no-store');
    response.attachment(fileName);
    await pipeline(createReadStream(output), response);
  } finally {
    await fs.rm(dir, { force: true, recursive: true });
  }
}

module.exports = {
  INTERNAL_PATH, MAX_SOURCE_TIME_MS, SHA, checkoutGit, hostedOwner, normalizeName, selected,
  issueGrant, verifyGrant, fromAuthorization, workloadRead, workerTurnRead, managedRepo, privateApp, workOrderRead, buildArchiveUrl, archive, bundle,
};
