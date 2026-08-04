'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolModule = require('../src/db/pool');
const queries = [];
const pool = {
  async query(sql, params) {
    queries.push({ sql, params });
    if (/clock_timestamp\(\) AS now/.test(sql)) {
      return { rows: [{ now: new Date() }], rowCount: 1 };
    }
    if (/FROM cli_auth_rate_limits/.test(sql)) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  },
};
poolModule.getPool = () => pool;

delete require.cache[require.resolve('../src/routes/cli-auth')];
const {
  cliAuthGate,
  cliPreAuthRoutes,
} = require('../src/routes/cli-auth');

const config = {
  cliAuthEnabled: true,
  cliAuthOrigin: 'https://social-vibecoding.usernodelabs.org',
  cliDeviceCreateRatePerMinute: 10,
  cliDeviceCreateBurst: 20,
  cliDeviceLivePerIp: 10,
  cliDeviceLiveGlobal: 10000,
};

function startApp() {
  const app = express();
  app.set('trust proxy', false);
  app.use(cliAuthGate(config));
  app.use(cliPreAuthRoutes(config));
  app.use((_req, res) => res.status(418).json({ error: 'fallback' }));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function base(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

test('staging gate is authoritative before the approval shell and database', async () => {
  const previous = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  queries.length = 0;
  const server = await startApp();
  try {
    for (const pathname of [
      '/cli/authorize',
      '/api/cli/device/code',
      '/api/me/cli-tokens/42',
    ]) {
      const response = await fetch(`${base(server)}${pathname}`, {
        method: pathname.includes('device/code') ? 'POST' : 'GET',
        headers: pathname.includes('device/code')
          ? { 'Content-Type': 'application/json' } : {},
        body: pathname.includes('device/code') ? '{}' : undefined,
      });
      assert.equal(response.status, 404, pathname);
      assert.equal(response.headers.get('cache-control'), 'no-store', pathname);
    }
    assert.equal(queries.length, 0);
  } finally {
    if (previous == null) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = previous;
    server.close();
  }
});

test('approval shell is state-free, noncacheable, and frame protected', async () => {
  const previous = process.env.USERNODE_ENV;
  delete process.env.USERNODE_ENV;
  queries.length = 0;
  const server = await startApp();
  try {
    const response = await fetch(`${base(server)}/cli/authorize`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(await response.text(), /Authorize CLI access/);
    assert.equal(queries.length, 0);
  } finally {
    if (previous == null) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = previous;
    server.close();
  }
});

test('device creation parser rejects malformed, duplicate, and oversized JSON before DB use', async () => {
  queries.length = 0;
  const server = await startApp();
  try {
    for (const body of [
      '{"scopes":',
      '{"scopes":[],"scopes":["rpc:identity:read"]}',
    ]) {
      const response = await fetch(`${base(server)}/api/cli/device/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      assert.equal(response.status, 400);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    const oversized = await fetch(`${base(server)}/api/cli/device/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopes: ['x'.repeat(5000)] }),
    });
    assert.equal(oversized.status, 413);
    assert.equal(queries.length, 0);
  } finally {
    server.close();
  }
});

test('client identity injection is invalid_request while unsupported scopes are invalid_scope', async () => {
  queries.length = 0;
  const server = await startApp();
  try {
    let response = await fetch(`${base(server)}/api/cli/device/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scopes: ['rpc:identity:read'],
        client_id: 'other',
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_request' });

    response = await fetch(`${base(server)}/api/cli/device/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scopes: ['rpc:read'] }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_scope' });
    assert.equal(queries.length, 0);
  } finally {
    server.close();
  }
});

test('unknown RPC paths terminate before cookie middleware fallthrough', async () => {
  queries.length = 0;
  const server = await startApp();
  try {
    for (const pathname of ['/api/cli/rpc/not-a-tool', '/api/cli/not-a-route']) {
      const response = await fetch(`${base(server)}${pathname}`, {
        headers: { Cookie: 'session=ambient-browser-cookie' },
      });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: 'not_found' });
    }
    assert.equal(queries.length, 0);
  } finally {
    server.close();
  }
});
