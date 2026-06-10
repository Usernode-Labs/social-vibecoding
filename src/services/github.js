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

// Anonymous GitHub REST needs a User-Agent or it 403s every request.
const GITHUB_USER_AGENT = 'usernode-platform';

// Read-only open-issues fetch (fetchPublicIssues) tunables. The 5-minute
// cache is the primary defense against GitHub's 60-req/hr/IP anonymous
// limit — all three agent surfaces (Mayor tool, scout, build) resolve
// through one function, so they share one cache entry per repo. The page
// ceiling bounds worst-case work for a repo with thousands of issues.
//
// Freshness on the "Open Issues" panel doesn't rely on this TTL: when a PR
// merges through the platform (routes/votes.js checkAndMerge) the closed
// issues are known from session.linked_issues, so the merge path busts this
// entry via invalidateIssuesCache() and broadcasts a refresh. The TTL is the
// backstop for closes that don't go through a platform merge.
const issuesCache = new Map();
const ISSUES_CACHE_TTL_MS = 5 * 60 * 1000;
const ISSUES_MAX_PAGES = 10;          // 10 * 100 = up to 1000 open issues
const ISSUE_BODY_MAX = 500;           // chars before we truncate the body
const ISSUES_FETCH_TIMEOUT_MS = 8000; // per-page request timeout

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

