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
