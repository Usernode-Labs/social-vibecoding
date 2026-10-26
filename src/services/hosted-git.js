'use strict';

// GitHub's git-data helpers, for a repository on Homeroom's git host.
//
// services/github.js reads files, compares refs, makes commits and moves
// branches through GitHub's REST API (contents, git/trees, git/commits,
// git/refs, compare). For an app on the git host (since GitHub suspended the
// account that owned every app repository, 25 Oct 2026) the same helpers
// come here and answer with git: reads from the app's mirror
// (services/repo-mirror.js), which is a full clone of the git host's
// repository, and writes built in that mirror and pushed with a
// compare-and-swap (services/git-host.js). The shapes and the error codes
// are GitHub's (`branch_conflict`, `branch_moved`, `non_fast_forward`,
// `tree_mismatch`, a 404 for a missing ref), so callers need no change.

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const log = require('./logger');
const gitHost = require('./git-host');
const repoMirror = require('./repo-mirror');

const SHA_RE = /^[0-9a-f]{40}$/i;
const SHORT_SHA_RE = /^[0-9a-f]{7,40}$/i;

function notFound(message) {
  const e = new Error(message);
  e.status = 404;
  return e;
}

function coded(message, code, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

function repoOf(owner, repo) { return { owner, name: repo }; }

async function mirror(owner, repo, { fresh = true, refs = [] } = {}) {
  return repoMirror.ensureMirror(owner, repo, { fresh, refs: refs.filter((r) => SHORT_SHA_RE.test(String(r || ''))) });
}

// Run git in the mirror (local plumbing; the mirror holds every object).
async function run(dir, args, { env = {}, input = null } = {}) {
  const { stdout } = await gitHost.git(['-C', dir, ...args], { env, input });
  return stdout;
}

async function tryRun(dir, args, opts) {
  try { return await run(dir, args, opts); } catch (_) { return null; }
}

// A ref as the GitHub helpers name one (a branch, a sha, HEAD), as git
// resolves it in the mirror. Null when there is none.
async function resolve(dir, ref) {
  const r = String(ref || 'HEAD').trim();
  if (!r || r.startsWith('-')) return null;
  const candidates = SHORT_SHA_RE.test(r) ? [r] : r === 'HEAD' ? ['HEAD'] : [`refs/heads/${r.replace(/^refs\/heads\//, '')}`];
  for (const c of candidates) {
    const out = await tryRun(dir, ['rev-parse', '--verify', '--quiet', `${c}^{commit}`]);
    if (out && out.trim()) return out.trim().toLowerCase();
  }
  return null;
}

// "base...head" or "base..head" (GitHub's basehead), each side a branch or a
// sha, an `owner:branch` head allowed.
function splitBasehead(basehead) {
  const s = String(basehead || '');
  const m = s.match(/^(.+?)(\.\.\.?)(.+)$/);
  if (!m) throw coded(`Not a basehead: ${s.slice(0, 80)}`, 'invalid_basehead');
  return { base: m[1].replace(/^[^:]+:/, ''), head: m[3].replace(/^[^:]+:/, ''), threeDot: m[2] === '...' };
}

// A tree built in a temporary index: the `base` tree (or nothing), with
// `writes` ({ path, sha, mode }) and `deletes` (paths) applied.
async function buildTree(dir, baseTree, { writes = [], deletes = [] }) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hosted-git-index-'));
  const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
  try {
    if (baseTree) await run(dir, ['read-tree', baseTree], { env });
    else await run(dir, ['read-tree', '--empty'], { env });
    // --index-info works in a bare repository; mode 0 removes a path.
    // Deletions go first, so a path replaced by a directory (or the other
    // way round) never meets itself.
    const ZERO = '0'.repeat(40);
    if (deletes.length) {
      await run(dir, ['update-index', '--index-info'], { env, input: deletes.map((p) => `0 ${ZERO}\t${p}\n`).join('') });
    }
    if (writes.length) {
      await run(dir, ['update-index', '--add', '--index-info'], {
        env, input: writes.map((w) => `${w.mode || '100644'} ${w.sha}\t${w.path}\n`).join(''),
      });
    }
    return (await run(dir, ['write-tree'], { env })).trim().toLowerCase();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function writeBlob(dir, content) {
  return (await run(dir, ['hash-object', '-w', '--stdin'], { input: content })).trim().toLowerCase();
}

function identityEnv(identity, { authoredAt = null, committedAt = null } = {}) {
  const who = identity || gitHost.defaultAuthor();
  return {
    GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email,
    GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email,
    ...(authoredAt ? { GIT_AUTHOR_DATE: new Date(authoredAt).toISOString() } : {}),
    ...(committedAt ? { GIT_COMMITTER_DATE: new Date(committedAt).toISOString() } : {}),
  };
}

async function commitTree(dir, tree, parents, message, { identity = null, authoredAt = null, committedAt = null } = {}) {
  const args = ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-F', '-'];
  return (await run(dir, args, { input: `${String(message || '').trimEnd()}\n`, env: identityEnv(identity, { authoredAt, committedAt }) }))
    .trim().toLowerCase();
}

async function moveRef(owner, repo, dir, branch, expected, sha) {
  await gitHost.casUpdateRef(repoOf(owner, repo), dir, branch, expected, sha);
}

// ── Repositories ──────────────────────────────────────────────────────

/**
 * An app's repository, with a first commit on main (GitHub's auto_init, which
 * the callers build on with pushFiles). GitHub's repository shape.
 */
async function createRepo(owner, name, { description = '', adoptExisting = false } = {}) {
  const made = await gitHost.createRepo(name, { description, adoptExisting: true });
  let adopted = false;
  const existing = await gitHost.readRef(made.name, 'main');
  if (existing) {
    if (!adoptExisting) throw coded(`A repository named ${name} already exists`, 'repo_exists', { status: 422 });
    adopted = true;
  } else {
    await gitHost.pushInitialFiles(made.name, { 'README.md': `# ${name}\n${description ? `\n${description}\n` : ''}` },
      { message: 'Initial commit' });
  }
  const html = made.url;
  return {
    name: made.name,
    full_name: `${made.owner}/${made.name}`,
    owner: { login: made.owner },
    html_url: html,
    clone_url: gitHost.cloneUrl(made.name, { internal: false }),
    default_branch: 'main',
    private: false,
    ...(adopted ? { adopted: true } : {}),
  };
}

async function checkRepoPublic(owner, repo) {
  try {
    const { status, data } = await gitHost.api('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, undefined, { allow: [404] });
    if (status === 404) return { ok: false, code: 'not_found', message: `Repo ${owner}/${repo} not accessible.` };
    return { ok: true, private: !!(data && data.private) };
  } catch (err) {
    return { ok: false, code: 'git_host_error', message: err.message };
  }
}

// ── Reads ─────────────────────────────────────────────────────────────

async function getFileContent(owner, repo, filePath, ref) {
  const dir = await mirror(owner, repo, { refs: [ref] });
  const at = await resolve(dir, ref || 'HEAD');
  if (!at) return null;
  const out = await tryRun(dir, ['cat-file', 'blob', `${at}:${String(filePath).replace(/^\/+/, '')}`]);
  return out == null ? null : out;
}

async function headCommit(owner, repo, branch = 'main') {
  const dir = await mirror(owner, repo);
  const sha = await resolve(dir, branch);
  if (!sha) return null;
  const message = await tryRun(dir, ['log', '-1', '--format=%B', sha]);
  return { sha, message: (message || '').trimEnd() };
}

async function listRepoFiles(owner, repo, ref) {
  const dir = await mirror(owner, repo, { refs: [ref] });
  const at = await resolve(dir, ref || 'HEAD');
  if (!at) return null;
  const out = await run(dir, ['ls-tree', '-r', '-l', '-z', at]);
  const files = out.split('\0').filter(Boolean).map((line) => {
    const [meta, p] = line.split('\t');
    const [, type, sha, size] = meta.trim().split(/\s+/);
    return type === 'blob' ? { path: p, size: Number(size) || 0, sha } : null;
  }).filter(Boolean);
  return { files, truncated: false };
}

async function getBlobContent(owner, repo, sha) {
  const dir = await mirror(owner, repo, { refs: [] });
  return run(dir, ['cat-file', 'blob', String(sha)]);
}

async function getBranchSha(owner, repo, branchName) {
  const dir = await mirror(owner, repo);
  const sha = await resolve(dir, branchName);
  if (!sha) throw notFound(`Branch ${branchName} not found`);
  return sha;
}

async function getRepoHead(owner, repo) {
  const dir = await mirror(owner, repo);
  const sha = await resolve(dir, 'HEAD');
  const date = sha ? await tryRun(dir, ['log', '-1', '--format=%cI', sha]) : null;
  return { defaultBranch: 'main', headSha: sha, headCommittedAt: date ? date.trim() : null };
}

async function getCommitAt(owner, repo, until, { branch = null } = {}) {
  const at = new Date(until);
  if (Number.isNaN(at.getTime())) throw new Error('getCommitAt needs a valid time');
  const dir = await mirror(owner, repo);
  const ref = branch || 'main';
  const tip = await resolve(dir, ref);
  if (!tip) return null;
  const out = await tryRun(dir, ['rev-list', '-1', `--before=${at.toISOString()}`, '--format=%cI', tip]);
  const lines = String(out || '').split('\n').filter(Boolean);
  const shaLine = lines.find((l) => l.startsWith('commit '));
  if (!shaLine) return null;
  return { sha: shaLine.slice('commit '.length).trim().toLowerCase(), committedAt: (lines[1] || '').trim() || null, branch: ref };
}

/** A branch's tip with its commit date and message (the drift poller's read): { sha, committedAt, subject } or null. */
async function headOf(owner, repo, branch = 'main') {
  const dir = await mirror(owner, repo);
  const sha = await resolve(dir, branch);
  if (!sha) return null;
  const out = await run(dir, ['log', '-1', '--format=%cI%x1f%B', sha]);
  const [committedAt, subject] = out.split('\x1f');
  return { sha, committedAt: (committedAt || '').trim() || null, subject: (subject || '').trimEnd() || null };
}

/**
 * GitHub's compare object for base...head, as the callers that read it raw
 * use it: { status, ahead_by, behind_by, base_commit, merge_base_commit,
 * commits: [{ sha, commit: { message } }], files: [{ filename, status }] }.
 */
async function compareCommits(owner, repo, base, head) {
  const { dir, from, headSha, files, aheadBy, mergeBaseSha } = await compareData(owner, repo, `${base}...${head}`);
  const baseSha = await resolve(dir, base);
  const behindBy = await repoMirror.behindBy(dir, baseSha, headSha);
  const out = await run(dir, ['log', '--reverse', '--format=%H%x1f%B%x1e', `${from}..${headSha}`]);
  const commits = out.split('\x1e').map((l) => l.replace(/^\n/, '')).filter((l) => l.trim()).map((l) => {
    const [sha, message] = l.split('\x1f');
    return { sha: sha.trim().toLowerCase(), commit: { message: (message || '').trimEnd() } };
  });
  const status = aheadBy === 0 && behindBy === 0 ? 'identical' : behindBy === 0 ? 'ahead' : aheadBy === 0 ? 'behind' : 'diverged';
  return {
    status, ahead_by: aheadBy, behind_by: behindBy, total_commits: commits.length,
    base_commit: { sha: baseSha }, merge_base_commit: { sha: mergeBaseSha },
    commits, files: files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })),
  };
}

