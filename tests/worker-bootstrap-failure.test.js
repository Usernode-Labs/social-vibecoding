// Bootstrap failures used to arrive as the two words "clone failed".
//
// Three production sessions on 2026-09-02 died 212-252ms after their
// container spawned, and every layer between git and the user threw the
// reason away: worker-run.sh merged git's stderr into stdout and `die`d with
// a fixed string, `_awaitWarmReady` turned that marker straight into
// `new Error('clone failed')` with none of the preceding lines, and
// `describeTurnError` had no branch for it. The container that still held
// the answer in `docker logs` was reaped, unread, at the start of the next
// attempt. Two users then spent real budget chasing a GitHub auth problem
// that does not exist on this path (the worker clones anonymously and holds
// no credentials at all).
//
// These tests pin the four properties that fix is made of:
//   1. The failing command's output reaches the thrown Error, along with the
//      last phase the wrapper announced.
//   2. The rejection paths that carry NO detail of their own (the wrapper
//      dying, the warm-ready timeout) carry the log tail instead.
//   3. Transient failures retry, bounded; deterministic ones do not.
//   4. The diagnostics are non-enumerable, so every existing
//      `{ message, stack }` log line and `send('error', …)` payload is
//      byte-identical to before.
//
// Run with: node --test tests/worker-bootstrap-failure.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.WORKER_JWT_SECRET = process.env.WORKER_JWT_SECRET || 'test-worker-secret';

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// Load worker.js against a fake docker + github + `docker logs -f`.
//
// `scripts` is one canned bootstrap-log script per attempt: an array of
// stdout lines, optionally ending the stream (`close`) rather than reaching
// warm-ready. The last script repeats if there are more attempts than
// scripts, which is what makes "fails every time" a one-element array.
function loadWorker({ scripts = [], repoPrivate = false, dockerLogs = '' } = {}) {
  const ids = {
    docker: require.resolve('../src/services/docker'),
    github: require.resolve('../src/services/github'),
    logger: require.resolve('../src/services/logger'),
    childProcess: require.resolve('child_process'),
    subject: require.resolve('../src/services/worker'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const calls = [];
  const logs = [];
  const realDocker = require('../src/services/docker');
  stub(ids.docker, {
    ...realDocker,
    getContainerStatus: async () => 'not_found',
    getContainerLabels: async () => ({}),
    ensureVolume: async () => {},
    stopAndRemove: async (name) => { calls.push({ cmd: 'stopAndRemove', name }); },
    execFileAsync: async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === 'logs' && args[1] === '--tail') {
        return { stdout: dockerLogs, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
  });
  stub(ids.github, {
    ...require('../src/services/github'),
    checkRepoPublic: async () => ({ ok: true, private: repoPrivate }),
    getCloneUrl: async () => 'https://github.com/owner/repo.git',
  });
  const record = (level) => (scope, msg, data) => logs.push({ level, scope, msg, data });
  stub(ids.logger, {
    info: record('info'), warn: record('warn'),
    error: record('error'), debug: record('debug'),
  });

  let spawnCount = 0;
  const realCp = require('child_process');
  stub(ids.childProcess, {
    ...realCp,
    spawn: () => {
      const script = scripts[Math.min(spawnCount, scripts.length - 1)] || { lines: [] };
      spawnCount += 1;
      const handlers = {};
      const proc = {
        stdout: { on: (ev, fn) => { if (ev === 'data') handlers.data = fn; } },
        stderr: { on: (ev, fn) => { if (ev === 'data') handlers.stderr = fn; } },
        on: (ev, fn) => { handlers[ev] = fn; },
        kill: () => {},
      };
      setImmediate(() => {
        if (script.lines?.length) handlers.data?.(Buffer.from(`${script.lines.join('\n')}\n`));
        if (script.stderr?.length) handlers.stderr?.(Buffer.from(`${script.stderr.join('\n')}\n`));
        if (script.close !== false) handlers.close?.(script.code ?? 1);
      });
      return proc;
    },
  });

  delete require.cache[ids.subject];
  const worker = require('../src/services/worker');
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k];
      else delete require.cache[id];
    }
    delete require.cache[require.resolve('../src/services/worker')];
  };
  return { worker, calls, logs, restore, spawns: () => spawnCount };
}

const ENSURE_ARGS = { repoOwner: 'owner', repoName: 'repo', branchName: 'dev/test' };

