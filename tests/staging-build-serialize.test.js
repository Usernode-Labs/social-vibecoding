// Per-session staging-build serialization (session 2258 friendly-fire
// incident, 2026-07-14).
//
// buildAndDeployStaging used to have no single-flight guard: a push-driven
// build racing a recovery/recheck rebuild for the SAME session would reach
// its clone step — which begins by dropping the prior staging DB via
// pg_terminate_backend — and kill the other build's in-flight pg_restore
// mid-COPY ("server closed the connection unexpectedly"). The loser then
// recorded a checks 'error' and posted a scary ⚠ to the session chat for a
// failure that was pure friendly fire.
//
// The guard chains builds per session id (concurrent triggers run
// one-at-a-time), coalesces same-commit requests onto the in-flight
// promise, keeps different sessions parallel, and never lets a failed
// build block its successor.
//
// Run with: node --test tests/staging-build-serialize.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// Loads services/staging with every collaborator stubbed. The build's
// slow step (cloneDatabase — the pg_dump|pg_restore in prod) is modeled
// with a configurable async delay so tests can force overlap windows.
// Returns an event log of ['start'|'clone'|'end', sessionId, commit] plus
// a live counter of in-flight inner builds per session.
function loadStaging({
  cloneDelayMs = 20,
  buildImageImpl = null,
  cloneImpl = null,
  existsImpl = async () => false,
  dropImpl = null,
  runtimeKind = 'docker',
} = {}) {
  const ids = {
    guard: require.resolve('../src/services/build-retention-guard'),
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

  const events = [];
  const deployments = [];
  const queries = [];
  const checkoutHeads = new Map();
  const inFlight = new Map(); // sessionId -> count of inner builds running
  let maxConcurrent = 0;

  const bump = (sid, d) => {
    const n = (inFlight.get(sid) || 0) + d;
    inFlight.set(sid, n);
    const total = [...inFlight.values()].reduce((a, b) => a + b, 0);
    if (total > maxConcurrent) maxConcurrent = total;
  };

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.guard, { withResourceUse: async (_config, _classifier, _resource, fn) => fn() });
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
  stub(ids.pool, {
    getPool: () => ({
      query: async (sql, params) => {
        queries.push({ sql: String(sql), params });
        return { rows: [] };
      },
    }),
  });
  stub(ids.caddy, {
    stagingHostname: (slug, u) => `${slug}--${u}.example.test`,
    warmCert: async () => ({ ok: true, code: 200 }),
  });

  // docker: track inner-build entry via the git clone execFileAsync call
  // (first thing the inner build does) and exit via runContainer/cleanup.
  stub(ids.docker, {
    execFileAsync: async (command, args) => {
      if (command === 'rm') checkoutHeads.delete(args.at(-1));
      if (command === 'git' && args[2] === 'checkout') checkoutHeads.set(args[1], args.at(-1));
      if (command === 'git' && args[2] === 'rev-parse') return { stdout: checkoutHeads.get(args[1]) || '' };
      return { stdout: '' };
    },
    buildImage: buildImageImpl || (async () => {}),
    runContainer: async (_name, options) => {
      deployments.push(options);
      events.push(['deploy']);
      return 'cid123';
    },
    waitForHealthy: async () => {},
    stopAndRemove: async () => {},
    getHostPort: async () => null,
  });

  // Reload the Docker adapter against this test's collaborators as well.
  delete require.cache[ids.applicationRuntime];
  if (runtimeKind === 'kubernetes') {
    stub(ids.applicationRuntime, {
      mode: () => runtimeKind,
      build: async () => ({
        runtimeKind,
        imageRef: 'registry/image@sha256:exact',
        buildRef: 'build-1',
      }),
      deploy: async (_config, options) => {
        deployments.push(options);
        events.push(['deploy']);
        return {
          runtimeKind,
          runtimeName: options.runtimeName || `sv-preview-${options.app.id}-s${options.sessionId}`,
          ...(options.createOnly ? { physicalId: 'deployment-uid' } : {}),
          hostname: 'preview.example.test',
          url: 'https://preview.example.test',
        };
      },
    });
  }

  stub(ids.dbManager, {
    appDbName: (slug) => `app_${slug}`,
    stagingDbName: (slug, u, hash) => `app_${slug}_staging_${u}_${hash.substring(0, 6)}`,
    databaseExists: existsImpl,
    dropDatabase: async (name) => { events.push(['drop', name]); if (dropImpl) await dropImpl(name); },
    cloneDatabase: async (sourceDb, targetDb, options) => {
      // The slow, kill-sensitive step. Extract sessionId back out of the
      // target name (staging_s<id>_<hash>) for the event log.
      const sid = Number(/staging_s(\d+)_/.exec(targetDb)?.[1] || 0);
      events.push(['clone', sid, targetDb]);
      bump(sid, +1);
      try {
        if (cloneImpl) return await cloneImpl(sourceDb, targetDb, options);
        await new Promise((r) => setTimeout(r, cloneDelayMs));
        return { password: 'pw' };
      } finally { bump(sid, -1); }
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
  return {
    subject, events, queries, deployments, restore,
    maxConcurrent: () => maxConcurrent,
  };
}

const mkSession = (id) => ({ id, branch_name: 'dev/x', staging_container_id: null });
const mkApp = { id: 5, slug: 'widget', name: 'Widget', repo_url: 'https://github.com/acme/widget' };

for (const runtimeKind of ['docker', 'kubernetes']) {
  test(`${runtimeKind}: actual staging adapter reserves cleanup locators and tags the deployed flow`, async () => {
    const { subject, deployments, restore } = loadStaging({ runtimeKind });
    const headSha = 'a'.repeat(40);
    const flowId = randomUUID();
    let intent;
    try {
      const config = {
        jwtSecret: 's',
        appRuntime: runtimeKind,
        kubernetes: { appNamespace: 'test-apps' },
      };
      const result = await subject.buildAndDeployStaging(config, mkSession(7), mkApp, headSha, {
        previewFlow: { flowId, generation: 1, headSha },
        beforeBuild: async value => {
          intent = value;
          assert.equal(deployments.length, 0);
        },
        consumePrepared: async value => {
          assert.equal(value.runtimeName, intent.runtimeName);
          assert.equal(deployments[0].labels['social.usernode.io/preview-flow'], flowId);
        },
      });
      assert.equal(result.runtimeKind, runtimeKind);
      assert.equal(intent.dbName, 'app_widget_staging_s7_aaaaaa');
      assert.equal(intent.namespace, runtimeKind === 'kubernetes' ? 'test-apps' : null);
    } finally {
      restore();
    }
  });
}

for (const runtimeKind of ['docker', 'kubernetes']) {
  test(`${runtimeKind}: isolated preparation retains serving resources and reports readiness before activation`, async () => {
    const attemptId = randomUUID();
    const config = { jwtSecret: 's', appRuntime: runtimeKind, kubernetes: { appNamespace: 'test-apps' } };
    const intent = require('../src/services/preview-flow/candidate-resources').candidateResources(config, 7, attemptId);
    let cloned = false;
    let marked = false;
    const { subject, deployments, events, queries, restore } = loadStaging({
      runtimeKind,
      cloneImpl: async (_source, target, options) => {
        assert.equal(target, intent.dbName);
        assert.deepEqual(options, { viaTemplate: true, password: '1'.repeat(48), createOnly: true });
        cloned = true;
        return { password: options.password };
      },
    });
    try {
      const headSha = 'a'.repeat(40);
      const result = await subject.buildAndDeployStaging(config,
        { ...mkSession(7), staging_runtime_name: 'old-serving' }, mkApp, headSha, {
          previewFlow: { flowId: randomUUID(), generation: 1, headSha },
          candidate: {
            intent,
            password: '1'.repeat(48),
            onClonePrepared: async () => { assert.equal(cloned, true); marked = true; },
            onPreparationFailed: async () => assert.fail('Preparation should succeed'),
          },
          beforeBuild: async reserved => assert.deepEqual(reserved, intent),
          consumePrepared: async result => {
            assert.equal(marked, true);
            assert.equal(result.runtimeName, intent.runtimeName);
            assert.equal(result.attemptId, attemptId);
            assert.ok(result.physicalId);
          },
        });
      assert.equal(result.runtimeName, intent.runtimeName);
      assert.equal(events.some(event => event[0] === 'drop'), false);
      assert.equal(queries.some(query => /SET staging_url/.test(query.sql)), false);
      if (runtimeKind === 'kubernetes') {
        assert.equal(deployments[0].internalOnly, true);
        assert.equal(deployments[0].createOnly, true);
      } else {
        assert.equal(deployments[0].replaceExisting, false);
        assert.deepEqual(deployments[0].aliases, []);
      }
    } finally {
      restore();
    }
  });

  test(`${runtimeKind}: isolated preparation defers partial failures to the owner under the resource lock`, async () => {
    const config = { jwtSecret: 's', appRuntime: runtimeKind, kubernetes: { appNamespace: 'test-apps' } };
    const intent = require('../src/services/preview-flow/candidate-resources').candidateResources(config, 7, randomUUID());
    const { subject, deployments, restore } = loadStaging({ runtimeKind, existsImpl: async () => true });
    let cleanupCalls = 0;
    try {
      const headSha = 'a'.repeat(40);
      await assert.rejects(subject.buildAndDeployStaging(config, mkSession(7), mkApp, headSha, {
        previewFlow: { flowId: randomUUID(), generation: 1, headSha },
        candidate: {
          intent,
          password: '1'.repeat(48),
          onPreparationFailed: async () => { cleanupCalls++; },
        },
      }), /already exists/);
      assert.equal(cleanupCalls, 1);
      assert.equal(deployments.length, 0);
    } finally {
      restore();
    }
  });
}

test('two concurrent builds for one session run sequentially, both to completion', async () => {
  const { subject, events, maxConcurrent, restore } = loadStaging({ cloneDelayMs: 30 });
  try {
    // Fire both before awaiting either — without the guard these overlap
    // and build B's clone-teardown would kill build A's restore.
    const pA = subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(7), mkApp, 'aaaaaa1');
    const pB = subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(7), mkApp, 'bbbbbb2');
    const [rA, rB] = await Promise.all([pA, pB]);

    assert.ok(rA.stagingUrl && rB.stagingUrl, 'both builds completed');
    const clones = events.filter((e) => e[0] === 'clone' && e[1] === 7);
    assert.equal(clones.length, 2, 'each distinct commit got its own build');
    assert.equal(maxConcurrent(), 1, 'the two builds never overlapped');
  } finally {
    restore();
  }
});

test('same-commit concurrent requests coalesce onto one build', async () => {
  const { subject, events, restore } = loadStaging({ cloneDelayMs: 30 });
  try {
    const pA = subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(7), mkApp, 'cccccc3');
    const pB = subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(7), mkApp, 'cccccc3');
    const [rA, rB] = await Promise.all([pA, pB]);

    const clones = events.filter((e) => e[0] === 'clone' && e[1] === 7);
    assert.equal(clones.length, 1, 'one shared build, not two identical ones');
    assert.deepEqual(rA, rB, 'both callers receive the same result');
  } finally {
    restore();
  }
});

