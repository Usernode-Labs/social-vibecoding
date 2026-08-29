// src/services/leaderboard-users.js — the RANKED-USERS query, extracted so
// the Leaderboard screen's "Top users" tab and the home screen's Challenges
// widget rank people the same way (#947). A widget that says "#12" while the
// tab says "#14" is a bug with no obvious owner, and two copies of a 5-key
// ORDER BY are exactly how that happens.
//
// What this file guards:
//
//   1. The DEFAULT (non-slim) statement is the one the endpoint always ran —
//      same SELECT list, same joins, same LATERAL bodies, same ORDER BY. The
//      endpoint's own suites (leaderboard-users-fields / -issues) assert on
//      that SQL text and must keep passing unchanged; this asserts the shape
//      from the service side.
//   2. `slim` drops ONLY display-only columns. None of them appears in the
//      ORDER BY, so a slim call must rank identically — that is the whole
//      licence for using it in the widget.
//   3. The window/limit params are wired to the same placeholders.
//
// No live DB: a mock pool captures the SQL and the params.
//
// Run with: node --test tests/leaderboard-users-service.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { rankedUsers, weekStartUtc } = require('../src/services/leaderboard-users');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function makeMockPool(rows = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      return { rows };
    },
  };
}

// The statement's OWN ORDER BY, as one string, so both modes can be compared
// against it. lastIndexOf, not indexOf: the active_apps LATERAL carries an
// inner `ORDER BY ap.name, ap.slug` inside its jsonb_agg.
function orderBy(sql) {
  const at = sql.lastIndexOf('ORDER BY');
  assert.ok(at > -1, 'the statement is ordered');
  return sql.slice(at).replace(/\s+/g, ' ').trim();
}

test('the default statement carries every column the endpoint publishes', async () => {
  const pool = makeMockPool();
  await rankedUsers(pool, {});
  const { sql, params } = pool.calls[0];
  for (const alias of [
    'user_id', 'username', 'kudos_received', 'prs_kudosed',
    'kudos_received_prs_merged', 'kudos_received_prs_unmerged', 'prs_merged',
    'last_kudos_at', 'kudos_given', 'issues_created', 'address', 'active_apps',
  ]) {
    assert.ok(sql.includes(alias), `${alias} is selected`);
  }
  // No window, no limit → no params at all.
  assert.deepEqual(params, []);
  assert.ok(!sql.includes('LIMIT $'), 'unlimited by default');
});

test('the privacy and activity guards live in the SQL, not in a caller', async () => {
  const pool = makeMockPool();
  await rankedUsers(pool, {});
  const { sql } = pool.calls[0];
  // Sessions and bounties count only on view-public apps.
  assert.match(sql, /ap\.id = cs\.app_id AND ap\.view_visibility = 'public'/);
  assert.match(sql, /ap\.id = ib\.app_id AND ap\.view_visibility = 'public'/);
  assert.match(sql, /ap\.id = i\.app_id AND ap\.view_visibility = 'public'/);
  // active_apps keeps its activity guards and its deliberate lack of a
  // view_visibility filter (see the LATERAL's own comment).
  assert.match(sql, /ap\.self_hosted = FALSE/);
  assert.match(sql, /r\.date >= CURRENT_DATE - 10/);
  assert.match(sql, /q\.seconds_spent >= 60/);
});

test('slim drops the three display-only LATERALs and NOTHING else', async () => {
  const full = makeMockPool();
  await rankedUsers(full, {});
  const slim = makeMockPool();
  await rankedUsers(slim, { slim: true });

  const fullSql = full.calls[0].sql;
  const slimSql = slim.calls[0].sql;

  for (const gone of ['kudos_given', 'issues_created', 'active_apps']) {
    assert.ok(fullSql.includes(gone), `${gone} present in the full query`);
    assert.ok(!slimSql.includes(gone), `${gone} dropped in slim`);
  }
  // Everything the ORDER BY reads survives — which is why the ranking can't
  // move. The awarded-bounty LATERAL feeds kudos_received_prs_merged, so it
  // is emphatically NOT display-only.
  for (const kept of [
    'kudos_received_prs_merged', 'prs_merged', 'kudos_received',
    'last_kudos_at', 'issue_bounties', 'ab ON true',
  ]) {
    assert.ok(slimSql.includes(kept), `${kept} kept in slim`);
  }
  assert.equal(orderBy(slimSql), orderBy(fullSql), 'identical ranking');
});

