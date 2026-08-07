// Topochain v4 admin API — seasons CRUD
// (src/routes/topochain/admin/seasons.js), the top tier of
// Season -> Season event -> Challenge and the last one to get an admin
// resource of its own.
//
// Same idiom as tests/topochain-admin-api.test.js: HTTP-level tests
// against a throwaway express app plus an in-memory "fake Postgres"
// (tables as arrays, one regex/startsWith-dispatching `handleQuery`).
// Kept in its own file rather than appended to that one because the
// interesting behaviour here — the guarded DELETE — needs four
// referencing tables the other file's fixture doesn't model.
//
// Run with: node --test tests/topochain-admin-seasons-api.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// Install the getPool indirection BEFORE requiring any route module —
// each one destructures `getPool` at require time, so a later
// reassignment of the module property would be invisible to it. Same
// pitfall (and same fix) as tests/topochain-admin-api.test.js.
const poolMod = require('../src/db/pool');
let currentMockPool = null;
poolMod.getPool = () => currentMockPool;

const { seasonsAdminRoutes } = require('../src/routes/topochain/admin/seasons');
const { topochainAdminRoutes } = require('../src/routes/topochain/admin');

// ─── Fake Postgres ───────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const T = (offsetDays) => new Date(NOW + offsetDays * DAY);

let db;
let failNextDelete = null; // set to an Error to simulate a mid-flight FK race

function freshDb() {
  return {
    seasons: [],
    season_events: [],
    user_enrollments: [],
    onchain_accounts: [],
    token_allocation: [],
    nextSeasonId: 100000,
  };
}

