'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const worker = require('../src/services/worker');
const github = require('../src/services/github');
const workerGitPush = require('../src/services/worker-git-push');
const docker = require('../src/services/docker');
const kubernetes = require('../src/services/kubernetes');
const db = require('../src/db/pool');

const token = 'fake-platform-github-credential-for-tests';
const branch = 'dev/test@example.invalid-123';
const sha = 'a'.repeat(40);
const sessionId = 91001;

function setup(t, runtime = 'docker') {
  const previous = { runtime: process.env.WORKER_RUNTIME };
  process.env.WORKER_RUNTIME = runtime;
  t.after(() => {
    if (previous.runtime === undefined) delete process.env.WORKER_RUNTIME;
    else process.env.WORKER_RUNTIME = previous.runtime;
    worker._registryForgetForTests(sessionId);
  });
  // The GitHub App's installation token for the stored owner, the only
  // GitHub credential the push uses (services/github.js "Who Homeroom is on
  // GitHub"); Homeroom can act on that owner.
  t.mock.method(github, 'canActOn', () => true);
  t.mock.method(github, 'getInstallationToken', async (owner) => {
    assert.equal(owner, 'Trusted-Owner', 'the owner is read from the stored address');
    return token;
  });
  const fx = { target: { branch_name: branch, repo_url: 'https://github.com/Trusted-Owner/stored-repo.git' }, queries: [], execs: [], pushes: [] };
  t.mock.method(db, 'getPool', () => ({ query: async (sql, params) => {
    fx.queries.push({ sql, params });
    return { rows: fx.target ? [fx.target] : [] };
  } }));
  t.mock.method(docker, 'execFileAsync', async (command, args, options) => {
    assert.equal(runtime, 'docker');
    assert.equal(command, 'docker');
    assert.deepEqual(args.slice(0, 3), ['exec', `usernode-worker-${sessionId}`, 'sh']);
    assert.ok(!args.includes('-e'), 'no credential environment injection');
    fx.execs.push({ command: args, options });
    return { stdout: 'exported objects', stderr: '' };
  });
  t.mock.method(kubernetes, 'execInWorker', async (_config, name, command, stdin, options) => {
    assert.equal(runtime, 'kubernetes');
    assert.equal(name, `sv-worker-s${sessionId}`);
    assert.equal(stdin, null, 'no credential-bearing stdin script');
    fx.execs.push({ command, stdin, options });
    return { stdout: 'exported objects', stderr: '' };
  });
  t.mock.method(workerGitPush, 'push', async options => {
    fx.pushes.push(options);
    assert.equal(options.remoteUrl, 'https://github.com/Trusted-Owner/stored-repo.git');
    assert.equal(options.branchName, branch);
    assert.equal(options.token, token, 'credential goes only to the trusted pusher');
    const result = await options.exportWorker('export only Git objects');
    assert.equal(result.stdout, 'exported objects');
    return { sha, stderr: '' };
  });
  return fx;
}

for (const runtime of ['docker', 'kubernetes']) {
  test(`${runtime}: credential never enters worker argv, stdin or environment`, async t => {
    const fx = setup(t, runtime);
    assert.deepEqual(await worker.execPushFromWorker(sessionId, branch), { sha, stderr: '' });
    assert.equal(fx.pushes.length, 1);
    assert.equal(fx.execs.length, 2, 'export, then credential-free tracking update');
    assert.equal(JSON.stringify(fx.execs).includes(token), false);
    assert.equal(JSON.stringify(fx.execs).includes('GITHUB_BOT_TOKEN'), false);
    assert.equal(JSON.stringify(fx.execs).includes('USERNODE_PUSH_TOKEN'), false);
    assert.equal(fx.execs[0].options.maxBuffer, workerGitPush.MAX_EXPORT_BYTES);
    assert.equal(fx.execs[0].options.timeoutMs || fx.execs[0].options.timeout, 60000);
    assert.equal(fx.queries[0].params[0], sessionId);
  });
}

test('push rejects missing or changed stored session branches before contacting a worker', async t => {
  const fx = setup(t);
  for (const target of [null, { ...fx.target, branch_name: 'main' }]) {
    fx.target = target;
    await assert.rejects(worker.execPushFromWorker(sessionId, branch), /branch has changed or no longer exists/);
  }
  assert.equal(fx.execs.length, 0);
  assert.equal(fx.pushes.length, 0);
});

test('only canonical GitHub HTTPS destinations from platform state are accepted', async t => {
  const fx = setup(t);
  for (const repo_url of [
    'https://github.com.attacker.invalid/owner/repo', 'https://attacker.invalid/github.com/owner/repo',
    'https://github.com@attacker.invalid/owner/repo', 'https://user:secret@github.com/owner/repo',
    'https://github.com:443/owner/repo', 'http://github.com/owner/repo',
    'file:///tmp/repo', 'ext::echo stolen', 'git@github.com:owner/repo.git',
    'https://github.com/owner/..', 'https://github.com/owner/.git',
    'https://github.com/owner/repo?redirect=elsewhere', 'https://github.com/owner/repo#fragment',
    'https://github.com/owner/repo/extra', 'https://github.com/owner/repo\n',
  ]) {
    fx.target.repo_url = repo_url;
    await assert.rejects(worker.execPushFromWorker(sessionId, branch), /Invalid canonical GitHub/);
  }
  assert.equal(fx.execs.length, 0);
  assert.equal(fx.pushes.length, 0);
});

test('a failed worker tracking update still reports the successful trusted push', async t => {
  const fx = setup(t);
  t.mock.method(docker, 'execFileAsync', async () => { throw new Error('worker no longer available'); });
  t.mock.method(workerGitPush, 'push', async () => ({ sha, stderr: '' }));
  assert.equal((await worker.execPushFromWorker(sessionId, branch)).sha, sha);
  assert.equal(fx.execs.length, 0);
});

test('push failures redact every occurrence of the credential and preserve unpushed state', async t => {
  setup(t);
  worker._registryUpsertForTests(sessionId, { unpushed: { sha, branchName: branch } });
  t.mock.method(workerGitPush, 'push', async () => {
    const error = new Error(`${token} twice ${token}`);
    error.stderr = `${token} twice ${token}`;
    throw error;
  });
  await assert.rejects(worker.execPushFromWorker(sessionId, branch), error => {
    assert.equal(error.code, 'push_failed');
    assert.equal(error.message.includes(token), false);
    assert.equal(error.stderr.includes(token), false);
    return true;
  });
  assert.deepEqual(await worker.rescueUnpushedCommit(sessionId), { attempted: true, pushed: false });
  t.mock.method(workerGitPush, 'push', async () => ({ sha, stderr: '' }));
  assert.deepEqual(await worker.rescueUnpushedCommit(sessionId), { attempted: true, pushed: true });
  assert.deepEqual(await worker.rescueUnpushedCommit(sessionId), { attempted: false });
});
