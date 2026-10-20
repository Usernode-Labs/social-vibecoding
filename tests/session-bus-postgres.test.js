'use strict';

// A turn's stream against the FULL PostgreSQL schema (services/session-bus.js):
// what a live turn shows a browser is kept in stream_events, so a browser
// served by another process follows it and resumes after a dropped
// connection. Two copies of the module stand for two platform processes.
//
// Skipped when no server is reachable, required when TEST_DATABASE_URL is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// A second process's copy of the module (its own subscribers, queue and timers).
function freshBus() {
  const id = require.resolve('../src/services/session-bus');
  const saved = require.cache[id];
  delete require.cache[id];
  const copy = require('../src/services/session-bus');
  if (saved) require.cache[id] = saved; else delete require.cache[id];
  return copy;
}

async function until(check, { timeoutMs = 8000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('a turn\'s stream against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `session_bus_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const a = freshBus();
  const b = freshBus();
  t.after(async () => {
    await a.flush().catch(() => {});
    await b.flush().catch(() => {});
    await require('../src/services/process-presence').reset().catch(() => {});
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  a.init({ pool });
  b.init({ pool });
  let n = 0;
  const ev = (type, extra = {}) => ({ type, _seq: `t1-${++n}`, ...extra });

  await t.test('a browser on another process follows the turn as it happens, in order', async () => {
    const seen = [];
    const off = b.subscribe('41', (e) => seen.push(e));
    await until(async () => (await pool.query("SELECT 1 FROM stream_watchers WHERE stream_key = '41'")).rows.length, { label: 'watcher' });
    a.publish(41, ev('status', { text: 'Spinning up' }));
    a.publish(41, ev('cc_progress', { text: 'line 1' }));
    a.publish(41, ev('done'));
    await a.flush();
    await until(() => seen.length === 3, { label: 'three events' });
    assert.deepEqual(seen.map((e) => e.type), ['status', 'cc_progress', 'done']);
    off();
  });

  await t.test('a reconnect resumes after the last `_seq` it saw; an unknown one replays what is kept', async () => {
    a.publish(42, ev('status', { text: 'one' }));
    const second = ev('status', { text: 'two' });
    a.publish(42, second);
    a.publish(42, ev('status', { text: 'three' }));
    await a.flush();
    const after = [];
    const off1 = b.subscribe(42, (e) => after.push(e.text), second._seq);
    await until(() => after.length === 1, { label: 'resume' });
    assert.deepEqual(after, ['three']);
    off1();
    const all = [];
    const off2 = b.subscribe(42, (e) => all.push(e.text), 'never-sent');
    await until(() => all.length === 3, { label: 'replay' });
    assert.deepEqual(all, ['one', 'two', 'three']);
    off2();
  });

  await t.test('a run of tokens is one row, its texts joined, the last `_seq` kept; the order holds', async () => {
    const key = 'agent:7';
    a.publish(key, ev('token', { text: 'Hel', agentSessionId: 7 }));
    a.publish(key, ev('token', { text: 'lo', agentSessionId: 7 }));
    const last = ev('token', { text: '!', agentSessionId: 7 });
    a.publish(key, last);
    a.publish(key, ev('tool', { name: 'search', agentSessionId: 7 }));
    await a.flush();
    const { rows } = await pool.query('SELECT seq, event FROM stream_events WHERE stream_key = $1 ORDER BY id', [key]);
    assert.deepEqual(rows.map((r) => r.event.type), ['token', 'tool']);
    assert.equal(rows[0].event.text, 'Hello!');
    assert.equal(rows[0].seq, last._seq);
  });

  await t.test('a running turn\'s snapshot, by its `_seq` prefix; findLast', async () => {
    a.publish(43, { type: 'status', _seq: 'old-1', text: 'an earlier turn' });
    a.publish(43, { type: 'accepted', _seq: 'abcd1234-1', messageId: 9 });
    a.publish(43, { type: 'status', _seq: 'abcd1234-2', text: 'now' });
    await a.flush();
    const snap = await b.snapshot(43, { seqPrefix: 'abcd1234-' });
    assert.deepEqual(snap.map((e) => e._seq), ['abcd1234-1', 'abcd1234-2']);
    assert.ok(snap.every((e) => Number.isFinite(e._id)), 'with their row ids, to follow on from');
    const accepted = await b.findLast(43, (e) => e.type === 'accepted' && e.messageId === 9);
    assert.equal(accepted._seq, 'abcd1234-1');
  });

  await t.test('subscribers count while their process holds its presence lock', async () => {
    assert.equal(await a.subscriberCount('agent:8'), 0);
    const off = b.subscribe('agent:8', () => {});
    await until(async () => (await a.subscriberCount('agent:8')) === 1, { label: 'counted' });
    off();
    await until(async () => (await a.subscriberCount('agent:8')) === 0, { label: 'uncounted' });
    // A process that went: its rows no longer count, and the sweep takes them.
    await pool.query("INSERT INTO stream_watchers (stream_key, holder, opened_at) VALUES ('agent:8', 'gone:1:x', NOW() - interval '5 minutes')");
    assert.equal(await a.subscriberCount('agent:8'), 0);
    const pruned = await a.prune(pool);
    assert.equal(pruned.watchers, 1);
  });

  await t.test('a finished turn\'s rows go, a turn just started keeps its own; old streams are pruned', async () => {
    await pool.query("INSERT INTO stream_events (stream_key, seq, event, created_at) VALUES ('44', 'x-1', '{\"type\":\"done\",\"_seq\":\"x-1\"}', NOW() - interval '1 minute')");
    a.publish(44, ev('status', { text: 'next turn' }));
    await a.flush();
    a.clearSession(44);
    await until(async () => (await pool.query("SELECT COUNT(*)::int AS n FROM stream_events WHERE stream_key = '44'")).rows[0].n === 1, { label: 'cleared' });
    await pool.query("INSERT INTO stream_events (stream_key, seq, event, created_at) VALUES ('45', 'y-1', '{}', NOW() - interval '7 hours')");
    const pruned = await a.prune(pool);
    assert.ok(pruned.events >= 1);
  });
});
