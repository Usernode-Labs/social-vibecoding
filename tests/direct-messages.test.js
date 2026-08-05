'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const path = require('path');

let queryHandler = async () => ({ rows: [], rowCount: 0 });
const calls = [];
const txPool = {
  query: async (sql, params = []) => {
    calls.push({ sql: String(sql), params });
    return queryHandler(String(sql), params);
  },
  release() {},
};
const pool = {
  query: (...args) => txPool.query(...args),
  connect: async () => txPool,
};

const poolId = require.resolve('../src/db/pool');
require.cache[poolId] = {
  id: poolId, filename: poolId, loaded: true, paths: [], exports: { getPool: () => pool },
};

let grantedApp = {
  id: 7, slug: 'demo', collab_visibility: 'public', view_visibility: 'public',
};
let allowParticipants = true;
const accessId = require.resolve('../src/services/app-access');
require.cache[accessId] = {
  id: accessId,
  filename: accessId,
  loaded: true,
  paths: [],
  exports: {
    ACCESS_COLUMNS: 'id, slug, collab_visibility, view_visibility',
    getAppForUser: async (_pool, slug, _user, level) => {
      assert.equal(level, 'collab');
      return slug === 'demo' ? grantedApp : null;
    },
    checkAppAccess: async () => allowParticipants,
  },
};

const rateId = require.resolve('../src/middleware/rate-limits');
require.cache[rateId] = {
  id: rateId,
  filename: rateId,
  loaded: true,
  paths: [],
  exports: {
    directMessageSendLimiter: (_req, _res, next) => next(),
    directMessageActionLimiter: (_req, _res, next) => next(),
  },
};

const loggerId = require.resolve('../src/services/logger');
require.cache[loggerId] = {
  id: loggerId,
  filename: loggerId,
  loaded: true,
  paths: [],
  exports: { error() {}, warn() {}, info() {}, debug() {} },
};

const dm = require('../src/routes/direct-messages');

const ALICE = { id: 5, username: 'alice', isAdmin: false, canAdminWrite: false };
const BOB_ROW = { id: 8, username: 'bob', is_admin: false, admin_readonly: false };
const CONVERSATION = {
  id: 41,
  app_id: 7,
  user_low_id: 5,
  user_high_id: 8,
  requested_by: 5,
  status: 'accepted',
  accepted_at: '2026-08-05T10:00:00.000Z',
  created_at: '2026-08-05T09:00:00.000Z',
  updated_at: '2026-08-05T10:00:00.000Z',
};

beforeEach(() => {
  calls.length = 0;
  grantedApp = {
    id: 7, slug: 'demo', collab_visibility: 'public', view_visibility: 'public',
  };
  allowParticipants = true;
  queryHandler = async (sql) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
    if (/pg_advisory_xact_lock/.test(sql)) return { rows: [{}] };
    return { rows: [], rowCount: 0 };
  };
});

