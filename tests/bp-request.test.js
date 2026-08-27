// Block-producer queue endpoints (onboarding flow alignment). Producing
// blocks is a released capability: an account asks once
// (POST bp/request sets bp_requested_at), an admin releases keys from the
// BP queue (bp_released_at), and the mobile app's node gates
// blockProducerSecretKey on the bp_released flag it reads from
// /api/v4/mobile/me. Both surfaces are exercised: the /challenges-api
// session-cookie twins (SV settings UI) and the bearer-token mobile /me.
//
// Contracts guarded here:
//
//   1. /challenges-api/bp/* are session-gated (401 anonymous), and
//      identity comes from the session row only.
//   2. bp/state reports {has_platform_access, bp_requested, bp_released}
//      derived from the user row; admins count as having access.
//   3. bp/request is idempotent — asking twice keeps the original
//      bp_requested_at — and reports the current release state.
//   4. GET /api/v4/mobile/me carries the same three fields for the
//      native side (bp_released is part of managed runtime admission).
//
// HTTP-level tests against a throwaway express app + a substring-
// dispatching mock pool (same idiom as tests/challenges-web-routes.test.js).
//
// Run with: node --test tests/bp-request.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const cookieParser = require('cookie-parser');

// ─── Fixtures ─────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;

function makeUsers() {
  return {
    1: {
      id: 1, username: 'released-bp', email: 'bp@example.com', display_name: 'BP',
      email_confirmed: true, is_in_waitlist: false, github: null, x: null,
      password_set: true, is_admin: false,
      has_platform_access: true,
      bp_requested_at: new Date(Date.now() - DAY),
      bp_released_at: new Date(),
    },
    2: {
      id: 2, username: 'fresh', email: 'fresh@example.com', display_name: 'Fresh',
      email_confirmed: true, is_in_waitlist: false, github: null, x: null,
      password_set: true, is_admin: false,
      has_platform_access: true,
      bp_requested_at: null,
      bp_released_at: null,
    },
  };
}

const SESSIONS = {
  'released-session': { user_id: 1, expires_at: new Date(Date.now() + DAY) },
  'fresh-session': { user_id: 2, expires_at: new Date(Date.now() + DAY) },
};

const MOBILE_TOKEN = 'raw-mobile-token';
const MOBILE_TOKEN_HASH = crypto.createHash('sha256').update(MOBILE_TOKEN).digest('hex');

function collapse(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function makeMockPool(users) {
  async function query(rawSql, params = []) {
    const sql = collapse(rawSql);

    // optionalSessionAuth (the /challenges-api web twins).
    if (sql.includes('FROM sessions s JOIN users u')) {
      const s = SESSIONS[params[0]];
      if (!s) return { rows: [] };
      const u = users[s.user_id];
      return {
        rows: [{
          user_id: u.id, expires_at: s.expires_at,
          username: u.username, is_admin: u.is_admin,
        }],
      };
    }

    // mobileTokenAuth (bearer token for /api/v4/mobile/me). Token 1 maps
    // to the released user.
    if (sql.includes('FROM native_session_credentials c')
        && sql.includes('JOIN mobile_auth_tokens t')
        && sql.includes('JOIN users u')) {
      if (params[0] !== MOBILE_TOKEN_HASH) return { rows: [] };
      const expiresAt = new Date(Date.now() + DAY);
      return {
        rows: [{
          id: 100, user_id: 1, ability: 'session',
          expires_at: expiresAt,
          credential_reference: `nsc_${'A'.repeat(43)}`,
          credential_generation: 1,
          installation_id: `nsi_${'B'.repeat(43)}`,
          credential_expires_at: expiresAt,
          renewal_due: false,
          username: users[1].username,
        }],
      };
    }

    // bp/state's user-row read.
    if (sql.includes('SELECT is_admin, has_platform_access, bp_requested_at, bp_released_at FROM users')) {
      const u = users[params[0]];
      return { rows: u ? [{ ...u }] : [] };
    }

    // bp/request's idempotent stamp.
    if (sql.includes('SET bp_requested_at = COALESCE(bp_requested_at, NOW())')) {
      const u = users[params[0]];
      if (!u) return { rows: [] };
      u.bp_requested_at = u.bp_requested_at || new Date();
      return { rows: [{ bp_requested_at: u.bp_requested_at, bp_released_at: u.bp_released_at }] };
    }

    // /me's full user-row read.
    if (sql.includes('is_admin, has_platform_access, bp_requested_at, bp_released_at FROM users WHERE id = $1')) {
      const u = users[params[0]];
      return { rows: u ? [{ ...u }] : [] };
    }

    // computeLevel's operator probe.
    if (sql.includes('SELECT 1 FROM onchain_accounts WHERE user_id = $1')) {
      return { rows: [] }; // no custodial account -> member
    }

    throw new Error(`Unhandled mock query: ${sql}`);
  }
  return { query };
}

// ─── Test app wiring (require-cache swap, same idiom as sibling tests) ─

function withApp(fn) {
  const users = makeUsers();
  const poolModulePath = require.resolve('../src/db/pool');
  const original = require.cache[poolModulePath];
  require.cache[poolModulePath] = {
    exports: { getPool: () => makeMockPool(users) },
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
    return fn(app, users);
  } finally {
    if (original) require.cache[poolModulePath] = original;
    else delete require.cache[poolModulePath];
    delete require.cache[mobileModulePath];
  }
}

async function withServer(fn) {
  return withApp(async (app, users) => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await fn(base, users);
    } finally {
      server.close();
    }
  });
}

