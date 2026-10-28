// Forking runs no shell of its own.
//
// The runtime image is node:22-alpine plus git and postgresql-client
// (Dockerfile.kubernetes): there is no bash in it. app-forker.js ran two of
// its steps through `bash -c` — the flatten of the cloned tree and the
// init/add/commit/push/rev-parse of the fork's single squashed commit — so
// every fork on Kubernetes died with "spawn bash ENOENT" before it wrote a
// byte. The flatten is plain fs now and each git step is its own process.
//
// Two things are pinned beyond "no bash": the flatten's exact semantics
// (every .git goes, a nested .gitmodules stays, symlinks are not followed),
// and where the copy is pushed: Homeroom's git host, as its service account
// (services/git-host.js git, auth: true). The GitHub path, which pushed with
// the bot's token, is gone with the account GitHub suspended: a copy whose
// owner is not the git host's is refused before anything is cloned.
//
// Run with: node --test tests/app-forker-no-shell.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/services/app-forker.js'), 'utf8');

// Homeroom's git host, as services/git-host.js reads it (at call time).
const HOST_TOKEN = 'test-host-token-9f1c2d';
process.env.GIT_HOST_URL = 'https://git.homeroom.test';
process.env.GIT_HOST_ORG = 'apps';
process.env.GIT_HOST_USER = 'homeroom';
process.env.GIT_HOST_TOKEN = HOST_TOKEN;

