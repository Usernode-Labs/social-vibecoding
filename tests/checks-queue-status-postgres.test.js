'use strict';

// The checks queue's view on Admin → Health & status, on a REAL Postgres
// (#5054, part 1): every run that gets its slot, or goes ahead without one,
// leaves a CHECKS_SLOT_GRANTED row in `events`, and snapshot() reads the live
// check_runs rows and the last day of those events for the page, without
// taking the queue's lock. tests/checks-queue-status.test.js holds the rules
// that need no database.
//
// Skips when no postgres is reachable (TEST_DATABASE_URL, else DATABASE_URL,
// else localhost).
//
// Run with: node --test tests/checks-queue-status-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

process.env.CHECKS_QUEUE_POLL_MS = '250';

const checksQueue = require('../src/services/checks-queue');
const checkRuns = require('../src/services/check-runs');

const ROOT = path.join(__dirname, '..');
const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';
const SCHEMA = `checks_queue_status_pg_${process.pid}`;
const SCOPED = `${DSN}${DSN.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;

// check_runs and events exactly as schema.sql declares them.
const schema = fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8');
function slice(first, last) {
  const start = schema.indexOf(first);
  return schema.slice(start, schema.indexOf(';', schema.indexOf(last, start)) + 1);
}
const QUEUE_DDL = slice('CREATE TABLE IF NOT EXISTS check_runs', 'CREATE INDEX IF NOT EXISTS idx_check_runs_app');
const EVENTS_DDL = slice('CREATE TABLE IF NOT EXISTS events (', 'CREATE INDEX IF NOT EXISTS idx_events_type_created');
const DDL = `
  CREATE TABLE users (id SERIAL PRIMARY KEY);
  CREATE TABLE apps (id SERIAL PRIMARY KEY, slug TEXT, name TEXT, repo_url TEXT);
  CREATE TABLE chat_sessions (
    id SERIAL PRIMARY KEY, app_id INTEGER REFERENCES apps(id), status TEXT NOT NULL DEFAULT 'active',
    source TEXT NOT NULL DEFAULT 'native', pr_number INTEGER, checks_commit_sha VARCHAR(40),
    handoff_head_sha TEXT, handoff_uploaded_sha TEXT, handoff_upload_checked_sha TEXT
  );
  ${QUEUE_DDL}
  ${EVENTS_DDL}
`;

let pg;
try { pg = require('pg'); } catch { pg = null; }

let reachable = null;
async function setUp() {
  if (reachable !== null) return reachable;
  if (!pg) { reachable = 'the pg driver is not installed in this environment'; return reachable; }
  const client = new pg.Client({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${SCHEMA}`);
    await client.query(`SET search_path TO ${SCHEMA}`);
    await client.query(DDL);
    reachable = true;
  } catch (err) {
    reachable = `no postgres reachable at ${DSN}: ${err.message || err.code || err}`;
  } finally {
    await client.end().catch(() => {});
  }
  return reachable;
}

let pool = null;
test.after(async () => {
  if (pool) await pool.end().catch(() => {});
  if (reachable === true) {
    const client = new pg.Client({ connectionString: DSN });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await client.end();
  }
});

async function fresh(t, { cap = 1 } = {}) {
  const ready = await setUp();
  if (ready !== true) { t.skip(ready); return null; }
  pool = pool || new pg.Pool({ connectionString: SCOPED, max: 4 });
  await pool.query('TRUNCATE check_runs, events, chat_sessions, apps CASCADE');
  const saved = process.env.CHECKS_MAX_CONCURRENT_RUNS;
  process.env.CHECKS_MAX_CONCURRENT_RUNS = String(cap);
  t.after(() => {
    if (saved === undefined) delete process.env.CHECKS_MAX_CONCURRENT_RUNS;
    else process.env.CHECKS_MAX_CONCURRENT_RUNS = saved;
  });
  const { rows: [app] } = await pool.query(`INSERT INTO apps (slug, name, repo_url) VALUES ('demo', 'Demo', '') RETURNING id`);
  return { appId: app.id };
}

