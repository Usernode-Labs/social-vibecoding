// The merge subsystem's new oracle. Every answer this module gives is git's
// own, so these tests drive REAL git against real temporary repositories —
// stubbing it would test the stub and nothing else.
//
// The load-bearing claim is the one in mergeTree's doc comment: a clean
// merge-tree result is bit-for-bit what `git merge` produces. That is what
// lets services/integration.js ask "did anybody write new bytes?" without a
// provenance ledger, so it is asserted here across the three cases that were
// genuinely in doubt — a plain content merge, a rename on one side, and a
// file-mode change.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const mirror = require('../src/services/repo-mirror');

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

// A throwaway repository with a base commit, a proposal branch and a moved
// main. `mainEdit` runs on main, `propEdit` on the proposal branch; both get
// a worktree to write into.
function makeRepo(propEdit, mainEdit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usernode-mirror-test-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  git(dir, 'config', 'user.email', 'test@usernode.invalid');
  git(dir, 'config', 'user.name', 'Homeroom Test');
  git(dir, 'config', 'commit.gpgsign', 'false');

  fs.writeFileSync(path.join(dir, 'a.txt'), 'line1\nline2\nline3\nline4\nline5\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');

  git(dir, 'checkout', '-qb', 'prop');
  propEdit(dir);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'proposal');
  const prop = git(dir, 'rev-parse', 'HEAD');

  git(dir, 'checkout', '-q', 'main');
  mainEdit(dir);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'main moves');
  const main = git(dir, 'rev-parse', 'HEAD');

  return { dir, base, prop, main, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// What an actual merge produces, for comparison against the recomputed one.
function realMergeTree(dir, ours, theirs) {
  git(dir, 'checkout', '-q', ours);
  execFileSync('git', ['-C', dir, 'merge', '-q', '--no-edit', theirs], { encoding: 'utf8' });
  return git(dir, 'rev-parse', 'HEAD^{tree}');
}

test('a clean merge-tree result is exactly what git merge produces', async () => {
  const r = makeRepo(
    (d) => fs.writeFileSync(path.join(d, 'a.txt'), 'PROP\nline2\nline3\nline4\nline5\n'),
    (d) => fs.writeFileSync(path.join(d, 'a.txt'), 'line1\nline2\nline3\nline4\nMAIN\n')
  );
  try {
    const merged = await mirror.mergeTree(r.dir, r.prop, r.main);
    assert.equal(merged.clean, true, 'non-overlapping edits must merge cleanly');
    assert.deepEqual(merged.conflicts, []);
    assert.equal(merged.tree, realMergeTree(r.dir, r.prop, r.main),
      'the recomputed tree must equal the real merge tree, or approval cannot follow the patch');
  } finally { r.cleanup(); }
});

test('the equality holds across a rename and a mode change on main', async () => {
  const r = makeRepo(
    (d) => fs.writeFileSync(path.join(d, 'a.txt'), 'PROP\nline2\nline3\nline4\nline5\n'),
    (d) => {
      execFileSync('git', ['-C', d, 'mv', 'b.txt', 'c.txt']);
      fs.chmodSync(path.join(d, 'c.txt'), 0o755);
    }
  );
  try {
    const merged = await mirror.mergeTree(r.dir, r.prop, r.main);
    assert.equal(merged.clean, true);
    assert.equal(merged.tree, realMergeTree(r.dir, r.prop, r.main),
      'a rename plus a mode change must not make an unedited merge look authored');
  } finally { r.cleanup(); }
});

test('a real conflict reports the conflicted paths, not a superset', async () => {
  const r = makeRepo(
    (d) => fs.writeFileSync(path.join(d, 'a.txt'), 'PROP\nline2\nline3\nline4\nline5\n'),
    (d) => {
      // Overlapping edit to a.txt (a genuine conflict) plus an untouched-by-
      // the-proposal edit to b.txt. The two-compare intersection the old
      // freshness service used would have to guess; this must name a.txt only.
      fs.writeFileSync(path.join(d, 'a.txt'), 'MAIN\nline2\nline3\nline4\nline5\n');
      fs.writeFileSync(path.join(d, 'b.txt'), 'b changed on main\n');
    }
  );
  try {
    const merged = await mirror.mergeTree(r.dir, r.prop, r.main);
    assert.equal(merged.clean, false);
    assert.deepEqual(merged.conflicts, ['a.txt'],
      'only the genuinely unresolvable path may be reported');
    assert.ok(merged.tree, 'a conflicted merge still yields a tree identity');
  } finally { r.cleanup(); }
});

test('a hand-resolved tree does not equal the mechanical attempt', async () => {
  const r = makeRepo(
    (d) => fs.writeFileSync(path.join(d, 'a.txt'), 'PROP\nline2\nline3\n'),
    (d) => fs.writeFileSync(path.join(d, 'a.txt'), 'MAIN\nline2\nline3\n')
  );
  try {
    const mechanical = await mirror.mergeTree(r.dir, r.prop, r.main);
    assert.equal(mechanical.clean, false);

    // Resolve it the way the worker's conflict turn does: write bytes.
    git(r.dir, 'checkout', '-q', 'prop');
    try { execFileSync('git', ['-C', r.dir, 'merge', '--no-edit', 'main'], { stdio: 'ignore' }); } catch { /* expected */ }
    fs.writeFileSync(path.join(r.dir, 'a.txt'), 'RESOLVED\nline2\nline3\n');
    git(r.dir, 'add', '-A');
    git(r.dir, 'commit', '-qm', 'resolved');
    const resolvedTree = git(r.dir, 'rev-parse', 'HEAD^{tree}');

    assert.notEqual(resolvedTree, mechanical.tree,
      'an authored resolution must never classify as a mechanical merge');
  } finally { r.cleanup(); }
});

test('behindBy, aheadBy, mergeBase and isAncestor answer exactly', async () => {
  const r = makeRepo(
    (d) => fs.writeFileSync(path.join(d, 'a.txt'), 'PROP\nline2\nline3\nline4\nline5\n'),
    (d) => fs.writeFileSync(path.join(d, 'a.txt'), 'line1\nline2\nline3\nline4\nMAIN\n')
  );
  try {
    assert.equal(await mirror.behindBy(r.dir, r.main, r.prop), 1,
      'the proposal is missing exactly the one commit main gained');
    assert.equal(await mirror.aheadBy(r.dir, r.main, r.prop), 1);
    assert.equal(await mirror.mergeBase(r.dir, r.main, r.prop), r.base);
    assert.equal(await mirror.isAncestor(r.dir, r.base, r.main), true);
    assert.equal(await mirror.isAncestor(r.dir, r.main, r.prop), false,
      'main is not on the proposal history, which is what "behind" means');
  } finally { r.cleanup(); }
});

test('changedPaths scopes a resolution, and hasCommit gates every read', async () => {
  const r = makeRepo(
    (d) => fs.writeFileSync(path.join(d, 'a.txt'), 'PROP\nline2\nline3\nline4\nline5\n'),
    (d) => fs.writeFileSync(path.join(d, 'b.txt'), 'b on main\n')
  );
  try {
    assert.deepEqual(await mirror.changedPaths(r.dir, r.base, r.prop), ['a.txt']);
    assert.equal(await mirror.hasCommit(r.dir, r.main), true);
    assert.equal(await mirror.hasCommit(r.dir, '0'.repeat(40)), false);
  } finally { r.cleanup(); }
});

// #6778: what merged to main since a moment, with the files each change
// touched. A fix turn reads this to see that main moved the line it fails on.
test('mainLogSince lists the commits merged since a moment, newest first, with their files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usernode-mirror-log-'));
  const commitAt = (when, message, edit) => {
    edit(dir);
    git(dir, 'add', '-A');
    execFileSync('git', ['-C', dir, 'commit', '-qm', message], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
    });
    return git(dir, 'rev-parse', 'HEAD');
  };
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    git(dir, 'config', 'user.email', 'test@usernode.invalid');
    git(dir, 'config', 'user.name', 'Homeroom Test');
    git(dir, 'config', 'commit.gpgsign', 'false');
    const first = commitAt('2026-11-17T15:32:11Z', 'Offer to move a request to the project it is really about (#6757)',
      (d) => fs.writeFileSync(path.join(d, 'a.txt'), 'a\nmore\n'));
    const second = commitAt('2026-11-17T15:40:00Z', 'No number here',
      (d) => fs.writeFileSync(path.join(d, 'b.txt'), 'b\n'));
    const log = await mirror.mainLogSince(dir, git(dir, 'rev-parse', 'HEAD'), '2026-11-17T15:20:00Z');
    assert.deepEqual(log.map((c) => c.sha), [second, first], 'newest first, and nothing from before the window');
    assert.deepEqual(log[1], {
      sha: first,
      mergedAt: '2026-11-17T15:32:11Z',
      subject: 'Offer to move a request to the project it is really about (#6757)',
      files: ['a.txt'],
    });
    assert.deepEqual(log[0].files, ['b.txt'], 'each commit carries its own files, not its neighbours\'');
    assert.equal(await mirror.mainLogSince(dir, git(dir, 'rev-parse', 'HEAD'), 'not a date'), null,
      'an unusable date is no log at all');
    assert.equal(await mirror.mainLogSince(dir, '0'.repeat(40), '2026-11-17T15:20:00Z'), null,
      'an unknown tip is no log at all');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a committish that is not a sha is refused before it reaches git', () => {
  assert.throws(() => mirror._safeSha('--upload-pack=evil'), /Not a usable/);
  assert.throws(() => mirror._safeSha('main'), /Not a usable/);
  assert.equal(mirror._safeSha('ABC1234'), 'abc1234');
});

test('a mirror path cannot escape its root', () => {
  assert.throws(() => mirror.mirrorPath('../../etc', 'repo'), /Unsafe owner/);
  assert.throws(() => mirror.mirrorPath('owner', '..'), /Unsafe repo/);
  assert.match(mirror.mirrorPath('Usernode-Labs', 'social-vibecoding'),
    /usernode-mirror-Usernode-Labs-social-vibecoding\.git$/);
});
