// Query + caching contract for src/services/model-stats.js (#800).
//
// The aggregate is a sequential scan over chat_session_messages that runs
// behind GET /api/models (hit on every dev-chat load), so two properties
// matter and neither is visible from the display math:
//
//   1. The SQL asks the question the spec defines — assistant rows only,
//      issue-linked sessions only, inside the 90-day window, success =
//      merged_at, one row per session via DISTINCT ON dominant-tier
//      attribution. Widening any of these silently turns the number into
//      a different (and misleading) metric.
//   2. Repeat callers inside the TTL hit the cache instead of the DB.
//
// Run with: node --test tests/model-stats-query.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const stats = require('../src/services/model-stats');

const SQL = stats.STATS_SQL;

test('only assistant rows with a recorded model feed the aggregate', () => {
  assert.match(SQL, /m\.role\s*=\s*'assistant'/);
  assert.match(SQL, /m\.model IS NOT NULL/);
});

test('the denominator is issue-linked sessions only', () => {
  assert.match(SQL, /array_length\(s\.linked_issues,\s*1\)\s*>\s*0/);
  assert.match(SQL, /s\.created_from_issue_number IS NOT NULL/);
  assert.match(SQL, /s\.headless_issue_number IS NOT NULL/);
});

test('success is a merged PR', () => {
  assert.match(SQL, /FILTER \(WHERE merged_at IS NOT NULL\)/);
});

test('the aggregate is windowed to WINDOW_DAYS', () => {
  assert.equal(stats.WINDOW_DAYS, 90);
  assert.match(SQL, /NOW\(\) - INTERVAL '90 days'/);
});

test('sessions are attributed to one dominant tier, most-recent as tiebreak', () => {
  assert.match(SQL, /DISTINCT ON \(session_id\)/);
  assert.match(SQL, /ORDER BY session_id, msg_count DESC, last_msg_id DESC/);
});

test('previous-generation ids are folded into tiers inside the query', () => {
  for (const tier of ['haiku', 'sonnet', 'opus', 'fable']) {
    assert.match(SQL, new RegExp(`ILIKE '%${tier}%'`), `missing ${tier} alias`);
  }
});

test('rows with no recognised tier are dropped, not bucketed', () => {
  assert.match(SQL, /WHERE tier IS NOT NULL/);
});

test('repeat calls inside the TTL are served from cache', async () => {
  stats._resetCacheForTests();
  let calls = 0;
  const pool = {
    query: async () => {
      calls += 1;
      return { rows: [{ tier: 'opus', attempts: 312, solved: 149 }] };
    },
  };

  const first = await stats.statsForModels(pool);
  const second = await stats.statsForModels(pool);

  assert.equal(calls, 1, 'second call must not re-query');
  assert.equal(second, first, 'cached call returns the same object');
  assert.ok(stats.CACHE_TTL_MS >= 60_000, 'TTL should be minutes, not seconds');
  stats._resetCacheForTests();
});

test('a failed aggregate is cached too, so a broken DB is not hammered', async () => {
  stats._resetCacheForTests();
  let calls = 0;
  const pool = {
    query: async () => { calls += 1; throw new Error('down'); },
  };

  assert.equal(await stats.statsForModels(pool), null);
  assert.equal(await stats.statsForModels(pool), null);
  assert.equal(calls, 1);
  stats._resetCacheForTests();
});
