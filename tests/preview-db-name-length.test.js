'use strict';

// Postgres keeps the first 63 bytes of an identifier and drops the rest
// without an error. On 22 Oct 2026 a 43-character slug made every preview
// attempt of session 10542 the database
// `app_workquest_escape_from_the_underclass_831ec5_staging_s10542_` (its
// 69-character names lost their tag), so each retirement of the attempt
// before dropped the one that had just started serving, and the preview was
// rebuilt every 2 minutes for two days. Pinned here:
//   - an attempt's database is at most 57 bytes and its `_owner` role at
//     most 63, for the longest slug a new app gets and a seven-digit session,
//     with its session and tag whole and its name still a staging clone's;
//   - names that already fit are what they were;
//   - db-manager acts on no name longer than 63: a create or a connection
//     refuses it, and a drop or a lookup leaves it alone without asking a
//     retirement to try again.
//
// Run with: node --test tests/preview-db-name-length.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { attemptDb } = require('../src/workflow/preview/machine.ts');
const dbManager = require('../src/services/db-manager');

const LONGEST_SLUG = 'a-fifty-character-slug-for-the-longest-name-831ec5';
// staging-reap's orphan sweep reads the session id and tag back out.
const ORPHAN_SWEEP_RE = /^app_[a-z0-9_]+_staging_s(\d+)_([0-9a-f]{6}|latest)$/;

test('an attempt\'s database and its role fit, whole session and tag included', () => {
  assert.equal(LONGEST_SLUG.length, 50);
  for (const [slug, sessionId] of [[LONGEST_SLUG, 1234567], ['workquest-escape-from-the-underclass-831ec5', 10542]]) {
    const names = [1, 2, 3].flatMap((n) => [1, 2, 3].map((claim) => attemptDb(slug, sessionId, 99, n, claim)));
    assert.equal(new Set(names).size, names.length, 'every attempt and claim its own database');
    for (const db of names) {
      assert.ok(db.length <= 57, `${db} is ${db.length} bytes`);
      assert.ok(dbManager.ownerRoleName(db).length <= 63);
      assert.equal(dbManager.ownerRoleName(db), `${db}_owner`, 'the role is its whole name');
      assert.equal(dbManager.isStagingCloneDb(db), true);
      assert.equal(Number(db.match(ORPHAN_SWEEP_RE)[1]), sessionId);
    }
  }
});

test('a name that already fits is what it was', () => {
  const db = attemptDb('number-guessing-game-6ba53e', 9462, 5, 2);
  assert.match(db, /^app_number_guessing_game_6ba53e_staging_s9462_[0-9a-f]{6}$/);
});

test('a role is named as Postgres stores it', () => {
  // A 61-byte clone made before names were kept to 57: its role is the
  // first 63 bytes, which Postgres had stored all along.
  const db = 'app_bay_area_restaurant_tier_list_6f1cf0_staging_s8116_72acc6';
  assert.equal(dbManager.ownerRoleName(db), `${db}_o`);
});

test('no name past 63 bytes is created, connected to, dropped or found', async () => {
  const overlong = 'app_workquest_escape_from_the_underclass_831ec5_staging_s10542_4e8919';
  assert.equal(overlong.length, 69);
  await assert.rejects(dbManager.createDatabase(overlong), /unsafe dbName/);
  assert.throws(() => dbManager.connectionUrl(overlong, 'x'.repeat(48)), /unsafe dbName/);
  // Left alone even when strict, without a statement: the executor would
  // throw if it were asked anything.
  const execute = async () => { throw new Error('asked to drop an over-long name'); };
  await dbManager.dropDatabase(overlong, { strict: true, execute });
  assert.equal(await dbManager.databaseExists(overlong, { strict: true }), false);
  // Anything else unsafe is still refused as it was.
  await assert.rejects(dbManager.dropDatabase('app_x; DROP', { strict: true, execute }), /unsafe database name/);
});
