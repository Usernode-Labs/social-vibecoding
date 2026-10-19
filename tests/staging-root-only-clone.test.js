// A Kubernetes preview's source is downloaded once (services/staging.js).
//
// Before a preview build the platform clones the proposal's branch. On the
// Kubernetes lane the image is then built in a Job that fetches the same
// commit from GitHub itself, so the whole-tree clone downloaded the source a
// second time, to read dapp.json, the scripts in package.json and which
// Dockerfile the tree carries. All of those sit at the root, so that lane now
// clones the commit's directory listing and its root files only.
//
// What this suite pins down:
//   - which lane gets which clone, and that the Docker lane's git commands
//     are exactly the ones it ran before;
//   - the exact-commit paths (#687, #866) on the root-only clone: a commit is
//     detached at only once the clone holds it, because a clone made with a
//     filter would otherwise go and fetch it with its whole history;
//   - against real git and a local repository: what the build is handed,
//     that the manifest, the Dockerfile choice and the script check answer
//     as they do on a whole clone, and that the failures are still failures.
//
// Run with: node --test tests/staging-root-only-clone.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');

const realExec = promisify(execFile);
const realKubernetes = require('../src/services/kubernetes');
const realBuildkit = require('../src/services/kubernetes-buildkit');
const realAppSecrets = require('../src/services/app-secrets');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const DOCKERFILES = ['Dockerfile.kubernetes', 'Dockerfile'];
const KUBERNETES = { jwtSecret: 's', appRuntime: 'kubernetes', kubernetes: { buildkitDockerfiles: DOCKERFILES } };
const DOCKER = { jwtSecret: 's' };
const APP = { id: 5, slug: 'widget', name: 'Widget', repo_url: 'https://github.com/acme/widget' };

// git must not read this machine's configuration, and must never prompt.
// A submodule is cloned over https in production; git refuses the file://
// one the repository below uses unless told it may.
const GIT_ENV = {
  ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always',
};

// Loads services/staging with its collaborators stubbed, the way
// tests/pr-import-fork-clone.test.js does. `git(argv)` answers a git command
// (a string becomes its stdout, a thrown error fails it); with `cloneUrl`
// set, git and rm run for real against that repository instead.
// `onBuild(sourceDir, revision, config)` runs where the image build would,
// while the directory still exists.
function loadStaging({ git = () => '', cloneUrl = null, stored = {}, onBuild = () => {}, manifest = null, kube = {} } = {}) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    buildRetentionGuard: require.resolve('../src/services/build-retention-guard'),
    docker: require.resolve('../src/services/docker'),
    kubernetes: require.resolve('../src/services/kubernetes'),
    applicationRuntime: require.resolve('../src/services/application-runtime'),
    caddy: require.resolve('../src/services/caddy'),
    dbManager: require.resolve('../src/services/db-manager'),
    github: require.resolve('../src/services/github'),
    appManifest: require.resolve('../src/services/app-manifest'),
    appSecrets: require.resolve('../src/services/app-secrets'),
    appLlmEnv: require.resolve('../src/services/app-llm-env'),
    pool: require.resolve('../src/db/pool'),
    subject: require.resolve('../src/services/staging'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const calls = [];      // every git invocation's argv, in order
  const builds = [];     // what each image build was handed
  const manifests = [];  // every manifest the secrets check was given

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  // On Kubernetes a build holds a database lock on its own connection.
  stub(ids.buildRetentionGuard, { withResourceUse: (config, lock, key, fn) => fn(), withBuildUse: (config, fn) => fn() });
  stub(ids.github, { getCloneUrl: async () => cloneUrl || 'https://x/clone.git', isEnabled: () => true });
  // The real manifest reader when there is a real checkout to read.
  if (!cloneUrl) stub(ids.appManifest, { read: () => manifest || ({ secrets: [] }) });
  else delete require.cache[ids.appManifest];
  stub(ids.appSecrets, {
    ...realAppSecrets,
    getRawValues: async () => ({ ...stored }),
    platformDefaultsFromEnv: () => ({}),
    mergeForDeploy: (manifest, ...rest) => {
      manifests.push(manifest);
      return realAppSecrets.mergeForDeploy(manifest, ...rest);
    },
  });
  stub(ids.appLlmEnv, { platformApiBaseUrl: () => 'http://usernode:3000/api/app-platform' });
  // A Docker attempt's deploy holds a per-session lock on its own connection.
  const client = { query: async () => ({ rows: [] }), release() {} };
  stub(ids.pool, { getPool: () => ({ query: async () => ({ rows: [] }), connect: async () => client }) });
  stub(ids.caddy, {
    stagingHostname: (slug, u) => `${slug}--${u}.example.test`,
    warmCert: async () => ({ ok: true, code: 200 }),
  });
  const built = async (sourceDir, revision, config) => {
    builds.push({ sourceDir, revision });
    await onBuild(sourceDir, revision, config);
  };
  stub(ids.docker, {
    execFileAsync: async (cmd, argv, opts = {}) => {
      if (cmd === 'git') {
        calls.push(argv);
        if (cloneUrl) return realExec('git', argv, { ...opts, env: { ...GIT_ENV, ...(opts.env || {}) } });
        return { stdout: await git(argv) };
      }
      if (cmd === 'rm' && cloneUrl) return realExec(cmd, argv, opts);
      return { stdout: '' };
    },
    buildImage: async (sourceDir, image, args) => built(sourceDir, args.GIT_SHA, DOCKER),
    runContainer: async () => 'cid123',
    inspectContainer: async () => null,
    waitForHealthy: async () => {},
    stopAndRemove: async () => {},
    getHostPort: async () => null,
  });
  const deploys = [];
  stub(ids.kubernetes, {
    ...realKubernetes,
    createBuild: async (config, params) => {
      await built(params.sourceDir, params.revision, config);
      builds.at(-1).early = params.early ?? null;
      return { imageRef: 'registry.example.test/widget@sha256:1', buildRef: 'builds/bk-5', ...(params.early ? { earlyStart: true } : {}) };
    },
    deployApplication: async (config, { sessionId }) => (deploys.push(sessionId), {
      runtimeKind: 'kubernetes', runtimeName: `sv-widget-s${sessionId}`, imageRef: 'registry.example.test/widget@sha256:1',
      hostname: `widget--s${sessionId}.example.test`, url: `https://widget--s${sessionId}.example.test`,
    }),
    ...kube,
  });
  stub(ids.dbManager, {
    appDbName: (slug) => `app_${slug}`,
    stagingDbName: (slug, u, hash) => `app_${slug}_staging_${u}_${String(hash).substring(0, 6)}`,
    cloneDatabase: async () => ({ password: 'pw' }),
    connectionUrl: () => 'postgres://x',
    databaseExists: async () => false,
  });

  // Reload the dispatcher so it picks up the docker and kubernetes stubs.
  delete require.cache[ids.applicationRuntime];
  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  const applicationRuntime = require(ids.applicationRuntime);
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  const find = (verb) => calls.filter((a) => a.includes(verb));
  return { subject, applicationRuntime, calls, find, builds, manifests, deploys, restore };
}

