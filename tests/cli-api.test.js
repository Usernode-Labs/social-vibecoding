'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const {
  API_SCOPE,
  CLIENT_ID,
  IDENTITY_SCOPE,
} = require('../src/services/cli-auth-constants');
const { makeAccessToken, hashSecret } = require('../src/services/cli-auth');
const {
  canonicalApiTarget,
  isCliCredentialManagementSession,
  isCliApiPath,
} = require('../src/services/cli-api-policy');
const { callUserApi } = require('../src/cli/main');

test('generic API target policy permits user-facing paths without an endpoint registry', () => {
  assert.equal(
    canonicalApiTarget('/api/apps/demo/github-issues?refresh=1'),
    '/api/apps/demo/github-issues?refresh=1'
  );
  assert.equal(canonicalApiTarget('/api/sessions/42/promote'), '/api/sessions/42/promote');
  assert.equal(isCliApiPath('/api/apps'), true);
  for (const target of [
    'https://evil.example/api/apps',
    '//evil.example/api/apps',
    '/api/admin/users',
    '/api/ADMIN/users',
    '/api/auth/login',
    '/api/cli/token/status',
    '/api/internal/sessions/1/issues',
    '/api/me/cli-tokens',
    '/api/me/api-key',
    '/api/me/llm-grants',
    '/api/me/password',
    '/api/me/wallet-link',
    '/api/apps/demo/llm-grant',
    '/api/apps/demo/secret-declaration-pr',
    '/api/apps/demo/secrets',
    '/api/apps/%2e%2e/admin',
    '/health',
  ]) {
    assert.equal(canonicalApiTarget(target), null, target);
  }
});

test('multiplexed session routes identify CLI secret-declaration mutations', () => {
  const secretSession = { branch_name: 'secret-declare/demo-123' };
  const ordinarySession = { branch_name: 'dev/alice-123' };

  assert.equal(isCliCredentialManagementSession({ cliAuthenticated: true }, secretSession), true);
  assert.equal(isCliCredentialManagementSession({ cliAuthenticated: true }, ordinarySession), false);
  assert.equal(isCliCredentialManagementSession({}, secretSession), false,
    'browser sessions retain the existing secret-declaration workflow');
  assert.equal(isCliCredentialManagementSession({ cliAuthenticated: true }, null), false);
});

test('all secret-declaration session lifecycle mutations enforce the CLI credential boundary', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', 'src', 'routes');
  const votes = fs.readFileSync(path.join(root, 'votes.js'), 'utf8');
  const sessions = fs.readFileSync(path.join(root, 'sessions.js'), 'utf8');

  const routeSlice = (source, opening, nextOpening) => {
    const start = source.indexOf(opening);
    assert.notEqual(start, -1, `missing route: ${opening}`);
    const end = nextOpening ? source.indexOf(nextOpening, start + opening.length) : source.length;
    assert.notEqual(end, -1, `missing route boundary after: ${opening}`);
    return source.slice(start, end);
  };
  const guardedBefore = (source, guard, mutation, label) => {
    const guardAt = source.indexOf(guard);
    const mutationAt = source.indexOf(mutation);
    assert.ok(guardAt >= 0, `${label}: CLI credential guard missing`);
    assert.ok(mutationAt >= 0, `${label}: mutation marker missing`);
    assert.ok(guardAt < mutationAt, `${label}: guard must run before mutation`);
  };

  guardedBefore(
    routeSlice(votes, "router.post('/api/sessions/:id/vote'", "router.get('/api/sessions/:id/votes'"),
    'isCliCredentialManagementSession(req, session)', 'recordVote({', 'vote'
  );
  guardedBefore(
    routeSlice(votes, "router.post('/api/sessions/:id/undo'", "router.post('/api/sessions/:id/admin-merge'"),
    'isCliCredentialManagementSession(req, session)', 'checkAndOpenRevert', 'undo'
  );
  guardedBefore(
    routeSlice(votes, "router.post('/api/sessions/:id/admin-merge'", 'return router;'),
    'isCliCredentialManagementSession(req, session)', 'checkAndMerge(config, pool, session', 'admin merge'
  );
  guardedBefore(
    routeSlice(sessions, "router.post('/api/sessions/:id/archive'", "router.post('/api/sessions/:id/unarchive'"),
    'isCliCredentialManagementSession(req, rows[0])', 'sessionLifecycle.archiveSession', 'archive'
  );
  guardedBefore(
    routeSlice(sessions, "router.post('/api/sessions/:id/unarchive'", "router.post('/api/sessions/:id/share'"),
    'isCliCredentialManagementSession(req, rows[0])', 'sessionLifecycle.unarchiveSession', 'unarchive'
  );
});

