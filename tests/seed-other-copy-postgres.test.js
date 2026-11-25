'use strict';

// The change's own staging seeds run against the pair's BEFORE copy one
// transaction per seed (src/db/seed-other-copy.js): a seed whose first
// statement succeeded and whose second hit a missing column must leave no
// row behind, and a seed whose media file the before copy does not hold is
// named `media` rather than written. Runs against a real PostgreSQL server;
// skipped when none is reachable and required when TEST_DATABASE_URL is set.
//
// Run with: node --test tests/seed-other-copy-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { applySeedsToOtherCopy } = require('../src/db/seed-other-copy');
const { withStagingMedia } = require('../src/services/staging-media');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';

function urlFor(schema) {
  const url = new URL(DSN);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}

async function adminClient() {
  const client = new Client({ connectionString: DSN, connectionTimeoutMillis: 2_000 });
  await client.connect();
  return client;
}

async function serverIsUp() {
  let client;
  try {
    client = await adminClient();
    return true;
  } catch (_) {
    return false;
  } finally {
    if (client) await client.end().catch(() => {});
  }
}

const seed = (name, run) => ({ name, run });

test('a change\'s seeds are written to the before copy seed by seed', async (t) => {
  if (!await serverIsUp()) {
    if (process.env.TEST_DATABASE_URL) assert.fail('TEST_DATABASE_URL is set but PostgreSQL did not answer');
    t.skip('no PostgreSQL server reachable');
    return;
  }
  const schema = `seed_other_copy_${crypto.randomBytes(6).toString('hex')}`;
  const admin = await adminClient();
  const previousEnv = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await admin.query('CREATE TABLE media_objects (object_key TEXT PRIMARY KEY)');
    await admin.query('CREATE TABLE demo_rows (id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL)');
    await admin.query('CREATE TABLE demo_media (object_key TEXT NOT NULL REFERENCES media_objects(object_key))');
    const databaseUrl = urlFor(schema);
    const names = async () => (await admin.query('SELECT name FROM demo_rows ORDER BY name')).rows.map((row) => row.name);

    await t.test('a seed that completes commits its rows', async () => {
      const result = await applySeedsToOtherCopy(databaseUrl, {}, {
        seeds: [seed('insertsRow', (pool) => pool.query("INSERT INTO demo_rows (name) VALUES ('committed')"))],
      });
      assert.deepEqual(result, { version: 1, applied: ['insertsRow'], leftOut: [] });
      assert.deepEqual(await names(), ['committed']);
    });

    await t.test('a statement the before copy cannot hold rolls back the whole seed', async () => {
      const result = await applySeedsToOtherCopy(databaseUrl, {}, {
        seeds: [seed('missingColumn', async (pool) => {
          await pool.query("INSERT INTO demo_rows (name) VALUES ('rolled-back')");
          await pool.query('INSERT INTO demo_rows (missing_column) VALUES (1)');
        })],
      });
      assert.deepEqual(result.applied, []);
      assert.deepEqual(result.leftOut, [{ name: 'missingColumn', why: 'schema' }]);
      assert.deepEqual(await names(), ['committed'], 'the first statement left nothing behind');
    });

    await t.test('an error the seed caught itself still rolls the seed back', async () => {
      const result = await applySeedsToOtherCopy(databaseUrl, {}, {
        seeds: [seed('swallowsError', async (pool) => {
          await pool.query("INSERT INTO demo_rows (name) VALUES ('caught')");
          await pool.query('INSERT INTO absent_table VALUES (1)').catch(() => {});
        })],
      });
      assert.deepEqual(result.leftOut, [{ name: 'swallowsError', why: 'schema' }]);
      assert.deepEqual(await names(), ['committed']);
    });

    await t.test('a seed that opens its own connection works inside a savepoint', async () => {
      const result = await applySeedsToOtherCopy(databaseUrl, {}, {
        seeds: [seed('nestedTransaction', async (pool) => {
          const tx = await pool.connect();
          try {
            await tx.query('BEGIN');
            await tx.query("INSERT INTO demo_rows (name) VALUES ('nested')");
            await tx.query('COMMIT');
            await tx.query("INSERT INTO demo_rows (name) VALUES ('after')");
          } finally {
            tx.release();
          }
        })],
      });
      assert.deepEqual(result.applied, ['nestedTransaction']);
      assert.deepEqual(await names(), ['after', 'committed', 'nested']);
    });

    await t.test('a media file the before copy does not hold leaves its seed out as media', async () => {
      const result = await applySeedsToOtherCopy(databaseUrl, {}, {
        seeds: [seed('newMedia', (pool) => withStagingMedia(pool, Buffer.from('a new picture'), 'image/png',
          (tx, m) => tx.query('INSERT INTO demo_media (object_key) VALUES ($1)', [m.key])))],
      });
      assert.deepEqual(result.leftOut, [{ name: 'newMedia', why: 'media' }]);
      const rows = await admin.query('SELECT object_key FROM demo_media');
      assert.equal(rows.rowCount, 0);
    });

    await t.test('a media file the before copy already holds is written through', async () => {
      const data = Buffer.from('already held');
      const key = require('../src/services/media-store').objectKey(data);
      await admin.query('INSERT INTO media_objects (object_key) VALUES ($1)', [key]);
      const result = await applySeedsToOtherCopy(databaseUrl, {}, {
        seeds: [seed('heldMedia', (pool) => withStagingMedia(pool, data, 'image/png',
          (tx, m) => tx.query('INSERT INTO demo_media (object_key) VALUES ($1)', [m.key])))],
      });
      assert.deepEqual(result.applied, ['heldMedia']);
      const rows = await admin.query('SELECT object_key FROM demo_media');
      assert.deepEqual(rows.rows.map((row) => row.object_key), [key]);
    });
  } finally {
    if (previousEnv === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = previousEnv;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
});

test('#7172: a seed that skipped is recorded as an outcome, not as applied', async (t) => {
  if (!await serverIsUp()) {
    if (process.env.TEST_DATABASE_URL) assert.fail('TEST_DATABASE_URL is set but PostgreSQL did not answer');
    t.skip('no PostgreSQL server reachable');
    return;
  }
  const { seedSkipped } = require('../src/db/staging-seed-outcome');
  const previousEnv = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  const schema = `seed_outcome_${crypto.randomBytes(6).toString('hex')}`;
  const admin = await adminClient();
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    await admin.query('CREATE TABLE demo_rows (id SERIAL PRIMARY KEY)');
    const databaseUrl = urlFor(schema);
    const result = await applySeedsToOtherCopy(databaseUrl, {}, {
      seeds: [
        { name: 'skipsItself', run: () => seedSkipped('no project staging-demo-pin-1') },
        { name: 'writesOne', run: (pool) => pool.query('INSERT INTO demo_rows DEFAULT VALUES') },
      ],
    });
    assert.deepEqual(result.outcomes, [
      { name: 'skipsItself', outcome: 'skipped', reason: 'no project staging-demo-pin-1' },
    ]);
    assert.deepEqual(result.applied, ['skipsItself', 'writesOne']);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
    if (previousEnv === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = previousEnv;
  }
});
