// Route tests for app file storage (#752, src/routes/app-files.js):
// the public serving route and the shell-facing upload/delete/usage
// routes. Contracts pinned here:
//
//  - serving: 32-hex id gate (malformed ids never touch the DB), public
//    files stream with the year-long immutable header, private files
//    require a valid ?token= user JWT (404 without — non-enumerable),
//    object-missing-for-row degrades to 404, unconfigured store → 503;
//  - shell upload: view-gated (404 when getAppForUser denies), staging=1
//    stamps the row, quota/validation errors surface their structured
//    codes, MinIO-down → 503 storage_unavailable;
//  - shell delete: uploader-only.
//
// Harness shape follows tests/chat-attachments-route.test.js: override
// getPool + stub app-access BEFORE requiring the route, mount on a real
// express app, fake object store injected via the route factory's deps.
//
// Run with: node --test tests/app-files-route.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
require('./platform-keys').setPlatformKeys();
const platformJwt = require('../src/services/platform-jwt');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
poolMod.getPool = () => ({
  query: (sql, params) => poolQueryHandler(sql, params),
});

// Controllable app-access gate, stubbed BEFORE requiring the route.
const appAccessId = require.resolve('../src/services/app-access');
let accessGrants = { view: { id: 7 } };
require.cache[appAccessId] = {
  id: appAccessId,
  filename: appAccessId,
  loaded: true,
  paths: [],
  exports: {
    ACCESS_COLUMNS: 'id, slug',
    getAppForUser: async (_pool, _slug, _user, level) => accessGrants[level] || null,
  },
};

const { appFileServeRoutes, appFileShellRoutes } = require('../src/routes/app-files');
const express = require('express');

const GOOD_ID = 'a'.repeat(32);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 1),
]);

function fakeStore(overrides = {}) {
  return {
    async putFile() {},
    async getFileStream() { return Readable.from([PNG]); },
    async removeFile() {},
    async removeAppPrefix() { return 0; },
    ...overrides,
  };
}

