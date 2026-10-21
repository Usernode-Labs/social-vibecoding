// A local agent's turn whose platform-side waiter died: who may take it
// over, and who runs its tail, against a real PostgreSQL (#907).
//
// The waiter that dispatched a local turn lives in the process that
// dispatched it, and its owner is the turn's work item. The statements here
// are what make a restart's recovery of such a turn exactly-once: a waiter's
// heartbeat and id, the takeover by its item's next claim (a new waiter id),
// and the one claim on the tail. The local-agent block is lifted VERBATIM out of
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

const WORK_ID = '11111111-2222-3333-4444-555555555555';
async function enqueue(client, workId = WORK_ID) {
  return localAgent.enqueueTurn(client, {
    sessionId: 42, userId: 5, prompt: 'add a toggle', baseSha: 'b'.repeat(40), branchName: 'dev/x',
    owner: { machine: 'turn', key: 'agent:9', kind: 'turn.run', workKey: 'run:t', workId },
  });
}

// The dispatching process died this long ago.
async function silence(client, turnId, seconds) {
  await client.query(
    `UPDATE local_agent_turns SET waiter_seen_at = NOW() - make_interval(secs => $2) WHERE id = $1`,
    [turnId, seconds]
  );
}

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
  const adopted = await localAgent.takeOverOwnedTurn(client, WORK_ID);

  const result = await localAgent.awaitTurnResult(client, adopted.id, { waiterId: adopted.waiter_id });
  assert.equal(result.outcome, 'completed');
  assert.ok(result.turn.tail_claimed_at, 'returned only with its tail claimed');
  assert.equal(result.turn.head_sha, 'c'.repeat(40));

  const second = await localAgent.awaitTurnResult(client, adopted.id, { waiterId: adopted.waiter_id });
  assert.equal(second.outcome, 'adopted', 'a second waiter, even with the id, does not get the tail');

  assert.equal(await localAgent.takeOverOwnedTurn(client, WORK_ID), null, 'a claimed tail is never taken over');
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

  const adopted = await localAgent.takeOverOwnedTurn(client, WORK_ID);
  assert.ok(adopted, 'and still taken over, so its tail tells the user what happened');
  const result = await localAgent.awaitTurnResult(client, adopted.id, { waiterId: adopted.waiter_id });
  assert.equal(result.outcome, 'abandoned');
  assert.match(localAgent.buildTurnResult({ turn: result.turn, outcome: result.outcome, label: "Evan's laptop" }).fatalError,
    /Evan's laptop disconnected before finishing this turn: The local coding agent stopped responding\./);
});

test('a turn its work item dispatched is its item\'s: no pass takes it, and the item\'s next claim takes it over once', async (t) => {
  const client = await connect(t);
  if (!client) return;
  const workId = WORK_ID;
  const queued = await enqueue(client);
  assert.equal(queued.turn.owner.workId, workId);
  assert.match(queued.waiterId, /^[0-9a-f-]{36}$/);
  assert.equal(await localAgent.renewWaiter(client, queued.turn.id, queued.waiterId), true, 'a live waiter renews');
  assert.equal(localAgent.adoptOrphanedTurns, undefined, 'no pass takes a quiet turn: the item is its waiter');

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
