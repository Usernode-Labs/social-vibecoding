const log = require('./logger');
const budget = require('./github-budget');
const pause = require('./github-pause');
const roles = require('./process-role');
let app;

// Neutralize `@handle` mentions in outgoing content so Homeroom never
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

// Headers for the read-only public GitHub reads that remain (exported as
// `publicApiHeaders` for the connector's fork inspection in
// services/external-agent-tasks). Anonymous: they used to authenticate as
// the bot, whose token is never sent again (see "Who Homeroom is on GitHub"
// below). Requests no longer use them: they are Homeroom's own rows
// (services/requests.js).
function publicFetchHeaders() {
  return { 'Accept': 'application/vnd.github+json', 'User-Agent': GITHUB_USER_AGENT };
}

// The budget a publicFetchHeaders() read spends: the anonymous per-IP one.
function publicFetchCredential() {
  return 'anonymous';
}

// Record one response's rate-limit headers (services/github-budget.js), and
// count the request against the caller that asked for it (`request`:
// { method, url, caller, status }). Bookkeeping only: it never throws into
// the request it describes, and a stub without headers records nothing.
function recordHeaders(credential, headers, request = null) {
  try {
    if (!headers) return;
    budget.record(credential, headers);
    if (request) budget.noteRequest(credential, { ...request, headers });
  } catch (_) { /* bookkeeping only */ }
}

// For the raw fetch paths. `method` and `url` are what was sent; the caller
// is read off the stack here, which still holds the awaiting callers.
function recordFetchResponse(credential, resp, { method = 'GET', url = null } = {}) {
  let caller = 'unknown';
  try { caller = budget.callerFromStack(); } catch (_) { /* bookkeeping only */ }
  recordHeaders(credential, resp && resp.headers, {
    method,
    url: url || (resp && resp.url) || '',
    caller,
    status: resp && resp.status,
  });
}

// Every raw fetch to GitHub's API goes through here: refused before it is
// sent while GitHub is paused, and a refusal saying the bot token is dead
// pauses this process (services/github-pause.js). `credential` is the one
// the request authenticates as ('pat', 'installation:<owner>', 'anonymous').
async function githubFetch(credential, url, init) {
  if (!['GET', 'HEAD'].includes(String(init?.method || 'GET').toUpperCase())) {
    require('./code-host-write').requireCodeHostWrite('github.fetch');
  }
  pause.assertNotPaused({ url: String(url).replace(/\?.*$/, '') });
  const resp = await fetch(url, init);
  await pause.noteResponse(credential, resp);
  return resp;
}

// Record every response an Octokit client gets, success or error, against
// the credential it authenticates as, and count it against the code that
// asked (read off the stack before the request is sent, while the asking
// frames are still on it). A client without Octokit's hook API (a test
// double) is returned untouched.
function instrument(octokit, credential, { readOnly = false } = {}) {
  if (!octokit || !octokit.hook || typeof octokit.hook.wrap !== 'function') return octokit;
  octokit.hook.wrap('request', async (request, options) => {
    if (!['GET', 'HEAD'].includes(String(options?.method || 'GET').toUpperCase())) {
      if (readOnly) throw Object.assign(new Error('GitHub read client refuses writes'), { code: 'github_read_only' });
      require('./code-host-write').requireCodeHostWrite('github.request');
    }
    let caller = 'unknown';
    try { caller = budget.callerFromStack(); } catch (_) { /* bookkeeping only */ }
    const sent = { method: options && options.method, url: options && options.url, caller };
    // Paused (services/github-pause.js): refused here, before it is sent.
    pause.assertNotPaused({ caller });
    try {
      const response = await request(options);
      recordHeaders(credential, response && response.headers, { ...sent, status: response && response.status });
      return response;
    } catch (err) {
      recordHeaders(credential, err && err.response && err.response.headers, { ...sent, status: err && err.status });
      pause.noteError(credential, err);
      throw err;
    }
  });
  return octokit;
}

// What the board's agent surfaces clip (truncateIssueBodies, #158) and
// keep of a request's comments (clipIssueComments).
const ISSUE_BODY_MAX = 500;
const ISSUE_COMMENTS_MAX = 300;       // total read (fetchIssueComments' max)
const ISSUE_COMMENTS_KEEP = 30;       // most-recent kept by clipIssueComments
const ISSUE_COMMENT_BODY_MAX = 2000;  // per-comment body clip

// owner/repo are case-insensitive on GitHub and repo_url parsing can
// capture a trailing `.git`.
function normRepoKey(owner, repo) {
  return `${owner}/${repo}`.toLowerCase().replace(/\.git$/, '');
}

// ─────────────────────────────────────────────────────────────────────
// Actions secrets METADATA for a repo — names, created/updated only.
//
// GitHub's API cannot return a secret's VALUE to anyone, with any
// credential: `GET /repos/{owner}/{repo}/actions/secrets` yields
// { name, created_at, updated_at } and that is the whole surface. So this
// is a presence-and-freshness read by construction — there is nothing
// here that could leak a value even by accident, which is what makes it
// safe to render in the Platform variables panel.
//
// PERMISSIONS. Reading Actions secrets is an admin-level capability on
// the repo: the App installation can do it only if the App carries the
// `secrets: read` repository permission (an operator must add and approve
// it). That is not guaranteed for a given deployment, so every failure
// FAILS OPEN with a reason the panel can print — same philosophy as
// services/platform-env-check.js. A GitHub hiccup must never break a
// panel whose real job is elsewhere.
const actionsSecretsCache = new Map();
const ACTIONS_SECRETS_CACHE_TTL_MS = 5 * 60 * 1000;
// Negative results are cached too, but briefly: a token that can't read
// the list shouldn't be re-probed on every panel open, and an operator
// who has just granted access shouldn't wait out the full TTL.
const ACTIONS_SECRETS_NEG_TTL_MS = 60 * 1000;
const ACTIONS_SECRETS_MAX = 300;      // 3 pages of 100 — a hard stall guard
const ACTIONS_SECRETS_TIMEOUT_MS = 4000;

const ACTIONS_SECRETS_FORBIDDEN_MESSAGE =
  "The platform can't read this repo's Actions secrets: its GitHub App needs the "
  + '`secrets: read` repository permission.';

function actionsSecretsFailure(code, message) {
  return { ok: false, code, message };
}

// One page-walking pass with a given client. Throws on any HTTP error so
// the caller can decide whether to try the other client.
async function fetchActionsSecretsWith(octokit, owner, repo) {
  const out = [];
  for (let page = 1; page <= Math.ceil(ACTIONS_SECRETS_MAX / 100); page++) {
    // Raw request() rather than the named plugin method, matching the
    // style used for the installation-token call above: no dependence on
    // @octokit/plugin-rest-endpoint-methods' surface.
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/secrets', {
      owner, repo, per_page: 100, page,
    });
    const batch = Array.isArray(data?.secrets) ? data.secrets : [];
    for (const s of batch) {
      if (!s || typeof s.name !== 'string') continue;
      out.push({
        name: s.name,
        createdAt: s.created_at || null,
        updatedAt: s.updated_at || s.created_at || null,
      });
      if (out.length >= ACTIONS_SECRETS_MAX) return out;
    }
    const total = Number(data?.total_count);
    if (!batch.length || (Number.isFinite(total) && out.length >= total)) break;
  }
  return out;
}

/**
 * List a repo's Actions secrets (metadata only).
 *
 * Returns { ok: true, secrets: [{ name, createdAt, updatedAt }], source }
 * or { ok: false, code, message } with `code` one of `disabled`,
 * `no_token`, `forbidden`, `not_found`, `github_error`. Never throws.
 *
 * Read through the App installation (getOctokit), the one credential
 * Homeroom has on GitHub.
 */
async function listActionsSecrets(owner, repo) {
  if (!roles.runsWorkflow(roles.processRole())) {
    if (pause.isPaused()) return actionsSecretsFailure('github_error', "Couldn't reach GitHub to list this repo's Actions secrets.");
    return require('./github-read-access').actionsSecrets(owner, repo);
  }
  if (!owner || !repo) return actionsSecretsFailure('not_found', 'No repository to read secrets from.');

  const cacheKey = normRepoKey(owner, repo);
  const cached = actionsSecretsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const remember = (result) => {
    actionsSecretsCache.set(cacheKey, {
      result,
      expiresAt: Date.now() + (result.ok ? ACTIONS_SECRETS_CACHE_TTL_MS : ACTIONS_SECRETS_NEG_TTL_MS),
    });
    return result;
  };

  const attempt = async () => {
    if (!app && !_octokitFactoryForTests) {
      return actionsSecretsFailure('no_token',
        'GitHub is not configured on this platform, so its Actions secrets can\'t be listed.');
    }
    try {
      const octokit = await getOctokit(owner);
      const secrets = await fetchActionsSecretsWith(octokit, owner, repo);
      secrets.sort((a, b) => a.name.localeCompare(b.name));
      return { ok: true, secrets, source: 'installation' };
    } catch (err) {
      log.warn('github', 'Actions-secrets listing failed (failing open)', {
        repo: `${owner}/${repo}`, errors: [{ source: 'installation', status: err?.status, message: err?.message }],
      });
      if (err?.status === 403 || err?.status === 401) {
        return actionsSecretsFailure('forbidden', ACTIONS_SECRETS_FORBIDDEN_MESSAGE);
      }
      if (err?.status === 404) {
        // GitHub also uses 404 when the caller cannot see this metadata.
        return actionsSecretsFailure('not_found', ACTIONS_SECRETS_FORBIDDEN_MESSAGE);
      }
      return actionsSecretsFailure('github_error',
        "Couldn't reach GitHub to list this repo's Actions secrets.");
    }
  };

  // Hard timeout: the panel must never hang waiting on GitHub.
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve(actionsSecretsFailure('github_error',
        "Couldn't reach GitHub to list this repo's Actions secrets (timed out).")),
      ACTIONS_SECRETS_TIMEOUT_MS
    );
    timer.unref?.();
  });
  try {
    return remember(await Promise.race([attempt(), timeout]));
  } catch (err) {
    log.warn('github', 'Actions-secrets listing threw (failing open)', { err: err.message });
    return remember(actionsSecretsFailure('github_error',
      "Couldn't reach GitHub to list this repo's Actions secrets."));
  } finally {
    clearTimeout(timer);
  }
}

