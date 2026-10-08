'use strict';

// The checks queue (issue #4317), executed against a REAL postgres
// (services/check-runs.js): the stamps enqueue writes, the supersession of
// a session's older queued run, the compare-and-swap that grants each row
// exactly once, the priority-then-FIFO order with the aging rule, the
// backoff a requeue applies, and the admin figures queueStats reports.
//
// Skips when no postgres is reachable (TEST_DATABASE_URL, else
// DATABASE_URL, else localhost), like its sibling
// tests/check-runs-handover-postgres.test.js, whose harness shape it keeps.
//
// Run with: node --test tests/check-runs-queue.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const checkRuns = require('../src/services/check-runs');

const ROOT = path.join(__dirname, '..');
const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';
const config = { captureRuntime: 'kubernetes' };

// The table as schema.sql declares it, less the foreign key (no
// chat_sessions in this throwaway schema), PLUS the queue columns and the
// chat_sessions column the dispatcher writes — the block schema.sql adds
// after the table, keyed to the same names so a rename fails loudly here.
const DDL = (() => {
  const schema = fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8');
  const start = schema.indexOf('CREATE TABLE IF NOT EXISTS check_runs');
  if (start < 0) throw new Error('check_runs is not in schema.sql any more');
  const tableEnd = schema.indexOf('CREATE INDEX IF NOT EXISTS idx_check_runs_session', start);
  if (tableEnd < 0) throw new Error('check_runs session index is not in schema.sql any more');
  const queueStart = schema.indexOf('ALTER TABLE check_runs ADD COLUMN IF NOT EXISTS queue_state', tableEnd);
  if (queueStart < 0) throw new Error('the check_runs queue columns are not in schema.sql any more');
  const queueEnd = schema.indexOf('ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS check_queue_position', queueStart);
  if (queueEnd < 0) throw new Error('chat_sessions.check_queue_position is not in schema.sql any more');
  const queueEndFull = schema.indexOf(';', queueEnd) + 1;
  const block = schema.slice(queueStart, queueEndFull)
    .replace(/ALTER TABLE check_runs ADD COLUMN IF NOT EXISTS/g, 'ALTER TABLE check_runs ADD COLUMN')
    .replace(/IF NOT EXISTS idx_check_runs_queue/, 'idx_check_runs_queue')
    .replace(/ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS/g, 'ALTER TABLE chat_sessions ADD COLUMN');
  return {
    table: schema.slice(start, schema.indexOf(');', start) + 2)
      .replace('IF NOT EXISTS ', '')
      .replace(/\s*REFERENCES chat_sessions\(id\) ON DELETE CASCADE/, ''),
    queue: `CREATE TABLE IF NOT EXISTS chat_sessions (id INTEGER PRIMARY KEY, check_state VARCHAR(24), check_phase VARCHAR(24), checks_commit_sha VARCHAR(40), status VARCHAR(16));\n${block}`,
  };
})();

