// One preview build's preparation (services/staging.js
// buildAndDeployStagingInner, reached through prepareAttempt: the preview
// machine's preview.prepare work). The image build and the database clone
// run side by side when the attempt's database does not exist yet, and the
// deploy waits for both. Either failing settles the other before the
// checkout is removed, and the attempt's database is left for the machine
// to retire (a claim that lost its lease may share it with the retry now
// using it).
//
// The per-session queue this file was named for (session 2258's
// friendly-fire incident, 2026-07-14: two builds of one session killing
// each other's restore) is gone with buildAndDeployStaging: the machine
// runs one attempt of a session at a time, each into its own database.
//
// Run with: node --test tests/staging-build-serialize.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// Loads services/staging with every collaborator stubbed. The build's
// slow step (cloneDatabase — the pg_dump|pg_restore in prod) is modeled
// with a configurable async delay so tests can force overlap windows.
// Returns an event log of ['clone', sessionId, db] / ['drop', db] /
// ['rm', dir] / ['deploy'].
function loadStaging({ cloneDelayMs = 20, buildImageImpl = null, cloneImpl = null, existsImpl = async () => false, dropImpl = null } = {}) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    buildRetentionGuard: require.resolve('../src/services/build-retention-guard'),
    docker: require.resolve('../src/services/docker'),
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

  const events = [];

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  // A build holds the shared build-retention lock on its own connection.
  stub(ids.buildRetentionGuard, { withResourceUse: (config, lock, key, fn) => fn(), withBuildUse: (config, fn) => fn() });
  stub(ids.github, { getCloneUrl: async () => 'https://x/clone.git', isEnabled: () => true });
  stub(ids.appManifest, { read: () => ({}) });
  stub(ids.appSecrets, {
    getRawValues: async () => ({}),
    platformDefaultsFromEnv: () => ({}),
    mergeForDeploy: () => ({ missingRequired: [], missingPrivateStagingDefault: [], env: {} }),
  });
  stub(ids.appLlmEnv, {
    // #1213: platformStagingEnv() injects the app-platform API base URL
    // into previews (URL only, no token), so the staging path calls this.
    platformApiBaseUrl: () => 'http://usernode:3000/api/app-platform',
  });
  // A Docker attempt's deploy holds a per-session lock on its own connection.
  const client = { query: async () => ({ rows: [] }), release() {} };
  stub(ids.pool, { getPool: () => ({ query: async () => ({ rows: [] }), connect: async () => client }) });
  stub(ids.caddy, {
    stagingHostname: (slug, u) => `${slug}--${u}.example.test`,
    warmCert: async () => ({ ok: true, code: 200 }),
  });

  // docker: the checkout's removal and the deploy are what the tests watch.
  stub(ids.docker, {
    execFileAsync: async (cmd, argv) => {
      if (cmd === 'rm') events.push(['rm', argv[argv.length - 1]]);
      return { stdout: '' };
    },
    buildImage: buildImageImpl || (async () => {}),
    runContainer: async () => { events.push(['deploy']); return 'cid123'; },
    inspectContainer: async () => null,
    waitForHealthy: async () => {},
    stopAndRemove: async () => {},
    getHostPort: async () => null,
  });

  stub(ids.dbManager, {
    appDbName: (slug) => `app_${slug}`,
    stagingDbName: (slug, u, hash) => `app_${slug}_staging_${u}_${hash.substring(0, 6)}`,
    databaseExists: existsImpl,
    dropDatabase: async (name) => { events.push(['drop', name]); if (dropImpl) await dropImpl(name); },
    cloneDatabase: async (sourceDb, targetDb) => {
      // The slow, kill-sensitive step. Extract sessionId back out of the
      // target name (staging_s<id>_<hash>) for the event log.
      const sid = Number(/staging_s(\d+)_/.exec(targetDb)?.[1] || 0);
      events.push(['clone', sid, targetDb]);
      if (cloneImpl) return cloneImpl(sourceDb, targetDb);
      await new Promise((r) => setTimeout(r, cloneDelayMs));
      return { password: 'pw' };
    },
    connectionUrl: () => 'postgres://x',
  });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { subject, events, restore };
}

const mkSession = (id) => ({ id, branch_name: 'dev/x', staging_container_id: null });
const mkApp = { id: 5, slug: 'widget', name: 'Widget', repo_url: 'https://github.com/acme/widget' };

