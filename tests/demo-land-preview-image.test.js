// Landing the image the checks ran against, instead of building it again.
//
// A merge used to be: squash onto main, clone main, BUILD, deploy. On a small
// app with a warm layer cache that build is ~9s of an ~18s merge-to-live —
// and it produces an image of a tree that was already built minutes earlier,
// for the preview the proposal's checks ran against.
//
// So a demo-mode merge OFFERS that image to the rebuild, and the rebuild
// takes it only when the tree it just cloned is the tree the image was built
// from. That comparison is the entire guarantee, which is why it is made
// against the clone rather than taken from the caller's word, and why it is
// unit-tested here against real git trees rather than a fixture that asserts
// what it was told.
//
// Run with: node --test tests/demo-land-preview-image.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const staging = require('../src/services/staging');

const TREE = 'a'.repeat(40);
const offer = (over = {}) => ({
  imageRef: 'registry.test/apps/demo@sha256:' + 'd'.repeat(64),
  buildRef: 'bk/job-1', treeSha: TREE, fromSha: 'c'.repeat(40), ...over,
});

// ── The decision ─────────────────────────────────────────────────────────

test('the same tree is the same source, so the image already built is the image to deploy', () => {
  const build = staging.reusedBuild(offer(), TREE);
  assert.deepEqual(build, {
    imageRef: offer().imageRef, buildRef: 'bk/job-1', reused: true,
  });
});

test('anything short of an exact tree match builds', () => {
  // The merge produced a different tree — main moved under the proposal, or
  // the squash was not a fast-forward of it. Building is the only honest
  // answer, and it is what the platform did before this existed.
  assert.equal(staging.reusedBuild(offer(), 'b'.repeat(40)), null);
  // git could not say what the tree is.
  assert.equal(staging.reusedBuild(offer(), null), null);
  // Nothing was offered, or the offer is incomplete: the caller failing open.
  assert.equal(staging.reusedBuild(null, TREE), null);
  assert.equal(staging.reusedBuild(offer({ imageRef: null }), TREE), null);
  assert.equal(staging.reusedBuild(offer({ treeSha: null }), TREE), null);
  // An empty string is not a tree, and must never compare equal to one.
  assert.equal(staging.reusedBuild(offer({ treeSha: '' }), ''), null);
});

test('a tree sha is hex, so its case is not a difference', () => {
  assert.ok(staging.reusedBuild(offer({ treeSha: TREE.toUpperCase() }), TREE));
});

test('a build ref is optional; the image is what is being deployed', () => {
  assert.equal(staging.reusedBuild(offer({ buildRef: undefined }), TREE).buildRef, null);
});

// ── The tree read, against real git ──────────────────────────────────────

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'pipe' });
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  git('add', '-A');
  git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'x');
  return dir;
}

test('two commits of the same content have the same tree, whatever their history', async () => {
  // This is why the comparison can be trusted across a squash: the merge
  // commit is a different commit from the proposal's head, and when it
  // carries the same files it points at the same tree.
  const a = repo({ 'app.js': 'console.log(1)\n', 'dapp.json': '{}\n' });
  const b = repo({ 'app.js': 'console.log(1)\n', 'dapp.json': '{}\n' });
  const [treeA, treeB] = [await staging.treeShaOf(a), await staging.treeShaOf(b)];
  assert.match(treeA, /^[0-9a-f]{40}$/);
  assert.equal(treeA, treeB);

  const c = repo({ 'app.js': 'console.log(2)\n', 'dapp.json': '{}\n' });
  assert.notEqual(await staging.treeShaOf(c), treeA, 'one changed byte is a different tree');
});

test('a directory git cannot answer for reads as no tree, not as a match', async () => {
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-'));
  assert.equal(await staging.treeShaOf(notARepo), null);
  assert.equal(await staging.treeShaOf('/nonexistent-' + Date.now()), null);
});

