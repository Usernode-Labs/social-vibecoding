'use strict';

// One registry, three audiences (#2779). registerTools serves an external
// chat product, the Mayor of an agent session, and the coding agent inside a
// change's worker. What each one sees, what each one is told, and which routes
// each one's tools actually reach are pinned here by driving registerTools
// itself, not by reading its source.
//
// Run with: node --test tests/mcp-audiences.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const tools = require('../src/services/mcp-tools');
const audiences = require('../src/services/mcp-audiences');
const charter = require('../src/services/mcp-charter');
const policy = require('../src/services/cli-api-policy');
const {
  READ_SCOPE,
  WRITE_SCOPE,
  SERVER_INSTRUCTIONS_MAX_CHARS,
  TOOL_DESCRIPTION_MAX_CHARS,
} = require('../src/services/mcp-connect-constants');

const ORIGIN = 'https://usernode.example';

function delegationFor(kind) {
  if (kind === 'external') return null;
  return kind === 'worker_read'
    ? { kind, grantId: 'g'.repeat(22), changeId: 50, appId: 3, appSlug: 'recipe-box', agentSessionId: null }
    : { kind, grantId: 'g'.repeat(22), changeId: null, appId: null, appSlug: null, agentSessionId: 4 };
}

function register(kind, { pool = null } = {}) {
  const specs = new Map();
  const handlers = new Map();
  tools.registerTools({
    registerTool(name, spec, handler) { specs.set(name, spec); handlers.set(name, handler); },
  }, {
    accessToken: kind === 'external' ? 'svmcp_test' : 'svmcd_test',
    scopes: kind === 'worker_read' ? [READ_SCOPE] : [READ_SCOPE, WRITE_SCOPE],
    user: { id: 7, username: 'ada' },
    clientName: kind === 'external' ? 'Claude' : 'Homeroom',
    clientId: 'c1',
    origin: ORIGIN,
    baseUrl: 'http://platform.internal',
    pool, config: {}, tokenId: 1, grantId: 'g'.repeat(22),
    delegation: delegationFor(kind),
  });
  return { specs, handlers };
}

// ── What each kind sees ────────────────────────────────────────────────

test('an external client sees everything but the Mayor-only change lifecycle', () => {
  const { specs } = register('external');
  for (const name of audiences.DELEGATED_ONLY_TOOLS) {
    assert.ok(!specs.has(name), `${name} is not offered to an external client`);
  }
  assert.ok(specs.has('get_change'), 'get_change is');
  assert.ok(specs.has('recheck_change'), 'and so is recheck_change');
  assert.ok(specs.has('submit_work') && specs.has('prepare_work'), 'today\'s surface is intact');
});

test('the Mayor sees exactly its list, and every name on it is a real tool', () => {
  const { specs } = register('agent_mayor');
  assert.deepEqual([...specs.keys()].sort(), [...audiences.AGENT_MAYOR_TOOLS].sort());
  for (const never of ['prepare_work', 'submit_work', 'start_platform_build', 'demo_vote', 'get_checkout_status']) {
    assert.ok(!specs.has(never), `${never} is for a human-driven client, not the Mayor`);
  }
});

test('the worker sees exactly six reads', () => {
  const { specs } = register('worker_read');
  assert.deepEqual([...specs.keys()].sort(), [...audiences.WORKER_READ_TOOLS].sort());
  assert.equal(specs.size, 6);
  for (const [name, spec] of specs) {
    assert.equal(spec.annotations.readOnlyHint, true, `${name} is a read`);
  }
});

test('an unknown kind sees nothing at all', () => {
  const { specs } = register('bogus');
  assert.equal(specs.size, 0);
  assert.equal(audiences.toolVisibleTo('bogus', 'get_app'), false);
  assert.equal(audiences.toolVisibleTo('__proto__', 'get_app'), false);
});

