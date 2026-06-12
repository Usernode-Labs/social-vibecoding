// Regression test for GET /api/apps/:slug/github-issues (#210 follow-up).
//
// The staging-mocks refactor in the Dev card-list redesign moved
// `const wantRefresh` inside the github-enabled else-branch while the
// response builder at the bottom of the handler still referenced it —
// a ReferenceError on EVERY request, so the route 500'd and the Dev
// view rendered zero open issues. This exercises the route end-to-end
// (express + mocked pool + stubbed GitHub fetch) on both the plain and
// ?refresh=1 paths so a scoping break like that fails loudly again.
//
// Run with: node --test tests/github-issues-route.test.js

const { test } = require('node:test');
const assert = require('node:assert');

// Override collaborators BEFORE requiring the route module: issues.js
// destructures getPool / countWeeklyAllowanceUsed at require time.
// The pool delegates to a swappable handler so individual tests can
// answer specific SQL shapes (default: empty result for everything).
const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
poolMod.getPool = () => ({ query: (sql, params) => poolQueryHandler(sql, params) });

const kudos = require('../src/routes/kudos');
kudos.countWeeklyAllowanceUsed = async () => 0;

const github = require('../src/services/github');
github.isEnabled = () => true; // production-shaped: App credentials configured

const appAccess = require('../src/services/app-access');
appAccess.getAppForUser = async () => ({
  id: 1, slug: 'demo', repo_url: 'https://github.com/o/r',
});

const { issueRoutes } = require('../src/routes/issues');
const express = require('express');

const GH_ISSUES = Array.from({ length: 5 }, (_, i) => ({
  number: i + 1,
  title: `issue ${i + 1}`,
  body: `body of #${i + 1}`,
  labels: [{ name: 'usernode' }],
  updated_at: '2026-06-10T00:00:00Z',
  html_url: `https://github.com/o/r/issues/${i + 1}`,
  user: { login: 'someone' },
}));

// Stub only the api.github.com calls fetchPublicIssues makes; local
// requests to the test server pass through to the real fetch.
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).includes('api.github.com')) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => GH_ISSUES,
    };
  }
  return realFetch(url, opts);
};

function startServer() {
  const app = express();
  app.use((req, res, next) => { req.user = { id: 7, username: 'tester' }; next(); });
  app.use(issueRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

test('github-issues route returns the open issue list (no 500)', async () => {
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await realFetch(`http://127.0.0.1:${port}/api/apps/demo/github-issues`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.issues), 'issues must be an array');
    assert.strictEqual(body.issues.length, 5);
    assert.strictEqual(body.issues[0].number, 1);
    assert.strictEqual(body.truncatedList, false);
    // Plain (non-refresh) responses must not carry the refresh fields.
    assert.ok(!('refreshed' in body));
    assert.ok(!('refreshRetryMs' in body));
  } finally {
    server.close();
  }
});

test('github-issues route ?refresh=1 returns issues plus refresh metadata', async () => {
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await realFetch(`http://127.0.0.1:${port}/api/apps/demo/github-issues?refresh=1`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.issues), 'issues must be an array');
    assert.strictEqual(body.issues.length, 5);
    assert.strictEqual(typeof body.refreshed, 'boolean');
    assert.strictEqual(typeof body.refreshRetryMs, 'number');
  } finally {
    server.close();
  }
});

test('per-issue chatCount counts only human messages (msg_type=message)', async () => {
  // Answer the per-issue thread-count grouped query with rows shaped the
  // way Postgres would after the FILTER: issue #1 has 2 human messages
  // (plus system rows that must NOT be counted — hence the SQL assertion),
  // issue #2 has only system rows, so its filtered cnt is 0 while last_at
  // still reflects the system activity.
  let threadCountSql = null;
  poolQueryHandler = async (sql) => {
    const s = String(sql);
    if (/FROM chat_messages/.test(s) && /thread_type = 'issue'/.test(s) && /GROUP BY thread_ref/.test(s)) {
      threadCountSql = s;
      return {
        rows: [
          { n: 1, cnt: 2, last_at: '2026-06-12T00:00:00Z' },
          { n: 2, cnt: 0, last_at: '2026-06-11T00:00:00Z' },
        ],
      };
    }
    return { rows: [] };
  };
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await realFetch(`http://127.0.0.1:${port}/api/apps/demo/github-issues`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();

    // The badge count must be filtered to human messages; the activity
    // timestamp must NOT be (system rows still freshen the feed sort).
    assert.ok(threadCountSql, 'thread-count query was issued');
    assert.match(threadCountSql, /FILTER \(WHERE msg_type = 'message'\)/);
    assert.ok(!/MAX\(created_at\) FILTER/.test(threadCountSql),
      'last_at must aggregate over all thread rows');

    const byNumber = new Map(body.issues.map((i) => [i.number, i]));
    assert.strictEqual(byNumber.get(1).chatCount, 2);
    assert.strictEqual(byNumber.get(1).lastMessageAt, '2026-06-12T00:00:00Z');
    assert.strictEqual(byNumber.get(2).chatCount, 0);
    assert.strictEqual(byNumber.get(2).lastMessageAt, '2026-06-11T00:00:00Z');
    assert.strictEqual(byNumber.get(3).chatCount, 0);
  } finally {
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
});
