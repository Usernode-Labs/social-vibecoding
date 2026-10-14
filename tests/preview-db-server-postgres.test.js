'use strict';

// A second Postgres server for preview databases (STAGING_DB_ADMIN_URL,
// src/services/db-manager.js), against TWO REAL servers. Pinned here:
//   - with the setting, a preview's template, its clone and the clone's role
//     are made on the preview server and nothing is made on the main one;
//     the dump is read from the main server and restored across, including
//     from an older main server into a newer preview server;
//   - the redaction holds across the move: private tables arrive empty,
//     private columns are scrubbed, and a redaction that cannot be done
//     fails the clone instead of handing out a database;
//   - on PostgreSQL 18 or later the preview server is asked for a
//     shared-block copy (file_copy_method = clone, STRATEGY = FILE_COPY) and
//     the main server never is;
//   - a wiped preview server is noticed (previewDatabaseVerdict, from the runtime's labels) and the
//     next clone rebuilds the template and copies again;
//   - switching both ways: draining makes new previews on the main server
//     while old ones are still found and dropped on the preview server, the
//     app's template follows the server that makes previews, and a preview
//     made before the setting existed is dropped from the main server;
//   - a shots run's frozen source and its two clones stay together on the
//     preview server;
//   - an app fork's database stays on the main server;
//   - an unreachable preview server fails the clone as a platform fault and
//     makes nothing on the main server; its password is in no error;
//   - one server reached under two addresses is recognised: no file copy,
//     and the template is not retired from under itself.
//
// The main server is TEST_DATABASE_URL (or DATABASE_URL, or the usual local
// default). The preview server is TEST_PREVIEW_DATABASE_URL, by default
// postgres://postgres:postgres@127.0.0.1:5433/postgres. Skipped when either
// is unreachable, and required when TEST_PREVIEW_DATABASE_URL is set.
// Every database is a throwaway with a random name; the main server also
// gets a `usernode` maintenance database if it has none, because that is the
// one db-manager connects to there.
//
// Run with: node --test tests/preview-db-server-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const pg = require('pg');

const MAIN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const PREVIEW = process.env.TEST_PREVIEW_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5433/postgres';
const REQUIRED = !!process.env.TEST_PREVIEW_DATABASE_URL;

const token = () => crypto.randomBytes(4).toString('hex');
const at = (dsn, database) => { const url = new URL(dsn); url.pathname = `/${database}`; return String(url); };

// Every pg_dump and pg_restore db-manager starts. Patched before db-manager
// is first required (in setup), because it takes `spawn` when it loads.
const childProcess = require('node:child_process');
const spawned = [];
const realSpawn = childProcess.spawn;
childProcess.spawn = function recordingSpawn(command, ...rest) {
  spawned.push(command);
  return realSpawn.call(this, command, ...rest);
};
test.after(() => { childProcess.spawn = realSpawn; });

// Every statement db-manager sends through pg, with the server it went to.
const sent = [];
const realQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function recordingQuery(config, ...rest) {
  const text = typeof config === 'string' ? config : config?.text;
  if (typeof text === 'string') sent.push({ port: String(this.port), host: this.host, text, client: this });
  return realQuery.call(this, config, ...rest);
};
test.after(() => { pg.Client.prototype.query = realQuery; });

async function connect(dsn) {
  const client = new pg.Client({ connectionString: dsn, connectionTimeoutMillis: 3000 });
  client.on('error', () => {});
  await client.connect();
  return client;
}

