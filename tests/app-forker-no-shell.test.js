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
// and that the bot PAT reaches git through the environment only — which the
// old script promised and, with $PAT inside bash double quotes, did not do.
//
// Run with: node --test tests/app-forker-no-shell.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/services/app-forker.js'), 'utf8');

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
  getCloneUrl: async () => 'https://github.com/source-owner/source-app.git',
  getBotUsername: async () => 'usernode-bot',
  createRepo: async () => ({ html_url: 'https://github.com/usernode-bot/forked-app' }),
});
stubModule('../src/services/docker', {
  execFileAsync: async (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (command === 'git' && args[0] === 'rev-parse') return { stdout: 'abc123def\n', stderr: '' };
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
stubModule('../src/services/template', { getConnectorScaffoldFiles: () => [] });
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
  fs.writeFileSync(path.join(dir, 'dapp.json'), JSON.stringify({ name: 'Source App', admins: ['someone'] }));
  fs.writeFileSync(path.join(dir, 'README.md'), '# source\n');
}

test('the fork path spawns no shell', () => {
  assert.doesNotMatch(SRC, /execFileAsync\(\s*'(?:bash|sh)'/, 'no bash -c, no sh -c');
  assert.doesNotMatch(SRC, /shell:\s*true/);
  // The helper git runs the push with is a literal: $PAT is expanded by
  // git's own sh at helper time, never by us into an argument.
  assert.match(SRC, /credential\.helper=!f\(\) \{ echo username=x-access-token; echo password=\$PAT; \}; f'/);
  assert.doesNotMatch(SRC, /password=\$\{/, 'no template interpolation of the secret');
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

test('copyRepoTree: one git process per step, in the fork tree, with the PAT in the environment only', async () => {
  const previousToken = process.env.GITHUB_BOT_TOKEN;
  process.env.GITHUB_BOT_TOKEN = 'test-pat-9f1c2d';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-copy-'));
  calls.length = 0;
  try {
    // The clone is stubbed to nothing, so what it would have produced is
    // laid down first; the `rm -rf` before it is stubbed too.
    clonedTree(tempDir);
    const result = await forker.copyRepoTree({
      sourceApp: { slug: 'source-app', repo_url: 'https://github.com/source-owner/source-app' },
      botUsername: 'usernode-bot', forkSlug: 'forked-app', forkName: 'Forked App', tempDir,
    });
    assert.deepEqual(result, { repoUrl: 'https://github.com/usernode-bot/forked-app', mainSha: 'abc123def' });

    assert.ok(calls.every((c) => c.command !== 'bash' && c.command !== 'sh'), 'no shell was spawned');
    const git = calls.filter((c) => c.command === 'git');
    assert.deepEqual(git.map((c) => c.args[0] === '-c' ? c.args.find((a, i) => i > 0 && !git[0].args.includes(a) && !a.includes('=') && !a.startsWith('-') && a !== c.args[i - 1]) : c.args[0]),
      ['clone', 'init', 'add', 'commit', 'push', 'rev-parse'], 'the steps, in order');
    const [clone, init, add, commit, push, revParse] = git;
    assert.deepEqual(init.args, ['init', '-q', '-b', 'main']);
    assert.deepEqual(add.args, ['add', '-A']);
    assert.ok(commit.args.includes('Forked from source-app'), 'the commit message names the source');
    assert.deepEqual(push.args.slice(-4), ['-q', '--force', 'https://github.com/usernode-bot/forked-app.git', 'HEAD:main']);
    assert.deepEqual(revParse.args, ['rev-parse', 'HEAD']);
    for (const step of [init, add, commit, push, revParse]) {
      assert.equal(step.options.cwd, tempDir, `${step.args[0]} runs in the fork tree`);
    }
    assert.equal(clone.options.cwd, undefined, 'the clone runs from wherever, into the tree');

    // The secret: in the push's environment, in no argument, anywhere.
    assert.equal(push.options.env.PAT, 'test-pat-9f1c2d');
    for (const c of calls) {
      assert.ok(!c.args.some((a) => String(a).includes('test-pat-9f1c2d')), `${c.command} ${c.args[0]}: no argument carries the token`);
    }
    assert.ok(push.args.some((a) => a.includes('password=$PAT')), 'the helper reads it by name');

    // The tree the commit was made from: flattened, renamed, admins stripped.
    assert.equal(fs.existsSync(path.join(tempDir, '.git')), false);
    assert.equal(fs.existsSync(path.join(tempDir, 'vendor', 'lib', '.git')), false);
    const manifest = JSON.parse(fs.readFileSync(path.join(tempDir, 'dapp.json'), 'utf8'));
    assert.equal(manifest.name, 'Forked App');
    assert.equal(manifest.admins, undefined);
  } finally {
    process.env.GITHUB_BOT_TOKEN = previousToken;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('a failing step after the clone is reported as the repo push failing, with the token redacted', async () => {
  const previousToken = process.env.GITHUB_BOT_TOKEN;
  process.env.GITHUB_BOT_TOKEN = 'test-pat-9f1c2d';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-fail-'));
  const docker = require('../src/services/docker');
  const realExec = docker.execFileAsync;
  docker.execFileAsync = async (command, args) => {
    if (command === 'git' && args.includes('push')) {
      throw new Error('remote: Permission denied for x-access-token:test-pat-9f1c2d');
    }
    return { stdout: '', stderr: '' };
  };
  try {
    clonedTree(tempDir);
    await assert.rejects(
      () => forker.copyRepoTree({
        sourceApp: { slug: 'source-app', repo_url: null }, botUsername: 'usernode-bot',
        forkSlug: 'forked-app', forkName: 'Forked App', tempDir,
      }),
      (err) => {
        assert.equal(err.repoFailed, true, 'classified as the repo stage');
        assert.match(err.message, /fork repo push failed/);
        assert.doesNotMatch(err.message, /test-pat-9f1c2d/, 'the token is redacted');
        return true;
      }
    );
  } finally {
    docker.execFileAsync = realExec;
    process.env.GITHUB_BOT_TOKEN = previousToken;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
