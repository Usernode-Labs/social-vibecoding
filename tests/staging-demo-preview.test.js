// #6817 — a staging demo change's Try it opens a sample preview.
//
// On a staging copy, every preview route used to answer "not available
// (demo)", so a change to the preview could be neither tried nor shot. With
// the demo data (`?demo=1`) a demo change now opens the same preview a real
// one does, showing a fixed, obviously fake Sample app served by the
// staging host (services/staging-demo-preview.js). Real changes keep
// answering as they did, and production is untouched.
//
// Services are stubbed via require.cache; no real Postgres / Docker / GitHub.
//
// Run with: node --test tests/staging-demo-preview.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

function stubModule(id, exports) {
  const original = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: original ? original.paths : [] };
  return original;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Load routes/sessions.js with its collaborators stubbed, counting every DB
// query so "a demo answer never looks the change up" is asserted, not assumed.
function loadSessions({ pool, needsRebuild = true } = {}) {
  const paths = {
    pool: require.resolve('../src/db/pool'),
    ws: require.resolve('../src/services/ws'),
    appAccess: require.resolve('../src/services/app-access'),
    stagingRecovery: require.resolve('../src/services/staging-recovery'),
    docker: require.resolve('../src/services/docker'),
    runtime: require.resolve('../src/services/application-runtime'),
    staging: require.resolve('../src/services/staging'),
    sessions: require.resolve('../src/routes/sessions'),
  };
  const originals = [
    [paths.pool, stubModule(paths.pool, { getPool: () => pool })],
    [paths.ws, stubModule(paths.ws, {
      broadcastGlobal: () => {}, pushSessionUpdate: () => {}, pushNotificationToUser: () => 0,
    })],
    [paths.appAccess, stubModule(paths.appAccess, {
      ...require('../src/services/app-access'),
      sessionCollabGuard: () => (_req, _res, next) => next(),
    })],
    [paths.docker, stubModule(paths.docker, { ...require('../src/services/docker'), probeHealthOnce: async () => true })],
    [paths.staging, stubModule(paths.staging, {
      ...require('../src/services/staging'),
      verifyStagingEdge: async () => ({ ok: true }),
    })],
    [paths.stagingRecovery, stubModule(paths.stagingRecovery, {
      stagingNeedsRebuild: async () => needsRebuild,
      recheckHeadSha: (session) => session.checks_commit_sha || null,
      rebuildSessionStaging: async () => 'built',
    })],
  ];
  const originalRuntime = require.cache[paths.runtime];
  delete require.cache[paths.runtime];
  delete require.cache[paths.sessions];
  const subject = require('../src/routes/sessions');
  const restore = () => {
    if (originalRuntime) require.cache[paths.runtime] = originalRuntime;
    else delete require.cache[paths.runtime];
    for (const [id, original] of originals) {
      if (original) require.cache[id] = original; else delete require.cache[id];
    }
    delete require.cache[paths.sessions];
  };
  return { subject, restore };
}

function makePool(sessionRow) {
  const queries = [];
  return {
    queries,
    query: async (sql) => {
      queries.push(String(sql));
      if (/FROM chat_sessions cs JOIN apps a/i.test(String(sql))) return { rows: sessionRow ? [sessionRow] : [] };
      return { rows: [] };
    },
  };
}