function collapse(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function like(str, pattern) {
  if (!pattern) return true;
  const needle = pattern.replace(/^%|%$/g, '').toLowerCase();
  return String(str || '').toLowerCase().includes(needle);
}

// The three sub-select counts the index/show queries carry, computed the
// same way the SQL does — notably `users_count` counts SEASON-WIDE
// enrollments only (season_event_id IS NULL), so an event-scoped row
// does not double-count.
function withCounts(s, extra = {}) {
  return {
    ...s,
    season_events_count: db.season_events.filter((e) => e.season_id === s.id).length,
    users_count: db.user_enrollments.filter((e) => e.season_id === s.id && e.season_event_id == null).length,
    onchain_accounts_count: db.onchain_accounts.filter((a) => a.season_id === s.id).length,
    ...extra,
  };
}

function handleQuery(rawSql, params = []) {
  const sql = collapse(rawSql);

  if (sql.startsWith('SELECT COUNT(*)::int AS c FROM seasons WHERE')) {
    const pattern = params[0];
    return {
      rows: [{
        c: db.seasons.filter((s) => like(s.name, pattern) || like(s.description, pattern)).length,
      }],
    };
  }

  // Show BEFORE index: both start `SELECT s.*`, and only the show query
  // ends `WHERE s.id = $1`.
  if (sql.startsWith('SELECT s.*') && sql.includes('WHERE s.id = $1')) {
    const row = db.seasons.find((s) => s.id === params[0]);
    if (!row) return { rows: [] };
    return {
      rows: [withCounts(row, {
        token_allocation_count: db.token_allocation.filter((t) => t.season_id === row.id).length,
      })],
    };
  }
  if (sql.startsWith('SELECT s.*') && sql.includes('ORDER BY s.display_order ASC')) {
    const [pattern, limit, offset] = params;
    const rows = db.seasons
      .filter((s) => like(s.name, pattern) || like(s.description, pattern))
      .sort((a, b) => (a.display_order - b.display_order)
        || (new Date(b.starts_at) - new Date(a.starts_at))
        || (b.id - a.id))
      .slice(offset, offset + limit)
      .map((s) => withCounts(s));
    return { rows };
  }

  if (sql.startsWith('INSERT INTO seasons')) {
    const [name, description, startsAt, endsAt, isActive, internal, displayOrder, poolInfo] = params;
    const row = {
      id: db.nextSeasonId++,
      name,
      description,
      starts_at: startsAt,
      ends_at: endsAt,
      is_active: isActive,
      internal,
      display_order: displayOrder,
      pool_info: poolInfo,
      created_at: new Date(),
      updated_at: new Date(),
    };
    db.seasons.push(row);
    return { rows: [{ ...row }] };
  }

  if (sql === 'SELECT * FROM seasons WHERE id = $1') {
    const row = db.seasons.find((s) => s.id === params[0]);
    return { rows: row ? [{ ...row }] : [] };
  }
  if (sql === 'SELECT id FROM seasons WHERE id = $1') {
    const row = db.seasons.find((s) => s.id === params[0]);
    return { rows: row ? [{ id: row.id }] : [] };
  }

  if (sql.startsWith('UPDATE seasons SET')) {
    const row = db.seasons.find((s) => s.id === params[0]);
    if (!row) return { rows: [] };
    const setSql = sql.slice('UPDATE seasons SET'.length, sql.indexOf(' WHERE '));
    const re = /(\w+)\s*=\s*\$(\d+)/g;
    let m;
    while ((m = re.exec(setSql))) row[m[1]] = params[Number(m[2]) - 1];
    row.updated_at = new Date();
    return { rows: [{ ...row }] };
  }

  const refMatch = /^SELECT COUNT\(\*\)::int AS c FROM (\w+) WHERE season_id = \$1$/.exec(sql);
  if (refMatch) {
    const table = db[refMatch[1]];
    return { rows: [{ c: (table || []).filter((r) => r.season_id === params[0]).length }] };
  }

  if (sql === 'DELETE FROM seasons WHERE id = $1') {
    if (failNextDelete) { const e = failNextDelete; failNextDelete = null; throw e; }
    db.seasons = db.seasons.filter((s) => s.id !== params[0]);
    return { rows: [] };
  }

  throw new Error(`unhandled SQL in fake pg: ${sql}`);
}

function makeMockPool() {
  return {
    async query(sql, params) { return handleQuery(sql, params); },
    async connect() {
      return { async query(sql, params) { return handleQuery(sql, params); }, release() {} };
    },
  };
}

// ─── App builders ────────────────────────────────────────────────────────

function userMiddleware(role) {
  return (req, _res, next) => {
    if (role === 'anon') { next(); return; }
    if (role === 'user') { req.user = { id: 900, username: 'plain', isAdmin: false, canAdminWrite: false }; next(); return; }
    if (role === 'readonly') { req.user = { id: 901, username: 'ro-admin', isAdmin: true, canAdminWrite: false }; next(); return; }
    req.user = { id: 902, username: 'full-admin', isAdmin: true, canAdminWrite: true };
    next();
  };
}

function buildApp(role = 'admin', factory = seasonsAdminRoutes) {
  const app = express();
  app.use(express.json());
  app.use(userMiddleware(role));
  app.use(factory({}));
  return app;
}

async function listen(app) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function withApp(role, fn) {
  const { server, base } = await listen(buildApp(role));
  try { await fn(base); } finally { server.close(); }
}

function seedSeason(over = {}) {
  const row = {
    id: over.id ?? db.nextSeasonId++,
    name: 'Season One',
    description: null,
    starts_at: T(-10),
    ends_at: T(10),
    is_active: true,
    internal: false,
    display_order: 0,
    pool_info: null,
    created_at: T(-30),
    updated_at: T(-30),
    ...over,
  };
  db.seasons.push(row);
  return row;
}

test.beforeEach(() => {
  db = freshDb();
  failNextDelete = null;
  currentMockPool = makeMockPool();
});

// ─── Index ───────────────────────────────────────────────────────────────

test('seasons: index paginates, orders by display_order then newest, and carries the reference counts', async () => {
  const a = seedSeason({ id: 1, name: 'Alpha', display_order: 1 });
  seedSeason({ id: 2, name: 'Beta', display_order: 0 });
  db.season_events.push({ id: 10, season_id: a.id });
  db.season_events.push({ id: 11, season_id: a.id });
  // One season-wide enrollment and one event-scoped one: only the
  // season-wide row counts, or a user auto-enrolled into an event would
  // be counted twice.
  db.user_enrollments.push({ id: 20, season_id: a.id, season_event_id: null });
  db.user_enrollments.push({ id: 21, season_id: a.id, season_event_id: 10 });
  db.onchain_accounts.push({ id: 30, season_id: a.id });

  await withApp('admin', async (base) => {
    const body = await (await fetch(`${base}/api/v4/admin/seasons`)).json();
    assert.equal(body.success, true);
    assert.deepEqual(body.data.map((s) => s.name), ['Beta', 'Alpha'], 'display_order 0 sorts first');
    assert.deepEqual(body.meta, {
      page: 1, per_page: 20, total: 2, total_pages: 1,
    });

    const alpha = body.data.find((s) => s.id === 1);
    assert.equal(alpha.season_events_count, 2);
    assert.equal(alpha.users_count, 1, 'season-wide enrollments only');
    assert.equal(alpha.onchain_accounts_count, 1);
    // §4.8: dates carry a numeric offset, never a bare Z.
    assert.match(alpha.starts_at, /\+00:00$/);
  });
});

test('seasons: index search matches name OR description, and per_page is validated to 1..100', async () => {
  seedSeason({ id: 1, name: 'Alpha', description: 'the mainnet dry run' });
  seedSeason({ id: 2, name: 'Beta', description: null });

  await withApp('admin', async (base) => {
    const byName = await (await fetch(`${base}/api/v4/admin/seasons?search=beta`)).json();
    assert.deepEqual(byName.data.map((s) => s.id), [2]);

    const byDescription = await (await fetch(`${base}/api/v4/admin/seasons?search=dry%20run`)).json();
    assert.deepEqual(byDescription.data.map((s) => s.id), [1]);

    const bad = await fetch(`${base}/api/v4/admin/seasons?per_page=0`);
    assert.equal(bad.status, 422);
    const badBody = await bad.json();
    assert.equal(badBody.success, false);
    assert.equal(badBody.code, 'invalid_per_page');
  });
});

// ─── Create ──────────────────────────────────────────────────────────────

test('seasons: POST creates with 201 and the documented defaults', async () => {
  await withApp('admin', async (base) => {
    const res = await fetch(`${base}/api/v4/admin/seasons`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Season Three', starts_at: T(0).toISOString(), ends_at: T(30).toISOString(),
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.name, 'Season Three');
    assert.equal(body.data.is_active, true, 'defaults to active');
    assert.equal(body.data.internal, false);
    assert.equal(body.data.display_order, 0);
    assert.equal(body.data.pool_info, null);
    assert.equal(db.seasons.length, 1);
  });
});

test('seasons: POST 422s on a missing name/window, on ends_at <= starts_at, and on a non-integer display_order', async () => {
  await withApp('admin', async (base) => {
    const post = (payload) => fetch(`${base}/api/v4/admin/seasons`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const empty = await post({});
    assert.equal(empty.status, 422);
    const emptyBody = await empty.json();
    assert.equal(emptyBody.error, 'The given data was invalid.');
    assert.ok(emptyBody.details.name);
    assert.ok(emptyBody.details.starts_at);
    assert.ok(emptyBody.details.ends_at);

    const backwards = await post({
      name: 'Backwards', starts_at: T(10).toISOString(), ends_at: T(1).toISOString(),
    });
    assert.equal(backwards.status, 422);
    assert.deepEqual((await backwards.json()).details.ends_at,
      ['The ends_at field must be a date after starts_at.']);

    // toNumber, not bare Number(): `true` would otherwise be written as 1.
    const boolOrder = await post({
      name: 'Bool', starts_at: T(0).toISOString(), ends_at: T(1).toISOString(), display_order: true,
    });
    assert.equal(boolOrder.status, 422);
    assert.ok((await boolOrder.json()).details.display_order);

    assert.equal(db.seasons.length, 0, 'nothing was written by any of the rejected requests');
  });
});

test('seasons: a negative display_order is legal — it is a sort key, not a count', async () => {
  await withApp('admin', async (base) => {
    const res = await fetch(`${base}/api/v4/admin/seasons`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Pinned', starts_at: T(0).toISOString(), ends_at: T(1).toISOString(), display_order: -5,
      }),
    });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).data.display_order, -5);
  });
});