function startServeServer(store) {
  const app = express();
  app.use(appFileServeRoutes({}, { store }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function startShellServer(store, userId = 5) {
  const app = express();
  app.use((req, _res, next) => { req.user = { id: userId, username: 'alice' }; next(); });
  app.use(appFileShellRoutes({}, { store }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

// ── Serving ─────────────────────────────────────────────────────────

test('serves a public file: streamed bytes, stored type, immutable cache', async () => {
  poolQueryHandler = async (_sql, params) => {
    assert.deepEqual(params, [GOOD_ID]);
    return { rows: [{ app_id: 7, filename: 'dish.png', content_type: 'image/png', visibility: 'public' }] };
  };
  const server = await startServeServer(fakeStore());
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/app-files/${GOOD_ID}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-disposition'), /^inline; filename="dish.png"/);
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(PNG));
  } finally {
    server.close();
  }
});

test('malformed ids 404 without querying the DB', async () => {
  let queried = false;
  poolQueryHandler = async () => { queried = true; return { rows: [] }; };
  const server = await startServeServer(fakeStore());
  try {
    for (const bad of ['short', 'Z'.repeat(32), 'a'.repeat(31)]) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/app-files/${bad}`);
      assert.equal(res.status, 404, `expected 404 for ${bad}`);
    }
    assert.equal(queried, false);
  } finally {
    server.close();
  }
});

test('unknown id 404s', async () => {
  poolQueryHandler = async () => ({ rows: [] });
  const server = await startServeServer(fakeStore());
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/app-files/${'f'.repeat(32)}`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('private file: 404 without a token, served with a valid one, short private cache', async () => {
  poolQueryHandler = async () => ({
    rows: [{ app_id: 7, filename: 'p.png', content_type: 'image/png', visibility: 'private' }],
  });
  const server = await startServeServer(fakeStore());
  try {
    const base = `http://127.0.0.1:${server.address().port}/app-files/${GOOD_ID}`;
    assert.equal((await fetch(base)).status, 404);
    assert.equal((await fetch(`${base}?token=garbage`)).status, 404);
    // Scoped (infrastructure) tokens are rejected like app-storage-auth.
    // A worker token is a different authority entirely now, so it fails at
    // the verifier rather than on the shape check — either way, 404.
    assert.equal(
      (await fetch(`${base}?token=${platformJwt.signWorkerToken({ sessionId: 1 })}`)).status,
      404
    );
    // A user identity minted for a DIFFERENT app must not unlock this
    // app's private file — the row's app_id is the audience checked.
    const otherApp = platformJwt.signAppIdentityToken({
      appId: 8, user: { id: 7, username: 'alice' },
    });
    assert.equal((await fetch(`${base}?token=${otherApp}`)).status, 404);
    const good = platformJwt.signAppIdentityToken({
      appId: 7, user: { id: 7, username: 'alice' },
    });
    const res = await fetch(`${base}?token=${good}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, max-age=3600');
  } finally {
    server.close();
  }
});

test('object missing for an existing row degrades to 404', async () => {
  poolQueryHandler = async () => ({
    rows: [{ app_id: 7, filename: 'gone.png', content_type: 'image/png', visibility: 'public' }],
  });
  const server = await startServeServer(fakeStore({
    async getFileStream() { throw new Error('NoSuchKey'); },
  }));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/app-files/${GOOD_ID}`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('unconfigured store 503s for an existing row', async () => {
  poolQueryHandler = async () => ({
    rows: [{ app_id: 7, filename: 'x.png', content_type: 'image/png', visibility: 'public' }],
  });
  const server = await startServeServer(null);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/app-files/${GOOD_ID}`);
    assert.equal(res.status, 503);
  } finally {
    server.close();
  }
});

// ── Shell upload / delete / usage ───────────────────────────────────

function shellPoolHandler({ appBytes = 0, userBytes = 0, stagingBytes = 0 } = {}) {
  const inserts = [];
  const handler = async (sql, params) => {
    if (/SELECT[\s\S]*FROM app_files WHERE app_id/.test(sql)) {
      return { rows: [{ app_bytes: String(appBytes), user_bytes: String(userBytes), staging_bytes: String(stagingBytes) }] };
    }
    if (/INSERT INTO app_files/.test(sql)) {
      inserts.push(params);
      return { rows: [] };
    }
    if (/SELECT id, user_id FROM app_files/.test(sql)) {
      return { rows: [{ id: params[0], user_id: 5 }] };
    }
    return { rows: [] };
  };
  handler.inserts = inserts;
  return handler;
}

test('shell upload stores the file and returns the stored shape', async () => {
  const handler = shellPoolHandler();
  poolQueryHandler = handler;
  accessGrants = { view: { id: 7 } };
  const server = await startShellServer(fakeStore());
  try {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/api/apps/demo/files?filename=dish.png`,
      { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: PNG }
    );
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.match(j.id, /^[a-f0-9]{32}$/);
    assert.equal(j.contentType, 'image/png');
    assert.equal(j.visibility, 'public');
    // INSERT params: [id, appId, userId, filename, contentType, size, visibility, staging]
    assert.equal(handler.inserts.length, 1);
    assert.equal(handler.inserts[0][7], false);
  } finally {
    server.close();
  }
});

test('shell upload with staging=1 stamps the row', async () => {
  const handler = shellPoolHandler();
  poolQueryHandler = handler;
  const server = await startShellServer(fakeStore());
  try {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/api/apps/demo/files?filename=dish.png&staging=1`,
      { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: PNG }
    );
    assert.equal(res.status, 200);
    assert.equal(handler.inserts[0][7], true);
  } finally {
    server.close();
  }
});

test('shell upload is view-gated: 404 when access denied', async () => {
  poolQueryHandler = shellPoolHandler();
  accessGrants = {};
  const server = await startShellServer(fakeStore());
  try {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/api/apps/demo/files?filename=dish.png`,
      { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: PNG }
    );
    assert.equal(res.status, 404);
  } finally {
    accessGrants = { view: { id: 7 } };
    server.close();
  }
});

test('shell upload surfaces quota codes', async () => {
  poolQueryHandler = shellPoolHandler({ userBytes: 200 * 1024 * 1024 });
  const server = await startShellServer(fakeStore());
  try {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/api/apps/demo/files?filename=dish.png`,
      { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: PNG }
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'user_quota_exceeded');
  } finally {
    server.close();
  }
});

test('shell upload with MinIO down → 503 storage_unavailable', async () => {
  poolQueryHandler = shellPoolHandler();
  const server = await startShellServer(fakeStore({
    async putFile() { throw new Error('connect ECONNREFUSED'); },
  }));
  try {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/api/apps/demo/files?filename=dish.png`,
      { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: PNG }
    );
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'storage_unavailable');
  } finally {
    server.close();
  }
});

test('shell delete is uploader-only (stored row belongs to user 5)', async () => {
  poolQueryHandler = shellPoolHandler();
  const otherUser = await startShellServer(fakeStore(), 9);
  try {
    const res = await fetch(
      `http://127.0.0.1:${otherUser.address().port}/api/apps/demo/files/${GOOD_ID}`,
      { method: 'DELETE' }
    );
    assert.equal(res.status, 404);
  } finally {
    otherUser.close();
  }
  const owner = await startShellServer(fakeStore(), 5);
  try {
    const res = await fetch(
      `http://127.0.0.1:${owner.address().port}/api/apps/demo/files/${GOOD_ID}`,
      { method: 'DELETE' }
    );
    assert.equal(res.status, 200);
  } finally {
    owner.close();
  }
});

test('shell usage reports sums and caps', async () => {
  poolQueryHandler = shellPoolHandler({ appBytes: 1234, userBytes: 234 });
  const server = await startShellServer(fakeStore());
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/demo/files/usage`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.appBytes, 1234);
    assert.equal(j.userBytes, 234);
    assert.ok(j.appCapBytes > j.userCapBytes);
  } finally {
    server.close();
  }
});
