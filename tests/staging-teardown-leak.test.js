// #851 — the staging-container leak, and where its invariant lives now.
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
// The invariant: NOTHING IS FORGOTTEN BEFORE REMOVAL IS CONFIRMED. The
// removal itself is now the preview machine's retirement, and so is the
// invariant: src/workflow/preview/machine.ts `toRetiring` keeps every
// attempt it must remove in the instance's `exit`, and `retired` lets go of
// them only when src/workflow/preview/services.ts WORK.retire reports
// `closed` (it closes only when a look after the deletes finds nothing left);
// otherwise the instance stays 'retiring' for an admin to retry. The row's
// staging_* columns are unpublished by the machine's own transition, not by
// any caller (tests/workflow-preview-*.test.js pin the machine).
//
// What is left here is the chokepoint's side of it: teardownStaging hands
// the preview to services/preview-workflow.retire and reports a refusal as a
// leak; and its callers (session-lifecycle's teardownStagingForSession and
// archiveSession) never null the columns themselves and do not announce a
// teardown that was refused.
//
// All docker / db-manager / events / pool / preview-workflow work is stubbed
// via require.cache — no real docker, DB, socket or workflow runtime.
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
  kubernetes: require.resolve('../src/services/kubernetes'),
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
  previewWorkflow: require.resolve('../src/services/preview-workflow'),
  staging: require.resolve('../src/services/staging'),
  lifecycle: require.resolve('../src/services/session-lifecycle'),
};

let fx;

function freshFixtures() {
  return {
    // preview-workflow: what the machine answers a retire with
    retireOut: { taken: true, reason: null },
    retireThrows: null,
    held: false,
    retires: [],
    // docker / kubernetes / db-manager: nothing here may remove anything
    stopCalls: [],
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
      if (fx.sessionRow) fx.sessionRow.status = 'archived';
      return { rows: [{ id: fx.sessionRow.id }] };
    }
    if (/SELECT cs\.\*, a\.slug as app_slug, a\.repo_url/i.test(String(sql))) {
      return { rows: [fx.sessionRow].filter(Boolean) };
    }
    // teardownStaging re-reads the row to decide whether the retirement is
    // for good.
    if (/SELECT app_id, status FROM chat_sessions WHERE id = \$1/i.test(String(sql))) {
      return { rows: fx.sessionRow ? [{ app_id: fx.sessionRow.app_id, status: fx.sessionRow.status }] : [] };
    }
    return { rows: [], rowCount: 1 };
  },
};

// Did any query null the staging columns?
function nullingQueries() {
  return fx.queries.filter((q) => /staging_(container_id|runtime_name|url)\s*=\s*NULL/i.test(q.sql));
}

function installStubs() {
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.kubernetes, {
    async deleteApplication(_config, name) { fx.stopCalls.push({ nameOrId: name, runtimeKind: 'kubernetes' }); },
  });
  stub(ids.docker, {
    STAGING_STOP_GRACE_SEC: 2,
    STOP_GRACE_SEC: 5,
    async stopAndRemove(nameOrId, opts) {
      fx.stopCalls.push({ nameOrId, opts });
      return { removed: true, stopMs: 10, rmMs: 5, forceKilled: false, error: null };
    },
  });
  stub(ids.caddy, { stagingHostname: () => 'h.example', async warmCert() { return { ok: true }; } });
  stub(ids.dbManager, {
    appDbName: (slug) => `app_${slug}`,
    stagingDbName: (slug, user, hash) => `app_${slug}_staging_${user}_${String(hash).slice(0, 6)}`,
    connectionUrl: () => 'postgres://x',
    async dropDatabase(name) { fx.dropCalls.push(name); },
  });
  stub(ids.github, {
    async getCloneUrl() { return 'https://example/repo.git'; },
    describeGithubError: () => ({}),
    async closePR() {},
  });
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
  stub(ids.previewWorkflow, {
    async held() { return fx.held; },
    async retire(args) {
      fx.retires.push(args);
      if (fx.retireThrows) throw fx.retireThrows;
      return fx.retireOut;
    },
  });
}

function setup() {
  fx = freshFixtures();
  fx.sessionRow = {
    id: 4242,
    app_id: 10,
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
  app_id: 10,
  staging_container_id: 'cid-4242',
  staging_url: 'https://x--s4242--abc123.example',
});
const APP = { id: 10, slug: 'tier-lists-abc123' };

// Nothing is removed, dropped or nulled inline: the machine does all three.
function assertNothingInline() {
  assert.deepEqual(fx.stopCalls, [], 'no runtime is removed outside the machine');
  assert.deepEqual(fx.dropCalls, [], 'no database is dropped outside the machine');
  assert.deepEqual(nullingQueries(), [], 'the machine unpublishes the columns, nobody else');
}

// ── teardownStaging: the hand-off to the machine ────────────────────────

test('teardownStaging: a merged session is retired for good, and the hand-off is all it does', async () => {
  const staging = setup();

  const result = await staging.teardownStaging(SESSION(), APP);

  assert.deepEqual(result, { removed: false, handedOff: true });
  assert.deepEqual(fx.retires, [{ session: { id: 4242, app_id: 10 }, reason: 'merged', terminal: true }]);
  assertNothingInline();
});

