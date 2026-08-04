// Tests for maintenance campaigns (#853's generalization):
// - the `maintenance_campaign` governance kind in src/routes/issues.js
//   (creation validation, vote-apply helper, admin force-apply gating),
// - the campaign engine in src/services/fleet-maintenance.js (per-app
//   AI tool loop, sequential fan-out, merge-green drain, retry),
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
function loadIssues(pool, { gh = {}, active = 2, app = SELF_APP, gate = {}, runCampaign } = {}) {
  const realActiveUsers = require('../src/services/active-users');
  const ids = {
    pool: require.resolve('../src/db/pool'),
    ws: require.resolve('../src/services/ws'),
    github: require.resolve('../src/services/github'),
    appAccess: require.resolve('../src/services/app-access'),
    activeUsers: require.resolve('../src/services/active-users'),
    adminApproval: require.resolve('../src/services/admin-approval'),
    governance: require.resolve('../src/services/governance'),
    fleet: require.resolve('../src/services/fleet-maintenance'),
    subject: require.resolve('../src/routes/issues'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const spies = { systemMessages: [], issueUpdates: [], ghCalls: [], campaignRuns: [] };
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
  stub(ids.adminApproval, { isAppLocked: async () => false, hasAdminUpVote: async () => true });
  // The apply helper resolves the vote through governedGate; script it
  // directly (the gate's own math has its own suite).
  const realGovernance = orig.governance ? orig.governance.exports : require('../src/services/governance');
  stub(ids.governance, {
    ...realGovernance,
    governedGate: async () => ({
      qualifiedYes: 2, activeCount: active, required: 2, mergeable: true,
      thresholdMet: true, lazyArmed: false, windowElapsed: true, windowEndsAt: null,
      ...gate,
    }),
  });
  stub(ids.fleet, {
    runCampaign: async (...args) => {
      spies.campaignRuns.push(args);
      if (runCampaign) return runCampaign(...args);
    },
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

    // Group line + governance-thread dual-post.
    assert.equal(spies.systemMessages.length, 2);
    assert.match(spies.systemMessages[0][2], /proposed a maintenance campaign: "Switch JWT/);
    assert.deepEqual(spies.systemMessages[1][5], { type: 'governance', ref: 71 });
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

// ── Vote apply (maybeApplyMaintenanceCampaignProposal) ───────────────────

function applyPool({ lockedRow } = {}) {
  return makePool([
    [/SELECT \* FROM issues WHERE id = \$1 FOR UPDATE/, [lockedRow]],
    [/INSERT INTO maintenance_campaigns/, [{ id: 33 }]],
    [/UPDATE issues SET status = 'closed'/, []],
  ]);
}

test('apply: passing gate creates the campaign row, closes the issue, starts the engine', async () => {
  const proposal = CAMPAIGN_PROPOSAL();
  const pool = applyPool({ lockedRow: proposal });
  const { subject, spies, restore } = loadIssues(pool);
  try {
    const r = await subject.maybeApplyMaintenanceCampaignProposal(
      { databaseUrl: 'postgres://test' }, pool, proposal
    );
    assert.equal(r.applied, true);
    assert.equal(r.campaignId, 33);

    const camp = pool.issued(/INSERT INTO maintenance_campaigns/);
    assert.ok(camp, 'campaign row inserted');
    assert.equal(camp.params[0], 71, 'linked to the proposal');
    assert.equal(camp.params[1], 'Switch JWT verification to RS256', 'raw payload title');
    assert.match(camp.params[2], /USERNODE_JWT_PUBLIC_KEY/);
    assert.equal(camp.params[3], null, 'no target filter → whole fleet');

    const upd = pool.issued(/UPDATE issues SET status = 'closed'/);
    const audit = JSON.parse(upd.params[1]);
    assert.equal(audit.campaignId, 33);
    assert.equal(audit.appliedBy, 'vote');

    // Engine kicked with the new campaign id.
    assert.equal(spies.campaignRuns.length, 1);
    assert.equal(spies.campaignRuns[0][2], 33);

    // Group line + governance-thread dual-post.
    assert.equal(spies.systemMessages.length, 2);
    assert.match(spies.systemMessages[0][2], /approved by group vote/);
  } finally { restore(); }
});

test('apply: below the gate leaves the proposal open (no campaign, no engine)', async () => {
  const proposal = CAMPAIGN_PROPOSAL({ created_at: new Date().toISOString() });
  const pool = applyPool({ lockedRow: proposal });
  const { subject, spies, restore } = loadIssues(pool, {
    gate: { mergeable: false, thresholdMet: false, qualifiedYes: 1, required: 5 },
  });
  try {
    const r = await subject.maybeApplyMaintenanceCampaignProposal(
      { databaseUrl: 'postgres://test' }, pool, proposal
    );
    assert.equal(r.applied, false);
    assert.equal(r.required, 5);
    assert.ok(!pool.issued(/INSERT INTO maintenance_campaigns/));
    assert.equal(spies.campaignRuns.length, 0);
  } finally { restore(); }
});

test('apply: already-closed row is a harmless no-op (race with a parallel apply)', async () => {
  const proposal = CAMPAIGN_PROPOSAL();
  const pool = applyPool({ lockedRow: { ...proposal, status: 'closed' } });
  const { subject, spies, restore } = loadIssues(pool);
  try {
    const r = await subject.maybeApplyMaintenanceCampaignProposal(
      { databaseUrl: 'postgres://test' }, pool, proposal
    );
    assert.equal(r.applied, false);
    assert.ok(!pool.issued(/INSERT INTO maintenance_campaigns/));
    assert.equal(spies.campaignRuns.length, 0);
  } finally { restore(); }
});

// ── Admin force-apply route ───────────────────────────────────────────────

test('admin-apply: full admin forces a campaign; view-only admin 403', async () => {
  const proposal = CAMPAIGN_PROPOSAL({ created_at: new Date().toISOString() });
  const pool = makePool([
    [/SELECT i\.\*, a\.slug AS app_slug/, [proposal]],
    [/SELECT \* FROM issues WHERE id = \$1 FOR UPDATE/, [proposal]],
    [/INSERT INTO maintenance_campaigns/, [{ id: 34 }]],
    [/UPDATE issues SET status = 'closed'/, []],
  ]);
  const { router, spies, restore } = loadIssues(pool, {
    // Zero-vote gate: force must bypass it entirely.
    gate: { mergeable: false, qualifiedYes: 0, required: 5, thresholdMet: false },
  });
  try {
    const handler = routeHandler(router, '/api/issues/:id/admin-apply');

    const denied = mockRes();
    await handler({
      params: { id: '71' },
      user: { id: 8, username: 'watcher', isAdmin: true, canAdminWrite: false },
    }, denied);
    assert.equal(denied.statusCode, 403, 'view-only admin blocked for this kind');
    assert.ok(!pool.issued(/INSERT INTO maintenance_campaigns/));

    const res = mockRes();
    await handler({
      params: { id: '71' },
      user: { id: 2, username: 'boss', isAdmin: true, canAdminWrite: true },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.applied.applied, true, 'force applied with zero votes');
    assert.equal(res.body.applied.campaignId, 34);
    assert.equal(res.body.secretChanged, null, 'BC alias null for campaigns');

    const upd = pool.issued(/UPDATE issues SET status = 'closed'/);
    const audit = JSON.parse(upd.params[1]);
    assert.equal(audit.appliedBy, 'admin:boss');
    assert.equal(spies.campaignRuns.length, 1);
  } finally { restore(); }
});

// ── Twin policy ───────────────────────────────────────────────────────────

test('shouldCreateGithubTwin: false for maintenance_campaign', () => {
  const { shouldCreateGithubTwin } = require('../src/routes/issues');
  assert.equal(shouldCreateGithubTwin('maintenance_campaign'), false);
  assert.equal(shouldCreateGithubTwin('general'), true);
});

// ═══ Engine (services/fleet-maintenance.js) ═══════════════════════════════

// Load the engine with github/llm and every promote-path collaborator
// stubbed via require.cache.
function loadFleet({ llmScript = [], files = {}, gh = {}, checkAndMerge } = {}) {
  const ids = {
    github: require.resolve('../src/services/github'),
    llm: require.resolve('../src/services/llm'),
    ws: require.resolve('../src/services/ws'),
    notifications: require.resolve('../src/services/notifications'),
    events: require.resolve('../src/services/events'),
    activeUsers: require.resolve('../src/services/active-users'),
    limits: require.resolve('../src/services/limits'),
    visuals: require.resolve('../src/services/visuals'),
    staging: require.resolve('../src/services/staging'),
    stagingRecovery: require.resolve('../src/services/staging-recovery'),
    votes: require.resolve('../src/routes/votes'),
    subject: require.resolve('../src/services/fleet-maintenance'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const spies = {
    llmCalls: [], ghCalls: [], systemMessages: [], voteUpdates: [],
    merges: [],
  };
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
    pushFiles: async (owner, repo, pushed, opts) => {
      spies.ghCalls.push({ type: 'pushFiles', owner, repo, files: pushed, opts });
    },
    createPR: async (owner, repo, opts) => {
      spies.ghCalls.push({ type: 'createPR', owner, repo, opts });
      return { number: 88, html_url: `https://github.com/${owner}/${repo}/pull/88` };
    },
    ...gh,
  });
  stub(ids.ws, {
    sendSystemMessage: async (...args) => { spies.systemMessages.push(args); },
    pushVoteUpdate: (data) => { spies.voteUpdates.push(data); },
    pushNotificationToUser: () => {},
  });
  stub(ids.notifications, {
    createPrProposedNotifications: async () => [],
    serialize: (r) => r,
  });
  stub(ids.events, {
    record: () => {},
    EVENT_TYPES: { PR_PROMOTED: 'pr_promoted' },
  });
  stub(ids.activeUsers, {
    getActiveUserStats: async () => ({ active: 3, majority: 2 }),
  });
  stub(ids.limits, { recordSpend: async () => {} });
  stub(ids.visuals, {
    setChecksPending: async () => {},
    notifyChecksPending: () => {},
    captureForSession: async () => {},
  });
  stub(ids.staging, {
    buildAndDeployStaging: async () => ({ containerId: 'c1', stagingUrl: 'https://s', hostname: 'h' }),
    verifyStagingEdge: async () => {},
  });
  stub(ids.stagingRecovery, { recordStagingBootFailure: async () => {} });
  stub(ids.votes, {
    checkAndMerge: async (config, pool, session, opts) => {
      spies.merges.push({ session, opts });
      return checkAndMerge ? checkAndMerge(session) : { merged: true };
    },
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

// ── runCampaign (sequential fan-out) ──────────────────────────────────────

test('runCampaign: fans out sequentially — one PR opened, one skipped, campaign done', async () => {
  const pendingPicks = [
    [{ row_id: 101, app_id: 9, slug: 'cool-app', name: 'Cool App', repo_url: CHILD_APP.repo_url }],
    [{ row_id: 102, app_id: 10, slug: 'other-app', name: 'Other App', repo_url: 'https://github.com/acme/other-app' }],
    [],
  ];
  let pick = 0;
  const pool = makePool([
    [/SELECT \* FROM maintenance_campaigns WHERE id = \$1/, [CAMPAIGN]],
    [/SELECT id FROM users WHERE username = \$1/, [{ id: 99 }]],
    [/state = 'pending'\s+ORDER BY mca\.id\s+LIMIT 1/, () => pendingPicks[pick++] || []],
    [/INSERT INTO chat_sessions/, [{ id: 501 }]],
    [/SELECT state, COUNT\(\*\)::int AS n/, [{ state: 'pr_open', n: 1 }, { state: 'skipped', n: 1 }]],
    [/SELECT app_id FROM issues WHERE id = \$1/, [{ app_id: 1 }]],
  ]);
  const { subject, spies, restore } = loadFleet({
    files: { 'server.js': 'const s = process.env.JWT_SECRET;\n' },
    llmScript: [
      // App 1: read → edit → finish.
      { toolUses: [{ id: 't1', name: 'read_file', input: { path: 'server.js' } }] },
      { toolUses: [{ id: 't2', name: 'edit_file', input: {
        path: 'server.js', old_string: 'JWT_SECRET', new_string: 'USERNODE_JWT_PUBLIC_KEY',
      } }] },
      { toolUses: [{ id: 't3', name: 'finish', input: { summary: 'Swapped env var in server.js.' } }] },
      // App 2: skip.
      { toolUses: [{ id: 't4', name: 'skip_app', input: { reason: 'No JWT here.' } }] },
    ],
  });
  try {
    await subject.runCampaign({ databaseUrl: 'postgres://test' }, pool, 5);
    // Let kickChecks' fire-and-forget IIFE settle.
    await new Promise((r) => setTimeout(r, 50));

    // Seeding targeted the whole fleet (no slug filter in the INSERT…SELECT).
    const seed = pool.issued(/INSERT INTO maintenance_campaign_apps/);
    assert.ok(seed, 'targets seeded');
    assert.ok(!/ANY\(\$2\)/.test(seed.sql), 'no slug filter for a fleet-wide campaign');

    // App 1: branch + push + PR + promoted session with source='maintenance'.
    const branch = spies.ghCalls.find((c) => c.type === 'createBranch');
    assert.match(branch.branch, /^maint\/c5\/cool-app-/);
    const push = spies.ghCalls.find((c) => c.type === 'pushFiles');
    assert.equal(push.files.length, 1);
    assert.match(push.files[0].content, /USERNODE_JWT_PUBLIC_KEY/);
    const pr = spies.ghCalls.find((c) => c.type === 'createPR');
    assert.equal(pr.opts.title, CAMPAIGN.title);
    assert.match(pr.opts.body, /maintenance campaign #5/i);
    const sess = pool.issued(/INSERT INTO chat_sessions/);
    assert.match(sess.sql, /'maintenance'/, 'session row marked source=maintenance');
    assert.equal(sess.params[1], 99, 'attributed to the platform user');

    const prOpen = pool.issued(/SET state = 'pr_open'/);
    assert.deepEqual(prOpen.params, [101, 501]);

    // App 2 skipped with the model's reason.
    const skipped = pool.issued(/SET state = 'skipped'/);
    assert.deepEqual(skipped.params, [102, 'No JWT here.']);

    // Campaign closed out + completion note in the platform chat.
    assert.ok(pool.issued(/SET status = 'done'/), 'campaign marked done');
    const done = spies.systemMessages.find((m) => /finished fanning out/.test(m[2]));
    assert.ok(done, 'completion chat message sent');
    assert.match(done[2], /1 PRs opened, 1 skipped, 0 failed/);

    // Vote message + panel push for the opened proposal.
    assert.ok(spies.systemMessages.find((m) => /opened PR #88/.test(m[2])));
    assert.equal(spies.voteUpdates[0].sessionId, 501);
  } finally { restore(); }
});

test('runCampaign: an app failure is recorded and the loop continues', async () => {
  const pendingPicks = [
    [{ row_id: 101, app_id: 9, slug: 'cool-app', name: 'Cool App', repo_url: CHILD_APP.repo_url }],
    [{ row_id: 102, app_id: 10, slug: 'other-app', name: 'Other App', repo_url: 'https://github.com/acme/other-app' }],
    [],
  ];
  let pick = 0;
  const pool = makePool([
    [/SELECT \* FROM maintenance_campaigns WHERE id = \$1/, [CAMPAIGN]],
    [/SELECT id FROM users WHERE username = \$1/, [{ id: 99 }]],
    [/state = 'pending'\s+ORDER BY mca\.id\s+LIMIT 1/, () => pendingPicks[pick++] || []],
    [/SELECT state, COUNT\(\*\)::int AS n/, [{ state: 'failed', n: 1 }, { state: 'skipped', n: 1 }]],
    [/SELECT app_id FROM issues WHERE id = \$1/, [{ app_id: 1 }]],
  ]);
  const { subject, restore } = loadFleet({
    llmScript: [
      // App 1: model wanders into a hard failure (truncation).
      { toolUses: [], stopReason: 'max_tokens' },
      // App 2 still runs: skip.
      { toolUses: [{ id: 't1', name: 'skip_app', input: { reason: 'n/a' } }] },
    ],
  });
  try {
    await subject.runCampaign({ databaseUrl: 'postgres://test' }, pool, 5);
    const failed = pool.issued(/SET state = 'failed'/);
    assert.equal(failed.params[0], 101);
    assert.match(failed.params[1], /truncated/);
    const skipped = pool.issued(/SET state = 'skipped'/);
    assert.equal(skipped.params[0], 102, 'second app still processed');
    assert.ok(pool.issued(/SET status = 'done'/));
  } finally { restore(); }
});

// ── mergeGreen + retry ────────────────────────────────────────────────────

test('mergeGreen: force-merges green sessions sequentially, records merged state', async () => {
  const sessions = [
    { row_id: 101, id: 501, app_slug: 'cool-app', pr_number: 88, status: 'promoted', check_state: 'passing' },
  ];
  const pool = makePool([
    [/FROM maintenance_campaign_apps mca\s+JOIN chat_sessions/, sessions],
  ]);
  const { subject, spies, restore } = loadFleet({});
  try {
    const results = await subject.mergeGreen({ databaseUrl: 'postgres://test' }, pool, 5, {
      forceBy: { id: 2, username: 'boss' },
    });
    assert.deepEqual(results, [{ slug: 'cool-app', prNumber: 88, merged: true }]);
    assert.equal(spies.merges.length, 1);
    assert.equal(spies.merges[0].opts.force, true, 'platform vote is the authority');
    assert.equal(spies.merges[0].opts.forceBy.username, 'boss');
    const upd = pool.issued(/SET state = 'merged'/);
    assert.deepEqual(upd.params, [101]);
  } finally { restore(); }
});

test('retryCampaignApp: resets a failed row to pending and re-enters the loop; no-op otherwise', async () => {
  // makePool has no rowCount plumbing — extend query for this one test.
  const base = makePool([]);
  let updated = 1;
  const pool = {
    ...base,
    query: async (sql, params) => {
      base.calls.push({ sql, params });
      if (/SET state = 'pending'/.test(sql)) return { rows: [], rowCount: updated };
      return { rows: [], rowCount: 0 };
    },
    issued: (re) => base.calls.find((c) => re.test(c.sql)),
  };
  const { subject, restore } = loadFleet({});
  try {
    const ok = await subject.retryCampaignApp({ databaseUrl: 'postgres://test' }, pool, 5, 9);
    assert.equal(ok, true);
    assert.ok(pool.issued(/SET status = 'running', completed_at = NULL/),
      'a done campaign flips back to running');

    updated = 0;
    const noop = await subject.retryCampaignApp({ databaseUrl: 'postgres://test' }, pool, 5, 9);
    assert.equal(noop, false, 'non-retryable state refuses');
  } finally { restore(); }
});

// ═══ Dashboard routes (routes/campaigns.js) ═══════════════════════════════

function loadCampaignRoutes(pool) {
  const ids = {
    pool: require.resolve('../src/db/pool'),
    fleet: require.resolve('../src/services/fleet-maintenance'),
    subject: require.resolve('../src/routes/campaigns'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  const stub = (id, exports) => {
    require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
  };
  const spies = { mergeGreens: [], retries: [] };
  stub(ids.pool, { getPool: () => pool });
  stub(ids.fleet, {
    campaignStatus: async (p, id) => (String(id) === '5'
      ? { id: 5, title: 'T', status: 'running', counts: {}, apps: [] } : null),
    mergeGreen: async (config, p, id, opts) => { spies.mergeGreens.push({ id, opts }); return []; },
    retryCampaignApp: async (config, p, id, appId) => { spies.retries.push({ id, appId }); return true; },
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

test('campaign routes: meta and merge-green are admin-gated; retry hits the engine', async () => {
  const pool = makePool([
    [/SELECT slug FROM apps WHERE self_hosted/, [{ slug: 'usernode-social' }]],
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
    assert.equal(spies.mergeGreens.length, 1);
    assert.equal(spies.mergeGreens[0].opts.forceBy.username, 'boss');

    const missing = mockRes();
    await mg({ params: { id: '6' }, user: { id: 2, username: 'boss', canAdminWrite: true } }, missing);
    assert.equal(missing.statusCode, 404);

    const retry = routeHandler(router, '/api/campaigns/:id/apps/:appId/retry', 'post');
    const rOk = mockRes();
    await retry({ params: { id: '5', appId: '9' }, user: { id: 2, canAdminWrite: true } }, rOk);
    assert.equal(rOk.statusCode, 200);
    assert.deepEqual(spies.retries, [{ id: '5', appId: '9' }]);
  } finally { restore(); }
});
