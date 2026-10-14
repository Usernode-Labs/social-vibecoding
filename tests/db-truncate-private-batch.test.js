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

// The emptiness check is a file-size query, then, only for what it lists, a
// DO block that reads rows. `holding` names private tables with live rows
// (listed by the size query, reported by the DO block); `allocated` names
// tables whose file is not empty but holds no live row; `listed` adds raw
// lines to the size query's answer; `readError` makes the DO block fail.
function recorder(tables, { failOn = null, holding = () => [], allocated = [], listed = [], readError = null, foreign = [] } = {}) {
  const calls = [];
  const execute = async (db, sql, opts = {}) => {
    calls.push({ db, sql, opts });
    if (/obj_description/.test(sql)) return [...tables, ...foreign.map((f) => `FOREIGN ${f}`)].join('\n') + '\n';
    if (failOn && failOn(sql)) throw new Error(`boom: ${sql.slice(0, 60)}`);
    if (/pg_relation_size/.test(sql)) {
      return [...holding(calls), ...allocated].map((n) => `${n}|${n}|r`).concat(listed).join('\n');
    }
    if (/^DO \$staging_check\$/.test(sql)) {
      if (readError) throw new Error(readError);
      const live = holding(calls.filter((c) => /pg_relation_size/.test(c.sql)));
      if (live.length) throw new Error(`ERROR:  staging:private rows remain in: ${live.join(', ')};`);
    }
    return '';
  };
  return {
    calls, execute,
    truncates: () => calls.filter((c) => /^TRUNCATE/.test(c.sql)).map((c) => c.sql),
    checks: () => calls.filter((c) => /pg_relation_size/.test(c.sql)),
    reads: () => calls.filter((c) => /^DO \$staging_check\$/.test(c.sql)),
  };
}

