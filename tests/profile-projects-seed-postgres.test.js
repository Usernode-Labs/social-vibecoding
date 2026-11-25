'use strict';

// #7153: the profile's project cards show each project's own logo. The
// before & after shots open them on the staging seed (src/db/migrate.js
// seedStagingProfileProjects), so each fake project carries a real logo:
// an app_icons row whose id /app-icons/:id accepts and serves, pointed at by
// apps.icon_image_id. Against the full schema, twice (an earlier boot's
// rows are left alone), and outside staging (nothing is written).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SLUGS = ['staging-demo-profile-garden', 'staging-demo-profile-tides', 'staging-demo-profile-notes'];

test('the profile projects seed gives every card a real logo', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'profile_projects_seed_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  pool.on('error', () => {});
  const env = process.env.USERNODE_ENV;
  t.after(async () => {
    process.env.USERNODE_ENV = env;
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const { seedStagingProfileProjects } = require('../src/db/migrate');
  await pool.query("INSERT INTO users (username, password) VALUES ('usernode-capture', 'x')");

  process.env.USERNODE_ENV = 'production';
  await seedStagingProfileProjects(pool);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM app_icons')).rows[0].n, 0, 'nothing outside staging');

  process.env.USERNODE_ENV = 'staging';
  await seedStagingProfileProjects(pool);
  await seedStagingProfileProjects(pool);

  const { rows } = await pool.query(
    `SELECT a.slug, a.icon_image_id, i.content_type, i.data
       FROM apps a LEFT JOIN app_icons i ON i.id = a.icon_image_id
      WHERE a.slug = ANY($1::text[]) ORDER BY a.slug`, [SLUGS]);
  assert.equal(rows.length, 3, 'the three fake projects');
  // The route's own shaper is what hands the card its picture (src/routes/profile.js).
  const { shapeProject } = require('../src/routes/profile');
  for (const row of rows) {
    assert.equal(shapeProject(row).appIconUrl, `/app-icons/${row.icon_image_id}`, `${row.slug}'s logo reaches the card`);
    // routes/app-icons.js rejects anything but 32 lowercase hex with a 404
    // BEFORE it queries, so an id of another shape is an icon every profile
    // card would fail to load.
    assert.match(row.icon_image_id, /^[a-f0-9]{32}$/, `${row.slug} has a servable icon id`);
    assert.equal(row.content_type, 'image/png');
    assert.deepEqual([...row.data.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'a real PNG');
    assert.equal(row.data.readUInt32BE(16), 64, '64×64');
    assert.equal(row.data.readUInt32BE(20), 64);
  }
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM app_icons')).rows[0].n, 3, 'one icon each, no duplicates');
});
