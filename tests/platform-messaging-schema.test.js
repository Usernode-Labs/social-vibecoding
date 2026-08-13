// Platform-wide messaging schema and wiring contracts (#488).
//
// These assertions deliberately inspect the real migration and route wiring.
// The platform applies schema.sql idempotently on every boot, so keeping the
// privacy tags, normalized direct-pair constraint, and conversation-specific
// notification references in the migration is part of the product contract.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const schema = read('src/db/schema.sql');
const server = read('server.js');
const debugAccess = read('src/services/debug-access.js');

const PRIVATE_TABLES = [
  'conversations',
  'conversation_direct_pairs',
  'conversation_members',
  'conversation_messages',
  'conversation_message_reactions',
  'conversation_message_attachments',
  'conversation_message_objects',
  'chat_session_spec_conversation_shares',
  'user_blocks',
  'conversation_message_reports',
];

test('platform messaging uses separate, idempotent platform-owned tables', () => {
  for (const table of PRIVATE_TABLES) {
    assert.match(
      schema,
      new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\b`, 'i'),
      `${table} is created idempotently`,
    );
  }
  assert.doesNotMatch(
    schema,
    /ALTER TABLE\s+chat_messages\s+ADD COLUMN IF NOT EXISTS\s+conversation_id/i,
    'private platform messages must not be placed in the app-scoped chat table',
  );
});

test('every platform messaging and safety table is excluded from staging data', () => {
  for (const table of PRIVATE_TABLES) {
    assert.match(
      schema,
      new RegExp(`COMMENT ON TABLE\\s+${table}\\s+IS\\s+'staging:private'`, 'i'),
      `${table} carries the staging:private marker`,
    );
  }
});

test('direct pairs, memberships, messages, and reactions have database invariants', () => {
  assert.match(
    schema,
    /conversation_direct_pairs[\s\S]*?user_low_id[\s\S]*?user_high_id[\s\S]*?CHECK\s*\(user_low_id\s*<\s*user_high_id\)/i,
    'direct user ids are normalized at the database boundary',
  );
  assert.match(
    schema,
    /conversation_direct_pairs[\s\S]*?UNIQUE\s*\(user_low_id\s*,\s*user_high_id\)/i,
    'one unordered user pair maps to one direct conversation',
  );
  assert.match(
    schema,
    /conversation_members[\s\S]*?PRIMARY KEY\s*\(conversation_id\s*,\s*user_id\)/i,
    'a user has one lifecycle row per conversation',
  );
  assert.match(
    schema,
    /CREATE TABLE IF NOT EXISTS conversation_messages[\s\S]*?idempotency_key/i,
    'offline retries have a durable idempotency key',
  );
  assert.match(
    schema,
    /CREATE TABLE IF NOT EXISTS conversation_message_reactions[\s\S]*?(?:PRIMARY KEY|UNIQUE)\s*\(message_id\s*,\s*user_id\s*,\s*emoji\)/i,
    'reaction toggles cannot create duplicates',
  );
});

test('notifications reference conversations without overloading app chat ids', () => {
  assert.match(
    schema,
    /ALTER TABLE notifications ADD COLUMN IF NOT EXISTS conversation_id\s+INTEGER/i,
  );
  assert.match(
    schema,
    /ALTER TABLE notifications ADD COLUMN IF NOT EXISTS conversation_message_id\s+INTEGER/i,
  );
  for (const kind of [
    'conversation_invite',
    'conversation_message',
    'conversation_mention',
    'conversation_reply',
    'conversation_reaction',
  ]) {
    assert.ok(schema.includes(kind), `${kind} is registered by the migration`);
  }
});

test('private messaging tables are denied by production debug access', () => {
  for (const table of PRIVATE_TABLES) {
    assert.match(
      debugAccess,
      new RegExp(`['\"]${table}['\"]`),
      `${table} is denied by production debug access`,
    );
  }
});

test('the authenticated server mounts the conversation router', () => {
  assert.match(server, /require\(['\"]\.\/src\/routes\/conversations['\"]\)/);
  assert.match(server, /app\.use\(conversationRoutes\(config\)\)/);
});