async function setup(t) {
  let main;
  let preview;
  try {
    main = await connect(MAIN);
    preview = await connect(PREVIEW);
  } catch (err) {
    await main?.end().catch(() => {});
    if (REQUIRED) throw err;
    t.skip('two PostgreSQL servers are needed; set TEST_PREVIEW_DATABASE_URL to require this check');
    return null;
  }
  const version = async (client) => Number((await client.query('SHOW server_version_num')).rows[0].server_version_num);
  const names = async (client, like) => (await client.query(
    'SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY 1', [like])).rows.map((row) => row.datname);
  const roles = async (client, like) => (await client.query(
    'SELECT rolname FROM pg_roles WHERE rolname LIKE $1 ORDER BY 1', [like])).rows.map((row) => row.rolname);
  const hadUsernode = (await names(main, 'usernode')).length === 1;
  if (!hadUsernode) await main.query('CREATE DATABASE usernode');

  const saved = {};
  for (const key of ['DB_ADMIN_URL', 'DATABASE_URL', 'STAGING_DB_ADMIN_URL', 'STAGING_DB_SERVER_DRAIN', 'STAGING_DB_FILE_CLONE', 'APP_RUNTIME']) {
    saved[key] = process.env[key];
  }
  process.env.DB_ADMIN_URL = at(MAIN, 'usernode');
  process.env.DATABASE_URL = MAIN;
  process.env.STAGING_DB_ADMIN_URL = PREVIEW;
  delete process.env.STAGING_DB_SERVER_DRAIN;
  delete process.env.STAGING_DB_FILE_CLONE;
  delete process.env.APP_RUNTIME;
  const dbManager = require('../src/services/db-manager');
  dbManager._resetPreviewServerStateForTest();

  const tok = token();
  const source = `app_pv${tok}`;
  const wipe = async (client) => {
    for (const name of await names(client, `%${tok}%`)) {
      await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    }
    for (const role of await roles(client, `%${tok}%`)) {
      await client.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    }
  };
  t.after(async () => {
    await dbManager._templateIdleForTest(source).catch(() => {});
    await wipe(preview);
    await wipe(main);
    if (!hadUsernode) await main.query('DROP DATABASE IF EXISTS usernode WITH (FORCE)').catch(() => {});
    await main.end();
    await preview.end();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    dbManager._resetPreviewServerStateForTest();
  });

  // The live source: an app's production database on the main server, owned
  // by its own role, with a private table, a table that references it, two
  // private columns and public rows.
  const seed = async (name, extraSql = '') => {
    await main.query(`CREATE ROLE ${name}_owner LOGIN PASSWORD 'source-password'`);
    await main.query(`CREATE DATABASE ${name} OWNER ${name}_owner`);
    const db = await connect(at(MAIN, name));
    try {
      await db.query(`
        CREATE TABLE notes (id serial PRIMARY KEY, body text NOT NULL);
        INSERT INTO notes (body) VALUES ('public one'), ('public two');
        CREATE TABLE people (id serial PRIMARY KEY, name text NOT NULL, token varchar(64) NOT NULL UNIQUE, secret text);
        INSERT INTO people (name, token, secret) VALUES ('ana', 'token-a', 'secret-a'), ('ben', 'token-b', 'secret-b');
        COMMENT ON COLUMN people.token IS 'staging:private';
        COMMENT ON COLUMN people.secret IS 'staging:private';
        CREATE TABLE vault (id serial PRIMARY KEY, data text);
        INSERT INTO vault (data) VALUES ('must never leave the main server');
        COMMENT ON TABLE vault IS 'staging:private';
        CREATE TABLE vault_refs (id serial PRIMARY KEY, vault_id int NOT NULL REFERENCES vault(id));
        INSERT INTO vault_refs (vault_id) VALUES (1);
        ${extraSql}
      `);
      for (const table of ['notes', 'people', 'vault', 'vault_refs']) {
        await db.query(`ALTER TABLE ${table} OWNER TO ${name}_owner`);
      }
    } finally { await db.end(); }
  };
  await seed(source);
  return {
    main, preview, dbManager, tok, source, seed, names, roles, wipe,
    mainVersion: await version(main), previewVersion: await version(preview),
    mainPort: String(new URL(MAIN).port || 5432), previewPort: String(new URL(PREVIEW).port || 5432),
  };
}

// What a preview would read: as the clone's own role, through the URL its
// container is given.
async function readClone(dbManager, target, cloned) {
  const url = dbManager.connectionUrl(target, cloned.password, { server: cloned.server });
  const db = await connect(url);
  try {
    return {
      url,
      notes: (await db.query('SELECT body FROM notes ORDER BY id')).rows.map((row) => row.body),
      people: (await db.query('SELECT name, token, secret FROM people ORDER BY id')).rows,
      vault: (await db.query('SELECT count(*)::int AS n FROM vault')).rows[0].n,
      vaultRefs: (await db.query('SELECT count(*)::int AS n FROM vault_refs')).rows[0].n,
      // The clone's role owns its tables: the preview's own boot migrates them.
      owned: await db.query('ALTER TABLE notes ADD COLUMN added_by_preview int').then(() => true),
    };
  } finally { await db.end(); }
}

function assertRedacted(read) {
  assert.deepEqual(read.notes, ['public one', 'public two'], 'public rows come across');
  assert.deepEqual(read.people.map((row) => row.name), ['ana', 'ben'], 'the rows of a table with private columns stay');
  for (const row of read.people) {
    assert.equal(row.secret, null, 'a nullable private column is NULL');
    assert.match(row.token, /^__staging_redacted__/, 'a NOT NULL private column is a placeholder');
  }
  assert.equal(read.vault, 0, 'a private table arrives empty');
  assert.equal(read.vaultRefs, 0, 'and so does a table that references it');
  assert.equal(read.owned, true);
}

