'use strict';

// The benchmark account's weekly allowance is $500 (14 Oct 2026: $100 ran out
// partway through a run, and every trial after that failed on its first
// request with OpenRouter's "Key limit exceeded"). A new account is made with
// it, and src/db/schema.sql raises the existing one once: never lower, never
// another user, and never again over an amount an admin sets afterwards in
// Admin > Limits. The included key's limit follows the account's on the
// bench's next turn (agent-turn resolveCodexRuntimeContext).
//
// The schema half skips when no database is reachable, unless
// TEST_DATABASE_URL insists.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const runner = require('../src/services/bench/runner');
const managedOpenRouter = require('../src/services/openrouter-managed-keys');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a new benchmark account is made with $500 a week, and its included key is ensured', async (t) => {
  assert.equal(runner.DEFAULT_BENCH_WEEKLY_CENTS, 50000);
  const ensured = [];
  t.mock.method(managedOpenRouter, 'ensureIncludedKey', async (args) => { ensured.push(args); return { created: true }; });
  const inserts = [];
  let made = null;
  const pool = {
    async query(sql, params) {
      if (/^INSERT INTO users/.test(sql.trim())) {
        inserts.push(params);
        made = { id: 77, username: params[0], is_synthetic: true, weekly_limit_cents: params[2] };
        return { rows: [] };
      }
      return { rows: made ? [made] : [] };
    },
  };
  const user = await runner.ensureBenchUser(pool, {});
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0][0], 'homeroom_bench');
  assert.equal(inserts[0][2], 50000, 'weekly and daily are both the default');
  assert.equal(user.weekly_limit_cents, 50000);
  assert.deepEqual(ensured.map((a) => [a.userId, a.reason]), [[77, 'homeroom_bench']]);
});

test('schema.sql raises the existing benchmark account to $500 once', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `bench_allowance_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 2 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  const marker = async () => (await pool.query(
    "SELECT value FROM platform_settings WHERE key = 'bench_weekly_limit_500'",
  )).rows[0]?.value || null;
  assert.equal(await marker(), 'true', 'a fresh database has no account to raise and is marked done');

  // Production before this release: the account made with the old $100.
  await pool.query("DELETE FROM platform_settings WHERE key = 'bench_weekly_limit_500'");
  const { rows: [bench] } = await pool.query(
    `INSERT INTO users (username, password, is_synthetic, weekly_limit_cents, daily_limit_cents)
     VALUES ('homeroom_bench', 'x', TRUE, 10000, 10000) RETURNING id`,
  );
  const { rows: [person] } = await pool.query(
    "INSERT INTO users (username, password, weekly_limit_cents) VALUES ('someone', 'x', 10000) RETURNING id",
  );
  const weekly = async (id) => (await pool.query('SELECT weekly_limit_cents FROM users WHERE id = $1', [id])).rows[0].weekly_limit_cents;

  await pool.query(schema);
  assert.equal(await weekly(bench.id), 50000);
  assert.equal(await weekly(person.id), 10000, 'nobody else');
  assert.equal(await marker(), 'true');

  // An admin lowers it afterwards in Admin > Limits; the next boot keeps it.
  await pool.query('UPDATE users SET weekly_limit_cents = 20000 WHERE id = $1', [bench.id]);
  await pool.query(schema);
  assert.equal(await weekly(bench.id), 20000);

  // Already above $500: never lowered.
  await pool.query("DELETE FROM platform_settings WHERE key = 'bench_weekly_limit_500'");
  await pool.query('UPDATE users SET weekly_limit_cents = 80000 WHERE id = $1', [bench.id]);
  await pool.query(schema);
  assert.equal(await weekly(bench.id), 80000);
});
