'use strict';

// GitHub's git-data helpers for a repository on Homeroom's git host
// (services/hosted-git.js), through services/github.js as every caller
// reaches them: reads from the app's mirror, writes built there and pushed
// with a compare-and-swap. A bare repository over file:// stands in for
// Forgejo; its one API call (making a repository) is stubbed.
//
// Run with: node --test tests/hosted-git.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const loggerId = require.resolve('../src/services/logger');
require.cache[loggerId] = {
  id: loggerId, filename: loggerId, loaded: true, paths: [],
  exports: { info() {}, debug() {}, warn() {}, error() {} },
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-git-'));
process.env.USERNODE_MIRROR_ROOT = path.join(root, 'mirrors');
fs.mkdirSync(process.env.USERNODE_MIRROR_ROOT);
Object.assign(process.env, {
  GIT_HOST_URL: 'https://git.example.test', GIT_HOST_INTERNAL_URL: `file://${root}/host`, GIT_HOST_ORG: 'apps',
  GIT_HOST_USER: 'homeroom', GIT_HOST_TOKEN: 'tok',
});

const github = require('../src/services/github');
const gitHost = require('../src/services/git-host');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function sh(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]).toString().trim();
}

// The API's one job here, making the (empty) repository, as Forgejo would.
function stubCreateApi(t) {
  const prior = global.fetch;
  t.after(() => { global.fetch = prior; });
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const dir = path.join(root, 'host', 'apps', `${body.name}.git`);
    if (fs.existsSync(dir)) return new Response('{}', { status: 409 });
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', dir]);
    return new Response('{}', { status: 201 });
  };
}

test('new app repositories are made on the git host, with a first commit to build on', async (t) => {
  stubCreateApi(t);
  assert.equal(await github.getBotUsername(), 'apps', 'the owner a new repository is made under');
  const made = await github.createRepo('apps', 'todo-1', { description: 'A list' });
  assert.equal(made.html_url, 'https://git.example.test/apps/todo-1');
  assert.equal(made.full_name, 'apps/todo-1');
  assert.ok(await gitHost.readRef('todo-1', 'main'), 'GitHub\'s auto_init commit');
  await assert.rejects(github.createRepo('apps', 'todo-1'), (err) => err.code === 'repo_exists');
  assert.equal((await github.createRepo('apps', 'todo-1', { adoptExisting: true })).adopted, true);

  const pushed = await github.pushFiles('apps', 'todo-1', [
    { path: 'index.html', content: '<p>hi</p>\n' }, { path: 'src/app.js', content: 'x\n' },
  ], { message: 'Starter' });
  assert.equal(await gitHost.readRef('todo-1', 'main'), pushed.sha);
  assert.equal(await github.getFileContent('apps', 'todo-1', 'src/app.js', 'main'), 'x\n');
  assert.equal(await github.getFileContent('apps', 'todo-1', 'README.md'), '# todo-1\n\nA list\n', 'the first commit kept');
  assert.equal(await github.getFileContent('apps', 'todo-1', 'nope.txt', 'main'), null);
  const listed = await github.listRepoFiles('apps', 'todo-1', 'main');
  assert.deepEqual(listed.files.map((f) => f.path).sort(), ['README.md', 'index.html', 'src/app.js']);
  assert.equal((await github.headCommit('apps', 'todo-1', 'main')).message, 'Starter');
  assert.equal((await github.getRepoHead('apps', 'todo-1')).headSha, pushed.sha);
  assert.equal(await github.getCloneUrl('apps', 'todo-1'), `file://${root}/host/apps/todo-1.git`);
});

