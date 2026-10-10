'use strict';

// The before & after shots database steps against a REAL PostgreSQL server
// (src/services/db-retry.js, db-manager.js, shots-fixtures.js). Pinned here:
//   - a session left on a disposable template makes Postgres refuse the copy
//     ("source database ... is being accessed by other users"), exactly as
//     it ended a shots run; with retries the session is cut off and the copy
//     is made, through psql as the platform runs it and through pg;
//   - a disposable database whose client keeps reconnecting is still
//     dropped (WITH (FORCE));
//   - a fixture write that loses a real deadlock to another session is
//     rolled back and written on the next attempt, while the other session
//     carries on;
//   - a database that is not a disposable shots or template one is refused,
//     and its sessions are left alone;
//   - a template that is not there fails with the exact text and SQLSTATE
//     the shots copy's rebuild-and-retry keys on.
// Every database here is a throwaway with a random name. Skipped when no
// server is reachable, and required when TEST_DATABASE_URL is set, the same
// contract as tests/communities-postgres.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Client } = require('pg');
const dbManager = require('../src/services/db-manager');
const shotsFixtures = require('../src/services/shots-fixtures');

const execFileAsync = promisify(execFile);
const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const IN_USE = /being accessed by other users/;

const token = () => crypto.randomBytes(4).toString('hex');
const urlFor = (database) => { const url = new URL(DSN); url.pathname = `/${database}`; return String(url); };

async function server(t) {
  const admin = new Client({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.connect(); } catch (err) {
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return null;
  }
  const made = [];
  t.after(async () => {
    for (const db of made.reverse()) {
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
    }
    await admin.end();
  });
  const owner = (await admin.query('SELECT current_user AS name')).rows[0].name;
  const create = async (db, template = null) => {
    made.push(db);
    await admin.query(`CREATE DATABASE ${db}${template ? ` TEMPLATE ${template}` : ''}`);
  };
  const exists = async (db) => (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [db])).rowCount === 1;
  return { admin, owner, create, exists, made };
}

// The statement runners db-manager is handed: psql exactly as execInTarget
// runs it (whose errors carry Postgres's text), and a pg client (whose errors
// carry the SQLSTATE).
async function psqlRunner(t) {
  try { await execFileAsync('psql', ['--version']); } catch {
    t.skip('psql is not on PATH');
    return null;
  }
  const url = new URL(DSN);
  const env = {
    ...process.env,
    PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: url.pathname.slice(1) || 'postgres',
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
  };
  return async (sql) => (await execFileAsync('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-c', sql], { env, timeout: 60_000 })).stdout;
}
const pgRunner = (client) => async (sql) => { await client.query(sql); return ''; };

// A connection that stays on `db` until it is cut off.
async function holdSession(db) {
  const client = new Client({ connectionString: urlFor(db), application_name: 'p3-stray-session' });
  const held = { client, cutOff: false };
  client.on('error', () => { held.cutOff = true; });
  await client.connect();
  return held;
}

