'use strict';

// "Suggest to <original>": send a version's own changes to the project it
// was made from, as an ordinary proposal there (docs/plans/versions.md,
// "Suggestions up"). Ids, routes and code keep `suggest-back`: tests and
// dapp.json checks select on them.
//
// A version records where it started in `apps.upstream`
// (services/upstream-lineage.js):
//
//   { appId, slug, following, syncedSha, baseSha, share, legacy, since }
//
// `syncedSha` is the ORIGINAL's commit the version last took, and `baseSha`
// a commit in the VERSION's repository whose tree is the original at
// `syncedSha` as it looks in this version (its first commit, then each
// update's "theirs" commit). A copy from before versions keeps the older
// `forked_from` ({ appId, slug, sourceSha, forkBaseSha, forkedAt }), read as
// the same two when it has no link yet; a legacy link has its commits found
// when first needed (upstream-lineage.resolveLegacy). A copy whose commits
// cannot be found gets a plain sentence saying so.
//
// ── What can be sent ───────────────────────────────────────────────────
//
// "Your changes" are the commits on the version's main since `baseSha` that
// are the version's own: not the updates it took from the original (a
// commit whose proposal came from there, `upstream_from_app_id`, or whose
// subject starts "Update from "). The preview lists them ({ sha, title },
// newest last), and the send takes `picks` (default all of them).
//
// Each picked commit travels on its own (`git format-patch`), binary-safe,
// without what makes the version a different project rather than a change
// to the original (upstream-lineage: words.json, its repository pointer,
// README.md, CLAUDE.md, LICENSE; and in dapp.json its name, visibility,
// admins, governance, description and followOriginal). Any other dapp.json
// key a picked commit changed is carried over onto the ORIGINAL's dapp.json
// at `syncedSha`, as one last patch, so the original keeps its own name,
// audience, admins and approval rule. The picks are applied first on the
// version's own `baseSha`: one that does not apply there builds on a change
// that was not picked, and is refused in words saying so. Then they are
// applied on the original at `syncedSha` with `git am --3way`.
//
// Nothing of the version's data, members or keys is in a repository, so
// nothing of them can travel.
//
// ── Who may send ───────────────────────────────────────────────────────
//
// The version's owner (its creator), and only when they could take part in
// the original anyway: collab access (services/app-access.js), and
// membership of its community (the communities.requireAppMembership rule).
// A non-member with collab access is answered `join_required`, which the
// client's fetch wrapper turns into Join and a retry; somebody without
// collab access is told to ask to join.
//
// ── How it lands ───────────────────────────────────────────────────────
//
// The same chain demo mode and submit_work's patch path run in process
// (routes/demo-mode.js, services/external-agent-tasks.js):
// externalAgentPatch.applyPatch applies the mbox at `syncedSha` in the
// original's repository (`git am --3way`) and pushes a fresh branch,
// createPR opens the pull request ("Suggested by <version>: <titles>"), and
// a `chat_sessions` row (`source = 'imported'`, `active`, owned by the
// version's owner) makes it a proposal, whose preview and checks start as an
// import's do. The bounds are submit_work's: the promoted-proposal cap,
// 256 KB and 200 files, and nothing under `.github/`. One open suggestion
// per version (`chat_sessions.suggested_from_app_id`, with a partial unique
// index behind the read).

const log = require('./logger');
const repoRef = require('./repo-ref');
const lineage = require('./upstream-lineage');

