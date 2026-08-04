// Tests for the admin /debug API (routes/debug.js).
//
//   - /api/debug/* is admin-gated: 403 for a non-admin, 200 for a
//     view-only admin AND a full admin (read-only diagnostics).
//   - List filters (app slug, pr_number, session_id, outcome, kind) are
//     wired into the query.
//   - Keyset paging adds the (started_at, id) < (before, before_id) cursor
//     and suppresses the staging demo injection.
//   - Under IS_STAGING + ?demo=1 the mock runs are injected on the first
//     page; without ?demo=1 they are not (and it's a no-op in production).
//
// Run with: node --test tests/debug-route.test.js

// Must be set BEFORE requiring the route — IS_STAGING is read at module load.
process.env.USERNODE_ENV = 'staging';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// Stub the pool: record calls and return canned rows per query.
const poolMod = require('../src/db/pool');
let calls = [];
poolMod.getPool = () => ({
  async query(sql, params) {
    calls.push({ sql, params });
    if (/INSERT INTO merge_debug_runs/.test(sql)) return { rows: [{ id: 1 }] };
    if (/FROM merge_debug_runs r/.test(sql) && /SELECT r\.id/.test(sql) && /LIMIT/.test(sql)) {
      // List query — one real run.
      return { rows: [{
        id: 10, app_id: 3, app_slug: 'realapp', app_name: 'Real App',
        session_id: 55, pr_number: 7, pr_title: 'Real PR', kind: 'merge',
        trigger: 'vote', status: 'merged', summary: 'Merged.',
        started_at: '2026-06-01T00:00:00Z', ended_at: '2026-06-01T00:01:00Z',
        step_count: 4,
      }] };
    }
    if (/FROM merge_debug_runs r/.test(sql) && /WHERE r\.id = \$1/.test(sql)) {
      return { rows: [{
        id: 10, app_id: 3, app_slug: 'realapp', app_name: 'Real App',
        session_id: 55, pr_number: 7, pr_title: 'Real PR', kind: 'merge',
        trigger: 'vote', status: 'merged', summary: 'Merged.',
        started_at: '2026-06-01T00:00:00Z', ended_at: '2026-06-01T00:01:00Z',
      }] };
    }
    if (/FROM merge_debug_steps/.test(sql)) {
      return { rows: [{ id: 1, run_id: 10, seq: 0, phase: 'claim', level: 'info', message: 'Claimed merge.', detail: {}, created_at: '2026-06-01T00:00:01Z' }] };
    }
    if (/JOIN apps a ON a\.id = r\.app_id/.test(sql) && /GROUP BY/.test(sql)) {
      return { rows: [{ id: 3, slug: 'realapp', name: 'Real App', run_count: 2 }] };
    }
    return { rows: [] };
  },
});

const { debugRoutes } = require('../src/routes/debug');

