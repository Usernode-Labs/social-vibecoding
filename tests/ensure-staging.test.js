// #439 — on-demand staging restore. Two layers:
//
//   1. Unit: the extracted stagingNeedsRebuild (src/services/staging-recovery.js)
//      returns the right verdict for a NULL url, a set url + stopped
//      container, and a set url + running container.
//
//   2. Route: POST /api/sessions/:id/ensure-staging returns `ready` for a
//      live preview, `rebuilding` for a torn-down one (invoking the rebuild
//      helper exactly once even under concurrent clicks), broadcasts a
//      `staging_failed` event when the rebuild is a no-op (branch not ahead
//      of main → 'skipped'), short-circuits to `unavailable`/demo under
//      USERNODE_ENV=staging, and 403s a non-owner on a non-vote-backed
//      session.
//
// Services are stubbed via require.cache; no real Postgres / Docker / GitHub.
//
// Run with: node --test tests/ensure-staging.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

function stubModule(id, exports) {
  const original = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: original ? original.paths : [] };
  return original;
}

// ── 1. Unit: stagingNeedsRebuild against a stubbed docker ────────────────
//
// #851 added a THIRD failure shape on top of the two liveness ones: a running
// container whose env fingerprint label was stamped by an older platform
// build. That is the shape the whole change exists to catch — a pre-#848
// preview boots fine and then can't recognise the signed-in user, so a
// liveness-only check answered "ready" and opened the app's login screen.
//
// The verdict drives an automatic teardown/rebuild sweeper, so the negative
// cases matter as much as the positive ones: an unreadable docker must NOT
// read as "stale" (it would sweep the fleet on a daemon hiccup), and a caller
// that passes no config must keep the old liveness-only behaviour.

const stagingEnvModule = require('../src/services/staging-env');

const TEST_PEM = '-----BEGIN PUBLIC KEY-----\nTESTKEY\n-----END PUBLIC KEY-----';
const TEST_CONFIG = { iframeJwtPublicKey: TEST_PEM };

// The label value a preview built by THIS platform would carry.
function currentFingerprint() {
  stagingEnvModule._resetExpected();
  const fp = stagingEnvModule.expectedStagingFingerprint(TEST_CONFIG);
  stagingEnvModule._resetExpected();
  return fp;
}

function loadRecovery(inspectContainer) {
  const dockerPath = require.resolve('../src/services/docker');
  const recPath = require.resolve('../src/services/staging-recovery');
  const original = stubModule(dockerPath, { inspectContainer });
  delete require.cache[recPath];
  const subject = require('../src/services/staging-recovery');
  const restore = () => {
    if (original) require.cache[dockerPath] = original; else delete require.cache[dockerPath];
    delete require.cache[recPath];
    stagingEnvModule._resetExpected();
  };
  return { subject, restore };
}

// Sugar: a container in `status` carrying `labels`.
function inspecting(status, labels = {}) {
  return async () => ({ status, labels });
}

const LIVE_SESSION = { id: 1, staging_url: 'https://x.example', staging_container_id: 'c1' };

test('stagingNeedsRebuild: NULL staging_url → true (no docker call)', async () => {
  let called = false;
  const { subject, restore } = loadRecovery(async () => { called = true; return { status: 'running', labels: {} }; });
  try {
    assert.equal(await subject.stagingNeedsRebuild({ staging_url: null, staging_container_id: 'c1' }), true);
    assert.equal(called, false, 'short-circuits before hitting docker');
  } finally { restore(); }
});

test('stagingNeedsRebuild: url set but container stopped → true', async () => {
  const { subject, restore } = loadRecovery(inspecting('exited'));
  try {
    assert.equal(await subject.stagingNeedsRebuild(LIVE_SESSION, { config: TEST_CONFIG }), true);
  } finally { restore(); }
});

test('stagingNeedsRebuild: url set + container running + fingerprint matches → false', async () => {
  const { subject, restore } = loadRecovery(
    inspecting('running', { [stagingEnvModule.LABEL_ENV_FP]: currentFingerprint() })
  );
  try {
    assert.equal(await subject.stagingNeedsRebuild(LIVE_SESSION, { config: TEST_CONFIG }), false);
  } finally { restore(); }
});

test('stagingNeedsRebuild: running but fingerprint MISMATCHED → true (stale env)', async () => {
  const { subject, restore } = loadRecovery(
    inspecting('running', { [stagingEnvModule.LABEL_ENV_FP]: 'deadbeefdeadbeef' })
  );
  try {
    assert.equal(await subject.stagingNeedsRebuild(LIVE_SESSION, { config: TEST_CONFIG }), true);
  } finally { restore(); }
});

