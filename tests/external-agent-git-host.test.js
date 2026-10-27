'use strict';

// The connector's external-agent path for an app on Homeroom's own git host.
//
// Since 26 Oct 2026 every app but the platform itself lives on Homeroom's git
// host (services/git-host.js), publicly readable, with no GitHub repository
// behind it. Until this existed prepare_work and submit_work refused all of
// them (`no_repository`), so no outside coding agent could build or revise a
// change for any of them. What is pinned here:
//
//   1. prepare_work accepts such an app with NO GitHub link (attribution is
//      the Homeroom user), bases the work on the git host's main, and writes a
//      work order that clones the PUBLIC repository and hands in a patch: no
//      fork, no push, no GitHub remedy.
//   2. submit_work refuses the two shapes that cannot mean anything there (a
//      pushed branch, a pull request number) with what does work instead,
//      before any GitHub link is asked about.
//   3. The update route takes a patch for such a proposal with no link, and
//      refuses a branch the same way.
//   4. get_proposal says 'git_host' and names the patch call, not a fork.
//
// The end-to-end apply and the native proposal are in
// tests/external-agent-git-host-postgres.test.js.
//
// Run with: node --test tests/external-agent-git-host.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, {
  GIT_HOST_URL: 'https://git.example.test',
  GIT_HOST_INTERNAL_URL: 'http://forgejo.internal:3000',
  GIT_HOST_ORG: 'apps',
});

const svc = require('../src/services/external-agent-tasks');
const proposalUpdate = require('../src/services/proposal-update');
const tools = require('../src/services/mcp-tools');

const APP = {
  id: 9, slug: 'tide-log', name: 'Tide Log',
  repo_url: 'https://git.example.test/apps/tide-log',
};
const GITHUB_APP = {
  id: 7, slug: 'recipe-box', name: 'Recipe Box',
  repo_url: 'https://github.com/usernode-bot/recipe-box',
};
const BASE_SHA = `ba5e${'1'.repeat(34)}fe`;
const PUBLIC_CLONE = 'https://git.example.test/apps/tide-log.git';

function fakePool(handlers, queries) {
  return {
    async query(sql, params) {
      queries.push({ sql, params });
      for (const [needle, rows] of handlers) {
        if (sql.includes(needle)) return { rows: typeof rows === 'function' ? rows(params) : rows };
      }
      throw new Error(`unstubbed query: ${sql.slice(0, 80)}`);
    },
  };
}

const okLimits = { checkOpenWorkOrders: async () => null, checkPromotedCap: async () => null };

// A deployment with no GitHub OAuth app, and a link that must never be read:
// a hosted app needs neither.
const noLink = {
  isEnabled: () => false,
  linkStatus: async () => { throw new Error('the GitHub link must not be consulted for a git-host app'); },
};

function hostedGh(calls = []) {
  return {
    isEnabled: () => true,
    parseGithubUrl: () => { throw new Error('a git-host address is never parsed as GitHub'); },
    getBranchSha: async (owner, repo, branch) => { calls.push([owner, repo, branch]); return BASE_SHA; },
  };
}

// No GitHub read happens on this path at all, not even the public one.
function noFetch(fn) {
  const original = global.fetch;
  global.fetch = async (url) => { throw new Error(`no network on this path: ${url}`); };
  return Promise.resolve(fn()).finally(() => { global.fetch = original; });
}

async function prepareHosted(params = {}, { queries = [], ghCalls = [] } = {}) {
  const pool = fakePool([['INSERT INTO external_agent_tasks', [{ id: 51 }]]], queries);
  return noFetch(() => svc.prepareWork(
    { pool, config: {}, gh: hostedGh(ghCalls), githubLink: noLink, limits: okLimits },
    {
      user: { id: 3 }, app: APP, brief: '<untrusted-content>Show high tide in bold</untrusted-content>',
      clientName: 'Claude — claude.ai', origin: 'https://usernode.example', ...params,
    }
  ));
}

// ── 1. prepare_work ────────────────────────────────────────────────────

test('the clone address is the PUBLIC one, from the git host itself', () => {
  const repo = svc.gitHostRepoFor(APP.repo_url);
  assert.equal(repo.cloneUrl, PUBLIC_CLONE, 'never the in-cluster address the platform reads');
  assert.equal(repo.webUrl, 'https://git.example.test/apps/tide-log');
  assert.equal(repo.host, 'git.example.test');
  assert.equal(repo.dir, 'tide-log');
  assert.equal(svc.gitHostRepoFor(GITHUB_APP.repo_url), null, 'an app on GitHub has none');
});

