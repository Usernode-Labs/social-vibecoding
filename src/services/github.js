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

// Headers for the read-only public fetch paths (fetchPublicIssues,
// fetchPublicIssue, fetchIssueComments). When the bot PAT is configured
// these requests authenticate as the bot — 5,000 req/hr on the token —
// instead of burning the per-IP ANONYMOUS 60 req/hr budget, which is
// shared by every app on the host and was routinely exhausted in prod
// (every issue panel then degraded to "Couldn't load open issues").
// Without a PAT they stay anonymous and the cache/stale-fallback layers
// below remain the only defense.
function publicFetchHeaders() {
  const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': GITHUB_USER_AGENT };
  const pat = process.env.GITHUB_BOT_TOKEN;
  if (pat) headers['Authorization'] = `Bearer ${pat}`;
  return headers;
}

// Read-only open-issues fetch (fetchPublicIssues) tunables. The 5-minute
// cache keeps these reads off GitHub's rate budget (the bot PAT's 5,000
// req/hr when configured, the brutal 60-req/hr/IP anonymous limit when
// not — see publicFetchHeaders) — all three agent surfaces (Mayor tool,
// scout, build) resolve through one function, so they share one cache
// entry per repo. The page
// ceiling bounds worst-case work for a repo with thousands of issues.
//
// Freshness on the "Open Issues" panel doesn't rely on this TTL: when a PR
// merges through the platform (routes/votes.js checkAndMerge) the closed
// issues are known from session.linked_issues, so the merge path busts this
// entry via invalidateIssuesCache() and broadcasts a refresh; when an issue
// is created through the platform, noteIssueCreated records it in the
// recently-created overlay (and seeds any live cache entry) so it shows
// immediately (#192). The TTL — plus the panel's throttled manual refresh
// (refreshPublicIssues) — is the backstop for creates/closes that happen
// directly on GitHub.
const issuesCache = new Map();
const ISSUES_CACHE_TTL_MS = 5 * 60 * 1000;
const ISSUES_MAX_PAGES = 10;          // 10 * 100 = up to 1000 open issues
// Per-issue body cap applied ONLY at agent-facing surfaces (the Mayor's
// list_github_issues tool and the worker's usernode-issues CLI) via
// truncateIssueBodies, so a few verbose issues can't blow up the model's
// context. The cache and the web route carry FULL bodies (#158): the
// "Create PR" button seeds the dev chat with the issue text, and cutting
// it at 500 chars dropped the rest of the issue from the PR flow.
const ISSUE_BODY_MAX = 500;
const ISSUES_FETCH_TIMEOUT_MS = 8000; // per-page request timeout

// Issue-comment thread reads (fetchIssueComments). Comments are fetched
// on demand (not cached) when an agent or the topic view drills into ONE
// issue, so the page ceiling bounds worst-case work for a chatty thread:
// 3 pages * 100/page = up to 300 comments collected. clipIssueComments
// then caps what reaches a model's context / the UI at the most-recent
// ISSUE_COMMENTS_KEEP, with each body clipped at ISSUE_COMMENT_BODY_MAX
// (matching the headless seed's HEADLESS_SEED_COMMENT_MAX_CHARS).
const ISSUE_COMMENTS_MAX_PAGES = 3;
const ISSUE_COMMENTS_PER_PAGE = 100;
const ISSUE_COMMENTS_MAX = 300;       // total collected cap (max option default)
const ISSUE_COMMENTS_KEEP = 30;       // most-recent kept by clipIssueComments
const ISSUE_COMMENT_BODY_MAX = 2000;  // per-comment body clip

// #144: known-closed suppression. Cache busting alone can't keep the
// "Open Issues" panel honest after a merge: fetchPublicIssues reads
// GitHub's ANONYMOUS list endpoint, which is eventually consistent and
// CDN-cached — for a window after `Closes #N` lands, a fresh
// `state=open` list can still include the just-closed issue, and the
// post-merge refetch then re-caches it as open for the full TTL. (The
// issue-close watcher verifies closure via the authenticated
// single-issue endpoint, which IS consistent — so it can correctly see
// "closed" while this list still says "open".)
//
// So alongside the cache we keep a per-repo set of issue numbers known
// (or about to be) closed; every fetchPublicIssues result — fresh,
// cached, or stale-rate-limited — is filtered against it. Entries
// expire after a TTL so a wrong optimistic suppression (a `Closes #N`
// GitHub never honored) self-heals; the cached payload itself is kept
// unfiltered so expiry resurfaces the issue without a refetch.
// Map<normalized "owner/repo", Map<issueNumber, expiresAtMs>>.
const closedIssueSuppressions = new Map();
const ISSUES_CLOSED_SUPPRESS_TTL_MS = 10 * 60 * 1000;

