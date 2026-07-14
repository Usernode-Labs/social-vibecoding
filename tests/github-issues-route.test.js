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

// ── #227: staging-mock synthetic headless state ─────────────────────────
//
// The feed sorts auto-solve issues above plain ones, so the staging
// mocks need headless state for the ordering to be reviewable in a
// preview. The route attaches synthetic state to [Mock] 900003
// ('generating') and 900005 ('ready'/spec) in staging only, and never
// clobbers a real headless row. IS_STAGING is a module-level const read
// at require time, so the staging tests re-require the route module
// under USERNODE_ENV=staging — the collaborator stubs at the top of
// this file are patched onto the modules' exports, so a fresh require
// still picks them up.

function stagingIssueRoutes() {
  const prevEnv = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  delete require.cache[require.resolve('../src/routes/issues')];
  const { issueRoutes: routes } = require('../src/routes/issues');
  // Restore immediately — the handler captured IS_STAGING already — and
  // drop the staging-shaped module from the cache so any later require
  // gets a production-shaped copy again.
  if (prevEnv === undefined) delete process.env.USERNODE_ENV;
  else process.env.USERNODE_ENV = prevEnv;
  delete require.cache[require.resolve('../src/routes/issues')];
  return routes;
}

function startStagingServer() {
  const app = express();
  app.use((req, res, next) => { req.user = { id: 7, username: 'tester' }; next(); });
  app.use(stagingIssueRoutes()({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

test('staging ?demo=1 attaches synthetic headless to mocks 900003/900005 only', async () => {
  const server = await startStagingServer();
  try {
    const port = server.address().port;
    const res = await realFetch(`http://127.0.0.1:${port}/api/apps/demo/github-issues?demo=1`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    const byNumber = new Map(body.issues.map((i) => [i.number, i]));

    // 5 live issues + 8 appended mocks (900008 joined in #556).
    assert.strictEqual(body.issues.length, 13);

    const generating = byNumber.get(900003).headless;
    assert.ok(generating, '900003 carries synthetic headless state');
    assert.strictEqual(generating.status, 'generating');
    assert.strictEqual(generating.outcome, null);
    assert.strictEqual(generating.sessionId, 900003);
    assert.strictEqual(generating.username, 'staging-tester');
    assert.strictEqual(generating.mySessionId, null);
    assert.strictEqual(generating.stagingUrl, null);

    const ready = byNumber.get(900005).headless;
    assert.ok(ready, '900005 carries synthetic headless state');
    assert.strictEqual(ready.status, 'ready');
    assert.strictEqual(ready.outcome, 'spec');
    assert.strictEqual(ready.sessionId, 900005);

    // The other mocks — and the live issues — stay plain.
    for (const n of [900001, 900002, 900004, 900006, 1, 2, 3, 4, 5]) {
      assert.strictEqual(byNumber.get(n).headless, null, `#${n} has no headless`);
    }
  } finally {
    server.close();
  }
});

test('staging does not clobber a real headless row on a mock number', async () => {
  poolQueryHandler = async (sql) => {
    const s = String(sql);
    if (/is_headless = TRUE/.test(s)) {
      return {
        rows: [{
          n: 900003, id: 555, headless_status: 'ready',
          headless_outcome: 'code', staging_url: null, pr_number: null,
          username: 'realuser',
        }],
      };
    }
    return { rows: [] };
  };
  const server = await startStagingServer();
  try {
    const port = server.address().port;
    const res = await realFetch(`http://127.0.0.1:${port}/api/apps/demo/github-issues?demo=1`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    const byNumber = new Map(body.issues.map((i) => [i.number, i]));

    // The real chat_sessions row wins over the synthetic one…
    const real = byNumber.get(900003).headless;
    assert.strictEqual(real.sessionId, 555);
    assert.strictEqual(real.status, 'ready');
    assert.strictEqual(real.outcome, 'code');
    assert.strictEqual(real.username, 'realuser');

    // …while the untouched mock still gets its synthetic state.
    assert.strictEqual(byNumber.get(900005).headless.status, 'ready');
    assert.strictEqual(byNumber.get(900005).headless.sessionId, 900005);
  } finally {
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
});

// ── #287: per-viewer proposal session → "Create new proposal" swap ───────
//
// GET /github-issues exposes myPrSessionId — the viewer's own most recent
// non-archived dev chat started from each issue's start-work button
// (created_from_issue_number). The row swaps "Create proposal" → "Create
// new proposal" when it's set. The lookup must be per-viewer (user_id-scoped)
// and exclude archived rows so the button reverts after abandonment.

test('myPrSessionId is populated from the viewer proposal session lookup', async () => {
  let prSql = null;
  let prParams = null;
  poolQueryHandler = async (sql, params) => {
    const s = String(sql);
    if (/created_from_issue_number IS NOT NULL/.test(s)) {
      prSql = s;
      prParams = params;
      // DISTINCT ON (created_from_issue_number) → one row per issue.
      return { rows: [{ n: 2, id: 42 }] };
    }
    return { rows: [] };
  };
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await realFetch(`http://127.0.0.1:${port}/api/apps/demo/github-issues`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    const byNumber = new Map(body.issues.map((i) => [i.number, i]));

    // Issue #2 has a linked session; the rest are null.
    assert.strictEqual(byNumber.get(2).myPrSessionId, 42);
    for (const n of [1, 3, 4, 5]) {
      assert.strictEqual(byNumber.get(n).myPrSessionId, null, `#${n} has no session`);
    }

    // The lookup is per-viewer (user_id) and excludes archived sessions.
    assert.ok(prSql, 'Create-PR session query was issued');
    assert.match(prSql, /user_id = \$2/);
    assert.match(prSql, /status <> 'archived'/);
    assert.deepStrictEqual(prParams, [1, 7]); // [app.id, req.user.id]
  } finally {
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
});

test('myPrSessionId is null for every issue when the viewer has no session', async () => {
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await realFetch(`http://127.0.0.1:${port}/api/apps/demo/github-issues`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    for (const issue of body.issues) {
      assert.strictEqual(issue.myPrSessionId, null);
    }
  } finally {
    server.close();
  }
});

test('staging synthesizes myPrSessionId on mock 900007 only', async () => {
  const server = await startStagingServer();
  try {
    const port = server.address().port;
    const res = await realFetch(`http://127.0.0.1:${port}/api/apps/demo/github-issues?demo=1`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    const byNumber = new Map(body.issues.map((i) => [i.number, i]));

    // Two-state label mapping (rendered in app-view.js _renderIssueRow):
    //   myPrSessionId set  ⇒ "Create new proposal"
    //   myPrSessionId null ⇒ "Create proposal"
    // 900007 gets a synthetic session id so the "Create new proposal" state
    // renders in a staging preview.
    assert.strictEqual(byNumber.get(900007).myPrSessionId, 900007);
    // Every other mock and live issue stays on "Create proposal".
    for (const n of [900001, 900002, 900003, 900004, 900005, 1, 2, 3, 4, 5]) {
      assert.strictEqual(byNumber.get(n).myPrSessionId, null, `#${n} stays Create proposal`);
    }
  } finally {
    server.close();
  }
});

test('staging does not clobber a real proposal session on mock 900007', async () => {
  poolQueryHandler = async (sql) => {
    const s = String(sql);
    if (/created_from_issue_number IS NOT NULL/.test(s)) {
      return { rows: [{ n: 900007, id: 777 }] };
    }
    return { rows: [] };
  };
  const server = await startStagingServer();
  try {
    const port = server.address().port;
    const res = await realFetch(`http://127.0.0.1:${port}/api/apps/demo/github-issues?demo=1`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    const byNumber = new Map(body.issues.map((i) => [i.number, i]));
    // The real session id wins over the synthetic one.
    assert.strictEqual(byNumber.get(900007).myPrSessionId, 777);
  } finally {
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
});

test('production never synthesizes a Create-PR session', async () => {
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await realFetch(`http://127.0.0.1:${port}/api/apps/demo/github-issues?demo=1`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    for (const issue of body.issues) {
      assert.strictEqual(issue.myPrSessionId, null);
    }
  } finally {
    server.close();
  }
});

test('production never synthesizes headless state', async () => {
  // The module-level routes were required with no USERNODE_ENV, i.e.
  // production-shaped: ?demo=1 is a no-op (no mocks appended) and no
  // issue gets a synthetic headless field.
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await realFetch(`http://127.0.0.1:${port}/api/apps/demo/github-issues?demo=1`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.issues.length, 5);
    for (const issue of body.issues) {
      assert.ok(issue.number < 900000, 'no mock rows outside staging');
      assert.strictEqual(issue.headless, null);
    }
  } finally {
    server.close();
  }
});

// ── #396: GET /api/apps/:slug/github-issues/:number/comments ─────────────
//
// The lazy, collab-gated comment-thread endpoint for the Dev topic view.
// It calls github.fetchIssueComments + clipIssueComments and returns
// { comments, truncated, note? }. In staging an empty/unavailable live
// thread falls back to stagingMockIssueComments so the section is
// reviewable. The module-level fetch stub above answers api.github.com
// list calls; these tests override global.fetch to shape the COMMENTS
// response, restoring it afterwards.

const baselineFetch = global.fetch;

test('comments endpoint returns the clipped live thread (collab-gated, merged shape)', async () => {
  global.fetch = async (url, opts) => {
    if (String(url).includes('api.github.com') && String(url).includes('/comments')) {
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => [
          { user: { login: 'reporter' }, body: 'It only happens on mobile.', created_at: '2026-06-10T00:00:00Z' },
          { user: { login: 'usernode-bot' }, body: 'Per-device, then?', created_at: '2026-06-11T00:00:00Z' },
        ],
      };
    }
    return baselineFetch(url, opts);
  };
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await realFetch(`http://127.0.0.1:${port}/api/apps/demo/github-issues/142/comments`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.comments.length, 2);
    assert.strictEqual(body.comments[0].author, 'reporter');
    assert.strictEqual(body.comments[1].author, 'usernode-bot');
    assert.strictEqual(body.truncated, false);
  } finally {
    global.fetch = baselineFetch;
    server.close();
  }
});

test('comments endpoint 404s when the app is not accessible to the viewer', async () => {
  const prev = appAccess.getAppForUser;
  appAccess.getAppForUser = async () => null;
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await realFetch(`http://127.0.0.1:${port}/api/apps/demo/github-issues/142/comments`);
    assert.strictEqual(res.status, 404);
  } finally {
    appAccess.getAppForUser = prev;
    server.close();
  }
});

test('staging comments endpoint serves mock thread (with a bot comment) on an empty live fetch', async () => {
  // Live thread comes back empty → staging falls back to the mocks.
  global.fetch = async (url, opts) => {
    if (String(url).includes('api.github.com') && String(url).includes('/comments')) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => [] };
    }
    return baselineFetch(url, opts);
  };
  const server = await startStagingServer();
  try {
    const port = server.address().port;
    const res = await realFetch(`http://127.0.0.1:${port}/api/apps/demo/github-issues/900001/comments?demo=1`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.comments.length, 3, 'mock 900001 thread has 3 comments');
    assert.ok(body.comments.some((c) => c.author === 'usernode-bot'), 'includes a bot-authored comment');
  } finally {
    global.fetch = baselineFetch;
    server.close();
  }
});

test('production comments endpoint never substitutes mocks (empty stays empty)', async () => {
  global.fetch = async (url, opts) => {
    if (String(url).includes('api.github.com') && String(url).includes('/comments')) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => [] };
    }
    return baselineFetch(url, opts);
  };
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await realFetch(`http://127.0.0.1:${port}/api/apps/demo/github-issues/900001/comments`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.comments, []);
    assert.strictEqual(body.truncated, false);
  } finally {
    global.fetch = baselineFetch;
    server.close();
  }
});
