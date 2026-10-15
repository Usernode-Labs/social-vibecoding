'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

async function database(t, prefix) {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 1500 });
  try { await admin.query('SELECT 1'); }
  catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return null;
  }
  const name = `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 12 });
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  return { pool, schema, url: String(url) };
}

async function reset(pool) {
  await pool.query('TRUNCATE security_bot_runs CASCADE');
  await pool.query('TRUNCATE security_bot_daily_budgets');
  await pool.query("DELETE FROM platform_settings WHERE key LIKE 'security_bot.%'");
  await pool.query("INSERT INTO platform_settings (key, value) VALUES ('security_bot.enabled', 'true')");
}

module.exports = { database, reset };