test('the ORDER BY is the documented five-key ranking', async () => {
  const pool = makeMockPool();
  await rankedUsers(pool, {});
  assert.equal(
    orderBy(pool.calls[0].sql),
    'ORDER BY kudos_received_prs_merged DESC, prs_merged DESC, '
    + 'kudos_received DESC, last_kudos_at DESC NULLS LAST, u.username ASC'
  );
});

test('window=week scopes all four aggregates to ONE week_start param', async () => {
  const pool = makeMockPool();
  await rankedUsers(pool, { window: 'week', weekStart: '2026-08-03' });
  const { sql, params } = pool.calls[0];
  assert.deepEqual(params, ['2026-08-03']);
  // Kudos, given-kudos, bounties and issues all reuse $1.
  assert.match(sql, /AND pk\.week_start = \$1/);
  assert.match(sql, /AND gk\.week_start = \$1/);
  assert.match(sql, /ib\.awarded_at AT TIME ZONE 'UTC'\)::date = \$1/);
  assert.match(sql, /i\.created_at AT TIME ZONE 'UTC'\)::date = \$1/);
});

test('limit lands after the window param, never interpolated', async () => {
  const all = makeMockPool();
  await rankedUsers(all, { limit: 20 });
  assert.deepEqual(all.calls[0].params, [20]);
  assert.match(all.calls[0].sql, /LIMIT \$1/);

  const week = makeMockPool();
  await rankedUsers(week, { window: 'week', weekStart: '2026-08-03', limit: 5 });
  assert.deepEqual(week.calls[0].params, ['2026-08-03', 5]);
  assert.match(week.calls[0].sql, /LIMIT \$2/);
});

test('weekStartUtc buckets to Monday 00:00 UTC', () => {
  // 2026-08-05 is a Wednesday → the Monday before it.
  assert.equal(weekStartUtc(new Date('2026-08-05T12:34:56Z')), '2026-08-03');
  // A Monday is its own bucket; a Sunday belongs to the Monday before.
  assert.equal(weekStartUtc(new Date('2026-08-03T00:00:00Z')), '2026-08-03');
  assert.equal(weekStartUtc(new Date('2026-08-09T23:59:59Z')), '2026-08-03');
});

// The extraction only pays off if the route actually calls it — an inlined
// copy left behind in kudos.js would drift silently.
test('the endpoint goes through the service', () => {
  const kudos = read('src/routes/kudos.js');
  assert.match(kudos, /require\('\.\.\/services\/leaderboard-users'\)/);
  assert.match(kudos, /await rankedUsers\(pool, \{/);
  // No second copy of the ranking left in the route.
  assert.ok(!kudos.includes('kudos_received_prs_merged DESC'),
    'the ORDER BY lives in the service only');

  // THE HOME PANEL WAS THE SECOND CONSUMER and is not one any more. Its
  // challenges block drew a standings preview under the challenge rows, on
  // this service's slim ranking as the fallback board; the preview is removed
  // — one area, one list — so the route asks for challenges and nothing else.
  const panels = read('src/routes/home-panels.js');
  assert.doesNotMatch(panels, /require\('\.\.\/services\/leaderboard-users'\)/,
    'the home panels no longer rank users at all');
  assert.doesNotMatch(panels, /rankedUsers\(/);

  // weekStartUtc moved with it, and is re-exported so existing importers
  // (src/routes/issues.js) are untouched.
  assert.match(kudos, /module\.exports = \{[\s\S]*?weekStartUtc/);
  assert.match(read('src/routes/issues.js'), /weekStartUtc[\s\S]*?require\('\.\/kudos'\)/);
});