// ─── Show ────────────────────────────────────────────────────────────────

test('seasons: GET /:id adds token_allocation_count; an unknown or malformed id is a 404', async () => {
  seedSeason({ id: 4, name: 'Detail' });
  db.token_allocation.push({ id: 1, season_id: 4 });
  db.token_allocation.push({ id: 2, season_id: 4 });

  await withApp('admin', async (base) => {
    const body = await (await fetch(`${base}/api/v4/admin/seasons/4`)).json();
    assert.equal(body.data.token_allocation_count, 2);
    assert.equal(body.data.season_events_count, 0);

    assert.equal((await fetch(`${base}/api/v4/admin/seasons/999`)).status, 404);
    assert.equal((await fetch(`${base}/api/v4/admin/seasons/not-a-number`)).status, 404);
  });
});

// ─── Update ──────────────────────────────────────────────────────────────

test('seasons: PUT with ends_at ALONE validates against the PERSISTED starts_at (§4.8 rule 7)', async () => {
  seedSeason({ id: 6, starts_at: T(0), ends_at: T(30) });

  await withApp('admin', async (base) => {
    // ends_at moved BEFORE the stored starts_at: without the persisted
    // lookup this passes, because the request carries no starts_at to
    // compare against.
    const bad = await fetch(`${base}/api/v4/admin/seasons/6`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ends_at: T(-5).toISOString() }),
    });
    assert.equal(bad.status, 422);
    assert.deepEqual((await bad.json()).details.ends_at,
      ['The ends_at field must be a date after starts_at.']);

    const good = await fetch(`${base}/api/v4/admin/seasons/6`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ends_at: T(60).toISOString() }),
    });
    assert.equal(good.status, 200);
    assert.equal(new Date((await good.json()).data.ends_at).getTime(), T(60).getTime());
  });
});