test('the Mayor\'s writes are exactly the confirmed tools plus recheck', () => {
  const { specs } = register('agent_mayor');
  const writes = [...specs].filter(([, spec]) => spec.annotations.readOnlyHint === false).map(([name]) => name);
  assert.deepEqual(writes.sort(), [...audiences.MAYOR_CONFIRMED_TOOLS, 'recheck_change'].sort(),
    'every Mayor write except recheck runs only on a confirmation card');
  for (const name of audiences.MAYOR_CONFIRMED_TOOLS) {
    assert.ok(audiences.AGENT_MAYOR_TOOLS.includes(name), `${name} is on the Mayor's list`);
  }
});

test('every description fits the budget for every kind', () => {
  for (const kind of audiences.KINDS) {
    for (const [name, spec] of register(kind).specs) {
      assert.ok(String(spec.description || '').length > 0, `${kind}/${name} has a description`);
      assert.ok(String(spec.description).length <= TOOL_DESCRIPTION_MAX_CHARS,
        `${kind}/${name} is ${String(spec.description).length} chars`);
    }
  }
});

// ── Which routes each kind's tools reach ───────────────────────────────
//
// Every tool a delegated kind can see is driven with plausible arguments
// against a recording fetch, and every loopback it makes must be on that
// kind's route list. A tool that reached for a route the list lacks would
// 403 in production and nowhere else.

const SAMPLE_ARGS = {
  get_app: { slug: 'recipe-box' },
  list_requests: { slug: 'recipe-box' },
  get_request: { slug: 'recipe-box', number: 12 },
  get_proposal: { proposalId: 50 },
  get_change: { changeId: 50 },
  get_platform_conventions: {},
  get_connector_guidance: {},
  whoami: {},
  list_apps: {},
  list_my_proposals: {},
  create_request: { slug: 'recipe-box', title: 'A request', body: 'Details.' },
  claim_request: { slug: 'recipe-box', number: 12 },
  release_request: { slug: 'recipe-box', number: 12 },
  update_proposal_issues: { proposalId: 50, addIssues: [12] },
  start_change: { slug: 'recipe-box', title: 'Dark mode', linkedIssues: [12, 13] },
  promote_change: { changeId: 50 },
  recheck_change: { changeId: 50 },
  sync_change: { changeId: 50 },
  withdraw_change: { changeId: 50 },
};

function fakePlatform(overrides = {}) {
  const calls = [];
  const bodies = {
    'GET /api/apps': { apps: [{ slug: 'recipe-box', name: 'Recipe box', repo_url: null }] },
    'GET /api/apps/recipe-box': { app: { id: 3, slug: 'recipe-box', name: 'Recipe box', repo_url: null } },
    'GET /api/apps/recipe-box/github-issues': { issues: [{ number: 12, title: 'A request', body: 'x', state: 'open' }] },
    'GET /api/apps/recipe-box/promoted': { sessions: [] },
    'GET /api/me/active-sessions': { sessions: [] },
    'GET /api/sessions/50': { session: { id: 50, app_slug: 'recipe-box', status: 'active', branch_name: 'b' } },
    'GET /api/sessions/50/status': { busy: false },
    'POST /api/apps/recipe-box/sessions': { session: { id: 77, status: 'active' } },
    'PATCH /api/sessions/77/linked-issues': { linkedIssues: [12, 13] },
    'POST /api/sessions/50/promote': { ok: true, prNumber: 901, prUrl: 'https://github.com/o/r/pull/901' },
    'POST /api/sessions/50/recheck': { status: 'running', checkState: 'pending' },
    'POST /api/sessions/50/sync-main': { ok: true, syncResult: 'clean', behind: 0, pushOk: true, conflictFiles: [] },
    'POST /api/sessions/50/archive': { ok: true },
    ...overrides,
  };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const key = `${method} ${u.pathname}`;
    calls.push({ method, path: u.pathname, body: init.body ? JSON.parse(init.body) : undefined });
    const found = Object.prototype.hasOwnProperty.call(bodies, key) ? bodies[key] : undefined;
    const status = found && found.__status ? found.__status : (found === undefined ? 404 : 200);
    const payload = found && found.__status ? found.body : (found === undefined ? { error: 'not found' } : found);
    return { ok: status < 400, status, text: async () => JSON.stringify(payload) };
  };
  return { calls, fetchImpl };
}

