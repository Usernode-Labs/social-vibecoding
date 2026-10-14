'use strict';

// staging.prepareAttempt: one attempt of the preview machine's
// preview.prepare (machine-preview.md). It builds into its own checkout and
// database, asks its checkpoint before each thing it creates, writes nothing
// on the row, and on Docker never removes the session's container (the one
// still serving) unless it got as far as replacing it (P-B1).
//
// Every collaborator is stubbed, as in tests/pr-import-fork-clone.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function loadStaging({ failGit = false, failRun = false, failHealth = false, liveAttempt = null } = {}) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
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
  const calls = { git: [], removed: [], cloned: [], queries: [], checkpoints: [], order: [], dropped: [] };
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.github, { getCloneUrl: async () => 'https://x/clone.git', isEnabled: () => true });
  stub(ids.appManifest, { read: () => ({}) });
  stub(ids.appSecrets, {
    getRawValues: async () => ({}), platformDefaultsFromEnv: () => ({}),
    mergeForDeploy: () => ({ missingRequired: [], missingPrivateStagingDefault: [], env: {} }),
  });
  stub(ids.appLlmEnv, { platformApiBaseUrl: () => 'http://usernode:3000/api/app-platform' });
  const query = async (text) => {
    calls.queries.push(String(text));
    if (/pg_advisory_(un)?lock/.test(String(text))) calls.order.push(/unlock/.test(String(text)) ? 'unlock' : 'lock');
    return { rows: [] };
  };
  stub(ids.pool, { getPool: () => ({ query, connect: async () => ({ query, release() {} }) }) });
  stub(ids.caddy, { stagingHostname: (slug, u) => `${slug}--${u}.example.test`, warmCert: async () => ({ ok: true }) });
  stub(ids.docker, {
    execFileAsync: async (cmd, argv) => {
      if (cmd === 'git') {
        calls.git.push(argv);
        if (failGit && argv.includes('clone')) throw new Error('fatal: could not read from remote');
        if (argv.includes('rev-parse')) return { stdout: 'a'.repeat(40) };
      }
      return { stdout: '' };
    },
    buildImage: async () => {},
    runContainer: async () => { calls.order.push('run'); if (failRun) throw new Error('container exited'); return 'cid-mine'; },
    waitForHealthy: async () => { if (failHealth) throw new Error('never healthy'); },
    // The container by the session's name, as the platform labelled it.
    inspectContainer: async () => (calls.order.push('inspect'), liveAttempt == null ? { status: 'not_found', labels: {} }
      : { status: 'running', labels: { 'social.usernode.io/preview-attempt': String(liveAttempt) } }),
    stopAndRemove: async (name) => { calls.order.push('remove'); calls.removed.push(name); return { removed: true }; },
    getHostPort: async () => null,
    STAGING_STOP_GRACE_SEC: 2,
  });
  stub(ids.dbManager, {
    appDbName: (slug) => `app_${slug}`,
    stagingDbName: (slug, u, hash) => `app_${slug}_staging_${u}_${String(hash).substring(0, 6)}`,
    databaseExists: async () => false,
    cloneDatabase: async (from, to) => { calls.cloned.push(to); return { password: 'pw' }; },
    dropDatabase: async (name) => { calls.dropped.push(name); },
    connectionUrl: () => 'postgres://x',
  });
  delete require.cache[ids.applicationRuntime];
  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { subject, calls, restore };
}

const APP = { id: 5, slug: 'widget', name: 'Widget', repo_url: 'https://github.com/acme/widget' };
const SHA = 'a'.repeat(40);
const SERVING = { id: 7, branch_name: 'dev/work', staging_runtime_name: 'usernode-staging-widget--7', staging_runtime_kind: 'docker' };
const attempt = (calls) => ({
  n: 3, dbName: 'app_widget_staging_s7_abc123',
  checkpoint: async (v) => { calls.checkpoints.push(v.step); },
});

test('an attempt builds into its own checkout and database, checkpoints, and writes nothing on the row', async () => {
  const { subject, calls, restore } = loadStaging();
  try {
    const a = attempt(calls);
    const out = await subject.prepareAttempt({ appRuntime: 'docker' }, SERVING, APP, SHA, a);
    assert.equal(out.commitSha, SHA);
    assert.ok(calls.git.find((g) => g.includes('clone')).includes('/tmp/usernode-preview-7-a3'));
    assert.deepEqual(calls.cloned, ['app_widget_staging_s7_abc123']);
    assert.deepEqual(calls.checkpoints, ['clone', 'deploy']);
    // Its live build progress (checks_progress) is written as before.
    assert.ok(!calls.queries.some((q) => /UPDATE chat_sessions\s+SET staging_/.test(q)), 'the machine publishes the receipt');
  } finally { restore(); }
});

test('a candidate that fails before its deploy step leaves the serving container alone', async () => {
  const { subject, calls, restore } = loadStaging({ failGit: true });
  try {
    await assert.rejects(subject.prepareAttempt({ appRuntime: 'docker' }, SERVING, APP, SHA, attempt(calls)), /could not read/);
    assert.deepEqual(calls.removed, []);
  } finally { restore(); }
});

test('on Docker, a candidate that fails after replacing the container says so, and removes only what it started', async () => {
  const { subject, calls, restore } = loadStaging({ failHealth: true });
  try {
    await assert.rejects(subject.prepareAttempt({ appRuntime: 'docker' }, SERVING, APP, SHA, attempt(calls)),
      (err) => err.servingRemoved === true && err.containerId === 'cid-mine');
    // The replace by name, then its own cleanup by id: never by name, which
    // could by now be a newer attempt's container (review finding).
    assert.equal(calls.removed.at(-1), 'cid-mine');
  } finally { restore(); }
});

test('on Docker, an older attempt never replaces a newer one\'s container', async () => {
  const { subject, calls, restore } = loadStaging({ liveAttempt: 4 });
  try {
    await assert.rejects(subject.prepareAttempt({ appRuntime: 'docker' }, SERVING, APP, SHA, attempt(calls)),
      (err) => err.code === 'attempt_superseded');
    assert.ok(!calls.removed.includes('usernode-staging-widget--7'), 'the newer container is untouched');
  } finally { restore(); }
});

test('on Docker, reading the newest attempt and replacing the container hold one lock (review finding)', async () => {
  const { subject, calls, restore } = loadStaging({ liveAttempt: 2 });
  try {
    await subject.prepareAttempt({ appRuntime: 'docker' }, SERVING, APP, SHA, attempt(calls));
    assert.deepEqual(calls.order,
      ['lock', 'inspect', 'remove', 'run', 'unlock'], 'an older attempt cannot read the label, stall, then replace a newer container');
  } finally { restore(); }
});

test('a failed preparation leaves the attempt\'s database to the machine: a retry of the attempt may be using it (review finding)', async () => {
  const { subject, calls, restore } = loadStaging();
  try {
    const a = attempt(calls);
    a.checkpoint = async (v) => { if (v.step === 'clone') throw Object.assign(new Error('work lease lost'), { name: 'LeaseLost' }); };
    await assert.rejects(subject.prepareAttempt({ appRuntime: 'docker' }, SERVING, APP, SHA, a), /lease lost/);
    assert.deepEqual(calls.dropped, []);
  } finally { restore(); }
});