test('seasons: PATCH updates only the fields sent, and an empty body echoes the row unchanged', async () => {
  seedSeason({ id: 7, name: 'Before', pool_info: 'pool', is_active: true });

  await withApp('admin', async (base) => {
    const patched = await fetch(`${base}/api/v4/admin/seasons/7`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'After', is_active: false, description: null }),
    });
    assert.equal(patched.status, 200);
    const data = (await patched.json()).data;
    assert.equal(data.name, 'After');
    assert.equal(data.is_active, false);
    assert.equal(data.pool_info, 'pool', 'a field not sent is left alone');

    const noop = await fetch(`${base}/api/v4/admin/seasons/7`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(noop.status, 200);
    assert.equal((await noop.json()).data.name, 'After');
  });
});

test('seasons: PUT on an unknown id is a 404, not a 500 or a silent no-op', async () => {
  await withApp('admin', async (base) => {
    const res = await fetch(`${base}/api/v4/admin/seasons/404`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ghost' }),
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'Season not found.');
  });
});

// ─── Delete (the guard) ──────────────────────────────────────────────────

test('seasons: DELETE removes a season nothing references', async () => {
  seedSeason({ id: 8 });

  await withApp('admin', async (base) => {
    const res = await fetch(`${base}/api/v4/admin/seasons/8`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).message, 'Season deleted successfully.');
    assert.equal(db.seasons.length, 0);
  });
});

