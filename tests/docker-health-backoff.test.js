// #767: escalating backoff between container health polls.
//
// Attempt 1 essentially always fails — the container has only just been
// started — and the old flat 2000ms sleep meant EVERY container start paid
// ~2s waiting for a process that was typically ready in a few hundred ms
// (production consistently logged `attempt: 2` at +2.96s). 250/500/1000
// then 2000-steady keeps the common case fast while preserving the same
// ~60s ceiling for a genuinely slow boot.
//
// Timing is modelled, never measured: the test swaps global setTimeout for
// a recorder so assertions are on the requested delays, not wall clock.
//
// Run with: node --test tests/docker-health-backoff.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// `failFirst` health polls reject, then they succeed. Sleeps are recorded
// and fired immediately so the test runs in ~0ms regardless of the delays.
function loadDocker({ failFirst = 0 } = {}) {
  const ids = {
    childProcess: require.resolve('child_process'),
    logger: require.resolve('../src/services/logger'),
    subject: require.resolve('../src/services/docker'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const logs = [];
  let polls = 0;
  const fakeExecFile = async (cmd, args) => {
    if (args[0] === 'exec') {
      polls += 1;
      if (polls <= failFirst) throw new Error('connection refused');
      return { stdout: 'ok', stderr: '' };
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

  const sleeps = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...rest) => {
    sleeps.push(ms);
    return realSetTimeout(fn, 0, ...rest);
  };

  const restore = () => {
    global.setTimeout = realSetTimeout;
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { docker, sleeps, logs, restore, polls: () => polls };
}

test('an immediately-healthy container sleeps not at all', async () => {
  const { docker, sleeps, restore } = loadDocker({ failFirst: 0 });
  try {
    const result = await docker.waitForHealthy('c', 3000, '/health');
    assert.equal(result.attempts, 1);
    assert.deepEqual(sleeps, []);
  } finally {
    restore();
  }
});

test('backoff escalates 250/500/1000 then holds at 2000', async () => {
  const { docker, sleeps, restore } = loadDocker({ failFirst: 5 });
  try {
    const result = await docker.waitForHealthy('c', 3000, '/health');
    assert.equal(result.attempts, 6);
    assert.deepEqual(sleeps, [250, 500, 1000, 2000, 2000]);
  } finally {
    restore();
  }
});

test('the common one-retry case costs 250ms, not 2000ms', async () => {
  // This is the whole point: production logged `attempt: 2` on essentially
  // every container start, so this one delay was paid on every deploy.
  const { docker, sleeps, restore } = loadDocker({ failFirst: 1 });
  try {
    const result = await docker.waitForHealthy('c', 3000, '/health');
    assert.equal(result.attempts, 2);
    assert.deepEqual(sleeps, [250]);
  } finally {
    restore();
  }
});

test('a passing healthcheck reports attempts and waitedMs', async () => {
  const { docker, logs, restore } = loadDocker({ failFirst: 2 });
  try {
    const result = await docker.waitForHealthy('c', 3000, '/health');
    assert.equal(result.attempts, 3);
    assert.equal(typeof result.waitedMs, 'number');
    assert.ok(result.waitedMs >= 0);

    const line = logs.find((l) => l.msg === 'Healthcheck passed');
    assert.ok(line);
    assert.equal(line.data.attempt, 3);
    assert.equal(typeof line.data.waitedMs, 'number');
  } finally {
    restore();
  }
});

test('the retry ceiling still covers ~60s of slow boot', () => {
  const { docker, restore } = loadDocker();
  try {
    // One sleep follows every failed attempt: the 3 escalating steps, then
    // the rest at the 2000ms plateau. Keep the total at or above the
    // pre-#767 budget (30 attempts x 2000ms = 60s) so shortening the early
    // retries never shortens how long a slow-booting app is given.
    const ramp = docker.HEALTH_BACKOFF_MS.reduce((a, b) => a + b, 0);
    const attempts = 33; // the waitForHealthy maxRetries default
    const ceilingMs = ramp
      + (attempts - docker.HEALTH_BACKOFF_MS.length) * docker.HEALTH_BACKOFF_MAX_MS;
    assert.ok(ceilingMs >= 60000, `ceiling ${ceilingMs}ms must stay >= the old 60s budget`);
  } finally {
    restore();
  }
});

test('total failure still throws with the boot diagnostics attached', async () => {
  const { docker, restore } = loadDocker({ failFirst: Infinity });
  try {
    await assert.rejects(
      () => docker.waitForHealthy('c', 3000, '/health', 3),
      (err) => {
        assert.equal(err.healthcheckFailed, true);
        assert.equal(err.attempts, 3);
        assert.equal(typeof err.waitedMs, 'number');
        return true;
      }
    );
  } finally {
    restore();
  }
});