// ── Module stubs, installed before the forker loads ─────────────────────
function stubModule(rel, exportsObj) {
  const full = require.resolve(rel);
  delete require.cache[full];
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
  return exportsObj;
}
const calls = [];
stubModule('../src/services/logger', { info() {}, warn() {}, error() {}, debug() {} });
stubModule('../src/services/github', {
  isEnabled: () => true,
  parseGithubUrl: () => ({ owner: 'source-owner', repo: 'source-app' }),
  getCloneUrl: async () => 'https://git.homeroom.test/apps/source-app.git',
  getBotUsername: async () => 'apps',
  createRepo: async () => ({ html_url: 'https://git.homeroom.test/apps/forked-app' }),
});
stubModule('../src/services/docker', {
  execFileAsync: async (command, args, options = {}) => {
    calls.push({ command, args, options });
    // Two rev-parses: the clone's HEAD (the source commit copied), read
    // before the flatten, then the copy's own squashed commit after the push.
    if (command === 'git' && args[0] === 'rev-parse') {
      const n = calls.filter((c) => c.command === 'git' && c.args[0] === 'rev-parse').length;
      return { stdout: n === 1 ? 'source0sha\n' : 'abc123def\n', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  },
});
stubModule('../src/services/db-manager', {});
stubModule('../src/services/app-manifest', { read: () => ({ secrets: [] }) });
stubModule('../src/services/app-secrets', {});
stubModule('../src/db/pool', { getPool: () => ({ query: async () => ({ rows: [] }) }) });
stubModule('../src/services/ws', { pushAppStatusUpdate() {} });
stubModule('../src/services/app-creator', {
  createApp: async () => {}, finalizeDeploy: async () => {}, reportPhase() {}, endPhases() {},
});
stubModule('../src/services/template', {
  getConnectorScaffoldFiles: () => [],
  getCanonicalRepoFile: () => null,
});
// The push goes through git-host.git, which runs git with the service
// account itself: recorded in the same list instead. Its settings and
// addresses are the real ones, read from the environment above.
const gitHost = require('../src/services/git-host');
gitHost.git =async (args, options = {}) => {
  calls.push({ command: 'git-host', args, options });
  return { stdout: '', stderr: '' };
};
delete require.cache[require.resolve('../src/services/app-forker')];
const forker = require('../src/services/app-forker');

// A tree the way `git clone --recurse-submodules` leaves one.
function clonedTree(dir) {
  fs.mkdirSync(path.join(dir, '.git', 'objects'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.mkdirSync(path.join(dir, 'vendor', 'lib', 'deep'), { recursive: true });
  // A submodule checkout: a .git FILE pointing back at the superproject.
  fs.writeFileSync(path.join(dir, 'vendor', 'lib', '.git'), 'gitdir: ../../.git/modules/lib\n');
  fs.writeFileSync(path.join(dir, 'vendor', 'lib', 'index.js'), 'module.exports = 1;\n');
  // A submodule with submodules of its own: its .gitmodules is a plain file
  // once flattened, and stays — exactly as the find did.
  fs.writeFileSync(path.join(dir, 'vendor', 'lib', '.gitmodules'), '[submodule "deep"]\n');
  fs.writeFileSync(path.join(dir, 'vendor', 'lib', 'deep', 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(dir, '.gitmodules'), '[submodule "vendor/lib"]\n');
  fs.writeFileSync(path.join(dir, 'dapp.json'), JSON.stringify({
    name: 'Source App',
    admins: ['someone'],
    visibility: { build: 'public', view: 'public' },
    governance: { approvers: 'invited', approvals: { atLeast: 2 } },
    followOriginal: false,
    icon: { emoji: '📚' },
  }));
  fs.writeFileSync(path.join(dir, 'README.md'), '# source\n');
}

test('the fork path spawns no shell', () => {
  assert.doesNotMatch(SRC, /execFileAsync\(\s*'(?:bash|sh)'/, 'no bash -c, no sh -c');
  assert.doesNotMatch(SRC, /shell:\s*true/);
  // No credential of its own: the git host's service account answers the
  // push inside git-host.git, and the bot token is read by nothing.
  assert.doesNotMatch(SRC, /GITHUB_BOT_TOKEN|\$PAT|credential\.helper/);
});

test('flattenTree removes every .git and the top-level .gitmodules, and nothing else', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-flatten-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-outside-'));
  try {
    clonedTree(dir);
    // A symlinked directory holding a .git of its own: find without -L did
    // not follow it, and neither does this — the target is not ours.
    fs.mkdirSync(path.join(outside, '.git'));
    fs.writeFileSync(path.join(outside, '.git', 'HEAD'), 'x');
    fs.symlinkSync(outside, path.join(dir, 'linked'));

    await forker.flattenTree(dir);

    assert.equal(fs.existsSync(path.join(dir, '.git')), false, 'the repository directory is gone');
    assert.equal(fs.existsSync(path.join(dir, 'vendor', 'lib', '.git')), false, 'the submodule pointer file is gone');
    assert.equal(fs.existsSync(path.join(dir, '.gitmodules')), false, 'the top-level .gitmodules is gone');
    assert.equal(fs.existsSync(path.join(dir, 'vendor', 'lib', '.gitmodules')), true, 'a nested one stays, as before');
    assert.equal(fs.readFileSync(path.join(dir, 'vendor', 'lib', 'index.js'), 'utf8'), 'module.exports = 1;\n');
    assert.equal(fs.existsSync(path.join(dir, 'vendor', 'lib', 'deep', 'a.txt')), true);
    assert.equal(fs.existsSync(path.join(dir, 'README.md')), true);
    assert.equal(fs.existsSync(path.join(outside, '.git', 'HEAD')), true, 'the symlink target was not followed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('copyRepoTree: one git process per step, in the fork tree, pushed to the git host as its service account', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-copy-'));
  calls.length = 0;
  try {
    // The clone is stubbed to nothing, so what it would have produced is
    // laid down first; the `rm -rf` before it is stubbed too.
    clonedTree(tempDir);
    const result = await forker.copyRepoTree({
      sourceApp: { slug: 'source-app', repo_url: 'https://git.homeroom.test/apps/source-app' },
      botUsername: 'apps', forkSlug: 'forked-app', forkName: 'Forked App', tempDir,
    });
    assert.deepEqual(result, {
      repoUrl: 'https://git.homeroom.test/apps/forked-app',
      mainSha: 'abc123def',
      sourceSha: 'source0sha',
    });

    assert.ok(calls.every((c) => c.command !== 'bash' && c.command !== 'sh'), 'no shell was spawned');
    const git = calls.filter((c) => c.command === 'git' || c.command === 'git-host');
    const step = (c) => (c.command === 'git-host' ? c.args[2] : c.args.find((a) => !a.startsWith('-') && !a.includes('=')));
    assert.deepEqual(git.map(step),
      ['clone', 'rev-parse', 'init', 'add', 'commit', 'push', 'rev-parse'], 'the steps, in order');
    const [clone, sourceRev, init, add, commit, push, revParse] = git;
    // The source commit is read from the clone, before the flatten removes
    // its .git: the commit actually copied, not the source row's main_sha.
    assert.deepEqual(sourceRev.args, ['rev-parse', 'HEAD']);
    assert.equal(sourceRev.options.cwd, tempDir);
    assert.deepEqual(init.args, ['init', '-q', '-b', 'main']);
    assert.deepEqual(add.args, ['add', '-A']);
    assert.ok(commit.args.includes('Forked from source-app'), 'the commit message names the source');
    assert.deepEqual(revParse.args, ['rev-parse', 'HEAD']);
    for (const s of [init, add, commit, revParse]) {
      assert.equal(s.options.cwd, tempDir, `${s.args[0]} runs in the fork tree`);
    }
    assert.equal(clone.options.cwd, undefined, 'the clone runs from wherever, into the tree');

    // The push: from the fork tree to the copy's repository on the git
    // host, answered by its service account (git-host.git, auth: true).
    assert.equal(push.command, 'git-host');
    assert.deepEqual(push.args, ['-C', tempDir, 'push', '-q', '--force', 'https://git.homeroom.test/apps/forked-app.git', 'HEAD:main']);
    assert.equal(push.options.auth, true);
    // No step carries a credential of its own, in an argument or its env.
    for (const c of calls) {
      assert.ok(!JSON.stringify(c).includes(HOST_TOKEN), `${c.command} ${c.args[0]}: no credential passed`);
      assert.ok(!(c.options.env && 'PAT' in c.options.env), `${c.command} ${c.args[0]}: no PAT`);
    }

    // The tree the commit was made from: flattened, renamed, and the
    // original's admins, visibility and governance stripped.
    assert.equal(fs.existsSync(path.join(tempDir, '.git')), false);
    assert.equal(fs.existsSync(path.join(tempDir, 'vendor', 'lib', '.git')), false);
    const manifest = JSON.parse(fs.readFileSync(path.join(tempDir, 'dapp.json'), 'utf8'));
    assert.equal(manifest.name, 'Forked App');
    assert.equal(manifest.admins, undefined);
    assert.equal(manifest.visibility, undefined);
    assert.equal(manifest.governance, undefined);
    assert.deepEqual(manifest.icon, { emoji: '📚' }, 'the look comes with the code');
    // Whether the version gets the original's updates is the maker's choice
    // (on unless turned off), not the original's own followOriginal line.
    assert.equal(manifest.followOriginal, true);
    assert.equal(Object.keys(manifest).pop(), 'followOriginal', 'written last');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('rewriteDappName writes the maker\'s followOriginal over the original\'s', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-follow-'));
  try {
    fs.writeFileSync(path.join(dir, 'dapp.json'), JSON.stringify({ name: 'A', followOriginal: true, tests: [] }));
    forker.rewriteDappName(dir, 'B', { follow: false });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'dapp.json'), 'utf8')),
      { name: 'B', tests: [], followOriginal: false });
    fs.rmSync(path.join(dir, 'dapp.json'));
    forker.rewriteDappName(dir, 'C');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'dapp.json'), 'utf8')),
      { name: 'C', followOriginal: true }, 'on by default, even with no dapp.json to start from');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing push is reported as the repo push failing, with git-host\'s redacted message', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-fail-'));
  const stubbedHostGit = gitHost.git;
  // git-host.git rejects with the service account's token already redacted
  // (its redact(), tests/worker-git-push.test.js); the reason passes it on.
  const redacted = 'git push failed: remote: Permission denied for homeroom:***';
  gitHost.git = async () => { throw new Error(redacted); };
  try {
    clonedTree(tempDir);
    await assert.rejects(
      () => forker.copyRepoTree({
        sourceApp: { slug: 'source-app', repo_url: null }, botUsername: 'apps',
        forkSlug: 'forked-app', forkName: 'Forked App', tempDir,
      }),
      (err) => {
        assert.equal(err.repoFailed, true, 'classified as the repo stage');
        assert.equal(err.message, `fork repo push failed: ${redacted}`);
        assert.doesNotMatch(err.message, new RegExp(HOST_TOKEN), 'no token in the reason');
        return true;
      }
    );
  } finally {
    gitHost.git = stubbedHostGit;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// GitHub suspended the bot whose token pushed copies to GitHub (25 Oct
// 2026). Without a git host, the copy's owner is a GitHub account, and the
// copy is refused with createRepo's own error before anything is cloned.
test('a copy for an owner that is not the git host\'s is refused before anything runs', async () => {
  const prior = process.env.GIT_HOST_URL;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-github-'));
  try {
    for (const [hostUrl, owner] of [['https://git.homeroom.test', 'usernode-bot'], ['', 'apps']]) {
      process.env.GIT_HOST_URL = hostUrl;
      calls.length = 0;
      await assert.rejects(
        () => forker.copyRepoTree({
          sourceApp: { slug: 'source-app', repo_url: 'https://github.com/usernode-bot/source-app' },
          botUsername: owner, forkSlug: 'forked-app', forkName: 'Forked App', tempDir,
        }),
        (err) => {
          assert.equal(err.code, 'git_host_not_configured');
          assert.match(err.message, /New repositories are made on Homeroom's git host, and it is not configured/);
          return true;
        },
        `${owner} with GIT_HOST_URL=${hostUrl || '(unset)'}`,
      );
      assert.deepEqual(calls, [], 'no clone, no git, no push');
    }
  } finally {
    process.env.GIT_HOST_URL = prior;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