test('preview databases live on the preview server, redacted, and the main server holds none of them', async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { main, preview, dbManager, tok, source, names, roles } = ctx;
  const target = `${source}_staging_s901_abc123`;
  sent.length = 0;

  const cloned = await dbManager.cloneDatabase(source, target, { viaTemplate: true });
  assert.equal(cloned.server, 'preview');
  assert.equal(cloned.via, 'template');
  assert.equal(cloned.templateRefreshed, true, 'the first build makes the template');
  assert.deepEqual(spawned.slice(-2).sort(), ['pg_dump', 'pg_restore'], 'by one dump of the source and one restore');

  assert.deepEqual(await names(preview, `%${tok}%`), [`${source}_staging_s901_abc123`, `${source}_stgtmpl`]);
  assert.deepEqual(await names(main, `%${tok}%`), [source], 'the main server has the live source and nothing else');
  assert.deepEqual(await roles(main, `%${tok}%`), [`${source}_owner`], 'no preview role is made on the main server');
  assert.deepEqual(await roles(preview, `%${tok}%`), [`${target}_owner`, `${source}_stgtmpl_owner`]);

  const template = (await preview.query(
    `SELECT datallowconn, shobj_description(oid, 'pg_database') AS stamp FROM pg_database WHERE datname = $1`,
    [`${source}_stgtmpl`])).rows[0];
  assert.equal(template.datallowconn, false);
  assert.match(template.stamp, new RegExp(`^staging-template source=${source} refreshed_at=`));

  const read = await readClone(dbManager, target, cloned);
  assert.equal(new URL(read.url).port, ctx.previewPort, 'the preview is handed the preview server\'s address');
  assertRedacted(read);

  // The copy itself.
  const copies = sent.filter((q) => /^CREATE DATABASE .* TEMPLATE .*_stgtmpl /.test(q.text));
  assert.equal(copies.length, 1);
  assert.equal(copies[0].port, ctx.previewPort);
  if (ctx.previewVersion >= 180000) {
    assert.match(copies[0].text, /STRATEGY = FILE_COPY$/, 'PostgreSQL 18 is asked for a shared-block copy');
    const index = sent.indexOf(copies[0]);
    assert.equal(sent[index - 1].text, 'SET file_copy_method = clone');
    assert.equal(sent[index - 1].port, ctx.previewPort);
    const sameSession = sent.filter((q) => q.client === copies[0].client).map((q) => q.text);
    assert.ok(sameSession.includes('SHOW server_version_num') && sameSession.includes('SELECT system_identifier FROM pg_control_system()'),
      'the server said who it is on the connection the copy ran on');
  } else {
    assert.doesNotMatch(copies[0].text, /STRATEGY/, 'an older preview server gets the plain copy');
  }
  assert.equal(sent.filter((q) => q.port === ctx.mainPort && /FILE_COPY|file_copy_method/.test(q.text)).length, 0,
    'the main server is never asked for a file copy');

  // A second build copies the template it finds.
  const second = await dbManager.cloneDatabase(source, `${source}_staging_s902_def456`, { viaTemplate: true });
  assert.equal(second.via, 'template');
  assert.equal(second.templateRefreshed, false);
  assertRedacted(await readClone(dbManager, `${source}_staging_s902_def456`, second));

  // The sweeps' view of the preview server.
  const listed = await dbManager.listPreviewServerStagingDatabases();
  assert.ok(listed.dbNames.includes(target));
  const census = await require('../src/db/connection-census').connectionCensus(dbManager.previewServerQueryable());
  assert.ok(census && census.max > 0 && census.used >= 0, 'the connection census reads the preview server');
  const labels = dbManager.previewDatabaseLabels(target, cloned.server);
  assert.deepEqual(labels, { 'usernode.db.id': dbManager.databaseIdentity(target), 'usernode.db.server': 'preview' });
  assert.equal(await dbManager.previewDatabaseVerdict(labels), null);
  assert.equal(await dbManager.databaseExists(target, { strict: true }), true);

  // A wiped preview server: everything on it is gone, the containers are not.
  await ctx.wipe(preview);
  assert.equal(await dbManager.previewDatabaseVerdict(labels), null,
    'for up to a minute the answer is the one read before the wipe: "there" is believed, "gone" is always read again');
  dbManager._resetPreviewServerStateForTest();
  assert.equal(await dbManager.previewDatabaseVerdict(labels), 'gone', 'the heal path is told the database is gone');
  assert.equal(await dbManager.databaseExists(target, { strict: true }), false);
  const rebuilt = await dbManager.cloneDatabase(source, target, { viaTemplate: true });
  assert.equal(rebuilt.server, 'preview');
  assert.equal(rebuilt.templateRefreshed, true, 'the template is rebuilt on the empty server without being told');
  assertRedacted(await readClone(dbManager, target, rebuilt));
  assert.equal(await dbManager.previewDatabaseVerdict(labels), null);

  // Dropping finds it where it is, and takes its role.
  await dbManager.dropDatabase(target, { strict: true });
  assert.deepEqual(await names(preview, `%${tok}%`), [`${source}_stgtmpl`]);
  assert.deepEqual(await roles(preview, `%${tok}%`), [`${source}_stgtmpl_owner`]);
});

