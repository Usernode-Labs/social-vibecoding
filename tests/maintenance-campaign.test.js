// Tests for maintenance campaigns (#853's generalization):
// - the `maintenance_campaign` governance kind in src/routes/issues.js
//   (creation validation, admin force-apply gating; the governance machine
//   applies it: tests/workflow-governance-postgres.test.js),
// - the campaign's I/O in src/services/fleet-maintenance.js (the per-app
//   AI tool loop, the push and the pull request its work makes; the campaign
//   machine itself: tests/workflow-campaign-postgres.test.js),
// - the dashboard API gating in src/routes/campaigns.js.
//
// Like the sibling suites (close-issue-proposal.test.js), collaborators
// are stubbed via require.cache and handlers are driven directly off
// the router stack — no HTTP server, no real GitHub, no real LLM.
//
// Run with: node --test tests/maintenance-campaign.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// ── Mock pool ───────────────────────────────────────────────────────────
// First matching [regex, rows] handler wins; every call is recorded.
// connect() returns a client sharing the same handlers/calls so the
// apply helper's transaction is observable.
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

const SELF_APP = {
  id: 1, slug: 'usernode-social', repo_url: 'https://github.com/acme/sv', self_hosted: true,
};
const CHILD_APP = {
  id: 9, slug: 'cool-app', repo_url: 'https://github.com/acme/cool-app', self_hosted: false,
};