async function startServer(user = ALICE) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(dm.directMessageRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function url(server, suffix) {
  return `http://127.0.0.1:${server.address().port}${suffix}`;
}

test('strict ids, pagination and exact usernames reject ambiguous input', () => {
  for (const bad of ['0', '-1', '1e2', '12x', '2147483648', '', null]) {
    assert.equal(dm.parseId(bad), null, String(bad));
  }
  assert.equal(dm.parseId('42'), 42);
  assert.deepEqual(dm.parsePage({ limit: '1000', before: '9' }), { limit: 100, before: 9 });
  assert.equal(dm.parsePage({ limit: '0' }), null);
  assert.equal(dm.parsePage({ before: '1e3' }), null);
  assert.equal(dm.normalizeUsername(' alice'), null);
  assert.equal(dm.normalizeUsername('Alice'), 'Alice');
  assert.deepEqual(dm.orderedPair(8, 5), [5, 8]);
});

test('all app DM routes require authentication and existence-hide denied apps', async () => {
  let server = await startServer(null);
  try {
    const res = await fetch(url(server, '/api/apps/demo/direct-conversations'));
    assert.equal(res.status, 401);
  } finally { server.close(); }

  grantedApp = null;
  server = await startServer();
  try {
    const res = await fetch(url(server, '/api/apps/demo/direct-conversations'));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Resource not found' });
    assert.equal(calls.length, 0);
  } finally { server.close(); }
});

test('exact-username request creates a pending app-scoped conversation', async () => {
  queryHandler = async (sql, params) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || /pg_advisory_xact_lock/.test(sql)) {
      return { rows: [{}] };
    }
    if (/FROM users WHERE username/.test(sql)) return { rows: [BOB_ROW] };
    if (/FROM apps WHERE id/.test(sql)) return { rows: [grantedApp] };
    if (/FROM users WHERE id = ANY/.test(sql)) {
      return { rows: [
        { id: 5, username: 'alice', is_admin: false, admin_readonly: false }, BOB_ROW,
      ] };
    }
    if (/FROM direct_message_blocks/.test(sql)) return { rows: [] };
    if (/SELECT \* FROM direct_conversations/.test(sql)) return { rows: [] };
    if (/INSERT INTO direct_conversations/.test(sql)) {
      assert.deepEqual(params, [7, 5, 8, 5]);
      return { rows: [{ ...CONVERSATION, status: 'pending', accepted_at: null }] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  const server = await startServer();
  try {
    const res = await fetch(url(server, '/api/apps/demo/direct-conversations'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob' }),
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const body = await res.json();
    assert.deepEqual(body.conversation.otherUser, { username: 'bob' });
    assert.equal(body.conversation.status, 'pending');
    assert.equal(body.conversation.requestedByMe, true);
    assert.ok(calls.some((call) => /pg_advisory_xact_lock/.test(call.sql)));
  } finally { server.close(); }
});

test('ineligible and blocked recipients share the same unavailable response', async () => {
  let blocked = false;
  queryHandler = async (sql) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || /pg_advisory_xact_lock/.test(sql)) {
      return { rows: [{}] };
    }
    if (/FROM users WHERE username/.test(sql)) return { rows: [BOB_ROW] };
    if (/FROM apps WHERE id/.test(sql)) return { rows: [grantedApp] };
    if (/FROM users WHERE id = ANY/.test(sql)) return { rows: [
      { id: 5, username: 'alice', is_admin: false, admin_readonly: false }, BOB_ROW,
    ] };
    if (/FROM direct_message_blocks/.test(sql)) return { rows: blocked ? [{ 1: 1 }] : [] };
    throw new Error(`unexpected SQL: ${sql}`);
  };
  const server = await startServer();
  try {
    allowParticipants = false;
    let res = await fetch(url(server, '/api/apps/demo/direct-conversations'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob' }),
    });
    assert.equal(res.status, 404);
    const ineligibleBody = await res.json();

    allowParticipants = true;
    blocked = true;
    res = await fetch(url(server, '/api/apps/demo/direct-conversations'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob' }),
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), ineligibleBody);
  } finally { server.close(); }
});

test('a reciprocal exact-username request is explicit consent and accepts atomically', async () => {
  const pending = { ...CONVERSATION, requested_by: 8, status: 'pending', accepted_at: null };
  queryHandler = async (sql) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || /pg_advisory_xact_lock/.test(sql)) {
      return { rows: [{}] };
    }
    if (/FROM users WHERE username/.test(sql)) return { rows: [BOB_ROW] };
    if (/FROM apps WHERE id/.test(sql)) return { rows: [grantedApp] };
    if (/FROM users WHERE id = ANY/.test(sql)) return { rows: [
      { id: 5, username: 'alice', is_admin: false, admin_readonly: false }, BOB_ROW,
    ] };
    if (/FROM direct_message_blocks/.test(sql)) return { rows: [] };
    if (/SELECT \* FROM direct_conversations/.test(sql)) return { rows: [pending] };
    if (/UPDATE direct_conversations/.test(sql)) {
      return { rows: [{ ...CONVERSATION, requested_by: 8 }] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  const server = await startServer();
  try {
    const res = await fetch(url(server, '/api/apps/demo/direct-conversations'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.conversation.status, 'accepted');
    assert.equal(body.conversation.requestedByMe, false);
    const lockAt = calls.findIndex((call) => /pg_advisory_xact_lock/.test(call.sql));
    const acceptAt = calls.findIndex((call) => /SET status = 'accepted'/.test(call.sql));
    assert.ok(lockAt >= 0 && acceptAt > lockAt, 'acceptance happens after the pair lock');
  } finally { server.close(); }
});

test('a requester cannot accept their own pending conversation', async () => {
  const pending = { ...CONVERSATION, status: 'pending', accepted_at: null };
  queryHandler = async (sql) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || /pg_advisory_xact_lock/.test(sql)) {
      return { rows: [{}] };
    }
    if (/SELECT \* FROM direct_conversations/.test(sql)) return { rows: [pending] };
    throw new Error(`unexpected SQL: ${sql}`);
  };
  const server = await startServer();
  try {
    const res = await fetch(url(server, '/api/apps/demo/direct-conversations/41/respond'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'accept' }),
    });
    assert.equal(res.status, 404);
    assert.ok(!calls.some((call) => /SET status/.test(call.sql)));
  } finally { server.close(); }
});