async function connect() {
  let Client;
  try { ({ Client } = require('pg')); } catch { return null; }
  const client = new Client({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch (err) {
    try { await client.end(); } catch { /* never connected */ }
    return { error: err.message || err.code || String(err) };
  }
  return { client };
}

async function withSchema(client, fn) {
  const name = `check_runs_queue_test_${process.pid}`;
  await client.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
  await client.query(`CREATE SCHEMA ${name}`);
  try {
    await client.query(`SET search_path TO ${name}`);
    await client.query(DDL.table);
    await client.query(DDL.queue);
    return await fn();
  } finally {
    await client.query('SET search_path TO public').catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`).catch(() => {});
  }
}

let nextSessionId = 5000;
function sessionFixture(overrides = {}) {
  const id = overrides.id ?? nextSessionId++;
  return {
    id,
    check_state: 'pending',
    check_phase: 'queued',
    checks_commit_sha: overrides.commitSha || `sha-${id}`,
    status: 'promoted',
    ...overrides,
  };
}

async function seedSession(client, overrides = {}) {
  const s = sessionFixture(overrides);
  await client.query(
    `INSERT INTO chat_sessions (id, check_state, check_phase, checks_commit_sha, status)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET check_state = EXCLUDED.check_state,
       check_phase = EXCLUDED.check_phase, checks_commit_sha = EXCLUDED.checks_commit_sha,
       status = EXCLUDED.status`,
    [s.id, s.check_state, s.check_phase, s.checks_commit_sha, s.status]
  );
  return s.id;
}

async function seedRun(client, runId, sessionId, commitSha, extra = {}) {
  await client.query(
    `INSERT INTO check_runs (run_id, session_id, commit_sha, owner, manifest, queue_state, queue_priority, queue_attempts, queued_at)
     VALUES ($1, $2, $3, 'test:1', '{}'::jsonb, $4, $5, $6,
             COALESCE($7::timestamptz, NOW() - ($8::int * INTERVAL '1 millisecond')))
     ON CONFLICT (run_id) DO UPDATE SET session_id = EXCLUDED.session_id,
       commit_sha = EXCLUDED.commit_sha, queue_state = EXCLUDED.queue_state,
       queue_priority = EXCLUDED.queue_priority, queue_attempts = EXCLUDED.queue_attempts,
       queued_at = EXCLUDED.queued_at`,
    [runId, sessionId, commitSha, extra.queueState ?? 'queued', !!extra.priority,
      extra.attempts ?? 0, extra.queuedAt ?? null, extra.ageMs ?? 0]
  );
}

// A deterministic run-id shape (a UUID-looking string is not required by the
// code under test, only uniqueness).
let runSeq = 0;
const runId = () => `00000000-0000-4000-8000-${String(++runSeq).padStart(12, '0')}`;

test('enqueue stamps the queue state and supersedes the session\'s older queued run', async (t) => {
  const conn = await connect();
  if (!conn) return t.skip('the pg driver is not installed in this environment');
  if (conn.error) return t.skip(`no postgres reachable at ${DSN}: ${conn.error}`);
  const { client } = conn;
  try {
    await withSchema(client, async () => {
      const sessionId = await seedSession(client, { status: 'promoted' });
      const older = runId();
      const newer = runId();
      await seedRun(client, older, sessionId, 'sha-a');
      await seedRun(client, newer, sessionId, 'sha-b');
      // The session moved to a newer commit; its older run is still queued.
      const newerSession = await seedSession(client, { id: sessionId, commitSha: 'sha-b' });

      // A promoted proposal queues with priority (the row itself exists —
      // visuals.captureForSession records the manifest before queueing).
      assert.equal(await checkRuns.enqueue(client, {
        runId: newer, sessionId, commitSha: 'sha-b', priority: true,
      }), true);

      const { rows } = await client.query(
        'SELECT run_id, queue_state, queue_priority, queued_at FROM check_runs ORDER BY run_id');
      const byRun = Object.fromEntries(rows.map((r) => [r.run_id, r]));
      assert.equal(byRun[older].queue_state, 'superseded',
        'a newer commit replaces the queued run for the same session rather than joining it');
      assert.equal(byRun[newer].queue_state, 'queued');
      assert.equal(byRun[newer].queue_priority, true, 'a vote-bound proposal queues with priority');
      assert.ok(byRun[newer].queued_at, 'the queue order stamp is written');

      // Enqueueing a draft keeps it unpriority.
      const draftSession = await seedSession(client, { status: 'active', commitSha: 'sha-c' });
      const draft = runId();
      await seedRun(client, draft, draftSession, 'sha-c');
      assert.equal(await checkRuns.enqueue(client, {
        runId: draft, sessionId: draftSession, commitSha: 'sha-c', priority: false,
      }), true);
      const { rows: draftRows } = await client.query(
        'SELECT queue_priority FROM check_runs WHERE run_id = $1', [draft]);
      assert.equal(draftRows[0].queue_priority, false);
    });
  } finally {
    await client.end();
  }
});

test('dispatchOnce grants each row once, priority first then FIFO, and mirrors the position', async (t) => {
  const conn = await connect();
  if (!conn) return t.skip('the pg driver is not installed in this environment');
  if (conn.error) return t.skip(`no postgres reachable at ${DSN}: ${conn.error}`);
  const { client } = conn;
  try {
    await withSchema(client, async () => {
      // Two drafts, oldest first; one promoted. No dispatched rows, so 4
      // slots are free and all three are granted this pass.
      const draft1 = await seedSession(client, { status: 'active' });
      const draft2 = await seedSession(client, { status: 'active' });
      const voting = await seedSession(client, { status: 'promoted' });
      const d1 = runId(); const d2 = runId(); const v1 = runId();
      await seedRun(client, d1, draft1, `sha-${draft1}`, { ageMs: 60_000 });
      await seedRun(client, d2, draft2, `sha-${draft2}`, { ageMs: 30_000 });
      await seedRun(client, v1, voting, `sha-${voting}`, { ageMs: 10_000, priority: true });

      await checkRuns.dispatchOnce(config, client);

      const { rows } = await client.query(
        'SELECT run_id, queue_state FROM check_runs');
      const byRun = Object.fromEntries(rows.map((r) => [r.run_id, r.queue_state]));
      assert.equal(byRun[d1], 'dispatched', 'the first draft was granted');
      assert.equal(byRun[d2], 'dispatched', 'the second draft was granted');
      assert.equal(byRun[v1], 'dispatched', 'the promoted proposal was granted');

      // Positions were mirrored while they were queued... they are all
      // dispatched now, so every session's position is cleared.
      const { rows: positions } = await client.query(
        'SELECT id, check_queue_position FROM chat_sessions WHERE check_queue_position IS NOT NULL');
      assert.deepEqual(positions, [], 'a session whose run left the queue shows no position');

      // A full queue: no free slots (a dispatched row with a fresh
      // heartbeat), so nothing new is granted and the positions stand.
      const held = runId();
      const heldSession = await seedSession(client, { status: 'active' });
      await seedRun(client, held, heldSession, `sha-${heldSession}`, { queueState: 'dispatched' });
      const waiting = runId();
      await seedRun(client, waiting, heldSession, `sha-${heldSession}`); // session moved on — ineligible
      const waitingSession = await seedSession(client, { status: 'promoted' });
      const w1 = runId();
      await seedRun(client, w1, waitingSession, `sha-${waitingSession}`, { priority: true });
      const w2 = runId();
      await seedRun(client, w2, heldSession, `sha-${heldSession}`); // superseded-session row: ineligible
      await client.query('UPDATE chat_sessions SET checks_commit_sha = $1 WHERE id = $2',
        [`sha-other-${heldSession}`, heldSession]);

      await checkRuns.dispatchOnce(config, client, { maxConcurrent: 1 });
      const { rows: held2 } = await client.query(
        'SELECT queue_state FROM check_runs WHERE run_id = $1', [w1]);
      assert.equal(held2[0].queue_state, 'queued',
        'no slot, no grant — the vote-bound run keeps waiting');
      // Its position is 1: priority sorts ahead of any draft.
      const { rows: pos } = await client.query(
        'SELECT check_queue_position FROM chat_sessions WHERE id = $1', [waitingSession]);
      assert.equal(pos[0].check_queue_position, 1,
        'the tick mirrors the queue position onto the session');

      // The CAS: a row already granted is never granted twice by a second
      // tick (a handover runs the same code).
      await checkRuns.dispatchOnce(config, client);
      const { rows: still } = await client.query(
        'SELECT queue_state FROM check_runs WHERE run_id = $1', [w1]);
      assert.equal(still[0].queue_state, 'queued',
        'a row the second pass could not grant (no free slot) was not dispatched behind the tick\'s back');
    });
  } finally {
    await client.end();
  }
});

test('dispatchOnce ages a long-queued draft into priority and keeps FIFO within a class', async (t) => {
  const conn = await connect();
  if (!conn) return t.skip('the pg driver is not installed in this environment');
  if (conn.error) return t.skip(`no postgres reachable at ${DSN}: ${conn.error}`);
  const { client } = conn;
  try {
    await withSchema(client, async () => {
      // One slot. A promoted run queued 1s ago, and a draft queued past the
      // ten-minute aging window. The aged draft goes first.
      const promotedSession = await seedSession(client, { status: 'promoted' });
      const draftSession = await seedSession(client, { status: 'active' });
      const promoted = runId(); const agedDraft = runId();
      await seedRun(client, promoted, promotedSession, `sha-${promotedSession}`,
        { ageMs: 1_000, priority: true });
      await seedRun(client, agedDraft, draftSession, `sha-${draftSession}`,
        { ageMs: checkRuns.PRIORITY_MAX_AGE_MS + 60_000 });

      await checkRuns.dispatchOnce(config, client, { maxConcurrent: 1 });
      const { rows } = await client.query(
        'SELECT run_id, queue_state FROM check_runs WHERE run_id IN ($1, $2)', [promoted, agedDraft]);
      const byRun = Object.fromEntries(rows.map((r) => [r.run_id, r.queue_state]));
      assert.equal(byRun[agedDraft], 'dispatched',
        'a draft queued past the aging window counts as priority too');
      assert.equal(byRun[promoted], 'queued',
        'within a priority class the order is still FIFO by queue time');
    });
  } finally {
    await client.end();
  }
});

test('requeue keeps the row queued, bumps the attempts and pushes queued_at back by the backoff', async (t) => {
  const conn = await connect();
  if (!conn) return t.skip('the pg driver is not installed in this environment');
  if (conn.error) return t.skip(`no postgres reachable at ${DSN}: ${conn.error}`);
  const { client } = conn;
  try {
    await withSchema(client, async () => {
      const sessionId = await seedSession(client, { status: 'active' });
      const refused = runId();
      await seedRun(client, refused, sessionId, `sha-${sessionId}`, { queueState: 'dispatched' });

      assert.equal(await checkRuns.requeue(client, refused), true);
      let { rows } = await client.query(
        `SELECT queue_state, queue_attempts,
                EXTRACT(EPOCH FROM (queued_at - NOW()))::int AS until
           FROM check_runs WHERE run_id = $1`, [refused]);
      assert.equal(rows[0].queue_state, 'queued');
      assert.equal(rows[0].queue_attempts, 1, 'the refusal-restart is on the clock');
      assert.ok(rows[0].until >= 29 && rows[0].until <= 30,
        'the first backoff is the 30s base');

      // A second refusal doubles the delay; a requeue of an already-queued
      // row keeps its later turn.
      assert.equal(await checkRuns.requeue(client, refused), true);
      ({ rows } = await client.query(
        `SELECT queue_attempts, EXTRACT(EPOCH FROM (queued_at - NOW()))::int AS until
           FROM check_runs WHERE run_id = $1`, [refused]));
      assert.equal(rows[0].queue_attempts, 2);
      assert.ok(rows[0].until >= 59 && rows[0].until <= 60, 'the backoff doubles');
    });
  } finally {
    await client.end();
  }
});

test('queueStats reports the length and the oldest wait', async (t) => {
  const conn = await connect();
  if (!conn) return t.skip('the pg driver is not installed in this environment');
  if (conn.error) return t.skip(`no postgres reachable at ${DSN}: ${conn.error}`);
  const { client } = conn;
  try {
    await withSchema(client, async () => {
      assert.deepEqual(await checkRuns.queueStats(client), { length: 0, oldestSeconds: 0 });

      const a = await seedSession(client, { status: 'active' });
      const b = await seedSession(client, { status: 'promoted' });
      await seedRun(client, runId(), a, `sha-${a}`, { ageMs: 125_000 });
      await seedRun(client, runId(), b, `sha-${b}`, { ageMs: 5_000, priority: true });
      // A dispatched row is not "waiting": it holds a slot.
      await seedRun(client, runId(), a, `sha-${a}`, { queueState: 'dispatched' });

      const stats = await checkRuns.queueStats(client);
      assert.equal(stats.length, 2, 'only queued rows count');
      assert.ok(stats.oldestSeconds >= 120 && stats.oldestSeconds <= 125,
        'the oldest wait is the oldest queued row\'s, in seconds');
    });
  } finally {
    await client.end();
  }
});

test('awaitDispatch resolves on a grant and returns false when the run leaves the queue', async (t) => {
  const conn = await connect();
  if (!conn) return t.skip('the pg driver is not installed in this environment');
  if (conn.error) return t.skip(`no postgres reachable at ${DSN}: ${conn.error}`);
  const { client } = conn;
  try {
    await withSchema(client, async () => {
      // Dispatched resolves promptly.
      const granted = runId();
      const sessionId = await seedSession(client, { status: 'active' });
      await seedRun(client, granted, sessionId, `sha-${sessionId}`, { queueState: 'dispatched' });
      const startedAt = Date.now();
      assert.equal(await checkRuns.awaitDispatch(client, granted), true);
      assert.ok(Date.now() - startedAt < 5000, 'a granted run does not wait out a poll');

      // Superseded returns false without waiting forever.
      const superseded = runId();
      await seedRun(client, superseded, sessionId, `sha-${sessionId}`, { queueState: 'superseded' });
      assert.equal(await checkRuns.awaitDispatch(client, superseded), false,
        'a superseded run exits the wait quietly');

      // A session that moved its commit under the queued run stops wanting it.
      const stale = runId();
      const staleSession = await seedSession(client, { status: 'active', commitSha: 'sha-old' });
      await seedRun(client, stale, staleSession, 'sha-old');
      await client.query('UPDATE chat_sessions SET checks_commit_sha = $1 WHERE id = $2',
        ['sha-new', staleSession]);
      assert.equal(await checkRuns.awaitDispatch(client, stale), false,
        'a run the session no longer pins does not wait forever');
    });
  } finally {
    await client.end();
  }
});
