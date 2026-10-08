'use strict';

// "Suggest this back": send a remix's changes to the app it was copied from,
// as an ordinary proposal there.
//
// People see a fork as a "Remix" (their own copy). A copy records where it
// started in `apps.forked_from` (services/app-forker.js):
//
//   { appId, slug, sourceSha, forkBaseSha, forkedAt }
//
// `sourceSha` is the commit of the ORIGINAL that was cloned, and
// `forkBaseSha` the copy's own first commit: that clone, flattened, with the
// copy's name written into dapp.json. So `forkBaseSha..<copy's main>` is
// exactly what the copy's owner changed, and it applies onto `sourceSha` in
// the original. Copies made before those two fields existed carry only
// { appId, slug } and cannot use this; they get a plain sentence saying so.
//
// ── What is sent, and what is not ──────────────────────────────────────
//
// The diff is binary-safe (`--binary --full-index`) and leaves out what
// makes the copy a different app rather than a change to the original:
//
//   * `.claude/homeroom-canonical-repo`, which names the copy's own
//     repository (app-forker writeCanonicalRepoPointer);
//   * in dapp.json, the top-level `name`, `visibility`, `admins` and
//     `governance`. Any other key the copy changed is carried over onto the
//     ORIGINAL's dapp.json at `sourceSha`, so the original keeps its own
//     name, audience, admins and approval rule.
//
// Nothing of the copy's data, members or keys is in a repository, so nothing
// of them can travel.
//
// ── Who may send ───────────────────────────────────────────────────────
//
// The copy's owner (its creator), and only when they could take part in the
// original anyway: collab access (services/app-access.js), and membership of
// its community (the communities.requireAppMembership rule). A non-member
// with collab access is answered `join_required`, which the client's fetch
// wrapper turns into Join and a retry; somebody without collab access is told
// to ask to join. Version one is for the original's collaborators only.
//
// ── How it lands ───────────────────────────────────────────────────────
//
// The same chain demo mode and submit_work's patch path run in process
// (routes/demo-mode.js, services/external-agent-tasks.js):
// externalAgentPatch.applyPatch commits the diff at `sourceSha` in the
// original's bot-owned repository and pushes a fresh branch, createPR opens
// the pull request, and a `chat_sessions` row (`source = 'imported'`,
// `active`, owned by the copy's owner) makes it a proposal, whose preview and
// checks start as an import's do. The bounds are submit_work's: the
// promoted-proposal cap, 256 KB and 200 files, and nothing under `.github/`.
// One open suggestion per copy (`chat_sessions.suggested_from_app_id`, with
// a partial unique index behind the read).

const log = require('./logger');

const EXCLUDED_MANIFEST_KEYS = Object.freeze(['name', 'visibility', 'admins', 'governance']);
const EXCLUDED_PATHS = Object.freeze(['.claude/homeroom-canonical-repo']);
const MANIFEST_PATH = 'dapp.json';
const OPEN_STATUSES = Object.freeze(['active', 'promoted', 'merging']);
const SHA_RE = /^[0-9a-f]{40}$/i;
// The bounds submit_work's patch path holds (services/external-agent-patch.js
// MAX_PATCH_BYTES / MAX_PATCH_FILES), checked here first so the refusal is in
// words for the person who pressed Send rather than for a coding agent.
const MAX_PATCH_BYTES = 256 * 1024;
const MAX_PATCH_FILES = 200;
// How many commit subjects the confirmation lists before "and N more".
const MAX_LISTED_COMMITS = 20;

// What people read. Plain words; no em dashes (tests/no-em-dash-in-copy).
const MESSAGES = Object.freeze({
  notACopy: 'This project is not a remix, so there is nothing to suggest back.',
  notOwner: 'Only the person who made this copy can suggest it back.',
  lineageMissing: 'This copy was made before Homeroom kept track of where a remix starts, '
    + 'so its changes can’t be sent back from here.',
  originalGone: 'The app this copy came from no longer exists.',
  collabRequired: 'Ask to join to suggest changes.',
  noChanges: 'Your copy has no changes to send since you remixed it.',
  originalMoved: 'The original has changed too much since you remixed it.',
  tooLarge: 'Your changes are too big to send as one proposal (over 256 KB).',
  tooManyFiles: (n) => `Your changes touch ${n} files, more than the 200 one proposal can carry.`,
  forbiddenPath: (file) => `Your changes include ${file}. Changes under .github/ can’t be sent back.`,
  alreadyOpen: (name) => `You already sent this copy’s changes to ${name}, and that proposal is still open.`,
  noGithub: 'GitHub is not set up here, so changes can’t be sent back.',
  unavailable: 'Homeroom could not send your changes just now. Try again shortly.',
  prFailed: 'GitHub did not open the pull request, so nothing was sent.',
});

