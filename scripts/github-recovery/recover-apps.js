#!/usr/bin/env node
'use strict';

// Rebuild every app's main on Homeroom's git host from what survived
// GitHub's suspension of usernode-bot (25 Oct 2026), and record each move
// for the platform's boot migration (services/github-move.js).
//
// Runs on the machine that holds the rescue folder (~/homeroom-rescue-
// 2026-10-26: the images in images/oci, the mirrors, inventory/apps.tsv).
//
//   An app on usernode-bot ('recovered'): its source is laid out from the
//   image it runs (apps.image_ref), the directory the builder used
//   (workspace/ for kpack, app/ for a Dockerfile build). Where a rescued
//   mirror holds GitHub's main (commits and trees, no file contents), that
//   tree decides which files belong, so build output is left out and what
//   the image lacks is named; else the repository's own .gitignore does.
//   dapp.json, which a Dockerfile build leaves out, comes from
//   apps.manifest_snapshot (--manifests). One commit: "Recovered from image
//   <digest>; GitHub main was <sha>".
//
//   An app on another GitHub account GitHub still serves ('mirrored'):
//   cloned with every branch and tag, anonymously, and pushed as it is.
//
//   The platform's own repository is never moved (it stays on GitHub).
//
// Dry run by default: everything is built under --out, nothing is sent.
// --push creates each repository on the git host (GIT_HOST_URL,
// GIT_HOST_USER, GIT_HOST_TOKEN: the service account) and pushes it, and
// writes git-host-moves.sql: one INSERT per app into git_host_moves, to be
// run on the primary. Re-running is safe: an app whose repository already
// holds the same tree is left as it is.
//
//   node scripts/github-recovery/recover-apps.js --rescue ~/homeroom-rescue-2026-10-26 \
//     [--apps slug,slug | --all] [--manifests manifests.tsv] [--out dir] [--push]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const oci = require('./oci');

function args() {
  const out = { apps: null, all: false, push: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--push') out.push = true;
    else if (a === '--all') out.all = true;
    else if (a === '--apps') out.apps = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--rescue') out.rescue = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--manifests') out.manifests = argv[++i];
    else throw new Error(`Unknown argument ${a}`);
  }
  if (!out.rescue) throw new Error('--rescue <folder> is required');
  if (!out.all && !out.apps) throw new Error('--apps a,b or --all');
  out.rescue = path.resolve(out.rescue.replace(/^~/, os.homedir()));
  out.out = path.resolve((out.out || path.join(out.rescue, 'recovery')).replace(/^~/, os.homedir()));
  return out;
}

function tsv(file) {
  const [head, ...lines] = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const cols = head.split('\t');
  return lines.map((l) => Object.fromEntries(l.split('\t').map((v, i) => [cols[i], v])));
}

