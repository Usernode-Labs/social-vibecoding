// Tests for the `close_issue` governance kind (src/routes/issues.js):
// creation validation (open-target verification, dedupe, reason cap),
// the vote-apply helper maybeApplyCloseIssueProposal (superseded guard,
// gate, GitHub close-then-comment, bounty voiding, cache sync), and the
// admin force-apply route accepting the new kind.
//
// Like the sibling suites (withdraw-gov-proposal.test.js), collaborators
// are stubbed via require.cache and handlers are driven directly off the
// router stack — no HTTP server, no real GitHub.
//
// Run with: node --test tests/close-issue-proposal.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// ── Mock pool ───────────────────────────────────────────────────────────
// First matching [regex, rows] handler wins; every call is recorded.
// connect() returns a client sharing the same handlers/calls so the apply
// helper's transaction is observable.
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
    async connect() {
      return { query, release() {} };
    },
    issued(re) { return calls.find((c) => re.test(c.sql)); },
    issuedAll(re) { return calls.filter((c) => re.test(c.sql)); },
  };
}

const APP = { id: 9, slug: 'cool-app', repo_url: 'https://github.com/acme/cool-app' };

// ── Load routes/issues with stubbed collaborators ─────────────────────────
// `gh` scripts the GitHub surface per test; `spies` records side effects.
function loadIssues(pool, { gh = {}, active = 2 } = {}) {
  const realActiveUsers = require('../src/services/active-users');
  const ids = {
    pool: require.resolve('../src/db/pool'),
    ws: require.resolve('../src/services/ws'),
    github: require.resolve('../src/services/github'),
    appAccess: require.resolve('../src/services/app-access'),
    activeUsers: require.resolve('../src/services/active-users'),
    adminApproval: require.resolve('../src/services/admin-approval'),
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
    createIssue: async (owner, repo, args) => {
      spies.ghCalls.push({ type: 'createIssue', owner, repo, args });
      return { number: 777 };
    },
    noteIssueCreated: () => {},
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
  stub(ids.activeUsers, {
    ...realActiveUsers,
    getActiveUserStats: async () => ({ active, majority: Math.floor(active / 2) + 1 }),
  });
  stub(ids.adminApproval, { isAppLocked: async () => false, hasAdminUpVote: async () => true });

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

// Pull the LAST handler for a route off the router stack (skips the
// rate-limit middleware on the create route).
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

const OPEN_LIST = { issues: [{ number: 42, title: 'Dark mode resets' }], truncatedList: false };

const CLOSE_PROPOSAL = (over) => ({
  id: 61, app_id: 9, created_by: 42, kind: 'close_issue', status: 'open',
  github_issue_number: null,
  title: 'Close issue #42: "Dark mode resets"',
  payload: { issueNumber: 42, issueTitle: 'Dark mode resets', reason: 'Already fixed.' },
  created_at: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
  app_slug: 'cool-app',
  ...over,
});

// ── Creation ─────────────────────────────────────────────────────────────

test('create: happy path files a vote-only proposal, no GitHub twin', async () => {
  const pool = makePool([
    [/kind = 'close_issue' AND status = 'open'/, []],
    [/INSERT INTO issues/, (params) => [{ id: 61, app_id: 9, kind: 'close_issue', payload: JSON.parse(params[5]) }]],
  ]);
  const { router, spies, restore } = loadIssues(pool, {
    gh: { fetchPublicIssues: async () => OPEN_LIST },
  });
  try {
    const handler = routeHandler(router, '/api/apps/:slug/issues');
    const res = mockRes();
    await handler({
      params: { slug: 'cool-app' },
      user: { id: 42, username: 'maker' },
      body: { kind: 'close_issue', payload: { issueNumber: 42, reason: '  Already fixed.  ' } },
    }, res);

    assert.equal(res.statusCode, 201);
    const ins = pool.issued(/INSERT INTO issues/);
    assert.ok(ins, 'INSERT issued');
    assert.equal(ins.params[1], null, 'github_issue_number stays NULL (target lives in payload)');
    assert.equal(ins.params[4], 'close_issue');
    const payload = JSON.parse(ins.params[5]);
    assert.equal(payload.issueNumber, 42);
    assert.equal(payload.issueTitle, 'Dark mode resets');
    assert.equal(payload.reason, 'Already fixed.', 'reason trimmed');
    assert.match(ins.params[2], /^Close issue #42: "Dark mode resets"/, 'auto title');
    assert.equal(ins.params[3], 'Already fixed.', 'description = reason');

    // No twin created.
    assert.equal(spies.ghCalls.filter((c) => c.type === 'createIssue').length, 0);

    // Group line + governance-thread + target-issue-thread dual-posts.
    assert.equal(spies.systemMessages.length, 3);
    assert.match(spies.systemMessages[0][2], /proposed closing issue #42/);
    assert.deepEqual(spies.systemMessages[1][5], { type: 'governance', ref: 61 });
    assert.deepEqual(spies.systemMessages[2][5], { type: 'issue', ref: 42 });

    assert.equal(spies.issueUpdates[0].action, 'created');
    assert.equal(spies.issueUpdates[0].kind, 'close_issue');
  } finally { restore(); }
});

test('create: rejects a target that is not an open issue (404)', async () => {
  const pool = makePool([]);
  const { router, restore } = loadIssues(pool, {
    gh: { fetchPublicIssues: async () => ({ issues: [{ number: 7, title: 'other' }] }) },
  });
  try {
    const handler = routeHandler(router, '/api/apps/:slug/issues');
    const res = mockRes();
    await handler({
      params: { slug: 'cool-app' }, user: { id: 42, username: 'maker' },
      body: { kind: 'close_issue', payload: { issueNumber: 42 } },
    }, res);
    assert.equal(res.statusCode, 404);
    assert.ok(!pool.issued(/INSERT INTO issues/), 'nothing inserted');
  } finally { restore(); }
});

test('create: refuses on a degraded fetch (422) — no positive confirmation', async () => {
  const pool = makePool([]);
  const { router, restore } = loadIssues(pool, {
    gh: { fetchPublicIssues: async () => ({ issues: [], note: 'rate limited' }) },
  });
  try {
    const handler = routeHandler(router, '/api/apps/:slug/issues');
    const res = mockRes();
    await handler({
      params: { slug: 'cool-app' }, user: { id: 42, username: 'maker' },
      body: { kind: 'close_issue', payload: { issueNumber: 42 } },
    }, res);
    assert.equal(res.statusCode, 422);
    assert.ok(!pool.issued(/INSERT INTO issues/));
  } finally { restore(); }
});

test('create: rejects a duplicate open close proposal (409)', async () => {
  const pool = makePool([
    [/kind = 'close_issue' AND status = 'open'/, [{ id: 5 }]],
  ]);
  const { router, restore } = loadIssues(pool, {
    gh: { fetchPublicIssues: async () => OPEN_LIST },
  });
  try {
    const handler = routeHandler(router, '/api/apps/:slug/issues');
    const res = mockRes();
    await handler({
      params: { slug: 'cool-app' }, user: { id: 42, username: 'maker' },
      body: { kind: 'close_issue', payload: { issueNumber: 42 } },
    }, res);
    assert.equal(res.statusCode, 409);
    assert.ok(!pool.issued(/INSERT INTO issues/));
  } finally { restore(); }
});

test('create: rejects a bad issueNumber (400) and an over-long reason (400)', async () => {
  const pool = makePool([]);
  const { router, restore } = loadIssues(pool, {
    gh: { fetchPublicIssues: async () => OPEN_LIST },
  });
  try {
    const handler = routeHandler(router, '/api/apps/:slug/issues');
    for (const payload of [{ issueNumber: 0 }, { issueNumber: 'x' }, {}]) {
      const res = mockRes();
      await handler({
        params: { slug: 'cool-app' }, user: { id: 42, username: 'maker' },
        body: { kind: 'close_issue', payload },
      }, res);
      assert.equal(res.statusCode, 400);
    }
    const res = mockRes();
    await handler({
      params: { slug: 'cool-app' }, user: { id: 42, username: 'maker' },
      body: { kind: 'close_issue', payload: { issueNumber: 42, reason: 'x'.repeat(2001) } },
    }, res);
    assert.equal(res.statusCode, 400);
    assert.ok(!pool.issued(/INSERT INTO issues/));
  } finally { restore(); }
});

// ── Vote apply (maybeApplyCloseIssueProposal) ────────────────────────────

function applyPool({ up = 2, down = 0, lockedRow, bountyRows = [{ id: 1 }] } = {}) {
  return makePool([
    [/SELECT slug, repo_url FROM apps/, [{ slug: APP.slug, repo_url: APP.repo_url }]],
    [/vote = 'up'/, [{ cnt: String(up) }]],
    [/vote = 'down'/, [{ cnt: String(down) }]],
    [/SELECT \* FROM issues WHERE id = \$1 FOR UPDATE/, [lockedRow]],
    [/UPDATE issues SET status = 'closed', payload = \$1/, []],
    [/UPDATE issues SET status = 'closed'\s+WHERE app_id/, []],
    [/UPDATE issue_bounties SET status = 'voided'/, bountyRows],
    [/SELECT username FROM users/, [{ username: 'maker' }]],
  ]);
}

test('apply: passing vote closes the proposal, GitHub close then comment with reason, voids bounties, syncs caches', async () => {
  const proposal = CLOSE_PROPOSAL();
  const pool = applyPool({ up: 2, down: 0, lockedRow: proposal });
  const { subject, spies, restore } = loadIssues(pool, {
    active: 2,
    gh: { fetchPublicIssues: async () => OPEN_LIST }, // target still open → guard passes
  });
  try {
    const r = await subject.maybeApplyCloseIssueProposal(pool, proposal);
    assert.equal(r.applied, true);
    assert.equal(r.issueNumber, 42);

    // Proposal row closed with an audit payload.
    const upd = pool.issued(/UPDATE issues SET status = 'closed', payload = \$1/);
    assert.ok(upd, 'proposal close UPDATE issued');
    const audit = JSON.parse(upd.params[0]);
    assert.equal(audit.appliedBy, 'group-vote');
    assert.ok(audit.appliedAt);
    assert.equal(audit.issueNumber, 42, 'original payload preserved');

    // Internal general twin rows for the target closed too.
    const twin = pool.issued(/UPDATE issues SET status = 'closed'\s+WHERE app_id = \$1 AND github_issue_number = \$2/);
    assert.ok(twin, 'internal twin close issued');
    assert.equal(twin.params[1], 42);

    // Open bounties voided (no awardee).
    const voided = pool.issued(/UPDATE issue_bounties SET status = 'voided'/);
    assert.ok(voided, 'bounty voiding issued');
    assert.deepEqual(voided.params, [9, 42]);
    assert.ok(!/awarded_user_id/.test(voided.sql), 'no awardee credited');

    // GitHub: close BEFORE comment; comment carries tally + proposer reason.
    const ghSeq = spies.ghCalls.filter((c) => ['closeIssue', 'createIssueComment'].includes(c.type));
    assert.deepEqual(ghSeq.map((c) => c.type), ['closeIssue', 'createIssueComment']);
    assert.equal(ghSeq[0].issueNumber, 42);
    assert.match(ghSeq[1].body, /Closed by group vote \(2\//);
    assert.match(ghSeq[1].body, /maker's reason: Already fixed\./);

    // Cache/UI sync: suppression + bust + github_synced broadcast.
    const noted = spies.ghCalls.find((c) => c.type === 'noteIssuesClosed');
    assert.deepEqual(noted.numbers, [42]);
    assert.ok(spies.ghCalls.find((c) => c.type === 'invalidateIssuesCache'));
    assert.ok(spies.issueUpdates.find((u) => u.action === 'github_synced'));

    // Chat: group line + governance-thread + issue-thread dual-posts.
    assert.equal(spies.systemMessages.length, 3);
    assert.match(spies.systemMessages[0][2], /Issue #42 closed by group vote \(2\//);
    assert.deepEqual(spies.systemMessages[1][5], { type: 'governance', ref: 61 });
    assert.deepEqual(spies.systemMessages[2][5], { type: 'issue', ref: 42 });
  } finally { restore(); }
});

test('apply: below the gate leaves the proposal open (no txn, no GitHub)', async () => {
  // Fresh proposal, large active count → threshold far from met.
  const proposal = CLOSE_PROPOSAL({ created_at: new Date().toISOString() });
  const pool = applyPool({ up: 1, down: 0, lockedRow: proposal });
  const { subject, spies, restore } = loadIssues(pool, {
    active: 20,
    gh: { fetchPublicIssues: async () => OPEN_LIST },
  });
  try {
    const r = await subject.maybeApplyCloseIssueProposal(pool, proposal);
    assert.equal(r.applied, false);
    assert.ok(!r.superseded);
    assert.ok(!pool.issued(/UPDATE issues SET status = 'closed'/), 'row untouched');
    assert.equal(spies.ghCalls.filter((c) => c.type === 'closeIssue').length, 0);
  } finally { restore(); }
});

test('apply: superseded guard — healthy list without the target resolves instead of applying', async () => {
  const proposal = CLOSE_PROPOSAL();
  const pool = makePool([
    [/SELECT slug, repo_url FROM apps/, [{ slug: APP.slug, repo_url: APP.repo_url }]],
    // Resolver's lookup + guarded flip.
    [/kind = 'close_issue' AND status = 'open'/, [{ id: 61, app_id: 9, payload: proposal.payload }]],
    [/UPDATE issues SET status = 'closed', payload = \$2/, [{ id: 61 }]],
  ]);
  const { subject, spies, restore } = loadIssues(pool, {
    active: 2,
    gh: { fetchPublicIssues: async () => ({ issues: [], truncatedList: false }) }, // healthy, target gone
  });
  try {
    const r = await subject.maybeApplyCloseIssueProposal(pool, proposal);
    assert.deepEqual(r, { applied: false, superseded: true });

    const upd = pool.issued(/UPDATE issues SET status = 'closed', payload = \$2/);
    assert.ok(upd, 'resolver flipped the row');
    const audit = JSON.parse(upd.params[1]);
    assert.equal(audit.supersededBy, 'github-close');
    assert.ok(audit.supersededAt);

    // No GitHub writes, no bounty changes.
    assert.equal(spies.ghCalls.filter((c) => ['closeIssue', 'createIssueComment'].includes(c.type)).length, 0);
    assert.ok(!pool.issued(/issue_bounties/), 'bounties untouched');
    assert.match(spies.systemMessages[0][2], /resolved automatically — the issue was closed on GitHub/);
  } finally { restore(); }
});

test('apply: degraded fetch skips the superseded guard and proceeds to the gate', async () => {
  const proposal = CLOSE_PROPOSAL({ created_at: new Date().toISOString() });
  const pool = applyPool({ up: 1, down: 0, lockedRow: proposal });
  const { subject, restore } = loadIssues(pool, {
    active: 20,
    gh: { fetchPublicIssues: async () => ({ issues: [], note: 'rate limited' }) },
  });
  try {
    const r = await subject.maybeApplyCloseIssueProposal(pool, proposal);
    assert.equal(r.applied, false);
    assert.ok(!r.superseded, 'degraded fetch must not supersede');
    assert.ok(pool.issued(/vote = 'up'/), 'gate evaluation ran');
  } finally { restore(); }
});

test('apply: GitHub close failure is warn-and-continue (row already closed)', async () => {
  const proposal = CLOSE_PROPOSAL();
  const pool = applyPool({ up: 2, down: 0, lockedRow: proposal });
  const { subject, restore } = loadIssues(pool, {
    active: 2,
    gh: {
      fetchPublicIssues: async () => OPEN_LIST,
      closeIssue: async () => { const e = new Error('boom'); e.status = 500; throw e; },
    },
  });
  try {
    const r = await subject.maybeApplyCloseIssueProposal(pool, proposal);
    assert.equal(r.applied, true, 'apply result unaffected by GitHub failure');
    assert.ok(pool.issued(/UPDATE issues SET status = 'closed', payload = \$1/));
  } finally { restore(); }
});

// ── Admin force-apply route ───────────────────────────────────────────────

test('admin-apply: accepts close_issue with force (gates bypassed); non-admin 403', async () => {
  const proposal = CLOSE_PROPOSAL({ created_at: new Date().toISOString() });
  const pool = makePool([
    [/SELECT i\.\*, a\.slug AS app_slug/, [proposal]],
    [/SELECT slug, repo_url FROM apps/, [{ slug: APP.slug, repo_url: APP.repo_url }]],
    [/vote = 'up'/, [{ cnt: '0' }]],
    [/vote = 'down'/, [{ cnt: '0' }]],
    [/SELECT \* FROM issues WHERE id = \$1 FOR UPDATE/, [proposal]],
    [/SELECT username FROM users/, [{ username: 'maker' }]],
  ]);
  const { router, spies, restore } = loadIssues(pool, {
    active: 20,
    gh: { fetchPublicIssues: async () => OPEN_LIST },
  });
  try {
    const handler = routeHandler(router, '/api/issues/:id/admin-apply');

    const denied = mockRes();
    await handler({ params: { id: '61' }, user: { id: 1, username: 'pleb' } }, denied);
    assert.equal(denied.statusCode, 403);

    const res = mockRes();
    await handler({ params: { id: '61' }, user: { id: 2, username: 'boss', canAdminWrite: true } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.applied.applied, true, 'force apply succeeded with zero votes');
    assert.equal(res.body.secretChanged, null, 'BC alias null for close_issue');

    const upd = pool.issued(/UPDATE issues SET status = 'closed', payload = \$1/);
    const audit = JSON.parse(upd.params[0]);
    assert.equal(audit.appliedBy, 'admin:boss');
    const comment = spies.ghCalls.find((c) => c.type === 'createIssueComment');
    assert.match(comment.body, /admin override \(boss\)/);
  } finally { restore(); }
});

// ── Twin policy ───────────────────────────────────────────────────────────

test('shouldCreateGithubTwin: false for close_issue and secret_change, true otherwise', () => {
  const { shouldCreateGithubTwin } = require('../src/routes/issues');
  assert.equal(shouldCreateGithubTwin('close_issue'), false);
  assert.equal(shouldCreateGithubTwin('secret_change'), false);
  assert.equal(shouldCreateGithubTwin('general'), true);
});