// Read a single file's decoded text contents from a repo at `ref`
// (default the repo's default branch). Returns the string, or null when
// the file doesn't exist (404) so callers can branch on "create vs
// edit" without try/catch noise. Other errors propagate.
async function getFileContent(owner, repo, filePath, ref) {
  const octokit = await getOctokit(owner);
  try {
    const params = { owner, repo, path: filePath };
    if (ref) params.ref = ref;
    const { data } = await octokit.rest.repos.getContent(params);
    // getContent returns an array for directories; a file has a base64
    // `content` field we decode to UTF-8.
    if (Array.isArray(data) || typeof data.content !== 'string') return null;
    return Buffer.from(data.content, data.encoding || 'base64').toString('utf-8');
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
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

async function closePR(owner, repo, prNumber) {
  const octokit = await getOctokit(owner);
  const { data } = await octokit.rest.pulls.update({
    owner, repo, pull_number: prNumber, state: 'closed',
  });
  log.info('github', 'PR closed', { repo: `${owner}/${repo}`, pr: prNumber });
  return data;
}

// Reopen a previously-closed PR. Best-effort: GitHub refuses to reopen a
// PR whose head branch was deleted (and some installations restrict
// reopening to the user who closed it), so callers should treat a throw
// as "couldn't reopen — fall back to proposing a fresh PR from the branch".
async function reopenPR(owner, repo, prNumber) {
  const octokit = await getOctokit(owner);
  const { data } = await octokit.rest.pulls.update({
    owner, repo, pull_number: prNumber, state: 'open',
  });
  log.info('github', 'PR reopened', { repo: `${owner}/${repo}`, pr: prNumber });
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

// Fetch a single PR (body, state, merged flag, …). Used by the
// linked-issues backfill to parse closing keywords out of historical PR
// bodies that predate the #75/#79 linkage plumbing.
async function getPR(owner, repo, prNumber) {
  const octokit = await getOctokit(owner);
  const { data } = await octokit.rest.pulls.get({
    owner, repo,
    pull_number: prNumber,
  });
  return data;
}

// Close an issue. Goes through getOctokit (PAT-preferred) so we get a
// real @octokit/rest instance with `.rest.issues.update`. Used by the
// rename-issue → rename-PR migration to retire the legacy issue once its
// PR is open (mirrors how maybeApplyRenameProposal closes the issue when
// a rename vote lands).
async function closeIssue(owner, repo, issueNumber) {
  const octokit = await getOctokit(owner);
  const { data } = await octokit.rest.issues.update({
    owner, repo, issue_number: issueNumber, state: 'closed',
  });
  log.info('github', 'Issue closed', { repo: `${owner}/${repo}`, issue: issueNumber });
  return data;
}

// Fetch a single issue (state, pull_request marker, …). Used by the
// post-merge close watcher (#135) to poll whether GitHub's own `Closes #N`
// handling has closed the issue yet. Note GitHub numbers issues and PRs in
// one sequence — callers must check the `pull_request` key on the response
// to tell them apart.
async function getIssue(owner, repo, issueNumber) {
  const octokit = await getOctokit(owner);
  const { data } = await octokit.rest.issues.get({
    owner, repo, issue_number: issueNumber,
  });
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

// Parse the `rel="next"` URL out of a GitHub `Link` response header so we
// can walk the issues pagination chain. Returns null when there's no next
// page (i.e. we've reached the last page).
function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

// Reduce a raw GitHub issue object to the compact, agent-friendly shape the
// list_github_issues tool returns. Labels collapse to bare names; bodies are
// truncated so a few verbose issues can't blow up the model's context.
function normalizeIssue(raw) {
  let body = typeof raw.body === 'string' ? raw.body : '';
  if (body.length > ISSUE_BODY_MAX) body = `${body.slice(0, ISSUE_BODY_MAX)}…`;
  const labels = Array.isArray(raw.labels)
    ? raw.labels.map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean)
    : [];
  return {
    number: raw.number,
    title: raw.title || '',
    body,
    labels,
    updatedAt: raw.updated_at || null,
    htmlUrl: raw.html_url || null,
    // #133: GitHub-side creator login. For platform-filed issues this is
    // the bot (the real creator lives in the local issues table / the
    // body's "**Source:**" line); for issues opened directly on GitHub
    // it's the actual author, which the github-issues route uses as a
    // last-resort creator fallback.
    user: (raw.user && raw.user.login) || null,
  };
}

// Read-only, anonymous fetch of a PUBLIC repo's OPEN issues. Powers the
// `list_github_issues` tool on all three agent surfaces (the Mayor's
// Anthropic tool directly; scout + build via the worker's usernode-issues
// CLI → GET /api/internal/sessions/:id/issues, which calls this).
//
// NEVER throws and NEVER returns null: every failure mode resolves to a
// well-formed `{ issues, truncatedList, note }` so callers can hand the
// result straight back to the model without special-casing. Notes:
//   - 'rate limited'        anonymous 60/hr exhausted (returns stale cache
//                           contents when we have them)
//   - 'issues unavailable'  404 (private or nonexistent — treated the same
//                           since we assume public)
//   - 'fetch failed'        network error / timeout / unexpected payload
// Success returns `{ issues, truncatedList }` (no note). truncatedList is
// true when the repo has more open issues than the page ceiling allows.
async function fetchPublicIssues(owner, repo) {
  const cacheKey = `${owner}/${repo}`;
  const cached = issuesCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  let url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    + '/issues?state=open&per_page=100&sort=updated&direction=desc';
  const collected = [];
  let page = 0;
  let truncatedList = false;

  try {
    while (url && page < ISSUES_MAX_PAGES) {
      page += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ISSUES_FETCH_TIMEOUT_MS);
      let resp;
      try {
        resp = await fetch(url, {
          headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': GITHUB_USER_AGENT },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      // Rate limited: anonymous quota is per-IP and shared across all apps
      // on the host. Fall back to whatever we last cached (even if expired)
      // rather than returning an empty list that reads as "no issues".
      if ((resp.status === 403 && resp.headers.get('x-ratelimit-remaining') === '0') || resp.status === 429) {
        log.warn('github', 'Issue fetch rate-limited', { repo: cacheKey });
        const stale = issuesCache.get(cacheKey);
        if (stale) return { ...stale.result, note: 'rate limited' };
        return { issues: [], truncatedList: false, note: 'rate limited' };
      }
      if (resp.status === 404) {
        return { issues: [], truncatedList: false, note: 'issues unavailable' };
      }
      if (!resp.ok) {
        return { issues: [], truncatedList: false, note: 'fetch failed' };
      }

      const batch = await resp.json();
      if (!Array.isArray(batch)) {
        return { issues: [], truncatedList: false, note: 'fetch failed' };
      }
      for (const item of batch) {
        // The /issues endpoint returns PRs too; drop anything carrying a
        // pull_request field so only real issues reach the agent.
        if (item && item.pull_request) continue;
        if (item) collected.push(normalizeIssue(item));
      }
      url = parseNextLink(resp.headers.get('link'));
    }
    // We stopped with a next page still pending → repo has more open issues
    // than our ceiling; flag the list as partial.
    if (url) truncatedList = true;

    const result = { issues: collected, truncatedList };
    issuesCache.set(cacheKey, { result, expiresAt: Date.now() + ISSUES_CACHE_TTL_MS });
    return result;
  } catch (err) {
    log.warn('github', 'Issue fetch failed', { repo: cacheKey, err: err.message });
    return { issues: [], truncatedList: false, note: 'fetch failed' };
  }
}

// Drop the cached open-issues list for a repo so the next fetchPublicIssues
// call re-reads from GitHub. Called from the merge path (routes/votes.js
// checkAndMerge) when a PR that closed one or more issues lands, so the
// "Open Issues" panel reflects the change on the next refresh instead of
// waiting out ISSUES_CACHE_TTL_MS. Case-insensitive match on owner/repo
// because GitHub treats those as case-insensitive while the cache key
// preserves whatever casing the caller passed. No-op when the repo has no
// cache entry. Returns true if an entry was deleted.
function invalidateIssuesCache(owner, repo) {
  if (!owner || !repo) return false;
  const target = `${owner}/${repo}`.toLowerCase();
  for (const key of issuesCache.keys()) {
    if (key.toLowerCase() === target) {
      issuesCache.delete(key);
      log.debug('github', 'Invalidated open-issues cache', { repo: key });
      return true;
    }
  }
  return false;
}

// Prepend a just-created issue to a repo's cached open-issues list so the
// very next fetchPublicIssues call sees it. Called from the feedback path
// (routes/feedback.js) right after createIssue succeeds, paired with a
// pushIssueUpdate broadcast that makes clients re-pull the "Open Issues"
// panel. Seeding instead of invalidating keeps the cache warm — no extra
// anonymous GitHub list call against the 60/hr/IP budget, and no
// read-after-write lag from GitHub's list endpoint hiding the new issue.
// Match is case-insensitive and ignores a trailing `.git` on the repo
// (mirrors how repo_url parsing can capture it). Dedupes by issue number.
// No-op (returns false) when the repo has no live cache entry — the next
// fetch reads fresh from GitHub and picks the issue up there.
function noteIssueCreated(owner, repo, rawIssue) {
  if (!owner || !repo || !rawIssue || rawIssue.number == null) return false;
  const norm = (o, r) => `${o}/${r}`.toLowerCase().replace(/\.git$/, '');
  const target = norm(owner, repo);
  for (const key of issuesCache.keys()) {
    if (key.toLowerCase().replace(/\.git$/, '') !== target) continue;
    const entry = issuesCache.get(key);
    const issues = [
      normalizeIssue(rawIssue),
      ...entry.result.issues.filter((i) => i.number !== rawIssue.number),
    ];
    issuesCache.set(key, { ...entry, result: { ...entry.result, issues } });
    log.debug('github', 'Seeded open-issues cache with new issue', { repo: key, issue: rawIssue.number });
    return true;
  }
  return false;
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
  getFileContent,
  createBranch,
  createPR,
  updatePR,
  closePR,
  reopenPR,
  mergePR,
  getPR,
  getIssue,
  createIssue,
  closeIssue,
  getCloneUrl,
  safeMention,
  parseGithubUrl,
  acceptInvitationFor,
  verifyBotAccess,
  checkRepoPublic,
  fetchPublicRepoInfo,
  fetchPublicIssues,
  invalidateIssuesCache,
  noteIssueCreated,
};