// The preview machine's build of one attempt (staging.prepareAttempt, as
// src/workflow/preview/services.ts calls it): attempt 1, its first claim,
// into its own database and its own checkout.
const checkoutOf = (id) => `/tmp/usernode-preview-${id}-a1-c1`;
const prepare = (subject, config, sess, app, head) => subject.prepareAttempt(config, sess, app, head, {
  n: 1, claim: 1, dbName: `app_widget_staging_s${sess.id}_aaaaaa`, servingN: null, checkpoint: async () => {},
});

// The commands with the checkout directory taken out, so two lanes compare.
const shape = (calls) => calls.map((argv) => argv.filter((a) => !String(a).startsWith('/tmp/usernode-preview-')).join(' '));

const SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const OTHER = 'c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff';

// Answers `rev-parse <ref>` from a table and everything else with nothing.
const refs = (table) => (argv) => (argv.includes('rev-parse') ? table[argv[argv.length - 1]] || '' : '');

// ── which lane gets which clone ───────────────────────────────────────

test('the dispatcher says which lane needs the whole tree', () => {
  const { applicationRuntime, restore } = loadStaging();
  try {
    assert.equal(applicationRuntime.buildReadsWholeSource(DOCKER), true, 'Docker builds from the directory');
    assert.equal(applicationRuntime.buildReadsWholeSource(KUBERNETES), false, 'a Kubernetes build fetches the commit itself');
    assert.equal(
      applicationRuntime.buildReadsWholeSource({ ...KUBERNETES, kubernetes: { buildkitDockerfiles: ['deploy/Dockerfile', 'Dockerfile'] } }),
      true, 'a Dockerfile candidate below the root is read below the root');
    assert.equal(applicationRuntime.buildReadsWholeSource({ appRuntime: 'kubernetes' }), false, 'no candidates configured, nothing below the root');
  } finally { restore(); }
});

