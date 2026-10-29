'use strict';

// What a git child of a submitted patch is given (services/git-child.js,
// external-agent-head.js withScratchRepo, external-agent-patch.js
// applyPatch): none of this process's secrets, a write credential only in
// the environment of the fetch and the push, through git's credential
// helper, and never in argv.
//
// Real git against a real HTTP git host (tests/lib/fake-git-host.js, which
// answers only its service account): every git process the code starts is
// recorded by a `git` placed first on PATH, which logs its argv and its
// environment and then runs the real git.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startFakeGitHost, TOKEN, USER, ORG } = require('./lib/fake-git-host');
const gitChild = require('../src/services/git-child');

const PLANTED = {
  DATABASE_URL: 'postgres://planted-db-user:planted-db-secret@db.invalid/app',
  GITHUB_PRIVATE_KEY: 'planted-github-private-key',
  OPENROUTER_MANAGEMENT_KEY: 'planted-openrouter-key',
  SESSION_SECRET: 'planted-session-secret',
};
const SECRETS = [...Object.values(PLANTED), TOKEN];

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git']).toString().trim();

function realGit(cwd, ...args) {
  return execFileSync(REAL_GIT, ['-C', cwd, '-c', 'user.name=Ada', '-c', 'user.email=ada@example.test',
    '-c', 'commit.gpgsign=false', ...args], {
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' },
  }).toString();
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
    // git's own argv: past the `-c x` and `-C dir` global options.
    const words = argv.split('\n');
    let i = 0;
    while (words[i] === '-c' || words[i] === '-C') i += 2;
    return { argv, env, sub: words[i], dir: words[words.indexOf('-C') + 1] || null };
  });
}

function plantSecrets(t) {
  const prior = {};
  for (const [k, v] of Object.entries(PLANTED)) { prior[k] = process.env[k]; process.env[k] = v; }
  t.after(() => {
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

// An app repository on the git host, private (a read needs the service
// account too), with one commit on main.
function seedRepo(host, root, name) {
  const bare = host.makeRepo(name, { private: true });
  const work = path.join(root, `${name}-work`);
  fs.mkdirSync(work);
  realGit(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'index.html'), '<p>High tide</p>\n');
  realGit(work, 'add', '-A');
  realGit(work, 'commit', '-qm', 'First');
  realGit(work, 'push', '-q', bare, 'HEAD:main');
  return { work, bare, base: realGit(work, 'rev-parse', 'HEAD').trim() };
}

test('a git child is given only what git needs, and a credential only through the helper', () => {
  const allowed = new Set(['PATH', 'HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL',
    'GIT_TERMINAL_PROMPT', 'GIT_ASKPASS', 'LC_ALL', 'TZ']);
  const prior = { ...process.env };
  try {
    Object.assign(process.env, PLANTED, { GIT_HOST_TOKEN: TOKEN });
    const plain = gitChild.invocation(['-C', '/tmp/x', 'am', 'p.patch'], { home: '/tmp/h' });
    assert.deepEqual(Object.keys(plain.env).filter((k) => !allowed.has(k)), [], 'nothing of the process\'s own environment');
    assert.deepEqual(plain.args.slice(-4), ['-C', '/tmp/x', 'am', 'p.patch']);
    assert.ok(!plain.args.some((a) => a.includes('USERNODE_GIT')), 'no helper without a credential');

    const authed = gitChild.invocation(['push', 'https://github.com/o/r.git', 'HEAD:refs/heads/x'], {
      home: '/tmp/h', credential: { username: 'x-access-token', token: 'ghs_only_in_env' },
    });
    assert.ok(!authed.args.join(' ').includes('ghs_only_in_env'), 'the token is never an argument');
    assert.ok(authed.args.includes(`credential.helper=${gitChild.HELPER}`));
    assert.ok(authed.args.includes('http.followRedirects=false'), 'the credential follows no redirect');
    assert.equal(authed.env.USERNODE_GIT_PASSWORD, 'ghs_only_in_env');
    assert.equal(authed.env.USERNODE_GIT_USERNAME, 'x-access-token');
    for (const secret of [...Object.values(PLANTED), TOKEN]) {
      assert.ok(!JSON.stringify(authed).includes(secret), `no ${secret} in the push either`);
    }
    assert.throws(() => gitChild.invocation(['status'], {}), /home/);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in prior)) delete process.env[k];
    Object.assign(process.env, prior);
  }
});

