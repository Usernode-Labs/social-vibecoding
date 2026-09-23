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

test('a real PostgreSQL clone can scrub an already-redacted unique column again', {
  skip: !process.env.DB_CLONE_TEST_URL,
}, async () => {
  const url = new URL(process.env.DB_CLONE_TEST_URL);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'integration database must be local');
  const dbManager = require('../src/services/db-manager');
  const token = crypto.randomBytes(4).toString('hex');
  const sourceDb = `app_scrub_${token}`;
  const cloneDb = `${sourceDb}_clone`;
  const admin = new Client({ connectionString: url.toString() });
  let source;
  let clone;
  const connect = async (database) => {
    const databaseUrl = new URL(url);
    databaseUrl.pathname = `/${database}`;
    const client = new Client({ connectionString: databaseUrl.toString() });
    await client.connect();
    return client;
  };
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${sourceDb}`);
    source = await connect(sourceDb);
    await source.query(`
      CREATE TABLE onchain_accounts (
        id bigint PRIMARY KEY,
        registration_code varchar(64) NOT NULL UNIQUE,
        secret_key varchar(64) NOT NULL
      );
      INSERT INTO onchain_accounts VALUES
        (1, '__staging_redacted__(0,2)', 'private-one'),
        (2, '__staging_redacted__(0,1)', 'private-two');
      COMMENT ON COLUMN onchain_accounts.registration_code IS 'staging:private';
      COMMENT ON COLUMN onchain_accounts.secret_key IS 'staging:private';
    `);
    const sourceCtids = (await source.query('SELECT ctid::text FROM onchain_accounts ORDER BY id'))
      .rows.map((row) => row.ctid);
    assert.deepEqual(sourceCtids, ['(0,1)', '(0,2)']);
    await source.end();
    source = null;
    await admin.query(`ALTER DATABASE ${sourceDb} WITH ALLOW_CONNECTIONS false`);
    await admin.query(`CREATE DATABASE ${cloneDb} TEMPLATE ${sourceDb}`);
    clone = await connect(cloneDb);

    await assert.rejects(
      clone.query("UPDATE public.onchain_accounts SET registration_code = left('__staging_redacted__' || ctid::text, 64)"),
      { code: '23505' },
      'the previous ctid-only scrub collides with an existing redacted value'
    );
    const execute = async (dbName, sql, options = {}) => {
      assert.equal(dbName, cloneDb);
      const result = await clone.query({ text: sql, rowMode: 'array' });
      if (!options.tuplesOnly) return '';
      return result.rows.map((row) => row.map((value) => value === true ? 't'
        : value === false ? 'f' : value == null ? '' : String(value)).join('|')).join('\n');
    };
    await dbManager.scrubPrivateColumns(cloneDb, execute);
    const firstCodes = (await clone.query('SELECT registration_code FROM onchain_accounts ORDER BY id'))
      .rows.map((row) => row.registration_code);
    await dbManager.scrubPrivateColumns(cloneDb, execute);
    const rows = (await clone.query('SELECT registration_code, secret_key FROM onchain_accounts')).rows;
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map((row) => row.registration_code)).size, 2);
    assert.ok(rows.every((row) => /^__staging_redacted__[0-9a-f]{16}:\([0-9]+,[0-9]+\)$/.test(row.registration_code)));
    assert.ok(rows.every((row) => row.registration_code.length <= 64));
    assert.ok(rows.every((row) => !firstCodes.includes(row.registration_code)), 'the second scrub uses a new namespace');
    assert.ok(rows.every((row) => row.secret_key !== 'private-one' && row.secret_key !== 'private-two'));
  } finally {
    if (clone) await clone.end().catch(() => {});
    if (source) await source.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${cloneDb} WITH (FORCE)`).catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${sourceDb} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
});