// A clone that failed the way the real ones did: git's stderr, folded onto
// the marker line by worker-run.sh's `clip`.
const CLONE_FAILURE = {
  lines: [
    '__USERNODE_PHASE__ seeded playwright mcp config',
    '__USERNODE_PHASE__ clone',
    "__USERNODE_ERROR__ clone failed: Cloning into '.'... | fatal: unable to access 'https://github.com/owner/repo.git/': Could not resolve host: github.com",
  ],
};

async function expectReject(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection, got none');
}

// ── 1. The reason survives all the way to the thrown Error ──────────────

test('a clone failure carries git\'s own words, the phase, and the log tail', async () => {
  const { worker, restore } = loadWorker({ scripts: [CLONE_FAILURE] });
  try {
    const err = await expectReject(() => worker.ensureWorker(1, ENSURE_ARGS));

    // The words a human needs. Before this change the whole message was the
    // eleven characters "clone failed".
    assert.match(err.message, /^clone failed: /);
    assert.match(err.message, /Could not resolve host: github\.com/);

    assert.equal(err.bootstrapPhase, 'clone', 'names how far bootstrap got');
    assert.equal(err.bootstrapContainerName, 'usernode-worker-1');
    assert.equal(err.bootstrapAttempts, 3, 'records how many attempts were spent');
    assert.ok(worker.isBootstrapError(err));
  } finally { restore(); }
});

test('the wrapper dying with no marker at all still reports the container output', async () => {
  // The rejection path with NO detail of its own: `docker logs -f` closed
  // before warm-ready. Without the ring buffer this says only that bootstrap
  // did not finish.
  const { worker, restore } = loadWorker({
    scripts: [{
      lines: ['__USERNODE_PHASE__ clone'],
      stderr: ['error response from daemon: no space left on device'],
    }],
  });
  try {
    const err = await expectReject(() => worker.ensureWorker(2, ENSURE_ARGS));
    assert.match(err.message, /^warm wrapper exited before warm-ready/);
    assert.equal(err.bootstrapPhase, 'clone');
    assert.ok(
      err.bootstrapLog.some((l) => /no space left on device/.test(l)),
      `log tail should hold the container output, got ${JSON.stringify(err.bootstrapLog)}`,
    );
  } finally { restore(); }
});

test('diagnostics are non-enumerable, so existing error logging is unchanged', async () => {
  const { worker, restore } = loadWorker({ scripts: [CLONE_FAILURE] });
  try {
    const err = await expectReject(() => worker.ensureWorker(3, ENSURE_ARGS));
    // `log.error('sessions', 'Chat error', { message, stack })` and
    // `send('error', { error: err.message })` must serialize exactly as they
    // did before — a bootstrap log tail in an SSE frame would be a
    // regression, not a feature.
    assert.deepEqual(Object.keys(err), []);
    assert.equal(JSON.stringify({ ...err }), '{}');
    assert.ok(err.bootstrapLog, 'still readable by the code that wants it');
  } finally { restore(); }
});

// ── 2. The harvest happens before the corpse is reaped ──────────────────

test('the failing container\'s logs are read before the next attempt scrubs it', async () => {
  const { worker, calls, restore } = loadWorker({
    // No lines at all: nothing for the ring buffer to hold, so the harvest
    // is the only source of detail.
    scripts: [{ lines: [] }],
    dockerLogs: 'fatal: the remote end hung up unexpectedly\n',
  });
  try {
    await expectReject(() => worker.ensureWorker(4, ENSURE_ARGS));
    const order = calls
      .map((c) => (c.cmd === 'stopAndRemove' ? 'reap' : (c.args?.[0] === 'logs' && c.args?.[1] === '--tail' ? 'harvest' : null)))
      .filter(Boolean);
    // reap (attempt 1's defensive scrub) → harvest → reap → harvest → …
    // The invariant that matters: no harvest is preceded by its OWN reap.
    assert.equal(order[0], 'reap');
    assert.equal(order[1], 'harvest');
    assert.ok(order.filter((o) => o === 'harvest').length >= 1);
  } finally { restore(); }
});

// ── 3. Bounded retry of the transient, none of the deterministic ────────