test('prepare_work takes a git-host app with no GitHub link, based at its main', async () => {
  const queries = [];
  const ghCalls = [];
  const result = await prepareHosted({}, { queries, ghCalls });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.repoHost, 'git_host');
  assert.equal(result.cloneUrl, PUBLIC_CLONE);
  assert.equal(result.forkStatus, 'not_needed');
  assert.equal(result.forkUrl, null);
  assert.equal(result.forkPageUrl, null);
  assert.equal(result.baseSha, BASE_SHA);
  // The base is the git host's main, read through the platform's own helper.
  assert.deepEqual(ghCalls, [['apps', 'tide-log', 'main']]);
  // The task row names the app's own repository where a fork would go.
  const insert = queries.find((q) => q.sql.includes('INSERT INTO external_agent_tasks'));
  assert.deepEqual(insert.params.slice(3, 5), ['apps', 'tide-log']);
});

test('its work order clones the public repository and hands in a patch, never a fork', async () => {
  const { workOrder, branch } = await prepareHosted();
  assert.ok(workOrder.includes(`git clone ${PUBLIC_CLONE} tide-log`));
  assert.ok(workOrder.includes(`git fetch origin ${BASE_SHA}`));
  assert.ok(workOrder.includes(`git checkout -b ${branch} ${BASE_SHA}`));
  assert.ok(workOrder.includes(`git format-patch ${BASE_SHA}..HEAD --stdout`));
  assert.match(workOrder, /Homeroom's own git host, not on GitHub/);
  assert.match(workOrder, /with taskId 51 and the patch text from step 1 as `patch`/);
  assert.match(workOrder, /needs network access to git\.example\.test/, 'the likeliest refusal is named');
  // Nothing fork- or push-shaped survives.
  assert.doesNotMatch(workOrder, /gh repo fork|\/fork\b|git push|remote add upstream|pr_open_failed/);
  assert.doesNotMatch(workOrder, /IF A PUSH OR GITHUB CALL IS REFUSED|github_not_linked/);
  assert.doesNotMatch(workOrder, /YOUR FORK|your fork/);
  // And everything else it carries is kept.
  assert.match(workOrder, /RULES/);
  assert.match(workOrder, /<untrusted-content>Show high tide in bold<\/untrusted-content>/);
  assert.match(workOrder, /npm run test:changed -- --base /);
  assert.match(workOrder, /`summary` is the USER-FACING half/);
  assert.match(workOrder, /THEN CHECK THE CHECKS/);
  assert.match(workOrder, /call `prepare_work` with that id as\n {3}`proposalId`/);
});

test('its guidance has no copy to make and passes the hand-off rules', async () => {
  for (const clientName of ['Claude — claude.ai', 'ChatGPT — chatgpt.com', null]) {
    const result = await prepareHosted({ clientName });
    assert.equal(result.ok, true);
    for (const step of result.guidance) {
      assert.ok(step.length <= svc.MAX_GUIDANCE_CHARS, `too long: ${step}`);
      assert.doesNotMatch(step, /will clone|create the branch|pull request|it will /i, step);
      assert.ok(!step.includes('git '), `no git commands in guidance: ${step}`);
      assert.doesNotMatch(step, /fork/i, `no copy to make: ${step}`);
    }
    assert.match(result.guidance[result.guidance.length - 2], /exactly as written/);
    assert.match(result.guidance[result.guidance.length - 1], /submit the change to Homeroom itself/);
  }
  const claude = await prepareHosted({ clientName: 'Claude — claude.ai' });
  assert.ok(claude.guidance.some((s) => s.includes('git.example.test')), 'the host its sandbox must reach');
});

test('an update work order starts at the proposal\'s head on the git host and is answered by patch', async () => {
  const ghCalls = [];
  const session = {
    id: 812, user_id: 3, app_id: 9, status: 'promoted', source: 'imported',
    branch_name: 'usernode/patch-u3-t51-ab12cd34', pr_title: 'Bold high tide', repo_url: APP.repo_url,
    imported_pr_head_repo: 'apps/tide-log',
  };
  const result = await prepareHosted({ targetProposal: session }, { ghCalls });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.proposalId, 812);
  assert.deepEqual(ghCalls, [['apps', 'tide-log', session.branch_name]], 'the base is the proposal\'s head');
  const order = result.workOrder;
  assert.match(order, /UPDATING a proposal/);
  assert.match(order, /hand the change in as a patch, and\nHomeroom moves the proposal onto it/);
  assert.match(order, /with taskId 51 and the patch text from step 1 as `patch`, agent/);
  assert.match(order, /`branch_moved`/);
  assert.ok(order.includes('git fetch origin <headSha>'));
  assert.doesNotMatch(order, /git push|your fork|YOUR FORK|upstream/);
  assert.doesNotMatch(order, /patchUploadId/, 'an update\'s patch goes inline');
});