// #192: recently-created overlay — the create-side mirror of #144 above.
// noteIssueCreated's cache seeding only helps when the repo has a LIVE
// cache entry; with no entry (server restart, idle panel) or an expired
// one, the very next fetch reads GitHub's eventually-consistent anonymous
// list, which can still OMIT a just-created issue — and that stale list
// then gets cached for the full TTL. (The pushIssueUpdate broadcast makes
// clients re-pull the panel immediately, so that refetch is exactly the
// request that locks the stale list in.)
//
// So alongside seeding we keep a per-repo map of just-created issues
// (full normalized shape, not just numbers); every fetchPublicIssues
// result — fresh, cached, or any fallback — gets the live overlay
// entries merged in. Entries expire after a TTL (GitHub's list lag is
// minutes at most) and are dropped early once a fresh fetch proves the
// list now serves the issue. Suppressions are applied AFTER the overlay
// so a created-then-quickly-closed issue stays hidden.
// Map<normalized "owner/repo", Map<issueNumber, { issue, expiresAt }>>.
const recentIssueCreations = new Map();
const ISSUES_CREATED_OVERLAY_TTL_MS = 10 * 60 * 1000;

// #192: manual-refresh cooldown. refreshPublicIssues bypasses the cache
// TTL at most once per repo per this window so the Open Issues panel's
// refresh button can't burn the shared anonymous 60-req/hr/IP budget.
// Map<normalized "owner/repo", lastForcedAtMs>.
const FORCE_REFRESH_COOLDOWN_MS = 60 * 1000;
const forceRefreshLastAt = new Map();

// Same normalization noteIssueCreated uses for cache-key matching:
// owner/repo are case-insensitive on GitHub and repo_url parsing can
// capture a trailing `.git`.
function normRepoKey(owner, repo) {
  return `${owner}/${repo}`.toLowerCase().replace(/\.git$/, '');
}

// Record issue numbers as closed so fetchPublicIssues stops returning
// them, regardless of what GitHub's stale list (or our cache) says.
// Called from the merge path (routes/votes.js, with the session's
// linked_issues, optimistically — GitHub reliably closes them, just
// late) and from the issue-close watcher (with observed closes).
// Returns how many numbers were recorded.
function noteIssuesClosed(owner, repo, numbers, ttlMs = ISSUES_CLOSED_SUPPRESS_TTL_MS) {
  if (!owner || !repo || !Array.isArray(numbers) || !numbers.length) return 0;
  const key = normRepoKey(owner, repo);
  let entry = closedIssueSuppressions.get(key);
  if (!entry) {
    entry = new Map();
    closedIssueSuppressions.set(key, entry);
  }
  const expiresAt = Date.now() + ttlMs;
  let recorded = 0;
  for (const raw of numbers) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) continue;
    entry.set(n, expiresAt);
    recorded++;
  }
  if (recorded) {
    log.debug('github', 'Suppressing closed issues from open-issues results', {
      repo: key, issues: [...entry.keys()],
    });
  }
  return recorded;
}

// Drop suppressions early — the issue-close watcher calls this for
// numbers that turned out to still be open after its polling gave up,
// so a `Closes #N` GitHub didn't honor doesn't hide a live issue for
// the full suppression TTL. Returns how many entries were removed.
function unsuppressIssues(owner, repo, numbers) {
  if (!owner || !repo || !Array.isArray(numbers) || !numbers.length) return 0;
  const entry = closedIssueSuppressions.get(normRepoKey(owner, repo));
  if (!entry) return 0;
  let removed = 0;
  for (const raw of numbers) {
    if (entry.delete(Number(raw))) removed++;
  }
  if (!entry.size) closedIssueSuppressions.delete(normRepoKey(owner, repo));
  return removed;
}

// Live (non-expired) suppressed numbers for a repo, pruning expired
// entries as a side effect. Returns null when nothing is suppressed.
function liveSuppressions(owner, repo) {
  const key = normRepoKey(owner, repo);
  const entry = closedIssueSuppressions.get(key);
  if (!entry) return null;
  const now = Date.now();
  for (const [n, expiresAt] of entry) {
    if (expiresAt <= now) entry.delete(n);
  }
  if (!entry.size) {
    closedIssueSuppressions.delete(key);
    return null;
  }
  return entry;
}

// Filter a fetchPublicIssues-shaped result against the repo's live
// suppressions. Never mutates the input (cached payloads stay
// unfiltered so TTL expiry resurfaces issues without a refetch).
function applyClosedSuppressions(owner, repo, result) {
  const live = liveSuppressions(owner, repo);
  if (!live || !result || !Array.isArray(result.issues)) return result;
  const issues = result.issues.filter((i) => !live.has(i.number));
  return issues.length === result.issues.length ? result : { ...result, issues };
}

// Live (non-expired) created-overlay entries for a repo, pruning expired
// ones as a side effect. Returns null when nothing is overlaid. Mirrors
// liveSuppressions above.
function liveCreatedOverlay(owner, repo) {
  const key = normRepoKey(owner, repo);
  const entry = recentIssueCreations.get(key);
  if (!entry) return null;
  const now = Date.now();
  for (const [n, { expiresAt }] of entry) {
    if (expiresAt <= now) entry.delete(n);
  }
  if (!entry.size) {
    recentIssueCreations.delete(key);
    return null;
  }
  return entry;
}

