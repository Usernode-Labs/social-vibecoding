'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  collectCommitUpload,
  validateUploadPath,
} = require('../src/cli/git-upload');

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', shell: false,
  });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout.trim();
}

test('collectCommitUpload snapshots the exact committed tree changes, modes, and metadata', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-cli-git-upload-'));
  try {
    git(repo, ['init', '-q']);
    await fs.writeFile(path.join(repo, 'old.txt'), 'remove me\n');
    await fs.writeFile(path.join(repo, 'same.txt'), 'base\n');
    git(repo, ['add', '.']);
    git(repo, ['-c', 'user.name=Local Tester', '-c', 'user.email=test@example.invalid',
      'commit', '-qm', 'Base']);
    const parent = git(repo, ['rev-parse', 'HEAD']);
    const parentTree = git(repo, ['rev-parse', 'HEAD^{tree}']);

    await fs.rm(path.join(repo, 'old.txt'));
    await fs.writeFile(path.join(repo, 'same.txt'), 'updated $() & bytes\n');
    await fs.writeFile(path.join(repo, 'run.sh'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
    await fs.symlink('same.txt', path.join(repo, 'link'));
    git(repo, ['add', '-A']);
    git(repo, ['-c', 'user.name=Local Tester', '-c', 'user.email=test@example.invalid',
      'commit', '-qm', 'Implement locally']);
    const commit = git(repo, ['rev-parse', 'HEAD']);
    const tree = git(repo, ['rev-parse', 'HEAD^{tree}']);

    const result = collectCommitUpload(repo, commit);
    assert.equal(result.repo, await fs.realpath(repo));
    assert.equal(result.payload.localCommitSha, commit);
    assert.equal(result.payload.parentSha, parent);
    assert.equal(result.payload.parentTreeSha, parentTree);
    assert.equal(result.payload.treeSha, tree);
    assert.equal(result.payload.message, 'Implement locally');
    assert.ok(Number.isFinite(Date.parse(result.payload.authoredAt)));
    assert.ok(Number.isFinite(Date.parse(result.payload.committedAt)));
    const byPath = new Map(result.payload.files.map((file) => [file.path, file]));
    assert.deepEqual(byPath.get('old.txt'), { path: 'old.txt', delete: true });
    assert.equal(byPath.get('same.txt').mode, '100644');
    assert.equal(Buffer.from(byPath.get('same.txt').contentBase64, 'base64').toString(),
      'updated $() & bytes\n');
    assert.equal(byPath.get('run.sh').mode, '100755');
    assert.equal(byPath.get('link').mode, '120000');
    assert.equal(Buffer.from(byPath.get('link').contentBase64, 'base64').toString(), 'same.txt');
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('upload paths reject traversal, git internals, and control characters', () => {
  assert.equal(validateUploadPath('src/ok.js'), 'src/ok.js');
  for (const bad of ['/absolute', '../escape', 'a/../b', '.git/config', 'a/.GIT/x', 'a\nname']) {
    assert.throws(() => validateUploadPath(bad), /unsupported file path/);
  }
});

test('collectCommitUpload treats Git pathspec-looking filenames literally', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-cli-git-literal-path-'));
  try {
    git(repo, ['init', '-q']);
    await fs.writeFile(path.join(repo, 'base.txt'), 'base\n');
    git(repo, ['add', '.']);
    git(repo, ['-c', 'user.name=Local Tester', '-c', 'user.email=test@example.invalid',
      'commit', '-qm', 'Base']);

    const filename = ':(literal)feature.txt';
    await fs.writeFile(path.join(repo, filename), 'literal path\n');
    git(repo, ['--literal-pathspecs', 'add', '--', filename]);
    git(repo, ['-c', 'user.name=Local Tester', '-c', 'user.email=test@example.invalid',
      'commit', '-qm', 'Add literal path']);
    const commit = git(repo, ['rev-parse', 'HEAD']);

    const { payload } = collectCommitUpload(repo, commit);
    assert.deepEqual(payload.files, [{
      path: filename,
      mode: '100644',
      contentBase64: Buffer.from('literal path\n').toString('base64'),
    }]);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('collectCommitUpload represents a file-to-directory transition exactly', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-cli-git-file-dir-'));
  try {
    git(repo, ['init', '-q']);
    await fs.writeFile(path.join(repo, 'config'), 'old file\n');
    git(repo, ['add', '.']);
    git(repo, ['-c', 'user.name=Local Tester', '-c', 'user.email=test@example.invalid',
      'commit', '-qm', 'Base']);

    await fs.rm(path.join(repo, 'config'));
    await fs.mkdir(path.join(repo, 'config'));
    await fs.writeFile(path.join(repo, 'config', 'index.js'), 'module.exports = true;\n');
    git(repo, ['add', '-A']);
    git(repo, ['-c', 'user.name=Local Tester', '-c', 'user.email=test@example.invalid',
      'commit', '-qm', 'Turn config into a directory']);
    const commit = git(repo, ['rev-parse', 'HEAD']);

    const { payload } = collectCommitUpload(repo, commit);
    assert.deepEqual(payload.files, [
      { path: 'config', delete: true },
      {
        path: 'config/index.js',
        mode: '100644',
        contentBase64: Buffer.from('module.exports = true;\n').toString('base64'),
      },
    ]);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});