test('seasons: DELETE is REFUSED with 409 season_in_use while anything still references the season', async () => {
  // Four tables cascade to seasons and leaderboard_snapshots.season_id has
  // no FK at all, so a bare DELETE would destroy events/enrollments and
  // leave snapshots dangling. The guard names what is in the way.
  seedSeason({ id: 9 });
  db.season_events.push({ id: 10, season_id: 9 });
  db.season_events.push({ id: 11, season_id: 9 });
  db.user_enrollments.push({ id: 20, season_id: 9, season_event_id: null });
  db.onchain_accounts.push({ id: 30, season_id: 9 });
  db.token_allocation.push({ id: 40, season_id: 9 });

  await withApp('admin', async (base) => {
    const res = await fetch(`${base}/api/v4/admin/seasons/9`, { method: 'DELETE' });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.code, 'season_in_use');
    assert.match(body.error, /2 season event\(s\)/);
    assert.match(body.error, /1 enrollment\(s\)/);
    assert.match(body.error, /1 onchain account\(s\)/);
    assert.match(body.error, /1 token allocation\(s\)/);
    assert.equal(db.seasons.length, 1, 'the season is still there');
  });
});

test('seasons: a concurrent insert that turns the DELETE into a 23503 still answers 409, not 500', async () => {
  seedSeason({ id: 12 });
  const fk = new Error('update or delete on table "seasons" violates foreign key constraint');
  fk.code = '23503';
  failNextDelete = fk;

  await withApp('admin', async (base) => {
    const res = await fetch(`${base}/api/v4/admin/seasons/12`, { method: 'DELETE' });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'season_in_use');
  });
});

test('seasons: DELETE on an unknown id is a 404', async () => {
  await withApp('admin', async (base) => {
    const res = await fetch(`${base}/api/v4/admin/seasons/777`, { method: 'DELETE' });
    assert.equal(res.status, 404);
  });
});

// ─── Auth ────────────────────────────────────────────────────────────────

test('seasons: a view-only admin reads everything and mutates nothing', async () => {
  seedSeason({ id: 13 });

  await withApp('readonly', async (base) => {
    assert.equal((await fetch(`${base}/api/v4/admin/seasons`)).status, 200);
    assert.equal((await fetch(`${base}/api/v4/admin/seasons/13`)).status, 200);

    for (const [method, path] of [
      ['POST', '/api/v4/admin/seasons'],
      ['PUT', '/api/v4/admin/seasons/13'],
      ['PATCH', '/api/v4/admin/seasons/13'],
      ['DELETE', '/api/v4/admin/seasons/13'],
    ]) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'DELETE' ? undefined : JSON.stringify({ name: 'Nope' }),
      });
      assert.equal(res.status, 403, `${method} ${path} must be write-gated`);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.equal(body.error, 'Full admin access required.');
    }
    assert.equal(db.seasons[0].name, 'Season One', 'nothing was written');
  });
});

test('seasons: a plain (non-admin) user gets the read gate\'s 403 through the composed admin router', async () => {
  seedSeason({ id: 14 });
  const app = express();
  app.use(express.json());
  app.use(userMiddleware('user'));
  app.use(topochainAdminRoutes({}));
  const { server, base } = await listen(app);
  try {
    const res = await fetch(`${base}/api/v4/admin/seasons`);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'Unauthorized. Admin access required.');
  } finally { server.close(); }
});

test('seasons: the resource is actually mounted in the composed admin router (mount-order regression)', async () => {
  seedSeason({ id: 15, name: 'Mounted' });
  const app = express();
  app.use(express.json());
  app.use(userMiddleware('admin'));
  app.use(topochainAdminRoutes({}));
  const { server, base } = await listen(app);
  try {
    const body = await (await fetch(`${base}/api/v4/admin/seasons/15`)).json();
    assert.equal(body.data.name, 'Mounted');
  } finally { server.close(); }
});
