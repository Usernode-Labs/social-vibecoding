const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolModule = require('../src/db/pool');

function loadRoutes(pool) {
  const original = poolModule.getPool;
  poolModule.getPool = () => pool;
  const modulePath = require.resolve('../src/routes/notifications');
  delete require.cache[modulePath];
  const routes = require('../src/routes/notifications');
  poolModule.getPool = original;
  delete require.cache[modulePath];
  return routes;
}

async function start(pool) {
  const routes = loadRoutes(pool);
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: 7, username: 'recipient' };
    next();
  });
  app.use(routes.notificationsRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({
      server,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

function notificationRow() {
  return {
    id: 42,
    kind: 'session_done',
    read_at: null,
    created_at: '2026-08-03T10:00:00Z',
    app_id: 5,
    app_slug: 'example',
    app_name: 'Example',
    chat_message_id: null,
    message_content: null,
    thread_type: null,
    thread_ref: null,
    session_id: 9,
    pr_title: 'Finished work',
    pr_number: null,
    headless_issue_number: null,
    branch_name: 'feat/work',
    source_username: null,
    detail: null,
  };
}

test('exact lookup is user-scoped, hydrated, and non-cacheable', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return { rows: [notificationRow()] };
    },
  };
  const { server, baseUrl } = await start(pool);
  try {
    const response = await fetch(`${baseUrl}/api/notifications/42`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal(body.notification.id, 42);
    assert.equal(body.notification.appSlug, 'example');
    assert.equal(body.notification.sessionId, 9);
    assert.deepEqual(calls[0].params, [42, 7]);
    assert.match(calls[0].sql, /n\.id = \$1 AND n\.user_id = \$2/);
  } finally {
    server.close();
  }
});

test('missing and invalid ids share the not-found response', async () => {
  let queryCount = 0;
  const pool = {
    async query() {
      queryCount += 1;
      return { rows: [] };
    },
  };
  const { server, baseUrl } = await start(pool);
  try {
    const missing = await fetch(`${baseUrl}/api/notifications/42`);
    const invalid = await fetch(`${baseUrl}/api/notifications/0`);
    const overflow = await fetch(`${baseUrl}/api/notifications/2147483648`);

    assert.equal(missing.status, 404);
    assert.equal(invalid.status, 404);
    assert.equal(overflow.status, 404);
    assert.equal(queryCount, 1, 'invalid ids never reach PostgreSQL');
  } finally {
    server.close();
  }
});
