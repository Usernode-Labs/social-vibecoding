'use strict';

// #6598: before a worker starts, Homeroom asks GitHub whether the repository
// is public. A brief GitHub outage (a 5xx, a timeout, a dropped connection)
// used to end the whole build, fix, takeover or shots run. These pin that the
// start check now asks again, that a settled answer fails at once, and that
// the exhausted case says so in plain words without GitHub's own error page.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.WORKER_JWT_SECRET = process.env.WORKER_JWT_SECRET || 'test-worker-secret';

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// Load worker.js against a fake github whose checkRepoPublic answers from
// `answers` in turn (the last one repeats). `getCloneUrl` throws a sentinel:
// it is the first thing after the privacy check, so a test that reaches it
// has passed the check without needing a Docker daemon.
function loadWorker(answers) {
  const ids = {
    docker: require.resolve('../src/services/docker'),
    github: require.resolve('../src/services/github'),
    logger: require.resolve('../src/services/logger'),
    pool: require.resolve('../src/db/pool'),
    subject: require.resolve('../src/services/worker'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  stub(ids.pool, { getPool: () => ({ query: async () => ({ rows: [] }) }) });
  stub(ids.docker, {
    ...require('../src/services/docker'),
    getContainerStatus: async () => 'not_found',
    getContainerLabels: async () => ({}),
    ensureVolume: async () => {},
    stopAndRemove: async () => {},
  });

  const calls = [];
  const logs = [];
  let next = 0;
  stub(ids.github, {
    ...require('../src/services/github'),
    checkRepoPublic: async (owner, repo) => {
      calls.push(`${owner}/${repo}`);
      const answer = answers[Math.min(next, answers.length - 1)];
      next += 1;
      return answer;
    },
    getCloneUrl: async () => { throw Object.assign(new Error('reached-clone-url'), { sentinel: true }); },
  });
  const record = (level) => (scope, msg, data) => logs.push({ level, scope, msg, data });
  stub(ids.logger, {
    info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug'),
    redactString: require('../src/services/logger').redactString,
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
  return { worker, calls, logs, restore };
}

const ARGS = { repoOwner: 'owner', repoName: 'repo', branchName: 'dev/test' };
const ERR_503 = { ok: false, code: 'github_error', message: 'No server is currently available to service your request. Sorry about that.', transient: true };
const OK = { ok: true, private: false };

async function expectReject(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection, got none');
}

async function withWorker(answers, fn) {
  const { worker, calls, logs, restore } = loadWorker(answers);
  worker._setGithubStartRetryDelaysForTests([0, 0, 0]);
  try {
    return await fn({ worker, calls, logs });
  } finally {
    worker._setGithubStartRetryDelaysForTests(null);
    restore();
  }
}

test('a 503 from GitHub is asked again, and the start goes on', async () => {
  await withWorker([ERR_503, OK], async ({ worker, calls }) => {
    const err = await expectReject(() => worker.ensureWorker(11, ARGS));
    assert.equal(err.sentinel, true, 'the bootstrap went past the privacy check');
    assert.equal(calls.length, 2, 'one retry after the 503');
  });
});

test('three 503s in a row are all asked again', async () => {
  await withWorker([ERR_503, ERR_503, ERR_503, OK], async ({ worker, calls }) => {
    const err = await expectReject(() => worker.ensureWorker(12, ARGS));
    assert.equal(err.sentinel, true);
    assert.equal(calls.length, 4, 'the first ask plus three retries');
  });
});

test('four 503s give up with a plain sentence, never GitHub\'s error page', async () => {
  await withWorker([ERR_503], async ({ worker, calls, logs }) => {
    const err = await expectReject(() => worker.ensureWorker(13, ARGS));
    assert.equal(err.code, 'github_unavailable');
    assert.equal(err.startTransient, true);
    assert.equal(calls.length, 4);
    assert.match(err.message, /GitHub didn't answer when Homeroom tried to start working on owner\/repo/);
    assert.match(err.message, /nothing was changed/i);
    assert.doesNotMatch(err.message, /No server is currently available/);
    assert.ok(logs.some((l) => l.level === 'warn' && /trying again/.test(l.msg)), 'each retry is logged');
    assert.equal(worker.isTransientStartError(err), true);
  });
});

test('a dropped connection and a timeout count as transient', async () => {
  const reset = { ok: false, code: 'github_error', message: 'socket hang up', transient: true };
  await withWorker([reset, OK], async ({ worker, calls }) => {
    const err = await expectReject(() => worker.ensureWorker(14, ARGS));
    assert.equal(err.sentinel, true);
    assert.equal(calls.length, 2);
  });
});

test('a private or missing repository fails at once, as today', async () => {
  for (const answer of [
    { ok: true, private: true },
    { ok: false, code: 'not_found', message: 'Repo owner/repo not accessible.' },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await withWorker([answer], async ({ worker, calls }) => {
      const err = await expectReject(() => worker.ensureWorker(15, ARGS));
      assert.equal(calls.length, 1, 'asked once, no retry');
      assert.match(err.message, /^Cannot bootstrap worker for owner\/repo:/);
      assert.equal(worker.isTransientStartError(err), false);
    });
  }
});

test('GitHub\'s hourly limit keeps its own code and its own message', async () => {
  const limited = {
    ok: false, code: 'rate_limited', message: "GitHub's hourly limit for Homeroom is used up.",
    retryAfterSeconds: 60,
  };
  await withWorker([limited], async ({ worker, calls }) => {
    const err = await expectReject(() => worker.ensureWorker(16, ARGS));
    assert.equal(calls.length, 1, 'no retry into the same wall');
    assert.equal(err.code, 'github_rate_limited');
    assert.equal(err.retryAfterMs, 60_000);
  });
});

test('isTransientGithubError tells GitHub being busy apart from a settled answer', () => {
  const github = require('../src/services/github');
  const cases = [
    [{ status: 503 }, true, 'server error'],
    [{ status: 502 }, true, 'bad gateway'],
    [{ status: 404 }, false, 'not found is settled'],
    [{ status: 403 }, false, 'a refusal is settled'],
    [{ code: 'ECONNRESET' }, true, 'connection reset'],
    [{ code: 'ETIMEDOUT' }, true, 'timeout'],
    [{ code: 'ECONNREFUSED' }, true, 'connection refused'],
    [{ code: 'EAI_AGAIN' }, true, 'name lookup failed'],
    [{ code: 'EPIPE' }, true, 'broken pipe'],
    [{ code: 'UND_ERR_SOCKET' }, true, 'undici socket failure'],
    [{ name: 'AbortError' }, true, 'aborted'],
    [{ name: 'TimeoutError' }, true, 'timed out'],
    [{ code: 'ERR_BAD_REQUEST' }, false, 'anything else'],
    [null, false, 'no error'],
  ];
  for (const [err, expected, why] of cases) {
    assert.equal(github.isTransientGithubError(err), expected, why);
  }
});