test('switching both ways: old previews are found where they are, and the template follows', async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { main, preview, dbManager, tok, source, names } = ctx;
  const before = `${source}_staging_s911_aaaaaa`;
  const during = `${source}_staging_s912_bbbbbb`;
  const drained = `${source}_staging_s913_cccccc`;

  // Before the setting existed: one server.
  delete process.env.STAGING_DB_ADMIN_URL;
  sent.length = 0;
  const old = await dbManager.cloneDatabase(source, before, { viaTemplate: true });
  assert.equal(old.server, 'primary');
  assert.equal(sent.filter((q) => q.port === ctx.previewPort).length, 0, 'without the setting the preview server is never contacted');
  assert.deepEqual(await names(main, `%${tok}%`), [source, before, `${source}_stgtmpl`]);
  assert.equal(new URL(dbManager.connectionUrl(before, old.password, { server: old.server })).port, ctx.mainPort);

  // Turned on. The next build is on the preview server, and the app's
  // template on the main server is retired by the rebuild.
  process.env.STAGING_DB_ADMIN_URL = PREVIEW;
  const moved = await dbManager.cloneDatabase(source, during, { viaTemplate: true });
  assert.equal(moved.server, 'preview');
  assert.deepEqual(await names(preview, `%${tok}%`), [during, `${source}_stgtmpl`]);
  assert.deepEqual(await names(main, `%${tok}%`), [source, before],
    'the old preview keeps its database on the main server; the old template is gone');
  assertRedacted(await readClone(dbManager, before, old));
  assert.equal(await dbManager.previewDatabaseVerdict({}), null, 'a preview from before the switch has no labels and is not "gone"');

  // Its teardown still finds it.
  await dbManager.dropDatabase(before, { strict: true });
  assert.deepEqual(await names(main, `%${tok}%`), [source]);

  // Switching back, step one: drain. New previews on the main server, the
  // preview server's are still found.
  process.env.STAGING_DB_SERVER_DRAIN = '1';
  const back = await dbManager.cloneDatabase(source, drained, { viaTemplate: true });
  assert.equal(back.server, 'primary');
  assert.deepEqual(await names(main, `%${tok}%`), [source, drained, `${source}_stgtmpl`]);
  assert.deepEqual(await names(preview, `%${tok}%`), [during], 'the draining server keeps its preview and loses its template');
  assertRedacted(await readClone(dbManager, during, moved));
  assert.equal(await dbManager.previewDatabaseVerdict(dbManager.previewDatabaseLabels(during, 'preview')), 'draining',
    'a rebuild will move it to the main server');
  assert.equal(await dbManager.previewDatabaseVerdict(dbManager.previewDatabaseLabels(drained, back.server)), null);
  await dbManager.dropDatabase(during, { strict: true });
  assert.deepEqual(await names(preview, `%${tok}%`), []);

  // Back on: the next build is on the preview server again, and the main
  // server's template goes. (The sweep that does the same for apps that
  // never build again, retireStrayTemplates, acts on every app's template
  // on the server, so it is pinned with stubs in preview-db-server.test.js
  // and not run against a server other suites are using.)
  delete process.env.STAGING_DB_SERVER_DRAIN;
  const again = await dbManager.cloneDatabase(source, `${source}_staging_s914_dddddd`, { viaTemplate: true });
  assert.equal(again.server, 'preview');
  assert.deepEqual(await names(main, `%${tok}%`), [source, drained]);
  await dbManager.dropDatabase(drained, { strict: true });
});

test('a rebuild drops what the other server holds of its name, and builds when it holds nothing', async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { main, preview, dbManager, tok, source, names, roles } = ctx;
  const rebuilt = `${source}_staging_s915_eeeeee`;
  const roleOnly = `${source}_staging_s916_ffffff`;
  const absent = `${source}_staging_s917_abcdef`;

  // Built before the setting existed: database and role on the main server.
  delete process.env.STAGING_DB_ADMIN_URL;
  await dbManager.cloneDatabase(source, rebuilt, { viaTemplate: true });
  // A drop that stopped half way: only the role is left on the main server.
  await main.query(`CREATE ROLE ${roleOnly}_owner LOGIN PASSWORD 'left-behind'`);
  process.env.STAGING_DB_ADMIN_URL = PREVIEW;

  for (const name of [rebuilt, roleOnly, absent]) {
    sent.length = 0;
    const cloned = await dbManager.cloneDatabase(source, name, { viaTemplate: true });
    assert.equal(cloned.server, 'preview', name);
    assert.equal(sent.filter((q) => q.port === ctx.mainPort && q.text.includes(name)).length, 0,
      `${name}: the main server is asked and cleared through psql, as before, not node-postgres`);
  }
  assert.deepEqual(await names(main, `%${tok}%`), [source], 'the earlier build is gone from the main server');
  assert.deepEqual(await roles(main, `%${tok}%`), [`${source}_owner`], 'and so are its role and the left-behind one');
  assert.deepEqual(await names(preview, `%${tok}%`), [rebuilt, roleOnly, absent, `${source}_stgtmpl`].sort());
  for (const name of [rebuilt, roleOnly, absent]) await dbManager.dropDatabase(name, { strict: true });
});

