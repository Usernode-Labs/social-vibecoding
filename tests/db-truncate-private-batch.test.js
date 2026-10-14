'use strict';

// truncatePrivateTables empties every `staging:private` table of a staging
// copy in ONE statement, so in one transaction: a TRUNCATE drops relation
// files, and Postgres flushes WAL at the commit of any transaction that does,
// whatever synchronous_commit says. One statement per table paid that flush
// once per table. When the one statement fails, the pass falls back to one
// statement per table, in autocommit, and still names each table it could
// not empty. The first tests drive it with a recording executor; the last
// two run it against a real PostgreSQL server (skipped when none is
// reachable, required when TEST_DATABASE_URL is set).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Client } = require('pg');

process.env.DATABASE_URL ||= 'postgres://usernode:test@db.example.test:5432/usernode';
const { truncatePrivateTables } = require('../src/services/db-manager');

function recorder(tables, { failOn = null } = {}) {
  const calls = [];
  const execute = async (db, sql, opts = {}) => {
    calls.push({ db, sql, opts });
    if (/obj_description/.test(sql)) return tables.join('\n') + '\n';
    if (failOn && failOn(sql)) throw new Error(`boom: ${sql.slice(0, 60)}`);
    return '';
  };
  return { calls, execute, truncates: () => calls.filter((c) => /^TRUNCATE/.test(c.sql)).map((c) => c.sql) };
}

test('every private table is emptied by one TRUNCATE statement', async () => {
  const tables = Array.from({ length: 191 }, (_, i) => `public.private_${String(i).padStart(3, '0')}`);
  const r = recorder(tables);
  const result = await truncatePrivateTables('app_demo_staging_s1_abc', r.execute);
  assert.deepEqual(r.truncates(), [`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`]);
  assert.deepEqual(result.truncated, tables);
  assert.ok(r.calls.every((c) => c.db === 'app_demo_staging_s1_abc'));
});

test('no private tables: no TRUNCATE at all', async () => {
  const r = recorder([]);
  assert.deepEqual(await truncatePrivateTables('app_demo_staging_s1_abc', r.execute), { truncated: [] });
  assert.deepEqual(r.truncates(), []);
});

