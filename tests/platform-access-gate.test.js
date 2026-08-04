// src/middleware/auth.js — the platform-access gate (onboarding flow
// alignment). A session is no longer the whole story: users.has_platform_access
// gates the SV platform surfaces (SPA home / social / build). Since the
// fold-auth-pages-into-SPA migration the SPA shell itself serves
// anonymously (the client boots into in-SPA landing/login screens and a
// gated session is routed to the in-SPA #waiting room); the API 401/403
// remain the security boundary.
//
// Contracts guarded here:
//
//   1. Grandfathered / released users (has_platform_access TRUE) pass the
//      middleware exactly as before — no behavior change at deploy time.
//   2. A no-access session still gets the SPA shell for page loads (the
//      client routes it to #waiting) and a 403 with code
//      `platform_access_required` for /api/* calls.
//   3. GATE_OPEN_PATHS survive the gate: /api/auth/* (me / logout /
//      change-password) and /api/iframe-token — because login-required
//      CHILD APPS stay usable for any account per the onboarding doc's
//      ladder.
//   4. Admins bypass the gate even with has_platform_access FALSE.
//   5. Sessionless `/` serves the SPA shell; deeper page paths bounce to
//      the shell; anonymous /api/* stays a plain 401.
//   6. The legacy standalone pages (landing/login/register/waiting .html)
//      are PUBLIC_PATH redirect stubs (served pre-auth).
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
    const server = app.listen(0, '127.0.0.1');
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

// ─── 2. No-access sessions get the shell (client routes to #waiting) ──

test('a user WITHOUT access still gets the SPA shell on the front door', async () => {
  await withServer(async (base) => {
    const res = await get(base, '/', 'waiting-session');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'SPA');
  });
});

test('a user WITHOUT access is bounced to the shell from deeper pages', async () => {
  await withServer(async (base) => {
    const res = await get(base, '/social', 'waiting-session');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');
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

test('the waiting stub, auth APIs, and iframe-token stay open to a no-access session', async () => {
  await withServer(async (base) => {
    // The old standalone waiting page is a PUBLIC_PATHS redirect stub now.
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

test('sessionless / serves the SPA shell; deeper paths bounce to it; APIs 401', async () => {
  await withServer(async (base) => {
    // Anonymous SPA boot (fold-auth-pages-into-SPA): the shell serves
    // without a session and the client shows the in-SPA landing screen.
    const front = await get(base, '/');
    assert.equal(front.status, 200);
    assert.equal(await front.text(), 'SPA');

    // Deeper paths bounce to the shell — the URL fragment survives a
    // redirect, so shared deep links still reach the login screen.
    const deep = await get(base, '/social');
    assert.equal(deep.status, 302);
    assert.equal(deep.headers.get('location'), '/');

    const api = await get(base, '/api/apps');
    assert.equal(api.status, 401);
  });
});

// ─── 6. The legacy standalone pages are public redirect stubs ─────────

test('the landing/waiting stubs are served without a session', async () => {
  await withServer(async (base) => {
    const landing = await get(base, '/landing.html');
    assert.equal(landing.status, 200);
    assert.equal(await landing.text(), 'LANDING');

    const waiting = await get(base, '/waiting.html');
    assert.equal(waiting.status, 200);
    assert.equal(await waiting.text(), 'WAITING');
  });
});

// ─── 7. The on-disk stubs carry the right SPA hash routes ─────────────

test('the four standalone pages are redirect stubs into SPA hash routes', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

  assert.match(read('landing.html'), /location\.replace\('\/#landing'\)/);
  assert.match(read('waiting.html'), /location\.replace\('\/#waiting'\)/);

  // login stub: #login base route, #signup for ?signup=1, and it carries
  // a deep-link fragment + remaining query (return_to) through.
  const login = read('login.html');
  assert.match(login, /#signup/);
  assert.match(login, /#login/);
  assert.match(login, /deepLink/);
  assert.match(login, /location\.replace\(/);

  // register stub: #register[/<code>] with the ?code= prefill preserved.
  const register = read('register.html');
  assert.match(register, /#register\/'\s*\+\s*encodeURIComponent\(code\)/);
  assert.match(register, /location\.replace\(/);
});