/** Test/ops hook: drop the Actions-secrets cache for one repo (or all). */
function invalidateActionsSecretsCache(owner, repo) {
  if (owner && repo) actionsSecretsCache.delete(normRepoKey(owner, repo));
  else actionsSecretsCache.clear();
}

// ── Which host a repository is on ──────────────────────────────────────
// App repositories live on Homeroom's git host since GitHub suspended the
// account that owned them (25 Oct 2026); only the platform's own repository
// is still on GitHub. A helper given an owner on the git host answers from
// there (services/native-pulls.js, services/hosted-git.js), in the same
// shape; any other owner is GitHub, as before, behind the pause.
function onGitHost(owner) { return require('./repo-ref').hostOfOwner(owner) === 'git_host'; }
function nativePulls() { return require('./native-pulls'); }
function hostedGit() { return require('./hosted-git'); }

async function init(config, pool = null) {
  app = null;
  await require('./github-read-access').init(config, pool);
  if (!roles.runsWorkflow(roles.processRole())) {
    log.info('github', 'GitHub reads use conductor-published access');
    return;
  }
  if (!config.githubAppId || !config.githubPrivateKey) {
    log.warn('github', 'GitHub App credentials not configured — GitHub features disabled');
    return;
  }

  const { App } = await import('@octokit/app');

  app = new App({
    appId: config.githubAppId,
    privateKey: config.githubPrivateKey,
  });
  log.info('github', 'GitHub App initialized', { appId: config.githubAppId });

  // Find the App's installation on the platform repository's owner now, so
  // the project page knows whether code changes to it can be made
  // (canActOn) before anything else asks.
  checkActingInstallation();
}

// Whether a code host is configured, independent of this process holding
// write credentials. Web may admit conductor operations with read access only.
// A GitHub repository is still subject to canActOn and the pause gate.
function isEnabled() {
  return !!app || require('./github-read-access').configured() || require('./git-host').isConfigured();
}

// Whether this process set up the GitHub App (init): what isEnabled meant
// before the git host. A process that never calls init, the migration Job
// among them, has none.
function hasApp() {
  return !!app;
}

// Whether this process can write. Callers admitting a conductor operation
// use isEnabled instead; only workflow work needs this capability.
function hasWriteAccess() {
  return roles.runsWorkflow(roles.processRole()) && (!!app || require('./git-host').hasWriteAccess());
}

// The App itself, for the calls only it can make. With the git host
// configured and no App, isEnabled() is true and these refuse plainly.
function requireApp() {
  if (!app) throw Object.assign(new Error('The GitHub App is not configured'), { code: 'github_not_configured' });
  return app;
}

// ── Who Homeroom is on GitHub ──────────────────────────────────────────
//
// GitHub suspended usernode-bot, the account behind GITHUB_BOT_TOKEN, on
// 25 Oct 2026, and Homeroom promised GitHub never to use that account again
// (docs/plans/github-independence-handoff.md §4). Its token is never sent:
// nothing in the platform reads it, and neither dapp.json nor the Helm
// chart declares it any more, so the GitHub App below is the platform's only
// GitHub credential.
//
// What is left on GitHub is the platform's own repository
// (config.platformRepoUrl), and Homeroom acts on it as the GitHub App,
// through the App's installation on that repository's owner. Every client
// below is that installation, for reads and writes alike. Any other owner on
// GitHub is refused like a pause, before anything is sent: the bot's own
// account, where three apps wait for GitHub's export of it, and anyone
// else's.

// The platform repository's owner on GitHub, or null when the platform's
// repository is not on GitHub.
function actingOwner() {
  const repoRef = require('./repo-ref');
  const parsed = repoRef.parse(repoRef.platformRepoUrl());
  return parsed && parsed.host === 'github' ? parsed.owner : null;
}

function isActingOwner(owner) {
  const acting = actingOwner();
  return !!(acting && owner && acting.toLowerCase() === String(owner).toLowerCase());
}

// Refuses, as a pause, a GitHub call about anyone but the acting owner.
function assertActingOwner(owner) {
  pause.assertNotPaused();
  if (!isActingOwner(owner)) throw pause.pausedError('owner');
}

// The App's installation on the acting owner, as last looked up: `found`
// is null until then. Kept apart from installationCache, which forgets, so
// that canActOn does not flip while a lookup is due.
const RECHECK_INSTALLATION_MS = 5 * 60 * 1000;
let actingInstallation = { found: null, checkedAt: 0 };
let checkingInstallation = null;

function noteActingInstallation(owner, found) {
  if (!isActingOwner(owner)) return;
  if (found !== actingInstallation.found) {
    if (found) log.info('github', 'The GitHub App is installed on the platform repository\'s owner', { owner });
    else log.warn('github', 'The GitHub App is not installed on the platform repository\'s owner; code changes to it stay paused until it is', { owner });
  }
  actingInstallation = { found, checkedAt: Date.now() };
}

// Look the acting owner's installation up again, at most once at a time.
// Never throws: a failed walk keeps the last answer.
function checkActingInstallation() {
  const owner = actingOwner();
  if (!app || !owner || checkingInstallation || pause.isPaused()) return checkingInstallation;
  checkingInstallation = resolveInstallationId(owner)
    .catch((err) => {
      if (!/No GitHub App installation found/.test(String(err && err.message))) {
        log.warn('github', 'Could not look up the GitHub App\'s installation', { owner, err: err && err.message });
      }
      return null;
    })
    .finally(() => { checkingInstallation = null; });
  return checkingInstallation;
}

/**
 * Whether Homeroom can change code in `owner`'s repositories on GitHub: the
 * App is set up, `owner` is the platform repository's, and the App's
 * installation there has not been found missing. Before the first lookup
 * (init starts it) the answer is yes, so a push or a merge in a process's
 * first moments is not refused for a lookup still on its way; the call
 * itself then needs the installation. Synchronous, for the project page's
 * paused notice and the push and merge gates (services/github-pause.js
 * codeChangesPaused). While the installation is not known to exist it is
 * looked up again in the background, every few minutes at most, so
 * installing the App lifts the notice without a restart.
 *
 * Web reads the conductor's published snapshot instead of the App. There an
 * absent or stale snapshot is unknown, not a hold, matching the workflow
 * side's `found !== false`: only a fresh record saying the App is gone holds
 * the notice, so a late clock refresh never shows it while changes merge.
 */
function canActOn(owner) {
  if (!roles.runsWorkflow(roles.processRole())) {
    return isActingOwner(owner) && !require('./github-read-access').knownMissing();
  }
  if (!app || !isActingOwner(owner)) return false;
  if (actingInstallation.found !== true
      && Date.now() - actingInstallation.checkedAt >= RECHECK_INSTALLATION_MS) {
    checkActingInstallation();
  }
  return actingInstallation.found !== false;
}

// GitHub logins are case-insensitive, and an owner parsed out of a stored
// repo URL keeps whatever case the URL was written in, so the installation
// is matched without regard to case.
async function resolveInstallationId(owner, { fresh = false } = {}) {
  assertActingOwner(owner);
  requireApp();
  const key = String(owner || '').toLowerCase();
  const cached = installationCache.get(key);
  if (!fresh && cached && cached.expiresAt > Date.now()) return cached.id;

  for await (const { installation } of app.eachInstallation.iterator()) {
    if (String(installation.account?.login || '').toLowerCase() === key) {
      installationCache.set(key, { id: installation.id, expiresAt: Date.now() + CACHE_TTL_MS });
      noteActingInstallation(owner, true);
      return installation.id;
    }
  }
  noteActingInstallation(owner, false);
  installationCache.delete(key);
  throw Object.assign(new Error(`No GitHub App installation found for owner: ${owner}`), { code: 'github_installation_missing' });
}

// An installation access token for `owner`. @octokit/auth-app caches it
// until shortly before it expires (an hour), so this costs a request about
// once an hour, on the App's own credentials. A caller holds it only for the
// call it makes now.
async function getInstallationToken(owner) {
  require('./code-host-write').requireCodeHostWrite('github.installationToken');
  const installationId = await resolveInstallationId(owner);
  pause.assertNotPaused();
  const auth = await requireApp().octokit.auth({ type: 'installation', installationId });
  if (!auth || typeof auth.token !== 'string' || !auth.token) {
    throw new Error(`No GitHub App installation token for owner: ${owner}`);
  }
  return auth.token;
}

// Only the conductor looks up installations and mints access. Read tokens
// are restricted at issuance to the platform repository and these permissions.
async function readInstallationId() {
  require('./code-host-write').requireCodeHostWrite('github.readInstallation');
  try { return await resolveInstallationId(actingOwner(), { fresh: true }); }
  catch (err) { if (err.code === 'github_installation_missing') return null; throw err; }
}
async function mintReadToken(installationId) {
  require('./code-host-write').requireCodeHostWrite('github.mintReadToken');
  pause.assertNotPaused();
  const repo = require('./repo-ref').parse(require('./repo-ref').platformRepoUrl());
  if (repo?.host !== 'github') throw new Error('No platform GitHub repository configured');
  if (installationId !== await resolveInstallationId(repo.owner)) {
    throw new Error('GitHub platform installation changed; refresh read access');
  }
  const permissions = { contents: 'read', pull_requests: 'read', metadata: 'read' };
  const auth = await requireApp().octokit.auth({
    type: 'installation', installationId, repositoryNames: [repo.repo], permissions, refresh: true,
  });
  if (!auth?.token || !Number.isFinite(Date.parse(auth.expiresAt))
      || Date.parse(auth.expiresAt) <= Date.now() + 60_000
      || Date.parse(auth.expiresAt) > Date.now() + 65 * 60_000
      || !Array.isArray(auth.repositoryNames) || auth.repositoryNames.length !== 1
      || String(auth.repositoryNames[0]).toLowerCase() !== repo.repo.toLowerCase()
      || !auth.permissions || Object.entries(auth.permissions).some(([key, value]) => permissions[key] !== value)
      || Object.entries(permissions).some(([key, value]) => auth.permissions[key] !== value)) {
    throw new Error('GitHub did not grant repository-scoped read access');
  }
  return { token: auth.token, expiresAt: auth.expiresAt };
}

