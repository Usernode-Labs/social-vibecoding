'use strict';

// A throwaway database that already holds src/db/schema.sql.
//
// About a hundred suites start the same way: CREATE DATABASE, then the whole
// schema in one query. Parsing and applying 12,500 lines of DDL was the
// largest part of each of those suites' setup, repeated by every one of them
// against the same server. Postgres can copy a database instead:
//
//   CREATE DATABASE <name> TEMPLATE <template>
//
// so the schema is applied ONCE per server, into a template, and every suite
// gets a copy of it. `createSchemaDatabase(admin, name)` stands where
// `admin.query(`CREATE DATABASE ${name}`)` stood, and the suite's own
// `pool.query(schema)` goes away. Everything else about the suite (how it
// finds the server, when it skips, its pool, its teardown) is untouched.
//
// THE TEMPLATE
//
// It is named for a hash of schema.sql's bytes, so a changed schema is a
// different template and never an old one reused. It is built lazily, by
// whichever process first finds it missing, and three things keep that safe
// with many suites starting at once:
//
//   * One builder. A session-level advisory lock is taken before building,
//     and everyone who waited for it finds the template already there.
//   * Never half-built. The schema is loaded into a database with a
//     different, random name; the template's name appears only when that
//     database is complete, through ALTER DATABASE … RENAME, which is one
//     catalog update. A builder that dies leaves a database nobody copies.
//   * Never written. Before it gets its name the database is marked
//     IS_TEMPLATE with ALLOW_CONNECTIONS false, as template0 is: nothing can
//     connect to it, so no suite can change what the next one copies, and no
//     stray session can make a copy fail. A copy does not inherit either flag.
//
// The advisory lock is an economy, not the guarantee: it is scoped to the
// database the admin connection is on, so two suites pointed at different
// admin databases of one server could both build. The rename decides between
// them (the second one fails on the name and uses the first one's template).
//
// What a copy does NOT carry is anything stored outside the database:
// ALTER DATABASE … SET and GRANT … ON DATABASE. schema.sql has neither, and
// tests/schema-database.test.js fails if it gains one.
//
// What a copy carries that a fresh load would not is the template's age: the
// rows schema.sql seeds (platform_settings, agent_model_compatibility, the
// #general conversation) keep the times they were given when the template
// was built, and so does the one setting schema.sql stamps with NOW()
// (model_cost_observed_since). In a check run that is seconds earlier; on a
// long-lived local server it can be days. The converted suites were run
// against a template aged thirty days and none of them noticed, but a new
// suite that reads a seeded row's time should not assume it is "now".
//
// A suite that does more than "fresh database, the whole schema, once" keeps
// its own setup: one that seeds an older shape first, sets a database option
// before loading, or applies the schema twice to prove it can be re-applied.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_FILE = path.join(__dirname, '..', '..', 'src', 'db', 'schema.sql');
const PREFIX = 'schema_template_';
// Templates are kept for a server's lifetime in a check run, which is one
// job. On a developer's long-lived server, a build also drops the templates
// of other schema versions once they are this old.
const KEEP_OTHERS_MS = 7 * 24 * 60 * 60 * 1000;

const UNDEFINED_DATABASE = '3D000';
const DUPLICATE_DATABASE = '42P04';

function schemaText() {
  return fs.readFileSync(SCHEMA_FILE, 'utf8');
}

function templateNameFor(schema) {
  return PREFIX + crypto.createHash('sha256').update(schema).digest('hex').slice(0, 20);
}

// One session to do everything on: an advisory lock belongs to a session,
// and a pool of one (several suites use `max: 1`) has no second connection
// to lend while the first is held.
async function borrow(admin) {
  const isPool = typeof admin.totalCount === 'number' && typeof admin.connect === 'function';
  if (!isPool) return { client: admin, release() {} };
  const client = await admin.connect();
  return { client, release: () => client.release() };
}

async function exists(client, name) {
  const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  return rows.length > 0;
}