// Attempt 1 of the session's preview, its first claim, the way the preview
// machine's prepare work asks for it.
const prepare = (subject, session, head) => subject.prepareAttempt({ jwtSecret: 's' }, session, mkApp, head, {
  n: 1, claim: 1, dbName: `app_widget_staging_s${session.id}_aaaaaa`, servingN: null, checkpoint: async () => {},
});
const CHECKOUT = '/tmp/usernode-preview-8-a1-c1';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('image and clone overlap, and deploy waits for both', { timeout: 5000 }, async () => {
  const imageStarted = deferred(), cloneStarted = deferred(), imageDone = deferred(), cloneDone = deferred();
  const { subject, events, restore } = loadStaging({
    buildImageImpl: async () => { imageStarted.resolve(); await imageDone.promise; },
    cloneImpl: async () => { cloneStarted.resolve(); return cloneDone.promise; },
  });
  try {
    const result = prepare(subject, mkSession(8), 'aaaaaa1');
    await Promise.all([imageStarted.promise, cloneStarted.promise]);
    imageDone.resolve();
    await new Promise(r => setImmediate(r));
    assert.equal(events.some(e => e[0] === 'deploy'), false);
    cloneDone.resolve({ password: 'pw', via: 'template' });
    const deployed = await result;
    assert.equal(events.filter(e => e[0] === 'deploy').length, 1);
    assert.equal(deployed.timings.cloneVia, 'template');
    assert.ok(Number.isFinite(deployed.timings.imageBuildMs));
    assert.ok(Number.isFinite(deployed.timings.cloneMs));
    assert.equal(events.some(e => e[0] === 'drop'), false);
  } finally { imageDone.resolve(); cloneDone.resolve({ password: 'pw' }); restore(); }
});

for (const fails of ['image', 'clone', 'both']) {
  test(`preparation failure (${fails}) settles both tasks before cleanup`, { timeout: 5000 }, async () => {
    const imageStarted = deferred(), cloneStarted = deferred(), imageDone = deferred(), cloneDone = deferred();
    const { subject, events, restore } = loadStaging({
      buildImageImpl: async () => { imageStarted.resolve(); return imageDone.promise; },
      cloneImpl: async () => { cloneStarted.resolve(); return cloneDone.promise; },
      dropImpl: async () => { throw new Error('cleanup failed'); },
    });
    try {
      const result = prepare(subject, mkSession(8), 'aaaaaa1');
      const checked = assert.rejects(result, fails === 'clone' ? /clone failed/ : /image failed/);
      await Promise.all([imageStarted.promise, cloneStarted.promise]);
      // The checkout is cleared once before the clone into it; count after.
      const removals = () => events.filter(e => e[0] === 'rm' && e[1] === CHECKOUT).length;
      const before = removals();
      if (fails === 'clone') cloneDone.reject(new Error('clone failed'));
      else imageDone.reject(new Error('image failed'));
      await new Promise(r => setImmediate(r));
      assert.equal(removals(), before, 'no cleanup while the sibling still runs');
      if (fails === 'clone') imageDone.resolve();
      else if (fails === 'both') cloneDone.reject(new Error('clone failed'));
      else cloneDone.resolve({ password: 'pw' });
      await checked;
      assert.ok(removals() > before, 'the checkout is removed once both have settled');
      assert.equal(events.some(e => e[0] === 'drop'), false, 'the attempt\'s database is the machine\'s to retire');
      assert.equal(events.some(e => e[0] === 'deploy'), false);
    } finally { imageDone.resolve(); cloneDone.resolve({ password: 'pw' }); restore(); }
  });
}

for (const lookup of ['existing', 'failed']) {
  test(`${lookup} database lookup preserves image-before-clone ordering`, async () => {
    const { subject, events, restore } = loadStaging({
      existsImpl: async (name, opts) => {
        assert.equal(opts.strict, true);
        if (lookup === 'failed') throw new Error('unavailable');
        return true;
      },
      buildImageImpl: async () => { throw new Error('image failed'); },
    });
    try {
      await assert.rejects(prepare(subject, mkSession(8), 'aaaaaa1'), /image failed/);
      assert.equal(events.some(e => ['clone', 'drop'].includes(e[0])), false);
    } finally { restore(); }
  });
}
