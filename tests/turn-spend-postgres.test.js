'use strict';

// A turn's model calls kept as they are made (turn_spend, services/limits.js)
// against the FULL PostgreSQL schema: a running turn counts against the caps
// at once (whichever process its calls reached), its end settles it into
// llm_usage once, a turn that reported no cost is charged what its calls
// cost, and calls no live turn will settle are settled by the clock.
//
// Skipped when no server is reachable, required when TEST_DATABASE_URL is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const limits = require('../src/services/limits');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a turn\'s spend as it happens, against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `turn_spend_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const { rows: [user] } = await pool.query("INSERT INTO users (username, password) VALUES ('spender', 'x') RETURNING id");
  const { rows: [app] } = await pool.query(
    "INSERT INTO apps (name, slug, status, created_by) VALUES ('Spend', 'spend', 'running', $1) RETURNING id", [user.id]);
  // A turn record as this release writes it (turn-lifecycle.js
  // persistNewTurn marks it `spendKept`), or as an older release did.
  const session = async (turnId, { older = false } = {}) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, active_turn)
     VALUES ($1, $2, 'b', 'active', $3::jsonb) RETURNING id`,
    [app.id, user.id, turnId ? JSON.stringify({ turnId, phase: 'executing', ...(older ? {} : { spendKept: true }) }) : null])).rows[0].id;
  const A = crypto.randomUUID();
  const B = crypto.randomUUID();
  const LIVE = crypto.randomUUID();
  const usage = async () => (await pool.query(
    `SELECT COALESCE(SUM(total_cost_cents), 0)::float8 AS platform, COALESCE(SUM(byok_cost_cents), 0)::float8 AS byok
       FROM llm_usage WHERE user_id = $1`, [user.id])).rows[0];
  const open = async () => (await pool.query(
    'SELECT COUNT(*)::int AS n FROM turn_spend WHERE user_id = $1 AND settled_at IS NULL', [user.id])).rows[0].n;

  await t.test('a running turn\'s calls count against today and the week at once', async () => {
    const s = await session(A);
    await limits.noteTurnSpend(pool, { sessionId: s, userId: user.id, cents: 40 });
    await limits.noteTurnSpend(pool, { sessionId: s, userId: user.id, cents: 2, byok: true });
    const { rows: [today] } = await pool.query(`SELECT ${limits.TODAY_USER_SPEND_SQL} AS n`, [user.id]);
    assert.equal(Number(today.n), 40, 'the platform-paid call, not the person\'s own key');
    const week = await limits.getWeeklyTotalsCents(pool, user.id);
    assert.deepEqual(week, { platformCents: 40, byokCents: 2 });
    const { rows: [global] } = await pool.query(`SELECT ${limits.TODAY_GLOBAL_SPEND_SQL} AS n`);
    assert.equal(Number(global.n), 40);
    const { rows: [row] } = await pool.query("SELECT turn_id FROM turn_spend WHERE session_id = $1 LIMIT 1", [s]);
    assert.equal(row.turn_id, A, 'kept against the turn recorded on its session');
  });

  await t.test('the turn\'s end settles them once: what Claude Code reported, its calls marked settled', async () => {
    const r = await limits.settleTurnSpend(pool, user.id, 55, { turnId: A, byokObservedCents: 0 });
    assert.deepEqual(r, { platformCents: 53, byokCents: 2 }, 'the person\'s own key\'s share from the kept calls');
    assert.deepEqual(await usage(), { platform: 53, byok: 2 });
    assert.equal(await open(), 0);
    const week = await limits.getWeeklyTotalsCents(pool, user.id);
    assert.deepEqual(week, { platformCents: 53, byokCents: 2 }, 'counted once, not as settled plus open');
    // Settled again (a recovery replaying the tail): nothing more.
    await limits.settleTurnSpend(pool, user.id, 55, { turnId: A });
    assert.deepEqual(await usage(), { platform: 53, byok: 2 });
  });

  await t.test('a turn that reported no cost is charged what its calls cost', async () => {
    const s = await session(B);
    await limits.noteTurnSpend(pool, { sessionId: s, userId: user.id, cents: 30 });
    await limits.settleTurnSpend(pool, user.id, 0, { turnId: B });
    assert.deepEqual(await usage(), { platform: 83, byok: 2 });
  });

  await t.test('calls no live turn will settle are settled by the clock; a live turn\'s are left', async () => {
    const live = await session(LIVE);
    const gone = await session(null);
    await limits.noteTurnSpend(pool, { sessionId: live, userId: user.id, cents: 7 });
    await limits.noteTurnSpend(pool, { sessionId: gone, userId: user.id, cents: 9 });
    await pool.query("UPDATE turn_spend SET created_at = NOW() - interval '3 hours' WHERE settled_at IS NULL");
    assert.equal(await limits.settleOpenTurnSpend(pool), 1);
    assert.deepEqual(await usage(), { platform: 92, byok: 2 });
    assert.equal(await open(), 1, 'the live turn\'s call waits for its end');
  });

  await t.test('ROLLOUT-ONLY: an older release\'s turn keeps none of its calls: it settles its spend from Claude Code\'s report alone', async () => {
    const before = await open();
    const older = await session(crypto.randomUUID(), { older: true });
    await limits.noteTurnSpend(pool, { sessionId: older, userId: user.id, cents: 11 });
    assert.equal(await open(), before, 'nothing kept, so nothing for the clock to bill again');
    const { rows: [today] } = await pool.query(`SELECT ${limits.TODAY_USER_SPEND_SQL} AS n`, [user.id]);
    assert.equal(Number(today.n), 92 + 7, 'nor counted against the caps twice');
    // A record this release writes carries the mark.
    const lifecycle = require('../src/services/turn-lifecycle');
    const fresh = await session(null);
    await lifecycle.persistNewTurn(pool, fresh, { turnId: crypto.randomUUID(), mode: 'build' });
    await limits.noteTurnSpend(pool, { sessionId: fresh, userId: user.id, cents: 5 });
    assert.equal(await open(), before + 1);
  });
});
