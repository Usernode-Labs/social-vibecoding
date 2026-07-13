// Tests for #529: POST /api/apps/:slug/issues/:number/complete — the
// admin-only "mark task complete without implementation" route in
// src/routes/issues.js. Verifies the admin gate, the upsert of a terminal
// status='completed' row with its audit payload (both the existing-row and
// GitHub-native insert paths), bounty voiding, the GitHub close + comment,
// and idempotency under a double call.
//
// Mirrors close-issue-proposal.test.js: collaborators/GitHub are stubbed via
// require.cache and the handler is driven directly off the router stack.
//
// Run with: node --test tests/mark-complete-route.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function makePool(handlers) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    for (const [re, rows] of handlers) {
      if (re.test(sql)) {
        return { rows: typeof rows === 'function' ? rows(params) : rows };
      }
    }
    return { rows: [] };
  };
  return {
    calls,
    query,
    async connect() { return { query, release() {} }; },
    issued(re) { return calls.find((c) => re.test(c.sql)); },
    issuedAll(re) { return calls.filter((c) => re.test(c.sql)); },
  };
}

const APP = { id: 9, slug: 'cool-app', repo_url: 'https://github.com/acme/cool-app' };

function loadIssues(pool, { gh = {} } = {}) {
  const ids = {
    pool: require.resolve('../src/db/pool'),
    ws: require.resolve('../src/services/ws'),
    github: require.resolve('../src/services/github'),
    appAccess: require.resolve('../src/services/app-access'),
    subject: require.resolve('../src/routes/issues'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const spies = { systemMessages: [], issueUpdates: [], ghCalls: [] };
  const stub = (id, exports) => {
    require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
  };

  stub(ids.pool, { getPool: () => pool });
  const realWs = orig.ws ? orig.ws.exports : require('../src/services/ws');
  stub(ids.ws, {
    ...realWs,
    sendSystemMessage: async (...args) => { spies.systemMessages.push(args); },
    pushIssueUpdate: (data) => { spies.issueUpdates.push(data); },
    pushAppUpdate: () => {},
  });
  stub(ids.github, {
    isEnabled: () => (gh.isEnabled ? gh.isEnabled() : true),
    safeMention: (s) => s,
    fetchPublicIssues: async (owner, repo) => {
      spies.ghCalls.push({ type: 'fetchPublicIssues', owner, repo });
      return gh.fetchPublicIssues
        ? gh.fetchPublicIssues(owner, repo)
        : { issues: [], truncatedList: false };
    },
    closeIssue: async (owner, repo, issueNumber) => {
      spies.ghCalls.push({ type: 'closeIssue', owner, repo, issueNumber });
      if (gh.closeIssue) return gh.closeIssue(owner, repo, issueNumber);
      return { number: issueNumber, state: 'closed' };
    },
    createIssueComment: async (owner, repo, issueNumber, body) => {
      spies.ghCalls.push({ type: 'createIssueComment', owner, repo, issueNumber, body });
      return { id: 1 };
    },
    noteIssuesClosed: (owner, repo, numbers) => {
      spies.ghCalls.push({ type: 'noteIssuesClosed', owner, repo, numbers: [...numbers] });
    },
    invalidateIssuesCache: (owner, repo) => {
      spies.ghCalls.push({ type: 'invalidateIssuesCache', owner, repo });
    },
  });
  stub(ids.appAccess, {
    ACCESS_COLUMNS: '*',
    issueCollabGuard: () => (_req, _res, next) => next(),
    getAppForUser: async () => ({ ...APP }),
  });

  delete require.cache[ids.subject];
  const subject = require('../src/routes/issues');
  const router = subject.issueRoutes({ databaseUrl: 'postgres://test', jwtSecret: 's' });

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
    delete require.cache[ids.subject];
  };
  return { subject, router, spies, restore };
}

function routeHandler(router, path, method = 'post') {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method]) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error(`${method} ${path} route not found`);
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

