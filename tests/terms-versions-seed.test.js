'use strict';

// seedTermsVersions (src/db/migrate.js, #6043): how a new terms-of-service
// revision is published. Nothing else writes terms_versions in production,
// so this pins that each entry is inserted once, keyed on its version, and
// links to the full text on the website. No live Postgres: a mock pool
// records the queries.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { seedTermsVersions, TERMS_VERSIONS } = require('../src/db/migrate');

function mockPool() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  };
}

test('the 29 Oct 2026 terms are a published version linking to the website', () => {
  const v = TERMS_VERSIONS.find((e) => e.version === '1.0-2026-10-29');
  assert.ok(v, 'the 1.0 version is listed');
  assert.equal(v.link, 'https://onhomeroom.com/legal/terms-of-service');
  assert.equal(v.publishedAt, '2026-10-29T00:00:00Z');
  assert.ok(v.title);
});

test('every version is unique, so the insert can key on it', () => {
  const versions = TERMS_VERSIONS.map((e) => e.version);
  assert.equal(new Set(versions).size, versions.length);
});

test('each version is inserted once, idempotent on reboot', async () => {
  const pool = mockPool();
  await seedTermsVersions(pool);
  assert.equal(pool.calls.length, TERMS_VERSIONS.length);
  for (const [i, call] of pool.calls.entries()) {
    const v = TERMS_VERSIONS[i];
    assert.match(call.sql, /INSERT INTO terms_versions/);
    assert.match(call.sql, /ON CONFLICT \(version\) DO NOTHING/);
    const [version, title, body, link, publishedAt] = call.params;
    assert.equal(version, v.version);
    assert.equal(title, v.title);
    assert.equal(link, v.link);
    assert.equal(publishedAt, v.publishedAt);
    // The body names the revision and points at the full text rather than
    // carrying a second copy of it.
    assert.ok(body.includes(v.version));
    assert.ok(body.includes(v.link));
  }
});
