// Topochain v4 admin API — read-only delegations list
// (GET /api/v4/admin/delegations).
//
// Same "fake Postgres" idiom as tests/topochain-admin-api2.test.js and
// the delegation-specific mock in tests/topochain-partner-api.test.js:
// rows as plain arrays, one startsWith-dispatching `handleQuery`. Every
// test drives the FULL composer app (topochainAdminRoutes) rather than
// the submodule factory, so the router-wide adminReadGate and the
// composer registration are exercised on every request — a route that
// exists but was never mounted in admin.js fails here.
//
// Run with: node --test tests/topochain-admin-delegations.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// Same require.cache indirection as the other admin test files — install
// the wrapper BEFORE requiring the admin composer below.
const poolMod = require('../src/db/pool');
let currentMockPool = null;
poolMod.getPool = () => currentMockPool;

const { topochainAdminRoutes } = require('../src/routes/topochain/admin');

// ─── Fixtures ───────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const T = (offsetDays) => new Date(NOW + offsetDays * DAY);

// Three delegation periods: one open on an account owned by a user, one
// closed on an unassigned account, and one open on an account that no
// longer exists in onchain_accounts (deliberately representable — the
// table has no FK on `account`).
//
// The open account's address exists THREE times in onchain_accounts (the
// per-season-event duplication production exhibits — one address, many
// rows, different claimants): the endpoint's lateral must resolve it to
// the claimed row with the most recent used_at (id 400 / user 7), never
// fan the one period out into three list rows.
let delegationRows;
let onchainAccounts;
let userRows;
let avatarRows;

const AVATAR_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function resetFixtures() {
  delegationRows = [
    { id: 1, account: 'ut1open0000000000000000000000000000000000', started_at: T(-5), ended_at: null, created_at: T(-5), updated_at: T(-5) },
    { id: 2, account: 'ut1closed00000000000000000000000000000000', started_at: T(-20), ended_at: T(-10), created_at: T(-20), updated_at: T(-10) },
    { id: 3, account: 'ut1orphan00000000000000000000000000000000', started_at: T(-2), ended_at: null, created_at: T(-2), updated_at: T(-2) },
  ];
  onchainAccounts = [
    { id: 350, address: 'ut1open0000000000000000000000000000000000', user_id: 5, is_used: true, used_at: T(-40) },
    { id: 400, address: 'ut1open0000000000000000000000000000000000', user_id: 7, is_used: true, used_at: T(-6) },
    { id: 410, address: 'ut1open0000000000000000000000000000000000', user_id: null, is_used: false, used_at: null },
    { id: 401, address: 'ut1closed00000000000000000000000000000000', user_id: null, is_used: false, used_at: null },
  ];
  userRows = [
    { id: 5, username: 'past-claimant', display_name: null },
    { id: 7, username: 'current-claimant', display_name: 'Current Claimant' },
  ];
  avatarRows = [
    { id: AVATAR_ID, user_id: 7 },
  ];
}

// ─── Mock pool ──────────────────────────────────────────────────────────

