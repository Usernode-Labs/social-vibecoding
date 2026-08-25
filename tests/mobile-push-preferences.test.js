'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CATEGORY_DEFINITIONS,
  KIND_TO_CATEGORY,
  isKindEnabled,
  serializePreferences,
  validatePreferencePatch,
  readPreferences,
  writePreferences,
} = require('../src/services/mobile-push-preferences');
const notifications = require('../src/services/notifications');

const CURRENT_KINDS = [
  'conversation_invite', 'conversation_message', 'conversation_mention',
  'conversation_reply', 'conversation_reaction',
  'mention', 'reply', 'reaction', 'kudos', 'stale_pr', 'check_failed',
  'pr_proposed', 'spec_shared', 'collab_invite', 'collab_invite_accepted',
  'approver_invite', 'approver_invite_accepted', 'session_done',
  'auto_solve_done',
  // #1405: a connector session put work somewhere, and a connector session is
  // holding for an answer. Both are "a coding session did something while you
  // were away", so both join developer_sessions rather than adding a category.
  'connector_submitted', 'agent_awaiting_input',
];

test('every current inbox kind maps exactly once to one closed category', () => {
  const flattened = CATEGORY_DEFINITIONS.flatMap((category) => category.kinds);
  assert.deepEqual([...flattened].sort(), [...CURRENT_KINDS].sort());
  assert.equal(new Set(flattened).size, CURRENT_KINDS.length);
  for (const kind of CURRENT_KINDS) assert.equal(typeof KIND_TO_CATEGORY.get(kind), 'string');
  assert.equal(KIND_TO_CATEGORY.has('future_kind'), false);
  assert.equal(isKindEnabled('future_kind'), false);
});

test('category defaults match the product contract', () => {
  assert.deepEqual(
    Object.fromEntries(CATEGORY_DEFINITIONS.map((category) => (
      [category.key, category.defaultEnabled]
    ))),
    {
      messages: true,
      direct_interactions: true,
      invitations: true,
      shared_work: true,
      developer_sessions: true,
      proposal_alerts: true,
      lightweight_activity: false,
    }
  );
  assert.equal(isKindEnabled('mention'), true);
  assert.equal(isKindEnabled('reply'), true);
  assert.equal(isKindEnabled('reaction'), false);
  assert.equal(isKindEnabled('kudos'), false);
  for (const kind of CURRENT_KINDS.filter((value) => value.startsWith('conversation_'))) {
    assert.equal(isKindEnabled(kind), true, kind);
    assert.equal(isKindEnabled(kind, { messages: false }), false, kind);
  }
});

test('disabling blocks its kinds and re-enabling is prospective policy only', () => {
  assert.equal(isKindEnabled('mention', { direct_interactions: false }), false);
  assert.equal(isKindEnabled('reply', { direct_interactions: false }), false);
  assert.equal(isKindEnabled('mention', { direct_interactions: true }), true);

  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  const trigger = schema.match(
    /CREATE OR REPLACE FUNCTION enqueue_mobile_push_deliveries\(\)[\s\S]*?END;\n\$\$;/
  )?.[0];
  assert.match(schema, /AFTER INSERT ON notifications/,
    'category state is evaluated only as a new inbox row is inserted');
  assert.doesNotMatch(trigger, /UPDATE notifications|SELECT[\s\S]*FROM notifications/,
    'the enqueue path never scans old inbox rows for backfill');
});

test('preference validation rejects malformed values and unknown categories', () => {
  assert.deepEqual(validatePreferencePatch({
    preferences: { direct_interactions: false, lightweight_activity: true },
  }), {
    details: {},
    values: { direct_interactions: false, lightweight_activity: true },
  });

  for (const body of [null, [], {}, { preferences: [] }, { preferences: {} }, {
    preferences: { direct_interactions: 'false' },
  }, {
    preferences: { future_category: true },
  }, {
    preferences: { direct_interactions: true }, extra: true,
  }]) {
    assert.notDeepEqual(validatePreferencePatch(body).details, {}, JSON.stringify(body));
  }
});

function preferencePool() {
  const accounts = new Map();
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (String(sql).startsWith('INSERT INTO mobile_push_preferences')) {
        const account = accounts.get(String(params[0])) || {};
        params[1].forEach((key, index) => { account[key] = params[2][index]; });
        accounts.set(String(params[0]), account);
        return { rows: [] };
      }
      if (String(sql).includes('FROM mobile_push_preferences')) {
        const account = accounts.get(String(params[0])) || {};
        return {
          rows: Object.entries(account).map(([category, enabled]) => ({ category, enabled })),
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

test('preferences are account-scoped and never mutate device registrations', async () => {
  const pool = preferencePool();
  await writePreferences(pool, 7, { direct_interactions: false });
  await writePreferences(pool, 8, { lightweight_activity: true });

  const first = await readPreferences(pool, 7);
  const second = await readPreferences(pool, 8);
  assert.equal(first.find((row) => row.key === 'direct_interactions').enabled, false);
  assert.equal(first.find((row) => row.key === 'lightweight_activity').enabled, false);
  assert.equal(second.find((row) => row.key === 'direct_interactions').enabled, true);
  assert.equal(second.find((row) => row.key === 'lightweight_activity').enabled, true);
  assert.ok(pool.calls.every((call) => !/mobile_push_registrations/.test(call.sql)),
    'account updates do not delete, recreate, or update phone registrations');

  const defaults = serializePreferences();
  assert.equal(defaults.length, 7);
  assert.ok(defaults.every((row) => typeof row.enabled === 'boolean'));
});

test('one account preference applies across every independently eligible registration', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  const trigger = schema.match(
    /CREATE OR REPLACE FUNCTION enqueue_mobile_push_deliveries\(\)[\s\S]*?END;\n\$\$;/
  )?.[0];
  assert.match(trigger, /preference\.user_id = NEW\.user_id/);
  assert.match(trigger, /r\.user_id = NEW\.user_id/);
  assert.match(trigger, /SELECT r\.id, r\.environment, r\.installation_id, r\.platform/);
  assert.match(trigger, /permission_status IN \('authorized', 'provisional'\)/,
    'the independent device master/permission switch remains required');
  assert.doesNotMatch(trigger, /LIMIT 1/,
    'all eligible registrations for the account receive the same category policy');
});

test('in-app inbox creation does not consult mobile-push preferences', async () => {
  const pool = {
    async query(sql, params) {
      assert.match(sql, /^INSERT INTO notifications/);
      assert.doesNotMatch(sql, /mobile_push_preferences/);
      return { rows: [{
        id: 91, user_id: params[0], kind: 'reply', chat_message_id: params[2],
      }] };
    },
  };
  const rows = await notifications.createReplyNotification(pool, {
    appId: 4, replyMessageId: 12, senderId: 2, recipientId: 7,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'reply');
});
