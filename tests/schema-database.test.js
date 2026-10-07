'use strict';

// tests/lib/schema-database.js: a suite's throwaway database as a copy of a
// template that already holds src/db/schema.sql.
//
// Like the suites that use it, this one needs a PostgreSQL it may create
// databases on, and skips when none is reachable unless TEST_DATABASE_URL
// insists. Everything except the one comparison with the real schema uses a
// two-line schema with a random marker in it: its template has a name of its
// own, so nothing here builds, ages or drops the template other suites are
// copying at the same moment.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { Pool, Client } = require('pg');
const {
  createSchemaDatabase, ensureSchemaTemplate, templateNameFor, schemaText,
} = require('./lib/schema-database');

const ROOT = path.join(__dirname, '..');
const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const random = () => crypto.randomBytes(6).toString('hex');
const urlFor = (database) => { const url = new URL(DSN); url.pathname = `/${database}`; return String(url); };

// A schema nobody else has: one table, one seeded row.
function tinySchema({ slowSeconds = 0 } = {}) {
  const marker = random();
  const pause = slowSeconds ? `SELECT pg_sleep(${slowSeconds});\n` : '';
  return { marker, schema: `${pause}CREATE TABLE marker (value text);\nINSERT INTO marker (value) VALUES ('${marker}');\n` };
}

// The admin pool, or null after skipping. Whatever a test makes on the
// server is dropped when it ends: every database whose name carries one of
// the test's own strings, templates included.
async function server(t) {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return null;
  }
  const mine = [];
  t.after(async () => {
    for (const part of mine) {
      const { rows } = await admin.query(
        'SELECT datname AS name, datistemplate AS template FROM pg_database WHERE datname LIKE $1', [`%${part}%`]);
      for (const row of rows) {
        if (row.template) await admin.query(`ALTER DATABASE ${row.name} IS_TEMPLATE false`).catch(() => {});
        await admin.query(`DROP DATABASE IF EXISTS ${row.name} WITH (FORCE)`).catch(() => {});
      }
    }
    await admin.end();
  });
  // Register a string that names databases this test owns, and get it back.
  admin.own = (part) => { mine.push(part); return part; };
  return admin;
}

async function databasesLike(admin, pattern) {
  const { rows } = await admin.query(
    'SELECT datname AS name, datistemplate AS template, datallowconn AS connectable FROM pg_database WHERE datname LIKE $1 ORDER BY 1',
    [pattern]);
  return rows;
}

async function markers(database) {
  const client = new Client({ connectionString: urlFor(database) });
  await client.connect();
  try { return (await client.query('SELECT value FROM marker ORDER BY 1')).rows.map((row) => row.value); } finally { await client.end(); }
}

