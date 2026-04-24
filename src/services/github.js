const log = require('./logger');

let App;
let app;

// Neutralize `@handle` mentions in outgoing content so Usernode never
// pings a random GitHub account that happens to own a matching handle.
// We insert a zero-width space between `@` and the first word char; the
// text still renders as `@handle` visually but GitHub's linker skips it.
// Called at every boundary where text crosses into GitHub (PR/issue
// bodies, comments, commit messages).
function safeMention(s) {
  if (typeof s !== 'string' || !s) return s;
  return s.replace(/@(?=[A-Za-z0-9_-])/g, '@\u200B');
}
const installationCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;

async function init(config) {
  if (!config.githubAppId || !config.githubPrivateKey) {
    log.warn('github', 'GitHub App credentials not configured — GitHub features disabled');
    return;
  }

  const mod = await import('@octokit/app');
  App = mod.App;

  app = new App({
    appId: config.githubAppId,
    privateKey: config.githubPrivateKey,
  });
  log.info('github', 'GitHub App initialized', { appId: config.githubAppId });

  // The App credentials alone aren't enough: repo creation, branch pushes,
  // PR creation, and staging recovery all require a PAT (GITHUB_BOT_TOKEN).
  // Warn loudly at boot if it's missing so deploys don't silently half-work.
  if (!process.env.GITHUB_BOT_TOKEN) {
    log.warn('github', 'GITHUB_BOT_TOKEN is not set — repo creation, commits, PRs, and session recovery will fail');
  }
}

function isEnabled() {
  return !!app;
}

async function resolveInstallationId(owner) {
  const cached = installationCache.get(owner);
  if (cached && cached.expiresAt > Date.now()) return cached.id;

  for await (const { installation } of app.eachInstallation.iterator()) {
    if (installation.account?.login === owner) {
      installationCache.set(owner, { id: installation.id, expiresAt: Date.now() + CACHE_TTL_MS });
      return installation.id;
    }
  }
  throw new Error(`No GitHub App installation found for owner: ${owner}`);
}

async function getInstallationOctokit(owner) {
  const id = await resolveInstallationId(owner);
  return app.getInstallationOctokit(id);
}

async function getInstallationToken(owner) {
  const installationId = await resolveInstallationId(owner);
  const { data } = await app.octokit.request('POST /app/installations/{installation_id}/access_tokens', {
    installation_id: installationId,
  });
  return data.token;
}

async function getBotUsername() {
  for await (const { installation } of app.eachInstallation.iterator()) {
    return installation.account.login;
  }
  throw new Error('No installations found for GitHub App');
}

async function createRepo(owner, name, { description = '' } = {}) {
  // GitHub App installation tokens can't create repos on user accounts (GitHub limitation).
  // Use a PAT (GITHUB_BOT_TOKEN) for repo creation.
  const pat = process.env.GITHUB_BOT_TOKEN;
  if (!pat) {
    throw new Error('GITHUB_BOT_TOKEN env var required for repo creation on user accounts');
  }

  const { Octokit } = await import('@octokit/rest');
  const octokit = new Octokit({ auth: pat });

  const { data } = await octokit.rest.repos.createForAuthenticatedUser({
    name,
    description: safeMention(description),
    auto_init: true,
    private: false,
  });
  log.info('github', 'Repo created via PAT', { repo: data.full_name });
  return data;
}

async function getOctokit(owner) {
  // Prefer PAT for repos owned by the bot (avoids App installation sync issues)
  const pat = process.env.GITHUB_BOT_TOKEN;
  if (pat) {
    const { Octokit } = await import('@octokit/rest');
    return new Octokit({ auth: pat });
  }
  return getInstallationOctokit(owner);
}

async function pushFiles(owner, repo, files, { branch = 'main', message = 'Initial commit' } = {}) {
  const octokit = await getOctokit(owner);

  const { data: ref } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
  const latestCommitSha = ref.object.sha;

  const { data: baseCommit } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: latestCommitSha });
  const baseTreeSha = baseCommit.tree.sha;

  const tree = files.map((f) => ({
    path: f.path,
    mode: '100644',
    type: 'blob',
    content: f.content,
  }));

  const { data: newTree } = await octokit.rest.git.createTree({ owner, repo, tree, base_tree: baseTreeSha });

  const { data: newCommit } = await octokit.rest.git.createCommit({
    owner, repo,
    message,
    tree: newTree.sha,
    parents: [latestCommitSha],
  });

  await octokit.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: newCommit.sha });

  log.info('github', 'Files pushed', { repo: `${owner}/${repo}`, fileCount: files.length });
  return newCommit;
}

async function createBranch(owner, repo, branchName) {
  const octokit = await getOctokit(owner);
  const { data: ref } = await octokit.rest.git.getRef({ owner, repo, ref: 'heads/main' });

  await octokit.rest.git.createRef({
    owner, repo,
    ref: `refs/heads/${branchName}`,
    sha: ref.object.sha,
  });

  log.info('github', 'Branch created', { repo: `${owner}/${repo}`, branch: branchName });
}

async function createPR(owner, repo, { branch, title, body }) {
  const octokit = await getOctokit(owner);
  const { data } = await octokit.rest.pulls.create({
    owner, repo,
    title: safeMention(title),
    body: safeMention(body),
    head: branch,
    base: 'main',
  });
  log.info('github', 'PR created', { repo: `${owner}/${repo}`, pr: data.number });
  return data;
}

async function updatePR(owner, repo, prNumber, { title, body } = {}) {
  // Goes through getOctokit (PAT-preferred) so callers get a real
  // @octokit/rest instance with `.rest.pulls.update`, instead of the
  // bare @octokit/app installation client whose surface differs and
  // throws "Cannot read properties of undefined (reading 'pulls')".
  const octokit = await getOctokit(owner);
  const params = { owner, repo, pull_number: prNumber };
  if (typeof title === 'string') params.title = safeMention(title);
  if (typeof body === 'string') params.body = safeMention(body);
  const { data } = await octokit.rest.pulls.update(params);
  log.info('github', 'PR updated', { repo: `${owner}/${repo}`, pr: prNumber });
  return data;
}

async function mergePR(owner, repo, prNumber) {
  const octokit = await getOctokit(owner);
  const { data } = await octokit.rest.pulls.merge({
    owner, repo,
    pull_number: prNumber,
    merge_method: 'squash',
  });
  log.info('github', 'PR merged', { repo: `${owner}/${repo}`, pr: prNumber });
  return data;
}

async function createIssue(owner, repo, { title, body }) {
  const octokit = await getOctokit(owner);
  const { data } = await octokit.rest.issues.create({
    owner, repo,
    title: safeMention(title),
    body: safeMention(body),
  });
  log.info('github', 'Issue created', { repo: `${owner}/${repo}`, issue: data.number });
  return data;
}

async function getCloneUrl(owner, repo) {
  const pat = process.env.GITHUB_BOT_TOKEN;
  if (pat) {
    return `https://x-access-token:${pat}@github.com/${owner}/${repo}.git`;
  }
  const token = await getInstallationToken(owner);
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}

module.exports = {
  init,
  isEnabled,
  getBotUsername,
  getInstallationOctokit,
  getInstallationToken,
  createRepo,
  pushFiles,
  createBranch,
  createPR,
  updatePR,
  mergePR,
  createIssue,
  getCloneUrl,
  safeMention,
};