let pr = 7000;
async function session(appId, over = {}) {
  pr += 1;
  const cols = { app_id: appId, status: 'promoted', pr_number: pr, checks_commit_sha: `c${crypto.randomUUID().slice(0, 8)}`, ...over };
  const keys = Object.keys(cols);
  const { rows } = await pool.query(
    `INSERT INTO chat_sessions (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    keys.map((k) => cols[k]));
  return rows[0];
}

async function ask(s) {
  const runId = crypto.randomUUID();
  assert.ok(await checksQueue.enqueue(pool, {
    runId, sessionId: s.id, commitSha: s.checks_commit_sha, manifest: { launched: false },
  }), 'the run joined the queue');
  return runId;
}

// The slot events, oldest first. events.record is fire-and-forget, so wait
// for `n` of them.
async function slotEvents(n) {
  for (let i = 0; i < 80; i += 1) {
    const { rows } = await pool.query(
      `SELECT session_id, app_id, metadata FROM events WHERE event_type = 'checks_slot_granted' ORDER BY id`);
    if (rows.length >= n) return rows;
    await sleep(25);
  }
  throw new Error(`expected ${n} slot events`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('every run that gets a slot leaves one event saying how long it waited; one that leaves the line, none', async (t) => {
  const env = await fresh(t, { cap: 1 });
  if (!env) return;
  const first = await session(env.appId);
  const second = await session(env.appId);
  const third = await session(env.appId);
  const a = await ask(first);
  const b = await ask(second);
  const c = await ask(third);

  assert.equal((await checksQueue.waitForSlot(pool, { runId: a, pollMs: 50 })).outcome, 'admitted');

  // b waits behind a, then gets the slot when a settles; c leaves the line.
  let cWanted = true;
  const waitB = checksQueue.waitForSlot(pool, { runId: b, pollMs: 50 });
  const waitC = checksQueue.waitForSlot(pool, { runId: c, pollMs: 50, stillWanted: async () => cWanted });
  await sleep(300);
  cWanted = false;
  assert.equal((await waitC).outcome, 'superseded');
  await checkRuns.finish(pool, c);
  await checkRuns.finish(pool, a);
  assert.equal((await waitB).outcome, 'admitted');

  const rows = await slotEvents(2);
  await sleep(100);
  const { rows: all } = await pool.query(`SELECT COUNT(*)::int AS n FROM events WHERE event_type = 'checks_slot_granted'`);
  assert.equal(all[0].n, 2, 'c left the line without a slot and recorded nothing');
  const by = (id) => rows.find((r) => r.metadata.runId === id);
  assert.equal(by(a).session_id, first.id, 'attributed to the run\'s own session');
  assert.deepEqual({ ...by(a).metadata, waitedMs: 0 },
    { runId: a, kind: 'proposal', class: 'promoted', waitedMs: 0, failedOpen: false });
  assert.ok(by(b).metadata.waitedMs >= 250, `b waited for a to settle (${by(b).metadata.waitedMs} ms)`);
  assert.equal(by(b).metadata.failedOpen, false);
});

test('a run that cannot join the queue is recorded as going ahead without a slot', async (t) => {
  const env = await fresh(t);
  if (!env) return;
  // No such session: check_runs' foreign key refuses the row.
  const runId = crypto.randomUUID();
  assert.equal(await checksQueue.enqueue(pool, { runId, sessionId: 999999, commitSha: 'abc', manifest: {} }), null);
  const [event] = await slotEvents(1);
  assert.equal(event.metadata.runId, runId);
  assert.equal(event.metadata.failedOpen, true);
  assert.equal(event.session_id, null, 'the session the run named does not exist, so the event\'s column names none');
  assert.equal(event.metadata.sessionId, 999999, 'its metadata still says which run it was');
});

test('snapshot() shows who holds and waits, with their pull requests, and the last day of slots only, taking no lock', async (t) => {
  const env = await fresh(t, { cap: 1 });
  if (!env) return;
  const holder = await session(env.appId);
  const waiter = await session(env.appId, { status: 'active' });
  const h = await ask(holder);
  assert.equal((await checksQueue.waitForSlot(pool, { runId: h, pollMs: 50 })).outcome, 'admitted');
  const w = await ask(waiter);
  await checksQueue.admit(pool, { self: w });
  await slotEvents(1);

  // Today: two waits and a run that went ahead without a slot. A week ago:
  // a wait that is not today's.
  await pool.query(
    `INSERT INTO events (event_type, metadata, created_at) VALUES
       ('checks_slot_granted', '{"waitedMs": 60000, "failedOpen": false}', NOW() - INTERVAL '9 minutes'),
       ('checks_slot_granted', '{"waitedMs": 300000, "failedOpen": false}', NOW() - INTERVAL '15 minutes'),
       ('checks_slot_granted', '{"waitedMs": 0, "failedOpen": true}', NOW() - INTERVAL '1 hour'),
       ('checks_slot_granted', '{"waitedMs": 900000, "failedOpen": false}', NOW() - INTERVAL '6 days'),
       ('pr_opened', '{"waitedMs": 900000}', NOW())`);

  // The queue's lock held elsewhere: the snapshot does not wait for it.
  const locker = await pool.connect();
  await locker.query('BEGIN');
  await locker.query('SELECT pg_advisory_xact_lock($1)', [require('../src/services/advisory-locks').CHECKS_QUEUE_LOCK]);
  try {
    const q = await Promise.race([
      checksQueue.snapshot(pool),
      sleep(3000).then(() => { throw new Error('the snapshot waited for the queue lock'); }),
    ]);
    assert.equal(q.cap, 1);
    assert.deepEqual(q.slots, { proposal: 1, main: 0, sharedUsed: 1 });
    assert.equal(q.waiting, 1);
    assert.ok(q.oldestWaitMs >= 0);
    assert.deepEqual(q.runs.map((r) => [r.runId, r.state, r.place, r.prNumber, r.app, r.classLabel, r.ownerAlive]), [
      [h, 'holding', null, holder.pr_number, 'demo', 'up for a vote', true],
      [w, 'waiting', 1, waiter.pr_number, 'demo', 'draft', true],
    ]);
    assert.deepEqual(q.last24h, { runs: 4, waited: 2, medianWaitMs: 180000, longestWaitMs: 300000, failedOpen: 1 },
      'the holder\'s own slot, the two waits and the run that went ahead; the week-old wait and other events are not counted');
  } finally {
    await locker.query('ROLLBACK');
    locker.release();
  }
  const { rows: [after] } = await pool.query('SELECT COUNT(*)::int AS n FROM check_runs WHERE admitted_at IS NOT NULL');
  assert.equal(after.n, 1, 'the snapshot admitted nobody');
});
