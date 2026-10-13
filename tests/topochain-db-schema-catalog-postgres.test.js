'use strict';

// The admin SQL console's schema browser (GET /api/v4/admin/sql-query/schema)
// reads the system catalog, not information_schema. Two declared checks
// failed on 7 Oct 2026 on proposals that never touched the console: with
// about 20 previews checking at once on one PostgreSQL, the old column query
// (information_schema.columns joined to key_column_usage and
// table_constraints, about a second of CPU on an idle server) answered after
// the checks had stopped waiting for the list.
//
// The catalog queries must say exactly what the information_schema ones
// said, because the console shows every value and the table inventory
// decides the console role's GRANT statements. So this file keeps the old
// queries, verbatim, and runs each beside its replacement against the full
// schema.sql plus a handful of tables that exercise what the full schema
// does not use today: a domain, an enum, arrays, an identity column, a
// generated column, a dropped column, a column comment, composite and
// overlapping keys, a partitioned table, a view, and a same-named table in
// another schema.
//
// Skipped when no server is reachable, and required when TEST_DATABASE_URL is
// set, like the other *-postgres tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const { TABLE_INVENTORY_SQL } = require('../src/services/topochain/db-console-scope');
const { COLUMN_INFO_SQL, getConsoleSchema } = require('../src/services/topochain/db-schema-info');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// db-console-scope.js's inventory before it moved to the catalog.
const INFORMATION_SCHEMA_INVENTORY_SQL = `
  SELECT c.table_name AS table,
         array_agg(c.column_name::text ORDER BY c.ordinal_position) AS columns
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
   WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
   GROUP BY c.table_name
   ORDER BY c.table_name
`;

// db-schema-info.js's column query before it moved to the catalog.
const INFORMATION_SCHEMA_COLUMN_SQL = `
  SELECT DISTINCT ON (c.table_name, c.column_name)
         c.table_name AS table_name,
         c.column_name AS column_name,
         c.data_type AS data_type,
         (c.is_nullable = 'YES') AS nullable,
         c.column_default AS default_value,
         col_description(pgc.oid, c.ordinal_position) AS comment,
         CASE tc.constraint_type
           WHEN 'PRIMARY KEY' THEN 'primary'
           WHEN 'FOREIGN KEY' THEN 'foreign'
           WHEN 'UNIQUE' THEN 'unique'
           ELSE NULL
         END AS key_type
    FROM information_schema.columns c
    JOIN pg_class pgc ON pgc.relname = c.table_name AND pgc.relnamespace = 'public'::regnamespace
    LEFT JOIN information_schema.key_column_usage kcu
      ON kcu.table_schema = 'public' AND kcu.table_name = c.table_name AND kcu.column_name = c.column_name
    LEFT JOIN information_schema.table_constraints tc
      ON tc.table_schema = 'public' AND tc.constraint_name = kcu.constraint_name AND tc.table_name = kcu.table_name
   WHERE c.table_schema = 'public' AND c.table_name = ANY($1)
   ORDER BY c.table_name, c.column_name,
     CASE tc.constraint_type
       WHEN 'PRIMARY KEY' THEN 0
       WHEN 'FOREIGN KEY' THEN 1
       WHEN 'UNIQUE' THEN 2
       ELSE 3
     END,
     c.ordinal_position
`;

const COLUMN_FIELDS = ['table_name', 'column_name', 'data_type', 'nullable', 'default_value', 'comment', 'key_type'];

// Shapes the full schema does not use yet, so a future migration that
// introduces one is already covered.
const PROBE_SQL = `
  CREATE TYPE zz_probe_mood AS ENUM ('calm', 'loud');
  CREATE DOMAIN zz_probe_code AS varchar(12) NOT NULL;
  CREATE DOMAIN zz_probe_tags AS text[];
  CREATE DOMAIN zz_probe_mood_d AS zz_probe_mood;

  CREATE TABLE zz_probe_parent (
    a integer NOT NULL,
    b text NOT NULL,
    PRIMARY KEY (a, b)
  );
  CREATE TABLE zz_probe_child (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    a integer,
    b text,
    code zz_probe_code,
    tags zz_probe_tags,
    mood zz_probe_mood DEFAULT 'calm',
    mood_d zz_probe_mood_d,
    scores integer[] DEFAULT '{}',
    doubled integer GENERATED ALWAYS AS (a * 2) STORED,
    gone text,
    email text UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (a, b) REFERENCES zz_probe_parent (a, b)
  );
  ALTER TABLE zz_probe_child DROP COLUMN gone;
  COMMENT ON COLUMN zz_probe_child.email IS 'where the receipt goes';

  -- One column in a primary key, a foreign key and a unique constraint.
  CREATE TABLE zz_probe_profile (
    child_id bigint PRIMARY KEY REFERENCES zz_probe_child (id),
    handle text,
    UNIQUE (child_id, handle)
  );

  CREATE TABLE zz_probe_events (
    id integer,
    at date NOT NULL,
    PRIMARY KEY (id, at)
  ) PARTITION BY RANGE (at);
  CREATE TABLE zz_probe_events_2026 PARTITION OF zz_probe_events
    FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');

  CREATE VIEW zz_probe_view AS SELECT id, email FROM zz_probe_child;

  -- Same table name in another schema: neither its columns nor its keys
  -- may reach the public listing.
  CREATE SCHEMA zz_probe_other;
  CREATE TABLE zz_probe_other.zz_probe_parent (a integer UNIQUE, extra integer);
  CREATE TABLE zz_probe_other.zz_probe_hidden (id integer PRIMARY KEY);
`;