async function getCommitParents(owner, repo, sha) {
  const dir = await mirror(owner, repo, { refs: [sha] });
  const out = await run(dir, ['rev-list', '--parents', '-n', '1', String(sha)]);
  return out.trim().split(/\s+/).slice(1).map((s) => s.toLowerCase());
}

async function getCommitTree(owner, repo, sha) {
  const dir = await mirror(owner, repo, { refs: [sha] });
  const out = await tryRun(dir, ['rev-parse', `${sha}^{tree}`]);
  return out ? out.trim().toLowerCase() : null;
}

async function compareCommitAncestry(owner, repo, baseSha, headSha) {
  const dir = await mirror(owner, repo, { refs: [baseSha, headSha] });
  const [aheadBy, behindBy, mergeBaseSha] = await Promise.all([
    repoMirror.aheadBy(dir, baseSha, headSha),
    repoMirror.behindBy(dir, baseSha, headSha),
    repoMirror.mergeBase(dir, baseSha, headSha),
  ]);
  const status = aheadBy === 0 && behindBy === 0 ? 'identical'
    : behindBy === 0 ? 'ahead' : aheadBy === 0 ? 'behind' : 'diverged';
  return { status, aheadBy, behindBy, mergeBaseSha };
}

// The files of a comparison, GitHub-shaped: { filename, status, additions,
// deletions, previous_filename, patch }.
async function compareData(owner, repo, basehead) {
  const { base, head, threeDot } = splitBasehead(basehead);
  const dir = await mirror(owner, repo, { refs: [base, head] });
  const baseSha = await resolve(dir, base);
  const headSha = await resolve(dir, head);
  if (!baseSha || !headSha) throw notFound(`Cannot compare ${basehead}`);
  const mergeBaseSha = await repoMirror.mergeBase(dir, baseSha, headSha);
  const from = threeDot ? (mergeBaseSha || baseSha) : baseSha;
  const status = await run(dir, ['diff', '--name-status', '-M', '-z', from, headSha]);
  const numstat = await run(dir, ['diff', '--numstat', '-M', '-z', from, headSha]);
  const counts = new Map();
  {
    const parts = numstat.split('\0');
    for (let i = 0; i < parts.length; i += 1) {
      const field = parts[i];
      if (!field) continue;
      const [add, del, p] = field.split('\t');
      const name = p || parts[i + 2];
      if (!p) i += 2;
      counts.set(name, { additions: add === '-' ? 0 : Number(add) || 0, deletions: del === '-' ? 0 : Number(del) || 0, binary: add === '-' });
    }
  }
  const files = [];
  const parts = status.split('\0').filter((x, i, a) => !(x === '' && i === a.length - 1));
  for (let i = 0; i < parts.length;) {
    const code = parts[i++];
    if (!code) continue;
    const kind = code[0];
    let filename;
    let previous = null;
    if (kind === 'R' || kind === 'C') { previous = parts[i++]; filename = parts[i++]; } else { filename = parts[i++]; }
    const c = counts.get(filename) || { additions: 0, deletions: 0, binary: false };
    const map = { A: 'added', D: 'removed', M: 'modified', R: 'renamed', C: 'copied', T: 'changed' };
    files.push({ filename, status: map[kind] || 'modified', additions: c.additions, deletions: c.deletions, previous_filename: previous, binary: c.binary });
  }
  const aheadBy = await repoMirror.aheadBy(dir, baseSha, headSha);
  return { dir, from, headSha, mergeBaseSha, files, aheadBy };
}