test('CLI bearer middleware authenticates generic user APIs and skips other namespaces', async () => {
  const token = makeAccessToken();
  const now = new Date();
  const queries = [];
  const pool = {
    async query(sql, params = []) {
      const text = String(sql);
      queries.push({ text, params });
      if (/FROM cli_access_tokens/.test(text)) {
        assert.equal(params[0], hashSecret(token));
        return {
          rows: [{
            id: 11,
            user_id: 7,
            client_id: CLIENT_ID,
            scopes: [IDENTITY_SCOPE, API_SCOPE],
            created_at: now,
            last_used_at: null,
            expires_at: new Date(now.getTime() + 60000),
            revoked_at: null,
          }],
        };
      }
      if (/clock_timestamp\(\) AS now/.test(text)) return { rows: [{ now }] };
      if (/FROM cli_auth_rate_limits/.test(text)) return { rows: [] };
      if (/SELECT id, username, is_admin, admin_readonly/.test(text)) {
        return {
          rows: [{
            id: 7,
            username: 'alice',
            is_admin: false,
            admin_readonly: false,
            app_quota: 3,
            ai_progress_estimate: false,
            locale: null,
          }],
        };
      }
      return { rows: [], rowCount: 1 };
    },
  };

  const poolModule = require('../src/db/pool');
  const originalGetPool = poolModule.getPool;
  poolModule.getPool = () => pool;
  delete require.cache[require.resolve('../src/routes/cli-auth')];
  const { cliApiBearerAuth } = require('../src/routes/cli-auth');
  poolModule.getPool = originalGetPool;

  const app = express();
  app.use(express.json());
  app.use(cliApiBearerAuth({ cliAuthEnabled: true }));
  app.use((req, res) => {
    res.json({
      authenticated: !!req.cliAuthenticated,
      user: req.user || null,
      body: req.body || null,
    });
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${origin}/api/apps/demo/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt: 'build it' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      authenticated: true,
      user: {
        id: 7,
        username: 'alice',
        isAdmin: false,
        adminReadonly: false,
        canAdminWrite: false,
        appQuota: 3,
        aiProgressEstimate: false,
        locale: null,
      },
      body: { prompt: 'build it' },
    });
    const ipLimitLookup = queries.findIndex(({ text }) => /FROM cli_auth_rate_limits/.test(text));
    const tokenLookup = queries.findIndex(({ text }) => /FROM cli_access_tokens/.test(text));
    assert.ok(ipLimitLookup >= 0 && ipLimitLookup < tokenLookup,
      'IP limiter must complete before retained-token lookup');
    const audit = queries.find(({ text }) => /INSERT INTO cli_auth_audit_events/.test(text));
    assert.deepEqual(JSON.parse(audit.params[9]), {
      method: 'POST',
      route: '/api/apps/demo/sessions',
    });

    const skipped = await fetch(`${origin}/api/admin/users`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.deepEqual(await skipped.json(), {
      authenticated: false,
      user: null,
      body: {},
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('generic bearer API fails closed before token lookup when IP limiter storage fails', async () => {
  let tokenLookups = 0;
  const poolModule = require('../src/db/pool');
  const originalGetPool = poolModule.getPool;
  poolModule.getPool = () => ({
    async query(sql) {
      const text = String(sql);
      if (/FROM cli_access_tokens/.test(text)) tokenLookups += 1;
      if (/pg_advisory_xact_lock/.test(text)) throw new Error('limiter unavailable');
      return { rows: [], rowCount: 0 };
    },
  });
  delete require.cache[require.resolve('../src/routes/cli-auth')];
  const { cliApiBearerAuth } = require('../src/routes/cli-auth');
  poolModule.getPool = originalGetPool;

  const app = express();
  app.use(cliApiBearerAuth({ cliAuthEnabled: true }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/apps/demo/issues`,
      { headers: { Authorization: `Bearer ${makeAccessToken()}` } }
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'temporarily_unavailable' });
    assert.equal(tokenLookups, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('CLI bearer API fails closed when CLI auth is disabled', async () => {
  const poolModule = require('../src/db/pool');
  const originalGetPool = poolModule.getPool;
  poolModule.getPool = () => ({
    query() {
      throw new Error('disabled middleware must not query');
    },
  });
  delete require.cache[require.resolve('../src/routes/cli-auth')];
  const { cliApiBearerAuth } = require('../src/routes/cli-auth');
  poolModule.getPool = originalGetPool;

  const app = express();
  app.use(cliApiBearerAuth({ cliAuthEnabled: false }));
  app.use((_req, res) => res.status(200).json({ unexpected: true }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${origin}/api/apps/demo/issues`, {
      headers: { Authorization: `Bearer ${makeAccessToken()}` },
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'not_found' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('generic API calls retain the protocol-wide 64 KiB response cap', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(
    JSON.stringify({ value: 'x'.repeat(64 * 1024) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
  try {
    await assert.rejects(
      callUserApi(
        { origin: 'https://example.test' },
        'GET',
        '/api/apps/demo',
        undefined,
        makeAccessToken()
      ),
      (err) => err.code === 'protocol_error'
        && /exceeded the size limit/.test(err.message)
    );
  } finally {
    global.fetch = originalFetch;
  }
});