test('anything that is not a sha is not a tree, whatever git printed', async () => {
  // Real git always answers with forty hex characters, so this is the branch
  // no repository on disk can reach — and the one that matters, because what
  // comes back is compared against an image's provenance. A truncated read, a
  // warning on stdout or an empty line must read as "no tree" rather than as
  // a value that could never match but would be reasoned about as if it could.
  const dockerId = require.resolve('../src/services/docker');
  const stagingId = require.resolve('../src/services/staging');
  const origDocker = require.cache[dockerId];
  const origStaging = require.cache[stagingId];
  let answer = { stdout: '' };
  require.cache[dockerId] = {
    id: dockerId, filename: dockerId, loaded: true,
    exports: { ...require('../src/services/docker'), execFileAsync: async () => answer },
  };
  delete require.cache[stagingId];
  try {
    const stubbed = require(stagingId);
    for (const stdout of ['', '\n', 'HEAD^{tree}\n', 'abc\n', 'z'.repeat(40) + '\n', 'a'.repeat(39) + '\n']) {
      answer = { stdout };
      assert.equal(await stubbed.treeShaOf('/anywhere'), null, JSON.stringify(stdout));
    }
    answer = { stdout: '  ' + 'A'.repeat(40) + ' \n' };
    assert.equal(await stubbed.treeShaOf('/anywhere'), 'a'.repeat(40),
      'a real sha is taken, trimmed and lowercased, so the comparison is on one form');
  } finally {
    if (origDocker) require.cache[dockerId] = origDocker; else delete require.cache[dockerId];
    if (origStaging) require.cache[stagingId] = origStaging; else delete require.cache[stagingId];
  }
});

// ── What a demo-mode merge offers ────────────────────────────────────────
//
// The merge-followups machine reads the preview off the session (facts.ts)
// and hands it to app-delivery with the merge's deploy request (machine.ts
// reuseOf). app-delivery's deploy work asks GitHub what tree the preview's
// commit points at, and offers the image with it. Run with GitHub, staging
// and the teardown stubbed, because the GitHub read is the only thing in it
// that leaves the process and the deploy is what is being offered.