// A file's hunks, as GitHub's `patch`: from the first "@@" on.
async function patchOf(dir, from, headSha, file) {
  if (file.binary) return null;
  const paths = file.previous_filename ? [file.previous_filename, file.filename] : [file.filename];
  const out = await tryRun(dir, ['diff', '--no-color', '-M', from, headSha, '--', ...paths]);
  if (!out) return null;
  const at = out.indexOf('\n@@');
  return at === -1 ? (out.startsWith('@@') ? out.trimEnd() : null) : out.slice(at + 1).trimEnd();
}

async function listChangedFiles(owner, repo, basehead) {
  return (await compareData(owner, repo, basehead)).files.map((f) => f.filename);
}

async function compareRefs(owner, repo, basehead, { cap = 300 } = {}) {
  const { files, mergeBaseSha } = await compareData(owner, repo, basehead);
  return { mergeBaseSha, files: files.map((f) => f.filename).slice(0, cap), filesComplete: files.length < cap };
}

async function compareCommitSubjects(owner, repo, base, head) {
  const { dir, from, headSha, files } = await compareData(owner, repo, `${base}...${head}`);
  const out = await run(dir, ['log', '--reverse', '--format=%H%x1f%s%x1e', `${from}..${headSha}`]);
  const commits = out.split('\x1e').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [sha, subject] = l.split('\x1f');
    return { sha: sha.toLowerCase(), subject: (subject || '').trim() };
  });
  return { commits, totalCommits: commits.length, files: files.map((f) => f.filename) };
}