test('Kubernetes, a native session: the clone carries the listing and the root files, no submodules', async () => {
  const { subject, find, calls, builds, restore } = loadStaging({ git: refs({ HEAD: SHA }) });
  try {
    await prepare(subject, 
      KUBERNETES, { id: 7078101, branch_name: 'dev/native-work', staging_container_id: null }, APP, 'latest');
    assert.deepEqual(shape(find('clone')), [
      'clone --depth 1 --filter=blob:none --sparse --branch dev/native-work https://x/clone.git',
    ]);
    assert.deepEqual(shape(calls).slice(1), ['-C rev-parse HEAD'], "'latest' pins nothing: the clone, then which commit it is");
    assert.equal(builds.length, 1);
    assert.equal(builds[0].sourceDir, checkoutOf(7078101), 'the build is still handed the directory');
    assert.equal(builds[0].revision, SHA, 'and builds the commit the clone resolved');
  } finally { restore(); }
});

test('Docker: the same session runs exactly the commands it ran before', async () => {
  const { subject, calls, restore } = loadStaging({ git: refs({ HEAD: SHA }) });
  try {
    await prepare(subject, 
      DOCKER, { id: 7078102, branch_name: 'dev/native-work', staging_container_id: null }, APP, 'latest');
    assert.deepEqual(shape(calls), [
      'clone --depth 1 --recurse-submodules --shallow-submodules --branch dev/native-work https://x/clone.git',
      '-C rev-parse HEAD',
    ]);
  } finally { restore(); }
});

test('Docker: a pinned commit is still detached at, then its submodules synced', async () => {
  const { subject, calls, restore } = loadStaging({ git: refs({ HEAD: SHA }) });
  try {
    await prepare(subject, 
      DOCKER, { id: 7078103, branch_name: 'dev/pinned', pr_number: null, staging_container_id: null }, APP, SHA);
    assert.deepEqual(shape(calls), [
      'clone --depth 1 --recurse-submodules --shallow-submodules --branch dev/pinned https://x/clone.git',
      `-C checkout --detach ${SHA}`,
      '-C submodule update --init --recursive --depth 1',
      '-C rev-parse HEAD',
    ]);
  } finally { restore(); }
});

test('Kubernetes with a Dockerfile candidate below the root keeps the whole tree', async () => {
  const { subject, find, restore } = loadStaging({ git: refs({ HEAD: SHA }) });
  try {
    await prepare(subject, 
      { ...KUBERNETES, kubernetes: { buildkitDockerfiles: ['deploy/Dockerfile'] } },
      { id: 7078104, branch_name: 'dev/native-work', staging_container_id: null }, APP, 'latest');
    assert.deepEqual(shape(find('clone')), [
      'clone --depth 1 --recurse-submodules --shallow-submodules --branch dev/native-work https://x/clone.git',
    ]);
  } finally { restore(); }
});

// ── the exact-commit paths on the root-only clone ─────────────────────

test('Kubernetes, pinned to the branch tip: detached at once, nothing fetched', async () => {
  const { subject, calls, restore } = loadStaging({ git: refs({ HEAD: SHA }) });
  try {
    await prepare(subject, 
      KUBERNETES, { id: 7078105, branch_name: 'dev/pinned', pr_number: null, staging_container_id: null }, APP, SHA);
    assert.deepEqual(shape(calls), [
      'clone --depth 1 --filter=blob:none --sparse --branch dev/pinned https://x/clone.git',
      '-C rev-parse HEAD',
      `-C checkout --detach ${SHA}`,
      '-C rev-parse HEAD',
    ], 'the tip is asked for first, and no submodules are fetched');
  } finally { restore(); }
});

test('Kubernetes, pinned behind the branch tip: fetched shallowly before anything detaches', async () => {
  // The clone landed on a newer tip; the pinned commit arrives by the fetch.
  const { subject, calls, restore } = loadStaging({ git: refs({ HEAD: OTHER, FETCH_HEAD: SHA }) });
  try {
    await prepare(subject, 
      KUBERNETES, { id: 7078106, branch_name: 'dev/pinned', pr_number: null, staging_container_id: null }, APP, SHA);
    assert.deepEqual(shape(calls), [
      'clone --depth 1 --filter=blob:none --sparse --branch dev/pinned https://x/clone.git',
      '-C rev-parse HEAD',
      `-C fetch --depth 1 origin ${SHA}`,
      '-C rev-parse FETCH_HEAD',
      `-C checkout --detach ${SHA}`,
      '-C rev-parse HEAD',
    ], 'no detach at a commit the clone does not hold: a filtered clone would fetch its whole history for it');
  } finally { restore(); }
});

test('Kubernetes, an imported pull request: the default branch, then refs/pull/<N>/head', async () => {
  const { subject, calls, restore } = loadStaging({ git: refs({ FETCH_HEAD: SHA }) });
  try {
    await prepare(subject, 
      KUBERNETES,
      { id: 7078107, branch_name: 'contributor/feature', pr_number: 9401, source: 'imported', staging_container_id: null },
      APP, SHA);
    assert.deepEqual(shape(calls), [
      'clone --depth 1 --filter=blob:none --sparse https://x/clone.git',
      '-C fetch --depth 1 origin refs/pull/9401/head',
      '-C rev-parse FETCH_HEAD',
      `-C checkout --detach ${SHA}`,
      '-C rev-parse HEAD',
    ]);
  } finally { restore(); }
});