// A full REST client (with .rest, unlike @octokit/app's own installation
// client) on the installation for `owner`, recorded as
// 'installation:<owner>'.
async function getInstallationOctokit(owner) {
  const token = await getInstallationToken(owner);
  const { Octokit } = await import('@octokit/rest');
  return instrument(new Octokit({ auth: token }), `installation:${owner}`);
}

// The owner a new app repository is made under: the git host's
// organisation whenever one is configured (every app since GitHub's
// suspension of usernode-bot, 25 Oct 2026), else the App's first
// installation, as before.
async function getBotUsername() {
  const gitHost = require('./git-host');
  if (gitHost.isConfigured()) return gitHost.settings().org;
  pause.assertNotPaused();
  for await (const { installation } of requireApp().eachInstallation.iterator()) {
    return installation.account.login;
  }
  throw new Error('No installations found for GitHub App');
}

// GitHub's "a repo with this name already exists" failure: HTTP 422
// whose errors[] carries a Repository/name entry. Prefer the structured
// shape (Octokit's RequestError exposes response.data.errors); fall back
// to the message substring for error objects without it.
function isRepoNameExistsError(err) {
  if (!err || err.status !== 422) return false;
  const errors = (err.response && err.response.data && err.response.data.errors) || [];
  if (Array.isArray(errors)
      && errors.some((e) => e && e.resource === 'Repository' && e.field === 'name')) {
    return true;
  }
  return /name already exists on this account/i.test(err.message || '');
}

async function createRepo(owner, name, { description = '', adoptExisting = false } = {}) {
  require('./code-host-write').requireCodeHostWrite('github.createRepo');
  if (onGitHost(owner)) return hostedGit().createRepo(owner, name, { description, adoptExisting });
  // New repositories are made on Homeroom's git host. On GitHub they were
  // made on the bot's account with its token, which is never sent again
  // ("Who Homeroom is on GitHub" above), and the App cannot make one on an
  // account.
  throw Object.assign(new Error('New repositories are made on Homeroom\'s git host, and it is not configured'), {
    code: 'git_host_not_configured',
  });
}

// Test seam (null in every real deploy): when set via
// _setOctokitFactoryForTests, getOctokit returns this factory's client
// instead of building a real one. Lets the mergePR sha-forwarding / 409
// mapping be unit-tested without a live GitHub client or credentials.
let _octokitFactoryForTests = null;
function _setOctokitFactoryForTests(factory) { _octokitFactoryForTests = factory; }

// Test seam (never called in a real deploy): stand a fake App in for the real
// one ({ eachInstallation.iterator(), octokit.auth() }), so the installation
// walk, canActOn and the clients above run without GitHub. Forgets every
// installation looked up before.
function _setAppForTests(fake) {
  app = fake || null;
  installationCache.clear();
  actingInstallation = { found: null, checkedAt: 0 };
  checkingInstallation = null;
}

// The writer client for a call on `owner`'s repositories on GitHub:
// the App's installation on the platform repository's owner, and refused
// for anyone else ("Who Homeroom is on GitHub" above).
async function getOctokit(owner) {
  require('./code-host-write').requireCodeHostWrite('github.writeClient');
  if (_octokitFactoryForTests) return _octokitFactoryForTests(owner);
  return getInstallationOctokit(owner);
}

// Web receives only conductor-published, repository-scoped read access.
// Conductors keep their installation client; both share the same rate budget.
async function getReadOctokit(owner) {
  if (_octokitFactoryForTests) return _octokitFactoryForTests(owner);
  if (roles.runsWorkflow(roles.processRole())) return getOctokit(owner);
  assertActingOwner(owner);
  const token = await require('./github-read-access').token(owner);
  const { Octokit } = await import('@octokit/rest');
  return instrument(new Octokit({ auth: token }), `installation:${owner}`, { readOnly: true });
}

async function pushFiles(owner, repo, files, { branch = 'main', message = 'Initial commit' } = {}) {
  require('./code-host-write').requireCodeHostWrite('github.pushFiles');
  if (onGitHost(owner)) return hostedGit().pushFiles(owner, repo, files, { branch, message });
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
    message: safeMention(message),
    tree: newTree.sha,
    parents: [latestCommitSha],
  });

  await octokit.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: newCommit.sha });

  log.info('github', 'Files pushed', { repo: `${owner}/${repo}`, fileCount: files.length });
  return newCommit;
}

// #3737: a commit with NO parent holding exactly `files`, written to the
// repository's object store with no branch pointing at it; the caller names
// it (services/bench/runner.js, the benchmark's scaffold, which only ever
// points a `bench/` branch at it). Without a parent, a checkout of it holds
// that one commit and none of the repository's history. Resolves its sha.
async function createRootCommit(owner, repo, files, { message = 'Initial commit' } = {}) {
  require('./code-host-write').requireCodeHostWrite('github.createRootCommit');
  if (onGitHost(owner)) return hostedGit().createRootCommit(owner, repo, files, { message });
  const octokit = await getOctokit(owner);
  const tree = files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content }));
  const { data: newTree } = await octokit.rest.git.createTree({ owner, repo, tree });
  const { data: commit } = await octokit.rest.git.createCommit({
    owner, repo, message: safeMention(message), tree: newTree.sha, parents: [],
  });
  return commit.sha;
}

