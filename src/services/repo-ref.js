'use strict';

// One parser for a repository address, whichever host it is on.
//
// apps.repo_url used to be a github.com URL, parsed by some 80 hand-written
// `github\.com` regexes. Since GitHub suspended the account that owned every
// app repository (25 Oct 2026), app repositories live on Homeroom's own git
// host (services/git-host.js) and only the platform's own repository stays
// on GitHub (docs/plans/github-independence-build.md). Every place that
// reads a stored repository address goes through here instead:
//
//   parse(url)       { host: 'git_host' | 'github', owner, repo } or null
//   ownerRepo(url)   { owner, repo } or null (the old regexes' result)
//   webUrl / commitUrl / treeUrl / compareUrl   pages people open
//   cloneUrl(url)    where git reads it
//   isHosted / isGithub / sameRepo / isPlatformRepo
//
// A person's own input (the import field) is still parsed as GitHub only,
// by src/workflow/rules/github-url.ts: importing a public GitHub repository
// is the one way code arrives from GitHub.

const gitHost = require('./git-host');

const GITHUB_HTTPS = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?(?:[?#].*)?$/i;
const GITHUB_SSH = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i;
const SEGMENT = /^[\w.-]+$/;

/** { host, owner, repo } for a stored repository address, else null. */
function parse(url) {
  if (url && typeof url === 'object' && url.owner && url.repo) {
    return { host: url.host || 'github', owner: String(url.owner), repo: String(url.repo) };
  }
  const s = String(url || '').trim();
  if (!s) return null;
  const hosted = gitHost.parseRepoUrl(s);
  if (hosted) return { host: 'git_host', owner: hosted.owner, repo: hosted.name };
  const m = s.match(GITHUB_HTTPS) || s.match(GITHUB_SSH);
  if (!m || !SEGMENT.test(m[1]) || !SEGMENT.test(m[2])) return null;
  return { host: 'github', owner: m[1], repo: m[2] };
}

/** { owner, repo } for a stored address, else null. */
function ownerRepo(url) {
  const p = parse(url);
  return p ? { owner: p.owner, repo: p.repo } : null;
}

function isHosted(url) {
  const p = parse(url);
  return !!(p && p.host === 'git_host');
}

function isGithub(url) {
  const p = parse(url);
  return !!(p && p.host === 'github');
}

/**
 * Which host `owner` names: the git host's organisation, else GitHub. For
 * callers that only kept owner/repo (the GitHub-shaped helpers).
 */
function hostOfOwner(owner) {
  const { org } = gitHost.settings();
  return org && String(owner || '').toLowerCase() === org.toLowerCase() && gitHost.settings().url ? 'git_host' : 'github';
}

/** The repository's page. */
function webUrl(url) {
  const p = parse(url);
  if (!p) return null;
  if (p.host === 'git_host') return gitHost.repoUrl(p.repo, { org: p.owner });
  return `https://github.com/${p.owner}/${p.repo}`;
}

/** A commit's page. Forgejo and GitHub both use /commit/<sha>. */
function commitUrl(url, sha) {
  const base = webUrl(url);
  return base && sha ? `${base}/commit/${sha}` : null;
}

/** A branch's file tree. */
function treeUrl(url, branch) {
  const p = parse(url);
  const base = webUrl(url);
  if (!base || !branch) return null;
  const b = String(branch).split('/').map(encodeURIComponent).join('/');
  return p.host === 'git_host' ? `${base}/src/branch/${b}` : `${base}/tree/${b}`;
}

/** Two refs compared. Forgejo and GitHub both use /compare/<base>...<head>. */
function compareUrl(url, base, head) {
  const page = webUrl(url);
  return page && base && head ? `${page}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}` : null;
}

/** Where git reads it: the git host's internal address, or GitHub's. */
function cloneUrl(url, { internal = true } = {}) {
  const p = parse(url);
  if (!p) return null;
  if (p.host === 'git_host') return gitHost.cloneUrl({ owner: p.owner, name: p.repo }, { internal });
  return `https://github.com/${p.owner}/${p.repo}.git`;
}

/** Whether two addresses name the same repository (case-insensitively). */
function sameRepo(a, b) {
  const x = parse(a);
  const y = parse(b);
  return !!(x && y && x.host === y.host
    && x.owner.toLowerCase() === y.owner.toLowerCase()
    && x.repo.toLowerCase() === y.repo.toLowerCase());
}

const DEFAULT_PLATFORM_REPO_URL = 'https://github.com/Usernode-Labs/social-vibecoding';

function platformRepoUrl(config = null) {
  return (config && config.platformRepoUrl)
    || process.env.USERNODE_PLATFORM_REPO
    || process.env.USERNODE_REPO_URL
    || DEFAULT_PLATFORM_REPO_URL;
}

/** Whether `url` (or an app with a repo_url) is the platform's own repository. */
function isPlatformRepo(url, config = null) {
  const target = url && typeof url === 'object' && !url.owner ? url.repo_url : url;
  return sameRepo(target, platformRepoUrl(config));
}

module.exports = {
  parse,
  ownerRepo,
  isHosted,
  isGithub,
  hostOfOwner,
  webUrl,
  commitUrl,
  treeUrl,
  compareUrl,
  cloneUrl,
  sameRepo,
  platformRepoUrl,
  isPlatformRepo,
  DEFAULT_PLATFORM_REPO_URL,
};
