// #851 — the staging-container leak, at its two chokepoints.
//
// WHAT LEAKED, AND WHY IT WAS INVISIBLE
//
// staging.teardownStaging used to call docker.stopAndRemove behind a
// `.catch(() => {})` and then run `UPDATE chat_sessions SET staging_url =
// NULL, staging_container_id = NULL` unconditionally. When the removal failed
// — and stopAndRemove could not even report that it had, because both of its
// inner calls swallowed their own errors too — the container kept running
// while the only record pointing at it was erased. Ten merged sessions in
// production ended up that way; they were findable only by enumerating docker
// and joining back to the DB (that is why services/staging-reap.js starts
// from `docker ps`).
//
// The invariant these tests pin: NOTHING IS FORGOTTEN BEFORE REMOVAL IS
// CONFIRMED. On a leak the staging_* columns stay, the staging database is
// left alone (dropping it would kill a live container's connections), an
// event records what happened, and callers must not null the columns behind
// the chokepoint's back or announce a teardown that didn't occur.
//
// All docker / db-manager / events / pool work is stubbed via require.cache —
// no real docker, DB or socket.
//
// Run with: node --test tests/staging-teardown-leak.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const ids = {
  logger: require.resolve('../src/services/logger'),
  docker: require.resolve('../src/services/docker'),
  caddy: require.resolve('../src/services/caddy'),
  dbManager: require.resolve('../src/services/db-manager'),
  github: require.resolve('../src/services/github'),
  appManifest: require.resolve('../src/services/app-manifest'),
  appSecrets: require.resolve('../src/services/app-secrets'),
  appLlmEnv: require.resolve('../src/services/app-llm-env'),
  appStorageEnv: require.resolve('../src/services/app-storage-env'),
  events: require.resolve('../src/services/events'),
  ws: require.resolve('../src/services/ws'),
  worker: require.resolve('../src/services/worker'),
  workerProgress: require.resolve('../src/services/worker-progress'),
  pendingSecrets: require.resolve('../src/services/pending-secrets'),
  pool: require.resolve('../src/db/pool'),
  staging: require.resolve('../src/services/staging'),
  lifecycle: require.resolve('../src/services/session-lifecycle'),
};

let fx;

function freshFixtures() {
  return {
    // docker
    removed: true,           // what stopAndRemove reports
    stopCalls: [],
    // db-manager
    dropCalls: [],
    // events
    eventRecords: [],
    // pool
    queries: [],
    // ws
    pushes: [],
  };
}

const fakePool = {
  async query(sql, params = []) {
    fx.queries.push({ sql: String(sql), params });
    if (/FROM chat_sessions cs JOIN apps a/i.test(String(sql))) {
      return { rows: [fx.sessionRow].filter(Boolean) };
    }
    if (/UPDATE chat_sessions SET status = 'archived'/i.test(String(sql))) {
      return { rows: [{ id: fx.sessionRow.id }] };
    }
    if (/SELECT cs\.\*, a\.slug as app_slug, a\.repo_url/i.test(String(sql))) {
      return { rows: [fx.sessionRow].filter(Boolean) };
    }
    return { rows: [], rowCount: 1 };
  },
};

// Did any query null the staging columns?
function nullingQueries() {
  return fx.queries.filter((q) => /staging_container_id\s*=\s*NULL/i.test(q.sql));
}

function installStubs() {
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.docker, {
    STAGING_STOP_GRACE_SEC: 2,
    STOP_GRACE_SEC: 5,
    async stopAndRemove(nameOrId, opts) {
      fx.stopCalls.push({ nameOrId, opts });
      return fx.removed
        ? { removed: true, stopMs: 10, rmMs: 5, forceKilled: false, error: null }
        : { removed: false, stopMs: 2000, rmMs: 20, forceKilled: true, error: 'device or resource busy' };
    },
  });
  stub(ids.caddy, { stagingHostname: () => 'h.example', async warmCert() { return { ok: true }; } });
  stub(ids.dbManager, {
    appDbName: (slug) => `app_${slug}`,
    stagingDbName: (slug, user, hash) => `app_${slug}_staging_${user}_${String(hash).slice(0, 6)}`,
    connectionUrl: () => 'postgres://x',
    async dropDatabase(name) { fx.dropCalls.push(name); },
  });
  stub(ids.github, { async getCloneUrl() { return 'https://example/repo.git'; }, describeGithubError: () => ({}) });
  stub(ids.appManifest, { read: () => ({}) });
  stub(ids.appSecrets, {
    async getRawValues() { return {}; },
    platformDefaultsFromEnv: () => ({}),
    mergeForDeploy: () => ({ env: {}, missingRequired: [], missingPrivateStagingDefault: [] }),
  });
  stub(ids.appLlmEnv, { async productionLlmEnv() { return {}; } });
  stub(ids.appStorageEnv, { async productionStorageEnv() { return {}; } });
  stub(ids.events, {
    EVENT_TYPES: {
      STALE_PREVIEWS_REAPED: 'stale_previews_reaped',
      STAGING_TEARDOWN_LEAKED: 'staging_teardown_leaked',
    },
    record(_pool, payload) { fx.eventRecords.push(payload); return Promise.resolve(); },
  });
  stub(ids.ws, {
    pushSessionUpdate(p) { fx.pushes.push(p); },
    broadcastGlobal() {},
    broadcastToAdmins() {},
  });
  stub(ids.worker, {
    isInFlight: () => false,
    workerContainerName: (id) => `usernode-worker-${id}`,
    async destroyWorker() {},
  });
  stub(ids.workerProgress, { clear() {} });
  stub(ids.pendingSecrets, { async discardForSession() {} });
  stub(ids.pool, { getPool: () => fakePool });
}