// Read a single file's decoded text contents from a repo at `ref`
// (default the repo's default branch). Returns the string, or null when
// the file doesn't exist (404) so callers can branch on "create vs
// edit" without try/catch noise. Other errors propagate.
async function getFileContent(owner, repo, filePath, ref) {
  if (onGitHost(owner)) return hostedGit().getFileContent(owner, repo, filePath, ref);
  const octokit = await getReadOctokit(owner);
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

// A branch's tip: its commit's sha and message, or null when the branch or
// the repository does not exist. A creation that resumes reads it to tell
// whether its first commit already landed (app-creator.js).
async function headCommit(owner, repo, branch = 'main') {
  if (onGitHost(owner)) return hostedGit().headCommit(owner, repo, branch);
  const octokit = await getReadOctokit(owner);
  try {
    const { data } = await octokit.rest.repos.getBranch({ owner, repo, branch });
    const commit = data && data.commit;
    if (!commit || !commit.sha) return null;
    return { sha: String(commit.sha).toLowerCase(), message: commit.commit?.message || '' };
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

// ── Requests ───────────────────────────────────────────────────────────
// Requests are Homeroom's own since GitHub suspended the account that filed
// them (25 Oct 2026): rows in services/requests.js, for every app, the
// platform's own included. These keep the names and shapes the platform has
// always called, so nothing here talks to GitHub any more, and nothing is
// cached: a board is a query.
function requests() { return require('./requests'); }

async function findIssueByMarker(owner, repo, marker, { recent = 30 } = {}) {
  return requests().findByMarker(owner, repo, marker, { recent });
}

// #4145: every file path in a repo at `ref` (default the repo's default
// branch), one request through the read client: [{ path, size }], blobs
// only, and `truncated` when GitHub cut a very large tree short. Null when
// the repository or ref does not exist; other errors propagate.
async function listRepoFiles(owner, repo, ref) {
  if (onGitHost(owner)) return hostedGit().listRepoFiles(owner, repo, ref);
  const octokit = await getReadOctokit(owner);
  try {
    const { data } = await octokit.rest.git.getTree({ owner, repo, tree_sha: ref || 'HEAD', recursive: 'true' });
    const files = (data.tree || [])
      .filter((entry) => entry.type === 'blob')
      .map((entry) => ({ path: entry.path, size: entry.size || 0, sha: entry.sha }));
    return { files, truncated: data.truncated === true };
  } catch (err) {
    if (err.status === 404 || err.status === 409) return null;
    throw err;
  }
}

// One blob's decoded text, by its sha (listRepoFiles gives each file's). The
// contents API stops returning a file's bytes at 1 MB; the blob API does not,
// which is what a large generated file needs (services/language-sync-runner.js).
async function getBlobContent(owner, repo, sha) {
  if (onGitHost(owner)) return hostedGit().getBlobContent(owner, repo, sha);
  const octokit = await getReadOctokit(owner);
  const { data } = await octokit.rest.git.getBlob({ owner, repo, file_sha: sha });
  return Buffer.from(data.content || '', data.encoding || 'base64').toString('utf-8');
}

// `fromBranch` (default 'main') lets callers fork off an arbitrary existing
// branch — used by the headless-session clone flow (#155), which branches a
// user's new dev branch off the auto session's branch so any pushed commits
// carry over.
async function createBranch(owner, repo, branchName, fromBranch = 'main') {
  require('./code-host-write').requireCodeHostWrite('github.createBranch');
  if (onGitHost(owner)) return hostedGit().createBranch(owner, repo, branchName, fromBranch);
  const octokit = await getOctokit(owner);
  const { data: ref } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${fromBranch}` });

  await octokit.rest.git.createRef({
    owner, repo,
    ref: `refs/heads/${branchName}`,
    sha: ref.object.sha,
  });

  log.info('github', 'Branch created', { repo: `${owner}/${repo}`, branch: branchName, from: fromBranch });
}

// Create a platform-managed branch at an exact commit supplied by a native
// CLI handoff. Unlike createBranch(), this does not infer `main`: the local
// agent and Homeroom agree on one audited base SHA. Retrying after a DB
// failure is safe when the orphaned ref still points at that SHA; a different
// ref is a hard conflict rather than something we silently overwrite.
async function ensureBranchAtSha(owner, repo, branchName, sha) {
  require('./code-host-write').requireCodeHostWrite('github.ensureBranchAtSha');
  if (onGitHost(owner)) return hostedGit().ensureBranchAtSha(owner, repo, branchName, sha);
  const octokit = await getOctokit(owner);
  await octokit.request('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', {
    owner, repo, commit_sha: sha,
  });

  try {
    const { data: ref } = await octokit.request(
      'GET /repos/{owner}/{repo}/git/ref/{+ref}',
      { owner, repo, ref: `heads/${branchName}` }
    );
    if (String(ref.object.sha).toLowerCase() !== String(sha).toLowerCase()) {
      const err = new Error('The CLI handoff branch already exists at a different commit');
      err.code = 'branch_conflict';
      throw err;
    }
    return { sha: ref.object.sha, created: false };
  } catch (err) {
    if (err.code === 'branch_conflict') throw err;
    if (err.status !== 404) throw err;
  }

  try {
    await octokit.request('POST /repos/{owner}/{repo}/git/refs', {
      owner, repo, ref: `refs/heads/${branchName}`, sha,
    });
  } catch (createErr) {
    // Two retries of the same proposal_start can both observe the ref as
    // absent. GitHub lets one POST win and returns 422 to the other. Re-read
    // on that exact race: the matching ref is the idempotent success case; a
    // different ref remains a hard conflict. If no ref appeared, preserve the
    // original validation error instead of disguising it.
    if (createErr.status !== 422) throw createErr;
    try {
      const { data: racedRef } = await octokit.request(
        'GET /repos/{owner}/{repo}/git/ref/{+ref}',
        { owner, repo, ref: `heads/${branchName}` }
      );
      if (String(racedRef.object.sha).toLowerCase() === String(sha).toLowerCase()) {
        return { sha: racedRef.object.sha, created: false };
      }
      const conflict = new Error('The CLI handoff branch already exists at a different commit');
      conflict.code = 'branch_conflict';
      throw conflict;
    } catch (readErr) {
      if (readErr.code === 'branch_conflict') throw readErr;
      throw createErr;
    }
  }
  log.info('github', 'Branch created at exact SHA', {
    repo: `${owner}/${repo}`, branch: branchName, sha,
  });
  return { sha, created: true };
}

// Prove `headSha` is the same commit as, or a descendant of, `baseSha`.
// The compare endpoint also proves both objects belong to this repository.
// Callers use this for both the immutable handoff base and the branch's
// current head, preventing history rewrites on a later submission.
async function compareCommitAncestry(owner, repo, baseSha, headSha) {
  if (onGitHost(owner)) return hostedGit().compareCommitAncestry(owner, repo, baseSha, headSha);
  const octokit = await getReadOctokit(owner);
  const { data } = await octokit.request(
    'GET /repos/{owner}/{repo}/compare/{basehead}',
    { owner, repo, basehead: `${baseSha}...${headSha}`, per_page: 1 }
  );
  return {
    status: data.status,
    aheadBy: Number(data.ahead_by || 0),
    behindBy: Number(data.behind_by || 0),
    mergeBaseSha: data.merge_base_commit?.sha || null,
  };
}

// The commits of one pull request, as its Commits tab lists them: the ones on
// its head that its base did not have. GitHub keeps the list after a squash
// merge, so for a merged pull request it is what the change brought to main,
// and an open change whose head is on it was built on (included in) this one
// (workflow/merge-followups/facts.ts). GitHub lists at most 250, so `complete` is
// false when the list may be short. Lowercase SHAs. Throws on transport
// errors.
const PR_COMMITS_CAP = 250;

async function listPullRequestCommitShas(owner, repo, prNumber) {
  if (onGitHost(owner)) return nativePulls().commitShas(owner, repo, prNumber, { cap: PR_COMMITS_CAP });
  const octokit = await getReadOctokit(owner);
  const shas = [];
  for (let page = 1; page <= 3; page += 1) {
    const { data } = await octokit.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/commits',
      { owner, repo, pull_number: prNumber, per_page: 100, page }
    );
    const batch = Array.isArray(data) ? data : [];
    for (const commit of batch) {
      if (typeof commit?.sha === 'string') shas.push(commit.sha.toLowerCase());
    }
    if (batch.length < 100) break;
  }
  return { shas, complete: shas.length < PR_COMMITS_CAP };
}

// #955: the parent SHAs of one commit, oldest-first as Git stores them —
// so `[0]` is the FIRST parent, i.e. the branch the merge was made ONTO.
// The platform's sync turn merges origin/main into a proposal branch, so a
// pushed sync commit whose first parent is the reviewed head proves it sits
// directly on top of the reviewed revision and swept in no unreviewed author
// commit. Throws on transport errors; callers fail closed (skip the vote
// carry) rather than guessing provenance.
async function getCommitParents(owner, repo, sha) {
  if (onGitHost(owner)) return hostedGit().getCommitParents(owner, repo, sha);
  const octokit = await getReadOctokit(owner);
  const { data } = await octokit.request(
    'GET /repos/{owner}/{repo}/git/commits/{commit_sha}',
    { owner, repo, commit_sha: sha }
  );
  return (data.parents || [])
    .map((p) => (typeof p?.sha === 'string' ? p.sha.toLowerCase() : null))
    .filter(Boolean);
}

// The tree one commit points at — the CONTENT, with no history attached.
// Two commits with the same tree sha are byte-for-byte the same source, which
// is what lets a merge reuse an image built from the commit it squashed (see
// services/staging.js reuseImage). Same fixed-size endpoint getCommitParents
// uses, deliberately not repos.getCommit: that carries the commit's whole
// file list, which on a merge runs to hundreds of entries.
async function getCommitTree(owner, repo, sha) {
  if (onGitHost(owner)) return hostedGit().getCommitTree(owner, repo, sha);
  const octokit = await getReadOctokit(owner);
  const { data } = await octokit.request(
    'GET /repos/{owner}/{repo}/git/commits/{commit_sha}',
    { owner, repo, commit_sha: sha }
  );
  const tree = data?.tree?.sha;
  return typeof tree === 'string' ? tree.toLowerCase() : null;
}

async function getBranchSha(owner, repo, branchName) {
  if (onGitHost(owner)) return hostedGit().getBranchSha(owner, repo, branchName);
  const octokit = await getReadOctokit(owner);
  const { data: ref } = await octokit.request(
    'GET /repos/{owner}/{repo}/git/ref/{+ref}',
    { owner, repo, ref: `heads/${branchName}` }
  );
  return ref.object.sha;
}

// #1433: where a repository's default branch actually points, right now.
//
// The default branch is READ rather than assumed. `main` is the platform's
// own convention (DEFAULT_BASE_BRANCH in services/external-agent-tasks.js)
// and it is right for every repo the platform creates, but this runs against
// whatever repository an app was pointed at — including imported ones, whose
// default branch is somebody else's decision.
//
// Two small calls rather than one large one: `repos.getCommit` would answer
// both halves in a single request, but it carries the commit's full file
// list, and a merge commit on this repository routinely runs to hundreds of
// entries. `listCommits` with `per_page: 1` returns the same sha and date in
// a fixed-size payload.
async function getRepoHead(owner, repo) {
  if (onGitHost(owner)) return hostedGit().getRepoHead(owner, repo);
  const octokit = await getReadOctokit(owner);
  const { data: info } = await octokit.rest.repos.get({ owner, repo });
  const defaultBranch = info.default_branch || 'main';
  const { data: commits } = await octokit.rest.repos.listCommits({
    owner, repo, sha: defaultBranch, per_page: 1,
  });
  const top = Array.isArray(commits) && commits[0] ? commits[0] : null;
  return {
    defaultBranch,
    headSha: top && typeof top.sha === 'string' ? top.sha.toLowerCase() : null,
    headCommittedAt: top && top.commit && top.commit.committer
      ? (top.commit.committer.date || null)
      : null,
  };
}

// The commit a repository's default branch was at, at a moment in the past:
// the newest commit on it dated at or before `until` (GitHub's `until` reads
// the commit date). Read-only, for the benchmark's historical snapshots
// (services/bench/backfill.js). Resolves { sha, committedAt, branch }, or
// null when the branch has no commit that old.
async function getCommitAt(owner, repo, until, { branch = null } = {}) {
  if (onGitHost(owner)) return hostedGit().getCommitAt(owner, repo, until, { branch });
  const at = new Date(until);
  if (Number.isNaN(at.getTime())) throw new Error('getCommitAt needs a valid time');
  const octokit = await getReadOctokit(owner);
  let ref = branch;
  if (!ref) {
    const { data: info } = await octokit.rest.repos.get({ owner, repo });
    ref = info.default_branch || 'main';
  }
  const { data: commits } = await octokit.rest.repos.listCommits({
    owner, repo, sha: ref, until: at.toISOString(), per_page: 1,
  });
  const top = Array.isArray(commits) && commits[0] ? commits[0] : null;
  if (!top || typeof top.sha !== 'string') return null;
  return {
    sha: top.sha.toLowerCase(),
    committedAt: (top.commit && top.commit.committer && top.commit.committer.date) || null,
    branch: ref,
  };
}

// Fast-forward a CLI handoff's platform branch to an exact pushed commit.
// `force:false` is intentional even though callers preflight ancestry: it
// closes the race if another writer moves the ref between compare + update.
async function advanceBranchToSha(owner, repo, branchName, sha) {
  require('./code-host-write').requireCodeHostWrite('github.advanceBranchToSha');
  if (onGitHost(owner)) return hostedGit().advanceBranchToSha(owner, repo, branchName, sha);
  const octokit = await getOctokit(owner);
  const { data: ref } = await octokit.request(
    'GET /repos/{owner}/{repo}/git/ref/{+ref}',
    { owner, repo, ref: `heads/${branchName}` }
  );
  const currentSha = ref.object.sha;
  if (String(currentSha).toLowerCase() === String(sha).toLowerCase()) {
    return { previousSha: currentSha, sha: currentSha, updated: false };
  }
  const ancestry = await compareCommitAncestry(owner, repo, currentSha, sha);
  if (ancestry.status !== 'ahead' || ancestry.aheadBy < 1) {
    const err = new Error('Submitted commit does not fast-forward the CLI handoff branch');
    err.code = 'non_fast_forward';
    throw err;
  }
  const { data: updated } = await octokit.request(
    'PATCH /repos/{owner}/{repo}/git/refs/{+ref}',
    { owner, repo, ref: `heads/${branchName}`, sha, force: false }
  );
  log.info('github', 'CLI handoff branch advanced', {
    repo: `${owner}/${repo}`, branch: branchName, from: currentSha, to: updated.object.sha,
  });
  return { previousSha: currentSha, sha: updated.object.sha, updated: true };
}

// Move a branch to an exact commit whether or not that is a fast-forward.
//
// This is deliberately not the module's general ref-update path. It exists
// for three callers. Demo mode's reset (routes/demo-mode.js) puts a demo
// app's main back to where it stood before a recorded take. That app is in
// demo mode, its creator asked, and the commits being discarded are the
// partner's own demo proposals — the one situation where rewinding main is
// the point rather than an accident. And the Homeroom bot's first-version
// review (homeroom-bot-live.js rollbackReviewBranch) puts the bot's own
// session branch, never a default branch, back on the last commit that
// booted when a review fix broke the app, before anything is proposed. And
// a maintenance campaign (fleet-maintenance.pushChange) puts its own branch
// for an app back on main before it pushes the change again, when an
// attempt that pushed was lost before it opened a pull request.
async function forceBranchToSha(owner, repo, branchName, sha) {
  require('./code-host-write').requireCodeHostWrite('github.forceBranchToSha');
  if (onGitHost(owner)) return hostedGit().forceBranchToSha(owner, repo, branchName, sha);
  const octokit = await getOctokit(owner);
  const { data: ref } = await octokit.request(
    'GET /repos/{owner}/{repo}/git/ref/{+ref}',
    { owner, repo, ref: `heads/${branchName}` }
  );
  const previousSha = ref.object.sha;
  if (String(previousSha).toLowerCase() === String(sha).toLowerCase()) {
    return { previousSha, sha: previousSha, updated: false };
  }
  const { data: updated } = await octokit.request(
    'PATCH /repos/{owner}/{repo}/git/refs/{+ref}',
    { owner, repo, ref: `heads/${branchName}`, sha, force: true }
  );
  log.info('github', 'Branch force-moved', {
    repo: `${owner}/${repo}`, branch: branchName, from: previousSha, to: updated.object.sha,
  });
  return { previousSha, sha: updated.object.sha, updated: true };
}

function proposalCommitMessage(message, localCommitSha) {
  const body = safeMention(String(message || 'Local proposal update').trim())
    || 'Local proposal update';
  return `${body}\n\nUsernode-Local-Commit: ${localCommitSha}`;
}

async function createProposalCommit(owner, repo, {
  branchName,
  expectedRemoteParentSha,
  localParentSha,
  localParentTreeSha,
  expectedTreeSha,
  localCommitSha,
  message,
  authoredAt,
  committedAt,
  files,
}) {
  require('./code-host-write').requireCodeHostWrite('github.createProposalCommit');
  if (onGitHost(owner)) {
    return hostedGit().createProposalCommit(owner, repo, {
      branchName, expectedRemoteParentSha, localParentSha, localParentTreeSha, expectedTreeSha,
      localCommitSha, message, authoredAt, committedAt, files,
      fullMessage: proposalCommitMessage(message, localCommitSha),
    });
  }
  const octokit = await getOctokit(owner);
  const readCommit = async (sha) => {
    const { data } = await octokit.request(
      'GET /repos/{owner}/{repo}/git/commits/{commit_sha}',
      { owner, repo, commit_sha: sha }
    );
    return data;
  };
  const readHead = async () => {
    const { data } = await octokit.request(
      'GET /repos/{owner}/{repo}/git/ref/{+ref}',
      { owner, repo, ref: `heads/${branchName}` }
    );
    return data.object.sha;
  };
  const fullMessage = proposalCommitMessage(message, localCommitSha);
  const currentSha = String(await readHead()).toLowerCase();
  const current = await readCommit(currentSha);
  // A retry can arrive before or after the database records the new head.
  // Before persistence, expectedRemoteParentSha is this commit's parent;
  // afterward it is the commit itself. Require one of those exact shapes as
  // well as the complete generated message and tree. A copied trailer on an
  // unrelated branch movement must never be mistaken for our lost response.
  const currentParentSha = String(current.parents?.[0]?.sha || '').toLowerCase();
  const isRetry = (currentSha === expectedRemoteParentSha
      || currentParentSha === expectedRemoteParentSha)
    && String(current.message || '').trimEnd() === fullMessage.trimEnd()
    && String(current.tree?.sha || '').toLowerCase() === expectedTreeSha;
  if (isRetry) {
    return {
      sha: currentSha,
      treeSha: expectedTreeSha,
      previousSha: currentParentSha || null,
      localParentSha,
      created: false,
    };
  }
  if (currentSha !== expectedRemoteParentSha) {
    const err = new Error('The proposal branch moved before the local commit was uploaded');
    err.code = 'branch_moved';
    err.currentSha = currentSha;
    throw err;
  }
  if (String(current.tree?.sha || '').toLowerCase() !== localParentTreeSha) {
    const err = new Error('The local parent tree does not match the proposal branch tree');
    err.code = 'parent_tree_mismatch';
    err.remoteTreeSha = current.tree?.sha;
    err.localParentTreeSha = localParentTreeSha;
    throw err;
  }
  const treeEntries = new Array(files.length);
  let next = 0;
  const uploadOne = async () => {
    while (next < files.length) {
      const index = next++;
      const file = files[index];
      if (file.delete) {
        treeEntries[index] = {
          path: file.path, mode: '100644', type: 'blob', sha: null,
        };
        continue;
      }
      const { data: blob } = await octokit.request(
        'POST /repos/{owner}/{repo}/git/blobs',
        {
          owner,
          repo,
          content: file.contentBase64,
          encoding: 'base64',
        }
      );
      treeEntries[index] = {
        path: file.path,
        mode: file.mode,
        type: 'blob',
        sha: blob.sha,
      };
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(8, Math.max(1, files.length)) },
    () => uploadOne()
  ));

  const deletions = treeEntries.filter((entry) => entry.sha === null);
  const writes = treeEntries.filter((entry) => entry.sha !== null);
  const hasParentChildConflict = deletions.some((deletion) => writes.some((write) => (
    write.path.startsWith(`${deletion.path}/`)
      || deletion.path.startsWith(`${write.path}/`)
  )));
  let tree;
  if (hasParentChildConflict) {
    // Git cannot contain a blob and children below that blob at the same time.
    // File<->directory commits therefore carry paths such as a deletion of
    // `config` plus an addition of `config/index.js` (or the reverse). Apply
    // deletions first, then build the writes on the intermediate tree. The
    // final SHA check below still proves byte-for-byte tree equality.
    const { data: deletedTree } = await octokit.request(
      'POST /repos/{owner}/{repo}/git/trees',
      {
        owner,
        repo,
        base_tree: current.tree.sha,
        tree: deletions,
      }
    );
    const result = await octokit.request(
      'POST /repos/{owner}/{repo}/git/trees',
      {
        owner,
        repo,
        base_tree: deletedTree.sha,
        tree: writes,
      }
    );
    tree = result.data;
  } else {
    const result = await octokit.request(
      'POST /repos/{owner}/{repo}/git/trees',
      {
        owner,
        repo,
        base_tree: current.tree.sha,
        tree: treeEntries,
      }
    );
    tree = result.data;
  }
  if (String(tree.sha).toLowerCase() !== expectedTreeSha) {
    const err = new Error('The uploaded GitHub tree does not match the tested local tree');
    err.code = 'tree_mismatch';
    err.actualTreeSha = tree.sha;
    throw err;
  }

  const identity = {
    name: 'Homeroom CLI',
    email: 'cli@usernodelabs.org',
  };
  const { data: commit } = await octokit.request(
    'POST /repos/{owner}/{repo}/git/commits',
    {
      owner,
      repo,
      message: fullMessage,
      tree: tree.sha,
      parents: [currentSha],
      author: { ...identity, date: authoredAt },
      committer: { ...identity, date: committedAt },
    }
  );
  const createdSha = String(commit.sha || '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(createdSha)) {
    throw new Error('GitHub returned an invalid proposal commit SHA');
  }
  try {
    await octokit.request(
      'PATCH /repos/{owner}/{repo}/git/refs/{+ref}',
      {
        owner,
        repo,
        ref: `heads/${branchName}`,
        sha: createdSha,
        force: false,
      }
    );
  } catch (err) {
    // The update response can be lost after GitHub commits the ref. Confirm
    // the live tip before classifying any transport/API error so a safe retry
    // does not report a false branch conflict.
    let observedSha = null;
    try { observedSha = String(await readHead()).toLowerCase(); } catch {}
    if (observedSha === createdSha) {
      log.warn('github', 'Confirmed proposal ref update after an ambiguous response', {
        repo: `${owner}/${repo}`, branch: branchName, to: createdSha,
      });
    } else {
      if (![409, 422].includes(err.status)) throw err;
      const moved = new Error('The proposal branch moved while the local commit was uploaded');
      moved.code = 'branch_moved';
      moved.currentSha = observedSha;
      throw moved;
    }
  }
  log.info('github', 'Created bot-owned proposal commit from local tree', {
    repo: `${owner}/${repo}`,
    branch: branchName,
    from: currentSha,
    to: createdSha,
    localCommitSha,
    localParentSha,
    fileCount: files.length,
  });
  return {
    sha: createdSha,
    treeSha: expectedTreeSha,
    previousSha: currentSha,
    localParentSha,
    created: true,
  };
}

// Log-safe description of a GitHub/Octokit error. Octokit's
// RequestError.message is EMPTY when GitHub answers with an empty or
// non-JSON body (the 2026-07-24 create-PR outage logged `{"err":""}` for
// hours), so warn sites should spread this instead of logging err.message.
//
// `scopes` carries GitHub's own `x-oauth-scopes` response header — the
// authoritative answer to "what can this token actually do", which no
// amount of source-reading can supply. It is the HEADER STRING ONLY and
// never the token: a classic PAT's powers are its scopes, and the 2026-08-07
// connector failure took a live production run to characterise precisely
// because nothing logged it. Null for an App installation token, which
// GitHub does not report scopes for.
function describeGithubError(err) {
  if (!err) return { status: null, requestId: null, message: 'unknown error', data: null, scopes: null };
  const headers = (err.response && err.response.headers) || null;
  const status = err.status || (err.response && err.response.status) || null;
  const requestId = (headers && headers['x-github-request-id']) || null;
  const rawScopes = headers && headers['x-oauth-scopes'];
  const scopes = typeof rawScopes === 'string' ? rawScopes.slice(0, 300) : null;
  let data = (err.response && err.response.data !== undefined) ? err.response.data : null;
  if (typeof data === 'string') data = data.slice(0, 300) || null;
  const message = (err.message && String(err.message).trim())
    || (status ? `HTTP ${status} from GitHub (empty response body)` : String(err));
  return { status, requestId, message, data, scopes };
}

// Which credential `getOctokit` used for this call, reported on failure
// paths: the App installation, the only one there is now.
function credentialClass() {
  return 'installation';
}

// createPR retries transient GitHub failures (5xx / status-less network
// errors) before giving up: POST /pulls is the one platform write with a
// user-blocking dead end when GitHub hiccups (2026-07-24 outage: every
// create 500'd with an empty body while all other endpoints worked).
// Delays are injectable so tests don't sleep.
let createPrRetryDelaysMs = [2000, 8000];
function _setCreatePrRetryDelaysForTests(delays) {
  createPrRetryDelaysMs = delays || [2000, 8000];
}

// `head` is optional and defaults to `branch` — the same-repo shape every
// pre-existing caller uses. The hosted MCP connector passes an explicit
// `owner:branch` instead: app repos are bot-owned, so work written by a
// user's own coding agent lives on a branch in THEIR fork and the PR is
// cross-fork. Everything below (the retry schedule, the typed no_commits /
// pr_exists / github_unavailable errors) is identical either way.
//
// `headRepo` ("owner/name") is forwarded to GitHub as `head_repo`. A bare
// `owner:branch` head makes GitHub SEARCH the base's fork network for a repo
// owned by that login, which is ambiguous the moment the user owns more than
// one repo in the network — the exact case CONFLICT_FORK_SUFFIX exists to
// create. Octokit forwards unknown body params, but this function
// destructures a fixed list, so the parameter has to be named here or it is
// silently dropped. Omitted entirely (not sent as undefined) when unset, so
// every same-repo caller's request body is byte-identical to before.
//
// `maintainerCanModify` is forwarded as `maintainer_can_modify` and carries
// the same fixed-list caveat. Cross-fork callers must pass `false`; see the
// note at the call below for why the default is not safe there.
async function createPR(owner, repo, {
  branch, title, body, head, headRepo, maintainerCanModify, draft,
}) {
  if (onGitHost(owner)) return nativePulls().create(owner, repo, { branch, head, title, body, draft });
  require('./code-host-write').requireCodeHostWrite('github.createPR');
  const octokit = await getOctokit(owner);
  const headRef = head || branch;
  const attempts = createPrRetryDelaysMs.length + 1;
  let data;
  for (let attempt = 1; ; attempt++) {
    try {
      ({ data } = await octokit.rest.pulls.create({
        owner, repo,
        title: safeMention(title),
        body: safeMention(body),
        head: headRef,
        ...(headRepo ? { head_repo: headRepo } : {}),
        // Sent ONLY when a caller asks for it — every same-repo caller omits
        // it and keeps GitHub's default, unchanged. A cross-fork caller
        // passes `false`: GitHub treats the parameter as true when omitted,
        // which for a fork head is a request to grant the BASE repo's
        // maintainers push access to the HEAD branch, and only a
        // collaborator on the head repo may grant that. `usernode-bot` is
        // not a collaborator on anybody's fork and by design never will be
        // (services/github-link.js is identity-only), so the implicit
        // request made GitHub 422 the whole create with
        // `field: "fork_collab"` — the failure that made every cross-fork
        // submission fall through to the mirror. Boolean-checked rather
        // than truthy-checked: `false` is the whole point.
        ...(typeof maintainerCanModify === 'boolean'
          ? { maintainer_can_modify: maintainerCanModify }
          : {}),
        ...(typeof draft === 'boolean' ? { draft } : {}),
        base: 'main',
      }));
      break;
    } catch (err) {
      // GitHub answers 422 "No commits between main and <branch>" when the
      // head branch has nothing to merge (typically: committed locally but
      // never pushed). Surface this as a typed, non-transient error so
      // callers can tell the user the truth instead of "try again in a
      // moment" — retrying a permanently-empty branch never succeeds.
      const detail = err && (err.message || '') +
        ' ' + JSON.stringify(err?.response?.data?.errors || err?.response?.data || '');
      if (err && err.status === 422 && /No commits between/i.test(detail)) {
        const e = new Error(`No commits between main and ${headRef}: the branch has no pushed commits.`);
        e.code = 'no_commits';
        throw e;
      }
      // GitHub answers 422 "A pull request already exists for <owner>:<branch>"
      // when the PR was created but the caller never learned about it — the
      // restart race: the old process created the PR and died before writing
      // pr_number to the DB (session 2262, 2026-07-14). Type it so callers can
      // look the existing PR up and adopt it instead of failing forever.
      if (err && err.status === 422 && /pull request already exists/i.test(detail)) {
        const e = new Error(`A pull request already exists for ${head ? headRef : `${owner}:${branch}`}.`);
        e.code = 'pr_exists';
        throw e;
      }
      // GitHub answers 422 `field: "fork_collab"` — "Fork collab can't be
      // granted by someone without permission" — when the create asks to
      // give the base repo's maintainers write access to a HEAD branch in
      // somebody else's fork. That grant is only a head-repo collaborator's
      // to make. It is a bug in the REQUEST, not a condition of the
      // repository: the caller either sends `maintainerCanModify: false` or
      // it must not open a cross-fork PR at all, so retrying, re-sending
      // with `head_repo`, or mirroring around it all miss the point. Typed
      // so `resolvePullRequest` stops the ladder and says what happened.
      // Unreachable once every cross-fork caller sends `false`, which is
      // exactly why it is worth naming if it ever comes back.
      if (err && err.status === 422 && /fork_collab/i.test(detail)) {
        const e = new Error(
          `GitHub refused to open the pull request for ${headRef} because the request asked to grant `
          + `${owner}/${repo}'s maintainers write access to that branch, and only a collaborator on the `
          + 'fork can grant it. Open the pull request with maintainer edits disabled.'
        );
        e.code = 'fork_collab_denied';
        e.status = 422;
        throw e;
      }
      // Transient: a GitHub 5xx or a status-less network failure. Retry on
      // the short schedule above. Non-idempotency is safe here: if a 500
      // actually created the PR, the retry 422s "already exists" and flows
      // into the pr_exists adopt path in applyPrMetadata.
      const transient = !err || !err.status || err.status >= 500;
      const desc = describeGithubError(err);
      if (transient && attempt < attempts) {
        log.warn('github', 'PR creation failed — retrying', {
          repo: `${owner}/${repo}`, branch, attempt, attempts, ...desc,
        });
        await new Promise((resolve) => setTimeout(resolve, createPrRetryDelaysMs[attempt - 1]));
        continue;
      }
      if (transient) {
        // GitHub itself is failing. Typed so callers can tell users the
        // truth — GitHub-side, wait and retry — instead of the generic
        // "re-run your request in the session".
        const e = new Error(
          `GitHub failed to create the PR for ${head ? headRef : `${owner}:${branch}`} after ${attempts} attempts `
          + `(${desc.status ? `HTTP ${desc.status}` : 'network error'}`
          + `${desc.requestId ? `, request id ${desc.requestId}` : ''}).`
        );
        e.code = 'github_unavailable';
        e.status = desc.status;
        e.requestId = desc.requestId;
        throw e;
      }
      throw err;
    }
  }
  log.info('github', 'PR created', { repo: `${owner}/${repo}`, pr: data.number });
  return data;
}