test('a session left on a disposable template is cut off, and the copy is made', { timeout: 120_000 }, async (t) => {
  const pg = await server(t);
  if (!pg) return;
  const psql = await psqlRunner(t);
  if (!psql) return;
  const template = `app_p3dbr_${token()}_stgtmpl`;
  await pg.create(template);
  await pg.admin.query(`COMMENT ON DATABASE ${template} IS 'p3 db-retry scratch template'`);
  const stray = await holdSession(template);

  // Without retries this is the error the shots run ended on.
  const refused = `app_p3dbr_${token()}_evsrc_${crypto.randomBytes(6).toString('hex')}`;
  pg.made.push(refused);
  await assert.rejects(dbManager.createFromTemplate(template, refused, pg.owner, { execute: psql }),
    (error) => /^Command failed: psql/.test(error.message)
      && /source database ".+_stgtmpl" is being accessed by other users/.test(error.message));
  assert.equal(await pg.exists(refused), false);
  assert.equal(stray.cutOff, false, 'one attempt cuts nobody off');

  for (const [runner, execute] of [['psql', psql], ['pg', pgRunner(pg.admin)]]) {
    const held = runner === 'psql' ? stray : await holdSession(template);
    const target = `app_p3dbr_${token()}_evsrc_${crypto.randomBytes(6).toString('hex')}`;
    pg.made.push(target);
    await dbManager.createFromTemplate(template, target, pg.owner, { execute, attempts: 3, wait: async () => {} });
    assert.equal(await pg.exists(target), true, `${runner}: the copy was made`);
    assert.equal(held.cutOff, true, `${runner}: the stray session was cut off`);
    const copied = await pg.admin.query(
      'SELECT shobj_description(oid, \'pg_database\') AS note FROM pg_database WHERE datname = $1', [target]);
    assert.equal(copied.rows[0].note, null, `${runner}: a fresh database, not an adopted one`);
  }
});

test('a disposable database whose client keeps reconnecting is still dropped', { timeout: 60_000 }, async (t) => {
  const pg = await server(t);
  if (!pg) return;
  const runId = crypto.randomBytes(16).toString('hex');
  const db = dbManager.shotsDbName(`p3-dbr-${token()}`, runId, 'base');
  assert.equal(dbManager.isDisposableDb(db), true);
  await pg.create(db);
  // The app pool a shots copy runs: back the moment it is cut off.
  let stop = false;
  let reconnects = 0;
  const reconnecting = async () => {
    while (!stop) {
      const client = new Client({ connectionString: urlFor(db), application_name: 'p3-reconnecting-pool' });
      const lost = new Promise((resolve) => { client.on('error', resolve); client.on('end', resolve); });
      try { await client.connect(); } catch { break; }
      reconnects += 1;
      await lost;
      await client.end().catch(() => {});
    }
  };
  const pool = reconnecting();
  try {
    while (reconnects === 0) await new Promise((resolve) => { setTimeout(resolve, 20); });
    await dbManager.dropDatabase(db, { strict: true, execute: pgRunner(pg.admin) });
    assert.equal(await pg.exists(db), false);
  } finally {
    stop = true;
    await pool;
  }
});