function refusal(status, code, error, extra = {}) {
  return { ok: false, status, body: { error, code, ...extra } };
}

function sha(value) {
  return typeof value === 'string' && SHA_RE.test(value) ? value.toLowerCase() : null;
}

/**
 * The lineage a copy's row carries, or null for an app that is not a copy.
 * `complete` is whether both commits this feature needs are recorded.
 */
function readLineage(row) {
  let ref = row ? row.forked_from : null;
  if (typeof ref === 'string') {
    try { ref = JSON.parse(ref); } catch { ref = null; }
  }
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  const appId = Number.isInteger(ref.appId) && ref.appId > 0 ? ref.appId : null;
  const sourceSha = sha(ref.sourceSha);
  const forkBaseSha = sha(ref.forkBaseSha);
  return {
    appId,
    slug: typeof ref.slug === 'string' ? ref.slug : null,
    sourceSha,
    forkBaseSha,
    complete: !!(appId && sourceSha && forkBaseSha),
  };
}

function parseJsonObject(text) {
  if (typeof text !== 'string') return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The original's dapp.json with the copy's own changes carried over, minus
 * the keys that make the copy a different app (EXCLUDED_MANIFEST_KEYS).
 *
 * `baseText` is dapp.json at the copy's first commit, `headText` at its
 * main, `targetText` at the original's `sourceSha` (null when absent). Each
 * top-level key the copy added, changed or removed, other than the excluded
 * ones, is applied to the target; key order is the target's, with new keys
 * after it. Returns { changed: false } when nothing applies, and
 * { changed: true, text, keys } otherwise. A dapp.json that does not parse
 * on either side of the copy is left alone (`unreadable: true`): there is no
 * telling which of its keys changed. Pure.
 */
function mergeManifest(baseText, headText, targetText) {
  if (baseText === headText) return { changed: false };
  const base = baseText == null ? {} : parseJsonObject(baseText);
  const head = headText == null ? {} : parseJsonObject(headText);
  if (!base || !head) return { changed: false, unreadable: true };
  const keys = [];
  for (const key of new Set([...Object.keys(base), ...Object.keys(head)])) {
    if (EXCLUDED_MANIFEST_KEYS.includes(key)) continue;
    if (!sameJson(base[key], head[key])) keys.push(key);
  }
  if (!keys.length) return { changed: false };
  const target = targetText == null ? {} : parseJsonObject(targetText);
  if (!target) return { changed: false, unreadable: true };
  const next = { ...target };
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(head, key)) next[key] = head[key];
    else delete next[key];
  }
  if (sameJson(next, target)) return { changed: false };
  return { changed: true, text: `${JSON.stringify(next, null, 2)}\n`, keys };
}

/** The pathspec for everything but dapp.json and the excluded paths. */
function diffPathspec() {
  return ['.', `:(exclude)${MANIFEST_PATH}`, ...EXCLUDED_PATHS.map((p) => `:(exclude)${p}`)];
}

/**
 * The bounds a patch must meet before anything is pushed, as the refusal a
 * person reads, or null. `files` is every path the patch writes.
 */
function checkPatch({ patch, files }) {
  const list = Array.isArray(files) ? files : [];
  const blocked = list.find((file) => {
    const p = String(file || '').replace(/\\/g, '/');
    return p === '.github' || p.startsWith('.github/');
  });
  if (blocked) return refusal(400, 'forbidden_path', MESSAGES.forbiddenPath(blocked));
  if (list.length > MAX_PATCH_FILES) {
    return refusal(413, 'too_many_files', MESSAGES.tooManyFiles(list.length));
  }
  if (Buffer.byteLength(String(patch || ''), 'utf8') > MAX_PATCH_BYTES) {
    return refusal(413, 'too_large', MESSAGES.tooLarge);
  }
  return null;
}