// Look up the open PR whose head is `branch`. Defaults to a same-repo head
// (`owner:branch`) — the shape every pre-existing caller means. Used by
// applyPrMetadata to adopt a PR that exists on GitHub but was never
// persisted to the session row (createPR 422 'pr_exists'), and by the MCP
// connector with an explicit `headOwner` to find the cross-fork PR for a
// branch in the user's own fork.
async function findOpenPrByBranch(owner, repo, branch, { headOwner } = {}) {
  if (onGitHost(owner)) return nativePulls().findOpenByBranch(owner, repo, branch);
  const octokit = await getReadOctokit(owner);
  const { data } = await octokit.rest.pulls.list({
    owner, repo, head: `${headOwner || owner}:${branch}`, state: 'open', per_page: 1,
  });
  return (data && data[0]) || null;
}

// #687 (PR-import): list the repo's currently-open pull requests, newest
// first. Used by the import picker to show candidates the user can pull in
// as proposals. Returns the raw Octokit PR objects (number, title, user,
// head, base, html_url, …); callers shape what they need. Same-repo scope —
// fork heads are out of scope for the import flow (see spec Deferred work).
async function listOpenPulls(owner, repo, { perPage = 50 } = {}) {
  if (onGitHost(owner)) return nativePulls().listOpen(owner, repo, { perPage });
  const octokit = await getReadOctokit(owner);
  const { data } = await octokit.rest.pulls.list({
    owner, repo, state: 'open', sort: 'created', direction: 'desc',
    per_page: perPage,
  });
  return data || [];
}

