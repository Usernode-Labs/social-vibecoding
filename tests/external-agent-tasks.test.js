// Hosted MCP connector — handing work to the user's own coding agent.
//
// This service is the only place the platform uses a USER'S GitHub token,
// and the only place a proposal can be created without a human clicking
// anything. The tests below are weighted accordingly:
//
//   1. The attribution gate. A proposal opened this way carries the
//      caller's name and their agent's badge, so the pull request's head
//      must live in a repository owned by the login THEY verified. This is
//      checked on every path — created, adopted, and named-by-number — and
//      it must refuse before the platform is asked to import anything.
//   2. The caps are applied BEFORE a pull request is opened, so a refusal
//      never leaves a stray PR on someone's app.
//   3. The work order is complete and carries no credential, and the
//      user-written brief inside it stays marked as data.
//   4. source stays 'imported'. The connector adds an author, not a new
//      kind of proposal.
//
// Run with: node --test tests/external-agent-tasks.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const svc = require('../src/services/external-agent-tasks');

const SRC = fs.readFileSync(
  path.join(__dirname, '../src/services/external-agent-tasks.js'), 'utf8'
);

// ── Fakes ──────────────────────────────────────────────────────────────

// A fetch stub for the GitHub-as-the-user calls. `routes` maps
// "METHOD /path" to a response; anything unmatched is a hard failure so a
// test can never pass by accidentally hitting a real network path.
function fakeFetch(routes, calls) {
  return async (url, init) => {
    const method = (init && init.method) || 'GET';
    const pathname = String(url).replace('https://api.github.com', '');
    const key = `${method} ${pathname}`;
    calls.push({ key, body: init && init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const hit = routes[key];
    if (!hit) throw new Error(`unstubbed GitHub call: ${key}`);
    return {
      ok: hit.status >= 200 && hit.status < 300,
      status: hit.status,
      text: async () => (hit.body === undefined ? '' : JSON.stringify(hit.body)),
    };
  };
}

function withFetch(routes, calls, fn) {
  const original = global.fetch;
  global.fetch = fakeFetch(routes, calls);
  return Promise.resolve(fn()).finally(() => { global.fetch = original; });
}

// A pool that dispatches on a substring of the SQL, so a test states what
// it expects to be asked rather than the order it is asked in.
function fakePool(handlers, queries) {
  return {
    async query(sql, params) {
      queries.push({ sql, params });
      for (const [needle, rows] of handlers) {
        if (sql.includes(needle)) {
          return { rows: typeof rows === 'function' ? rows(params) : rows };
        }
      }
      throw new Error(`unstubbed query: ${sql.slice(0, 80)}`);
    },
  };
}

const okLimits = {
  checkPrepareRate: async () => null,
  checkPromotedCap: async () => null,
  checkProposalRate: async () => null,
};

const APP = {
  id: 7, slug: 'recipe-box', name: 'Recipe Box',
  repo_url: 'https://github.com/usernode-bot/recipe-box',
};

function baseGh(overrides = {}) {
  return {
    isEnabled: () => true,
    parseGithubUrl: (url) => {
      const m = /github\.com\/([^/]+)\/([^/.]+)/.exec(String(url || ''));
      return m ? { owner: m[1], repo: m[2] } : null;
    },
    getBranchSha: async () => 'base00000000000000000000000000000000sha',
    ...overrides,
  };
}

// A deployment that HAS a GitHub OAuth app configured, with this user
// linked through it. `isEnabled` is the deployment-level question asked
// before the per-user one — see connector-config-unset.test.js for the
// unconfigured deployment.
const linkedAs = (login) => ({
  isEnabled: () => true,
  loadUserToken: async () => ({ login, token: 'gho_fake' }),
});

// ── Agent vocabulary ───────────────────────────────────────────────────

test('the agent label is a closed vocabulary, inferred from the client', () => {
  assert.equal(svc.normalizeAgent('claude-code'), 'claude-code');
  assert.equal(svc.normalizeAgent('codex'), 'codex');
  // Inferred from the connected chat product when the tool call omits it.
  assert.equal(svc.normalizeAgent(null, 'Claude'), 'claude-code');
  assert.equal(svc.normalizeAgent(null, 'ChatGPT'), 'codex');
  assert.equal(svc.normalizeAgent(null, 'Some MCP Client'), 'external');
  // Anything a connector invents collapses to the generic label rather
  // than reaching the database, and therefore the badge.
  assert.equal(svc.normalizeAgent('Anthropic Ultra Deluxe'), 'external');
  assert.equal(svc.normalizeAgent('<script>alert(1)</script>'), 'external');
  for (const agent of [svc.normalizeAgent('nonsense'), svc.normalizeAgent('codex')]) {
    assert.ok(svc.AGENTS.includes(agent));
  }
});

test('branch names are namespaced and derived from platform identifiers only', () => {
  const branch = svc.branchNameFor('recipe-box', 42, 'abc123');
  assert.equal(branch, 'usernode/recipe-box-issue-42-abc123');
  assert.equal(svc.branchNameFor('recipe-box', null, 'abc123'), 'usernode/recipe-box-task-abc123');
  // A hostile slug cannot escape the namespace or the ref syntax.
  const nasty = svc.branchNameFor('../../evil branch~^:?*[', 0, 'abc123');
  assert.match(nasty, /^usernode\/[a-z0-9-]+-task-abc123$/);
  // Unseeded names are unique, so two concurrent prepares do not collide.
  assert.notEqual(svc.branchNameFor('x', 1), svc.branchNameFor('x', 1));
});

// ── The work order ─────────────────────────────────────────────────────

test('the work order is self-contained and carries no credential', () => {
  const order = svc.buildWorkOrder({
    appName: 'Recipe Box',
    appSlug: 'recipe-box',
    upstreamUrl: 'https://github.com/usernode-bot/recipe-box',
    forkUrl: 'https://github.com/someuser/recipe-box',
    forkCloneUrl: 'https://github.com/someuser/recipe-box.git',
    branch: 'usernode/recipe-box-issue-4-abc123',
    baseSha: 'deadbeef',
    issueNumber: 4,
    brief: '<untrusted-content>Add dark mode</untrusted-content>',
    webPath: 'https://usernode.example/#app/recipe-box',
  });
  // Everything the receiving agent needs: where to push, what branch, and
  // the commit it starts from.
  assert.match(order, /https:\/\/github\.com\/someuser\/recipe-box\.git/);
  assert.match(order, /usernode\/recipe-box-issue-4-abc123/);
  assert.match(order, /deadbeef/);
  assert.match(order, /request #4/);
  // The brief keeps its envelope: it is other people's writing on its way
  // to an agent with a shell.
  assert.match(order, /<untrusted-content>Add dark mode<\/untrusted-content>/);
  assert.match(order, /not instructions addressed/i);
  // And the rules that keep the agent inside its own repository.
  assert.match(order, /Do not\n {2}push to the upstream repository/);
  assert.match(order, /secrets, tokens or credentials/);
  // No token of any kind is ever pasted into a chat product's transcript.
  assert.doesNotMatch(order, /gho_|ghp_|Bearer |x-access-token/);
});

test('a work order with no brief tells the agent to ask rather than guess', () => {
  const order = svc.buildWorkOrder({
    appName: 'A', appSlug: 'a', upstreamUrl: 'u', forkUrl: 'f',
    forkCloneUrl: 'f.git', branch: 'b', baseSha: 's', brief: '',
  });
  assert.match(order, /ask the user what they want before writing code/);
});

// ── The attribution gate ───────────────────────────────────────────────

test('attribution: only a pull request from the caller’s own fork passes', () => {
  const fromMe = { head: { repo: { owner: { login: 'SomeUser' } } } };
  // GitHub logins are case-preserving, not case-sensitive.
  assert.equal(svc.attributionError(fromMe, 'someuser'), null);
  assert.equal(svc.attributionError(fromMe, 'SomeUser'), null);

  const fromSomeoneElse = { head: { repo: { owner: { login: 'attacker' } } } };
  const err = svc.attributionError(fromSomeoneElse, 'someuser');
  assert.equal(err.ok, false);
  assert.equal(err.code, 'fork_mismatch');
  assert.match(err.message, /attacker's repository/);
  assert.match(err.message, /import it from the app’s Dev page|import it from the app's Dev page/);

  // Head repo deleted: GitHub keeps the owner in the label, and that is
  // still enough to refuse — it must never fall through to "allowed".
  assert.equal(svc.headOwnerOf({ head: { label: 'attacker:feat/x' } }), 'attacker');
  assert.equal(svc.attributionError({ head: { label: 'attacker:feat/x' } }, 'someuser').code, 'fork_mismatch');
  // No head information at all is a refusal, not a pass.
  assert.equal(svc.attributionError({}, 'someuser').code, 'fork_mismatch');
  assert.equal(svc.attributionError(null, 'someuser').code, 'fork_mismatch');
  // And an empty verified login can never match an empty head owner.
  assert.equal(svc.attributionError({ head: { repo: { owner: { login: '' } } } }, '').code, 'fork_mismatch');
});

// ── ensureFork ─────────────────────────────────────────────────────────

test('a same-named repo that is not our fork is a named conflict, never touched', async () => {
  const calls = [];
  await withFetch({
    'GET /repos/someuser/recipe-box': { status: 200, body: { fork: false, name: 'recipe-box' } },
  }, calls, async () => {
    const result = await svc.ensureFork('t', 'someuser', { owner: 'usernode-bot', repo: 'recipe-box' });
    assert.equal(result.state, 'fork_name_conflict');
  });
  assert.equal(calls.length, 1, 'nothing is written to that repository');

  // A fork of a DIFFERENT upstream with the same name is also a conflict.
  const calls2 = [];
  await withFetch({
    'GET /repos/someuser/recipe-box': {
      status: 200, body: { fork: true, name: 'recipe-box', parent: { full_name: 'elsewhere/recipe-box' } },
    },
  }, calls2, async () => {
    const result = await svc.ensureFork('t', 'someuser', { owner: 'usernode-bot', repo: 'recipe-box' });
    assert.equal(result.state, 'fork_name_conflict');
  });
});

test('a fork GitHub is still creating reports fork_pending, not failure', async () => {
  const calls = [];
  await withFetch({
    'GET /repos/someuser/recipe-box': { status: 404, body: { message: 'Not Found' } },
    'POST /repos/usernode-bot/recipe-box/forks': { status: 202, body: { name: 'recipe-box' } },
  }, calls, async () => {
    // The confirming re-read hits the same stubbed 404 (fork not visible yet).
    const result = await svc.ensureFork('t', 'someuser', { owner: 'usernode-bot', repo: 'recipe-box' });
    assert.equal(result.state, 'fork_pending');
  });
  assert.equal(calls[1].body.default_branch_only, true, 'only the default branch is copied');
});

// ── prepareWork ────────────────────────────────────────────────────────

const PREPARE_ROUTES = {
  'GET /repos/someuser/recipe-box': {
    status: 200,
    body: { fork: true, name: 'recipe-box', parent: { full_name: 'usernode-bot/recipe-box' } },
  },
  'POST /repos/someuser/recipe-box/merge-upstream': { status: 200, body: {} },
  'POST /repos/someuser/recipe-box/git/refs': { status: 201, body: {} },
};

test('prepare_work reserves the branch at the UPSTREAM base commit', async () => {
  const queries = [];
  const calls = [];
  const pool = fakePool([['INSERT INTO external_agent_tasks', [{ id: 31 }]]], queries);
  const result = await withFetch(PREPARE_ROUTES, calls, () => svc.prepareWork(
    { pool, config: {}, gh: baseGh(), githubLink: linkedAs('someuser'), limits: okLimits },
    {
      user: { id: 3 }, app: APP, issueNumber: 4,
      brief: '<untrusted-content>Add dark mode</untrusted-content>',
      clientId: 'claude-ai', origin: 'https://usernode.example',
    }
  ));

  assert.equal(result.ok, true);
  assert.equal(result.taskId, 31);
  assert.equal(result.forkOwner, 'someuser');
  assert.equal(result.baseSha, 'base00000000000000000000000000000000sha');
  assert.match(result.branch, /^usernode\/recipe-box-issue-4-/);

  // The ref is created at the sha read from upstream with the platform's
  // own credentials — never at whatever the fork happens to be at.
  const refCall = calls.find((c) => c.key.endsWith('/git/refs'));
  assert.equal(refCall.body.sha, 'base00000000000000000000000000000000sha');
  assert.equal(refCall.body.ref, `refs/heads/${result.branch}`);
  assert.match(refCall.headers.authorization, /^Bearer gho_fake$/,
    'the fork is written with the USER’s token, not the bot’s');

  // The row records the reservation so submit_work can find it again.
  const insert = queries.find((q) => q.sql.includes('INSERT INTO external_agent_tasks'));
  assert.deepEqual(insert.params.slice(0, 3), [3, 7, 4]);
  assert.equal(insert.params[5], result.branch);
});

test('prepare_work refuses before any GitHub write when GitHub is not linked', async () => {
  const queries = [];
  let fetched = false;
  const original = global.fetch;
  global.fetch = async () => { fetched = true; throw new Error('should not be called'); };
  try {
    const result = await svc.prepareWork(
      {
        pool: fakePool([], queries), config: {}, gh: baseGh(),
        githubLink: { isEnabled: () => true, loadUserToken: async () => null }, limits: okLimits,
      },
      { user: { id: 3 }, app: APP, brief: 'x', origin: 'https://usernode.example' }
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'github_not_linked');
    assert.equal(result.settingsUrl, 'https://usernode.example/#settings/connectors');
    assert.equal(fetched, false);
    assert.equal(queries.length, 0, 'and nothing is recorded');
  } finally {
    global.fetch = original;
  }
});

test('prepare_work is bounded before it forks anything', async () => {
  const queries = [];
  let fetched = false;
  const original = global.fetch;
  global.fetch = async () => { fetched = true; throw new Error('should not be called'); };
  try {
    const result = await svc.prepareWork(
      {
        pool: fakePool([], queries), config: {}, gh: baseGh(),
        githubLink: linkedAs('someuser'),
        limits: { ...okLimits, checkPrepareRate: async () => ({ code: 'at_capacity', message: 'Slow down.' }) },
      },
      { user: { id: 3 }, app: APP, brief: 'x', origin: 'https://usernode.example' }
    );
    assert.equal(result.code, 'at_capacity');
    assert.equal(result.retryable, true);
    assert.equal(fetched, false, 'a rate-limited caller never reaches GitHub');
  } finally {
    global.fetch = original;
  }
});

test('a diverged fork is reported honestly rather than force-branched', async () => {
  const queries = [];
  const calls = [];
  const result = await withFetch({
    ...PREPARE_ROUTES,
    'POST /repos/someuser/recipe-box/git/refs': { status: 422, body: { message: 'Object does not exist' } },
  }, calls, () => svc.prepareWork(
    { pool: fakePool([], queries), config: {}, gh: baseGh(), githubLink: linkedAs('someuser'), limits: okLimits },
    { user: { id: 3 }, app: APP, brief: 'x', origin: 'https://usernode.example' }
  ));
  assert.equal(result.code, 'fork_out_of_sync');
  assert.match(result.message, /Sync it with the upstream repository/);
  // Sync-and-retry was attempted once before giving up.
  assert.equal(calls.filter((c) => c.key.endsWith('/git/refs')).length, 2);
  assert.equal(queries.length, 0, 'no task row is left behind for a branch that does not exist');
});

// ── submitWork ─────────────────────────────────────────────────────────

const TASK_ROW = {
  id: 31, user_id: 3, app_id: 7, issue_number: 4,
  fork_owner: 'someuser', fork_repo: 'recipe-box',
  branch_name: 'usernode/recipe-box-issue-4-abc123',
  base_sha: 'base00000000000000000000000000000000sha',
  brief: 'Add dark mode', status: 'open',
  app_slug: 'recipe-box', app_name: 'Recipe Box',
  repo_url: 'https://github.com/usernode-bot/recipe-box',
};

const PUSHED_BRANCH = {
  'GET /repos/someuser/recipe-box/branches/usernode%2Frecipe-box-issue-4-abc123': {
    status: 200, body: { commit: { sha: 'newsha1111111111111111111111111111111' } },
  },
};

function submitPool(queries, extra = []) {
  return fakePool([
    ['FROM external_agent_tasks t JOIN apps a', [TASK_ROW]],
    ['UPDATE chat_sessions SET external_agent', []],
    ['UPDATE external_agent_tasks', []],
    ...extra,
  ], queries);
}

test('submit_work opens the cross-fork PR and stamps the agent on the session', async () => {
  const queries = [];
  const calls = [];
  const created = [];
  const imports = [];
  const gh = baseGh({
    findOpenPrByBranch: async () => null,
    createPR: async (owner, repo, opts) => {
      created.push({ owner, repo, opts });
      return { number: 88, html_url: 'https://github.com/usernode-bot/recipe-box/pull/88', head: { repo: { owner: { login: 'SomeUser' } } } };
    },
  });

  const result = await withFetch(PUSHED_BRANCH, calls, () => svc.submitWork(
    { pool: submitPool(queries), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
    {
      user: { id: 3 }, clientName: 'Claude', taskId: 31, title: 'Dark mode',
      body: 'Adds a toggle.',
      importProposal: async (slug, prNumber) => {
        imports.push({ slug, prNumber });
        return { ok: true, status: 200, body: { sessionId: 55 } };
      },
    }
  ));

  assert.equal(result.ok, true);
  assert.equal(result.proposalId, 55);
  assert.equal(result.prNumber, 88);
  assert.equal(result.externalAgent, 'claude-code');

  // The PR targets the app's repo but its head is the user's fork.
  assert.equal(created[0].owner, 'usernode-bot');
  assert.equal(created[0].opts.head, 'someuser:usernode/recipe-box-issue-4-abc123');

  // The proposal is made by the platform's own import route, replaying the
  // caller's token — this service never inserts a chat_sessions row itself.
  assert.deepEqual(imports, [{ slug: 'recipe-box', prNumber: 88 }]);
  assert.doesNotMatch(SRC, /INSERT INTO chat_sessions/);

  // The only thing stamped afterwards is the badge column, scoped to the
  // caller's own row. source is untouched, so an imported proposal keeps
  // behaving like one.
  const stamp = queries.find((q) => q.sql.includes('UPDATE chat_sessions SET external_agent'));
  assert.deepEqual(stamp.params, ['claude-code', 55, 3]);
  assert.doesNotMatch(SRC, /source\s*=\s*'(?!imported)/);
  assert.doesNotMatch(SRC, /SET source/);

  // And the reservation is closed so it stops counting against the caps.
  const close = queries.find((q) => q.sql.includes('UPDATE external_agent_tasks'));
  assert.match(close.sql, /status = 'submitted'/);
});

test('submit_work refuses a pull request from someone else’s fork before importing', async () => {
  const queries = [];
  const calls = [];
  let imported = false;
  const gh = baseGh({
    findOpenPrByBranch: async () => ({
      number: 90, html_url: 'x', head: { repo: { owner: { login: 'attacker' } } },
    }),
    createPR: async () => { throw new Error('should not create'); },
  });

  const result = await withFetch(PUSHED_BRANCH, calls, () => svc.submitWork(
    { pool: submitPool(queries), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
    {
      user: { id: 3 }, taskId: 31,
      importProposal: async () => { imported = true; return { ok: true, body: {} }; },
    }
  ));

  assert.equal(result.code, 'fork_mismatch');
  assert.equal(imported, false, 'the platform is never asked to import it');
  assert.ok(!queries.some((q) => q.sql.includes('UPDATE chat_sessions')));
});

test('submitting an already-open pull request by number is gated the same way', async () => {
  const queries = [];
  let imported = false;
  const gh = baseGh({
    getPR: async () => ({ number: 77, state: 'open', head: { repo: { owner: { login: 'someone-else' } } } }),
  });
  const result = await svc.submitWork(
    { pool: fakePool([], queries), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
    {
      user: { id: 3 }, prNumber: 77, slug: 'recipe-box',
      repoUrl: 'https://github.com/usernode-bot/recipe-box',
      importProposal: async () => { imported = true; return { ok: true, body: {} }; },
    }
  );
  assert.equal(result.code, 'fork_mismatch');
  assert.equal(imported, false);
});

test('the promoted-session cap is applied before a pull request is opened', async () => {
  const queries = [];
  let createdPr = false;
  const gh = baseGh({
    findOpenPrByBranch: async () => null,
    createPR: async () => { createdPr = true; return { number: 1 }; },
  });
  const result = await svc.submitWork(
    {
      pool: submitPool(queries), config: {}, gh, githubLink: linkedAs('someuser'),
      limits: {
        ...okLimits,
        checkPromotedCap: async () => ({
          code: 'at_capacity',
          message: 'You already have 5 PRs up for vote. Wait for one to merge, or archive one first.',
        }),
      },
    },
    { user: { id: 3 }, taskId: 31, importProposal: async () => ({ ok: true, body: {} }) }
  );
  assert.equal(result.code, 'at_capacity');
  assert.match(result.message, /5 PRs up for vote/, 'the browser’s own wording');
  assert.equal(createdPr, false, 'a refused submit leaves no stray pull request behind');
});

test('an unpushed or empty branch is named precisely instead of failing at GitHub', async () => {
  const gh = baseGh({ findOpenPrByBranch: async () => null, createPR: async () => ({ number: 1 }) });
  const deps = () => ({
    pool: submitPool([]), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits,
  });
  const params = { user: { id: 3 }, taskId: 31, importProposal: async () => ({ ok: true, body: {} }) };

  const notPushed = await withFetch({
    'GET /repos/someuser/recipe-box/branches/usernode%2Frecipe-box-issue-4-abc123': { status: 404, body: {} },
  }, [], () => svc.submitWork(deps(), params));
  assert.equal(notPushed.code, 'branch_not_found');
  assert.equal(notPushed.retryable, true);

  const empty = await withFetch({
    'GET /repos/someuser/recipe-box/branches/usernode%2Frecipe-box-issue-4-abc123': {
      status: 200, body: { commit: { sha: TASK_ROW.base_sha } },
    },
  }, [], () => svc.submitWork(deps(), params));
  assert.equal(empty.code, 'no_commits');
});

test('a task that is not the caller’s own is simply unknown', async () => {
  const queries = [];
  const result = await svc.submitWork(
    {
      pool: fakePool([['FROM external_agent_tasks t JOIN apps a', []]], queries),
      config: {}, gh: baseGh(), githubLink: linkedAs('someuser'), limits: okLimits,
    },
    { user: { id: 99 }, taskId: 31, importProposal: async () => ({ ok: true, body: {} }) }
  );
  assert.equal(result.code, 'unknown_task');
  // Ownership is in the WHERE clause, not in a branch after the read.
  assert.match(SRC, /WHERE t\.id = \$1 AND t\.user_id = \$2 AND t\.status = 'open'/);
});

test('a platform refusal to import is passed back with the platform’s own answer', async () => {
  const queries = [];
  const gh = baseGh({
    findOpenPrByBranch: async () => ({
      number: 88, html_url: 'x', head: { repo: { owner: { login: 'someuser' } } },
    }),
  });
  const result = await withFetch(PUSHED_BRANCH, [], () => svc.submitWork(
    { pool: submitPool(queries), config: {}, gh, githubLink: linkedAs('someuser'), limits: okLimits },
    {
      user: { id: 3 }, taskId: 31,
      importProposal: async () => ({ ok: false, status: 409, body: { error: 'That PR is already imported.' } }),
    }
  ));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'import_failed');
  assert.equal(result.platformResult.status, 409);
  assert.match(result.message, /already imported/);
  // The task stays open so the user can retry once the conflict is cleared.
  assert.ok(!queries.some((q) => q.sql.includes('UPDATE external_agent_tasks')));
});

// ── Structural guarantees ──────────────────────────────────────────────

test('the user’s GitHub token is used for their own account only', () => {
  // Every githubAsUser call names a path under the user's own login or the
  // fork endpoint; the bot's Octokit is what touches the app repository.
  const paths = [...SRC.matchAll(/githubAsUser\([^,]+, '(\w+)', `([^`]+)`/g)].map((m) => m[2]);
  assert.ok(paths.length >= 4);
  for (const p of paths) {
    assert.match(
      p, /^\/repos\/\$\{(login|task\.fork_owner)\}\/|^\/repos\/\$\{owner\}\/\$\{repo\}\/forks$/,
      `${p} touches only the user's own repositories (or forks the app into them)`
    );
  }
  // The fork endpoint is the one exception, and it is a create, not a write
  // to the upstream repository.
  assert.match(SRC, /'POST', `\/repos\/\$\{owner\}\/\$\{repo\}\/forks`/);
});

test('the service never opens a proposal itself', () => {
  // Creating the chat_sessions row, the staging preview, the checks and the
  // vote is the import route's job — reached over loopback with the
  // caller's own token. Reimplementing any of it here would route around
  // the authorization the browser goes through.
  assert.doesNotMatch(SRC, /INSERT INTO chat_sessions/);
  assert.doesNotMatch(SRC, /INSERT INTO pr_votes/);
  assert.match(SRC, /await importProposal\(slug, pr\.number\)/);
});