test('stagingNeedsRebuild: running with NO fingerprint label → true (built pre-#851)', async () => {
  const { subject, restore } = loadRecovery(inspecting('running', {}));
  try {
    assert.equal(await subject.stagingNeedsRebuild(LIVE_SESSION, { config: TEST_CONFIG }), true);
  } finally { restore(); }
});

test('stagingNeedsRebuild: container GONE (not_found) → true', async () => {
  // Shape 2, and the case the fingerprint work could most easily have broken:
  // "gone" and "cannot inspect" arrive through the same call, and collapsing
  // them would silently stop rebuilding previews lost to a host restart or a
  // manual cleanup.
  const { subject, restore } = loadRecovery(inspecting('not_found'));
  try {
    assert.equal(await subject.stagingNeedsRebuild(LIVE_SESSION, { config: TEST_CONFIG }), true);
    // ...and with no config either: this is liveness, not staleness.
    assert.equal(await subject.stagingNeedsRebuild(LIVE_SESSION), true);
  } finally { restore(); }
});

test('stagingNeedsRebuild: inspect FAILED (null) → false, leave it strictly alone', async () => {
  // A docker hiccup must never be read as staleness: the sweeper acts on this
  // verdict, so mistaking "can't see" for "out of date" would tear down every
  // preview on the host.
  const { subject, restore } = loadRecovery(async () => null);
  try {
    assert.equal(await subject.stagingNeedsRebuild(LIVE_SESSION, { config: TEST_CONFIG }), false);
  } finally { restore(); }
});

test('stagingNeedsRebuild: no config → liveness-only verdict (unchanged behaviour)', async () => {
  const stale = loadRecovery(inspecting('running', { [stagingEnvModule.LABEL_ENV_FP]: 'notthecurrentone' }));
  try {
    assert.equal(await stale.subject.stagingNeedsRebuild(LIVE_SESSION), false,
      'without config the fingerprint is not consulted');
  } finally { stale.restore(); }

  const dead = loadRecovery(inspecting('exited'));
  try {
    assert.equal(await dead.subject.stagingNeedsRebuild(LIVE_SESSION), true,
      'liveness still decides');
  } finally { dead.restore(); }
});

// ── 2. Route: POST /api/sessions/:id/ensure-staging ──────────────────────

// Mock pool answering the single ensure-staging SELECT with one session row.
function makePool(sessionRow) {
  return {
    query: async (sql) => {
      if (/FROM chat_sessions cs JOIN apps a/i.test(String(sql))) {
        return { rows: sessionRow ? [sessionRow] : [] };
      }
      return { rows: [] };
    },
  };
}

// Load routes/sessions.js with pool, staging-recovery, ws, and the collab
// guard stubbed so we exercise the ensure-staging handler in isolation. The
// pool MUST be stubbed before sessions.js is required (its `getPool` binding
// is captured at load). The in-flight dedup Set is module-level, so a fresh
// require per load resets it.
function loadSessions({ pool, needsRebuild, rebuild }) {
  const paths = {
    pool: require.resolve('../src/db/pool'),
    ws: require.resolve('../src/services/ws'),
    appAccess: require.resolve('../src/services/app-access'),
    stagingRecovery: require.resolve('../src/services/staging-recovery'),
    sessions: require.resolve('../src/routes/sessions'),
  };

  const broadcasts = [];
  let rebuildCalls = 0;

  const originals = [
    [paths.pool, stubModule(paths.pool, { getPool: () => pool })],
    [paths.ws, stubModule(paths.ws, {
      broadcastGlobal: (m) => broadcasts.push(m),
      pushSessionUpdate: () => {},
      pushNotificationToUser: () => 0,
    })],
    [paths.appAccess, stubModule(paths.appAccess, {
      ...require('../src/services/app-access'),
      sessionCollabGuard: () => (_req, _res, next) => next(),
    })],
    [paths.stagingRecovery, stubModule(paths.stagingRecovery, {
      stagingNeedsRebuild: async () => needsRebuild,
      rebuildSessionStaging: async (args) => { rebuildCalls += 1; return rebuild(args); },
    })],
  ];

  delete require.cache[paths.sessions];
  const subject = require('../src/routes/sessions');

  const restore = () => {
    for (const [id, original] of originals) {
      if (original) require.cache[id] = original; else delete require.cache[id];
    }
    delete require.cache[paths.sessions];
  };
  return { subject, broadcasts, getRebuildCalls: () => rebuildCalls, restore };
}

