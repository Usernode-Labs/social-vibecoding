// /challenges-api — the SV web shell's challenges + profile read surface
// (app-as-SV-chrome + profile-and-settings-to-web migrations). Until the
// topochain merge this was a read-only proxy in server.js to the external
// leaderboard deployment; it is now served in-process by
// topochainMobileRoutes (src/routes/topochain/mobile.js, "/challenges-api
// (SV web shell reads)" section), reusing the SAME five GET handlers as
// /api/v4/mobile but authenticated by the platform session cookie.
//
// Contracts guarded here:
//
//   1. Session-gated: no/expired session cookie -> 401, never anonymous
//      data (the old proxy trusted a client-claimed participant_id; the
//      in-process routes must not).
//   2. /me/* identity comes from the session row — a client-supplied
//      participant_id query param is ignored.
//   3. The old proxy's allowlist contract survives: off-list paths and
//      non-GET methods under /challenges-api 404 instead of falling
//      through to the SPA catch-all.
//   4. The /api/v4/mobile twins still demand a mobile bearer token — a
//      web session cookie alone must NOT open the mobile surface.
//   5. The proxy block is really gone from server.js (source pin, same
//      idiom as tests/board-order.test.js).
//
// HTTP-level tests against a throwaway express app + a substring-
// dispatching mock pool (same idiom as tests/topochain-mobile-data.test.js)
// — no live DB.
//
// Run with: node --test tests/challenges-web-routes.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');

// ─── Fixtures ─────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;

// One signed-in platform user. `display_name` is what /me/breakdown echoes
// back, which is how the identity-from-session tests observe req.user.
const WEB_USER = {
  id: 7,
  username: 'webuser',
  email: 'web@example.com',
  telegram: null,
  discord: null,
  display_name: 'Web User',
  is_admin: false,
};

const SESSIONS = {
  'good-session': { user_id: WEB_USER.id, expires_at: new Date(Date.now() + DAY) },
  'expired-session': { user_id: WEB_USER.id, expires_at: new Date(Date.now() - DAY) },
};

function collapse(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function makeMockPool() {
  async function query(rawSql, params = []) {
    const sql = collapse(rawSql);

    // optionalSessionAuth's session-cookie resolution.
    if (sql.includes('FROM sessions s JOIN users u')) {
      const s = SESSIONS[params[0]];
      if (!s) return { rows: [] };
      return {
        rows: [{
          user_id: s.user_id,
          expires_at: s.expires_at,
          username: WEB_USER.username,
          is_admin: WEB_USER.is_admin,
        }],
      };
    }

    // /challenges: current-active-season resolution (no scope params).
    if (sql.includes('WHERE internal = FALSE AND is_active = TRUE AND starts_at <= NOW()')) {
      return { rows: [] }; // no current season -> handler returns data: []
    }

    // /seasons: the top-level season list (public filter, newest first).
    if (sql.includes('SELECT id, name, description, starts_at, ends_at, is_active FROM seasons')) {
      return { rows: [] };
    }

    // /me/breakdown: display-name row for the AUTHENTICATED user.
    if (sql.includes('SELECT discord, display_name, email, telegram FROM users WHERE id = $1')) {
      if (Number(params[0]) !== WEB_USER.id) return { rows: [] };
      return {
        rows: [{
          discord: WEB_USER.discord,
          display_name: WEB_USER.display_name,
          email: WEB_USER.email,
          telegram: WEB_USER.telegram,
        }],
      };
    }

    // /me/breakdown global scope: public seasons list.
    if (sql.includes('SELECT id, name FROM seasons WHERE internal = FALSE ORDER BY display_order')) {
      return { rows: [] };
    }

    throw new Error(`Unhandled mock query: ${sql}`);
  }
  return { query };
}

// ─── Test app wiring (same require-cache swap as the mobile-data tests) ─

function withApp(fn) {
  const poolModulePath = require.resolve('../src/db/pool');
  const original = require.cache[poolModulePath];
  require.cache[poolModulePath] = {
    exports: { getPool: () => makeMockPool() },
    loaded: true, id: poolModulePath, filename: poolModulePath, paths: original ? original.paths : [],
  };
  const mobileModulePath = require.resolve('../src/routes/topochain/mobile');
  delete require.cache[mobileModulePath];
  try {
    const { topochainMobileRoutes } = require('../src/routes/topochain/mobile');
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(topochainMobileRoutes({ databaseUrl: 'postgres://fake/fake', env: 'test' }));
    return fn(app);
  } finally {
    if (original) require.cache[poolModulePath] = original;
    else delete require.cache[poolModulePath];
    delete require.cache[mobileModulePath];
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

function sessionCookie(token) {
  return { cookie: `session=${token}` };
}

// ─── 1. Session gating ────────────────────────────────────────────────

test('anonymous request is refused with 401', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/challenges-api/seasons`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.success, false);
  });
});

test('expired session is refused with 401', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/challenges-api/seasons`, {
      headers: sessionCookie('expired-session'),
    });
    assert.equal(res.status, 401);
  });
});