test('branches: created, compared, advanced only forward, forced, and a bench branch deleted', async (t) => {
  stubCreateApi(t);
  await github.createRepo('apps', 'br-1');
  const main0 = await gitHost.readRef('br-1', 'main');
  await github.createBranch('apps', 'br-1', 'dev/a');
  assert.equal(await github.getBranchSha('apps', 'br-1', 'dev/a'), main0);
  await assert.rejects(github.createBranch('apps', 'br-1', 'dev/a'), (err) => err.status === 422);
  await assert.rejects(github.getBranchSha('apps', 'br-1', 'dev/none'), (err) => err.status === 404);

  const a1 = await github.pushFiles('apps', 'br-1', [{ path: 'a.txt', content: 'one\n' }], { branch: 'dev/a', message: 'a1' });
  const a2 = await github.pushFiles('apps', 'br-1', [{ path: 'a.txt', content: 'one\ntwo\n' }], { branch: 'dev/a', message: 'a2' });
  const anc = await github.compareCommitAncestry('apps', 'br-1', main0, a2.sha);
  assert.deepEqual(anc, { status: 'ahead', aheadBy: 2, behindBy: 0, mergeBaseSha: main0 });
  assert.equal((await github.compareCommitAncestry('apps', 'br-1', a2.sha, main0)).status, 'behind');
  assert.deepEqual(await github.getCommitParents('apps', 'br-1', a2.sha), [a1.sha]);
  assert.equal(await github.getCommitTree('apps', 'br-1', a2.sha), a2.tree.sha);

  // The comparison helpers, GitHub-shaped.
  assert.deepEqual(await github.listChangedFiles('apps', 'br-1', `main...dev/a`), ['a.txt']);
  const refs = await github.compareRefs('apps', 'br-1', `${main0}...${a2.sha}`);
  assert.deepEqual(refs, { mergeBaseSha: main0, files: ['a.txt'], filesComplete: true });
  const subjects = await github.compareCommitSubjects('apps', 'br-1', 'main', 'dev/a');
  assert.deepEqual(subjects.commits.map((c) => c.subject), ['a1', 'a2']);
  assert.equal(subjects.totalCommits, 2);
  const diff = await github.getProposalDiff('apps', 'br-1', 'main...dev/a');
  assert.equal(diff.fileCount, 1);
  assert.match(diff.diff, /^diff --git a\/a\.txt b\/a\.txt\n@@ -0,0 \+1,2 @@\n\+one\n\+two\n/);
  const files = await github.compareFiles('apps', 'br-1', 'main...dev/a');
  assert.deepEqual(files.files, [{ filename: 'a.txt', status: 'added', additions: 2, deletions: 0, previous: null }]);
  assert.equal(files.aheadBy, 2);

  // Fast-forward only.
  await github.createBranch('apps', 'br-1', 'dev/ff');
  assert.deepEqual(await github.advanceBranchToSha('apps', 'br-1', 'dev/ff', a2.sha), { previousSha: main0, sha: a2.sha, updated: true });
  assert.equal((await github.advanceBranchToSha('apps', 'br-1', 'dev/ff', a2.sha)).updated, false);
  const root1 = await github.createRootCommit('apps', 'br-1', [{ path: 'x.txt', content: 'x' }], { message: 'root' });
  await assert.rejects(github.advanceBranchToSha('apps', 'br-1', 'dev/ff', root1), (err) => err.code === 'non_fast_forward');
  assert.deepEqual(await github.forceBranchToSha('apps', 'br-1', 'dev/ff', root1), { previousSha: a2.sha, sha: root1, updated: true });
  assert.equal(await gitHost.readRef('br-1', 'dev/ff'), root1, 'the root commit reached the host with the move');

  // An exact branch for a handoff.
  assert.deepEqual(await github.ensureBranchAtSha('apps', 'br-1', 'cli/one', a1.sha), { sha: a1.sha, created: true });
  assert.deepEqual(await github.ensureBranchAtSha('apps', 'br-1', 'cli/one', a1.sha), { sha: a1.sha, created: false });
  await assert.rejects(github.ensureBranchAtSha('apps', 'br-1', 'cli/one', a2.sha), (err) => err.code === 'branch_conflict');

  // Bench branches only.
  await github.forceBranchToSha('apps', 'br-1', 'dev/ff', a2.sha);
  await gitHost.casUpdateRef('br-1', path.join(process.env.USERNODE_MIRROR_ROOT, 'usernode-mirror-apps-br-1.git'), 'bench/x', null, a2.sha);
  assert.equal(await github.deleteBenchBranch('apps', 'br-1', 'bench/x'), true);
  assert.equal(await github.deleteBenchBranch('apps', 'br-1', 'bench/x'), false);
  await assert.rejects(github.deleteBenchBranch('apps', 'br-1', 'dev/a'), /not a benchmark branch/);
});

