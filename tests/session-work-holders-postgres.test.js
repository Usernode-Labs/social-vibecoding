'use strict';

// #6068: a change's busy state against the full PostgreSQL schema. Every
// record that says work is happening is named (src/workflow/session-work.ts
// sessionHoldersSql), `workedOnSql` is exactly "one holder exists", and a
// machine state counts only while the work item that would move it is
// outstanding and the kernel has not flagged the instance: a transition that
// faulted is held with the old state, and that frozen state was what kept a
// change busy after its coding agent stopped.
//
// Then services/change-busy.js on the same rows: what is called stuck, and
// that releasing a coding record nothing holds asks its recovery while a
// record a live item holds is left alone.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/session-work-holders-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const { sessionHoldersSql, workedOnSql } = require('../src/workflow/session-work.ts');
const changeBusy = require('../src/services/change-busy');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a change holder is a live record, and workedOnSql is exactly one', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  admin.on('error', () => {});
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const dbName = 'change_busy_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(DSN); url.pathname = '/' + dbName;
  const pool = new Pool({ connectionString: String(url), max: 5 });
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const { rows: [user] } = await pool.query(
    `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`, [`cb_${crypto.randomBytes(3).toString('hex')}`]);
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, created_by) VALUES ($1, $1, $2) RETURNING id`,
    [`cb-app-${crypto.randomBytes(3).toString('hex')}`, user.id]);
  const { rows: [change] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, branch_name) VALUES ($1, $2, 'active', NULL) RETURNING id`,
    [app.id, user.id]);
  const sessionId = change.id;

  const holders = () => changeBusy.holders(pool, sessionId);
  const both = async () => {
    const { rows: [r] } = await pool.query(
      `SELECT ${workedOnSql()} AS busy, EXISTS (${sessionHoldersSql('cs.id')}) AS same
         FROM chat_sessions cs WHERE cs.id = $1`, [sessionId]);
    return r;
  };
  const assertAgree = async () => {
    const r = await both();
    assert.equal(!!r.busy, !!r.same, 'workedOnSql and the holder list agree');
    return r.busy;
  };
  // The kernel refuses instance rows written outside a transition. A fixture
  // stands in for the machine that would have written them, in one
  // transaction, with the same marker.
  const write = async (sql, params) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL app.wf_writer = 'transition'");
      const result = await client.query(sql, params);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };
  const setInstance = (machine, key, state, data, flag = null) => write(
    `INSERT INTO wf_instances (machine, key, app_id, state, data, machine_version, flag)
     VALUES ($1, $2, $3, $4, $5::jsonb, 1, $6)
     ON CONFLICT (machine, key) DO UPDATE SET state = EXCLUDED.state, data = EXCLUDED.data, flag = EXCLUDED.flag`,
    [machine, key, app.id, state, JSON.stringify(data), flag]);
  const work = (machine, key, kind, status) => write(
    `INSERT INTO wf_work (machine, key, kind, work_key, input, status, claim_id, lease_until)
     VALUES ($1, $2, $3, 'run', '{}'::jsonb, $4,
             CASE WHEN $4 = 'running' THEN gen_random_uuid() END,
             CASE WHEN $4 = 'running' THEN NOW() + interval '1 hour' END)`,
    [machine, key, kind, status]);

  // ── A turn machine instance ──────────────────────────────────────────
  const turnKey = `session:${sessionId}`;
  await setInstance('turn', turnKey, 'running', { running: { kind: 'classic' } });
  await work('turn', turnKey, 'turn.run', 'settled');
  assert.equal(await assertAgree(), false, 'a settled item behind a running instance is not work');
  assert.deepEqual(await holders(), []);

  await write(`DELETE FROM wf_work WHERE machine = 'turn' AND key = $1`, [turnKey]);
  await work('turn', turnKey, 'turn.run', 'running');
  assert.equal(await assertAgree(), true, 'the outstanding item makes the instance a holder');
  assert.deepEqual((await holders()).map((h) => h.kind), ['turn_instance']);

  await setInstance('turn', turnKey, 'running', { running: { kind: 'classic' } }, 'faulted');
  assert.equal(await assertAgree(), false, 'a faulted instance is held, not running');
  assert.deepEqual(await holders(), []);

  // ── The Homeroom bot's look ──────────────────────────────────────────
  const botKey = `request:${app.id}:29`;
  const startedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  await setInstance('bot-request', botKey, 'reading', { look: { n: 1, kind: 'read', sessionId, startedAt } });
  await work('bot-request', botKey, 'bot.look', 'running');
  assert.equal(await assertAgree(), true);
  const botHolders = await holders();
  assert.deepEqual(botHolders.map((h) => h.kind), ['bot']);
  assert.equal(botHolders[0].since, startedAt);
  const stuck = changeBusy.stuckOf(botHolders);
  assert.ok(stuck, 'a twenty-minute bot look with nothing else is stuck');
  assert.deepEqual(stuck.holders, [{ kind: 'bot', since: startedAt }]);

  await setInstance('bot-request', botKey, 'reading', { look: { n: 1, kind: 'read', sessionId, startedAt } }, 'faulted');
  assert.equal(await assertAgree(), false, 'a faulted look is not running');
  assert.deepEqual(await holders(), []);

  // ── A coding turn's record ───────────────────────────────────────────
  await pool.query(
    `UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1`,
    [sessionId, JSON.stringify({ turnId: 't-1', mode: 'build', startedAt })]);
  assert.equal(await assertAgree(), true);
  const turnHolders = await holders();
  assert.deepEqual(turnHolders.map((h) => h.kind), ['turn']);
  assert.equal(turnHolders[0].since, startedAt);

  // A record no item holds is released by asking its recovery, once; the
  // leftovers clock's own identity is the same ask, so a second call replays.
  const asked = [];
  const deps = {
    turnLeftovers: { recoverNow: async (_pool, id) => { asked.push(id); return true; } },
    platform: { stopWorkflowTurn: async () => null, operationEnded: async () => {} },
    localAgent: { abandonSessionTurns: async () => 0 },
    sessionState: { touch: () => {} },
  };
  const released = await changeBusy.releaseChange(pool, sessionId, { deps });
  assert.deepEqual(released.released, ['turn']);
  assert.deepEqual(asked, [sessionId]);

  // A record a live item holds is real work: nothing is released.
  const { rows: [item] } = await write(
    `INSERT INTO wf_work (machine, key, kind, work_key, input, status, claim_id, lease_until)
     VALUES ('turn', $1, 'turn.run', 'run:held', '{}'::jsonb, 'running',
             gen_random_uuid(), NOW() + interval '1 hour') RETURNING id`, [turnKey]);
  await pool.query(
    `UPDATE chat_sessions SET active_turn = $2::jsonb WHERE id = $1`,
    [sessionId, JSON.stringify({
      turnId: 't-2', mode: 'build', startedAt,
      owner: { machine: 'turn', key: turnKey, kind: 'turn.run', workKey: 'run:held', workId: item.id },
    })]);
  const heldAsked = [];
  const held = await changeBusy.releaseChange(pool, sessionId, {
    deps: { ...deps, turnLeftovers: { recoverNow: async (_pool, id) => { heldAsked.push(id); return true; } } },
  });
  assert.deepEqual(held.released, []);
  assert.deepEqual(heldAsked, [], 'a held record is not asked for recovery');
  assert.equal(held.working, true);

  // The cleared line is written only when something was released, in the
  // change's own thread.
  await pool.query(`UPDATE chat_sessions SET active_turn = NULL WHERE id = $1`, [sessionId]);
  await changeBusy.noteCleared(pool, sessionId, { by: 'ada' });
  const { rows: lines } = await pool.query(
    `SELECT content, metadata FROM chat_session_messages WHERE session_id = $1 AND role = 'system'`, [sessionId]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].content, changeBusy.CLEARED_LINE);
  assert.equal(lines[0].metadata.stuckBusyCleared, true);
  assert.equal(lines[0].metadata.by, 'ada');
});
