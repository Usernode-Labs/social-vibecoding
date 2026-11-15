'use strict';

// The agent-sessions block of the frozen baseline migration (#2779) against
// a real PostgreSQL. Agent chats are retired; their tables stay in the
// schema, unread by the platform, until a later migration drops them. While
// they are there:
//
//   1. THE BLOCK APPLIES on any database, idempotently, and its tables stay
//      private to staging copies ('staging:private').
//   2. ACCOUNT DELETION still clears a person's conversation-only rows
//      (services/account-deletion.js), and a change outlives the
//      conversation it was started from.
//   3. THE DELEGATION SWEEPER (services/mcp-oauth.js pruneDelegations) drops
//      grants a week after they ended, with their tokens.
//
// The block is lifted VERBATIM out of schema.sql and run over the handful of
// columns it touches, the way tests/pr-vote-epoch-postgres.test.js does. Set
// TEST_DATABASE_URL to point it somewhere; without one it skips.
//
// Run with: node --test tests/agent-sessions-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client, Pool } = require('pg');

const mcpOauth = require('../src/services/mcp-oauth');

const DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');

// The block as shipped: from its banner to the confirmation cards' table
// (step 3b), which follows the delegation foreign key.
function agentSessionsMigration() {
  const start = SCHEMA.indexOf('-- Agent sessions (#2779, spec: docs/agent-sessions.md)');
  assert.ok(start > 0, 'the agent-sessions block must be findable in schema.sql');
  const marker = "COMMENT ON TABLE agent_session_actions IS 'staging:private';";
  const end = SCHEMA.indexOf(marker, start);
  assert.ok(end > start, 'and its end');
  // And the block that keeps every screen of a conversation in step (the
  // version, the message revs, the triggers that bump and announce them),
  // which follows the drafts and attachments blocks.
  const syncStart = SCHEMA.indexOf('-- ── Keeping every screen of a conversation in step with the server');
  const syncMarker = 'EXECUTE FUNCTION agent_session_state_announce();\n  END IF;\nEND $$;';
  const syncEnd = SCHEMA.indexOf(syncMarker, syncStart);
  assert.ok(syncStart > end && syncEnd > syncStart, 'the sync block must be findable in schema.sql');
  return `${SCHEMA.slice(start, end + marker.length)}\n${SCHEMA.slice(syncStart, syncEnd + syncMarker.length)}`;
}

