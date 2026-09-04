// `migrateWaitlistCountryCodes` in src/db/migrate.js — the one-time rewrite
// that namespaces the retired waitlist region pseudo-codes.
//
// WHY THIS FILE EXISTS. #1527 replaced the region-bucketed country picker
// with the complete ISO 3166-1 list. Five buckets ended in an "Elsewhere in
// <region>" option that stored `EU`, `LA`, `AF`, `ME` or `AP`, and three of
// those five are REAL codes in the new list: LA is Laos, AF is Afghanistan,
// ME is Montenegro. A stored `LA` is therefore ambiguous the moment the new
// picker ships, which is what this migration exists to prevent.
//
// Two properties matter and neither is visible in a rendered screen:
//
//   1. It runs EXACTLY ONCE. It is called from `migrate()`, which runs on
//      every boot. Re-running it after a real Laos signup would rewrite that
//      person's answer to "elsewhere in Latin America" — silently, and with
//      no way to tell the two apart afterwards. A platform_settings marker
//      guards it, and the guard has to short-circuit BEFORE the UPDATE.
//   2. It touches only `waitlist_signups.answers`. `users.country` and
//      `users.waitlist_answers` are deliberately out of scope.
//
// Same two layers as tests/topochain-staging-seed.test.js: the real function
// against a mock pool that records every query, plus static assertions over
// the SQL text. No live Postgres.
//
// Run with: node --test tests/waitlist-country-migration.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { migrateWaitlistCountryCodes } = require('../src/db/migrate');
const { LEGACY_REGION_LABELS } = require('../src/services/countries');

const src = fs.readFileSync(path.join(__dirname, '..', 'src/db/migrate.js'), 'utf8');

// `markerRows` is what the guard SELECT returns: [] on a fresh database,
// [{}] once the migration has run.
function mockPool({ markerRows = [], rowCount = 0, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (fail && fail.test(sql)) throw new Error('boom');
      if (/FROM platform_settings/.test(sql)) return { rows: markerRows };
      return { rows: [], rowCount };
    },
  };
}

const updates = (pool) => pool.calls.filter((c) => /^\s*UPDATE/.test(c.sql));

// ─── 1. Behaviour ─────────────────────────────────────────────────────

test('on a fresh database it rewrites the five codes and records the marker', async () => {
  const pool = mockPool({ rowCount: 3 });
  await migrateWaitlistCountryCodes(pool);

  assert.equal(pool.calls.length, 3, 'guard SELECT, one UPDATE, marker INSERT');
  assert.match(pool.calls[0].sql, /SELECT 1 FROM platform_settings/);
  assert.match(pool.calls[0].sql, /waitlist_country_iso_migrated/);

  const [update] = updates(pool);
  assert.ok(update, 'the rewrite ran');
  assert.match(update.sql, /UPDATE waitlist_signups/);
  for (const code of ['EU', 'LA', 'AF', 'ME', 'AP']) {
    assert.match(update.sql, new RegExp(`'${code}'`), `${code} is remapped`);
  }

  assert.match(pool.calls[2].sql, /INSERT INTO platform_settings/);
  assert.match(pool.calls[2].sql, /waitlist_country_iso_migrated/);
  assert.match(pool.calls[2].sql, /ON CONFLICT \(key\) DO NOTHING/);
});

test('a second run is a no-op: the marker short-circuits before any UPDATE', async () => {
  const pool = mockPool({ markerRows: [{ '?column?': 1 }] });
  await migrateWaitlistCountryCodes(pool);

  assert.equal(pool.calls.length, 1, 'only the guard SELECT is issued');
  assert.equal(updates(pool).length, 0,
    'a genuine LA (Laos) signup must never be rewritten by a later boot');
});

test('a failure is logged and swallowed, never thrown into boot', async () => {
  // migrate() runs this on every start; a broken rewrite must not take the
  // platform down, and the unset marker means the next boot retries.
  const pool = mockPool({ fail: /UPDATE waitlist_signups/ });
  await assert.doesNotReject(() => migrateWaitlistCountryCodes(pool));
  assert.equal(pool.calls.filter((c) => /INSERT INTO platform_settings/.test(c.sql)).length, 0,
    'the marker is not written when the rewrite failed');
});

// ─── 2. The SQL itself ────────────────────────────────────────────────

const BLOCK = (() => {
  const start = src.indexOf('async function migrateWaitlistCountryCodes(pool)');
  assert.ok(start > 0, 'the migration is still in migrate.js');
  return src.slice(start, src.indexOf('\nasync function', start + 10));
})();

test('the rewrite prefixes rather than reinterprets, and only where a country exists', () => {
  assert.match(BLOCK, /jsonb_set\(answers, '\{country\}'/, 'only the country key is replaced');
  assert.match(BLOCK, /to_jsonb\('X-' \|\| \(answers->>'country'\)\)/,
    'the stored value is namespaced, not swapped for some other country');
  assert.match(BLOCK, /answers \? 'country'/,
    'rows with no country (or NULL answers) are left alone');
});

test('the migration stays inside waitlist_signups', () => {
  assert.ok(!/users\.country|waitlist_answers|UPDATE users/.test(BLOCK),
    'users.country and users.waitlist_answers are out of scope');
  assert.equal((BLOCK.match(/UPDATE /g) || []).length, 1, 'exactly one UPDATE');
});

test('every namespaced value it can produce has a label on the admin screen', () => {
  // The migration and countries.js are the two halves of one decision: a
  // value written here with no label there renders as a bare `X-ME`.
  for (const code of ['EU', 'LA', 'AF', 'ME', 'AP']) {
    assert.ok(`X-${code}` in LEGACY_REGION_LABELS, `X-${code} has a label`);
  }
  assert.equal(Object.keys(LEGACY_REGION_LABELS).length, 5);
});

test('it is wired into migrate(), so it actually runs on boot', () => {
  assert.match(src, /^\s*await migrateWaitlistCountryCodes\(pool\);$/m);
});