test('Kubernetes, a pull request that has moved on: its head is not detached at, the commit is fetched by name', async () => {
  let fetches = 0;
  const { subject, calls, restore } = loadStaging({
    git: (argv) => {
      if (argv.includes('fetch')) fetches += 1;
      if (argv.includes('rev-parse')) return argv[argv.length - 1] === 'FETCH_HEAD' ? (fetches === 1 ? OTHER : SHA) : SHA;
      return '';
    },
  });
  try {
    await prepare(subject, 
      KUBERNETES,
      { id: 7078108, branch_name: 'contributor/feature', pr_number: 9401, source: 'imported', staging_container_id: null },
      APP, SHA);
    assert.deepEqual(shape(calls), [
      'clone --depth 1 --filter=blob:none --sparse https://x/clone.git',
      '-C fetch --depth 1 origin refs/pull/9401/head',
      '-C rev-parse FETCH_HEAD',
      `-C fetch --depth 1 origin ${SHA}`,
      '-C rev-parse FETCH_HEAD',
      `-C checkout --detach ${SHA}`,
      '-C rev-parse HEAD',
    ]);
  } finally { restore(); }
});

test('Kubernetes, a pinned commit that cannot be produced fails the build', async () => {
  const { subject, find, builds, restore } = loadStaging({
    git: (argv) => {
      if (argv.includes('fetch')) throw new Error(`git ${argv.join(' ')} failed`);
      return argv.includes('rev-parse') ? OTHER : '';
    },
  });
  try {
    await assert.rejects(
      () => prepare(subject, 
        KUBERNETES, { id: 7078109, branch_name: 'dev/pinned', pr_number: 9401, staging_container_id: null }, APP, SHA),
      /failed/i);
    assert.equal(find('fetch').length, 2, 'both the pull request ref and the bare commit were tried');
    assert.equal(find('checkout').length, 0, 'and nothing was detached at');
    assert.equal(builds.length, 0, 'so nothing was built');
  } finally { restore(); }
});

// ── against real git ──────────────────────────────────────────────────