async function withFetch(fetchImpl, fn) {
  const previous = global.fetch;
  global.fetch = fetchImpl;
  try { return await fn(); } finally { global.fetch = previous; }
}

// A pool for the handful of tools that read platform state directly (whoami's
// GitHub link, a request's platform thread). Empty answers are enough here.
const quietPool = { async query() { return { rows: [] }; } };

for (const kind of ['agent_mayor', 'worker_read']) {
  test(`every loopback a ${kind} tool makes is on the ${kind} route list`, async () => {
    const { handlers } = register(kind, { pool: quietPool });
    const platform = fakePlatform();
    await withFetch(platform.fetchImpl, async () => {
      for (const [name, handler] of handlers) {
        assert.ok(SAMPLE_ARGS[name], `${name} has sample arguments in this test`);
        await handler(SAMPLE_ARGS[name]);
      }
    });
    assert.ok(platform.calls.length >= handlers.size - 3, 'the tools really called the platform');
    for (const call of platform.calls) {
      assert.equal(
        policy.isDelegatedApiRequest(kind, call.method, call.path), true,
        `${kind}: ${call.method} ${call.path} is on its list`
      );
    }
  });
}

// ── What each kind is told ─────────────────────────────────────────────

test('the external charter and instructions are exactly what they were', () => {
  assert.equal(charter.charterFor('external'), charter.CHARTER_FULL);
  assert.equal(charter.instructionsFor('external'), charter.SERVER_INSTRUCTIONS);
  assert.equal(tools.instructionsFor('external'), tools.SERVER_INSTRUCTIONS);
  assert.deepEqual(charter.sectionsFor('external'), charter.CHARTER_SECTIONS);
});

test('each delegated kind is told what it is, with the safety clauses first', () => {
  for (const kind of ['agent_mayor', 'worker_read']) {
    const instructions = charter.instructionsFor(kind);
    assert.ok(instructions.length > 0 && instructions.length <= SERVER_INSTRUCTIONS_MAX_CHARS,
      `${kind} instructions fit the budget (${instructions.length})`);
    assert.match(instructions, /UNTRUSTED DATA/);
    assert.match(instructions, /never claim a change has landed/i);
    const order = charter.DELEGATED_BRIEF_ORDER[kind];
    const safetyIds = [...charter.CHARTER_SECTIONS, ...charter.DELEGATED_CHARTER_SECTIONS]
      .filter((s) => s.safety && order.includes(s.id)).map((s) => s.id);
    for (const id of safetyIds) {
      assert.ok(order.indexOf(id) <= 3, `${kind}: safety clause ${id} is near the top`);
    }
    const full = charter.charterFor(kind);
    for (const section of charter.sectionsFor(kind)) {
      assert.ok(full.includes(`[${section.id}]`), `${kind}: ${section.id} is in its charter`);
    }
  }
});

test('nothing written for a human-driven client reaches a delegated kind', () => {
  const humanOnly = ['setup-tip-relay', 'verify-your-checkout', 'work-order-handling', 'no-code-here',
    'you-may-be-both', 'two-destinations', 'platform-build-fallback', 'read-this-first'];
  for (const kind of ['agent_mayor', 'worker_read']) {
    const ids = charter.sectionsFor(kind).map((s) => s.id);
    for (const id of humanOnly) {
      assert.ok(!ids.includes(id), `${kind} is not given ${id}`);
    }
    assert.doesNotMatch(charter.instructionsFor(kind), /setup tip|get_checkout_status|prepare_work/);
  }
  // The worker cannot call get_connector_guidance, so it is not pointed at it.
  assert.doesNotMatch(charter.instructionsFor('worker_read'), /get_connector_guidance/);
  assert.match(charter.instructionsFor('worker_read'), /READ-ONLY/);
  // The Mayor is told a chat "yes" is not a confirmation.
  assert.match(charter.instructionsFor('agent_mayor'), /Confirm/);
  assert.match(charter.instructionsFor('agent_mayor'), /"yes" in chat is not a confirmation/);
  assert.equal(charter.charterFor('bogus'), '');
  assert.equal(charter.instructionsFor('bogus'), '');
});