// What never travels, as upstream-lineage says it for both directions.
const EXCLUDED_MANIFEST_KEYS = lineage.EXCLUDED_MANIFEST_KEYS;
const EXCLUDED_PATHS = lineage.EXCLUDED_PATHS;
const MANIFEST_PATH = lineage.MANIFEST_PATH;
const OPEN_STATUSES = Object.freeze(['active', 'promoted', 'merging']);
const SHA_RE = /^[0-9a-f]{40}$/i;
// The bounds submit_work's patch path holds (services/external-agent-patch.js
// MAX_PATCH_BYTES / MAX_PATCH_FILES), checked here first so the refusal is in
// words for the person who pressed Send rather than for a coding agent.
const MAX_PATCH_BYTES = 256 * 1024;
const MAX_PATCH_FILES = 200;
// How many commit subjects the confirmation lists before "and N more".
const MAX_LISTED_COMMITS = 20;
// How many of the version's own changes the pick list offers (the newest).
const MAX_CHANGES = 100;
// The subject an update's merge carries (services/upstream-offers.js), for a
// merge whose proposal row is gone.
const UPDATE_SUBJECT = /^Update from /;
// git's empty tree, the parent side of a version's very first commit.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// What people read. Plain words; no em dashes (tests/no-em-dash-in-copy).
const MESSAGES = Object.freeze({
  notACopy: 'This project was not made from another one, so there is nothing to suggest.',
  notOwner: 'Only the person who made this version can suggest its changes.',
  lineageMissing: 'This version was made before Homeroom kept track of where a version starts, '
    + 'so its changes can’t be sent from here.',
  originalGone: 'The project this version came from no longer exists.',
  collabRequired: 'Ask to join to suggest changes.',
  noChanges: 'Your version has no changes to send since you made it.',
  originalMoved: 'The original has changed too much since you made your version.',
  tooLarge: 'Your changes are too big to send as one proposal (over 256 KB).',
  tooManyFiles: (n) => `Your changes touch ${n} files, more than the 200 one proposal can carry.`,
  forbiddenPath: (file) => `Your changes include ${file}. Changes under .github/ can’t be suggested.`,
  alreadyOpen: (name) => `You already suggested this version’s changes to ${name}, and that proposal is still open.`,
  noGithub: 'No code host is set up here, so changes can’t be suggested.',
  unavailable: 'Homeroom could not send your changes just now. Try again shortly.',
  prFailed: 'The code host did not open the pull request, so nothing was sent.',
  nothingPicked: 'Pick at least one of your changes to suggest.',
  unknownPick: 'One of the changes you picked is not one of this version’s own changes. Open the list again and pick from it.',
  dependsOnUnpicked: (title) => `“${title}” builds on one of your changes you did not pick. `
    + 'Pick that one too, or leave this one out.',
});

function refusal(status, code, error, extra = {}) {
  return { ok: false, status, body: { error, code, ...extra } };
}

function sha(value) {
  return typeof value === 'string' && SHA_RE.test(value) ? value.toLowerCase() : null;
}

/**
 * The older lineage a copy's row carries in `forked_from`, or null for an
 * app that is not a copy. `complete` is whether both commits are recorded.
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

/**
 * A version's link to its original, as suggestions read it: `apps.upstream`
 * when it has one, else the older `forked_from` under the same names.
 * Resolves { appId, slug, syncedSha, baseSha, legacy, complete } or null for
 * a project that is not a version. Pure.
 */
function readLink(row) {
  const up = lineage.readUpstream(row);
  if (up) {
    return {
      appId: up.appId, slug: up.slug, syncedSha: up.syncedSha, baseSha: up.baseSha,
      legacy: up.legacy, upstream: true, complete: lineage.planned(up),
    };
  }
  const old = readLineage(row);
  if (!old) return null;
  return {
    appId: old.appId, slug: old.slug, syncedSha: old.sourceSha, baseSha: old.forkBaseSha,
    legacy: false, upstream: false, complete: old.complete,
  };
}

/**
 * The original's dapp.json with the version's changes to it carried over,
 * minus the keys that never travel (upstream-lineage.mergeManifest). Kept
 * under this name for its callers. Pure.
 */
function mergeManifest(baseText, headText, targetText) {
  return lineage.mergeManifest(baseText, headText, targetText);
}

