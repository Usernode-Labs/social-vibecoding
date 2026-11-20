'use strict';

// services/git-host.js, services/hosted-git.js and the mirror against a REAL
// Forgejo: the one API call (making a repository), the service account's
// credential helper on push and fetch, compare-and-swap refusals, a commit
// fetched by sha (uploadpack.allowAnySHA1InWant, which previews and the push
// proxy rely on), deleting a branch, and a private repository refused to an
// anonymous clone. The other git-host tests stand Forgejo in with bare
// repositories; this checks the stand-in tells the truth.
//
// Skipped unless FORGEJO_TEST_URL, FORGEJO_TEST_USER and FORGEJO_TEST_TOKEN
// name a Forgejo whose user may create repositories in FORGEJO_TEST_ORG
// (default `apps`). Run against a throwaway one:
//   FORGEJO_TEST_URL=http://127.0.0.1:3300 FORGEJO_TEST_USER=homeroom FORGEJO_TEST_TOKEN=... \
//     node --test tests/git-host-forgejo.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const URL_ = process.env.FORGEJO_TEST_URL;
const skip = !(URL_ && process.env.FORGEJO_TEST_USER && process.env.FORGEJO_TEST_TOKEN)
  && 'set FORGEJO_TEST_URL, FORGEJO_TEST_USER and FORGEJO_TEST_TOKEN to check against a real Forgejo';

const loggerId = require.resolve('../src/services/logger');
require.cache[loggerId] = {
  id: loggerId, filename: loggerId, loaded: true, paths: [],
  exports: { info() {}, debug() {}, warn() {}, error() {} },
};

