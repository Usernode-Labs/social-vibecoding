// #767: `docker run --init` on app/staging containers.
//
// Why this test is worth its weight: without --init the app's Node process
// is PID 1, and Linux DISCARDS signals PID 1 has installed no handler for.
// `docker stop`'s SIGTERM therefore went nowhere and every container was
// SIGKILLed after the full grace window (measured 10.7-11.4s on every
// single stop in production, never less). One dropped flag silently
// re-breaks graceful shutdown for every app on the platform, with no
// symptom other than deploys quietly getting ~20s slower again — so pin it.
//
// runOneShot deliberately does NOT get --init: the capture container is
// --rm, foreground, and already lifetime-bounded by its exec timeout.
//
// Run with: node --test tests/docker-init-flag.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// services/docker closes over `promisify(execFile)` at require time, so the
// seam is child_process — stub it, then load docker fresh.
function loadDocker() {
  const ids = {
    childProcess: require.resolve('child_process'),
    logger: require.resolve('../src/services/logger'),
    subject: require.resolve('../src/services/docker'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const calls = [];
  const fakeExecFile = (cmd, args) => {
    calls.push({ cmd, args });
    return Promise.resolve({ stdout: 'deadbeefcafe0000\n', stderr: '' });
  };
  // promisify() honours this symbol, so execFileAsync resolves to the
  // { stdout, stderr } object the real promisified execFile yields.
  fakeExecFile[require('util').promisify.custom] = fakeExecFile;

  stub(ids.childProcess, { execFile: fakeExecFile, spawn: () => { throw new Error('unused'); } });
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  delete require.cache[ids.subject];
  const docker = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { docker, calls, restore };
}

test('runContainer passes --init so SIGTERM reaches the app', async () => {
  const { docker, calls, restore } = loadDocker();
  try {
    await docker.runContainer('usernode-app-demo', {
      image: 'usernode-app-demo:latest',
      env: { PORT: '3000' },
      port: '3000',
    });
    assert.equal(calls.length, 1);
    const { cmd, args } = calls[0];
    assert.equal(cmd, 'docker');
    assert.equal(args[0], 'run');
    assert.ok(
      args.includes('--init'),
      'runContainer must pass --init — without it Node runs as PID 1 and discards SIGTERM'
    );
  } finally {
    restore();
  }
});

test('runOneShot does NOT pass --init', async () => {
  const { docker, calls, restore } = loadDocker();
  try {
    await docker.runOneShot('usernode-capture-1', { image: 'usernode-capture:latest' });
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].args.includes('--init'),
      'the one-shot capture container is --rm and timeout-bounded; --init buys nothing there');
  } finally {
    restore();
  }
});

test('--init sits before the image argument', async () => {
  // `docker run [OPTIONS] IMAGE` — a flag after the image name is passed to
  // the container as an argv, not consumed by docker. Ordering matters.
  const { docker, calls, restore } = loadDocker();
  try {
    await docker.runContainer('usernode-staging-demo--1', {
      image: 'usernode-staging-demo:latest',
      env: {},
      port: '3000',
    });
    const { args } = calls[0];
    assert.ok(args.indexOf('--init') < args.indexOf('usernode-staging-demo:latest'),
      '--init must be a docker option, not a container argv');
  } finally {
    restore();
  }
});