test('a fixture write that loses a real deadlock is written on the next attempt', { timeout: 60_000 }, async (t) => {
  const pg = await server(t);
  if (!pg) return;
  const slug = `p3-dbr-${token()}`;
  const runId = crypto.randomBytes(16).toString('hex');
  const db = dbManager.shotsDbName(slug, runId, 'base');
  await pg.create(db);
  const setup = new Client({ connectionString: urlFor(db) });
  const other = new Client({ connectionString: urlFor(db), application_name: 'p3-booted-copy' });
  // The scratch database is force-dropped after the test.
  for (const client of [setup, other]) client.on('error', () => {});
  await setup.connect();
  await other.connect();
  t.after(async () => { await setup.end().catch(() => {}); await other.end().catch(() => {}); });
  // The tables the full-admin fixture writes, as a shots copy has them.
  await setup.query(`
    CREATE TABLE apps (id serial PRIMARY KEY, slug text UNIQUE NOT NULL, name text);
    CREATE TABLE users (id bigint PRIMARY KEY, username text UNIQUE NOT NULL, password text,
      is_admin boolean, admin_readonly boolean, can_create_apps boolean,
      has_platform_access boolean, platform_access_granted_at timestamptz);
    CREATE TABLE app_collaborators (app_id int, user_id bigint, status text, invited_by bigint,
      accepted_at timestamptz, PRIMARY KEY (app_id, user_id));
  `);
  await setup.query('INSERT INTO apps (slug, name) VALUES ($1, $2)', [slug, 'Homeroom']);
  await setup.query(`INSERT INTO users (id, username, password) VALUES ($1, $2, 'x')`,
    [shotsFixtures.FULL_ADMIN_USER_ID, shotsFixtures.FULL_ADMIN_USERNAME]);

  // The other session (the booted copy) holds the fixture's user row, and
  // will reach for the app row the fixture holds next: a deadlock. Its own
  // deadlock check is put off, so Postgres rolls the fixture's write back.
  const timeout = (await setup.query('SHOW deadlock_timeout')).rows[0].deadlock_timeout;
  if (!/^\d+ms$|^1s$/.test(timeout)) { t.skip(`deadlock_timeout is ${timeout}`); return; }
  await other.query('BEGIN');
  try { await other.query("SET LOCAL deadlock_timeout = '20s'"); } catch (err) {
    t.skip(`cannot set deadlock_timeout: ${err.message}`);
    return;
  }
  await other.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [shotsFixtures.FULL_ADMIN_USER_ID]);
  const fixture = shotsFixtures.ensureFullAdminIdentity({ databaseUrl: urlFor(db), slug, runId, side: 'base' });
  const fixtureSettled = fixture.then(() => {}, () => {});
  for (let waited = 0; ; waited += 20) {
    const { rows } = await pg.admin.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = $1 AND application_name = 'social-shots-fixture' AND wait_event_type = 'Lock'`, [db]);
    if (rows[0].n === 1) break;
    if (waited > 10_000) throw new Error('the fixture write never waited on the held row');
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
  await other.query('UPDATE apps SET name = name WHERE slug = $1', [slug]);
  await other.query('COMMIT');

  const installed = await fixture;
  await fixtureSettled;
  assert.equal(installed.userId, shotsFixtures.FULL_ADMIN_USER_ID, 'the fixture is written');
  const { rows } = await setup.query('SELECT is_admin, has_platform_access FROM users WHERE id = $1',
    [shotsFixtures.FULL_ADMIN_USER_ID]);
  assert.deepEqual(rows[0], { is_admin: true, has_platform_access: true });
  assert.equal((await setup.query('SELECT count(*)::int AS n FROM app_collaborators')).rows[0].n, 1);
});

test('a missing template fails with the text and SQLSTATE the shots copy\'s rebuild-and-retry keys on', { timeout: 30_000 }, async (t) => {
  const pg = await server(t);
  if (!pg) return;
  const psql = await psqlRunner(t);
  if (!psql) return;
  const missing = `app_p3dbr_${token()}_stgtmpl`;
  const target = `app_p3dbr_${token()}_evsrc_${crypto.randomBytes(6).toString('hex')}`;
  pg.made.push(target);
  // Through psql, whose errors carry Postgres's text: the message the
  // recovery in prepareStagingCloneSource matches.
  await assert.rejects(dbManager.createFromTemplate(missing, target, pg.owner, { execute: psql }),
    (error) => /template database ".*" does not exist/.test(error.message));
  assert.equal(await pg.exists(target), false, 'a refused copy made nothing');
  // Through pg, whose errors carry the SQLSTATE: the other half of the match.
  let code = null;
  try { await pg.admin.query(`CREATE DATABASE ${target} TEMPLATE ${missing}`); } catch (err) { code = err.code; }
  assert.equal(code, '3D000');
});

test('a database that is not a disposable shots or template one is refused, its sessions left alone', { timeout: 30_000 }, async (t) => {
  const pg = await server(t);
  if (!pg) return;
  const db = `p3dbr_${token()}`;
  await pg.create(db);
  const held = await holdSession(db);
  t.after(() => held.client.end().catch(() => {}));
  const execute = pgRunner(pg.admin);
  await assert.rejects(dbManager.terminateDisposableSessions(db, { execute }), /not a disposable/);
  await assert.rejects(dbManager.dropDisposableDatabase(db, { execute }), /not a disposable/);
  assert.equal((await held.client.query('SELECT 1 AS ok')).rows[0].ok, 1, 'the session is still there');
  assert.equal(held.cutOff, false);
  assert.equal(await pg.exists(db), true);
});