if (!skip) {
  Object.assign(process.env, {
    GIT_HOST_URL: URL_, GIT_HOST_INTERNAL_URL: URL_, GIT_HOST_ORG: process.env.FORGEJO_TEST_ORG || 'apps',
    GIT_HOST_USER: process.env.FORGEJO_TEST_USER, GIT_HOST_TOKEN: process.env.FORGEJO_TEST_TOKEN,
  });
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-host-forgejo-'));
process.env.USERNODE_MIRROR_ROOT = root;
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('git-host against Forgejo: create, push, swap, fetch by sha, delete, private', { skip, timeout: 120000 }, async () => {
  const gitHost = require('../src/services/git-host');
  const name = `itest-${crypto.randomBytes(4).toString('hex')}`;
  const made = await gitHost.createRepo(name, { description: 'integration test' });
  assert.equal(made.url, `${URL_.replace(/\/$/, '')}/${gitHost.settings().org}/${name}`);
  await assert.rejects(gitHost.createRepo(name), (err) => err.code === 'repo_exists');
  assert.equal((await gitHost.createRepo(name, { adoptExisting: true })).name, name);
  assert.equal(await gitHost.repoExists(name), true);

  const first = await gitHost.pushInitialFiles(name, { 'README.md': '# one\n' });
  assert.equal(await gitHost.readRef(name, 'main'), first);

  // A clone through the credential helper, a second commit, a stale swap refused.
  const work = path.join(root, 'work');
  await gitHost.git(['clone', '-q', gitHost.cloneUrl(name), work], { auth: true });
  fs.writeFileSync(path.join(work, 'b.txt'), 'b\n');
  execFileSync('git', ['-C', work, 'add', '-A']);
  execFileSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'b']);
  const second = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD']).toString().trim();
  await assert.rejects(gitHost.casUpdateRef(name, work, 'main', second, second), (err) => err.headMoved === true);
  await gitHost.casUpdateRef(name, work, 'main', first, second);
  assert.equal(await gitHost.readRef(name, 'main'), second);

  // A commit no branch points at any more, fetched by its sha: main is
  // rewritten (an amend, force-pushed), so `second` is reachable from nothing.
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['-C', work, 'commit', '-q', '--amend', '-m', 'b, again'], { env });
  const amended = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD']).toString().trim();
  await gitHost.casUpdateRef(name, work, 'keep/x', null, amended);
  await gitHost.pushRefs(name, work, [`${amended}:refs/heads/main`], { force: true });
  await gitHost.deleteRef(name, 'keep/x');
  assert.equal(await gitHost.readRef(name, 'keep/x'), null, 'the branch is gone');
  assert.equal(await gitHost.readRef(name, 'main'), amended);
  const fresh = path.join(root, 'fresh');
  execFileSync('git', ['init', '-q', '--bare', fresh]);
  await gitHost.git(['-C', fresh, 'fetch', '-q', gitHost.cloneUrl(name), second], { auth: true });
  assert.equal(execFileSync('git', ['-C', fresh, 'cat-file', '-t', second]).toString().trim(), 'commit',
    'fetched by sha although no branch holds it');

  // The mirror reads a hosted repository whole, with the service account.
  const repoMirror = require('../src/services/repo-mirror');
  const dir = await repoMirror.ensureMirror(gitHost.settings().org, name, { fresh: true });
  assert.equal(await repoMirror.resolveBranch(dir, 'main'), amended);
  assert.equal(execFileSync('git', ['-C', dir, 'cat-file', '-p', `${amended}:b.txt`]).toString(), 'b\n', 'blobs are there');

  // Private: refused to an anonymous clone, served to the service account.
  await gitHost.setPrivate(name, true);
  assert.throws(() => execFileSync('git', ['-c', 'credential.helper=', 'ls-remote', gitHost.cloneUrl(name)],
    { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false' }, stdio: 'pipe' }));
  assert.equal(await gitHost.readRef(name, 'main'), amended);
});

test('a private project supports scoped Git and pinned source downloads through a read-only web process', {
  skip: skip || !(process.env.FORGEJO_TEST_READ_USER && process.env.FORGEJO_TEST_READ_TOKEN),
  timeout: 120_000,
}, async (t) => {
  const gitHost = require('../src/services/git-host');
  const hostedGit = require('../src/services/hosted-git');
  const source = require('../src/services/project-source');
  const express = require('express');
  const { once } = require('node:events');
  const { promisify } = require('node:util');
  const exec = promisify(require('node:child_process').execFile);
  const app = express().use(require('../src/routes/project-source').internalProjectSourceRoutes({}));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.closeAllConnections());
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');

  const name = `private-${crypto.randomBytes(4).toString('hex')}`;
  const made = await hostedGit.createRepo(gitHost.settings().org, name, { private: true });
  assert.equal(made.private, true);
  const first = await gitHost.readRef(name);
  const direct = gitHost.cloneUrl(name);
  const noPrompt = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false' };
  await assert.rejects(exec('git', ['-c', 'credential.helper=', 'ls-remote', direct], { env: noPrompt }));
  const privateReader = process.env.FORGEJO_TEST_READ_USER;
  await gitHost.api('PUT', `/repos/${gitHost.settings().org}/${name}/collaborators/${privateReader}`, { permission: 'read' });

  const env = {
    PROCESS_ROLE: 'web', GIT_HOST_READ_USER: privateReader, GIT_HOST_READ_TOKEN: process.env.FORGEJO_TEST_READ_TOKEN,
    GIT_HOST_TOKEN: '', GIT_HOST_PRIVATE_PROJECTS: name, WORKER_JWT_SECRET: 'test-project-source-signing-key',
    PLATFORM_INTERNAL_URL: `http://127.0.0.1:${server.address().port}`,
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, old] of Object.entries(previous)) {
      if (old == null) delete process.env[key];
      else process.env[key] = old;
    }
  });

  const { url, token: grant } = source.workloadRead(gitHost.settings().org, name);
  const refs = `${url}/info/refs?service=git-upload-pack`;
  const auth = { Authorization: `Bearer ${grant}` };
  assert.equal((await fetch(refs)).status, 404);
  assert.equal((await fetch(refs.replace(name, 'another-repository'), { headers: auth })).status, 404);
  assert.equal((await fetch(refs.replace('git-upload-pack', 'git-receive-pack'), { headers: auth })).status, 404);
  const expired = source.issueGrant(name, 'git', {}, -1);
  assert.equal((await fetch(refs, { headers: { Authorization: `Bearer ${expired}` } })).status, 404);

  const clone = path.join(root, name);
  await exec('git', [
    `--config-env=http.${url}.extraHeader=PROJECT_SOURCE_HEADER`,
    '-c', 'http.followRedirects=false', 'clone', '--quiet', url, clone,
  ], { env: { ...noPrompt, PROJECT_SOURCE_HEADER: `Authorization: Bearer ${grant}` } });
  assert.equal((await exec('git', ['-C', clone, 'rev-parse', 'HEAD'])).stdout.trim(), first);
  assert.equal((await exec('git', ['-C', clone, 'remote', 'get-url', 'origin'])).stdout.trim(), url);

  const workerClone = path.join(root, `${name}-worker`);
  await exec('sh', [
    '-c', '. ./worker/session-branch.sh; usernode_source_git clone --quiet "$PROJECT_SOURCE_CANONICAL" "$1"',
    'private-project-worker', workerClone,
  ], {
    cwd: path.join(__dirname, '..'),
    env: { ...noPrompt, PROJECT_SOURCE_URL: url, PROJECT_SOURCE_CANONICAL: direct, PROJECT_SOURCE_TOKEN: grant },
  });
  assert.equal((await exec('git', ['-C', workerClone, 'rev-parse', 'HEAD'])).stdout.trim(), first);
  assert.equal((await exec('git', ['-C', workerClone, 'remote', 'get-url', 'origin'])).stdout.trim(), direct);

  const webClone = path.join(root, `${name}-web`);
  await source.checkoutGit(made.html_url, direct)(['clone', '--quiet', direct, webClone]);
  assert.equal((await exec('git', ['-C', webClone, 'rev-parse', 'HEAD'])).stdout.trim(), first);

  const archive = source.buildArchiveUrl(made.html_url, first, 60);
  assert.equal((await fetch(archive.replace(first, 'b'.repeat(40)))).status, 404);
  const download = await fetch(archive);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('cache-control'), 'private, no-store');
  const tar = path.join(root, `${name}.tar.gz`);
  fs.writeFileSync(tar, Buffer.from(await download.arrayBuffer()));
  const entries = (await exec('tar', ['-tzf', tar])).stdout;
  assert.match(entries, /README\.md/);
  assert.doesNotMatch(entries, /\/\.git(?:\/|\n)/);

  const bundleFile = path.join(root, `${name}.bundle`);
  await source.bundle(name, first, Object.assign(fs.createWriteStream(bundleFile), { set() {}, attachment() {} }));
  assert.equal((await exec('git', ['bundle', 'list-heads', bundleFile, 'refs/heads/source'])).stdout.trim(),
    `${first} refs/heads/source`);
});

