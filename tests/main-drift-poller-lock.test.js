// Cross-process single-flight coverage for main-branch drift redeploys.
// All GitHub, Docker/rebuild, DB, WebSocket and conflict-resolution work is
// stubbed; these tests exercise only the coordination and cleanup contract.

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const ids = {
  logger: require.resolve('../src/services/logger'),
  pool: require.resolve('../src/db/pool'),
  github: require.resolve('../src/services/github'),
  staging: require.resolve('../src/services/staging'),
  ws: require.resolve('../src/services/ws'),
  conflicts: require.resolve('../src/services/conflict-resolver'),
  subject: require.resolve('../src/services/main-drift-poller'),
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function loadPoller(options = {}) {
  const originals = {};
  for (const [key, id] of Object.entries(ids)) originals[key] = require.cache[id];

  const state = {
    remoteCalls: 0,
    rebuildCalls: 0,
    queries: [],
    releases: [],
    lockAcquired: options.lockAcquired ?? true,
    lockError: options.lockError || null,
    currentMainSha: options.currentMainSha ?? 'old-sha',
    rebuildError: options.rebuildError || null,
    unlockError: options.unlockError || null,
  };

  const client = {
    async query(sql, params) {
      state.queries.push({ sql, params });
      if (/pg_try_advisory_lock/.test(sql)) {
        if (state.lockError) throw state.lockError;
        return { rows: [{ acquired: state.lockAcquired }] };
      }
      if (/SELECT main_sha FROM apps/.test(sql)) {
        return { rows: [{ main_sha: state.currentMainSha }] };
      }
      if (/pg_advisory_unlock/.test(sql)) {
        if (state.unlockError) throw state.unlockError;
        return { rows: [{ unlocked: true }] };
      }
      if (/SET container_id/.test(sql)) {
        state.currentMainSha = params[1];
      }
      return { rows: [], rowCount: 1 };
    },
    release(error) { state.releases.push(error); },
  };
  const pool = { async connect() { return client; } };

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => pool });
  stub(ids.github, {
    parseGithubUrl: () => ({ owner: 'acme', repo: 'widget' }),
    getOctokit: async () => ({
      rest: { repos: { getBranch: async () => {
        state.remoteCalls += 1;
        if (options.remoteHead) return options.remoteHead(state);
        return { data: { commit: { sha: 'new-sha' } } };
      } } },
    }),
    isEnabled: () => true,
  });
  stub(ids.staging, {
    rebuildProduction: async () => {
      state.rebuildCalls += 1;
      if (state.rebuildError) throw state.rebuildError;
      return { containerId: 'cid-new', sha: 'new-sha' };
    },
  });
  stub(ids.ws, { broadcastGlobal() {} });
  stub(ids.conflicts, { checkAndResolveConflicts: async () => {} });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  const restore = () => {
    for (const [key, id] of Object.entries(ids)) {
      if (originals[key]) require.cache[id] = originals[key];
      else delete require.cache[id];
    }
  };

  return { subject, pool, state, restore };
}

const app = {
  id: 42,
  slug: 'widget',
  repo_url: 'https://github.com/acme/widget',
  main_sha: 'old-sha',
};

test('the local claim is synchronous, before remote lookup', async () => {
  const head = deferred();
  const fx = loadPoller({ remoteHead: () => head.promise });
  try {
    const first = fx.subject.checkAndRedeployOne({}, fx.pool, app);
    const second = await fx.subject.checkAndRedeployOne({}, fx.pool, app);

    assert.deepEqual(second, { status: 'in_flight', slug: 'widget' });
    assert.equal(fx.state.remoteCalls, 1, 'the overlapping call never reaches GitHub');

    head.resolve({ data: { commit: { sha: 'new-sha' } } });
    assert.equal((await first).status, 'redeployed');
    assert.equal(fx.state.rebuildCalls, 1);
  } finally {
    fx.restore();
  }
});

test('a lock held by another process skips work and leaves a later retry possible', async () => {
  const fx = loadPoller({ lockAcquired: false });
  try {
    const blocked = await fx.subject.checkAndRedeployOne({}, fx.pool, app);
    assert.deepEqual(blocked, { status: 'in_flight', slug: 'widget' });
    assert.equal(fx.state.rebuildCalls, 0);
    assert.equal(fx.state.releases.length, 1, 'the unowned client is returned');

    fx.state.lockAcquired = true;
    const retry = await fx.subject.checkAndRedeployOne({}, fx.pool, app);
    assert.equal(retry.status, 'redeployed');
    assert.equal(fx.state.rebuildCalls, 1);
  } finally {
    fx.restore();
  }
});

test('the durable SHA is reread under the lock before deciding to rebuild', async () => {
  const fx = loadPoller({ currentMainSha: 'new-sha' });
  try {
    const result = await fx.subject.checkAndRedeployOne({}, fx.pool, app);
    assert.deepEqual(result, { status: 'no_drift', slug: 'widget', sha: 'new-sha' });
    assert.equal(fx.state.rebuildCalls, 0, 'a stale caller snapshot cannot duplicate the rebuild');
    assert.ok(fx.state.queries.some((q) => /SELECT main_sha FROM apps/.test(q.sql)));
  } finally {
    fx.restore();
  }
});

test('a failed rebuild releases both lock layers and can be retried', async () => {
  const fx = loadPoller({ rebuildError: new Error('docker build failed') });
  try {
    const failed = await fx.subject.checkAndRedeployOne({}, fx.pool, app);
    assert.equal(failed.status, 'rebuild_failed');
    assert.equal(fx.state.releases.length, 1);
    assert.equal(fx.state.queries.filter((q) => /pg_advisory_unlock/.test(q.sql)).length, 1);

    fx.state.rebuildError = null;
    const retry = await fx.subject.checkAndRedeployOne({}, fx.pool, app);
    assert.equal(retry.status, 'redeployed');
    assert.equal(fx.state.rebuildCalls, 2);
    assert.equal(fx.state.releases.length, 2);
  } finally {
    fx.restore();
  }
});

test('an unlock failure destroys the client instead of recycling it', async () => {
  const unlockError = new Error('connection lost during unlock');
  const fx = loadPoller({ currentMainSha: 'new-sha', unlockError });
  try {
    const result = await fx.subject.checkAndRedeployOne({}, fx.pool, app);
    assert.equal(result.status, 'no_drift', 'cleanup failure does not replace the job result');
    assert.equal(fx.state.releases.length, 1);
    assert.equal(fx.state.releases[0], unlockError,
      'node-postgres receives the error and destroys the possibly locked client');
  } finally {
    fx.restore();
  }
});

test('an uncertain lock-acquisition failure also destroys the client', async () => {
  const lockError = new Error('connection lost after lock request');
  const fx = loadPoller({ lockError });
  try {
    await assert.rejects(
      fx.subject.checkAndRedeployOne({}, fx.pool, app),
      /connection lost after lock request/
    );
    assert.equal(fx.state.releases.length, 1);
    assert.equal(fx.state.releases[0], lockError,
      'a connection with an uncertain lock outcome cannot return to the pool');

    fx.state.lockError = null;
    assert.equal(
      (await fx.subject.checkAndRedeployOne({}, fx.pool, app)).status,
      'redeployed',
      'the local claim is cleared even when lock acquisition throws'
    );
  } finally {
    fx.restore();
  }
});
