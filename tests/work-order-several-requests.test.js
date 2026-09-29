// One work order, several requests.
//
// prepare_work took one `requestNumber`. A change meant to implement three
// requests went in as a free-text brief that NAMED them, and a number in a
// brief is not a link: the proposal (PR #3040) merged with no `Closes #N`
// line, no linked_issues, and all three requests still open for somebody to
// close by hand. Agent chat's own start_change has always taken a list; the
// connector path could not.
//
// Now prepare_work takes `requestNumbers`. Every one is recorded on the job
// (external_agent_tasks.linked_issues, the first also as issue_number), is
// quoted into the work order, is claimed, is checked for proposals already up
// for a vote, and gets its own `Closes #N` line and link at submission. A
// brief-only submission whose brief mentions open requests is pointed at
// update_proposal_issues rather than linked by guesswork.
//
// Run with: node --test tests/work-order-several-requests.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const svc = require('../src/services/external-agent-tasks');
const tools = require('../src/services/mcp-tools');
const constants = require('../src/services/mcp-connect-constants');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ── The job's request list ─────────────────────────────────────────────

test('the list is cleaned up: primary first, no repeats, no junk, capped', () => {
  assert.deepEqual(svc.normalizeIssueNumbers([3033, 3032, 3028]), [3033, 3032, 3028]);
  // The one-request parameter leads, and is not repeated from the list.
  assert.deepEqual(svc.normalizeIssueNumbers([3032, 3033], 3033), [3033, 3032]);
  assert.deepEqual(svc.normalizeIssueNumbers(['12', 12, 0, -1, 1.5, 'x', null, true, {}]), [12]);
  assert.deepEqual(svc.normalizeIssueNumbers(undefined, null), []);
  const many = Array.from({ length: 12 }, (_, i) => i + 1);
  assert.equal(svc.normalizeIssueNumbers(many).length, svc.MAX_TASK_ISSUES);
  assert.equal(svc.MAX_TASK_ISSUES, 5);
});

test('a job for several requests is keyed on the set, and never collides with a one-request job', () => {
  // The one-request and brief keys are byte-identical to before: the schema
  // backfilled rows under them.
  assert.equal(svc.requestKeyFor(50, 'anything'), 'issue:50');
  assert.equal(svc.requestKeyFor(null, 'x', [50]), 'issue:50');
  assert.match(svc.requestKeyFor(null, 'add dark mode'), /^brief:[0-9a-f]{32}$/);
  // Order does not make it a different job.
  assert.equal(svc.requestKeyFor(null, 'x', [3033, 3028, 3032]), 'issues:3028,3032,3033');
  assert.equal(svc.requestKeyFor(3032, 'y', [3033, 3028]), 'issues:3028,3032,3033');
  assert.notEqual(svc.requestKeyFor(null, 'x', [3033, 3028]), svc.requestKeyFor(3033, 'x'));
});

test('the job links every request, and an older row still links its one', () => {
  assert.deepEqual(svc.linkedIssuesFor({ issue_number: 3033, linked_issues: [3033, 3032, 3028] }),
    [3033, 3032, 3028]);
  // Rows from before the column hold the empty array.
  assert.deepEqual(svc.linkedIssuesFor({ issue_number: 1217, linked_issues: [] }), [1217]);
  assert.deepEqual(svc.linkedIssuesFor({ issue_number: 1217 }), [1217]);
  assert.deepEqual(svc.linkedIssuesFor({ issue_number: null, linked_issues: [] }), []);
});

test('the pull request closes every one of them', () => {
  const body = svc.prBodyFor({
    body: 'Three agent-chat fixes.',
    task: { issue_number: 3033, linked_issues: [3033, 3032, 3028] },
  });
  assert.match(body, /Closes #3028\nCloses #3032\nCloses #3033$/);
});

test('the column exists, and an older row means "just issue_number"', () => {
  const schema = read('src/db/schema.sql');
  assert.match(schema,
    /ALTER TABLE external_agent_tasks ADD COLUMN IF NOT EXISTS linked_issues INTEGER\[\] NOT NULL DEFAULT '\{\}';/);
});

// ── prepareWork ────────────────────────────────────────────────────────

const APP = { id: 7, slug: 'recipe-box', name: 'Recipe Box', repo_url: 'https://github.com/usernode-bot/recipe-box' };
const BASE_SHA = 'a'.repeat(40);

function fakePool(lookupRows, queries) {
  return {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('FROM chat_sessions cs')) return { rows: lookupRows };
      if (sql.includes('INSERT INTO external_agent_tasks')) return { rows: [{ id: 70 }] };
      return { rows: [] };
    },
  };
}