const PATH = '/api/apps/:slug/issues/:number/complete';
const OPEN_LIST = { issues: [{ number: 42, title: 'Dark mode resets' }], truncatedList: false };

test('non-admin is refused with 403 and changes nothing', async () => {
  const pool = makePool([]);
  const { router, restore } = loadIssues(pool);
  try {
    const handler = routeHandler(router, PATH);
    const res = mockRes();
    await handler({
      params: { slug: 'cool-app', number: '42' },
      user: { id: 1, username: 'pleb' },
      body: {},
    }, res);
    assert.equal(res.statusCode, 403);
    assert.ok(!pool.issued(/UPDATE issues/), 'nothing updated');
    assert.ok(!pool.issued(/INSERT INTO issues/), 'nothing inserted');
  } finally { restore(); }
});

test('rejects a bad issue number (400)', async () => {
  const pool = makePool([]);
  const { router, restore } = loadIssues(pool);
  try {
    const handler = routeHandler(router, PATH);
    for (const number of ['0', 'x', '-3']) {
      const res = mockRes();
      await handler({
        params: { slug: 'cool-app', number },
        user: { id: 2, username: 'boss', canAdminWrite: true },
        body: {},
      }, res);
      assert.equal(res.statusCode, 400);
    }
  } finally { restore(); }
});

test('rejects an over-long note (400)', async () => {
  const pool = makePool([]);
  const { router, restore } = loadIssues(pool);
  try {
    const handler = routeHandler(router, PATH);
    const res = mockRes();
    await handler({
      params: { slug: 'cool-app', number: '42' },
      user: { id: 2, username: 'boss', canAdminWrite: true },
      body: { note: 'x'.repeat(2001) },
    }, res);
    assert.equal(res.statusCode, 400);
    assert.ok(!pool.issued(/UPDATE issues/));
  } finally { restore(); }
});

