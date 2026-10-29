'use strict';

// A local agent's commit on Homeroom's git host (services/hosted-git.js
// createProposalCommit, which `proposal.commit` asks for on a conductor):
// built in a scratch repository of its own, with every git process run
// through services/git-child.js. None holds this process's secrets; the
// service account reaches only the fetch, the push (and the read of the
// branch after a refused push), through git's credential helper, never
// argv; git's HOME is outside the repository.
//
// Real git against a real HTTP git host (tests/lib/fake-git-host.js, a
// private repository, so even the fetch needs the service account); every
// git process is recorded by a `git` placed first on PATH.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startFakeGitHost, TOKEN, USER, ORG } = require('./lib/fake-git-host');

const PLANTED = {
  DATABASE_URL: 'postgres://planted-db-user:planted-db-secret@db.invalid/app',
  GITHUB_PRIVATE_KEY: 'planted-github-private-key',
  SESSION_SECRET: 'planted-session-secret',
};

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git']).toString().trim();

function realGit(cwd, ...args) {
  return execFileSync(REAL_GIT, ['-C', cwd, '-c', 'user.name=Ada', '-c', 'user.email=ada@example.test',
    '-c', 'commit.gpgsign=false', ...args], {
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' },
  }).toString().trim();
}

// A `git` first on PATH that records each invocation, then runs the real one.
function recordGit(t, root) {
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'git.log');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/bin/sh',
    `{ echo '@@ARGV'; for a in "$@"; do printf '%s\\n' "$a"; done; echo '@@ENV'; env; echo '@@END'; } >> '${log}'`,
    `exec '${REAL_GIT}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  const priorPath = process.env.PATH;
  process.env.PATH = `${bin}:${priorPath}`;
  t.after(() => { process.env.PATH = priorPath; });
  return () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').split('@@END\n').filter(Boolean).map((rec) => {
    const argv = rec.slice(rec.indexOf('@@ARGV\n') + 7, rec.indexOf('@@ENV\n'));
    const env = rec.slice(rec.indexOf('@@ENV\n') + 6);
    const words = argv.split('\n');
    let i = 0;
    while (words[i] === '-c' || words[i] === '-C') i += 2;
    return { argv, env, sub: words[i], dir: words.includes('-C') ? words[words.indexOf('-C') + 1] : null };
  });
}

test('a local agent\'s commit on the git host: no git child holds a secret, and only the fetch and the push hold the credential', { timeout: 60000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-commit-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const host = await startFakeGitHost(t);
  const bare = host.makeRepo('tide-chart', { private: true });
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  realGit(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'index.html'), '<p>High tide</p>\n');
  fs.writeFileSync(path.join(work, 'old.txt'), 'gone soon\n');
  realGit(work, 'add', '-A');
  realGit(work, 'commit', '-qm', 'First');
  const branch = 'dev/cli-u3-req-1';
  realGit(work, 'push', '-q', bare, `HEAD:main`, `HEAD:refs/heads/${branch}`);
  const base = realGit(work, 'rev-parse', 'HEAD');
  const baseTree = realGit(work, 'rev-parse', 'HEAD^{tree}');
  // The agent's tested commit: one file changed, one added, one removed.
  fs.writeFileSync(path.join(work, 'index.html'), '<p><b>High tide</b></p>\n');
  fs.writeFileSync(path.join(work, 'notes.txt'), 'Low at noon\n');
  fs.rmSync(path.join(work, 'old.txt'));
  realGit(work, 'add', '-A');
  realGit(work, 'commit', '-qm', 'Bold the high tide');
  const localCommit = realGit(work, 'rev-parse', 'HEAD');
  const tree = realGit(work, 'rev-parse', 'HEAD^{tree}');

  const prior = {};
  for (const [k, v] of Object.entries(PLANTED)) { prior[k] = process.env[k]; process.env[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const records = recordGit(t, root);
  const github = require('../src/services/github');
  const args = {
    branchName: branch, expectedRemoteParentSha: base, localParentSha: base, localParentTreeSha: baseTree,
    expectedTreeSha: tree, localCommitSha: localCommit, message: 'Bold the high tide',
    authoredAt: '2026-10-29T10:00:00Z', committedAt: '2026-10-29T10:00:01Z',
    files: [
      { path: 'index.html', mode: '100644', contentBase64: Buffer.from('<p><b>High tide</b></p>\n').toString('base64') },
      { path: 'notes.txt', mode: '100644', contentBase64: Buffer.from('Low at noon\n').toString('base64') },
      { path: 'old.txt', delete: true },
    ],
  };
  const made = await github.createProposalCommit(ORG, 'tide-chart', args);
  assert.equal(made.created, true);
  assert.equal(made.previousSha, base);
  assert.equal(host.branchSha('tide-chart', branch), made.sha, 'the push landed, answered through the helper');
  assert.equal(execFileSync(REAL_GIT, ['--git-dir', bare, 'rev-parse', `${made.sha}^{tree}`]).toString().trim(), tree,
    'exactly the tested tree');

  const all = records();
  const ours = all.filter((r) => r.dir && r.dir.includes('hosted-git-commit-'));
  const subs = ours.map((r) => r.sub);
  for (const sub of ['fetch', 'hash-object', 'write-tree', 'commit-tree', 'push']) assert.ok(subs.includes(sub), `${sub} ran: ${subs.join(', ')}`);
  for (const r of all) {
    for (const secret of [...Object.values(PLANTED), TOKEN]) assert.ok(!r.argv.includes(secret), `git ${r.sub}'s argv holds a secret`);
  }
  for (const r of ours) {
    for (const secret of Object.values(PLANTED)) assert.ok(!r.env.includes(secret), `git ${r.sub}'s environment holds ${secret}`);
    assert.doesNotMatch(r.env, /^GIT_HOST_TOKEN=/m, `git ${r.sub} is not handed the platform's environment`);
    const credentialed = /^USERNODE_GIT_PASSWORD=/m.test(r.env);
    assert.equal(credentialed, ['fetch', 'push', 'ls-remote'].includes(r.sub), `git ${r.sub} ${credentialed ? 'holds' : 'lacks'} the credential`);
    if (credentialed) {
      assert.match(r.env, new RegExp(`^USERNODE_GIT_PASSWORD=${TOKEN}$`, 'm'));
      assert.match(r.env, new RegExp(`^USERNODE_GIT_USERNAME=${USER}$`, 'm'));
    } else {
      assert.ok(!r.env.includes(TOKEN), `git ${r.sub} never sees the write credential`);
    }
    const home = /^HOME=(.*)$/m.exec(r.env)[1];
    assert.ok(!home.startsWith(r.dir), `git ${r.sub}'s HOME is not inside the repository`);
  }
  assert.equal(fs.readdirSync(os.tmpdir()).some((d) => d.startsWith('hosted-git-commit-')
    && ours.some((r) => r.dir.includes(d))), false, 'the scratch repository is removed');

  // Asked again after a lost answer: the same commit, nothing pushed.
  const pushes = ours.filter((r) => r.sub === 'push').length;
  assert.deepEqual(await github.createProposalCommit(ORG, 'tide-chart', args), { ...made, created: false });
  assert.equal(records().filter((r) => r.dir && r.dir.includes('hosted-git-commit-') && r.sub === 'push').length, pushes);
  // From a parent the branch has left: refused, before anything is pushed.
  await assert.rejects(github.createProposalCommit(ORG, 'tide-chart', { ...args, message: 'other' }),
    (err) => err.code === 'branch_moved' && err.currentSha === made.sha);
  // A branch the host does not have: GitHub's 404.
  await assert.rejects(github.createProposalCommit(ORG, 'tide-chart', { ...args, branchName: 'dev/cli-u3-gone' }),
    (err) => err.status === 404);
});