async function getProposalDiff(owner, repo, basehead, charBudget) {
  const { dir, from, headSha, files } = await compareData(owner, repo, basehead);
  let out = '';
  let truncated = false;
  for (const f of files) {
    const header = `diff --git a/${f.filename} b/${f.filename}\n`;
    const patch = await patchOf(dir, from, headSha, f);
    const block = header + (patch ? `${patch}\n` : `(no textual diff — ${f.status}, +${f.additions || 0}/-${f.deletions || 0})\n`);
    if (out.length + block.length > charBudget) {
      const remaining = charBudget - out.length;
      if (remaining > header.length + 40) out += block.slice(0, remaining);
      truncated = true;
      break;
    }
    out += block;
  }
  if (truncated) out += `\n…diff truncated at ~${charBudget} chars (${files.length} files changed in total)…\n`;
  return { diff: out, fileCount: files.length, truncated };
}

async function compareFiles(owner, repo, basehead, charBudget = 60000, { cap = 300 } = {}) {
  const { dir, from, headSha, files, aheadBy, mergeBaseSha } = await compareData(owner, repo, basehead);
  let diff = '';
  let truncated = false;
  for (const f of files) {
    const patch = await patchOf(dir, from, headSha, f);
    const block = `diff --git a/${f.filename} b/${f.filename}\n${patch ? `${patch}\n` : `(no textual diff: ${f.status}, +${f.additions || 0}/-${f.deletions || 0})\n`}`;
    if (diff.length + block.length > charBudget) { truncated = true; break; }
    diff += block;
  }
  return {
    files: files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, previous: f.previous_filename })),
    diff, truncated, complete: files.length < cap, aheadBy, mergeBaseSha,
  };
}

