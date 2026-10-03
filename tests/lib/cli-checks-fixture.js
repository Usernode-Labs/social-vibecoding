'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { handoffWorker } = require('./cli-handoff-fixture');

async function addChecksTables(pool) {
  await pool.query(`ALTER TABLE apps ADD COLUMN name TEXT DEFAULT 'Fixture',
    ADD COLUMN runtime_name TEXT, ADD COLUMN runtime_kind TEXT DEFAULT 'kubernetes',
    ADD COLUMN screenshot_device_scale SMALLINT DEFAULT 1, ADD COLUMN unit_suite_last_tests INTEGER;
    ALTER TABLE chat_sessions ADD COLUMN imported_pr_head_sha TEXT,
      ADD COLUMN testing_path TEXT DEFAULT '/health', ADD COLUMN shots_state TEXT,
      ADD COLUMN shots_detail JSONB,
      ADD COLUMN capture_state TEXT, ADD COLUMN capture_detail JSONB, ADD COLUMN captured_at TIMESTAMPTZ,
      ADD COLUMN console_check_state TEXT, ADD COLUMN console_errors JSONB, ADD COLUMN console_checked_at TIMESTAMPTZ;
    CREATE TABLE users (id INTEGER, username TEXT, usernode_pubkey TEXT)`);
  const source = fs.readFileSync(require.resolve('../../src/db/schema.sql'), 'utf8');
  for (const table of ['session_visuals', 'app_check_history']) {
    await pool.query(source.match(new RegExp(String.raw`CREATE TABLE IF NOT EXISTS ${table} \([\s\S]*?\n\);`))[0]);
    for (const migration of source.matchAll(new RegExp(String.raw`ALTER TABLE ${table} ADD COLUMN[\s\S]*?;`, 'g'))) {
      await pool.query(migration[0]);
    }
  }
}