async function showFile(git, rev, file) {
  try {
    const { stdout } = await git(['show', `${rev}:${file}`]);
    return String(stdout);
  } catch {
    return null;
  }
}

/**
 * Build the patch in a scratch repository (`git` is
 * external-agent-head.withScratchRepo's runner, `dir` its directory).
 * Fetches the copy's two commits and, only when dapp.json needs carrying
 * over, the original's `sourceSha`. Returns { patch, files, manifestKeys }.
 */
async function buildPatch({ git, dir, copyRemote, originalRemote, forkBaseSha, copyHeadSha, sourceSha }) {
  await git(['fetch', '--no-tags', '--depth', '1', copyRemote, forkBaseSha, copyHeadSha]);
  const spec = diffPathspec();
  const { stdout: body } = await git([
    'diff', '--binary', '--full-index', '--no-renames', forkBaseSha, copyHeadSha, '--', ...spec,
  ]);
  const { stdout: names } = await git([
    'diff', '--name-only', '--no-renames', forkBaseSha, copyHeadSha, '--', ...spec,
  ]);
  const files = String(names || '').split('\n').map((s) => s.trim()).filter(Boolean);
  let patch = String(body || '');

  // dapp.json: the copy's changes to it, minus the excluded keys, carried
  // over onto the ORIGINAL's dapp.json at sourceSha, and diffed against
  // that. The original is fetched only when the copy changed the file.
  let manifestKeys = [];
  const baseText = await showFile(git, forkBaseSha, MANIFEST_PATH);
  const headText = await showFile(git, copyHeadSha, MANIFEST_PATH);
  if (baseText !== headText) {
    await git(['fetch', '--no-tags', '--depth', '1', originalRemote, sourceSha]);
    const targetText = await showFile(git, sourceSha, MANIFEST_PATH);
    const merged = mergeManifest(baseText, headText, targetText);
    if (merged.changed) {
      const fs = require('fs/promises');
      const path = require('path');
      const file = path.join(dir, '.usernode-suggest-manifest.json');
      await fs.writeFile(file, merged.text, 'utf8');
      const { stdout: blob } = await git(['hash-object', '-w', file]);
      await git(['read-tree', sourceSha]);
      await git(['update-index', '--add', '--cacheinfo', `100644,${String(blob).trim()},${MANIFEST_PATH}`]);
      const { stdout: tree } = await git(['write-tree']);
      const { stdout: manifestDiff } = await git([
        'diff', '--binary', '--full-index', sourceSha, String(tree).trim(), '--', MANIFEST_PATH,
      ]);
      if (String(manifestDiff || '').trim()) {
        if (patch && !patch.endsWith('\n')) patch += '\n';
        patch += String(manifestDiff);
        files.push(MANIFEST_PATH);
        manifestKeys = merged.keys;
      }
    }
  }
  return { patch, files, manifestKeys };
}

function defaultDeps() {
  return {
    github: require('./github'),
    head: require('./external-agent-head'),
    externalAgentPatch: require('./external-agent-patch'),
    appAccess: require('./app-access'),
    communities: require('./communities'),
    limits: require('./connector-limits'),
    topicAttrs: require('./topic-attributes'),
    prImportSync: require('./pr-import-sync'),
    ws: require('./ws'),
  };
}

function appRef(app) {
  return { slug: app.slug, name: app.name || app.slug };
}

/**
 * Everything that decides whether `user` may send `fork`'s changes back,
 * short of building the patch. Shared by the preview and the send, so the
 * dialog and the button can never disagree. Resolves
 * { ok: true, lineage, original } or a refusal { ok: false, status, body }.
 */