async function updatePR(owner, repo, prNumber, { title, body } = {}) {
  if (onGitHost(owner)) return nativePulls().update(owner, repo, prNumber, { title, body });
  require('./code-host-write').requireCodeHostWrite('github.updatePR');
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

// Point a pull request at another base branch: a stacked change whose parent
// has landed on main is retargeted to main (src/workflow/rules/pr-base.ts).
// A pull request on the git host always merges into main, so there is
// nothing to move.
async function retargetPR(owner, repo, prNumber, base) {
  if (onGitHost(owner)) return nativePulls().get(owner, repo, prNumber);
  require('./code-host-write').requireCodeHostWrite('github.retargetPR');
  const octokit = await getOctokit(owner);
  const { data } = await octokit.rest.pulls.update({ owner, repo, pull_number: prNumber, base });
  log.info('github', 'PR retargeted', { repo: `${owner}/${repo}`, pr: prNumber, base });
  return data;
}

async function closePR(owner, repo, prNumber) {
  if (onGitHost(owner)) return nativePulls().close(owner, repo, prNumber);
  require('./code-host-write').requireCodeHostWrite('github.closePR');
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
  if (onGitHost(owner)) return nativePulls().reopen(owner, repo, prNumber);
  require('./code-host-write').requireCodeHostWrite('github.reopenPR');
  const octokit = await getOctokit(owner);
  const { data } = await octokit.rest.pulls.update({
    owner, repo, pull_number: prNumber, state: 'open',
  });
  log.info('github', 'PR reopened', { repo: `${owner}/${repo}`, pr: prNumber });
  return data;
}

// Distinct "head moved" outcome. Proposal callers pin the exact reviewed
// commit, so GitHub returns 409 if someone pushes between the vote and merge.
// Imported proposals defer to their sync poller; native proposals (including
// CLI handoffs) reconcile their live reviewed head immediately.
// `err.headMoved === true` is the shared sentinel.
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
// something newer that pushed in after the vote. Native and imported proposal
// callers both pass their revision-specific reviewed SHA.
// A 409 raised specifically by the sha mismatch is re-thrown as a
// HeadMovedError so the caller can distinguish it from other merge failures.
async function mergePR(owner, repo, prNumber, sha = null) {
  require('./code-host-write').requireCodeHostWrite('github.mergePR');
  if (onGitHost(owner)) return nativePulls().merge(owner, repo, prNumber, sha);
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
    // and hit a 409, surface it as the head-moved sentinel so proposal callers
    // can refresh the live revision instead of erroring the proposal.
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
  if (onGitHost(owner)) return nativePulls().get(owner, repo, prNumber);
  const octokit = await getReadOctokit(owner);
  const { data } = await octokit.rest.pulls.get({
    owner, repo,
    pull_number: prNumber,
  });
  return data;
}

// GitHub's REST update-PR endpoint does not support changing draft state.
// The GraphQL mutation is the supported transition at the review boundary.
async function markPrReadyForReview(owner, repo, prNumber, existingPr = null) {
  if (onGitHost(owner)) return nativePulls().markReady(owner, repo, prNumber);
  require('./code-host-write').requireCodeHostWrite('github.markPrReadyForReview');
  const pr = existingPr || await getPR(owner, repo, prNumber);
  if (pr.draft === false) return pr;
  if (pr.draft !== true) throw new Error(`GitHub did not report PR #${prNumber}'s draft state`);
  if (!pr.node_id) throw new Error(`PR #${prNumber} has no GitHub node ID`);
  const octokit = await getOctokit(owner);
  const result = await octokit.graphql(
    `mutation($pullRequestId: ID!) {
      markPullRequestReadyForReview(input: {pullRequestId: $pullRequestId}) {
        pullRequest { id isDraft }
      }
    }`,
    { pullRequestId: pr.node_id }
  );
  if (result?.markPullRequestReadyForReview?.pullRequest?.isDraft !== false) {
    throw new Error(`GitHub did not confirm PR #${prNumber} is ready for review`);
  }
  return { ...pr, draft: false };
}

// List the file paths changed between two refs ("main...branch-name").
// Used by the visuals capture heuristic (src/services/visuals.js) to decide
// whether a commit range plausibly touches the UI. Uses the compare API
// (not pulls.listFiles) so it works on the headless path, where no PR
// exists yet. The compare endpoint returns at most 300 files per page —
// plenty for a "does anything frontend-ish appear?" check.
async function listChangedFiles(owner, repo, basehead) {
  if (onGitHost(owner)) return hostedGit().listChangedFiles(owner, repo, basehead);
  const octokit = await getReadOctokit(owner);
  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner, repo, basehead, per_page: 100,
  });
  return (data.files || []).map((f) => f.filename);
}

