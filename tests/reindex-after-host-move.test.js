// `reindexAfterHostMove` in src/db/reindex-after-host-move.js — the one-off
// index rebuild that migrate() runs after the 2026-09 database host move.
//
// WHY THIS FILE EXISTS. After the move, rows written before it stopped being
// findable through their unique B-tree indexes while rows written after it
// were fine: `mcp_clients` returned Claude.ai's August registration from a
// scan on client_name and nothing from `WHERE client_id = $1`, so every
// connector consent 404'd as an unknown client. The pass rebuilds the
// indexes of every small table once, from migrate(), so the repair needs
// no shell on the database host.
//
// The properties that matter are not visible in a screen:
//
//   1. It runs EXACTLY ONCE per marker, and the guard short-circuits before
//      any REINDEX. A failed table leaves the marker unset so the next boot
//      retries; a clean pass writes it.
//   2. Every REINDEX runs on ONE dedicated client under a lock timeout and
//      a statement timeout, set before the first rebuild, and that client
//      is destroyed afterwards so the session-level timeouts cannot leak
//      back into the pool.
//   3. Large tables are never touched here — they are reported for the
//      operator's REINDEX DATABASE — and identifiers are quoted, so a table
//      name can never be interpreted as SQL.
//   4. It is wired into migrate() AFTER the schema apply and BEFORE
//      seedAdmin, because the seeds look rows up by text key and insert on
//      a miss.
//   5. A staging clone skips it entirely.
//
// Same two layers as tests/waitlist-country-migration.test.js: the real
// function against a mock pool that records every query, plus static
// assertions over migrate.js. No live Postgres.
//
// Run with: node --test tests/reindex-after-host-move.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  reindexAfterHostMove, reportCollationDrift, quoteIdent, MARKER_KEY, SMALL_TABLE_BYTES,
} = require('../src/db/reindex-after-host-move');

const migrateSrc = fs.readFileSync(path.join(__dirname, '..', 'src/db/migrate.js'), 'utf8');

const MB = 1024 * 1024;

// `markerRows` is what the guard SELECT returns: [] on a database that has
// not had the pass, [{}] once it has. `tables` is the pg_class listing.
// `failing` names tables whose REINDEX throws. `collation` is the
// pg_database row (null = a server without collation versions).
function mockPool({
  markerRows = [],
  tables = [],
  failing = [],
  collation = null,
} = {}) {
  const calls = [];
  const clientCalls = [];
  let released = null;
  const client = {
    query: async (sql) => {
      clientCalls.push(sql);
      const m = /^REINDEX TABLE "(.*)"$/.exec(sql);
      if (m && failing.includes(m[1].replace(/""/g, '"'))) throw new Error('lock timeout');
      return { rows: [] };
    },
    release: (arg) => { released = arg; },
  };
  return {
    calls,
    clientCalls,
    get released() { return released; },
    connect: async () => client,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM platform_settings/.test(sql)) return { rows: markerRows };
      if (/FROM pg_database/.test(sql)) {
        if (!collation) throw new Error('function pg_database_collation_actual_version does not exist');
        return { rows: [collation] };
      }
      if (/FROM pg_class/.test(sql)) return { rows: tables };
      return { rows: [], rowCount: 0 };
    },
  };
}

const env = {}; // never staging unless a test says so
const reindexes = (pool) => pool.clientCalls.filter((s) => /^REINDEX/.test(s));
const markerInserts = (pool) => pool.calls.filter((c) => /INSERT INTO platform_settings/.test(c.sql));

// ─── 1. Behaviour ─────────────────────────────────────────────────────

test('on a fresh database it reindexes every small table, smallest first, then records the marker', async () => {
  const pool = mockPool({
    tables: [
      { name: 'mcp_clients', bytes: 64 * 1024 },
      { name: 'users', bytes: 3 * MB },
      { name: 'messages', bytes: 900 * MB },
    ],
  });
  const result = await reindexAfterHostMove(pool, { env });

  assert.match(pool.calls[0].sql, /SELECT 1 FROM platform_settings WHERE key = \$1/);
  assert.deepEqual(pool.calls[0].params, [MARKER_KEY], 'the guard reads its own marker');

  assert.deepEqual(reindexes(pool), ['REINDEX TABLE "mcp_clients"', 'REINDEX TABLE "users"'],
    'both small tables, in size order; the large one is never touched here');
  assert.deepEqual(result.reindexed, ['mcp_clients', 'users']);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.deferred, ['messages'], 'the large table is reported for the operator');

  const [insert] = markerInserts(pool);
  assert.ok(insert, 'the marker is written after a clean pass');
  assert.equal(insert.params[0], MARKER_KEY);
  assert.match(insert.sql, /ON CONFLICT \(key\) DO NOTHING/);
});

test('a second run is a no-op: the marker short-circuits before any REINDEX', async () => {
  const pool = mockPool({ markerRows: [{ '?column?': 1 }], tables: [{ name: 'users', bytes: MB }] });
  const result = await reindexAfterHostMove(pool, { env });

  assert.deepEqual(result, { skipped: 'done' });
  assert.equal(pool.calls.length, 1, 'only the guard SELECT is issued');
  assert.equal(reindexes(pool).length, 0);
});

test('the timeouts are set on the dedicated client before the first REINDEX, and that client is destroyed', async () => {
  const pool = mockPool({ tables: [{ name: 'users', bytes: MB }] });
  await reindexAfterHostMove(pool, { env });

  assert.match(pool.clientCalls[0], /^SET lock_timeout = '\d+s'$/);
  assert.match(pool.clientCalls[1], /^SET statement_timeout = '\d+s'$/);
  assert.match(pool.clientCalls[2], /^REINDEX TABLE/);
  assert.equal(pool.released, true,
    'release(true) destroys the client so the session-level timeouts never return to the pool');
});