test('schema.sql holds nothing that a copy of a loaded database would lose', () => {
  // A copy carries what is IN the database. Settings and grants ON the
  // database, and roles and tablespaces beside it, are stored elsewhere.
  const sql = schemaText().split('\n').map((line) => line.replace(/--.*$/, '')).join('\n');
  const outside = [
    ['a database setting', /\bALTER\s+DATABASE\b/i],
    ['a grant, comment or label on the database', /\bON\s+DATABASE\b/i],
    ['a role or tablespace', /\b(CREATE|ALTER|DROP)\s+(ROLE|USER|GROUP|TABLESPACE)\b/i],
    ['a server setting', /\bALTER\s+SYSTEM\b/i],
    ['the database\'s own name', /\bcurrent_database\s*\(/i],
  ];
  for (const [what, pattern] of outside) {
    assert.doesNotMatch(sql, pattern, `schema.sql now has ${what}: a suite that copies the template would not get it`);
  }
});

// schema.sql stamps this one setting with NOW()::text. In a copy it holds the
// moment the template was built, which is earlier than the copy: the marker
// means "count what happened since", so an earlier one only counts more.
// It is named here so that the next value of this kind does not slip in
// unseen: the comparison below fails on it, and whoever adds it decides
// whether an earlier time is as harmless for it.
const LOAD_TIME_SETTING = /^(public\.platform_settings \{"key": "model_cost_observed_since", "value": ")[^"]+(")/;

// Everything the schema leaves in a database, in a comparable form.
async function describe(database) {
  const client = new Client({ connectionString: urlFor(database) });
  await client.connect();
  const all = async (sql) => (await client.query(sql)).rows.map((row) => JSON.stringify(row));
  const user = "NOT IN ('pg_catalog', 'information_schema', 'pg_toast')";
  try {
    const out = {
      schemas: await all(`SELECT nspname FROM pg_namespace WHERE nspname ${user} AND nspname NOT LIKE 'pg\\_%' ORDER BY 1`),
      extensions: await all('SELECT extname, extversion FROM pg_extension ORDER BY 1'),
      columns: await all(`SELECT table_schema, table_name, ordinal_position, column_name, data_type, udt_name, is_nullable, column_default
                            FROM information_schema.columns WHERE table_schema ${user} ORDER BY 1, 2, 3`),
      indexes: await all(`SELECT schemaname, tablename, indexname, indexdef FROM pg_indexes WHERE schemaname ${user} ORDER BY 1, 2, 3`),
      constraints: await all(`SELECT conrelid::regclass::text AS "table", conname, pg_get_constraintdef(c.oid) AS definition
                                FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
                               WHERE n.nspname ${user} ORDER BY 1, 2, 3`),
      functions: await all(`SELECT n.nspname, p.proname, pg_get_functiondef(p.oid) AS definition
                              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                             WHERE n.nspname ${user} AND p.prokind IN ('f', 'p') ORDER BY 1, 2, 3`),
      triggers: await all(`SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid) AS definition
                             FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                            WHERE NOT t.tgisinternal AND n.nspname ${user} ORDER BY 1, 2`),
      views: await all(`SELECT schemaname, viewname, definition FROM pg_views WHERE schemaname ${user} ORDER BY 1, 2`),
      sequences: await all(`SELECT schemaname, sequencename, last_value FROM pg_sequences WHERE schemaname ${user} ORDER BY 1, 2`),
      comments: await all(`SELECT n.nspname, c.relname, obj_description(c.oid, 'pg_class') AS comment
                             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                            WHERE n.nspname ${user} AND obj_description(c.oid, 'pg_class') IS NOT NULL ORDER BY 1, 2`),
      rows: [],
    };
    // Seeded rows, without the times they were written at: every time
    // column, and the one setting whose VALUE is the time of the load.
    const { rows: tables } = await client.query(
      `SELECT t.table_schema AS schema, t.table_name AS name,
              (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I', t.table_schema, t.table_name), false, true, '')))[1]::text::int AS count,
              COALESCE((SELECT array_agg(c.column_name::text) FROM information_schema.columns c
                         WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name
                           AND c.data_type IN ('timestamp with time zone', 'timestamp without time zone', 'date')), '{}') AS timed
         FROM information_schema.tables t
        WHERE t.table_type = 'BASE TABLE' AND t.table_schema ${user} ORDER BY 1, 2`);
    for (const table of tables) {
      out.rows.push(`${table.schema}.${table.name}: ${table.count}`);
      if (!table.count) continue;
      const { rows } = await client.query(
        `SELECT (to_jsonb(t) - $1::text[])::text AS row FROM "${table.schema}"."${table.name}" t ORDER BY 1`, [table.timed]);
      out.rows.push(...rows.map((row) => `${table.schema}.${table.name} ${row.row}`
        .replace(LOAD_TIME_SETTING, '$1<the time of the load>$2')));
    }
    return out;
  } finally {
    await client.end();
  }
}

test('a copy is the same database as a fresh load of the schema', { timeout: 180000 }, async (t) => {
  const admin = await server(t);
  if (!admin) return;
  const tag = admin.own(`schema_db_same_${random()}`);
  await admin.query(`CREATE DATABASE ${tag}_loaded`);
  const loader = new Client({ connectionString: urlFor(`${tag}_loaded`) });
  await loader.connect();
  try { await loader.query(schemaText()); } finally { await loader.end(); }
  const made = await createSchemaDatabase(admin, `${tag}_copied`);
  assert.equal(made.template, templateNameFor(schemaText()));

  const loaded = await describe(`${tag}_loaded`);
  const copied = await describe(`${tag}_copied`);
  assert.ok(loaded.columns.length > 1000 && loaded.rows.length > 200, 'the comparison saw the whole schema');
  for (const part of Object.keys(loaded)) assert.deepEqual(copied[part], loaded[part], `${part} differ between a copy and a fresh load`);
});

test('the template takes no connections and no writes; a copy is an ordinary database of its own', { timeout: 60000 }, async (t) => {
  const admin = await server(t);
  if (!admin) return;
  const { marker, schema } = tinySchema();
  const template = admin.own(templateNameFor(schema));
  const tag = admin.own(`schema_db_own_${random()}`);

  assert.deepEqual(await createSchemaDatabase(admin, `${tag}_a`, { schema }), { template, built: true });
  assert.deepEqual(await databasesLike(admin, template), [{ name: template, template: true, connectable: false }]);
  await assert.rejects(markers(template), /not currently accepting connections/);
  assert.deepEqual(await databasesLike(admin, `${tag}_a`), [{ name: `${tag}_a`, template: false, connectable: true }]);

  const writer = new Client({ connectionString: urlFor(`${tag}_a`) });
  await writer.connect();
  await writer.query("INSERT INTO marker (value) VALUES ('written by a suite')");
  await writer.end();
  assert.deepEqual(await markers(`${tag}_a`), [marker, 'written by a suite'].sort());

  assert.deepEqual(await createSchemaDatabase(admin, `${tag}_b`, { schema }), { template, built: false });
  assert.deepEqual(await markers(`${tag}_b`), [marker], 'the next copy starts from the schema alone');
  assert.deepEqual(await ensureSchemaTemplate(admin, { schema }), { template, built: false });
});

test('many processes starting at once on a server with no template build it exactly once', { timeout: 120000 }, async (t) => {
  const admin = await server(t);
  if (!admin) return;
  // Slow enough to load that every process arrives while the first builds.
  const { marker, schema } = tinySchema({ slowSeconds: 0.5 });
  const template = admin.own(templateNameFor(schema));
  const tag = admin.own(`schema_db_many_${random()}`);
  const child = `
    const { Pool } = require('pg');
    const { createSchemaDatabase } = require('./tests/lib/schema-database');
    (async () => {
      const admin = new Pool({ connectionString: process.env.CHILD_DSN, connectionTimeoutMillis: 5000 });
      try {
        const made = await createSchemaDatabase(admin, process.env.CHILD_DATABASE, { schema: process.env.CHILD_SCHEMA });
        process.stdout.write(JSON.stringify(made));
      } finally { await admin.end(); }
    })().catch((err) => { console.error(err); process.exit(1); });
  `;
  const count = 8;
  const env = { ...process.env, CHILD_DSN: DSN, CHILD_SCHEMA: schema };
  delete env.NODE_TEST_CONTEXT;
  const results = await Promise.all(Array.from({ length: count }, (_, i) => new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', child], { cwd: ROOT, env: { ...env, CHILD_DATABASE: `${tag}_${i}` } }, (err, stdout, stderr) => {
      if (err) reject(new Error(`process ${i} failed: ${stderr || err.message}`)); else resolve(JSON.parse(stdout));
    });
  })));

  assert.equal(results.filter((made) => made.built).length, 1, 'one process built the template');
  assert.ok(results.every((made) => made.template === template));
  assert.deepEqual(await databasesLike(admin, `${template}%`), [{ name: template, template: true, connectable: false }],
    'one template, and no half-built database left beside it');
  for (let i = 0; i < count; i += 1) assert.deepEqual(await markers(`${tag}_${i}`), [marker]);
});