// #788 follow-up: merge-base compare between two refs ("main...branch").
// Returns { mergeBaseSha, files, filesComplete } — the merge-base commit
// sha (the point the branch was cut from, i.e. what a three-dot diff is
// relative to), the changed file paths, and whether that list is
// exhaustive. The compare endpoint caps the files array at 300 entries,
// so a list that hits the cap must not be trusted as complete
// (filesComplete: false); callers fall back to fetching the file they
// care about instead. mergeBaseSha is null when GitHub reports no
// merge_base_commit (unrelated histories). Throws on transport errors,
// matching listChangedFiles / getProposalDiff.
const COMPARE_FILES_CAP = 300;

async function compareRefs(owner, repo, basehead) {
  if (onGitHost(owner)) return hostedGit().compareRefs(owner, repo, basehead, { cap: COMPARE_FILES_CAP });
  const octokit = await getReadOctokit(owner);
  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner, repo, basehead, per_page: 100,
  });
  const files = (data.files || []).map((f) => f.filename);
  return {
    mergeBaseSha: data.merge_base_commit?.sha || null,
    files,
    filesComplete: files.length < COMPARE_FILES_CAP,
  };
}

// "Suggest this back" (services/suggest-back.js): the commits on `head`
// since `base`, oldest first, each as { sha, subject } (the message's first
// line), with the total GitHub counted and the changed file paths. The
// compare endpoint lists at most 250 commits and 300 files, so `totalCommits`
// is the figure to show and `files` may be short of a very large change.
// Throws on transport errors, like compareRefs.
async function compareCommitSubjects(owner, repo, base, head) {
  if (onGitHost(owner)) return hostedGit().compareCommitSubjects(owner, repo, base, head);
  const octokit = await getReadOctokit(owner);
  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner, repo, basehead: `${base}...${head}`, per_page: 100,
  });
  const commits = (data.commits || []).map((c) => ({
    sha: c.sha,
    subject: String((c.commit && c.commit.message) || '').split('\n')[0].trim(),
  }));
  return {
    commits,
    totalCommits: Number.isInteger(data.total_commits) ? data.total_commits : commits.length,
    files: (data.files || []).map((f) => f.filename),
  };
}

// #297: a size-capped unified diff for LLM context. Concatenates the
// per-file `patch` hunks from the compare endpoint (`main...<branch>`)
// into one unified-diff string, truncated to a hard char budget so a huge
// PR can't blow a prompt budget. Mirrors listChangedFiles' use of
// compareCommitsWithBasehead (so it works on any ref pair, PR or not).
// Binary / overly-large files have no `patch` field — those get a one-line
// "+N/-M" summary instead. Throws on transport errors, so callers that
// treat the diff as optional context should fail open around it.
//
// #827 retired its only caller (the proposal-advisor route). Kept as a
// generic sibling of listChangedFiles / compareRefs.
const PROPOSAL_DIFF_CHAR_BUDGET = 12000;

async function getProposalDiff(owner, repo, basehead, charBudget = PROPOSAL_DIFF_CHAR_BUDGET) {
  if (onGitHost(owner)) return hostedGit().getProposalDiff(owner, repo, basehead, charBudget);
  const octokit = await getReadOctokit(owner);
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
  return {
    diff: out, fileCount: files.length, truncated,
    // #6037: the full list, so a reviewer knows what exists beyond the
    // truncated text. `filesComplete` false means the compare's 300-file
    // page was full, so an unlisted path is not proven absent.
    files: files.map((f) => ({ filename: f.filename, previous: f.previous_filename || null })),
    filesComplete: files.length < COMPARE_FILES_CAP,
  };
}

// #3654: the files a compare touched, with their status and patch, for the
// Homeroom bot benchmark's diff-scope grader and its judge. One call gives
// both the list and the diff text (capped like getProposalDiff's), and
// `complete` says whether GitHub's 300-file page held everything. Also read
// by the small-change tag (services/small-change.js), which needs the merge
// base to read dapp.json as the change found it.
async function compareFiles(owner, repo, basehead, charBudget = 60000) {
  if (onGitHost(owner)) return hostedGit().compareFiles(owner, repo, basehead, charBudget, { cap: COMPARE_FILES_CAP });
  const octokit = await getReadOctokit(owner);
  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner, repo, basehead, per_page: 100,
  });
  const files = (data.files || []).map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions || 0,
    deletions: f.deletions || 0,
    previous: f.previous_filename || null,
  }));
  let diff = '';
  let truncated = false;
  for (const f of data.files || []) {
    const block = `diff --git a/${f.filename} b/${f.filename}\n${f.patch ? `${f.patch}\n` : `(no textual diff: ${f.status}, +${f.additions || 0}/-${f.deletions || 0})\n`}`;
    if (diff.length + block.length > charBudget) { truncated = true; break; }
    diff += block;
  }
  return {
    files, diff, truncated, complete: files.length < COMPARE_FILES_CAP, aheadBy: data.ahead_by ?? null,
    mergeBaseSha: data.merge_base_commit?.sha || null,
  };
}