async function prepare(params, lookupRows = []) {
  const queries = [];
  const original = global.fetch;
  global.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ fork: true, name: 'recipe-box', parent: { full_name: 'usernode-bot/recipe-box' } }),
    text: async () => '{}',
    headers: { get: () => null },
  });
  try {
    const result = await svc.prepareWork({
      pool: fakePool(lookupRows, queries),
      config: {},
      gh: {
        parseGithubUrl: () => ({ owner: 'usernode-bot', repo: 'recipe-box' }),
        isEnabled: () => true,
        getBranchSha: async () => BASE_SHA,
      },
      githubLink: { isEnabled: () => true, linkStatus: async () => ({ linked: true, login: 'someuser' }) },
      limits: { checkOpenWorkOrders: async () => null },
    }, {
      user: { id: 3 }, app: APP, brief: 'Three agent-chat fixes.',
      clientName: 'Claude — claude.ai', origin: 'https://usernode.example',
      ...params,
    });
    return { result, queries };
  } finally {
    global.fetch = original;
  }
}

test('prepareWork records every request on the job, the first as issue_number', async () => {
  const { result, queries } = await prepare({ issueNumbers: [3033, 3032, 3028] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.requestNumbers, [3033, 3032, 3028]);

  const insert = queries.find((q) => q.sql.includes('INSERT INTO external_agent_tasks'));
  assert.equal(insert.params[2], 3033, 'issue_number is the first');
  assert.equal(insert.params[9], 'issues:3028,3032,3033', 'request_key is the set');
  assert.deepEqual(insert.params[12], [3033, 3032, 3028], 'linked_issues is all of them');
  assert.match(result.branch, /-issue-3033-/, 'the branch is named for the first');

  // The coding agent is told it is building all of them.
  assert.match(result.workOrder,
    /This implements requests #3033, #3032 and #3028: build all of them\. The proposal closes each one when it merges\./);
});

test('one request reads exactly as it always did', async () => {
  const { result, queries } = await prepare({ issueNumber: 50 });
  assert.deepEqual(result.requestNumbers, [50]);
  assert.match(result.workOrder, /This implements request #50\.\n/);
  const insert = queries.find((q) => q.sql.includes('INSERT INTO external_agent_tasks'));
  assert.equal(insert.params[9], 'issue:50');
  assert.deepEqual(insert.params[12], [50]);
});

test('no request, no line and no link', async () => {
  const { result, queries } = await prepare({});
  assert.deepEqual(result.requestNumbers, []);
  assert.doesNotMatch(result.workOrder, /This implements request/);
  assert.ok(!queries.some((q) => q.sql.includes('FROM chat_sessions cs')), 'no duplicate lookup');
  const insert = queries.find((q) => q.sql.includes('INSERT INTO external_agent_tasks'));
  assert.equal(insert.params[2], null);
  assert.deepEqual(insert.params[12], []);
});

test('a proposal already up for any of them is reported, naming the one it is for', async () => {
  const { result, queries } = await prepare({ issueNumbers: [3033, 3032, 3028] }, [{
    id: 4800, status: 'promoted', pr_number: 3001, pr_title: 'Inline propose',
    session_title: null, user_id: 9, username: 'dana', requests: [3032],
  }]);
  const lookup = queries.find((q) => q.sql.includes('FROM chat_sessions cs'));
  assert.deepEqual(lookup.params[1], [3033, 3032, 3028], 'one lookup covers every request');
  assert.match(lookup.sql, /WITH ORDINALITY AS asked\(n, ord\)[\s\S]*ORDER BY asked\.ord\) AS requests/);
  assert.deepEqual(result.openProposals[0].requests, [3032]);
  assert.match(result.guidance[0], /^Heads-up: request #3032 already has a proposal up for a vote — PR #3001 \(proposal 4800\), opened by dana\./);
});

test('the submission reports what it linked, and what the brief only mentioned', () => {
  const src = read('src/services/external-agent-tasks.js');
  const tail = src.slice(src.indexOf('await notifyConnectorSubmitted(pool, {\n    userId: user.id, appId: task ? task.app_id : null, sessionId, detail: \'submitted\','));
  assert.match(tail, /linkedIssues: linkedIssuesFor\(task\),\n\s*mentionedIssues: linkedIssuesFor\(task\)\.length \? \[\] : mentionedIssueNumbers\(task && task\.brief\),/);

  assert.deepEqual(
    svc.mentionedIssueNumbers('<untrusted-content>Solve #3033, #3032 and (#3028). Like #3033 again.</untrusted-content>'),
    [3033, 3032, 3028]
  );
  // Not a request reference: part of a word, an HTML entity, a path.
  assert.deepEqual(svc.mentionedIssueNumbers('PR#12 &#39; a/#5 x#6'), []);
  assert.deepEqual(svc.mentionedIssueNumbers(''), []);
  assert.deepEqual(svc.mentionedIssueNumbers(null), []);
});

// ── The connector ──────────────────────────────────────────────────────

const ORIGIN = 'https://usernode.example';

function collectTools() {
  const handlers = new Map();
  const specs = new Map();
  tools.registerTools({
    registerTool(name, spec, handler) { handlers.set(name, handler); specs.set(name, spec); },
  }, {
    accessToken: 'svmcp_test', scopes: [constants.READ_SCOPE, constants.WRITE_SCOPE],
    user: { id: 7, username: 'ada' },
    clientName: 'Claude', clientId: 'c1',
    origin: ORIGIN, baseUrl: 'http://platform.internal',
    pool: { query: async () => ({ rows: [] }) }, config: {},
  });
  return { handlers, specs };
}

const OPEN_ISSUES = [
  { number: 3033, title: 'Pills fill the box', body: 'Tapping a pill should not send.' },
  { number: 3032, title: 'Propose asks inline', body: 'Not a full-screen dialog.' },
  { number: 3028, title: 'Spinner replaces the icon', body: '' },
  { number: 2961, title: 'Something else', body: '' },
];

// A platform that answers the loopback calls prepare_work and submit_work
// make, recording each one.
async function withPlatform(calls, fn) {
  const original = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(`${init.method || 'GET'} ${u.pathname}`);
    let body = {};
    if (u.pathname === '/api/apps/recipe-box') body = { app: APP };
    else if (u.pathname === '/api/apps/recipe-box/github-issues') body = { issues: OPEN_ISSUES };
    else if (u.pathname.endsWith('/comments')) body = { comments: [] };
    else if (u.pathname.endsWith('/claim')) body = { ok: true };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
}

function stubService(name, impl) {
  const original = svc[name];
  svc[name] = impl;
  return () => { svc[name] = original; };
}

test('prepare_work takes requestNumbers and hands every request to the job', async () => {
  const { handlers, specs } = collectTools();
  assert.ok(specs.get('prepare_work').inputSchema.requestNumbers, 'declared in the input schema');
  assert.ok(specs.get('prepare_work').outputSchema.requestNumbers, 'and reported back');

  let seen = null;
  const restore = stubService('prepareWork', async (_deps, params) => {
    seen = params;
    return {
      ok: true, taskId: 70, requestNumbers: params.issueNumbers, openProposals: [],
      forkUrl: 'f', forkPageUrl: 'p', forkStatus: 'ready', branch: 'b', baseSha: BASE_SHA,
      guidance: [], workOrder: 'w', reused: false, proposalId: null, branchHome: null,
    };
  });
  const calls = [];
  try {
    const res = await withPlatform(calls, () => handlers.get('prepare_work')({
      slug: 'recipe-box', requestNumbers: [3032, 3028], requestNumber: 3033, brief: 'All three, one proposal.',
    }));
    assert.ok(!res.isError, JSON.stringify(res.structuredContent));
    assert.deepEqual(seen.issueNumbers, [3033, 3032, 3028], 'requestNumber leads the list');

    // Each request is quoted, the first unlabelled so its title still names
    // the job, the rest introduced by their numbers; the caller's brief last.
    const brief = seen.brief;
    assert.ok(brief.startsWith('<untrusted-content>Pills fill the box</untrusted-content>'));
    assert.match(brief, /\n\nAlso request #3032:\n\n<untrusted-content>Propose asks inline<\/untrusted-content>/);
    assert.match(brief, /\n\nAlso request #3028:\n\n<untrusted-content>Spinner replaces the icon<\/untrusted-content>/);
    assert.ok(brief.endsWith('<untrusted-content>All three, one proposal.</untrusted-content>'));

    // One claim each, and each request's discussion read.
    for (const n of [3033, 3032, 3028]) {
      assert.ok(calls.includes(`POST /api/apps/recipe-box/github-issues/${n}/claim`), `claims #${n}`);
      assert.ok(calls.includes(`GET /api/apps/recipe-box/github-issues/${n}/comments`), `reads #${n}'s thread`);
    }
    assert.deepEqual(res.structuredContent.requestNumbers, [3033, 3032, 3028]);
    assert.deepEqual(res.structuredContent.claimedRequests, [3033, 3032, 3028]);
    assert.equal(res.structuredContent.claimedRequest, true);
  } finally {
    restore();
  }
});

test('a request that is not open is named, and nothing is prepared', async () => {
  const { handlers } = collectTools();
  let called = false;
  const restore = stubService('prepareWork', async () => { called = true; return { ok: true }; });
  try {
    const res = await withPlatform([], () => handlers.get('prepare_work')({
      slug: 'recipe-box', requestNumbers: [3033, 9999, 8888],
    }));
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.code, 'no_access');
    assert.match(res.structuredContent.message, /Requests #9999, #8888 are not open on this app/);
    assert.equal(called, false);
  } finally {
    restore();
  }
});

test('several requests share the brief evenly instead of the last one being cut', () => {
  const limit = svc.MAX_BRIEF_CHARS;
  // One request keeps the budgets it always had.
  assert.deepEqual(tools.requestTextBudget(1, '', limit), { body: tools.MAX_BODY_CHARS, discussion: 2500 });
  for (const count of [2, 3, 5]) {
    for (const brief of ['', 'x'.repeat(400), 'x'.repeat(5000)]) {
      const { body, discussion } = tools.requestTextBudget(count, brief, limit);
      assert.ok(body >= 200 && discussion >= 200, `${count}/${brief.length}: every request says something`);
      assert.ok(body <= tools.MAX_BODY_CHARS && discussion <= 2500, 'never more than one request gets');
      // Every request at its worst (a full title, a clipped body and thread,
      // the label, envelopes and clip marks) plus the caller's brief fits.
      const perRequest = tools.MAX_TITLE_CHARS + body + discussion + 180;
      const total = count * perRequest + (brief ? Math.min(brief.length, tools.MAX_BODY_CHARS) + 64 : 0);
      assert.ok(total <= limit + 16 || body === 200, `${count}/${brief.length}: ${total} > ${limit}`);
    }
  }
});

test('submit_work points at update_proposal_issues when the brief names open requests it did not link', async () => {
  const { handlers, specs } = collectTools();
  assert.ok(specs.get('submit_work').outputSchema.linkedIssues, 'what it linked is reported');
  const submitted = (over) => async () => ({
    ok: true, proposalId: 4900, prNumber: 3050, prUrl: 'u', appSlug: 'recipe-box',
    externalAgent: 'claude-code', submittedVia: 'branch', ...over,
  });

  // Nothing linked; the brief mentions an open request, a closed one and a
  // pull request. Only the open request is suggested.
  let restore = stubService('submitWork', submitted({ linkedIssues: [], mentionedIssues: [3033, 3040, 12] }));
  try {
    const res = await withPlatform([], () => handlers.get('submit_work')({ taskId: 70, branch: 'b' }));
    assert.deepEqual(res.structuredContent.linkedIssues, []);
    assert.match(res.structuredContent.nextStep,
      /It is linked to no request, so no request closes when it merges\. Its brief mentions open request #3033: if this change implements it, call update_proposal_issues with proposalId 4900 and addIssues \[3033\]/);
    assert.doesNotMatch(res.structuredContent.nextStep, /3040|\b12\b/);
  } finally {
    restore();
  }

  // Linked already: nothing to suggest, and no extra read.
  restore = stubService('submitWork', submitted({ linkedIssues: [3033, 3032], mentionedIssues: [] }));
  const calls = [];
  try {
    const res = await withPlatform(calls, () => handlers.get('submit_work')({ taskId: 70, branch: 'b' }));
    assert.deepEqual(res.structuredContent.linkedIssues, [3033, 3032]);
    assert.doesNotMatch(res.structuredContent.nextStep, /update_proposal_issues/);
    assert.ok(!calls.includes('GET /api/apps/recipe-box/github-issues'));
  } finally {
    restore();
  }
});

test('the charter and the tool say where several requests go', () => {
  const { specs } = collectTools();
  const spec = specs.get('prepare_work');
  assert.match(spec.inputSchema.requestNumbers.description,
    /Only requests named here or in requestNumber are linked: a number written into brief is not\./);
  assert.match(require('../src/services/mcp-charter').CHARTER_FULL,
    /prepare_work does it for you for every request you pass it in requestNumber or requestNumbers/);
});

test('more requests than one work order holds is refused, not quietly cut', async () => {
  const { handlers } = collectTools();
  let called = false;
  const restore = stubService('prepareWork', async () => { called = true; return { ok: true }; });
  const calls = [];
  try {
    // requestNumbers alone is capped by the schema; requestNumber on top of
    // a full list would otherwise drop the last one without saying so.
    const res = await withPlatform(calls, () => handlers.get('prepare_work')({
      slug: 'recipe-box', requestNumber: 1, requestNumbers: [2, 3, 4, 5, 6],
    }));
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.code, 'invalid_request');
    assert.match(res.structuredContent.message, /at most 5 requests/);
    assert.equal(called, false);
    assert.ok(!calls.some((c) => c.includes('/claim')), 'nothing claimed');
  } finally {
    restore();
  }
});