function setup() {
  fx = freshFixtures();
  fx.sessionRow = {
    id: 4242,
    status: 'merged',
    app_slug: 'tier-lists-abc123',
    repo_url: 'https://github.com/o/r',
    staging_container_id: 'cid-4242',
    staging_url: 'https://x--s4242--abc123.example',
  };
  installStubs();
  delete require.cache[ids.staging];
  return require(ids.staging);
}

const SESSION = () => ({
  id: 4242,
  staging_container_id: 'cid-4242',
  staging_url: 'https://x--s4242--abc123.example',
});
const APP = { slug: 'tier-lists-abc123' };

// ── teardownStaging: the confirmed-removal path (unchanged behaviour) ────

test('teardownStaging: on confirmed removal, drops the DB and nulls the columns', async () => {
  const staging = setup();
  fx.removed = true;

  const result = await staging.teardownStaging(SESSION(), APP);

  assert.deepEqual(result, { removed: true, leaked: false });
  assert.equal(fx.stopCalls.length, 1);
  assert.deepEqual(fx.dropCalls, ['app_tier-lists-abc123_staging_s4242_abc123'],
    'the cloned staging DB is reclaimed');
  assert.equal(nullingQueries().length, 1, 'the row stops vouching for a dead hostname');
  assert.deepEqual(fx.eventRecords, [], 'a clean teardown is not an incident');
});

// ── teardownStaging: the leak path ──────────────────────────────────────

test('teardownStaging: on a LEAK, keeps the columns so the container stays findable', async () => {
  const staging = setup();
  fx.removed = false;

  const result = await staging.teardownStaging(SESSION(), APP);

  assert.deepEqual(result, { removed: false, leaked: true });
  assert.deepEqual(nullingQueries(), [],
    'nulling here is exactly what orphaned ten production containers');
});

test('teardownStaging: on a LEAK, does NOT drop the staging database', async () => {
  const staging = setup();
  fx.removed = false;

  await staging.teardownStaging(SESSION(), APP);

  // dropDatabase runs pg_terminate_backend first, so dropping it under a
  // still-running container leaves that container alive against a dead DB —
  // strictly worse than a preview that still works.
  assert.deepEqual(fx.dropCalls, []);
});

test('teardownStaging: on a LEAK, records a durable event', async () => {
  const staging = setup();
  fx.removed = false;

  await staging.teardownStaging(SESSION(), APP);

  assert.equal(fx.eventRecords.length, 1);
  const rec = fx.eventRecords[0];
  assert.equal(rec.type, 'staging_teardown_leaked');
  assert.equal(rec.metadata.sessionId, 4242);
  assert.equal(rec.metadata.containerId, 'cid-4242');
  assert.ok(rec.metadata.error, 'the reason docker gave is kept for diagnosis');
});

test('teardownStaging: a session with no container is a clean no-op', async () => {
  const staging = setup();
  fx.removed = false;   // irrelevant: nothing to remove

  const result = await staging.teardownStaging(
    { id: 4242, staging_container_id: null, staging_url: null }, APP
  );

  assert.equal(result.leaked, false);
  assert.deepEqual(fx.stopCalls, [], 'no docker call for a row with nothing to stop');
  assert.equal(nullingQueries().length, 1, 'the columns are still normalised');
});

// ── The callers must honour the result ──────────────────────────────────

function loadLifecycle() {
  delete require.cache[ids.lifecycle];
  return require(ids.lifecycle);
}

test('teardownStagingForSession: a leak skips the redundant nulling and the WS push', async () => {
  const staging = setup();
  const lifecycle = loadLifecycle();
  fx.removed = false;

  const result = await lifecycle.teardownStagingForSession({
    pool: fakePool, sessionId: 4242, reason: 'idle-gc',
  });

  assert.deepEqual(result, { torn: false, leaked: true });
  assert.deepEqual(nullingQueries(), [],
    'the GC caller must not null what the chokepoint deliberately kept');
  assert.deepEqual(fx.pushes, [],
    'no staging_torn_down announcement for a teardown that did not happen');
  assert.ok(staging, 'staging module is the stubbed-dependency one under test');
});

test('teardownStagingForSession: a confirmed removal nulls once and announces', async () => {
  setup();
  const lifecycle = loadLifecycle();
  fx.removed = true;

  const result = await lifecycle.teardownStagingForSession({
    pool: fakePool, sessionId: 4242, reason: 'idle-gc',
  });

  assert.equal(result.torn, true);
  assert.equal(nullingQueries().length, 1,
    'exactly one nulling UPDATE — the chokepoint owns it, the caller no longer duplicates it');
  assert.deepEqual(fx.pushes.map((p) => p.action), ['staging_torn_down']);
});

test('archiveSession: still archives when the preview leaks', async () => {
  setup();
  const lifecycle = loadLifecycle();
  fx.removed = false;
  fx.sessionRow.status = 'promoted';

  const result = await lifecycle.archiveSession({
    pool: fakePool, sessionId: 4242, reason: 'manual',
  });

  // Closing the PR and flipping status must not hinge on docker cooperating.
  assert.equal(result.archived, true);
  assert.deepEqual(nullingQueries(), [], 'but the container stays findable for retry');
});

test('archiveSession: nulls the columns exactly once on a clean teardown', async () => {
  setup();
  const lifecycle = loadLifecycle();
  fx.removed = true;
  fx.sessionRow.status = 'promoted';

  const result = await lifecycle.archiveSession({
    pool: fakePool, sessionId: 4242, reason: 'manual',
  });

  assert.equal(result.archived, true);
  assert.equal(nullingQueries().length, 1);
});