function sessionHeaders(token) {
  return { cookie: `session=${token}` };
}

// ─── 1. Session gating ────────────────────────────────────────────────

test('anonymous bp/state and bp/request are refused with 401', async () => {
  await withServer(async (base) => {
    const state = await fetch(`${base}/challenges-api/bp/state`);
    assert.equal(state.status, 401);
    const request = await fetch(`${base}/challenges-api/bp/request`, { method: 'POST' });
    assert.equal(request.status, 401);
  });
});

// ─── 2. bp/state reflects the user row ────────────────────────────────

test('bp/state reports request + release flags per user', async () => {
  await withServer(async (base) => {
    const released = await fetch(`${base}/challenges-api/bp/state`, {
      headers: sessionHeaders('released-session'),
    });
    assert.equal(released.status, 200);
    assert.deepEqual((await released.json()).data, {
      has_platform_access: true, bp_requested: true, bp_released: true,
    });

    const fresh = await fetch(`${base}/challenges-api/bp/state`, {
      headers: sessionHeaders('fresh-session'),
    });
    assert.deepEqual((await fresh.json()).data, {
      has_platform_access: true, bp_requested: false, bp_released: false,
    });
  });
});

// ─── 3. bp/request is idempotent ──────────────────────────────────────

test('bp/request stamps once; asking again keeps the original request time', async () => {
  await withServer(async (base, users) => {
    const first = await fetch(`${base}/challenges-api/bp/request`, {
      method: 'POST', headers: sessionHeaders('fresh-session'),
    });
    assert.equal(first.status, 200);
    assert.deepEqual((await first.json()).data, { bp_requested: true, bp_released: false });
    const stamped = users[2].bp_requested_at;
    assert.ok(stamped);

    const again = await fetch(`${base}/challenges-api/bp/request`, {
      method: 'POST', headers: sessionHeaders('fresh-session'),
    });
    assert.equal(again.status, 200);
    assert.equal(users[2].bp_requested_at, stamped);
  });
});

// ─── 4. The mobile /me carries the native gating fields ───────────────

test('GET /api/v4/mobile/me exposes has_platform_access, bp_requested, bp_released', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/v4/mobile/me`, {
      headers: { authorization: `Bearer ${MOBILE_TOKEN}` },
    });
    assert.equal(res.status, 200);
    const { data } = await res.json();
    assert.equal(data.id, 1);
    assert.equal(data.has_platform_access, true);
    assert.equal(data.bp_requested, true);
    assert.equal(data.bp_released, true);
  });
});

test('a web session cookie alone does not open the mobile /me', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/v4/mobile/me`, {
      headers: sessionHeaders('released-session'),
    });
    assert.equal(res.status, 401);
  });
});
