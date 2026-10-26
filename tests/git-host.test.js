'use strict';

// The git host app code lives on (services/git-host.js): Forgejo as plain
// storage, after GitHub suspended the account that owned every app
// repository (25 Oct 2026). Pinned here:
//
//   1. Addresses: apps.repo_url is the repository's page on GIT_HOST_URL,
//      parsed in one place, clone URLs internal or public.
//   2. Refs against a real git server stand-in (bare repositories over
//      file://): readRef, the initial commit, compare-and-swap that refuses
//      a moved ref with the `headMoved` sentinel, deleteRef through the API.
//   3. createRepo through the host's API, adopting an existing repository
//      only when asked.
//   4. The service account's token never reaches argv or a URL.
//
// Run with: node --test tests/git-host.test.js

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

const gitHost = require('../src/services/git-host');

function withEnv(t, vars) {
  const prior = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

// A git server stand-in: <root>/apps/<name>.git bare repositories, reached
// as file://<root>/apps/<name>.git through GIT_HOST_INTERNAL_URL.
function fakeHost(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-host-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  withEnv(t, {
    GIT_HOST_URL: 'https://git.example.test',
    GIT_HOST_INTERNAL_URL: `file://${root}`,
    GIT_HOST_ORG: 'apps',
    GIT_HOST_USER: 'homeroom',
    GIT_HOST_TOKEN: 'secret-token-value',
  });
  const bare = (name) => {
    const dir = path.join(root, 'apps', `${name}.git`);
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', dir]);
    return dir;
  };
  return { root, bare };
}

function localCommit(dir, file, content, parent = null) {
  if (!fs.existsSync(path.join(dir, '.git'))) execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  if (parent) execFileSync('git', ['-C', dir, 'checkout', '-q', '--detach', parent]);
  fs.writeFileSync(path.join(dir, file), content);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', file]);
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim();
}

test('repo_url is the page on the public host, parsed in one place', (t) => {
  withEnv(t, { GIT_HOST_URL: 'https://git.example.test/', GIT_HOST_INTERNAL_URL: 'http://forgejo-http.forgejo:3000', GIT_HOST_ORG: undefined });
  assert.equal(gitHost.repoUrl('todo-list-b91765'), 'https://git.example.test/apps/todo-list-b91765');
  assert.deepEqual(gitHost.parseRepoUrl('https://git.example.test/apps/todo-list-b91765'), { owner: 'apps', name: 'todo-list-b91765' });
  assert.deepEqual(gitHost.parseRepoUrl('https://GIT.example.test/apps/x.git/'), { owner: 'apps', name: 'x' });
  assert.deepEqual(gitHost.parseRepoUrl('http://forgejo-http.forgejo:3000/apps/x.git'), { owner: 'apps', name: 'x' });
  assert.equal(gitHost.parseRepoUrl('https://github.com/usernode-bot/x'), null);
  assert.equal(gitHost.parseRepoUrl('https://git.example.test/apps/x/extra'), null);
  assert.equal(gitHost.parseRepoUrl('https://git.example.test.evil.com/apps/x'), null);
  assert.equal(gitHost.cloneUrl('x'), 'http://forgejo-http.forgejo:3000/apps/x.git');
  assert.equal(gitHost.cloneUrl('https://git.example.test/apps/x', { internal: false }), 'https://git.example.test/apps/x.git');
  assert.throws(() => gitHost.repoUrl('../etc'), /Invalid repository name/);
  assert.throws(() => gitHost.repoUrl('x.git'), /Invalid repository name/);
});

test('isConfigured needs a URL and the service account', (t) => {
  withEnv(t, { GIT_HOST_URL: 'https://git.example.test', GIT_HOST_USER: 'homeroom', GIT_HOST_TOKEN: undefined });
  assert.equal(gitHost.isConfigured(), false);
  process.env.GIT_HOST_TOKEN = 't';
  assert.equal(gitHost.isConfigured(), true);
});

test('the first commit, readRef, and a compare-and-swap that refuses a moved ref', async (t) => {
  const { bare } = fakeHost(t);
  bare('app-one');
  assert.equal(await gitHost.readRef('app-one', 'main'), null, 'an empty repository has no main');

  const first = await gitHost.pushInitialFiles('app-one', { 'README.md': '# One\n', 'src/index.js': 'x\n' });
  assert.match(first, /^[0-9a-f]{40}$/);
  assert.equal(await gitHost.readRef('app-one', 'main'), first);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'git-host-work-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  execFileSync('git', ['clone', '-q', gitHost.cloneUrl('app-one'), work]);
  const second = localCommit(work, 'a.txt', 'a\n');
  await gitHost.casUpdateRef('app-one', work, 'main', first, second);
  assert.equal(await gitHost.readRef('app-one', 'main'), second);

  // A merge pinned to the old main: refused, with the shared sentinel.
  const stale = localCommit(work, 'b.txt', 'b\n', first);
  await assert.rejects(gitHost.casUpdateRef('app-one', work, 'main', first, stale), (err) => {
    assert.equal(err.headMoved, true);
    assert.equal(err.name, 'RefMovedError');
    return true;
  });
  assert.equal(await gitHost.readRef('app-one', 'main'), second, 'main did not move');

  // A ref that must not exist yet.
  await gitHost.casUpdateRef('app-one', work, 'proposal/x', null, stale);
  assert.equal(await gitHost.readRef('app-one', 'proposal/x'), stale);
  await assert.rejects(gitHost.casUpdateRef('app-one', work, 'proposal/x', null, second), (err) => err.headMoved === true);
  assert.deepEqual(Object.keys(await gitHost.listBranches('app-one')).sort(), ['main', 'proposal/x']);
});

test('pushInitialFiles refuses a path out of the repository', async (t) => {
  const { bare } = fakeHost(t);
  bare('app-two');
  await assert.rejects(gitHost.pushInitialFiles('app-two', { '../escape.txt': 'x' }), /Invalid file path/);
});

test('createRepo goes through the host API and adopts an existing one only when asked', async (t) => {
  withEnv(t, { GIT_HOST_URL: 'https://git.example.test', GIT_HOST_INTERNAL_URL: 'http://forgejo.internal', GIT_HOST_USER: 'homeroom', GIT_HOST_TOKEN: 'tok' });
  const prior = global.fetch;
  t.after(() => { global.fetch = prior; });
  const sent = [];
  let status = 201;
  global.fetch = async (url, init) => {
    sent.push({ url, init });
    return new Response(JSON.stringify({}), { status });
  };
  const made = await gitHost.createRepo('new-app', { description: 'A thing' });
  assert.deepEqual(made, { owner: 'apps', name: 'new-app', url: 'https://git.example.test/apps/new-app' });
  assert.equal(sent[0].url, 'http://forgejo.internal/api/v1/orgs/apps/repos');
  assert.equal(sent[0].init.headers.Authorization, 'token tok');
  assert.deepEqual(JSON.parse(sent[0].init.body), { name: 'new-app', description: 'A thing', private: false, auto_init: false, default_branch: 'main' });
  status = 409;
  await assert.rejects(gitHost.createRepo('new-app'), (err) => err.code === 'repo_exists');
  assert.equal((await gitHost.createRepo('new-app', { adoptExisting: true })).name, 'new-app');
});

test('the service token never reaches argv or a URL', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/git-host.js'), 'utf8');
  assert.match(src, /credential\.helper=\$\{CREDENTIAL_HELPER\}/);
  assert.match(src, /password=\$USERNODE_GIT_HOST_TOKEN/);
  assert.doesNotMatch(src, /\$\{s\.token\}@|:\$\{s\.token\}|token\)\}@/);
});