function loadDeploy({ tree = TREE, throws = false } = {}) {
  const ids = {
    github: require.resolve('../src/services/github'),
    staging: require.resolve('../src/services/staging'),
    teardown: require.resolve('../src/services/app-teardown'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  const asked = [];
  const deployed = [];
  const put = (id, exports) => { require.cache[id] = { id, filename: id, loaded: true, exports }; };
  put(ids.github, {
    isEnabled: () => true,
    getCommitTree: async (owner, repo, sha) => {
      asked.push([owner, repo, sha]);
      if (throws) throw new Error('502 Bad Gateway');
      return tree;
    },
  });
  put(ids.staging, {
    async deployProduction(config, app, options) { deployed.push(options); return { sha: 'f'.repeat(40) }; },
  });
  put(ids.teardown, { async removeRuntimeIfDeleted() {} });
  const { appDeliveryServices } = require('../src/workflow/app-delivery/services.ts');
  const { WORK } = require('../src/workflow/app-delivery/machine.ts');
  const pool = { query: async () => ({ rows: [{ id: 1, slug: 'todo-list', self_hosted: false }] }) };
  const handler = appDeliveryServices({ config: {}, pool })[WORK.deploy];
  const run = (reuse) => handler.run({
    input: { appId: 1, revision: null, reuse, prNumber: 4 },
    key: 'deploy', attempt: 1, resumeFrom: null, checkpoint: async () => {},
  });
  return {
    run, asked, deployed,
    restore() {
      for (const [k, id] of Object.entries(ids)) {
        if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
      }
    },
  };
}

// What machine.ts reuseOf hands app-delivery for a demo-mode app with a
// preview: the preview's build and commit, and the app's repository.
const REUSE = {
  imageRef: 'registry.test/apps/todo@sha256:' + 'e'.repeat(64),
  buildRef: 'bk/job-9',
  commitSha: 'c'.repeat(40),
  owner: 'usernode-bot', repo: 'todo-list',
};

test('a demo-mode merge offers the preview\'s image, and the tree GitHub says it is of', async () => {
  const v = loadDeploy();
  try {
    await v.run(REUSE);
    assert.deepEqual(v.deployed[0].reuseImage, {
      imageRef: REUSE.imageRef,
      buildRef: 'bk/job-9',
      treeSha: TREE,
      fromSha: REUSE.commitSha,
    });
    // The tree asked about is the PREVIEW's commit: the offer is "this image
    // is of that tree", and the deploy checks that against its own clone.
    assert.deepEqual(v.asked, [['usernode-bot', 'todo-list', REUSE.commitSha]]);
  } finally { v.restore(); }
});

test('a deploy offered nothing offers nothing, and GitHub is not even asked', async () => {
  const v = loadDeploy();
  try {
    await v.run(null);
    assert.equal(v.deployed[0].reuseImage, undefined);
    assert.deepEqual(v.asked, [], 'the gate comes before the work');
  } finally { v.restore(); }
});

test('every way of GitHub not knowing means build: no answer, no tree', async () => {
  for (const [label, world] of [
    ['GitHub will not answer', { throws: true }],
    ['GitHub answers with no tree', { tree: null }],
  ]) {
    const v = loadDeploy(world);
    try {
      await v.run(REUSE);
      assert.equal(v.deployed[0].reuseImage, undefined, label);
    } finally { v.restore(); }
  }
});

test('only a demo-mode merge with a preview of a known image and commit offers one', () => {
  // The gate is the machine's (reuseOf), on what facts.ts read: a preview
  // with no image or no commit reads as no preview, and an app with no
  // parseable repository has no repo to ask about.
  const facts = read('src/workflow/merge-followups/facts.ts');
  assert.match(facts, /staging: s\.staging_image_ref && s\.staging_commit_sha\s*\n\s*\? \{ imageRef: s\.staging_image_ref, buildRef: s\.staging_build_ref \?\? null, commitSha: s\.staging_commit_sha \} : null/);
  const machine = read('src/workflow/merge-followups/machine.ts');
  const helper = machine.slice(machine.indexOf('function reuseOf('));
  assert.match(helper.slice(0, 200), /return f\?\.app\?\.demoMode && s && f\.app\.repo \? \{ \.\.\.s, \.\.\.f\.app\.repo \} : null;/,
    'demo mode, a preview and a repository, or nothing');
  // One call site, and it is the merge's own deploy request.
  const calls = machine.match(/reuseOf\(/g) || [];
  assert.equal(calls.length, 2, 'the definition and exactly one call');
  // (The merge's other message, beside the deploy request, tells the
  // proposal machine the proposal merged; it carries no preview.)
  assert.match(machine, /const messages = \[toProposal\(d\), \.\.\.\(d\.delivery \? \[deliveryRequest\(d, reuseOf\(f\)\)\] : \[\]\)\];/,
    'what it answers is what the deploy is offered, and nothing else is');
  const toProposal = machine.slice(machine.indexOf('function toProposal('), machine.indexOf('function merged('));
  assert.doesNotMatch(toProposal, /reuse|staging|image/i);
});

// ── The seam, where the source is the only place it shows ────────────────

test('the rebuild compares against the tree it just cloned, not against what it was told', () => {
  const SRC = read('src/services/staging.js');
  const fn = SRC.slice(SRC.indexOf('async function rebuildProductionInner'));
  const decide = fn.indexOf('reusedBuild(offered, mergedTree)');
  const readTree = fn.indexOf('await treeShaOf(cloneDir)');
  assert.ok(readTree > 0, 'the merged tree is read from the clone');
  assert.ok(decide > readTree, 'and the decision is made with it');
  // And the build is skipped only when that decision said so.
  const build = fn.indexOf('applicationRuntime.build(config, {');
  assert.ok(build > decide, 'the build comes after the decision');
  assert.match(fn.slice(decide, build), /if \(!build\) \{/, 'and only runs when nothing was reused');
});
