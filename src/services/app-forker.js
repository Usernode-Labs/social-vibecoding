'use strict';

// Staging rebuild trigger — no functional effect.
const fs = require('fs');
const path = require('path');
const log = require('./logger');
const github = require('./github');
const docker = require('./docker');
const { getConnectorScaffoldFiles, getCanonicalRepoFile } = require('./template');
const repoRef = require('./repo-ref');
const commitIdentity = require('./commit-identity');

// Rewrite (or create) the top-level `name` in the forked working tree's
// dapp.json to the forker's chosen name. dapp.json's `name` is the
// source of truth for the display name and reconcileAppName() would
// otherwise overwrite apps.name back to the ORIGINAL's name on the
// fork's first deploy. The rest of the manifest (icon, secrets, tests,
// description) carries over verbatim: it is the app's code and look.
//
// Three blocks are the ORIGINAL's settings rather than its code, and the
// first deploy's reconcile would apply each of them to the copy, so they
// are stripped:
//   - `admins` (issue #788): carrying the source's per-app admin roster
//     over would silently hand strangers management + force-merge rights
//     on someone else's app. The forker keeps their creator rights.
//   - `visibility`: a copy starts as Just you (the route inserts it
//     private/private); the source's block would open it back up.
//   - `governance`: who approves the original's proposals says nothing
//     about the copy, which starts on the platform default.
// Each stays votable later like any other line in the copy's dapp.json.
const FORK_STRIPPED_MANIFEST_KEYS = Object.freeze(['admins', 'visibility', 'governance']);