test('the CLI handoff commit: the tested tree, only from the expected parent', { skip: false }, async (t) => {
  stubCreateApi(t);
  await github.createRepo('apps', 'cli-1');
  await github.createBranch('apps', 'cli-1', 'proposal/x');
  const parent = await gitHost.readRef('cli-1', 'proposal/x');
  // The agent's local commit: README changed, new file, computed with git itself.
  const local = path.join(root, 'cli-local');
  execFileSync('git', ['clone', '-q', gitHost.cloneUrl('cli-1'), local]);
  sh(local, 'checkout', '-q', 'proposal/x');
  const parentTree = sh(local, 'rev-parse', 'HEAD^{tree}');
  fs.writeFileSync(path.join(local, 'README.md'), '# changed\n');
  fs.mkdirSync(path.join(local, 'bin'));
  fs.writeFileSync(path.join(local, 'bin', 'run'), '#!/bin/sh\n');
  fs.chmodSync(path.join(local, 'bin', 'run'), 0o755);
  sh(local, 'add', '-A');
  sh(local, 'commit', '-q', '-m', 'Local change');
  const localSha = sh(local, 'rev-parse', 'HEAD');
  const expectedTree = sh(local, 'rev-parse', 'HEAD^{tree}');
  const b64 = (p) => fs.readFileSync(path.join(local, p)).toString('base64');
  const args = {
    branchName: 'proposal/x', expectedRemoteParentSha: parent, localParentSha: parent, localParentTreeSha: parentTree,
    expectedTreeSha: expectedTree, localCommitSha: localSha, message: 'Local change',
    authoredAt: '2026-10-26T10:00:00Z', committedAt: '2026-10-26T10:01:00Z',
    files: [
      { path: 'README.md', mode: '100644', contentBase64: b64('README.md') },
      { path: 'bin/run', mode: '100755', contentBase64: b64('bin/run') },
    ],
  };
  const made = await github.createProposalCommit('apps', 'cli-1', args);
  assert.equal(made.created, true);
  assert.equal(made.previousSha, parent);
  assert.equal(await gitHost.readRef('cli-1', 'proposal/x'), made.sha);
  sh(local, 'fetch', '-q', 'origin');
  assert.equal(sh(local, 'rev-parse', `${made.sha}^{tree}`), expectedTree, 'exactly the tested tree');
  // The author date as a number: the worker image's git writes UTC as +00:00, a newer one as Z.
  assert.equal(sh(local, 'log', '-1', '--format=%an|%at', made.sha), `Homeroom CLI|${Date.parse('2026-10-26T10:00:00Z') / 1000}`);
  // Sent again after a lost answer: the same commit.
  assert.deepEqual(await github.createProposalCommit('apps', 'cli-1', args), { ...made, created: false });
  // From a parent the branch has left: refused.
  await assert.rejects(github.createProposalCommit('apps', 'cli-1', { ...args, message: 'other', expectedRemoteParentSha: parent }),
    (err) => err.code === 'branch_moved' && err.currentSha === made.sha);
  // A tree that is not the tested one: refused.
  await assert.rejects(github.createProposalCommit('apps', 'cli-1', {
    ...args, expectedRemoteParentSha: made.sha, localParentTreeSha: expectedTree, message: 'm2',
    expectedTreeSha: '0'.repeat(40), files: [{ path: 'gone.txt', delete: true }],
  }), (err) => err.code === 'tree_mismatch');
});