test('managed retries of the same SHA stay distinct, serialized, and return without projection writes', async () => {
  const { subject, events, queries, maxConcurrent, restore } = loadStaging({ cloneDelayMs: 20 });
  const headSha = 'a'.repeat(40);
  try {
    const options = generation => ({ previewFlow: { flowId: randomUUID(), generation, headSha } });
    const results = await Promise.all([
      subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(7), mkApp, headSha, options(1)),
      subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(7), mkApp, headSha, options(2)),
    ]);
    assert.equal(events.filter(event => event[0] === 'clone').length, 2);
    assert.equal(maxConcurrent(), 1, 'shared clone/runtime preparation remains serialized');
    assert.ok(results.every(result => result.commitSha === headSha && result.imageRef && result.runtimeName && result.stagingUrl));
    assert.equal(queries.filter(query => /UPDATE chat_sessions SET staging_image_ref/.test(query.sql)).length, 0,
      'publication owner receives the complete receipt; no partial tuple written');
  } finally {
    restore();
  }
});

test('repeated calls for one managed in-flight identity still share its build', async () => {
  const { subject, events, restore } = loadStaging({ cloneDelayMs: 20 });
  const headSha = 'a'.repeat(40);
  const options = { previewFlow: { flowId: randomUUID(), generation: 1, headSha } };
  try {
    await Promise.all([
      subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(7), mkApp, headSha, options),
      subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(7), mkApp, headSha, options),
    ]);
    assert.equal(events.filter(event => event[0] === 'clone').length, 1);
  } finally {
    restore();
  }
});

