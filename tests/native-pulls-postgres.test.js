'use strict';

// Native pull requests and merges (services/native-pulls.js,
// services/native-merge.js), through services/github.js's pull-request
// helpers, for an app on the git host: real PostgreSQL, a bare repository
// over file:// standing in for Forgejo, and the real mirror
// (services/repo-mirror.js).
//
// GitHub's pinned squash merge moved every proposal into main until GitHub
// suspended the account that owned the repositories (25 Oct 2026). Pinned
// here: the same outcomes, made by Homeroom with git: a merge only at the
// reviewed head (else the headMoved sentinel), a conflict refused with
// GitHub's wording, main moved by compare-and-swap ("Base branch was
// modified" when it moved underneath), and a retried merge answering the
// first one.
//
// TEST_DATABASE_URL selects a local test database, like the other
// *-postgres tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Pool } = require('pg');

const loggerId = require.resolve('../src/services/logger');
require.cache[loggerId] = {
  id: loggerId, filename: loggerId, loaded: true, paths: [],
  exports: { info() {}, debug() {}, warn() {}, error() {} },
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-pulls-'));
process.env.USERNODE_MIRROR_ROOT = path.join(root, 'mirrors');
fs.mkdirSync(process.env.USERNODE_MIRROR_ROOT);

const github = require('../src/services/github');
const gitHost = require('../src/services/git-host');
const requests = require('../src/services/requests');

function sh(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]).toString().trim();
}

