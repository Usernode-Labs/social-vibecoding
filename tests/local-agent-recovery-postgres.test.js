// A local agent's turn whose platform-side waiter died: who may take it
// over, and who runs its tail, against a real PostgreSQL (#907).
//
// The waiter that dispatched a local turn lives in the process that
// dispatched it. The statements here are what make a restart's recovery of
// such a turn exactly-once: a waiter's heartbeat and id, the leader's
// takeover of a quiet one (a new waiter id, FOR UPDATE SKIP LOCKED), and the one
// claim on the tail. The local-agent block is lifted VERBATIM out of
// schema.sql, over the few tables it references. Set TEST_DATABASE_URL to
// point it somewhere; without one it skips.
//
// Run with: node --test tests/local-agent-recovery-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const localAgent = require('../src/services/local-agent');

const DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');

function localAgentMigration() {
  const start = SCHEMA.indexOf('-- One machine\'s claim on one session.');
  assert.ok(start > 0, 'the local-agent block must be findable in schema.sql');
  const marker = "COMMENT ON TABLE local_agent_turns IS 'staging:private';";
  const end = SCHEMA.indexOf(marker, start);
  assert.ok(end > start, 'and its end');
  return SCHEMA.slice(start, end + marker.length);
}

async function connect(t) {
  const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500 });
  try { await client.connect(); } catch {
    await client.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not reachable');
    t.skip('No local PostgreSQL; set TEST_DATABASE_URL to run the database tests.');
    return null;
  }
  await client.query('DROP SCHEMA IF EXISTS local_agent_recovery_test CASCADE');
  await client.query('CREATE SCHEMA local_agent_recovery_test');
  await client.query('SET search_path = local_agent_recovery_test');
  await client.query(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE chat_sessions (id INTEGER PRIMARY KEY);
    CREATE TABLE cli_access_tokens (id BIGSERIAL PRIMARY KEY);
    INSERT INTO users (id) VALUES (5);
    INSERT INTO chat_sessions (id) VALUES (42), (43);
  `);
  await client.query(localAgentMigration());
  await client.query(`
    INSERT INTO session_agent_leases (session_id, user_id, label, expires_at)
    VALUES (42, 5, 'Evan''s laptop', NOW() + INTERVAL '2 minutes')`);
  t.after(async () => {
    await client.query('DROP SCHEMA IF EXISTS local_agent_recovery_test CASCADE').catch(() => {});
    await client.end();
  });
  return client;
}

async function enqueue(client) {
  return localAgent.enqueueTurn(client, {
    sessionId: 42, userId: 5, prompt: 'add a toggle', baseSha: 'b'.repeat(40), branchName: 'dev/x',
  });
}

// The dispatching process died this long ago.
async function silence(client, turnId, seconds) {
  await client.query(
    `UPDATE local_agent_turns SET waiter_seen_at = NOW() - make_interval(secs => $2) WHERE id = $1`,
    [turnId, seconds]
  );
}

test('a waiter that keeps renewing is never taken over; one that went quiet is, once', async (t) => {
  const client = await connect(t);
  if (!client) return;
  const queued = await enqueue(client);
  assert.match(queued.waiterId, /^[0-9a-f-]{36}$/);
  assert.equal(queued.turn.waiter_id, queued.waiterId);

  assert.deepEqual(await localAgent.adoptOrphanedTurns(client), [], 'a live waiter keeps its turn');
  assert.equal(await localAgent.renewWaiter(client, queued.turn.id, queued.waiterId), true);

  await silence(client, queued.turn.id, localAgent.WAITER_STALE_SECONDS + 5);
  const [adopted, ...more] = await localAgent.adoptOrphanedTurns(client);
  assert.equal(more.length, 0);
  assert.equal(String(adopted.id), String(queued.turn.id));
  assert.notEqual(adopted.waiter_id, queued.waiterId, 'recovery waits under an id of its own');
  assert.deepEqual(await localAgent.adoptOrphanedTurns(client), [], 'and the turn is not taken twice');

  // Had the first waiter been alive after all, it could neither renew nor
  // claim the tail: it would answer 'adopted' and leave the tail alone.
  assert.equal(await localAgent.renewWaiter(client, queued.turn.id, queued.waiterId), false);
  assert.equal(await localAgent.claimTail(client, queued.turn.id, queued.waiterId), null);
});

test('the tail is claimed once, by the waiter holding it, and a claimed turn is never taken over', async (t) => {
  const client = await connect(t);
  if (!client) return;
  const queued = await enqueue(client);
  await client.query(
    `UPDATE local_agent_turns SET status = 'completed', finished_at = NOW(), head_sha = $2 WHERE id = $1`,
    [queued.turn.id, 'c'.repeat(40)]
  );
  // The laptop finished while the platform was down; the old waiter is gone.
  await silence(client, queued.turn.id, 600);
  const [adopted] = await localAgent.adoptOrphanedTurns(client);

  const result = await localAgent.awaitTurnResult(client, adopted.id, { waiterId: adopted.waiter_id });
  assert.equal(result.outcome, 'completed');
  assert.ok(result.turn.tail_claimed_at, 'returned only with its tail claimed');
  assert.equal(result.turn.head_sha, 'c'.repeat(40));

  const second = await localAgent.awaitTurnResult(client, adopted.id, { waiterId: adopted.waiter_id });
  assert.equal(second.outcome, 'adopted', 'a second waiter, even with the id, does not get the tail');

  await silence(client, adopted.id, 600);
  assert.deepEqual(await localAgent.adoptOrphanedTurns(client), [], 'a claimed tail is never taken over');
});

test('a row from before waiters had ids is left alone', async (t) => {
  const client = await connect(t);
  if (!client) return;
  await client.query(`
    INSERT INTO local_agent_turns (session_id, lease_id, user_id, prompt, status, finished_at)
    SELECT 42, id, 5, 'old', 'completed', NOW() FROM session_agent_leases LIMIT 1`);
  assert.deepEqual(await localAgent.adoptOrphanedTurns(client, { staleSeconds: 0 }), []);
});

test('a turn the lease sweeper failed is still finished: the sweep and the takeover compose', async (t) => {
  const client = await connect(t);
  if (!client) return;
  const queued = await enqueue(client);
  await client.query(`UPDATE local_agent_turns SET status = 'running', accepted_at = NOW() WHERE id = $1`, [queued.turn.id]);
  // The machine stopped heartbeating, and the platform restarted meanwhile.
  await client.query(`UPDATE session_agent_leases SET expires_at = NOW() - INTERVAL '1 second', last_seen_at = created_at`);
  await silence(client, queued.turn.id, 600);

  assert.equal(await localAgent.sweepExpiredLeases(client), 1);
  const { rows: [swept] } = await client.query('SELECT status, error_detail FROM local_agent_turns WHERE id = $1', [queued.turn.id]);
  assert.equal(swept.status, 'abandoned', 'failed as before');

  const [adopted] = await localAgent.adoptOrphanedTurns(client);
  assert.ok(adopted, 'and still taken over, so its tail tells the user what happened');
  const result = await localAgent.awaitTurnResult(client, adopted.id, { waiterId: adopted.waiter_id });
  assert.equal(result.outcome, 'abandoned');
  assert.match(localAgent.buildTurnResult({ turn: result.turn, outcome: result.outcome, label: "Evan's laptop" }).fatalError,
    /Evan's laptop disconnected before finishing this turn: The local coding agent stopped responding\./);
});

test('a turn its work item dispatched is its item\'s: no pass takes it, and the item\'s next claim takes it over once', async (t) => {
  const client = await connect(t);
  if (!client) return;
  const workId = '11111111-2222-3333-4444-555555555555';
  const owner = { machine: 'turn', key: 'agent:9', kind: 'turn.run', workKey: 'run:t', workId };
  const queued = await localAgent.enqueueTurn(client, {
    sessionId: 42, userId: 5, prompt: 'add a toggle', baseSha: 'b'.repeat(40), branchName: 'dev/x', owner,
  });
  assert.deepEqual(queued.turn.owner, owner);
  await silence(client, queued.turn.id, 600);
  assert.deepEqual(await localAgent.adoptOrphanedTurns(client), [], 'however quiet: the item is its waiter');

  assert.equal(await localAgent.takeOverOwnedTurn(client, 'another-item'), null, 'only its own item');
  const taken = await localAgent.takeOverOwnedTurn(client, workId);
  assert.equal(String(taken.id), String(queued.turn.id));
  assert.notEqual(taken.waiter_id, queued.waiterId, 'the next claim waits under an id of its own');
  assert.equal(await localAgent.renewWaiter(client, queued.turn.id, queued.waiterId), false,
    'so the waiter a process that lost the item left answers \'adopted\' and leaves the tail');

  await client.query(`UPDATE local_agent_turns SET status = 'completed', finished_at = NOW() WHERE id = $1`, [taken.id]);
  assert.ok(await localAgent.claimTail(client, taken.id, taken.waiter_id));
  assert.equal(await localAgent.takeOverOwnedTurn(client, workId), null, 'a claimed tail is never taken over');
});
