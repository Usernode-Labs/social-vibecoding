// GET /challenges-api/me/challenge-items (#7152) — the web session twin the
// challenge page's itemized list reads. HTTP-level tests against a throwaway
// express app, the idiom of tests/challenge-invites-route.test.js: what is
// under test here is the ROUTE (session gating, the envelope, the param and
// not-found contracts, and that the read is scoped to the session user). The
// statuses themselves are pinned against a real PostgreSQL in
// tests/challenge-items-postgres.test.js.
//
// Run with: node --test tests/challenge-items-route.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');

const DAY = 24 * 60 * 60 * 1000;

const SESSIONS = {
  maker: { user_id: 1, expires_at: new Date(Date.now() + DAY) },
  other: { user_id: 2, expires_at: new Date(Date.now() + DAY) },
};

const DATA = {
  measure: 'USEFUL_FEEDBACK',
  target: 4,
  weekly: false,
  items: [{
    key: 'feedback:11',
    title: 'Map won’t zoom',
    app_name: 'Plant Pal',
    at: new Date().toISOString(),
    status: 'counted',
    points: 210,
    max: 250,
    reason_text: 'says what happened and where',
    link: { kind: 'request', slug: 'plant-pal', number: 11 },
  }],
};

function collapse(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

// Only the session read reaches the pool: the service itself is stubbed.
function makeMockPool() {
  async function query(rawSql, params = []) {
    const sql = collapse(rawSql);
    if (sql.includes('FROM sessions s JOIN users u')) {
      const s = SESSIONS[params[0]];
      if (!s) return { rows: [] };
      return {
        rows: [{
          user_id: s.user_id, expires_at: s.expires_at,
          username: params[0], is_admin: false,
        }],
      };
    }
    throw new Error(`Unhandled mock query: ${sql}`);
  }
  return { query };
}

function withApp(fn) {
  const poolModulePath = require.resolve('../src/db/pool');
  const originalPool = require.cache[poolModulePath];
  require.cache[poolModulePath] = {
    exports: { getPool: () => makeMockPool() },
    loaded: true, id: poolModulePath, filename: poolModulePath, paths: originalPool ? originalPool.paths : [],
  };

  const serviceModulePath = require.resolve('../src/services/topochain/challenge-items');
  const originalService = require.cache[serviceModulePath];
  const state = { result: DATA, calls: [] };
  require.cache[serviceModulePath] = {
    exports: {
      challengeItems: async (pool, args) => {
        state.calls.push(args);
        return state.result;
      },
    },
    loaded: true, id: serviceModulePath, filename: serviceModulePath,
    paths: originalService ? originalService.paths : [],
  };

  const mobileModulePath = require.resolve('../src/routes/topochain/mobile');
  delete require.cache[mobileModulePath];
  try {
    const { topochainMobileRoutes } = require('../src/routes/topochain/mobile');
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(topochainMobileRoutes({ databaseUrl: 'postgres://fake/fake', env: 'test' }));
    return fn(app, state);
  } finally {
    if (originalPool) require.cache[poolModulePath] = originalPool;
    else delete require.cache[poolModulePath];
    if (originalService) require.cache[serviceModulePath] = originalService;
    else delete require.cache[serviceModulePath];
    delete require.cache[mobileModulePath];
  }
}

async function withServer(fn) {
  return withApp(async (app, state) => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await fn(base, state);
    } finally {
      server.close();
    }
  });
}

const sessionHeaders = { cookie: 'session=maker' };

test('signed out, the challenge-items route answers 401 and reads nothing', async () => {
  await withServer(async (base, state) => {
    const res = await fetch(`${base}/challenges-api/me/challenge-items?challenge_id=7`);
    assert.equal(res.status, 401);
    assert.equal(state.calls.length, 0);
  });
});

test('a malformed challenge_id answers 422', async () => {
  await withServer(async (base, state) => {
    for (const bad of ['abc', '0', '-3', '7.5']) {
      const res = await fetch(`${base}/challenges-api/me/challenge-items?challenge_id=${bad}`, {
        headers: sessionHeaders,
      });
      assert.equal(res.status, 422, bad);
    }
    const absent = await fetch(`${base}/challenges-api/me/challenge-items`, { headers: sessionHeaders });
    assert.equal(absent.status, 422);
    assert.equal(state.calls.length, 0);
  });
});

test('a challenge the list does not cover answers 404', async () => {
  await withServer(async (base, state) => {
    state.result = null;
    const res = await fetch(`${base}/challenges-api/me/challenge-items?challenge_id=8`, {
      headers: sessionHeaders,
    });
    assert.equal(res.status, 404);
  });
});

test('the challenge answers the envelope, scoped to the session user', async () => {
  await withServer(async (base, state) => {
    state.result = DATA;
    const res = await fetch(`${base}/challenges-api/me/challenge-items?challenge_id=7`, {
      headers: sessionHeaders,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.deepEqual(body.data, DATA);
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0].userId, SESSIONS.maker.user_id, 'the session user, not a query parameter');
    assert.equal(state.calls[0].challengeId, 7);

    // A different session reads for its own user, whatever the body says.
    state.calls.length = 0;
    const other = await fetch(`${base}/challenges-api/me/challenge-items?challenge_id=7`, {
      headers: { cookie: 'session=other' },
    });
    assert.equal(other.status, 200);
    assert.equal(state.calls[0].userId, SESSIONS.other.user_id);
  });
});