/** The pathspec for everything but dapp.json and the paths that never travel. */
function diffPathspec() {
  return lineage.diffPathspec();
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

// A commit's parent, or git's empty tree for a first commit.
async function parentOf(git, commit) {
  try {
    const { stdout } = await git(['rev-parse', '--verify', '--quiet', `${commit}^`]);
    return String(stdout).trim() || EMPTY_TREE;
  } catch {
    return EMPTY_TREE;
  }
}

// A change's title: its subject without the "(#N)" its merge added.
function titleOf(subject) {
  return String(subject || '').trim().replace(/\s+\(#\d+\)$/, '');
}

class DependsOnUnpicked extends Error {
  constructor(pick) {
    super('depends_on_unpicked');
    this.pick = pick;
  }
}

// The picks do not apply on the original as the version last took it, even
// with every one of the version's changes: the original's own changes are in
// the way.
class DoesNotFit extends Error {
  constructor(pick) {
    super('does_not_fit');
    this.pick = pick;
  }
}

// One commit's own change as a mail (`git format-patch`), without the paths
// that never travel, and what it did to dapp.json. `mail` is null when the
// commit changed nothing that travels.
async function commitPatch(git, commit, spec) {
  const parent = await parentOf(git, commit.sha);
  const { stdout: names } = await git(['diff', '--name-only', '--no-renames', parent, commit.sha, '--', ...spec]);
  const touched = String(names || '').split('\n').map((x) => x.trim()).filter(Boolean);
  let mail = null;
  if (touched.length) {
    const { stdout } = await git([
      'format-patch', '-1', '--stdout', '--binary', '--full-index', '--no-renames',
      ...(parent === EMPTY_TREE ? ['--root'] : []), commit.sha, '--', ...spec,
    ]);
    mail = String(stdout || '').trim() ? String(stdout) : null;
  }
  const before = parent === EMPTY_TREE ? null : await showFile(git, parent, MANIFEST_PATH);
  const after = await showFile(git, commit.sha, MANIFEST_PATH);
  return { commit, mail, touched: mail ? touched : [], manifest: before !== after ? { before, after } : null };
}

// Apply `patches` on `baseSha` in turn (`git am --3way`), from a clean
// checkout. Resolves the index of the first that does not apply, or -1.
async function firstMisfit(git, dir, baseSha, patches) {
  const fs = require('fs/promises');
  const path = require('path');
  await git(['am', '--abort']).catch(() => {});
  await git(['checkout', '-q', '-f', '--detach', baseSha]);
  for (const [i, p] of patches.entries()) {
    const file = path.join(dir, `.usernode-pick-${i}.patch`);
    await fs.writeFile(file, p.mail);
    try {
      await git(['am', '--3way', '--keep-non-patch', '--quiet', file]);
    } catch {
      await git(['am', '--abort']).catch(() => {});
      return i;
    } finally {
      await fs.rm(file, { force: true }).catch(() => {});
    }
  }
  return -1;
}

/**
 * Build the patch in a scratch repository (`git` is
 * external-agent-head.withScratchRepo's runner, `dir` its directory): an
 * mbox of the picked commits, each `git format-patch` of its own change
 * without the paths that never travel, then, when a pick changed dapp.json
 * keys that travel, one more message carrying them over onto the original's
 * dapp.json at `syncedSha`.
 *
 * The two fetches from the repositories (`copyRemote`, `originalRemote`,
 * credential-free addresses) are the only invocations handed `credential`
 * (external-agent-head.resolveWriteCredential): `git am` and the rest run
 * on the version's commits with none.
 *
 * `changes` are all the version's own changes and `picks` the chosen ones,
 * [{ sha, title }] oldest first. The picks are applied on the version's
 * `baseSha` in turn first. One that does not apply there, when all of the
 * version's changes together do, builds on a change that was not picked
 * (DependsOnUnpicked); one that does not apply even then does not fit the
 * original as the version last took it (DoesNotFit). Resolves
 * { patch, files, manifestKeys, sent: [titles] }.
 */
async function buildPatch({
  git, dir, copyRemote, originalRemote, credential = null, baseSha, copyHeadSha, syncedSha, picks, changes = picks,
}) {
  await git(['fetch', '--no-tags', copyRemote, baseSha, copyHeadSha], { credential });
  const spec = diffPathspec();
  const fs = require('fs/promises');
  const path = require('path');

  const made = new Map();
  const patchOf = async (c) => {
    if (!made.has(c.sha)) made.set(c.sha, await commitPatch(git, c, spec));
    return made.get(c.sha);
  };
  const picked = [];
  for (const pick of picks) picked.push(await patchOf(pick));
  const messages = picked.filter((p) => p.mail);

  if (messages.length) {
    const misfit = await firstMisfit(git, dir, baseSha, messages);
    if (misfit !== -1) {
      const failing = messages[misfit].commit;
      if (picks.length < changes.length) {
        const all = [];
        for (const c of changes) all.push(await patchOf(c));
        if (await firstMisfit(git, dir, baseSha, all.filter((p) => p.mail)) === -1) {
          throw new DependsOnUnpicked(failing);
        }
      }
      throw new DoesNotFit(failing);
    }
  }

  const files = new Set();
  for (const m of messages) for (const f of m.touched) files.add(f);
  let patch = messages.map((m) => (m.mail.endsWith('\n') ? m.mail : `${m.mail}\n`)).join('');

  // dapp.json: each pick's changes to it, minus the keys that never travel,
  // carried over in turn onto the ORIGINAL's dapp.json at syncedSha, and
  // sent as one more commit on top of it. The original is fetched only when
  // a pick changed the file.
  let manifestKeys = [];
  const manifestSteps = picked.map((p) => p.manifest).filter(Boolean);
  if (manifestSteps.length) {
    await git(['fetch', '--no-tags', '--depth', '1', originalRemote, syncedSha], { credential });
    const targetText = await showFile(git, syncedSha, MANIFEST_PATH);
    let text = targetText;
    const keys = new Set();
    for (const step of manifestSteps) {
      const merged = mergeManifest(step.before, step.after, text);
      if (merged.changed) {
        text = merged.text;
        for (const k of merged.keys) keys.add(k);
      }
    }
    if (text !== targetText) {
      const file = path.join(dir, '.usernode-suggest-manifest.json');
      await fs.writeFile(file, text, 'utf8');
      const { stdout: blob } = await git(['hash-object', '-w', file]);
      await fs.rm(file, { force: true }).catch(() => {});
      await git(['read-tree', syncedSha]);
      await git(['update-index', '--add', '--cacheinfo', `100644,${String(blob).trim()},${MANIFEST_PATH}`]);
      const { stdout: tree } = await git(['write-tree']);
      const { stdout: commit } = await git([
        'commit-tree', String(tree).trim(), '-p', syncedSha, '-m', 'Carry over dapp.json settings',
      ]);
      const { stdout: mail } = await git([
        'format-patch', '-1', '--stdout', '--binary', '--full-index', String(commit).trim(),
      ]);
      if (String(mail || '').trim()) {
        patch += String(mail);
        files.add(MANIFEST_PATH);
        manifestKeys = [...keys];
      }
    }
  }
  return { patch, files: [...files], manifestKeys, sent: messages.map((m) => m.commit.title) };
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
    lineage,
  };
}

function appRef(app) {
  return { slug: app.slug, name: app.name || app.slug };
}

/**
 * Everything that decides whether `user` may send `fork`'s changes, short
 * of building the patch. Shared by the preview and the send, so the dialog
 * and the button can never disagree. A legacy link has its two commits
 * looked for here (upstream-lineage.resolveLegacy). Resolves
 * { ok: true, link, original } or a refusal { ok: false, status, body }.
 */
async function evaluate({ pool, config = {}, user, fork, deps }) {
  let link = readLink(fork);
  if (!link) return refusal(409, 'not_a_copy', MESSAGES.notACopy);
  if (!user || fork.created_by !== user.id) return refusal(403, 'not_owner', MESSAGES.notOwner);

  let original = null;
  if (link.appId) {
    const { rows } = await pool.query('SELECT * FROM apps WHERE id = $1', [link.appId]);
    original = rows[0] || null;
  }
  if (!original || original.self_hosted) return refusal(409, 'original_gone', MESSAGES.originalGone);
  if (!(await deps.appAccess.checkAppAccess(pool, original, user, 'view'))) {
    return refusal(409, 'original_gone', MESSAGES.originalGone);
  }
  if (!link.complete && link.upstream) {
    const resolver = deps.lineage || lineage;
    const resolved = await resolver.resolveLegacy(config, pool, fork).catch(() => null);
    if (resolved && lineage.planned(resolved)) {
      link = { ...link, syncedSha: resolved.syncedSha, baseSha: resolved.baseSha, legacy: false, complete: true };
    }
  }
  if (!link.complete) {
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
      link,
    };
  }
  return { ok: true, link, original };
}

/** The open suggestion this version already has on the original, or null. */
async function openSuggestion(pool, fork) {
  const { rows } = await pool.query(
    `SELECT cs.id, cs.pr_number, a.slug
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
      WHERE cs.suggested_from_app_id = $1
        AND cs.status IN ('active', 'promoted', 'merging')
      ORDER BY cs.id DESC
      LIMIT 1`,
    [fork.id]
  );
  return rows[0] ? { sessionId: rows[0].id, href: proposalHref(rows[0].slug, rows[0].id, rows[0].pr_number) } : null;
}

// #4367: by its pull request's number once it has one.
function proposalHref(slug, sessionId, prNumber = null) {
  return require('./change-destination').changeHref(slug, sessionId, prNumber);
}

function repoOf(deps, app) {
  return repoRef.ownerRepo(app && app.repo_url);
}

/**
 * The version's own changes since `baseSha` up to `head`, oldest first, as
 * [{ sha, title }]: the commits on its main that are not the updates it
 * took from the original (a commit an update's proposal merged, or one
 * whose subject says it is an update). Also the files they touch.
 */
async function ownChanges({ pool, deps, fork, link, head }) {
  const repo = repoOf(deps, fork);
  const compared = await deps.github.compareCommitSubjects(repo.owner, repo.repo, link.baseSha, head);
  const { rows } = await pool.query(
    `SELECT merge_commit_sha FROM chat_sessions
      WHERE app_id = $1 AND upstream_from_app_id IS NOT NULL AND merge_commit_sha IS NOT NULL`,
    [fork.id]
  );
  const updates = new Set(rows.map((r) => String(r.merge_commit_sha || '').toLowerCase()).filter(Boolean));
  const changes = (compared.commits || [])
    .map((c) => ({ sha: sha(c.sha), subject: String(c.subject || '') }))
    .filter((c) => c.sha && !updates.has(c.sha) && !UPDATE_SUBJECT.test(c.subject))
    .map((c) => ({ sha: c.sha, title: titleOf(c.subject) || c.sha.slice(0, 7) }));
  const files = (compared.files || []).filter((f) => !lineage.isExcludedPath(f));
  return { changes, files, total: Number(compared.totalCommits) || (compared.commits || []).length };
}

/**
 * What the confirmation shows: the original, the version's own changes
 * (`changes`, [{ sha, title }] newest last, at most MAX_CHANGES; `commits`
 * their titles, at most MAX_LISTED_COMMITS, for the older dialog), how many
 * files they touch, and whether Send can go ahead (`reason` is the refusal
 * it would meet, which the dialog says in place of the list).
 */
async function preview({ pool, config = {}, user, fork, deps = defaultDeps() }) {
  const copy = appRef(fork);
  const verdict = await evaluate({ pool, config, user, fork, deps });
  if (!verdict.ok && verdict.body.code !== 'join_required') {
    return {
      copy,
      original: verdict.body.original || null,
      ready: false,
      reason: { code: verdict.body.code, error: verdict.body.error },
      commits: [],
      changes: [],
      commitCount: 0,
      fileCount: 0,
      open: null,
    };
  }
  // A join_required verdict still names the original: Send stays offered,
  // and the press that meets the refusal is asked to Join first.
  const { original, link } = verdict;
  const open = await openSuggestion(pool, fork);
  let changes = [];
  let fileCount = 0;
  // Whether the list was read: a list that could not be read (the code host
  // slow) leaves Send offered, and the send reads it again; one that was
  // read and is empty says there is nothing to send.
  let listed = false;
  if (repoOf(deps, fork) && deps.github.isEnabled()) {
    try {
      // A version's repository is the platform's own, always on `main`
      // (app-forker pushes HEAD:main).
      const own = await ownChanges({ pool, deps, fork, link, head: 'main' });
      changes = own.changes;
      fileCount = own.files.length;
      listed = true;
    } catch (err) {
      log.warn('suggest-back', 'Could not list the version’s changes', { slug: fork.slug, err: err.message });
    }
  }
  const empty = listed && !changes.length;
  return {
    copy,
    original: appRef(original),
    ready: !open && verdict.ok && !empty,
    reason: open
      ? { code: 'already_open', error: MESSAGES.alreadyOpen(original.name || original.slug) }
      : (verdict.ok
        ? (empty ? { code: 'no_changes', error: MESSAGES.noChanges } : null)
        : { code: verdict.body.code, error: verdict.body.error }),
    commits: changes.slice(-MAX_LISTED_COMMITS).map((c) => c.title),
    changes: changes.slice(-MAX_CHANGES),
    commitCount: changes.length,
    fileCount,
    open,
  };
}

function prTitle(copyName, titles) {
  const list = titles.length ? `: ${titles.join(', ')}` : '';
  const title = `Suggested by ${copyName}${list}`;
  return title.length > 256 ? `${title.slice(0, 255)}…` : title;
}

function prBody({ copy, user, subjects, manifestKeys }) {
  const lines = [
    `Suggested by **${copy.name}**, a version of this project, by ${user.username || 'its owner'}.`,
    '',
  ];
  if (subjects.length) {
    lines.push('Its changes:', '');
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

// `picks` from the request: absent is all of them; anything else must be a
// list of the version's own changes by their full commit.
function choosePicks(raw, changes) {
  if (raw === undefined || raw === null) return { picks: changes };
  if (!Array.isArray(raw) || !raw.every((p) => typeof p === 'string')) {
    return { error: refusal(400, 'invalid_picks', MESSAGES.unknownPick) };
  }
  if (!raw.length) return { error: refusal(400, 'nothing_picked', MESSAGES.nothingPicked) };
  const wanted = new Set(raw.map((p) => p.trim().toLowerCase()));
  const known = new Set(changes.map((c) => c.sha));
  if ([...wanted].some((p) => !known.has(p))) return { error: refusal(400, 'unknown_pick', MESSAGES.unknownPick) };
  // In the version's own order, oldest first, whatever order they came in.
  return { picks: changes.filter((c) => wanted.has(c.sha)) };
}

/**
 * Send the version's picked changes (`picks`, all of them when absent) to
 * the original as a proposal. Resolves
 * { ok: true, sessionId, prNumber, prUrl, href, original } or a refusal
 * { ok: false, status, body }.
 */
async function suggest({ pool, config, user, fork, picks: rawPicks, deps = defaultDeps() }) {
  const verdict = await evaluate({ pool, config, user, fork, deps });
  if (!verdict.ok) return verdict;
  const { link, original } = verdict;

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
    log.warn('suggest-back', 'Could not read the version’s head', { slug: fork.slug, err: err.message });
  }
  copyHeadSha = copyHeadSha || sha(fork.main_sha);
  if (!copyHeadSha) return refusal(503, 'platform_unavailable', MESSAGES.unavailable);
  if (copyHeadSha === link.baseSha) return refusal(409, 'no_changes', MESSAGES.noChanges);

  // The version's own changes, read at the head the patch is built from.
  let changes;
  try {
    ({ changes } = await ownChanges({ pool, deps, fork, link, head: copyHeadSha }));
  } catch (err) {
    log.warn('suggest-back', 'Could not list the version’s changes', { slug: fork.slug, err: err.message });
    return refusal(503, 'platform_unavailable', MESSAGES.unavailable);
  }
  if (!changes.length) return refusal(409, 'no_changes', MESSAGES.noChanges);
  const chosen = choosePicks(rawPicks, changes);
  if (chosen.error) return chosen.error;
  const { picks } = chosen;

  // ── The patch ──────────────────────────────────────────────────────
  let built;
  let credential;
  try {
    credential = await deps.head.resolveWriteCredential(originalRepo.owner);
    built = await deps.head.withScratchRepo(`suggest-${fork.id}`, ({ dir, git }) => buildPatch({
      git,
      dir,
      copyRemote: deps.head.appRemote(copyRepo.owner, copyRepo.repo),
      originalRemote: deps.head.appRemote(originalRepo.owner, originalRepo.repo),
      credential,
      baseSha: link.baseSha,
      copyHeadSha,
      syncedSha: link.syncedSha,
      picks,
      changes,
    }));
  } catch (err) {
    if (err instanceof DependsOnUnpicked) {
      return refusal(409, 'depends_on_unpicked', MESSAGES.dependsOnUnpicked(err.pick.title), { sha: err.pick.sha });
    }
    if (err instanceof DoesNotFit) return refusal(409, 'original_moved', MESSAGES.originalMoved);
    log.error('suggest-back', 'Building the patch failed', {
      slug: fork.slug,
      err: deps.head.redactToken(err && (err.stderr || err.message), credential && credential.token),
    });
    return refusal(503, 'platform_unavailable', MESSAGES.unavailable);
  }
  if (!built.patch.trim() || !built.files.length) return refusal(409, 'no_changes', MESSAGES.noChanges);
  const bounded = checkPatch(built);
  if (bounded) return bounded;

  // ── Apply at the commit the version last took, on the original ─────
  const applied = await deps.externalAgentPatch.applyPatch({
    owner: originalRepo.owner,
    repo: originalRepo.repo,
    patch: built.patch,
    baseSha: link.syncedSha,
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
  const subjects = picks.map((p) => p.title);
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
        applied.headSha, sha(pr.base && pr.base.sha) || link.syncedSha, botLogin,
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
    copy: fork.slug, original: original.slug, sessionId, prNumber: pr.number,
    files: built.files.length, picks: picks.length, of: changes.length,
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
  readLink,
  mergeManifest,
  diffPathspec,
  checkPatch,
  buildPatch,
  choosePicks,
  evaluate,
  preview,
  suggest,
  proposalHref,
  prTitle,
  titleOf,
  DependsOnUnpicked,
  DoesNotFit,
};