// ── Load routes/issues with stubbed collaborators ────────────────────────
function loadIssues(pool, { gh = {}, active = 2, app = SELF_APP, gate = {} } = {}) {
  const realActiveUsers = require('../src/services/active-users');
  const ids = {
    pool: require.resolve('../src/db/pool'),
    ws: require.resolve('../src/services/ws'),
    github: require.resolve('../src/services/github'),
    appAccess: require.resolve('../src/services/app-access'),
    activeUsers: require.resolve('../src/services/active-users'),
    adminApproval: require.resolve('../src/services/admin-approval'),
    governance: require.resolve('../src/services/governance'),
    workflow: require.resolve('../src/workflow/platform.ts'),
    subject: require.resolve('../src/routes/issues'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const spies = { systemMessages: [], issueUpdates: [], ghCalls: [], adminApplied: [] };
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
    fetchPublicIssues: async () => ({ issues: [], truncatedList: false }),
    createIssue: async (owner, repo, args) => {
      spies.ghCalls.push({ type: 'createIssue', owner, repo, args });
      return { number: 777 };
    },
    noteIssueCreated: () => {},
    closeIssue: async () => ({}),
    createIssueComment: async () => ({ id: 1 }),
    noteIssuesClosed: () => {},
    invalidateIssuesCache: () => {},
  });
  stub(ids.appAccess, {
    ACCESS_COLUMNS: '*',
    issueCollabGuard: () => (_req, _res, next) => next(),
    getAppForUser: async () => ({ ...app }),
  });
  stub(ids.activeUsers, {
    ...realActiveUsers,
    getActiveUserStats: async () => ({ active, majority: Math.floor(active / 2) + 1 }),
  });
  stub(ids.adminApproval, { isAppLocked: async () => false });
  stub(ids.workflow, {
    async fileProposal() {},
    async adminApplyProposal(issue, user) {
      spies.adminApplied.push([issue.id, user.username]);
      return { status: 200, body: { ok: true, applied: { applied: true, campaignId: 34 }, secretChanged: null } };
    },
  });
  // Any read of the gate is scripted directly (its math has its own suite).
  const realGovernance = orig.governance ? orig.governance.exports : require('../src/services/governance');
  stub(ids.governance, {
    ...realGovernance,
    governedGate: async () => ({
      qualifiedYes: 2, activeCount: active, required: 2, mergeable: true,
      thresholdMet: true, lazyArmed: false, windowElapsed: true, windowEndsAt: null,
      ...gate,
    }),
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

const CAMPAIGN_PROPOSAL = (over) => ({
  id: 71, app_id: 1, created_by: 42, kind: 'maintenance_campaign', status: 'open',
  github_issue_number: null,
  title: 'Maintenance campaign: Switch JWT verification to RS256',
  payload: {
    title: 'Switch JWT verification to RS256',
    instructions: 'Replace JWT_SECRET reads with USERNODE_JWT_PUBLIC_KEY and verify with RS256.',
  },
  created_at: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
  app_slug: 'usernode-social',
  ...over,
});

// ── Creation ─────────────────────────────────────────────────────────────

test('create: happy path files a vote-only proposal on the self-app, admin-authored', async () => {
  const pool = makePool([
    [/INSERT INTO issues/, (params) => [{
      id: 71, app_id: 1, kind: 'maintenance_campaign', payload: JSON.parse(params[5]),
    }]],
  ]);
  const { router, spies, restore } = loadIssues(pool);
  try {
    const handler = routeHandler(router, '/api/apps/:slug/issues');
    const res = mockRes();
    await handler({
      params: { slug: 'usernode-social' },
      user: { id: 42, username: 'boss', isAdmin: true, canAdminWrite: true },
      body: {
        kind: 'maintenance_campaign',
        title: '  Switch JWT verification to RS256  ',
        payload: {
          instructions: '  Replace JWT_SECRET with USERNODE_JWT_PUBLIC_KEY.  ',
          targetFilter: [' echo ', 'lastwin', ''],
          junk: 'dropped',
        },
      },
    }, res);

    assert.equal(res.statusCode, 201);
    const ins = pool.issued(/INSERT INTO issues/);
    assert.ok(ins, 'INSERT issued');
    assert.equal(ins.params[1], null, 'no GitHub twin number');
    assert.equal(ins.params[4], 'maintenance_campaign');
    const payload = JSON.parse(ins.params[5]);
    assert.equal(payload.title, 'Switch JWT verification to RS256', 'raw title trimmed into payload');
    assert.equal(payload.instructions, 'Replace JWT_SECRET with USERNODE_JWT_PUBLIC_KEY.');
    assert.deepEqual(payload.targetFilter, ['echo', 'lastwin'], 'slugs trimmed, empties dropped');
    assert.equal(payload.junk, undefined, 'unknown payload keys dropped');
    assert.match(ins.params[2], /^Maintenance campaign: Switch JWT/, 'display title prefixed');
    assert.match(ins.params[3], /2 selected app\(s\)/, 'auto description names the target count');

    // Vote-only: no GitHub twin.
    assert.equal(spies.ghCalls.filter((c) => c.type === 'createIssue').length, 0);

    // The governance thread only; a channel carries no activity.
    assert.equal(spies.systemMessages.length, 1);
    assert.match(spies.systemMessages[0][2], /proposed a maintenance campaign: "Switch JWT/);
    assert.deepEqual(spies.systemMessages[0][5], { type: 'governance', ref: 71 });
  } finally { restore(); }
});

test('create: rejected on a non-self-hosted app (400)', async () => {
  const pool = makePool([]);
  const { router, restore } = loadIssues(pool, { app: CHILD_APP });
  try {
    const handler = routeHandler(router, '/api/apps/:slug/issues');
    const res = mockRes();
    await handler({
      params: { slug: 'cool-app' },
      user: { id: 42, username: 'boss', isAdmin: true, canAdminWrite: true },
      body: { kind: 'maintenance_campaign', title: 'T', payload: { instructions: 'I' } },
    }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /platform app/);
    assert.ok(!pool.issued(/INSERT INTO issues/));
  } finally { restore(); }
});

test('create: rejected without full admin (403) and without instructions (400)', async () => {
  const pool = makePool([]);
  const { router, restore } = loadIssues(pool);
  try {
    const handler = routeHandler(router, '/api/apps/:slug/issues');

    const denied = mockRes();
    await handler({
      params: { slug: 'usernode-social' },
      user: { id: 7, username: 'pleb' },
      body: { kind: 'maintenance_campaign', title: 'T', payload: { instructions: 'I' } },
    }, denied);
    assert.equal(denied.statusCode, 403);

    const viewOnly = mockRes();
    await handler({
      params: { slug: 'usernode-social' },
      user: { id: 8, username: 'watcher', isAdmin: true, canAdminWrite: false },
      body: { kind: 'maintenance_campaign', title: 'T', payload: { instructions: 'I' } },
    }, viewOnly);
    assert.equal(viewOnly.statusCode, 403, 'view-only admin cannot author a campaign');

    const noInstructions = mockRes();
    await handler({
      params: { slug: 'usernode-social' },
      user: { id: 42, username: 'boss', isAdmin: true, canAdminWrite: true },
      body: { kind: 'maintenance_campaign', title: 'T', payload: { instructions: '   ' } },
    }, noInstructions);
    assert.equal(noInstructions.statusCode, 400);

    assert.ok(!pool.issued(/INSERT INTO issues/));
  } finally { restore(); }
});

// ── Admin force-apply route ───────────────────────────────────────────────

test('admin-apply: a full admin\'s force goes to the machine; a view-only admin is refused', async () => {
  const proposal = CAMPAIGN_PROPOSAL({ created_at: new Date().toISOString() });
  const pool = makePool([[/SELECT i\.\*, a\.slug AS app_slug/, [proposal]]]);
  const { router, spies, restore } = loadIssues(pool);
  try {
    const handler = routeHandler(router, '/api/issues/:id/admin-apply');
    const denied = mockRes();
    await handler({
      params: { id: '71' },
      user: { id: 8, username: 'watcher', isAdmin: true, canAdminWrite: false },
    }, denied);
    assert.equal(denied.statusCode, 403, 'view-only admin blocked for this kind');
    assert.deepEqual(spies.adminApplied, []);

    const res = mockRes();
    await handler({
      params: { id: '71' },
      user: { id: 2, username: 'boss', isAdmin: true, canAdminWrite: true },
      get: () => undefined,
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.applied.campaignId, 34);
    assert.deepEqual(spies.adminApplied, [[71, 'boss']]);
    assert.ok(!pool.issued(/INSERT INTO maintenance_campaigns/), 'the route writes nothing itself');
  } finally { restore(); }
});

// ── Twin policy ───────────────────────────────────────────────────────────

test('shouldCreateGithubTwin: false for maintenance_campaign', () => {
  const { shouldCreateGithubTwin } = require('../src/routes/issues');
  assert.equal(shouldCreateGithubTwin('maintenance_campaign'), false);
  assert.equal(shouldCreateGithubTwin('general'), true);
});

// ═══ Engine (services/fleet-maintenance.js) ═══════════════════════════════

// Load the campaign's I/O with github and the model stubbed via
// require.cache.
function loadFleet({ llmScript = [], files = {}, gh = {} } = {}) {
  const ids = {
    github: require.resolve('../src/services/github'),
    llm: require.resolve('../src/services/llm'),
    subject: require.resolve('../src/services/fleet-maintenance'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const spies = { llmCalls: [], ghCalls: [] };
  const stub = (id, exports) => {
    require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
  };

  let llmCallIdx = 0;
  stub(ids.llm, {
    isEnabled: () => true,
    estimateCostCents: () => 1,
    streamChat: async (args) => {
      spies.llmCalls.push(args);
      const next = llmScript[llmCallIdx++];
      if (!next) throw new Error('llm script exhausted');
      return {
        toolUses: [], rawContent: [{ type: 'text', text: 'ok' }],
        stopReason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 },
        servedModel: 'test-model',
        ...next,
      };
    },
  });
  stub(ids.github, {
    isEnabled: () => true,
    getFileContent: async (owner, repo, path) => {
      spies.ghCalls.push({ type: 'getFileContent', path });
      return Object.prototype.hasOwnProperty.call(files, path) ? files[path] : null;
    },
    createBranch: async (owner, repo, branch) => {
      spies.ghCalls.push({ type: 'createBranch', owner, repo, branch });
    },
    getBranchSha: async () => 'a'.repeat(40),
    forceBranchToSha: async (owner, repo, branch, sha) => {
      spies.ghCalls.push({ type: 'forceBranchToSha', branch, sha });
    },
    pushFiles: async (owner, repo, pushed, opts) => {
      spies.ghCalls.push({ type: 'pushFiles', owner, repo, files: pushed, opts });
      return { sha: 'B'.repeat(40) };
    },
    findOpenPrByBranch: async () => null,
    createPR: async (owner, repo, opts) => {
      spies.ghCalls.push({ type: 'createPR', owner, repo, opts });
      return { number: 88, html_url: `https://github.com/${owner}/${repo}/pull/88`, title: opts.title };
    },
    ...gh,
  });

  delete require.cache[ids.subject];
  const subject = require('../src/services/fleet-maintenance');

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
    delete require.cache[ids.subject];
  };
  return { subject, spies, restore };
}

const CAMPAIGN = {
  id: 5, issue_id: 44, title: 'Switch JWT verification to RS256',
  instructions: 'Replace JWT_SECRET with USERNODE_JWT_PUBLIC_KEY.',
  status: 'running', target_filter: null,
};

// ── runAppChange (the per-app tool loop) ──────────────────────────────────

test('runAppChange: read → edit → finish stages the edited file', async () => {
  const { subject, spies, restore } = loadFleet({
    files: { 'server.js': 'const secret = process.env.JWT_SECRET;\nstart();\n' },
    llmScript: [
      { toolUses: [{ id: 't1', name: 'read_file', input: { path: 'server.js' } }] },
      { toolUses: [{ id: 't2', name: 'edit_file', input: {
        path: 'server.js',
        old_string: 'process.env.JWT_SECRET',
        new_string: 'process.env.USERNODE_JWT_PUBLIC_KEY',
      } }] },
      { toolUses: [{ id: 't3', name: 'finish', input: { summary: 'Swapped the env var.' } }] },
    ],
  });
  try {
    const usage = [];
    const out = await subject.runAppChange({
      campaign: CAMPAIGN,
      app: CHILD_APP,
      exemplarSummary: null,
      onUsage: (u, m) => usage.push({ u, m }),
    });
    assert.equal(out.summary, 'Swapped the env var.');
    assert.equal(out.files.get('server.js'),
      'const secret = process.env.USERNODE_JWT_PUBLIC_KEY;\nstart();\n');
    assert.equal(usage.length, 3, 'spend attributed per LLM call');
    // The system prompt carries the operator instructions.
    assert.match(spies.llmCalls[0].systemPrompt, /USERNODE_JWT_PUBLIC_KEY/);
    // Only one repo read — the loop caches file content.
    assert.equal(spies.ghCalls.filter((c) => c.type === 'getFileContent').length, 1);
  } finally { restore(); }
});

test('runAppChange: skip_app resolves without edits; exemplar summary rides the prompt', async () => {
  const { subject, spies, restore } = loadFleet({
    llmScript: [
      { toolUses: [{ id: 't1', name: 'skip_app', input: { reason: 'No JWT usage here.' } }] },
    ],
  });
  try {
    const out = await subject.runAppChange({
      campaign: CAMPAIGN, app: CHILD_APP, exemplarSummary: 'Did X in app Y.',
    });
    assert.deepEqual(out, { skipped: true, reason: 'No JWT usage here.' });
    assert.match(spies.llmCalls[0].systemPrompt, /Did X in app Y\./, 'few-shot carry-forward');
  } finally { restore(); }
});

test('runAppChange: finish without staged edits is a hard failure', async () => {
  const { subject, restore } = loadFleet({
    llmScript: [
      { toolUses: [{ id: 't1', name: 'finish', input: { summary: 'nothing' } }] },
    ],
  });
  try {
    await assert.rejects(
      subject.runAppChange({ campaign: CAMPAIGN, app: CHILD_APP }),
      /finish without staging/
    );
  } finally { restore(); }
});

test('runAppChange: one prose turn is nudged back to tools; a second one fails', async () => {
  const { subject, restore } = loadFleet({
    llmScript: [
      { toolUses: [], stopReason: 'end_turn' },
      { toolUses: [{ id: 't1', name: 'skip_app', input: { reason: 'n/a' } }] },
    ],
  });
  try {
    const out = await subject.runAppChange({ campaign: CAMPAIGN, app: CHILD_APP });
    assert.equal(out.skipped, true, 'recovered after one nudge');
  } finally { restore(); }

  const second = loadFleet({
    llmScript: [
      { toolUses: [], stopReason: 'end_turn' },
      { toolUses: [], stopReason: 'end_turn' },
    ],
  });
  try {
    await assert.rejects(
      second.subject.runAppChange({ campaign: CAMPAIGN, app: CHILD_APP }),
      /without calling finish or skip_app/
    );
  } finally { second.restore(); }
});

test('runAppChange: edit_file rejects a non-unique old_string with a retryable tool error', async () => {
  const { subject, restore } = loadFleet({
    files: { 'a.js': 'x();\nx();\n' },
    llmScript: [
      { toolUses: [{ id: 't1', name: 'edit_file', input: { path: 'a.js', old_string: 'x();', new_string: 'y();' } }] },
      { toolUses: [{ id: 't2', name: 'skip_app', input: { reason: 'gave up' } }] },
    ],
  });
  try {
    const out = await subject.runAppChange({ campaign: CAMPAIGN, app: CHILD_APP });
    assert.equal(out.skipped, true);
  } finally { restore(); }
});

test('runAppChange: search_file returns line-numbered matches, sees staged edits, and reports no matches', async () => {
  const { subject, spies, restore } = loadFleet({
    files: { 'server.js': 'const a = process.env.JWT_SECRET;\nstart();\nverify(process.env.JWT_SECRET);\n' },
    llmScript: [
      { toolUses: [{ id: 't1', name: 'search_file', input: { path: 'server.js', query: 'JWT_SECRET' } }] },
      { toolUses: [{ id: 't2', name: 'edit_file', input: {
        path: 'server.js',
        old_string: 'const a = process.env.JWT_SECRET;',
        new_string: 'const a = process.env.USERNODE_JWT_PUBLIC_KEY;',
      } }] },
      { toolUses: [{ id: 't3', name: 'search_file', input: { path: 'server.js', query: 'USERNODE_JWT_PUBLIC_KEY' } }] },
      { toolUses: [{ id: 't4', name: 'search_file', input: { path: 'server.js', query: 'no_such_token' } }] },
      { toolUses: [{ id: 't5', name: 'finish', input: { summary: 'done' } }] },
    ],
  });
  try {
    await subject.runAppChange({ campaign: CAMPAIGN, app: CHILD_APP });
    // The engine mutates ONE messages array across calls, so read results
    // from the final state by tool_use_id rather than per-call position.
    const finalMessages = spies.llmCalls.at(-1).messages;
    const resultFor = (id) => finalMessages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((c) => c.type === 'tool_result' && c.tool_use_id === id).content;
    const first = resultFor('t1');
    assert.match(first, /2 match\(es\):/);
    assert.match(first, /line 1: const a = process\.env\.JWT_SECRET;/);
    assert.match(first, /line 3: verify\(process\.env\.JWT_SECRET\);/);
    // Search runs against staged content, so the edit is visible.
    assert.match(resultFor('t3'), /line 1: const a = process\.env\.USERNODE_JWT_PUBLIC_KEY;/);
    assert.equal(resultFor('t4'), 'No matches.');
  } finally { restore(); }
});

test('runAppChange: read_file pages through a >100KB file via offset', async () => {
  // Marker beyond the 100 KB window — invisible to a plain read, the
  // exact shape that stranded puzzlechain/block-game in campaign #1.
  const filler = 'x'.repeat(110 * 1024);
  const content = `${filler}\nconst NEEDLE = process.env.JWT_SECRET;\n`;
  const { subject, spies, restore } = loadFleet({
    files: { 'big.js': content },
    llmScript: [
      { toolUses: [{ id: 't1', name: 'read_file', input: { path: 'big.js' } }] },
      { toolUses: [{ id: 't2', name: 'read_file', input: { path: 'big.js', offset: 100 * 1024 } }] },
      { toolUses: [{ id: 't3', name: 'skip_app', input: { reason: 'n/a' } }] },
    ],
  });
  try {
    await subject.runAppChange({ campaign: CAMPAIGN, app: CHILD_APP });
    const finalMessages = spies.llmCalls.at(-1).messages;
    const resultFor = (id) => finalMessages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((c) => c.type === 'tool_result' && c.tool_use_id === id).content;
    const first = resultFor('t1');
    assert.match(first, /showing chars 0–102400/);
    assert.match(first, /offset=102400/, 'truncation note tells the model how to continue');
    assert.ok(!first.includes('NEEDLE'), 'marker is beyond the first window');
    const second = resultFor('t2');
    assert.ok(second.includes('NEEDLE'), 'offset read reaches the tail');
  } finally { restore(); }
});

test('runAppChange: budget exhaustion error carries the tool-call trace', async () => {
  const { subject, restore } = loadFleet({
    files: { 'server.js': 'start();\n' },
    llmScript: Array.from({ length: 30 }, (_, i) => ({
      toolUses: [{
        id: `t${i}`,
        name: i % 2 ? 'search_file' : 'read_file',
        input: i % 2 ? { path: 'server.js', query: 'JWT' } : { path: 'server.js', offset: i * 100 },
      }],
    })),
  });
  try {
    await assert.rejects(
      subject.runAppChange({ campaign: CAMPAIGN, app: CHILD_APP }),
      (err) => {
        assert.match(err.message, /Tool-call budget exhausted \(20 iterations\)/);
        assert.match(err.message, /Tool trace: read_file\(server\.js\)/);
        assert.match(err.message, /search_file\(server\.js "JWT"\)/);
        assert.match(err.message, /read_file\(server\.js@200\)/, 'offsets visible in the trace');
        return true;
      }
    );
  } finally { restore(); }
});

// ── The change on GitHub (the campaign machine's work) ───────────────────

test('pushChange: the campaign\'s branch for the app, at main, then one commit; an earlier attempt\'s branch is moved back to main', async () => {
  const { subject, spies, restore } = loadFleet({});
  const repo = { owner: 'acme', repo: 'cool-app' };
  const files = new Map([['server.js', 'x']]);
  try {
    const head = await subject.pushChange({ repo, branch: 'maint/c5/cool-app', files, message: 'Maintenance: T' });
    assert.equal(head, 'b'.repeat(40));
    assert.deepEqual(spies.ghCalls.map((c) => c.type), ['createBranch', 'pushFiles']);
    assert.equal(spies.ghCalls[0].branch, 'maint/c5/cool-app', 'one name per app: a retry finds it (bug 1)');
  } finally { restore(); }
  const exists = loadFleet({ gh: { createBranch: async () => { throw Object.assign(new Error('Reference already exists'), { status: 422 }); } } });
  try {
    await exists.subject.pushChange({ repo, branch: 'maint/c5/cool-app', files, message: 'M' });
    assert.deepEqual(exists.spies.ghCalls.map((c) => c.type), ['forceBranchToSha', 'pushFiles']);
    assert.equal(exists.spies.ghCalls[0].sha, 'a'.repeat(40), 'back on main before the change is pushed again');
  } finally { exists.restore(); }
});

test('openChangePr: the pull request GitHub already has for the branch is used, never a second one (bug 1)', async () => {
  const campaign = { id: 5, title: 'Switch JWT verification to RS256' };
  const repo = { owner: 'acme', repo: 'cool-app' };
  const fresh = loadFleet({});
  try {
    const pr = await fresh.subject.openChangePr({ repo, branch: 'maint/c5/cool-app', campaign, summary: 'Swapped it.' });
    assert.deepEqual(pr, { number: 88, url: 'https://github.com/acme/cool-app/pull/88', title: campaign.title });
    const created = fresh.spies.ghCalls.find((c) => c.type === 'createPR');
    assert.match(created.opts.body, /maintenance campaign #5/i);
    assert.match(created.opts.body, /Swapped it\./);
  } finally { fresh.restore(); }
  const found = loadFleet({ gh: { findOpenPrByBranch: async () => ({ number: 41, html_url: 'u41', title: 'Earlier' }) } });
  try {
    const pr = await found.subject.openChangePr({ repo, branch: 'maint/c5/cool-app', campaign, summary: '' });
    assert.deepEqual(pr, { number: 41, url: 'u41', title: 'Earlier' });
    assert.equal(found.spies.ghCalls.filter((c) => c.type === 'createPR').length, 0);
  } finally { found.restore(); }
  // Lost the race with an earlier attempt's create: its pull request is the one.
  let looked = 0;
  const raced = loadFleet({ gh: {
    findOpenPrByBranch: async () => (looked++ ? { number: 42, html_url: 'u42', title: 'T' } : null),
    createPR: async () => { throw Object.assign(new Error('A pull request already exists'), { code: 'pr_exists' }); },
  } });
  try {
    assert.equal((await raced.subject.openChangePr({ repo, branch: 'b', campaign, summary: '' })).number, 42);
  } finally { raced.restore(); }
});

test('runAppChange: a change too big or a model gone astray fails at once (permanent); GitHub\'s error is retried', async () => {
  const { subject, restore } = loadFleet({ llmScript: [{ toolUses: [], stopReason: 'max_tokens' }] });
  try {
    await assert.rejects(subject.runAppChange({ campaign: CAMPAIGN, app: CHILD_APP }), (err) => err.permanent === true);
  } finally { restore(); }
  const gh = loadFleet({
    llmScript: [{ toolUses: [{ id: 't1', name: 'read_file', input: { path: 'server.js' } }] }],
    gh: { getFileContent: async () => { throw Object.assign(new Error('Bad gateway'), { status: 502 }); } },
  });
  try {
    await assert.rejects(gh.subject.runAppChange({ campaign: CAMPAIGN, app: CHILD_APP }), (err) => !err.permanent && /Bad gateway/.test(err.message));
  } finally { gh.restore(); }
});

// ═══ Dashboard routes (routes/campaigns.js) ═══════════════════════════════

function loadCampaignRoutes(pool, { answer = () => ({ status: 'accepted', reply: { state: 'running', asked: [501] } }) } = {}) {
  const ids = {
    pool: require.resolve('../src/db/pool'),
    fleet: require.resolve('../src/services/fleet-maintenance'),
    workflow: require.resolve('../src/workflow/platform.ts'),
    subject: require.resolve('../src/routes/campaigns'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  const stub = (id, exports) => {
    require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
  };
  const spies = { events: [] };
  stub(ids.pool, { getPool: () => pool });
  stub(ids.fleet, {
    campaignStatus: async (p, id) => (String(id) === '5'
      ? { id: 5, title: 'T', status: 'running', counts: {}, apps: [] } : null),
  });
  // Every move is an event on the campaign machine.
  stub(ids.workflow, {
    async campaignEvent(id, type, payload, user) { spies.events.push({ id, type, payload, user: user.username }); return answer(type); },
  });
  delete require.cache[ids.subject];
  const { campaignRoutes } = require('../src/routes/campaigns');
  const router = campaignRoutes({ databaseUrl: 'postgres://test' });
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
    delete require.cache[ids.subject];
  };
  return { router, spies, restore };
}

test('campaign routes: meta, merge-green, retry and stop are admin-gated; each is the machine\'s event', async () => {
  const pool = makePool([
    [/SELECT slug FROM apps WHERE self_hosted/, [{ slug: 'usernode-social' }]],
    [/SELECT 1 FROM maintenance_campaigns WHERE id = \$1/, (params) => (params[0] === 5 ? [{ '?column?': 1 }] : [])],
  ]);
  const { router, spies, restore } = loadCampaignRoutes(pool);
  try {
    const meta = routeHandler(router, '/api/campaigns/meta', 'get');
    const denied = mockRes();
    await meta({ user: { id: 7 } }, denied);
    assert.equal(denied.statusCode, 403);
    const ok = mockRes();
    await meta({ user: { id: 2, isAdmin: true } }, ok);
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body.selfAppSlug, 'usernode-social');

    const mg = routeHandler(router, '/api/campaigns/:id/merge-green', 'post');
    const mgDenied = mockRes();
    await mg({ params: { id: '5' }, user: { id: 8, isAdmin: true, canAdminWrite: false } }, mgDenied);
    assert.equal(mgDenied.statusCode, 403, 'view-only admin cannot drain merges');
    const mgOk = mockRes();
    await mg({ params: { id: '5' }, user: { id: 2, username: 'boss', isAdmin: true, canAdminWrite: true } }, mgOk);
    assert.equal(mgOk.statusCode, 200);
    assert.deepEqual(mgOk.body, { ok: true, forced: [501] }, 'answered at once with what it forced (bug 7)');
    assert.deepEqual(spies.events, [{ id: 5, type: 'MergeGreen', payload: {}, user: 'boss' }]);

    const missing = mockRes();
    await mg({ params: { id: '6' }, user: { id: 2, username: 'boss', canAdminWrite: true } }, missing);
    assert.equal(missing.statusCode, 404);

    const retry = routeHandler(router, '/api/campaigns/:id/apps/:appId/retry', 'post');
    const rOk = mockRes();
    await retry({ params: { id: '5', appId: '9' }, user: { id: 2, canAdminWrite: true } }, rOk);
    assert.equal(rOk.statusCode, 200);
    assert.deepEqual(spies.events.at(-1), { id: 5, type: 'RetryApp', payload: { appId: 9 }, user: undefined });
    const rBad = mockRes();
    await retry({ params: { id: '5', appId: 'x' }, user: { id: 2, canAdminWrite: true } }, rBad);
    assert.equal(rBad.statusCode, 404);
    assert.equal(spies.events.length, 2, 'a non-numeric app id never reaches the machine');

    const rMissing = mockRes();
    await retry({ params: { id: '6', appId: '9' }, user: { id: 2, canAdminWrite: true } }, rMissing);
    assert.equal(rMissing.statusCode, 404, 'a campaign that does not exist is 404, never "being taken over"');

    const stop = routeHandler(router, '/api/campaigns/:id/stop', 'post');
    const sDenied = mockRes();
    await stop({ params: { id: '5' }, user: { id: 8, isAdmin: true, canAdminWrite: false } }, sDenied);
    assert.equal(sDenied.statusCode, 403);
    const sOk = mockRes();
    await stop({ params: { id: '5' }, user: { id: 2, username: 'boss', canAdminWrite: true } }, sOk);
    assert.equal(sOk.statusCode, 200);
    assert.equal(spies.events.at(-1).type, 'Stop');
  } finally { restore(); }
});

test('campaign routes: the machine\'s refusals answer what an admin can act on', async () => {
  const reasons = new Map([['RetryApp', 'not_retryable'], ['Stop', 'stopped'], ['AutoMerge', 'no_instance']]);
  const { router, restore } = loadCampaignRoutes(makePool([[/SELECT 1 FROM maintenance_campaigns/, [{ '?column?': 1 }]]]),
    { answer: (type) => ({ status: type === 'MergeGreen' ? 'faulted' : 'rejected', reason: reasons.get(type) }) });
  try {
    const retry = routeHandler(router, '/api/campaigns/:id/apps/:appId/retry', 'post');
    const r = mockRes();
    await retry({ params: { id: '5', appId: '9' }, user: { id: 2, canAdminWrite: true } }, r);
    assert.deepEqual([r.statusCode, r.body.error], [409, 'App is not in a retryable state (failed/skipped)']);
    const stop = routeHandler(router, '/api/campaigns/:id/stop', 'post');
    const st = mockRes();
    await stop({ params: { id: '5' }, user: { id: 2, canAdminWrite: true } }, st);
    assert.deepEqual([st.statusCode, st.body.reason], [409, 'stopped']);
    // A campaign whose Start the machine has not applied yet: starting, not
    // "taken over by this release".
    const starting = await (async () => {
      const auto = routeHandler(router, '/api/campaigns/:id/auto-merge', 'post');
      const res = mockRes();
      await auto({ params: { id: '5' }, body: { on: true }, user: { id: 2, canAdminWrite: true } }, res);
      return res;
    })();
    assert.deepEqual([starting.statusCode, starting.body.error], [409, 'The campaign is starting. Try again in a moment.']);
    const mg = routeHandler(router, '/api/campaigns/:id/merge-green', 'post');
    const broken = mockRes();
    await mg({ params: { id: '5' }, user: { id: 2, canAdminWrite: true } }, broken);
    assert.equal(broken.statusCode, 500, 'a faulted campaign is an error, not a refusal');
  } finally { restore(); }
});

test('campaign routes: list and detail are admin-only (a view-only admin may read); a non-numeric id is 404', async () => {
  const pool = makePool([
    [/FROM maintenance_campaigns mc/, [{ id: 5, title: 'T', status: 'running' }]],
  ]);
  const { router, restore } = loadCampaignRoutes(pool);
  try {
    const list = routeHandler(router, '/api/campaigns', 'get');
    const listDenied = mockRes();
    await list({ user: { id: 7 } }, listDenied);
    assert.equal(listDenied.statusCode, 403);
    assert.equal(listDenied.body.campaigns, undefined);
    const listOk = mockRes();
    await list({ user: { id: 8, isAdmin: true, canAdminWrite: false } }, listOk);
    assert.equal(listOk.statusCode, 200);
    assert.equal(listOk.body.campaigns.length, 1);

    const detail = routeHandler(router, '/api/campaigns/:id', 'get');
    const detailDenied = mockRes();
    await detail({ params: { id: '5' }, user: { id: 7 } }, detailDenied);
    assert.equal(detailDenied.statusCode, 403);
    assert.equal(detailDenied.body.campaign, undefined, 'a non-admin sees no campaign apps');
    const anon = mockRes();
    await detail({ params: { id: '5' } }, anon);
    assert.equal(anon.statusCode, 403);
    const detailOk = mockRes();
    await detail({ params: { id: '5' }, user: { id: 8, isAdmin: true, canAdminWrite: false } }, detailOk);
    assert.equal(detailOk.statusCode, 200);
    assert.equal(detailOk.body.campaign.id, 5);

    for (const bad of ['abc', '0', '-1', '5.5', '1e3', '99999999999']) {
      const res = mockRes();
      await detail({ params: { id: bad }, user: { id: 2, isAdmin: true } }, res);
      assert.equal(res.statusCode, 404, `id ${bad} answers 404`);
    }
    const missing = mockRes();
    await detail({ params: { id: '6' }, user: { id: 2, isAdmin: true } }, missing);
    assert.equal(missing.statusCode, 404);
  } finally { restore(); }
});
