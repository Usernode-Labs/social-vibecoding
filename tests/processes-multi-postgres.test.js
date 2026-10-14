'use strict';

// Two real platform processes (tests/lib/process-child.js), each with the
// registry and the WebSocket bus, against one throwaway PostgreSQL database:
// what each must see of the other while a release lets the replaced one
// finish its work (docs/plans/draining-releases.md).
//
//   - a hold one takes reaches the other's copy, and its exact read;
//   - a stop one publishes reaches the other (the bus the stops ride on);
//   - a release reaches it; so does a graceful stop, at once;
//   - a process that died holding something holds nothing once its beat
//     lapses.
//
// Skipped when no server is reachable, required when TEST_DATABASE_URL is set.
// Run with: TEST_DATABASE_URL=postgres://... node --test tests/processes-multi-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

async function until(check, { timeoutMs = 15000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function child(url) {
  const proc = spawn(process.execPath, [path.join(__dirname, 'lib', 'process-child.js'), url], {
    stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, LOG_LEVEL: 'error' },
  });
  const waiting = new Map();
  const bus = [];
  let ready = null;
  const readyP = new Promise((resolve, reject) => { ready = { resolve, reject }; });
  let nextId = 1;
  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === 'ready') ready.resolve(msg.processId);
    else if (msg.type === 'fatal') ready.reject(new Error(msg.error));
    else if (msg.type === 'bus') bus.push(msg);
    else if (msg.type === 'reply' && waiting.has(msg.id)) {
      const w = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error)); else w.resolve(msg.value);
    }
  });
  const ask = (cmd) => new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    proc.stdin.write(`${JSON.stringify({ ...cmd, id })}\n`);
  });
  return { proc, ask, bus, ready: readyP };
}

test('two platform processes see each other\'s holds and stops', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'processes_multi_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const old = child(String(url));
  const fresh = child(String(url));
  t.after(async () => {
    for (const c of [old, fresh]) { try { c.proc.kill('SIGKILL'); } catch { /* gone */ } }
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });
  const oldId = await old.ready;
  const freshId = await fresh.ready;
  assert.notEqual(oldId, freshId);

  // The old process is finishing a turn on session 7.
  await old.ask({ op: 'hold', kind: 'session', ref: 7 });
  await until(() => fresh.ask({ op: 'heldElsewhere', kind: 'session', ref: 7 }), { label: 'the new process seeing the turn' });
  assert.deepEqual(await fresh.ask({ op: 'holders', kind: 'session', ref: 7 }), [oldId]);
  assert.equal(await old.ask({ op: 'heldElsewhere', kind: 'session', ref: 7 }), false, 'a process does not see itself elsewhere');

  // A Stop clicked on the new process reaches the old one.
  await fresh.ask({ op: 'publish', kind: 'session_stop', data: { sessionId: 7, user: { id: 1, username: 'alice' } } });
  await until(() => old.bus.some((m) => m.kind === 'session_stop' && m.data.sessionId === 7), { label: 'the stop reaching the holder' });
  assert.ok(!fresh.bus.some((m) => m.kind === 'session_stop'), 'and never comes back to its sender');

  // The turn ends: the new process sees the session free.
  await old.ask({ op: 'release', kind: 'session', ref: 7 });
  await until(async () => !(await fresh.ask({ op: 'heldElsewhere', kind: 'session', ref: 7 })), { label: 'the release reaching the new process' });

  // The old process exits holding a build: its row goes, and the build is free at once.
  await old.ask({ op: 'hold', kind: 'staging_build', ref: 9 });
  await until(() => fresh.ask({ op: 'heldElsewhere', kind: 'staging_build', ref: 9 }), { label: 'the build seen' });
  await old.ask({ op: 'stop' }).catch(() => {});
  await until(async () => (await fresh.ask({ op: 'holders', kind: 'staging_build', ref: 9 })).length === 0,
    { label: 'a stopped process holding nothing' });

  // A process that dies holding something holds nothing once its beat lapses.
  await pool.query(
    `INSERT INTO platform_processes (id, heartbeat_at) VALUES ('crashed', NOW())`);
  await pool.query(`INSERT INTO process_holds (process_id, kind, ref) VALUES ('crashed', 'capture', '11')`);
  await fresh.ask({ op: 'refresh' });
  assert.equal(await fresh.ask({ op: 'heldElsewhere', kind: 'capture', ref: 11 }), true);
  await pool.query(`UPDATE platform_processes SET heartbeat_at = NOW() - interval '10 minutes' WHERE id = 'crashed'`);
  await fresh.ask({ op: 'refresh' });
  assert.equal(await fresh.ask({ op: 'heldElsewhere', kind: 'capture', ref: 11 }), false);
  assert.deepEqual(await fresh.ask({ op: 'holders', kind: 'capture', ref: 11 }), []);
  await fresh.ask({ op: 'stop' }).catch(() => {});
});