// Merge a repo's live created-overlay issues into a fetchPublicIssues-
// shaped result: overlay issues not already present are PREPENDED
// (descending number among themselves, so newest first — consistent with
// the list's sort=updated&direction=desc order). When the list already
// carries the number, the fetched/cached copy wins (it's fresher). Never
// mutates the input; truncatedList/note are left untouched.
function applyCreatedOverlay(owner, repo, result) {
  const live = liveCreatedOverlay(owner, repo);
  if (!live || !result || !Array.isArray(result.issues)) return result;
  const present = new Set(result.issues.map((i) => i.number));
  const missing = [...live.entries()]
    .filter(([n]) => !present.has(n))
    .sort(([a], [b]) => b - a)
    .map(([, v]) => v.issue);
  return missing.length ? { ...result, issues: [...missing, ...result.issues] } : result;
}

// The full freshness pipeline applied to every result fetchPublicIssues
// hands out: merge just-created issues in, then filter known-closed ones
// out. Suppressions go LAST so a created-then-quickly-closed issue stays
// hidden.
function applyIssueOverlays(owner, repo, result) {
  return applyClosedSuppressions(owner, repo, applyCreatedOverlay(owner, repo, result));
}

// Drop created-overlay entries that a successful FRESH fetch proved
// GitHub's list now serves — the overlay is redundant from then on
// (mirrors the spirit of unsuppressIssues on the close side).
function confirmCreatedIssues(owner, repo, issues) {
  const key = normRepoKey(owner, repo);
  const entry = recentIssueCreations.get(key);
  if (!entry) return;
  for (const issue of issues) entry.delete(issue.number);
  if (!entry.size) recentIssueCreations.delete(key);
}

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

// Test seam (null in every real deploy): when set via
// _setOctokitFactoryForTests, getOctokit returns this factory's client
// instead of building a real one. Lets the mergePR sha-forwarding / 409
// mapping be unit-tested without a live GitHub client or credentials.
let _octokitFactoryForTests = null;
function _setOctokitFactoryForTests(factory) { _octokitFactoryForTests = factory; }

