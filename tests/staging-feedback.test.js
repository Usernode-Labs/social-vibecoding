'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { seedStagingFeedback } = require('../src/services/staging-feedback');
const { editInfo } = require('../src/services/feedback-edit');
const originalEnv = process.env.USERNODE_ENV;
test.after(() => {
  if (originalEnv === undefined) delete process.env.USERNODE_ENV;
  else process.env.USERNODE_ENV = originalEnv;
});

test('never seeds production or a local server', async () => {
  const pool = { query() { assert.fail('no fixture writes outside staging'); } };
  for (const env of ['production', 'local', undefined]) {
    if (env === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = env;
    await seedStagingFeedback(pool, { selfAppSlug: 'homeroom' });
  }
});

test('PostgreSQL: the capture receipt is editable, expires normally and never replaces real feedback', async (t) => {
  const dsn = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
    || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
  const admin = new Pool({ connectionString: dsn, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (error) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw error;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'feedback_seed_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(dsn); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url) });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
  await pool.query(`
    INSERT INTO users (id, username, password) VALUES
      (7, 'usernode-capture', 'unused'), (8, 'another-member', 'unused');
    INSERT INTO apps (id, slug, name) VALUES (3, 'homeroom', 'Homeroom');
    INSERT INTO feedback_reports (id, user_id, target, title, description)
      VALUES (12, 8, 'platform', 'Real report', 'Keep these words');
  `);
  process.env.USERNODE_ENV = 'staging';
  const config = { selfAppSlug: 'homeroom' };
  await seedStagingFeedback(pool, config);
  const rows = async () => (await pool.query(`SELECT fr.*,
    (body_prefix IS NOT NULL AND body_suffix IS NOT NULL) AS has_body,
    GREATEST(0, EXTRACT(EPOCH FROM created_at + INTERVAL '5 minutes' - clock_timestamp())) AS seconds_left
    FROM feedback_reports fr ORDER BY id`)).rows;
  const before = await rows();
  const receipt = before[1];
  assert.equal(before.length, 2);
  assert.equal(receipt.user_id, 7);
  assert.equal(receipt.app_id, 3);
  assert.match(receipt.title, /^\[staging fixture\]/);
  assert.match(receipt.description, /^\[staging fixture\]/);
  assert.equal(receipt.issue_owner, 'shots-fixture');
  assert.ok(editInfo(receipt));
  await pool.query("UPDATE feedback_reports SET created_at = NOW() - INTERVAL '6 minutes' WHERE id = $1", [receipt.id]);
  const expired = (await rows())[1];
  await seedStagingFeedback(pool, config);
  const after = await rows();
  const stored = ({ seconds_left, ...row }) => row;
  assert.deepEqual(stored(after[0]), stored(before[0]), 'another member\'s feedback is untouched');
  assert.deepEqual(after[1], expired, 'a restart preserves the original receipt and deadline');
  assert.equal(editInfo(after[1]), null);
});

test('the receipt is seeded during migration after the capture identity and self app exist', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/db/migrate.js'), 'utf8');
  const seed = source.indexOf("require('../services/staging-feedback').seedStagingFeedback(pool, config)");
  assert.ok(seed > source.indexOf('await seedCaptureUser(pool)'));
  assert.ok(seed > source.indexOf('await seedSelfApp(pool, config)'));
});