// ── Writes ────────────────────────────────────────────────────────────

/** Commit `files` ({ path, content }) on top of `branch` and move it there. GitHub's commit shape. */
async function pushFiles(owner, repo, files, { branch = 'main', message = 'Initial commit' } = {}) {
  const dir = await mirror(owner, repo);
  const parent = await resolve(dir, branch);
  if (!parent) throw notFound(`Branch ${branch} not found`);
  const writes = [];
  for (const f of files) writes.push({ path: f.path, sha: await writeBlob(dir, String(f.content ?? '')), mode: '100644' });
  const tree = await buildTree(dir, `${parent}^{tree}`, { writes });
  const sha = await commitTree(dir, tree, [parent], message);
  await moveRef(owner, repo, dir, branch, parent, sha);
  log.info('hosted-git', 'Files pushed', { repo: `${owner}/${repo}`, branch, fileCount: files.length });
  return { sha, tree: { sha: tree }, parents: [{ sha: parent }], message };
}

/** A commit of `files` with no parent; no branch moves. Resolves its sha. */
async function createRootCommit(owner, repo, files, { message = 'Initial commit' } = {}) {
  const dir = await mirror(owner, repo);
  const writes = [];
  for (const f of files) writes.push({ path: f.path, sha: await writeBlob(dir, String(f.content ?? '')), mode: '100644' });
  const tree = await buildTree(dir, null, { writes });
  return commitTree(dir, tree, [], message);
}