async function getOctokit(owner) {
  if (_octokitFactoryForTests) return _octokitFactoryForTests(owner);
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

// `fromBranch` (default 'main') lets callers fork off an arbitrary existing
// branch — used by the headless-session clone flow (#155), which branches a
// user's new dev branch off the auto session's branch so any pushed commits
// carry over.
async function createBranch(owner, repo, branchName, fromBranch = 'main') {
  const octokit = await getOctokit(owner);
  const { data: ref } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${fromBranch}` });

  await octokit.rest.git.createRef({
    owner, repo,
    ref: `refs/heads/${branchName}`,
    sha: ref.object.sha,
  });

  log.info('github', 'Branch created', { repo: `${owner}/${repo}`, branch: branchName, from: fromBranch });
}

async function createPR(owner, repo, { branch, title, body }) {
  const octokit = await getOctokit(owner);
  let data;
  try {
    ({ data } = await octokit.rest.pulls.create({
      owner, repo,
      title: safeMention(title),
      body: safeMention(body),
      head: branch,
      base: 'main',
    }));
  } catch (err) {
    // GitHub answers 422 "No commits between main and <branch>" when the
    // head branch has nothing to merge (typically: committed locally but
    // never pushed). Surface this as a typed, non-transient error so
    // callers can tell the user the truth instead of "try again in a
    // moment" — retrying a permanently-empty branch never succeeds.
    const detail = err && (err.message || '') +
      ' ' + JSON.stringify(err?.response?.data?.errors || err?.response?.data || '');
    if (err && err.status === 422 && /No commits between/i.test(detail)) {
      const e = new Error(`No commits between main and ${branch} — the branch has no pushed commits.`);
      e.code = 'no_commits';
      throw e;
    }
    // GitHub answers 422 "A pull request already exists for <owner>:<branch>"
    // when the PR was created but the caller never learned about it — the
    // restart race: the old process created the PR and died before writing
    // pr_number to the DB (session 2262, 2026-07-14). Type it so callers can
    // look the existing PR up and adopt it instead of failing forever.
    if (err && err.status === 422 && /pull request already exists/i.test(detail)) {
      const e = new Error(`A pull request already exists for ${owner}:${branch}.`);
      e.code = 'pr_exists';
      throw e;
    }
    throw err;
  }
  log.info('github', 'PR created', { repo: `${owner}/${repo}`, pr: data.number });
  return data;
}

// Look up the open PR whose head is `branch` (same-repo branches — the
// only shape this platform creates). Returns the PR data or null. Used by
// applyPrMetadata to adopt a PR that exists on GitHub but was never
// persisted to the session row (createPR 422 'pr_exists').
async function findOpenPrByBranch(owner, repo, branch) {
  const octokit = await getOctokit(owner);
  const { data } = await octokit.rest.pulls.list({
    owner, repo, head: `${owner}:${branch}`, state: 'open', per_page: 1,
  });
  return (data && data[0]) || null;
}

// #687 (PR-import): list the repo's currently-open pull requests, newest
// first. Used by the import picker to show candidates the user can pull in
// as proposals. Returns the raw Octokit PR objects (number, title, user,
// head, base, html_url, …); callers shape what they need. Same-repo scope —
// fork heads are out of scope for the import flow (see spec Deferred work).
async function listOpenPulls(owner, repo, { perPage = 50 } = {}) {
  const octokit = await getOctokit(owner);
  const { data } = await octokit.rest.pulls.list({
    owner, repo, state: 'open', sort: 'created', direction: 'desc',
    per_page: perPage,
  });
  return data || [];
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

// #687 Slice 4: distinct "head moved" outcome. When a `sha` is passed to
// mergePR (imported PRs pin the exact reviewed commit) GitHub returns 409
// if the PR head has moved since — someone pushed between the vote and the
// merge. checkAndMerge treats this NOT as a proposal error but as "wait for
// the sync poller to pick up the new head (reset votes/checks) and retry on
// the next qualifying vote". `err.headMoved === true` is the sentinel.
class HeadMovedError extends Error {
  constructor(message) {
    super(message || 'PR head moved since the reviewed commit');
    this.name = 'HeadMovedError';
    this.headMoved = true;
  }
}

// Merge a PR (squash). `sha`, when provided, is forwarded to GitHub's merge
// API as the expected head commit: GitHub refuses (409) if the current head
// differs, guaranteeing we merge EXACTLY the reviewed commit and never
// something newer that pushed in after the vote. Native callers pass no
// `sha` and keep the prior unconditional-squash behaviour byte-for-byte.
// A 409 raised specifically by the sha mismatch is re-thrown as a
// HeadMovedError so the caller can distinguish it from other merge failures.
async function mergePR(owner, repo, prNumber, sha = null) {
  const octokit = await getOctokit(owner);
  const params = {
    owner, repo,
    pull_number: prNumber,
    merge_method: 'squash',
  };
  if (sha) params.sha = sha;
  try {
    const { data } = await octokit.rest.pulls.merge(params);
    log.info('github', 'PR merged', { repo: `${owner}/${repo}`, pr: prNumber, pinnedSha: sha || null });
    return data;
  } catch (err) {
    // GitHub returns 409 both for "head changed" (our sha no longer matches)
    // and for "not mergeable" (base moved / conflicts). When we pinned a sha
    // and hit a 409, surface it as the head-moved sentinel so imported merges
    // defer to the sync poller instead of erroring the proposal.
    if (sha && err && err.status === 409) {
      log.info('github', 'PR merge refused — head moved since reviewed commit', {
        repo: `${owner}/${repo}`, pr: prNumber, pinnedSha: sha,
      });
      throw new HeadMovedError(err.message);
    }
    throw err;
  }
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

// List the file paths changed between two refs ("main...branch-name").
// Used by the visuals capture heuristic (src/services/visuals.js) to decide
// whether a commit range plausibly touches the UI. Uses the compare API
// (not pulls.listFiles) so it works on the headless path, where no PR
// exists yet. The compare endpoint returns at most 300 files per page —
// plenty for a "does anything frontend-ish appear?" check.
async function listChangedFiles(owner, repo, basehead) {
  const octokit = await getOctokit(owner);
  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner, repo, basehead, per_page: 100,
  });
  return (data.files || []).map((f) => f.filename);
}

// #297: a size-capped unified diff for the proposal-advisor context.
// Concatenates the per-file `patch` hunks from the compare endpoint
// (`main...<branch>`) into one unified-diff string, truncated to a hard
// char budget so a huge PR can't blow the advisor's prompt budget.
// Mirrors listChangedFiles' use of compareCommitsWithBasehead (so it
// works on any ref pair, PR or not). Binary / overly-large files have no
// `patch` field — those get a one-line "+N/-M" summary instead. Throws on
// transport errors; the proposal-discuss route fails open (metadata +
// spec only) rather than letting a GitHub hiccup break the conversation.
const PROPOSAL_DIFF_CHAR_BUDGET = 12000;

async function getProposalDiff(owner, repo, basehead, charBudget = PROPOSAL_DIFF_CHAR_BUDGET) {
  const octokit = await getOctokit(owner);
  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner, repo, basehead, per_page: 100,
  });
  const files = data.files || [];
  let out = '';
  let truncated = false;
  for (const f of files) {
    const header = `diff --git a/${f.filename} b/${f.filename}\n`;
    const patch = f.patch
      ? `${f.patch}\n`
      : `(no textual diff — ${f.status}, +${f.additions || 0}/-${f.deletions || 0})\n`;
    const block = header + patch;
    if (out.length + block.length > charBudget) {
      const remaining = charBudget - out.length;
      // Only spill a partial block if a meaningful chunk still fits.
      if (remaining > header.length + 40) out += block.slice(0, remaining);
      truncated = true;
      break;
    }
    out += block;
  }
  if (truncated) {
    out += `\n…diff truncated at ~${charBudget} chars (${files.length} files changed in total)…\n`;
  }
  return { diff: out, fileCount: files.length, truncated };
}

// Close an issue. Goes through getOctokit (PAT-preferred) so we get a
// real @octokit/rest instance with `.rest.issues.update`. Used by the
// rename-issue → rename-PR migration to retire the legacy issue once its
// PR is open (mirrors how maybeApplyRenameProposal closes the issue when
// a rename vote lands).
// Retitle an existing issue. Used by the title-heal sweeper
// (services/title-heal.js) when a feedback issue was filed with the
// LLM-unavailable fallback title and a real title has now been generated.
// safeMention keeps model-written text from pinging arbitrary accounts.
async function updateIssueTitle(owner, repo, issueNumber, title) {
  const octokit = await getOctokit(owner);
  const { data } = await octokit.rest.issues.update({
    owner, repo, issue_number: issueNumber, title: safeMention(title),
  });
  log.info('github', 'Issue retitled', { repo: `${owner}/${repo}`, issue: issueNumber });
  return data;
}

// PATCH a title onto a GitHub issue, PAT-first. Platform-repo issues were
// filed with the PAT (routes/feedback.js), app-repo issues via the GitHub
// App installation — try the PAT first (covers both on the canonical
// deploy, where the bot user owns app repos too), then fall back to the
// installation octokit. Shared by the title-heal sweeper and the
// author-rename route (routes/issues.js, #556).
async function patchIssueTitle(owner, repo, issueNumber, title) {
  const pat = process.env.GITHUB_BOT_TOKEN;
  if (pat) {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `token ${pat}`,
        'User-Agent': 'usernode-social-vibecoding',
      },
      body: JSON.stringify({ title: safeMention(title) }),
    });
    if (res.ok) return;
    log.warn('github', 'PAT issue PATCH failed; trying installation token', {
      repo: `${owner}/${repo}`, issueNumber, status: res.status,
    });
  }
  await updateIssueTitle(owner, repo, issueNumber, title);
}

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

// Post a comment on an issue. Used by the headless auto-solve path (#150)
// to surface the Mayor's clarifying questions to the issue reporter
// without them entering the platform. Body passes through safeMention so
// model-written text can never ping arbitrary GitHub accounts.
async function createIssueComment(owner, repo, issueNumber, body) {
  const octokit = await getOctokit(owner);
  const { data } = await octokit.rest.issues.createComment({
    owner, repo, issue_number: issueNumber, body: safeMention(body),
  });
  log.info('github', 'Issue comment posted', { repo: `${owner}/${repo}`, issue: issueNumber });
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

// Reduce a raw GitHub issue object to the compact shape fetchPublicIssues
// returns. Labels collapse to bare names. Bodies are kept FULL here (#158) —
// the web route needs the complete text so "Create PR" can seed the dev chat
// with the whole issue; agent surfaces clip via truncateIssueBodies instead.
function normalizeIssue(raw) {
  const body = typeof raw.body === 'string' ? raw.body : '';
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

// Clip issue bodies for agent-facing surfaces (the Mayor's
// list_github_issues tool and the worker's usernode-issues CLI) so a few
// verbose issues can't blow up the model's context. Takes a
// fetchPublicIssues-shaped result and returns a copy with each body capped
// at ISSUE_BODY_MAX; never mutates the input (the result may be the shared
// cache entry). The web route deliberately skips this (#158).
//
// Clipped bodies end with an EXPLICIT marker naming how to get the full
// text, so the agent knows the cut happened and what to do about it.
// `fullTextHint(issueNumber)` supplies the surface-specific command
// (Mayor: `get_github_issue(N)`; worker CLI: `usernode-issues N`).
function truncateIssueBodies(result, fullTextHint) {
  if (!result || !Array.isArray(result.issues)) return result;
  const hint = typeof fullTextHint === 'function'
    ? fullTextHint
    : (n) => `get_github_issue(${n})`;
  return {
    ...result,
    issues: result.issues.map((issue) => {
      const body = typeof issue.body === 'string' ? issue.body : '';
      if (body.length <= ISSUE_BODY_MAX) return issue;
      return {
        ...issue,
        body: `${body.slice(0, ISSUE_BODY_MAX)}… [truncated — use ${hint(issue.number)} for full text]`,
      };
    }),
  };
}

// Read-only fetch of a PUBLIC repo's OPEN issues (bot-PAT-authenticated
// when configured, anonymous otherwise — publicFetchHeaders). Powers the
// `list_github_issues` tool on all three agent surfaces (the Mayor's
// Anthropic tool directly; scout + build via the worker's usernode-issues
// CLI → GET /api/internal/sessions/:id/issues, which calls this).
//
// NEVER throws and NEVER returns null: every failure mode resolves to a
// well-formed `{ issues, truncatedList, note }` so callers can hand the
// result straight back to the model without special-casing. Notes:
//   - 'rate limited'        rate budget exhausted (returns stale cache
//                           contents when we have them)
//   - 'issues unavailable'  404 (private or nonexistent — treated the same
//                           since we assume public)
//   - 'fetch failed'        network error / timeout / unexpected payload
// Success returns `{ issues, truncatedList }` (no note). truncatedList is
// true when the repo has more open issues than the page ceiling allows.
//
// Every exit path runs through applyIssueOverlays (#192/#144): the
// recently-created overlay is merged in and known-closed suppressions
// filtered out, so a platform-created issue renders even when the cache,
// GitHub's lagging anonymous list, or a rate-limit/fetch failure would
// otherwise hide it.
//
// `force: true` (internal — used by refreshPublicIssues only) skips the
// still-valid-cache early return and refetches; everything else (rate-
// limited stale fallback, caching the result, overlays) is unchanged.
async function fetchPublicIssues(owner, repo, { force = false } = {}) {
  const cacheKey = `${owner}/${repo}`;
  const cached = issuesCache.get(cacheKey);
  if (!force && cached && cached.expiresAt > Date.now()) {
    return applyIssueOverlays(owner, repo, cached.result);
  }

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
          headers: publicFetchHeaders(),
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
        if (stale) {
          return { ...applyIssueOverlays(owner, repo, stale.result), note: 'rate limited' };
        }
        return { ...applyIssueOverlays(owner, repo, { issues: [], truncatedList: false }), note: 'rate limited' };
      }
      if (resp.status === 404) {
        return { ...applyIssueOverlays(owner, repo, { issues: [], truncatedList: false }), note: 'issues unavailable' };
      }
      if (!resp.ok) {
        return { ...applyIssueOverlays(owner, repo, { issues: [], truncatedList: false }), note: 'fetch failed' };
      }

      const batch = await resp.json();
      if (!Array.isArray(batch)) {
        return { ...applyIssueOverlays(owner, repo, { issues: [], truncatedList: false }), note: 'fetch failed' };
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
    // A successful fresh fetch is proof GitHub's list now serves any
    // overlaid issue it contains — drop those overlay entries early.
    confirmCreatedIssues(owner, repo, collected);
    // Overlay/filter the RETURNED copy, not the cached one: a freshly-
    // fetched list can itself be stale (GitHub's anonymous list endpoint
    // lags both creates and closes), and caching it unmodified means TTL
    // expiry alone is what reconciles a wrong overlay or suppression.
    return applyIssueOverlays(owner, repo, result);
  } catch (err) {
    log.warn('github', 'Issue fetch failed', { repo: cacheKey, err: err.message });
    return { ...applyIssueOverlays(owner, repo, { issues: [], truncatedList: false }), note: 'fetch failed' };
  }
}

// Force-refresh a repo's open-issues list past the cache TTL, throttled
// per repo (#192) — backs the Open Issues panel's manual refresh button,
// covering issues created directly on GitHub (where the platform gets no
// create signal). Within the cooldown it serves the normal (cached) flow
// with `refreshed: false`; otherwise it stamps the cooldown FIRST (so a
// failing repo can't be hammered) and refetches. Deliberately not
// invalidateIssuesCache()+fetch: deleting the entry would lose the
// stale-cache fallback the rate-limited path depends on. Same
// never-throws contract as fetchPublicIssues, plus `refreshed` and
// `retryInMs` (ms until the next force is allowed).
async function refreshPublicIssues(owner, repo) {
  const key = normRepoKey(owner, repo);
  const now = Date.now();
  const last = forceRefreshLastAt.get(key) || 0;
  if (now - last < FORCE_REFRESH_COOLDOWN_MS) {
    const result = await fetchPublicIssues(owner, repo);
    return { ...result, refreshed: false, retryInMs: FORCE_REFRESH_COOLDOWN_MS - (now - last) };
  }
  forceRefreshLastAt.set(key, now);
  const result = await fetchPublicIssues(owner, repo, { force: true });
  return { ...result, refreshed: true, retryInMs: FORCE_REFRESH_COOLDOWN_MS };
}

// Read-only fetch of ONE issue with its FULL (untruncated) body, using
// the same publicFetchHeaders auth as fetchPublicIssues. Backs the Mayor's get_github_issue tool and the worker's
// `usernode-issues <number>` CLI form — the on-demand escape hatch for
// bodies the list surfaces clip at ISSUE_BODY_MAX (#158).
//
// Cache-first: the open-issues cache already carries full bodies, so a
// hit costs no network call (and no anonymous rate-limit budget). On a
// miss we GET the single-issue endpoint, which also resolves CLOSED
// issues — useful when an agent follows up on a just-merged fix.
//
// NEVER throws and NEVER returns null: every outcome resolves to a
// well-formed `{ issue, note? }` — `issue` is the normalized full-body
// shape or null, with `note` naming why ('bad issue number',
// 'not found', 'not an issue (pull request)', 'rate limited',
// 'fetch failed').
async function fetchPublicIssue(owner, repo, number) {
  const n = Number(number);
  if (!owner || !repo || !Number.isInteger(n) || n <= 0) {
    return { issue: null, note: 'bad issue number' };
  }

  const cacheKey = `${owner}/${repo}`;
  const cached = issuesCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    const hit = cached.result.issues.find((i) => i.number === n);
    if (hit) return { issue: hit };
  }

  // #192: a just-created issue may predate both the cache and GitHub's
  // lagging anonymous endpoints — the overlay carries its full body, so
  // serving from it costs no network call (and no rate-limit budget).
  const overlay = liveCreatedOverlay(owner, repo);
  const overlayHit = overlay && overlay.get(n);
  if (overlayHit) return { issue: overlayHit.issue };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ISSUES_FETCH_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${n}`,
        {
          headers: publicFetchHeaders(),
          signal: controller.signal,
        }
      );
    } finally {
      clearTimeout(timer);
    }

    if ((resp.status === 403 && resp.headers.get('x-ratelimit-remaining') === '0') || resp.status === 429) {
      // Same stale-cache fallback fetchPublicIssues uses: an expired list
      // entry still beats returning nothing.
      log.warn('github', 'Single-issue fetch rate-limited', { repo: cacheKey, issue: n });
      const stale = issuesCache.get(cacheKey);
      const hit = stale && stale.result.issues.find((i) => i.number === n);
      if (hit) return { issue: hit, note: 'rate limited' };
      return { issue: null, note: 'rate limited' };
    }
    if (resp.status === 404) {
      return { issue: null, note: 'not found' };
    }
    if (!resp.ok) {
      return { issue: null, note: 'fetch failed' };
    }

    const raw = await resp.json();
    if (!raw || raw.number == null) {
      return { issue: null, note: 'fetch failed' };
    }
    // The /issues/:n endpoint resolves PR numbers too; keep the tool's
    // contract honest — it reads issues, not pull requests.
    if (raw.pull_request) {
      return { issue: null, note: 'not an issue (pull request)' };
    }
    return { issue: normalizeIssue(raw) };
  } catch (err) {
    log.warn('github', 'Single-issue fetch failed', { repo: cacheKey, issue: n, err: err.message });
    return { issue: null, note: 'fetch failed' };
  }
}