function git(cwd, ...a) {
  return execFileSync('git', ['-C', cwd, ...a], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8').trim();
}

function tryGit(cwd, ...a) {
  try { return git(cwd, ...a); } catch (_) { return null; }
}

const PLATFORM = /github\.com\/usernode-labs\/social-vibecoding(\.git)?\/?$/i;
// When the account went: the date every recovered commit carries.
const RECOVERED_AT = '2026-10-25T00:00:00Z';
// services/template.js's .gitignore: build output and secrets never in git.
const STANDARD_EXCLUDES = ['node_modules/', 'public/tailwind.css', '.env', '.env.*', '.playwright-mcp/', 'test-results/', 'playwright-report/'];
const GITHUB = /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

// A rescued mirror holding `sha`: the tree GitHub's main had.
function mirrorWith(rescue, owner, repo, sha) {
  const root = path.join(rescue, 'mirrors');
  if (!sha || !fs.existsSync(root)) return null;
  for (const pod of fs.readdirSync(root)) {
    const dir = path.join(root, pod, `usernode-mirror-${owner}-${repo}.git`);
    if (fs.existsSync(dir) && tryGit(dir, 'cat-file', '-e', `${sha}^{commit}`) !== null) return dir;
  }
  return null;
}

function treeEntries(mirror, sha) {
  return git(mirror, 'ls-tree', '-r', '-z', sha).split('\0').filter(Boolean).map((line) => {
    const [meta, p] = line.split('\t');
    const [mode, type, oid] = meta.split(' ');
    return { mode, type, oid, path: p };
  });
}

// Build the recovered commit for one app in `repoDir` from the files in
// `filesDir`. Resolves { sha, tree, missing, extra, treeMatches }.
function buildCommit({ app, filesDir, repoDir, mirror, manifest, imageRef, newRepoUrl = null }) {
  fs.rmSync(repoDir, { recursive: true, force: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repoDir]);
  // Some images hold the checkout they were built from, .git and all (a
  // shallow clone on a branch named after the commit). Copied in, it
  // replaced this repository's own: the recovered commit sat on that
  // shallow history, and the git host refuses a push from a shallow clone.
  fs.cpSync(filesDir, repoDir, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => !path.relative(filesDir, src).split(path.sep).includes('.git'),
  });
  fs.rmSync(path.join(repoDir, '.git', 'index'), { force: true });
  if (manifest && !fs.existsSync(path.join(repoDir, 'dapp.json'))) {
    fs.writeFileSync(path.join(repoDir, 'dapp.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  let missing = [];
  let extra = [];
  let treeMatches = false;
  if (mirror) {
    // GitHub's tree decides the file set: build output the image holds is
    // left out, and what the image lacks is named.
    const entries = treeEntries(mirror, app.main_sha).filter((e) => e.type === 'blob' || e.type === 'commit');
    const wanted = new Set(entries.map((e) => e.path));
    for (const e of entries) {
      if (e.type !== 'blob') continue;
      if (fs.existsSync(path.join(repoDir, e.path)) || isSymlink(path.join(repoDir, e.path))) {
        git(repoDir, 'add', '-f', '--', e.path);
      } else {
        missing.push(e.path);
      }
    }
    const listed = git(repoDir, 'ls-files', '--others', '-z', '--exclude-standard').split('\0').filter(Boolean);
    extra = listed.filter((p) => !wanted.has(p) && !p.startsWith('node_modules/')).slice(0, 50);
  } else {
    // No tree to go by: the repository's own .gitignore, plus what the
    // template ignores, for an app old enough to have no .gitignore.
    fs.writeFileSync(path.join(repoDir, '.git', 'info', 'exclude'), `${STANDARD_EXCLUDES.join('\n')}\n`);
    git(repoDir, 'add', '-A');
  }
  // Whether the image gave back exactly GitHub main's tree, before the repairs below.
  treeMatches = !!(mirror && git(repoDir, 'write-tree') === tryGit(mirror, 'rev-parse', `${app.main_sha}^{tree}`));
  // The template's own files a Dockerfile image leaves out (.claude/,
  // services/template.js getConnectorScaffoldFiles), restored where missing,
  // and the canonical-repository pointer naming the new home, never GitHub.
  const template = require('../../src/services/template');
  const restored = [];
  for (const f of template.getConnectorScaffoldFiles()) {
    const dest = path.join(repoDir, f.path);
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.content, f.path.endsWith('.sh') ? { mode: 0o755 } : undefined);
    restored.push(f.path);
  }
  const pointer = newRepoUrl && template.getCanonicalRepoFile(newRepoUrl);
  if (pointer) {
    fs.mkdirSync(path.dirname(path.join(repoDir, pointer.path)), { recursive: true });
    fs.writeFileSync(path.join(repoDir, pointer.path), pointer.content);
  }
  for (const p of [...restored, ...(pointer ? [pointer.path] : [])]) git(repoDir, 'add', '-f', '--', p);
  missing = missing.filter((p) => !restored.includes(p) && p !== (pointer && pointer.path));
  const tree = git(repoDir, 'write-tree');
  const message = [
    `Recovered from image ${imageRef}`,
    '',
    'GitHub suspended the account that held this repository (25 Oct 2026). This',
    'commit rebuilds main from the image the app was running.',
    '',
    `GitHub main was ${app.main_sha || 'unknown'}.`,
    treeMatches ? 'The tree is exactly GitHub main\'s tree.' : null,
    missing.length ? `Not in the image, so not here: ${missing.slice(0, 40).join(', ')}${missing.length > 40 ? ', ...' : ''}` : null,
    restored.length ? `Restored from the template: ${restored.join(', ')}` : null,
  ].filter((l) => l !== null).join('\n');
  // Fixed dates: the same files make the same commit on every run, so a
  // re-run finds its own commit already on the git host.
  execFileSync('git', ['-C', repoDir, '-c', 'user.name=Homeroom', '-c', 'user.email=homeroom@users.noreply.onhomeroom.com',
    'commit', '-q', '--no-verify', '--allow-empty', '-m', message],
  { env: { ...process.env, GIT_AUTHOR_DATE: RECOVERED_AT, GIT_COMMITTER_DATE: RECOVERED_AT } });
  return { sha: git(repoDir, 'rev-parse', 'HEAD'), tree, missing, extra, treeMatches, restored };
}

function isSymlink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; }
}

