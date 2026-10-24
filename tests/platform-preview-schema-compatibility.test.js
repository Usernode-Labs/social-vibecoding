'use strict';
// test:changed: when src/services/platform-preview-schema.json (reviewed schema)
// test:changed: when src/db/schema.sql (PostgreSQL version compatibility)
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Client } = require('pg');
const policy = require('../src/services/platform-preview-data-policy');
const BASE = process.env.TEST_DATABASE_URL || process.env.SQL_CHECK_CONNECTION_URL;
const PREVIEW = process.env.TEST_PREVIEW_DATABASE_URL;

function catalog() {
  return { schemas: ['public'], largeObjects: 0, sequences: [],
    relations: Object.entries(policy.policy.tables).map(([name, table]) => ({
      name, kind: 'r', rls: false, forceRls: false, inherits: false, constraints: [],
      columns: Object.fromEntries(Object.keys(table.columns).map(name => [name, ['text', false, null, '', '']])),
    })) };
}
const execute = value => async () => JSON.stringify(value);
test('runtime and CI both refuse unreviewed catalogs without compatibility exceptions', async () => {
  const value = catalog();
  assert.equal(Object.hasOwn(policy.schema, 'temporaryRuntimeFingerprints'), false);
  assert.throws(() => policy.verifyCatalog(value), /review schema fingerprint/);
  await assert.rejects(policy.inspect('synthetic-preview', execute(value)), { noFallback: true });
});

test('schema approval cannot grant export columns or unsupported relations; unlisted data stays empty', async t => {
  const value = catalog();
  value.relations.push({ name: 'public.private_data', kind: 'r', rls: false,
    forceRls: false, inherits: false, columns: {}, constraints: [] });
  const saved = policy.schema.fingerprint;
  t.after(() => { policy.schema.fingerprint = saved; });
  policy.schema.fingerprint = policy.schemaFingerprint(value);
  const result = await policy.inspect('synthetic-preview', execute(value));
  assert.ok(policy.exclusions(result.catalog).includes('public.private_data'));
  assert.equal(policy.retainedTables().includes('public.private_data'), false);

  value.relations[0].columns.private_new_field = ['text', false, null, '', ''];
  policy.schema.fingerprint = policy.schemaFingerprint(value);
  await assert.rejects(policy.inspect('synthetic-preview', execute(value)), /missing column policy/);
  delete value.relations[0].columns.private_new_field;
  value.relations[0].rls = true;
  policy.schema.fingerprint = policy.schemaFingerprint(value);
  await assert.rejects(policy.inspect('synthetic-preview', execute(value)), /unsupported relation/);
});

const at = (url, database) => { const u = new URL(url); u.pathname = `/${database}`; return String(u); };
async function connect(url) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000, query_timeout: 15000 });
  await client.connect();
  return client;
}
async function readCatalog(client) {
  return JSON.parse((await client.query(policy.CATALOG_SQL)).rows[0].inventory);
}

test('PostgreSQL source and preview catalogs agree while real schema drift is refused', { timeout: 60000 }, async t => {
  if (!BASE) { t.skip('set TEST_DATABASE_URL or SQL_CHECK_CONNECTION_URL for the catalog regression'); return; }
  let sourceCatalog;
  for (const [side, url] of [['source', BASE], ...(PREVIEW ? [['preview', PREVIEW]] : [])]) {
    await t.test(side, async t => {
      const database = `preview_catalog_${crypto.randomBytes(8).toString('hex')}`;
      const admin = await connect(url);
      let client;
      let created = false;
      try {
        await admin.query(`CREATE DATABASE ${database}`);
        created = true;
        client = await connect(at(url, database));
        await client.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
        await client.query('SET search_path = pg_catalog');
        const catalog = await readCatalog(client);
        policy.verifyCatalog(catalog); // strict CI path, no approved runtime alternative
        const inspected = await policy.inspect(database, async (_db, sql) => (await client.query(sql)).rows[0].inventory);
        assert.deepEqual(inspected.catalog, catalog);
        if (sourceCatalog) assert.deepEqual(catalog, sourceCatalog, 'both server versions must produce the same complete catalog');
        else sourceCatalog = catalog;

        // PostgreSQL 18 has extra pg_constraint rows for these same columns.
        // Real changes must still fail through attnotnull and other constraints.
        for (const [name, ddl] of [
          ['drop NOT NULL', 'ALTER TABLE public.users ALTER COLUMN password DROP NOT NULL'],
          ['add NOT NULL', 'ALTER TABLE public.users ALTER COLUMN email SET NOT NULL'],
          ['default', 'ALTER TABLE public.users ALTER COLUMN is_admin SET DEFAULT true'],
          ['check constraint', 'ALTER TABLE public.users ADD CHECK (id > 0)'],
          ['unique constraint', 'ALTER TABLE public.users ADD UNIQUE (username, email)'],
          ['foreign key', 'ALTER TABLE public.users ADD FOREIGN KEY (id) REFERENCES public.apps(id)'],
        ]) {
          await t.test(name, async () => {
            await client.query('BEGIN');
            try {
              await client.query(ddl);
              const changed = await readCatalog(client);
              assert.throws(() => policy.verifyCatalog(changed), /review schema fingerprint/);
              await assert.rejects(policy.inspect(database, execute(changed)), { noFallback: true });
            } finally { await client.query('ROLLBACK'); }
          });
        }
      } finally {
        try { await client?.end(); }
        finally {
          try { if (created) await admin.query(`DROP DATABASE ${database} WITH (FORCE)`); }
          finally { await admin.end(); }
        }
      }
    });
  }
});