test('a schema that fails to load publishes nothing; a dead builder\'s database is never copied', { timeout: 60000 }, async (t) => {
  const admin = await server(t);
  if (!admin) return;
  const tag = admin.own(`schema_db_half_${random()}`);

  const broken = `CREATE TABLE marker (value text);\nSELEC this is not SQL ${random()};\n`;
  const brokenTemplate = admin.own(templateNameFor(broken));
  await assert.rejects(createSchemaDatabase(admin, `${tag}_broken`, { schema: broken }), /syntax error/);
  assert.deepEqual(await databasesLike(admin, `${brokenTemplate}%`), [], 'no template and nothing half-built');
  assert.deepEqual(await databasesLike(admin, `${tag}_broken`), []);

  // What a builder that died mid-load leaves: its database, under its
  // building name, with part of a schema in it and no session behind it.
  const { marker, schema } = tinySchema();
  const template = admin.own(templateNameFor(schema));
  const orphan = `${template}_building_${random()}`;
  await admin.query(`CREATE DATABASE ${orphan}`);
  // One with a living builder, which must be left alone.
  const { schema: otherSchema } = tinySchema();
  const alive = `${admin.own(templateNameFor(otherSchema))}_building_${random()}`;
  const builder = new Client({ connectionString: DSN, application_name: alive });
  await builder.connect();
  t.after(() => builder.end().catch(() => {}));
  await builder.query(`CREATE DATABASE ${alive}`);

  assert.deepEqual(await createSchemaDatabase(admin, `${tag}_good`, { schema }), { template, built: true });
  assert.deepEqual(await markers(`${tag}_good`), [marker], 'copied from a complete template, not from the orphan');
  assert.deepEqual(await databasesLike(admin, `${template}%`), [{ name: template, template: true, connectable: false }],
    'and the build dropped the orphan');
  assert.equal((await databasesLike(admin, alive)).length, 1, 'a half-built database whose builder is alive is kept');
});