const gitIn = (cwd, ...args) => execFileSync('git', [
  '-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', ...args,
], { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

const write = (root, rel, content) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};

// A repository the way an app's looks: a manifest, package.json and a
// Dockerfile at the root, the source under it. Served over file:// with the
// two things GitHub allows: a filter, and asking for a commit by name.
function makeOrigin(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-root-only-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = (name) => JSON.stringify({ name, secrets: [{ key: 'API_KEY', required: true }] });
  const commit = (message) => { gitIn(root, 'add', '-A'); gitIn(root, 'commit', '-q', '-m', message); return gitIn(root, 'rev-parse', 'HEAD'); };

  gitIn(root, 'init', '-q', '-b', 'main');
  write(root, 'dapp.json', manifest('Zero'));
  write(root, 'package.json', JSON.stringify({ name: 'widget', scripts: { build: 'node build.js' } }));
  write(root, 'Dockerfile', 'FROM scratch\n');
  write(root, 'src/app.js', 'module.exports = 0;\n');
  write(root, 'docs/guide.md', '# Guide\n');
  const c0 = commit('zero');
  write(root, 'dapp.json', manifest('One'));
  write(root, 'src/app.js', 'module.exports = 1;\n');
  const c1 = commit('one');

  gitIn(root, 'checkout', '-q', '-b', 'dev/work');
  write(root, 'dapp.json', manifest('Two'));
  write(root, 'src/app.js', 'module.exports = 2;\n');
  const c2 = commit('two');

  // A pull request's head: on no branch, published under refs/pull only.
  gitIn(root, 'checkout', '-q', '--detach', c1);
  write(root, 'dapp.json', manifest('Three'));
  const c3 = commit('three');
  gitIn(root, 'update-ref', 'refs/pull/7/head', c3);
  write(root, 'dapp.json', manifest('Three and a half'));
  const c3b = commit('three and a half');
  gitIn(root, 'update-ref', 'refs/pull/8/head', c3b);

  // The manifest kept in a subdirectory, behind a link at the root.
  gitIn(root, 'checkout', '-q', '-b', 'dev/linked', c1);
  fs.rmSync(path.join(root, 'dapp.json'));
  write(root, 'config/dapp.json', manifest('Linked'));
  fs.symlinkSync('config/dapp.json', path.join(root, 'dapp.json'));
  const c4 = commit('linked');

  // The manifest kept in a submodule, behind a link at the root.
  const sub = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-root-only-sub-'));
  t.after(() => fs.rmSync(sub, { recursive: true, force: true }));
  gitIn(sub, 'init', '-q', '-b', 'main');
  write(sub, 'dapp.json', manifest('In a submodule'));
  gitIn(sub, 'add', '-A');
  gitIn(sub, 'commit', '-q', '-m', 'manifest');
  gitIn(root, 'checkout', '-q', '-b', 'dev/submodule', c1);
  fs.rmSync(path.join(root, 'dapp.json'));
  gitIn(root, 'submodule', '--quiet', 'add', `file://${sub}`, 'config');
  fs.symlinkSync('config/dapp.json', path.join(root, 'dapp.json'));
  const c5 = commit('manifest in a submodule');

  // The same tree once the submodule's repository is gone.
  gitIn(root, 'checkout', '-q', '-b', 'dev/submodule-gone');
  const gitmodules = path.join(root, '.gitmodules');
  fs.writeFileSync(gitmodules, fs.readFileSync(gitmodules, 'utf8').replace(`file://${sub}`, `file://${sub}-gone`));
  commit('submodule moved away');

  gitIn(root, 'checkout', '-q', 'main');
  gitIn(root, 'config', 'uploadpack.allowFilter', 'true');
  gitIn(root, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  return { url: `file://${root}`, c0, c1, c2, c3, c3b, c4, c5 };
}

// What a build finds in the directory it is handed.
function inspect(found) {
  return (sourceDir, revision, config) => {
    const entries = fs.readdirSync(sourceDir).filter((name) => name !== '.git').sort();
    found.push({
      entries,
      head: gitIn(sourceDir, 'rev-parse', 'HEAD'),
      // Commits on HEAD's history in this clone: 1 when it was fetched shallowly.
      history: Number(gitIn(sourceDir, 'rev-list', '--count', 'HEAD')),
      dockerfile: realBuildkit.selectDockerfile({ kubernetes: { buildkitDockerfiles: DOCKERFILES } }, sourceDir),
      runsBuild: realKubernetes._packageRunsScriptForTest(sourceDir, 'build'),
      runsEnsureShell: realKubernetes._packageRunsScriptForTest(sourceDir, 'ensure:shell'),
      revision,
      lane: config.appRuntime || 'docker',
    });
  };
}

const session = (id, over = {}) => ({ id, branch_name: 'dev/work', pr_number: null, staging_container_id: null, ...over });
const cleanup = (t, id) => t.after(() => fs.rmSync(checkoutOf(id), { recursive: true, force: true }));

test('real git: the Kubernetes build is handed the root of the commit and nothing under it', async (t) => {
  const origin = makeOrigin(t);
  const found = [];
  const { subject, manifests, restore } = loadStaging({ cloneUrl: origin.url, stored: { API_KEY: 'k' }, onBuild: inspect(found) });
  cleanup(t, 7078201);
  try {
    const result = await prepare(subject, KUBERNETES, session(7078201), APP, 'latest');
    assert.equal(found.length, 1);
    assert.deepEqual(found[0].entries, ['Dockerfile', 'dapp.json', 'package.json'], 'no src/, no docs/');
    assert.equal(found[0].head, origin.c2, 'at the branch tip');
    assert.equal(found[0].revision, origin.c2, 'which is the commit handed to the build');
    assert.equal(result.commitSha, origin.c2, 'and recorded as the preview\'s commit');
    assert.equal(found[0].dockerfile, 'Dockerfile', 'the Dockerfile the tree carries is still found');
    assert.equal(found[0].runsBuild, true, 'and so is the build script kpack runs');
    assert.equal(found[0].runsEnsureShell, false);
    assert.equal(manifests[0].name, 'Two', 'the manifest read is the tip\'s');
    assert.equal(fs.existsSync(checkoutOf(7078201)), false, 'the directory is removed once the build is back');
  } finally { restore(); }
});

test('real git: both lanes read the same manifest and build the same commit', async (t) => {
  const origin = makeOrigin(t);
  const seen = {};
  for (const [lane, config, id] of [['docker', DOCKER, 7078202], ['kubernetes', KUBERNETES, 7078203]]) {
    const found = [];
    const { subject, manifests, restore } = loadStaging({ cloneUrl: origin.url, stored: { API_KEY: 'k' }, onBuild: inspect(found) });
    cleanup(t, id);
    try {
      await prepare(subject, config, session(id), APP, 'latest');
      seen[lane] = { manifest: manifests[0], ...found[0] };
    } finally { restore(); }
  }
  assert.deepEqual(seen.docker.entries, ['Dockerfile', 'dapp.json', 'docs', 'package.json', 'src'], 'Docker still gets the whole tree');
  assert.deepEqual(seen.kubernetes.manifest, seen.docker.manifest);
  assert.equal(seen.kubernetes.revision, seen.docker.revision);
  assert.equal(seen.kubernetes.dockerfile, seen.docker.dockerfile);
  assert.equal(seen.kubernetes.runsBuild, seen.docker.runsBuild);
});

test('real git: a commit behind the branch tip is fetched alone, not with its history', async (t) => {
  const origin = makeOrigin(t);
  const found = [];
  const { subject, find, calls, manifests, restore } = loadStaging({ cloneUrl: origin.url, stored: { API_KEY: 'k' }, onBuild: inspect(found) });
  cleanup(t, 7078204);
  try {
    await prepare(subject, KUBERNETES, session(7078204), APP, origin.c1);
    assert.equal(found[0].head, origin.c1, 'detached at exactly the pinned commit');
    assert.equal(found[0].revision, origin.c1);
    assert.equal(manifests[0].name, 'One', 'and the manifest is that commit\'s, not the tip\'s');
    assert.equal(found[0].history, 1, 'its parent was not fetched');
    assert.deepEqual(found[0].entries, ['Dockerfile', 'dapp.json', 'package.json']);
    const firstFetch = calls.indexOf(find('fetch')[0]);
    const firstCheckout = calls.indexOf(find('checkout')[0]);
    assert.ok(firstFetch >= 0 && firstFetch < firstCheckout, 'fetched before anything detached');
  } finally { restore(); }
});

test('real git: an imported pull request builds its head through refs/pull', async (t) => {
  const origin = makeOrigin(t);
  const found = [];
  const { subject, manifests, restore } = loadStaging({ cloneUrl: origin.url, stored: { API_KEY: 'k' }, onBuild: inspect(found) });
  cleanup(t, 7078205);
  try {
    await prepare(subject, 
      KUBERNETES, session(7078205, { branch_name: 'contributor/feature', pr_number: 7, source: 'imported' }), APP, origin.c3);
    assert.equal(found[0].head, origin.c3);
    assert.equal(manifests[0].name, 'Three');
    assert.equal(found[0].history, 1);
  } finally { restore(); }
});

test('real git: a pull request that has moved on still builds the reviewed commit', async (t) => {
  const origin = makeOrigin(t);
  const found = [];
  const { subject, find, manifests, restore } = loadStaging({ cloneUrl: origin.url, stored: { API_KEY: 'k' }, onBuild: inspect(found) });
  cleanup(t, 7078206);
  try {
    // refs/pull/8/head is at the commit AFTER the one that was reviewed.
    await prepare(subject, 
      KUBERNETES, session(7078206, { branch_name: 'contributor/feature', pr_number: 8, source: 'imported' }), APP, origin.c3);
    assert.equal(found[0].head, origin.c3, 'not the pull request\'s newer head');
    assert.equal(manifests[0].name, 'Three');
    assert.equal(find('fetch').length, 2, 'the ref, then the commit by name');
    assert.equal(found[0].history, 1);
  } finally { restore(); }
});

test('real git: a root file that links into a subdirectory is still read', async (t) => {
  const origin = makeOrigin(t);
  const found = [];
  const { subject, manifests, restore } = loadStaging({ cloneUrl: origin.url, stored: { API_KEY: 'k' }, onBuild: inspect(found) });
  cleanup(t, 7078207);
  try {
    await prepare(subject, KUBERNETES, session(7078207, { branch_name: 'dev/linked' }), APP, 'latest');
    assert.equal(manifests[0].name, 'Linked', 'not "no manifest"');
    assert.deepEqual(manifests[0].secrets.map((s) => s.key), ['API_KEY'], 'so its required secrets are still checked');
    assert.ok(found[0].entries.includes('config'), 'the tree was given its files');
  } finally { restore(); }
});

test('real git: a root file that links into a submodule is still read', async (t) => {
  const origin = makeOrigin(t);
  const ids = [7078212, 7078213, 7078214, 7078215, 7078216, 7078217];
  for (const id of ids) cleanup(t, id);
  const run = async (config, id, commit, stored, branch = 'dev/submodule') => {
    const { subject, manifests, builds, restore } = loadStaging({ cloneUrl: origin.url, stored });
    try {
      let err = null;
      await prepare(subject, config, session(id, { branch_name: branch }), APP, commit).catch((e) => { err = e; });
      return { err, manifests, builds };
    } finally { restore(); }
  };

  // The whole clone brings the submodule with it, so the manifest inside it
  // is read and its required secret is asked for.
  const whole = await run(DOCKER, ids[0], 'latest', {});
  assert.equal(whole.err && whole.err.name, 'MissingSecretsError');
  assert.deepEqual(whole.err.missingSecrets, ['API_KEY']);

  // The root-only clone has to answer the same. Giving the tree its files is
  // not enough: the submodule's are in another repository. Read as "no
  // manifest", this preview was built without the secret it requires.
  const rootOnly = await run(KUBERNETES, ids[1], 'latest', {});
  assert.equal(rootOnly.err && rootOnly.err.name, 'MissingSecretsError');
  assert.deepEqual(rootOnly.err.missingSecrets, ['API_KEY']);
  assert.equal(rootOnly.builds.length, 0, 'and nothing was built');

  const stored = await run(KUBERNETES, ids[2], 'latest', { API_KEY: 'k' });
  assert.equal(stored.err, null);
  assert.equal(stored.manifests[0].name, 'In a submodule');
  assert.equal(stored.builds.length, 1);

  // The exact-commit path reaches the same place.
  const pinned = await run(KUBERNETES, ids[3], origin.c5, {});
  assert.equal(pinned.err && pinned.err.name, 'MissingSecretsError');

  // A submodule that cannot be fetched fails the whole clone. It fails the
  // root-only one too: a manifest that could not be read is not "none".
  const goneWhole = await run(DOCKER, ids[4], 'latest', { API_KEY: 'k' }, 'dev/submodule-gone');
  assert.ok(goneWhole.err, 'the whole clone fails');
  assert.equal(goneWhole.builds.length, 0);
  const goneRootOnly = await run(KUBERNETES, ids[5], 'latest', { API_KEY: 'k' }, 'dev/submodule-gone');
  assert.ok(goneRootOnly.err, 'the root-only clone fails rather than building without a manifest');
  assert.notEqual(goneRootOnly.err.name, 'MissingSecretsError');
  assert.equal(goneRootOnly.builds.length, 0);
});

test('real git: the failures are still failures, on the root-only clone', async (t) => {
  const origin = makeOrigin(t);
  const ids = [7078208, 7078209, 7078210, 7078211];
  for (const id of ids) cleanup(t, id);
  const run = async (sess, commit, stored = { API_KEY: 'k' }) => {
    const { subject, builds, restore } = loadStaging({ cloneUrl: origin.url, stored });
    try {
      let err = null;
      await prepare(subject, KUBERNETES, sess, APP, commit).catch((e) => { err = e; });
      return { err, builds };
    } finally { restore(); }
  };

  // A required secret with no stored value: read from the root-only checkout.
  const secrets = await run(session(ids[0]), 'latest', {});
  assert.equal(secrets.err && secrets.err.name, 'MissingSecretsError');
  assert.deepEqual(secrets.err.missingSecrets, ['API_KEY']);
  assert.equal(secrets.builds.length, 0);

  // A branch that no longer exists.
  const gone = await run(session(ids[1], { branch_name: 'dev/deleted' }), 'latest');
  assert.match(String(gone.err && gone.err.message), /Remote branch dev\/deleted not found/);
  assert.equal(gone.builds.length, 0);

  // A commit the repository does not have.
  const missing = await run(session(ids[2]), 'feedfacefeedfacefeedfacefeedfacefeedface');
  assert.ok(missing.err, 'the build fails rather than previewing the branch tip');
  assert.equal(missing.builds.length, 0);

  // A session with no branch yet (#1350): refused before any git runs.
  const none = await run(session(ids[3], { branch_name: null }), 'latest');
  assert.match(String(none.err && none.err.message), /no branch yet/);
});

// ── the build starts beside the checkout (services/staging.js, kubernetes.startEarlyBuild) ──

// A runtime whose early start records what it was asked for and hands back
// `handle` (or fails with `fails`), and whose cancel records what it got.
function earlyKube({ handle = { dockerfile: 'Dockerfile.kubernetes', revision: SHA, startedAt: 1 }, fails = null } = {}) {
  const seen = { started: [], cancelled: [] };
  return {
    seen,
    kube: {
      startEarlyBuild: async (config, params) => {
        seen.started.push(params);
        if (fails) throw fails;
        return handle;
      },
      cancelEarlyBuild: async (config, h) => { seen.cancelled.push(h); return true; },
    },
  };
}

test('Kubernetes, a pinned commit: its build starts before the checkout, and the build takes it over once the checks on the checkout pass', async () => {
  const early = earlyKube();
  const { subject, builds, deploys, restore } = loadStaging({ git: refs({ HEAD: SHA }), kube: early.kube });
  try {
    await prepare(subject, KUBERNETES, { id: 7078201, branch_name: 'dev/pinned', pr_number: null, staging_container_id: null }, APP, SHA.toUpperCase());
    assert.equal(early.seen.started.length, 1);
    assert.equal(early.seen.started[0].revision, SHA, 'the pinned commit, as git spells it');
    assert.equal(early.seen.started[0].sessionId, 7078201);
    assert.equal(early.seen.started[0].environment, 'staging');
    assert.equal(builds.length, 1);
    assert.deepEqual(builds[0].early, { dockerfile: 'Dockerfile.kubernetes', revision: SHA, startedAt: 1 }, 'the build is handed what was started');
    assert.equal(early.seen.cancelled.length, 0, 'nothing to cancel: the build owns it now');
    assert.equal(deploys.length, 1);
  } finally { restore(); }
});

test('Kubernetes, a pinned commit: the early start is made before the first git command', async () => {
  let gitCalls = 0;
  const order = [];
  const early = earlyKube();
  early.kube.startEarlyBuild = async () => { order.push(`early after ${gitCalls} git calls`); return null; };
  const { subject, restore } = loadStaging({ git: (argv) => { gitCalls += 1; return refs({ HEAD: SHA })(argv); }, kube: early.kube });
  try {
    await prepare(subject, KUBERNETES, { id: 7078202, branch_name: 'dev/pinned', pr_number: null, staging_container_id: null }, APP, SHA);
    assert.deepEqual(order, ['early after 0 git calls']);
  } finally { restore(); }
});

test('Kubernetes, a pinned commit whose required secret is missing: the early build is cancelled, nothing is built or deployed', async () => {
  const early = earlyKube();
  const { subject, builds, deploys, restore } = loadStaging({
    git: refs({ HEAD: SHA }), kube: early.kube,
    manifest: { secrets: [{ key: 'API_KEY', required: true }] },
  });
  try {
    await assert.rejects(
      prepare(subject, KUBERNETES, { id: 7078203, branch_name: 'dev/pinned', pr_number: null, staging_container_id: null }, APP, SHA),
      (err) => err.name === 'MissingSecretsError' || /API_KEY/.test(err.message));
    assert.equal(early.seen.started.length, 1);
    assert.deepEqual(early.seen.cancelled, [{ dockerfile: 'Dockerfile.kubernetes', revision: SHA, startedAt: 1 }],
      'the Job started for a build that will not deploy goes');
    assert.equal(builds.length, 0, 'the image build is never waited on');
    assert.equal(deploys.length, 0, 'the failed check still stops the deploy');
  } finally { restore(); }
});

test('Kubernetes, a pinned commit whose checkout fails: the early build is cancelled', async () => {
  const early = earlyKube();
  const { subject, deploys, restore } = loadStaging({
    git: (argv) => { if (argv.includes('clone')) throw new Error('remote hung up'); return ''; }, kube: early.kube,
  });
  try {
    await assert.rejects(prepare(subject, KUBERNETES, { id: 7078204, branch_name: 'dev/pinned', pr_number: null, staging_container_id: null }, APP, SHA),
      /remote hung up/);
    assert.equal(early.seen.cancelled.length, 1);
    assert.equal(deploys.length, 0);
  } finally { restore(); }
});

test('an early start that fails, or that the runtime declines, leaves the build to start after the checkout, as before', async () => {
  const failing = earlyKube({ fails: new Error('etcdserver: request timed out') });
  let loaded = loadStaging({ git: refs({ HEAD: SHA }), kube: failing.kube });
  try {
    await prepare(loaded.subject, KUBERNETES, { id: 7078205, branch_name: 'dev/pinned', pr_number: null, staging_container_id: null }, APP, SHA);
    assert.equal(loaded.builds.length, 1);
    assert.equal(loaded.builds[0].early, null);
    assert.equal(loaded.deploys.length, 1);
  } finally { loaded.restore(); }
  const declined = earlyKube({ handle: null });
  loaded = loadStaging({ git: refs({ HEAD: SHA }), kube: declined.kube });
  try {
    await prepare(loaded.subject, KUBERNETES, { id: 7078206, branch_name: 'dev/pinned', pr_number: null, staging_container_id: null }, APP, SHA);
    assert.equal(loaded.builds[0].early, null);
    assert.equal(declined.seen.cancelled.length, 0);
  } finally { loaded.restore(); }
});

test('nothing starts early for the branch tip (no commit to start from) or on Docker', async () => {
  const early = earlyKube();
  let loaded = loadStaging({ git: refs({ HEAD: SHA }), kube: early.kube });
  try {
    await prepare(loaded.subject, KUBERNETES, { id: 7078207, branch_name: 'dev/native-work', staging_container_id: null }, APP, 'latest');
    assert.equal(early.seen.started.length, 0);
  } finally { loaded.restore(); }
  loaded = loadStaging({ git: refs({ HEAD: SHA }), kube: early.kube });
  try {
    await prepare(loaded.subject, DOCKER, { id: 7078208, branch_name: 'dev/pinned', pr_number: null, staging_container_id: null }, APP, SHA);
    assert.equal(early.seen.started.length, 0, 'the Docker lane builds from the checkout');
  } finally { loaded.restore(); }
});