test('a transient clone failure is retried, three attempts total', async () => {
  const { worker, restore, spawns } = loadWorker({ scripts: [CLONE_FAILURE] });
  try {
    const progress = [];
    await expectReject(() => worker.ensureWorker(5, { ...ENSURE_ARGS, onProgress: (t) => progress.push(t) }));
    assert.equal(spawns(), 3, 'BOOTSTRAP_MAX_ATTEMPTS attempts, no more');
    const retries = progress.filter((t) => t.startsWith('[retrying setup'));
    assert.equal(retries.length, 2, 'one user-visible retry line per retry');
    assert.equal(retries[0], '[retrying setup (attempt 2 of 3)]');
  } finally { restore(); }
});

test('a clone that succeeds on the second attempt returns a warm container', async () => {
  const { worker, restore, spawns } = loadWorker({
    scripts: [
      CLONE_FAILURE,
      { lines: ['__USERNODE_PHASE__ clone', '__USERNODE_PHASE__ warm-ready'], close: false },
    ],
  });
  try {
    const name = await worker.ensureWorker(6, ENSURE_ARGS);
    assert.equal(name, 'usernode-worker-6');
    assert.equal(spawns(), 2, 'stops retrying the moment it works');
  } finally { restore(); }
});

test('a checkout failure is NOT retried — the branch will not fix itself', async () => {
  const { worker, restore, spawns } = loadWorker({
    scripts: [{
      lines: [
        '__USERNODE_PHASE__ checkout',
        "__USERNODE_ERROR__ checkout failed: fatal: a branch named 'dev/test' already exists",
      ],
    }],
  });
  try {
    const err = await expectReject(() => worker.ensureWorker(7, ENSURE_ARGS));
    assert.match(err.message, /^checkout failed: /);
    assert.equal(spawns(), 1);
    assert.equal(err.bootstrapAttempts, 1);
    assert.ok(worker.isBootstrapError(err));
    assert.ok(!worker.isRetryableBootstrapError(err));
  } finally { restore(); }
});

test('a private repo is refused once, before any container is spawned', async () => {
  const { worker, calls, restore, spawns } = loadWorker({ repoPrivate: true });
  try {
    const err = await expectReject(() => worker.ensureWorker(8, ENSURE_ARGS));
    assert.match(err.message, /repo is private/);
    assert.equal(spawns(), 0, 'never even started a container');
    assert.equal(calls.filter((c) => c.args?.[0] === 'run').length, 0);
    // Deterministic, so it is not a bootstrap error for retry/copy purposes.
    assert.ok(!worker.isBootstrapError(err));
  } finally { restore(); }
});

test('classification keys off the stable marker prefix, never git\'s wording', () => {
  const { worker, restore } = loadWorker();
  try {
    const { isBootstrapError: isBoot, isRetryableBootstrapError: isRetry } = worker;
    // The whole point of slice 1 is that the text after the colon now VARIES.
    assert.ok(isBoot(new Error('clone failed: fatal: could not read Username')));
    assert.ok(isBoot(new Error('clone failed: fatal: Could not resolve host')));
    assert.ok(isRetry(new Error('clone failed: anything at all')));
    assert.ok(isBoot(new Error('warm-ready timeout for usernode-worker-9')));
    assert.ok(isRetry(new Error('warm-ready timeout for usernode-worker-9')));
    assert.ok(isBoot(new Error('warm wrapper exited before warm-ready (code=1)')));
    assert.ok(!isRetry(new Error('warm wrapper exited before warm-ready (code=1)')),
      'a wrapper that died structurally will die the same way again');
    assert.ok(!isBoot(new Error('boom')));
    assert.ok(!isBoot(null));
  } finally { restore(); }
});

// ── 4. Concurrent ensures still share one bootstrap ─────────────────────

test('a second ensure joins the in-flight bootstrap instead of retrying alongside it', async () => {
  const { worker, restore, spawns } = loadWorker({ scripts: [CLONE_FAILURE] });
  try {
    const first = worker.ensureWorker(10, ENSURE_ARGS);
    // Let the first caller past its Docker status check, which is where the
    // registry entry carrying the shared `bootstrap` promise is written.
    await new Promise((r) => setTimeout(r, 20));
    const second = worker.ensureWorker(10, ENSURE_ARGS);
    const results = await Promise.allSettled([first, second]);
    assert.equal(results[0].status, 'rejected');
    assert.equal(results[1].status, 'rejected');
    // Three attempts for the ONE coalesced bootstrap, not six: the retries
    // live INSIDE the shared promise, so a second caller adds no load and
    // gets the same error the first one did.
    assert.equal(spawns(), 3);
    assert.match(results[1].reason.message, /^clone failed: /);
  } finally { restore(); }
});
