// Topochain Task 2 — `users` columns, `platform_settings` seed, staging
// privacy (plan Task 2; SPEC §8.5 users columns 3283-3294, §3.5 settings
// 801-804, §6 staging privacy 3080-3088).
//
// Static assertions on the SQL/JS source — no database required. Mirrors
// tests/db-export-schema.test.js style. Companion to
// tests/topochain-schema.test.js (the 22 tables) and
// tests/prod-debug-access.test.js (which cross-checks every
// staging:private COLUMN tag against the debug-access.js deny lists —
// run all three together).
//
// Run with: node --test tests/topochain-privacy-schema.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'src/db/schema.sql'), 'utf8');
const debugAccess = require('../src/services/debug-access');

// Isolate the Task 2 block so column/index assertions can't accidentally
// match unrelated platform tables (e.g. the platform's own `users` table
// definition, or other staging:private tags) elsewhere in the file.
//
// The block is bounded at BOTH ends. It used to run to end-of-file, which
// silently depended on Task 2 being the last thing in schema.sql — so the
// next feature to append a table (the hosted MCP connector) started
// inflating this file's counts. The end bound is the next top-level
// section header, so later additions land outside the block where they
// belong.
const blockStart = schema.indexOf('Topochain Task 2 — `users` columns');
assert.ok(blockStart > 0, 'the Task 2 block header exists');
const afterStart = schema.slice(blockStart);
const nextSection = afterStart.search(/\n-- ── /);
const block = nextSection > 0 ? afterStart.slice(0, nextSection) : afterStart;

// ─── users columns ──────────────────────────────────────────────────