test('native publication and cleanup consumer completes before any legacy successor can start', async () => {
  const { subject, events, restore } = loadStaging();
  let release;
  const finish = new Promise(r => { release = r; });
  let entered;
  const consuming = new Promise(r => { entered = r; });
  const head = 'a'.repeat(40);
  let intent;
  try {
    const managed = subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(7), mkApp, head, {
      previewFlow: { flowId: randomUUID(), generation: 1, headSha: head },
      beforeBuild: async value => {
        intent = value;
        assert.equal(events.length, 0, 'intent precedes creation');
      },
      consumePrepared: async result => {
        assert.equal(result.runtimeName, intent.runtimeName);
        entered();
        await finish;
      },
    });
    await consuming;
    const legacy = subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(7), mkApp, 'b'.repeat(40));
    await new Promise(r => setImmediate(r));
    assert.equal(events.filter(event => event[0] === 'clone').length, 1, 'successor waits through consumption');
    release();
    await Promise.all([managed, legacy]);
    assert.equal(events.filter(event => event[0] === 'clone').length, 2);
  } finally {
    release();
    restore();
  }
});

test("'latest' never coalesces — it can point at different content over time", async () => {
  const { subject, events, maxConcurrent, restore } = loadStaging({ cloneDelayMs: 20 });
  try {
    const pA = subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(7), mkApp, 'latest');
    const pB = subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(7), mkApp, 'latest');
    await Promise.all([pA, pB]);

    const clones = events.filter((e) => e[0] === 'clone' && e[1] === 7);
    assert.equal(clones.length, 2, "two 'latest' builds run (serialized), not one");
    assert.equal(maxConcurrent(), 1, 'still never overlapping');
  } finally {
    restore();
  }
});