test('a proposal is opened, read, refused and merged by Homeroom itself', { timeout: 120000 }, async (t) => {
  const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
  }
  const name = 'native_pulls_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const env = {
    GIT_HOST_URL: 'https://git.example.test', GIT_HOST_INTERNAL_URL: `file://${root}/host`, GIT_HOST_ORG: 'apps',
    GIT_HOST_USER: 'homeroom', GIT_HOST_TOKEN: 'tok', USERNODE_DOMAIN: 'app.example.test',
  };
  const prior = {};
  for (const [k, v] of Object.entries(env)) { prior[k] = process.env[k]; process.env[k] = v; }
  t.after(async () => {
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    requests._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  requests._resetForTests();
  requests.setPool(pool);
  await pool.query(`INSERT INTO apps (name, slug, repo_url) VALUES ('X', 'x-1', 'https://git.example.test/apps/x-1')`);

  // The git host: apps/x-1.git with main, and a working clone people push from.
  const bare = path.join(root, 'host', 'apps', 'x-1.git');
  fs.mkdirSync(bare, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const work = path.join(root, 'work');
  execFileSync('git', ['clone', '-q', bare, work]);
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(work, 'b.txt'), 'shared\n');
  sh(work, 'add', '-A'); sh(work, 'commit', '-q', '-m', 'first'); sh(work, 'push', '-q', 'origin', 'HEAD:main');
  const main0 = sh(work, 'rev-parse', 'HEAD');

  // A proposal branch with one change.
  sh(work, 'checkout', '-q', '-b', 'dev/one');
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\ntwo\n');
  sh(work, 'commit', '-q', '-am', 'two');
  sh(work, 'push', '-q', 'origin', 'dev/one');
  const head1 = sh(work, 'rev-parse', 'HEAD');

  // Opened: the next number, the change's Homeroom page.
  const pr = await github.createPR('apps', 'x-1', { branch: 'dev/one', title: 'Add two', body: 'Closes #3', draft: false });
  assert.equal(pr.number, 1);
  assert.equal(pr.html_url, 'https://app.example.test/#app/x-1/dev/changes/1');
  assert.equal(pr.head.ref, 'dev/one');
  assert.equal(pr.head.sha, head1);
  await assert.rejects(github.createPR('apps', 'x-1', { branch: 'dev/one', title: 'again' }), (err) => err.code === 'pr_exists');
  sh(work, 'push', '-q', 'origin', `${main0}:refs/heads/dev/empty`);
  await assert.rejects(github.createPR('apps', 'x-1', { branch: 'dev/empty', title: 'nothing' }), (err) => err.code === 'no_commits');

  // Read: live head and base, mergeability from merge-tree.
  const read = await github.getPR('apps', 'x-1', 1);
  assert.equal(read.state, 'open');
  assert.equal(read.merged, false);
  assert.equal(read.mergeable, true);
  assert.equal(read.mergeable_state, 'clean');
  assert.equal(read.base.sha, main0);
  assert.equal((await github.findOpenPrByBranch('apps', 'x-1', 'dev/one')).number, 1);
  assert.deepEqual((await github.listOpenPulls('apps', 'x-1')).map((p) => p.number), [1]);
  await github.updatePR('apps', 'x-1', 1, { title: 'Add a second line' });

  // Pinned to an older head: refused with the headMoved sentinel, main untouched.
  await assert.rejects(github.mergePR('apps', 'x-1', 1, main0), (err) => err.headMoved === true && err.status === 409);
  assert.equal(await gitHost.readRef('x-1', 'main'), main0);

  // Merged at the reviewed head: one squash commit on main, parent the old main.
  const merged = await github.mergePR('apps', 'x-1', 1, head1);
  assert.match(merged.sha, /^[0-9a-f]{40}$/);
  assert.equal(await gitHost.readRef('x-1', 'main'), merged.sha);
  sh(work, 'fetch', '-q', 'origin');
  assert.equal(sh(work, 'rev-parse', `${merged.sha}^`), main0);
  assert.equal(sh(work, 'rev-list', '--count', `${merged.sha}^@`), '1', 'one parent: a squash');
  assert.equal(sh(work, 'show', `${merged.sha}:a.txt`), 'one\ntwo');
  assert.match(sh(work, 'log', '-1', '--format=%s', merged.sha), /^Add a second line \(#1\)$/);
  // Asked again (a lost answer): the same merge, not a second one.
  assert.equal((await github.mergePR('apps', 'x-1', 1, head1)).sha, merged.sha);
  const after = await github.getPR('apps', 'x-1', 1);
  assert.equal(after.merged, true);
  assert.equal(after.merge_commit_sha, merged.sha);
  assert.equal(after.head.sha, head1);
  assert.deepEqual((await github.listPullRequestCommitShas('apps', 'x-1', 1)).shas, [head1]);
  await assert.rejects(github.reopenPR('apps', 'x-1', 1), (err) => err.status === 422);

  // A conflict with main: refused in GitHub's words, main untouched.
  sh(work, 'checkout', '-q', '-b', 'dev/clash', main0);
  fs.writeFileSync(path.join(work, 'a.txt'), 'something else\n');
  sh(work, 'commit', '-q', '-am', 'clash');
  sh(work, 'push', '-q', 'origin', 'dev/clash');
  const clash = await github.createPR('apps', 'x-1', { branch: 'dev/clash', title: 'Clash' });
  assert.equal(clash.number, 2);
  assert.equal((await github.getPR('apps', 'x-1', 2)).mergeable_state, 'dirty');
  await assert.rejects(github.mergePR('apps', 'x-1', 2, sh(work, 'rev-parse', 'HEAD')), (err) => {
    assert.equal(err.status, 405);
    assert.match(err.message, /merge conflict/);
    assert.deepEqual(err.conflicts, ['a.txt']);
    return true;
  });
  assert.equal(await gitHost.readRef('x-1', 'main'), merged.sha);

  // Main moved between the read and the swap: "Base branch was modified".
  sh(work, 'checkout', '-q', '-b', 'dev/three', merged.sha);
  fs.writeFileSync(path.join(work, 'c.txt'), 'three\n');
  sh(work, 'add', '-A'); sh(work, 'commit', '-q', '-m', 'three');
  sh(work, 'push', '-q', 'origin', 'dev/three');
  const head3 = sh(work, 'rev-parse', 'HEAD');
  await github.createPR('apps', 'x-1', { branch: 'dev/three', title: 'Three' });
  const realCas = gitHost.casUpdateRef;
  gitHost.casUpdateRef = async () => { throw new gitHost.RefMovedError('moved'); };
  try {
    await assert.rejects(github.mergePR('apps', 'x-1', 3, head3), (err) => err.status === 405 && /Base branch was modified/.test(err.message));
  } finally {
    gitHost.casUpdateRef = realCas;
  }
  assert.equal((await github.getPR('apps', 'x-1', 3)).merged, false, 'not recorded as merged');
  assert.match((await github.mergePR('apps', 'x-1', 3, head3)).sha, /^[0-9a-f]{40}$/, 'the retry merges');

  // Close and reopen; a draft is not mergeable.
  sh(work, 'checkout', '-q', '-b', 'dev/four', merged.sha);
  fs.writeFileSync(path.join(work, 'd.txt'), 'four\n');
  sh(work, 'add', '-A'); sh(work, 'commit', '-q', '-m', 'four');
  sh(work, 'push', '-q', 'origin', 'dev/four');
  await github.createPR('apps', 'x-1', { branch: 'dev/four', title: 'Four', draft: true });
  await assert.rejects(github.mergePR('apps', 'x-1', 4, sh(work, 'rev-parse', 'HEAD')), (err) => err.status === 405 && /draft/.test(err.message));
  assert.equal((await github.markPrReadyForReview('apps', 'x-1', 4)).draft, false);
  assert.equal((await github.closePR('apps', 'x-1', 4)).state, 'closed');
  assert.equal((await github.reopenPR('apps', 'x-1', 4)).state, 'open');

  // Requests and proposals share the app's numbers.
  const filed = await github.createIssue('apps', 'x-1', { title: 'A request' });
  assert.equal(filed.number, 5);
  assert.deepEqual(await github.fetchPublicIssue('apps', 'x-1', 1), { issue: null, note: 'not an issue (pull request)' });
});