async function evaluate({ pool, user, fork, deps }) {
  const lineage = readLineage(fork);
  if (!lineage) return refusal(409, 'not_a_copy', MESSAGES.notACopy);
  if (!user || fork.created_by !== user.id) return refusal(403, 'not_owner', MESSAGES.notOwner);

  let original = null;
  if (lineage.appId) {
    const { rows } = await pool.query('SELECT * FROM apps WHERE id = $1', [lineage.appId]);
    original = rows[0] || null;
  }
  if (!original || original.self_hosted) return refusal(409, 'original_gone', MESSAGES.originalGone);
  if (!(await deps.appAccess.checkAppAccess(pool, original, user, 'view'))) {
    return refusal(409, 'original_gone', MESSAGES.originalGone);
  }
  if (!lineage.complete) {
    return refusal(409, 'lineage_missing', MESSAGES.lineageMissing, { original: appRef(original) });
  }
  // Collaborators of the original only, for now. Admins pass, as they do
  // every collab guard.
  if (!(await deps.appAccess.checkAppAccess(pool, original, user, 'collab'))) {
    return refusal(403, 'collab_required', MESSAGES.collabRequired, { app: appRef(original), original: appRef(original) });
  }
  // The communities.requireAppMembership rule, on the ORIGINAL: someone
  // who may build there but has not joined is asked to Join (the client's
  // fetch wrapper does the asking and the retry).
  if (!user.isAdmin && original.community_id != null
    && !(await deps.communities.isMember(pool, original.id, user.id))) {
    return {
      ok: false,
      status: 403,
      body: { ...deps.communities.joinRequiredBody(original), original: appRef(original) },
      original,
    };
  }
  return { ok: true, lineage, original };
}

/** The open suggestion this copy already has on the original, or null. */
async function openSuggestion(pool, fork) {
  const { rows } = await pool.query(
    `SELECT cs.id, a.slug
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
      WHERE cs.suggested_from_app_id = $1
        AND cs.status IN ('active', 'promoted', 'merging')
      ORDER BY cs.id DESC
      LIMIT 1`,
    [fork.id]
  );
  return rows[0] ? { sessionId: rows[0].id, href: proposalHref(rows[0].slug, rows[0].id) } : null;
}

function proposalHref(slug, sessionId) {
  return `#app/${encodeURIComponent(slug)}/dev/proposals/${sessionId}`;
}

function repoOf(deps, app) {
  return deps.github.parseGithubUrl(app && app.repo_url ? app.repo_url : '');
}

/**
 * What the confirmation shows: the original, the commit subjects since the
 * remix (newest last, at most MAX_LISTED_COMMITS), how many files they
 * touch, and whether Send can go ahead (`reason` is the refusal it would
 * meet, which the dialog says in place of the list).
 */
async function preview({ pool, user, fork, deps = defaultDeps() }) {
  const copy = appRef(fork);
  const verdict = await evaluate({ pool, user, fork, deps });
  if (!verdict.ok && verdict.body.code !== 'join_required') {
    return {
      copy,
      original: verdict.body.original || null,
      ready: false,
      reason: { code: verdict.body.code, error: verdict.body.error },
      commits: [],
      commitCount: 0,
      fileCount: 0,
      open: null,
    };
  }
  // A join_required verdict still names the original: Send stays offered,
  // and the press that meets the refusal is asked to Join first.
  const { original } = verdict;
  const lineage = readLineage(fork);
  const open = await openSuggestion(pool, fork);
  let commits = [];
  let commitCount = 0;
  let fileCount = 0;
  const copyRepo = repoOf(deps, fork);
  if (copyRepo && deps.github.isEnabled()) {
    try {
      const compared = await deps.github.compareCommitSubjects(
        // A copy's repository is the platform's own, always on `main`
        // (app-forker pushes HEAD:main).
        copyRepo.owner, copyRepo.repo, lineage.forkBaseSha, 'main'
      );
      commitCount = compared.totalCommits;
      commits = compared.commits.slice(-MAX_LISTED_COMMITS).map((c) => c.subject).filter(Boolean);
      fileCount = compared.files.filter((f) => !EXCLUDED_PATHS.includes(f)).length;
    } catch (err) {
      log.warn('suggest-back', 'Could not list the copy’s commits', { slug: fork.slug, err: err.message });
    }
  }
  return {
    copy,
    original: appRef(original),
    ready: !open && verdict.ok,
    reason: open
      ? { code: 'already_open', error: MESSAGES.alreadyOpen(original.name || original.slug) }
      : (verdict.ok ? null : { code: verdict.body.code, error: verdict.body.error }),
    commits,
    commitCount,
    fileCount,
    open,
  };
}

function prTitle(copyName, subjects) {
  const one = subjects.length === 1 ? subjects[0] : null;
  return (one ? `${one} (from ${copyName})` : `Changes from ${copyName}`).slice(0, 256);
}