async function connect(t, { beforeMigration = null } = {}) {
  const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500 });
  try { await client.connect(); } catch {
    await client.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not reachable');
    t.skip('No local PostgreSQL; set TEST_DATABASE_URL to run the database tests.');
    return null;
  }
  await client.query('DROP SCHEMA IF EXISTS agent_sessions_test CASCADE');
  await client.query('CREATE SCHEMA agent_sessions_test');
  await client.query('SET search_path = agent_sessions_test');
  // Only the columns the migration and the data layer touch.
  await client.query(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    CREATE TABLE apps (
      id INTEGER PRIMARY KEY, slug TEXT UNIQUE, name TEXT, created_by INTEGER,
      self_hosted BOOLEAN DEFAULT FALSE,
      -- The two icon columns the data layer's focus-app projection now reads
      -- (the "Open app" header button draws the app's own artwork from them).
      -- The real table gets them from ALTER TABLE later in schema.sql; this
      -- reduced copy creates them up front, the way it creates every other
      -- column the agent-sessions statements touch.
      icon_emoji VARCHAR(32), icon_image_id VARCHAR(32),
      -- Where a request a conversation was opened on is read (#3752).
      repo_url TEXT,
      moderation_suspended_at TIMESTAMPTZ,
      collab_visibility TEXT NOT NULL DEFAULT 'public', view_visibility TEXT NOT NULL DEFAULT 'public');
    CREATE TABLE user_app_blocks (user_id INTEGER, app_id INTEGER, PRIMARY KEY (user_id, app_id));
    CREATE TABLE chat_sessions (
      id SERIAL PRIMARY KEY, app_id INTEGER REFERENCES apps(id), user_id INTEGER REFERENCES users(id),
      status VARCHAR(32) NOT NULL DEFAULT 'active', source TEXT,
      pr_number INTEGER, pr_title VARCHAR(256), session_title TEXT,
      -- The name a change got before it had a pull request, which its cards
      -- now read before the session's old name (#6124). The real table gets
      -- it from an ALTER later in schema.sql.
      proposed_pr_title TEXT,
      staging_url TEXT, check_state VARCHAR(32), test_results JSONB NOT NULL DEFAULT '[]',
      -- Why a skipped run was skipped (activeChange.checkSkipReason, #3180).
      check_error_detail TEXT,
      -- When the last verdict was stored (activeChange.failingChecks.at, #3755).
      checks_checked_at TIMESTAMPTZ,
      -- Where a pending run stands, and its progress stream, which a queued
      -- run's wait is read from (activeChange.checkPhase / checksQueueAhead,
      -- #6122).
      check_phase VARCHAR(24), checks_progress JSONB,
      shots_state VARCHAR(24), shots_run_id VARCHAR(32),
      -- A change's own durable turn (a build restart recovery can adopt).
      active_turn JSONB,
      -- When production first ran it: a merged change without it reads as
      -- going live (the merge-followups workflow machine).
      live_at TIMESTAMPTZ);
    -- The active change's running preview (activeChange.previewCapture).
    CREATE TABLE shot_runs (
      id VARCHAR(32) PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      started_at TIMESTAMPTZ);
    CREATE TABLE chat_session_messages (
      id SERIAL PRIMARY KEY,
      session_id INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role VARCHAR(20) NOT NULL, content TEXT NOT NULL, model VARCHAR(100),
      cost_cents NUMERIC(10,4) DEFAULT 0, metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      -- The dev chat's delivery id (#3177), which a conversation's sends
      -- carry too; the real table gets it from an ALTER earlier in schema.sql.
      client_message_id VARCHAR(64));
    CREATE TABLE mcp_delegations (grant_id TEXT PRIMARY KEY, agent_session_id INTEGER);
    INSERT INTO users (id, username) VALUES (7, 'ada'), (8, 'bo');
    INSERT INTO apps (id, slug, name) VALUES (3, 'recipe-box', 'Recipe box');
  `);
  if (beforeMigration) await beforeMigration(client);
  await client.query(agentSessionsMigration());
  return client;
}

async function done(client, pool = null) {
  if (pool) await pool.end().catch(() => {});
  await client.query('DROP SCHEMA IF EXISTS agent_sessions_test CASCADE').catch(() => {});
  await client.end();
}

// A pool on the test schema, for statements that check a client out
// themselves (the delegation sweeper).
function schemaPool() {
  return new Pool({ connectionString: DATABASE_URL, options: '-c search_path=agent_sessions_test', max: 6 });
}

test('a grant written before the table existed cannot stop the schema applying', async (t) => {
  // The one thing a schema block must never do is fail at boot. A delegation
  // that names an agent session id from before agent_sessions existed has to
  // leave the foreign key addable.
  const client = await connect(t, { beforeMigration: async (c) => {
    await c.query("INSERT INTO mcp_delegations (grant_id, agent_session_id) VALUES ('orphan', 999)");
  } });
  if (!client) return;
  try {
    const { rows } = await client.query(
      "SELECT convalidated FROM pg_constraint WHERE conname = 'mcp_delegations_agent_session_fk'"
    );
    assert.equal(rows.length, 1, 'the key exists');
    await assert.rejects(
      client.query("INSERT INTO mcp_delegations (grant_id, agent_session_id) VALUES ('new', 998)"),
      /mcp_delegations_agent_session_fk/, 'and binds every row written after it'
    );
  } finally {
    await done(client);
  }
});

test('the migration is idempotent', async (t) => {
  const client = await connect(t);
  if (!client) return;
  try {
    await client.query(agentSessionsMigration());
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM pg_trigger
        WHERE tgname = 'chat_session_messages_stamp_agent_session' AND NOT tgisinternal`
    );
    assert.equal(rows[0].n, 1, 'one trigger after two runs');
    const { rows: comment } = await client.query("SELECT obj_description('agent_sessions'::regclass) AS c");
    assert.equal(comment[0].c, 'staging:private');
  } finally {
    await done(client);
  }
});

test('account deletion clears a conversation\'s own rows; the change and its rows outlive it', async (t) => {
  const client = await connect(t);
  if (!client) return;
  try {
    // A conversation and its change as they stand in the tables: the change
    // links back to it, the conversation's own note names no change, and the
    // change's row is stamped by the trigger.
    const { rows: [session] } = await client.query(
      'INSERT INTO agent_sessions (user_id) VALUES (7) RETURNING id'
    );
    const { rows: [child] } = await client.query(
      'INSERT INTO chat_sessions (app_id, user_id, agent_session_id) VALUES (3, 7, $1) RETURNING *', [session.id]
    );
    await client.query(
      "INSERT INTO chat_session_messages (agent_session_id, role, content) VALUES ($1, 'system', 'note')", [session.id]
    );
    await client.query(
      "INSERT INTO chat_session_messages (session_id, role, content) VALUES ($1, 'assistant', 'kept')", [child.id]
    );
    await client.query("INSERT INTO mcp_delegations (grant_id, agent_session_id) VALUES ('g', $1)", [session.id]);

    // What account deletion runs, lifted from the service, then the user.
    const deletion = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'account-deletion.js'), 'utf8');
    const statement = deletion.match(/`(DELETE FROM chat_session_messages WHERE session_id IS NULL[\s\S]*?)`/)[1];
    await client.query(statement, [7]);
    await client.query('DELETE FROM agent_sessions WHERE user_id = 7');

    const { rows: left } = await client.query('SELECT content, agent_session_id FROM chat_session_messages ORDER BY id');
    assert.deepEqual(left.map((r) => [r.content, r.agent_session_id]), [['kept', null]],
      'the change\'s own row survives; the conversation note does not');
    const { rows: changes } = await client.query('SELECT agent_session_id FROM chat_sessions');
    assert.deepEqual(changes.map((r) => r.agent_session_id), [null], 'the change outlives its parent');
    const { rows: grants } = await client.query('SELECT * FROM mcp_delegations');
    assert.equal(grants.length, 0, 'a grant goes with the session it served');
  } finally {
    await done(client);
  }
});

