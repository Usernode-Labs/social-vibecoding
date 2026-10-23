'use strict';

// A turn's model calls kept as they are made (turn_spend, services/limits.js)
// against the FULL PostgreSQL schema: a running turn counts against the caps
// at once (whichever process its calls reached), its end settles it into
// llm_usage once, a turn that reported no cost is charged what its calls
// cost, calls no live turn will settle are settled by the clock, and a
// settlement that names no turn leaves its calls to the clock.
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
  // A turn record, as turn-lifecycle.js persistNewTurn writes it.
  const session = async (turnId) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, active_turn)
     VALUES ($1, $2, 'b', 'active', $3::jsonb) RETURNING id`,
    [app.id, user.id, turnId ? JSON.stringify({ turnId, phase: 'executing' }) : null])).rows[0].id;
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

  await t.test('a settlement that names no turn bills nothing itself: the clock bills its kept calls, once', async () => {
    const { rows: [u] } = await pool.query("INSERT INTO users (username, password) VALUES ('unnamed-spender', 'x') RETURNING id");
    const mine = async () => (await pool.query(
      `SELECT COALESCE(SUM(total_cost_cents), 0)::float8 AS platform FROM llm_usage WHERE user_id = $1`, [u.id])).rows[0].platform;
    const T = crypto.randomUUID();
    const { rows: [{ id: s }] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, active_turn) VALUES ($1, $2, 'b', 'active', $3::jsonb) RETURNING id`,
      [app.id, u.id, JSON.stringify({ turnId: T, phase: 'executing' })]);
    await limits.noteTurnSpend(pool, { sessionId: s, userId: u.id, cents: 12 });
    await limits.noteTurnSpend(pool, { sessionId: s, userId: u.id, cents: 8 });
    const r = await limits.settleTurnSpend(pool, u.id, 500, { turnId: null, sessionId: s });
    assert.deepEqual(r, { platformCents: 0, byokCents: 0 });
    assert.equal(await mine(), 0, 'not the reported 500 on top of the kept calls');
    await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [s]);
    await limits.settleOpenTurnSpend(pool, { olderThanMinutes: 0 });
    assert.equal(await mine(), 20, 'the calls\' cost, once');
  });

  await t.test('a call whose write lands after its turn settled is reconciled with that settlement: never counted or billed twice', async () => {
    const { rows: [u] } = await pool.query("INSERT INTO users (username, password) VALUES ('late-spender', 'x') RETURNING id");
    const mine = async () => (await pool.query(
      `SELECT COALESCE(SUM(total_cost_cents), 0)::float8 AS platform FROM llm_usage WHERE user_id = $1`, [u.id])).rows[0].platform;
    const today = async () => Number((await pool.query(`SELECT ${limits.TODAY_USER_SPEND_SQL} AS n`, [u.id])).rows[0].n);
    const sessionOf = async (turnId) => (await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, active_turn) VALUES ($1, $2, 'b', 'active', $3::jsonb) RETURNING id`,
      [app.id, u.id, JSON.stringify({ turnId, phase: 'executing' })])).rows[0].id;

    // Claude Code reported 10 cents, which holds every call; one call's write
    // lands after the settlement, its turn read as the call started.
    const R = crypto.randomUUID();
    const s = await sessionOf(R);
    const turn = await limits.turnSpendTarget(pool, s);
    assert.deepEqual(turn, { turnId: R });
    await limits.settleTurnSpend(pool, u.id, 10, { turnId: R });
    // The next turn has its record by now: the late call is still its own turn's.
    await pool.query(`UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1`, [s, JSON.stringify({ turnId: crypto.randomUUID() })]);
    await limits.noteTurnSpend(pool, { sessionId: s, userId: u.id, cents: 10, turn });
    assert.equal(await mine(), 10, 'in the reported total already');
    assert.equal(await today(), 10, 'not counted again by the caps');
    await pool.query("UPDATE turn_spend SET created_at = NOW() - interval '3 hours' WHERE user_id = $1", [u.id]);
    await limits.settleOpenTurnSpend(pool);
    assert.equal(await mine(), 10, 'nor billed again by the clock');
    await limits.settleTurnSpend(pool, u.id, 10, { turnId: R });
    assert.equal(await mine(), 10, 'and a replayed settlement adds nothing');

    // A turn that reported nothing was charged its kept calls: a late one is
    // charged as it lands, once.
    const K = crypto.randomUUID();
    const k = await sessionOf(K);
    const kTurn = await limits.turnSpendTarget(pool, k);
    await limits.noteTurnSpend(pool, { sessionId: k, userId: u.id, cents: 4, turn: kTurn });
    await limits.settleTurnSpend(pool, u.id, 0, { turnId: K });
    assert.equal(await mine(), 14);
    await limits.noteTurnSpend(pool, { sessionId: k, userId: u.id, cents: 3, turn: kTurn });
    assert.equal(await mine(), 17, 'charged now');
    assert.equal(await today(), 17);
    await pool.query("UPDATE turn_spend SET created_at = NOW() - interval '3 hours' WHERE user_id = $1", [u.id]);
    await limits.settleOpenTurnSpend(pool);
    assert.equal(await mine(), 17, 'once');

    // A Mayor's spend settled under the same turn id is its own figure: the
    // coding agent's kept calls wait for the coding agent's settlement.
    const M = crypto.randomUUID();
    const m = await sessionOf(M);
    await limits.noteTurnSpend(pool, { sessionId: m, userId: u.id, cents: 6, turn: await limits.turnSpendTarget(pool, m) });
    await limits.settleTurnSpend(pool, u.id, 2, { turnId: M, effectKey: 'turn_wrapup_spend' });
    assert.equal(await mine(), 19, 'the Mayor\'s 2 cents');
    await limits.settleTurnSpend(pool, u.id, 0, { turnId: M });
    assert.equal(await mine(), 25, 'then the coding agent\'s kept 6');

    // A late write racing its turn's settlement waits for it, and then sees
    // that it closed the turn.
    const L = crypto.randomUUID();
    const l = await sessionOf(L);
    const lTurn = await limits.turnSpendTarget(pool, l);
    const settling = await pool.connect();
    try {
      await settling.query('BEGIN');
      await settling.query(`SELECT pg_advisory_xact_lock(hashtextextended('turn_spend:' || $1::text, 0))`, [L]);
      const late = limits.noteTurnSpend(pool, { sessionId: l, userId: u.id, cents: 9, turn: lTurn });
      await new Promise((r) => setTimeout(r, 200));
      await settling.query('INSERT INTO turn_spend_closed (turn_id, reported) VALUES ($1, TRUE)', [L]);
      await settling.query('COMMIT');
      await late;
    } finally { settling.release(); }
    assert.equal(await today(), 25, 'the reported total held it: kept as settled');
  });

  await t.test('every turn record keeps its calls, with no mark of its own: no release that settles from the report alone runs', async () => {
    const before = await open();
    const lifecycle = require('../src/services/turn-lifecycle');
    const fresh = await session(null);
    await lifecycle.persistNewTurn(pool, fresh, { turnId: crypto.randomUUID(), mode: 'build' });
    const { rows: [rec] } = await pool.query('SELECT active_turn FROM chat_sessions WHERE id = $1', [fresh]);
    assert.equal(rec.active_turn.spendKept, undefined);
    await limits.noteTurnSpend(pool, { sessionId: fresh, userId: user.id, cents: 5 });
    assert.equal(await open(), before + 1);
  });

});
