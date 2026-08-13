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

test('staging ?demo=1 attaches synthetic headless to mocks 900003/900005/900015 only', async () => {
  const server = await startStagingServer();
  try {
    const port = server.address().port;
    const res = await realFetch(`http://127.0.0.1:${port}/api/apps/demo/github-issues?demo=1`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    const byNumber = new Map(body.issues.map((i) => [i.number, i]));

    // 5 live issues + 15 appended mocks (900008 joined in #556, 900009 in
    // #617, 900010 in #683, 900011/900012 in #1010 as the targets of the
    // applying / retry-pending mock close proposals, 900013 with the
    // card-as-pointer revision — the deliberately BARE row, which the
    // staging attribute-enrichment block leaves alone so the 'no grey
    // placeholder chips' rule is reviewable — and 900014/900015 in #1112 to
    // make the `paused` and `answer_needed` work states reviewable).
    assert.strictEqual(body.issues.length, 20);

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

    // #1112: 900015 is the run that came back with a QUESTION rather than a
    // draft — the board's `answer_needed` state, which needs its own seed
    // because `ready` alone reads as "draft ready to review".
    const asked = byNumber.get(900015).headless;
    assert.ok(asked, '900015 carries synthetic headless state');
    assert.strictEqual(asked.status, 'ready');
    assert.strictEqual(asked.outcome, 'question');
    assert.strictEqual(asked.sessionId, 900015);

    // The other mocks — and the live issues — stay plain.
    for (const n of [900001, 900002, 900004, 900006, 900014, 1, 2, 3, 4, 5]) {
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

// ── "In progress" status: dispatch-derived sessions + manual claims ──────
//
// GET /github-issues composes per-issue `in_progress` from (a) LIVE
// non-headless sessions whose linked_issues contain the number and (b)
// live issue_claims rows (7-day activity-based expiry, computed against
// the thread's last_at). The chip's link `target` is chosen server-side
// per viewer: proposal > own session > shared session > null.

const {
  pickInProgressTarget, composeInProgress, ISSUE_CLAIM_TTL_DAYS,
} = require('../src/routes/issues');

test('in_progress session query filters to live rows only (status + paused window + non-headless)', async () => {
  let ipSql = null;
  let ipParams = null;
  poolQueryHandler = async (sql, params) => {
    const s = String(sql);
    if (/UNNEST\(cs\.linked_issues\)/.test(s)) {
      ipSql = s;
      ipParams = params;
      return { rows: [] };
    }
    return { rows: [] };
  };
  const server = await startServer();
  try {
    const port = server.address().port;
    const res = await realFetch(`http://127.0.0.1:${port}/api/apps/demo/github-issues`);
    assert.strictEqual(res.status, 200);
    assert.ok(ipSql, 'in-progress session query was issued');
    assert.match(ipSql, /is_headless = FALSE/);
    assert.match(ipSql, /status IN \('active','promoted','merging'\)/);
    assert.match(ipSql, /status = 'paused'/);
    assert.match(ipSql, /make_interval\(days => \$2\)/);
    assert.deepStrictEqual(ipParams, [1, 7]); // [app.id, IN_PROGRESS_PAUSED_WINDOW_DAYS]
  } finally {
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
});

test('in_progress serializes count/users/mine and targets the viewer\'s own session', async () => {
  poolQueryHandler = async (sql) => {
    const s = String(sql);
    if (/UNNEST\(cs\.linked_issues\)/.test(s)) {
      return {
        rows: [{
          n: 2, id: 50, user_id: 7, status: 'active', shared_at: null,
          last_activity_at: '2026-06-12T00:00:00Z', created_at: '2026-06-11T00:00:00Z',
          username: 'tester',
        }],
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
    const byNumber = new Map(body.issues.map((i) => [i.number, i]));

    const ip = byNumber.get(2).in_progress;
    assert.ok(ip, 'issue #2 is in progress');
    assert.strictEqual(ip.count, 1);
    assert.deepStrictEqual(ip.users, ['tester']);
    assert.strictEqual(ip.mine, true);
    assert.deepStrictEqual(ip.claims, []);
    assert.deepStrictEqual(ip.target, { kind: 'session-own', sessionId: 50 });
    // #1112: per-session detail, so the FE can say WHICH of the seven work
    // states this is rather than the old catch-all "In progress".
    assert.strictEqual(ip.peopleTotal, 1);
    assert.strictEqual(ip.sessions.length, 1);
    assert.strictEqual(ip.sessions[0].sessionId, 50);
    assert.strictEqual(ip.sessions[0].username, 'tester');
    assert.strictEqual(ip.sessions[0].mine, true);
    assert.strictEqual(ip.sessions[0].status, 'active');
    assert.strictEqual(ip.sessions[0].busy, false);
    assert.strictEqual(ip.sessions[0].lastActivityAt, '2026-06-12T00:00:00Z');

    for (const n of [1, 3, 4, 5]) {
      assert.strictEqual(byNumber.get(n).in_progress, null, `#${n} not in progress`);
    }
  } finally {
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
});

test('another user\'s PRIVATE session marks in-progress but yields no target', async () => {
  poolQueryHandler = async (sql) => {
    if (/UNNEST\(cs\.linked_issues\)/.test(String(sql))) {
      return {
        rows: [{
          n: 1, id: 60, user_id: 99, status: 'active', shared_at: null,
          last_activity_at: '2026-06-12T00:00:00Z', created_at: '2026-06-11T00:00:00Z',
          username: 'maya',
        }],
      };
    }
    return { rows: [] };
  };
  const server = await startServer();
  try {
    const port = server.address().port;
    const body = await (await realFetch(`http://127.0.0.1:${port}/api/apps/demo/github-issues`)).json();
    const ip = body.issues.find((i) => i.number === 1).in_progress;
    assert.ok(ip);
    assert.strictEqual(ip.mine, false);
    assert.deepStrictEqual(ip.users, ['maya']);
    assert.strictEqual(ip.target, null, 'private work stays unlinked');
  } finally {
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
});

test('pickInProgressTarget: proposal > own session > shared session, recency tie-break', () => {
  const mk = (over) => ({
    id: 1, user_id: 99, status: 'active', shared_at: null,
    last_activity_at: '2026-06-10T00:00:00Z', created_at: '2026-06-09T00:00:00Z',
    ...over,
  });
  const viewer = 7;

  // A promoted session wins over the viewer's own and a shared one.
  assert.deepStrictEqual(
    pickInProgressTarget([
      mk({ id: 10, status: 'promoted' }),
      mk({ id: 11, user_id: viewer }),
      mk({ id: 12, shared_at: '2026-06-10T00:00:00Z' }),
    ], viewer),
    { kind: 'proposal', sessionId: 10 }
  );
  // 'merging' counts as the proposal class too.
  assert.deepStrictEqual(
    pickInProgressTarget([mk({ id: 13, status: 'merging' })], viewer),
    { kind: 'proposal', sessionId: 13 }
  );
  // Own beats shared.
  assert.deepStrictEqual(
    pickInProgressTarget([
      mk({ id: 11, user_id: viewer }),
      mk({ id: 12, shared_at: '2026-06-10T00:00:00Z' }),
    ], viewer),
    { kind: 'session-own', sessionId: 11 }
  );
  // Shared when nothing closer to the viewer exists.
  assert.deepStrictEqual(
    pickInProgressTarget([mk({ id: 12, shared_at: '2026-06-10T00:00:00Z' })], viewer),
    { kind: 'session-shared', sessionId: 12 }
  );
  // Others' private sessions → no target at all.
  assert.strictEqual(pickInProgressTarget([mk({ id: 14 })], viewer), null);
  // Two candidates in one class → most recently active wins.
  assert.deepStrictEqual(
    pickInProgressTarget([
      mk({ id: 20, status: 'promoted', last_activity_at: '2026-06-10T00:00:00Z' }),
      mk({ id: 21, status: 'promoted', last_activity_at: '2026-06-12T00:00:00Z' }),
    ], viewer),
    { kind: 'proposal', sessionId: 21 }
  );
  // Claims-only (no sessions) → null; composeInProgress mirrors that.
  assert.strictEqual(pickInProgressTarget([], viewer), null);
});

test('claims serialize oldest-first with expiresAt; expired ones are filtered per claim', async () => {
  const now = Date.now();
  const daysAgo = (d) => new Date(now - d * 24 * 3600 * 1000).toISOString();
  poolQueryHandler = async (sql) => {
    const s = String(sql);
    if (/FROM issue_claims/.test(s)) {
      return {
        rows: [
          { n: 1, user_id: 8, claimed_at: daysAgo(8), username: 'stale-user' }, // expired
          { n: 1, user_id: 7, claimed_at: daysAgo(1), username: 'tester' },     // live
        ],
      };
    }
    return { rows: [] };
  };
  const server = await startServer();
  try {
    const port = server.address().port;
    const body = await (await realFetch(`http://127.0.0.1:${port}/api/apps/demo/github-issues`)).json();
    const ip = body.issues.find((i) => i.number === 1).in_progress;
    assert.ok(ip, 'live claim keeps the issue in progress');
    assert.strictEqual(ip.count, 0);
    assert.strictEqual(ip.claims.length, 1, 'the >7d-idle claim is filtered out');
    assert.strictEqual(ip.claims[0].username, 'tester');
    assert.strictEqual(ip.claims[0].mine, true);
    assert.strictEqual(ip.claims[0].userId, 7);
    assert.ok(ip.claims[0].expiresAt, 'expiresAt is precomputed server-side');
    assert.strictEqual(ip.mine, true);
    assert.strictEqual(ip.target, null, 'claims-only status is not a link');
  } finally {
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
});

test('recent thread activity keeps an old claim alive (GREATEST rule)', async () => {
  const now = Date.now();
  const daysAgo = (d) => new Date(now - d * 24 * 3600 * 1000).toISOString();
  poolQueryHandler = async (sql) => {
    const s = String(sql);
    if (/FROM issue_claims/.test(s)) {
      return { rows: [{ n: 2, user_id: 8, claimed_at: daysAgo(10), username: 'maya' }] };
    }
    if (/FROM chat_messages/.test(s) && /GROUP BY thread_ref/.test(s)) {
      return { rows: [{ n: 2, cnt: 3, last_at: daysAgo(1) }] };
    }
    return { rows: [] };
  };
  const server = await startServer();
  try {
    const port = server.address().port;
    const body = await (await realFetch(`http://127.0.0.1:${port}/api/apps/demo/github-issues`)).json();
    const ip = body.issues.find((i) => i.number === 2).in_progress;
    assert.ok(ip, 'a 10-day-old claim with fresh discussion is still live');
    assert.strictEqual(ip.claims.length, 1);
    assert.strictEqual(ip.claims[0].username, 'maya');
    // expiresAt keys off the thread's last activity, not the stale claimed_at.
    const expires = Date.parse(ip.claims[0].expiresAt);
    const expected = Date.parse(daysAgo(1)) + ISSUE_CLAIM_TTL_DAYS * 24 * 3600 * 1000;
    assert.ok(Math.abs(expires - expected) < 5000, 'expiry extends from thread last_at');
  } finally {
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
});

test('composeInProgress dedupes nothing it should not and caps serialized claims at 10', () => {
  const claims = Array.from({ length: 12 }, (_, i) => ({
    user_id: 100 + i, username: `u${i}`, claimed_at: '2026-06-12T00:00:00Z',
    expires_at: '2026-06-19T00:00:00Z',
  }));
  const ip = composeInProgress([], claims, 7);
  assert.strictEqual(ip.claims.length, 10);
  assert.strictEqual(ip.count, 0);
  assert.deepStrictEqual(ip.sessions, []);
  // #1112: peopleTotal is the TRUE headcount, uncapped — 12 claimers, not 10.
  assert.strictEqual(ip.peopleTotal, 12);
  // Null when neither sessions nor claims exist.
  assert.strictEqual(composeInProgress([], [], 7), null);
});

// #1112: `users` used to `break` at three, so a five-person issue reported
// "In progress · 3" and there was no way to tell it from a real three. The
// display list is capped at five; the truth rides on peopleTotal.
test('composeInProgress reports the true headcount and caps only the display list', () => {
  const sess = Array.from({ length: 7 }, (_, i) => ({
    id: 500 + i, user_id: 200 + i, username: `w${i}`, status: 'active',
    shared_at: null, last_activity_at: `2026-06-${12 + i}T00:00:00Z`,
    created_at: '2026-06-01T00:00:00Z',
  }));
  const ip = composeInProgress(sess, [
    { user_id: 900, username: 'claimer', claimed_at: '2026-06-12T00:00:00Z', expires_at: '2026-06-19T00:00:00Z' },
  ], 7);
  assert.strictEqual(ip.count, 7);
  assert.strictEqual(ip.users.length, 5, 'display list capped at five');
  assert.strictEqual(ip.peopleTotal, 8, 'seven session owners plus one claimer');
  // Session detail is most-recent-first and capped at five.
  assert.strictEqual(ip.sessions.length, 5);
  assert.deepStrictEqual(ip.sessions.map((s) => s.username), ['w6', 'w5', 'w4', 'w3', 'w2']);
  assert.strictEqual(ip.sessions[0].lastActivityAt, '2026-06-18T00:00:00Z');
  // A repeated owner is one person in both lists.
  const dup = composeInProgress([
    { id: 1, user_id: 5, username: 'solo', status: 'active', shared_at: null, last_activity_at: '2026-06-12T00:00:00Z', created_at: null },
    { id: 2, user_id: 5, username: 'solo', status: 'paused', shared_at: null, last_activity_at: '2026-06-11T00:00:00Z', created_at: null },
  ], [], 7);
  assert.deepStrictEqual(dup.users, ['solo']);
  assert.strictEqual(dup.peopleTotal, 1);
  assert.strictEqual(dup.sessions.length, 2, 'both sessions are reported even though it is one person');
  assert.deepStrictEqual(dup.sessions.map((s) => s.status), ['active', 'paused']);
});

test('staging ?demo=1 seeds in_progress mock states on 900004/900006/900007/900008/900014 only', async () => {
  const server = await startStagingServer();
  try {
    const port = server.address().port;
    const body = await (await realFetch(`http://127.0.0.1:${port}/api/apps/demo/github-issues?demo=1`)).json();
    const byNumber = new Map(body.issues.map((i) => [i.number, i]));

    // 900007: promoted session → the `in_review` state, clickable (synthetic
    // proposal target).
    const p7 = byNumber.get(900007).in_progress;
    assert.strictEqual(p7.count, 1);
    assert.deepStrictEqual(p7.users, ['staging-tester']);
    assert.deepStrictEqual(p7.target, { kind: 'proposal', sessionId: 900007 });
    assert.strictEqual(p7.sessions[0].status, 'promoted');

    // 900006: two active sessions, the most recent one busy → the `working`
    // state in its emerald mid-turn variant. Non-clickable.
    const p6 = byNumber.get(900006).in_progress;
    assert.strictEqual(p6.count, 2);
    assert.deepStrictEqual(p6.users, ['maya-builder', 'staging-tester']);
    assert.strictEqual(p6.target, null);
    assert.strictEqual(p6.peopleTotal, 2);
    assert.strictEqual(p6.sessions.length, 2);
    assert.strictEqual(p6.sessions[0].busy, true);
    assert.ok(p6.sessions.every((s) => s.status === 'active'));

    // #1112 900014: a paused session five days old → the `paused` state and
    // the topic head's dated self-clear sentence.
    const p14 = byNumber.get(900014).in_progress;
    assert.strictEqual(p14.count, 1);
    assert.strictEqual(p14.sessions.length, 1);
    assert.strictEqual(p14.sessions[0].status, 'paused');
    assert.strictEqual(p14.sessions[0].busy, false);
    const pausedAgeDays = (Date.now() - Date.parse(p14.sessions[0].lastActivityAt)) / 86400000;
    assert.ok(pausedAgeDays > 4.9 && pausedAgeDays < 5.1, `paused ~5 days ago, got ${pausedAgeDays}`);

    // #1112 900015: a finished auto-solve run asking a question → the
    // `answer_needed` state. It rides on `headless`, not `in_progress`.
    const h15 = byNumber.get(900015).headless;
    assert.strictEqual(h15.status, 'ready');
    assert.strictEqual(h15.outcome, 'question');
    assert.strictEqual(byNumber.get(900015).in_progress, null);

    // 900004: two claims incl. the VIEWER's own (mine → Clear button state).
    const p4 = byNumber.get(900004).in_progress;
    assert.strictEqual(p4.mine, true);
    assert.strictEqual(p4.claims.length, 2);
    assert.strictEqual(p4.claims[0].username, 'tester'); // the viewing user
    assert.strictEqual(p4.claims[0].mine, true);
    assert.strictEqual(p4.claims[1].username, 'maya-builder');

    // 900008: someone else's single claim.
    const p8 = byNumber.get(900008).in_progress;
    assert.strictEqual(p8.mine, false);
    assert.strictEqual(p8.claims.length, 1);
    assert.strictEqual(p8.claims[0].username, 'maya-builder');
    assert.strictEqual(byNumber.get(900008).created_by_username, 'tester',
      'the dedicated mock is authored by the actual capture viewer, not its synthetic GitHub login');

    // The kanban-demo anchors and live issues stay untouched.
    for (const n of [900001, 900002, 900009, 1, 2, 3, 4, 5]) {
      assert.strictEqual(byNumber.get(n).in_progress, null, `#${n} has no in_progress`);
    }
  } finally {
    server.close();
  }
});

test('staging does not clobber real in_progress data on a mock number', async () => {
  poolQueryHandler = async (sql) => {
    if (/UNNEST\(cs\.linked_issues\)/.test(String(sql))) {
      return {
        rows: [{
          n: 900007, id: 888, user_id: 7, status: 'active', shared_at: null,
          last_activity_at: '2026-06-12T00:00:00Z', created_at: '2026-06-11T00:00:00Z',
          username: 'tester',
        }],
      };
    }
    return { rows: [] };
  };
  const server = await startStagingServer();
  try {
    const port = server.address().port;
    const body = await (await realFetch(`http://127.0.0.1:${port}/api/apps/demo/github-issues?demo=1`)).json();
    const ip = body.issues.find((i) => i.number === 900007).in_progress;
    assert.strictEqual(ip.count, 1);
    assert.deepStrictEqual(ip.target, { kind: 'session-own', sessionId: 888 });
  } finally {
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
});

test('production never synthesizes in_progress state', async () => {
  const server = await startServer();
  try {
    const port = server.address().port;
    const body = await (await realFetch(`http://127.0.0.1:${port}/api/apps/demo/github-issues?demo=1`)).json();
    for (const issue of body.issues) {
      assert.strictEqual(issue.in_progress, null);
    }
  } finally {
    server.close();
  }
});
