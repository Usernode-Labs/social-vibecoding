// #767: the SIGTERM→SIGKILL grace handed to `docker stop -t`, and the
// forceKilled diagnostic.
//
// The grace is a CEILING, not a cost — a container that exits on its own
// returns `docker stop` immediately. Two values are in play:
//   - STOP_GRACE_SEC (5s) for live app containers, sized ABOVE the 3s drain
//     deadline the app conventions prescribe so a correctly-draining app is
//     never SIGKILLed mid-drain.
//   - STAGING_STOP_GRACE_SEC (2s) for throwaway previews, which have
//     nothing to drain.
// restartContainer keeps the long 10s grace: it stops a nominally-live
// container on the heal path and isn't latency-sensitive.
//
// `forceKilled` is the diagnostic that finds apps still lacking a shutdown
// handler without inspecting their repos, so it gets pinned too.
//
// Run with: node --test tests/docker-stop-grace.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// `stopDelayMs` models how long `docker stop` blocks: a container that
// handles SIGTERM returns fast; one that ignores it burns the whole grace.
function loadDocker({ stopDelayMs = 0 } = {}) {
  const ids = {
    childProcess: require.resolve('child_process'),
    logger: require.resolve('../src/services/logger'),
    subject: require.resolve('../src/services/docker'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const logs = [];
  const calls = [];
  const fakeExecFile = async (cmd, args) => {
    calls.push({ cmd, args });
    if (args[0] === 'stop' && stopDelayMs > 0) {
      await new Promise((r) => setTimeout(r, stopDelayMs));
    }
    return { stdout: '', stderr: '' };
  };
  fakeExecFile[require('util').promisify.custom] = fakeExecFile;

  stub(ids.childProcess, { execFile: fakeExecFile, spawn: () => { throw new Error('unused'); } });
  stub(ids.logger, {
    info: (cat, msg, data) => logs.push({ level: 'info', cat, msg, data }),
    warn: (cat, msg, data) => logs.push({ level: 'warn', cat, msg, data }),
    error: (cat, msg, data) => logs.push({ level: 'error', cat, msg, data }),
    debug() {},
  });
  delete require.cache[ids.subject];
  const docker = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { docker, calls, logs, restore };
}

function stopArgs(calls) {
  return calls.find((c) => c.args[0] === 'stop').args;
}

test('stopAndRemove defaults to the 5s app grace', async () => {
  const { docker, calls, restore } = loadDocker();
  try {
    assert.equal(docker.STOP_GRACE_SEC, 5,
      'app grace must sit above the 3s drain deadline the conventions prescribe');
    await docker.stopAndRemove('usernode-app-demo');
    assert.deepEqual(stopArgs(calls), ['stop', '-t', '5', 'usernode-app-demo']);
  } finally {
    restore();
  }
});

test('stopAndRemove honours an explicit short grace for throwaway containers', async () => {
  const { docker, calls, restore } = loadDocker();
  try {
    assert.equal(docker.STAGING_STOP_GRACE_SEC, 2);
    await docker.stopAndRemove('usernode-staging-demo--1', {
      stopTimeoutSec: docker.STAGING_STOP_GRACE_SEC,
    });
    assert.deepEqual(stopArgs(calls), ['stop', '-t', '2', 'usernode-staging-demo--1']);
  } finally {
    restore();
  }
});

test('restartContainer keeps the long 10s grace', async () => {
  const { docker, calls, restore } = loadDocker();
  try {
    await docker.restartContainer('usernode-app-demo');
    assert.deepEqual(calls[0].args, ['restart', '-t', '10', 'usernode-app-demo']);
  } finally {
    restore();
  }
});

test('a fast exit reports forceKilled=false with a measured stopMs', async () => {
  const { docker, logs, restore } = loadDocker({ stopDelayMs: 0 });
  try {
    const result = await docker.stopAndRemove('usernode-app-demo');
    assert.equal(result.forceKilled, false);
    assert.equal(typeof result.stopMs, 'number');
    assert.ok(result.stopMs >= 0);
    assert.equal(typeof result.rmMs, 'number');

    const line = logs.find((l) => l.msg === 'Container removed');
    assert.ok(line, 'the stop must be logged');
    assert.equal(line.data.forceKilled, false);
    assert.equal(line.data.stopTimeoutSec, 5);
    assert.equal(typeof line.data.stopMs, 'number');
  } finally {
    restore();
  }
});

test('a stop that burns the whole grace reports forceKilled=true', async () => {
  // A 1s ceiling with a stop that takes the full second models a container
  // whose SIGTERM went nowhere: Docker had to SIGKILL it at the deadline.
  const { docker, logs, restore } = loadDocker({ stopDelayMs: 1000 });
  try {
    const result = await docker.stopAndRemove('usernode-app-legacy', { stopTimeoutSec: 1 });
    assert.equal(result.forceKilled, true,
      'burning the full grace means the process never handled SIGTERM');
    const line = logs.find((l) => l.msg === 'Container removed');
    assert.equal(line.data.forceKilled, true);
  } finally {
    restore();
  }
});

test('staging call sites pass the short grace', () => {
  // Cross-file consistency: the constant existing is useless if the three
  // throwaway-container call sites don't actually use it.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'staging.js'), 'utf8'
  );
  const shortGraceCalls = src.match(/stopAndRemove\([^)]*STAGING_STOP_GRACE_SEC/gs) || [];
  assert.ok(shortGraceCalls.length >= 3,
    `expected >=3 staging stopAndRemove calls using the short grace, found ${shortGraceCalls.length}`);
});