test('a revert is made on the mirror and pushed to its own branch; a conflict is refused', async (t) => {
  stubCreateApi(t);
  await github.createRepo('apps', 'rv-1');
  await github.pushFiles('apps', 'rv-1', [{ path: 'a.txt', content: 'one\n' }, { path: 'b.txt', content: 'b\n' }], { message: 'start' });
  const change = await github.pushFiles('apps', 'rv-1', [{ path: 'a.txt', content: 'two\n' }], { message: 'change a' });
  await github.pushFiles('apps', 'rv-1', [{ path: 'b.txt', content: 'b2\n' }], { message: 'change b' });
  const hostedGit = require('../src/services/hosted-git');
  const revert = await hostedGit.revertOnto('apps', 'rv-1', change.sha, { branch: 'revert/x', message: 'Revert: change a' });
  assert.equal(await gitHost.readRef('rv-1', 'revert/x'), revert);
  assert.equal(await github.getFileContent('apps', 'rv-1', 'a.txt', 'revert/x'), 'one\n', 'the change is undone');
  assert.equal(await github.getFileContent('apps', 'rv-1', 'b.txt', 'revert/x'), 'b2\n', 'later work is kept');
  assert.equal((await github.getCommitParents('apps', 'rv-1', revert))[0], await gitHost.readRef('rv-1', 'main'), 'on top of main');

  // Main changed the same lines since: git revert would conflict, so does this.
  await github.pushFiles('apps', 'rv-1', [{ path: 'a.txt', content: 'three\n' }], { message: 'change a again' });
  await assert.rejects(hostedGit.revertOnto('apps', 'rv-1', change.sha, { branch: 'revert/y', message: 'm' }), /merge conflicts/);
  assert.equal(await gitHost.readRef('rv-1', 'revert/y'), null);
});

// A change made before its app moved off GitHub names a branch that may only
// ever have existed there (services/code-missing.js branchGone). Read live,
// with git's own answer, before anything runs on the change.
test('a change\'s branch that did not come across reads as gone, live; pushed back it is there at once; an unreadable host says nothing', async (t) => {
  stubCreateApi(t);
  await github.createRepo('apps', 'moved-1');
  const repoUrl = 'https://git.example.test/apps/moved-1';
  const codeMissing = require('../src/services/code-missing');
  // The change predates its app's move: its row, as PRE_MOVE_SQL answers it.
  const pool = {
    query: async (sql, params) => ({ rows: Number(params[0]) === 7 ? [{ branch_name: 'dev/ada-old', repo_url: repoUrl }] : [] }),
  };
  const change = { id: 7, branch_name: 'dev/ada-old', repo_url: repoUrl };
  assert.ok(await gitHost.readRef('moved-1', 'main'), 'main came across');
  assert.equal(await codeMissing.branchGone(pool, change), true);

  // A local agent's or a CLI hand-off's upload to it fails as a 404, which
  // the routes tell apart from GitHub being unavailable.
  await assert.rejects(github.createProposalCommit('apps', 'moved-1', {
    branchName: 'dev/ada-old', expectedRemoteParentSha: 'a'.repeat(40), localParentSha: 'a'.repeat(40),
    localParentTreeSha: 'b'.repeat(40), expectedTreeSha: 'c'.repeat(40), localCommitSha: 'd'.repeat(40),
    message: 'x', authoredAt: '2026-10-26T10:00:00Z', committedAt: '2026-10-26T10:00:00Z', files: [],
  }), (err) => err.status === 404);

  // Pushed back under its name (from GitHub's copy): there at the next read,
  // with no list cache to wait out.
  await github.createBranch('apps', 'moved-1', 'dev/ada-old');
  assert.equal(await codeMissing.branchGone(pool, change), false);

  // A repository the host cannot read: unknown, never gone.
  const missingRepo = { query: async () => ({ rows: [{ branch_name: 'dev/x', repo_url: 'https://git.example.test/apps/no-such-repo' }] }) };
  assert.equal(await codeMissing.branchGone(missingRepo, { id: 8 }), null);
});
