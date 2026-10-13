// The two statements the app-host gate's safety rests on, run against a REAL
// PostgreSQL (src/services/edge-gate.js):
//
//   * redeemOnce: a sign-in code's jti is accepted exactly once, however many
//     presentations race (one INSERT ... ON CONFLICT DO NOTHING, first writer
//     wins), and expired rows are cleared as codes are redeemed;
//   * sessionLive: the app-host cookie names its platform session by a
//     SHA-256 of the token, and is good only while that session row exists,
//     belongs to that user and has not expired (signing out deletes it).
//
// The tables come from src/db/schema.sql itself, so this describes what
// ships. Set TEST_DATABASE_URL to run; without a reachable server it skips.
//
// Run with: node --test tests/edge-gate-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

process.env.EDGE_JWT_SECRET = process.env.EDGE_JWT_SECRET || 'edge-gate-postgres-test';
const edgeGate = require('../src/services/edge-gate');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SCHEMA_NAME = `edge_gate_test_${process.pid}`;
const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');

function statement(re, label) {
  const m = SCHEMA_SQL.match(re);
  assert.ok(m, `${label} must be findable in schema.sql`);
  return m[0];
}
const REDEMPTIONS = statement(/CREATE TABLE IF NOT EXISTS edge_grant_redemptions \([\s\S]*?\n\);/, 'edge_grant_redemptions');
const REDEMPTIONS_IDX = statement(/CREATE INDEX IF NOT EXISTS edge_grant_redemptions_expiry_idx[\s\S]*?;/, 'its expiry index');
const SESSION_IDX = statement(/CREATE INDEX IF NOT EXISTS sessions_token_sha256_idx[\s\S]*?;/, 'the session hash index');

async function connect() {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return { skip: 'the pg driver is not installed' }; }
  const probe = new Pool({ connectionString: DSN, connectionTimeoutMillis: 1500, max: 1 });
  try {
    await probe.query('SELECT 1');
  } catch {
    await probe.end().catch(() => {});
    return { skip: 'No local PostgreSQL; set TEST_DATABASE_URL to run the database tests.' };
  }
  await probe.query(`CREATE SCHEMA ${SCHEMA_NAME}`);
  await probe.end();
  const pool = new Pool({ connectionString: DSN, max: 8, options: `-c search_path=${SCHEMA_NAME}` });
  await pool.query(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE sessions (
      token      VARCHAR(64) PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);
  await pool.query(REDEMPTIONS);
  await pool.query(REDEMPTIONS_IDX);
  await pool.query(SESSION_IDX);
  return { pool };
}

let ctx;
test.before(async () => { ctx = await connect(); });
test.after(async () => {
  if (!ctx?.pool) return;
  await ctx.pool.query(`DROP SCHEMA ${SCHEMA_NAME} CASCADE`).catch(() => {});
  await ctx.pool.end();
});

const jti = () => crypto.randomBytes(16).toString('hex');
const inAMinute = () => Math.floor(Date.now() / 1000) + 60;

test('a code is redeemed exactly once, even when presentations race', async (t) => {
  if (ctx.skip) return t.skip(ctx.skip);
  const id = jti();
  const results = await Promise.all(Array.from({ length: 8 }, () => edgeGate.redeemOnce(ctx.pool, id, inAMinute())));
  assert.equal(results.filter(Boolean).length, 1, 'one winner');
  assert.equal(await edgeGate.redeemOnce(ctx.pool, id, inAMinute()), false, 'and never again');
});

test('a malformed jti or expiry is refused without touching the table', async (t) => {
  if (ctx.skip) return t.skip(ctx.skip);
  for (const bad of ['', 'x'.repeat(32), `${jti()}'; DROP TABLE sessions; --`, null]) {
    assert.equal(await edgeGate.redeemOnce(ctx.pool, bad, inAMinute()), false, String(bad));
  }
  assert.equal(await edgeGate.redeemOnce(ctx.pool, jti(), NaN), false);
});

test('expired redemptions are cleared as new codes are redeemed', async (t) => {
  if (ctx.skip) return t.skip(ctx.skip);
  const old = jti();
  await ctx.pool.query(
    "INSERT INTO edge_grant_redemptions (jti, expires_at, redeemed_at) VALUES ($1, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '2 hours')",
    [old]
  );
  assert.equal(await edgeGate.redeemOnce(ctx.pool, jti(), inAMinute()), true);
  const { rows } = await ctx.pool.query('SELECT 1 FROM edge_grant_redemptions WHERE jti = $1', [old]);
  assert.equal(rows.length, 0);
});

test('a session is live only while its row exists, is the user’s, and has not expired', async (t) => {
  if (ctx.skip) return t.skip(ctx.skip);
  edgeGate._resetCachesForTest();
  const token = crypto.randomBytes(32).toString('hex');
  const sid = edgeGate.sha256Hex(token);
  await ctx.pool.query('INSERT INTO users (id) VALUES (10), (11) ON CONFLICT DO NOTHING');
  await ctx.pool.query("INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, 10, NOW() + INTERVAL '1 day')", [token]);

  assert.equal(await edgeGate.sessionLive(ctx.pool, sid, 10), true);
  edgeGate._resetCachesForTest();
  assert.equal(await edgeGate.sessionLive(ctx.pool, sid, 11), false, 'another user');
  assert.equal(await edgeGate.sessionLive(ctx.pool, edgeGate.sha256Hex('nope'), 10), false, 'another session');
  assert.equal(await edgeGate.sessionLive(ctx.pool, token, 10), false, 'the token itself is not a sid');

  // Signing out deletes the row.
  await ctx.pool.query('DELETE FROM sessions WHERE token = $1', [token]);
  edgeGate._resetCachesForTest();
  assert.equal(await edgeGate.sessionLive(ctx.pool, sid, 10), false, 'signed out');

  // An expired row is not live either.
  await ctx.pool.query("INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, 10, NOW() - INTERVAL '1 minute')", [token]);
  edgeGate._resetCachesForTest();
  assert.equal(await edgeGate.sessionLive(ctx.pool, sid, 10), false, 'expired');
});

test('the lookup is the indexed one: SQL and Node agree on the hash', async (t) => {
  if (ctx.skip) return t.skip(ctx.skip);
  const token = crypto.randomBytes(32).toString('hex');
  const { rows } = await ctx.pool.query("SELECT encode(sha256($1::varchar::bytea), 'hex') AS h", [token]);
  assert.equal(rows[0].h, edgeGate.sha256Hex(token));
  // One connection, so the planner setting and the EXPLAIN share a session.
  const client = await ctx.pool.connect();
  try {
    await client.query('SET enable_seqscan = off');
    const plan = await client.query(
      "EXPLAIN SELECT 1 FROM sessions WHERE encode(sha256(token::bytea), 'hex') = $1",
      [edgeGate.sha256Hex(token)]
    );
    assert.match(plan.rows.map((r) => r['QUERY PLAN']).join('\n'), /sessions_token_sha256_idx/);
  } finally {
    await client.query('RESET enable_seqscan');
    client.release();
  }
});