test('valid session reads succeed with the v4 envelope', async () => {
  await withServer(async (base) => {
    for (const p of ['/challenges-api/seasons', '/challenges-api/challenges']) {
      const res = await fetch(`${base}${p}`, {
        headers: sessionCookie('good-session'),
      });
      assert.equal(res.status, 200, p);
      const body = await res.json();
      assert.equal(body.success, true, p);
      assert.deepEqual(body.data, [], p);
    }
  });
});

// ─── 2. /me/* identity comes from the session, not the client ─────────

test('/me/breakdown scopes to the session user', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/challenges-api/me/breakdown`, {
      headers: sessionCookie('good-session'),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.display_name, WEB_USER.display_name);
    assert.equal(body.data.scope, 'global');
  });
});

test('a client-claimed participant_id param is ignored', async () => {
  await withServer(async (base) => {
    const res = await fetch(
      `${base}/challenges-api/me/breakdown?participant_id=999`, {
        headers: sessionCookie('good-session'),
      });
    assert.equal(res.status, 200);
    const body = await res.json();
    // Still the SESSION user's data — the param must have no effect
    // (the mock pool returns no rows for any id but WEB_USER.id).
    assert.equal(body.data.display_name, WEB_USER.display_name);
  });
});

// ─── 3. Allowlist contract: off-list + non-GET -> 404 ─────────────────

test('off-allowlist paths under /challenges-api 404', async () => {
  await withServer(async (base) => {
    for (const p of ['/challenges-api/register', '/challenges-api/me',
      '/challenges-api/wallet', '/challenges-api/']) {
      const res = await fetch(`${base}${p}`, {
        headers: sessionCookie('good-session'),
      });
      assert.equal(res.status, 404, p);
      const body = await res.json();
      assert.equal(body.success, false, p);
    }
  });
});

test('non-GET methods under /challenges-api 404', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/challenges-api/seasons`, {
      method: 'POST',
      headers: sessionCookie('good-session'),
    });
    assert.equal(res.status, 404);
  });
});

// ─── 4. The mobile twins still demand a bearer token ──────────────────

test('a web session cookie does NOT open /api/v4/mobile', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/v4/mobile/seasons`, {
      headers: sessionCookie('good-session'),
    });
    assert.equal(res.status, 401);
  });
});

// ─── 5. The server.js proxy is gone (source pin) ──────────────────────

test('server.js no longer contains the challenges proxy', () => {
  const serverSrc = fs.readFileSync(
    path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(!serverSrc.includes('CHALLENGES_UPSTREAM_BASE'),
    'the external-upstream constant must be gone');
  assert.ok(!serverSrc.includes("app.use('/challenges-api'"),
    'the proxy handler must be gone');
});