test('different sessions still build in parallel', async () => {
  const { subject, maxConcurrent, restore } = loadStaging({ cloneDelayMs: 40 });
  try {
    const pA = subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(7), mkApp, 'dddddd4');
    const pB = subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(8), mkApp, 'eeeeee5');
    await Promise.all([pA, pB]);
    assert.equal(maxConcurrent(), 2, 'cross-session builds are not serialized');
  } finally {
    restore();
  }
});

test('a failed build does not block the next queued build for the session', async () => {
  let call = 0;
  const { subject, events, restore } = loadStaging({
    cloneDelayMs: 10,
    // First build's image step blows up (e.g. broken Dockerfile on the old
    // commit); the queued build with the fix must still run.
    buildImageImpl: async () => {
      call += 1;
      if (call === 1) throw new Error('docker build failed');
    },
  });
  try {
    const pA = subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(7), mkApp, 'ffffff6');
    const pB = subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(7), mkApp, 'abcdef7');
    const [rA, rB] = await Promise.allSettled([pA, pB]);

    assert.equal(rA.status, 'rejected', 'the broken build still surfaces its real error');
    assert.match(rA.reason.message, /docker build failed/);
    assert.equal(rB.status, 'fulfilled', 'the follow-up build ran and succeeded');
    const clones = events.filter((e) => e[0] === 'clone' && e[1] === 7);
    assert.equal(clones.length, 2, 'both builds started their independent clones');
    assert.equal(events.filter(e => e[0] === 'drop').length, 1, 'failed build clone was cleaned up');
  } finally {
    restore();
  }
});

test('sequential (non-overlapping) builds are independent — the chain self-cleans', async () => {
  const { subject, events, restore } = loadStaging({ cloneDelayMs: 5 });
  try {
    await subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(7), mkApp, '111111a');
    // Same commit, but the first build has fully settled — this must be a
    // fresh build (a re-deploy request), not a stale coalesced result.
    await subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(7), mkApp, '111111a');
    const clones = events.filter((e) => e[0] === 'clone' && e[1] === 7);
    assert.equal(clones.length, 2, 'settled chains do not swallow later rebuild requests');
  } finally {
    restore();
  }
});


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
    const result = subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(8), mkApp, 'aaaaaa1');
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
      const result = subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(8), mkApp, 'aaaaaa1');
      const checked = assert.rejects(result, fails === 'clone' ? /clone failed/ : /image failed/);
      await Promise.all([imageStarted.promise, cloneStarted.promise]);
      if (fails === 'clone') cloneDone.reject(new Error('clone failed'));
      else imageDone.reject(new Error('image failed'));
      await new Promise(r => setImmediate(r));
      assert.equal(events.some(e => e[0] === 'drop'), false, 'no cleanup while the sibling still runs');
      if (fails === 'clone') imageDone.resolve();
      else if (fails === 'both') cloneDone.reject(new Error('clone failed'));
      else cloneDone.resolve({ password: 'pw' });
      await checked;
      assert.equal(events.filter(e => e[0] === 'drop').length, 1);
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
      await assert.rejects(subject.buildAndDeployStaging({ jwtSecret: 's' }, mkSession(8), mkApp, 'aaaaaa1'), /image failed/);
      assert.equal(events.some(e => ['clone', 'drop'].includes(e[0])), false);
    } finally { restore(); }
  });
}