test('a table that fails to reindex is skipped, the others still run, and the marker is NOT written', async () => {
  const pool = mockPool({
    tables: [
      { name: 'mcp_clients', bytes: MB },
      { name: 'sessions', bytes: 2 * MB },
      { name: 'users', bytes: 3 * MB },
    ],
    failing: ['sessions'],
  });
  const result = await reindexAfterHostMove(pool, { env });

  assert.deepEqual(result.reindexed, ['mcp_clients', 'users']);
  assert.deepEqual(result.failed, ['sessions']);
  assert.equal(markerInserts(pool).length, 0, 'an incomplete pass must retry on the next boot');
  assert.equal(pool.released, true, 'the client is destroyed even after a failure');
});

test('a staging clone never touches the database', async () => {
  const pool = mockPool({ tables: [{ name: 'users', bytes: MB }] });
  const result = await reindexAfterHostMove(pool, { env: { USERNODE_ENV: 'staging' } });

  assert.deepEqual(result, { skipped: 'staging' });
  assert.equal(pool.calls.length, 0);
  assert.equal(pool.clientCalls.length, 0);
});

test('a failure outside the loop is logged and swallowed, never thrown into boot', async () => {
  const pool = {
    query: async () => { throw new Error('connection refused'); },
    connect: async () => { throw new Error('unreachable'); },
  };
  await assert.doesNotReject(() => reindexAfterHostMove(pool, { env }));
  const result = await reindexAfterHostMove(pool, { env });
  assert.equal(result.skipped, 'error');
});

test('the threshold is applied to total relation size, inclusive', async () => {
  const pool = mockPool({
    tables: [
      { name: 'at_limit', bytes: SMALL_TABLE_BYTES },
      { name: 'over_limit', bytes: SMALL_TABLE_BYTES + 1 },
    ],
  });
  const result = await reindexAfterHostMove(pool, { env });
  assert.deepEqual(result.reindexed, ['at_limit']);
  assert.deepEqual(result.deferred, ['over_limit']);
});

test('pg returns bigint sizes as strings; they are still compared as numbers', async () => {
  const pool = mockPool({ tables: [{ name: 'users', bytes: String(2 * MB) }, { name: 'big', bytes: String(10 * SMALL_TABLE_BYTES) }] });
  const result = await reindexAfterHostMove(pool, { env });
  assert.deepEqual(result.reindexed, ['users']);
  assert.deepEqual(result.deferred, ['big']);
});

// ─── 2. Identifier safety ─────────────────────────────────────────────

test('table names are quoted identifiers, never interpolated as SQL', async () => {
  const hostile = 'users"; DROP TABLE users; --';
  const pool = mockPool({ tables: [{ name: hostile, bytes: MB }] });
  await reindexAfterHostMove(pool, { env });

  const [sql] = reindexes(pool);
  assert.equal(sql, `REINDEX TABLE ${quoteIdent(hostile)}`);
  assert.equal(quoteIdent(hostile), '"users""; DROP TABLE users; --"',
    'an embedded double quote is doubled, so the whole name stays one identifier');
  assert.equal(quoteIdent('Mixed.Case'), '"Mixed.Case"', 'quoting also preserves case and punctuation');
});

// ─── 3. Collation drift report ────────────────────────────────────────

test('collation drift is reported when the recorded and actual versions differ', async () => {
  const drifted = await reportCollationDrift(mockPool({
    collation: { datcollate: 'en_US.utf8', datcollversion: '2.31', actual_version: '2.36' },
  }));
  assert.deepEqual(drifted, { drifted: true, recorded: '2.31', actual: '2.36' });

  const same = await reportCollationDrift(mockPool({
    collation: { datcollate: 'en_US.utf8', datcollversion: '2.36', actual_version: '2.36' },
  }));
  assert.equal(same.drifted, false);
});

test('a server without collation versions (Postgres < 15) is not an error', async () => {
  assert.equal(await reportCollationDrift(mockPool({ collation: null })), null);
  const noVersion = await reportCollationDrift(mockPool({
    collation: { datcollate: 'C', datcollversion: null, actual_version: null },
  }));
  assert.equal(noVersion, null, 'the C collation has no version to compare');
});

test('drift is advisory: the reindex pass runs the same way whether or not it is reported', async () => {
  for (const collation of [null, { datcollate: 'en_US.utf8', datcollversion: '2.31', actual_version: '2.36' }]) {
    const pool = mockPool({ tables: [{ name: 'users', bytes: MB }], collation });
    const result = await reindexAfterHostMove(pool, { env });
    assert.deepEqual(result.reindexed, ['users']);
    assert.equal(markerInserts(pool).length, 1);
  }
});

// ─── 4. Wiring ────────────────────────────────────────────────────────

test('it is wired into migrate() after the schema apply and before seedAdmin', () => {
  assert.match(migrateSrc, /require\('\.\/reindex-after-host-move'\)/, 'migrate.js imports the module');
  const call = migrateSrc.search(/^\s*await reindexAfterHostMove\(pool\);$/m);
  const schemaDone = migrateSrc.indexOf("log.info('db', 'Schema up to date');");
  const seedAdmin = migrateSrc.search(/^\s*await seedAdmin\(pool, config\);$/m);
  assert.ok(call > 0, 'migrate() calls the pass');
  assert.ok(schemaDone > 0 && seedAdmin > 0, 'the two anchors are still in migrate()');
  assert.ok(schemaDone < call, 'the pass runs after the schema apply');
  assert.ok(call < seedAdmin, 'the pass runs before the first seed, which looks users up by username');
});

test('the marker key names the event, so a future host move gets its own key rather than a deleted row', () => {
  assert.match(MARKER_KEY, /host_move_2026_09$/);
});