test('an old clone of the same session on the other server does not vouch for the current one', async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { main, preview, dbManager, tok, source, names } = ctx;
  // A project whose slug itself contains `_staging_s7_…`, and one session
  // (98017) built twice: an old commit before the preview server existed,
  // the current commit after.
  const tricky = `${source}_staging_s7_6cb80a`;
  await main.query(`CREATE DATABASE ${tricky} TEMPLATE ${source}`).catch(async () => {
    // The source may have a session on it; a plain empty database will do.
    await main.query(`CREATE DATABASE ${tricky}`);
  });
  const seedTricky = await connect(at(MAIN, tricky));
  await seedTricky.query('CREATE TABLE IF NOT EXISTS notes (id serial PRIMARY KEY, body text)');
  await seedTricky.end();
  const oldClone = `${tricky}_staging_s98017_aaaaaa`;
  const current = `${tricky}_staging_s98017_bbbbbb`;

  delete process.env.STAGING_DB_ADMIN_URL;
  const before = await dbManager.cloneDatabase(tricky, oldClone, { viaTemplate: true });
  assert.equal(before.server, 'primary');
  process.env.STAGING_DB_ADMIN_URL = PREVIEW;
  const now = await dbManager.cloneDatabase(tricky, current, { viaTemplate: true });
  assert.equal(now.server, 'preview');
  assert.ok((await names(main, `%${tok}%`)).includes(oldClone), 'a different commit\'s clone is not dropped by the new build');
  const labels = dbManager.previewDatabaseLabels(current, now.server);

  assert.equal(await dbManager.previewDatabaseVerdict(labels), null);
  assert.equal(await dbManager.previewDatabaseVerdict(dbManager.previewDatabaseLabels(oldClone, before.server || 'primary')), null);

  // Drain: the current clone is on the preview server, whatever is on main.
  process.env.STAGING_DB_SERVER_DRAIN = '1';
  assert.equal(await dbManager.previewDatabaseVerdict(labels), 'draining');
  delete process.env.STAGING_DB_SERVER_DRAIN;

  // Wipe: the old clone on the main server is still there and says nothing.
  await ctx.wipe(preview);
  dbManager._resetPreviewServerStateForTest();
  assert.equal(await dbManager.databaseExists(oldClone, { strict: true }), true);
  assert.equal(await dbManager.previewDatabaseVerdict(labels), 'gone');
});

test('a URL whose query points somewhere else is refused before anything runs', async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { main, preview, dbManager, tok, source, names } = ctx;
  // The address names the preview server; the query names the main one.
  // node-postgres would follow the query, psql the address.
  const url = new URL(PREVIEW);
  url.searchParams.set('port', ctx.mainPort);
  process.env.STAGING_DB_ADMIN_URL = String(url);
  dbManager._resetPreviewServerStateForTest();
  sent.length = 0;
  await assert.rejects(
    dbManager.cloneDatabase(source, `${source}_staging_s951_abc123`, { viaTemplate: true }),
    /STAGING_DB_ADMIN_URL has an unsupported parameter "port"/,
  );
  assert.equal(sent.filter((q) => /FILE_COPY|file_copy_method/.test(q.text)).length, 0, 'no server was asked for a file copy');
  assert.deepEqual(await names(main, `%${tok}%`), [source]);
  assert.deepEqual(await names(preview, `%${tok}%`), []);
});

test('ambient libpq settings cannot send preview work to the main server', async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { main, preview, dbManager, tok, source, names } = ctx;
  // A service file whose entry is the MAIN server. libpq lets a service
  // override the host and port it is otherwise given.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvdb-service-'));
  const mainUrl = new URL(MAIN);
  fs.writeFileSync(path.join(dir, 'pg_service.conf'),
    `[elsewhere]\nhost=${mainUrl.hostname}\nport=${mainUrl.port || 5432}\nuser=${decodeURIComponent(mainUrl.username)}\npassword=${decodeURIComponent(mainUrl.password)}\n`);
  const saved = { PGSERVICE: process.env.PGSERVICE, PGSERVICEFILE: process.env.PGSERVICEFILE, PGHOSTADDR: process.env.PGHOSTADDR };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // The service names the main server, so the main server's own processes
  // (the dump, which inherits the environment as before) still reach it.
  // The direct copy is the path that is psql and pg_restore throughout.
  process.env.PGSERVICE = 'elsewhere';
  process.env.PGSERVICEFILE = path.join(dir, 'pg_service.conf');
  process.env.PGHOSTADDR = mainUrl.hostname;
  const target = `${source}_staging_s961_abc123`;
  const cloned = await dbManager.cloneDatabase(source, target);
  for (const key of Object.keys(saved)) delete process.env[key];
  assert.equal(cloned.server, 'preview');
  assert.equal(cloned.via, 'direct');
  assert.deepEqual(await names(preview, `%${tok}%`), [target], 'made where the function says it was made');
  assert.deepEqual(await names(main, `%${tok}%`), [source], 'nothing reached the main server');
  assertRedacted(await readClone(dbManager, target, cloned));
});

test('the longest legal names: the clone works and its runtime is not judged "gone"', async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { main, preview, dbManager, tok, seed, names } = ctx;
  // A 50-character slug: `app_` + 50 = 54 characters, and a preview name of
  // 54 + `_staging_s8016000_abcdef` = 78. Postgres stores 63.
  const longSource = `app_long${tok}${'x'.repeat(50 - 4 - tok.length)}`;
  assert.equal(longSource.length, 54);
  await seed(longSource);
  const target = `${longSource}_staging_s8016000_abcdef`;
  assert.equal(target.length, 78);
  const cloned = await dbManager.cloneDatabase(longSource, target, { viaTemplate: true });
  assert.equal(cloned.server, 'preview');
  const stored = (await names(preview, `%long${tok}%`)).filter((name) => name.includes('_staging_'));
  assert.deepEqual(stored, [target.slice(0, 63)], 'Postgres kept the first 63 bytes');
  assertRedacted(await readClone(dbManager, target, cloned));

  const labels = dbManager.previewDatabaseLabels(target, cloned.server);
  for (const value of Object.values(labels)) assert.match(value, /^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/);
  assert.equal(await dbManager.previewDatabaseVerdict(labels), null, 'there, under its stored name');
  await dbManager.dropDatabase(target, { strict: true });
  dbManager._resetPreviewServerStateForTest();
  assert.equal(await dbManager.previewDatabaseVerdict(labels), 'gone');
});

