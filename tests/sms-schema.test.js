// The SMS half's tables, pinned: `sms_deliveries` and `sms_suppressions`,
// plus the phone columns this change added to the two waitlist tables.
//
// Two properties a table gets wrong quietly:
//
//  1. PRIVACY. A delivery log is a list of phone numbers in bulk — PII the
//     platform does not hand out through a debug surface — so both tables
//     are `staging:private` AND denied in the prod-debug console and the DB
//     export. Being private alone would still let an admin read the numbers
//     through /admin's SQL tool.
//  2. THE ONE-KEY-PER-ROW INVARIANT. Which channel a signup uses at release
//     must be a property of the row, never a second decision, so the schema
//     refuses a row with two keys or none, and refuses a number that is not
//     E.164.
//
// Static assertions on schema.sql, no database required. The behavioural
// half of the constraint set is exercised in tests/waitlist-phone-signup.
//
// Run with: node --test tests/sms-schema.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const schema = fs.readFileSync(path.join(ROOT, 'src/db/schema.sql'), 'utf8');
const debugAccess = require('../src/services/debug-access');
const dbExport = require('../src/services/db-export');

test('sms_deliveries is created idempotently with the throttle\'s columns and indexes', () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS sms_deliveries/);
  for (const col of ['kind', 'recipient', 'provider', 'status', 'error', 'provider_message_id', 'created_at']) {
    assert.match(schema, new RegExp(`\\b${col}\\b`), `sms_deliveries.${col} should exist`);
  }
  assert.match(schema, /CREATE INDEX IF NOT EXISTS idx_sms_deliveries_recipient/);
  assert.match(schema, /CREATE INDEX IF NOT EXISTS idx_sms_deliveries_created/);
});

test('sms_suppressions keys on the recipient and only takes known reasons', () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS sms_suppressions/);
  assert.match(schema, /reason\s+TEXT NOT NULL CHECK \(reason IN \('bounce', 'stop', 'complaint'\)\)/);
});

test('both sms tables are staging:private, so a clone starts empty', () => {
  assert.match(schema, /COMMENT ON TABLE sms_deliveries IS 'staging:private'/);
  assert.match(schema, /COMMENT ON TABLE sms_suppressions IS 'staging:private'/);
});

test('both sms tables are denied in the prod-debug console and the DB export', () => {
  // A log of who the platform texted and when is a list of numbers; neither
  // the debug console nor the export may reveal it.
  for (const table of ['sms_deliveries', 'sms_suppressions']) {
    assert.ok(debugAccess.DENIED_TABLES.has(table), `${table} must be denied in debug-access`);
    assert.ok(dbExport.EXCLUDED_TABLE_DATA.includes(table), `${table} must be excluded from the DB export`);
  }
});

test('waitlist_signups gains phone_e164 with a unique index and the format check', () => {
  assert.match(schema, /ALTER TABLE waitlist_signups ADD COLUMN IF NOT EXISTS phone_e164 VARCHAR\(16\)/);
  // A plain (non-partial) unique index — the shape ON CONFLICT (phone_e164)
  // infers in services/waitlist.js. A partial index would need every
  // statement to repeat its predicate.
  assert.match(schema,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_signups_phone_e164\s+ON waitlist_signups \(phone_e164\);/);
  assert.match(schema, /phone_e164 ~ '\^\\\+\[1-9\]\[0-9\]\{1,14\}\$'/);
});

test('waitlist_signups.email is nullable so a phone-only row can exist', () => {
  // A real widening: every WHERE LOWER(email)=... lookup must tolerate null.
  assert.match(schema, /ALTER TABLE waitlist_signups ALTER COLUMN email DROP NOT NULL/);
});

test('waitlist_signups refuses a row with no key', () => {
  assert.match(schema, /waitlist_signups_key_present_check/);
  assert.match(schema, /CHECK \(email IS NOT NULL OR phone_e164 IS NOT NULL\)/);
});

test('waitlist_verification_codes is keyed by exactly one of email/phone', () => {
  assert.match(schema, /ALTER TABLE waitlist_verification_codes ADD COLUMN IF NOT EXISTS phone_e164 VARCHAR\(16\)/);
  assert.match(schema, /waitlist_verification_codes_key_check/);
  // XOR: exactly one key, never both and never neither.
  assert.match(schema, /CHECK \(\(email IS NOT NULL\) <> \(phone_e164 IS NOT NULL\)\)/);
});
