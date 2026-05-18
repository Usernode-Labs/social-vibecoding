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

// Worker containers carry no GitHub credentials — we restrict imports
// to public repos, so `git clone` over plain HTTPS just works. This
// used to return a token-embedded URL; that capability moved to the
// platform-side push proxy (see src/routes/internal.js +
// worker.execPushFromWorker).
async function getCloneUrl(owner, repo) {
  return `https://github.com/${owner}/${repo}.git`;
}

// ---------------------------------------------------------------------------
// "Import existing repo" helpers.
//
// These power the new flow where a user pastes a GitHub URL into the
// create-app modal. None of them are part of the bot-owns-the-repo path —
// existing apps go through createRepo/pushFiles unchanged.
// ---------------------------------------------------------------------------

// Parse the variants we want to accept from the user. Returns
// { owner, repo } or null. We deliberately don't accept arbitrary git
// hosts: this is GitHub-specific to match the rest of the platform.
function parseGithubUrl(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;

  // Strip an optional .git suffix and any trailing slash so all four URL
  // shapes (https, https/, https.git, ssh) collapse to "owner/repo".
  const cleaned = s.replace(/\.git$/i, '').replace(/\/+$/, '');

  // https://github.com/owner/repo
  let m = cleaned.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)(?:\/.*)?$/i);
  if (!m) {
    // git@github.com:owner/repo
    m = cleaned.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  }
  if (!m) return null;
  const owner = m[1];
  const repo = m[2];
  // Guard against query strings or fragments leaking into the repo name.
  if (!/^[\w.\-]+$/.test(owner) || !/^[\w.\-]+$/.test(repo)) return null;
  return { owner, repo };
}

// Find a pending invitation for *this exact repo* and accept it. Used
// only as a side-effect of the import-flow pre-flight, never as a
// background poller — that's the user-confirmed scoping rule.
//
// Returns true if an invitation was found+accepted, false otherwise.
// Errors are swallowed by the caller (verifyBotAccess) so a transient
// invitation-list failure doesn't mask the real problem on the get-repo
// call that follows.
async function acceptInvitationFor(owner, repo) {
  const pat = process.env.GITHUB_BOT_TOKEN;
  if (!pat) return false;
  const { Octokit } = await import('@octokit/rest');
  const octokit = new Octokit({ auth: pat });
  const invites = await octokit.rest.repos.listInvitationsForAuthenticatedUser();
  const match = invites.data.find(
    (i) => i.repository.owner.login.toLowerCase() === owner.toLowerCase()
        && i.repository.name.toLowerCase() === repo.toLowerCase()
  );
  if (!match) return false;
  await octokit.rest.repos.acceptInvitationForAuthenticatedUser({ invitation_id: match.id });
  log.info('github', 'Accepted repo invitation', { repo: `${owner}/${repo}`, id: match.id });
  return true;
}

// The pre-flight that gates POST /api/apps when repoUrl is set. The
// shape of the return value is deliberately wire-friendly: the route
// just forwards `{ status, error: message }` to the client when ok is
// false, so the modal can show an actionable hint and stay open.
async function verifyBotAccess(owner, repo) {
  const pat = process.env.GITHUB_BOT_TOKEN;
  if (!pat) {
    return {
      ok: false, status: 500, code: 'no_token',
      message: 'GitHub bot token not configured on the platform.',
    };
  }
  const { Octokit } = await import('@octokit/rest');
  const octokit = new Octokit({ auth: pat });

  // Greedy first pass: if the user just invited the bot moments before
  // clicking submit, the invitation accept turns this into a one-step
  // flow. Failures here are non-fatal — the get-repo call below will
  // still produce the correct 404/403 if there's a real access problem.
  await acceptInvitationFor(owner, repo).catch((err) => {
    log.warn('github', 'acceptInvitationFor failed (non-fatal)', { repo: `${owner}/${repo}`, err: err.message });
  });

  let resp;
  try {
    resp = await octokit.rest.repos.get({ owner, repo });
  } catch (err) {
    if (err.status === 404) {
      return {
        ok: false, status: 404, code: 'not_found',
        message: `Couldn't see ${owner}/${repo}. If it's private, invite \`usernode-bot\` as a collaborator with Write access and resubmit.`,
      };
    }
    if (err.status === 401) {
      return {
        ok: false, status: 500, code: 'unauthorized',
        message: 'Platform GitHub credentials are invalid — contact an admin.',
      };
    }
    return { ok: false, status: 502, code: 'github_error', message: `GitHub error: ${err.message}` };
  }

  // Public-only enforcement. Usernode workers run with zero GitHub
  // credentials inside the container — git pushes flow through a
  // platform-side proxy instead. That model relies on the worker being
  // able to `git clone` over unauthenticated HTTPS, which requires the
  // repo to be public. Reject private imports up front so users get a
  // clean error rather than a mysterious bootstrap failure later.
  if (resp.data.private === true) {
    return {
      ok: false, status: 400, code: 'private_repo',
      message: `${owner}/${repo} is a private repository. Usernode currently supports public repositories only — switch the repo to public on GitHub and resubmit.`,
    };
  }

  // permissions.push covers everyone the bot would actually be able to
  // commit through (Write, Maintain, Admin all set push:true).
  const perms = resp.data.permissions || {};
  if (!perms.push) {
    return {
      ok: false, status: 403, code: 'no_push',
      message: `\`usernode-bot\` has read-only access to ${owner}/${repo}. Grant Write/Maintain and resubmit.`,
    };
  }
  return {
    ok: true,
    name: resp.data.name || repo,
    description: resp.data.description || null,
    fullName: resp.data.full_name || `${owner}/${repo}`,
  };
}

// Lightweight privacy check. Used by:
//   - worker bootstrap (defense against post-import privacy flips)
//   - the startup audit (sweeps existing imports)
// Returns { ok: true, private: bool } on success, { ok: false, code, message }
// on failure. Callers decide whether to treat "couldn't determine" as
// fatal (bootstrap) or just log (audit).
async function checkRepoPublic(owner, repo) {
  const pat = process.env.GITHUB_BOT_TOKEN;
  if (!pat) {
    return { ok: false, code: 'no_token', message: 'GitHub bot token not configured.' };
  }
  const { Octokit } = await import('@octokit/rest');
  const octokit = new Octokit({ auth: pat });
  try {
    const { data } = await octokit.rest.repos.get({ owner, repo });
    return { ok: true, private: data.private === true };
  } catch (err) {
    if (err.status === 404) {
      return { ok: false, code: 'not_found', message: `Repo ${owner}/${repo} not accessible.` };
    }
    return { ok: false, code: 'github_error', message: err.message };
  }
}

// Unauthenticated GET that powers the name-prefill in the modal. We
// deliberately do NOT use the bot token here: the prefill is a
// convenience, not an oracle, and keeping it unauth means a private
// repo silently 404s without leaking name/description info that the
// caller wouldn't otherwise be able to see. Verification on submit
// (verifyBotAccess) is what actually gates access.
async function fetchPublicRepoInfo(owner, repo) {
  try {
    const resp = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: { 'Accept': 'application/vnd.github+json' },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return { name: data.name || null, description: data.description || null };
  } catch (_) {
    return null;
  }
}

module.exports = {
  init,
  isEnabled,
  getBotUsername,
  getOctokit,
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
  parseGithubUrl,
  acceptInvitationFor,
  verifyBotAccess,
  checkRepoPublic,
  fetchPublicRepoInfo,
};