function sqlString(v) {
  return v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
}

function sqlArray(list) {
  return `ARRAY[${list.map(sqlString).join(', ')}]::text[]`;
}

async function main() {
  const opt = args();
  const apps = tsv(path.join(opt.rescue, 'inventory', 'apps.tsv'));
  const manifests = new Map();
  if (opt.manifests) {
    for (const line of fs.readFileSync(opt.manifests, 'utf8').split('\n').filter(Boolean)) {
      const [slug, b64] = line.split('\t');
      try { manifests.set(slug, JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))); } catch (_) { /* skipped */ }
    }
  }
  const layout = path.join(opt.rescue, 'images', 'oci');
  const chosen = apps.filter((a) => a.repo_url && !PLATFORM.test(a.repo_url) && (opt.all || opt.apps.includes(a.slug)));
  fs.mkdirSync(opt.out, { recursive: true, mode: 0o700 });
  const gitHost = opt.push ? require('../../src/services/git-host') : null;
  if (opt.push && !gitHost.isConfigured()) throw new Error('--push needs GIT_HOST_URL, GIT_HOST_USER and GIT_HOST_TOKEN');
  if (opt.push && !process.env.GIT_HOST_INTERNAL_URL) process.env.GIT_HOST_INTERNAL_URL = process.env.GIT_HOST_URL;

  // Every move recorded so far, across runs: the SQL is written from all of them.
  const movesFile = path.join(opt.out, 'moves.json');
  const moves = fs.existsSync(movesFile) ? JSON.parse(fs.readFileSync(movesFile, 'utf8')) : {};
  const report = [['slug', 'outcome', 'github_repo', 'github_main_sha', 'new_main_sha', 'tree_matches', 'missing', 'extra', 'image', 'note'].join('\t')];
  const sql = ['\\set ON_ERROR_STOP on', 'BEGIN;'];
  for (const app of chosen) {
    const m = app.repo_url.match(GITHUB);
    const [owner, repo] = m ? [m[1], m[2]] : [null, null];
    const work = path.join(opt.out, 'work', app.slug);
    const repoDir = path.join(opt.out, 'repos', app.slug);
    let row;
    try {
      if (!owner) throw new Error(`not a GitHub address: ${app.repo_url}`);
      if (owner.toLowerCase() !== 'usernode-bot') {
        // GitHub still serves it: every branch and tag, as it is.
        const bare = `${repoDir}.git`;
        fs.rmSync(bare, { recursive: true, force: true });
        execFileSync('git', ['clone', '-q', '--mirror', `https://github.com/${owner}/${repo}.git`, bare], { stdio: ['ignore', 'ignore', 'pipe'] });
        const sha = git(bare, 'rev-parse', 'refs/heads/main');
        row = { outcome: 'mirrored', sha, tree: null, missing: [], extra: [], treeMatches: sha === app.main_sha, dir: bare, image: '' };
      } else {
        if (!app.image_ref || !app.image_ref.includes('@')) throw new Error('no image to recover from');
        const digest = app.image_ref.split('@')[1];
        const manifest = oci.manifestFor(layout, digest);
        if (!manifest) throw new Error(`image ${digest} is not in the rescued layout`);
        const root = oci.sourceRoot(layout, manifest);
        if (!root) throw new Error('no app source directory in the image');
        fs.rmSync(work, { recursive: true, force: true });
        oci.extractRoot(layout, manifest, root, path.join(work, 'files'));
        const mirror = mirrorWith(opt.rescue, owner, repo, app.main_sha);
        const built = buildCommit({
          app, filesDir: path.join(work, 'files'), repoDir, mirror, manifest: manifests.get(app.slug) || null, imageRef: app.image_ref,
          newRepoUrl: process.env.GIT_HOST_URL ? `${process.env.GIT_HOST_URL.replace(/\/+$/, '')}/${process.env.GIT_HOST_ORG || 'apps'}/${repo}` : null,
        });
        row = { outcome: 'recovered', ...built, dir: repoDir, image: app.image_ref, note: `${root}/${mirror ? ', mirror tree' : ', .gitignore'}` };
      }
      if (opt.push) {
        await gitHost.createRepo(repo, { description: `Recovered ${app.slug}`, adoptExisting: true });
        const there = await gitHost.readRef(repo, 'main');
        if (there && there !== row.sha) {
          // Already pushed by an earlier run: the same tree is the same app.
          await gitHost.git(['-C', row.dir, 'fetch', '-q', gitHost.cloneUrl(repo), there], { auth: true }).catch(() => {});
          const theirs = tryGit(row.dir, 'rev-parse', `${there}^{tree}`);
          const ours = row.tree || tryGit(row.dir, 'rev-parse', `${row.sha}^{tree}`);
          if (!theirs || theirs !== ours) throw new Error(`apps/${repo} already has a different main (${there.slice(0, 8)}); not overwritten`);
        }
        if (!there) {
          if (row.outcome === 'mirrored') {
            await gitHost.git(['-C', row.dir, 'push', '--quiet', gitHost.cloneUrl(repo), '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'], { auth: true });
          } else {
            await gitHost.casUpdateRef(repo, row.dir, 'main', null, row.sha);
          }
        } else {
          row.sha = there;
          row.note = `${row.note || ''} (already there)`;
        }
        moves[app.slug] = {
          appId: Number(app.id), repoUrl: gitHost.repoUrl(repo), githubRepoUrl: app.repo_url, mainSha: row.sha,
          githubMainSha: app.main_sha || null, outcome: row.outcome, image: row.image || null, missing: row.missing,
        };
      }
      report.push([app.slug, row.outcome, `${owner}/${repo}`, app.main_sha || '', row.sha, row.treeMatches ? 'yes' : 'no',
        row.missing.join(' '), row.extra.join(' '), row.image || '', row.note || ''].join('\t'));
      console.log(`${app.slug}: ${row.outcome} ${row.sha.slice(0, 8)}${row.treeMatches ? ' (GitHub main\'s tree)' : ''}${row.missing.length ? `, ${row.missing.length} missing` : ''}`);
    } catch (err) {
      report.push([app.slug, 'failed', owner ? `${owner}/${repo}` : '', app.main_sha || '', '', '', '', '', app.image_ref || '', String(err.message).replace(/\s+/g, ' ').slice(0, 300)].join('\t'));
      console.log(`${app.slug}: FAILED ${err.message}`);
    }
  }
  for (const [, mv] of Object.entries(moves).sort((x, y) => x[1].appId - y[1].appId)) {
    sql.push(`INSERT INTO git_host_moves (app_id, repo_url, github_repo_url, main_sha, github_main_sha, outcome, source_image, missing_files)
VALUES (${mv.appId}, ${sqlString(mv.repoUrl)}, ${sqlString(mv.githubRepoUrl)}, ${sqlString(mv.mainSha)}, ${sqlString(mv.githubMainSha)},
        ${sqlString(mv.outcome)}, ${sqlString(mv.image)}, ${sqlArray(mv.missing || [])})
ON CONFLICT (app_id) DO UPDATE SET repo_url = EXCLUDED.repo_url, main_sha = EXCLUDED.main_sha, outcome = EXCLUDED.outcome,
  source_image = EXCLUDED.source_image, missing_files = EXCLUDED.missing_files, recorded_at = NOW()
WHERE git_host_moves.applied_at IS NULL;`);
  }
  sql.push('COMMIT;');
  fs.writeFileSync(path.join(opt.out, 'report.tsv'), `${report.join('\n')}\n`, { mode: 0o600 });
  if (opt.push) {
    fs.writeFileSync(movesFile, JSON.stringify(moves, null, 1), { mode: 0o600 });
    fs.writeFileSync(path.join(opt.out, 'git-host-moves.sql'), `${sql.join('\n')}\n`, { mode: 0o600 });
  }
  console.log(`report: ${path.join(opt.out, 'report.tsv')}${opt.push ? `, sql: ${path.join(opt.out, 'git-host-moves.sql')}` : ' (dry run: nothing sent)'}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