async function createBranch(owner, repo, branchName, fromBranch = 'main') {
  const dir = await mirror(owner, repo);
  const from = await resolve(dir, fromBranch);
  if (!from) throw notFound(`Branch ${fromBranch} not found`);
  // GitHub answers 422 for a branch that exists, wherever it points; a push
  // of the same commit would just say "up to date".
  const exists = () => Object.assign(new Error('Reference already exists'), { status: 422 });
  if (await gitHost.readRef(repoOf(owner, repo), branchName)) throw exists();
  try {
    await moveRef(owner, repo, dir, branchName, null, from);
  } catch (err) {
    if (err && err.refMoved) throw exists();
    throw err;
  }
  log.info('hosted-git', 'Branch created', { repo: `${owner}/${repo}`, branch: branchName, from: fromBranch });
}

async function ensureBranchAtSha(owner, repo, branchName, sha) {
  const dir = await mirror(owner, repo, { refs: [sha] });
  if (!(await repoMirror.hasCommit(dir, sha))) throw notFound(`Commit ${sha} not found`);
  const current = await resolve(dir, branchName);
  const conflict = () => coded('The CLI handoff branch already exists at a different commit', 'branch_conflict');
  if (current) {
    if (current !== String(sha).toLowerCase()) throw conflict();
    return { sha: current, created: false };
  }
  try {
    await moveRef(owner, repo, dir, branchName, null, String(sha).toLowerCase());
  } catch (err) {
    if (!err || !err.refMoved) throw err;
    const raced = await gitHost.readRef(repoOf(owner, repo), branchName);
    if (raced && raced === String(sha).toLowerCase()) return { sha: raced, created: false };
    throw conflict();
  }
  return { sha, created: true };
}

async function advanceBranchToSha(owner, repo, branchName, sha) {
  const dir = await mirror(owner, repo, { refs: [sha] });
  const current = await resolve(dir, branchName);
  if (!current) throw notFound(`Branch ${branchName} not found`);
  const target = String(sha).toLowerCase();
  if (current === target) return { previousSha: current, sha: current, updated: false };
  if (!(await repoMirror.isAncestor(dir, current, target))) {
    throw coded('Submitted commit does not fast-forward the CLI handoff branch', 'non_fast_forward');
  }
  await moveRef(owner, repo, dir, branchName, current, target);
  return { previousSha: current, sha: target, updated: true };
}

async function forceBranchToSha(owner, repo, branchName, sha) {
  const dir = await mirror(owner, repo, { refs: [sha] });
  const current = await resolve(dir, branchName);
  if (!current) throw notFound(`Branch ${branchName} not found`);
  const target = String(sha).toLowerCase();
  if (current === target) return { previousSha: current, sha: current, updated: false };
  await moveRef(owner, repo, dir, branchName, current, target);
  return { previousSha: current, sha: target, updated: true };
}

/**
 * `sha` undone on top of `onto` (main), as `git revert` would, and pushed to
 * a new `branch`: a three-way merge whose base is the commit itself, ours the
 * current main, theirs its parent. Resolves the revert commit's sha; a
 * conflict rejects with "Revert produced merge conflicts".
 */
async function revertOnto(owner, repo, sha, { onto = 'main', branch, message }) {
  const dir = await mirror(owner, repo, { refs: [sha] });
  const main = await resolve(dir, onto);
  if (!main) throw notFound(`Branch ${onto} not found`);
  const parent = (await run(dir, ['rev-parse', `${sha}^`])).trim();
  const out = await gitHost.git(['-C', dir, 'merge-tree', '--write-tree', '--name-only', '--merge-base', sha, main, parent])
    .catch((err) => { if (err.exitCode === 1) return { conflict: true }; throw err; });
  if (out.conflict) throw new Error('Revert produced merge conflicts');
  const tree = out.stdout.split('\n')[0].trim();
  const revert = await commitTree(dir, tree, [main], message);
  await moveRef(owner, repo, dir, branch, null, revert);
  return revert;
}

async function deleteBenchBranch(owner, repo, branchName) {
  if (typeof branchName !== 'string' || !/^bench\/[A-Za-z0-9._/-]+$/.test(branchName) || branchName.includes('..')) {
    throw new Error(`refusing to delete ${branchName}: not a benchmark branch`);
  }
  const existed = await gitHost.readRef(repoOf(owner, repo), branchName);
  if (!existed) return false;
  await gitHost.deleteRef(repoOf(owner, repo), branchName);
  return true;
}