// Fetch an issue's comment thread via the same public REST pattern as
// fetchPublicIssue (timeout, publicFetchHeaders auth, rate-limit
// handling). Backs the headless auto-solve seed (#150 — so answers the
// reporter left as comments are visible to the run) and, since #396, the
// on-demand single-issue read surfaces (the Mayor's get_github_issue tool,
// the worker's `usernode-issues <number>` CLI, and the Dev topic view).
//
// GitHub returns issue comments OLDEST-FIRST and paginates via the Link
// header. We follow it like fetchPublicIssues does — up to
// ISSUE_COMMENTS_MAX_PAGES pages of ISSUE_COMMENTS_PER_PAGE — collecting
// the WHOLE thread (in order) up to `max`. `truncated` is true when more
// pages remained at the ceiling or `max` was hit, so a caller can keep the
// MOST RECENT comments (the tail) and know older ones were dropped. (The
// old single-page fetch returned the OLDEST page, so a chatty thread's
// recent answers were invisible despite the seed's "most recent" wording.)
//
// NEVER throws: every outcome resolves to
// `{ comments: [{ author, body, createdAt }], truncated, note? }` — on any
// failure the list is empty, `truncated` false, and `note` names why. No
// caching: it's an on-demand read.
async function fetchIssueComments(owner, repo, number, { max = ISSUE_COMMENTS_MAX } = {}) {
  const n = Number(number);
  if (!owner || !repo || !Number.isInteger(n) || n <= 0) {
    return { comments: [], truncated: false, note: 'bad issue number' };
  }

  let url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    + `/issues/${n}/comments?per_page=${ISSUE_COMMENTS_PER_PAGE}`;
  const collected = [];
  let page = 0;

  try {
    while (url && page < ISSUE_COMMENTS_MAX_PAGES) {
      page += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ISSUES_FETCH_TIMEOUT_MS);
      let resp;
      try {
        resp = await fetch(url, {
          headers: publicFetchHeaders(),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if ((resp.status === 403 && resp.headers.get('x-ratelimit-remaining') === '0') || resp.status === 429) {
        log.warn('github', 'Issue-comments fetch rate-limited', { repo: `${owner}/${repo}`, issue: n });
        return { comments: [], truncated: false, note: 'rate limited' };
      }
      if (resp.status === 404) {
        return { comments: [], truncated: false, note: 'not found' };
      }
      if (!resp.ok) {
        return { comments: [], truncated: false, note: 'fetch failed' };
      }

      const raw = await resp.json();
      if (!Array.isArray(raw)) {
        return { comments: [], truncated: false, note: 'fetch failed' };
      }
      for (const c of raw) {
        collected.push({
          author: (c && c.user && c.user.login) || '',
          body: (c && c.body) || '',
          createdAt: (c && c.created_at) || '',
        });
      }
      // Hit the total cap mid-thread: stop and flag the rest as omitted.
      if (collected.length >= max) {
        return { comments: collected.slice(0, max), truncated: true };
      }
      url = parseNextLink(resp.headers.get('link'));
    }
    // A next page still pending → the thread is longer than our ceiling.
    return { comments: collected, truncated: !!url };
  } catch (err) {
    log.warn('github', 'Issue-comments fetch failed', { repo: `${owner}/${repo}`, issue: n, err: err.message });
    return { comments: [], truncated: false, note: 'fetch failed' };
  }
}

// Clip a comment thread for agent-facing surfaces and the topic view so a
// chatty issue can't blow up a model's context (or the UI). Mirrors
// truncateIssueBodies: keeps the MOST-RECENT `max` comments (GitHub orders
// oldest-first, so we keep the tail), clips each body at `bodyMax` with an
// explicit "… [truncated]" marker, and reports whether anything was
// dropped. `wasTruncated` carries through an upstream truncation (a thread
// longer than fetchIssueComments' page ceiling) so the combined flag is
// honest even when the kept count is under `max`. Never mutates the input.
// Returns `{ comments, truncated }`.
function clipIssueComments(comments, { max = ISSUE_COMMENTS_KEEP, bodyMax = ISSUE_COMMENT_BODY_MAX, wasTruncated = false } = {}) {
  const list = Array.isArray(comments) ? comments : [];
  const kept = list.slice(-max);
  const droppedOlder = list.length > kept.length;
  const clipped = kept.map((c) => {
    const body = typeof c.body === 'string' ? c.body : '';
    return {
      author: c.author || '',
      body: body.length > bodyMax ? `${body.slice(0, bodyMax)}… [truncated]` : body,
      createdAt: c.createdAt || '',
    };
  });
  return { comments: clipped, truncated: !!wasTruncated || droppedOlder };
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

// Record a just-created issue so every fetchPublicIssues result includes
// it immediately. Called from both platform creation paths
// (routes/issues.js and routes/feedback.js) right after createIssue
// succeeds, paired with a pushIssueUpdate broadcast that makes clients
// re-pull the "Open Issues" panel. Two halves:
//
// 1. Overlay (#192) — ALWAYS records the normalized issue in
//    recentIssueCreations, so it survives a missing/expired cache entry
//    and the refetch race where GitHub's eventually-consistent anonymous
//    list still omits the new issue (and would otherwise be re-cached
//    without it for the full TTL).
// 2. Cache seeding (#125) — when the repo has a cache entry, the issue is
//    also prepended into it: keeps the warm path's ordering and means the
//    cached payload itself is already correct.
//
// Match is case-insensitive and ignores a trailing `.git` on the repo
// (mirrors how repo_url parsing can capture it). Dedupes by issue number.
// Returns true whenever the issue was recorded (i.e. for any valid
// input, cache entry or not); false only on malformed input.
function noteIssueCreated(owner, repo, rawIssue, ttlMs = ISSUES_CREATED_OVERLAY_TTL_MS) {
  if (!owner || !repo || !rawIssue || rawIssue.number == null) return false;
  const normalized = normalizeIssue(rawIssue);
  const target = normRepoKey(owner, repo);

  let overlay = recentIssueCreations.get(target);
  if (!overlay) {
    overlay = new Map();
    recentIssueCreations.set(target, overlay);
  }
  overlay.set(normalized.number, { issue: normalized, expiresAt: Date.now() + ttlMs });
  log.debug('github', 'Recorded just-created issue in overlay', { repo: target, issue: normalized.number });

  for (const key of issuesCache.keys()) {
    if (key.toLowerCase().replace(/\.git$/, '') !== target) continue;
    const entry = issuesCache.get(key);
    const issues = [
      normalized,
      ...entry.result.issues.filter((i) => i.number !== normalized.number),
    ];
    issuesCache.set(key, { ...entry, result: { ...entry.result, issues } });
    log.debug('github', 'Seeded open-issues cache with new issue', { repo: key, issue: normalized.number });
    break;
  }
  return true;
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
  findOpenPrByBranch,
  listOpenPulls,
  updatePR,
  closePR,
  reopenPR,
  mergePR,
  HeadMovedError,
  _setOctokitFactoryForTests,
  getPR,
  listChangedFiles,
  getProposalDiff,
  getIssue,
  createIssue,
  createIssueComment,
  updateIssueTitle,
  patchIssueTitle,
  closeIssue,
  getCloneUrl,
  safeMention,
  parseGithubUrl,
  acceptInvitationFor,
  verifyBotAccess,
  checkRepoPublic,
  fetchPublicRepoInfo,
  fetchPublicIssues,
  fetchPublicIssue,
  fetchIssueComments,
  clipIssueComments,
  refreshPublicIssues,
  truncateIssueBodies,
  invalidateIssuesCache,
  noteIssueCreated,
  noteIssuesClosed,
  unsuppressIssues,
};
