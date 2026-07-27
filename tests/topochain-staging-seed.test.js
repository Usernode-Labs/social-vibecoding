// Topochain staging seed fixtures (plan Task 4): `seedStagingTopochain`
// in src/db/migrate.js.
//
// The topochain block of schema.sql (Task 1) is brand new — none of its
// 22 tables carry a row outside a real topochain data load (Task 16),
// and a handful (`token_allocation`, `user_terms_consents`, the mobile_*
// tables) are additionally `staging:private` at the table level, so a
// staging clone truncates them entirely. Without a seed, every /api/v4
// public/admin/mobile screen built in later tasks has nothing to render
// in a staging preview.
//
// Static, no-database assertions over the SQL text appended to
// src/db/migrate.js — mirrors the style of
// tests/dashboard-spend-distribution.test.js (source-guard section) and
// tests/topochain-schema.test.js (block-isolation via indexOf/slice).
// No live Postgres is required or used.
//
// Run with: node --test tests/topochain-staging-seed.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src/db/migrate.js'), 'utf8');

// Isolate the function body: from its declaration to the next top-level
// `async function`, same slicing idiom as
// tests/dashboard-spend-distribution.test.js.
const fnStart = src.indexOf('async function seedStagingTopochain');
assert.ok(fnStart > 0, 'seedStagingTopochain must be defined in migrate.js');
const nextFnStart = src.indexOf('\nasync function', fnStart + 10);
assert.ok(nextFnStart > fnStart, 'a following function declaration must exist to bound the slice');
const body = src.slice(fnStart, nextFnStart);

// ─── Definition, staging gate, call site ───────────────────────────────

test('seedStagingTopochain is defined with the (pool, config) signature', () => {
  assert.match(src, /async function seedStagingTopochain\(pool, config\)/);
});

test('seedStagingTopochain is a strict no-op outside staging (gate is the first statement)', () => {
  const afterSignature = body.slice(body.indexOf(') {') + 3);
  const firstStatement = afterSignature.split('\n').find((l) => l.trim().length > 0);
  assert.match(firstStatement, /if \(process\.env\.USERNODE_ENV !== 'staging'\) return;/,
    'the staging gate must be the very first statement in the function body');
});

test('migrate() calls seedStagingTopochain(pool, config) inside the staging seed run', () => {
  assert.match(src, /await seedStagingTopochain\(pool, config\);/);
  // It must be called alongside the other seedStaging* calls, before the
  // backfills/sweeps that follow in migrate().
  const migrateStart = src.indexOf('async function migrate(config)');
  const migrateBody = src.slice(migrateStart, src.indexOf('\n}', migrateStart));
  assert.match(migrateBody, /await seedStagingTopochain\(pool, config\);/,
    'the call must live inside migrate(), not just exist somewhere in the file');
});

