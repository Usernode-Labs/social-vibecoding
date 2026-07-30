// POST /api/v4/mobile/wallet/provision — the platform-auth replacement for
// the retired v2 /register account allocation. Same idiom as
// tests/topochain-mobile-data2.test.js: HTTP-level tests against a
// throwaway express app + a substring-dispatching mock pool (no live DB),
// with auth through the REAL mobileTokenAuth middleware against a seeded
// `mobile_auth_tokens` fixture. Mutable fixture state (onchain_accounts
// and user_enrollments get written to) follows the reset-before-each
// pattern.
//
// Run with: node --test tests/topochain-mobile-wallet.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const T = (offsetDays) => new Date(NOW + offsetDays * DAY);

function collapse(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

// ─── Fixtures ───────────────────────────────────────────────────────────

const USERS = [
  { id: 1, email: 'fresh@example.com' }, // no account, no enrollment
  { id: 2, email: 'migrated@example.com' }, // event-scoped account + enrollment (topochain import)
  { id: 3, email: 'both@example.com' }, // season-wide AND event-scoped accounts
  { id: 4, email: 'late@example.com' }, // fresh user hitting an exhausted pool
];

const TOKENS = [
  { user_id: 1, raw: 'fresh-token' },
  { user_id: 2, raw: 'migrated-token' },
  { user_id: 3, raw: 'both-token' },
  { user_id: 4, raw: 'late-token' },
].map((t) => ({ ...t, token_hash: crypto.createHash('sha256').update(t.raw).digest('hex'), ability: 'session', expires_at: T(1) }));

// Season 10: the current active public season. Season 20: internal (must
// never be picked by the fallback).
const SEASONS = [
  { id: 10, internal: false, is_active: true, starts_at: T(-30), ends_at: T(30) },
  { id: 20, internal: true, is_active: true, starts_at: T(-30), ends_at: T(30) },
];

// Reset per test. Accounts 100/101: unused season-scoped pool for season
// 10. Account 200: user 2's event-scoped allocation. Accounts 300/301:
// user 3's event-scoped + season-wide pair (season-wide must win).
function initialAccounts() {
  return [
    { id: 100, address: 'ut1pool0', public_key: 'utpk1pool0', secret_key: 'utsk1pool0', season_id: 10, season_event_id: null, user_id: null, is_used: false },
    { id: 101, address: 'ut1pool1', public_key: 'utpk1pool1', secret_key: 'utsk1pool1', season_id: 10, season_event_id: null, user_id: null, is_used: false },
    { id: 200, address: 'ut1migrated', public_key: 'utpk1migrated', secret_key: 'utsk1migrated', season_id: 10, season_event_id: 100, user_id: 2, is_used: true },
    { id: 300, address: 'ut1both-event', public_key: 'utpk1both-event', secret_key: 'utsk1both-event', season_id: 10, season_event_id: 100, user_id: 3, is_used: true },
    { id: 301, address: 'ut1both-season', public_key: 'utpk1both-season', secret_key: 'utsk1both-season', season_id: 10, season_event_id: null, user_id: 3, is_used: true },
  ];
}

function initialEnrollments() {
  return [
    { id: 1, user_id: 2, season_id: 10, season_event_id: 100 },
    { id: 2, user_id: 3, season_id: 10, season_event_id: null },
  ];
}

let accounts = initialAccounts();
let enrollments = initialEnrollments();
let nextEnrollmentId = 10;

function resetState() {
  accounts = initialAccounts();
  enrollments = initialEnrollments();
  nextEnrollmentId = 10;
  global.__noCurrentSeason = false;
}

// ─── Mock pool ──────────────────────────────────────────────────────────

function handleQuery(rawSql, params = []) {
  const sql = collapse(rawSql);

  if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };

  // mobileTokenAuth.
  if (sql.startsWith('SELECT t.id, t.user_id, t.ability, t.expires_at, u.username FROM mobile_auth_tokens')) {
    const tok = TOKENS.find((t) => t.token_hash === params[0]);
    if (!tok) return { rows: [] };
    const user = USERS.find((u) => u.id === tok.user_id);
    return { rows: [{ id: tok.user_id, user_id: tok.user_id, ability: tok.ability, expires_at: tok.expires_at, username: user.email }] };
  }
  if (sql.startsWith('UPDATE mobile_auth_tokens SET last_used_at')) return { rows: [] };

  // Current active public season fallback.
  if (sql.startsWith('SELECT id FROM seasons WHERE internal = FALSE AND is_active = TRUE')) {
    if (global.__noCurrentSeason) return { rows: [] };
    const now = Date.now();
    const rows = SEASONS.filter((s) => !s.internal && s.is_active && s.starts_at.getTime() <= now && s.ends_at.getTime() >= now)
      .sort((a, b) => b.starts_at - a.starts_at || b.id - a.id);
    return { rows: rows.length ? [{ id: rows[0].id }] : [] };
  }

  // Existing allocation lookup (season-wide first, then id).
  if (sql.startsWith('SELECT id, address, public_key, secret_key, season_event_id FROM onchain_accounts WHERE user_id = $1 AND season_id = $2')) {
    const rows = accounts
      .filter((a) => a.user_id === params[0] && a.season_id === params[1])
      .sort((a, b) => Number(b.season_event_id == null) - Number(a.season_event_id == null) || a.id - b.id)
      .slice(0, 1)
      .map((a) => ({ id: a.id, address: a.address, public_key: a.public_key, secret_key: a.secret_key, season_event_id: a.season_event_id }));
    return { rows };
  }

  // Unused pool claim.
  if (sql.startsWith('SELECT id, address, public_key, secret_key, season_event_id FROM onchain_accounts WHERE user_id IS NULL AND is_used = FALSE')) {
    const rows = accounts
      .filter((a) => a.user_id == null && !a.is_used && a.season_id === params[0] && a.season_event_id == null)
      .sort((a, b) => a.id - b.id)
      .slice(0, 1)
      .map((a) => ({ id: a.id, address: a.address, public_key: a.public_key, secret_key: a.secret_key, season_event_id: a.season_event_id }));
    return { rows };
  }
  if (sql.startsWith('UPDATE onchain_accounts SET user_id = $1, is_used = TRUE, used_at = NOW()')) {
    const row = accounts.find((a) => a.id === params[1]);
    row.user_id = params[0];
    row.is_used = true;
    row.used_at = new Date();
    return { rows: [] };
  }

  // Enrollment check + insert.
  if (sql.startsWith('SELECT id FROM user_enrollments WHERE user_id = $1 AND season_id = $2')) {
    const row = enrollments.find((e) => e.user_id === params[0] && e.season_id === params[1]);
    return { rows: row ? [{ id: row.id }] : [] };
  }
  if (sql.startsWith('INSERT INTO user_enrollments (season_event_id, user_id, season_id, registered_at')) {
    enrollments.push({ id: nextEnrollmentId++, user_id: params[0], season_id: params[1], season_event_id: null });
    return { rows: [] };
  }

  throw new Error(`Unhandled mock query: ${sql}`);
}