test('send rechecks participant access and block state under the pair lock', async () => {
  let blocked = true;
  let inserted = false;
  queryHandler = async (sql, params) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || /pg_advisory_xact_lock/.test(sql)) {
      return { rows: [{}] };
    }
    if (/SELECT \* FROM direct_conversations/.test(sql)) return { rows: [CONVERSATION] };
    if (/FROM direct_message_blocks/.test(sql)) return { rows: blocked ? [{ 1: 1 }] : [] };
    if (/FROM apps WHERE id/.test(sql)) return { rows: [grantedApp] };
    if (/FROM users WHERE id = ANY/.test(sql)) return { rows: [
      { id: 5, username: 'alice', is_admin: false, admin_readonly: false }, BOB_ROW,
    ] };
    if (/INSERT INTO direct_messages/.test(sql)) {
      inserted = true;
      assert.deepEqual(params, [41, 5, '<b>plain data</b>']);
      return { rows: [{
        id: 90, sender_id: 5, content: params[2],
        created_at: '2026-08-05T11:00:00.000Z', deleted_at: null,
      }] };
    }
    if (/UPDATE direct_conversations/.test(sql)) return { rows: [] };
    throw new Error(`unexpected SQL: ${sql}`);
  };
  const server = await startServer();
  try {
    let res = await fetch(url(server, '/api/apps/demo/direct-conversations/41/messages'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '<b>plain data</b>' }),
    });
    assert.equal(res.status, 404);
    assert.equal(inserted, false);

    blocked = false;
    res = await fetch(url(server, '/api/apps/demo/direct-conversations/41/messages'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '<b>plain data</b>' }),
    });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).message.content, '<b>plain data</b>');
    assert.equal(inserted, true);
  } finally { server.close(); }
});

test('author-only deletion scrubs content and is idempotent', async () => {
  let deletedAt = null;
  let scrubbed = false;
  queryHandler = async (sql) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
    if (/SELECT dm\.id, dm\.sender_id/.test(sql)) {
      return { rows: [{ id: 90, sender_id: 5, deleted_at: deletedAt }] };
    }
    if (/UPDATE direct_messages SET content = NULL/.test(sql)) {
      scrubbed = true;
      deletedAt = new Date();
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  const server = await startServer();
  try {
    let res = await fetch(url(server, '/api/apps/demo/direct-conversations/41/messages/90'), {
      method: 'DELETE',
    });
    assert.equal(res.status, 204);
    assert.equal(scrubbed, true);
    scrubbed = false;
    res = await fetch(url(server, '/api/apps/demo/direct-conversations/41/messages/90'), {
      method: 'DELETE',
    });
    assert.equal(res.status, 204);
    assert.equal(scrubbed, false);
  } finally { server.close(); }
});

test('reports snapshot content and the queue is full-admin only', async () => {
  let reportParams = null;
  queryHandler = async (sql, params) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
    if (/SELECT \* FROM direct_conversations/.test(sql)) return { rows: [CONVERSATION] };
    if (/SELECT sender_id, content FROM direct_messages/.test(sql)) {
      return { rows: [{ sender_id: 8, content: 'abusive text' }] };
    }
    if (/INSERT INTO direct_message_reports/.test(sql)) {
      reportParams = params;
      return { rows: [{ id: 12, created_at: '2026-08-05T12:00:00.000Z' }] };
    }
    if (/FROM direct_message_reports dmr/.test(sql)) return { rows: [] };
    throw new Error(`unexpected SQL: ${sql}`);
  };
  let server = await startServer();
  try {
    const res = await fetch(url(server, '/api/apps/demo/direct-conversations/41/reports'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: 90, reason: 'Harassment' }),
    });
    assert.equal(res.status, 201);
    assert.deepEqual(reportParams, [7, 41, 90, 5, 8, 'abusive text', 'Harassment']);
  } finally { server.close(); }

  server = await startServer(ALICE);
  try {
    const res = await fetch(url(server, '/api/admin/direct-message-reports'));
    assert.equal(res.status, 403);
  } finally { server.close(); }

  server = await startServer({ ...ALICE, isAdmin: true, canAdminWrite: true });
  try {
    const res = await fetch(url(server, '/api/admin/direct-message-reports'));
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).reports, []);
  } finally { server.close(); }
});

test('schema, debug isolation and server wiring pin the privacy contract', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  for (const table of [
    'direct_conversations', 'direct_messages', 'direct_message_blocks',
    'direct_message_reports',
  ]) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.match(schema, new RegExp(`COMMENT ON TABLE ${table}\\s+IS 'staging:private'`));
  }
  assert.match(schema, /UNIQUE \(app_id, user_low_id, user_high_id\)/);
  assert.match(schema, /length\(btrim\(content\)\) BETWEEN 1 AND 2000/);

  const route = fs.readFileSync(
    path.join(__dirname, '../src/routes/direct-messages.js'), 'utf8'
  );
  assert.match(route, /SET content = NULL, deleted_at = NOW\(\)/);

  const debugAccess = require('../src/services/debug-access');
  for (const table of [
    'direct_conversations', 'direct_messages', 'direct_message_blocks',
    'direct_message_reports',
  ]) assert.ok(debugAccess.DENIED_TABLES.has(table), table);

  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(server, /require\('\.\/src\/routes\/direct-messages'\)/);
  assert.match(server, /app\.use\(directMessageRoutes\(config\)\)/);
});