async function startServer(subject) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1, username: 'alice' }; next(); });
  app.use(subject.sessionRoutes({ jwtSecret: 'test' }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

function withEnv(value, fn, ...args) {
  const prev = process.env.USERNODE_ENV;
  if (value === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = value;
  return Promise.resolve()
    .then(() => fn(...args))
    .finally(() => { if (prev === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = prev; });
}

const DEMO = '/?demo=1';
const SAMPLE_PATH = '/api/staging-demo/sample-app';

test('staging with the demo data: ensure-staging answers ready for the demo change, without reading the change', () => withEnv('staging', async () => {
  const pool = makePool(null);
  const loaded = loadSessions({ pool });
  const srv = await startServer(loaded.subject);
  try {
    const res = await fetch(`${srv.baseUrl}/api/sessions/9000013/ensure-staging${DEMO}`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ready');
    assert.equal(body.verified, true);
    assert.equal(body.checksRunning, false);
    assert.equal(body.url, SAMPLE_PATH);
    assert.equal(body.startPath, SAMPLE_PATH, 'the frame opens the sample page, never the host root');
    assert.equal(body.prNumber, 900113);
    assert.match(body.title, /Near-majority/, 'the change\'s own title rides the answer');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(pool.queries, [], 'a demo answer never looks the change up');
  } finally { await srv.close(); loaded.restore(); }
}));

test('staging with the demo data: preview-status answers the same for a read-only reviewer', () => withEnv('staging', async () => {
  const pool = makePool(null);
  const loaded = loadSessions({ pool });
  const srv = await startServer(loaded.subject);
  try {
    const res = await fetch(`${srv.baseUrl}/api/sessions/9000013/preview-status${DEMO}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ready');
    assert.equal(body.url, SAMPLE_PATH);
    assert.equal(body.prNumber, 900113);
    assert.deepEqual(pool.queries, [], 'no DB lookup');
  } finally { await srv.close(); loaded.restore(); }
}));

test('staging with the demo data: a real change still answers unavailable/demo', () => withEnv('staging', async () => {
  const session = {
    id: 42, user_id: 1, status: 'promoted', app_slug: 'my-app', app_name: 'My App',
    staging_url: 'https://stg.example', staging_commit_sha: 'head',
  };
  const loaded = loadSessions({ pool: makePool(session) });
  const srv = await startServer(loaded.subject);
  try {
    const get = await fetch(`${srv.baseUrl}/api/sessions/42/preview-status${DEMO}`);
    assert.deepEqual(await get.json(), { status: 'unavailable', reason: 'demo' });
    const post = await fetch(`${srv.baseUrl}/api/sessions/42/ensure-staging${DEMO}`, { method: 'POST' });
    assert.deepEqual(await post.json(), { status: 'unavailable', reason: 'demo' });
  } finally { await srv.close(); loaded.restore(); }
}));

test('staging without the demo data: a demo id is not found, as today', () => withEnv('staging', async () => {
  const pool = makePool(null);
  const loaded = loadSessions({ pool });
  const srv = await startServer(loaded.subject);
  try {
    const res = await fetch(`${srv.baseUrl}/api/sessions/9000013/ensure-staging`, { method: 'POST' });
    assert.equal(res.status, 404);
  } finally { await srv.close(); loaded.restore(); }
}));

test('production with the demo data: the branch is inert', () => withEnv(undefined, async () => {
  const pool = makePool(null);
  const loaded = loadSessions({ pool });
  const srv = await startServer(loaded.subject);
  try {
    const res = await fetch(`${srv.baseUrl}/api/sessions/9000013/preview-status${DEMO}`);
    assert.equal(res.status, 404);
  } finally { await srv.close(); loaded.restore(); }
}));

test('the sample page is served on staging only, and is obviously a sample', () => withEnv('staging', async () => {
  const loaded = loadSessions({ pool: makePool(null) });
  const srv = await startServer(loaded.subject);
  try {
    const res = await fetch(`${srv.baseUrl}${SAMPLE_PATH}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'self'/);
    const html = await res.text();
    assert.match(html, /Sample app/);
    assert.match(html, /Nothing here is real/);
    assert.equal((html.match(/<button/g) || []).length, 1, 'one button');
    assert.equal((html.match(/<button/g) || []).length, (html.match(/<\/button>/g) || []).length, 'the button is closed');
    assert.doesNotMatch(html, /<script/i, 'no script');
    assert.doesNotMatch(html, /https?:\/\//i, 'no external resource');
  } finally { await srv.close(); loaded.restore(); }
}));

test('the sample page is not found anywhere else', () => withEnv(undefined, async () => {
  const loaded = loadSessions({ pool: makePool(null) });
  const srv = await startServer(loaded.subject);
  try {
    const res = await fetch(`${srv.baseUrl}${SAMPLE_PATH}`);
    assert.equal(res.status, 404);
  } finally { await srv.close(); loaded.restore(); }
}));

test('the demo change up for a vote carries verified before & after shots', () => {
  const votes = require('../src/routes/votes');
  const mock = votes.stagingMockProposalFor(9000013, { id: 1, username: 'alice' });
  assert.ok(mock, 'the fixture is there');
  assert.equal(mock.yes_count, 5, 'the tally the header shows');
  assert.equal(mock.votes_required, 3);
  assert.equal(mock.shots.state, 'verified');
  assert.equal(mock.shots.claims.length, 1);
  assert.deepEqual(mock.shots.artifacts.map((artifact) => artifact.side).sort(), ['base', 'head']);
  for (const artifact of mock.shots.artifacts) {
    // The client draws a shot only at this address (app-view.js shotsUrl).
    assert.match(artifact.url, /^\/api\/apps\/[^/]+\/proposals\/9000013\/shots\/[0-9a-f]{32}$/);
  }
});

test('the placeholder pictures are real PNGs, one grey and one blue', () => {
  const demo = require('../src/services/staging-demo-preview');
  const before = demo.shotPng('base');
  const after = demo.shotPng('head');
  assert.deepEqual(before.subarray(0, 8), PNG_SIGNATURE);
  assert.deepEqual(after.subarray(0, 8), PNG_SIGNATURE);
  assert.notDeepEqual(before, after, 'the two sides differ');
  assert.equal(demo.shotPng('base'), before, 'cached after the first call');
});

test('staging: the demo artifact route answers the picture; any other id goes the existing way', (t) => withEnv('staging', async () => {
  const routePath = require.resolve('../src/routes/shots');
  delete require.cache[routePath];
  const subject = require('../src/routes/shots');
  const app = express();
  app.use((req, _res, next) => { req.user = { id: 1 }; next(); });
  // No shots store declared: every id that is not the demo's is not found
  // before anything is read, which is enough to show it took the usual path.
  app.use(subject.shotsRoutes({}));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.close();
    delete require.cache[routePath];
  });

  const demo = require('../src/services/staging-demo-preview');
  for (const [side, id] of [['base', demo.ARTIFACT_IDS.base], ['head', demo.ARTIFACT_IDS.head]]) {
    const res = await fetch(`${base}/api/apps/demo/proposals/9000013/shots/${id}`);
    assert.equal(res.status, 200, side);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), demo.shotPng(side));
  }
  // An unknown artifact id is not the demo's: it falls through to the
  // stored-artifact path, which finds nothing here.
  const other = await fetch(`${base}/api/apps/demo/proposals/9000013/shots/${'1'.repeat(32)}`);
  assert.equal(other.status, 404);
}, t));
