'use strict';
// GET /api/admin/platform-limits and POST /api/admin/platform-limits/check
// (routes/admin-platform-limits.js): full admins only, through the real
// evaluators, and never cached by the browser.
//
// Mounted the way routes/admin.js mounts it: behind adminMiddleware, then
// the route's own requireAdminWrite. A member and a view-only admin are both
// turned away; a full admin gets the rows services/platform-limits-view.js
// computes from the enforcing routes' own queries.
//
// Run with: node --test tests/admin-platform-limits-route.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const wsPath = require.resolve('../src/services/ws');
require.cache[wsPath] = {
  id: wsPath, filename: wsPath, loaded: true,
  exports: { broadcastToAdmins: () => 0 },
};

const express = require('express');
const { adminMiddleware } = require('../src/middleware/admin');
const { adminPlatformLimitsRoutes } = require('../src/routes/admin-platform-limits');
const view = require('../src/services/platform-limits-view');

const collapse = (sql) => sql.replace(/\s+/g, ' ').trim();

function pool({ apps = 214, appLimit = 210 } = {}) {
  return {
    async query(rawSql, params = []) {
      const sql = collapse(rawSql);
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
      if (/FROM platform_limit_alerts WHERE limit_key = ANY/.test(sql)) return { rows: [{ limit_key: 'apps', level: 'full' }] };
      if (/FROM apps WHERE status <> 'error'/.test(sql)) return { rows: [{ n: apps }] };
      if (/FROM chat_sessions/.test(sql)) return { rows: [{ cnt: 3 }] };
      if (/FROM platform_settings s/.test(sql)) {
        return { rows: params[0] === 'max_apps' ? [{ value: String(appLimit), updated_at: null, updated_by: 'ada' }] : [] };
      }
      if (/^SELECT key, value FROM platform_settings WHERE key = ANY/.test(sql)) return { rows: [] };
      if (/current_setting\('max_connections'\)/.test(sql)) return { rows: [{ max: 100, used: 10, idle: 0 }] };
      if (/GROUP BY datname|homeroom_connection_counts\(\) WHERE datname/.test(sql)) return { rows: [] };
      if (/superuser_reserved_connections/.test(sql)) return { rows: [{ superuser_reserved: 3, reserved: 0 }] };
      if (/^INSERT INTO platform_limit_alerts|^UPDATE platform_limit_alerts|^INSERT INTO platform_settings/.test(sql)) return { rows: [] };
      if (/FROM platform_limit_alerts WHERE limit_key = \$1 FOR UPDATE/.test(sql)) return { rows: [{ level: 'full', window_ms: null }] };
      if (/FROM users WHERE username = \$1 AND is_synthetic/.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

async function serve(user, db = pool()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api/admin', adminMiddleware);
  app.use(adminPlatformLimitsRoutes(db, { maxApps: 50, maxGlobalSessions: 180 }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

const MEMBER = { id: 7, username: 'ada', isAdmin: false, canAdminWrite: false };
const VIEW_ONLY = { id: 8, username: 'bo', isAdmin: true, canAdminWrite: false };
const FULL = { id: 9, username: 'cy', isAdmin: true, canAdminWrite: true };

test('members and view-only admins never see the figures', async () => {
  for (const user of [MEMBER, VIEW_ONLY]) {
    const { base, close } = await serve(user);
    try {
      // adminMiddleware turns a member away (a redirect off the admin
      // mount); requireAdminWrite answers a view-only admin 403.
      const read = await fetch(`${base}/api/admin/platform-limits`, { redirect: 'manual' });
      const check = await fetch(`${base}/api/admin/platform-limits/check`, { method: 'POST', redirect: 'manual' });
      assert.ok([302, 403].includes(read.status), `${user.username}: read answered ${read.status}`);
      assert.ok([302, 403].includes(check.status), `${user.username}: check answered ${check.status}`);
      if (user === VIEW_ONLY) assert.equal(read.status, 403);
    } finally {
      await close();
    }
  }
});

test('a full admin reads the rows, worst first, uncached', async () => {
  view.resetForTests();
  const { base, close } = await serve(FULL);
  try {
    const res = await fetch(`${base}/api/admin/platform-limits`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.equal(body.broken, true);
    assert.deepEqual(body.rows.map((r) => [r.key, r.state, r.used, r.cap]), [['apps', 'over', 214, 210]]);
    assert.equal(typeof body.checkedAt, 'string');
  } finally {
    await close();
  }
});

test('Check again runs the sweeps and answers the area anew', async () => {
  view.resetForTests();
  const { base, close } = await serve(FULL, pool({ apps: 100, appLimit: 300 }));
  try {
    const res = await fetch(`${base}/api/admin/platform-limits/check`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.rows, [], 'raised to 300: nothing near, the row is gone');
    assert.equal(body.broken, false);
  } finally {
    await close();
  }
});