test('an administrator this module cannot name in SQL is refused before anything is made', async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { main, preview, dbManager, tok, source, names } = ctx;
  const admin = `pv-admin-${tok}`;
  await preview.query(`CREATE ROLE "${admin}" SUPERUSER LOGIN PASSWORD 'pw'`);
  t.after(() => preview.query(`DROP ROLE IF EXISTS "${admin}"`).catch(() => {}));
  const url = new URL(PREVIEW);
  url.username = admin;
  url.password = 'pw';
  process.env.STAGING_DB_ADMIN_URL = String(url);
  dbManager._resetPreviewServerStateForTest();
  await assert.rejects(
    dbManager.cloneDatabase(source, `${source}_staging_s971_abc123`, { viaTemplate: true }),
    /STAGING_DB_ADMIN_URL must carry a user of letters, digits and underscores/,
  );
  assert.deepEqual(await names(preview, `%${tok}%`), [], 'no clone its own role could not read was made');
  assert.deepEqual(await names(main, `%${tok}%`), [source]);
});

// ─── TLS: one contract for the three clients ────────────────────────────
//
// Two more throwaway PostgreSQL servers, both with a self-signed
// certificate: one that offers TLS and also takes plain connections
// (TEST_PREVIEW_TLS_DATABASE_URL, by default 127.0.0.1:5434) and one that
// takes TLS only (TEST_PREVIEW_TLSONLY_DATABASE_URL, by default
// 127.0.0.1:5435). Skipped when they are not running, required when the
// variables are set.
const TLS_OFFERED = process.env.TEST_PREVIEW_TLS_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5434/postgres';
const TLS_ONLY = process.env.TEST_PREVIEW_TLSONLY_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5435/postgres';

async function tlsAdmin(t, dsn, required) {
  const client = new pg.Client({ connectionString: dsn, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 3000 });
  client.on('error', () => {});
  try { await client.connect(); } catch (err) {
    if (required) throw err;
    t.skip('no TLS PostgreSQL server; set TEST_PREVIEW_TLS_DATABASE_URL and TEST_PREVIEW_TLSONLY_DATABASE_URL to require this check');
    return null;
  }
  t.after(() => client.end().catch(() => {}));
  return client;
}

// What a connection says about itself, asked on that connection.
const OWN_TLS = 'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()';
const psqlSays = (args, env) => new Promise((resolve) => {
  require('node:child_process').execFile('psql', ['-X', '-At', ...args, '-c', OWN_TLS], { env }, (err, stdout, stderr) =>
    resolve(err ? `error: ${String(stderr).trim().split('\n')[0]}` : String(stdout).trim()));
});