test('existing internal row → flips to completed with the audit payload, voids bounties, closes on GitHub', async () => {
  const pool = makePool([
    [/SELECT id FROM issues[\s\S]*FOR UPDATE/, [{ id: 55 }]],
    [/UPDATE issues\s+SET status = 'completed',\s+payload = COALESCE/, [{ id: 55 }]],
    [/UPDATE issues SET status = 'completed'\s+WHERE app_id/, []],
    [/UPDATE issue_bounties SET status = 'voided'/, [{ id: 1 }]],
  ]);
  const { router, spies, restore } = loadIssues(pool, {
    gh: { fetchPublicIssues: async () => OPEN_LIST },
  });
  try {
    const handler = routeHandler(router, PATH);
    const res = mockRes();
    await handler({
      params: { slug: 'cool-app', number: '42' },
      user: { id: 2, username: 'snait', canAdminWrite: true },
      body: { note: '  Handled offchain  ', title: 'Dark mode resets' },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.completed, true);
    assert.equal(res.body.issueNumber, 42);

    // Primary row flipped to completed with a merged audit payload.
    const upd = pool.issued(/UPDATE issues\s+SET status = 'completed',\s+payload = COALESCE/);
    assert.ok(upd, 'completed UPDATE issued');
    const audit = JSON.parse(upd.params[1]);
    assert.equal(audit.resolution, 'completed');
    assert.equal(audit.completedBy, 2);
    assert.equal(audit.completedByUsername, 'snait');
    assert.equal(audit.note, 'Handled offchain', 'note trimmed');
    assert.equal(audit.issueTitle, 'Dark mode resets');
    assert.ok(audit.completedAt);

    // No INSERT on the existing-row path.
    assert.ok(!pool.issued(/INSERT INTO issues/), 'existing row is updated, not inserted');

    // Twin open rows for the same number closed too.
    assert.ok(pool.issued(/UPDATE issues SET status = 'completed'\s+WHERE app_id/), 'twin flip issued');

    // Open bounties voided (no awardee).
    const voided = pool.issued(/UPDATE issue_bounties SET status = 'voided'/);
    assert.ok(voided, 'bounty voiding issued');
    assert.deepEqual(voided.params, [9, 42]);

    // GitHub: close BEFORE comment; comment names the admin + note.
    const ghSeq = spies.ghCalls.filter((c) => ['closeIssue', 'createIssueComment'].includes(c.type));
    assert.deepEqual(ghSeq.map((c) => c.type), ['closeIssue', 'createIssueComment']);
    assert.equal(ghSeq[0].issueNumber, 42);
    assert.match(ghSeq[1].body, /Marked complete without code changes by @snait/);
    assert.match(ghSeq[1].body, /Note: Handled offchain/);

    // Cache/UI sync + completion broadcast.
    assert.ok(spies.ghCalls.find((c) => c.type === 'noteIssuesClosed'));
    assert.ok(spies.ghCalls.find((c) => c.type === 'invalidateIssuesCache'));
    const upd2 = spies.issueUpdates.find((u) => u.action === 'completed');
    assert.ok(upd2, 'completed issue_update broadcast');
    assert.equal(upd2.number, 42);

    // Chat: group line + governance-thread + issue-thread dual-posts.
    assert.equal(spies.systemMessages.length, 3);
    assert.match(spies.systemMessages[0][2], /Task #42 marked complete without implementation by snait/);
    assert.deepEqual(spies.systemMessages[2][5], { type: 'issue', ref: 42 });
  } finally { restore(); }
});

test('GitHub-native issue with no internal row → inserts a completed general row', async () => {
  const pool = makePool([
    [/SELECT id FROM issues[\s\S]*FOR UPDATE/, []], // no existing row
    [/INSERT INTO issues/, (params) => [{ id: 88 }]],
    [/UPDATE issue_bounties SET status = 'voided'/, []],
  ]);
  const { router, spies, restore } = loadIssues(pool, {
    gh: { fetchPublicIssues: async () => OPEN_LIST },
  });
  try {
    const handler = routeHandler(router, PATH);
    const res = mockRes();
    await handler({
      params: { slug: 'cool-app', number: '42' },
      user: { id: 2, username: 'snait', canAdminWrite: true },
      body: {}, // no title → resolved from the live GitHub fetch
    }, res);

    assert.equal(res.statusCode, 200);
    const ins = pool.issued(/INSERT INTO issues/);
    assert.ok(ins, 'INSERT issued');
    assert.equal(ins.params[1], 42, 'github_issue_number');
    assert.equal(ins.params[2], 'Dark mode resets', 'title resolved from GitHub');
    const audit = JSON.parse(ins.params[4]);
    assert.equal(audit.resolution, 'completed');
    assert.equal(audit.note, null, 'no note → null');
    assert.equal(spies.issueUpdates.find((u) => u.action === 'completed')?.number, 42);
  } finally { restore(); }
});

test('idempotent: a second complete on an already-completed number is a no-op flip', async () => {
  // The FOR UPDATE lock finds the row (now completed); the primary UPDATE
  // simply re-writes the same terminal state — no INSERT, still a 200.
  const pool = makePool([
    [/SELECT id FROM issues[\s\S]*FOR UPDATE/, [{ id: 55 }]],
    [/UPDATE issues\s+SET status = 'completed',\s+payload = COALESCE/, [{ id: 55 }]],
    [/UPDATE issue_bounties SET status = 'voided'/, []],
  ]);
  const { router, restore } = loadIssues(pool, {
    gh: { fetchPublicIssues: async () => OPEN_LIST },
  });
  try {
    const handler = routeHandler(router, PATH);
    const res1 = mockRes();
    const req = {
      params: { slug: 'cool-app', number: '42' },
      user: { id: 2, username: 'snait', canAdminWrite: true },
      body: { title: 'Dark mode resets' },
    };
    await handler(req, res1);
    const res2 = mockRes();
    await handler(req, res2);
    assert.equal(res1.statusCode, 200);
    assert.equal(res2.statusCode, 200);
    assert.equal(pool.issuedAll(/INSERT INTO issues/).length, 0, 'never inserts');
  } finally { restore(); }
});