test('account deletion clears those rows before it anonymises the user', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'account-deletion.js'), 'utf8');
  const rows = SRC.indexOf('DELETE FROM chat_session_messages WHERE session_id IS NULL');
  // Deletion anonymises the row, whose purge empties agent_sessions.
  assert.ok(rows > 0 && rows < SRC.indexOf('await anonymiseUser(db, userId'));
});

test('the sweeper drops delegations a week after they ended, with their tokens', async (t) => {
  const client = await connect(t);
  if (!client) return;
  const pool = schemaPool();
  try {
    await client.query(`
      ALTER TABLE mcp_delegations ADD COLUMN expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                                  ADD COLUMN revoked_at TIMESTAMPTZ;
      CREATE TABLE mcp_tokens (id SERIAL PRIMARY KEY, grant_id TEXT NOT NULL);
      INSERT INTO mcp_delegations (grant_id, expires_at, revoked_at) VALUES
        ('expired-long-ago', NOW() - interval '8 days', NULL),
        ('revoked-long-ago', NOW() + interval '1 day', NOW() - interval '8 days'),
        ('expired-recently', NOW() - interval '6 days', NULL),
        ('live', NOW() + interval '1 hour', NULL);
      INSERT INTO mcp_tokens (grant_id) VALUES
        ('expired-long-ago'), ('revoked-long-ago'), ('expired-recently'), ('live');
    `);
    assert.equal(await mcpOauth.pruneDelegations(pool), 2);
    const { rows: grants } = await client.query('SELECT grant_id FROM mcp_delegations ORDER BY grant_id');
    assert.deepEqual(grants.map((r) => r.grant_id), ['expired-recently', 'live'],
      'a recent grant stays, for the audit trail and the refusal message');
    const { rows: tokens } = await client.query('SELECT grant_id FROM mcp_tokens ORDER BY grant_id');
    assert.deepEqual(tokens.map((r) => r.grant_id), ['expired-recently', 'live']);
    assert.equal(await mcpOauth.pruneDelegations(pool), 0, 'and a second sweep finds nothing');
  } finally {
    await done(client, pool);
  }
});