test('an update to a proposal whose code never reached the git host is refused before any work', async () => {
  const session = {
    id: 813, user_id: 3, app_id: 9, status: 'promoted', source: 'native',
    branch_name: 'dev/ada-1', repo_url: APP.repo_url,
  };
  const pool = fakePool([['INSERT INTO external_agent_tasks', [{ id: 52 }]]], []);
  const gh = { ...hostedGh(), getBranchSha: async () => { throw Object.assign(new Error('Branch not found'), { status: 404 }); } };
  const result = await noFetch(() => svc.prepareWork(
    { pool, config: {}, gh, githubLink: noLink, limits: okLimits },
    { user: { id: 3 }, app: APP, brief: 'x', origin: 'https://usernode.example', targetProposal: session }
  ));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'code_missing');

  // And a pre-move head in a GitHub fork, which nothing follows any more.
  const forked = { ...session, id: 814, source: 'imported', imported_pr_head_repo: 'someuser/tide-log' };
  const refused = svc.describeTargetProposal(forked, { id: 3 }, APP, 'https://usernode.example');
  assert.equal(refused.code, 'code_missing');
});

test('the GitHub path is untouched: a GitHub app still needs the link', async () => {
  const result = await svc.prepareWork(
    {
      pool: fakePool([], []), config: {},
      gh: { isEnabled: () => true, parseGithubUrl: () => ({ owner: 'usernode-bot', repo: 'recipe-box' }) },
      githubLink: { isEnabled: () => true, linkStatus: async () => ({ linked: false }) },
      limits: okLimits,
    },
    { user: { id: 3 }, app: GITHUB_APP, brief: 'x', origin: 'https://usernode.example' }
  );
  assert.equal(result.code, 'github_not_linked');
});

// ── 2. submit_work's shapes ────────────────────────────────────────────

function hostedTaskPool(queries, overrides = {}) {
  const task = {
    id: 51, user_id: 3, app_id: 9, status: 'open', fork_owner: 'apps', fork_repo: 'tide-log',
    branch_name: 'usernode/tide-log-task-abc123', base_sha: BASE_SHA, app_slug: 'tide-log',
    app_name: 'Tide Log', repo_url: APP.repo_url, target_session_id: null, session_id: null,
    linked_issues: [], ...overrides,
  };
  return fakePool([
    ['FROM external_agent_tasks t JOIN apps a', [task]],
    ['FROM external_agent_tasks t\n         JOIN apps a', [task]],
  ], queries);
}

test('a pushed branch or a pull request number is refused for a git-host app, with the patch call', async () => {
  for (const shape of [
    { taskId: 51, branch: 'my-work' },
    { taskId: 51 },
    { slug: 'tide-log', prNumber: 4, repoUrl: APP.repo_url },
    { taskId: 51, branch: 'my-work', share: true },
  ]) {
    const result = await noFetch(() => svc.submitWork(
      { pool: hostedTaskPool([]), config: {}, gh: hostedGh(), githubLink: noLink, limits: okLimits },
      { user: { id: 3 }, origin: 'https://usernode.example', ...shape }
    ));
    assert.equal(result.ok, false, JSON.stringify(shape));
    assert.equal(result.code, 'patch_required', JSON.stringify(shape));
    assert.match(result.message, /git format-patch <baseSha>\.\.HEAD --stdout/);
    assert.match(result.message, /prepare_work with its proposalId/);
  }
});

test('a patch for a git-host app gets past the GitHub gates on a deployment with no OAuth app', async () => {
  // The promoted cap is the first thing after the gates: answering from it
  // proves the call reached the apply without a link of any kind.
  const result = await noFetch(() => svc.submitWork(
    {
      pool: hostedTaskPool([]), config: {}, gh: hostedGh(),
      githubLink: { isEnabled: () => false, linkStatus: async () => { throw new Error('not consulted'); } },
      limits: { ...okLimits, checkPromotedCap: async () => ({ code: 'at_capacity', message: 'cap reached' }) },
    },
    { user: { id: 3 }, taskId: 51, patch: 'diff --git a/x b/x\n', origin: 'https://usernode.example' }
  ));
  assert.equal(result.code, 'at_capacity');
});

