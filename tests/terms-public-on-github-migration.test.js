// `publishTermsPublicOnGithub` in src/db/migrate.js — the one-time
// publication of the terms version that carries the public-on-GitHub
// clause.
//
// WHY THIS FILE EXISTS. #4384 moved the "public on GitHub" line off the
// make screen and into Homeroom's terms. The terms text lives in the
// database (`terms_versions`), not in the repository, so the migration
// appends the clause to the latest published version at run time and
// publishes it as a new version. The app only tells people the terms
// changed when a new version is published (`getTermsGate` orders by
// published_at DESC, id DESC), so appending without a version bump would
// go unnoticed.
//
// Three properties matter and none is visible in a rendered screen:
//
//   1. It runs EXACTLY ONCE. `migrate()` calls it on every boot, and a
//      platform_settings marker guards it. The guard is what makes it
//      one-time rather than merely idempotent: an admin who later
//      publishes terms without the clause must not get a copy with the
//      clause appended on the next boot.
//   2. Staging never publishes it. `seedStagingTopochain` consents every
//      cloned user to `staging-demo-v1`; a newer version would put the
//      "We updated our terms" toast on every preview screen.
//   3. A failure never aborts boot. `migrate()` runs this before the
//      platform accepts traffic.
//
// Same two layers as tests/waitlist-country-migration.test.js: the real
// function against a mock pool that records every query, plus static
// assertions over the SQL text. No live Postgres.
//
// Run with: node --test tests/terms-public-on-github-migration.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { publishTermsPublicOnGithub } = require('../src/db/migrate');

const src = fs.readFileSync(path.join(__dirname, '..', 'src/db/migrate.js'), 'utf8');

const CLAUSE = 'Projects you make here, including their description and code, are public on GitHub.';

// `markerRows` is what the guard SELECT returns: [] on a fresh database,
// [{}] once the migration has run. `rowCount` is what the terms INSERT
// reports: 1 when a row was inserted, 0 when the clause was already there
// or no terms have been published.
function mockPool({ markerRows = [], rowCount = 1, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (fail && fail.test(sql)) throw new Error('boom');
      if (/SELECT 1 FROM platform_settings/.test(sql)) return { rows: markerRows };
      return { rows: [], rowCount };
    },
  };
}

const inserts = (pool) => pool.calls.filter((c) => /^\s*(WITH latest|INSERT INTO)/m.test(c.sql));

// ─── 1. Behaviour ─────────────────────────────────────────────────────

test('on a fresh database it publishes the new version and records the marker', async () => {
  const pool = mockPool({ rowCount: 1 });
  await publishTermsPublicOnGithub(pool);

  assert.equal(pool.calls.length, 3, 'guard SELECT, terms INSERT, marker INSERT');

  const [terms] = inserts(pool);
  assert.ok(terms, 'the publish ran');
  assert.match(terms.sql, /INSERT INTO terms_versions/);
  // The clause is a parameter, not baked into the SQL text.
  assert.ok(Array.isArray(terms.params), 'the terms INSERT is parameterised');
  assert.ok(terms.params.includes(CLAUSE), 'the clause is passed as a parameter');

  const marker = pool.calls[2];
  assert.match(marker.sql, /INSERT INTO platform_settings/);
  assert.match(marker.sql, /terms_public_on_github_published/);
  assert.match(marker.sql, /ON CONFLICT \(key\) DO NOTHING/);
});

test('a body that already holds the clause still records the marker, and inserts nothing', async () => {
  const pool = mockPool({ rowCount: 0 });
  await publishTermsPublicOnGithub(pool);

  assert.equal(pool.calls.length, 3, 'guard SELECT, terms INSERT (inserting 0 rows), marker INSERT');
  const [terms] = inserts(pool);
  assert.match(terms.sql, /INSERT INTO terms_versions/);
  assert.match(terms.sql, /ON CONFLICT \(version\) DO NOTHING/);
});

test('a second run is a no-op: the marker short-circuits before any INSERT', async () => {
  const pool = mockPool({ markerRows: [{ '?column?': 1 }] });
  await publishTermsPublicOnGithub(pool);

  assert.equal(pool.calls.length, 1, 'only the guard SELECT is issued');
  assert.equal(inserts(pool).length, 0,
    'terms an admin published without the clause must never be copied with it');
});

test('staging publishes nothing and writes no marker', async () => {
  const had = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  try {
    const pool = mockPool();
    await publishTermsPublicOnGithub(pool);
    assert.equal(pool.calls.length, 0, 'no query runs at all');
  } finally {
    if (had === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = had;
  }
});

test('a failure is logged and swallowed, never thrown into boot', async () => {
  // migrate() runs this on every start; a broken publish must not take the
  // platform down, and the unset marker means the next boot retries.
  const pool = mockPool({ fail: /INSERT INTO terms_versions/ });
  await assert.doesNotReject(() => publishTermsPublicOnGithub(pool));
  assert.equal(pool.calls.filter((c) => /INSERT INTO platform_settings/.test(c.sql)).length, 0,
    'the marker is not written when the publish failed');
});

// ─── 2. The SQL itself ────────────────────────────────────────────────

const BLOCK = (() => {
  const start = src.indexOf('async function publishTermsPublicOnGithub(pool)');
  assert.ok(start > 0, 'the migration is still in migrate.js');
  return src.slice(start, src.indexOf('\nasync function', start + 10));
})();

test('it copies the newest published version, the way the terms gate reads it', () => {
  // The gate (getTermsGate, termsCurrentHandler) picks the current terms
  // with ORDER BY published_at DESC, id DESC; the copy must follow the
  // same rule, or it could build on a superseded revision.
  assert.match(BLOCK, /published_at IS NOT NULL/);
  assert.match(BLOCK, /ORDER BY published_at DESC, id DESC LIMIT 1/);
});

test('it appends the clause as a final paragraph, guarding against a body that already has it', () => {
  assert.match(BLOCK, /rtrim\(body_markdown\) \|\| E'\\n\\n' \|\| \$2/, 'the clause joins the body as its own paragraph');
  assert.match(BLOCK, /WHERE position\(\$2 in body_markdown\) = 0/, 'a body that already holds the clause inserts nothing');
});

test('an existing version string cannot collide: the insert does nothing on conflict', () => {
  assert.match(BLOCK, /ON CONFLICT \(version\) DO NOTHING/);
});

test('it is wired into migrate(), so it actually runs on boot', () => {
  assert.match(src, /^\s*await publishTermsPublicOnGithub\(pool\);$/m);
  const call = src.indexOf('await publishTermsPublicOnGithub(pool)');
  const waitlist = src.indexOf('await migrateWaitlistCountryCodes(pool)');
  assert.ok(call > 0 && waitlist > 0 && call > waitlist,
    'the call sits in the maintenance phase, right after migrateWaitlistCountryCodes');
});