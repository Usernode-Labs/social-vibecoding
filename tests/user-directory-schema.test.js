// #1213 — the user directory's handle-match indexes and staging fixtures.
//
// Every lookup runs `LOWER(username) = LOWER($1)` and every typeahead
// keystroke runs `LOWER(username) LIKE '<prefix>%' … ORDER BY
// LOWER(username)`, across three surfaces (the app-platform API, the
// shell's bridge relay, the collaborator-invite typeahead). Before #1213
// both were sequential scans — schema.sql indexed users(email) and
// friends but nothing on LOWER(username), while the comment in
// services/user-directory.js claimed the prefix form "uses the index".
// These are static assertions that the two expression indexes exist (and
// stay idempotent, like every neighbouring index), that the service
// comment now points at the real index, and that the staging fixtures a
// preview needs to demonstrate the directory are seeded.
//
// Static assertions on the SQL/JS source — no database required.
//
// Run with: node --test tests/user-directory-schema.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'src/db/schema.sql'), 'utf8');
const migrate = fs.readFileSync(path.join(root, 'src/db/migrate.js'), 'utf8');
const service = fs.readFileSync(path.join(root, 'src/services/user-directory.js'), 'utf8');

// ─── The two expression indexes ───────────────────────────────────

test('LOWER(username) equality/ordering index exists and is idempotent', () => {
  assert.match(
    schema,
    /CREATE INDEX IF NOT EXISTS idx_users_username_lower ON users \(LOWER\(username\)\);/,
    'the default-opclass index serves lookupExact equality and searchPrefix ORDER BY'
  );
});

test('LOWER(username) text_pattern_ops index exists for LIKE prefix ranges', () => {
  assert.match(
    schema,
    /CREATE INDEX IF NOT EXISTS idx_users_username_lower_pattern ON users \(LOWER\(username\) text_pattern_ops\);/,
    'under a non-C collation the default opclass cannot serve LIKE — text_pattern_ops can'
  );
});

test('the service comment names the real index instead of asserting one exists', () => {
  // The pre-#1213 comment claimed "LIKE \'q%\' uses the index" while no
  // such index existed. Tie the comment to the index name so the claim
  // can only be made while the schema actually backs it.
  assert.match(service, /idx_users_username_lower_pattern/);
});

// ─── Staging directory fixtures (deterministic preview handles) ────

test('the prefix cluster is big enough to truncate at the DEFAULT limit', () => {
  // searchPrefix defaults to limit 10; has_more on the untouched-limit
  // path is only demonstrable with more than 10 rows on one stem.
  const stem = migrate.match(/'staging-demo-car[a-z-]*'/g) || [];
  assert.ok(
    new Set(stem).size >= 12,
    `need at least 12 staging-demo-car* handles, found ${new Set(stem).size}`
  );
});

test('the case-collision pair and the LIKE-metacharacter handle are seeded', () => {
  assert.match(migrate, /'staging-demo-Nova'/, 'ambiguous: true needs a real collision');
  assert.match(migrate, /'staging-demo-nova'/);
  assert.match(migrate, /'staging-demo-a_b_test'/, 'the escapeLike path needs a _ handle');
});
