'use strict';

// Agent sessions (#2779) against a real PostgreSQL: the trigger that stamps
// every transcript row with its conversation, the foreign keys that decide
// what outlives what, and the data layer's statements.
//
// A mock cannot have a trigger, and the whole point of this one is that the
// dozens of places that insert a message row never have to know agent
// sessions exist. So the migration is lifted VERBATIM out of schema.sql and
// run over the handful of columns it touches, the way
// tests/pr-vote-epoch-postgres.test.js does. Set TEST_DATABASE_URL to point
// it somewhere; without one it skips.
//
// Run with: node --test tests/agent-sessions-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const agentSessions = require('../src/services/agent-sessions');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');

// The block as shipped: from its banner to the delegation foreign key.
function agentSessionsMigration() {
  const start = SCHEMA.indexOf('-- Agent sessions (#2779, spec: docs/agent-sessions.md)');
  assert.ok(start > 0, 'the agent-sessions block must be findable in schema.sql');
  const marker = 'ON DELETE CASCADE\n      NOT VALID;\n  END IF;\nEND $$;';
  const end = SCHEMA.indexOf(marker, start);
  assert.ok(end > start, 'and its end');
  return SCHEMA.slice(start, end + marker.length);
}

async function connect(t, { beforeMigration = null } = {}) {
  const client = new Client({
    connectionString: process.env.TEST_DATABASE_URL
      || 'postgres://postgres:postgres@127.0.0.1:5432/postgres',
    connectionTimeoutMillis: 1500,
  });
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
      collab_visibility TEXT NOT NULL DEFAULT 'public', view_visibility TEXT NOT NULL DEFAULT 'public');
    CREATE TABLE chat_sessions (
      id SERIAL PRIMARY KEY, app_id INTEGER REFERENCES apps(id), user_id INTEGER REFERENCES users(id),
      status VARCHAR(32) NOT NULL DEFAULT 'active', source TEXT,
      pr_number INTEGER, pr_title VARCHAR(256), session_title TEXT);
    CREATE TABLE chat_session_messages (
      id SERIAL PRIMARY KEY,
      session_id INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role VARCHAR(20) NOT NULL, content TEXT NOT NULL, model VARCHAR(100),
      cost_cents NUMERIC(10,4) DEFAULT 0, metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE mcp_delegations (grant_id TEXT PRIMARY KEY, agent_session_id INTEGER);
    INSERT INTO users (id, username) VALUES (7, 'ada'), (8, 'bo');
    INSERT INTO apps (id, slug, name) VALUES (3, 'recipe-box', 'Recipe box');
  `);
  if (beforeMigration) await beforeMigration(client);
  await client.query(agentSessionsMigration());
  return client;
}

async function done(client) {
  await client.query('DROP SCHEMA IF EXISTS agent_sessions_test CASCADE').catch(() => {});
  await client.end();
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

test('every row a change writes lands in its conversation, whoever inserts it', async (t) => {
  const client = await connect(t);
  if (!client) return;
  try {
    const session = await agentSessions.createAgentSession(client, {
      user: { id: 7 }, hint: { slug: 'recipe-box', entry: 'improve' },
    });
    assert.equal(session.focusApp.slug, 'recipe-box');
    const { rows: [child] } = await client.query(
      "INSERT INTO chat_sessions (app_id, user_id, session_title) VALUES (3, 7, 'Dark mode') RETURNING *"
    );
    const { rows: [classic] } = await client.query(
      'INSERT INTO chat_sessions (app_id, user_id) VALUES (3, 7) RETURNING *'
    );
    // A row the change wrote before it was linked is backfilled by the link.
    await client.query(
      "INSERT INTO chat_session_messages (session_id, role, content) VALUES ($1, 'user', 'early')", [child.id]
    );
    assert.equal(await agentSessions.linkChange(client, {
      agentSessionId: session.id, userId: 7, change: { ...child, app_name: 'Recipe box' },
    }), true);

    // The shape of every existing insert site: it names the change and
    // nothing else.
    await client.query(
      "INSERT INTO chat_session_messages (session_id, role, content) VALUES ($1, 'assistant', 'built it')", [child.id]
    );
    await client.query(
      "INSERT INTO chat_session_messages (session_id, role, content) VALUES ($1, 'assistant', 'classic')", [classic.id]
    );

    const { rows } = await client.query(
      'SELECT content, session_id, agent_session_id FROM chat_session_messages ORDER BY id'
    );
    assert.deepEqual(rows.map((r) => [r.content, r.agent_session_id]), [
      ['early', session.id],
      ['Started a change on Recipe box: Dark mode', session.id],
      ['built it', session.id],
      ['classic', null],
    ]);

    const conversation = await agentSessions.listMessages(client, { userId: 7, id: session.id });
    assert.deepEqual(conversation.messages.map((m) => [m.content, m.changeId]), [
      ['early', child.id],
      ['Started a change on Recipe box: Dark mode', null],
      ['built it', child.id],
    ]);
    assert.equal(await agentSessions.listMessages(client, { userId: 8, id: session.id }), null,
      'another user reads nothing');

    const detail = await agentSessions.getAgentSession(client, { userId: 7, id: session.id });
    assert.equal(detail.activeChange.id, child.id);
    assert.equal(detail.activeChange.title, 'Dark mode');
    assert.deepEqual(detail.changes.map((c) => c.id), [child.id]);

    // An explicit conversation id is never overwritten by the trigger.
    const other = await agentSessions.createAgentSession(client, { user: { id: 7 } });
    await client.query(
      `INSERT INTO chat_session_messages (session_id, agent_session_id, role, content)
       VALUES ($1, $2, 'system', 'explicit')`, [child.id, other.id]
    );
    const { rows: explicit } = await client.query(
      "SELECT agent_session_id FROM chat_session_messages WHERE content = 'explicit'"
    );
    assert.equal(explicit[0].agent_session_id, other.id);
  } finally {
    await done(client);
  }
});

test('a closed change clears the active change and leaves a note', async (t) => {
  const client = await connect(t);
  if (!client) return;
  try {
    const session = await agentSessions.createAgentSession(client, { user: { id: 7 } });
    const { rows: [child] } = await client.query(
      "INSERT INTO chat_sessions (app_id, user_id, pr_number) VALUES (3, 7, 901) RETURNING *"
    );
    await agentSessions.linkChange(client, { agentSessionId: session.id, userId: 7, change: child });
    const { rows: [row] } = await client.query('SELECT * FROM chat_sessions WHERE id = $1', [child.id]);
    assert.equal(await agentSessions.noteChangeClosed(client, { change: row, outcome: 'merged' }), true);
    const detail = await agentSessions.getAgentSession(client, { userId: 7, id: session.id });
    assert.equal(detail.activeChange, null);
    const { messages } = await agentSessions.listMessages(client, { userId: 7, id: session.id });
    assert.equal(messages.at(-1).content, 'PR #901 merged. It is part of the app now.');
    assert.equal(messages.at(-1).metadata.agentSessionEvent, 'change_closed');
  } finally {
    await done(client);
  }
});

test('what outlives a deleted conversation, and what does not', async (t) => {
  const client = await connect(t);
  if (!client) return;
  try {
    const session = await agentSessions.createAgentSession(client, { user: { id: 7 } });
    const { rows: [child] } = await client.query(
      'INSERT INTO chat_sessions (app_id, user_id) VALUES (3, 7) RETURNING *'
    );
    await agentSessions.linkChange(client, { agentSessionId: session.id, userId: 7, change: child });
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

test('the constraints hold', async (t) => {
  const client = await connect(t);
  if (!client) return;
  try {
    await assert.rejects(client.query("INSERT INTO agent_sessions (user_id, status) VALUES (7, 'closed')"));
    await assert.rejects(client.query("INSERT INTO agent_sessions (user_id, status) VALUES (7, 'archived')"),
      'archived needs archived_at');
    await assert.rejects(client.query("INSERT INTO agent_sessions (user_id, focus_context) VALUES (7, '[]')"));
    const session = await agentSessions.createAgentSession(client, { user: { id: 7 } });
    const archived = await agentSessions.archiveAgentSession(client, { userId: 7, id: session.id });
    assert.equal(archived.status, 'archived');
    const reopened = await agentSessions.unarchiveAgentSession(client, { userId: 7, id: session.id });
    assert.equal(reopened.status, 'open');
    await assert.rejects(
      agentSessions.prepareChangeStart(client, { agentSessionId: session.id, userId: 8 }),
      /not found/, 'another user cannot start a change in it'
    );
  } finally {
    await done(client);
  }
});