test('the schema browser\'s catalog queries match the information_schema ones they replaced', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const suffix = crypto.randomBytes(6).toString('hex');
  const name = 'schema_catalog_' + suffix;
  const reader = 'schema_catalog_reader_' + suffix;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    // Roles are cluster-wide; the database (and its grants) is gone first.
    await admin.query(`DROP ROLE IF EXISTS ${reader}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  await pool.query(PROBE_SQL);
  // Until autovacuum first analyzes a new database's catalogs, the planner
  // picks nested loops for the old column query and it runs for about nine
  // seconds even on an idle server (a fresh preview database is in exactly
  // that state). Analyze now so the comparison costs a second instead.
  await pool.query('ANALYZE');

  const inventory = async (sql, client = pool) => (await client.query(sql)).rows;
  const columns = async (sql, names, client = pool) => {
    const result = await client.query(sql, [names]);
    return { fields: result.fields.map((f) => f.name), rows: result.rows };
  };

  await t.test('the table inventory is row-for-row the same', async () => {
    const before = await inventory(INFORMATION_SCHEMA_INVENTORY_SQL);
    const after = await inventory(TABLE_INVENTORY_SQL);
    assert.ok(before.length > 200, `the full schema has hundreds of tables, got ${before.length}`);
    assert.deepEqual(after, before);

    const listed = new Map(after.map((r) => [r.table, r.columns]));
    // Base tables only, partitioned ones included; never a view, never
    // another schema's table.
    assert.ok(listed.has('zz_probe_events'), 'a partitioned table is a base table');
    assert.ok(listed.has('zz_probe_events_2026'), 'so is its partition');
    assert.equal(listed.has('zz_probe_view'), false, 'a view is not');
    assert.equal(listed.has('zz_probe_hidden'), false, 'another schema\'s table is not');
    // Column order, without the dropped column.
    assert.deepEqual(listed.get('zz_probe_child'), [
      'id', 'a', 'b', 'code', 'tags', 'mood', 'mood_d', 'scores', 'doubled', 'email', 'created_at',
    ]);
    assert.deepEqual(listed.get('zz_probe_parent'), ['a', 'b'], 'the other schema\'s same-named table adds nothing');
  });

  await t.test('the column rows are the same columns, values and order', async () => {
    const names = (await inventory(TABLE_INVENTORY_SQL)).map((r) => r.table);
    const before = await columns(INFORMATION_SCHEMA_COLUMN_SQL, names);
    const after = await columns(COLUMN_INFO_SQL, names);
    assert.deepEqual(before.fields, COLUMN_FIELDS);
    assert.deepEqual(after.fields, COLUMN_FIELDS);
    assert.ok(before.rows.length > 2000, `the full schema has thousands of columns, got ${before.rows.length}`);
    assert.deepEqual(after.rows, before.rows);

    // The comparison is only worth something if the rows cover every case,
    // so spell out what the probe tables must have come back as.
    const row = (table, column) => after.rows.find((r) => r.table_name === table && r.column_name === column);
    const pick = (r) => ({
      data_type: r.data_type, nullable: r.nullable, default_value: r.default_value,
      comment: r.comment, key_type: r.key_type,
    });
    const expected = {
      'zz_probe_child.id': { data_type: 'bigint', nullable: false, default_value: null, comment: null, key_type: 'primary' },
      'zz_probe_child.a': { data_type: 'integer', nullable: true, default_value: null, comment: null, key_type: 'foreign' },
      'zz_probe_child.b': { data_type: 'text', nullable: true, default_value: null, comment: null, key_type: 'foreign' },
      'zz_probe_child.code': { data_type: 'character varying', nullable: false, default_value: null, comment: null, key_type: null },
      'zz_probe_child.tags': { data_type: 'ARRAY', nullable: true, default_value: null, comment: null, key_type: null },
      'zz_probe_child.mood': { data_type: 'USER-DEFINED', nullable: true, default_value: "'calm'::zz_probe_mood", comment: null, key_type: null },
      'zz_probe_child.mood_d': { data_type: 'USER-DEFINED', nullable: true, default_value: null, comment: null, key_type: null },
      'zz_probe_child.scores': { data_type: 'ARRAY', nullable: true, default_value: "'{}'::integer[]", comment: null, key_type: null },
      'zz_probe_child.doubled': { data_type: 'integer', nullable: true, default_value: null, comment: null, key_type: null },
      'zz_probe_child.email': { data_type: 'text', nullable: true, default_value: null, comment: 'where the receipt goes', key_type: 'unique' },
      'zz_probe_child.created_at': { data_type: 'timestamp with time zone', nullable: false, default_value: 'now()', comment: null, key_type: null },
      'zz_probe_profile.child_id': { data_type: 'bigint', nullable: false, default_value: null, comment: null, key_type: 'primary' },
      'zz_probe_profile.handle': { data_type: 'text', nullable: true, default_value: null, comment: null, key_type: 'unique' },
      'zz_probe_parent.a': { data_type: 'integer', nullable: false, default_value: null, comment: null, key_type: 'primary' },
      'zz_probe_events.at': { data_type: 'date', nullable: false, default_value: null, comment: null, key_type: 'primary' },
      'zz_probe_events_2026.id': { data_type: 'integer', nullable: false, default_value: null, comment: null, key_type: 'primary' },
    };
    for (const [key, want] of Object.entries(expected)) {
      const [table, column] = key.split('.');
      const got = row(table, column);
      assert.ok(got, `${key} is listed`);
      assert.deepEqual(pick(got), want, key);
    }
    assert.equal(row('zz_probe_child', 'gone'), undefined, 'a dropped column is not listed');
    assert.equal(after.rows.filter((r) => r.table_name === 'zz_probe_parent').length, 2,
      'the other schema\'s zz_probe_parent adds no column');
  });

  await t.test('a caller without privileges sees the same tables and columns from both', async () => {
    // The inventory decides the console role's GRANT statements, so its
    // visibility rule has to match information_schema's for any caller,
    // not just for the owner the platform connects as.
    await admin.query(`CREATE ROLE ${reader} NOLOGIN`);
    await pool.query(`GRANT SELECT ON zz_probe_parent TO ${reader}`);
    await pool.query(`GRANT SELECT (id, email) ON zz_probe_child TO ${reader}`);
    await pool.query(`GRANT UPDATE (handle) ON zz_probe_profile TO ${reader}`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${reader}`);
      const before = await inventory(INFORMATION_SCHEMA_INVENTORY_SQL, client);
      const after = await inventory(TABLE_INVENTORY_SQL, client);
      assert.deepEqual(after, before);
      // Everything else belongs to the superuser who loaded the schema, so
      // the reader sees only what it was granted, down to the column.
      assert.deepEqual(after, [
        { table: 'zz_probe_child', columns: ['id', 'email'] },
        { table: 'zz_probe_parent', columns: ['a', 'b'] },
        { table: 'zz_probe_profile', columns: ['handle'] },
      ]);

      // The column query applies the same rule. (Its key_type is not
      // compared here: information_schema hid a key from a caller who could
      // only read the table, which the platform's pool never is.)
      const names = after.map((r) => r.table);
      const cols = (rows) => rows.map((r) => `${r.table_name}.${r.column_name}`);
      assert.deepEqual(
        cols((await columns(COLUMN_INFO_SQL, names, client)).rows),
        cols((await columns(INFORMATION_SCHEMA_COLUMN_SQL, names, client)).rows),
      );
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  await t.test('the endpoint\'s listing still holds the tables the declared checks look for', async () => {
    const schema = await getConsoleSchema(pool);
    const byName = new Map(schema.map((entry) => [entry.name, entry]));
    for (const table of ['chat_sessions', 'mobile_push_deliveries']) {
      assert.ok(byName.has(table), `${table} is listed`);
      assert.ok(byName.get(table).columns.length > 0, `${table} lists its columns`);
    }
    // Credential columns stay hidden from the listing.
    assert.equal(byName.get('users').columns.some((c) => c.name === 'password'), false);
  });
});