test('applying a submitted patch: no git child holds a secret, and only the fetch and the push hold the credential', { timeout: 60000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-git-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const host = await startFakeGitHost(t);
  const repo = seedRepo(host, root, 'tide-log');
  realGit(repo.work, 'checkout', '-q', '-b', 'work');
  fs.writeFileSync(path.join(repo.work, 'index.html'), '<p><b>High tide</b></p>\n');
  realGit(repo.work, 'commit', '-qam', 'Bold the high tide');
  const patch = realGit(repo.work, 'format-patch', '--stdout', `${repo.base}..HEAD`);

  plantSecrets(t);
  const records = recordGit(t, root);
  const patchSvc = require('../src/services/external-agent-patch');
  const out = await patchSvc.applyPatch({ owner: ORG, repo: 'tide-log', patch, baseSha: repo.base, userId: 3, taskId: 7 });
  assert.equal(out.ok, true, `${out.code}: ${out.message} ${out.detail || ''}`);
  assert.equal(out.credential, 'git_host');
  assert.equal(host.branchSha('tide-log', out.branch), out.headSha, 'the push landed, answered through the helper');

  const all = records();
  const ours = all.filter((r) => r.dir && r.dir.includes('usernode-head-patch-7-'));
  const subs = ours.map((r) => r.sub);
  for (const sub of ['fetch', 'apply', 'am', 'push']) assert.ok(subs.includes(sub), `${sub} ran: ${subs.join(', ')}`);
  for (const r of all) {
    for (const secret of SECRETS) assert.ok(!r.argv.includes(secret), `git ${r.sub}'s argv holds a secret`);
  }
  for (const r of ours) {
    for (const secret of Object.values(PLANTED)) assert.ok(!r.env.includes(secret), `git ${r.sub}'s environment holds ${secret}`);
    assert.doesNotMatch(r.env, /^GIT_HOST_TOKEN=/m, `git ${r.sub} is not handed the platform's environment`);
    const credentialed = /^USERNODE_GIT_PASSWORD=/m.test(r.env);
    assert.equal(credentialed, ['fetch', 'push'].includes(r.sub), `git ${r.sub} ${credentialed ? 'holds' : 'lacks'} the credential`);
    if (credentialed) {
      assert.match(r.env, new RegExp(`^USERNODE_GIT_PASSWORD=${TOKEN}$`, 'm'));
      assert.match(r.env, new RegExp(`^USERNODE_GIT_USERNAME=${USER}$`, 'm'));
    } else {
      assert.ok(!r.env.includes(TOKEN), `git ${r.sub} never sees the write credential`);
    }
    // git's HOME is outside the work tree it runs in.
    const home = /^HOME=(.*)$/m.exec(r.env)[1];
    assert.ok(!home.startsWith(r.dir), `git ${r.sub}'s HOME is not inside the tree`);
  }
});

test('a .gitconfig a patch adds is a file in the tree, never git\'s own configuration', { timeout: 60000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-git-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const host = await startFakeGitHost(t);
  const repo = seedRepo(host, root, 'harbour');
  const marker = path.join(root, 'hook-ran');
  // A hook the patch ships, and the configuration that would run it with
  // whatever environment git has, from the two places a HOME inside the
  // work tree made git read its global configuration.
  realGit(repo.work, 'checkout', '-q', '-b', 'work');
  const config = '[core]\n\thooksPath = h\n';
  fs.writeFileSync(path.join(repo.work, '.gitconfig'), config);
  fs.mkdirSync(path.join(repo.work, '.config', 'git'), { recursive: true });
  fs.writeFileSync(path.join(repo.work, '.config', 'git', 'config'), config);
  fs.mkdirSync(path.join(repo.work, 'h'));
  fs.writeFileSync(path.join(repo.work, 'h', 'pre-commit'), `#!/bin/sh\nenv > '${marker}'\n`, { mode: 0o755 });
  realGit(repo.work, 'add', '-A');
  realGit(repo.work, 'commit', '-qm', 'Ship a hook');
  // A plain diff, so the patch path makes the commit itself.
  const patch = realGit(repo.work, 'diff', '--binary', repo.base, 'HEAD');

  plantSecrets(t);
  const patchSvc = require('../src/services/external-agent-patch');
  const out = await patchSvc.applyPatch({ owner: ORG, repo: 'harbour', patch, baseSha: repo.base, userId: 3, taskId: 8 });
  assert.equal(out.ok, true, `${out.code}: ${out.message} ${out.detail || ''}`);
  assert.equal(fs.existsSync(marker), false, `the patch's hook ran: ${fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').slice(0, 200) : ''}`);
  // Committed as what it is: the person's own file.
  assert.equal(realGit(repo.bare, 'show', `${out.headSha}:.gitconfig`), config);
});