test('a changed schema gets a template of its own; another version\'s is kept for a week', { timeout: 60000 }, async (t) => {
  const admin = await server(t);
  if (!admin) return;
  const tag = admin.own(`schema_db_versions_${random()}`);
  const first = tinySchema();
  const second = tinySchema();
  const third = tinySchema();
  const [a, b, c] = [first, second, third].map((version) => admin.own(templateNameFor(version.schema)));
  assert.equal(new Set([a, b, c]).size, 3);
  assert.equal(templateNameFor(first.schema), a, 'the same text is the same template');

  await createSchemaDatabase(admin, `${tag}_1`, { schema: first.schema });
  await createSchemaDatabase(admin, `${tag}_2`, { schema: second.schema });
  assert.deepEqual(await markers(`${tag}_1`), [first.marker]);
  assert.deepEqual(await markers(`${tag}_2`), [second.marker]);
  assert.equal((await databasesLike(admin, a)).length, 1, 'the first version\'s template is still there: another checkout may be using it');

  // Eight days on, the next build clears it. The second version is recent.
  const { rows } = await admin.query("SELECT shobj_description(oid, 'pg_database') AS built FROM pg_database WHERE datname = $1", [a]);
  assert.ok(Math.abs(Date.now() - Date.parse(rows[0].built)) < 60000, 'a template records when it was built');
  await admin.query(`COMMENT ON DATABASE ${a} IS '${new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()}'`);
  await createSchemaDatabase(admin, `${tag}_3`, { schema: third.schema });
  assert.deepEqual(await databasesLike(admin, a), []);
  assert.equal((await databasesLike(admin, b)).length, 1);
  assert.deepEqual(await markers(`${tag}_1`), [first.marker], 'databases already copied from it are untouched');
});

test('two builders on different admin databases end with one template', { timeout: 60000 }, async (t) => {
  const admin = await server(t);
  if (!admin) return;
  // The advisory lock belongs to the database a session is on, so these two
  // do not wait for each other: both build, and the rename decides.
  const tag = admin.own(`schema_db_two_${random()}`);
  await admin.query(`CREATE DATABASE ${tag}_admin`);
  const elsewhere = new Pool({ connectionString: urlFor(`${tag}_admin`), connectionTimeoutMillis: 2000 });
  const { marker, schema } = tinySchema({ slowSeconds: 0.5 });
  const template = admin.own(templateNameFor(schema));

  let made;
  try {
    made = await Promise.all([
      createSchemaDatabase(admin, `${tag}_x`, { schema }),
      createSchemaDatabase(elsewhere, `${tag}_y`, { schema }),
    ]);
  } finally {
    // Before the test's databases are dropped: this pool lives on one of them.
    await elsewhere.end();
  }
  assert.equal(made.filter((one) => one.built).length, 1, 'both built; one published');
  assert.deepEqual(await databasesLike(admin, `${template}%`), [{ name: template, template: true, connectable: false }]);
  assert.deepEqual(await markers(`${tag}_x`), [marker]);
  assert.deepEqual(await markers(`${tag}_y`), [marker]);
});

test('an admin pool of one connection and a plain client both work', { timeout: 60000 }, async (t) => {
  const admin = await server(t);
  if (!admin) return;
  const tag = admin.own(`schema_db_admins_${random()}`);

  const one = tinySchema();
  admin.own(templateNameFor(one.schema));
  const single = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000, max: 1 });
  t.after(() => single.end());
  assert.equal((await createSchemaDatabase(single, `${tag}_pool`, { schema: one.schema })).built, true);
  assert.deepEqual(await markers(`${tag}_pool`), [one.marker]);
  assert.equal(single.totalCount, 1, 'it never needed a second connection');

  const two = tinySchema();
  admin.own(templateNameFor(two.schema));
  const client = new Client({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  await client.connect();
  t.after(() => client.end());
  assert.equal((await createSchemaDatabase(client, `${tag}_client`, { schema: two.schema })).built, true);
  assert.deepEqual(await markers(`${tag}_client`), [two.marker]);
  assert.equal((await client.query('SHOW application_name')).rows[0].application_name, '', 'the builder\'s session name is put back');
});