function prBody({ copy, user, subjects, manifestKeys }) {
  const lines = [
    `Suggested back from **${copy.name}**, a remix of this app, by ${user.username || 'its owner'}.`,
    '',
  ];
  if (subjects.length) {
    lines.push('Changes since the remix:', '');
    for (const s of subjects.slice(-MAX_LISTED_COMMITS)) lines.push(`- ${s}`);
    if (subjects.length > MAX_LISTED_COMMITS) lines.push(`- and ${subjects.length - MAX_LISTED_COMMITS} more`);
    lines.push('');
  }
  if (manifestKeys.length) {
    lines.push(`dapp.json: carries over ${manifestKeys.map((k) => `\`${k}\``).join(', ')}.`, '');
  }
  lines.push(`Not sent: ${copy.name}’s name, who can see it, its admins or its data.`);
  return lines.join('\n');
}

/**
 * Send the copy's changes to the original as a proposal. Resolves
 * { ok: true, sessionId, prNumber, prUrl, href, original } or a refusal
 * { ok: false, status, body }.
 */
async function suggest({ pool, config, user, fork, deps = defaultDeps() }) {
  const verdict = await evaluate({ pool, user, fork, deps });
  if (!verdict.ok) return verdict;
  const { lineage, original } = verdict;

  const capError = await deps.limits.checkPromotedCap(pool, config, user);
  if (capError) return refusal(429, capError.code, capError.message);

  const open = await openSuggestion(pool, fork);
  if (open) {
    return refusal(409, 'already_open', MESSAGES.alreadyOpen(original.name || original.slug), { open });
  }

  const copyRepo = repoOf(deps, fork);
  const originalRepo = repoOf(deps, original);
  if (!copyRepo || !originalRepo || !deps.github.isEnabled()) {
    return refusal(409, 'no_github', MESSAGES.noGithub);
  }

  let copyHeadSha = null;
  try {
    const live = await deps.github.getRepoHead(copyRepo.owner, copyRepo.repo);
    copyHeadSha = sha(live && live.headSha);
  } catch (err) {
    log.warn('suggest-back', 'Could not read the copy’s head', { slug: fork.slug, err: err.message });
  }
  copyHeadSha = copyHeadSha || sha(fork.main_sha);
  if (!copyHeadSha) return refusal(503, 'platform_unavailable', MESSAGES.unavailable);
  if (copyHeadSha === lineage.forkBaseSha) return refusal(409, 'no_changes', MESSAGES.noChanges);

  let subjects = [];
  try {
    const compared = await deps.github.compareCommitSubjects(
      copyRepo.owner, copyRepo.repo, lineage.forkBaseSha, copyHeadSha
    );
    subjects = compared.commits.map((c) => c.subject).filter(Boolean);
  } catch (err) {
    log.warn('suggest-back', 'Could not list the copy’s commits for the PR body', { slug: fork.slug, err: err.message });
  }

  // ── The patch ──────────────────────────────────────────────────────
  let built;
  let credential;
  try {
    credential = await deps.head.resolveWriteCredential(originalRepo.owner);
    built = await deps.head.withScratchRepo(`suggest-${fork.id}`, ({ dir, git }) => buildPatch({
      git,
      dir,
      copyRemote: deps.head.authenticatedRemote(credential.token, copyRepo.owner, copyRepo.repo),
      originalRemote: deps.head.authenticatedRemote(credential.token, originalRepo.owner, originalRepo.repo),
      forkBaseSha: lineage.forkBaseSha,
      copyHeadSha,
      sourceSha: lineage.sourceSha,
    }));
  } catch (err) {
    log.error('suggest-back', 'Building the patch failed', {
      slug: fork.slug,
      err: deps.head.redactToken(err && (err.stderr || err.message), credential && credential.token),
    });
    return refusal(503, 'platform_unavailable', MESSAGES.unavailable);
  }
  if (!built.patch.trim() || !built.files.length) return refusal(409, 'no_changes', MESSAGES.noChanges);
  const bounded = checkPatch(built);
  if (bounded) return bounded;

  // ── Apply at the commit the copy was cut from, on the original ─────
  const applied = await deps.externalAgentPatch.applyPatch({
    owner: originalRepo.owner,
    repo: originalRepo.repo,
    patch: built.patch,
    baseSha: lineage.sourceSha,
    userId: user.id,
    taskId: `s${fork.id}`,
  });
  if (!applied.ok) {
    if (applied.code === 'patch_did_not_apply') return refusal(409, 'original_moved', MESSAGES.originalMoved);
    if (applied.code === 'patch_too_large') return refusal(413, 'too_large', MESSAGES.tooLarge);
    if (applied.code === 'patch_rejected') return refusal(413, 'too_many_files', MESSAGES.tooManyFiles(built.files.length));
    return refusal(503, 'platform_unavailable', MESSAGES.unavailable);
  }

  const copy = appRef(fork);
  let pr;
  try {
    pr = await deps.github.createPR(originalRepo.owner, originalRepo.repo, {
      branch: applied.branch,
      title: prTitle(copy.name, subjects),
      body: prBody({ copy, user, subjects, manifestKeys: built.manifestKeys }),
    });
  } catch (err) {
    await Promise.resolve(applied.cleanup && applied.cleanup()).catch(() => {});
    log.error('suggest-back', 'Opening the PR failed', { slug: fork.slug, err: err.message });
    return refusal(502, 'pr_failed', MESSAGES.prFailed);
  }

  const botLogin = await deps.github.getBotUsername().catch(() => null);
  const title = (pr.title || prTitle(copy.name, subjects)).slice(0, 256);
  const body = pr.body || null;
  let sessionId;
  try {
    const { rows } = await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_number, pr_url, pr_title, status,
          source, imported_pr_head_sha, handoff_base_sha, imported_pr_author,
          imported_pr_head_repo, shared_at, created_at, pr_body, suggested_from_app_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'active',
          'imported', $7, $8, $9,
          $10, NOW(), NOW(), $11, $12)
       RETURNING id`,
      [
        original.id, user.id, applied.branch, pr.number, pr.html_url || null, title,
        applied.headSha, sha(pr.base && pr.base.sha) || lineage.sourceSha, botLogin,
        `${originalRepo.owner}/${originalRepo.repo}`, body, fork.id,
      ]
    );
    sessionId = rows[0].id;
  } catch (err) {
    // Two presses racing past the read above meet the partial unique index.
    // The pull request this call opened then has no proposal: close it and
    // take its branch away rather than leave litter in the original.
    await deps.github.closePR(originalRepo.owner, originalRepo.repo, pr.number).catch(() => {});
    await Promise.resolve(applied.cleanup && applied.cleanup()).catch(() => {});
    if (err && err.code === '23505') {
      return refusal(409, 'already_open', MESSAGES.alreadyOpen(original.name || original.slug));
    }
    throw err;
  }

  try {
    await deps.topicAttrs.selfAssignProposal(pool, original.id, sessionId, user);
  } catch (err) {
    log.warn('suggest-back', 'Self-assign failed (non-fatal)', { sessionId, err: err.message });
  }
  try {
    deps.ws.pushSessionUpdate({ action: 'imported', sessionId, appSlug: original.slug });
  } catch { /* a missed push is repaired by the next list read */ }

  const session = {
    id: sessionId, app_id: original.id, app_slug: original.slug, user_id: user.id,
    branch_name: applied.branch, pr_number: pr.number, pr_url: pr.html_url || null,
    pr_title: title, pr_body: body, repo_url: original.repo_url, staging_url: null,
    source: 'imported', status: 'active', imported_pr_head_sha: applied.headSha,
    imported_pr_head_repo: `${originalRepo.owner}/${originalRepo.repo}`,
    testing_md: null, testing_path: null, testing_paths: null,
  };
  // Preview + checks, exactly as an import gets them. Never throws.
  deps.prImportSync.kickImportedChecks({
    config, pool, session,
    app: { id: original.id, slug: original.slug, name: original.name, repo_url: original.repo_url },
    headSha: applied.headSha,
  });

  log.info('suggest-back', 'Suggestion sent', {
    copy: fork.slug, original: original.slug, sessionId, prNumber: pr.number, files: built.files.length,
  });
  return {
    ok: true,
    sessionId,
    prNumber: pr.number,
    prUrl: pr.html_url || null,
    href: proposalHref(original.slug, sessionId),
    original: appRef(original),
  };
}

module.exports = {
  EXCLUDED_MANIFEST_KEYS,
  EXCLUDED_PATHS,
  OPEN_STATUSES,
  MAX_PATCH_BYTES,
  MAX_PATCH_FILES,
  MESSAGES,
  readLineage,
  mergeManifest,
  diffPathspec,
  checkPatch,
  buildPatch,
  evaluate,
  preview,
  suggest,
  proposalHref,
};
