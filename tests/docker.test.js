// Tests for docker.runContainer's name-conflict self-heal.
//
// When `docker run --name X` collides with a leftover container (a prior
// stopAndRemove raced, an aborted rebuild left a half-removed container,
// or two rebuild paths interleaved), docker fails with "The container
// name "/X" is already in use". runContainer should force-remove the
// stale container and retry exactly once instead of bubbling the failure
// up and bricking the deploy — this is the defense-in-depth layer under
// staging.rebuildProduction's per-app serialization.
//
// We stub child_process.execFile (which docker.js promisifies at load)
// so no real docker is invoked.
//
// Run with: node --test tests/docker.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// Load docker.js with a scripted execFile. `script(cmd, args)` returns
// either { stdout } (success) or throws/returns an Error to reject.
function loadDockerWithExecFile(script) {
  const cpId = require.resolve('child_process');
  const loggerId = require.resolve('../src/services/logger');
  const dockerId = require.resolve('../src/services/docker');
  const orig = {
    cp: require.cache[cpId],
    logger: require.cache[loggerId],
    docker: require.cache[dockerId],
  };

  const calls = [];
  const realCp = require('child_process');
  // execFile(cmd, args, options, callback) — promisify calls it with a
  // node-style callback. We translate the script's return/throw into it.
  const fakeExecFile = (cmd, args, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    calls.push({ cmd, args });
    Promise.resolve()
      .then(() => script(cmd, args))
      .then(
        (res) => cb(null, res || { stdout: '', stderr: '' }),
        (err) => cb(err)
      );
  };
  stub(cpId, { ...realCp, execFile: fakeExecFile });
  stub(loggerId, { info() {}, warn() {}, error() {}, debug() {} });

  delete require.cache[dockerId];
  const docker = require(dockerId);

  const restore = () => {
    if (orig.cp) require.cache[cpId] = orig.cp; else delete require.cache[cpId];
    if (orig.logger) require.cache[loggerId] = orig.logger; else delete require.cache[loggerId];
    if (orig.docker) require.cache[dockerId] = orig.docker; else delete require.cache[dockerId];
  };
  return { docker, calls, restore };
}

function nameInUseError() {
  const e = new Error('Command failed: docker run ...');
  e.stderr = 'docker: Error response from daemon: Conflict. The container ' +
    'name "/usernode-app-x" is already in use by container "099d1772".';
  return e;
}

test('runContainer: removes the stale container and retries once on a name conflict', async () => {
  let runAttempts = 0;
  const { docker, calls, restore } = loadDockerWithExecFile((cmd, args) => {
    if (args[0] === 'run') {
      runAttempts += 1;
      if (runAttempts === 1) throw nameInUseError();
      return { stdout: 'newcontainerid123\n' };
    }
    if (args[0] === 'rm') return { stdout: '' };
    return { stdout: '' };
  });
  try {
    const id = await docker.runContainer('usernode-app-x', {
      image: 'img:latest', port: 3000,
    });
    assert.equal(id, 'newcontainerid123', 'returns the id from the successful retry');
    assert.equal(runAttempts, 2, 'retried the run exactly once');
    assert.ok(
      calls.some((c) => c.args[0] === 'rm' && c.args.includes('-f') && c.args.includes('usernode-app-x')),
      'force-removed the conflicting container before retrying'
    );
  } finally {
    restore();
  }
});

test('runContainer: succeeds on the first try without any rm when there is no conflict', async () => {
  const { docker, calls, restore } = loadDockerWithExecFile((cmd, args) => {
    if (args[0] === 'run') return { stdout: 'firsttryid456\n' };
    return { stdout: '' };
  });
  try {
    const id = await docker.runContainer('usernode-app-y', { image: 'img:latest', port: 3000 });
    assert.equal(id, 'firsttryid456');
    assert.equal(calls.filter((c) => c.args[0] === 'rm').length, 0, 'no rm on the happy path');
  } finally {
    restore();
  }
});

test('runContainer: a non-conflict run error is not retried and propagates', async () => {
  let runAttempts = 0;
  const { docker, restore } = loadDockerWithExecFile((cmd, args) => {
    if (args[0] === 'run') {
      runAttempts += 1;
      const e = new Error('boom');
      e.stderr = 'docker: Error response from daemon: no such image: img:latest';
      throw e;
    }
    return { stdout: '' };
  });
  try {
    await assert.rejects(
      () => docker.runContainer('usernode-app-z', { image: 'img:latest', port: 3000 }),
      /boom|no such image/
    );
    assert.equal(runAttempts, 1, 'a non-name-conflict error must not trigger the retry');
  } finally {
    restore();
  }
});
