// Disconnecting a local agent from Settings, against a real PostgreSQL (#907).
//
// The Settings route used to release the lease with reason 'settings', which
// the release_reason CHECK on session_agent_leases does not allow, so on a
// real database the UPDATE failed and the route answered 503. The pool-mocked
// lease tests could not see that. Here the route runs over the local-agent
// block and the rate-limit table lifted VERBATIM out of schema.sql. Set
// TEST_DATABASE_URL to point it somewhere; without one it skips.
//
// Run with: node --test tests/local-agent-settings-detach-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { Pool } = require('pg');

const poolModule = require('../src/db/pool');
const localAgent = require('../src/services/local-agent');

const DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
const TEST_SCHEMA = 'local_agent_settings_detach_test';

// The router reads its pool once, when it is built; each test points it at
// its own database pool through this holder.
let currentPool = null;
poolModule.getPool = () => currentPool;
delete require.cache[require.resolve('../src/routes/cli-auth')];
const { cliBrowserRoutes } = require('../src/routes/cli-auth');

const config = {
  cliAuthEnabled: true,
  cliAuthOrigin: 'https://social-vibecoding.usernodelabs.org',
};

function block(startMarker, endMarker) {
  const start = SCHEMA.indexOf(startMarker);
  assert.ok(start >= 0, `schema.sql must contain ${startMarker}`);
  const end = SCHEMA.indexOf(endMarker, start);
  assert.ok(end > start, `and ${endMarker} after it`);
  return SCHEMA.slice(start, end + endMarker.length);
}

async function connect(t) {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 1500,
    options: `-c search_path=${TEST_SCHEMA}`,
    max: 2,
  });
  try {
    await pool.query('SELECT 1');
  } catch {
    await pool.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not reachable');
    t.skip('No local PostgreSQL; set TEST_DATABASE_URL to run the database tests.');
    return null;
  }
  await pool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
  await pool.query(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE chat_sessions (id INTEGER PRIMARY KEY);
    CREATE TABLE cli_access_tokens (id BIGSERIAL PRIMARY KEY);
    INSERT INTO users (id) VALUES (5);
    INSERT INTO chat_sessions (id) VALUES (42);
  `);
  await pool.query(block('CREATE TABLE IF NOT EXISTS cli_auth_rate_limits (', ');'));
  await pool.query(block(
    '-- One machine\'s claim on one session.',
    "COMMENT ON TABLE local_agent_turns IS 'staging:private';"
  ));
  t.after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`).catch(() => {});
    await pool.end();
  });
  return pool;
}

function startBrowserApp() {
  const app = express();
  // The app mounts these routes after cookie auth; stand in for it.
  app.use((req, _res, next) => { req.user = { id: 5 }; next(); });
  app.use(cliBrowserRoutes(config));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('disconnecting a machine from Settings releases its lease and abandons its turn', async (t) => {
  const pool = await connect(t);
  if (!pool) return;
  currentPool = pool;
  const { rows: [lease] } = await pool.query(
    `INSERT INTO session_agent_leases (session_id, user_id, label, expires_at)
     VALUES (42, 5, 'Evan''s laptop', NOW() + INTERVAL '2 minutes')
     RETURNING id`
  );
  const { turn } = await localAgent.enqueueTurn(pool, {
    sessionId: 42, userId: 5, prompt: 'add a toggle', baseSha: 'b'.repeat(40), branchName: 'dev/x',
  });

  const server = await startBrowserApp();
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/me/local-agents/${lease.id}`,
      { method: 'DELETE', headers: { Origin: config.cliAuthOrigin } }
    );
    assert.equal(response.status, 204);
  } finally {
    server.close();
  }

  const { rows: [released] } = await pool.query(
    'SELECT released_at, release_reason FROM session_agent_leases WHERE id = $1',
    [lease.id]
  );
  assert.ok(released.released_at, 'the lease is released');
  // The schema's own words: 'revoked' is the owner letting the machine go
  // from the browser or Settings.
  assert.equal(released.release_reason, 'revoked');
  const { rows: [after] } = await pool.query(
    'SELECT status FROM local_agent_turns WHERE id = $1',
    [turn.id]
  );
  assert.equal(after.status, 'abandoned');
});