async function startServer(loaded, user = { id: 1, username: 'alice' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(loaded.subject.sessionRoutes({ jwtSecret: 'test' }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

const OWNED_ACTIVE = {
  id: 42, user_id: 1, status: 'active', branch_name: 'feat/x',
  app_slug: 'my-app', app_name: 'My App', repo_url: 'https://github.com/owner/repo',
  staging_url: 'https://stg.example', staging_container_id: 'c1',
};

async function waitFor(pred, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (pred()) return true; await new Promise((r) => setTimeout(r, 15)); }
  return pred();
}

test('ensure-staging returns {ready,url} when the preview is live', async () => {
  const loaded = loadSessions({ pool: makePool(OWNED_ACTIVE), needsRebuild: false, rebuild: async () => 'built' });
  const srv = await startServer(loaded);
  try {
    const res = await fetch(`${srv.baseUrl}/api/sessions/42/ensure-staging`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { status: 'ready', url: 'https://stg.example' });
    assert.equal(loaded.getRebuildCalls(), 0, 'no rebuild when already live');
  } finally { await srv.close(); loaded.restore(); }
});

test('ensure-staging kicks off ONE rebuild under concurrent clicks → {rebuilding}', async () => {
  let resolveRebuild;
  const loaded = loadSessions({
    pool: makePool(OWNED_ACTIVE),
    needsRebuild: true,
    rebuild: () => new Promise((r) => { resolveRebuild = () => r('built'); }),
  });
  const srv = await startServer(loaded);
  try {
    const [a, b] = await Promise.all([
      fetch(`${srv.baseUrl}/api/sessions/42/ensure-staging`, { method: 'POST' }).then((r) => r.json()),
      fetch(`${srv.baseUrl}/api/sessions/42/ensure-staging`, { method: 'POST' }).then((r) => r.json()),
    ]);
    assert.equal(a.status, 'rebuilding');
    assert.equal(b.status, 'rebuilding');
    // Both requests saw "needs rebuild" but the in-flight guard must collapse
    // them to a single rebuild invocation.
    await waitFor(() => loaded.getRebuildCalls() >= 1);
    assert.equal(loaded.getRebuildCalls(), 1, 'exactly one rebuild despite two clicks');
    resolveRebuild();
  } finally { await srv.close(); loaded.restore(); }
});

test('ensure-staging broadcasts staging_failed when the rebuild is a no-op (ahead_by===0 → skipped)', async () => {
  const loaded = loadSessions({ pool: makePool(OWNED_ACTIVE), needsRebuild: true, rebuild: async () => 'skipped' });
  const srv = await startServer(loaded);
  try {
    const res = await fetch(`${srv.baseUrl}/api/sessions/42/ensure-staging`, { method: 'POST' });
    assert.equal((await res.json()).status, 'rebuilding');
    await waitFor(() => loaded.broadcasts.some((m) => m.event === 'staging_failed'));
    const ev = loaded.broadcasts.find((m) => m.event === 'staging_failed');
    assert.ok(ev, 'staging_failed broadcast emitted for a no-op rebuild');
    assert.equal(ev.errorName, 'NothingToPreview');
    assert.equal(ev.sessionId, 42);
  } finally { await srv.close(); loaded.restore(); }
});

test('ensure-staging short-circuits to {unavailable,demo} under USERNODE_ENV=staging', async () => {
  const prev = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  const loaded = loadSessions({ pool: makePool(OWNED_ACTIVE), needsRebuild: true, rebuild: async () => 'built' });
  const srv = await startServer(loaded);
  try {
    const res = await fetch(`${srv.baseUrl}/api/sessions/42/ensure-staging`, { method: 'POST' });
    const body = await res.json();
    assert.deepEqual(body, { status: 'unavailable', reason: 'demo' });
    assert.equal(loaded.getRebuildCalls(), 0, 'no docker rebuild attempted in staging');
  } finally {
    await srv.close(); loaded.restore();
    if (prev === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = prev;
  }
});

test('ensure-staging 403s a non-owner on a non-vote-backed (active) session', async () => {
  const loaded = loadSessions({ pool: makePool(OWNED_ACTIVE), needsRebuild: true, rebuild: async () => 'built' });
  // Request user id 2, session owned by user 1, status active (not promoted).
  const srv = await startServer(loaded, { id: 2, username: 'bob' });
  try {
    const res = await fetch(`${srv.baseUrl}/api/sessions/42/ensure-staging`, { method: 'POST' });
    assert.equal(res.status, 403);
    assert.equal(loaded.getRebuildCalls(), 0);
  } finally { await srv.close(); loaded.restore(); }
});

test('ensure-staging allows a non-owner on a promoted (vote-backed) session', async () => {
  const promoted = { ...OWNED_ACTIVE, status: 'promoted', staging_url: null, staging_container_id: null };
  const loaded = loadSessions({ pool: makePool(promoted), needsRebuild: true, rebuild: async () => 'built' });
  const srv = await startServer(loaded, { id: 2, username: 'bob' });
  try {
    const res = await fetch(`${srv.baseUrl}/api/sessions/42/ensure-staging`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'rebuilding');
  } finally { await srv.close(); loaded.restore(); }
});