test('every SPEC §8.5 users column is added idempotently with the right type', () => {
  const cols = [
    ['email', 'VARCHAR(255)'],
    ['email_confirmed', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['email_confirmation_token', 'VARCHAR(255)'],
    ['email_confirmation_sent_at', 'TIMESTAMPTZ'],
    ['email_confirmed_at', 'TIMESTAMPTZ'],
    ['display_name', 'VARCHAR(255)'],
    ['telegram', 'VARCHAR(255)'],
    ['discord', 'VARCHAR(255)'],
    ['github', 'VARCHAR(255)'],
    ['x', 'VARCHAR(255)'],
    ['is_in_waitlist', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['waitlist_submitted_at', 'TIMESTAMPTZ'],
    ['waitlist_ip', 'VARCHAR(45)'],
    ['waitlist_answers', 'JSONB'],
    ['referrer', 'VARCHAR(255)'],
    ['referrer_handle', 'VARCHAR(255)'],
    ['country', 'VARCHAR(255)'],
    ['city', 'VARCHAR(255)'],
    ['device_info', 'JSONB'],
    ['exclude_podium', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['accept_logs', 'BOOLEAN NOT NULL DEFAULT TRUE'],
    ['updated_at', 'TIMESTAMPTZ'],
  ];
  for (const [name, type] of cols) {
    const re = new RegExp(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS ${name}\\s+${type.replace(/[()]/g, '\\$&')};`
    );
    assert.match(block, re, `users.${name} ${type}`);
  }
  assert.equal(cols.length, 22, 'all 22 SPEC §8.5 columns are covered');
});

test('dropped source columns are NOT carried over', () => {
  // SPEC §8.5: users.name (superseded by display_name), email_verified_at
  // (superseded by email_confirmed_at), remember_token.
  assert.ok(!/ADD COLUMN IF NOT EXISTS name\b/.test(block));
  assert.ok(!/email_verified_at/.test(block));
  assert.ok(!/remember_token/.test(block));
});

test('users.email gets a PARTIAL unique index (existing platform users have none)', () => {
  assert.match(block,
    /CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users\(email\) WHERE email IS NOT NULL;/);
});

test('the six plain users indexes from SPEC §8.5 exist', () => {
  for (const col of ['is_in_waitlist', 'exclude_podium', 'email_confirmation_token', 'telegram', 'discord', 'country']) {
    assert.match(block, new RegExp(`CREATE INDEX IF NOT EXISTS idx_users_${col} ON users\\(${col}\\);`),
      `plain index on users.${col}`);
  }
});

// ─── platform_settings ──────────────────────────────────────────────

test('platform_settings gains a description column, idempotently', () => {
  assert.match(block, /ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS description TEXT;/);
});

test('the seven topochain_* settings keys are seeded with exact values and ON CONFLICT DO NOTHING', () => {
  const insertStart = block.indexOf('INSERT INTO platform_settings');
  assert.ok(insertStart > 0, 'the settings seed INSERT exists');
  const insertEnd = block.indexOf('ON CONFLICT (key) DO NOTHING;', insertStart);
  assert.ok(insertEnd > insertStart, 'the seed INSERT is guarded by ON CONFLICT DO NOTHING');
  const seed = block.slice(insertStart, insertEnd);

  const expected = {
    topochain_first_block_points: '250',
    topochain_produced_half_blocks_points: '0',
    topochain_top_1_points: '1500',
    topochain_top_2_points: '1000',
    topochain_top_3_points: '500',
    topochain_success_50_percent_points: '1000',
    topochain_inviting_new_participant_points: '0',
  };
  const keys = Object.keys(expected);
  assert.equal(keys.length, 7, 'exactly seven topochain_* keys are seeded');
  for (const key of keys) {
    const re = new RegExp(`\\('${key}',\\s*'${expected[key]}',`);
    assert.match(seed, re, `${key} = ${expected[key]}`);
  }
  // Every prefixed key gets a non-empty description (SPEC §3.5 wants each
  // documented) — check no key sits directly next to a closing paren
  // with an empty/missing description string.
  for (const key of keys) {
    const at = seed.indexOf(`'${key}'`);
    // The last row has no trailing comma before ON CONFLICT, so look for
    // either row terminator and fall back to the end of the seed text.
    const commaEnd = seed.indexOf('),', at);
    const clauseEnd = commaEnd >= 0 ? commaEnd + 2 : seed.length;
    const clause = seed.slice(at, clauseEnd);
    assert.match(clause, /'[^']{10,}'\)/, `${key} has a non-trivial description`);
  }
});

test('bug_report_points and community_contribution_points are NOT settings keys', () => {
  // Documented interpretation call: these are per-activity columns already
  // on leaderboard_snapshots (Task 1), not flat configured point values,
  // so they must not appear as topochain_* settings keys here.
  assert.ok(!/topochain_bug_report_points/.test(block));
  assert.ok(!/topochain_community_contribution_points/.test(block));
});

// ─── Staging privacy: table-level ───────────────────────────────────

test('every SPEC §6 "truncated in staging" table plus mobile_auth_tokens and user_terms_consents is tagged staging:private', () => {
  for (const t of [
    'token_allocation', 'chains', 'vrf_obligations', 'slot_outcome_reports',
    'mobile_logs', 'mobile_otp_codes', 'mobile_auth_tokens', 'user_terms_consents',
  ]) {
    assert.match(block, new RegExp(`COMMENT ON TABLE ${t}\\s+IS 'staging:private';`),
      `${t} must be tagged staging:private`);
  }
});

test('exactly eight new table-level staging:private tags were added in this block', () => {
  const matches = block.match(/COMMENT ON TABLE \w+\s+IS 'staging:private';/g) || [];
  assert.equal(matches.length, 8);
});

// ─── Staging privacy: column-level ──────────────────────────────────

test('the four SPEC §6 scrubbed columns are tagged staging:private', () => {
  for (const [table, column] of [
    ['users', 'email_confirmation_token'],
    ['users', 'waitlist_ip'],
    ['onchain_accounts', 'secret_key'],
    ['onchain_accounts', 'registration_code'],
  ]) {
    assert.match(block, new RegExp(`COMMENT ON COLUMN ${table}\\.${column}\\s+IS 'staging:private';`),
      `${table}.${column} must be tagged staging:private`);
  }
});

test('users.password is not re-tagged here (already staging:private earlier in schema.sql)', () => {
  assert.ok(!block.includes("COMMENT ON COLUMN users.password"),
    'the Task 2 block must not duplicate the existing users.password tag');
  assert.match(schema, /COMMENT ON COLUMN users\.password\s+IS 'staging:private';/,
    'the pre-existing tag from Task 0 platform schema is still present');
});

// ─── debug-access.js deny lists ─────────────────────────────────────

test('mobile_otp_codes and mobile_auth_tokens are fully denied to the debug role', () => {
  assert.ok(debugAccess.DENIED_TABLES.has('mobile_otp_codes'));
  assert.ok(debugAccess.DENIED_TABLES.has('mobile_auth_tokens'));
});

test('the four scrubbed columns are denied to the debug role by column', () => {
  assert.ok(debugAccess.DENIED_COLUMNS.users.includes('email_confirmation_token'));
  assert.ok(debugAccess.DENIED_COLUMNS.users.includes('waitlist_ip'));
  assert.ok(Array.isArray(debugAccess.DENIED_COLUMNS.onchain_accounts));
  assert.deepEqual(
    debugAccess.DENIED_COLUMNS.onchain_accounts.slice().sort(),
    ['registration_code', 'secret_key']
  );
});

test('every table-level staging:private tag added in this block is either fully denied or a table the debugger legitimately still needs', () => {
  // Sanity check on the deliberate asymmetry documented in
  // debug-access.js: token_allocation/chains/vrf_obligations/
  // slot_outcome_reports/mobile_logs are staging:private (truncated in
  // staging clones) but NOT in DENIED_TABLES — only the two credential-
  // shaped ones (mobile_otp_codes, mobile_auth_tokens) are fully denied.
  const tableTagged = [...block.matchAll(/COMMENT ON TABLE (\w+)\s+IS 'staging:private';/g)].map((m) => m[1]);
  const mustBeFullyDenied = ['mobile_otp_codes', 'mobile_auth_tokens'];
  for (const t of mustBeFullyDenied) {
    assert.ok(tableTagged.includes(t) && debugAccess.DENIED_TABLES.has(t), `${t} tagged and denied`);
  }
  const notNecessarilyDenied = tableTagged.filter((t) => !mustBeFullyDenied.includes(t));
  assert.equal(notNecessarilyDenied.length, 6);
});
