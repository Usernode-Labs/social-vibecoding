const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');

// Opt in only against a disposable local PostgreSQL 17 server with a `usernode`
// maintenance database and psql on PATH. Never use a platform/production URL.
test('template clone reuses connections without changing real ownership or redaction', {
  skip: !process.env.DB_CLONE_TEST_URL,
}, async () => {
  const url = new URL(process.env.DB_CLONE_TEST_URL);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'integration database must be local');
  const saved = process.env.DB_ADMIN_URL;
  process.env.DB_ADMIN_URL = url.toString();
  const dbManager = require('../src/services/db-manager');
  const source = `app_reuse_${crypto.randomBytes(4).toString('hex')}`;
  const template = `${source}_stgtmpl`;
  const target = `${source}_staging_s1_abc123`;
  const templateRole = `${template}_owner`;
  const targetRole = `${target}_owner`;
  const admin = new Client({ connectionString: url.toString() });
  const clients = [];
  const connect = async (database, role, password) => {
    const dbUrl = new URL(url);
    dbUrl.pathname = `/${database}`;
    if (role) { dbUrl.username = role; dbUrl.password = password; }
    const client = new Client({ connectionString: dbUrl.toString() });
    clients.push(client);
    await client.connect();
    return client;
  };
  try {
    await admin.connect();
    await admin.query(`CREATE ROLE ${templateRole} NOLOGIN`);
    await admin.query(`CREATE DATABASE ${template} OWNER ${templateRole}`);
    const seed = await connect(template);
    await seed.query(`
      CREATE TABLE people (id serial PRIMARY KEY, token varchar(64) NOT NULL UNIQUE, secret text);
      INSERT INTO people (token, secret) VALUES ('private-a', 'secret-a'), ('private-b', 'secret-b');
      COMMENT ON COLUMN people.token IS 'staging:private';
      COMMENT ON COLUMN people.secret IS 'staging:private';
      CREATE TABLE private_data (id serial PRIMARY KEY, data text);
      INSERT INTO private_data (data) VALUES ('must disappear');
      COMMENT ON TABLE private_data IS 'staging:private';
      ALTER TABLE people OWNER TO ${templateRole};
      ALTER TABLE private_data OWNER TO ${templateRole};
    `);
    await seed.end();
    await admin.query(`COMMENT ON DATABASE ${template} IS 'staging-template source=${source} refreshed_at=${new Date().toISOString()}'`);
    await admin.query(`ALTER DATABASE ${template} WITH ALLOW_CONNECTIONS false`);

    const result = await dbManager.cloneDatabase(source, target, { viaTemplate: true });
    assert.equal(result.via, 'template');
    assert.equal(result.templateRefreshed, false);
    const sessions = await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE application_name = 'social-template-clone' AND datname IN ('usernode', $1)`, [target]);
    assert.equal(sessions.rows[0].n, 0, 'clone must close administrative sessions before returning');
    const clone = await connect(target, targetRole, result.password);
    const people = (await clone.query('SELECT token, secret FROM people ORDER BY id')).rows;
    assert.equal(people.length, 2);
    assert.equal(new Set(people.map((p) => p.token)).size, 2);
    assert.ok(people.every((p) => p.token.startsWith('__staging_redacted__') && p.secret === null));
    assert.equal((await clone.query('SELECT count(*)::int AS n FROM private_data')).rows[0].n, 0);
    assert.equal((await clone.query("INSERT INTO private_data(data) VALUES ('new') RETURNING id")).rows[0].id, 1);
    await clone.query('ALTER TABLE people ADD COLUMN owner_can_migrate boolean');
    const owners = (await clone.query(`SELECT tableowner FROM pg_tables WHERE schemaname='public'`)).rows;
    assert.ok(owners.every((row) => row.tableowner === targetRole));
    await clone.end();
    await dbManager.dropDatabase(target, { strict: true });
    assert.equal((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [targetRole])).rowCount, 0);
  } finally {
    for (const client of clients) await client.end().catch(() => {});
    for (const db of [target, template]) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
    for (const role of [targetRole, templateRole]) await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    await admin.end();
    if (saved === undefined) delete process.env.DB_ADMIN_URL;
    else process.env.DB_ADMIN_URL = saved;
  }
});