// The other databases this helper made on the server: half-built ones whose
// builder is gone, and templates of other schema versions that have had
// their week. A builder names its session after the database it is building,
// so "gone" is "no session carries that name". Best-effort throughout: a
// database in use refuses to drop, and that is the right answer.
async function tidy(client, keep) {
  const { rows } = await client.query(
    `SELECT d.datname AS name, d.datistemplate AS template, shobj_description(d.oid, 'pg_database') AS note,
            EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.application_name = d.datname) AS alive
       FROM pg_database d
      WHERE d.datname LIKE $1 AND d.datname <> $2`,
    [`${PREFIX.replace(/_/g, '\\_')}%`, keep],
  );
  for (const row of rows) {
    const building = /_building_[0-9a-f]+$/.test(row.name);
    const builtAt = Date.parse(row.note || '');
    const old = Number.isFinite(builtAt) && Date.now() - builtAt > KEEP_OTHERS_MS;
    if (!(building ? !row.alive : old)) continue;
    try {
      if (row.template) await client.query(`ALTER DATABASE ${row.name} IS_TEMPLATE false`);
      await client.query(`DROP DATABASE IF EXISTS ${row.name}`);
    } catch { /* in use, or already gone */ }
  }
}

async function build(client, template, schema) {
  const { Client } = require('pg');
  await tidy(client, template).catch(() => {});
  const building = `${template}_building_${crypto.randomBytes(6).toString('hex')}`;
  // Says "this half-built database has a living builder" to anyone tidying.
  await client.query(`SET application_name = '${building}'`);
  try {
    await client.query(`CREATE DATABASE ${building}`);
    const params = client.connectionParameters;
    const loader = new Client({
      host: params.host, port: params.port, user: params.user, password: params.password, ssl: params.ssl,
      database: building,
    });
    await loader.connect();
    try {
      await loader.query(schema);
    } finally {
      await loader.end();
    }
    await client.query(`COMMENT ON DATABASE ${building} IS '${new Date().toISOString()}'`);
    await client.query(`ALTER DATABASE ${building} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
    await client.query(`ALTER DATABASE ${building} RENAME TO ${template}`);
  } catch (err) {
    await client.query(`ALTER DATABASE ${building} IS_TEMPLATE false`).catch(() => {});
    await client.query(`DROP DATABASE IF EXISTS ${building}`).catch(() => {});
    // Someone on another admin database published first: theirs is the same
    // schema under the same name.
    if (err.code === DUPLICATE_DATABASE && await exists(client, template)) return false;
    throw err;
  } finally {
    await client.query('RESET application_name').catch(() => {});
  }
  return true;
}

// Make sure the template for this schema exists. Answers with its name and
// whether this call was the one that built it.
async function ensureSchemaTemplate(admin, { schema = schemaText() } = {}) {
  const template = templateNameFor(schema);
  const session = await borrow(admin);
  try {
    if (await exists(session.client, template)) return { template, built: false };
    const key = crypto.createHash('sha256').update(template).digest().readBigInt64BE(0).toString();
    await session.client.query('SELECT pg_advisory_lock($1::bigint)', [key]);
    try {
      if (await exists(session.client, template)) return { template, built: false };
      return { template, built: await build(session.client, template, schema) };
    } finally {
      await session.client.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
    }
  } finally {
    session.release();
  }
}

// CREATE DATABASE <name>, holding the whole schema. `admin` is the suite's
// own admin Pool or Client, connected to the server's maintenance database.
// Answers `{ template, built }`: which template the copy came from and
// whether this call had to build it.
async function createSchemaDatabase(admin, name, { schema = schemaText() } = {}) {
  const template = templateNameFor(schema);
  let built = false;
  // The common case is one statement: the template is there.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await admin.query(`CREATE DATABASE ${name} TEMPLATE ${template}`);
      return { template, built };
    } catch (err) {
      // Missing on a server's first use, or tidied away by a run on another
      // schema version: build it and copy again.
      if (err.code !== UNDEFINED_DATABASE || attempt >= 3) throw err;
      built = (await ensureSchemaTemplate(admin, { schema })).built || built;
    }
  }
}

module.exports = { createSchemaDatabase, ensureSchemaTemplate, templateNameFor, schemaText };