// #3654: delete a branch the Homeroom bot benchmark made. Refuses any name
// outside the benchmark's own `bench/` prefix, so a bug in the caller can
// never take a person's or a proposal's branch with it. A branch already
// gone is not an error.
async function deleteBenchBranch(owner, repo, branchName) {
  require('./code-host-write').requireCodeHostWrite('github.deleteBenchBranch');
  if (onGitHost(owner)) return hostedGit().deleteBenchBranch(owner, repo, branchName);
  if (typeof branchName !== 'string' || !/^bench\/[A-Za-z0-9._/-]+$/.test(branchName) || branchName.includes('..')) {
    throw new Error(`refusing to delete ${branchName}: not a benchmark branch`);
  }
  const octokit = await getOctokit(owner);
  try {
    await octokit.rest.git.deleteRef({ owner, repo, ref: `heads/${branchName}` });
    return true;
  } catch (err) {
    if (err.status === 404 || err.status === 422) return false;
    throw err;
  }
}

async function updateIssueTitle(owner, repo, issueNumber, title) {
  return requests().setTitle(owner, repo, issueNumber, title);
}

async function updateIssueBody(owner, repo, issueNumber, body) {
  return requests().setBody(owner, repo, issueNumber, body);
}

// The author's rename (routes/issues.js, #556) and the title-heal sweeper.
async function patchIssueTitle(owner, repo, issueNumber, title) {
  await requests().setTitle(owner, repo, issueNumber, title);
}

async function patchIssueBody(owner, repo, issueNumber, body) {
  await requests().setBody(owner, repo, issueNumber, body);
}

async function patchIssueContent(owner, repo, issueNumber, { title, body }) {
  await requests().setContent(owner, repo, issueNumber, { title, body });
}

// `reason`: 'completed' (the default) or 'not_planned'.
async function closeIssue(owner, repo, issueNumber, { reason = null } = {}) {
  return requests().close(owner, repo, issueNumber, { reason });
}

async function reopenIssue(owner, repo, issueNumber) {
  return requests().reopen(owner, repo, issueNumber);
}

// The raw issue shape, open or closed; a missing one throws with status 404.
async function getIssue(owner, repo, issueNumber) {
  return requests().getRaw(owner, repo, issueNumber);
}

// File a request. `createdBy` is the person, when the caller knows them.
async function createIssue(owner, repo, { title, body, labels = [], createdBy = null } = {}) {
  return requests().create(owner, repo, { title, body, labels, createdBy });
}

async function createIssueComment(owner, repo, issueNumber, body) {
  return requests().comment(owner, repo, issueNumber, body);
}

// Worker containers carry no GitHub credentials — we restrict imports
// to public repos, so `git clone` over plain HTTPS just works. This
// used to return a token-embedded URL; that capability moved to the
// platform-side push proxy (see src/routes/internal.js +
// worker.execPushFromWorker).
async function getCloneUrl(owner, repo) {
  if (onGitHost(owner)) return require('./git-host').cloneUrl({ owner, name: repo });
  return `https://github.com/${owner}/${repo}.git`;
}

// ---------------------------------------------------------------------------
// "Import existing repo" helpers.
//
// What is left of the flow where a person pasted a GitHub URL to import
// their repository. Importing from GitHub is paused (it made the bot a
// collaborator on that repository: routes/apps.js POST /api/apps), so these
// only read.
// ---------------------------------------------------------------------------

// Parse the variants we want to accept from the user: { owner, repo } or
// null (src/workflow/rules/github-url.ts, which the workflow machines read
// repositories with).
const { parseGithubUrl } = require('../workflow/rules/github-url.ts');

// Lightweight privacy check. Used by:
//   - worker bootstrap (defense against post-import privacy flips)
//   - the startup audit (sweeps existing imports)
// Returns { ok: true, private: bool } on success, { ok: false, code, message }
// on failure. Callers decide whether to treat "couldn't determine" as
// fatal (bootstrap) or just log (audit).
async function checkRepoPublic(owner, repo) {
  if (onGitHost(owner)) return hostedGit().checkRepoPublic(owner, repo);
  if (!app && !require('./github-read-access').configured() && !_octokitFactoryForTests) {
    return { ok: false, code: 'no_token', message: 'The GitHub App is not configured.' };
  }
  // A read, on every worker start, through the App installation. Refused
  // (as a pause) for any owner but the platform repository's.
  let octokit;
  try {
    octokit = await getReadOctokit(owner);
  } catch (err) {
    if (pause.isPausedError(err)) return { ok: false, code: 'github_paused', message: err.message };
    return { ok: false, code: 'github_error', message: err.message };
  }
  try {
    const { data } = await octokit.rest.repos.get({ owner, repo });
    return { ok: true, private: data.private === true };
  } catch (err) {
    if (err.status === 404) {
      return { ok: false, code: 'not_found', message: `Repo ${owner}/${repo} not accessible.` };
    }
    // GitHub's own "API rate limit exceeded for user ID ..." told a person
    // nothing about what to do. Say it in plain words, with when it resets.
    const notice = budget.rateLimitNotice(err);
    if (notice) {
      const retryAfterSeconds = budget.rateLimitRetryAfterSeconds(err);
      return { ok: false, code: 'rate_limited', message: notice, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) };
    }
    return { ok: false, code: 'github_error', message: err.message };
  }
}

// Unauthenticated GET that powers the name-prefill in the modal. We
// deliberately do NOT use the bot token here: the prefill is a
// convenience, not an oracle, and keeping it unauth means a private
// repo silently 404s without leaking name/description info that the
// caller wouldn't otherwise be able to see. Importing from GitHub is paused
// (routes/apps.js POST /api/apps), so nothing is gated on it.
async function fetchPublicRepoInfo(owner, repo) {
  try {
    const resp = await githubFetch('anonymous', `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: { 'Accept': 'application/vnd.github+json' },
    });
    recordFetchResponse('anonymous', resp, { url: `/repos/${owner}/${repo}` });
    if (!resp.ok) return null;
    const data = await resp.json();
    return { name: data.name || null, description: data.description || null };
  } catch (_) {
    return null;
  }
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

// An app's open requests, most recently updated first:
// { issues, truncatedList, note? }. Never throws: a failed read is an empty
// list with a note, as a failed GitHub read was.
async function fetchPublicIssues(owner, repo) {
  try {
    return await requests().listOpen(owner, repo);
  } catch (err) {
    log.warn('github', 'Request list read failed', { repo: `${owner}/${repo}`, err: err.message });
    return { issues: [], truncatedList: false, note: 'fetch failed' };
  }
}

// The board's refresh button: a fresh read is always the current list.
async function refreshPublicIssues(owner, repo) {
  const result = await fetchPublicIssues(owner, repo);
  return { ...result, refreshed: true, retryInMs: 0 };
}

// One request, open or closed: { issue } or { issue: null, note }. A
// proposal's number answers 'not an issue (pull request)'.
async function fetchPublicIssue(owner, repo, number) {
  try {
    return await requests().getOne(owner, repo, number);
  } catch (err) {
    log.warn('github', 'Request read failed', { repo: `${owner}/${repo}`, issue: number, err: err.message });
    return { issue: null, note: 'fetch failed' };
  }
}

// A request's comments, oldest first: { comments: [{ author, body,
// createdAt, id }], truncated, note? }. Never throws.
async function fetchIssueComments(owner, repo, number, { max = ISSUE_COMMENTS_MAX, since = null } = {}) {
  try {
    return await requests().comments(owner, repo, number, { max, since });
  } catch (err) {
    log.warn('github', 'Request comments read failed', { repo: `${owner}/${repo}`, issue: number, err: err.message });
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

module.exports = {
  init,
  isEnabled,
  hasApp,
  hasWriteAccess,
  getBotUsername,
  getOctokit,
  getReadOctokit,
  // Whether Homeroom can change code on GitHub for an owner: only the
  // platform repository's, once the App's installation there is found.
  canActOn,
  checkActingInstallation,
  actingOwner,
  getInstallationOctokit,
  getInstallationToken,
  readInstallationId,
  mintReadToken,
  createRepo,
  _isRepoNameExistsError: isRepoNameExistsError,
  pushFiles,
  headCommit,
  findIssueByMarker,
  createRootCommit,
  getFileContent,
  listRepoFiles,
  getBlobContent,
  createBranch,
  ensureBranchAtSha,
  compareCommitAncestry,
  listPullRequestCommitShas,
  getCommitParents,
  getCommitTree,
  getBranchSha,
  getRepoHead,
  getCommitAt,
  advanceBranchToSha,
  forceBranchToSha,
  createProposalCommit,
  createPR,
  describeGithubError,
  credentialClass,
  _setCreatePrRetryDelaysForTests,
  findOpenPrByBranch,
  listOpenPulls,
  updatePR,
  retargetPR,
  closePR,
  reopenPR,
  mergePR,
  HeadMovedError,
  _setOctokitFactoryForTests,
  _setAppForTests,
  getPR,
  markPrReadyForReview,
  listChangedFiles,
  compareRefs,
  compareCommitSubjects,
  getProposalDiff,
  compareFiles,
  deleteBenchBranch,
  getIssue,
  createIssue,
  createIssueComment,
  updateIssueTitle,
  patchIssueTitle,
  updateIssueBody,
  patchIssueBody,
  patchIssueContent,
  closeIssue,
  reopenIssue,
  getCloneUrl,
  safeMention,
  parseGithubUrl,
  checkRepoPublic,
  fetchPublicRepoInfo,
  // The header builder for read-only PUBLIC GitHub reads (anonymous), for
  // services/external-agent-tasks.
  publicApiHeaders: publicFetchHeaders,
  // The budget those reads spend ('anonymous'), and the recorder for a raw
  // fetch response (services/github-budget.js), for the same services.
  publicApiCredential: publicFetchCredential,
  // The one raw-fetch path to GitHub's API, refused while paused
  // (services/github-pause.js), for the few callers outside this file.
  githubFetch,
  recordFetchResponse,
  _instrumentForTests: instrument,
  fetchPublicIssues,
  fetchPublicIssue,
  fetchIssueComments,
  clipIssueComments,
  refreshPublicIssues,
  truncateIssueBodies,
  listActionsSecrets,
  invalidateActionsSecretsCache,
  ACTIONS_SECRETS_FORBIDDEN_MESSAGE,
  ACTIONS_SECRETS_MAX,
};