test('best-effort: the whole seed body is wrapped in try/catch with log.warn on failure', () => {
  assert.match(body, /try\s*\{/);
  assert.match(body, /\} catch \(err\) \{/);
  assert.match(body, /log\.warn\('db', 'Topochain staging fixtures seeding failed'/);
});

// ─── Idempotency: every INSERT is followed by an ON CONFLICT guard ─────

test('every INSERT INTO in the seeder has a matching ON CONFLICT guard (idempotent on reboot)', () => {
  const inserts = body.match(/INSERT INTO \w+/g) || [];
  const conflicts = body.match(/ON CONFLICT \(id\) DO NOTHING/g) || [];
  assert.ok(inserts.length >= 15, `expected a substantial number of INSERT statements, got ${inserts.length}`);
  assert.equal(inserts.length, conflicts.length,
    'every INSERT INTO must be paired with exactly one ON CONFLICT (id) DO NOTHING');
});

test('fixed ids used throughout live in the obviously-fake 900500+ range', () => {
  // Every literal 6-digit numeric id in the body should start with 9005,
  // matching this platform's staging-demo numbering convention.
  const sixDigitIds = body.match(/\b9\d{5}\b/g) || [];
  assert.ok(sixDigitIds.length > 20, 'a substantial number of fixed ids are used');
  for (const id of sixDigitIds) {
    assert.match(id, /^9005\d\d$/, `id ${id} should be in the 900500-900599 staging-demo range`);
  }
});

// ─── Content spot-checks per the brief's fixture list ──────────────────

test('1 season', () => {
  assert.match(body, /INSERT INTO seasons/);
  assert.equal((body.match(/INSERT INTO seasons/g) || []).length, 1);
});

test('2 season_events: one regular with epochs + scoring_formula, one type=\'season\'', () => {
  const start = body.indexOf('INSERT INTO season_events');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  assert.match(block, /'\{"metrics": \[\], "offchain_weight": 1\}'::jsonb/g);
  assert.match(block, /100, 130/, 'the regular event carries a start_epoch/end_epoch range');
  assert.match(block, /'regular'/);
  assert.match(block, /'season'/);
  const scoringFormulaCount = (block.match(/::jsonb/g) || []).length;
  assert.equal(scoringFormulaCount, 2, 'both season_events rows carry a scoring_formula');
});

test('4 challenge_kinds', () => {
  const start = body.indexOf('INSERT INTO challenge_kinds');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  for (const kind of ['REPORT_BUG_CHALLENGE', 'SEND_TRANSACTION_CHALLENGE',
    'SOCIAL_SHARE_CHALLENGE', 'INVITE_PARTICIPANT_CHALLENGE']) {
    assert.match(block, new RegExp(`'${kind}'`));
  }
});

test('5 challenge_templates', () => {
  const start = body.indexOf('INSERT INTO challenge_templates');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  const ids = block.match(/^\s*\(9005\d\d,/gm) || [];
  assert.equal(ids.length, 5);
});

test('8 challenges split across both season_events', () => {
  const start = body.indexOf('INSERT INTO challenges');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  const ids = block.match(/^\s*\(9005\d\d, \$/gm) || [];
  assert.equal(ids.length, 8);
  const regularEventRows = block.match(/\(9005\d\d, \$1,/g) || [];
  const seasonEventRows = block.match(/\(9005\d\d, \$2,/g) || [];
  assert.equal(regularEventRows.length, 5, '5 challenges on the regular event');
  assert.equal(seasonEventRows.length, 3, '3 challenges on the season-type event');
});

test('6 users with emails, one exclude_podium=TRUE, one with a real bcrypt password', () => {
  const start = body.indexOf('INSERT INTO users');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  const usernames = block.match(/staging-demo-topochain-participant-\d/g) || [];
  assert.equal(new Set(usernames).size, 6, '6 distinct fixture usernames');
  const emails = block.match(/staging-demo-topochain-\d@example\.invalid/g) || [];
  assert.equal(new Set(emails).size, 6, '6 distinct fixture emails');
  assert.match(block, /TRUE\)/, 'one row sets exclude_podium TRUE');
  assert.equal((block.match(/, TRUE\)/g) || []).length, 1, 'exactly one exclude_podium=TRUE row');
  assert.match(body, /const realHash = await bcrypt\.hash\(/, 'a real bcrypt hash is computed');
  assert.match(block, /\$7,/, 'the bcrypt hash param is used in place of the sentinel password for one user');
});

test('user_enrollments: a mix of season-wide (NULL event) and event-scoped rows, every row carrying the same season_id', () => {
  const start = body.indexOf('INSERT INTO user_enrollments');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  const rows = block.match(/\(9005\d\d, [^,]+, \$\d, (\$\d), NOW/g) || [];
  assert.ok(rows.length >= 6, 'a substantial number of enrollment rows');
  const seasonIdTokens = new Set(rows.map((r) => r.match(/\$\d, NOW/)[0].split(',')[0].trim()));
  assert.equal(seasonIdTokens.size, 1,
    'every enrollment row must reference the SAME season_id placeholder (the scope invariant, enforced by construction)');
  assert.match(block, /\(\d+, NULL, /, 'at least one season-wide (NULL season_event_id) row');
  assert.ok(/\(\d+, \$\d, \$\d, /.test(block), 'at least one event-scoped row');
});

test('6 onchain_accounts, some assigned/used, some unassigned/unused, with a fake secret_key', () => {
  const start = body.indexOf('INSERT INTO onchain_accounts');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  const ids = block.match(/^\s*\(9005\d\d,/gm) || [];
  assert.equal(ids.length, 6);
  assert.match(block, /sk_staging_demo_fake_/, 'secret_key is an obviously-fake fixture value');
  assert.match(block, /TRUE,\s*\n\s*NOW\(\) - INTERVAL/, 'at least one used account carries used_at');
  assert.match(block, /NULL, FALSE, NULL/, 'at least one unassigned (user_id NULL), unused account');
});

test('user_activities span multiple challenges with the challenge_completion replay-guard metadata', () => {
  const start = body.indexOf('INSERT INTO user_activities');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  const ids = block.match(/^\s*\(9005\d\d,/gm) || [];
  assert.equal(ids.length, 8);
  assert.match(block, /'\{"kind": "challenge_completion"\}'::jsonb/);
  const challengeIds = new Set((block.match(/, (900500|900501|900502|900503|900504|900505|900506|900507)\)/g) || []));
  assert.ok(challengeIds.size >= 6, 'activities reference a variety of distinct challenges');
});

test('epoch_stats: 3 epochs x 3 wallets, including one wallet-only (user_id NULL) row per epoch', () => {
  const start = body.indexOf('INSERT INTO epoch_stats');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  const ids = block.match(/^\s*\(9005\d\d,/gm) || [];
  assert.equal(ids.length, 9);
  for (const epoch of [100, 101, 102]) {
    const count = (block.match(new RegExp(`, ${epoch}, `, 'g')) || []).length;
    assert.equal(count, 3, `epoch ${epoch} must appear once per wallet (3 rows)`);
  }
  assert.equal((block.match(/, NULL, \d+,/g) || []).length, 3, '3 wallet-only rows (user_id NULL)');
});

test('leaderboard_snapshots: 2 snapshot times x 6 users, unique per (user, snapshot_at)', () => {
  const start = body.indexOf('INSERT INTO leaderboard_snapshots');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  const ids = block.match(/^\s*\(9005\d\d,/gm) || [];
  assert.equal(ids.length, 12);
  const earlierRows = (block.match(/EARLIER_SNAPSHOT/g) || []).length;
  const laterRows = (block.match(/LATER_SNAPSHOT/g) || []).length;
  assert.equal(earlierRows, 6);
  assert.equal(laterRows, 6);
  // Every row's season_event_id placeholder is the same token — all 12
  // rows target the single display_leaderboard-flagged regular event.
  const eventTokens = new Set((block.match(/\(9005\d\d, (\$\d),/g) || []).map((m) => m.match(/\$\d/)[0]));
  assert.equal(eventTokens.size, 1, 'every snapshot row targets the same season_event_id');
});

test('1 terms_version + 2 user_terms_consents', () => {
  assert.equal((body.match(/INSERT INTO terms_versions/g) || []).length, 1);
  const start = body.indexOf('INSERT INTO user_terms_consents');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  const ids = block.match(/^\s*\(9005\d\d,/gm) || [];
  assert.equal(ids.length, 2);
});

test('1 app_version_config per OS (ios, android)', () => {
  const start = body.indexOf('INSERT INTO app_version_configs');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  assert.match(block, /'ios'/);
  assert.match(block, /'android'/);
  const ids = block.match(/^\s*\(9005\d\d,/gm) || [];
  assert.equal(ids.length, 2);
});

test('1 account_delegation_period', () => {
  assert.equal((body.match(/INSERT INTO account_delegation_periods/g) || []).length, 1);
});

test('token_allocation for 3 users', () => {
  const start = body.indexOf('INSERT INTO token_allocation');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  const ids = block.match(/^\s*\(9005\d\d,/gm) || [];
  assert.equal(ids.length, 3);
});