function makeMockPool() {
  return {
    query: async (sql, params) => handleQuery(sql, params),
    connect: async () => ({
      query: async (sql, params) => handleQuery(sql, params),
      release: () => {},
    }),
  };
}

// ─── Test app wiring (same swap-in-require-cache idiom as data2) ────────

function withApp(configOverrides, fn) {
  const poolModulePath = require.resolve('../src/db/pool');
  const mobileModulePath = require.resolve('../src/routes/topochain/mobile');
  const mockPool = makeMockPool();
  const original = require.cache[poolModulePath];
  require.cache[poolModulePath] = {
    exports: { getPool: () => mockPool },
    loaded: true, id: poolModulePath, filename: poolModulePath, paths: original ? original.paths : [],
  };
  delete require.cache[mobileModulePath];
  try {
    const { topochainMobileRoutes } = require('../src/routes/topochain/mobile');
    const app = express();
    app.use(express.json());
    app.use(topochainMobileRoutes({ databaseUrl: 'postgres://fake/fake', env: 'test', ...configOverrides }));
    return fn(app);
  } finally {
    if (original) require.cache[poolModulePath] = original;
    else delete require.cache[poolModulePath];
    delete require.cache[mobileModulePath];
  }
}

async function withServer(fn) {
  return withApp({}, async (app) => {
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

function bearer(raw) {
  return { authorization: `Bearer ${raw}` };
}
const FRESH = bearer('fresh-token');
const MIGRATED = bearer('migrated-token');
const BOTH = bearer('both-token');
const LATE = bearer('late-token');

function provision(base, headers) {
  return fetch(`${base}/api/v4/mobile/wallet/provision`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(headers || {}) }, body: '{}',
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────

test('provision requires a session token', async () => {
  resetState();
  await withServer(async (base) => {
    const resp = await provision(base);
    assert.equal(resp.status, 401);
  });
});

test('fresh user is allocated an unused pool account and enrolled season-wide', async () => {
  resetState();
  await withServer(async (base) => {
    const resp = await provision(base, FRESH);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.success, true);
    assert.equal(body.data.address, 'ut1pool0');
    assert.equal(body.data.public_key, 'utpk1pool0');
    assert.equal(body.data.secret_key, 'utsk1pool0');
    assert.equal(body.data.season_id, 10);
    assert.equal(body.data.season_event_id, null);
    assert.equal(body.data.newly_allocated, true);

    const claimed = accounts.find((a) => a.id === 100);
    assert.equal(claimed.user_id, 1);
    assert.equal(claimed.is_used, true);
    assert.ok(claimed.used_at instanceof Date);

    const enrollment = enrollments.find((e) => e.user_id === 1 && e.season_id === 10);
    assert.ok(enrollment, 'season-wide enrollment created');
    assert.equal(enrollment.season_event_id, null);
  });
});

test('provision is idempotent: a second call returns the same account without consuming the pool', async () => {
  resetState();
  await withServer(async (base) => {
    const first = await (await provision(base, FRESH)).json();
    const second = await (await provision(base, FRESH)).json();
    assert.equal(second.data.address, first.data.address);
    assert.equal(second.data.newly_allocated, false);

    // Only one pool account consumed, only one enrollment created.
    assert.equal(accounts.filter((a) => a.user_id === 1).length, 1);
    assert.equal(enrollments.filter((e) => e.user_id === 1).length, 1);
  });
});

test('migrated user gets their existing event-scoped account back, untouched', async () => {
  resetState();
  await withServer(async (base) => {
    const resp = await provision(base, MIGRATED);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.data.address, 'ut1migrated');
    assert.equal(body.data.secret_key, 'utsk1migrated');
    assert.equal(body.data.season_event_id, 100);
    assert.equal(body.data.newly_allocated, false);

    // Pool untouched, no duplicate enrollment (event-scoped one counts).
    assert.equal(accounts.filter((a) => a.user_id == null).length, 2);
    assert.equal(enrollments.filter((e) => e.user_id === 2).length, 1);
  });
});

test('season-wide account is preferred over an event-scoped one', async () => {
  resetState();
  await withServer(async (base) => {
    const body = await (await provision(base, BOTH)).json();
    assert.equal(body.data.address, 'ut1both-season');
    assert.equal(body.data.season_event_id, null);
  });
});

test('409 when the season pool is exhausted', async () => {
  resetState();
  // Hand both pool accounts to other users.
  for (const a of accounts) {
    if (a.user_id == null) { a.user_id = 99; a.is_used = true; }
  }
  await withServer(async (base) => {
    const resp = await provision(base, LATE);
    assert.equal(resp.status, 409);
    const body = await resp.json();
    assert.equal(body.success, false);
    assert.match(body.error, /No on-chain accounts are available/);
  });
});

test('422 when no active public season exists', async () => {
  resetState();
  global.__noCurrentSeason = true;
  await withServer(async (base) => {
    const resp = await provision(base, FRESH);
    assert.equal(resp.status, 422);
  });
  global.__noCurrentSeason = false;
});