function rewriteDappName(dir, name) {
  const p = path.join(dir, 'dapp.json');
  let obj = null;
  try {
    obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (_) {
    obj = null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = {};
  obj.name = name;
  for (const key of FORK_STRIPPED_MANIFEST_KEYS) delete obj[key];
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`);
}

// Place the `.claude/` connector scaffold in the fork's working tree, so a
// fork of an app created before #1218 — or of an imported repo that never had
// one — stops prompting on every read-only connector call too.
//
// Write-if-absent, never overwrite: whatever the source repo carries in
// `.claude/` is the app's own, and a fork copies the app rather than
// normalising it. A source scaffolded by today's template already has these
// two files byte-for-byte, so the common case is a no-op.
//
// Plain fs on the tree that has just been flattened and not yet committed, so
// the files land in the single squashed commit below rather than needing a
// second push.
function writeConnectorScaffold(dir) {
  for (const file of getConnectorScaffoldFiles()) {
    const dest = path.join(dir, file.path);
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, file.content);
  }
}

// Name the fork's OWN repository as its canonical one
// (.claude/homeroom-canonical-repo, read by the scaffold's freshness check).
// Unlike the scaffold above this always overwrites: the tree was copied from
// the source app, so the file it carries names the parent, and a fork's
// agents must be compared against the fork.
function writeCanonicalRepoPointer(dir, repoUrl) {
  const file = getCanonicalRepoFile(repoUrl);
  if (!file) return;
  const dest = path.join(dir, file.path);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, file.content);
}

// Resolve the source row recorded in a fork's reference-only lineage. New
// rows carry appId + slug; the slug fallback keeps retries/recovery working
// for older rows that predate the appId form. This deliberately returns the
// live row rather than trusting display-enriched lineage from an API payload.
async function findForkSource(pool, forkApp) {
  let ref = forkApp && forkApp.forked_from;
  if (typeof ref === 'string') {
    try { ref = JSON.parse(ref); } catch (_) { ref = null; }
  }
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;

  if (Number.isInteger(ref.appId) && ref.appId > 0) {
    const { rows } = await pool.query('SELECT * FROM apps WHERE id = $1', [ref.appId]);
    // An appId is immutable and authoritative. If that row was deleted, do
    // not fall through to a slug that may since have been reused by a wholly
    // different app.
    return rows.length ? rows[0] : null;
  }
  if (typeof ref.slug === 'string' && ref.slug.trim()) {
    const { rows } = await pool.query('SELECT * FROM apps WHERE slug = $1', [ref.slug.trim()]);
    if (rows.length) return rows[0];
  }
  return null;
}

// Copy the SOURCE app's current `main` tree into a brand-new repository on
// Homeroom's git host as a single, history-free commit — preserving binary
// assets (icon images, etc.) that github.pushFiles would corrupt. NOT a
// fork on the host: we want an independent app with its own requests and
// proposals. Leaves the fork's working tree on disk at `tempDir` (the
// caller removes it), and returns { repoUrl, mainSha, sourceSha }: the
// copy's own first commit, and the source commit that was actually cloned.
// That is read from the clone itself rather than from the source's
// `main_sha`, which lags the repository while a deploy of a newer merge is
// still running.

// A copy is refused, before anything is cloned, where the git host is not
// set up: with createRepo's own error (services/github.js), which is where
// it would otherwise be refused, after the clone.
function gitHostNotConfigured() {
  return Object.assign(new Error('New repositories are made on Homeroom\'s git host, and it is not configured'), {
    code: 'git_host_not_configured',
  });
}

// Strip every `.git` under `dir` — the top-level repository directory and
// the `.git` FILE a submodule checkout leaves in its place — without
// descending into what is removed, and the top-level `.gitmodules`. In
// process, on fs alone: the runtime image has no bash, and the
// `find … -prune -exec rm` this replaces was the first "spawn bash ENOENT"
// a fork hit. A nested submodule's own .gitmodules is left as the plain
// file it now is, exactly as the find did.
async function flattenTree(dir) {
  await stripGitEntries(dir);
  // Top level only, as the find's companion `rm -f "$DIR/.gitmodules"` was.
  await fs.promises.rm(path.join(dir, '.gitmodules'), { force: true });
}
async function stripGitEntries(dir) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.name === '.git') {
      await fs.promises.rm(full, { recursive: true, force: true });
      continue;
    }
    // Symlinks are not directories here, and are not followed — as find
    // without -L did not.
    if (entry.isDirectory()) await stripGitEntries(full);
  }
}

async function copyRepoTree({ sourceApp, botUsername, forkSlug, forkName, tempDir }) {
  // The copy is made where new repositories are: Homeroom's git host
  // (botUsername is its organisation, services/github.js getBotUsername),
  // pushed as its service account. Without a git host, botUsername is a
  // GitHub account, where Homeroom makes no repository any more: copies were
  // pushed there with the bot's token, and GitHub suspended the bot
  // (services/github.js "Who Homeroom is on GitHub").
  if (repoRef.hostOfOwner(botUsername) !== 'git_host') throw gitHostNotConfigured();

  // Resolve the source clone URL from repo_url (fall back to bot/<slug>).
  const parsed = repoRef.ownerRepo(sourceApp.repo_url);
  const srcOwner = parsed ? parsed.owner : botUsername;
  const srcRepo = parsed ? parsed.repo : sourceApp.slug;
  const cloneUrl = await github.getCloneUrl(srcOwner, srcRepo);

  await docker.execFileAsync('rm', ['-rf', tempDir]).catch(() => {});
  try {
    await docker.execFileAsync('git', [
      'clone', '--depth', '1',
      '--recurse-submodules', '--shallow-submodules',
      cloneUrl, tempDir,
    ], { timeout: 120000 });
  } catch (err) {
    // Let deploy-failure classify this as a source-clone problem instead of
    // the undifferentiated `other` stage the old fork path exposed.
    err.cloneFailed = true;
    throw err;
  }

  // The source commit this copy is made from, read before the flatten below
  // removes the clone's .git. Lineage only: a copy whose source sha cannot
  // be read is still a good copy, so this never fails the fork.
  let sourceSha = null;
  try {
    const { stdout } = await docker.execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: tempDir, timeout: 30000,
    });
    sourceSha = String(stdout || '').trim() || null;
  } catch (err) {
    log.warn('app-forker', 'Could not read the cloned source commit', { forkSlug, err: err.message });
  }

  // Flatten to a history-free tree: strip every .git (the top-level dir and
  // any submodule .git files) plus .gitmodules, so `git add -A` commits
  // the materialised working tree (submodule contents become plain
  // files) rather than gitlinks. Then rewrite the display name.
  await flattenTree(tempDir);
  rewriteDappName(tempDir, forkName);
  writeConnectorScaffold(tempDir);

  // Create the fork's repository, then force-push our single squashed
  // commit over whatever it starts with. The git host's service account
  // answers that one push (services/git-host.js git, auth: true), and its
  // token never lands in argv or in an error.
  // adoptExisting: a fork retry after a partial failure re-uses the same
  // fork slug, so the repo may already exist — adopt it rather than
  // refusing; the force-push below overwrites its content.
  const repo = await github.createRepo(botUsername, forkSlug, {
    description: `${forkName}: forked on Homeroom`,
    adoptExisting: true,
  });
  const repoUrl = repo.html_url;
  // Only now is the fork's own URL known; still before the commit below.
  writeCanonicalRepoPointer(tempDir, repoUrl);

  // One git process per step, with the fork's tree as cwd — no shell in
  // between. The runtime image has no bash (node:22-alpine plus git and
  // postgresql-client, Dockerfile.kubernetes), so the `bash -c` script that
  // used to run these five commands failed with "spawn bash ENOENT" before
  // it wrote anything, and every fork with it.
  const git = (args, extra = {}) => docker.execFileAsync('git', args, {
    cwd: tempDir, timeout: 120000, ...extra,
  });
  let mainSha = null;
  try {
    await git(['init', '-q', '-b', 'main']);
    await git(['add', '-A']);
    // Homeroom's one identity (services/commit-identity.js).
    await git([
      ...commitIdentity.gitConfigArgs(),
      'commit', '-q', '-m', `Forked from ${sourceApp.slug}`,
    ]);
    const gitHost = require('./git-host');
    await gitHost.git(['-C', tempDir, 'push', '-q', '--force', gitHost.cloneUrl(forkSlug), 'HEAD:main'], { auth: true });
    const { stdout } = await git(['rev-parse', 'HEAD']);
    mainSha = (stdout || '').trim() || null;
  } catch (err) {
    // git-host.git redacts its token from the message already.
    const pushError = new Error(`fork repo push failed: ${String(err.message || '')}`);
    pushError.repoFailed = true;
    throw pushError;
  }

  return { repoUrl, mainSha, sourceSha };
}

// The two commits a copy's lineage records, from copyRepoTree's result.
// A value git did not give us is stored as null rather than left out, so a
// reader can tell "recorded, unknown" from a copy made before this existed.
function forkLineageShas(copied) {
  return {
    sourceSha: (copied && copied.sourceSha) || null,
    forkBaseSha: (copied && copied.mainSha) || null,
  };
}

// A copy gets the code, the look and the icon, and nothing that belongs to
// the original's people (app-creator.js copyFork, the setup's repository
// step, then its first deploy through app delivery):
//   - a NEW, EMPTY database (dbManager.createDatabase, as create does). The
//     app's own migrations are idempotent and build its tables on first
//     boot, so no row from the original comes over: not its posts, not its
//     per-user rows, not its leaderboards. An app that relied on seeded
//     public rows starts blank.
//   - no stored secrets. Not even the non-private ones: they are the
//     original's keys. A copy that needs a required key lands in the
//     ordinary `awaiting_secrets` state and its owner adds their own.
//     Platform-provided keys (DATABASE_URL, JWT_SECRET, the LLM proxy pair,
//     …) are never in app_secrets, so the deploy mints them.

module.exports = {
  copyRepoTree,
  findForkSource,
  flattenTree,
  rewriteDappName,
  forkLineageShas,
  FORK_STRIPPED_MANIFEST_KEYS,
};
