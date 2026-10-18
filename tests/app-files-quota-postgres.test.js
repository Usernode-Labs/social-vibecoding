'use strict';

// Per-app file storage quota overrides (#5416), against the full PostgreSQL
// schema. usageSums reads the app's slug in the same query that sums its
// files, and the caps it returns are what storeAppFile checks and what both
// usage routes report. HomeVault (homevault-9012d2) gets 10 GB per user;
// every other app keeps 200 MB per user and 2 GB per app.
//
// Like the repository's other postgres tests it skips when no database is
// reachable, unless TEST_DATABASE_URL is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const appFiles = require('../src/services/app-files');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
  '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex'
);

function fakeStore() {
  return { async putFile() {}, async removeFile() {} };
}

test('file storage quotas follow the app\'s override, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `app_files_quota_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const { rows: [user] } = await pool.query(`INSERT INTO users (username, password) VALUES ('lee', 'x') RETURNING id`);
  const addApp = async (slug) => (await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ($1, $1, 'running', $2) RETURNING id`,
    [slug, `https://github.com/x/${slug}`],
  )).rows[0].id;
  const vault = await addApp('homevault-9012d2');
  const other = await addApp('plant-pal');
  // 1 GB already stored by this user in each app (metadata rows only).
  for (const appId of [vault, other]) {
    await pool.query(
      `INSERT INTO app_files (id, app_id, user_id, filename, content_type, size_bytes, visibility, staging)
       VALUES ($1, $2, $3, 'old.png', 'image/png', $4, 'public', FALSE)`,
      [crypto.randomBytes(16).toString('hex'), appId, user.id, GB],
    );
  }

  const vaultSums = await appFiles.usageSums(pool, vault, user.id);
  assert.equal(vaultSums.userBytes, GB);
  assert.equal(vaultSums.userCapBytes, 10 * GB);
  assert.ok(vaultSums.appCapBytes > 10 * GB);

  assert.deepEqual(await appFiles.usageReport(pool, other, user.id), {
    appBytes: GB, appCapBytes: 2 * GB, userBytes: GB, userCapBytes: 200 * MB,
  });
  const vaultUsage = await appFiles.usageReport(pool, vault, user.id);
  assert.equal(vaultUsage.userCapBytes, 10 * GB);

  const upload = (appId) => appFiles.storeAppFile(pool, fakeStore(), {
    appId, userId: user.id, filename: 'new.png', visibility: 'public', staging: false, data: PNG,
  });
  const ok = await upload(vault);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const refused = await upload(other);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'user_quota_exceeded');
  assert.match(refused.error, /200 MB max/);
});