test('an update task\'s branch is refused for a git-host proposal without a round trip', async () => {
  let called = false;
  const result = await noFetch(() => svc.submitWork(
    { pool: hostedTaskPool([], { target_session_id: 812 }), config: {}, gh: hostedGh(), githubLink: noLink, limits: okLimits },
    {
      user: { id: 3 }, taskId: 51, proposalId: 812, branch: 'my-work', origin: 'https://usernode.example',
      updateProposal: async () => { called = true; return { ok: true, body: {} }; },
    }
  ));
  assert.equal(result.code, 'patch_required');
  assert.equal(called, false);
});

// ── 3. The update route ────────────────────────────────────────────────

const HOSTED_SESSION = {
  id: 812, user_id: 3, app_id: 9, status: 'promoted', source: 'imported',
  branch_name: 'usernode/patch-u3-t51-ab12cd34', repo_url: APP.repo_url, app_slug: 'tide-log',
  imported_pr_head_repo: 'apps/tide-log', pr_number: 6,
};

test('the update route refuses a branch for a git-host proposal, before any link is read', async () => {
  const result = await proposalUpdate.updateProposalFromForkBranch(
    { pool: fakePool([], []), config: {}, gh: hostedGh(), githubLink: noLink },
    { user: { id: 3 }, session: HOSTED_SESSION, branch: 'my-work' }
  );
  assert.equal(result.code, 'patch_required');
  assert.match(result.message, /prepare_work with this proposalId/);
});

test('the update route applies a patch on a git-host proposal with no GitHub link', async () => {
  const applied = [];
  const result = await proposalUpdate.updateProposalFromForkBranch(
    {
      pool: fakePool([['FROM chat_sessions cs JOIN apps a', [HOSTED_SESSION]], ['pr_votes', [{ n: 2 }]]], []),
      config: {},
      gh: { ...hostedGh(), getBranchSha: async () => BASE_SHA },
      githubLink: noLink,
      busy: async () => false,
      beginOperation: () => () => {},
      lock: (pool, id, fn) => fn(),
      applyPatch: async (args) => { applied.push(args); return { ok: false, code: 'branch_moved', message: 'moved' }; },
    },
    { user: { id: 3 }, session: HOSTED_SESSION, patch: 'diff --git a/x b/x\n', expectedHeadSha: BASE_SHA }
  );
  // The apply ran, on the proposal's own branch at its head, as its owner.
  assert.equal(applied.length, 1);
  assert.equal(applied[0].owner, 'apps');
  assert.equal(applied[0].repo, 'tide-log');
  assert.equal(applied[0].targetBranch, HOSTED_SESSION.branch_name);
  assert.equal(applied[0].baseSha, BASE_SHA);
  assert.equal(result.code, 'branch_moved', 'and its refusal is passed through');
});

// ── 4. What get_proposal says ──────────────────────────────────────────

test('get_proposal reports a git-host home and the patch call, not a fork', () => {
  const failing = tools.shapeProposal({
    ...HOSTED_SESSION, check_state: 'failing',
    test_results: [{ name: 'Board shows high tide', status: 'fail' }],
  }, 'https://usernode.example');
  assert.equal(failing.branch.home, 'git_host');
  assert.equal(failing.branch.youCanPush, false);
  assert.match(failing.branch.updateWith, /prepare_work with proposalId 812/);
  assert.match(failing.branch.updateWith, /patch/);
  assert.match(failing.nextStep, /call prepare_work with proposalId 812 for an update work order, then submit_work/);
  assert.doesNotMatch(failing.nextStep, /fork alone|in your OWN fork|push to a branch/);

  const passing = tools.shapeProposal({ ...HOSTED_SESSION, check_state: 'passing' }, 'https://usernode.example');
  assert.match(passing.nextStep, /prepare_work with proposalId 812/);
  assert.doesNotMatch(passing.nextStep, /fork/);

  const underway = tools.shapeProposal({ ...HOSTED_SESSION, status: 'active' }, 'https://usernode.example', 3);
  assert.match(underway.nextStep, /propose: true/);
  assert.match(underway.nextStep, /prepare_work with proposalId 812/);
  assert.doesNotMatch(underway.nextStep, /your own fork/);

  // A GitHub app's proposal reads exactly as before.
  const github = tools.shapeProposal({
    id: 63, app_slug: 'recipe-box', status: 'promoted', check_state: 'failing', source: 'native',
    branch_name: 'dev/x', repo_url: GITHUB_APP.repo_url,
    test_results: [{ name: 'Board shows the snap toggle', status: 'fail' }],
  }, 'https://usernode.example');
  assert.equal(github.branch.home, 'app_repo');
  assert.match(github.nextStep, /pushing to your fork alone does not move it/);
});