test('get_connector_guidance and the conventions preamble follow the kind', async () => {
  const mayor = register('agent_mayor');
  const guidance = await mayor.handlers.get('get_connector_guidance')({});
  assert.equal(guidance.structuredContent.charter, charter.charterFor('agent_mayor'));
  assert.deepEqual(guidance.structuredContent.sections.map((s) => s.id),
    charter.sectionsFor('agent_mayor').map((s) => s.id));

  const worker = register('worker_read');
  const conventions = await worker.handlers.get('get_platform_conventions')({});
  assert.equal(conventions.structuredContent.preamble, charter.DELEGATED_CONVENTIONS_PREAMBLES.worker_read);
  assert.match(conventions.structuredContent.preamble, /ALL of it applies to you/);
  const external = register('external');
  const externalConventions = await external.handlers.get('get_platform_conventions')({});
  assert.match(externalConventions.structuredContent.preamble, /THREE SECTIONS DO NOT APPLY TO YOU/);
});

test('a delegated caller never claims a setup tip', async () => {
  let hintQueries = 0;
  const pool = {
    async query(sql) {
      if (/mcp_connector_hints/.test(sql)) hintQueries += 1;
      return { rows: [{ shown_count: 1 }] };
    },
  };
  const { handlers } = register('agent_mayor', { pool });
  const result = await handlers.get('whoami')({});
  assert.equal(result.content.length, 1, 'no second block');
  assert.equal(hintQueries, 0, 'not even a claim is attempted');
});

// ── The change tools themselves ────────────────────────────────────────