test('Forgejo visibility backfills private projects and retries an approved publication', {
  skip: skip || !process.env.TEST_DATABASE_URL,
  timeout: 120_000,
}, async (t) => {
  const { Pool } = require('pg');
  const gitHost = require('../src/services/git-host');
  const visibility = require('../src/services/project-repo-visibility');
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  t.after(() => pool.end());
  const name = `backfill-${crypto.randomBytes(4).toString('hex')}`;
  const repo = await gitHost.createRepo(name);
  const previous = process.env.GIT_HOST_PRIVATE_PROJECTS;
  const previousWrite = process.env.GIT_HOST_PRIVATE_PROJECTS_WRITE;
  process.env.GIT_HOST_PRIVATE_PROJECTS = name;
  process.env.GIT_HOST_PRIVATE_PROJECTS_WRITE = 'true';
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_HOST_PRIVATE_PROJECTS;
    else process.env.GIT_HOST_PRIVATE_PROJECTS = previous;
    if (previousWrite === undefined) delete process.env.GIT_HOST_PRIVATE_PROJECTS_WRITE;
    else process.env.GIT_HOST_PRIVATE_PROJECTS_WRITE = previousWrite;
  });

  await pool.query(`CREATE TEMP TABLE apps (
    id INTEGER PRIMARY KEY, slug TEXT, status TEXT, repo_url TEXT, self_hosted BOOLEAN DEFAULT FALSE,
    collab_visibility TEXT, view_visibility TEXT, manifest_snapshot JSONB
  )`);
  await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/migrations/forgejo-publication-pending.sql'), 'utf8'));
  await pool.query(
    `INSERT INTO apps (id, slug, status, repo_url, collab_visibility, view_visibility)
       VALUES (1, $1, 'running', $2, 'private', 'private')`,
    [name, repo.url],
  );
  const repoPrivacy = async () => (await gitHost.api('GET', `/repos/${repo.owner}/${name}`)).data.private;
  assert.equal(await repoPrivacy(), false);
  assert.deepEqual(await visibility.sweep(pool), { checked: 1, failed: 0 });
  assert.equal(await repoPrivacy(), true);

  const current = async () => (await pool.query('SELECT * FROM apps WHERE id = 1')).rows[0];
  await visibility.record(pool, await current(), { collab: 'public', view: 'public' });
  assert.equal((await current()).repo_publication_pending, true);
  assert.equal(await repoPrivacy(), true);
  const unavailable = t.mock.method(gitHost, 'setPrivate', async () => { throw new Error('Forgejo unavailable'); });
  assert.deepEqual(await visibility.sweep(pool), { checked: 0, failed: 1 });
  assert.equal((await current()).repo_publication_pending, true);
  unavailable.mock.restore();
  assert.deepEqual(await visibility.sweep(pool), { checked: 1, failed: 0 });
  assert.equal((await current()).repo_publication_pending, false);
  assert.equal(await repoPrivacy(), false);

  await visibility.record(pool, await current(), { collab: 'private', view: 'private' });
  assert.equal((await current()).view_visibility, 'private');
  assert.equal(await repoPrivacy(), true);
});