test('teardownStaging: a session still open is retired as idle, not for good', async () => {
  const staging = setup();
  fx.sessionRow.status = 'paused';

  await staging.teardownStaging(SESSION(), APP);

  assert.deepEqual(fx.retires, [{ session: { id: 4242, app_id: 10 }, reason: 'idle', terminal: false }]);
});

test('teardownStaging: a row that is gone is retired for good, under the app it named', async () => {
  const staging = setup();
  fx.sessionRow = null;

  const result = await staging.teardownStaging({ id: 4242, app_id: 10 }, APP);

  assert.deepEqual(result, { removed: false, handedOff: true });
  assert.deepEqual(fx.retires, [{ session: { id: 4242, app_id: 10 }, reason: 'deleted', terminal: true }]);
});

test('teardownStaging: a refusal is reported as a leak, and nothing is forgotten', async () => {
  const staging = setup();
  fx.retireOut = { taken: false, reason: 'worked_on' };

  const result = await staging.teardownStaging(SESSION(), APP);

  assert.deepEqual(result, { removed: false, leaked: true, busy: true, refused: 'worked_on' });
  assertNothingInline();
});

// ── The callers must honour the result ──────────────────────────────────

function loadLifecycle() {
  delete require.cache[ids.lifecycle];
  return require(ids.lifecycle);
}

test('teardownStagingForSession: a refused retirement skips the nulling and the WS push', async () => {
  setup();
  const lifecycle = loadLifecycle();
  fx.sessionRow.status = 'paused';
  fx.retireOut = { taken: false, reason: 'worked_on' };

  const result = await lifecycle.teardownStagingForSession({
    pool: fakePool, sessionId: 4242, reason: 'idle-gc',
  });

  assert.deepEqual(result, { torn: false, leaked: true });
  assert.equal(fx.retires.length, 1);
  assertNothingInline();
  assert.deepEqual(fx.pushes, [],
    'no staging_torn_down announcement for a teardown that did not happen');
});

test('teardownStagingForSession: a retirement that throws is a leak too', async () => {
  setup();
  const lifecycle = loadLifecycle();
  fx.sessionRow.status = 'paused';
  fx.retireThrows = new Error('workflow runtime unavailable');

  const result = await lifecycle.teardownStagingForSession({
    pool: fakePool, sessionId: 4242, reason: 'idle-gc',
  });

  assert.deepEqual(result, { torn: false, leaked: true });
  assertNothingInline();
  assert.deepEqual(fx.pushes, []);
});

test('teardownStagingForSession: a taken retirement announces once and nulls nothing itself', async () => {
  setup();
  const lifecycle = loadLifecycle();
  fx.sessionRow.status = 'paused';

  const result = await lifecycle.teardownStagingForSession({
    pool: fakePool, sessionId: 4242, reason: 'idle-gc',
  });

  assert.equal(result.torn, true);
  assert.deepEqual(fx.retires.map((r) => r.terminal), [false]);
  assertNothingInline();
  assert.deepEqual(fx.pushes.map((p) => p.action), ['staging_torn_down']);
});

test('teardownStagingForSession: a row naming no preview asks for nothing', async () => {
  setup();
  const lifecycle = loadLifecycle();
  Object.assign(fx.sessionRow, { staging_container_id: null, staging_url: null });

  const result = await lifecycle.teardownStagingForSession({ pool: fakePool, sessionId: 4242 });

  assert.deepEqual(result, { torn: false });
  assert.deepEqual(fx.retires, []);
  assert.deepEqual(fx.pushes, []);
});

test('archiveSession: still archives when the retirement is refused, and nulls nothing', async () => {
  setup();
  const lifecycle = loadLifecycle();
  fx.sessionRow.status = 'promoted';
  fx.retireOut = { taken: false, reason: 'under_review' };

  const result = await lifecycle.archiveSession({
    pool: fakePool, sessionId: 4242, reason: 'manual',
  });

  // Closing the PR and flipping status must not hinge on the cluster.
  assert.equal(result.archived, true);
  assert.equal(fx.retires.length, 1);
  assertNothingInline();
});

test('archiveSession: retires the archived preview for good, nulling nothing itself', async () => {
  setup();
  const lifecycle = loadLifecycle();
  fx.sessionRow.status = 'promoted';

  const result = await lifecycle.archiveSession({
    pool: fakePool, sessionId: 4242, reason: 'manual',
  });

  assert.equal(result.archived, true);
  assert.deepEqual(fx.retires, [{ session: { id: 4242, app_id: 10 }, reason: 'archived', terminal: true }]);
  assertNothingInline();
});

test('archiveSession: a preview the machine still builds is retired though no column names it yet', async () => {
  setup();
  const lifecycle = loadLifecycle();
  Object.assign(fx.sessionRow, { status: 'active', staging_container_id: null, staging_url: null });
  fx.held = true;

  assert.equal((await lifecycle.archiveSession({ pool: fakePool, sessionId: 4242 })).archived, true);
  assert.deepEqual(fx.retires.map((r) => [r.reason, r.terminal]), [['archived', true]]);
});

test('archiveSession: no preview and nothing held asks the machine for nothing', async () => {
  setup();
  const lifecycle = loadLifecycle();
  Object.assign(fx.sessionRow, { status: 'active', staging_container_id: null, staging_url: null });

  assert.equal((await lifecycle.archiveSession({ pool: fakePool, sessionId: 4242 })).archived, true);
  assert.deepEqual(fx.retires, []);
});
