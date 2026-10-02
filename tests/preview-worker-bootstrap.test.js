'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

// Fresh singleton/SDK state in each process. PostgreSQL/execution are substituted
// here; the delivery suite proves durable behavior against disposable PostgreSQL.
const bootstrap = `
  const assert = require('node:assert/strict');
  const { generateKeyPairSync } = require('node:crypto');
  const mode = process.argv[1];
  const events = [];
  function stub(path, exports) {
    const id = require.resolve(path);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  }
  global.fetch = () => { throw new Error('Network forbidden in bootstrap regression'); };
  for (const name of ['node:http', 'node:https']) {
    require(name).request = () => { throw new Error('Network forbidden in bootstrap regression'); };
  }
  stub('./src/services/preview-flow/experimental-support', { async assertSupportedExperimentalStore() {} });
  const github = require('./src/services/github');
  const llm = require('./src/services/llm');
  assert.equal(github.isEnabled(), false);
  assert.equal(github.getInitializationStatus(), 'uninitialized');
  const initGithub = github.init;
  github.init = async config => {
    events.push('github');
    if (mode === 'github-error') throw new Error('Injected GitHub initialization failure');
    await initGithub(config);
  };
  const initLlm = llm.init;
  llm.init = async config => {
    events.push('llm');
    if (mode === 'llm-error') throw new Error('Injected LLM initialization failure');
    await initLlm(config);
  };
  stub('./src/services/execution/discovery-pool', {
    createDiscoveryPool() {
      events.push('discovery-pool');
      return { async end() { events.push('pool-stop'); } };
    },
  });
  stub('./src/services/cli-preview-handoff/work', {
    createCliHandoffWork() { return { preview: { store: {} }, handlers: {} }; },
  });
  stub('./src/services/preview-flow/work', {
    createPreviewWork() { return { async census() {} }; },
  });
  stub('./src/services/proposal-review/work', {
    createReviewWork() { return { handlers: {} }; },
  });
  stub('./src/services/execution/service', {
    createExecutionService() {
      events.push('execution');
      assert.equal(github.getInitializationStatus(), mode === 'ready' ? 'ready' : 'unavailable');
      return { async stop() { events.push('execution-stop'); } };
    },
  });
  const config = {};
  if (mode === 'ready') {
    config.githubAppId = '123';
    config.githubPrivateKey = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
  }
  (async () => {
    const { runWorker } = require('./scripts/preview-preparation-worker');
    if (mode.endsWith('-error')) {
      await assert.rejects(runWorker({ pool: {}, config }), /initialization failure/);
      assert.deepEqual(events, mode === 'github-error' ? ['github'] : ['github', 'llm']);
    } else {
      const worker = await runWorker({ pool: {}, config });
      await worker.stop();
      assert.deepEqual(events, ['github', 'llm', 'discovery-pool', 'execution', 'execution-stop', 'pool-stop']);
      assert.equal(github.isEnabled(), mode === 'ready');
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
`;

for (const mode of ['ready', 'unavailable', 'github-error', 'llm-error']) {
  test(`standalone worker initializes dependencies before claiming work: ${mode}`, () => {
    const result = spawnSync(process.execPath, ['-e', bootstrap, mode], {
      cwd: require('node:path').resolve(__dirname, '..'),
      env: { PATH: process.env.PATH, NODE_ENV: 'test' },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  });
}