test('get_change merges the live status and speaks the caller\'s vocabulary', async () => {
  const platform = fakePlatform({
    'GET /api/sessions/50': {
      session: {
        id: 50, app_slug: 'recipe-box', status: 'active', branch_name: 'b', pr_number: 12,
        check_state: 'failing', test_results: [{ name: 'home loads', status: 'fail', failureReason: 'boom' }],
        session_title: 'Dark mode',
      },
    },
    'GET /api/sessions/50/status': { busy: false, sync: null },
  });
  await withFetch(platform.fetchImpl, async () => {
    const mayor = await register('agent_mayor').handlers.get('get_change')({ changeId: 50 });
    assert.equal(mayor.structuredContent.changeId, 50);
    assert.equal(mayor.structuredContent.busy, false);
    assert.equal(mayor.structuredContent.hasBranch, true);
    assert.match(mayor.structuredContent.title, /<untrusted-content>Dark mode<\/untrusted-content>/);
    assert.match(mayor.structuredContent.nextStep, /^Checks on PR #12 \(change 50\) are failing/);
    assert.match(mayor.structuredContent.nextStep, /Dispatch the coding agent/);
    assert.equal(mayor.structuredContent.webPath,
      require('../src/services/change-destination').changeWebPath(ORIGIN, 'recipe-box', 50));

    const worker = await register('worker_read').handlers.get('get_change')({ changeId: 50 });
    assert.match(worker.structuredContent.nextStep, /Fix the failing tests in this turn/);
    const external = await register('external').handlers.get('get_change')({ changeId: 50 });
    assert.match(external.structuredContent.nextStep, /from the change's own page/);
    assert.doesNotMatch(external.structuredContent.nextStep, /promote_change|Dispatch/);
  });
});

test('an unreadable live status leaves busy unknown instead of failing the read', async () => {
  const platform = fakePlatform({ 'GET /api/sessions/50/status': { __status: 500, body: {} } });
  await withFetch(platform.fetchImpl, async () => {
    const result = await register('agent_mayor').handlers.get('get_change')({ changeId: 50 });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.busy, null);
  });
});

test('the next step walks a change through its whole life', () => {
  const step = (session, live = {}, kind = 'agent_mayor') => tools.shapeChange(
    { id: 50, app_slug: 'recipe-box', branch_name: 'b', ...session }, live, '', kind
  ).nextStep;
  assert.match(step({ branch_name: null, status: 'active' }), /Nothing has been built on Change 50 yet/);
  assert.match(step({ status: 'active' }, { busy: true }), /working on Change 50 right now/);
  assert.match(step({ status: 'active' }, { sync: { phase: 'merging' } }), /being synced with main/);
  assert.match(step({ status: 'active', check_state: 'pending' }), /Checks are running/);
  assert.match(step({ status: 'active', check_state: 'pending', check_phase: 'deferred' }), /conflicts with main\. sync_change/);
  assert.match(step({ status: 'active', check_state: 'error' }), /errored before any test reported/);
  assert.match(step({ status: 'active', check_state: 'passing' }), /ready to go up for a vote: promote_change/);
  assert.match(step({ status: 'paused', check_state: 'passing' }), /It is paused/);
  assert.match(step({ status: 'promoted', check_state: 'passing', pr_number: 9, yes_count: 1, votes_required: 3, behind_main: 2 }),
    /PR #9 \(change 50\) is up for the group's vote\. It has 1 of 3 yes votes\. It is 2 commit\(s\) behind main/);
  assert.match(step({ status: 'merging' }), /is merging now/);
  assert.match(step({ status: 'merged' }), /part of the app now/);
  assert.match(step({ status: 'archived' }), /withdrawn and is closed for good/);
  assert.doesNotMatch(step({ status: 'active' }, { busy: true }, 'worker_read'), /working on/,
    'the worker is the turn that is running');
});

test('start_change creates, names and links, and reports what did not stick', async () => {
  const platform = fakePlatform();
  await withFetch(platform.fetchImpl, async () => {
    const result = await register('agent_mayor').handlers.get('start_change')(SAMPLE_ARGS.start_change);
    assert.equal(result.structuredContent.changeId, 77);
    assert.deepEqual(result.structuredContent.linkedIssues, [12, 13]);
    assert.deepEqual(result.structuredContent.warnings, []);
    assert.match(result.structuredContent.nextStep, /dispatch the coding agent/);
  });
  const sequence = platform.calls.map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(sequence, [
    'POST /api/apps/recipe-box/sessions',
    'PATCH /api/sessions/77/linked-issues',
  ]);
  assert.deepEqual(platform.calls[0].body, { issueNumber: 12, title: 'Dark mode' },
    'the first request seeds and claims, and the name rides on the create');
  assert.deepEqual(platform.calls[1].body, { addIssues: [13] });

  const partial = fakePlatform({ 'PATCH /api/sessions/77/linked-issues': { __status: 500, body: {} } });
  await withFetch(partial.fetchImpl, async () => {
    const result = await register('agent_mayor').handlers.get('start_change')({
      slug: 'recipe-box', title: 'x', linkedIssues: [12, 13],
    });
    assert.equal(result.isError, undefined, 'the change exists, so this is not a failure');
    assert.equal(result.structuredContent.warnings.length, 1);
    assert.deepEqual(result.structuredContent.linkedIssues, [12]);
  });

  const bare = fakePlatform();
  await withFetch(bare.fetchImpl, async () => {
    await register('agent_mayor').handlers.get('start_change')({ slug: 'recipe-box', title: 'x' });
  });
  assert.deepEqual(bare.calls[0].body, { title: 'x' }, 'no request, no seed');
  assert.equal(bare.calls.length, 1);
});

test('start_change refuses bad input before anything is created', async () => {
  const platform = fakePlatform();
  await withFetch(platform.fetchImpl, async () => {
    const handler = register('agent_mayor').handlers.get('start_change');
    assert.equal((await handler({ slug: 'Bad Slug', title: 'x' })).structuredContent.code, 'invalid_request');
    assert.equal((await handler({ slug: 'recipe-box', title: '   ' })).structuredContent.code, 'invalid_request');
    assert.equal((await handler({ slug: 'recipe-box', title: 'x'.repeat(257) })).structuredContent.code, 'title_too_long');
  });
  assert.equal(platform.calls.length, 0);
});

test('a refused lifecycle call repeats the platform\'s own sentence', async () => {
  const platform = fakePlatform({
    'POST /api/sessions/50/promote': {
      __status: 409,
      body: { error: 'proposal_not_ready', message: 'This proposal is not ready yet. Wait for staging and checks to finish, then try again.' },
    },
    'POST /api/apps/recipe-box/sessions': {
      __status: 429, body: { error: 'You already have 5 running sessions. Pause or archive one first.' },
    },
  });
  await withFetch(platform.fetchImpl, async () => {
    const mayor = register('agent_mayor').handlers;
    const promoted = await mayor.get('promote_change')({ changeId: 50 });
    assert.equal(promoted.structuredContent.code, 'proposal_not_ready');
    assert.match(promoted.structuredContent.message, /not ready yet/);
    const started = await mayor.get('start_change')({ slug: 'recipe-box', title: 'x' });
    assert.equal(started.structuredContent.code, 'at_capacity');
    assert.match(started.structuredContent.message, /5 running sessions/);
  });
});

test('recheck, promote, sync and withdraw report what happened', async () => {
  const platform = fakePlatform();
  await withFetch(platform.fetchImpl, async () => {
    const mayor = register('agent_mayor').handlers;
    const recheck = await mayor.get('recheck_change')({ changeId: 50 });
    assert.equal(recheck.structuredContent.started, true);
    const promoted = await mayor.get('promote_change')({ changeId: 50 });
    assert.equal(promoted.structuredContent.prNumber, 901);
    assert.match(promoted.structuredContent.nextStep, /^PR #901 \(change 50\) is up for the group's vote/);
    const synced = await mayor.get('sync_change')({ changeId: 50 });
    assert.equal(synced.structuredContent.synced, true);
    const withdrawn = await mayor.get('withdraw_change')({ changeId: 50 });
    assert.equal(withdrawn.structuredContent.withdrawn, true);
  });

  const conflicted = fakePlatform({
    'POST /api/sessions/50/sync-main': {
      ok: false, syncResult: 'conflict', behind: 3, pushOk: false, conflictFiles: ['src/app.js'],
    },
    'POST /api/sessions/50/recheck': { status: 'unavailable', reason: 'demo' },
  });
  await withFetch(conflicted.fetchImpl, async () => {
    const mayor = register('agent_mayor').handlers;
    const synced = await mayor.get('sync_change')({ changeId: 50 });
    assert.equal(synced.structuredContent.synced, false);
    assert.deepEqual(synced.structuredContent.conflictFiles, ['<untrusted-content>src/app.js</untrusted-content>']);
    const recheck = await mayor.get('recheck_change')({ changeId: 50 });
    assert.equal(recheck.structuredContent.started, false);
  });
});

test('a read-only grant cannot start a write even if it could see the tool', async () => {
  const handlers = new Map();
  tools.registerTools({
    registerTool(name, _spec, handler) { handlers.set(name, handler); },
  }, {
    accessToken: 'svmcd_test', scopes: [READ_SCOPE],
    user: { id: 7, username: 'ada' }, clientName: 'Homeroom', clientId: 'c1',
    origin: ORIGIN, baseUrl: 'http://platform.internal', pool: null, config: {},
    tokenId: 1, grantId: 'g'.repeat(22), delegation: delegationFor('agent_mayor'),
  });
  const platform = fakePlatform();
  await withFetch(platform.fetchImpl, async () => {
    for (const name of ['start_change', 'promote_change', 'recheck_change', 'sync_change', 'withdraw_change']) {
      const result = await handlers.get(name)(SAMPLE_ARGS[name]);
      assert.equal(result.structuredContent.code, 'insufficient_scope', `${name} needs the write scope`);
    }
  });
  assert.equal(platform.calls.length, 0);
});