// Every override is fixture input or transport, never a successful Job/result.
function actualChecksWorker(f, {
  onPhase = async () => {}, startupDelay = false,
  unitSuite = false, delayUnitCreation = false,
} = {}) {
  assert.ok(f.fixture.checks, 'Actual capture fixture must pass dedicated preflight');
  const undo = [];
  function replace(object, key, value) {
    const old = object[key];
    object[key] = value(old);
    undo.push(() => { object[key] = old; });
  }
  const env = {
    CAPTURE_RUNTIME: 'kubernetes',
    KUBERNETES_CAPTURE_IMAGE: f.fixture.checks.captureImage,
    PREVIEW_LIFECYCLE_ENABLED: 'true',
  };
  for (const [key, value] of Object.entries(env)) {
    const old = process.env[key];
    process.env[key] = value;
    undo.push(() => {
      if (old === undefined) delete process.env[key];
      else process.env[key] = old;
    });
  }
  const github = require('../../src/services/github');
  replace(github, 'isEnabled', () => () => true);
  replace(github, 'listChangedFiles', () => async () => ['frontend/fixture.js']);
  replace(github, 'getFileContent', () => async (_owner, _repo, filename) => {
    if (filename === 'dapp.json') return JSON.stringify({ tests: [{
      name: 'Real browser reaches the pinned candidate health endpoint',
      path: '/health', expectText: 'Ok',
    }] });
    // The pinned sample has no runnable npm test script. Preserve that policy.
    if (filename === 'package.json') return JSON.stringify({ scripts: unitSuite ? { test: 'node --test' } : {} });
    throw new Error(`Fixture forbids unconfigured GitHub content: ${filename}`);
  });
  const application = require('../../src/services/application-runtime');
  // Source metadata remains an injected fixture fact; resource observations
  // below remain actual. Strict-reader regressions exercise the real helper.
  replace(github, 'inspectRootFileAtCommit', () => async (owner, repo, filename, revision) => ({
    state: 'present', commitSha: revision,
    content: await github.getFileContent(owner, repo, filename, revision),
  }));
  replace(application, 'probeHealth', () => (_config, ref) => f.probe(f.config, {
    namespace: f.config.kubernetes.appNamespace, runtimeName: ref.runtimeName,
  }));
  const staging = require('../../src/services/staging');
  replace(staging, 'verifyStagingEdge', () => async session => ({
    ok: await f.probe(f.config, { namespace: f.config.kubernetes.appNamespace,
      runtimeName: session.staging_runtime_name }), code: 200,
  }));
  const kubernetes = require('../../src/services/kubernetes');
  replace(kubernetes, 'runCaptureJob', original => async (config, options) => {
    const session = (await f.pool.query('SELECT staging_runtime_name FROM chat_sessions WHERE id = $1',
      [options.sessionId])).rows[0];
    const origin = `http://${session.staging_runtime_name}.${config.kubernetes.appNamespace}.svc:3000`;
    const translate = value => value.replaceAll(new RegExp(`https://demo--s${options.sessionId}\\.fixture\\.invalid`, 'g'), origin);
    const env = Object.fromEntries(Object.entries(options.env).map(([key, value]) => [key, translate(String(value))]));
    // Exercise real Secret stdin transport even for this small assertion suite.
    const stdinPayload = options.stdinPayload || env.TESTS;
    env.TESTS = '@stdin';
    return original(config, { ...options, env, stdinPayload: translate(stdinPayload), cpus: '1', memory: '1g' });
  });
  if (unitSuite) {
    assert.ok(f.fixture.checks.unitSuite, 'Dedicated unit-suite inputs required');
    replace(github, 'getCloneUrl', () => async () => f.fixture.preparationSource.repoUrl);
    replace(kubernetes, 'runUnitSuiteJob', original => (config, options) => original(config, {
      ...options,
      env: { ...options.env, REPO_URL: f.fixture.checks.unitSuite.repoUrl,
        GIT_REF: f.fixture.checks.unitSuite.revision,
        UNIT_FIXTURE_TOKEN: 'isolated-secret' },
      // Actual runner script follows the delay; no result or observation is substituted.
      cmd: ['bash', '-c', `sleep 20; ${options.cmd[2]}`], cpus: '1', memory: '512m',
    }));
  }

  async function waitForRunningJob(job, namespace, kind, pollMs) {
    const deadline = Date.now() + 120000;
    for (;;) {
      const pods = await f.clients.core.listNamespacedPod({ namespace,
        labelSelector: `job-name=${job.metadata.name}` });
      if (pods.items.some(pod => pod.status?.containerStatuses?.some(status => status.state?.running))) return;
      assert.ok(Date.now() < deadline, `Actual ${kind} container must start`);
      await delay(pollMs);
    }
  }

  const batch = f.clients.batch;
  replace(batch, 'createNamespacedJob', original => async params => {
    assert.equal(params.namespace, f.fixture.isolation.namespace.name);
    if (params.body.metadata.name.startsWith(`sv-capture-s`)) {
      if (startupDelay) {
        // Inject interruption opportunity, not a result: actual capture runs later.
        const container = params.body.spec.template.spec.containers[0];
        container.command = ['sh', '-c'];
        container.args = ['sleep 20; exec node /app/capture.js < /var/run/usernode-capture/tests.json'];
      }
      const job = await original.call(batch, params);
      await waitForRunningJob(job, params.namespace, 'capture', 500);
      await onPhase('checks_running', { name: job.metadata.name, uid: job.metadata.uid });
      return job;
    }
    if (unitSuite && params.body.metadata.name.startsWith('sv-unit-suite-s')) {
      if (delayUnitCreation) {
        // Hold the actual POST after input creation. Capture can progress concurrently.
        const deadline = Date.now() + 120000;
        for (;;) {
          const jobs = await kubernetes.findCheckJobs(f.config, {
            sessionId: Number(params.body.metadata.labels['social.usernode.io/session-id']),
            previewRunId: params.body.metadata.labels['social.usernode.io/preview-run-id'],
          });
          if (jobs.capture) break;
          assert.ok(Date.now() < deadline, 'Capture must exist before delayed unit submission');
          await delay(250);
        }
        await onPhase('unit_creation_submitted', { name: params.body.metadata.name, body: params.body });
      }
      const job = await original.call(batch, params);
      await waitForRunningJob(job, params.namespace, 'unit', 250);
      await onPhase('unit_running', { name: job.metadata.name, uid: job.metadata.uid });
      return job;
    }
    return original.call(batch, params);
  });
  const basePool = require('../../src/db/pool').getPool(f.config);
  replace(basePool, 'connect', original => function connect(callback) {
    if (callback) {
      return original.call(basePool, (error, client) => {
        if (error) return callback(error);
        callback(null, observeClient(client), client.release);
      });
    }
    return original.call(basePool).then(observeClient);
  });

  function observeClient(client) {
    const query = client.query.bind(client);
    let verdict = false;
    client.query = async (...args) => {
      if (typeof args.at(-1) === 'function') return query(...args);
      const result = await query(...args);
      const sql = typeof args[0] === 'string' ? args[0] : args[0].text;
      if (/UPDATE chat_sessions/.test(sql) && /SET check_state = \$1/.test(sql)
          && /checks_checked_at = NOW\(\)/.test(sql)
          && ['passing', 'failing', 'error', 'skipped'].includes(args[1]?.[0])) verdict = true;
      if (verdict && /^COMMIT\b/.test(sql)) {
        verdict = false;
        await onPhase('verdict_persisted');
      }
      return result;
    };
    const release = client.release.bind(client);
    client.release = (...args) => {
      client.query = query;
      client.release = release;
      return release(...args);
    };
    return client;
  }
  const work = handoffWorker(f, {
    capture: (config, ...args) => require('../../src/services/visuals').captureForSession(
      { ...config, selfAppSlug: 'fixture-platform' }, ...args),
  });
  return { work, restore() { for (const restore of undo.reverse()) restore(); } };
}

module.exports = { actualChecksWorker, addChecksTables };