test('a failed statement falls back to one per table and names the table that failed', async () => {
  const tables = ['public.a', 'public.b', 'public.c'];
  const r = recorder(tables, { failOn: (sql) => /^TRUNCATE .*public\.b\b/.test(sql) });
  await assert.rejects(truncatePrivateTables('app_demo_staging_s1_abc', r.execute),
    (err) => /Failed to truncate 1 staging:private table\(s\)/.test(err.message)
      && /public\.b \(boom/.test(err.message) && !/public\.a \(/.test(err.message));
  assert.deepEqual(r.truncates(), [
    'TRUNCATE public.a, public.b, public.c RESTART IDENTITY CASCADE',
    'TRUNCATE public.a RESTART IDENTITY CASCADE',
    'TRUNCATE public.b RESTART IDENTITY CASCADE',
    'TRUNCATE public.c RESTART IDENTITY CASCADE',
  ], 'every table is still tried after one fails');
});

test('a failed statement whose tables all empty one by one is not a failure', async () => {
  const tables = ['public.a', 'public.b'];
  const r = recorder(tables, { failOn: (sql) => sql.includes(', ') });
  const result = await truncatePrivateTables('app_demo_staging_s1_abc', r.execute);
  assert.deepEqual(result.truncated, tables);
  assert.equal(r.truncates().length, 3);
});

test('an unsafe name is never spliced into the statement, and still fails the pass', async () => {
  const r = recorder(['public.a', 'public.b; DROP TABLE x', 'public.c']);
  await assert.rejects(truncatePrivateTables('app_demo_staging_s1_abc', r.execute),
    /public\.b; DROP TABLE x \(unsafe identifier\)/);
  assert.deepEqual(r.truncates(), ['TRUNCATE public.a, public.c RESTART IDENTITY CASCADE'],
    'the safe tables are still emptied');
});

test('discovery failure is fatal before any TRUNCATE', async () => {
  const execute = async (db, sql) => { if (/obj_description/.test(sql)) throw new Error('down'); return ''; };
  await assert.rejects(truncatePrivateTables('app_demo_staging_s1_abc', execute), /Failed to discover staging:private tables/);
});

// ── against a real server ───────────────────────────────────────────────

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

async function scratchDatabase(t, prefix) {
  const admin = new Client({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.connect(); } catch (err) {
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return null;
  }
  const name = `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const client = new Client({ connectionString: String(url) });
  await client.connect();
  t.after(async () => {
    await client.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  });
  const statements = [];
  // The shape withDatabaseConnection hands the pass: autocommit, '|'-joined
  // tuples for discovery.
  const execute = async (db, sql, opts = {}) => {
    assert.equal(db, name);
    statements.push(sql);
    const result = await client.query({ text: sql, rowMode: 'array' });
    return opts.tuplesOnly ? result.rows.map((row) => row.join('|')).join('\n') : '';
  };
  return { name, client, execute, statements };
}

test('real server: rows, CASCADE reach and identities, emptied in one statement', { timeout: 60000 }, async (t) => {
  const s = await scratchDatabase(t, 'trunc_batch');
  if (!s) return;
  await s.client.query(`
    CREATE TABLE parent (id serial PRIMARY KEY, v text);
    CREATE TABLE child (id serial PRIMARY KEY, parent_id int REFERENCES parent(id), v text);
    CREATE TABLE other_private (id bigserial PRIMARY KEY, v text);
    CREATE TABLE refers_to_private (id serial PRIMARY KEY, p int REFERENCES other_private(id));
    CREATE TABLE public_rows (id serial PRIMARY KEY, v text);
    COMMENT ON TABLE parent IS 'staging:private';
    COMMENT ON TABLE child IS 'staging:private';
    COMMENT ON TABLE other_private IS 'staging:private';
    INSERT INTO parent (v) VALUES ('a'), ('b');
    INSERT INTO child (parent_id, v) VALUES (1, 'x'), (2, 'y');
    INSERT INTO other_private (v) VALUES ('secret');
    INSERT INTO refers_to_private (p) VALUES (1);
    INSERT INTO public_rows (v) VALUES ('kept');
  `);
  const result = await truncatePrivateTables(s.name, s.execute);
  assert.deepEqual(result.truncated, ['public.child', 'public.other_private', 'public.parent']);
  assert.equal(s.statements.filter((sql) => /^TRUNCATE/.test(sql)).length, 1);
  for (const table of ['parent', 'child', 'other_private', 'refers_to_private']) {
    assert.equal((await s.client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, `${table} is empty`);
  }
  assert.equal((await s.client.query('SELECT count(*)::int AS n FROM public_rows')).rows[0].n, 1, 'other tables keep their rows');
  assert.equal((await s.client.query("INSERT INTO parent (v) VALUES ('new') RETURNING id")).rows[0].id, 1, 'identities restart');
});

test('real server: a table that refuses TRUNCATE is named, and the others are still emptied', { timeout: 60000 }, async (t) => {
  const s = await scratchDatabase(t, 'trunc_fallback');
  if (!s) return;
  await s.client.query(`
    CREATE TABLE a (id serial PRIMARY KEY); CREATE TABLE b (id serial PRIMARY KEY); CREATE TABLE c (id serial PRIMARY KEY);
    COMMENT ON TABLE a IS 'staging:private'; COMMENT ON TABLE b IS 'staging:private'; COMMENT ON TABLE c IS 'staging:private';
    INSERT INTO a DEFAULT VALUES; INSERT INTO b DEFAULT VALUES; INSERT INTO c DEFAULT VALUES;
    CREATE FUNCTION refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$;
    CREATE TRIGGER refuse_truncate BEFORE TRUNCATE ON b FOR EACH STATEMENT EXECUTE FUNCTION refuse();
  `);
  await assert.rejects(truncatePrivateTables(s.name, s.execute),
    (err) => /Failed to truncate 1 staging:private table\(s\)/.test(err.message) && /public\.b \(refused\)/.test(err.message));
  assert.equal((await s.client.query('SELECT count(*)::int AS n FROM a')).rows[0].n, 0);
  assert.equal((await s.client.query('SELECT count(*)::int AS n FROM c')).rows[0].n, 0);
  assert.equal((await s.client.query('SELECT count(*)::int AS n FROM b')).rows[0].n, 1);
});

test('real server: the platform schema\'s private tables, in one statement', { timeout: 180000 }, async (t) => {
  const s = await scratchDatabase(t, 'trunc_schema');
  if (!s) return;
  await s.client.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  s.statements.length = 0;
  const result = await truncatePrivateTables(s.name, s.execute);
  assert.ok(result.truncated.length > 100, `found ${result.truncated.length} private tables`);
  assert.equal(s.statements.filter((sql) => /^TRUNCATE/.test(sql)).length, 1, 'no fallback on the real schema');
});