test('a server that offers TLS: every client of a preview database connects the same, plain way', async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const tls = await tlsAdmin(t, TLS_OFFERED, !!process.env.TEST_PREVIEW_TLS_DATABASE_URL);
  if (!tls) return;
  const { main, dbManager, tok, source, names, wipe } = ctx;
  const shotsFixtures = require('../src/services/shots-fixtures');
  const ambient = { PGSSLMODE: process.env.PGSSLMODE };
  try {
    for (const query of ['', '?sslmode=disable']) {
      process.env.STAGING_DB_ADMIN_URL = `${TLS_OFFERED}${query}`;
      dbManager._resetPreviewServerStateForTest();
      const target = `${source}_staging_s98${query ? 2 : 1}_abc123`;
      sent.length = 0;
      const cloned = await dbManager.cloneDatabase(source, target, { viaTemplate: true });
      assert.equal(cloned.server, 'preview');
      assert.equal(cloned.via, 'template', 'the fast path, not a production dump per build');

      // 1. This module's own node-postgres connections: each one's socket,
      //    looked at after the fact. Nothing is sampled.
      const own = [...new Set(sent.filter((q) => q.port === String(new URL(TLS_OFFERED).port)).map((q) => q.client))];
      assert.ok(own.length >= 2, 'the maintenance session and the clone\'s own session');
      for (const client of own) assert.notEqual(client.connection.stream.encrypted, true, 'node-postgres did not negotiate TLS');

      // 2. Its child processes: the real psql, started with exactly the
      //    environment this module gives a preview-side child, asked about
      //    its own connection.
      const childEnv = dbManager._childEnvForTest('postgres', 'preview');
      assert.equal(childEnv.PGSSLMODE, 'disable');
      assert.equal(await psqlSays([], childEnv), 'f', 'psql, pg_dump and pg_restore are started this way');

      // 3. Everything that is handed the returned URL, with a PGSSLMODE in
      //    the environment that demands a verified certificate: what the
      //    platform's own environment may hold while it writes shots
      //    fixtures, and what a self-signed server cannot satisfy.
      const url = dbManager.connectionUrl(target, cloned.password, { server: cloned.server });
      assert.equal(new URL(url).search, '?sslmode=disable', 'whichever form the admin URL took');
      process.env.PGSSLMODE = 'verify-full';
      try {
        // The platform's shots fixture client, as it is.
        assert.equal(await shotsFixtures.withClient(url, async (client) => (await client.query(OWN_TLS)).rows[0].ssl), false);
        // A preview's own pool, built the way a generated app builds it.
        const pool = new pg.Pool({ connectionString: url });
        try {
          const row = (await pool.query(`SELECT (${OWN_TLS}) AS ssl, count(*)::int AS n FROM notes`)).rows[0];
          assert.deepEqual(row, { ssl: false, n: 2 });
        } finally { await pool.end(); }
        // libpq given the same URL (an app that is not node-postgres).
        assert.equal(await psqlSays([url], { PATH: process.env.PATH, PGSSLMODE: 'verify-full' }), 'f');
        // The control: the same URL without its sslmode does what each
        // client's default says, which is why it is spelled out.
        const bare = url.replace('?sslmode=disable', '');
        await assert.rejects(shotsFixtures.withClient(bare, (client) => client.query('SELECT 1')), /self-signed certificate/);
        assert.equal(await psqlSays([bare], { PATH: process.env.PATH }), 't', 'libpq alone would have taken TLS');
      } finally {
        if (ambient.PGSSLMODE === undefined) delete process.env.PGSSLMODE; else process.env.PGSSLMODE = ambient.PGSSLMODE;
      }
      await dbManager.dropDatabase(target, { strict: true });
    }
    assert.deepEqual(await names(main, `%${tok}%`), [source]);
  } finally { await wipe(tls); }
});

test('a server that takes TLS only is refused by all three clients alike, before production is read', async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const tls = await tlsAdmin(t, TLS_ONLY, !!process.env.TEST_PREVIEW_TLSONLY_DATABASE_URL);
  if (!tls) return;
  const { main, dbManager, tok, source, names } = ctx;
  process.env.STAGING_DB_ADMIN_URL = TLS_ONLY;
  dbManager._resetPreviewServerStateForTest();
  spawned.length = 0;
  const target = `${source}_staging_s991_abc123`;
  await assert.rejects(dbManager.cloneDatabase(source, target, { viaTemplate: true }), (err) => {
    assert.equal(err.previewDatabaseServerFault, true);
    assert.match(err.message, /pg_hba\.conf rejects connection|no encryption/i);
    return true;
  });
  await assert.rejects(dbManager.prepareStagingCloneSource(source, { sourceId: `run-${tok}` }), /pg_hba\.conf rejects connection|no encryption/i);
  // The child processes are turned away too: each of the three is plain.
  assert.match(await psqlSays([], dbManager._childEnvForTest('postgres', 'preview')), /^error: .*(pg_hba\.conf rejects connection|no encryption)/i);
  assert.match(await psqlSays([dbManager.connectionUrl(target, 'pw', { server: 'preview' })], { PATH: process.env.PATH }),
    /^error: .*(pg_hba\.conf rejects connection|no encryption)/i, 'and so is anything using a handed-out URL');
  assert.deepEqual(spawned, [], 'no pg_dump of production was started, and no pg_restore');
  assert.deepEqual(await names(tls, `%${tok}%`), [], 'nothing was made there');
  assert.deepEqual(await names(main, `%${tok}%`), [source]);

  // And the modes that would have made only one client work are refused
  // by name.
  for (const mode of ['require', 'verify-ca', 'verify-full', 'prefer', 'allow', 'no-verify']) {
    process.env.STAGING_DB_ADMIN_URL = `${TLS_ONLY}?sslmode=${mode}`;
    await assert.rejects(dbManager.cloneDatabase(source, target, { viaTemplate: true }),
      new RegExp(`sslmode=${mode} is not supported`));
  }
});

