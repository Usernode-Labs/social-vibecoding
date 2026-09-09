// Route test for the merged-proposal aggregates on GET /api/apps
// (src/routes/apps.js, issue #1383): merged_prs, merged_prs_recent and
// last_merged_at, which are what the directory's "Most changes merged" and
// "Most active" orders rank on.
//
// Three contracts matter here, and each of them is a way the Sort control
// could go quietly wrong rather than loudly broken:
//
//   1. A merged chat_session IS an accepted community proposal — the same
//      definition src/services/contributors.js and the gallery use. A future
//      status rename must fail here, not silently rank every app at zero.
//   2. merged_at was added by a later ALTER TABLE and is NULL on every row
//      merged before it existed, so both the 30-day window and the recency
//      aggregate COALESCE to created_at. Without that, "Most active" would
//      read the platform's own history as though nothing had ever shipped.
//   3. The three ride the EXISTING dev subquery's scan of chat_sessions —
//      one query, no new index. A second `FROM chat_sessions` in the listing
//      SQL means someone added a scan per app card.
//
// Harness shape is tests/home-app-activity-counts.test.js's: override getPool
// BEFORE requiring the route module, mount on express with an injected user,
// capture every query.
//
// Run with: node --test tests/app-sort-aggregates.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
let capturedQueries = [];
poolMod.getPool = () => ({
  query: (sql, params) => {
    capturedQueries.push({ sql, params });
    return poolQueryHandler(sql, params);
  },
});

const { appRoutes } = require('../src/routes/apps');
const express = require('express');

const VIEWER = { id: 7, username: 'tester' };

function startServer() {
  const app = express();
  app.use((req, res, next) => { req.user = VIEWER; next(); });
  app.use(appRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

// status 'error' keeps the per-row enrichment quiet; COUNT(*) is bigint, so
// postgres hands the counts back as strings.
function appRow(overrides = {}) {
  return {
    id: 1,
    slug: 'demo',
    name: 'Demo App',
    status: 'error',
    self_hosted: false,
    manifest_snapshot: null,
    repo_url: null,
    main_sha: null,
    main_pr_number: null,
    created_by: 7,
    created_at: '2026-06-01T00:00:00Z',
    last_deploy_at: null,
    collab_visibility: 'public',
    view_visibility: 'public',
    is_collaborator: false,
    is_favorited: false,
    favorite_order: null,
    active_users: '0',
    message_count: '0',
    total_seconds: '0',
    ...overrides,
  };
}

async function fetchApps(server) {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/apps`);
  return { res, body: await res.json() };
}

test('merged-proposal aggregates are surfaced per app', async () => {
  capturedQueries = [];
  poolQueryHandler = async () => ({
    rows: [appRow({
      merged_prs: '41',
      merged_prs_recent: '11',
      last_merged_at: '2026-08-24T09:00:00Z',
    })],
  });
  const server = await startServer();
  try {
    const { res, body } = await fetchApps(server);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.apps[0].merged_prs, 41);
    assert.strictEqual(body.apps[0].merged_prs_recent, 11);
    assert.strictEqual(body.apps[0].last_merged_at, '2026-08-24T09:00:00Z');
  } finally {
    server.close();
  }
});

test('an app that has never merged anything reads as 0 / null, not undefined', async () => {
  capturedQueries = [];
  // No aggregate fields at all — the COALESCE lives in SQL, and this also
  // covers a payload that drops them entirely. `null` matters as much as the
  // zeroes: the client sinks a null last_merged_at rather than treating it as
  // the epoch, so an app with no history must not arrive as `undefined`.
  poolQueryHandler = async () => ({ rows: [appRow()] });
  const server = await startServer();
  try {
    const { res, body } = await fetchApps(server);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.apps[0].merged_prs, 0);
    assert.strictEqual(body.apps[0].merged_prs_recent, 0);
    assert.strictEqual(body.apps[0].last_merged_at, null);
  } finally {
    server.close();
  }
});

test('SQL counts merged sessions, and dates the NULL-merged_at history', async () => {
  capturedQueries = [];
  poolQueryHandler = async () => ({ rows: [] });
  const server = await startServer();
  try {
    const { res } = await fetchApps(server);
    assert.strictEqual(res.status, 200);

    const q = capturedQueries.find((c) => /FROM apps a/.test(c.sql));
    assert.ok(q, 'app listing query was issued');

    assert.match(q.sql, /COUNT\(\*\) FILTER \(WHERE status = 'merged'\) AS merged_prs/);
    assert.match(
      q.sql,
      /WHERE status = 'merged'\s+AND COALESCE\(merged_at, created_at\) > NOW\(\) - INTERVAL '30 days'/,
      'the 30-day window must fall back to created_at for pre-ALTER rows'
    );
    assert.match(
      q.sql,
      /MAX\(COALESCE\(merged_at, created_at\)\) FILTER \(WHERE status = 'merged'\)\s+AS last_merged_at/
    );
  } finally {
    server.close();
  }
});

test('the aggregates ride the existing chat_sessions scan — no extra query', async () => {
  capturedQueries = [];
  poolQueryHandler = async () => ({ rows: [] });
  const server = await startServer();
  try {
    await fetchApps(server);
    const q = capturedQueries.find((c) => /FROM apps a/.test(c.sql));
    const scans = (q.sql.match(/FROM chat_sessions/g) || []).length;
    assert.strictEqual(scans, 1,
      'a second scan means the sort control started costing a query per listing');
    // And they are in the SAME statement as the chips' counts, not a sibling.
    assert.match(q.sql, /AS open_prs/);
    assert.match(q.sql, /AS merged_prs_recent/);
  } finally {
    server.close();
  }
});