/**
 * The CLI handoff's commit (routes/proposal-handoff.js): the local commit's
 * tree rebuilt from `files` on the branch's head, checked against the tree
 * the agent tested, committed as 'Homeroom CLI' with the local dates, and the
 * branch moved only from the expected parent. GitHub's result and codes.
 */
async function createProposalCommit(owner, repo, {
  branchName, expectedRemoteParentSha, localParentSha, localParentTreeSha, expectedTreeSha,
  localCommitSha, message, authoredAt, committedAt, files, fullMessage,
}) {
  const dir = await mirror(owner, repo);
  const currentSha = await resolve(dir, branchName);
  if (!currentSha) throw notFound(`Branch ${branchName} not found`);
  const read = async (sha) => {
    const out = await run(dir, ['log', '-1', '--format=%T%x1f%P%x1f%B', sha]);
    const [tree, parents, body] = out.split('\x1f');
    return { tree: tree.trim(), parent: (parents || '').trim().split(/\s+/)[0] || '', message: body || '' };
  };
  const current = await read(currentSha);
  const isRetry = (currentSha === expectedRemoteParentSha || current.parent === expectedRemoteParentSha)
    && current.message.trimEnd() === fullMessage.trimEnd()
    && current.tree === expectedTreeSha;
  if (isRetry) {
    return { sha: currentSha, treeSha: expectedTreeSha, previousSha: current.parent || null, localParentSha, created: false };
  }
  if (currentSha !== expectedRemoteParentSha) {
    throw coded('The proposal branch moved before the local commit was uploaded', 'branch_moved', { currentSha });
  }
  if (current.tree !== localParentTreeSha) {
    throw coded('The local parent tree does not match the proposal branch tree', 'parent_tree_mismatch',
      { remoteTreeSha: current.tree, localParentTreeSha });
  }
  const writes = [];
  const deletes = [];
  for (const file of files) {
    if (file.delete) { deletes.push(file.path); continue; }
    writes.push({ path: file.path, mode: file.mode, sha: await writeBlob(dir, Buffer.from(file.contentBase64, 'base64')) });
  }
  const tree = await buildTree(dir, current.tree, { writes, deletes });
  if (tree !== expectedTreeSha) {
    throw coded('The uploaded tree does not match the tested local tree', 'tree_mismatch', { actualTreeSha: tree });
  }
  const createdSha = await commitTree(dir, tree, [currentSha], fullMessage, {
    identity: { name: 'Homeroom CLI', email: 'cli@usernodelabs.org' }, authoredAt, committedAt,
  });
  try {
    await moveRef(owner, repo, dir, branchName, currentSha, createdSha);
  } catch (err) {
    if (!err || !err.refMoved) throw err;
    const observed = await gitHost.readRef(repoOf(owner, repo), branchName).catch(() => null);
    if (observed !== createdSha) throw coded('The proposal branch moved while the local commit was uploaded', 'branch_moved', { currentSha: observed });
  }
  log.info('hosted-git', 'Created a proposal commit from a local tree', {
    repo: `${owner}/${repo}`, branch: branchName, from: currentSha, to: createdSha, localCommitSha, localParentSha, fileCount: files.length,
  });
  return { sha: createdSha, treeSha: expectedTreeSha, previousSha: currentSha, localParentSha, created: true };
}

module.exports = {
  createRepo,
  checkRepoPublic,
  getFileContent,
  headCommit,
  listRepoFiles,
  getBlobContent,
  getBranchSha,
  getRepoHead,
  getCommitAt,
  headOf,
  compareCommits,
  getCommitParents,
  getCommitTree,
  compareCommitAncestry,
  listChangedFiles,
  compareRefs,
  compareCommitSubjects,
  getProposalDiff,
  compareFiles,
  pushFiles,
  createRootCommit,
  createBranch,
  ensureBranchAtSha,
  advanceBranchToSha,
  forceBranchToSha,
  deleteBenchBranch,
  createProposalCommit,
  revertOnto,
  _splitBasehead: splitBasehead,
};