function collapse(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function filterRows(sql, params) {
  let rows = delegationRows.slice();
  if (sql.includes('adp.ended_at IS NULL')) rows = rows.filter((r) => r.ended_at == null);
  if (sql.includes('adp.ended_at IS NOT NULL')) rows = rows.filter((r) => r.ended_at != null);
  const ilike = /adp\.account ILIKE \$(\d+)/.exec(sql);
  if (ilike) {
    const needle = String(params[Number(ilike[1]) - 1]).replace(/%/g, '').toLowerCase();
    rows = rows.filter((r) => r.account.toLowerCase().includes(needle));
  }
  return rows;
}

function handleQuery(rawSql, params = []) {
  const sql = collapse(rawSql);

  if (sql.startsWith('SELECT COUNT(*)::int AS c FROM account_delegation_periods adp')) {
    return { rows: [{ c: filterRows(sql, params).length }] };
  }

  if (sql.startsWith('SELECT') && sql.includes('FROM account_delegation_periods adp')) {
    const limit = params[params.length - 2];
    const offset = params[params.length - 1];
    const rows = filterRows(sql, params)
      .sort((a, b) => (b.started_at - a.started_at) || (a.id - b.id))
      .slice(offset, offset + limit)
      .map((r) => {
        // The route's LATERAL: one account row per period, claimed rows
        // first, most recent claim first, newest id as the tie-break.
        const oa = onchainAccounts
          .filter((a) => a.address === r.account)
          .sort((a, b) => (Number(b.is_used) - Number(a.is_used))
            || ((b.used_at ? b.used_at.getTime() : -Infinity) - (a.used_at ? a.used_at.getTime() : -Infinity))
            || (b.id - a.id))[0] || null;
        const u = (oa && oa.user_id != null && userRows.find((x) => x.id === oa.user_id)) || null;
        const av = (u && avatarRows.find((x) => x.user_id === u.id)) || null;
        return {
          ...r,
          onchain_account_id: oa ? oa.id : null,
          user_id: oa ? oa.user_id : null,
          username: u ? u.username : null,
          display_name: u ? u.display_name : null,
          avatar_id: av ? av.id : null,
        };
      });
    return { rows };
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

// ─── App builder ────────────────────────────────────────────────────────

function userMiddleware(role) {
  return (req, _res, next) => {
    if (role === 'anon') { next(); return; }
    if (role === 'user') { req.user = { id: 900, username: 'plain', isAdmin: false, canAdminWrite: false }; next(); return; }
    if (role === 'readonly') { req.user = { id: 901, username: 'ro-admin', isAdmin: true, canAdminWrite: false }; next(); return; }
    req.user = { id: 902, username: 'full-admin', isAdmin: true, canAdminWrite: true };
    next();
  };
}

function buildApp(role) {
  const app = express();
  app.use(express.json());
  app.use(userMiddleware(role));
  app.use(topochainAdminRoutes({}));
  return app;
}

async function listen(app) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test.beforeEach(() => {
  resetFixtures();
  currentMockPool = makeMockPool();
});

// ─── Auth + registration ────────────────────────────────────────────────

test('non-admin gets the SPEC 403 body; a view-only admin can read (no write gate on a read-only surface)', async () => {
  const denied = await listen(buildApp('user'));
  try {
    const res = await fetch(`${denied.base}/api/v4/admin/delegations`);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { success: false, error: 'Unauthorized. Admin access required.' });
  } finally { denied.server.close(); }

  const ro = await listen(buildApp('readonly'));
  try {
    const res = await fetch(`${ro.base}/api/v4/admin/delegations`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).success, true);
  } finally { ro.server.close(); }
});

// ─── Index ──────────────────────────────────────────────────────────────

test('index returns every period (open AND closed) ordered started_at DESC, with the admin data+meta envelope', async () => {
  const { server, base } = await listen(buildApp('admin'));
  try {
    const res = await fetch(`${base}/api/v4/admin/delegations`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.deepEqual(body.data.map((r) => r.id), [3, 1, 2]); // started_at DESC
    assert.deepEqual(body.meta, { page: 1, per_page: 25, total: 3, total_pages: 1 });

    const open = body.data.find((r) => r.id === 1);
    assert.equal(open.account, 'ut1open0000000000000000000000000000000000');
    assert.equal(open.delegated, true);
    assert.equal(open.ended_at, null);
    assert.match(open.started_at, /\+00:00$/); // iso() rendering
    assert.match(open.updated_at, /\+00:00$/);

    const closed = body.data.find((r) => r.id === 2);
    assert.equal(closed.delegated, false);
    assert.match(closed.ended_at, /\+00:00$/);
  } finally { server.close(); }
});

test('index resolves ONE current claimant per period: no fan-out over duplicate addresses, delegator carries the user identity', async () => {
  const { server, base } = await listen(buildApp('admin'));
  try {
    const body = await (await fetch(`${base}/api/v4/admin/delegations`)).json();

    // Three onchain_accounts rows share the open address; the period must
    // still appear exactly once, resolved to the claimed row with the most
    // recent used_at — not the older claim (id 350) or the unclaimed
    // duplicate (id 410), and total stays in step with the visible rows.
    assert.deepEqual(body.data.map((r) => r.id), [3, 1, 2]);
    assert.equal(body.meta.total, 3);

    const owned = body.data.find((r) => r.id === 1);
    assert.equal(owned.onchain_account_id, 400);
    assert.equal(owned.user_id, 7);
    assert.deepEqual(owned.delegator, {
      user_id: 7,
      username: 'current-claimant',
      display_name: 'Current Claimant',
      avatar_url: `/avatars/${AVATAR_ID}`,
    });

    const unassigned = body.data.find((r) => r.id === 2);
    assert.equal(unassigned.onchain_account_id, 401);
    assert.equal(unassigned.user_id, null);
    assert.equal(unassigned.delegator, null);

    const orphan = body.data.find((r) => r.id === 3);
    assert.equal(orphan.onchain_account_id, null);
    assert.equal(orphan.user_id, null);
    assert.equal(orphan.delegator, null);
  } finally { server.close(); }
});

test('a delegator without an avatar row gets avatar_url null, not a broken path', async () => {
  avatarRows = [];
  const { server, base } = await listen(buildApp('admin'));
  try {
    const body = await (await fetch(`${base}/api/v4/admin/delegations`)).json();
    const owned = body.data.find((r) => r.id === 1);
    assert.equal(owned.delegator.username, 'current-claimant');
    assert.equal(owned.delegator.avatar_url, null);
  } finally { server.close(); }
});

test('status filter: delegated -> open only, ended -> closed only, all -> everything, anything else -> 422', async () => {
  const { server, base } = await listen(buildApp('admin'));
  try {
    const open = await (await fetch(`${base}/api/v4/admin/delegations?status=delegated`)).json();
    assert.deepEqual(open.data.map((r) => r.id), [3, 1]);
    assert.equal(open.meta.total, 2);

    const ended = await (await fetch(`${base}/api/v4/admin/delegations?status=ended`)).json();
    assert.deepEqual(ended.data.map((r) => r.id), [2]);

    const all = await (await fetch(`${base}/api/v4/admin/delegations?status=all`)).json();
    assert.equal(all.meta.total, 3);

    const bad = await fetch(`${base}/api/v4/admin/delegations?status=bogus`);
    assert.equal(bad.status, 422);
    const badBody = await bad.json();
    assert.equal(badBody.success, false);
    assert.ok(badBody.details.status);
  } finally { server.close(); }
});

test('search matches the account address case-insensitively as a substring', async () => {
  const { server, base } = await listen(buildApp('admin'));
  try {
    const body = await (await fetch(`${base}/api/v4/admin/delegations?search=OPEN`)).json();
    assert.deepEqual(body.data.map((r) => r.id), [1]);
    assert.equal(body.meta.total, 1);
  } finally { server.close(); }
});

test('pagination: per_page=1 pages through in started_at DESC order; per_page=0 -> 422 (shared paginate guard)', async () => {
  const { server, base } = await listen(buildApp('admin'));
  try {
    const p2 = await (await fetch(`${base}/api/v4/admin/delegations?per_page=1&page=2`)).json();
    assert.deepEqual(p2.data.map((r) => r.id), [1]);
    assert.deepEqual(p2.meta, { page: 2, per_page: 1, total: 3, total_pages: 3 });

    const bad = await fetch(`${base}/api/v4/admin/delegations?per_page=0`);
    assert.equal(bad.status, 422);
  } finally { server.close(); }
});