test('a shots run keeps its frozen source and both clones together on the preview server', async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { main, preview, dbManager, tok, source, names } = ctx;
  const runId = `run-${tok}`;
  sent.length = 0;
  const prepared = await dbManager.prepareStagingCloneSource(source, { sourceId: runId });
  assert.equal(prepared.server, 'preview');
  // The frozen source is copied with no runner of its own. It still holds
  // one connection for the probes, the SET and the copy.
  const frozen = sent.find((q) => /^CREATE DATABASE \S+_evsrc_\S+ TEMPLATE /.test(q.text));
  assert.equal(frozen.port, ctx.previewPort);
  if (ctx.previewVersion >= 180000) {
    assert.match(frozen.text, /STRATEGY = FILE_COPY$/);
    assert.deepEqual(sent.filter((q) => q.client === frozen.client).map((q) => q.text).slice(0, 4), [
      'SHOW server_version_num', 'SELECT system_identifier FROM pg_control_system()', 'SET file_copy_method = clone', frozen.text,
    ]);
  }
  const slug = source.replace(/^app_/, '');
  const sides = { base: dbManager.shotsDbName(slug, runId, 'base'), head: dbManager.shotsDbName(slug, runId, 'head') };
  for (const side of ['base', 'head']) {
    const cloned = await dbManager.cloneFromPreparedSource(prepared, sides[side]);
    assert.equal(cloned.server, 'preview');
    assert.equal(cloned.fixtureFingerprint, prepared.fingerprint);
    assertRedacted(await readClone(dbManager, sides[side], cloned));
  }
  assert.deepEqual(await names(main, `%${tok}%`), [source], 'nothing of the run is on the main server');
  assert.equal((await names(preview, '%')).filter((name) => [prepared.templateDb, sides.base, sides.head].includes(name)).length, 3);

  for (const side of ['base', 'head']) await dbManager.dropDatabase(sides[side], { strict: true });
  await dbManager.releasePreparedCloneSource(prepared);
  const left = (await names(preview, '%')).filter((name) => [prepared.templateDb, sides.base, sides.head].includes(name));
  assert.deepEqual(left, []);
});

test('an app fork stays on the main server, and a redaction that cannot be done hands out nothing', async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { main, preview, dbManager, tok, source, names, seed } = ctx;

  const fork = `app_fork${tok}`;
  const forked = await dbManager.cloneDatabase(source, fork);
  assert.equal(forked.server, 'primary');
  assert.ok((await names(main, `%${tok}%`)).includes(fork));
  assert.deepEqual(await names(preview, `%${tok}%`), [], 'a production database is never made on the preview server');
  assert.equal(new URL(dbManager.connectionUrl(fork, forked.password)).port, ctx.mainPort);

  // A private NOT NULL column too short to hold a unique placeholder: the
  // scrub refuses it. Both the template build and the direct copy must fail.
  const leaky = `app_leak${tok}`;
  await seed(leaky, `
    CREATE TABLE codes (id serial PRIMARY KEY, code varchar(5) NOT NULL);
    INSERT INTO codes (code) VALUES ('abcde');
    COMMENT ON COLUMN codes.code IS 'staging:private';
  `);
  const target = `${leaky}_staging_s921_abc123`;
  await assert.rejects(
    dbManager.cloneDatabase(leaky, target, { viaTemplate: true }),
    (err) => {
      assert.match(err.message, /Failed to scrub 1 staging:private column/);
      assert.equal(err.infrastructure, true, 'a failed preview-server clone is a platform fault, not the proposal\'s');
      return true;
    },
  );
  assert.deepEqual((await names(preview, `%${tok}%`)).filter((name) => name.endsWith('_stgtmpl')), [],
    'no template is swapped in from a build whose redaction failed');
});

test('an unreachable preview server fails the clone and makes nothing on the main server', async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { main, dbManager, tok, source, names } = ctx;
  process.env.STAGING_DB_ADMIN_URL = 'postgres://postgres:not-a-real-password-91@127.0.0.1:1/postgres';
  dbManager._resetPreviewServerStateForTest();
  const target = `${source}_staging_s931_abc123`;
  await assert.rejects(
    dbManager.cloneDatabase(source, target, { viaTemplate: true }),
    (err) => {
      assert.equal(err.infrastructure, true);
      assert.doesNotMatch(`${err.message}\n${err.stack}\n${err.cmd || ''}`, /not-a-real-password-91/);
      return true;
    },
  );
  assert.deepEqual(await names(main, `%${tok}%`), [source], 'no fallback copy lands on the main server');
  assert.equal(await dbManager.previewDatabaseVerdict(dbManager.previewDatabaseLabels(target, 'preview')), null,
    'a server that cannot be read is "cannot tell"');
  await assert.rejects(dbManager.databaseExists(target, { strict: true }), 'a failed lookup is not absence');
});

test('one server under two addresses is recognised: no file copy, and its template is kept', async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const { main, dbManager, tok, source, names } = ctx;
  // The main server plays both parts, as 127.0.0.1 and as localhost.
  const alias = new URL(MAIN);
  if (alias.hostname !== '127.0.0.1') { t.skip('needs a main server on 127.0.0.1'); return; }
  alias.hostname = 'localhost';
  try { await (await connect(String(alias))).end(); } catch { t.skip('localhost does not reach the same server'); return; }

  process.env.STAGING_DB_ADMIN_URL = String(alias);
  dbManager._resetPreviewServerStateForTest();
  assert.equal(dbManager.previewServerConfigured(), true, 'the two URLs look like two servers');
  sent.length = 0;
  const target = `${source}_staging_s941_abc123`;
  const cloned = await dbManager.cloneDatabase(source, target, { viaTemplate: true });
  assert.equal(cloned.via, 'template');
  assert.equal(sent.filter((q) => /FILE_COPY|file_copy_method/.test(q.text)).length, 0,
    'whatever its version, the main server is not asked for a file copy');
  assert.deepEqual(await names(main, `%${tok}%`), [source, target, `${source}_stgtmpl`],
    'the template just built was not retired as "the other server\'s"');
  assertRedacted(await readClone(dbManager, target, cloned));
});
