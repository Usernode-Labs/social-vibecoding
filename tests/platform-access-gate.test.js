// src/middleware/auth.js — the platform-access gate (onboarding flow
// alignment). A session is no longer the whole story: users.has_platform_access
// gates the SV platform surfaces (SPA home / social / build). Accounts
// without it keep a small allowlist and land on the waiting room instead
// of the SPA; sessionless visitors hitting the front door get the public
// landing page.
//
// Contracts guarded here:
//
//   1. Grandfathered / released users (has_platform_access TRUE) pass the
//      middleware exactly as before — no behavior change at deploy time.
//   2. A no-access session gets the waiting room for page loads and a 403
//      with code `platform_access_required` for /api/* calls.
//   3. GATE_OPEN_PATHS survive the gate: /waiting.html itself, /api/auth/*
//      (me / logout / change-password), and /api/iframe-token — because
//      login-required CHILD APPS stay usable for any account per the
//      onboarding doc's ladder.
//   4. Admins bypass the gate even with has_platform_access FALSE.
//   5. Sessionless `/` redirects to the public landing page; deeper paths
//      keep the login redirect; anonymous /api/* stays a plain 401.
//   6. /landing.html is a PUBLIC_PATH (served pre-auth).
//
// HTTP-level tests against a throwaway express app + a substring-
// dispatching mock pool (same idiom as tests/mobile-auth-from-session.test.js).
//
// Run with: node --test tests/platform-access-gate.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');

// ─── Fixtures ─────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;

const USERS = {
  1: { id: 1, username: 'released', is_admin: false, has_platform_access: true },
  2: { id: 2, username: 'waiting', is_admin: false, has_platform_access: false },
  3: { id: 3, username: 'admin', is_admin: true, has_platform_access: false },
};

const SESSIONS = {
  'released-session': { user_id: 1, expires_at: new Date(Date.now() + DAY) },
  'waiting-session': { user_id: 2, expires_at: new Date(Date.now() + DAY) },
  'admin-session': { user_id: 3, expires_at: new Date(Date.now() + DAY) },
};

function collapse(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function makeMockPool() {
  async function query(rawSql, params = []) {
    const sql = collapse(rawSql);

    if (sql.includes('FROM sessions s JOIN users u')) {
      const s = SESSIONS[params[0]];
      if (!s) return { rows: [] };
      const u = USERS[s.user_id];
      return {
        rows: [{
          user_id: u.id,
          expires_at: s.expires_at,
          username: u.username,
          is_admin: u.is_admin,
          admin_readonly: false,
          app_quota: 0,
          ai_progress_estimate: false,
          locale: null,
          has_platform_access: u.has_platform_access,
        }],
      };
    }

    if (sql.startsWith('DELETE FROM sessions')) return { rows: [] };

    throw new Error(`Unhandled mock query: ${sql}`);
  }
  return { query };
}

// ─── Test app wiring (require-cache swap, same idiom as sibling tests) ─

function withApp(fn) {
  const poolModulePath = require.resolve('../src/db/pool');
  const original = require.cache[poolModulePath];
  require.cache[poolModulePath] = {
    exports: { getPool: () => makeMockPool() },
    loaded: true, id: poolModulePath, filename: poolModulePath, paths: original ? original.paths : [],
  };
  const authModulePath = require.resolve('../src/middleware/auth');
  delete require.cache[authModulePath];
  try {
    const { authMiddleware } = require('../src/middleware/auth');
    const app = express();
    app.use(cookieParser());
    app.use(authMiddleware({ databaseUrl: 'postgres://fake/fake', env: 'test' }));
    // Downstream stand-ins: reaching one of these means the gate let the
    // request through.
    app.get('/', (_req, res) => res.send('SPA'));
    app.get('/social', (_req, res) => res.send('SPA'));
    app.get('/waiting.html', (_req, res) => res.send('WAITING'));
    app.get('/landing.html', (_req, res) => res.send('LANDING'));
    app.get('/api/apps', (_req, res) => res.json({ reached: 'apps' }));
    app.get('/api/auth/me', (_req, res) => res.json({ reached: 'me' }));
    app.get('/api/iframe-token', (_req, res) => res.json({ reached: 'iframe-token' }));
    return fn(app);
  } finally {
    if (original) require.cache[poolModulePath] = original;
    else delete require.cache[poolModulePath];
    delete require.cache[authModulePath];
  }
}

async function withServer(fn) {
  return withApp(async (app) => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await fn(base);
    } finally {
      server.close();
    }
  });
}

function get(base, path, session) {
  return fetch(`${base}${path}`, {
    redirect: 'manual',
    headers: session ? { cookie: `session=${session}` } : {},
  });
}

// ─── 1. Released users are unaffected ─────────────────────────────────

test('a user WITH platform access reaches the SPA and APIs', async () => {
  await withServer(async (base) => {
    const spa = await get(base, '/', 'released-session');
    assert.equal(spa.status, 200);
    assert.equal(await spa.text(), 'SPA');

    const api = await get(base, '/api/apps', 'released-session');
    assert.equal(api.status, 200);
    assert.deepEqual(await api.json(), { reached: 'apps' });
  });
});

// ─── 2. No-access sessions land in the waiting room ───────────────────

test('a user WITHOUT access is redirected to the waiting room on page loads', async () => {
  await withServer(async (base) => {
    for (const p of ['/', '/social']) {
      const res = await get(base, p, 'waiting-session');
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/waiting.html');
    }
  });
});

test('a user WITHOUT access gets 403 platform_access_required on APIs', async () => {
  await withServer(async (base) => {
    const res = await get(base, '/api/apps', 'waiting-session');
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'platform_access_required');
  });
});

// ─── 3. The gate's allowlist ──────────────────────────────────────────

test('the waiting room, auth APIs, and iframe-token stay open to a no-access session', async () => {
  await withServer(async (base) => {
    const waiting = await get(base, '/waiting.html', 'waiting-session');
    assert.equal(waiting.status, 200);
    assert.equal(await waiting.text(), 'WAITING');

    // Account basics — the waiting room polls /api/auth/me for release.
    const me = await get(base, '/api/auth/me', 'waiting-session');
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), { reached: 'me' });

    // Login-required child apps stay usable for ANY account.
    const iframe = await get(base, '/api/iframe-token', 'waiting-session');
    assert.equal(iframe.status, 200);
    assert.deepEqual(await iframe.json(), { reached: 'iframe-token' });
  });
});

// ─── 4. Admin bypass ──────────────────────────────────────────────────

test('an admin bypasses the gate even without the access flag', async () => {
  await withServer(async (base) => {
    const spa = await get(base, '/', 'admin-session');
    assert.equal(spa.status, 200);
    assert.equal(await spa.text(), 'SPA');
  });
});

// ─── 5. Sessionless routing ───────────────────────────────────────────

test('sessionless / redirects to the landing page, deeper paths to login', async () => {
  await withServer(async (base) => {
    const front = await get(base, '/');
    assert.equal(front.status, 302);
    assert.equal(front.headers.get('location'), '/landing.html');

    const deep = await get(base, '/social');
    assert.equal(deep.status, 302);
    assert.equal(deep.headers.get('location'), '/login.html');

    const api = await get(base, '/api/apps');
    assert.equal(api.status, 401);
  });
});

// ─── 6. The landing page is public ────────────────────────────────────

test('landing.html is served without a session', async () => {
  await withServer(async (base) => {
    const res = await get(base, '/landing.html');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'LANDING');
  });
});