let server, base;
let role = { id: 1, username: 'admin', isAdmin: true, canAdminWrite: true };

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = role; next(); });
  app.use(debugRoutes({ jwtSecret: 'test' }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

test.beforeEach(() => { calls = []; });

test('403 for a non-admin', async () => {
  role = { id: 2, username: 'bob', isAdmin: false };
  const r = await fetch(`${base}/api/debug/merge-runs`);
  assert.equal(r.status, 403);
});

test('200 for a view-only admin', async () => {
  role = { id: 3, username: 'viewer', isAdmin: true, canAdminWrite: false };
  const r = await fetch(`${base}/api/debug/merge-runs`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(Array.isArray(body.runs));
});

test('200 for a full admin and returns runs', async () => {
  role = { id: 1, username: 'admin', isAdmin: true, canAdminWrite: true };
  const r = await fetch(`${base}/api/debug/merge-runs`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.runs.some((x) => x.id === 10), 'real run present');
});

test('app + pr_number + outcome + kind filters are wired into the query', async () => {
  role = { id: 1, username: 'admin', isAdmin: true, canAdminWrite: true };
  await fetch(`${base}/api/debug/merge-runs?app=realapp&pr_number=7&session_id=55&outcome=merged&kind=merge`);
  const listCall = calls.find((c) => /FROM merge_debug_runs r/.test(c.sql) && /LIMIT/.test(c.sql));
  assert.ok(listCall, 'list query ran');
  assert.ok(/a\.slug = \$/.test(listCall.sql), 'slug predicate present');
  assert.ok(listCall.params.includes('realapp'));
  assert.ok(listCall.params.includes(7), 'pr_number bound');
  assert.ok(listCall.params.includes(55), 'session_id bound');
  assert.ok(listCall.params.includes('merged'), 'status bound');
  assert.ok(listCall.params.includes('merge'), 'kind bound');
});

test('a numeric app filter binds app_id, not slug', async () => {
  await fetch(`${base}/api/debug/merge-runs?app=42`);
  const listCall = calls.find((c) => /FROM merge_debug_runs r/.test(c.sql) && /LIMIT/.test(c.sql));
  assert.ok(/r\.app_id = \$/.test(listCall.sql));
  assert.ok(listCall.params.includes(42));
});

test('keyset cursor adds the (started_at,id) predicate', async () => {
  await fetch(`${base}/api/debug/merge-runs?before=2026-06-01T00:00:00Z&before_id=10`);
  const listCall = calls.find((c) => /FROM merge_debug_runs r/.test(c.sql) && /LIMIT/.test(c.sql));
  assert.ok(/\(r\.started_at, r\.id\) < /.test(listCall.sql), 'cursor predicate present');
  assert.ok(listCall.params.includes(10));
});

test('staging demo injects mock runs on the first page', async () => {
  const r = await fetch(`${base}/api/debug/merge-runs?demo=1`);
  const body = await r.json();
  const ids = body.runs.map((x) => x.id);
  assert.ok(ids.includes(9500001), 'clean-merge mock present');
  assert.ok(ids.includes(9500003), 'conflict-failed mock present');
  assert.ok(ids.includes(10), 'real run still present');
});

test('no demo param → no mock runs', async () => {
  const r = await fetch(`${base}/api/debug/merge-runs`);
  const body = await r.json();
  assert.ok(!body.runs.some((x) => x.id >= 9500000), 'no mock rows without ?demo=1');
});

test('demo + cursor (not first page) → no mock runs', async () => {
  const r = await fetch(`${base}/api/debug/merge-runs?demo=1&before=2026-06-01T00:00:00Z&before_id=10`);
  const body = await r.json();
  assert.ok(!body.runs.some((x) => x.id >= 9500000), 'mocks suppressed past the first page');
});

test('single demo run returns its steps from the fixture', async () => {
  const r = await fetch(`${base}/api/debug/merge-runs/9500002?demo=1`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.run.id, 9500002);
  assert.equal(body.run.kind, 'conflict_resolution');
  assert.ok(body.steps.length > 0);
  assert.ok(body.steps.every((s, i) => s.seq === i), 'steps carry monotonic seq');
});

test('demo outcome filter narrows mock runs', async () => {
  const r = await fetch(`${base}/api/debug/merge-runs?demo=1&outcome=conflict_failed`);
  const body = await r.json();
  const mocks = body.runs.filter((x) => x.id >= 9500000);
  assert.ok(mocks.length >= 1);
  assert.ok(mocks.every((x) => x.status === 'conflict_failed'));
});

// ── pr_closed: the closed-PR terminal status round-trips ────────────────
// A proposal whose PR is closed on GitHub and couldn't be reopened ends
// its run with status 'pr_closed' (conflict-resolver / checkAndMerge).
// The /debug surface must accept it as an outcome filter and ship a
// staging mock so the badge is visible in previews.

test('staging demo includes the pr_closed mock run', async () => {
  const r = await fetch(`${base}/api/debug/merge-runs?demo=1`);
  const body = await r.json();
  const mock = body.runs.find((x) => x.id === 9500005);
  assert.ok(mock, 'pr_closed mock present');
  assert.equal(mock.status, 'pr_closed');
  assert.equal(mock.kind, 'conflict_resolution');
});

test('outcome=pr_closed is an accepted filter and narrows to pr_closed runs', async () => {
  const r = await fetch(`${base}/api/debug/merge-runs?demo=1&outcome=pr_closed`);
  const body = await r.json();
  const listCall = calls.find((c) => /FROM merge_debug_runs r/.test(c.sql) && /LIMIT/.test(c.sql));
  assert.ok(listCall.params.includes('pr_closed'), 'pr_closed bound into the SQL (not ignored)');
  const mocks = body.runs.filter((x) => x.id >= 9500000);
  assert.ok(mocks.length >= 1);
  assert.ok(mocks.every((x) => x.status === 'pr_closed'));
});

test('the reopened_closed_pr happy-path mock carries its reopen step', async () => {
  const r = await fetch(`${base}/api/debug/merge-runs/9500006?demo=1`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.run.status, 'merged');
  assert.ok(body.steps.some((s) => s.phase === 'reopened_closed_pr'),
    'the auto-reopen is narrated as its own step');
});

// ── kind='checks': the proposal-checks timing trace ─────────────────────
// The checks pipeline reuses this tracer (one run per checks run, a step per
// phase carrying detail.durationMs) because nothing else persisted how long a
// checks run took. There are several per proposal, far outnumbering merge
// attempts, so they are EXCLUDED from the unfiltered list and reachable only
// via the kind filter.

test("the unfiltered list excludes kind='checks' so it stays a merge list", async () => {
  calls = [];
  await fetch(`${base}/api/debug/merge-runs`);
  const listCall = calls.find((c) => /FROM merge_debug_runs r/.test(c.sql) && /LIMIT/.test(c.sql));
  assert.match(listCall.sql, /r\.kind <> \$\d+/, 'a kind exclusion is applied by default');
  assert.ok(listCall.params.includes('checks'), "'checks' is the excluded kind");
});

test("kind=checks is an accepted filter and switches to an equality match", async () => {
  calls = [];
  await fetch(`${base}/api/debug/merge-runs?kind=checks`);
  const listCall = calls.find((c) => /FROM merge_debug_runs r/.test(c.sql) && /LIMIT/.test(c.sql));
  assert.match(listCall.sql, /r\.kind = \$\d+/, 'filters TO checks');
  assert.doesNotMatch(listCall.sql, /r\.kind <> \$\d+/, 'and drops the default exclusion');
  assert.ok(listCall.params.includes('checks'));
});

test("an explicit kind=merge still filters to merge (the default exclusion does not stack)", async () => {
  calls = [];
  await fetch(`${base}/api/debug/merge-runs?kind=merge`);
  const listCall = calls.find((c) => /FROM merge_debug_runs r/.test(c.sql) && /LIMIT/.test(c.sql));
  assert.match(listCall.sql, /r\.kind = \$\d+/);
  assert.doesNotMatch(listCall.sql, /r\.kind <> \$\d+/);
  assert.ok(listCall.params.includes('merge'));
});

test('the staging demo ships checks runs, behind the kind filter like the real ones', async () => {
  // Unfiltered: the mock checks runs are held back, mirroring the SQL.
  const plain = await (await fetch(`${base}/api/debug/merge-runs?demo=1`)).json();
  assert.ok(!plain.runs.some((x) => x.kind === 'checks'),
    'mock checks runs stay out of the unfiltered merge list');

  // Filtered: both the passing and the error trace are reviewable.
  const body = await (await fetch(`${base}/api/debug/merge-runs?demo=1&kind=checks`)).json();
  const mocks = body.runs.filter((x) => x.id >= 9500000);
  assert.ok(mocks.length >= 2, 'a passing and an error checks run are seeded');
  assert.ok(mocks.every((x) => x.kind === 'checks'));
  assert.ok(mocks.some((x) => x.status === 'passing'));
  assert.ok(mocks.some((x) => x.status === 'error'));
});

test('a demo checks run carries per-phase durations for every phase of the pipeline', async () => {
  const body = await (await fetch(`${base}/api/debug/merge-runs/9500007?demo=1`)).json();
  const phases = body.steps.map((s) => s.phase);
  assert.deepEqual(phases, ['image_build', 'clone', 'staging_health', 'capture', 'tests']);
  for (const s of body.steps) {
    assert.equal(typeof s.detail.durationMs, 'number', `${s.phase} carries a durationMs`);
  }
  // The clone was the dominant phase before the dump-exclusion fix; the
  // fixture must show the healthy shape, not the ~4m35s regression.
  const clone = body.steps.find((s) => s.phase === 'clone');
  assert.ok(clone.detail.durationMs < 120000, 'the seeded clone reads as healthy');
});