test('every private table is emptied by one TRUNCATE statement', async () => {
  const tables = Array.from({ length: 191 }, (_, i) => `public.private_${String(i).padStart(3, '0')}`);
  const r = recorder(tables);
  const result = await truncatePrivateTables('app_demo_staging_s1_abc', r.execute);
  assert.deepEqual(r.truncates(), [`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`]);
  assert.deepEqual(result.truncated, tables);
  assert.ok(r.calls.every((c) => c.db === 'app_demo_staging_s1_abc'));
  assert.equal(r.checks().length, 1, 'one query confirms they are empty');
  assert.equal(r.calls.length, 3, 'discovery, the statement and the check: three round trips');
  assert.match(r.checks()[0].sql, /^WITH RECURSIVE targets\(name, rel\) AS \(VALUES \('public\.private_000', 'public\.private_000'::regclass\), /);
  assert.match(r.checks()[0].sql, /pg_inherits/, 'inheritance children, which TRUNCATE empties too, are checked');
  assert.equal(r.checks()[0].opts.tuplesOnly, true);
  assert.equal(r.reads().length, 0, 'zero-length heap files need no second query');
});

test('rows back after the one statement: the per-table pass runs, then the check again', async () => {
  const tables = ['public.a', 'public.b'];
  // Refilled once (an AFTER TRUNCATE trigger), empty after the per-table pass.
  const r = recorder(tables, { holding: (calls) => (calls.filter((c) => /pg_relation_size/.test(c.sql)).length === 1 ? ['public.b'] : []) });
  // (the DO block sees the same answer as the size query that preceded it)
  const result = await truncatePrivateTables('app_demo_staging_s1_abc', r.execute);
  assert.deepEqual(result.truncated, tables);
  assert.deepEqual(r.truncates(), [
    'TRUNCATE public.a, public.b RESTART IDENTITY CASCADE',
    'TRUNCATE public.a RESTART IDENTITY CASCADE',
    'TRUNCATE public.b RESTART IDENTITY CASCADE',
  ]);
  assert.equal(r.checks().length, 2);
});

test('rows still there after the per-table pass fail it, naming the table', async () => {
  const r = recorder(['public.a', 'public.b'], { holding: () => ['public.a'] });
  await assert.rejects(truncatePrivateTables('app_demo_staging_s1_abc', r.execute),
    /Failed to truncate 1 staging:private table\(s\) in app_demo_staging_s1_abc: public\.a \(still holds rows after TRUNCATE\)/);
});

test('after a failed statement, rows the per-table pass leaves behind still fail it', async () => {
  // The check also runs on the fallback path, not only after the single statement.
  const r = recorder(['public.a', 'public.b'], { failOn: (sql) => sql.includes(', public.'), holding: () => ['public.a'] });
  await assert.rejects(truncatePrivateTables('app_demo_staging_s1_abc', r.execute),
    /public\.a \(still holds rows after TRUNCATE\)/);
  assert.equal(r.checks().length, 1);
});

test('a file with pages but no live row is read, found empty, and passes', async () => {
  const r = recorder(['public.a', 'public.b'], { allocated: ['public.b'] });
  const result = await truncatePrivateTables('app_demo_staging_s1_abc', r.execute);
  assert.deepEqual(result.truncated, ['public.a', 'public.b']);
  assert.equal(r.truncates().length, 1, 'no per-table pass');
  assert.equal(r.reads().length, 1);
  assert.match(r.reads()[0].sql, /SET LOCAL row_security = off; IF EXISTS \(SELECT 1 FROM ONLY "public"\."b"\)/);
});

test('a suspect that cannot be read (a policy with row_security off, no privilege) fails the pass', async () => {
  const r = recorder(['public.a'], { allocated: ['public.a'], readError: 'query would be affected by row-level security policy for table "a"' });
  await assert.rejects(truncatePrivateTables('app_demo_staging_s1_abc', r.execute),
    /Could not confirm the staging:private tables in app_demo_staging_s1_abc are empty: query would be affected by row-level security/);
  assert.equal(r.truncates().length, 2, 'after the single statement, the per-table pass runs; the second check decides');
  assert.equal(r.reads().length, 2);
});

test('a relation under a private table whose name cannot be checked fails the pass', async () => {
  const r = recorder(['public.a'], { listed: ['public.a|public.weird name|r'] });
  await assert.rejects(truncatePrivateTables('app_demo_staging_s1_abc', r.execute),
    /Could not confirm .* cannot be checked: "public\.a\|public\.weird name\|r"/);
  assert.equal(r.reads().length, 0);
});

test('a read error that only echoes the statement is not mistaken for named rows', async () => {
  // psql failures repeat the statement; its marker is built by format(), so
  // the statement's text never matches.
  const r = recorder(['public.a'], { allocated: ['public.a'] });
  const sqlOf = async () => { await truncatePrivateTables('app_demo_staging_s1_abc', r.execute); return r.reads()[0].sql; };
  const doSql = await sqlOf();
  assert.doesNotMatch(doSql, /staging:private rows remain in: /);
  const r2 = recorder(['public.a'], { allocated: ['public.a'], readError: `Command failed: psql -c ${doSql}\nERROR:  could not connect to server "remote"` });
  await assert.rejects(truncatePrivateTables('app_demo_staging_s1_abc', r2.execute), /Could not confirm/);
});

test('a foreign child the check finds after the single statement refuses the copy, with no per-table pass', async () => {
  const r = recorder(['public.a', 'public.b'], { listed: ['public.b|public.b_dyn|f'] });
  await assert.rejects(truncatePrivateTables('app_demo_staging_s1_abc', r.execute),
    /Refusing to empty the staging:private tables in app_demo_staging_s1_abc: public\.b has the foreign-table descendant public\.b_dyn/);
  assert.equal(r.truncates().length, 1, 'only the single statement, which did not reach it');
  assert.equal(r.reads().length, 0);
});

test('a check that cannot run fails the pass', async () => {
  const r = recorder(['public.a'], { failOn: (sql) => /pg_relation_size/.test(sql) });
  await assert.rejects(truncatePrivateTables('app_demo_staging_s1_abc', r.execute),
    /Could not confirm the staging:private tables in app_demo_staging_s1_abc are empty: boom/);
});

test('a private table with a foreign-table descendant refuses the copy before any TRUNCATE', async () => {
  const r = recorder(['public.a', 'public.b'], { foreign: ['public.b public.b_remote'] });
  await assert.rejects(truncatePrivateTables('app_demo_staging_s1_abc', r.execute),
    /Refusing to empty the staging:private tables in app_demo_staging_s1_abc: public\.b has the foreign-table descendant public\.b_remote/);
  assert.deepEqual(r.truncates(), []);
  assert.equal(r.calls.length, 1, 'discovery only');
  assert.match(r.calls[0].sql, /c\.relkind = 'f'/);
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
  const r = recorder(tables, { failOn: (sql) => sql.startsWith('TRUNCATE') && sql.includes(', ') });
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

// AFTER TRUNCATE triggers fire once the whole statement is done, so one on
// `a` that writes into `b` refills `b` after the single statement emptied it.
test('real server: an AFTER TRUNCATE trigger that refills a private table is caught and undone', { timeout: 60000 }, async (t) => {
  const s = await scratchDatabase(t, 'trunc_trigger');
  if (!s) return;
  await s.client.query(`
    CREATE TABLE a (id serial PRIMARY KEY, v text); CREATE TABLE b (id serial PRIMARY KEY, v text);
    COMMENT ON TABLE a IS 'staging:private'; COMMENT ON TABLE b IS 'staging:private';
    INSERT INTO a (v) VALUES ('x'); INSERT INTO b (v) VALUES ('y');
    CREATE FUNCTION refill_b() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO b (v) VALUES ('fixture'); RETURN NULL; END $$;
    CREATE TRIGGER a_refills_b AFTER TRUNCATE ON a FOR EACH STATEMENT EXECUTE FUNCTION refill_b();
  `);
  const result = await truncatePrivateTables(s.name, s.execute);
  assert.deepEqual(result.truncated, ['public.a', 'public.b']);
  for (const table of ['a', 'b']) {
    assert.equal((await s.client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, `${table} is empty`);
  }
  assert.ok(s.statements.includes('TRUNCATE public.b RESTART IDENTITY CASCADE'), 'the per-table pass ran');
});

test('real server: a trigger that refills an earlier table even table by table fails the pass', { timeout: 60000 }, async (t) => {
  const s = await scratchDatabase(t, 'trunc_trigger_rev');
  if (!s) return;
  await s.client.query(`
    CREATE TABLE a (id serial PRIMARY KEY, v text); CREATE TABLE b (id serial PRIMARY KEY, v text);
    COMMENT ON TABLE a IS 'staging:private'; COMMENT ON TABLE b IS 'staging:private';
    CREATE FUNCTION refill_a() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO a (v) VALUES ('fixture'); RETURN NULL; END $$;
    CREATE TRIGGER b_refills_a AFTER TRUNCATE ON b FOR EACH STATEMENT EXECUTE FUNCTION refill_a();
  `);
  await assert.rejects(truncatePrivateTables(s.name, s.execute),
    /Failed to truncate 1 staging:private table\(s\) in trunc_trigger_rev_[0-9a-f]+: public\.a \(still holds rows after TRUNCATE\)/);
});

// The check must not trust a SELECT: row-level security filters it for an
// administrator that neither is a superuser nor bypasses RLS, and a refilled
// table would read as empty.
test('real server: a refill hidden by row-level security is still caught', { timeout: 60000 }, async (t) => {
  const s = await scratchDatabase(t, 'trunc_rls');
  if (!s) return;
  const role = `trunc_rls_admin_${crypto.randomBytes(4).toString('hex')}`;
  await s.client.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'local-test-only'`);
  t.after(async () => {
    const url = new URL(DSN);
    const admin = new Client({ connectionString: String(url) });
    await admin.connect();
    await admin.query(`DROP OWNED BY ${role}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    await admin.end();
  });
  await s.client.query(`GRANT ALL ON SCHEMA public TO ${role}`);
  const url = new URL(DSN); url.pathname = `/${s.name}`; url.username = role; url.password = 'local-test-only';
  const ordinary = new Client({ connectionString: String(url) });
  // The scratch database is dropped WITH (FORCE) first, which ends this session.
  ordinary.on('error', () => {});
  await ordinary.connect();
  t.after(() => ordinary.end().catch(() => {}));
  await ordinary.query(`
    CREATE TABLE a (id serial PRIMARY KEY); CREATE TABLE b (id serial PRIMARY KEY, secret text);
    COMMENT ON TABLE a IS 'staging:private'; COMMENT ON TABLE b IS 'staging:private';
    CREATE FUNCTION refill_b() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO b (secret) VALUES ('fixture'); RETURN NULL; END $$;
    CREATE TRIGGER a_refills_b AFTER TRUNCATE ON a FOR EACH STATEMENT EXECUTE FUNCTION refill_b();
    ALTER TABLE b ENABLE ROW LEVEL SECURITY; ALTER TABLE b FORCE ROW LEVEL SECURITY;
    CREATE POLICY can_insert ON b FOR INSERT WITH CHECK (true);
    CREATE POLICY cannot_read ON b FOR SELECT USING (false);
    INSERT INTO a DEFAULT VALUES; INSERT INTO b (secret) VALUES ('secret');
  `);
  const statements = [];
  const execute = async (db, sql, opts = {}) => {
    statements.push(sql);
    const result = await ordinary.query({ text: sql, rowMode: 'array' });
    return opts.tuplesOnly ? result.rows.map((row) => row.join('|')).join('\n') : '';
  };
  assert.equal((await ordinary.query('SELECT count(*)::int AS n FROM b')).rows[0].n, 0, 'the role cannot see b\'s rows');
  await truncatePrivateTables(s.name, execute);
  assert.ok(statements.includes('TRUNCATE public.b RESTART IDENTITY CASCADE'), 'the refill was seen, and the per-table pass ran');
  assert.equal((await s.client.query('SELECT count(*)::int AS n FROM b')).rows[0].n, 0, 'b is empty, as a superuser sees it');
});

test('real server: after a failed statement, a refill left by the per-table pass fails it', { timeout: 60000 }, async (t) => {
  const s = await scratchDatabase(t, 'trunc_fallback_check');
  if (!s) return;
  await s.client.query(`
    CREATE TABLE a (id int); CREATE TABLE b (id int);
    COMMENT ON TABLE a IS 'staging:private'; COMMENT ON TABLE b IS 'staging:private';
    CREATE FUNCTION refuse_many() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF current_query() LIKE '%, %' THEN RAISE EXCEPTION 'refused'; END IF; RETURN NULL; END $$;
    CREATE TRIGGER refuse BEFORE TRUNCATE ON a FOR EACH STATEMENT EXECUTE FUNCTION refuse_many();
    CREATE FUNCTION refill_a() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO a VALUES (1); RETURN NULL; END $$;
    CREATE TRIGGER b_refills_a AFTER TRUNCATE ON b FOR EACH STATEMENT EXECUTE FUNCTION refill_a();
  `);
  await assert.rejects(truncatePrivateTables(s.name, s.execute), /public\.a \(still holds rows after TRUNCATE\)/);
});

test('real server: a refilled inheritance child of a private table is caught', { timeout: 60000 }, async (t) => {
  const s = await scratchDatabase(t, 'trunc_inherit');
  if (!s) return;
  await s.client.query(`
    CREATE TABLE a (id int); CREATE TABLE parent (id int); CREATE TABLE child () INHERITS (parent);
    COMMENT ON TABLE a IS 'staging:private'; COMMENT ON TABLE parent IS 'staging:private';
    INSERT INTO child VALUES (1);
    CREATE FUNCTION refill_child() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO child VALUES (2); RETURN NULL; END $$;
    CREATE TRIGGER a_refills_child AFTER TRUNCATE ON a FOR EACH STATEMENT EXECUTE FUNCTION refill_child();
  `);
  await truncatePrivateTables(s.name, s.execute);
  assert.ok(s.statements.includes('TRUNCATE public.parent RESTART IDENTITY CASCADE'), 'the per-table pass ran');
  assert.equal((await s.client.query('SELECT count(*)::int AS n FROM parent')).rows[0].n, 0);
});

// A foreign child can also appear after discovery: a TRUNCATE trigger may
// create one. Found by the check, it refuses the copy at once; it is never
// handed to the per-table pass, whose TRUNCATE would reach the remote table.
test('real server: a foreign child created by a TRUNCATE trigger after discovery is refused', { timeout: 60000 }, async (t) => {
  const s = await scratchDatabase(t, 'trunc_dynforeign');
  if (!s) return;
  const live = await scratchDatabase(t, 'trunc_dynforeign_live');
  try { await s.client.query('CREATE EXTENSION postgres_fdw'); } catch (err) {
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip(`postgres_fdw unavailable: ${err.message}`); return;
  }
  await live.client.query('CREATE TABLE store (id int); INSERT INTO store VALUES (1), (2)');
  const url = new URL(DSN);
  const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
  await s.client.query(`
    CREATE SERVER live_app FOREIGN DATA WRAPPER postgres_fdw
      OPTIONS (host ${lit(url.hostname)}, port ${lit(url.port || '5432')}, dbname ${lit(live.name)});
    CREATE USER MAPPING FOR CURRENT_USER SERVER live_app
      OPTIONS (user ${lit(decodeURIComponent(url.username))}, password ${lit(decodeURIComponent(url.password))});
    CREATE TABLE a (id int); CREATE TABLE b (id int);
    COMMENT ON TABLE a IS 'staging:private'; COMMENT ON TABLE b IS 'staging:private';
    CREATE FUNCTION add_foreign_child() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      CREATE FOREIGN TABLE IF NOT EXISTS b_dyn () INHERITS (b) SERVER live_app OPTIONS (table_name 'store');
      RETURN NULL; END $$;
    CREATE TRIGGER a_adds_child AFTER TRUNCATE ON a FOR EACH STATEMENT EXECUTE FUNCTION add_foreign_child();
  `);
  s.statements.length = 0;
  await assert.rejects(truncatePrivateTables(s.name, s.execute),
    /Refusing to empty the staging:private tables in trunc_dynforeign_[0-9a-f]+: public\.b has the foreign-table descendant public\.b_dyn/);
  assert.equal(s.statements.filter((sql) => /^TRUNCATE/.test(sql)).length, 1, 'no per-table pass');
  assert.equal((await live.client.query('SELECT count(*)::int AS n FROM store')).rows[0].n, 2, 'the remote rows are untouched');
});

test('real server: a table left with pages but no live row passes without the per-table pass', { timeout: 60000 }, async (t) => {
  const s = await scratchDatabase(t, 'trunc_deadrow');
  if (!s) return;
  await s.client.query(`
    CREATE TABLE a (id int); CREATE TABLE b (id int);
    COMMENT ON TABLE a IS 'staging:private'; COMMENT ON TABLE b IS 'staging:private';
    CREATE FUNCTION touch_b() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO b VALUES (1); DELETE FROM b; RETURN NULL; END $$;
    CREATE TRIGGER a_touches_b AFTER TRUNCATE ON a FOR EACH STATEMENT EXECUTE FUNCTION touch_b();
  `);
  const result = await truncatePrivateTables(s.name, s.execute);
  assert.deepEqual(result.truncated, ['public.a', 'public.b']);
  assert.ok((await s.client.query("SELECT pg_relation_size('b') AS n")).rows[0].n > 0, 'b keeps a page of dead rows');
  assert.equal(s.statements.filter((sql) => /^TRUNCATE/.test(sql)).length, 1, 'no per-table pass');
  assert.equal(s.statements.filter((sql) => /^DO \$staging_check\$/.test(sql)).length, 1, 'b was read, not trusted by size');
});

// TRUNCATE reaches a foreign inheritance child and, through postgres_fdw,
// empties the REMOTE table, which in a copy is the live app's. The pass
// refuses such a table before sending any TRUNCATE.
test('real server: a foreign-table descendant is refused, and the remote rows are not touched', { timeout: 60000 }, async (t) => {
  const s = await scratchDatabase(t, 'trunc_foreign');
  if (!s) return;
  const live = await scratchDatabase(t, 'trunc_foreign_live');
  try { await s.client.query('CREATE EXTENSION postgres_fdw'); } catch (err) {
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip(`postgres_fdw unavailable: ${err.message}`); return;
  }
  await live.client.query("CREATE TABLE store (id int); INSERT INTO store VALUES (1), (2)");
  const url = new URL(DSN);
  const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
  await s.client.query(`
    CREATE SERVER live_app FOREIGN DATA WRAPPER postgres_fdw
      OPTIONS (host ${lit(url.hostname)}, port ${lit(url.port || '5432')}, dbname ${lit(live.name)});
    CREATE USER MAPPING FOR CURRENT_USER SERVER live_app
      OPTIONS (user ${lit(decodeURIComponent(url.username))}, password ${lit(decodeURIComponent(url.password))});
    CREATE TABLE a (id int); CREATE TABLE b (id int);
    CREATE FOREIGN TABLE b_remote () INHERITS (b) SERVER live_app OPTIONS (table_name 'store');
    COMMENT ON TABLE a IS 'staging:private'; COMMENT ON TABLE b IS 'staging:private';
    INSERT INTO a VALUES (1);
  `);
  s.statements.length = 0;
  await assert.rejects(truncatePrivateTables(s.name, s.execute),
    /Refusing to empty the staging:private tables in trunc_foreign_[0-9a-f]+: public\.b has the foreign-table descendant public\.b_remote/);
  assert.equal(s.statements.length, 1, 'discovery, and nothing after it');
  assert.equal((await live.client.query('SELECT count(*)::int AS n FROM store')).rows[0].n, 2, 'the remote rows are untouched');
  assert.equal((await s.client.query('SELECT count(*)::int AS n FROM ONLY a')).rows[0].n, 1, 'no local table was emptied either');
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
